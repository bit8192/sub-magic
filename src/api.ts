import {
  getApiKeyHash,
  getConfig,
  getParsedConfig,
  getSubscriptionKey,
  saveConfig,
  getConfigVersions, getConfigVersion, saveConfigVersion,
  restoreConfigVersion, deleteConfigVersion,
} from './config'
import {
  parseConfig, serializeConfig, parseRule, type ProxyGroup, type ProxyProvider,
} from './yaml'
import {
  verifyPassword,
  verifySubscriptionKey,
  isPasswordSet,
  createPassword,
  generateSessionId,
  createSessionCookie,
  clearSessionCookie,
  createSession,
  deleteSession,
  requireAuth,
  generateSubscriptionKey,
  generateApiKey,
  requireAccessKey,
} from './auth'
import { generateSubscription } from './subscribe'
import { getSubscriptionInfo } from './subscription-info'

function json(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  })
}

function parseBody(request: Request): Promise<Record<string, unknown>> {
  return request.json().catch(() => ({})) as Promise<Record<string, unknown>>
}

function isApiRequest(path: string): boolean {
  return path.startsWith('/api/') || path.startsWith('/sub/')
}

function withCors(response: Response, request: Request): Response {
  const origin = request.headers.get('Origin')
  if (!origin) return response

  const headers = new Headers(response.headers)
  headers.set('Access-Control-Allow-Origin', origin)
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  headers.append('Vary', 'Origin')

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function corsPreflight(request: Request): Response {
  const origin = request.headers.get('Origin') || '*'
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') || 'Authorization, Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    },
  })
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  const method = request.method

  if (method === 'OPTIONS' && isApiRequest(path)) {
    return corsPreflight(request)
  }

  // GitHub Release proxy: get latest release info (no auth required, used by install scripts)
  if (path === '/api/proxy/github/release' && method === 'GET') {
    const repo = url.searchParams.get('repo') || ''
    if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repo)) {
      return json({ error: 'Invalid repo' }, 400)
    }
    const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`
    try {
      const ghResp = await fetch(apiUrl, {
        headers: { 'User-Agent': 'sub-magic-worker', Accept: 'application/vnd.github+json' },
      })
      if (!ghResp.ok) {
        return json({ error: `GitHub API returned ${ghResp.status}` }, 502)
      }
      const release = (await ghResp.json()) as Record<string, unknown>
      const workerOrigin = url.origin
      if (Array.isArray(release.assets)) {
        for (const asset of release.assets as Array<Record<string, unknown>>) {
          if (typeof asset.browser_download_url === 'string') {
            asset.browser_download_url = `${workerOrigin}/api/proxy/github/download?url=${encodeURIComponent(asset.browser_download_url)}`
          }
        }
      }
      return json(release)
    } catch {
      return json({ error: 'Failed to fetch release info' }, 502)
    }
  }

  // GitHub Download proxy: stream a release asset (no auth required, used by install scripts)
  if (path === '/api/proxy/github/download' && method === 'GET') {
    const downloadUrl = url.searchParams.get('url') || ''
    if (!downloadUrl.startsWith('https://github.com/')) {
      return json({ error: 'Invalid download URL' }, 400)
    }
    try {
      const ghResp = await fetch(downloadUrl, {
        headers: { 'User-Agent': 'sub-magic-worker' },
        redirect: 'follow',
      })
      return new Response(ghResp.body, {
        status: ghResp.status,
        headers: ghResp.headers,
      })
    } catch {
      return json({ error: 'Failed to fetch asset' }, 502)
    }
  }

  // Subscription endpoint (no auth required)
  if (method === 'GET' && path.startsWith('/sub/')) {
    const key = path.slice(5)
    if (key.length < 8) return json({ error: 'Invalid key' }, 400)
    const valid = await verifySubscriptionKey(env, key)
    if (!valid) return withCors(json({ error: 'Forbidden' }, 403), request)
    return withCors(await generateSubscription(env, request), request)
  }

  // Browser extension routes authenticated by API key
  if (path === '/api/rules/add' && method === 'POST') {
    const authErr = await requireAccessKey(request, env)
    if (authErr) return withCors(authErr, request)

    const body = await parseBody(request)
    const rule = String(body.rule || '')
    if (!rule) return withCors(json({ error: 'rule is required' }, 400), request)

    const config = await getParsedConfig(env)
    const rules = config.rules || []
    const matchIdx = rules.findIndex(r => r.trim().toUpperCase().startsWith('MATCH'))

    if (matchIdx !== -1) {
      rules.splice(matchIdx, 0, rule)
    } else {
      rules.push(rule)
    }

    config.rules = rules
    await saveConfig(env, serializeConfig(config))
    return withCors(json({ ok: true, ruleCount: rules.length }), request)
  }

  if (path === '/api/rules/update' && method === 'POST') {
    const authErr = await requireAccessKey(request, env)
    if (authErr) return withCors(authErr, request)

    const body = await parseBody(request)
    const oldRule = String(body.oldRule || '')
    const newRule = String(body.newRule || '')
    if (!oldRule || !newRule) {
      return withCors(json({ error: 'oldRule and newRule are required' }, 400), request)
    }

    const config = await getParsedConfig(env)
    const rules = config.rules || []
    const idx = rules.indexOf(oldRule)
    if (idx === -1) return withCors(json({ error: 'Rule not found' }, 404), request)

    rules[idx] = newRule
    config.rules = rules
    await saveConfig(env, serializeConfig(config))
    return withCors(json({ ok: true, ruleCount: rules.length }), request)
  }

  // --- Setup / Password Status (no auth required) ---
  if (path === '/api/password-status' && method === 'GET') {
    const set = await isPasswordSet(env)
    return json({ passwordSet: set })
  }

  if (path === '/api/setup' && method === 'POST') {
    const alreadySet = await isPasswordSet(env)
    if (alreadySet) return json({ error: 'Password already set' }, 403)
    const body = await parseBody(request)
    const password = String(body.password || '')
    if (password.length < 6) return json({ error: 'Password must be at least 6 characters' }, 400)
    await createPassword(env, password)
    const sessionId = generateSessionId()
    await createSession(env, sessionId)
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json', 'Set-Cookie': createSessionCookie(sessionId) },
    })
  }

  // Auth endpoints
  if (path === '/api/login') {
    if (method === 'POST') {
      const body = await parseBody(request)
      const password = String(body.password || '')
      const ok = await verifyPassword(env, password)
      if (!ok) return json({ error: 'Invalid password' }, 401)
      const sessionId = generateSessionId()
      await createSession(env, sessionId)
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json', 'Set-Cookie': createSessionCookie(sessionId) },
      })
    }
    return json({ error: 'Method not allowed' }, 405)
  }

  if (path === '/api/logout') {
    if (method === 'POST') {
      const sessionId = request.headers.get('Cookie')?.match(/session=([^;]+)/)?.[1]
      if (sessionId) await deleteSession(env, sessionId)
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json', 'Set-Cookie': clearSessionCookie() },
      })
    }
    return json({ error: 'Method not allowed' }, 405)
  }

  if (path === '/api/check') {
    const authErr = await requireAuth(request, env)
    if (authErr) return authErr
    return json({ ok: true })
  }

  // All other API routes require auth
  const authErr = await requireAuth(request, env)
  if (authErr) return authErr

  // --- Config full text ---
  if (path === '/api/config' && method === 'GET') {
    const raw = await getConfig(env)
    return json({ config: raw || '' })
  }

  if (path === '/api/config/meta' && method === 'GET') {
    const parsed = await getParsedConfig(env)
    const meta: Record<string, unknown> = {}
    if (parsed['external-controller']) meta['external-controller'] = parsed['external-controller']
    if (parsed['external-ui']) meta['external-ui'] = parsed['external-ui']
    if (parsed['external-ui-url']) meta['external-ui-url'] = parsed['external-ui-url']
    return json(meta)
  }

  if (path === '/api/config' && method === 'PUT') {
    const body = await parseBody(request)
    const yamlText = String(body.config || '')
    try {
      parseConfig(yamlText)
    } catch {
      return json({ error: 'Invalid YAML' }, 400)
    }
    await saveConfig(env, yamlText)
    return json({ ok: true })
  }

  // --- Proxy Providers ---
  if (path === '/api/config/proxy-providers') {
    const config = await getParsedConfig(env)
    const providers = config['proxy-providers'] || {}

    if (method === 'GET') {
      const list = Object.entries(providers).map(([n, p]) => ({ name: n, ...p }))
      return json(list)
    }

    if (method === 'POST') {
      const body = await parseBody(request)
      const providerName = String(body.name || '').trim()
      if (!providerName) return json({ error: 'Name is required' }, 400)
      if (providers[providerName]) return json({ error: 'Provider already exists' }, 409)
      const { name: _n, ...providerData } = body
      providers[providerName] = providerData as ProxyProvider
      config['proxy-providers'] = providers
      await saveConfig(env, serializeConfig(config))
      return json({ ok: true })
    }
  }

  if (path.startsWith('/api/config/proxy-providers/') && method === 'PUT') {
    const name = decodeURIComponent(path.slice('/api/config/proxy-providers/'.length))
    const config = await getParsedConfig(env)
    const providers = config['proxy-providers'] || {}
    if (!providers[name]) return json({ error: 'Not found' }, 404)
    const body = await parseBody(request)
    const { name: _n, ...providerData } = body
    providers[name] = providerData as ProxyProvider
    config['proxy-providers'] = providers
    await saveConfig(env, serializeConfig(config))
    return json({ ok: true })
  }

  if (path.startsWith('/api/config/proxy-providers/') && method === 'DELETE') {
    const name = decodeURIComponent(path.slice('/api/config/proxy-providers/'.length))
    const config = await getParsedConfig(env)
    const providers = config['proxy-providers'] || {}
    if (!providers[name]) return json({ error: 'Not found' }, 404)
    delete providers[name]
    config['proxy-providers'] = providers
    await saveConfig(env, serializeConfig(config))
    return json({ ok: true })
  }

  // --- Proxy Groups ---
  if (path === '/api/config/proxy-groups') {
    const config = await getParsedConfig(env)
    const groups = config['proxy-groups'] || []

    if (method === 'GET') {
      return json(groups)
    }

    if (method === 'POST') {
      const body = (await parseBody(request)) as unknown as ProxyGroup
      const name = String(body.name || '').trim()
      if (!name) return json({ error: 'Name is required' }, 400)
      if (groups.some(g => g.name === name)) return json({ error: 'Group already exists' }, 409)
      groups.push(body)
      config['proxy-groups'] = groups
      await saveConfig(env, serializeConfig(config))
      return json({ ok: true })
    }
  }

  if (path.startsWith('/api/config/proxy-groups/') && method === 'PUT') {
    const name = decodeURIComponent(path.slice('/api/config/proxy-groups/'.length))
    const config = await getParsedConfig(env)
    const groups = config['proxy-groups'] || []
    const idx = groups.findIndex(g => g.name === name)
    if (idx === -1) return json({ error: 'Not found' }, 404)
    const body = (await parseBody(request)) as unknown as ProxyGroup
    groups[idx] = body
    config['proxy-groups'] = groups
    await saveConfig(env, serializeConfig(config))
    return json({ ok: true })
  }

  if (path.startsWith('/api/config/proxy-groups/') && method === 'DELETE') {
    const name = decodeURIComponent(path.slice('/api/config/proxy-groups/'.length))
    const config = await getParsedConfig(env)
    const groups = config['proxy-groups'] || []
    const idx = groups.findIndex(g => g.name === name)
    if (idx === -1) return json({ error: 'Not found' }, 404)
    groups.splice(idx, 1)
    config['proxy-groups'] = groups
    await saveConfig(env, serializeConfig(config))
    return json({ ok: true })
  }

  // --- Rules ---
  if (path === '/api/config/rules') {
    const config = await getParsedConfig(env)
    const rules = config.rules || []

    if (method === 'GET') {
      const parsed = rules.map((r, i) => ({ index: i, raw: r, ...parseRule(r) }))
      return json(parsed)
    }

    if (method === 'POST') {
      const body = await parseBody(request)
      const raw = String(body.raw || '')
      if (!raw) return json({ error: 'Rule is required' }, 400)
      rules.push(raw)
      config.rules = rules
      await saveConfig(env, serializeConfig(config))
      return json({ ok: true })
    }

    if (method === 'PUT') {
      const body = await parseBody(request)
      const reorder = body.rules as string[]
      if (!Array.isArray(reorder)) return json({ error: 'rules array required' }, 400)
      config.rules = reorder
      await saveConfig(env, serializeConfig(config))
      return json({ ok: true })
    }
  }

  if (path.startsWith('/api/config/rules/') && method === 'PUT') {
    const idxStr = path.slice('/api/config/rules/'.length)
    const idx = parseInt(idxStr, 10)
    const config = await getParsedConfig(env)
    const rules = config.rules || []
    if (idx < 0 || idx >= rules.length) return json({ error: 'Index out of range' }, 404)
    const body = await parseBody(request)
    const raw = String(body.raw || '')
    if (!raw) return json({ error: 'Rule is required' }, 400)
    rules[idx] = raw
    config.rules = rules
    await saveConfig(env, serializeConfig(config))
    return json({ ok: true })
  }

  if (path.startsWith('/api/config/rules/') && method === 'DELETE') {
    const idxStr = path.slice('/api/config/rules/'.length)
    const idx = parseInt(idxStr, 10)
    const config = await getParsedConfig(env)
    const rules = config.rules || []
    if (idx < 0 || idx >= rules.length) return json({ error: 'Index out of range' }, 404)
    rules.splice(idx, 1)
    config.rules = rules
    await saveConfig(env, serializeConfig(config))
    return json({ ok: true })
  }

  // --- Config Version History ---
  if (path === '/api/config/versions') {
    if (method === 'GET') {
      const list = await getConfigVersions(env)
      return json(list)
    }
    if (method === 'POST') {
      const body = await parseBody(request)
      const label = String(body.label || '').trim() || undefined
      try {
        const version = await saveConfigVersion(env, label)
        return json(version)
      } catch {
        return json({ error: 'Failed to save version' }, 400)
      }
    }
  }

  if (path.startsWith('/api/config/versions/') && method === 'GET') {
    const id = decodeURIComponent(path.slice('/api/config/versions/'.length))
    const config = await getConfigVersion(env, id)
    if (!config) return json({ error: 'Version not found' }, 404)
    return json({ config })
  }

  if (path.startsWith('/api/config/versions/') && method === 'POST') {
    const id = decodeURIComponent(path.slice('/api/config/versions/'.length))
    if (path.endsWith('/restore')) {
      const ok = await restoreConfigVersion(env, id)
      if (!ok) return json({ error: 'Version not found' }, 404)
      return json({ ok: true })
    }
  }

  if (path.startsWith('/api/config/versions/') && method === 'DELETE') {
    const id = decodeURIComponent(path.slice('/api/config/versions/'.length))
    await deleteConfigVersion(env, id)
    return json({ ok: true })
  }

  // --- Keys ---
  if (path === '/api/access-key') {
    if (method === 'GET') {
      const subscriptionKey = await getSubscriptionKey(env)
      const apiKeyHash = await getApiKeyHash(env)

      let generatedSubscriptionKey: string | null = null
      let generatedApiKey: string | null = null

      if (!subscriptionKey) {
        generatedSubscriptionKey = await generateSubscriptionKey(env)
      }
      if (!apiKeyHash) {
        generatedApiKey = await generateApiKey(env)
      }

      return json({
        subscriptionKey: subscriptionKey || generatedSubscriptionKey,
        apiKey: generatedApiKey,
        subscriptionKeyPresent: !!(subscriptionKey || generatedSubscriptionKey),
        apiKeyPresent: !!(apiKeyHash || generatedApiKey),
      }, 200, { 'Cache-Control': 'no-store' })
    }

    if (method === 'POST') {
      const newSubscriptionKey = await generateSubscriptionKey(env)
      const newApiKey = await generateApiKey(env)
      return json({
        subscriptionKey: newSubscriptionKey,
        apiKey: newApiKey,
      }, 200, { 'Cache-Control': 'no-store' })
    }
  }

  if (path === '/api/access-key/rotate' && method === 'POST') {
    const body = await parseBody(request)
    const target = String(body.target || 'both')

    if (target === 'subscription') {
      const subscriptionKey = await generateSubscriptionKey(env)
      return json({ subscriptionKey }, 200, { 'Cache-Control': 'no-store' })
    }

    if (target === 'api') {
      const apiKey = await generateApiKey(env)
      return json({ apiKey }, 200, { 'Cache-Control': 'no-store' })
    }

    const subscriptionKey = await generateSubscriptionKey(env)
    const apiKey = await generateApiKey(env)
    return json({ subscriptionKey, apiKey }, 200, { 'Cache-Control': 'no-store' })
  }

  // --- Subscription Info ---
  if (path === '/api/subscription-info' && method === 'POST') {
    const body = await parseBody(request)
    const name = String(body.name || '').trim()
    if (!name) return json({ error: 'Provider name is required' }, 400)
    const result = await getSubscriptionInfo(env, name)
    if ('error' in result) return json({ error: result.error }, 400)
    return json(result)
  }

  return json({ error: 'Not found' }, 404)
}

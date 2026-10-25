import {
  getApiKeyHash,
  getConfig,
  getConfigFromKv,
  getParsedConfigFromKv,
  getSubscriptionKey,
  saveConfig,
  getConfigVersions, getConfigVersion, saveConfigVersion,
  restoreConfigVersion, deleteConfigVersion,
} from './config'
import {
  parseRule, type Listener, type ProxyAuthUser, type ProxyGroup, type ProxyProvider, type RuleProvider,
} from './yaml'
import { ConfigDocument } from './config-doc'
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

/**
 * 写操作统一走「文档原地编辑」：直接改 YAML AST 再序列化，
 * 这样手写注释、锚点（&name）与别名（*name）以及未改动区域的排版都会保留。
 */
async function loadConfigDocument(env: Env): Promise<ConfigDocument> {
  return ConfigDocument.fromText(await getConfig(env))
}

async function saveConfigDocument(env: Env, doc: ConfigDocument): Promise<void> {
  doc.validate()
  await saveConfig(env, doc.serialize())
}

async function requireAuthOrAccessKey(request: Request, env: Env): Promise<Response | null> {
  const accessErr = await requireAccessKey(request, env)
  if (!accessErr) return null

  const sessionErr = await requireAuth(request, env)
  if (!sessionErr) return null

  return accessErr
}

function parseProxyAuthEntry(entry: unknown): ProxyAuthUser | null {
  if (typeof entry !== 'string') return null
  const separatorIdx = entry.indexOf(':')
  if (separatorIdx <= 0) return null
  return {
    username: entry.slice(0, separatorIdx),
    password: entry.slice(separatorIdx + 1),
  }
}

function serializeProxyAuthEntry(user: ProxyAuthUser): string {
  return `${user.username}:${user.password}`
}

function findMatchRuleIndex(rules: string[]): number {
  return rules.findIndex(rule => rule.trim().toUpperCase().startsWith('MATCH'))
}

function resolveRuleInsertIndex(rules: string[], insertAfter: string): number {
  const normalized = insertAfter.trim()
  if (!normalized) return 0
  const anchorIdx = rules.indexOf(normalized)
  if (anchorIdx !== -1) return anchorIdx + 1
  const matchIdx = findMatchRuleIndex(rules)
  return matchIdx !== -1 ? matchIdx : rules.length
}

function getProxyAuthUsers(config: Record<string, unknown>): ProxyAuthUser[] {
  return Array.isArray(config.authentication)
    ? config.authentication.map(parseProxyAuthEntry).filter((entry): entry is ProxyAuthUser => !!entry)
    : []
}

function getProxyAuthUsersFromDocument(doc: ConfigDocument): ProxyAuthUser[] {
  return getProxyAuthUsers((doc.value ?? {}) as Record<string, unknown>)
}

/** 读取顶层序列（不存在或类型不对时返回空数组） */
function readSeq<T>(doc: ConfigDocument, key: string): T[] {
  const value = doc.getIn<T[]>([key])
  return Array.isArray(value) ? value : []
}

function normalizeListener(body: Record<string, unknown>): Listener {
  const listener: Listener = {
    name: String(body.name || '').trim(),
    type: String(body.type || '').trim(),
  }

  for (const [key, value] of Object.entries(body)) {
    if (key === 'name' || key === 'type') continue
    if (key === 'port') {
      if (typeof value === 'number') {
        listener.port = value
      } else if (typeof value === 'string' && value.trim()) {
        const maybeNumber = Number(value)
        listener.port = Number.isFinite(maybeNumber) ? maybeNumber : value.trim()
      }
      continue
    }
    if (key === 'listen' && value != null) {
      listener.listen = String(value).trim()
      continue
    }
    if (value !== undefined) {
      listener[key] = value
    }
  }

  return listener
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
    const insertAfter = String(body.insertAfter || '')
    if (!rule) return withCors(json({ error: 'rule is required' }, 400), request)

    const doc = await loadConfigDocument(env)
    const rules = doc.getIn<string[]>(['rules']) ?? []
    const insertIdx = insertAfter.trim()
      ? resolveRuleInsertIndex(rules, insertAfter)
      : (() => {
          const matchIdx = findMatchRuleIndex(rules)
          return matchIdx !== -1 ? matchIdx : rules.length
        })()

    doc.insertAt(['rules'], insertIdx, rule)
    await saveConfigDocument(env, doc)
    return withCors(json({ ok: true, ruleCount: rules.length + 1 }), request)
  }

  if (path === '/api/rules/update' && method === 'POST') {
    const authErr = await requireAccessKey(request, env)
    if (authErr) return withCors(authErr, request)

    const body = await parseBody(request)
    const oldRule = String(body.oldRule || '')
    const newRule = String(body.newRule || '')
    const insertAfter = String(body.insertAfter || '')
    if (!oldRule || !newRule) {
      return withCors(json({ error: 'oldRule and newRule are required' }, 400), request)
    }

    const doc = await loadConfigDocument(env)
    const rules = doc.getIn<string[]>(['rules']) ?? []
    const idx = rules.indexOf(oldRule)
    if (idx === -1) return withCors(json({ error: 'Rule not found' }, 404), request)

    // 先移除旧规则再按插入位置放回；未变动的规则节点会被复用，注释随之保留
    const nextRules = rules.filter((_, index) => index !== idx)
    const insertIdx = resolveRuleInsertIndex(nextRules, insertAfter)
    nextRules.splice(insertIdx, 0, newRule)

    doc.syncSeq(['rules'], nextRules, value => String(value))
    await saveConfigDocument(env, doc)
    return withCors(json({ ok: true, ruleCount: nextRules.length }), request)
  }

  if (path === '/api/config/proxy-auth-users') {
    const authErr = await requireAuthOrAccessKey(request, env)
    if (authErr) return withCors(authErr, request)

    if (method === 'GET') {
      const config = await getParsedConfigFromKv(env)
      const users = getProxyAuthUsers(config)
      return withCors(json(users), request)
    }

    if (method === 'POST') {
      const doc = await loadConfigDocument(env)
      const users = getProxyAuthUsersFromDocument(doc)
      const body = await parseBody(request)
      const username = String(body.username || '').trim()
      const password = String(body.password || '')
      if (!username) return withCors(json({ error: 'username is required' }, 400), request)
      if (!password) return withCors(json({ error: 'password is required' }, 400), request)
      if (users.some(user => user.username === username)) {
        return withCors(json({ error: 'User already exists' }, 409), request)
      }

      doc.syncSeq(
        ['authentication'],
        [...users.map(serializeProxyAuthEntry),
        serializeProxyAuthEntry({ username, password })],
        value => String(value),
      )
      await saveConfigDocument(env, doc)
      return withCors(json({ ok: true }), request)
    }
  }

  if (path.startsWith('/api/config/proxy-auth-users/') && method === 'DELETE') {
    const authErr = await requireAuthOrAccessKey(request, env)
    if (authErr) return withCors(authErr, request)

    const username = decodeURIComponent(path.slice('/api/config/proxy-auth-users/'.length))
    const doc = await loadConfigDocument(env)
    const users = getProxyAuthUsersFromDocument(doc)
    if (!users.some(user => user.username === username)) {
      return withCors(json({ error: 'Not found' }, 404), request)
    }

    doc.syncSeq(
      ['authentication'],
      users.filter(user => user.username !== username).map(serializeProxyAuthEntry),
      value => String(value),
    )
    await saveConfigDocument(env, doc)
    return withCors(json({ ok: true }), request)
  }

  if (path === '/api/config/listeners') {
    const authErr = await requireAuthOrAccessKey(request, env)
    if (authErr) return withCors(authErr, request)

    if (method === 'GET') {
      const config = await getParsedConfigFromKv(env)
      const listeners = Array.isArray(config.listeners) ? config.listeners : []
      return withCors(json(listeners), request)
    }

    if (method === 'POST') {
      const doc = await loadConfigDocument(env)
      const listeners = readSeq<Listener>(doc, 'listeners')
      const body = await parseBody(request)
      const listener = normalizeListener(body)
      if (!listener.name) return withCors(json({ error: 'name is required' }, 400), request)
      if (!listener.type) return withCors(json({ error: 'type is required' }, 400), request)
      if (listener.port === undefined || listener.port === '') {
        return withCors(json({ error: 'port is required' }, 400), request)
      }
      if (listeners.some(item => item?.name === listener.name)) {
        return withCors(json({ error: 'Listener already exists' }, 409), request)
      }

      doc.insertAt(['listeners'], listeners.length, listener)
      await saveConfigDocument(env, doc)
      return withCors(json({ ok: true }), request)
    }
  }

  if (path.startsWith('/api/config/listeners/') && method === 'DELETE') {
    const authErr = await requireAuthOrAccessKey(request, env)
    if (authErr) return withCors(authErr, request)

    const name = decodeURIComponent(path.slice('/api/config/listeners/'.length))
    const doc = await loadConfigDocument(env)
    const listeners = readSeq<Listener>(doc, 'listeners')
    const idx = listeners.findIndex(listener => listener?.name === name)
    if (idx === -1) {
      return withCors(json({ error: 'Not found' }, 404), request)
    }

    doc.deleteIn(['listeners', idx])
    await saveConfigDocument(env, doc)
    return withCors(json({ ok: true }), request)
  }

  if (path === '/api/config/external-ui' && method === 'GET') {
    const authErr = await requireAuthOrAccessKey(request, env)
    if (authErr) return withCors(authErr, request)

    const config = await getParsedConfigFromKv(env)
    const externalUi = String(config['external-ui'] || '').trim()
    return withCors(json({ externalUi }), request)
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

  // All other API routes require auth, except selected config endpoints that also allow access keys.
  const configAccessKeyPath =
    path === '/api/config/rule-providers' ||
    path.startsWith('/api/config/rule-providers/') ||
    path === '/api/config/proxy-groups' ||
    path.startsWith('/api/config/proxy-groups/') ||
    path === '/api/config/rules' ||
    path.startsWith('/api/config/rules/')

  if (!configAccessKeyPath) {
    const authErr = await requireAuth(request, env)
    if (authErr) return authErr
  }

  // --- Config full text ---
  if (path === '/api/config' && method === 'GET') {
    const raw = await getConfigFromKv(env)
    return json({ config: raw || '' })
  }

  if (path === '/api/config/meta' && method === 'GET') {
    const parsed = await getParsedConfigFromKv(env)
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
      // 校验后原样落库：文本编辑不做格式化，注释与锚点连排版一起保留
      ConfigDocument.parse(yamlText)
    } catch {
      return json({ error: 'Invalid YAML' }, 400)
    }
    await saveConfig(env, yamlText)
    return json({ ok: true })
  }

  // --- Proxy Providers ---
  if (path === '/api/config/proxy-providers') {
    if (method === 'GET') {
      const config = await getParsedConfigFromKv(env)
      const providers = config['proxy-providers'] || {}
      const list = Object.entries(providers).map(([n, p]) => ({ name: n, ...p }))
      return json(list)
    }

    if (method === 'POST') {
      const body = await parseBody(request)
      const providerName = String(body.name || '').trim()
      if (!providerName) return json({ error: 'Name is required' }, 400)
      const doc = await loadConfigDocument(env)
      if (doc.getIn(['proxy-providers', providerName]) !== undefined) {
        return json({ error: 'Provider already exists' }, 409)
      }
      const { name: _n, ...providerData } = body
      doc.updateMap(['proxy-providers', providerName], providerData as ProxyProvider)
      await saveConfigDocument(env, doc)
      return json({ ok: true })
    }
  }

  if (path.startsWith('/api/config/proxy-providers/') && method === 'PUT') {
    const name = decodeURIComponent(path.slice('/api/config/proxy-providers/'.length))
    const doc = await loadConfigDocument(env)
    if (doc.getIn(['proxy-providers', name]) === undefined) return json({ error: 'Not found' }, 404)
    const body = await parseBody(request)
    const { name: _n, ...providerData } = body
    doc.updateMap(['proxy-providers', name], providerData as ProxyProvider)
    await saveConfigDocument(env, doc)
    return json({ ok: true })
  }

  if (path.startsWith('/api/config/proxy-providers/') && method === 'DELETE') {
    const name = decodeURIComponent(path.slice('/api/config/proxy-providers/'.length))
    const doc = await loadConfigDocument(env)
    if (doc.getIn(['proxy-providers', name]) === undefined) return json({ error: 'Not found' }, 404)
    doc.deleteIn(['proxy-providers', name])
    await saveConfigDocument(env, doc)
    return json({ ok: true })
  }

  // --- Proxy Groups ---
  if (path === '/api/config/rule-providers') {
    const authErr = await requireAuthOrAccessKey(request, env)
    if (authErr) return withCors(authErr, request)

    if (method === 'GET') {
      const config = await getParsedConfigFromKv(env)
      const providers = config['rule-providers'] || {}
      const list = Object.entries(providers).map(([name, provider]) => ({ name, ...provider }))
      return withCors(json(list), request)
    }

    const doc = await loadConfigDocument(env)

    if (method === 'POST') {
      const body = (await parseBody(request)) as unknown as RuleProvider & { name?: string }
      const name = String(body.name || '').trim()
      if (!name) return withCors(json({ error: 'Name is required' }, 400), request)
      if (doc.getIn(['rule-providers', name]) !== undefined) {
        return withCors(json({ error: 'Rule provider already exists' }, 409), request)
      }
      const { name: _name, ...providerData } = body
      doc.updateMap(['rule-providers', name], providerData as Record<string, unknown>)
      await saveConfigDocument(env, doc)
      return withCors(json({ ok: true }), request)
    }
  }

  if (path.startsWith('/api/config/rule-providers/') && method === 'PUT') {
    const authErr = await requireAuthOrAccessKey(request, env)
    if (authErr) return withCors(authErr, request)

    const name = decodeURIComponent(path.slice('/api/config/rule-providers/'.length))
    const doc = await loadConfigDocument(env)
    if (doc.getIn(['rule-providers', name]) === undefined) {
      return withCors(json({ error: 'Not found' }, 404), request)
    }
    const body = (await parseBody(request)) as unknown as RuleProvider
    doc.updateMap(['rule-providers', name], body as unknown as Record<string, unknown>)
    await saveConfigDocument(env, doc)
    return withCors(json({ ok: true }), request)
  }

  if (path.startsWith('/api/config/rule-providers/') && method === 'DELETE') {
    const authErr = await requireAuthOrAccessKey(request, env)
    if (authErr) return withCors(authErr, request)

    const name = decodeURIComponent(path.slice('/api/config/rule-providers/'.length))
    const doc = await loadConfigDocument(env)
    if (doc.getIn(['rule-providers', name]) === undefined) {
      return withCors(json({ error: 'Not found' }, 404), request)
    }
    doc.deleteIn(['rule-providers', name])
    await saveConfigDocument(env, doc)
    return withCors(json({ ok: true }), request)
  }

  // --- Proxy Groups ---
  if (path === '/api/config/proxy-groups') {
    const authErr = await requireAuthOrAccessKey(request, env)
    if (authErr) return withCors(authErr, request)

    if (method === 'GET') {
      const config = await getParsedConfigFromKv(env)
      const groups = config['proxy-groups'] || []
      return withCors(json(groups), request)
    }

    const doc = await loadConfigDocument(env)

    if (method === 'POST') {
      const body = (await parseBody(request)) as unknown as ProxyGroup
      const name = String(body.name || '').trim()
      if (!name) return withCors(json({ error: 'Name is required' }, 400), request)
      const groups = readSeq<ProxyGroup>(doc, 'proxy-groups')
      if (groups.some(g => g?.name === name)) return withCors(json({ error: 'Group already exists' }, 409), request)
      doc.insertAt(['proxy-groups'], groups.length, body)
      await saveConfigDocument(env, doc)
      return withCors(json({ ok: true }), request)
    }
  }

  if (path.startsWith('/api/config/proxy-groups/') && method === 'PUT') {
    const authErr = await requireAuthOrAccessKey(request, env)
    if (authErr) return withCors(authErr, request)

    const name = decodeURIComponent(path.slice('/api/config/proxy-groups/'.length))
    const doc = await loadConfigDocument(env)
    const groups = readSeq<ProxyGroup>(doc, 'proxy-groups')
    const idx = groups.findIndex(g => g?.name === name)
    if (idx === -1) return withCors(json({ error: 'Not found' }, 404), request)
    const body = (await parseBody(request)) as unknown as ProxyGroup
    doc.updateMap(['proxy-groups', idx], body as unknown as Record<string, unknown>)
    await saveConfigDocument(env, doc)
    return withCors(json({ ok: true }), request)
  }

  if (path.startsWith('/api/config/proxy-groups/') && method === 'DELETE') {
    const authErr = await requireAuthOrAccessKey(request, env)
    if (authErr) return withCors(authErr, request)

    const name = decodeURIComponent(path.slice('/api/config/proxy-groups/'.length))
    const doc = await loadConfigDocument(env)
    const groups = readSeq<ProxyGroup>(doc, 'proxy-groups')
    const idx = groups.findIndex(g => g?.name === name)
    if (idx === -1) return withCors(json({ error: 'Not found' }, 404), request)
    doc.deleteIn(['proxy-groups', idx])
    await saveConfigDocument(env, doc)
    return withCors(json({ ok: true }), request)
  }

  // --- Rules ---
  if (path === '/api/config/rules') {
    const authErr = await requireAuthOrAccessKey(request, env)
    if (authErr) return withCors(authErr, request)

    if (method === 'GET') {
      const config = await getParsedConfigFromKv(env)
      const rules = config.rules || []
      const parsed = rules.map((r, i) => ({ index: i, raw: r, ...parseRule(r) }))
      return withCors(json(parsed), request)
    }

    const doc = await loadConfigDocument(env)
    const rules = readSeq<string>(doc, 'rules')

    if (method === 'POST') {
      const body = await parseBody(request)
      const raw = String(body.raw || '')
      if (!raw) return withCors(json({ error: 'Rule is required' }, 400), request)
      doc.insertAt(['rules'], rules.length, raw)
      await saveConfigDocument(env, doc)
      return withCors(json({ ok: true }), request)
    }

    if (method === 'PUT') {
      const body = await parseBody(request)
      const reorder = body.rules as string[]
      if (!Array.isArray(reorder)) return withCors(json({ error: 'rules array required' }, 400), request)
      doc.syncSeq(['rules'], reorder, value => String(value))
      await saveConfigDocument(env, doc)
      return withCors(json({ ok: true }), request)
    }
  }

  if (path.startsWith('/api/config/rules/') && method === 'PUT') {
    const authErr = await requireAuthOrAccessKey(request, env)
    if (authErr) return withCors(authErr, request)

    const idxStr = path.slice('/api/config/rules/'.length)
    const idx = parseInt(idxStr, 10)
    const doc = await loadConfigDocument(env)
    const rules = readSeq<string>(doc, 'rules')
    if (idx < 0 || idx >= rules.length) return withCors(json({ error: 'Index out of range' }, 404), request)
    const body = await parseBody(request)
    const raw = String(body.raw || '')
    if (!raw) return withCors(json({ error: 'Rule is required' }, 400), request)
    doc.setIn(['rules', idx], raw)
    await saveConfigDocument(env, doc)
    return withCors(json({ ok: true }), request)
  }

  if (path.startsWith('/api/config/rules/') && method === 'DELETE') {
    const authErr = await requireAuthOrAccessKey(request, env)
    if (authErr) return withCors(authErr, request)

    const idxStr = path.slice('/api/config/rules/'.length)
    const idx = parseInt(idxStr, 10)
    const doc = await loadConfigDocument(env)
    const rules = readSeq<string>(doc, 'rules')
    if (idx < 0 || idx >= rules.length) return withCors(json({ error: 'Index out of range' }, 404), request)
    doc.deleteIn(['rules', idx])
    await saveConfigDocument(env, doc)
    return withCors(json({ ok: true }), request)
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
    if (path.endsWith('/restore')) {
      const id = decodeURIComponent(path.slice('/api/config/versions/'.length, -'/restore'.length))
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

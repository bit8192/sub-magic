import {
  getApiKeyHash,
  getSubscriptionKey,
  setApiKeyHash,
  setSubscriptionKey,
  getPasswordHash,
  setPasswordHash,
} from './config'

const SESSION_COOKIE = 'session'
const SESSION_TTL = 86400 * 7

function kv(env: Env): KVNamespace | null {
  return (env as any).SUB_MAGIC ?? null
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return result === 0
}

export async function isPasswordSet(env: Env): Promise<boolean> {
  const hash = await getPasswordHash(env)
  return !!hash
}

export async function createPassword(env: Env, password: string): Promise<void> {
  const hash = await sha256Hex(password)
  await setPasswordHash(env, hash)
}

export async function verifyPassword(env: Env, password: string): Promise<boolean> {
  const storedHash = await getPasswordHash(env)
  if (storedHash) {
    return timingSafeEqual(storedHash, await sha256Hex(password))
  }
  const stored = env.PASSWORD
  if (!stored) return false
  return timingSafeEqual(stored, password)
}

export function generateSessionId(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

export function createSessionCookie(sessionId: string): string {
  const expires = new Date(Date.now() + SESSION_TTL * 1000).toUTCString()
  return `${SESSION_COOKIE}=${sessionId}; HttpOnly; Path=/; Max-Age=${SESSION_TTL}; SameSite=Lax`
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`
}

export function getSessionId(request: Request): string | null {
  const cookie = request.headers.get('Cookie')
  if (!cookie) return null
  for (const part of cookie.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === SESSION_COOKIE) return rest.join('=') || null
  }
  return null
}

export async function createSession(env: Env, sessionId: string): Promise<void> {
  const ns = kv(env)
  if (!ns) return
  await ns.put(`session:${sessionId}`, '1', {
    expirationTtl: SESSION_TTL,
  })
}

export async function isValidSession(env: Env, sessionId: string): Promise<boolean> {
  const ns = kv(env)
  if (!ns) return false
  const val = await ns.get(`session:${sessionId}`)
  return val !== null
}

export async function deleteSession(env: Env, sessionId: string): Promise<void> {
  const ns = kv(env)
  if (!ns) return
  await ns.delete(`session:${sessionId}`)
}

export async function requireAuth(request: Request, env: Env): Promise<Response | null> {
  const sessionId = getSessionId(request)
  if (!sessionId) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const valid = await isValidSession(env, sessionId)
  if (!valid) {
    return new Response(JSON.stringify({ error: 'Session expired' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return null
}

export function getBearerToken(request: Request): string | null {
  const authorization = request.headers.get('Authorization') || ''
  const match = authorization.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || null
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}

function randomToken(prefix: string): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  const body = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
  return `${prefix}${body}`
}

export async function hashKey(key: string): Promise<string> {
  return sha256Hex(key)
}

export async function generateSubscriptionKey(env: Env): Promise<string> {
  const key = randomToken('sm_sub_')
  await setSubscriptionKey(env, key)
  return key
}

export async function generateApiKey(env: Env): Promise<string> {
  const key = randomToken('sm_api_')
  await setApiKeyHash(env, await hashKey(key))
  return key
}

export async function verifySubscriptionKey(env: Env, key: string): Promise<boolean> {
  const storedKey = await getSubscriptionKey(env)
  if (!storedKey) return false
  return timingSafeEqual(storedKey, key)
}

export async function verifyApiKey(env: Env, key: string): Promise<boolean> {
  const storedHash = await getApiKeyHash(env)
  if (!storedHash) return false
  return timingSafeEqual(storedHash, await hashKey(key))
}

export async function requireAccessKey(request: Request, env: Env): Promise<Response | null> {
  const key = getBearerToken(request)
  if (!key) {
    return new Response(JSON.stringify({ error: 'Missing API key' }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer',
      },
    })
  }
  const valid = await verifyApiKey(env, key)
  if (!valid) {
    return new Response(JSON.stringify({ error: 'Invalid API key' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return null
}

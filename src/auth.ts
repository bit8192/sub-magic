import { getAccessKey, setAccessKey } from './config'

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

export async function verifyPassword(env: Env, password: string): Promise<boolean> {
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

export async function generateAccessKey(env: Env): Promise<string> {
  const key = crypto.randomUUID().replace(/-/g, '')
  await setAccessKey(env, key)
  return key
}

export async function verifyAccessKey(env: Env, key: string): Promise<boolean> {
  const stored = await getAccessKey(env)
  if (!stored) return false
  return timingSafeEqual(stored, key)
}

import { getConfig } from './config'
import { parseConfig, serializeConfig } from './yaml'

const LONG_POLL_HEADER = 'X-Sub-Magic-Long-Poll'
const LONG_POLL_INTERVAL_MS = 3000
const LONG_POLL_MAX_CHECKS = 10

function computeEtag(text: string): string {
  let hash = 0
  for (let i = 0; i < text.length; i++) {
    const chr = text.charCodeAt(i)
    hash = ((hash << 5) - hash) + chr
    hash |= 0
  }
  return `"${Math.abs(hash).toString(36)}"`
}

function isLongPollRequest(request: Request): boolean {
  return request.headers.get(LONG_POLL_HEADER) === '1'
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function getSubscriptionSnapshot(env: Env): Promise<{ rawConfig: string | null, etag: string | null }> {
  const rawConfig = await getConfig(env)
  if (!rawConfig) {
    return { rawConfig: null, etag: null }
  }
  return { rawConfig, etag: computeEtag(rawConfig) }
}

export async function generateSubscription(env: Env, request: Request): Promise<Response> {
  let { rawConfig, etag } = await getSubscriptionSnapshot(env)
  if (!rawConfig || !etag) {
    return new Response('Configuration not found', { status: 404 })
  }

  const clientEtag = request.headers.get('If-None-Match')

  if (clientEtag === etag && isLongPollRequest(request)) {
    for (let i = 0; i < LONG_POLL_MAX_CHECKS; i++) {
      await sleep(LONG_POLL_INTERVAL_MS)
      const snapshot = await getSubscriptionSnapshot(env)
      rawConfig = snapshot.rawConfig
      etag = snapshot.etag
      if (!rawConfig || !etag) {
        return new Response('Configuration not found', { status: 404 })
      }
      if (etag !== clientEtag) {
        break
      }
    }
  }

  if (clientEtag === etag) {
    return new Response(null, {
      status: 304,
      headers: {
        'ETag': etag,
        'Cache-Control': 'no-cache',
      },
    })
  }

  const config = parseConfig(rawConfig)

  const output = serializeConfig(config)

  return new Response(output, {
    headers: {
      'Content-Type': 'text/yaml; charset=utf-8',
      'Content-Disposition': 'attachment; filename="config.yaml"',
      'ETag': etag,
      'Cache-Control': 'no-cache',
    },
  })
}

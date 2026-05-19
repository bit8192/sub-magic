import { getConfig, getParsedConfig } from './config'
import { parseConfig, serializeConfig, type ClashConfig } from './yaml'

let lastConfigEtag: string | null = null
let lastConfigBody: string | null = null

function computeEtag(text: string): string {
  let hash = 0
  for (let i = 0; i < text.length; i++) {
    const chr = text.charCodeAt(i)
    hash = ((hash << 5) - hash) + chr
    hash |= 0
  }
  return `"${Math.abs(hash).toString(36)}"`
}

export async function generateSubscription(env: Env, request: Request): Promise<Response> {
  const rawConfig = await getConfig(env)
  if (!rawConfig) {
    return new Response('Configuration not found', { status: 404 })
  }

  const etag = computeEtag(rawConfig)

  if (request.headers.get('If-None-Match') === etag) {
    return new Response(null, { status: 304 })
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

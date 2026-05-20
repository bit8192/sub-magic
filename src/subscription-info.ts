import { getParsedConfig } from './config'

interface SubInfo {
  upload: number
  download: number
  total: number
  expire: number
  updateInterval: number
  webPageUrl: string
  source: string
  details: string
  checkedAt: number
}

function parseHeader(header: string | null): Partial<SubInfo> | null {
  if (!header) return null
  const result: Partial<SubInfo> = {}
  const parts = header.split(';')
  for (const part of parts) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const key = part.slice(0, eq).trim()
    const val = part.slice(eq + 1).trim()
    const num = Number(val)
    if (isNaN(num)) continue
    switch (key) {
      case 'upload': result.upload = num; break
      case 'download': result.download = num; break
      case 'total': result.total = num; break
      case 'expire': result.expire = num; break
    }
  }
  if (Object.keys(result).length === 0) return null
  return result
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

function parseGroupNameUsage(yamlText: string): Partial<SubInfo> | null {
  try {
    const pattern1 = /剩余\s*([\d.]+)\s*(GB|MB|TB|KB)/i
    const pattern2 = /总\s*([\d.]+)\s*(GB|MB|TB|KB)/i
    const pattern3 = /已用\s*([\d.]+)\s*(GB|MB|TB|KB)/i
    const datePattern = /(\d{4}[-/]\d{2}[-/]\d{2}).*?(?:到期|过期|expire)/i

    let remaining = 0
    let total = 0
    let used = 0
    let expire = 0

    const parseValue = (val: string, unit: string): number => {
      const n = parseFloat(val)
      const multiplier: Record<string, number> = { B: 1, KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024, TB: 1024 * 1024 * 1024 * 1024 }
      return n * (multiplier[unit.toUpperCase()] || 1)
    }

    const lines = yamlText.split('\n')
    for (const line of lines) {
      const m1 = line.match(pattern1)
      if (m1) remaining += parseValue(m1[1], m1[2])

      const m2 = line.match(pattern2)
      if (m2) total += parseValue(m2[1], m2[2])

      const m3 = line.match(pattern3)
      if (m3) used += parseValue(m3[1], m3[2])

      if (!expire) {
        const dm = line.match(datePattern)
        if (dm) {
          const ts = Date.parse(dm[1])
          if (!isNaN(ts)) expire = Math.floor(ts / 1000)
        }
      }
    }

    if (remaining <= 0 && total <= 0 && used <= 0 && expire <= 0) return null

    const result: Partial<SubInfo> = {}
    if (remaining > 0) {
      result.upload = 0
      result.download = Math.max(0, total - remaining)
      result.total = Math.max(total, remaining + (used || 0))
    }
    if (total > 0) result.total = total
    if (used > 0) result.download = used
    if (expire > 0) result.expire = expire
    result.source = 'group-name-inference'

    return Object.keys(result).length > 1 ? result : null
  } catch {
    return null
  }
}

export async function getSubscriptionInfo(env: Env, providerName: string): Promise<SubInfo | { error: string }> {
  const config = await getParsedConfig(env)
  const providers = config['proxy-providers'] || {}
  const provider = providers[providerName]
  if (!provider) return { error: 'Provider not found' }

  const url = (provider as any).url
  if (!url) return { error: 'Provider has no URL' }

  const ua = (provider as any).ua || 'clash-verge/v2.1.2'

  let response: Response
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': ua },
    })
  } catch (e) {
    return { error: `Fetch failed: ${(e as Error).message}` }
  }

  if (!response.ok) {
    return { error: `HTTP ${response.status} ${response.statusText}` }
  }

  const result: SubInfo = {
    upload: 0,
    download: 0,
    total: 0,
    expire: 0,
    updateInterval: 0,
    webPageUrl: '',
    source: 'header',
    details: '',
    checkedAt: Date.now(),
  }

  const userInfo = response.headers.get('subscription-userinfo')
  const parsed = parseHeader(userInfo)
  if (parsed) {
    Object.assign(result, parsed)
    result.details = [
      result.upload > 0 ? `上传 ${formatBytes(result.upload)}` : '',
      result.download > 0 ? `下载 ${formatBytes(result.download)}` : '',
      result.total > 0 ? `总量 ${formatBytes(result.total)}` : '',
      result.expire > 0 ? `到期 ${new Date(result.expire * 1000).toLocaleDateString('zh-CN')}` : '',
    ].filter(Boolean).join(' | ')
    result.source = 'header'
  }

  const updateInterval = response.headers.get('profile-update-interval')
  if (updateInterval) result.updateInterval = parseInt(updateInterval, 10) || 0

  const webPageUrl = response.headers.get('profile-web-page-url')
  if (webPageUrl) result.webPageUrl = webPageUrl

  if (!parsed) {
    try {
      const yamlText = await response.clone().text()
      const inferred = parseGroupNameUsage(yamlText)
      if (inferred) {
        Object.assign(result, inferred)
        result.details = [
          result.total > 0 ? `总量 ~${formatBytes(result.total)}` : '',
          result.download > 0 ? `已用 ~${formatBytes(result.download)}` : '',
          result.expire > 0 ? `到期 ${new Date(result.expire * 1000).toLocaleDateString('zh-CN')}` : '',
        ].filter(Boolean).join(' | ')
        result.source = 'group-name-inference'
      }
    } catch {}
  }

  return result
}

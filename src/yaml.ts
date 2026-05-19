import YAML from 'yaml'

export interface ProxyProvider {
  name?: string
  url?: string
  type?: string
  interval?: number
  'health-check'?: { enable?: boolean; url?: string; interval?: number }
  override?: Record<string, unknown>
  [key: string]: unknown
}

export interface ProxyGroup {
  name: string
  type: string
  proxies?: string[]
  'include-all'?: boolean
  'exclude-type'?: string
  filter?: string
  tolerance?: number
  url?: string
  interval?: number
  [key: string]: unknown
}

export interface Rule {
  type: string
  payload: string
  proxy: string
  noResolve?: boolean
}

export interface GeoxUrl {
  geoip?: string
  geosite?: string
  mmdb?: string
  asn?: string
}

export interface GeneralConfig {
  'mixed-port'?: number
  'allow-lan'?: boolean
  'log-level'?: string
  'ipv6'?: boolean
  'mode'?: string
  'external-controller'?: string
  'external-ui'?: string
  'geodata-mode'?: boolean
  'geox-url'?: GeoxUrl
  'find-process-mode'?: string
  'global-client-fingerprint'?: string
  'unified-delay'?: boolean
  'tcp-concurrent'?: boolean
  'profile'?: { 'store-selected'?: boolean; 'store-fake-ip'?: boolean }
  sniffer?: Record<string, unknown>
  tun?: Record<string, unknown>
  dns?: Record<string, unknown>
  [key: string]: unknown
}

export interface ClashConfig {
  general?: GeneralConfig & Record<string, unknown>
  'proxy-providers'?: Record<string, ProxyProvider>
  'proxy-groups'?: ProxyGroup[]
  rules?: string[]
  proxies?: Record<string, unknown>[]
  [key: string]: unknown
}

export function parseConfig(yamlText: string): ClashConfig {
  const doc = YAML.parse(yamlText)
  if (!doc || typeof doc !== 'object') return {}
  return doc as ClashConfig
}

export function serializeConfig(config: ClashConfig): string {
  return YAML.stringify(config, {
    lineWidth: 0,
    indent: 2,
    aliasDuplicateObjects: false,
  })
}

export function parseRule(ruleStr: string): Rule | null {
  const parts = ruleStr.split(',')
  if (parts.length < 3) return null
  const type = parts[0].trim()
  const payload = parts[1].trim()
  const proxy = parts[2].trim()
  const noResolve = parts.slice(3).some(p => p.trim() === 'no-resolve')
  return { type, payload, proxy, noResolve }
}

export function serializeRule(rule: Rule): string {
  const base = `${rule.type},${rule.payload},${rule.proxy}`
  return rule.noResolve ? `${base},no-resolve` : base
}

export function stripGeneralKeys(config: ClashConfig): ClashConfig {
  const generalKeys: (keyof GeneralConfig)[] = [
    'mixed-port', 'allow-lan', 'log-level', 'ipv6', 'mode',
    'external-controller', 'external-ui', 'external-ui-url',
    'geodata-mode', 'geox-url', 'find-process-mode',
    'global-client-fingerprint', 'unified-delay', 'tcp-concurrent',
    'profile', 'sniffer', 'tun', 'dns',
  ]
  const result: ClashConfig = {}
  for (const [key, value] of Object.entries(config)) {
    if (!generalKeys.includes(key as keyof GeneralConfig)) {
      result[key] = value
    }
  }
  return result
}

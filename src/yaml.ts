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

export interface RuleProvider {
  type?: string
  behavior?: string
  format?: string
  path?: string
  url?: string
  interval?: number
  proxy?: string
  payload?: string[]
  [key: string]: unknown
}

export interface ProxyGroup {
  name: string
  type: string
  proxies?: string[]
  use?: string[]
  'include-all'?: boolean
  'include-all-proxies'?: boolean
  'include-all-providers'?: boolean
  'exclude-type'?: string
  filter?: string
  'exclude-filter'?: string
  tolerance?: number
  url?: string
  interval?: number
  lazy?: boolean
  timeout?: number
  'max-failed-times'?: number
  'disable-udp'?: boolean
  'interface-name'?: string
  'routing-mark'?: number
  'expected-status'?: string
  strategy?: string
  hidden?: boolean
  icon?: string
  [key: string]: unknown
}

export interface ProxyAuthUser {
  username: string
  password: string
}

export interface Listener {
  name: string
  type: string
  listen?: string
  port?: number | string
  users?: Array<string | Record<string, unknown>>
  rule?: string
  proxy?: string
  [key: string]: unknown
}

export interface Rule {
  type: string
  payload: string
  proxy: string
  target?: string
  params?: string[]
  noResolve?: boolean
  src?: boolean
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
  authentication?: string[]
  listeners?: Listener[]
  'proxy-providers'?: Record<string, ProxyProvider>
  'rule-providers'?: Record<string, RuleProvider>
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
  return YAML.stringify(orderConfigForSerialize(config), {
    lineWidth: 0,
    indent: 2,
    aliasDuplicateObjects: false,
  })
}

const TOP_LEVEL_KEY_ORDER = [
  'port',
  'socks-port',
  'redir-port',
  'tproxy-port',
  'mixed-port',
  'allow-lan',
  'bind-address',
  'authentication',
  'skip-auth-prefixes',
  'lan-allowed-ips',
  'lan-disallowed-ips',
  'find-process-mode',
  'mode',
  'geodata-mode',
  'geox-url',
  'geo-auto-update',
  'geo-update-interval',
  'geosite-matcher',
  'global-client-fingerprint',
  'unified-delay',
  'tcp-concurrent',
  'log-level',
  'ipv6',
  'tls',
  'external-controller',
  'external-controller-tls',
  'secret',
  'external-controller-cors',
  'external-controller-unix',
  'external-controller-pipe',
  'external-ui',
  'external-ui-name',
  'external-ui-url',
  'external-doh-server',
  'interface-name',
  'routing-mark',
  'experimental',
  'hosts',
  'profile',
  'tun',
  'sniffer',
  'tunnels',
  'dns',
  'ntp',
  'listeners',
  'proxy-providers',
  'proxies',
  'proxy-groups',
  'rule-providers',
  'rules',
] as const

const KEY_ORDERS_BY_PATH: Record<string, readonly string[]> = {
  '': TOP_LEVEL_KEY_ORDER,
  'geox-url': ['geoip', 'geosite', 'mmdb', 'asn'],
  'profile': ['store-selected', 'store-fake-ip'],
  'sniffer': [
    'enable',
    'force-dns-mapping',
    'parse-pure-ip',
    'override-destination',
    'sniff',
    'force-domain',
    'skip-src-address',
    'skip-dst-address',
    'skip-domain',
    'sniffing',
    'port-whitelist',
  ],
  'sniffer.sniff': ['QUIC', 'TLS', 'HTTP'],
  'tun': [
    'enable',
    'stack',
    'dns-hijack',
    'auto-detect-interface',
    'auto-route',
    'mtu',
    'gso',
    'gso-max-size',
    'auto-redirect',
    'strict-route',
    'route-address-set',
    'route-exclude-address-set',
    'route-address',
    'inet4-route-address',
    'inet6-route-address',
    'endpoint-independent-nat',
    'include-interface',
    'exclude-interface',
    'include-uid',
    'include-uid-range',
    'exclude-uid',
    'exclude-uid-range',
    'include-android-user',
    'include-package',
    'exclude-package',
  ],
  'dns': [
    'cache-algorithm',
    'enable',
    'prefer-h3',
    'listen',
    'ipv6',
    'ipv6-timeout',
    'enhanced-mode',
    'fake-ip-range',
    'fake-ip-filter',
    'default-nameserver',
    'nameserver',
    'proxy-server-nameserver',
    'direct-nameserver',
    'direct-nameserver-follow-policy',
    'fallback',
    'fallback-filter',
    'nameserver-policy',
    'search-domains',
    'respect-rules',
    'use-system-hosts',
    'use-hosts',
  ],
  'proxy-providers.*': [
    'url',
    'type',
    'proxy',
    'interval',
    'path',
    'filter',
    'exclude-filter',
    'exclude-type',
    'dialer-proxy',
    'health-check',
    'override',
    'header',
  ],
  'proxy-groups.*': [
    'name',
    'type',
    'proxies',
    'use',
    'include-all',
    'include-all-proxies',
    'include-all-providers',
    'exclude-type',
    'filter',
    'exclude-filter',
    'url',
    'interval',
    'lazy',
    'timeout',
    'max-failed-times',
    'tolerance',
    'disable-udp',
    'interface-name',
    'routing-mark',
    'expected-status',
    'strategy',
    'hidden',
    'icon',
  ],
  'listeners.*': [
    'name',
    'type',
    'listen',
    'port',
    'users',
    'rule',
    'proxy',
  ],
}

function getOrderForPath(path: string[]): readonly string[] | undefined {
  const direct = KEY_ORDERS_BY_PATH[path.join('.')]
  if (direct) return direct

  const wildcardPath = path.map((segment, index) => {
    return /^\d+$/.test(segment) ? '*' : segment
  }).join('.')
  return KEY_ORDERS_BY_PATH[wildcardPath]
}

function sortKeys(keys: string[], order: readonly string[] | undefined): string[] {
  if (!order) return keys
  const rank = new Map(order.map((key, index) => [key, index]))
  return [...keys].sort((a, b) => {
    const aRank = rank.get(a)
    const bRank = rank.get(b)
    if (aRank !== undefined && bRank !== undefined) return aRank - bRank
    if (aRank !== undefined) return -1
    if (bRank !== undefined) return 1
    return 0
  })
}

function orderConfigForSerialize<T>(value: T, path: string[] = []): T {
  if (Array.isArray(value)) {
    return value.map((item, index) => orderConfigForSerialize(item, [...path, String(index)])) as T
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  const source = value as Record<string, unknown>
  const ordered: Record<string, unknown> = {}
  const keys = sortKeys(Object.keys(source), getOrderForPath(path))
  for (const key of keys) {
    ordered[key] = orderConfigForSerialize(source[key], [...path, key])
  }
  return ordered as T
}

export function splitRule(ruleStr: string): string[] {
  const parts: string[] = []
  let current = ''
  let depth = 0

  for (const ch of ruleStr) {
    if (ch === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
      continue
    }
    if (ch === '(') depth += 1
    if (ch === ')' && depth > 0) depth -= 1
    current += ch
  }

  if (current || ruleStr.endsWith(',')) {
    parts.push(current.trim())
  }

  return parts
}

export function parseRule(ruleStr: string): Rule | null {
  const parts = splitRule(ruleStr)
  if (parts.length < 2) return null

  const type = parts[0].trim()
  if (!type) return null

  const isMatch = type.toUpperCase() === 'MATCH'
  if (isMatch) {
    const target = (parts[2] ?? parts[1] ?? '').trim()
    const payload = parts.length >= 3 ? parts[1].trim() : ''
    const params = (parts.length >= 3 ? parts.slice(3) : parts.slice(2)).map(p => p.trim()).filter(Boolean)
    return {
      type,
      payload,
      proxy: target,
      target,
      params,
      noResolve: params.includes('no-resolve'),
      src: params.includes('src'),
    }
  }

  if (parts.length < 3) return null

  const payload = parts[1].trim()
  const target = parts[2].trim()
  const params = parts.slice(3).map(p => p.trim()).filter(Boolean)
  return {
    type,
    payload,
    proxy: target,
    target,
    params,
    noResolve: params.includes('no-resolve'),
    src: params.includes('src'),
  }
}

export function serializeRule(rule: Rule): string {
  const target = String(rule.target || rule.proxy || '').trim()
  const payload = String(rule.payload || '').trim()
  const extras = new Set((rule.params || []).map(p => String(p).trim()).filter(Boolean))
  if (rule.noResolve) extras.add('no-resolve')
  if (rule.src) extras.add('src')

  const parts = [String(rule.type || '').trim()]
  if (parts[0].toUpperCase() === 'MATCH' && !payload) {
    parts.push(target)
  } else {
    parts.push(payload, target)
  }
  if (extras.size) parts.push(...extras)
  return parts.join(',')
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

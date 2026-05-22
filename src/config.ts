import { parseConfig, serializeConfig, type ClashConfig } from './yaml'

const KV_CONFIG_KEY = 'config'
const KV_SUBSCRIPTION_KEY = 'subscription_key'
const KV_API_KEY_HASH = 'api_key_hash'

function kv(env: Env): KVNamespace | null {
  return (env as any).SUB_MAGIC ?? null
}

export async function getConfig(env: Env): Promise<string | null> {
  const ns = kv(env)
  if (!ns) return null
  return await ns.get(KV_CONFIG_KEY)
}

export async function saveConfig(env: Env, yamlText: string): Promise<void> {
  const ns = kv(env)
  if (!ns) return
  await ns.put(KV_CONFIG_KEY, yamlText)
}

export async function getParsedConfig(env: Env): Promise<ClashConfig> {
  const raw = await getConfig(env)
  if (!raw) return {}
  return parseConfig(raw)
}

export async function saveParsedConfig(env: Env, config: ClashConfig): Promise<void> {
  await saveConfig(env, serializeConfig(config))
}

export async function getSubscriptionKey(env: Env): Promise<string | null> {
  const ns = kv(env)
  if (!ns) return null
  return await ns.get(KV_SUBSCRIPTION_KEY)
}

export async function setSubscriptionKey(env: Env, key: string): Promise<void> {
  const ns = kv(env)
  if (!ns) return
  await ns.put(KV_SUBSCRIPTION_KEY, key)
}

export async function getApiKeyHash(env: Env): Promise<string | null> {
  const ns = kv(env)
  if (!ns) return null
  return await ns.get(KV_API_KEY_HASH)
}

export async function setApiKeyHash(env: Env, keyHash: string): Promise<void> {
  const ns = kv(env)
  if (!ns) return
  await ns.put(KV_API_KEY_HASH, keyHash)
}

const VERSIONS_INDEX_KEY = 'versions:index'

export interface ConfigVersion {
  id: string
  timestamp: number
  label: string
}

export async function saveConfigVersion(env: Env, label?: string): Promise<ConfigVersion> {
  const ns = kv(env)
  if (!ns) throw new Error('KV not bound')
  const config = await getConfig(env)
  if (!config) throw new Error('No config to save')
  const id = Date.now().toString(36) + '-' + crypto.randomUUID().slice(0, 8)
  const version: ConfigVersion = {
    id,
    timestamp: Date.now(),
    label: label || `v${id.slice(0, 8)}`,
  }
  await ns.put(`version:${id}`, config)
  const indexRaw = await ns.get(VERSIONS_INDEX_KEY)
  const index: ConfigVersion[] = indexRaw ? JSON.parse(indexRaw) : []
  index.unshift(version)
  await ns.put(VERSIONS_INDEX_KEY, JSON.stringify(index))
  return version
}

export async function getConfigVersions(env: Env): Promise<ConfigVersion[]> {
  const ns = kv(env)
  if (!ns) return []
  const raw = await ns.get(VERSIONS_INDEX_KEY)
  return raw ? JSON.parse(raw) : []
}

export async function getConfigVersion(env: Env, id: string): Promise<string | null> {
  const ns = kv(env)
  if (!ns) return null
  return await ns.get(`version:${id}`)
}

export async function restoreConfigVersion(env: Env, id: string): Promise<boolean> {
  const ns = kv(env)
  if (!ns) return false
  const config = await ns.get(`version:${id}`)
  if (!config) return false
  await ns.put('config', config)
  return true
}

export async function deleteConfigVersion(env: Env, id: string): Promise<boolean> {
  const ns = kv(env)
  if (!ns) return false
  await ns.delete(`version:${id}`)
  const indexRaw = await ns.get(VERSIONS_INDEX_KEY)
  if (indexRaw) {
    const index: ConfigVersion[] = JSON.parse(indexRaw)
    const filtered = index.filter(v => v.id !== id)
    await ns.put(VERSIONS_INDEX_KEY, JSON.stringify(filtered))
  }
  return true
}

export async function initConfigIfEmpty(env: Env): Promise<void> {
  const existing = await getConfig(env)
  if (existing) return

  const defaultYaml = `# Sub Magic - Default Configuration
mixed-port: 7890
ipv6: true
allow-lan: true
unified-delay: false
tcp-concurrent: true
external-controller: 127.0.0.1:9090
external-ui: ui
external-ui-url: "https://github.com/MetaCubeX/metacubexd/archive/refs/heads/gh-pages.zip"

geodata-mode: true
geox-url:
  geoip: "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip-lite.dat"
  geosite: "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite.dat"
  mmdb: "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/country-lite.mmdb"
  asn: "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/GeoLite2-ASN.mmdb"

find-process-mode: strict
global-client-fingerprint: chrome

profile:
  store-selected: true
  store-fake-ip: true

sniffer:
  enable: true
  sniff:
    HTTP:
      ports: [80, 8080-8880]
      override-destination: true
    TLS:
      ports: [443, 8443]
    QUIC:
      ports: [443, 8443]
  skip-domain:
    - "Mijia Cloud"
    - "+.push.apple.com"

tun:
  enable: true
  stack: mixed
  dns-hijack:
    - "any:53"
    - "tcp://any:53"
  auto-route: true
  auto-redirect: true
  auto-detect-interface: true

dns:
  enable: true
  ipv6: true
  enhanced-mode: fake-ip
  fake-ip-filter:
    - "*"
    - "+.lan"
    - "+.local"
    - "+.market.xiaomi.com"
  default-nameserver:
    - tls://223.5.5.5
    - tls://223.6.6.6
  nameserver:
    - https://doh.pub/dns-query
    - https://dns.alidns.com/dns-query

proxy-providers:
  provider1:
    url: ""
    type: http
    interval: 86400
    health-check: {enable: true, url: "https://www.gstatic.com/generate_204", interval: 300}
    override:
      additional-prefix: "[provider1]"

  provider2:
    url: ""
    type: http
    interval: 86400
    health-check: {enable: true, url: "https://www.gstatic.com/generate_204", interval: 300}
    override:
      additional-prefix: "[provider2]"

proxies:
  - name: "DIRECT"
    type: direct
    udp: true

proxy-groups:
  - name: \u9ed8\u8ba4
    type: select
    proxies: [\u81ea\u52a8\u9009\u62e9, DIRECT, \u9999\u6e2f, \u53f0\u6e7e, \u65e5\u672c, \u65b0\u52a0\u5761, \u7f8e\u56fd, \u5176\u5b83\u5730\u533a, \u5168\u90e8\u8282\u70b9]

  - name: Google
    type: select
    proxies: [\u9ed8\u8ba4, \u9999\u6e2f, \u53f0\u6e7e, \u65e5\u672c, \u65b0\u52a0\u5761, \u7f8e\u56fd, \u5176\u5b83\u5730\u533a, \u5168\u90e8\u8282\u70b9, \u81ea\u52a8\u9009\u62e9, DIRECT]

  - name: Telegram
    type: select
    proxies: [\u9ed8\u8ba4, \u9999\u6e2f, \u53f0\u6e7e, \u65e5\u672c, \u65b0\u52a0\u5761, \u7f8e\u56fd, \u5176\u5b83\u5730\u533a, \u5168\u90e8\u8282\u70b9, \u81ea\u52a8\u9009\u62e9, DIRECT]

  - name: Twitter
    type: select
    proxies: [\u9ed8\u8ba4, \u9999\u6e2f, \u53f0\u6e7e, \u65e5\u672c, \u65b0\u52a0\u5761, \u7f8e\u56fd, \u5176\u5b83\u5730\u533a, \u5168\u90e8\u8282\u70b9, \u81ea\u52a8\u9009\u62e9, DIRECT]

  - name: YouTube
    type: select
    proxies: [\u9ed8\u8ba4, \u9999\u6e2f, \u53f0\u6e7e, \u65e5\u672c, \u65b0\u52a0\u5761, \u7f8e\u56fd, \u5176\u5b83\u5730\u533a, \u5168\u90e8\u8282\u70b9, \u81ea\u52a8\u9009\u62e9, DIRECT]

  - name: NETFLIX
    type: select
    proxies: [\u9ed8\u8ba4, \u9999\u6e2f, \u53f0\u6e7e, \u65e5\u672c, \u65b0\u52a0\u5761, \u7f8e\u56fd, \u5176\u5b83\u5730\u533a, \u5168\u90e8\u8282\u70b9, \u81ea\u52a8\u9009\u62e9, DIRECT]

  - name: GitHub
    type: select
    proxies: [\u9ed8\u8ba4, \u9999\u6e2f, \u53f0\u6e7e, \u65e5\u672c, \u65b0\u52a0\u5761, \u7f8e\u56fd, \u5176\u5b83\u5730\u533a, \u5168\u90e8\u8282\u70b9, \u81ea\u52a8\u9009\u62e9, DIRECT]

  - name: \u56fd\u5185
    type: select
    proxies: [DIRECT, \u9ed8\u8ba4, \u9999\u6e2f, \u53f0\u6e7e, \u65e5\u672c, \u65b0\u52a0\u5761, \u7f8e\u56fd, \u5176\u5b83\u5730\u533a, \u5168\u90e8\u8282\u70b9, \u81ea\u52a8\u9009\u62e9]

  - name: \u5176\u4ed6
    type: select
    proxies: [\u9ed8\u8ba4, \u9999\u6e2f, \u53f0\u6e7e, \u65e5\u672c, \u65b0\u52a0\u5761, \u7f8e\u56fd, \u5176\u5b83\u5730\u533a, \u5168\u90e8\u8282\u70b9, \u81ea\u52a8\u9009\u62e9, DIRECT]

  - name: \u9999\u6e2f
    type: select
    include-all: true
    exclude-type: direct
    filter: "(?i)\u6e2f|hk|hongkong|hong kong"

  - name: \u53f0\u6e7e
    type: select
    include-all: true
    exclude-type: direct
    filter: "(?i)\u53f0|tw|taiwan"

  - name: \u65e5\u672c
    type: select
    include-all: true
    exclude-type: direct
    filter: "(?i)\u65e5|jp|japan"

  - name: \u7f8e\u56fd
    type: select
    include-all: true
    exclude-type: direct
    filter: "(?i)\u7f8e|us|unitedstates|united states"

  - name: \u65b0\u52a0\u5761
    type: select
    include-all: true
    exclude-type: direct
    filter: "(?i)(\u65b0|sg|singapore)"

  - name: \u5176\u5b83\u5730\u533a
    type: select
    include-all: true
    exclude-type: direct
    filter: "(?i)^(?!.*(?:\\U0001f1ed\\U0001f1f0|\\U0001f1ef\\U0001f1f5|\\U0001f1fa\\U0001f1f8|\\U0001f1f8\\U0001f1ec|\\U0001f1e8\\U0001f1f3|\u6e2f|hk|hongkong|\u53f0|tw|taiwan|\u65e5|jp|japan|\u65b0|sg|singapore|\u7f8e|us|unitedstates)).*"

  - name: \u5168\u90e8\u8282\u70b9
    type: select
    include-all: true
    exclude-type: direct

  - name: \u81ea\u52a8\u9009\u62e9
    type: url-test
    include-all: true
    exclude-type: direct
    tolerance: 10

rules:
  - GEOIP,lan,DIRECT,no-resolve
  - GEOSITE,github,GitHub
  - GEOSITE,twitter,Twitter
  - GEOSITE,youtube,YouTube
  - GEOSITE,google,Google
  - GEOSITE,telegram,Telegram
  - GEOSITE,netflix,NETFLIX
  - GEOSITE,CN,\u56fd\u5185
  - GEOSITE,geolocation-!cn,\u5176\u4ed6
  - GEOIP,google,Google
  - GEOIP,netflix,NETFLIX
  - GEOIP,telegram,Telegram
  - GEOIP,twitter,Twitter
  - GEOIP,CN,\u56fd\u5185
  - MATCH,\u5176\u4ed6
  `

  await saveConfig(env, defaultYaml)
}

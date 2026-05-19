import { parseConfig, serializeConfig, type ClashConfig } from './yaml'

const KV_CONFIG_KEY = 'config'
const KV_ACCESS_KEY = 'access_key'

export async function getConfig(env: Env): Promise<string | null> {
  return await env.SUB_MAGIC.get(KV_CONFIG_KEY)
}

export async function saveConfig(env: Env, yamlText: string): Promise<void> {
  await env.SUB_MAGIC.put(KV_CONFIG_KEY, yamlText)
}

export async function getParsedConfig(env: Env): Promise<ClashConfig> {
  const raw = await getConfig(env)
  if (!raw) return {}
  return parseConfig(raw)
}

export async function saveParsedConfig(env: Env, config: ClashConfig): Promise<void> {
  await saveConfig(env, serializeConfig(config))
}

export async function getAccessKey(env: Env): Promise<string | null> {
  return await env.SUB_MAGIC.get(KV_ACCESS_KEY)
}

export async function setAccessKey(env: Env, key: string): Promise<void> {
  await env.SUB_MAGIC.put(KV_ACCESS_KEY, key)
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

  const existingKey = await getAccessKey(env)
  if (!existingKey) {
    const key = crypto.randomUUID().replace(/-/g, '')
    await setAccessKey(env, key)
  }
}

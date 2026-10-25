import { env, createExecutionContext, waitOnExecutionContext, SELF } from "cloudflare:test"
import { describe, it, expect, beforeEach } from "vitest"
import worker from "../src"
import { parseConfig, serializeConfig, parseRule, serializeRule } from "../src/yaml"
import { hashKey } from "../src/auth"

const TEST_PASSWORD = "sub-magic-test-password"

beforeEach(async () => {
  await env.SUB_MAGIC.put("config", `mixed-port: 7890
proxy-providers:
  p1:
    url: "https://example.com/sub"
    type: http
    interval: 86400
proxy-groups:
  - name: Proxy
    type: select
    proxies: [DIRECT, p1]
rules:
  - GEOIP,CN,DIRECT
  - MATCH,Proxy
proxies:
  - name: DIRECT
    type: direct
`)
  await env.SUB_MAGIC.put("subscription_key", "sm_sub_testkey123")
  await env.SUB_MAGIC.put("api_key_hash", await hashKey("sm_api_testkey456"))
  await env.SUB_MAGIC.put("password_hash", await hashKey(TEST_PASSWORD))
})

describe("YAML utilities", () => {
  it("parseConfig returns structured object", () => {
    const config = parseConfig("mixed-port: 7890\nproxy-groups:\n  - name: Test\n    type: select\n")
    expect(config["mixed-port"]).toBe(7890)
    expect(config["proxy-groups"]).toHaveLength(1)
    expect(config["proxy-groups"]![0].name).toBe("Test")
  })

  it("serializeConfig round-trips", () => {
    const yaml = "mixed-port: 7890\nproxy-groups:\n  - name: Test\n    type: select\n"
    const parsed = parseConfig(yaml)
    const serialized = serializeConfig(parsed)
    expect(serialized).toContain("mixed-port: 7890")
    expect(serialized).toContain("Test")
  })

  it("serializeConfig orders top-level and nested keys for readability", () => {
    const serialized = serializeConfig({
      rules: ['MATCH,Proxy'],
      dns: {
        nameserver: ['https://1.1.1.1/dns-query'],
        enable: true,
        ipv6: true,
      },
      profile: {
        'store-fake-ip': true,
        'store-selected': true,
      },
      'proxy-groups': [{ type: 'select', name: 'Proxy', interval: 300, proxies: ['DIRECT'] }],
      'mixed-port': 7890,
      'proxy-providers': {
        demo: {
          interval: 86400,
          type: 'http',
          url: 'https://example.com/sub',
        },
      },
    })

    expect(serialized.indexOf('mixed-port: 7890')).toBeLessThan(serialized.indexOf('profile:'))
    expect(serialized.indexOf('profile:')).toBeLessThan(serialized.indexOf('dns:'))
    expect(serialized.indexOf('dns:')).toBeLessThan(serialized.indexOf('proxy-providers:'))
    expect(serialized.indexOf('proxy-providers:')).toBeLessThan(serialized.indexOf('proxy-groups:'))
    expect(serialized.indexOf('proxy-groups:')).toBeLessThan(serialized.indexOf('rules:'))
    expect(serialized).toContain('store-selected: true\n  store-fake-ip: true')
    expect(serialized).toContain('enable: true\n  ipv6: true\n  nameserver:')
    expect(serialized).toContain('- name: Proxy\n    type: select\n    proxies:\n      - DIRECT\n    interval: 300')
    expect(serialized).toContain('url: https://example.com/sub\n    type: http\n    interval: 86400')
  })

  it("parseRule parses rule string", () => {
    const rule = parseRule("GEOIP,CN,DIRECT,no-resolve")
    expect(rule).not.toBeNull()
    expect(rule!.type).toBe("GEOIP")
    expect(rule!.payload).toBe("CN")
    expect(rule!.proxy).toBe("DIRECT")
    expect(rule!.noResolve).toBe(true)
  })

  it("serializeRule produces correct string", () => {
    expect(serializeRule({ type: "MATCH", payload: "", proxy: "Proxy" })).toBe("MATCH,Proxy")
    expect(serializeRule({ type: "GEOIP", payload: "CN", proxy: "DIRECT", noResolve: true })).toBe("GEOIP,CN,DIRECT,no-resolve")
  })

  it("parseRule handles MATCH shorthand and logic payloads", () => {
    const matchRule = parseRule("MATCH,Proxy")
    expect(matchRule).not.toBeNull()
    expect(matchRule!.type).toBe("MATCH")
    expect(matchRule!.payload).toBe("")
    expect(matchRule!.proxy).toBe("Proxy")

    const logicRule = parseRule("AND,((DOMAIN,baidu.com),(NETWORK,UDP)),DIRECT")
    expect(logicRule).not.toBeNull()
    expect(logicRule!.type).toBe("AND")
    expect(logicRule!.payload).toBe("((DOMAIN,baidu.com),(NETWORK,UDP))")
    expect(logicRule!.proxy).toBe("DIRECT")
  })

  it("parseRule returns null for invalid rule", () => {
    expect(parseRule("invalid")).toBeNull()
  })
})

describe("Auth", () => {
  it("login with wrong password returns 401", async () => {
    const res = await SELF.fetch("http://example.com/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    })
    expect(res.status).toBe(401)
  })

  it("login with empty password returns 401", async () => {
    const res = await SELF.fetch("http://example.com/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "" }),
    })
    expect(res.status).toBe(401)
  })

  it("check without auth returns 401", async () => {
    const res = await SELF.fetch("http://example.com/api/check")
    expect(res.status).toBe(401)
  })
})

describe("Subscription endpoint", () => {
  it("returns config with valid key", async () => {
    const res = await SELF.fetch("http://example.com/sub/sm_sub_testkey123")
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toContain("text/yaml")
    const text = await res.text()
    expect(text).toContain("mixed-port: 7890")
  })

  it("returns 403 with invalid key", async () => {
    const res = await SELF.fetch("http://example.com/sub/wrongkey")
    expect(res.status).toBe(403)
  })

  it("returns 400 with short key", async () => {
    const res = await SELF.fetch("http://example.com/sub/ab")
    expect(res.status).toBe(400)
  })
})

describe("API endpoints", () => {
  let cookie = ""

  async function login() {
    const res = await SELF.fetch("http://example.com/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: TEST_PASSWORD }),
    })
    cookie = res.headers.get("Set-Cookie") || ""
  }

  beforeEach(async () => {
    await login()
  })

  it("GET /api/config returns config", async () => {
    const res = await SELF.fetch("http://example.com/api/config", { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.config).toContain("mixed-port: 7890")
  })

  it("PUT /api/config saves config", async () => {
    const res = await SELF.fetch("http://example.com/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ config: "mixed-port: 9999\n" }),
    })
    expect(res.status).toBe(200)
    const stored = await env.SUB_MAGIC.get("config")
    expect(stored).toContain("mixed-port: 9999")
  })

  it("GET /api/config/proxy-providers returns list", async () => {
    const res = await SELF.fetch("http://example.com/api/config/proxy-providers", { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    const list = await res.json()
    expect(Array.isArray(list)).toBe(true)
    expect(list[0].name).toBe("p1")
  })

  it("POST /api/config/proxy-providers adds a provider", async () => {
    const res = await SELF.fetch("http://example.com/api/config/proxy-providers", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: "p2", url: "https://example.com/sub2", type: "http" }),
    })
    expect(res.status).toBe(200)
    const stored = await env.SUB_MAGIC.get("config")
    expect(stored).toContain("p2")
  })

  it("DELETE /api/config/proxy-providers/p1 removes provider", async () => {
    const res = await SELF.fetch("http://example.com/api/config/proxy-providers/p1", {
      method: "DELETE",
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(200)
    const stored = await env.SUB_MAGIC.get("config")
    expect(stored).not.toContain("url: https://example.com/sub")
  })

  it("GET /api/config/proxy-groups returns groups", async () => {
    const res = await SELF.fetch("http://example.com/api/config/proxy-groups", { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    const groups = await res.json()
    expect(Array.isArray(groups)).toBe(true)
    expect(groups[0].name).toBe("Proxy")
  })

  it("GET /api/config/rules returns parsed rules", async () => {
    const res = await SELF.fetch("http://example.com/api/config/rules", { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    const rules = await res.json()
    expect(rules.length).toBe(2)
    expect(rules[0].type).toBe("GEOIP")
    expect(rules[0].payload).toBe("CN")
    expect(rules[0].proxy).toBe("DIRECT")
  })

  it("GET /api/config/proxy-groups accepts access key and returns CORS headers", async () => {
    const res = await SELF.fetch("http://example.com/api/config/proxy-groups", {
      headers: {
        Authorization: "Bearer sm_api_testkey456",
        Origin: "chrome-extension://test",
      },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("chrome-extension://test")
    const groups = await res.json()
    expect(groups[0].name).toBe("Proxy")
  })

  it("POST /api/config/rule-providers accepts access key", async () => {
    const res = await SELF.fetch("http://example.com/api/config/rule-providers", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer sm_api_testkey456",
        Origin: "chrome-extension://test",
      },
      body: JSON.stringify({
        name: "IpCheck",
        type: "inline",
        behavior: "classical",
        format: "yaml",
        payload: ["AND,((IN-USER,IpCheck),(DOMAIN-SUFFIX,ip.sb))"],
      }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("chrome-extension://test")
    const stored = await env.SUB_MAGIC.get("config")
    expect(stored).toContain("rule-providers:")
    expect(stored).toContain("IpCheck:")
    expect(stored).toContain("AND,((IN-USER,IpCheck),(DOMAIN-SUFFIX,ip.sb))")
  })

  it("POST /api/config/proxy-groups accepts access key", async () => {
    const res = await SELF.fetch("http://example.com/api/config/proxy-groups", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer sm_api_testkey456",
        Origin: "chrome-extension://test",
      },
      body: JSON.stringify({
        name: "IpCheck",
        type: "select",
        proxies: ["Proxy"],
      }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("chrome-extension://test")
    const stored = await env.SUB_MAGIC.get("config")
    expect(stored).toContain("name: IpCheck")
  })

  it("POST /api/config/rules accepts access key", async () => {
    const res = await SELF.fetch("http://example.com/api/config/rules", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer sm_api_testkey456",
        Origin: "chrome-extension://test",
      },
      body: JSON.stringify({ raw: "RULE-SET,IpCheck,IpCheck" }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("chrome-extension://test")
    const stored = await env.SUB_MAGIC.get("config")
    expect(stored).toContain("RULE-SET,IpCheck,IpCheck")
  })

  it("POST /api/config/rules adds a rule", async () => {
    const res = await SELF.fetch("http://example.com/api/config/rules", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ raw: "DOMAIN-SUFFIX,example.com,Proxy" }),
    })
    expect(res.status).toBe(200)
  })

  it("DELETE /api/config/rules/0 removes first rule", async () => {
    const res = await SELF.fetch("http://example.com/api/config/rules/0", {
      method: "DELETE",
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(200)
    const stored = await env.SUB_MAGIC.get("config")
    expect(stored).not.toContain("GEOIP,CN,DIRECT")
  })

  it("GET /api/access-key returns key", async () => {
    const res = await SELF.fetch("http://example.com/api/access-key", { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.subscriptionKey).toBe("sm_sub_testkey123")
    expect(data.apiKey).toBeNull()
    expect(data.subscriptionKeyPresent).toBe(true)
    expect(data.apiKeyPresent).toBe(true)
  })

  it("POST /api/access-key rotates key", async () => {
    const res = await SELF.fetch("http://example.com/api/access-key", {
      method: "POST",
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.subscriptionKey).toContain("sm_sub_")
    expect(data.apiKey).toContain("sm_api_")
  })

  it("POST /api/rules/add adds a rule before MATCH", async () => {
    const res = await SELF.fetch("http://example.com/api/rules/add", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer sm_api_testkey456",
        Origin: "chrome-extension://test",
      },
      body: JSON.stringify({ rule: "DOMAIN-SUFFIX,example.com,Proxy" }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("chrome-extension://test")
    const stored = await env.SUB_MAGIC.get("config")
    expect(stored).toContain("DOMAIN-SUFFIX,example.com,Proxy")
    expect(stored?.indexOf("DOMAIN-SUFFIX,example.com,Proxy")).toBeLessThan(stored?.indexOf("MATCH,Proxy") ?? 0)
  })

  it("POST /api/rules/add inserts a rule after the selected previous rule", async () => {
    const res = await SELF.fetch("http://example.com/api/rules/add", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer sm_api_testkey456",
      },
      body: JSON.stringify({
        rule: "DOMAIN-SUFFIX,example.com,Proxy",
        insertAfter: "GEOIP,CN,DIRECT",
      }),
    })
    expect(res.status).toBe(200)
    const stored = await env.SUB_MAGIC.get("config")
    expect(stored?.indexOf("GEOIP,CN,DIRECT")).toBeLessThan(stored?.indexOf("DOMAIN-SUFFIX,example.com,Proxy") ?? 0)
    expect(stored?.indexOf("DOMAIN-SUFFIX,example.com,Proxy")).toBeLessThan(stored?.indexOf("MATCH,Proxy") ?? 0)
  })

  it("POST /api/rules/update updates an existing rule", async () => {
    const res = await SELF.fetch("http://example.com/api/rules/update", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer sm_api_testkey456",
      },
      body: JSON.stringify({
        oldRule: "GEOIP,CN,DIRECT",
        newRule: "GEOIP,CN,Proxy",
      }),
    })
    expect(res.status).toBe(200)
    const stored = await env.SUB_MAGIC.get("config")
    expect(stored).toContain("GEOIP,CN,Proxy")
    expect(stored).not.toContain("GEOIP,CN,DIRECT")
  })

  it("POST /api/rules/update can reorder an existing rule to the top", async () => {
    const res = await SELF.fetch("http://example.com/api/rules/update", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer sm_api_testkey456",
      },
      body: JSON.stringify({
        oldRule: "MATCH,Proxy",
        newRule: "MATCH,Proxy",
        insertAfter: "",
      }),
    })
    expect(res.status).toBe(200)
    const stored = await env.SUB_MAGIC.get("config")
    expect(stored?.indexOf("MATCH,Proxy")).toBeLessThan(stored?.indexOf("GEOIP,CN,DIRECT") ?? 0)
  })

  it("POST /api/rules/add rejects missing API key", async () => {
    const res = await SELF.fetch("http://example.com/api/rules/add", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "chrome-extension://test" },
      body: JSON.stringify({ rule: "DOMAIN-SUFFIX,example.com,Proxy" }),
    })
    expect(res.status).toBe(401)
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer")
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("chrome-extension://test")
  })

  it("OPTIONS /api/rules/add returns CORS preflight headers", async () => {
    const res = await SELF.fetch("http://example.com/api/rules/add", {
      method: "OPTIONS",
      headers: {
        Origin: "chrome-extension://test",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("chrome-extension://test")
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("authorization")
  })

})

describe("Comment & anchor preserving writes", () => {
  const HAND_WRITTEN = `# ═════════════════════════════
#  手写配置：注释与锚点必须活下来
# ═════════════════════════════

mixed-port: 7890
unified-delay: true            # 行尾注释
mode: rule

proxy-providers:
  # 主订阅
  main:
    url: "https://example.com/sub"
    type: http
    interval: 86400

# ── 策略组 ──────────────────────
proxy-groups:
  # 总控
  - name: 默认
    type: select
    proxies: [自动选择, DIRECT]

  # 平台服务（&svc 复用出口清单）
  - name: Google
    type: select
    proxies: &svc [默认, 香港, DIRECT]
  - name: YouTube
    type: select
    proxies: *svc

# ── 规则 ───────────────────────
rules:
  # 局域网
  - GEOIP,lan,DIRECT,no-resolve
  - GEOSITE,google,Google
  - MATCH,默认
`

  let cookie = ""

  async function putConfig(config: string) {
    const res = await SELF.fetch("http://example.com/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ config }),
    })
    expect(res.status).toBe(200)
    return res
  }

  async function getConfigText(): Promise<string> {
    const res = await SELF.fetch("http://example.com/api/config", { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    const data = await res.json() as { config: string }
    return data.config
  }

  beforeEach(async () => {
    const res = await SELF.fetch("http://example.com/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: TEST_PASSWORD }),
    })
    cookie = res.headers.get("Set-Cookie") || ""
    await putConfig(HAND_WRITTEN)
  })

  it("stores the edited text verbatim", async () => {
    // 文本编辑保存后连行尾注释对齐都不变
    expect(await getConfigText()).toBe(HAND_WRITTEN)
  })

  it("serves the subscription with comments and anchors intact", async () => {
    const res = await SELF.fetch("http://example.com/sub/sm_sub_testkey123")
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toBe(HAND_WRITTEN)
    expect(text).toContain("&svc")
    expect(text).toContain("*svc")
  })

  it("appending a rule keeps comments and anchors", async () => {
    const res = await SELF.fetch("http://example.com/api/config/rules", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ raw: "DOMAIN-SUFFIX,shopee.sg,默认" }),
    })
    expect(res.status).toBe(200)

    const text = await getConfigText()
    expect(text).toContain("# 平台服务（&svc 复用出口清单）")
    expect(text).toContain("proxies: &svc [默认, 香港, DIRECT]")
    expect(text).toContain("proxies: *svc")
    expect(text).toContain("- DOMAIN-SUFFIX,shopee.sg,默认")
    // 只新增一行，其余内容逐字节不变
    expect(text.replace("  - DOMAIN-SUFFIX,shopee.sg,默认\n", "")).toBe(HAND_WRITTEN)
  })

  it("POST /api/rules/add before MATCH keeps hand-written formatting", async () => {
    const res = await SELF.fetch("http://example.com/api/rules/add", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sm_api_testkey456" },
      body: JSON.stringify({ rule: "GEOSITE,shopee,默认" }),
    })
    expect(res.status).toBe(200)

    const text = await getConfigText()
    expect(text).toContain("  # 局域网\n  - GEOIP,lan,DIRECT,no-resolve\n  - GEOSITE,google,Google\n  - GEOSITE,shopee,默认\n  - MATCH,默认")
    expect(text).toContain("&svc")
  })

  it("editing the anchor owner group updates every alias", async () => {
    const res = await SELF.fetch("http://example.com/api/config/proxy-groups/Google", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: "Google", type: "select", proxies: ["默认", "香港", "日本", "DIRECT"] }),
    })
    expect(res.status).toBe(200)

    const text = await getConfigText()
    expect(text).toContain("proxies: &svc [默认, 香港, 日本, DIRECT]")
    expect(text).toContain("  - name: YouTube\n    type: select\n    proxies: *svc")
    expect(text).toContain("# 平台服务（&svc 复用出口清单）")

    const groups = await (await SELF.fetch("http://example.com/api/config/proxy-groups", { headers: { Cookie: cookie } })).json() as Array<{ name: string, proxies: string[] }>
    expect(groups[1].proxies).toEqual(["默认", "香港", "日本", "DIRECT"])
    expect(groups[2].proxies).toEqual(["默认", "香港", "日本", "DIRECT"])
  })

  it("deleting the anchor owner keeps the config valid", async () => {
    const res = await SELF.fetch("http://example.com/api/config/proxy-groups/Google", {
      method: "DELETE",
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(200)

    const text = await getConfigText()
    expect(text).not.toContain("&svc")
    expect(text).not.toContain("*svc")
    expect(text).toContain("  - name: YouTube\n    type: select\n    proxies: [默认, 香港, DIRECT]")

    const groups = await (await SELF.fetch("http://example.com/api/config/proxy-groups", { headers: { Cookie: cookie } })).json() as Array<{ name: string, proxies: string[] }>
    expect(groups.map(group => group.name)).toEqual(["默认", "YouTube"])
    expect(groups[1].proxies).toEqual(["默认", "香港", "DIRECT"])
  })

  it("updating a provider keeps neighbouring comments", async () => {
    const res = await SELF.fetch("http://example.com/api/config/proxy-providers/main", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ url: "https://example.com/sub2", type: "http", interval: 3600 }),
    })
    expect(res.status).toBe(200)

    const text = await getConfigText()
    // 原有引号风格也保留下来，只改变化的值
    expect(text).toContain('# 主订阅\n  main:\n    url: "https://example.com/sub2"\n    type: http\n    interval: 3600')
    expect(text).toContain("# ── 策略组 ──────────────────────")
  })
})

import { env, createExecutionContext, waitOnExecutionContext, SELF } from "cloudflare:test"
import { describe, it, expect, beforeEach } from "vitest"
import worker from "../src"
import { parseConfig, serializeConfig, parseRule, serializeRule } from "../src/yaml"

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
  await env.SUB_MAGIC.put("access_key", "testkey123")
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

  it("parseRule parses rule string", () => {
    const rule = parseRule("GEOIP,CN,DIRECT,no-resolve")
    expect(rule).not.toBeNull()
    expect(rule!.type).toBe("GEOIP")
    expect(rule!.payload).toBe("CN")
    expect(rule!.proxy).toBe("DIRECT")
    expect(rule!.noResolve).toBe(true)
  })

  it("serializeRule produces correct string", () => {
    expect(serializeRule({ type: "MATCH", payload: "", proxy: "Proxy" })).toBe("MATCH,,Proxy")
    expect(serializeRule({ type: "GEOIP", payload: "CN", proxy: "DIRECT", noResolve: true })).toBe("GEOIP,CN,DIRECT,no-resolve")
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
    const res = await SELF.fetch("http://example.com/sub/testkey123")
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
      body: JSON.stringify({ password: env.PASSWORD }),
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
    expect(data.key).toBe("testkey123")
  })

  it("POST /api/access-key rotates key", async () => {
    const res = await SELF.fetch("http://example.com/api/access-key", {
      method: "POST",
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.key).not.toBe("testkey123")
    expect(data.key.length).toBeGreaterThan(8)
  })
})

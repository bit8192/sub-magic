import { describe, it, expect } from 'vitest'
import { ConfigDocument } from '../src/config-doc'

/** 手写风格的配置：带分区注释、行尾注释、锚点与别名 */
const FIXTURE = `# ═══════════════════════════════════════════
#  手写配置：注释 + 锚点 都要活下来
# ═══════════════════════════════════════════

mixed-port: 7890
unified-delay: true            # 行尾注释不能被吞掉
mode: rule

# ── ⑧ 策略组 ────────────────────────────────
proxy-groups:
  # ⑧-0 总控
  - name: 默认
    type: select
    proxies: [自动选择, DIRECT]

  # ⑧-1 平台服务（锚点 &svc 复用同一出口清单）
  - name: Google
    type: select
    proxies: &svc [默认, 香港, 日本, DIRECT]
  - name: YouTube
    type: select
    proxies: *svc
  - name: Netflix
    type: select
    proxies: *svc

rule-providers:
  # 内联规则集
  shopee:
    type: inline
    behavior: domain
    payload:
      - shopee.sg
      - shopee.co.id

# ── ⑨ 规则 ─────────────────────────────────
rules:
  # ⑨-1 局域网
  - GEOIP,lan,DIRECT,no-resolve
  # ⑨-2 平台
  - GEOSITE,google,Google
  - GEOSITE,youtube,YouTube
  - MATCH,默认
`

function parse(document = FIXTURE): ConfigDocument {
  return ConfigDocument.parse(document)
}

describe('ConfigDocument', () => {
  it('round-trips comments, anchors and aliases', () => {
    const output = parse().toString()

    expect(output).toContain('#  手写配置：注释 + 锚点 都要活下来')
    expect(output).toContain('# ⑧-1 平台服务（锚点 &svc 复用同一出口清单）')
    expect(output).toContain('unified-delay: true # 行尾注释不能被吞掉')
    expect(output).toContain('proxies: &svc [默认, 香港, 日本, DIRECT]')
    expect(output).toContain('proxies: *svc')
    // 别名不会被展开成重复清单
    expect(output.match(/默认, 香港, 日本, DIRECT/g)).toHaveLength(1)
  })

  it('insertAt adds a rule without touching neighbours comments', () => {
    const doc = parse()
    const rules = doc.getIn<string[]>(['rules']) ?? []
    const matchIdx = rules.findIndex(rule => rule.startsWith('MATCH'))

    doc.insertAt(['rules'], matchIdx, 'GEOSITE,shopee,默认')
    const output = doc.toString()

    expect(output).toContain('  # ⑨-2 平台\n  - GEOSITE,google,Google\n  - GEOSITE,youtube,YouTube\n  - GEOSITE,shopee,默认\n  - MATCH,默认')
    expect(output).toContain('# ═══════════════════════════════════════════')
    expect(doc.getIn<string[]>(['rules'])).toHaveLength(rules.length + 1)
  })

  it('replacing an aliased group only affects that group', () => {
    const doc = parse()
    doc.setIn(['proxy-groups', 2, 'proxies'], ['默认', 'DIRECT'])

    const output = doc.toString()
    expect(output).toContain('proxies: &svc [默认, 香港, 日本, DIRECT]')
    expect(output).toContain('  - name: YouTube\n    type: select\n    proxies: [默认, DIRECT]\n')
    expect(output).toContain('  - name: Netflix\n    type: select\n    proxies: *svc\n')
  })

  it('editing the anchor owner updates every alias', () => {
    const doc = parse()
    doc.setIn(['proxy-groups', 1, 'proxies'], ['默认', '香港', '日本', '新加坡', 'DIRECT'])

    const output = doc.toString()
    expect(output).toContain('proxies: &svc [默认, 香港, 日本, 新加坡, DIRECT]')
    expect(output.match(/\*svc/g)).toHaveLength(2)

    const groups = doc.getIn<Array<{ name: string, proxies: string[] }>>(['proxy-groups']) ?? []
    expect(groups[1].proxies).toEqual(['默认', '香港', '日本', '新加坡', 'DIRECT'])
    expect(groups[2].proxies).toEqual(['默认', '香港', '日本', '新加坡', 'DIRECT'])
  })

  it('updateMap keeps the group comment and YAML valid', () => {
    const doc = parse()
    doc.updateMap(['proxy-groups', 1], { name: 'Google', type: 'select', proxies: ['默认', 'DIRECT'], icon: 'google.png' })

    const output = doc.toString()
    expect(output).toContain('# ⑧-1 平台服务（锚点 &svc 复用同一出口清单）')
    expect(output).toContain('proxies: &svc [默认, DIRECT]\n    icon: google.png')
    expect(doc.getIn<Array<{ name: string, proxies: string[] }>>(['proxy-groups'])?.[2].proxies).toEqual(['默认', 'DIRECT'])
  })

  it('deleting a group that owns an anchor materializes its aliases', () => {
    const doc = parse()
    doc.deleteIn(['proxy-groups', 1])

    const output = doc.toString()
    expect(output).not.toContain('&svc')
    expect(output).not.toContain('*svc')
    expect(output).toContain('  - name: YouTube\n    type: select\n    proxies: [默认, 香港, 日本, DIRECT]\n')
    // 删除后仍是合法 YAML，别名已就地展开
    expect(() => doc.validate()).not.toThrow()
    expect(doc.getIn<string[]>(['proxy-groups', 0, 'proxies'])).toEqual(['自动选择', 'DIRECT'])
  })

  it('syncSeq reorders rules and keeps their comments', () => {
    const doc = parse()
    const rules = doc.getIn<string[]>(['rules']) ?? []
    const reordered = [...rules].reverse()

    doc.syncSeq(['rules'], reordered, value => String(value))
    const output = doc.toString()

    expect(output.indexOf('- MATCH,默认')).toBeLessThan(output.indexOf('- GEOSITE,youtube,YouTube'))
    // 注释跟着所属规则一起移动（值相同的节点被复用）
    expect(output).toContain('# ⑨-1 局域网')
    expect(output.match(/# ⑨-2 平台/g)).toHaveLength(1)
    expect(doc.getIn<string[]>(['rules'])).toEqual(reordered)
  })

  it('adds and removes providers while keeping other entries intact', () => {
    const doc = parse()
    doc.updateMap(['proxy-providers', 'demo'], {
      url: 'https://example.com/sub',
      type: 'http',
      interval: 3600,
      'health-check': { enable: true, url: 'https://www.gstatic.com/generate_204' },
    })
    expect(doc.toString()).toContain('demo:\n    url: https://example.com/sub\n    type: http\n    interval: 3600')

    doc.deleteIn(['proxy-providers', 'demo'])
    const output = doc.toString()
    expect(output).not.toContain('demo:')
    expect(output).toContain('# 内联规则集\n  shopee:')
    expect(output).toContain('# ── ⑨ 规则 ─────────────────────────────────')
  })

  it('keeps duplicate rules distinct when syncing', () => {
    const doc = ConfigDocument.parse('rules:\n  - MATCH,Proxy\n  - MATCH,Proxy\n  - GEOIP,CN,DIRECT\n')
    doc.syncSeq(['rules'], ['MATCH,Proxy', 'GEOIP,CN,DIRECT'], value => String(value))
    expect(doc.getIn<string[]>(['rules'])).toEqual(['MATCH,Proxy', 'GEOIP,CN,DIRECT'])
  })

  it('serialize() returns the original text untouched when nothing changed', () => {
    const doc = parse()
    expect(doc.serialize()).toBe(FIXTURE)
  })

  it('serialize() only rewrites the changed lines', () => {
    const doc = parse()
    const rules = doc.getIn<string[]>(['rules']) ?? []
    doc.insertAt(['rules'], rules.findIndex(rule => rule.startsWith('MATCH')), 'GEOSITE,shopee,默认')

    const output = doc.serialize()
    const originalLines = FIXTURE.split('\n')
    const outputLines = output.split('\n')
    expect(outputLines).toHaveLength(originalLines.length + 1)

    // 去掉新增的那一行后，剩余内容与原文逐字节相同（含对齐空格）
    const insertedIdx = outputLines.indexOf('  - GEOSITE,shopee,默认')
    outputLines.splice(insertedIdx, 1)
    expect(outputLines).toEqual(originalLines)
    expect(output).toContain('unified-delay: true            # 行尾注释不能被吞掉')
  })

  it('follows the original indentation when creating new nodes', () => {
    const source = 'mixed-port: 7890\nproxy-groups:\n    - name: Proxy\n      type: select\n'
    const doc = ConfigDocument.parse(source)
    doc.updateMap(['proxy-groups', 0], { name: 'Proxy', type: 'select', proxies: ['DIRECT'], interval: 300 })

    const output = doc.serialize()
    expect(output).toContain('    - name: Proxy\n      type: select\n')
    expect(output).toContain('      interval: 300')
    expect(output.split('\n').filter(line => line.includes('proxies:') || line.includes('interval:'))).toHaveLength(2)
  })

  it('understands merge keys and keeps them elsewhere', () => {
    const source = `base: &base
  type: select
  interval: 300
proxy-groups:
  - <<: *base
    name: A
  - <<: *base
    name: B
rules:
  - MATCH,A
`
    const doc = ConfigDocument.parse(source)
    // 读的时候展开继承字段（与 mihomo 的解析一致）
    expect(doc.getIn<{ interval: number }>(['proxy-groups', 0])).toMatchObject({ name: 'A', type: 'select', interval: 300 })

    // 只改 A 的名称：A 变成显式字段，B 仍然复用 <<: *base
    doc.updateMap(['proxy-groups', 0], { name: 'A', type: 'select' })
    const output = doc.serialize()
    expect(output).toContain('  - <<: *base\n    name: B')
    expect(output).toContain('rules:\n  - MATCH,A')
    expect(() => doc.validate()).not.toThrow()
  })

  it('creates missing sections on demand', () => {
    const doc = ConfigDocument.fromText(null)
    doc.updateMap(['proxy-groups', 0], { name: 'Proxy', type: 'select', proxies: ['DIRECT'] })
    expect(doc.toString()).toBe('proxy-groups:\n  - name: Proxy\n    type: select\n    proxies:\n      - DIRECT\n')
  })
})

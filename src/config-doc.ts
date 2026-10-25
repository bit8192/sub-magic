import YAML, {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  visit,
  type Document,
  type Node,
  type Pair,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml'
import { orderConfigValue, type ClashConfig } from './yaml'

export type ConfigPath = (string | number)[]

/**
 * 与手写配置保持一致的输出风格：
 * - lineWidth: 0      不折行（长规则、长正则保持一行）
 * - indent            沿用原文的缩进宽度（2 / 4 空格）
 * - flowCollectionPadding: false  `[a, b]` 而不是 `[ a, b ]`
 */
function stringifyOptions(indent: number) {
  return {
    lineWidth: 0,
    indent,
    flowCollectionPadding: false,
    aliasDuplicateObjects: false,
  } as const
}

/** 从手写文本推断缩进宽度（取第一处缩进） */
function detectIndent(text: string): number {
  const match = /\n( +)\S/.exec(text)
  return match ? Math.min(match[1].length, 8) : 2
}

interface LocatedNode {
  parent: Node | null
  key: string | number | null
  node: Node | undefined
}

function resolveAlias(doc: Document, node: Node | undefined): Node | undefined {
  if (!node) return undefined
  if (!isAlias(node)) return node
  return node.resolve(doc) ?? node
}

function childNode(doc: Document, node: Node | undefined, segment: string | number): Node | undefined {
  const target = resolveAlias(doc, node)
  if (!target) return undefined

  if (typeof segment === 'number') {
    if (!isSeq(target)) return undefined
    return target.items[segment] as Node | undefined
  }

  if (!isMap(target)) return undefined
  return target.get(segment, true) as Node | undefined
}

/** 找到 path 对应的节点，以及它的父容器与 key/index */
function locate(doc: Document, path: ConfigPath): LocatedNode {
  let node: Node | undefined = doc.contents as Node | undefined
  let parent: Node | null = null
  let key: string | number | null = null

  for (const segment of path) {
    parent = resolveAlias(doc, node) ?? null
    key = segment
    node = childNode(doc, node, segment)
    if (!node) return { parent, key, node: undefined }
  }

  return { parent, key, node }
}

/** 收集子树内所有带锚点的节点 */
function anchoredNodes(subtree: Node): Node[] {
  const found: Node[] = []
  if (subtree.anchor) found.push(subtree)
  visit(subtree, {
    Node(_key, node) {
      if (node.anchor) found.push(node)
    },
  })
  return found
}

/**
 * 把指向 targets 的别名展开成实际内容。
 * 删除 / 拆掉锚点节点前必须调用，否则 `*anchor` 会变成无法解析的引用。
 */
function materializeAliases(doc: Document, targets: Node[]): number {
  if (!targets.length) return 0
  const matched = new Set<Node>(targets)
  let count = 0

  visit(doc, {
    Alias(_key, alias) {
      const source = alias.resolve(doc)
      if (!source || !matched.has(source)) return undefined
      count += 1
      return cloneNode(doc, source)
    },
  })

  return count
}

/** 深拷贝一个节点（保留 flow / 引号风格，不保留注释） */
function cloneNode(doc: Document, node: Node): Node {
  if (isAlias(node)) {
    const source = node.resolve(doc)
    return source ? cloneNode(doc, source) : node
  }

  if (isScalar(node)) {
    const copy = doc.createNode(node.value) as Node
    if (isScalar(copy) && node.type) copy.type = node.type
    return copy
  }

  if (isSeq(node)) {
    const seq = new YAML.YAMLSeq(doc.schema)
    seq.flow = node.flow
    seq.items = node.items.map(item => cloneNode(doc, item as Node))
    return seq
  }

  if (isMap(node)) {
    const map = new YAML.YAMLMap(doc.schema)
    map.flow = node.flow
    map.items = node.items.map(pair => {
      const p = pair as Pair
      return new YAML.Pair(cloneNode(doc, p.key as Node), cloneNode(doc, p.value as Node))
    })
    return map
  }

  return node
}

function createOrderedNode(doc: Document, value: unknown, path: ConfigPath = []): Node {
  return doc.createNode(orderConfigValue(value, path.map(String))) as unknown as Node
}

/** 写入 map 的键：已有则替换 value（保留 pair 位置与注释），没有则追加到末尾 */
function setMapEntry(doc: Document, map: YAMLMap, key: string, value: Node): void {
  const pair = map.items.find(item => keyOfMapEntry(item as Pair) === key) as Pair | undefined
  if (pair) {
    pair.value = value
    return
  }
  map.items.push(new YAML.Pair(doc.createNode(key) as Node, value) as Pair)
}

interface CommentedNode {
  commentBefore?: string | null
  comment?: string | null
  commentAfter?: string | null
}

/** 旧节点是 flow 风格（[a, b]）时，替换后的新节点也保持 flow */
function inheritFlowStyle(previous: Node | undefined, next: Node): Node {
  if (!previous) return next
  if ((isSeq(previous) && isSeq(next)) || (isMap(previous) && isMap(next))) {
    if (previous.flow) next.flow = true
  }
  return next
}

/** 把注释从旧节点搬到新节点，避免替换时丢掉上下文说明 */
function transferComments(from: Node | undefined, to: Node | undefined): void {
  if (!from || !to) return
  const source = from as Node & CommentedNode
  const target = to as Node & CommentedNode
  if (source.commentBefore != null) target.commentBefore = source.commentBefore
  if (source.comment != null) target.comment = source.comment
  if (source.commentAfter != null) target.commentAfter = source.commentAfter
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
}

/** 递归地把 js 值写入已有节点（保持节点身份 → 锚点与别名继续有效） */
function writeInto(doc: Document, node: Node, value: unknown, path: ConfigPath): Node {
  if (isMap(node) && isPlainObject(value)) {
    assignMap(doc, node, value, path)
    return node
  }

  if (isSeq(node) && Array.isArray(value)) {
    assignSeq(doc, node, value, path)
    return node
  }

  if (isScalar(node) && !isPlainObject(value) && !Array.isArray(value)) {
    node.value = value
    return node
  }

  return createOrderedNode(doc, value, path)
}

/** 按 key 合并更新一个 YAMLMap：保留同名 key 的位置与注释，删除多余 key，追加缺失 key */
function assignMap(doc: Document, map: YAMLMap, value: Record<string, unknown>, path: ConfigPath): void {
  const ordered = orderConfigValue(value, path.map(String)) as Record<string, unknown>
  const wanted = new Set(Object.keys(ordered))

  for (const pair of [...map.items]) {
    const p = pair as Pair
    const key = isScalar(p.key) ? String(p.key.value) : String(p.key)
    if (!wanted.has(key)) {
      materializeAliases(doc, anchoredNodes(p.value as Node))
      map.items.splice(map.items.indexOf(pair), 1)
      continue
    }

    const nextValue = ordered[key]
    const current = p.value as Node | undefined
    const childPath = [...path, key]
    if (!current) {
      p.value = createOrderedNode(doc, nextValue, childPath)
      continue
    }
    if (isMap(current) && isPlainObject(nextValue)) {
      assignMap(doc, current, nextValue, childPath)
    } else if (isSeq(current) && Array.isArray(nextValue)) {
      assignSeq(doc, current, nextValue, childPath)
    } else if (isScalar(current) && !isPlainObject(nextValue) && !Array.isArray(nextValue)) {
      current.value = nextValue
    } else {
      const replacement = inheritFlowStyle(current, createOrderedNode(doc, nextValue, childPath))
      transferComments(current, replacement)
      materializeAliases(doc, anchoredNodes(current))
      p.value = replacement
    }
  }

  for (const key of Object.keys(ordered)) {
    if (map.has(key)) continue
    setMapEntry(doc, map, key, createOrderedNode(doc, ordered[key]))
  }
}

function keyOfMapEntry(pair: Pair): string {
  const key = pair.key
  return isScalar(key) ? String(key.value) : String(key)
}

/** 序列同步：按 key 复用旧节点（保留注释），其余新建；多余节点移除 */
function assignSeq(doc: Document, seq: YAMLSeq, values: unknown[], path: ConfigPath, keyOf?: (value: unknown) => string): void {
  const keyOfValue = keyOf ?? ((value: unknown) => JSON.stringify(value))

  const buckets = new Map<string, Node[]>()
  for (const item of seq.items) {
    const node = item as Node
    const key = keyOfValue(node.toJS(doc))
    const bucket = buckets.get(key)
    if (bucket) bucket.push(node)
    else buckets.set(key, [node])
  }

  const reused = new Set<Node>()
  const nextItems = values.map((value, index) => {
    const key = keyOfValue(value)
    const node = buckets.get(key)?.shift()
    if (!node) return createOrderedNode(doc, value, [...path, index])
    reused.add(node)
    return node
  })

  const dropped = seq.items
    .map(item => item as Node)
    .filter(item => !reused.has(item))
  if (dropped.length) materializeAliases(doc, dropped.flatMap(item => anchoredNodes(item)))

  seq.items = nextItems
}

interface LineHunk {
  start: number
  end: number
  lines: string[]
}

/** LCS 行级 diff 的规模上限（超出后退化为前后缀裁剪，避免 Worker 内存/CPU 抖动） */
const MAX_DIFF_CELLS = 1_000_000

function diffLineHunks(base: string[], next: string[]): LineHunk[] | null {
  const n = base.length
  const m = next.length
  if (n * m > MAX_DIFF_CELLS) return null

  const width = m + 1
  const dp = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] = base[i] === next[j]
        ? dp[(i + 1) * width + j + 1] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1])
    }
  }

  const hunks: LineHunk[] = []
  let i = 0
  let j = 0
  let current: LineHunk | null = null

  while (i < n || j < m) {
    if (i < n && j < m && base[i] === next[j]) {
      if (current) {
        hunks.push(current)
        current = null
      }
      i += 1
      j += 1
      continue
    }

    if (!current) current = { start: i, end: i, lines: [] }
    const stayBase = i < n ? dp[(i + 1) * width + j] : -1
    const takeNext = j < m ? dp[i * width + j + 1] : -1

    if (j < m && (i >= n || takeNext >= stayBase)) {
      current.lines.push(next[j])
      j += 1
    } else {
      i += 1
      current.end = i
    }
  }

  if (current) hunks.push(current)
  return hunks
}

/**
 * 把 base→next 的行改动贴回 original：
 * 只替换真正变化的那几行，其余行（包括行尾注释的对齐空格）保持字节级不变。
 */
function applyMinimalPatch(original: string, base: string, next: string): string | null {
  const originalLines = original.split('\n')
  const baseLines = base.split('\n')
  const nextLines = next.split('\n')
  // 规范化不会改变行数，行号才能一一对应
  if (originalLines.length !== baseLines.length) return null

  const hunks = diffLineHunks(baseLines, nextLines)
  if (!hunks) {
    let prefix = 0
    while (prefix < baseLines.length && prefix < nextLines.length && baseLines[prefix] === nextLines[prefix]) prefix += 1
    let suffix = 0
    while (
      suffix < baseLines.length - prefix
      && suffix < nextLines.length - prefix
      && baseLines[baseLines.length - 1 - suffix] === nextLines[nextLines.length - 1 - suffix]
    ) suffix += 1

    return [
      ...originalLines.slice(0, prefix),
      ...nextLines.slice(prefix, nextLines.length - suffix),
      ...originalLines.slice(baseLines.length - suffix),
    ].join('\n')
  }

  const merged: string[] = []
  let position = 0
  for (const hunk of hunks) {
    merged.push(...originalLines.slice(position, hunk.start), ...hunk.lines)
    position = hunk.end
  }
  merged.push(...originalLines.slice(position))
  return merged.join('\n')
}

/**
 * 直接编辑 YAML 文档「原地」完成配置修改。
 *
 * 与 `parse → toJS → stringify` 的区别：
 * - 注释（行首 #、行尾 #）全部保留，包括用户手写的分区说明；
 * - 锚点（&name）与别名（*name、<<: *name）保留，被别名引用的节点会原地更新，
 *   这样「改一处、全局生效」的手写语义不会在后台保存时被展平；
 * - 未改动的部分不重新排序、不重新格式化；
 * - 只有新建/替换的节点会套用 `orderConfigValue` 的规范字段顺序。
 */
export class ConfigDocument {
  static parse(text: string): ConfigDocument {
    const doc: Document = YAML.parseDocument(text, { merge: true })
    const fatal = doc.errors.filter(error => error.name !== 'YAMLWarning')
    if (fatal.length) throw new Error(fatal[0].message)
    return new ConfigDocument(doc, text)
  }

  static fromText(text: string | null | undefined): ConfigDocument {
    if (!text || !text.trim()) return new ConfigDocument(YAML.parseDocument('', { merge: true }), '')
    return ConfigDocument.parse(text)
  }

  private dirty = false
  private readonly indent: number

  private constructor(readonly doc: Document, private readonly source: string) {
    this.indent = detectIndent(source)
  }

  /**
   * 把本次改动以「最小行差」套回原始文本：
   * 只替换真正变化的那几行，其余行（包括行尾注释的对齐空格）保持字节级不变。
   * 任何异常或语义校验不通过时退回整篇规范化输出。
   */
  serialize(): string {
    const next = this.toString()
    if (!this.source) return next
    if (!this.dirty) return this.source

    try {
      const base = ConfigDocument.parse(this.source).toString()
      if (base === next) return this.source
      const merged = applyMinimalPatch(this.source, base, next)
      if (merged === null) return next
      // 合并结果必须与原文档语义一致（merge 键同样展开后比较），否则回退到规范化输出
      const reparsed = YAML.parse(merged, { merge: true }) as ClashConfig | null
      return JSON.stringify(reparsed) === JSON.stringify(this.doc.toJS()) ? merged : next
    } catch {
      return next
    }
  }

  /** 解析后的 JS 对象视图（只读用途，别名会展开成同一份内容） */
  get value(): ClashConfig {
    return (this.doc.toJS() ?? {}) as ClashConfig
  }

  getIn<T = unknown>(path: ConfigPath): T | undefined {
    const node = locate(this.doc, path).node
    return node ? (node.toJS(this.doc) as T) : undefined
  }

  /** 整体替换某个位置的值；被别名引用的节点会原地更新以保住锚点 */
  setIn(path: ConfigPath, value: unknown): void {
    this.dirty = true
    if (!path.length) {
      this.doc.contents = createOrderedNode(this.doc, value) as unknown as typeof this.doc.contents
      return
    }

    const { parent, key, node } = locate(this.doc, path)
    if (!parent || key === null) return

    // 被别名引用的锚点节点必须原地更新，否则别名会失去指向
    if (node && !isAlias(node) && node.anchor && hasAliases(this.doc, node)) {
      writeInto(this.doc, node, value, path)
      return
    }

    const replacement = inheritFlowStyle(resolveAlias(this.doc, node), createOrderedNode(this.doc, value, path))
    transferComments(node && !isAlias(node) ? node : undefined, replacement)
    if (node) materializeAliases(this.doc, anchoredNodes(node))

    if (isSeq(parent)) parent.items[key as number] = replacement
    else if (isMap(parent)) setMapEntry(this.doc, parent, String(key), replacement)
  }

  /** 合并更新一个 map（provider / proxy-group 表单提交） */
  updateMap(path: ConfigPath, value: Record<string, unknown>): void {
    this.dirty = true
    const target = this.ensureNode(path, 'map')
    if (!isMap(target)) {
      this.setIn(path, value)
      return
    }
    assignMap(this.doc, target, value, path)
  }

  /** 在序列的指定位置插入一项 */
  insertAt(path: ConfigPath, index: number, value: unknown): void {
    this.dirty = true
    const target = this.ensureNode(path, 'seq')
    if (!isSeq(target)) {
      this.setIn(path, [value])
      return
    }
    const clamped = Math.max(0, Math.min(index, target.items.length))
    target.items.splice(clamped, 0, createOrderedNode(this.doc, value, [...path, clamped]))
  }

  /** 按 key 同步整个序列（规则排序 / 认证用户等） */
  syncSeq(path: ConfigPath, values: unknown[], keyOf?: (value: unknown) => string): void {
    this.dirty = true
    const target = this.ensureNode(path, 'seq')
    if (!isSeq(target)) {
      this.setIn(path, values)
      return
    }
    assignSeq(this.doc, target, values, path, keyOf)
  }

  /** 删除某个 key / 索引；若它带着被引用的锚点，会先展开别名 */
  deleteIn(path: ConfigPath): void {
    this.dirty = true
    if (!path.length) {
      this.doc.contents = null
      return
    }

    const { parent, key, node } = locate(this.doc, path)
    if (!parent || key === null || !node) return

    materializeAliases(this.doc, anchoredNodes(node))

    if (isSeq(parent)) {
      parent.items.splice(key as number, 1)
      return
    }

    if (isMap(parent)) {
      const index = parent.items.findIndex(pair => keyOfMapEntry(pair as Pair) === String(key))
      if (index !== -1) parent.items.splice(index, 1)
    }
  }

  toString(): string {
    return this.doc.toString(stringifyOptions(this.indent))
  }

  /** 校验当前文档是否可安全序列化（未解析的别名会在这里抛错） */
  validate(): void {
    this.doc.toJS()
  }

  private ensureNode(path: ConfigPath, kind: 'map' | 'seq'): Node | undefined {
    if (!path.length) return this.doc.contents as Node | undefined

    // 容器类型由「下一段路径」决定：数字 → 序列，字符串 → 映射，末尾 → 调用方指定
    const makeContainer = (index: number): Node => {
      if (index >= path.length) {
        return kind === 'map' ? new YAML.YAMLMap(this.doc.schema) : new YAML.YAMLSeq(this.doc.schema)
      }
      return typeof path[index] === 'number'
        ? new YAML.YAMLSeq(this.doc.schema)
        : new YAML.YAMLMap(this.doc.schema)
    }

    if (!this.doc.contents) this.doc.contents = makeContainer(0) as unknown as typeof this.doc.contents
    let node: Node = this.doc.contents as Node

    path.forEach((segment, index) => {
      node = resolveAlias(this.doc, node) ?? node

      if (typeof segment === 'number') {
        if (!isSeq(node)) throw new TypeError(`Expected a sequence at ${path.slice(0, index).join('.')}`)
        let child = node.items[segment] as Node | undefined
        if (!child) {
          child = makeContainer(index + 1)
          node.items[segment] = child
        }
        node = child
        return
      }

      if (!isMap(node)) throw new TypeError(`Expected a mapping at ${path.slice(0, index).join('.')}`)
      let child = node.get(segment, true) as Node | undefined
      if (!child) {
        child = makeContainer(index + 1)
        setMapEntry(this.doc, node, segment, child)
      }
      node = child
    })

    return node
  }
}

function hasAliases(doc: Document, target: Node): boolean {
  let found = false
  visit(doc, {
    Alias(_key, alias) {
      if (alias.resolve(doc) === target) {
        found = true
        return visit.BREAK
      }
      return undefined
    },
  })
  return found
}

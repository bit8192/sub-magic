import { DurableObject } from 'cloudflare:workers'
import { parseConfig, serializeConfig, type ClashConfig } from '../yaml'

const DEFAULT_CONFIG_KEY = 'main'

export interface ConfigVersion {
  id: string
  timestamp: number
  label: string
}

type SqlRow = Record<string, SqlStorageValue>

interface ConfigRow extends SqlRow {
  value: string
}

interface VersionRow extends SqlRow {
  id: string
  timestamp: number
  label: string
  config: string
}

/**
 * ConfigSync Durable Object
 *
 * 职责：
 * 1. 作为配置主存储（SQLite-backed，强一致性）
 * 2. 内存缓存，避免重复解析 YAML
 * 3. WebSocket Hibernation 实时推送配置变更
 * 4. 版本管理（替代 KV 中的版本索引）
 *
 * 设计为单租户全局实例：一个 Worker 部署对应一个 ConfigSync DO。
 * 未来如需多租户，可按 userId 分片（getByName(userId)）。
 */
export class ConfigSync extends DurableObject<Env> {
  private cachedConfig: string | null = null
  private cachedParsed: ClashConfig | null = null
  private etag: string | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)

    ctx.blockConcurrencyWhile(async () => {
      this.initSchema()
      // 预热缓存
      const config = this.loadConfigFromDb()
      this.cachedConfig = config
    })
  }

  /* ─── Schema ─── */

  private initSchema() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `)

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS versions (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        config TEXT NOT NULL,
        timestamp INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `)

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `)

    // 索引加速
    this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS idx_versions_ts ON versions(timestamp DESC)`)
  }

  /* ─── Helpers ─── */

  private loadConfigFromDb(): string | null {
    const rows = this.ctx.storage.sql.exec<ConfigRow>(
      'SELECT value FROM config WHERE key = ?',
      DEFAULT_CONFIG_KEY
    ).toArray()
    return rows[0]?.value ?? null
  }

  private invalidateCache() {
    this.cachedConfig = null
    this.cachedParsed = null
    this.etag = null
  }

  private computeEtag(text: string): string {
    let hash = 0
    for (let i = 0; i < text.length; i++) {
      const chr = text.charCodeAt(i)
      hash = ((hash << 5) - hash) + chr
      hash |= 0
    }
    return `"${Math.abs(hash).toString(36)}"`
  }

  private broadcast(message: unknown) {
    const payload = JSON.stringify(message)
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload)
      } catch {
        // ignore closed sockets
      }
    }
  }

  /* ─── RPC: Config CRUD ─── */

  async getConfig(): Promise<string | null> {
    if (this.cachedConfig !== null) {
      return this.cachedConfig
    }
    const config = this.loadConfigFromDb()
    this.cachedConfig = config
    return config
  }

  async setConfig(yaml: string): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, unixepoch())`,
      DEFAULT_CONFIG_KEY,
      yaml
    )
    this.invalidateCache()
    this.cachedConfig = yaml

    this.broadcast({ type: 'config:updated', timestamp: Date.now() })
  }

  async getParsedConfig(): Promise<ClashConfig> {
    if (this.cachedParsed !== null) {
      return this.cachedParsed
    }
    const raw = await this.getConfig()
    const parsed = raw ? parseConfig(raw) : {}
    this.cachedParsed = parsed
    return parsed
  }

  async getEtag(): Promise<string | null> {
    if (this.etag !== null) {
      return this.etag
    }
    const raw = await this.getConfig()
    if (!raw) return null
    const etag = this.computeEtag(raw)
    this.etag = etag
    return etag
  }

  /* ─── RPC: Versions ─── */

  async getVersions(): Promise<ConfigVersion[]> {
    const rows = this.ctx.storage.sql.exec<VersionRow>(
      'SELECT id, timestamp, label FROM versions ORDER BY timestamp DESC'
    ).toArray()
    return rows.map(r => ({ id: r.id, timestamp: r.timestamp, label: r.label }))
  }

  async saveVersion(label?: string): Promise<ConfigVersion> {
    const config = await this.getConfig()
    if (!config) throw new Error('No config to save')

    const id = Date.now().toString(36) + '-' + crypto.randomUUID().slice(0, 8)
    const version: ConfigVersion = {
      id,
      timestamp: Math.floor(Date.now() / 1000),
      label: label || `v${id.slice(0, 8)}`,
    }

    this.ctx.storage.sql.exec(
      'INSERT INTO versions (id, label, config, timestamp) VALUES (?, ?, ?, ?)',
      version.id,
      version.label,
      config,
      version.timestamp
    )

    return version
  }

  async getVersion(id: string): Promise<string | null> {
    const rows = this.ctx.storage.sql.exec<Pick<VersionRow, 'config'>>(
      'SELECT config FROM versions WHERE id = ?',
      id
    ).toArray()
    return rows[0]?.config ?? null
  }

  async restoreVersion(id: string): Promise<boolean> {
    const config = await this.getVersion(id)
    if (!config) return false
    await this.setConfig(config)
    return true
  }

  async deleteVersion(id: string): Promise<boolean> {
    this.ctx.storage.sql.exec('DELETE FROM versions WHERE id = ?', id)
    return true
  }

  /* ─── RPC: Metadata (for keys that rarely change) ─── */

  async getMetadata(key: string): Promise<string | null> {
    const rows = this.ctx.storage.sql.exec<{ value: string }>(
      'SELECT value FROM metadata WHERE key = ?',
      key
    ).toArray()
    return rows[0]?.value ?? null
  }

  async setMetadata(key: string, value: string): Promise<void> {
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)',
      key,
      value
    )
  }

  /* ─── HTTP / WebSocket ─── */

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // WebSocket upgrade for real-time sync
    if ((url.pathname === '/sync' || url.pathname === '/api/sync') && request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair()
      const client = pair[0]
      const server = pair[1]
      this.ctx.acceptWebSocket(server)

      // 立即推送当前配置
      const config = await this.getConfig()
      server.send(JSON.stringify({ type: 'config:sync', config, timestamp: Date.now() }))

      return new Response(null, { status: 101, webSocket: client })
    }

    // Internal HTTP API (optional fallback if RPC not desired)
    if (url.pathname === '/config' && request.method === 'GET') {
      const config = await this.getConfig()
      return Response.json({ config })
    }

    if (url.pathname === '/config' && request.method === 'PUT') {
      const body = (await request.json()) as { config?: string }
      const yaml = String(body.config || '')
      await this.setConfig(yaml)
      return Response.json({ ok: true })
    }

    if (url.pathname === '/versions' && request.method === 'GET') {
      const versions = await this.getVersions()
      return Response.json(versions)
    }

    return new Response('Not found', { status: 404 })
  }

  /* ─── WebSocket Hibernation callbacks ─── */

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    // 客户端可向 DO 发送消息，例如请求重新同步
    if (typeof message === 'string') {
      try {
        const data = JSON.parse(message) as { type?: string }
        if (data.type === 'sync') {
          this.getConfig().then(config => {
            ws.send(JSON.stringify({ type: 'config:sync', config, timestamp: Date.now() }))
          })
        }
      } catch {
        // ignore invalid JSON
      }
    }
  }

  webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    // hibernation 模式下不需要手动清理；DO 会自动管理
  }
}

/* ─── Worker-side helper: get stub ─── */

const DO_NAME = 'sub-magic-config'

export function getConfigSyncDO(env: Env): DurableObjectStub<ConfigSync> {
  return env.CONFIG_SYNC.getByName(DO_NAME)
}

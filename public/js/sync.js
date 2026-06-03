/**
 * ConfigSync WebSocket Client
 *
 * 通过 WebSocket 与 ConfigSync Durable Object 保持长连接，
 * 实时接收配置变更推送，并自动重连。
 */

const WS_URL = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/sync`
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30000

let ws = null
let reconnectTimer = null
let reconnectAttempts = 0
let intentionalClose = false

const listeners = new Set()

export function onConfigUpdated(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function notify(data) {
  for (const fn of listeners) {
    try {
      fn(data)
    } catch (e) {
      console.error('[Sync] listener error:', e)
    }
  }
}

function connect() {
  if (ws || intentionalClose) return

  try {
    ws = new WebSocket(WS_URL)
  } catch (e) {
    console.error('[Sync] failed to create WebSocket:', e)
    scheduleReconnect()
    return
  }

  ws.onopen = () => {
    console.log('[Sync] connected')
    reconnectAttempts = 0
  }

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data)
      if (msg.type === 'config:updated') {
        console.log('[Sync] config updated, notifying listeners')
        notify({ type: 'updated', timestamp: msg.timestamp })
      } else if (msg.type === 'config:sync') {
        console.log('[Sync] initial sync received')
        notify({ type: 'sync', config: msg.config, timestamp: msg.timestamp })
      }
    } catch (e) {
      console.error('[Sync] invalid message:', event.data, e)
    }
  }

  ws.onerror = (e) => {
    console.error('[Sync] error:', e)
  }

  ws.onclose = () => {
    ws = null
    if (!intentionalClose) {
      scheduleReconnect()
    }
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return
  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts), RECONNECT_MAX_MS)
  reconnectAttempts++
  console.log(`[Sync] reconnecting in ${delay}ms (attempt ${reconnectAttempts})`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, delay)
}

export function initSync() {
  intentionalClose = false
  connect()
}

export function closeSync() {
  intentionalClose = true
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (ws) {
    ws.close()
    ws = null
  }
}

export function requestSync() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'sync' }))
  }
}

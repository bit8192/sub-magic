let ws = null
let config = { url: '', secret: '' }
let reconnectDelay = 2000
let reconnectTimer = null
let polling = false
let pollTimer = null

let cachedSnapshots = []
const SNAPSHOT_TTL = 30000

let proxyGroups = []

const tabRequests = new Map()
const REQUEST_TTL = 30000
const CORRELATION_WINDOW = 2000

const debuggerAttached = new Set()
const debuggerAvailable = typeof chrome !== 'undefined' && !!chrome.debugger
const tabLastPoll = new Map()
const CLEANUP_INTERVAL = 5000
let cleanupTimer = null
let debuggerFailedForTab = new Set()

function extractHost(url) {
	try { return new URL(url).hostname } catch { return '' }
}

function httpToWs(url) {
	let base = url.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')
	return `ws://${base}`
}

function recordRequest(tabId, url) {
	if (!tabId || tabId < 0) return
	const host = extractHost(url)
	if (!host) return
	let domainMap = tabRequests.get(tabId)
	if (!domainMap) {
		domainMap = new Map()
		tabRequests.set(tabId, domainMap)
	}
	const entry = domainMap.get(host) || { lastSeen: 0, count: 0 }
	entry.lastSeen = Date.now()
	entry.count++
	domainMap.set(host, entry)
}

chrome.webRequest.onBeforeRequest.addListener(
	(details) => {
		if (details.tabId < 0) return
		recordRequest(details.tabId, details.url)
	},
	{ urls: ['<all_urls>'] }
)

chrome.tabs.onRemoved.addListener((tabId) => {
	tabRequests.delete(tabId)
	tabLastPoll.delete(tabId)
	debuggerFailedForTab.delete(tabId)
	if (debuggerAttached.has(tabId)) {
		detachDebugger(tabId)
	}
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
	if (changeInfo.url) {
		tabRequests.delete(tabId)
		debuggerFailedForTab.delete(tabId)
	}
})

function getDebuggerStatus(tabId) {
	if (!debuggerAvailable) return 'unavailable'
	if (debuggerFailedForTab.has(tabId)) return 'failed'
	if (debuggerAttached.has(tabId)) return 'attached'
	return 'available'
}

function detachDebugger(tabId) {
	if (!debuggerAvailable || !debuggerAttached.has(tabId)) return
	try {
		chrome.debugger.detach({ tabId })
	} catch (e) {}
	debuggerAttached.delete(tabId)
}

async function attachDebugger(tabId) {
	if (!debuggerAvailable) return 'unavailable'
	if (debuggerAttached.has(tabId)) return 'attached'
	if (debuggerFailedForTab.has(tabId)) return 'failed'

	try {
		await new Promise((resolve, reject) => {
			chrome.debugger.attach({ tabId }, '1.3', () => {
				if (chrome.runtime.lastError) {
					reject(new Error(chrome.runtime.lastError.message))
				} else {
					resolve()
				}
			})
		})

		try {
			await new Promise((resolve, reject) => {
				chrome.debugger.sendCommand({ tabId }, 'Network.enable', {
					maxTotalBufferSize: 10000000,
					maxResourceBufferSize: 5000000,
				}, () => {
					if (chrome.runtime.lastError) {
						reject(new Error(chrome.runtime.lastError.message))
					} else {
						resolve()
					}
				})
			})
		} catch (networkErr) {
			try {
				chrome.debugger.detach({ tabId })
			} catch (detachErr) {}
			debuggerFailedForTab.add(tabId)
			return 'failed'
		}

		debuggerAttached.add(tabId)
		return 'attached'
	} catch (e) {
		debuggerFailedForTab.add(tabId)
		return 'failed'
	}
}

if (debuggerAvailable) {
	chrome.debugger.onEvent.addListener((source, method, params) => {
		if (method === 'Network.requestWillBeSent') {
			const tabId = source.tabId
			if (!tabId || !params.request?.url) return
			recordRequest(tabId, params.request.url)
		}
	})

	chrome.debugger.onDetach.addListener((source, reason) => {
		const tabId = source.tabId
		if (tabId) {
			debuggerAttached.delete(tabId)
		}
	})

	cleanupTimer = setInterval(() => {
		const now = Date.now()
		for (const [tabId, lastPoll] of tabLastPoll) {
			if (now - lastPoll > CLEANUP_INTERVAL && debuggerAttached.has(tabId)) {
				detachDebugger(tabId)
			}
		}
	}, CLEANUP_INTERVAL)
}

async function mihomoFetch(url, secret, path, options = {}) {
	let baseUrl = url.trim()
	if (!/^https?:\/\//i.test(baseUrl)) baseUrl = 'http://' + baseUrl
	baseUrl = baseUrl.replace(/\/+$/, '')
	const headers = { ...options.headers }
	if (secret) headers.Authorization = `Bearer ${secret}`
	const res = await fetch(`${baseUrl}${path}`, { ...options, headers })
	if (!res.ok) {
		const text = await res.text()
		throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
	}
	return res.json()
}

function addSnapshot(data) {
	const now = Date.now()
	cachedSnapshots.push({ data, ts: now })
	cachedSnapshots = cachedSnapshots.filter(s => now - s.ts < SNAPSHOT_TTL)
}

function getMergedGroups(tabId) {
	const now = Date.now()

	const currentTabDomains = new Map()
	const domainMap = tabRequests.get(tabId)
	if (domainMap) {
		for (const [host, entry] of domainMap) {
			if (now - entry.lastSeen < REQUEST_TTL) {
				currentTabDomains.set(host, entry)
			}
		}
	}

	for (const [tid, dm] of tabRequests) {
		for (const [host, entry] of dm) {
			if (now - entry.lastSeen >= REQUEST_TTL) {
				dm.delete(host)
			}
		}
	}

	if (currentTabDomains.size === 0) return { total: 0, groups: [], status: 'no_domain', debuggerStatus: getDebuggerStatus(tabId) }
	if (cachedSnapshots.length === 0) return { total: 0, groups: [], status: 'fetching', debuggerStatus: getDebuggerStatus(tabId) }

	const allConns = new Map()

	for (const snap of cachedSnapshots) {
		const conns = snap.data.connections || []
		for (const c of conns) {
			const host = c.metadata?.host || c.metadata?.sniffHost || ''
			if (!host) continue

			let matchedDomain = ''
			for (const d of currentTabDomains.keys()) {
				if (host === d || host.endsWith('.' + d) || host === d.replace(/^www\./, '')) {
					matchedDomain = d
					break
				}
			}
			if (!matchedDomain) continue

			const selfEntry = currentTabDomains.get(matchedDomain)
			const selfTime = selfEntry ? selfEntry.lastSeen : 0

			let bestOtherTime = 0
			let bestOtherTabId = 0
			for (const [tid, dm] of tabRequests) {
				if (tid === tabId) continue
				const entry = dm.get(matchedDomain)
				if (entry && entry.lastSeen > bestOtherTime) {
					bestOtherTime = entry.lastSeen
					bestOtherTabId = tid
				}
			}

			const owned = selfTime >= bestOtherTime
			const shared = selfTime > 0 && bestOtherTime > 0 && Math.abs(selfTime - bestOtherTime) < CORRELATION_WINDOW

			if (!owned && !shared) continue

			const rule = c.rule || ''
			const key = `${host}\0${rule}`
			if (!allConns.has(key)) {
				const chain = c.chains || c.chain || []
				allConns.set(key, {
					host,
					rule,
					count: 0,
					chain: Array.isArray(chain) ? chain : [],
					rulePayload: c.rulePayload || '',
					owned,
					shared,
					otherTabId: bestOtherTabId,
				})
			}
			allConns.get(key).count++
		}
	}

	const groups = Array.from(allConns.values()).sort((a, b) => b.count - a.count)

	return {
		total: groups.reduce((s, g) => s + g.count, 0),
		groups,
		status: 'connected',
		debuggerStatus: getDebuggerStatus(tabId),
	}
}

async function getProxyGroups() {
	const data = await mihomoFetch(config.url, config.secret, '/proxies')
	const proxies = data.proxies || {}
	return Object.values(proxies)
		.filter(p => p?.name && p.type && p.type !== 'Direct' && p.type !== 'Reject')
		.map(p => ({ name: p.name, type: p.type, now: p.now || '' }))
}

function connectWs() {
	if (!config.url) return
	if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return

	const token = config.secret ? `?token=${encodeURIComponent(config.secret)}` : ''
	let wsUrl = `${httpToWs(config.url)}/connections?interval=2000${config.secret ? token.replace('?', '&') : ''}`

	try {
		ws = new WebSocket(wsUrl)

		ws.onopen = () => {
			reconnectDelay = 2000
		}

		ws.onmessage = (event) => {
			try {
				const data = JSON.parse(event.data)
				addSnapshot(data)
			} catch (e) {}
		}

		ws.onclose = () => {
			ws = null
			if (!polling) { polling = true; startPolling() }
		}

		ws.onerror = () => {
			if (ws) { ws.onclose = null; ws.close(); ws = null }
			if (!polling) { polling = true; startPolling() }
		}
	} catch (e) {
		if (!polling) { polling = true; startPolling() }
	}
}

async function pollHttp() {
	if (!config.url) return
	try {
		const data = await mihomoFetch(config.url, config.secret, '/connections')
		addSnapshot(data)
	} catch (e) {}
}

function startPolling() {
	pollHttp()
	pollTimer = setInterval(pollHttp, 2000)
}

function stopPolling() {
	if (pollTimer) clearInterval(pollTimer)
	pollTimer = null
	polling = false
}

function initMonitor() {
	polling = false

	if (ws) {
		try { ws.onclose = null; ws.close() } catch (e) {}
		ws = null
	}
	if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
	stopPolling()

	connectWs()
}

async function loadConfig() {
	const data = await chrome.storage.sync.get(['mihomoUrl', 'mihomoSecret'])
	config.url = data.mihomoUrl || ''
	config.secret = data.mihomoSecret || ''
}

async function ensureProxyGroups() {
	if (proxyGroups.length > 0 || !config.url) return
	try {
		const groups = await getProxyGroups()
		proxyGroups = groups
	} catch (e) {
		proxyGroups = []
	}
}

chrome.runtime.onInstalled.addListener(() => {
	chrome.storage.sync.get(['mihomoUrl', 'mihomoSecret', 'subMagicUrl', 'subMagicKey'], data => {
		if (!data.mihomoUrl) chrome.storage.sync.set({ mihomoUrl: '' })
		if (!data.mihomoSecret) chrome.storage.sync.set({ mihomoSecret: '' })
		if (!data.subMagicUrl) chrome.storage.sync.set({ subMagicUrl: '' })
		if (!data.subMagicKey) chrome.storage.sync.set({ subMagicKey: '' })
	})
})

;(async () => {
	await loadConfig()
	if (config.url) {
		initMonitor()
		ensureProxyGroups()
	}
})()

chrome.storage.onChanged.addListener((changes, area) => {
	if (area !== 'sync') return
	if (changes.mihomoUrl || changes.mihomoSecret) {
		loadConfig().then(() => {
			if (config.url) initMonitor()
		})
	}
})

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	if (msg.type === 'POLL') {
		;(async () => {
			const tabId = msg.tabId || 0
			tabLastPoll.set(tabId, Date.now())

			if (tabId > 0 && !tabRequests.has(tabId)) {
				try {
					const tab = await chrome.tabs.get(tabId)
					const host = extractHost(tab.url || '')
					if (host) {
						recordRequest(tabId, tab.url)
					}
				} catch {}
			}

			if (tabId > 0 && config.url) {
				attachDebugger(tabId).catch(() => {})
			}

			const data = getMergedGroups(tabId)
			await ensureProxyGroups()
			sendResponse({ data, proxyGroups })
		})()
		return true
	} else if (msg.type === 'POLL_STOP') {
		const tabId = msg.tabId || 0
		tabLastPoll.delete(tabId)
		if (debuggerAttached.has(tabId)) {
			detachDebugger(tabId)
		}
		sendResponse({ ok: true })
		return false
	} else if (msg.type === 'REFRESH_PROXY') {
		;(async () => {
			await loadConfig()
			proxyGroups = []
			await ensureProxyGroups()
			sendResponse({ proxyGroups })
		})()
		return true
	}
})

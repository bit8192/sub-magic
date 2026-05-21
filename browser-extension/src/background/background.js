let ws = null
let config = { url: '', secret: '' }
let reconnectDelay = 2000
let reconnectTimer = null
let polling = false
let pollTimer = null

let cachedSnapshots = []
const SNAPSHOT_TTL = 30000

let proxyGroups = []

const tabDomains = new Map()
const MAX_DOMAINS_PER_TAB = 200

function extractHost(url) {
	try { return new URL(url).hostname } catch { return '' }
}

function httpToWs(url) {
	let base = url.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')
	return `ws://${base}`
}

chrome.webRequest.onBeforeRequest.addListener(
	(details) => {
		if (details.tabId < 0) return
		const host = extractHost(details.url)
		if (!host) return
		let set = tabDomains.get(details.tabId)
		if (!set) {
			set = new Set()
			tabDomains.set(details.tabId, set)
		}
		if (set.size < MAX_DOMAINS_PER_TAB) set.add(host)
	},
	{ urls: ['<all_urls>'] }
)

chrome.tabs.onRemoved.addListener((tabId) => {
	tabDomains.delete(tabId)
})

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
	const domains = new Set()
	const tabSet = tabDomains.get(tabId)
	if (tabSet) {
		for (const d of tabSet) {
			domains.add(d)
			domains.add(d.replace(/^www\./, ''))
		}
	}

	if (domains.size === 0) return { total: 0, groups: [], status: 'no_domain' }
	if (cachedSnapshots.length === 0) return { total: 0, groups: [], status: 'fetching' }

	const domainList = [...domains]
	const allConns = new Map()
	for (const snap of cachedSnapshots) {
		const conns = snap.data.connections || []
		for (const c of conns) {
			const host = c.metadata?.host || c.metadata?.sniffHost || ''
			const matched = domainList.some(d => host === d || host.endsWith('.' + d))
			if (!matched) continue
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
				})
			}
			allConns.get(key).count++
		}
	}

	const groups = Array.from(allConns.values()).sort((a, b) => b.count - a.count)
	return { total: groups.reduce((s, g) => s + g.count, 0), groups, status: 'connected' }
}

async function getProxyGroups() {
	const data = await mihomoFetch(config.url, config.secret, '/group')
	const proxies = data.proxies || []
	return proxies
		.filter(p => p.type && p.type !== 'Direct' && p.type !== 'Reject')
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
			if (tabId > 0 && !tabDomains.has(tabId)) {
				try {
					const tab = await chrome.tabs.get(tabId)
					const host = extractHost(tab.url || '')
					if (host) {
						const set = new Set()
						set.add(host)
						tabDomains.set(tabId, set)
					}
				} catch {}
			}
			const data = getMergedGroups(tabId)
			await ensureProxyGroups()
			sendResponse({ data, proxyGroups })
		})()
		return true
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
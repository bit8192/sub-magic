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
const MAX_REQUESTS_PER_TAB = 200
const SHARED_SCORE_DELTA = 12
const WINNING_SCORE_DELTA = 8

function extractHost(url) {
	try { return normalizeHost(new URL(url).hostname) } catch { return '' }
}

function normalizeHost(host) {
	return String(host || '').trim().toLowerCase().replace(/\.+$/, '')
}

function getDefaultPort(protocol) {
	if (protocol === 'https:' || protocol === 'wss:') return '443'
	if (protocol === 'http:' || protocol === 'ws:') return '80'
	return ''
}

function extractRequestInfo(url) {
	try {
		const parsed = new URL(url)
		const host = normalizeHost(parsed.hostname)
		if (!host) return null
		return {
			host,
			port: parsed.port || getDefaultPort(parsed.protocol),
			url: parsed.href,
		}
	} catch {
		return null
	}
}

function httpToWs(url) {
	let base = url.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')
	return `ws://${base}`
}

function recordRequest(tabId, url) {
	if (!tabId || tabId < 0) return
	const info = extractRequestInfo(url)
	if (!info) return
	const requests = tabRequests.get(tabId) || []
	const now = Date.now()
	requests.push({
		host: info.host,
		port: info.port,
		ts: now,
		url: info.url,
	})
	const recentRequests = requests
		.filter(entry => now - entry.ts < REQUEST_TTL)
		.slice(-MAX_REQUESTS_PER_TAB)
	tabRequests.set(tabId, recentRequests)
}

function cleanupRequests(now) {
	for (const [tabId, requests] of tabRequests) {
		const recentRequests = requests.filter(entry => now - entry.ts < REQUEST_TTL)
		if (recentRequests.length > 0) {
			tabRequests.set(tabId, recentRequests.slice(-MAX_REQUESTS_PER_TAB))
		} else {
			tabRequests.delete(tabId)
		}
	}
}

function getTabRequests(tabId, now) {
	const requests = tabRequests.get(tabId) || []
	return requests.filter(entry => now - entry.ts < REQUEST_TTL)
}

function getHostMatchScore(connectionHost, requestHost) {
	const connHost = normalizeHost(connectionHost)
	const reqHost = normalizeHost(requestHost)
	if (!connHost || !reqHost) return 0
	if (connHost === reqHost) return 60
	const connBare = connHost.replace(/^www\./, '')
	const reqBare = reqHost.replace(/^www\./, '')
	if (connBare === reqBare) return 56
	if (connHost.endsWith('.' + reqHost) || reqHost.endsWith('.' + connHost)) return 46
	if (connHost.endsWith('.' + reqBare) || reqBare.endsWith('.' + connHost)) return 42
	return 0
}

function getFreshnessScore(requestTs, now) {
	const age = now - requestTs
	if (age <= 2000) return 18
	if (age <= 5000) return 14
	if (age <= 10000) return 9
	if (age <= REQUEST_TTL) return 4
	return 0
}

function getStartProximityScore(requestTs, connectionStart) {
	const startTs = Date.parse(connectionStart || '')
	if (!Number.isFinite(startTs)) return 0
	const delta = Math.abs(requestTs - startTs)
	if (delta <= 2000) return 12
	if (delta <= 5000) return 8
	if (delta <= 15000) return 3
	return 0
}

function scoreConnectionAgainstRequests(connection, requests, now) {
	const connectionHost = normalizeHost(connection.metadata?.host || connection.metadata?.sniffHost || '')
	const connectionPort = String(connection.metadata?.destinationPort || '')
	let best = null

	for (const request of requests) {
		const hostScore = getHostMatchScore(connectionHost, request.host)
		if (hostScore === 0) continue

		let score = hostScore
		if (request.port && connectionPort) {
			score += request.port === connectionPort ? 20 : -8
		}
		score += getFreshnessScore(request.ts, now)
		score += getStartProximityScore(request.ts, connection.start)

		if (!best || score > best.score || (score === best.score && request.ts > best.requestTs)) {
			best = {
				score,
				requestTs: request.ts,
				hostScore,
				portMatched: !!(request.port && connectionPort && request.port === connectionPort),
			}
		}
	}

	return best || { score: 0, requestTs: 0, hostScore: 0, portMatched: false }
}

function getConfidenceLabel(score) {
	if (score >= 78) return 'high'
	if (score >= 58) return 'medium'
	return 'low'
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
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
	if (changeInfo.url) {
		tabRequests.delete(tabId)
	}
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
	const now = Date.now()
	cleanupRequests(now)

	const currentTabRequests = getTabRequests(tabId, now)
	if (currentTabRequests.length === 0) return { total: 0, groups: [], status: 'no_domain' }
	if (cachedSnapshots.length === 0) return { total: 0, groups: [], status: 'fetching' }

	const allConns = new Map()

	for (const snap of cachedSnapshots) {
		const conns = snap.data.connections || []
		for (const c of conns) {
			const host = normalizeHost(c.metadata?.host || c.metadata?.sniffHost || '')
			if (!host) continue
			const selfMatch = scoreConnectionAgainstRequests(c, currentTabRequests, now)
			if (selfMatch.score <= 0) continue

			let bestOtherScore = 0
			let bestOtherTime = 0
			let bestOtherTabId = 0
			for (const [tid, requests] of tabRequests) {
				if (tid === tabId) continue
				const otherMatch = scoreConnectionAgainstRequests(c, requests, now)
				if (
					otherMatch.score > bestOtherScore ||
					(otherMatch.score === bestOtherScore && otherMatch.requestTs > bestOtherTime)
				) {
					bestOtherScore = otherMatch.score
					bestOtherTime = otherMatch.requestTs
					bestOtherTabId = tid
				}
			}

			const shared = bestOtherScore > 0
				&& Math.abs(selfMatch.score - bestOtherScore) <= SHARED_SCORE_DELTA
				&& Math.abs(selfMatch.requestTs - bestOtherTime) < CORRELATION_WINDOW
			const owned = selfMatch.score >= bestOtherScore + WINNING_SCORE_DELTA || (selfMatch.score > 0 && bestOtherScore === 0)

			if (!owned && !shared) continue

			const rule = c.rule || ''
			const destinationPort = String(c.metadata?.destinationPort || '')
			const key = `${host}\0${destinationPort}\0${rule}`
			if (!allConns.has(key)) {
				const chain = c.chains || c.chain || []
				allConns.set(key, {
					host,
					destinationPort,
					rule,
					count: 0,
					chain: Array.isArray(chain) ? chain : [],
					rulePayload: c.rulePayload || '',
					owned: false,
					shared: false,
					otherTabId: bestOtherTabId,
					score: selfMatch.score,
					confidence: getConfidenceLabel(selfMatch.score),
					portMatched: selfMatch.portMatched,
				})
			}
			const group = allConns.get(key)
			group.count++
			group.owned = group.owned || owned
			group.shared = group.shared || shared
			group.otherTabId = group.otherTabId || bestOtherTabId
			if (selfMatch.score > group.score) {
				group.score = selfMatch.score
				group.confidence = getConfidenceLabel(selfMatch.score)
				group.portMatched = selfMatch.portMatched
			}
		}
	}

	const groups = Array.from(allConns.values()).sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score
		return b.count - a.count
	})

	return {
		total: groups.reduce((s, g) => s + g.count, 0),
		groups,
		status: 'connected',
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

			if (tabId > 0 && !tabRequests.has(tabId)) {
				try {
					const tab = await chrome.tabs.get(tabId)
					const host = extractHost(tab.url || '')
					if (host) {
						recordRequest(tabId, tab.url)
					}
				} catch {}
			}

			const data = getMergedGroups(tabId)
			await ensureProxyGroups()
			sendResponse({ data, proxyGroups })
		})()
		return true
	} else if (msg.type === 'POLL_STOP') {
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

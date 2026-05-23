const extensionBrowser = typeof browser !== 'undefined' ? browser : null
const isFirefox = !!extensionBrowser?.proxy?.onRequest
const supportsIsolation = isFirefox

const PROXY_SYNC_KEYS = ['mihomoUrl', 'mihomoSecret', 'subMagicUrl', 'subMagicKey', 'proxyIsolation']
const PROXY_LOCAL_KEYS = ['proxyGlobalState', 'proxyTabStates']
const DEFAULT_PROXY_TYPE = 'http'

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

const proxyState = {
	isolationEnabled: supportsIsolation,
	globalProfile: createDefaultProxyProfile(),
	tabProfiles: {},
}

function createDefaultProxyProfile() {
	return {
		enabled: true,
		proxyType: DEFAULT_PROXY_TYPE,
		host: '',
		port: 0,
		listenerName: '',
		source: 'config',
		authUser: null,
	}
}

function normalizeAuthUser(authUser) {
	if (!authUser || typeof authUser !== 'object') return null
	const username = String(authUser.username || '').trim()
	const password = String(authUser.password || '')
	return username ? { username, password } : null
}

function normalizeProfile(profile) {
	const base = createDefaultProxyProfile()
	if (!profile || typeof profile !== 'object') return base
	return {
		enabled: profile.enabled !== false,
		proxyType: ['http', 'https', 'socks4', 'socks5'].includes(profile.proxyType) ? profile.proxyType : DEFAULT_PROXY_TYPE,
		host: String(profile.host || '').trim(),
		port: Number.isFinite(Number(profile.port)) ? Number(profile.port) : 0,
		listenerName: String(profile.listenerName || '').trim(),
		source: profile.source === 'listener' ? 'listener' : 'config',
		authUser: normalizeAuthUser(profile.authUser),
	}
}

function normalizeTabProfiles(tabProfiles) {
	if (!tabProfiles || typeof tabProfiles !== 'object') return {}
	const normalized = {}
	for (const [tabId, profile] of Object.entries(tabProfiles)) {
		if (!/^\d+$/.test(tabId)) continue
		normalized[tabId] = normalizeProfile(profile)
	}
	return normalized
}

function canApplyProfile(profile) {
	return !!(profile.enabled && profile.host && Number(profile.port) > 0)
}

function getBrowserInfo() {
	return {
		id: isFirefox ? 'firefox' : 'chrome',
		supportsIsolation,
	}
}

function getEffectiveProfile(tabId = 0) {
	if (supportsIsolation && proxyState.isolationEnabled && tabId > 0) {
		return normalizeProfile(proxyState.tabProfiles[String(tabId)] || proxyState.globalProfile)
	}
	return normalizeProfile(proxyState.globalProfile)
}

function serializeProxyState(tabId = 0) {
	return {
		browser: getBrowserInfo(),
		isolationEnabled: proxyState.isolationEnabled,
		profile: getEffectiveProfile(tabId),
	}
}

async function persistProxyState() {
	await chrome.storage.local.set({
		proxyGlobalState: proxyState.globalProfile,
		proxyTabStates: proxyState.tabProfiles,
	})
}

async function loadProxyState() {
	const syncData = await chrome.storage.sync.get(PROXY_SYNC_KEYS)
	const localData = await chrome.storage.local.get(PROXY_LOCAL_KEYS)

	proxyState.isolationEnabled = supportsIsolation ? syncData.proxyIsolation !== false : false
	proxyState.globalProfile = normalizeProfile(localData.proxyGlobalState)
	proxyState.tabProfiles = normalizeTabProfiles(localData.proxyTabStates)

	if (!supportsIsolation && syncData.proxyIsolation !== false) {
		await chrome.storage.sync.set({ proxyIsolation: false })
	}
	if (!localData.proxyGlobalState) {
		await persistProxyState()
	}

	await applyProxySettings()
}

function ensureHttpUrl(url) {
	if (!url) return ''
	return /^https?:\/\//i.test(url) ? url : `http://${url}`
}

function getMihomoHost() {
	try {
		return new URL(ensureHttpUrl(config.url)).hostname
	} catch {
		return ''
	}
}

function resolveConfigPortForType(profile, configs) {
	if (profile.proxyType === 'http' || profile.proxyType === 'https') {
		const directPort = Number(configs.port || 0)
		const mixedPort = Number(configs['mixed-port'] || 0)
		if (directPort > 0) return directPort
		if (mixedPort > 0) return mixedPort
		return 0
	}

	if (profile.proxyType === 'socks5') {
		const directPort = Number(configs['socks-port'] || 0)
		const mixedPort = Number(configs['mixed-port'] || 0)
		if (directPort > 0) return directPort
		if (mixedPort > 0) return mixedPort
		return 0
	}

	const directPort = Number(configs['socks-port'] || 0)
	return directPort > 0 ? directPort : 0
}

async function bootstrapProxyProfileFromMihomo(profile) {
	const normalized = normalizeProfile(profile)
	if (!normalized.enabled || canApplyProfile(normalized) || !config.url) {
		return normalized
	}

	try {
		const configs = await mihomoFetch(config.url, config.secret, '/configs')
		const host = getMihomoHost()
		const port = resolveConfigPortForType(normalized, configs || {})
		if (!host || port <= 0) return normalized

		return normalizeProfile({
			...normalized,
			host,
			port,
			source: 'config',
		})
	} catch {
		return normalized
	}
}

async function bootstrapProxyState() {
	const nextGlobalProfile = await bootstrapProxyProfileFromMihomo(proxyState.globalProfile)
	const changedGlobalProfile = JSON.stringify(nextGlobalProfile) !== JSON.stringify(proxyState.globalProfile)
	if (changedGlobalProfile) {
		proxyState.globalProfile = nextGlobalProfile
	}

	if (supportsIsolation) {
		let changedTabProfiles = false
		const nextTabProfiles = {}
		for (const [tabId, profile] of Object.entries(proxyState.tabProfiles)) {
			const nextProfile = await bootstrapProxyProfileFromMihomo(profile)
			nextTabProfiles[tabId] = nextProfile
			if (JSON.stringify(nextProfile) !== JSON.stringify(profile)) {
				changedTabProfiles = true
			}
		}
		if (changedTabProfiles) {
			proxyState.tabProfiles = nextTabProfiles
		}
		if (changedGlobalProfile || changedTabProfiles) {
			await persistProxyState()
		}
	} else if (changedGlobalProfile) {
		await persistProxyState()
	}

	await applyProxySettings()
}

function buildChromeProxyConfig(profile) {
	if (!canApplyProfile(profile)) {
		return { mode: 'direct' }
	}

	return {
		mode: 'fixed_servers',
		rules: {
			singleProxy: {
				scheme: profile.proxyType,
				host: profile.host,
				port: Number(profile.port),
			},
		},
	}
}

async function applyProxySettings() {
	if (isFirefox || !chrome.proxy?.settings?.set) return
	const profile = normalizeProfile(proxyState.globalProfile)
	await chrome.proxy.settings.set({
		value: buildChromeProxyConfig(profile),
		scope: 'regular',
	})
}

function buildFirefoxProxyInfo(profile, tabId) {
	if (!canApplyProfile(profile)) {
		return { type: 'direct' }
	}

	const info = {
		type: profile.proxyType === 'socks5' ? 'socks' : profile.proxyType,
		host: profile.host,
		port: Number(profile.port),
		connectionIsolationKey: proxyState.isolationEnabled && tabId > 0 ? `tab:${tabId}` : 'global',
	}

	if (profile.proxyType === 'socks5') {
		info.proxyDNS = true
		if (profile.authUser) {
			info.username = profile.authUser.username
			info.password = profile.authUser.password
		}
	}

	if (profile.proxyType === 'socks4') {
		info.proxyDNS = true
	}

	return info
}

function handleFirefoxProxyRequest(requestInfo) {
	const profile = getEffectiveProfile(requestInfo.tabId || 0)
	return buildFirefoxProxyInfo(profile, requestInfo.tabId || 0)
}

function resolveProxyAuthCredentials(details) {
	if (!details.isProxy) return null
	const profile = getEffectiveProfile(details.tabId || 0)
	if (!canApplyProfile(profile) || !profile.authUser) return null
	if (profile.proxyType !== 'http' && profile.proxyType !== 'https') return null
	return {
		authCredentials: {
			username: profile.authUser.username,
			password: profile.authUser.password,
		},
	}
}

function registerProxyAuthHandler() {
	const filter = { urls: ['<all_urls>'] }

	if (isFirefox && extensionBrowser?.webRequest?.onAuthRequired) {
		extensionBrowser.webRequest.onAuthRequired.addListener(
			(details) => resolveProxyAuthCredentials(details),
			filter,
			['blocking']
		)
		return
	}

	if (chrome.webRequest?.onAuthRequired) {
		chrome.webRequest.onAuthRequired.addListener(
			(details, callback) => {
				callback(resolveProxyAuthCredentials(details))
			},
			filter,
			['asyncBlocking']
		)
	}
}

if (isFirefox && extensionBrowser?.proxy?.onRequest) {
	extensionBrowser.proxy.onRequest.addListener(
		handleFirefoxProxyRequest,
		{ urls: ['<all_urls>'] }
	)
}

registerProxyAuthHandler()

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
	const base = url.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')
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
	if (proxyState.tabProfiles[String(tabId)]) {
		delete proxyState.tabProfiles[String(tabId)]
		persistProxyState().catch(() => {})
	}
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
		total: groups.reduce((sum, group) => sum + group.count, 0),
		groups,
		status: 'connected',
	}
}

async function getProxyGroups() {
	const data = await mihomoFetch(config.url, config.secret, '/proxies')
	const proxies = data.proxies || {}
	return Object.values(proxies)
		.filter(proxy => proxy?.name && proxy.type && proxy.type !== 'Direct' && proxy.type !== 'Reject')
		.map(proxy => ({ name: proxy.name, type: proxy.type, now: proxy.now || '' }))
}

function connectWs() {
	if (!config.url) return
	if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return

	const token = config.secret ? `?token=${encodeURIComponent(config.secret)}` : ''
	const wsUrl = `${httpToWs(config.url)}/connections?interval=2000${config.secret ? token.replace('?', '&') : ''}`

	try {
		ws = new WebSocket(wsUrl)

		ws.onopen = () => {
			reconnectDelay = 2000
		}

		ws.onmessage = (event) => {
			try {
				const data = JSON.parse(event.data)
				addSnapshot(data)
			} catch {}
		}

		ws.onclose = () => {
			ws = null
			if (!polling) {
				polling = true
				startPolling()
			}
		}

		ws.onerror = () => {
			if (ws) {
				ws.onclose = null
				ws.close()
				ws = null
			}
			if (!polling) {
				polling = true
				startPolling()
			}
		}
	} catch {
		if (!polling) {
			polling = true
			startPolling()
		}
	}
}

async function pollHttp() {
	if (!config.url) return
	try {
		const data = await mihomoFetch(config.url, config.secret, '/connections')
		addSnapshot(data)
	} catch {}
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
		try {
			ws.onclose = null
			ws.close()
		} catch {}
		ws = null
	}
	if (reconnectTimer) {
		clearTimeout(reconnectTimer)
		reconnectTimer = null
	}
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
		proxyGroups = await getProxyGroups()
	} catch {
		proxyGroups = []
	}
}

async function ensureSyncDefaults() {
	const data = await chrome.storage.sync.get(PROXY_SYNC_KEYS)
	const updates = {}
	if (data.mihomoUrl === undefined) updates.mihomoUrl = ''
	if (data.mihomoSecret === undefined) updates.mihomoSecret = ''
	if (data.subMagicUrl === undefined) updates.subMagicUrl = ''
	if (data.subMagicKey === undefined) updates.subMagicKey = ''
	if (data.proxyIsolation === undefined) updates.proxyIsolation = supportsIsolation
	if (Object.keys(updates).length > 0) {
		await chrome.storage.sync.set(updates)
	}
}

chrome.runtime.onInstalled.addListener(() => {
	ensureSyncDefaults().catch(() => {})
})

;(async () => {
	await ensureSyncDefaults()
	await loadConfig()
	await loadProxyState()
	await bootstrapProxyState()
	if (config.url) {
		initMonitor()
		ensureProxyGroups()
	}
})()

chrome.storage.onChanged.addListener((changes, area) => {
	if (area === 'sync' && (changes.mihomoUrl || changes.mihomoSecret)) {
		loadConfig().then(() => {
			if (config.url) {
				bootstrapProxyState().catch(() => {})
				initMonitor()
			} else {
				stopPolling()
			}
		})
	}

	if (area === 'sync' && changes.proxyIsolation) {
		loadProxyState().catch(() => {})
	}

	if (area === 'local' && (changes.proxyGlobalState || changes.proxyTabStates)) {
		loadProxyState().then(() => bootstrapProxyState()).catch(() => {})
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
	}

	if (msg.type === 'POLL_STOP') {
		sendResponse({ ok: true })
		return false
	}

	if (msg.type === 'REFRESH_PROXY') {
		;(async () => {
			await loadConfig()
			proxyGroups = []
			await ensureProxyGroups()
			sendResponse({ proxyGroups })
		})()
		return true
	}

	if (msg.type === 'PROXY_GET_STATE') {
		sendResponse(serializeProxyState(msg.tabId || 0))
		return false
	}

	if (msg.type === 'PROXY_SET_STATE') {
		;(async () => {
			const tabId = Number(msg.tabId || 0)
			const profile = normalizeProfile(msg.profile)
			const shouldPersist = msg.persist !== false
			if (supportsIsolation && proxyState.isolationEnabled && tabId > 0) {
				proxyState.tabProfiles[String(tabId)] = profile
			} else {
				proxyState.globalProfile = profile
			}
			if (shouldPersist) {
				await persistProxyState()
			}
			await applyProxySettings()
			sendResponse(serializeProxyState(tabId))
		})()
		return true
	}
})

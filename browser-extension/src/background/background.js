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
let ipCheckRunning = false

const tabRequests = new Map()
const routingPanelCache = new Map()
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

async function applyTemporaryGlobalProfile(profile, task) {
	const previousProfile = normalizeProfile(proxyState.globalProfile)
	proxyState.globalProfile = normalizeProfile(profile)
	await applyProxySettings()

	try {
		return await task()
	} finally {
		proxyState.globalProfile = previousProfile
		await applyProxySettings()
	}
}

function buildIpCheckSummary(ipInfo = {}) {
	const flags = []
	if (ipInfo.is_tor) flags.push('Tor')
	if (ipInfo.is_proxy) flags.push('Proxy')
	if (ipInfo.is_vpn) flags.push('VPN')
	if (ipInfo.is_datacenter) flags.push('机房')

	const companyType = String(ipInfo.company?.type || ipInfo.type || '').trim()
	if (companyType && !flags.includes(companyType)) {
		flags.push(companyType)
	}

	const risk = flags.length > 0 ? '高风险' : '低风险'
	return {
		risk,
		tags: flags,
	}
}

function firstNonEmpty(...values) {
	for (const value of values) {
		if (value === null || value === undefined) continue
		if (typeof value === 'string' && !value.trim()) continue
		return value
	}
	return ''
}

function normalizeBooleanFlag(value) {
	if (value === true) return '是'
	if (value === false) return '否'
	return '未知'
}

function buildIpCheckDetails(quality = {}, geo = {}) {
	const vpn = firstNonEmpty(quality?.is_vpn, quality?.security?.is_vpn)
	const proxy = firstNonEmpty(quality?.is_proxy, quality?.security?.is_proxy)
	const tor = firstNonEmpty(quality?.is_tor, quality?.security?.is_tor)
	const datacenter = firstNonEmpty(quality?.is_datacenter, quality?.security?.is_datacenter, geo?.hosting)
	const mobile = firstNonEmpty(quality?.is_mobile, quality?.company?.is_mobile, geo?.mobile)
	const crawler = firstNonEmpty(quality?.is_crawler, quality?.security?.is_crawler)

	return {
		networkType: firstNonEmpty(quality?.type, quality?.company?.type, geo?.type),
		continent: firstNonEmpty(quality?.location?.continent, geo?.continent),
		region: firstNonEmpty(quality?.location?.state, quality?.location?.region, geo?.region),
		city: firstNonEmpty(quality?.location?.city, geo?.city),
		postal: firstNonEmpty(quality?.location?.zip, quality?.location?.postal_code, geo?.postal_code),
		timezone: firstNonEmpty(quality?.location?.timezone, geo?.timezone),
		latitude: firstNonEmpty(quality?.location?.latitude, geo?.latitude),
		longitude: firstNonEmpty(quality?.location?.longitude, geo?.longitude),
		asnOrg: firstNonEmpty(quality?.company?.name, geo?.isp, geo?.organization),
		asnDomain: firstNonEmpty(quality?.company?.domain, geo?.domain),
		asnRoute: firstNonEmpty(quality?.company?.route, geo?.cidr),
		usageType: firstNonEmpty(quality?.company?.type, geo?.type),
		vpn: normalizeBooleanFlag(vpn),
		proxy: normalizeBooleanFlag(proxy),
		tor: normalizeBooleanFlag(tor),
		datacenter: normalizeBooleanFlag(datacenter),
		mobile: normalizeBooleanFlag(mobile),
		crawler: normalizeBooleanFlag(crawler),
		fraudScore: firstNonEmpty(quality?.fraud_score, quality?.risk?.score, quality?.score),
		abuseVelocity: firstNonEmpty(quality?.abuse?.velocity, quality?.abuse_velocity),
		abuseRecent: firstNonEmpty(quality?.abuse?.recent, quality?.abuse_recent),
	}
}

async function fetchJsonWithTimeout(url, timeoutMs = 8000) {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), timeoutMs)
	try {
		const res = await fetch(url, { signal: controller.signal, cache: 'no-store' })
		if (!res.ok) {
			const text = await res.text()
			throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`)
		}
		return await res.json()
	} finally {
		clearTimeout(timer)
	}
}

async function fetchTextWithTimeout(url, timeoutMs = 8000) {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), timeoutMs)
	try {
		const res = await fetch(url, {
			signal: controller.signal,
			cache: 'no-store',
			redirect: 'follow',
		})
		const text = await res.text()
		return {
			ok: res.ok,
			status: res.status,
			url: res.url,
			text,
		}
	} finally {
		clearTimeout(timer)
	}
}

function inferServiceStatus(result, options = {}) {
	if (!result) return { status: 'unknown', detail: '未检测' }
	if (result.error) return { status: 'blocked', detail: result.error }

	const text = String(result.text || '')
	const finalUrl = String(result.url || '')
	if (typeof options.match === 'function') {
		return options.match({ ...result, text, finalUrl })
	}

	if (result.ok) return { status: 'available', detail: `HTTP ${result.status}` }
	return { status: 'blocked', detail: `HTTP ${result.status}` }
}

async function probeServiceMatrix() {
	const tasks = {
		chatgpt: fetchTextWithTimeout('https://chatgpt.com/', 10000),
		openai: fetchTextWithTimeout('https://openai.com/', 10000),
		claude: fetchTextWithTimeout('https://claude.ai/', 10000),
		gemini: fetchTextWithTimeout('https://gemini.google.com/app', 10000),
		youtubePremium: fetchTextWithTimeout('https://www.youtube.com/premium', 10000),
		netflix: fetchTextWithTimeout('https://www.netflix.com/title/81215567', 10000),
		disneyPlus: fetchTextWithTimeout('https://www.disneyplus.com/', 10000),
		primeVideo: fetchTextWithTimeout('https://www.primevideo.com/', 10000),
	}

	const settled = await Promise.allSettled(Object.values(tasks))
	const entries = Object.keys(tasks).map((key, index) => {
		const item = settled[index]
		if (item.status === 'fulfilled') return [key, item.value]
		return [key, { error: item.reason?.message || '请求失败' }]
	})
	const raw = Object.fromEntries(entries)

	return {
		chatgpt: inferServiceStatus(raw.chatgpt, {
			match: ({ ok, status, text, finalUrl }) => {
				if (!ok) return { status: 'blocked', detail: `HTTP ${status}` }
				if (finalUrl.includes('/auth/error')) return { status: 'blocked', detail: '访问被拒绝' }
				if (text.includes('ChatGPT') || text.includes('OpenAI')) return { status: 'available', detail: `HTTP ${status}` }
				return { status: 'unknown', detail: `HTTP ${status}` }
			},
		}),
		openai: inferServiceStatus(raw.openai, {
			match: ({ ok, status, text }) => {
				if (!ok) return { status: 'blocked', detail: `HTTP ${status}` }
				if (text.includes('OpenAI')) return { status: 'available', detail: `HTTP ${status}` }
				return { status: 'unknown', detail: `HTTP ${status}` }
			},
		}),
		claude: inferServiceStatus(raw.claude, {
			match: ({ ok, status, text, finalUrl }) => {
				if (!ok) return { status: 'blocked', detail: `HTTP ${status}` }
				if (text.includes('Claude') || finalUrl.includes('claude.ai')) return { status: 'available', detail: `HTTP ${status}` }
				return { status: 'unknown', detail: `HTTP ${status}` }
			},
		}),
		gemini: inferServiceStatus(raw.gemini, {
			match: ({ ok, status, text, finalUrl }) => {
				if (!ok) return { status: 'blocked', detail: `HTTP ${status}` }
				if (finalUrl.includes('sorry') || text.includes('not available in your country')) {
					return { status: 'blocked', detail: '地区不可用' }
				}
				if (text.includes('Gemini') || finalUrl.includes('gemini.google.com')) {
					return { status: 'available', detail: `HTTP ${status}` }
				}
				return { status: 'unknown', detail: `HTTP ${status}` }
			},
		}),
		youtubePremium: inferServiceStatus(raw.youtubePremium, {
			match: ({ ok, status, text, finalUrl }) => {
				if (!ok) return { status: 'blocked', detail: `HTTP ${status}` }
				if (finalUrl.includes('/premium') && (text.includes('YouTube Premium') || text.includes('ad-free'))) {
					return { status: 'available', detail: `HTTP ${status}` }
				}
				return { status: 'unknown', detail: `HTTP ${status}` }
			},
		}),
		netflix: inferServiceStatus(raw.netflix, {
			match: ({ ok, status, text, finalUrl }) => {
				if (!ok) return { status: 'blocked', detail: `HTTP ${status}` }
				if (text.includes('Netflix') || finalUrl.includes('netflix.com/title/')) {
					return { status: 'available', detail: `HTTP ${status}` }
				}
				return { status: 'unknown', detail: `HTTP ${status}` }
			},
		}),
		disneyPlus: inferServiceStatus(raw.disneyPlus, {
			match: ({ ok, status, text, finalUrl }) => {
				if (!ok) return { status: 'blocked', detail: `HTTP ${status}` }
				if (text.includes('Disney+') || finalUrl.includes('disneyplus.com')) {
					return { status: 'available', detail: `HTTP ${status}` }
				}
				return { status: 'unknown', detail: `HTTP ${status}` }
			},
		}),
		primeVideo: inferServiceStatus(raw.primeVideo, {
			match: ({ ok, status, text, finalUrl }) => {
				if (!ok) return { status: 'blocked', detail: `HTTP ${status}` }
				if (text.includes('Prime Video') || finalUrl.includes('primevideo.com')) {
					return { status: 'available', detail: `HTTP ${status}` }
				}
				return { status: 'unknown', detail: `HTTP ${status}` }
			},
		}),
		raw,
	}
}

async function probeReferenceDatabases() {
	const tasks = {
		ipinfo: fetchJsonWithTimeout('https://ipinfo.io/json', 10000),
		ipapiCo: fetchJsonWithTimeout('https://ipapi.co/json/', 10000),
		dbIp: fetchJsonWithTimeout('https://api.db-ip.com/v2/free/self', 10000),
	}

	const settled = await Promise.allSettled(Object.values(tasks))
	const entries = Object.keys(tasks).map((key, index) => {
		const item = settled[index]
		if (item.status === 'fulfilled') return [key, item.value]
		return [key, { error: item.reason?.message || '请求失败' }]
	})
	const raw = Object.fromEntries(entries)

	return {
		ipinfo: raw.ipinfo?.error ? null : {
			ip: raw.ipinfo?.ip || '',
			country: raw.ipinfo?.country || '',
			region: raw.ipinfo?.region || '',
			city: raw.ipinfo?.city || '',
			loc: raw.ipinfo?.loc || '',
			org: raw.ipinfo?.org || '',
			postal: raw.ipinfo?.postal || '',
			timezone: raw.ipinfo?.timezone || '',
			privacy: raw.ipinfo?.privacy || null,
			company: raw.ipinfo?.company || null,
		},
		ipapiCo: raw.ipapiCo?.error ? null : {
			ip: raw.ipapiCo?.ip || '',
			country: raw.ipapiCo?.country_code || raw.ipapiCo?.country || '',
			region: raw.ipapiCo?.region || '',
			city: raw.ipapiCo?.city || '',
			latitude: raw.ipapiCo?.latitude || '',
			longitude: raw.ipapiCo?.longitude || '',
			asn: raw.ipapiCo?.asn || '',
			org: raw.ipapiCo?.org || '',
			postal: raw.ipapiCo?.postal || '',
			timezone: raw.ipapiCo?.timezone || '',
			inEu: raw.ipapiCo?.in_eu ?? null,
			countryArea: raw.ipapiCo?.country_area || '',
			countryPopulation: raw.ipapiCo?.country_population || '',
		},
		dbIp: raw.dbIp?.error ? null : {
			ip: raw.dbIp?.ipAddress || '',
			country: raw.dbIp?.countryCode || '',
			region: raw.dbIp?.stateProv || '',
			city: raw.dbIp?.city || '',
			latitude: raw.dbIp?.latitude || '',
			longitude: raw.dbIp?.longitude || '',
			isp: raw.dbIp?.isp || '',
		},
		raw,
	}
}

async function runIpCheckProbe(payload) {
	if (ipCheckRunning) {
		throw new Error('已有检测任务正在执行，请稍后重试')
	}

	const baseProfile = normalizeProfile(payload?.profile)
	if (!canApplyProfile(baseProfile)) {
		throw new Error('当前代理配置不可用，请先启用可用的 Mihomo 代理端口')
	}

	const authUser = normalizeAuthUser(payload?.authUser)
	if (!authUser) {
		throw new Error('IpCheck 代理认证用户无效')
	}

	const probeProfile = normalizeProfile({
		...baseProfile,
		enabled: true,
		authUser,
	})

	ipCheckRunning = true
	try {
		return await applyTemporaryGlobalProfile(probeProfile, async () => {
			const [qualityRes, geoRes, serviceRes, refsRes] = await Promise.allSettled([
				fetchJsonWithTimeout('https://ipapi.is/json'),
				fetchJsonWithTimeout('https://api.ip.sb/geoip'),
				probeServiceMatrix(),
				probeReferenceDatabases(),
			])

			const quality = qualityRes.status === 'fulfilled' ? qualityRes.value : null
			const geo = geoRes.status === 'fulfilled' ? geoRes.value : null
			const services = serviceRes.status === 'fulfilled' ? serviceRes.value : null
			const references = refsRes.status === 'fulfilled' ? refsRes.value : null
			if (!quality && !geo) {
				const firstError = qualityRes.status === 'rejected' ? qualityRes.reason : geoRes.reason
				throw new Error(firstError?.message || 'IP 检测失败')
			}

			const ip = quality?.ip || geo?.ip || ''
			const country = quality?.location?.country || geo?.country || ''
			const countryCode = quality?.location?.country_code || geo?.country_code || ''
			const city = quality?.location?.city || geo?.city || ''
			const asn = quality?.company?.asn || geo?.asn || ''
			const isp = quality?.company?.name || geo?.isp || geo?.organization || ''
			const summary = buildIpCheckSummary(quality || {})
			const details = buildIpCheckDetails(quality || {}, geo || {})

			return {
				ok: true,
				ip,
				country,
				countryCode,
				city,
				asn,
				isp,
				risk: summary.risk,
				tags: summary.tags,
				details,
				services,
				references,
				raw: {
					quality,
					geo,
					services: services?.raw || null,
					references: references?.raw || null,
				},
			}
		})
	} finally {
		ipCheckRunning = false
	}
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

function getRequestKey(request) {
	return `${request.requestId || ''}\0${request.ts}\0${request.url || ''}`
}

function recordRequest(tabId, url, requestId = '') {
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
		requestId: String(requestId || ''),
		status: 'pending',
		error: '',
		fromCache: false,
	})
	const recentRequests = requests
		.filter(entry => now - entry.ts < REQUEST_TTL)
		.slice(-MAX_REQUESTS_PER_TAB)
	tabRequests.set(tabId, recentRequests)
}

function updateRequest(tabId, requestId, patch) {
	if (!tabId || tabId < 0 || !requestId) return
	const requests = tabRequests.get(tabId) || []
	if (requests.length === 0) return
	for (let i = requests.length - 1; i >= 0; i--) {
		if (requests[i].requestId !== requestId) continue
		requests[i] = {
			...requests[i],
			...patch,
		}
		tabRequests.set(tabId, requests)
		return
	}
}

function markRequestFailed(tabId, requestId, error) {
	updateRequest(tabId, requestId, {
		status: 'failed',
		error: String(error || '').trim(),
	})
}

function markRequestCompleted(tabId, requestId, fromCache) {
	updateRequest(tabId, requestId, {
		status: 'completed',
		fromCache: !!fromCache,
	})
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
				requestKey: getRequestKey(request),
				hostScore,
				portMatched: !!(request.port && connectionPort && request.port === connectionPort),
			}
		}
	}

	return best || { score: 0, requestTs: 0, requestKey: '', hostScore: 0, portMatched: false }
}

function getConfidenceLabel(score) {
	if (score >= 78) return 'high'
	if (score >= 58) return 'medium'
	return 'low'
}

chrome.webRequest.onBeforeRequest.addListener(
	(details) => {
		if (details.tabId < 0) return
		recordRequest(details.tabId, details.url, details.requestId)
	},
	{ urls: ['<all_urls>'] }
)

chrome.webRequest.onErrorOccurred.addListener(
	(details) => {
		if (details.tabId < 0) return
		markRequestFailed(details.tabId, details.requestId, details.error)
	},
	{ urls: ['<all_urls>'] }
)

chrome.webRequest.onCompleted.addListener(
	(details) => {
		if (details.tabId < 0) return
		markRequestCompleted(details.tabId, details.requestId, details.fromCache)
	},
	{ urls: ['<all_urls>'] }
)

chrome.tabs.onRemoved.addListener((tabId) => {
	tabRequests.delete(tabId)
	clearRoutingPanelCache(tabId)
	if (proxyState.tabProfiles[String(tabId)]) {
		delete proxyState.tabProfiles[String(tabId)]
		persistProxyState().catch(() => {})
	}
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
	if (changeInfo.url) {
		tabRequests.delete(tabId)
		clearRoutingPanelCache(tabId)
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

function buildRoutingGroupKey(group) {
	return [
		group.kind || 'matched',
		group.host || '',
		group.destinationPort || '',
		group.rule || '',
		group.rulePayload || '',
		group.error || '',
	].join('\0')
}

function mergeRoutingPanelData(tabId, data) {
	if (!tabId || !data || typeof data !== 'object') return data
	const nextGroups = Array.isArray(data.groups) ? data.groups : []
	const cached = routingPanelCache.get(tabId)

	if (!cached) {
		const initial = {
			...data,
			groups: nextGroups.map(group => ({ ...group })),
		}
		routingPanelCache.set(tabId, initial)
		return initial
	}

	const groupMap = new Map(
		(cached.groups || []).map(group => [buildRoutingGroupKey(group), { ...group }])
	)
	for (const group of nextGroups) {
		groupMap.set(buildRoutingGroupKey(group), { ...group })
	}

	const merged = {
		...cached,
		...data,
		total: Math.max(Number(cached.total || 0), Number(data.total || 0)),
		issueTotal: Math.max(Number(cached.issueTotal || 0), Number(data.issueTotal || 0)),
		groups: Array.from(groupMap.values()),
	}
	routingPanelCache.set(tabId, merged)
	return merged
}

function clearRoutingPanelCache(tabId) {
	if (!tabId || tabId < 0) return
	routingPanelCache.delete(tabId)
}

function logMergedGroups(tabId, groups, totalConnections, issueTotal) {
	const payload = groups.map((group) => ({
		kind: group.kind || 'matched',
		host: group.host || '',
		port: group.destinationPort || '',
		destinationIps: Array.isArray(group.destinationIps) ? group.destinationIps : [],
		connectionIds: Array.isArray(group.connectionIds) ? group.connectionIds : [],
		count: group.count || 0,
		rule: group.rule || '',
		error: group.error || '',
		confidence: group.confidence || '',
		shared: !!group.shared,
		chain: Array.isArray(group.chain) ? group.chain : [],
		latestUrl: group.latestUrl || '',
	}))
	console.debug('[sub-magic] routing groups', {
		tabId,
		totalConnections,
		issueTotal,
		groupCount: groups.length,
		groups: payload,
	})
}

function getMergedGroups(tabId) {
	const now = Date.now()
	cleanupRequests(now)

	const currentTabRequests = getTabRequests(tabId, now)
	if (currentTabRequests.length === 0) return { total: 0, groups: [], status: 'no_domain' }
	if (cachedSnapshots.length === 0) return { total: 0, groups: [], status: 'fetching' }

	const allConns = new Map()
	const matchedRequestKeys = new Set()

	for (const snap of cachedSnapshots) {
		const conns = snap.data.connections || []
		for (const c of conns) {
			const host = normalizeHost(c.metadata?.host || c.metadata?.sniffHost || '')
			if (!host) continue
			const selfMatch = scoreConnectionAgainstRequests(c, currentTabRequests, now)
			if (selfMatch.score <= 0) continue
			if (selfMatch.requestKey) matchedRequestKeys.add(selfMatch.requestKey)

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
			const destinationIp = String(c.metadata?.destinationIP || '').trim()
			const key = `${host}\0${destinationPort}\0${rule}`
			if (!allConns.has(key)) {
				const chain = c.chains || c.chain || []
				const connectionId = String(c.id || '').trim()
				allConns.set(key, {
					host,
					destinationPort,
					destinationIps: destinationIp ? [destinationIp] : [],
					connectionIds: connectionId ? [connectionId] : [],
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
			if (destinationIp && !group.destinationIps.includes(destinationIp)) {
				group.destinationIps.push(destinationIp)
				if (group.destinationIps.length > 6) {
					group.destinationIps = group.destinationIps.slice(0, 6)
				}
			}
			const connectionId = String(c.id || '').trim()
			if (connectionId && !group.connectionIds.includes(connectionId)) {
				group.connectionIds.push(connectionId)
			}
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

	const matchedGroups = Array.from(allConns.values()).sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score
		return b.count - a.count
	})
	const matchedGroupByHostPort = new Map(
		matchedGroups.map(group => [`${group.host}\0${group.destinationPort || ''}`, group])
	)

	const issueGroupsMap = new Map()
	for (const request of currentTabRequests) {
		const requestKey = getRequestKey(request)
		if (matchedRequestKeys.has(requestKey)) continue
		if (request.fromCache) continue
		const kind = request.status === 'failed' ? 'failed' : 'unmatched'
		const hostPortKey = `${request.host}\0${request.port || ''}`
		if (kind === 'unmatched' && matchedGroupByHostPort.has(hostPortKey)) {
			const matchedGroup = matchedGroupByHostPort.get(hostPortKey)
			matchedGroup.mergedUnmatchedCount = (matchedGroup.mergedUnmatchedCount || 0) + 1
			matchedGroup.latestUrl = request.url || matchedGroup.latestUrl || ''
			matchedGroup.latestTs = Math.max(Number(matchedGroup.latestTs || 0), Number(request.ts || 0))
			continue
		}
		const groupKey = `${kind}\0${request.host}\0${request.port}\0${request.error || ''}`
		if (!issueGroupsMap.has(groupKey)) {
			issueGroupsMap.set(groupKey, {
				kind,
				host: request.host,
				destinationPort: request.port || '',
				destinationIps: [],
				rule: '',
				count: 0,
				chain: [],
				rulePayload: '',
				error: request.error || '',
				latestUrl: request.url || '',
				latestTs: request.ts,
			})
		}
		const group = issueGroupsMap.get(groupKey)
		group.count++
		if (request.ts >= group.latestTs) {
			group.latestTs = request.ts
			group.latestUrl = request.url || group.latestUrl
			if (request.error) group.error = request.error
		}
	}

	const issueGroups = Array.from(issueGroupsMap.values()).sort((a, b) => {
		if (a.kind !== b.kind) return a.kind === 'failed' ? -1 : 1
		if (b.latestTs !== a.latestTs) return b.latestTs - a.latestTs
		return b.count - a.count
	})

	const groups = [...matchedGroups, ...issueGroups]
	const totalConnections = matchedGroups.reduce((sum, group) => sum + group.count, 0)
	const issueTotal = issueGroups.reduce((sum, group) => sum + group.count, 0)
	logMergedGroups(tabId, groups, totalConnections, issueTotal)

	return {
		total: totalConnections,
		issueTotal,
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

			const data = mergeRoutingPanelData(tabId, getMergedGroups(tabId))
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

	if (msg.type === 'IPCHECK_PROBE') {
		;(async () => {
			try {
				const result = await runIpCheckProbe(msg)
				sendResponse(result)
			} catch (error) {
				sendResponse({ ok: false, error: error.message || 'IP 检测失败' })
			}
		})()
		return true
	}
})

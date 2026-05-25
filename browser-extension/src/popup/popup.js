import {
	parseRuleDisplay,
	findRuleByConnection,
	addRuleLocal,
	addRuleRemote,
	updateRuleRemote,
	waitForRuleUpdate,
	waitForRulePresent,
	deleteRule,
	getExternalUiConfig,
	getListeners,
	getLocalRules,
	getMihomoConfigs,
	getProxyAuthUsers,
	getProxySnapshot,
	getProxyProviders,
	setProxySelector,
	closeConnection,
	ensureIpCheckLocalConfig,
	ensureIpCheckRemoteConfig,
} from '../utils/api.js'
import {
	DEFAULT_PROXY_TYPE,
	buildAvailableProxyPortOptions,
	findProxyPortOption,
	getPreferredProxyType,
	isProxyTypeSupportedByPortOption,
} from '../utils/proxy-options.js'
import { getGeoRuleSuggestions } from '../utils/geodata.js'

const state = {
	domain: '',
	tabId: 0,
	mihomo: { url: '', secret: '' },
	subMagic: { url: '', accessKey: '' },
	externalUi: '',
	browser: { id: 'chrome', supportsIsolation: false },
	proxyIsolation: false,
	proxyProfile: null,
	proxyAuthUsers: [],
	listeners: [],
	mihomoConfigs: null,
	proxyPortOptions: [],
	proxyValidation: null,
	proxyGroups: [],
	proxyMap: {},
	proxyProviders: {},
	localRules: [],
	ruleMode: null,
	editingRule: null,
	ruleGeoContext: { host: '', destinationIps: [] },
	currentSelector: '',
	currentSelectorRouteKey: '',
	currentIpCheckKey: '',
	routingData: null,
	proxyPanelCollapsed: false,
	proxyPanelTouched: false,
	geoSuggestionSeq: 0,
	ipCheckByGroupKey: {},
	ipCheckKnownDomains: [],
}

const IPCHECK_GROUP_NAME = 'IpCheck'
const IPCHECK_USERNAME = 'IpCheck'
const IPCHECK_DEFAULT_PASSWORD = 'submagic-ipcheck'
const IPCHECK_RULE_DOMAINS = [
	'ip.sb',
	'api.ip.sb',
	'ipapi.is',
	'ipapi.co',
	'ipinfo.io',
	'api.db-ip.com',
	'chatgpt.com',
	'openai.com',
	'claude.ai',
	'anthropic.com',
	'gemini.google.com',
	'google.com',
	'youtube.com',
	'netflix.com',
	'disneyplus.com',
	'dssott.com',
	'primevideo.com',
	'ipv6.netflix.com',
]

state.ipCheckKnownDomains = [...IPCHECK_RULE_DOMAINS]

let pollTimer = null
let proxyRefreshTimer = null
let observedTabUpdateHandler = null

document.addEventListener('DOMContentLoaded', async () => {
	await initCurrentTab()
	await loadSettings()
	await loadProxyState()
	refreshRuleTypeAvailability()

	document.getElementById('btn-add-rule').addEventListener('click', handleAddRule)
	document.getElementById('btn-save-rule').addEventListener('click', handleSaveRule)
	document.getElementById('btn-delete-rule').addEventListener('click', handleDeleteRule)
	document.getElementById('btn-back-routing').addEventListener('click', showRoutingPanel)
	document.getElementById('btn-back-selector').addEventListener('click', showRoutingPanel)
	document.getElementById('btn-back-ipcheck').addEventListener('click', showRoutingPanel)
	document.getElementById('btn-settings').addEventListener('click', () => chrome.runtime.openOptionsPage())
	document.getElementById('btn-management-page').addEventListener('click', openManagementPage)
	document.getElementById('btn-control-panel').addEventListener('click', openControlPanel)
	document.getElementById('btn-apply-proxy').addEventListener('click', handleApplyProxy)
	document.getElementById('btn-toggle-proxy-panel').addEventListener('click', toggleProxyPanel)
	document.getElementById('rule-type').addEventListener('change', onRuleTypeChange)
	document.getElementById('selector-result').addEventListener('click', handleSelectorResultClick)
	document.getElementById('ipcheck-result').addEventListener('click', handleIpCheckResultClick)
	document.getElementById('geo-suggestion-box').addEventListener('click', handleGeoSuggestionClick)
	document.getElementById('proxy-port').addEventListener('change', () => refreshProxyForm())
	document.getElementById('proxy-type').addEventListener('change', () => refreshProxyForm())
	document.getElementById('proxy-auth-user').addEventListener('change', () => refreshProxyMeta())
	document.getElementById('rule-priority-select').addEventListener('change', updateRulePriorityHint)

	const proxySelect = document.getElementById('rule-proxy-select')
	proxySelect.addEventListener('change', () => {
		if (proxySelect.value === '__custom__') {
			document.getElementById('rule-proxy-input').style.display = ''
			document.getElementById('rule-proxy-input').value = ''
		} else {
			document.getElementById('rule-proxy-input').style.display = 'none'
		}
	})

	if (state.mihomo.url) {
		await refreshControlPanelButton()
		await refreshProxyControls()
		await refreshProxyData(true)
		await startRoutingPoll()
	} else {
		refreshControlPanelButton()
		refreshProxyMeta({ ok: false, reason: '请先在设置中配置 Mihomo API。' })
	}

	window.addEventListener('pagehide', () => {
		if (pollTimer) clearInterval(pollTimer)
		if (proxyRefreshTimer) clearInterval(proxyRefreshTimer)
		if (observedTabUpdateHandler && chrome.tabs?.onUpdated) {
			chrome.tabs.onUpdated.removeListener(observedTabUpdateHandler)
			observedTabUpdateHandler = null
		}
		if (state.tabId > 0) {
			chrome.runtime.sendMessage({ type: 'POLL_STOP', tabId: state.tabId }).catch(() => {})
		}
	})

	window.addEventListener('beforeunload', () => {
		if (state.tabId > 0) {
			chrome.runtime.sendMessage({ type: 'POLL_STOP', tabId: state.tabId }).catch(() => {})
		}
	})

	startTabReloadObserver()
})

async function loadSettings() {
	const data = await chrome.storage.sync.get(['mihomoUrl', 'mihomoSecret', 'subMagicUrl', 'subMagicKey'])
	if (data.mihomoUrl) state.mihomo.url = data.mihomoUrl
	if (data.mihomoSecret) state.mihomo.secret = data.mihomoSecret
	if (data.subMagicUrl) state.subMagic.url = data.subMagicUrl
	if (data.subMagicKey) state.subMagic.accessKey = data.subMagicKey

	document.getElementById('routing-section').style.display = state.mihomo.url ? '' : 'none'
	refreshManagementPageButton()
}

function refreshManagementPageButton() {
	const button = document.getElementById('btn-management-page')
	button.disabled = !state.subMagic.url
}

async function refreshControlPanelButton() {
	const button = document.getElementById('btn-control-panel')
	button.style.display = 'none'
	state.externalUi = ''

	if (!(state.mihomo.url && state.subMagic.url && state.subMagic.accessKey)) return

	try {
		const response = await getExternalUiConfig(state.subMagic.url, state.subMagic.accessKey)
		const externalUi = String(response?.externalUi || '').trim()
		if (!externalUi) return
		state.externalUi = externalUi
		button.style.display = ''
	} catch {}
}

function joinExternalUiUrl(baseUrl, externalUi) {
	const normalizedBase = ensureHttpUrl(baseUrl).replace(/\/+$/, '')
	const normalizedPath = String(externalUi || '').trim().replace(/^\/+/, '')
	if (!normalizedPath) return normalizedBase
	return `${normalizedBase}/${normalizedPath}`
}

function openControlPanel() {
	if (!(state.mihomo.url && state.externalUi)) return
	const url = joinExternalUiUrl(state.mihomo.url, state.externalUi)
	if (chrome.tabs?.create) {
		chrome.tabs.create({ url })
		return
	}
	window.open(url, '_blank', 'noopener,noreferrer')
}

function openManagementPage() {
	if (!state.subMagic.url) return
	const url = ensureHttpUrl(state.subMagic.url)
	if (chrome.tabs?.create) {
		chrome.tabs.create({ url })
		return
	}
	window.open(url, '_blank', 'noopener,noreferrer')
}

async function initCurrentTab() {
	const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
	if (tabs && tabs.length > 0) {
		state.tabId = tabs[0].id || 0
		try {
			state.domain = new URL(tabs[0].url || '').hostname
		} catch {
			state.domain = ''
		}
	}
}

async function loadProxyState() {
	const response = await chrome.runtime.sendMessage({ type: 'PROXY_GET_STATE', tabId: state.tabId })
	if (!response) return
	state.browser = response.browser || state.browser
	state.proxyIsolation = !!response.isolationEnabled
	state.proxyProfile = response.profile || null
	applyProxyProfileToForm()
}

function ensureHttpUrl(url) {
	if (!url) return ''
	return /^https?:\/\//i.test(url) ? url : `http://${url}`
}

function getMihomoHost() {
	try {
		return new URL(ensureHttpUrl(state.mihomo.url)).hostname
	} catch {
		return ''
	}
}

function isProxyAuthUserSupported(proxyType) {
	return !(state.browser.id === 'chrome' && (proxyType === 'socks4' || proxyType === 'socks5'))
}

function getSelectedPortOption() {
	const selectedId = document.getElementById('proxy-port').value
	return state.proxyPortOptions.find((option) => option.id === selectedId) || null
}

function renderProxyPortOptions(selectedId = '') {
	const select = document.getElementById('proxy-port')
	let options = [...state.proxyPortOptions]

	if (selectedId && !options.some((option) => option.id === selectedId)) {
		const fallbackPort = Number(state.proxyProfile?.port || 0)
		const fallbackLabel = state.proxyProfile?.source === 'listener' && state.proxyProfile?.listenerName
			? `${state.proxyProfile.listenerName} · ${fallbackPort || '-'} · 已失效`
			: `${state.proxyProfile?.source === 'config' ? '/configs' : '未知来源'} · ${fallbackPort || '-'} · 已失效`
		options.unshift({
			id: selectedId,
			source: state.proxyProfile?.source || 'config',
			sourceLabel: state.proxyProfile?.source === 'listener' && state.proxyProfile?.listenerName
				? `listener / ${state.proxyProfile.listenerName}`
				: '/configs',
			listenerName: state.proxyProfile?.listenerName || '',
			port: fallbackPort,
			supportedTypes: [state.proxyProfile?.proxyType || DEFAULT_PROXY_TYPE],
			label: fallbackLabel,
		})
	}

	let html = '<option value="">请选择</option>'
	for (const option of options) {
		const selected = option.id === selectedId ? ' selected' : ''
		html += `<option value="${escAttr(option.id)}"${selected}>${escHtml(option.label)}</option>`
	}
	select.innerHTML = html
	select.disabled = options.length === 0
}

function renderProxyTypeOptions(selectedType = '') {
	const select = document.getElementById('proxy-type')
	const option = getSelectedPortOption()
	const supportedTypes = option?.supportedTypes || []
	const preferredType = getPreferredProxyType(option, selectedType, DEFAULT_PROXY_TYPE)
	const labels = {
		http: 'HTTP',
		https: 'HTTPS',
		socks4: 'SOCKS4',
		socks5: 'SOCKS5',
	}

	let html = ''
	for (const type of supportedTypes) {
		const selected = type === preferredType ? ' selected' : ''
		html += `<option value="${type}"${selected}>${labels[type] || type.toUpperCase()}</option>`
	}
	select.innerHTML = html
	select.disabled = supportedTypes.length === 0
	if (supportedTypes.length === 0) {
		select.value = ''
	}
}

function getSelectedProxyType() {
	return document.getElementById('proxy-type').value || ''
}

function getSelectedAuthUser() {
	const proxyType = getSelectedProxyType()
	if (!isProxyAuthUserSupported(proxyType)) return null
	const selectedUsername = document.getElementById('proxy-auth-user').value
	if (!selectedUsername) return null
	return state.proxyAuthUsers.find(user => user.username === selectedUsername) || null
}

function refreshProxyAuthUserAvailability(proxyType) {
	const select = document.getElementById('proxy-auth-user')
	const hint = document.getElementById('proxy-auth-user-hint')
	const supported = isProxyAuthUserSupported(proxyType)

	select.disabled = !supported
	if (!supported) {
		select.value = ''
		hint.textContent = 'Chrome 中选择 SOCKS4/SOCKS5 时，不支持代理认证用户。'
		return
	}

	hint.textContent = ''
}

function buildProxyValidation(profile) {
	if (!state.mihomo.url) {
		return { ok: false, reason: '请先配置 Mihomo API。' }
	}

	const host = getMihomoHost()
	if (!host) {
		return { ok: false, reason: '无法从 Mihomo API 地址解析代理 host。' }
	}

	const portOption = getSelectedPortOption()
	if (!portOption) {
		return { ok: false, reason: '当前没有可用代理端口。' }
	}
	if (!isProxyTypeSupportedByPortOption(portOption, profile.proxyType)) {
		return { ok: false, reason: '当前代理端口不支持所选代理方式。' }
	}
	if (Number(portOption.port) <= 0) {
		return { ok: false, reason: '当前代理端口无效。' }
	}

	if (
		state.browser.id === 'chrome' &&
		(profile.proxyType === 'socks4' || profile.proxyType === 'socks5') &&
		profile.authUser
	) {
		return { ok: false, reason: 'Chrome 无法为 SOCKS 代理自动注入认证，请改用 HTTP/HTTPS 或清空代理用户。' }
	}

	return {
		ok: true,
		host,
		port: Number(portOption.port),
		source: portOption.source,
		listenerName: portOption.listenerName || '',
		sourceLabel: portOption.sourceLabel || '',
	}
}

function buildProfileFromForm() {
	const currentProfile = state.proxyProfile || {}
	const portOption = getSelectedPortOption()
	const draft = {
		enabled: true,
		proxyType: getSelectedProxyType(),
		host: getMihomoHost(),
		port: 0,
		listenerName: portOption?.listenerName || '',
		source: portOption?.source || 'config',
		authUser: getSelectedAuthUser(),
	}
	const validation = buildProxyValidation(draft)
	state.proxyValidation = validation
	if (validation.ok) {
		draft.host = validation.host
		draft.port = validation.port
		draft.source = validation.source
		draft.listenerName = validation.listenerName
	} else {
		draft.host = getMihomoHost()
		draft.port = 0
		draft.source = draft.listenerName ? 'listener' : currentProfile.source || 'config'
	}
	return draft
}

function renderProxyAuthUsers() {
	const select = document.getElementById('proxy-auth-user')
	const currentUsername = state.proxyProfile?.authUser?.username || ''
	const users = [...state.proxyAuthUsers]
	if (currentUsername && !users.some(user => user.username === currentUsername)) {
		users.unshift({ username: currentUsername, password: state.proxyProfile?.authUser?.password || '' })
	}
	let html = '<option value="">不使用代理用户</option>'
	for (const user of users) {
		const selected = user.username === currentUsername ? ' selected' : ''
		html += `<option value="${escAttr(user.username)}"${selected}>${escHtml(user.username)}</option>`
	}
	select.innerHTML = html
}

function applyProxyProfileToForm() {
	const profile = state.proxyProfile || {
		proxyType: DEFAULT_PROXY_TYPE,
		listenerName: '',
		authUser: null,
	}
	const selectedPortOption = findProxyPortOption(state.proxyPortOptions, profile)
	renderProxyPortOptions(selectedPortOption?.id || '')
	renderProxyTypeOptions(profile.proxyType || DEFAULT_PROXY_TYPE)
	renderProxyAuthUsers()
	refreshProxyAuthUserAvailability(getSelectedProxyType())
	refreshProxyMeta()
}

async function refreshProxyControls() {
	try {
		const configs = await getMihomoConfigs(state.mihomo.url, state.mihomo.secret)
		let authUsers = []
		let listeners = []
		if (state.subMagic.url && state.subMagic.accessKey) {
			const [usersResult, listenersResult] = await Promise.allSettled([
				getProxyAuthUsers(state.subMagic.url, state.subMagic.accessKey),
				getListeners(state.subMagic.url, state.subMagic.accessKey),
			])
			if (usersResult.status === 'fulfilled' && Array.isArray(usersResult.value)) {
				authUsers = usersResult.value
			}
			if (listenersResult.status === 'fulfilled' && Array.isArray(listenersResult.value)) {
				listeners = listenersResult.value
			}
		}
		state.mihomoConfigs = configs || {}
		state.proxyAuthUsers = Array.isArray(authUsers) ? authUsers : []
		state.listeners = Array.isArray(listeners) ? listeners : []
		state.proxyPortOptions = buildAvailableProxyPortOptions(state.mihomoConfigs, state.listeners)
		refreshRuleTypeAvailability()
		if (!state.proxyProfile) {
			state.proxyProfile = {
				enabled: true,
				proxyType: DEFAULT_PROXY_TYPE,
				host: '',
				port: 0,
				listenerName: '',
				source: 'config',
				authUser: null,
			}
		}
		applyProxyProfileToForm()
		const nextProfile = {
			...buildProfileFromForm(),
			enabled: state.proxyProfile?.enabled !== false,
		}
		const needsBootstrap =
			(state.proxyProfile.enabled !== false) !== (nextProfile.enabled !== false) ||
			state.proxyProfile.proxyType !== nextProfile.proxyType ||
			state.proxyProfile.host !== nextProfile.host ||
			state.proxyProfile.port !== nextProfile.port ||
			state.proxyProfile.listenerName !== nextProfile.listenerName ||
			(state.proxyProfile.authUser?.username || '') !== (nextProfile.authUser?.username || '')
		state.proxyProfile = nextProfile
		if (needsBootstrap && nextProfile.enabled !== false) {
			await chrome.runtime.sendMessage({ type: 'PROXY_SET_STATE', tabId: state.tabId, profile: nextProfile })
		}
		refreshProxyMeta()
	} catch (error) {
		refreshProxyMeta({ ok: false, reason: `代理控制初始化失败: ${error.message}` })
	}
}

function refreshProxyForm() {
	renderProxyTypeOptions(getSelectedProxyType() || state.proxyProfile?.proxyType || DEFAULT_PROXY_TYPE)
	const proxyType = getSelectedProxyType()
	refreshProxyAuthUserAvailability(proxyType)
	refreshProxyMeta()
}

function getProfileSignature(profile) {
	return JSON.stringify({
		proxyType: profile?.proxyType || '',
		host: profile?.host || '',
		port: Number(profile?.port || 0),
		listenerName: profile?.listenerName || '',
		authUser: profile?.authUser?.username || '',
		source: profile?.source || '',
		enabled: profile?.enabled !== false,
	})
}

function isProxyProfileActive(profile) {
	return !!(profile && profile.host && Number(profile.port) > 0 && profile.enabled !== false)
}

function updateApplyButton(validation, draftProfile) {
	const button = document.getElementById('btn-apply-proxy')
	button.className = 'btn'

	if (!validation.ok) {
		button.disabled = true
		button.classList.add('btn-secondary')
		button.textContent = '不可用'
		return
	}

	button.disabled = false
	const currentActive = isProxyProfileActive(state.proxyProfile)
	const applied = getProfileSignature(state.proxyProfile) === getProfileSignature(draftProfile)
	if (applied) {
		button.classList.add('btn-warning')
		button.textContent = '关闭代理'
		return
	}

	button.classList.add('btn-success')
	button.textContent = currentActive ? '应用代理' : '启用代理'
}

function setProxyPanelCollapsed(collapsed) {
	state.proxyPanelCollapsed = !!collapsed
	const sectionEl = document.getElementById('proxy-section')
	const buttonEl = document.getElementById('btn-toggle-proxy-panel')
	if (!sectionEl || !buttonEl) return
	sectionEl.classList.toggle('is-collapsed', state.proxyPanelCollapsed)
	buttonEl.setAttribute('aria-expanded', state.proxyPanelCollapsed ? 'false' : 'true')
	buttonEl.title = state.proxyPanelCollapsed ? '展开代理控制' : '收起代理控制'
}

function syncProxyPanelCollapsed() {
	if (state.proxyPanelTouched) return
	setProxyPanelCollapsed(isProxyProfileActive(state.proxyProfile))
}

function toggleProxyPanel() {
	state.proxyPanelTouched = true
	setProxyPanelCollapsed(!state.proxyPanelCollapsed)
}

function refreshProxyMeta(overrideValidation = null) {
	const statusEl = document.getElementById('proxy-status')
	const metaEl = document.getElementById('proxy-meta')
	const draftProfile = {
		proxyType: getSelectedProxyType(),
		host: getMihomoHost(),
		port: 0,
		listenerName: getSelectedPortOption()?.listenerName || '',
		authUser: getSelectedAuthUser(),
	}
	const validation = overrideValidation || buildProxyValidation(draftProfile)

	if (!validation.ok) {
		statusEl.textContent = '不可用'
		statusEl.className = 'routing-status error'
		metaEl.innerHTML = `隔离模式: <strong>${state.proxyIsolation ? '按标签页' : '全局共享'}</strong><br>${escHtml(validation.reason)}`
		updateApplyButton(validation, draftProfile)
		syncProxyPanelCollapsed()
		return
	}

	draftProfile.port = validation.port
	draftProfile.host = validation.host
	draftProfile.listenerName = validation.listenerName
	draftProfile.source = validation.source
	statusEl.textContent = isProxyProfileActive(state.proxyProfile) ? '代理中' : '未代理'
	statusEl.className = 'routing-status connected'
	metaEl.innerHTML = `隔离模式: <strong>${state.proxyIsolation ? '按标签页' : '全局共享'}</strong><br>地址: <strong>${escHtml(validation.host)}:${validation.port}</strong>`
	updateApplyButton(validation, draftProfile)
	syncProxyPanelCollapsed()
}

async function handleApplyProxy() {
	if (!state.mihomo.url) {
		refreshProxyMeta({ ok: false, reason: '请先在设置中配置 Mihomo API。' })
		return
	}

	const draftProfile = buildProfileFromForm()
	if (!state.proxyValidation?.ok) {
		refreshProxyMeta()
		return
	}

	const applied = getProfileSignature(state.proxyProfile) === getProfileSignature({
		...draftProfile,
		port: state.proxyValidation.port,
		host: state.proxyValidation.host,
		listenerName: state.proxyValidation.listenerName,
		source: state.proxyValidation.source,
	})

	const profile = applied
		? {
			...draftProfile,
			enabled: false,
			host: '',
			port: 0,
			listenerName: '',
			source: 'config',
			authUser: null,
		}
		: {
			...draftProfile,
			enabled: true,
		}

	state.proxyProfile = profile
	const shouldPersist = !(applied && state.proxyIsolation)
	await chrome.runtime.sendMessage({ type: 'PROXY_SET_STATE', tabId: state.tabId, profile, persist: shouldPersist })
	refreshProxyMeta()
}

async function startRoutingPoll() {
	const statusEl = document.getElementById('routing-status')
	statusEl.textContent = '获取中...'
	statusEl.className = 'routing-status loading'

	await pollRouting()

	pollTimer = setInterval(async () => {
		await pollRouting()
	}, 2000)

	proxyRefreshTimer = setInterval(async () => {
		await refreshProxyData()
	}, 10000)
}

async function pollRouting() {
	const resp = await chrome.runtime.sendMessage({ type: 'POLL', tabId: state.tabId })
	handleBackgroundResponse(resp)
}

function handleBackgroundResponse(resp) {
	if (!resp) return
	if (resp.proxyGroups && state.proxyGroups.length === 0 && Object.keys(state.proxyProviders).length === 0) {
		state.proxyGroups = resp.proxyGroups
		populateProxyOptions()
	}
	if (resp.data) {
		updateRoutingDisplay(mergeRoutingData(resp.data))
	}
}

function buildRoutingGroupKey(group) {
	return JSON.stringify([
		group.kind || 'matched',
		group.host || '',
		group.destinationPort || '',
		group.rule || '',
		group.rulePayload || '',
		group.error || '',
	])
}

function getIpCheckState(group) {
	return state.ipCheckByGroupKey[buildRoutingGroupKey(group)] || null
}

function setIpCheckState(group, value) {
	const key = buildRoutingGroupKey(group)
	state.ipCheckByGroupKey[key] = value
	if (state.currentIpCheckKey === key && document.getElementById('ipcheck-section').style.display !== 'none') {
		renderIpCheckPanel(group)
	}
}

function getIpCheckButtonLabel(entry) {
	if (!entry) return 'IpCheck'
	if (entry.status === 'configuring') return '配置中...'
	if (entry.status === 'probing') return '检测中...'
	if (entry.status === 'error') return '重试'
	return '再测一次'
}

function renderIpCheckBlock(group) {
	const entry = getIpCheckState(group)
	const disabled = entry && (entry.status === 'configuring' || entry.status === 'probing') ? ' disabled' : ''
	return `<div class="ipcheck-actions"><button class="btn btn-secondary btn-ipcheck" data-route-key="${escAttr(buildRoutingGroupKey(group))}"${disabled}>${escHtml(getIpCheckButtonLabel(entry))}</button></div>`
}

function mergeRoutingData(data) {
	if (!data || typeof data !== 'object') return state.routingData
	const nextGroups = Array.isArray(data.groups) ? data.groups : []

	if (!state.routingData) {
		state.routingData = {
			...data,
			groups: nextGroups.map(group => ({ ...group })),
		}
		return state.routingData
	}

	const groupMap = new Map(
		(state.routingData.groups || []).map(group => [buildRoutingGroupKey(group), { ...group }])
	)
	for (const group of nextGroups) {
		groupMap.set(buildRoutingGroupKey(group), { ...group })
	}

	state.routingData = {
		...state.routingData,
		...data,
		total: Math.max(Number(state.routingData.total || 0), Number(data.total || 0)),
		issueTotal: Math.max(Number(state.routingData.issueTotal || 0), Number(data.issueTotal || 0)),
		groups: Array.from(groupMap.values()),
	}
	return state.routingData
}

function clearRoutingData() {
	state.routingData = null
}

function resetRoutingDisplay() {
	clearRoutingData()
	const resultEl = document.getElementById('routing-result')
	const statusEl = document.getElementById('routing-status')
	if (!resultEl || !statusEl) return
	statusEl.textContent = '获取中...'
	statusEl.className = 'routing-status loading'
	resultEl.innerHTML = '<div class="routing-empty">页面已重载，等待新流量...</div>'
}

function startTabReloadObserver() {
	if (observedTabUpdateHandler || !chrome.tabs?.onUpdated || state.tabId <= 0) return
	observedTabUpdateHandler = (tabId, changeInfo) => {
		if (tabId !== state.tabId) return
		if (changeInfo.status === 'loading') {
			resetRoutingDisplay()
		}
	}
	chrome.tabs.onUpdated.addListener(observedTabUpdateHandler)
}

async function refreshProxyData(initial = false) {
	if (!state.mihomo.url) return

	try {
		const [proxyMap, proxyProviders] = await Promise.all([
			getProxySnapshot(state.mihomo.url, state.mihomo.secret),
			getProxyProviders(state.mihomo.url, state.mihomo.secret),
		])

		state.proxyMap = proxyMap
		state.proxyProviders = proxyProviders
		state.proxyGroups = buildRuleProxyTargets(proxyProviders)
		populateProxyOptions()

		if (state.currentSelector && document.getElementById('selector-section').style.display !== 'none') {
			renderSelectorPanel(state.currentSelector)
		}
	} catch (error) {
		if (initial) {
			const statusEl = document.getElementById('routing-status')
			statusEl.textContent = `代理信息获取失败: ${error.message}`
			statusEl.className = 'routing-status error'
		}
	}
}

function buildRuleProxyTargets(proxyProviders) {
	return Object.entries(proxyProviders || {})
		.map(([providerName, provider]) => ({
			name: String(providerName || '').trim(),
			type: provider?.type || '',
			now: '',
			provider: '',
		}))
		.filter(group => !!group.name)
}

function populateProxyOptions() {
	const select = document.getElementById('rule-proxy-select')
	const currentValue = getProxyValue()
	let options = ''
	for (const group of state.proxyGroups) {
		options += `<option value="${escAttr(group.name)}">${escHtml(group.name)}</option>`
	}
	options += '<option value="DIRECT">DIRECT</option>'
	options += '<option value="REJECT">REJECT</option>'
	options += '<option value="REJECT-DROP">REJECT-DROP</option>'
	options += '<option value="__custom__">自定义...</option>'
	select.innerHTML = options
	setProxyValue(currentValue)
}

function getProxyValue() {
	const select = document.getElementById('rule-proxy-select')
	if (select.value === '__custom__') {
		return document.getElementById('rule-proxy-input').value.trim()
	}
	return select.value
}

function setProxyValue(value) {
	const select = document.getElementById('rule-proxy-select')
	const input = document.getElementById('rule-proxy-input')
	if (state.proxyGroups.some(group => group.name === value) || ['DIRECT', 'REJECT', 'REJECT-DROP'].includes(value)) {
		select.value = value
		input.style.display = 'none'
		input.value = ''
	} else if (value) {
		select.value = '__custom__'
		input.style.display = ''
		input.value = value
	} else {
		select.value = ''
		input.style.display = 'none'
		input.value = ''
	}
}

function updateRoutingDisplay(data) {
	const resultEl = document.getElementById('routing-result')
	const statusEl = document.getElementById('routing-status')
	const groups = Array.isArray(data.groups) ? data.groups : []
	const matchedGroups = groups.filter(group => !group.kind || group.kind === 'matched')
	const failedGroups = groups.filter(group => group.kind === 'failed')
	const unmatchedGroups = groups.filter(group => group.kind === 'unmatched')

	if (data.status === 'disconnected') {
		statusEl.textContent = '已断开，重连中...'
		statusEl.className = 'routing-status error'
		return
	}

	if (data.status === 'fetching') {
		statusEl.textContent = '获取中...'
		statusEl.className = 'routing-status loading'
		return
	}

	if (data.status === 'no_domain') {
		statusEl.textContent = '无法获取当前域名'
		statusEl.className = 'routing-status error'
		return
	}

	if (groups.length === 0) {
		statusEl.textContent = `监控中 · 命中 ${data.total || 0} 连接`
		statusEl.className = 'routing-status connected'
		if (!resultEl.innerHTML) {
			resultEl.innerHTML = '<div class="routing-empty">当前域名暂无链路或异常请求</div>'
		}
		return
	}

	const sharedCount = matchedGroups.filter(group => group.shared).length
	statusEl.textContent = `${failedGroups.length}异常/${unmatchedGroups.length}未命中/${sharedCount}共享/${Number(data.total || 0)}命中/${groups.length}组`
	statusEl.className = 'routing-status connected'

	let html = ''
	for (const group of groups) {
		const isIssue = group.kind === 'failed' || group.kind === 'unmatched'
		const ruleStr = group.rule ? formatRule(group.rule, group.rulePayload) : ''
		const chainHtml = isIssue ? renderIssueLine(group) : renderChain(group.chain, group)
		const sharedTag = group.shared ? '<span class="route-shared-tag" title="此连接可能与其他Tab共享">共享</span>' : ''
		const confidenceLabel = group.confidence === 'high' ? '高' : group.confidence === 'medium' ? '中' : '低'
		const confidenceTag = !isIssue
			? `<span class="route-confidence-tag ${group.confidence}" title="匹配置信度：${confidenceLabel}${group.portMatched ? '，端口一致' : ''}">${confidenceLabel}</span>`
			: ''
		const issueTag = group.kind === 'failed'
			? '<span class="route-issue-tag failed" title="浏览器请求已失败">失败</span>'
			: group.kind === 'unmatched'
				? '<span class="route-issue-tag unmatched" title="最近请求未匹配到活动链路">未匹配</span>'
				: ''
		const hostTitle = group.latestUrl || group.host
		const cardClass = isIssue ? `route-card issue ${group.kind}` : 'route-card'

		html += `<div class="${cardClass}">
			<div class="route-header">
				<span class="route-count">${group.count}</span>
				<span class="route-host" data-host="${escAttr(group.host)}" data-destination-ips="${escAttr((group.destinationIps || []).join(','))}" title="${escAttr(hostTitle)}">${escHtml(group.host)}${issueTag}${sharedTag}${confidenceTag}</span>
			</div>
			<div class="route-chain-line${isIssue ? ' issue' : ''}">${chainHtml}</div>`

		if (!isIssue && ruleStr) {
			html += `<div class="route-rule-line" data-rule="${escAttr(group.rule)}" data-rule-payload="${escAttr(group.rulePayload || '')}">${escHtml(ruleStr)}</div>`
		}

		if (!isIssue) {
			html += renderIpCheckBlock(group)
		}

		html += '</div>'
	}

	resultEl.innerHTML = html

	resultEl.querySelectorAll('.route-host').forEach(el => {
		el.addEventListener('click', () => {
			const destinationIps = String(el.getAttribute('data-destination-ips') || '')
				.split(',')
				.map(ip => ip.trim())
				.filter(Boolean)
			void showAddPanel(el.getAttribute('data-host') || '', destinationIps)
		})
	})

	resultEl.querySelectorAll('.route-rule-line').forEach(el => {
		const rule = el.getAttribute('data-rule') || ''
		if (rule) {
			const rulePayload = el.getAttribute('data-rule-payload') || ''
			el.addEventListener('click', () => handleEditRuleClick(rule, rulePayload))
		}
	})

	resultEl.querySelectorAll('.route-chain-selector').forEach(el => {
		el.addEventListener('click', () => openSelectorPanel(
			el.getAttribute('data-proxy') || '',
			el.getAttribute('data-route-key') || ''
		))
	})

	resultEl.querySelectorAll('.btn-ipcheck').forEach((el) => {
		el.addEventListener('click', () => {
			const routeKey = el.getAttribute('data-route-key') || ''
			const group = groups.find((item) => buildRoutingGroupKey(item) === routeKey)
			if (group) {
				openIpCheckPanel(group, `${group.host || 'IpCheck'} · ${resolveIpCheckTarget(group.chain) || '-'}`)
				void handleIpCheck(group)
			}
		})
	})
}

function renderChain(chain, group) {
	const items = Array.isArray(chain) && chain.length > 0 ? [...chain].reverse() : ['DIRECT']
	const routeKey = group ? buildRoutingGroupKey(group) : ''
	return items.map((item) => renderChainToken(item, routeKey)).join(' <span class="route-chain-token">→</span> ')
}

function resolveIpCheckTarget(chain) {
	const items = Array.isArray(chain) ? chain.map((item) => String(item || '').trim()).filter(Boolean) : []
	return String(items[0] || '').trim()
}

function openIpCheckPanel(group, title = '') {
	const routeKey = buildRoutingGroupKey(group)
	state.currentIpCheckKey = routeKey
	document.getElementById('routing-section').style.display = 'none'
	document.getElementById('rule-section').style.display = 'none'
	document.getElementById('selector-section').style.display = 'none'
	document.getElementById('ipcheck-section').style.display = ''
	document.getElementById('ipcheck-panel-title').textContent = title || group.host || 'IpCheck'
	renderIpCheckPanel(group)
}

function renderIpCheckPanel(group) {
	const entry = getIpCheckState(group)
	const metaEl = document.getElementById('ipcheck-meta')
	const resultEl = document.getElementById('ipcheck-result')
	const targetGroup = resolveIpCheckTarget(group.chain)
	const chainText = Array.isArray(group.chain) && group.chain.length > 0 ? [...group.chain].reverse().join(' -> ') : 'DIRECT'

	metaEl.innerHTML = `目标域名: <strong>${escHtml(group.host || '-')}</strong><br>目标代理: <strong>${escHtml(targetGroup || '-')}</strong><br>当前链路: <strong>${escHtml(chainText)}</strong>`

	if (!entry) {
		resultEl.innerHTML = '<div class="selector-empty">准备开始检测...</div>'
		return
	}

	if (entry.status === 'configuring' || entry.status === 'probing') {
		resultEl.innerHTML = `<div class="ipcheck-result">${escHtml(entry.message || '处理中...')}</div>`
		return
	}

	if (entry.status === 'error') {
		resultEl.innerHTML = `<div class="ipcheck-result error">${escHtml(entry.message || '检测失败')}</div>`
		return
	}

	const tags = Array.isArray(entry.tags) && entry.tags.length > 0 ? entry.tags.join(' / ') : '无'
	const location = [entry.countryCode || entry.country, entry.city].filter(Boolean).join(' ')
	const details = entry.details || {}
	const services = entry.services || {}
	const references = entry.references || {}
	const uncoveredRedirectDomains = getIpCheckUncoveredRedirectDomains(entry)
	const mapRows = (rows) => rows.map(([label, value]) => {
		const content = value && typeof value === 'object' && 'html' in value
			? value.html
			: `<strong>${escHtml(value || '-')}</strong>`
		return `<div class="ipcheck-row"><span>${escHtml(label)}</span>${content}</div>`
	}).join('')
	const renderMatrix = (columns, rows) => `
		<div class="ipcheck-matrix">
			<div class="ipcheck-matrix-row header" style="grid-template-columns: 88px repeat(${columns.length}, minmax(0, 1fr));">
				<div class="ipcheck-matrix-cell label"></div>
				${columns.map((column) => `<div class="ipcheck-matrix-cell">${escHtml(column)}</div>`).join('')}
			</div>
			${rows.map((row) => `
				<div class="ipcheck-matrix-row" style="grid-template-columns: 88px repeat(${columns.length}, minmax(0, 1fr));">
					<div class="ipcheck-matrix-cell label">${escHtml(row.label)}</div>
					${row.values.map((value) => `<div class="ipcheck-matrix-cell">${escHtml(value || '-')}</div>`).join('')}
				</div>
			`).join('')}
		</div>
	`
	const formatServiceStatus = (service) => {
		if (!service) return '未知'
		const label = service.status === 'available'
			? '可用'
			: service.status === 'blocked'
				? '不可用'
				: '待确认'
		return `${label}${service.detail ? ` · ${service.detail}` : ''}`
	}
	const buildReferenceValue = (source, values) => {
		if (!source) return '不可用'
		return values.map((value) => source[value]).filter(Boolean).join(' / ') || '无'
	}
	const formatCoordinates = (latitude, longitude) => {
		const parts = [latitude, longitude]
			.map((value) => String(value || '').trim())
			.filter(Boolean)
		return parts.length === 2 ? parts.join(', ') : ''
	}
	const formatAsnValue = (value) => {
		const text = String(value || '').trim()
		if (!text) return ''
		return /^AS/i.test(text) ? text : `AS${text}`
	}
	const formatBooleanBadge = (value) => value === true ? '是' : value === false ? '否' : '无'
	const coordinateParts = [details.latitude, details.longitude]
		.map((value) => String(value || '').trim())
		.filter(Boolean)
	const coordinateText = coordinateParts.length === 2 ? coordinateParts.join(', ') : ''
	const coordinateLink = coordinateParts.length === 2
		? {
			html: `<strong><a class="ipcheck-link" href="https://www.google.com/maps?q=${encodeURIComponent(coordinateParts.join(','))}" target="_blank" rel="noopener noreferrer">${escHtml(coordinateText)}</a></strong>`,
		}
		: '-'
	const ping0Link = entry.ip
		? {
			html: `<strong><a class="ipcheck-link" href="https://www.ping0.cc/ip/${encodeURIComponent(entry.ip)}" target="_blank" rel="noopener noreferrer">https://www.ping0.cc/ip/${escHtml(entry.ip)}</a></strong>`,
		}
		: '-'
	const yesNoUnknown = (value) => value === true ? '是' : value === false ? '否' : '无'
	const quality = entry.raw?.quality || {}
	const geo = entry.raw?.geo || {}
	const qualitySecurity = entry.raw?.quality?.security || {}
	const qualityCompany = entry.raw?.quality?.company || {}
	const geographyMatrix = renderMatrix(
		['ipapi.is', 'ip.sb', 'IPinfo', 'ipapi.co', 'DB-IP'],
		[
			{
				label: 'IP',
				values: [
					quality?.ip || '无',
					geo?.ip || '无',
					references.ipinfo?.ip || '无',
					references.ipapiCo?.ip || '无',
					references.dbIp?.ip || '无',
				],
			},
			{
				label: '地区',
				values: [
					quality?.location?.country_code || quality?.location?.country || '无',
					geo?.country_code || geo?.country || '无',
					references.ipinfo?.country || '无',
					references.ipapiCo?.country || '无',
					references.dbIp?.country || '无',
				],
			},
			{
				label: '区域',
				values: [
					quality?.location?.state || quality?.location?.region || '无',
					geo?.region || '无',
					references.ipinfo?.region || '无',
					references.ipapiCo?.region || '无',
					references.dbIp?.region || '无',
				],
			},
			{
				label: '城市',
				values: [
					quality?.location?.city || '无',
					geo?.city || '无',
					references.ipinfo?.city || '无',
					references.ipapiCo?.city || '无',
					references.dbIp?.city || '无',
				],
			},
			{
				label: '邮编',
				values: [
					quality?.location?.zip || quality?.location?.postal_code || '无',
					'无',
					references.ipinfo?.postal || '无',
					references.ipapiCo?.postal || '无',
					'无',
				],
			},
			{
				label: '时区',
				values: [
					quality?.location?.timezone || '无',
					geo?.timezone || '无',
					references.ipinfo?.timezone || '无',
					references.ipapiCo?.timezone || '无',
					'无',
				],
			},
			{
				label: '坐标',
				values: [
					formatCoordinates(quality?.location?.latitude, quality?.location?.longitude) || '无',
					formatCoordinates(geo?.latitude, geo?.longitude) || '无',
					references.ipinfo?.loc || '无',
					formatCoordinates(references.ipapiCo?.latitude, references.ipapiCo?.longitude) || '无',
					formatCoordinates(references.dbIp?.latitude, references.dbIp?.longitude) || '无',
				],
			},
			{
				label: 'ASN',
				values: [
					formatAsnValue(qualityCompany?.asn) || '无',
					formatAsnValue(geo?.asn) || '无',
					'无',
					formatAsnValue(references.ipapiCo?.asn) || '无',
					'无',
				],
			},
			{
				label: '组织',
				values: [
					qualityCompany?.name || '无',
					geo?.asn_organization || geo?.organization || geo?.isp || '无',
					references.ipinfo?.org || '无',
					references.ipapiCo?.org || '无',
					references.dbIp?.isp || '无',
				],
			},
		]
	)
	const riskMatrix = renderMatrix(
		['ipapi.is', 'IPinfo', 'ipapi.co', 'DB-IP'],
		[
			{
				label: '地区',
				values: [
					entry.countryCode || entry.country || '无',
					references.ipinfo?.country || '无',
					references.ipapiCo?.country || '无',
					references.dbIp?.country || '无',
				],
			},
			{
				label: '代理',
				values: [
					details.proxy || '无',
					yesNoUnknown(references.ipinfo?.privacy?.proxy),
					'无',
					'无',
				],
			},
			{
				label: 'Tor',
				values: [
					details.tor || '无',
					yesNoUnknown(references.ipinfo?.privacy?.tor),
					'无',
					'无',
				],
			},
			{
				label: 'VPN',
				values: [
					details.vpn || '无',
					yesNoUnknown(references.ipinfo?.privacy?.vpn),
					'无',
					'无',
				],
			},
			{
				label: '服务器',
				values: [
					details.datacenter || '无',
					yesNoUnknown(references.ipinfo?.privacy?.hosting),
					'无',
					'无',
				],
			},
			{
				label: '移动网络',
				values: [
					details.mobile || '无',
					yesNoUnknown(references.ipinfo?.privacy?.mobile),
					'无',
					'无',
				],
			},
			{
				label: 'Crawler',
				values: [
					details.crawler || '无',
					'无',
					'无',
					'无',
				],
			},
		]
	)
	const typeMatrix = renderMatrix(
		['ipapi.is', 'IPinfo', 'ipapi.co', 'DB-IP'],
		[
			{
				label: '使用类型',
				values: [
					details.usageType || '其他',
					references.ipinfo?.company?.type || '其他',
					'其他',
					'其他',
				],
			},
			{
				label: '公司类型',
				values: [
					qualityCompany?.type || '其他',
					references.ipinfo?.company?.type || '其他',
					'其他',
					'其他',
				],
			},
			{
				label: '风险分数',
				values: [
					details.fraudScore || '无',
					'无',
					'无',
					'无',
				],
			},
			{
				label: '隐私类型',
				values: [
					qualitySecurity?.type || details.networkType || '无',
					[
						references.ipinfo?.privacy?.proxy ? 'proxy' : '',
						references.ipinfo?.privacy?.vpn ? 'vpn' : '',
						references.ipinfo?.privacy?.tor ? 'tor' : '',
						references.ipinfo?.privacy?.hosting ? 'hosting' : '',
					].filter(Boolean).join('/') || '无',
					'residential/unknown',
					'无',
				],
			},
		]
	)
	resultEl.innerHTML = `
		<div class="ipcheck-result success">
			${uncoveredRedirectDomains.length > 0 ? `
				<div class="ipcheck-group">
					<div class="ipcheck-group-title">重定向规则补齐</div>
					<div class="ipcheck-redirect-note">以下重定向后的域名未被当前 IpCheck 规则覆盖：</div>
					<div class="ipcheck-redirect-list">${uncoveredRedirectDomains.map((domain) => `<code>${escHtml(domain)}</code>`).join('')}</div>
					<div class="ipcheck-redirect-actions">
						<button class="btn btn-secondary btn-ipcheck-retry-redirect" data-route-key="${escAttr(buildRoutingGroupKey(group))}">添加规则并重试</button>
					</div>
				</div>
			` : ''}
			<div class="ipcheck-group">
				<div class="ipcheck-group-title">基础信息</div>
				${mapRows([
					['IP', entry.ip || '-'],
					['地区', location || '未知'],
					['坐标', coordinateLink],
					['邮编', details.postal || '-'],
					['时区', details.timezone || '-'],
				])}
			</div>
			<div class="ipcheck-group">
				<div class="ipcheck-group-title">网络质量</div>
				${mapRows([
					['风险', entry.risk || '未知'],
					['标签', tags],
					['网络类型', details.networkType || '-'],
					['Fraud Score', details.fraudScore || '-'],
					['近期滥用', details.abuseRecent || '-'],
					['滥用频率', details.abuseVelocity || '-'],
				])}
			</div>
			<div class="ipcheck-group">
				<div class="ipcheck-group-title">身份判定</div>
				${mapRows([
					['Proxy', details.proxy || '-'],
					['VPN', details.vpn || '-'],
					['Tor', details.tor || '-'],
					['机房', details.datacenter || '-'],
					['移动网络', details.mobile || '-'],
					['Crawler', details.crawler || '-'],
				])}
			</div>
			<div class="ipcheck-group">
				<div class="ipcheck-group-title">ASN / 运营商</div>
				${mapRows([
					['ASN', entry.asn ? `AS${entry.asn}` : '-'],
					['运营商', entry.isp || '-'],
					['组织', details.asnOrg || '-'],
					['域名', details.asnDomain || '-'],
					['路由', details.asnRoute || '-'],
					['用途', details.usageType || '-'],
				])}
			</div>
			<div class="ipcheck-group">
				<div class="ipcheck-group-title">多源地理对照</div>
				${geographyMatrix}
			</div>
			<div class="ipcheck-group">
				<div class="ipcheck-group-title">附加画像</div>
				${mapRows([
					['IPinfo', buildReferenceValue(references.ipinfo, ['country', 'region', 'city', 'org'])],
					['ipapi.co', buildReferenceValue(references.ipapiCo, ['country', 'region', 'city', 'org'])],
					['DB-IP', buildReferenceValue(references.dbIp, ['country', 'region', 'city'])],
					['Ping0 页面', ping0Link],
					['欧盟区域', formatBooleanBadge(references.ipapiCo?.inEu)],
					['国家面积', references.ipapiCo?.countryArea ? `${references.ipapiCo.countryArea}` : '-'],
					['国家人口', references.ipapiCo?.countryPopulation ? `${references.ipapiCo.countryPopulation}` : '-'],
					['地图', (() => {
						const loc = formatCoordinates(references.ipapiCo?.latitude, references.ipapiCo?.longitude) || references.ipinfo?.loc || ''
						return loc ? `https://www.google.com/maps?q=${loc}` : '-'
					})()],
				])}
			</div>
			<div class="ipcheck-group">
				<div class="ipcheck-group-title">类型对照矩阵</div>
				${typeMatrix}
			</div>
			<div class="ipcheck-group">
				<div class="ipcheck-group-title">风险因子矩阵</div>
				${riskMatrix}
			</div>
			<div class="ipcheck-group">
				<div class="ipcheck-group-title">AI 服务</div>
				${mapRows([
					['ChatGPT', formatServiceStatus(services.chatgpt)],
					['OpenAI', formatServiceStatus(services.openai)],
					['Claude', formatServiceStatus(services.claude)],
					['Gemini', formatServiceStatus(services.gemini)],
				])}
			</div>
			<div class="ipcheck-group">
				<div class="ipcheck-group-title">流媒体</div>
				${mapRows([
					['YouTube Premium', formatServiceStatus(services.youtubePremium)],
					['Netflix', formatServiceStatus(services.netflix)],
					['Disney+', formatServiceStatus(services.disneyPlus)],
					['Prime Video', formatServiceStatus(services.primeVideo)],
				])}
			</div>
			<details class="ipcheck-raw">
				<summary>原始返回</summary>
				<pre>${escHtml(JSON.stringify(entry.raw || {}, null, 2))}</pre>
			</details>
		</div>
	`
}

function getKnownIpCheckDomains() {
	return Array.isArray(state.ipCheckKnownDomains) && state.ipCheckKnownDomains.length > 0
		? state.ipCheckKnownDomains
		: IPCHECK_RULE_DOMAINS
}

function isIpCheckDomainCovered(hostname, domains = getKnownIpCheckDomains()) {
	const host = String(hostname || '').trim().toLowerCase()
	if (!host) return false
	return domains.some((domain) => {
		const normalized = String(domain || '').trim().toLowerCase()
		return normalized && (host === normalized || host.endsWith(`.${normalized}`))
	})
}

function getIpCheckUncoveredRedirectDomains(entry) {
	const rawServices = entry?.raw?.services || {}
	const domains = Object.values(rawServices)
		.map((item) => {
			const url = String(item?.url || '').trim()
			if (!url) return ''
			try {
				return new URL(url).hostname
			} catch {
				return ''
			}
		})
		.filter(Boolean)
	return [...new Set(domains.filter((domain) => !isIpCheckDomainCovered(domain)))]
}

function getIpCheckBaseProfile() {
	const draftProfile = {
		proxyType: getSelectedProxyType() || state.proxyProfile?.proxyType || DEFAULT_PROXY_TYPE,
		host: getMihomoHost(),
		port: 0,
		listenerName: getSelectedPortOption()?.listenerName || state.proxyProfile?.listenerName || '',
		source: getSelectedPortOption()?.source || state.proxyProfile?.source || 'config',
		authUser: { username: IPCHECK_USERNAME, password: IPCHECK_DEFAULT_PASSWORD },
	}
	const validation = buildProxyValidation(draftProfile)
	if (!validation.ok) {
		throw new Error(validation.reason)
	}
	return {
		...draftProfile,
		enabled: true,
		host: validation.host,
		port: validation.port,
		listenerName: validation.listenerName,
		source: validation.source,
	}
}

async function resolveIpCheckPassword() {
	if (!state.mihomo.url) return IPCHECK_DEFAULT_PASSWORD
	try {
		const configs = (await getMihomoConfigs(state.mihomo.url, state.mihomo.secret)) || {}
		const entries = Array.isArray(configs.authentication) ? configs.authentication : []
		for (const entry of entries) {
			if (typeof entry !== 'string') continue
			const separatorIndex = entry.indexOf(':')
			if (separatorIndex === -1) continue
			const username = entry.slice(0, separatorIndex).trim()
			if (username !== IPCHECK_USERNAME) continue
			return entry.slice(separatorIndex + 1) || IPCHECK_DEFAULT_PASSWORD
		}
	} catch {}
	return IPCHECK_DEFAULT_PASSWORD
}

async function ensureIpCheckConfig(targetGroup, password, extraDomains = []) {
	const messages = []
	const remoteEnabled = !!(state.subMagic.url && state.subMagic.accessKey)
	const mergedDomains = [...new Set([
		...getKnownIpCheckDomains(),
		...extraDomains.map((item) => String(item || '').trim()).filter(Boolean),
	])]
	state.ipCheckKnownDomains = mergedDomains

	if (remoteEnabled) {
		try {
			const remoteResult = await ensureIpCheckRemoteConfig(state.subMagic.url, state.subMagic.accessKey, {
				targetGroup,
				username: IPCHECK_USERNAME,
				password,
				groupName: IPCHECK_GROUP_NAME,
				domains: mergedDomains,
			})
			if (remoteResult.changed) {
				messages.push('远程配置已补齐')
			}
			password = remoteResult.authUser?.password || password
		} catch (error) {
			messages.push(`远程持久化失败: ${error.message}`)
		}
	}

	const localResult = await ensureIpCheckLocalConfig(state.mihomo.url, state.mihomo.secret, {
		targetGroup,
		username: IPCHECK_USERNAME,
		password,
		groupName: IPCHECK_GROUP_NAME,
		domains: mergedDomains,
	})
	password = localResult.authUser?.password || password
	if (localResult.changed) {
		messages.push('本地配置已补齐')
	}

	return {
		authUser: { username: IPCHECK_USERNAME, password },
		messages,
	}
}

async function handleIpCheck(group, options = {}) {
	const targetGroup = resolveIpCheckTarget(group.chain)
	if (!targetGroup || targetGroup === 'DIRECT') {
		setIpCheckState(group, { status: 'error', message: '当前链路没有可检测的代理组' })
		updateRoutingDisplay(state.routingData || { groups: [] })
		return
	}
	if (!state.mihomo.url) {
		setIpCheckState(group, { status: 'error', message: '请先配置 Mihomo API' })
		updateRoutingDisplay(state.routingData || { groups: [] })
		return
	}

	try {
		const baseProfile = getIpCheckBaseProfile()
		setIpCheckState(group, { status: 'configuring', message: `准备 ${targetGroup} 的 IpCheck 配置...` })
		updateRoutingDisplay(state.routingData || { groups: [] })

		const ipCheckPassword = await resolveIpCheckPassword()
		const ensured = await ensureIpCheckConfig(targetGroup, ipCheckPassword, options.extraDomains || [])
		await setProxySelector(state.mihomo.url, state.mihomo.secret, IPCHECK_GROUP_NAME, targetGroup)
		await refreshProxyData()

		setIpCheckState(group, {
			status: 'probing',
			message: ensured.messages.length > 0 ? `${ensured.messages.join('；')}，开始检测...` : '开始检测...',
		})
		updateRoutingDisplay(state.routingData || { groups: [] })

		const result = await chrome.runtime.sendMessage({
			type: 'IPCHECK_PROBE',
			profile: baseProfile,
			authUser: ensured.authUser,
		})

		if (!result?.ok) {
			throw new Error(result?.error || 'IP 检测失败')
		}

		setIpCheckState(group, {
			status: 'success',
			...result,
			targetGroup,
		})
		updateRoutingDisplay(state.routingData || { groups: [] })
	} catch (error) {
		setIpCheckState(group, { status: 'error', message: error.message || 'IP 检测失败' })
		updateRoutingDisplay(state.routingData || { groups: [] })
	}
}

async function handleIpCheckResultClick(event) {
	const button = event.target.closest('.btn-ipcheck-retry-redirect')
	if (!button) return
	const routeKey = String(button.dataset.routeKey || '').trim()
	if (!routeKey) return
	const groups = Array.isArray(state.routingData?.groups) ? state.routingData.groups : []
	const group = groups.find((item) => buildRoutingGroupKey(item) === routeKey)
	if (!group) return
	const entry = getIpCheckState(group)
	const extraDomains = getIpCheckUncoveredRedirectDomains(entry)
	if (extraDomains.length === 0) return
	button.disabled = true
	await handleIpCheck(group, { extraDomains })
}

function renderIssueLine(group) {
	if (group.kind === 'failed') {
		return `<span class="route-chain-token">${escHtml(formatRequestError(group.error) || '请求失败')}</span>`
	}
	const port = group.destinationPort ? `:${group.destinationPort}` : ''
	return `<span class="route-chain-token">未匹配到活动链路${escHtml(port)}</span>`
}

function formatRequestError(error) {
	const value = String(error || '').trim()
	if (!value) return ''
	return value.replace(/^net::/i, '')
}

function renderChainToken(name, routeKey = '') {
	const proxy = state.proxyMap[name]
	if (proxy?.type === 'Selector') {
		return `<button class="route-chain-token route-chain-selector" data-proxy="${escAttr(name)}" data-route-key="${escAttr(routeKey)}" title="点击选择 ${escAttr(name)} 的下游链路">${escHtml(name)}</button>`
	}
	return `<span class="route-chain-token">${escHtml(name)}</span>`
}

function showRoutingPanel() {
	document.getElementById('routing-section').style.display = state.mihomo.url ? '' : 'none'
	document.getElementById('rule-section').style.display = 'none'
	document.getElementById('selector-section').style.display = 'none'
	document.getElementById('ipcheck-section').style.display = 'none'
	state.ruleMode = null
	state.editingRule = null
	state.currentSelector = ''
	state.currentSelectorRouteKey = ''
	state.currentIpCheckKey = ''
}

async function returnToRoutingAndReloadTab() {
	showRoutingPanel()
	resetRoutingDisplay()
	if (state.tabId > 0 && chrome.tabs?.reload) {
		await chrome.tabs.reload(state.tabId)
	}
}

function normalizeConnectionIdList(values) {
	return [...new Set((Array.isArray(values) ? values : [])
		.map((value) => String(value || '').trim())
		.filter(Boolean))]
}

function collectConnectionIdsForGroups(groups) {
	return normalizeConnectionIdList(
		(groups || []).flatMap((group) => Array.isArray(group?.connectionIds) ? group.connectionIds : [])
	)
}

function matchesRuleDescriptor(group, descriptor) {
	if (!descriptor?.type) return false
	const groupType = String(group?.rule || '').trim().toUpperCase()
	if (groupType !== descriptor.type) return false
	if (descriptor.type === 'MATCH') return true
	return String(group?.rulePayload || '').trim() === String(descriptor.payload || '').trim()
}

function collectAffectedConnectionIdsForRuleChange(oldRule = '', newRule = '') {
	const groups = Array.isArray(state.routingData?.groups) ? state.routingData.groups : []
	if (groups.length === 0) return []

	const oldDescriptor = parseRuleDisplay(oldRule)
	const newDescriptor = parseRuleDisplay(newRule)
	const targetHost = normalizeRuleHost(state.ruleGeoContext?.host || state.domain || '')

	const matchedGroups = groups.filter((group) => {
		if (group?.kind && group.kind !== 'matched') return false
		if (matchesRuleDescriptor(group, oldDescriptor) || matchesRuleDescriptor(group, newDescriptor)) {
			return true
		}
		const groupHost = normalizeRuleHost(group?.host || '')
		return !!targetHost && groupHost === targetHost
	})

	return collectConnectionIdsForGroups(matchedGroups)
}

async function closeConnectionsByIds(connectionIds) {
	const ids = normalizeConnectionIdList(connectionIds)
	if (ids.length === 0) return { total: 0, closed: 0, failed: 0 }

	const results = await Promise.allSettled(
		ids.map((connectionId) => closeConnection(state.mihomo.url, state.mihomo.secret, connectionId))
	)

	return {
		total: ids.length,
		closed: results.filter((result) => result.status === 'fulfilled').length,
		failed: results.filter((result) => result.status === 'rejected').length,
	}
}

async function showAddPanel(domain, destinationIps = []) {
	debugRuleEdit('showAddPanel', { domain, destinationIps, fallbackDomain: state.domain })
	document.getElementById('routing-section').style.display = 'none'
	document.getElementById('selector-section').style.display = 'none'
	document.getElementById('ipcheck-section').style.display = 'none'
	document.getElementById('rule-section').style.display = ''
	document.getElementById('rule-panel-title').textContent = '添加规则'
	document.getElementById('btn-group-add').style.display = ''
	document.getElementById('btn-group-edit').style.display = 'none'
	state.ruleMode = 'add'
	state.editingRule = null
	state.ruleGeoContext = {
		host: normalizeRuleHost(domain || state.domain || ''),
		destinationIps: normalizeDestinationIps(destinationIps),
	}
	clearRuleResult()

	refreshRuleTypeAvailability()
	document.getElementById('rule-type').value = 'DOMAIN-SUFFIX'
	document.getElementById('rule-no-resolve').checked = false
	setProxyValue('')
	await refreshRulePriorityOptions()

	onRuleTypeChange()
	setRulePayloadValue(domain || state.domain || '')
	await refreshGeoSuggestions()
}

async function showEditPanel(ruleStr) {
	debugRuleEdit('showEditPanel:start', { ruleStr })
	document.getElementById('routing-section').style.display = 'none'
	document.getElementById('selector-section').style.display = 'none'
	document.getElementById('ipcheck-section').style.display = 'none'
	document.getElementById('rule-section').style.display = ''
	document.getElementById('rule-panel-title').textContent = '修改规则'
	document.getElementById('btn-group-add').style.display = 'none'
	document.getElementById('btn-group-edit').style.display = ''
	state.ruleMode = 'edit'
	state.editingRule = ruleStr
	const info = parseRuleDisplay(ruleStr)
	state.ruleGeoContext = {
		host: normalizeRuleHost(info.payload || ''),
		destinationIps: [],
	}
	clearRuleResult()

	debugRuleEdit('showEditPanel:parsed', { ruleStr, info })
	refreshRuleTypeAvailability(info.type || 'DOMAIN-SUFFIX')
	document.getElementById('rule-type').value = info.type || 'DOMAIN-SUFFIX'
	document.getElementById('rule-no-resolve').checked = !!info.noResolve
	setProxyValue(info.target)
	await refreshRulePriorityOptions(ruleStr)

	onRuleTypeChange()
	setRulePayloadValue(info.payload || '')
	await refreshGeoSuggestions()
	debugRuleEdit('showEditPanel:applied', {
		selectedType: document.getElementById('rule-type').value,
		selectedPayload: getRulePayloadValue(),
		selectedProxy: getProxyValue(),
	})
}

async function openSelectorPanel(proxyName, routeKey = '') {
	if (!proxyName) return

	state.currentSelector = proxyName
	state.currentSelectorRouteKey = routeKey
	document.getElementById('routing-section').style.display = 'none'
	document.getElementById('rule-section').style.display = 'none'
	document.getElementById('ipcheck-section').style.display = 'none'
	document.getElementById('selector-section').style.display = ''
	document.getElementById('selector-panel-title').textContent = proxyName
	document.getElementById('selector-meta').innerHTML = '<span class="spinner"></span>加载链路中...'
	document.getElementById('selector-result').innerHTML = ''

	try {
		await refreshProxyData()
		renderSelectorPanel(proxyName)
	} catch (error) {
		document.getElementById('selector-meta').textContent = `加载失败: ${error.message}`
		document.getElementById('selector-result').innerHTML = ''
	}
}

function renderSelectorPanel(proxyName) {
	const proxy = state.proxyMap[proxyName]
	const metaEl = document.getElementById('selector-meta')
	const resultEl = document.getElementById('selector-result')

	if (!proxy) {
		metaEl.textContent = '未找到代理组信息'
		resultEl.innerHTML = ''
		return
	}

	const providerEntry = state.proxyProviders[proxyName]
	const providerProxies = Array.isArray(providerEntry?.proxies) ? providerEntry.proxies : []
	const providerByName = new Map(providerProxies.map(item => [item.name, item]))
	const candidateNames = Array.isArray(proxy.all)
		? proxy.all
		: providerProxies.map(item => item.name)

	metaEl.innerHTML = `类型: <strong>${escHtml(proxy.type || '-')}</strong><br>当前选择: <strong>${escHtml(proxy.now || '-')}</strong>`

	if (candidateNames.length === 0) {
		resultEl.innerHTML = '<div class="selector-empty">该代理组没有可选下游链路</div>'
		return
	}

	let html = ''
	for (const name of candidateNames) {
		const candidate = providerByName.get(name) || state.proxyMap[name] || { name }
		const isCurrent = proxy.now === name
		const delayInfo = resolveProxyDelay(name)
		const latencyTone = getLatencyTone(delayInfo?.delay)
		const latencyText = formatLatency(delayInfo?.delay)
		const delaySource = delayInfo?.sourceName && delayInfo.sourceName !== name
			? `当前出口: ${delayInfo.sourceName}`
			: candidate.type || state.proxyMap[name]?.type || 'Unknown'

		html += `<button class="selector-item${isCurrent ? ' is-current' : ''}" data-proxy="${escAttr(proxyName)}" data-target="${escAttr(name)}"${isCurrent ? ' disabled' : ''}>
			<div class="selector-main">
				<div class="selector-name">${escHtml(name)}</div>
				<div class="selector-sub">${escHtml(delaySource)}</div>
			</div>
			<div class="selector-latency ${latencyTone}">${escHtml(latencyText)}</div>
		</button>`
	}

	resultEl.innerHTML = html
}

async function handleSelectorResultClick(event) {
	const button = event.target.closest('.selector-item')
	if (!button || button.disabled) return

	const proxyName = button.getAttribute('data-proxy') || ''
	const targetName = button.getAttribute('data-target') || ''
	if (!proxyName || !targetName) return

	const metaEl = document.getElementById('selector-meta')
	metaEl.innerHTML = '<span class="spinner"></span>切换链路中...'

	try {
		await setProxySelector(state.mihomo.url, state.mihomo.secret, proxyName, targetName)
		const currentGroup = (state.routingData?.groups || []).find(
			(item) => buildRoutingGroupKey(item) === state.currentSelectorRouteKey
		)
		const connectionIds = Array.isArray(currentGroup?.connectionIds) ? currentGroup.connectionIds : []
		const closeSummary = await closeConnectionsByIds(connectionIds)
		await refreshProxyData()
		renderSelectorPanel(proxyName)
		const proxy = state.proxyMap[proxyName]
		const closeMessage = connectionIds.length > 0
			? closeSummary.failed > 0
				? `已关闭 ${closeSummary.closed}/${closeSummary.total} 条现有连接`
				: `已关闭 ${closeSummary.closed} 条现有连接`
			: '未找到可关闭的现有连接'
		metaEl.innerHTML = `类型: <strong>${escHtml(proxy?.type || '-')}</strong><br>当前选择: <strong>${escHtml(proxy?.now || targetName)}</strong><br>已切换成功<br>${escHtml(closeMessage)}`
		await returnToRoutingAndReloadTab()
	} catch (error) {
		metaEl.textContent = `切换失败: ${error.message}`
	}
}

function resolveProxyDelay(proxyName, visited = new Set()) {
	if (!proxyName || visited.has(proxyName)) return null
	visited.add(proxyName)

	const proxy = state.proxyMap[proxyName]
	if (!proxy) return null

	const directDelay = extractLatestDelay(proxy)
	if (directDelay !== null) {
		return { delay: directDelay, sourceName: proxyName }
	}

	if (proxy.now && proxy.now !== proxyName) {
		return resolveProxyDelay(proxy.now, visited)
	}

	return null
}

function extractLatestDelay(proxy) {
	const delay = extractDelayFromHistory(proxy?.history)
	if (delay !== null) return delay

	for (const value of Object.values(proxy?.extra || {})) {
		const extraDelay = extractDelayFromHistory(value?.history)
		if (extraDelay !== null) return extraDelay
	}

	return null
}

function extractDelayFromHistory(history) {
	if (!Array.isArray(history)) return null
	for (let i = history.length - 1; i >= 0; i--) {
		const delay = history[i]?.delay
		if (typeof delay === 'number' && delay >= 0) {
			return delay
		}
	}
	return null
}

function getLatencyTone(delay) {
	if (typeof delay !== 'number') return 'unknown'
	if (delay <= 150) return 'good'
	if (delay <= 300) return 'ok'
	if (delay <= 600) return 'warn'
	return 'bad'
}

function formatLatency(delay) {
	if (typeof delay !== 'number') return '未知'
	return `${delay} ms`
}

function clearRuleResult() {
	const resultEl = document.getElementById('rule-result')
	resultEl.textContent = ''
	resultEl.className = 'result-box'
}

function debugRuleEdit(stage, payload) {
	try {
		console.log('[Sub Magic][Rule Edit]', stage, payload)
	} catch {}
}

async function refreshRulePriorityOptions(currentRule = '') {
	const select = document.getElementById('rule-priority-select')
	const hint = document.getElementById('rule-priority-hint')
	const resultEl = document.getElementById('rule-result')

	if (!state.mihomo.url) {
		state.localRules = []
		select.innerHTML = '<option value="">最顶部</option>'
		select.value = ''
		select.disabled = true
		hint.textContent = '未配置 Mihomo API，仅可按最顶部处理。'
		return
	}

	try {
		state.localRules = await getLocalRules(state.mihomo.url, state.mihomo.secret)
		const candidateRules = currentRule ? excludeCurrentRule(state.localRules, currentRule) : state.localRules
		let options = '<option value="">最顶部</option>'
		for (let i = 0; i < candidateRules.length; i++) {
			options += `<option value="${escAttr(candidateRules[i])}">${escHtml(formatPriorityRuleLabel(candidateRules[i], i))}</option>`
		}
		select.innerHTML = options
		select.disabled = false
		select.value = resolveDefaultPriorityAnchor(state.localRules, currentRule)
		updateRulePriorityHint()
	} catch (error) {
		state.localRules = []
		select.innerHTML = '<option value="">最顶部</option>'
		select.value = ''
		select.disabled = true
		hint.textContent = `读取本地规则失败: ${error.message}`
		if (resultEl.className === 'result-box' && !resultEl.textContent) {
			resultEl.textContent = `读取本地规则失败: ${error.message}`
			resultEl.className = 'result-box error'
		}
	}
}

function excludeCurrentRule(rules, currentRule) {
	let removed = false
	return rules.filter((rule) => {
		if (!removed && rule === currentRule) {
			removed = true
			return false
		}
		return true
	})
}

function resolveDefaultPriorityAnchor(rules, currentRule = '') {
	if (currentRule) {
		const currentIdx = rules.indexOf(currentRule)
		return currentIdx > 0 ? rules[currentIdx - 1] : ''
	}

	const matchIdx = rules.findIndex(rule => parseRuleDisplay(rule).type === 'MATCH')
	const insertIdx = matchIdx === -1 ? rules.length : matchIdx
	return insertIdx > 0 ? rules[insertIdx - 1] : ''
}

function formatPriorityRuleLabel(rule, index) {
	const parsed = parseRuleDisplay(rule)
	const summary = parsed.type === 'MATCH'
		? `MATCH → ${parsed.target || '-'}`
		: `${parsed.type}${parsed.payload ? ` ${parsed.payload}` : ''} → ${parsed.target || '-'}`
	return `${index + 1}. ${truncateText(summary, 72)}`
}

function truncateText(value, maxLength) {
	const text = String(value || '')
	if (text.length <= maxLength) return text
	return `${text.slice(0, Math.max(0, maxLength - 3))}...`
}

function getPriorityAnchorValue() {
	return document.getElementById('rule-priority-select').value || ''
}

function updateRulePriorityHint() {
	const hint = document.getElementById('rule-priority-hint')
	const select = document.getElementById('rule-priority-select')
	const text = select.options[select.selectedIndex]?.textContent || '最顶部'
	hint.textContent = select.value ? `在 ${text} 下方` : '最顶部'
}

function getRulePayloadValue() {
	const type = document.getElementById('rule-type').value
	if (type === 'IN-TYPE') {
		return Array.from(document.querySelectorAll('input[name="rule-payload-type"]:checked'))
			.map((input) => input.value)
			.join('/')
	}
	const select = document.getElementById('rule-payload-select')
	if (select) return select.value.trim()
	const input = document.getElementById('rule-payload')
	return input ? input.value.trim() : ''
}

function setRulePayloadValue(value) {
	const type = document.getElementById('rule-type').value
	if (type === 'IN-TYPE') {
		const selected = new Set(String(value || '').split('/').map((item) => item.trim().toUpperCase()).filter(Boolean))
		document.querySelectorAll('input[name="rule-payload-type"]').forEach((input) => {
			input.checked = selected.has(input.value)
		})
		return
	}
	const select = document.getElementById('rule-payload-select')
	if (select) {
		select.value = String(value || '')
		return
	}
	const input = document.getElementById('rule-payload')
	if (input) {
		input.value = String(value || '')
	}
}

function attachRulePayloadListeners() {
	const select = document.getElementById('rule-payload-select')
	if (select) {
		select.addEventListener('change', () => {
			void refreshGeoSuggestions()
		})
	}

	const input = document.getElementById('rule-payload')
	if (input) {
		input.addEventListener('input', () => {
			void refreshGeoSuggestions()
		})
	}

	document.querySelectorAll('input[name="rule-payload-type"]').forEach((checkbox) => {
		checkbox.addEventListener('change', () => {
			void refreshGeoSuggestions()
		})
	})
}

function renderRulePayloadControl(type) {
	const container = document.getElementById('rule-payload-control')
	if (!container) return

	if (type === 'IN-PORT') {
		const listeners = Array.isArray(state.listeners) ? state.listeners : []
		const options = listeners
			.map((listener) => String(listener?.port || '').trim())
			.filter(Boolean)
		container.innerHTML = `
			<select id="rule-payload-select">
				<option value="">请选择端口</option>
				${[...new Set(options)].map((port) => `<option value="${escAttr(port)}">${escHtml(port)}</option>`).join('')}
			</select>
		`
		return
	}

	if (type === 'IN-NAME') {
		const listeners = Array.isArray(state.listeners) ? state.listeners : []
		container.innerHTML = `
			<select id="rule-payload-select">
				<option value="">请选择 Listener</option>
				${listeners.map((listener) => `<option value="${escAttr(listener.name || '')}">${escHtml(listener.name || '')}</option>`).join('')}
			</select>
		`
		return
	}

	if (type === 'IN-USER') {
		const users = Array.isArray(state.proxyAuthUsers) ? state.proxyAuthUsers : []
		container.innerHTML = `
			<select id="rule-payload-select">
				<option value="">请选择代理用户</option>
				${users.map((user) => `<option value="${escAttr(user.username || '')}">${escHtml(user.username || '')}</option>`).join('')}
			</select>
		`
		return
	}

	if (type === 'IN-TYPE') {
		container.innerHTML = `
			<div class="rule-payload-multiselect">
				<label><input type="checkbox" name="rule-payload-type" value="HTTP" />HTTP</label>
				<label><input type="checkbox" name="rule-payload-type" value="HTTPS" />HTTPS</label>
				<label><input type="checkbox" name="rule-payload-type" value="SOCKS" />SOCKS</label>
			</div>
		`
		return
	}

	container.innerHTML = '<input type="text" id="rule-payload" placeholder="example.com" />'
}

function refreshRuleTypeAvailability(preferredType = '') {
	const typeSelect = document.getElementById('rule-type')
	if (!typeSelect) return

	const hasListeners = Array.isArray(state.listeners) && state.listeners.length > 0
	const hasUsers = Array.isArray(state.proxyAuthUsers) && state.proxyAuthUsers.length > 0

	const optionRules = {
		'IN-PORT': hasListeners,
		'IN-NAME': hasListeners,
		'IN-USER': hasUsers,
	}

	for (const option of typeSelect.options) {
		if (Object.prototype.hasOwnProperty.call(optionRules, option.value)) {
			option.disabled = !optionRules[option.value] && option.value !== preferredType
		}
	}

	const currentValue = preferredType || typeSelect.value
	if (optionRules[currentValue] === false) {
		if (preferredType) {
			typeSelect.value = preferredType
		} else {
			typeSelect.value = 'DOMAIN-SUFFIX'
		}
	}
}

function formatRule(rule, rulePayload) {
	if (!rule) return ''
	const index = rule.indexOf(',')
	if (index === -1) return rulePayload ? `${rule}:${rulePayload}` : rule
	return rule.substring(0, index) + ':' + (rulePayload || rule.substring(index + 1))
}

function escHtml(value) {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
}

function escAttr(value) {
	return escHtml(value)
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}

function onRuleTypeChange() {
	const type = document.getElementById('rule-type').value
	const payloadGroup = document.getElementById('payload-group')
	const noResolveGroup = document.getElementById('no-resolve-group')
	const noResolveInput = document.getElementById('rule-no-resolve')
	const previousValue = getRulePayloadValue()
	renderRulePayloadControl(type)
	payloadGroup.style.display = type === 'MATCH' ? 'none' : ''
	noResolveGroup.style.display = supportsNoResolve(type) ? '' : 'none'
	if (!supportsNoResolve(type)) {
		noResolveInput.checked = false
	}
	setRulePayloadValue(previousValue)
	attachRulePayloadListeners()
	void refreshGeoSuggestions()
}

async function refreshGeoSuggestions() {
	const suggestionBox = document.getElementById('geo-suggestion-box')
	if (!suggestionBox) return

	const payload = getRulePayloadValue()
	const type = document.getElementById('rule-type').value
	const host = normalizeRuleHost(payload || state.ruleGeoContext.host)
	const destinationIps = normalizeDestinationIps(state.ruleGeoContext.destinationIps)
	const shouldLookupHost = shouldLookupGeosite(type, payload)
	const shouldLookupGeoip = destinationIps.length > 0

	if (!state.mihomoConfigs || (!shouldLookupHost && !shouldLookupGeoip)) {
		renderGeoSuggestions([])
		return
	}

	const seq = ++state.geoSuggestionSeq
	suggestionBox.hidden = false
	suggestionBox.innerHTML = '<div class="geo-suggestion-meta"><span class="spinner"></span>检查 GeoSite / GeoIP...</div>'

	const lookupHost = shouldLookupHost ? host : ''
	try {
		const suggestions = await getGeoRuleSuggestions(state.mihomoConfigs, lookupHost, shouldLookupGeoip ? destinationIps : [])
		if (seq !== state.geoSuggestionSeq) return
		renderGeoSuggestions(suggestions)
	} catch {
		if (seq !== state.geoSuggestionSeq) return
		renderGeoSuggestions([])
	}
}

function renderGeoSuggestions(suggestions) {
	const suggestionBox = document.getElementById('geo-suggestion-box')
	if (!suggestionBox) return
	if (!Array.isArray(suggestions) || suggestions.length === 0) {
		suggestionBox.hidden = true
		suggestionBox.innerHTML = ''
		return
	}

	suggestionBox.hidden = false
	suggestionBox.innerHTML = `
		<div class="geo-suggestion-meta">匹配到可复用的 Geo 规则，点击可直接回填规则类型和匹配值。</div>
		<div class="geo-suggestion-list">
			${suggestions.map((suggestion) => `
				<button
					type="button"
					class="geo-suggestion-item"
					data-geo-type="${escAttr(suggestion.type)}"
					data-geo-value="${escAttr(suggestion.value)}"
				>
					<div class="geo-suggestion-main">
						<div class="geo-suggestion-title">${escHtml(suggestion.label)}</div>
						<div class="geo-suggestion-detail">${escHtml(suggestion.detail || '')}</div>
					</div>
					<span class="geo-suggestion-type ${suggestion.type === 'GEOIP' ? 'geoip' : 'geosite'}">${escHtml(suggestion.type)}</span>
				</button>
			`).join('')}
		</div>
	`
}

function handleGeoSuggestionClick(event) {
	const button = event.target.closest('.geo-suggestion-item')
	if (!button) return
	const nextType = button.getAttribute('data-geo-type') || ''
	const nextValue = button.getAttribute('data-geo-value') || ''
	if (!nextType || !nextValue) return

	document.getElementById('rule-type').value = nextType
	onRuleTypeChange()
	setRulePayloadValue(nextValue)
	if (nextType === 'GEOIP') {
		document.getElementById('rule-no-resolve').checked = false
	}
	void refreshGeoSuggestions()
}

function shouldLookupGeosite(type, payload) {
	if (type === 'MATCH') return false
	const host = normalizeRuleHost(payload || state.ruleGeoContext.host)
	return !!host && host.includes('.')
}

function normalizeRuleHost(value) {
	return String(value || '').trim().toLowerCase().replace(/\.+$/, '')
}

function normalizeDestinationIps(values) {
	return [...new Set((Array.isArray(values) ? values : [])
		.map(value => String(value || '').trim())
		.filter(Boolean))]
}

function supportsNoResolve(type) {
	return ['GEOIP', 'IP-CIDR'].includes(type)
}

function buildRuleString(ruleType, rulePayload, ruleProxy) {
	if (ruleType === 'MATCH') return `MATCH,${ruleProxy}`
	const noResolve = supportsNoResolve(ruleType) && document.getElementById('rule-no-resolve').checked
	const base = `${ruleType},${rulePayload},${ruleProxy}`
	return noResolve ? `${base},no-resolve` : base
}

async function handleEditRuleClick(ruleType, rulePayload) {
	const resultEl = document.getElementById('rule-result')
	const parsedClickedRule = parseRuleDisplay(ruleType || '')
	const normalizedType = parsedClickedRule.type || ruleType || ''
	const normalizedPayload = parsedClickedRule.payload || rulePayload || ''
	const fallbackRule = normalizedPayload ? `${normalizedType},${normalizedPayload}` : `${normalizedType},`
	debugRuleEdit('handleEditRuleClick:input', {
		ruleType,
		rulePayload,
		parsedClickedRule,
		normalizedType,
		normalizedPayload,
		fallbackRule,
	})

	try {
		const fullRule = await findRuleByConnection(state.mihomo.url, state.mihomo.secret, normalizedType, normalizedPayload)
		debugRuleEdit('handleEditRuleClick:lookup', {
			normalizedType,
			normalizedPayload,
			fullRule,
		})
		if (!fullRule) {
			await showEditPanel(fallbackRule)
			resultEl.textContent = '未找到原始规则，已按命中信息回填，代理组可能需要手动确认'
			resultEl.className = 'result-box error'
			return
		}

		await showEditPanel(fullRule)
	} catch (error) {
		await showEditPanel(fallbackRule)
		resultEl.textContent = `读取原始规则失败: ${error.message}`
		resultEl.className = 'result-box error'
	}
}

async function handleAddRule() {
	const resultEl = document.getElementById('rule-result')
	resultEl.textContent = ''
	resultEl.className = 'result-box'

	const ruleType = document.getElementById('rule-type').value
	const rulePayload = ruleType === 'MATCH' ? 'MATCH' : getRulePayloadValue()
	const ruleProxy = getProxyValue()
	const priorityAnchor = getPriorityAnchorValue()

	if (ruleType !== 'MATCH' && !rulePayload) {
		resultEl.textContent = '请填写匹配值'
		resultEl.className = 'result-box error'
		return
	}
	if (!ruleProxy) {
		resultEl.textContent = '请选择代理组/策略'
		resultEl.className = 'result-box error'
		return
	}

	const hasLocal = !!state.mihomo.url
	const hasRemote = !!(state.subMagic.url && state.subMagic.accessKey)

	if (!hasRemote) {
		resultEl.textContent = '未配置 Sub Magic 远程规则接口'
		resultEl.className = 'result-box error'
		return
	}

	const ruleStr = buildRuleString(ruleType, rulePayload, ruleProxy)
	const messages = []
	resultEl.innerHTML = '<span class="spinner"></span>添加中...'

	try {
		if (hasLocal) {
			try {
				await addRuleLocal(state.mihomo.url, state.mihomo.secret, ruleStr, priorityAnchor)
				messages.push('本地添加成功')
			} catch (error) {
				messages.push(`本地添加失败: ${error.message}`)
			}
		}

		try {
			await addRuleRemote(state.subMagic.url, state.subMagic.accessKey, ruleStr, priorityAnchor)
			if (hasLocal) {
				resultEl.innerHTML = '<span class="spinner"></span>远程添加成功，等待本地 Mihomo 生效...'
				const verifyResult = await waitForRulePresent(state.mihomo.url, state.mihomo.secret, ruleStr, priorityAnchor)
				if (verifyResult.ok) {
					messages.push(`远程添加成功，本地 Mihomo 已生效（${verifyResult.attempts}s）`)
				} else {
					messages.push('远程添加成功，但本地 Mihomo 在 30 秒内未检测到规则生效，请手动检查订阅更新状态')
				}
			} else {
				messages.push('远程添加成功')
			}
		} catch (error) {
			messages.push(`远程添加失败: ${error.message}`)
		}

		resultEl.textContent = messages.join('\n')
		resultEl.className = messages.some(message => message.includes('失败') || message.includes('未检测到')) ? 'result-box error' : 'result-box success'
		if (resultEl.className === 'result-box success') {
			await closeConnectionsByIds(collectAffectedConnectionIdsForRuleChange('', ruleStr))
			await returnToRoutingAndReloadTab()
		}
	} catch (error) {
		resultEl.textContent = `操作失败: ${error.message}`
		resultEl.className = 'result-box error'
	}
}

async function handleSaveRule() {
	const resultEl = document.getElementById('rule-result')
	resultEl.textContent = ''
	resultEl.className = 'result-box'

	const ruleType = document.getElementById('rule-type').value
	const rulePayload = ruleType === 'MATCH' ? 'MATCH' : getRulePayloadValue()
	const ruleProxy = getProxyValue()
	const priorityAnchor = getPriorityAnchorValue()

	if (ruleType !== 'MATCH' && !rulePayload) {
		resultEl.textContent = '请填写匹配值'
		resultEl.className = 'result-box error'
		return
	}
	if (!ruleProxy) {
		resultEl.textContent = '请选择代理组/策略'
		resultEl.className = 'result-box error'
		return
	}

	const hasLocal = !!state.mihomo.url
	const hasRemote = !!(state.subMagic.url && state.subMagic.accessKey)
	if (!hasLocal && !hasRemote) {
		resultEl.textContent = '未配置本地或远程规则接口'
		resultEl.className = 'result-box error'
		return
	}

	const newRuleStr = buildRuleString(ruleType, rulePayload, ruleProxy)
	if (!state.editingRule) {
		resultEl.textContent = '编辑状态丢失'
		resultEl.className = 'result-box error'
		return
	}
	const previousRuleStr = state.editingRule

	resultEl.innerHTML = '<span class="spinner"></span>保存中...'

	try {
		await updateRuleRemote(state.subMagic.url, state.subMagic.accessKey, previousRuleStr, newRuleStr, priorityAnchor)
		if (hasLocal) {
			resultEl.innerHTML = '<span class="spinner"></span>远程修改成功，等待本地 Mihomo 生效...'
			const verifyResult = await waitForRuleUpdate(state.mihomo.url, state.mihomo.secret, previousRuleStr, newRuleStr, priorityAnchor)
			state.editingRule = newRuleStr
			if (verifyResult.ok) {
				resultEl.textContent = `远程修改成功，本地 Mihomo 已生效（${verifyResult.attempts}s）`
				resultEl.className = 'result-box success'
				await closeConnectionsByIds(collectAffectedConnectionIdsForRuleChange(previousRuleStr, newRuleStr))
				await returnToRoutingAndReloadTab()
			} else {
				resultEl.textContent = '远程修改成功，但本地 Mihomo 在 30 秒内未检测到规则生效，请手动检查订阅更新状态'
				resultEl.className = 'result-box error'
			}
			return
		}

		state.editingRule = newRuleStr
		resultEl.textContent = '远程修改成功'
		resultEl.className = 'result-box success'
		await closeConnectionsByIds(collectAffectedConnectionIdsForRuleChange(previousRuleStr, newRuleStr))
		await returnToRoutingAndReloadTab()
	} catch (error) {
		resultEl.textContent = `远程修改失败: ${error.message}`
		resultEl.className = 'result-box error'
	}
}

async function handleDeleteRule() {
	const resultEl = document.getElementById('rule-result')
	resultEl.textContent = ''
	resultEl.className = 'result-box'

	if (!state.editingRule) {
		resultEl.textContent = '编辑状态丢失'
		resultEl.className = 'result-box error'
		return
	}

	resultEl.innerHTML = '<span class="spinner"></span>删除中...'

	try {
		await deleteRule(state.mihomo.url, state.mihomo.secret, state.editingRule)
		state.editingRule = null
		resultEl.textContent = '删除成功'
		resultEl.className = 'result-box success'
	} catch (error) {
		resultEl.textContent = `删除失败: ${error.message}`
		resultEl.className = 'result-box error'
	}
}

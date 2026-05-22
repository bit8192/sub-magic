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
	getMihomoConfigs,
	getProxyAuthUsers,
	getProxySnapshot,
	getProxyProviders,
	setProxySelector,
} from '../utils/api.js'

const DEFAULT_PROXY_TYPE = 'http'

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
	proxyValidation: null,
	proxyGroups: [],
	proxyMap: {},
	proxyProviders: {},
	ruleMode: null,
	editingRule: null,
	currentSelector: '',
}

let pollTimer = null
let proxyRefreshTimer = null

document.addEventListener('DOMContentLoaded', async () => {
	await initCurrentTab()
	await loadSettings()
	await loadProxyState()

	document.getElementById('btn-add-rule').addEventListener('click', handleAddRule)
	document.getElementById('btn-save-rule').addEventListener('click', handleSaveRule)
	document.getElementById('btn-delete-rule').addEventListener('click', handleDeleteRule)
	document.getElementById('btn-back-routing').addEventListener('click', showRoutingPanel)
	document.getElementById('btn-back-selector').addEventListener('click', showRoutingPanel)
	document.getElementById('btn-settings').addEventListener('click', () => chrome.runtime.openOptionsPage())
	document.getElementById('btn-control-panel').addEventListener('click', openControlPanel)
	document.getElementById('btn-apply-proxy').addEventListener('click', handleApplyProxy)
	document.getElementById('rule-type').addEventListener('change', onRuleTypeChange)
	document.getElementById('selector-result').addEventListener('click', handleSelectorResultClick)
	document.getElementById('proxy-type').addEventListener('change', () => refreshProxyForm())
	document.getElementById('proxy-auth-user').addEventListener('change', () => refreshProxyMeta())
	document.getElementById('proxy-listener').addEventListener('change', () => refreshProxyForm())

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
		if (state.tabId > 0) {
			chrome.runtime.sendMessage({ type: 'POLL_STOP', tabId: state.tabId }).catch(() => {})
		}
	})

	window.addEventListener('beforeunload', () => {
		if (state.tabId > 0) {
			chrome.runtime.sendMessage({ type: 'POLL_STOP', tabId: state.tabId }).catch(() => {})
		}
	})
})

async function loadSettings() {
	const data = await chrome.storage.sync.get(['mihomoUrl', 'mihomoSecret', 'subMagicUrl', 'subMagicKey'])
	if (data.mihomoUrl) state.mihomo.url = data.mihomoUrl
	if (data.mihomoSecret) state.mihomo.secret = data.mihomoSecret
	if (data.subMagicUrl) state.subMagic.url = data.subMagicUrl
	if (data.subMagicKey) state.subMagic.accessKey = data.subMagicKey

	document.getElementById('routing-section').style.display = state.mihomo.url ? '' : 'none'
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
	if (chrome.windows?.create) {
		chrome.windows.create({ url, type: 'popup' })
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

function normalizeListenerPort(port) {
	const value = Number(port)
	return Number.isFinite(value) ? value : 0
}

function areConfigInboundPortsDisabled() {
	const configs = state.mihomoConfigs || {}
	const ports = ['port', 'socks-port', 'mixed-port']
	return ports.every((key) => {
		const value = configs[key]
		if (value === undefined || value === null || value === '') return true
		return Number(value) === 0
	})
}

function canUseListenersFallback() {
	return areConfigInboundPortsDisabled() && Array.isArray(state.listeners) && state.listeners.length > 0
}

function filterListenersByProxyType(proxyType) {
	const listeners = state.listeners || []
	if (proxyType === 'http' || proxyType === 'https') {
		return listeners.filter(listener => listener?.type === 'http' || listener?.type === 'mixed')
	}
	if (proxyType === 'socks5') {
		return listeners.filter(listener => listener?.type === 'socks' || listener?.type === 'mixed')
	}
	return listeners.filter(listener => listener?.type === 'socks')
}

function resolvePortForType(proxyType, selectedListenerName = '') {
	const configs = state.mihomoConfigs || {}
	const listeners = filterListenersByProxyType(proxyType)

	if (proxyType === 'http' || proxyType === 'https') {
		const directPort = Number(configs.port || 0)
		const mixedPort = Number(configs['mixed-port'] || 0)
		if (directPort > 0) return { port: directPort, source: 'config', listenerName: '' }
		if (mixedPort > 0) return { port: mixedPort, source: 'config', listenerName: '' }
	} else if (proxyType === 'socks5') {
		const directPort = Number(configs['socks-port'] || 0)
		const mixedPort = Number(configs['mixed-port'] || 0)
		if (directPort > 0) return { port: directPort, source: 'config', listenerName: '' }
		if (mixedPort > 0) return { port: mixedPort, source: 'config', listenerName: '' }
	} else {
		const directPort = Number(configs['socks-port'] || 0)
		if (directPort > 0) return { port: directPort, source: 'config', listenerName: '' }
	}

	if (!canUseListenersFallback()) {
		return { port: 0, source: 'config', listenerName: '' }
	}

	const selected = listeners.find(listener => listener.name === selectedListenerName) || listeners[0] || null
	return {
		port: selected ? normalizeListenerPort(selected.port) : 0,
		source: 'listener',
		listenerName: selected?.name || '',
	}
}

function getSelectedAuthUser() {
	const selectedUsername = document.getElementById('proxy-auth-user').value
	if (!selectedUsername) return null
	return state.proxyAuthUsers.find(user => user.username === selectedUsername) || null
}

function buildProxyValidation(profile) {
	if (!state.mihomo.url) {
		return { ok: false, reason: '请先配置 Mihomo API。' }
	}

	const host = getMihomoHost()
	if (!host) {
		return { ok: false, reason: '无法从 Mihomo API 地址解析代理 host。' }
	}

	const resolution = resolvePortForType(profile.proxyType, profile.listenerName)
	if (resolution.source === 'listener' && !resolution.listenerName) {
		return { ok: false, reason: '当前代理方式未从 configs 获取到端口，请先选择 listener。' }
	}
	if (resolution.port <= 0) {
		if (Array.isArray(state.listeners) && state.listeners.length > 0 && !canUseListenersFallback()) {
			return { ok: false, reason: '仅当 /configs 中 port、socks-port、mixed-port 全部为 0 或未配置时，才允许改用 listener。' }
		}
		return { ok: false, reason: '当前代理方式没有可用端口。' }
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
		port: resolution.port,
		source: resolution.source,
		listenerName: resolution.listenerName,
	}
}

function buildProfileFromForm() {
	const currentProfile = state.proxyProfile || {}
	const draft = {
		enabled: true,
		proxyType: document.getElementById('proxy-type').value,
		host: getMihomoHost(),
		port: 0,
		listenerName: document.getElementById('proxy-listener').value,
		source: 'config',
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

function renderListenerOptions(proxyType) {
	const listeners = [...filterListenersByProxyType(proxyType)]
	const groupEl = document.getElementById('proxy-listener-group')
	const select = document.getElementById('proxy-listener')
	const resolution = resolvePortForType(proxyType, state.proxyProfile?.listenerName || '')
	const listenersAvailable = canUseListenersFallback()
	const needsListener = listenersAvailable && resolution.source === 'listener'

	if (resolution.listenerName && !listeners.some(listener => listener.name === resolution.listenerName)) {
		listeners.unshift({ name: resolution.listenerName, type: 'unknown', port: state.proxyProfile?.port || '' })
	}

	groupEl.style.display = needsListener ? '' : 'none'

	let html = '<option value="">请选择</option>'
	for (const listener of listeners) {
		const port = normalizeListenerPort(listener.port)
		const selected = listener.name === resolution.listenerName ? ' selected' : ''
		html += `<option value="${escAttr(listener.name)}"${selected}>${escHtml(listener.name)} · ${escHtml(listener.type || '')} · ${port || '-'}</option>`
	}
	select.innerHTML = html
	select.disabled = !listenersAvailable
}

function applyProxyProfileToForm() {
	const profile = state.proxyProfile || {
		proxyType: DEFAULT_PROXY_TYPE,
		listenerName: '',
		authUser: null,
	}
	document.getElementById('proxy-type').value = profile.proxyType || DEFAULT_PROXY_TYPE
	renderProxyAuthUsers()
	renderListenerOptions(profile.proxyType || DEFAULT_PROXY_TYPE)
	if (profile.listenerName) {
		document.getElementById('proxy-listener').value = profile.listenerName
	}
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
		if (!state.proxyProfile) {
			state.proxyProfile = {
				proxyType: DEFAULT_PROXY_TYPE,
				host: '',
				port: 0,
				listenerName: '',
				source: 'config',
				authUser: null,
			}
		}
		applyProxyProfileToForm()
		const nextProfile = buildProfileFromForm()
		const needsBootstrap =
			state.proxyProfile.proxyType !== nextProfile.proxyType ||
			state.proxyProfile.host !== nextProfile.host ||
			state.proxyProfile.port !== nextProfile.port ||
			state.proxyProfile.listenerName !== nextProfile.listenerName ||
			(state.proxyProfile.authUser?.username || '') !== (nextProfile.authUser?.username || '')
		state.proxyProfile = nextProfile
		if (needsBootstrap) {
			await chrome.runtime.sendMessage({ type: 'PROXY_SET_STATE', tabId: state.tabId, profile: nextProfile })
		}
		refreshProxyMeta()
	} catch (error) {
		refreshProxyMeta({ ok: false, reason: `代理控制初始化失败: ${error.message}` })
	}
}

function refreshProxyForm() {
	const proxyType = document.getElementById('proxy-type').value
	renderListenerOptions(proxyType)
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
	})
}

function isProxyProfileActive(profile) {
	return !!(profile && profile.host && Number(profile.port) > 0)
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

function refreshProxyMeta(overrideValidation = null) {
	const statusEl = document.getElementById('proxy-status')
	const metaEl = document.getElementById('proxy-meta')
	const draftProfile = {
		proxyType: document.getElementById('proxy-type').value,
		host: getMihomoHost(),
		port: 0,
		listenerName: document.getElementById('proxy-listener').value,
		authUser: getSelectedAuthUser(),
	}
	const validation = overrideValidation || buildProxyValidation(draftProfile)

	if (!validation.ok) {
		statusEl.textContent = '不可用'
		statusEl.className = 'routing-status error'
		metaEl.innerHTML = `隔离模式: <strong>${state.proxyIsolation ? '按标签页' : '全局共享'}</strong><br>${escHtml(validation.reason)}`
		updateApplyButton(validation, draftProfile)
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
			host: '',
			port: 0,
			listenerName: '',
			source: 'config',
			authUser: null,
		}
		: draftProfile

	state.proxyProfile = profile
	await chrome.runtime.sendMessage({ type: 'PROXY_SET_STATE', tabId: state.tabId, profile })
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
	if (resp.proxyGroups && state.proxyGroups.length === 0) {
		state.proxyGroups = resp.proxyGroups
		populateProxyOptions()
	}
	if (resp.data) {
		updateRoutingDisplay(resp.data)
	}
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
		state.proxyGroups = buildProxyGroups(proxyMap)
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

function buildProxyGroups(proxyMap) {
	return Object.values(proxyMap)
		.filter(proxy => proxy?.name && proxy.type && proxy.type !== 'Direct' && proxy.type !== 'Reject')
		.map(proxy => ({
			name: proxy.name,
			type: proxy.type,
			now: proxy.now || '',
		}))
}

function populateProxyOptions() {
	const select = document.getElementById('rule-proxy-select')
	const currentValue = getProxyValue()
	let options = ''
	for (const group of state.proxyGroups) {
		const selected = group.now ? ` (${group.now})` : ''
		options += `<option value="${escAttr(group.name)}">${escHtml(group.name)}${escHtml(selected)}</option>`
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

	if (data.status === 'disconnected') {
		statusEl.textContent = '已断开，重连中...'
		statusEl.className = 'routing-status error'
		resultEl.innerHTML = ''
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
		resultEl.innerHTML = ''
		return
	}

	if (!data.groups || data.groups.length === 0) {
		statusEl.textContent = `监控中 · 命中 ${data.total} 连接`
		statusEl.className = 'routing-status connected'
		resultEl.innerHTML = '<div class="routing-empty">当前域名暂无命中链路</div>'
		return
	}

	const sharedCount = data.groups.filter(g => g.shared).length
	statusEl.textContent = `监控中 · 命中 ${data.total} 连接 · ${data.groups.length} 组${sharedCount > 0 ? ` (${sharedCount} 可能共享)` : ''}`
	statusEl.className = 'routing-status connected'

	let html = ''
	for (const group of data.groups) {
		const ruleStr = group.rule ? formatRule(group.rule, group.rulePayload) : ''
		const chainHtml = renderChain(group.chain)
		const sharedTag = group.shared ? '<span class="route-shared-tag" title="此连接可能与其他Tab共享">共享</span>' : ''
		const confidenceLabel = group.confidence === 'high' ? '高' : group.confidence === 'medium' ? '中' : '低'
		const confidenceTag = `<span class="route-confidence-tag ${group.confidence}" title="匹配置信度：${confidenceLabel}${group.portMatched ? '，端口一致' : ''}">${confidenceLabel}</span>`

		html += `<div class="route-card">
			<div class="route-header">
				<span class="route-count">${group.count}</span>
				<span class="route-host" data-host="${escAttr(group.host)}" title="${escAttr(group.host)}">${escHtml(group.host)}${sharedTag}${confidenceTag}</span>
			</div>
			<div class="route-chain-line">${chainHtml}</div>`

		if (ruleStr) {
			html += `<div class="route-rule-line" data-rule="${escAttr(group.rule)}" data-rule-payload="${escAttr(group.rulePayload || '')}">${escHtml(ruleStr)}</div>`
		}

		html += '</div>'
	}

	resultEl.innerHTML = html

	resultEl.querySelectorAll('.route-host').forEach(el => {
		el.addEventListener('click', () => showAddPanel(el.getAttribute('data-host') || ''))
	})

	resultEl.querySelectorAll('.route-rule-line').forEach(el => {
		const rule = el.getAttribute('data-rule') || ''
		if (rule) {
			const rulePayload = el.getAttribute('data-rule-payload') || ''
			el.addEventListener('click', () => handleEditRuleClick(rule, rulePayload))
		}
	})

	resultEl.querySelectorAll('.route-chain-selector').forEach(el => {
		el.addEventListener('click', () => openSelectorPanel(el.getAttribute('data-proxy') || ''))
	})
}

function renderChain(chain) {
	const items = Array.isArray(chain) && chain.length > 0 ? [...chain].reverse() : ['DIRECT']
	return items.map(renderChainToken).join(' <span class="route-chain-token">→</span> ')
}

function renderChainToken(name) {
	const proxy = state.proxyMap[name]
	if (proxy?.type === 'Selector') {
		return `<button class="route-chain-token route-chain-selector" data-proxy="${escAttr(name)}" title="点击选择 ${escAttr(name)} 的下游链路">${escHtml(name)}</button>`
	}
	return `<span class="route-chain-token">${escHtml(name)}</span>`
}

function showRoutingPanel() {
	document.getElementById('routing-section').style.display = state.mihomo.url ? '' : 'none'
	document.getElementById('rule-section').style.display = 'none'
	document.getElementById('selector-section').style.display = 'none'
	state.ruleMode = null
	state.editingRule = null
	state.currentSelector = ''
}

function showAddPanel(domain) {
	document.getElementById('routing-section').style.display = 'none'
	document.getElementById('selector-section').style.display = 'none'
	document.getElementById('rule-section').style.display = ''
	document.getElementById('rule-panel-title').textContent = '添加规则'
	document.getElementById('btn-group-add').style.display = ''
	document.getElementById('btn-group-edit').style.display = 'none'
	state.ruleMode = 'add'
	state.editingRule = null

	document.getElementById('rule-type').value = 'DOMAIN-SUFFIX'
	document.getElementById('rule-payload').value = domain || state.domain || ''
	document.getElementById('rule-no-resolve').checked = false
	setProxyValue('')

	onRuleTypeChange()
	clearRuleResult()
}

function showEditPanel(ruleStr) {
	document.getElementById('routing-section').style.display = 'none'
	document.getElementById('selector-section').style.display = 'none'
	document.getElementById('rule-section').style.display = ''
	document.getElementById('rule-panel-title').textContent = '修改规则'
	document.getElementById('btn-group-add').style.display = 'none'
	document.getElementById('btn-group-edit').style.display = ''
	state.ruleMode = 'edit'
	state.editingRule = ruleStr

	const info = parseRuleDisplay(ruleStr)
	document.getElementById('rule-type').value = info.type || 'DOMAIN-SUFFIX'
	document.getElementById('rule-payload').value = info.payload || ''
	document.getElementById('rule-no-resolve').checked = !!info.noResolve
	setProxyValue(info.target)

	onRuleTypeChange()
	clearRuleResult()
}

async function openSelectorPanel(proxyName) {
	if (!proxyName) return

	state.currentSelector = proxyName
	document.getElementById('routing-section').style.display = 'none'
	document.getElementById('rule-section').style.display = 'none'
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
		await refreshProxyData()
		renderSelectorPanel(proxyName)
		const proxy = state.proxyMap[proxyName]
		metaEl.innerHTML = `类型: <strong>${escHtml(proxy?.type || '-')}</strong><br>当前选择: <strong>${escHtml(proxy?.now || targetName)}</strong><br>已切换成功`
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
	payloadGroup.style.display = type === 'MATCH' ? 'none' : ''
	noResolveGroup.style.display = supportsNoResolve(type) ? '' : 'none'
	if (!supportsNoResolve(type)) {
		noResolveInput.checked = false
	}
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
	const fallbackRule = rulePayload ? `${ruleType},${rulePayload}` : `${ruleType},`

	try {
		const fullRule = await findRuleByConnection(state.mihomo.url, state.mihomo.secret, ruleType, rulePayload)
		if (!fullRule) {
			showEditPanel(fallbackRule)
			resultEl.textContent = '未找到原始规则，已按命中信息回填，代理组可能需要手动确认'
			resultEl.className = 'result-box error'
			return
		}

		showEditPanel(fullRule)
	} catch (error) {
		showEditPanel(fallbackRule)
		resultEl.textContent = `读取原始规则失败: ${error.message}`
		resultEl.className = 'result-box error'
	}
}

async function handleAddRule() {
	const resultEl = document.getElementById('rule-result')
	resultEl.textContent = ''
	resultEl.className = 'result-box'

	const ruleType = document.getElementById('rule-type').value
	const rulePayload = ruleType === 'MATCH' ? 'MATCH' : document.getElementById('rule-payload').value.trim()
	const ruleProxy = getProxyValue()

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
				await addRuleLocal(state.mihomo.url, state.mihomo.secret, ruleStr)
				messages.push('本地添加成功')
			} catch (error) {
				messages.push(`本地添加失败: ${error.message}`)
			}
		}

		try {
			await addRuleRemote(state.subMagic.url, state.subMagic.accessKey, ruleStr)
			if (hasLocal) {
				resultEl.innerHTML = '<span class="spinner"></span>远程添加成功，等待本地 Mihomo 生效...'
				const verifyResult = await waitForRulePresent(state.mihomo.url, state.mihomo.secret, ruleStr)
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
	const rulePayload = ruleType === 'MATCH' ? 'MATCH' : document.getElementById('rule-payload').value.trim()
	const ruleProxy = getProxyValue()

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

	resultEl.innerHTML = '<span class="spinner"></span>保存中...'

	try {
		await updateRuleRemote(state.subMagic.url, state.subMagic.accessKey, state.editingRule, newRuleStr)
		if (hasLocal) {
			resultEl.innerHTML = '<span class="spinner"></span>远程修改成功，等待本地 Mihomo 生效...'
			const verifyResult = await waitForRuleUpdate(state.mihomo.url, state.mihomo.secret, state.editingRule, newRuleStr)
			state.editingRule = newRuleStr
			if (verifyResult.ok) {
				resultEl.textContent = `远程修改成功，本地 Mihomo 已生效（${verifyResult.attempts}s）`
				resultEl.className = 'result-box success'
			} else {
				resultEl.textContent = '远程修改成功，但本地 Mihomo 在 30 秒内未检测到规则生效，请手动检查订阅更新状态'
				resultEl.className = 'result-box error'
			}
			return
		}

		state.editingRule = newRuleStr
		resultEl.textContent = '远程修改成功'
		resultEl.className = 'result-box success'
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

import {
	getListeners,
	getMihomoConfigs,
	getProxyAuthUsers,
} from '../utils/api.js'
import {
	DEFAULT_PROXY_TYPE,
	buildAvailableProxyPortOptions,
	findProxyPortOption,
	getPreferredProxyType,
	isProxyTypeSupportedByPortOption,
} from '../utils/proxy-options.js'

const state = {
	browser: { id: 'chrome', supportsIsolation: false },
	proxyIsolation: false,
	proxyProfile: null,
	proxyAuthUsers: [],
	listeners: [],
	mihomoConfigs: null,
	proxyPortOptions: [],
	proxyValidation: null,
}

document.addEventListener('DOMContentLoaded', async () => {
	const [data, proxyState] = await Promise.all([
		chrome.storage.sync.get(['mihomoUrl', 'mihomoSecret', 'subMagicUrl', 'subMagicKey', 'proxyIsolation']),
		chrome.runtime.sendMessage({ type: 'PROXY_GET_STATE' }),
	])

	state.browser = proxyState?.browser || state.browser
	state.proxyProfile = proxyState?.profile || null

	if (data.mihomoUrl) document.getElementById('mihomo-url').value = data.mihomoUrl
	if (data.mihomoSecret) document.getElementById('mihomo-secret').value = data.mihomoSecret
	if (data.subMagicUrl) document.getElementById('submagic-url').value = data.subMagicUrl
	if (data.subMagicKey) document.getElementById('submagic-key').value = data.subMagicKey

	const isolationCheckbox = document.getElementById('proxy-isolation')
	const isolationHint = document.getElementById('proxy-isolation-hint')
	const isolationSupported = !!proxyState?.browser?.supportsIsolation

	state.proxyIsolation = isolationSupported ? data.proxyIsolation !== false : false
	isolationCheckbox.checked = state.proxyIsolation
	isolationCheckbox.disabled = !isolationSupported
	isolationHint.textContent = isolationSupported
		? '开启后，每个标签页可分别选择代理方式和代理授权用户。设置页中的默认代理仍作为全局默认值。'
		: '当前浏览器不支持按标签页代理隔离；所有标签页将共享这里设置的默认代理。'

	document.querySelectorAll('.toggle-visibility').forEach((button) => {
		button.addEventListener('click', () => {
			const input = document.getElementById(button.dataset.target)
			const isPassword = input.type === 'password'
			input.type = isPassword ? 'text' : 'password'
			button.textContent = isPassword ? '隐藏' : '显示'
		})
	})

	document.getElementById('proxy-port').addEventListener('change', refreshProxyForm)
	document.getElementById('proxy-type').addEventListener('change', refreshProxyForm)
	document.getElementById('proxy-auth-user').addEventListener('change', refreshProxyMeta)
	isolationCheckbox.addEventListener('change', () => {
		state.proxyIsolation = isolationSupported ? isolationCheckbox.checked : false
		refreshProxyMeta()
	})

	for (const id of ['mihomo-url', 'mihomo-secret', 'submagic-url', 'submagic-key']) {
		const input = document.getElementById(id)
		const refresh = () => {
			refreshProxyControls().catch((error) => {
				refreshProxyMeta({ ok: false, reason: `代理控制初始化失败: ${error.message}` })
			})
		}
		input.addEventListener('input', refresh)
		input.addEventListener('change', refresh)
	}

	await refreshProxyControls()

	document.getElementById('btn-save').addEventListener('click', async () => {
		const mihomoUrl = document.getElementById('mihomo-url').value.trim()
		const mihomoSecret = document.getElementById('mihomo-secret').value.trim()
		const subMagicUrl = document.getElementById('submagic-url').value.trim()
		const subMagicKey = document.getElementById('submagic-key').value.trim()
		const proxyIsolation = isolationSupported ? isolationCheckbox.checked : false
		const saveStatus = document.getElementById('save-status')

		saveStatus.classList.remove('error')
		saveStatus.textContent = ''

		await chrome.storage.sync.set({ mihomoUrl, mihomoSecret, subMagicUrl, subMagicKey, proxyIsolation })

		const draftProfile = buildProfileFromForm()
		if (!state.proxyValidation?.ok) {
			saveStatus.classList.add('error')
			saveStatus.textContent = `基础设置已保存，默认代理未更新：${state.proxyValidation?.reason || '配置无效'}`
			return
		}

		const profile = {
			...draftProfile,
			enabled: true,
			host: state.proxyValidation.host,
			port: state.proxyValidation.port,
			listenerName: state.proxyValidation.listenerName,
			source: state.proxyValidation.source,
		}

		const response = await chrome.runtime.sendMessage({ type: 'PROXY_SET_STATE', profile })
		state.proxyProfile = response?.profile || profile
		refreshProxyMeta()

		saveStatus.textContent = '已保存'
		setTimeout(() => {
			saveStatus.textContent = ''
			saveStatus.classList.remove('error')
		}, 2500)
	})
})

function ensureHttpUrl(url) {
	if (!url) return ''
	return /^https?:\/\//i.test(url) ? url : `http://${url}`
}

function getMihomoUrl() {
	return document.getElementById('mihomo-url').value.trim()
}

function getMihomoSecret() {
	return document.getElementById('mihomo-secret').value.trim()
}

function getSubMagicUrl() {
	return document.getElementById('submagic-url').value.trim()
}

function getSubMagicKey() {
	return document.getElementById('submagic-key').value.trim()
}

function getMihomoHost() {
	try {
		return new URL(ensureHttpUrl(getMihomoUrl())).hostname
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
		html += `<option value="${escapeAttr(option.id)}"${selected}>${escapeHtml(option.label)}</option>`
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
	if (!getMihomoUrl()) {
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
		html += `<option value="${escapeAttr(user.username)}"${selected}>${escapeHtml(user.username)}</option>`
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
	const mihomoUrl = getMihomoUrl()
	const mihomoSecret = getMihomoSecret()
	const subMagicUrl = getSubMagicUrl()
	const subMagicKey = getSubMagicKey()

	if (!mihomoUrl) {
		state.mihomoConfigs = {}
		state.proxyAuthUsers = []
		state.listeners = []
		state.proxyPortOptions = []
		applyProxyProfileToForm()
		refreshProxyMeta({ ok: false, reason: '请先配置 Mihomo API。' })
		return
	}

	try {
		const configs = await getMihomoConfigs(mihomoUrl, mihomoSecret)
		let authUsers = []
		let listeners = []
		if (subMagicUrl && subMagicKey) {
			const [usersResult, listenersResult] = await Promise.allSettled([
				getProxyAuthUsers(subMagicUrl, subMagicKey),
				getListeners(subMagicUrl, subMagicKey),
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

		applyProxyProfileToForm()
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

function isProxyProfileActive(profile) {
	return !!(profile && profile.host && Number(profile.port) > 0 && profile.enabled !== false)
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
		statusEl.className = 'status-chip error'
		metaEl.innerHTML = `模式: <strong>${state.proxyIsolation ? '按标签页可覆盖' : '全局共享'}</strong><br>${escapeHtml(validation.reason)}`
		return
	}

	const effectiveDraftProfile = {
		...draftProfile,
		enabled: true,
		host: validation.host,
		port: validation.port,
		listenerName: validation.listenerName,
		source: validation.source,
	}
	const applied = getProfileSignature(state.proxyProfile) === getProfileSignature(effectiveDraftProfile)
	statusEl.textContent = applied && isProxyProfileActive(state.proxyProfile) ? '已生效' : '可保存'
	statusEl.className = 'status-chip connected'
	metaEl.innerHTML = `模式: <strong>${state.proxyIsolation ? '按标签页可覆盖' : '全局共享'}</strong><br>地址: <strong>${escapeHtml(validation.host)}:${validation.port}</strong><br>来源: <strong>${escapeHtml(validation.sourceLabel || validation.source || '')}</strong>`
}

function escapeHtml(value) {
	return String(value || '')
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;')
}

function escapeAttr(value) {
	return escapeHtml(value)
}

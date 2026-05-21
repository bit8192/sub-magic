import { parseRuleDisplay, findRuleByConnection, addRuleLocal, addRuleRemote, updateRuleRemote, waitForRuleUpdate, waitForRulePresent, deleteRule } from '../utils/api.js'

const state = {
	domain: '',
	tabId: 0,
	mihomo: { url: '', secret: '' },
	subMagic: { url: '', accessKey: '' },
	proxyGroups: [],
	ruleMode: null,
	editingRule: null,
}

let pollTimer = null

document.addEventListener('DOMContentLoaded', async () => {
	await loadSettings()
	await initCurrentTab()

	document.getElementById('btn-add-rule').addEventListener('click', handleAddRule)
	document.getElementById('btn-save-rule').addEventListener('click', handleSaveRule)
	document.getElementById('btn-delete-rule').addEventListener('click', handleDeleteRule)
	document.getElementById('btn-back-routing').addEventListener('click', showRoutingPanel)
	document.getElementById('btn-settings').addEventListener('click', () => chrome.runtime.openOptionsPage())
	document.getElementById('rule-type').addEventListener('change', onRuleTypeChange)

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
		startRoutingPoll()
	}

	window.addEventListener('pagehide', () => {
		if (pollTimer) clearInterval(pollTimer)
	})
})

async function loadSettings() {
	const data = await chrome.storage.sync.get(['mihomoUrl', 'mihomoSecret', 'subMagicUrl', 'subMagicKey'])
	if (data.mihomoUrl) state.mihomo.url = data.mihomoUrl
	if (data.mihomoSecret) state.mihomo.secret = data.mihomoSecret
	if (data.subMagicUrl) state.subMagic.url = data.subMagicUrl
	if (data.subMagicKey) state.subMagic.accessKey = data.subMagicKey

	const statusEl = document.getElementById('status-text')
	const hasMihomo = !!state.mihomo.url
	const hasSubMagic = !!(state.subMagic.url && state.subMagic.accessKey)

	if (hasMihomo || hasSubMagic) {
		statusEl.textContent = hasMihomo && hasSubMagic ? '已配置' : '部分配置'
		statusEl.className = 'status configured'
	} else {
		statusEl.textContent = '未配置'
		statusEl.className = 'status unconfigured'
	}

	document.getElementById('routing-section').style.display = hasMihomo ? '' : 'none'
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

async function startRoutingPoll() {
	const statusEl = document.getElementById('routing-status')
	statusEl.textContent = '获取中...'
	statusEl.className = 'routing-status loading'

	const resp = await chrome.runtime.sendMessage({ type: 'POLL', tabId: state.tabId })
	handleBackgroundResponse(resp)

	pollTimer = setInterval(async () => {
		const resp = await chrome.runtime.sendMessage({ type: 'POLL', tabId: state.tabId })
		handleBackgroundResponse(resp)
	}, 2000)
}

function handleBackgroundResponse(resp) {
	if (!resp) return
	if (resp.proxyGroups) {
		state.proxyGroups = resp.proxyGroups
		populateProxyOptions()
	}
	if (resp.data) {
		updateRoutingDisplay(resp.data)
	}
}

function populateProxyOptions() {
	const select = document.getElementById('rule-proxy-select')
	const currentValue = getProxyValue()
	let options = ''
	for (const g of state.proxyGroups) {
		const selected = g.now ? ` (${g.now})` : ''
		options += `<option value="${escHtml(g.name)}">${escHtml(g.name)}${selected}</option>`
	}
	options += `<option value="DIRECT">DIRECT</option>`
	options += `<option value="REJECT">REJECT</option>`
	options += `<option value="REJECT-DROP">REJECT-DROP</option>`
	options += `<option value="__custom__">自定义...</option>`
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
	if (state.proxyGroups.some(g => g.name === value) || ['DIRECT', 'REJECT', 'REJECT-DROP'].includes(value)) {
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
		return
	}

	statusEl.textContent = `监控中 · 命中 ${data.total} 连接 · ${data.groups.length} 组`
	statusEl.className = 'routing-status connected'

	let html = ''
	for (const g of data.groups) {
		const ruleStr = g.rule ? formatRule(g.rule, g.rulePayload) : ''
		const chainStr = g.chain.length > 0 ? [...g.chain].reverse().join(' → ') : 'DIRECT'

		html += `<div class="route-card">
			<div class="route-header">
				<span class="route-count">${g.count}</span>
				<span class="route-host" title="${g.host}">${escHtml(g.host)}</span>
			</div>
			<div class="route-chain-line">${escHtml(chainStr)}</div>`
		if (ruleStr) {
			html += `<div class="route-rule-line" data-rule="${escHtml(g.rule)}" data-rule-payload="${escHtml(g.rulePayload || '')}">${escHtml(ruleStr)}</div>`
		}
		html += `</div>`
	}

	resultEl.innerHTML = html

	resultEl.querySelectorAll('.route-host').forEach(el => {
		el.addEventListener('click', () => showAddPanel(el.textContent.trim()))
	})
	resultEl.querySelectorAll('.route-rule-line').forEach(el => {
		const rule = el.getAttribute('data-rule') || ''
		if (rule) {
			const rulePayload = el.getAttribute('data-rule-payload') || ''
			el.addEventListener('click', () => handleEditRuleClick(rule, rulePayload))
		}
	})
}

function showRoutingPanel() {
	document.getElementById('routing-section').style.display = ''
	document.getElementById('rule-section').style.display = 'none'
	state.ruleMode = null
	state.editingRule = null
}

function showAddPanel(domain) {
	document.getElementById('routing-section').style.display = 'none'
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

function clearRuleResult() {
	const resultEl = document.getElementById('rule-result')
	resultEl.textContent = ''
	resultEl.className = 'result-box'
}

function formatRule(rule, rulePayload) {
	if (!rule) return ''
	const i = rule.indexOf(',')
	if (i === -1) return rulePayload ? `${rule}:${rulePayload}` : rule
	return rule.substring(0, i) + ':' + (rulePayload || rule.substring(i + 1))
}

function escHtml(s) {
	return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
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
	} catch (e) {
		showEditPanel(fallbackRule)
		resultEl.textContent = `读取原始规则失败: ${e.message}`
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
			} catch (e) {
				messages.push(`本地添加失败: ${e.message}`)
			}
		}
		if (hasRemote) {
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
			} catch (e) {
				messages.push(`远程添加失败: ${e.message}`)
			}
		}

		resultEl.textContent = messages.join('\n')
		resultEl.className = messages.some(message => message.includes('失败') || message.includes('未检测到')) ? 'result-box error' : 'result-box success'
	} catch (e) {
		resultEl.textContent = `操作失败: ${e.message}`
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
	} catch (e) {
		resultEl.textContent = `远程修改失败: ${e.message}`
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
	} catch (e) {
		resultEl.textContent = `删除失败: ${e.message}`
		resultEl.className = 'result-box error'
	}
}

import { queryRouting, addRuleLocal, addRuleRemote, getCurrentTabDomain } from '../utils/api.js'

const state = {
	domain: '',
	routingData: null,
	mihomo: { url: '', secret: '' },
	subMagic: { url: '', accessKey: '' },
}

document.addEventListener('DOMContentLoaded', async () => {
	await loadSettings()
	await initCurrentTab()

	document.getElementById('btn-query-routing').addEventListener('click', handleQueryRouting)
	document.getElementById('btn-add-rule-local').addEventListener('click', () => handleAddRule('local'))
	document.getElementById('btn-add-rule-remote').addEventListener('click', () => handleAddRule('remote'))
	document.getElementById('btn-add-rule-both').addEventListener('click', () => handleAddRule('both'))
	document.getElementById('btn-settings').addEventListener('click', () => chrome.runtime.openOptionsPage())

	document.getElementById('rule-type').addEventListener('change', onRuleTypeChange)
})

async function loadSettings() {
	const data = await chrome.storage.sync.get(['mihomoUrl', 'mihomoSecret', 'subMagicUrl', 'subMagicKey'])
	if (data.mihomoUrl) state.mihomo.url = data.mihomoUrl
	if (data.mihomoSecret) state.mihomo.secret = data.mihomoSecret
	if (data.subMagicUrl) state.subMagic.url = data.subMagicUrl
	if (data.subMagicKey) state.subMagic.accessKey = data.subMagicKey

	const statusEl = document.getElementById('status-text')
	const hasMihomo = !!(state.mihomo.url && state.mihomo.secret)
	const hasSubMagic = !!(state.subMagic.url && state.subMagic.accessKey)

	if (hasMihomo || hasSubMagic) {
		statusEl.textContent = hasMihomo && hasSubMagic ? '已配置' : '部分配置'
		statusEl.className = 'status configured'
	} else {
		statusEl.textContent = '未配置'
		statusEl.className = 'status unconfigured'
	}

	document.getElementById('routing-section').style.display = hasMihomo ? '' : 'none'
	document.getElementById('rule-section').style.display = (hasMihomo || hasSubMagic) ? '' : 'none'
}

async function initCurrentTab() {
	const domain = await getCurrentTabDomain()
	state.domain = domain || ''
	document.getElementById('current-domain').textContent = state.domain || '未知'

	if (state.domain) {
		document.getElementById('rule-payload').value = state.domain
	}
}

function onRuleTypeChange() {
	const type = document.getElementById('rule-type').value
	const payloadGroup = document.getElementById('payload-group')
	if (type === 'MATCH') {
		payloadGroup.style.display = 'none'
	} else {
		payloadGroup.style.display = ''
	}
}

async function handleQueryRouting() {
	const resultEl = document.getElementById('routing-result')
	resultEl.textContent = ''
	resultEl.className = 'result-box'

	if (!state.mihomo.url || !state.mihomo.secret) {
		resultEl.textContent = '请先在设置中配置 mihomo API'
		resultEl.className = 'result-box error'
		return
	}

	resultEl.innerHTML = '<span class="spinner"></span>查询中...'

	try {
		const data = await queryRouting(state.mihomo.url, state.mihomo.secret, state.domain)
		state.routingData = data

		let display = ''
		if (data.connections && data.connections.length > 0) {
			display += '=== 活跃连接 ===\n'
			for (const conn of data.connections) {
				display += `${conn.metadata?.host || conn.id} → ${conn.chains?.join(' → ') || conn.rule}\n`
			}
		}
		if (data.matchedRule) {
			display += `\n=== 匹配规则 ===\n${data.matchedRule}\n`
		}
		if (data.allRules && data.allRules.length > 0) {
			display += `\n=== 全部规则 (${data.allRules.length}) ===\n`
			for (const r of data.allRules.slice(0, 20)) {
				display += `${r.type || r}\n`
			}
			if (data.allRules.length > 20) display += `... 还有 ${data.allRules.length - 20} 条\n`
		}
		if (!display) display = '未找到相关连接/规则'

		resultEl.textContent = display
		resultEl.className = 'result-box success'
	} catch (e) {
		resultEl.textContent = `查询失败: ${e.message}`
		resultEl.className = 'result-box error'
	}
}

async function handleAddRule(target) {
	const resultEl = document.getElementById('rule-result')
	resultEl.textContent = ''
	resultEl.className = 'result-box'

	const ruleType = document.getElementById('rule-type').value
	const rulePayload = ruleType === 'MATCH' ? 'MATCH' : document.getElementById('rule-payload').value.trim()
	const ruleProxy = document.getElementById('rule-proxy').value.trim()

	if (ruleType !== 'MATCH' && !rulePayload) {
		resultEl.textContent = '请填写匹配值'
		resultEl.className = 'result-box error'
		return
	}
	if (!ruleProxy) {
		resultEl.textContent = '请填写代理组/策略'
		resultEl.className = 'result-box error'
		return
	}

	const ruleStr = ruleType === 'MATCH' ? 'MATCH,' + ruleProxy : `${ruleType},${rulePayload},${ruleProxy}`

	const messages = []
	resultEl.innerHTML = '<span class="spinner"></span>添加中...'

	try {
		if (target === 'local' || target === 'both') {
			try {
				await addRuleLocal(state.mihomo.url, state.mihomo.secret, ruleStr)
				messages.push('本地添加成功')
			} catch (e) {
				messages.push(`本地添加失败: ${e.message}`)
			}
		}
		if (target === 'remote' || target === 'both') {
			try {
				await addRuleRemote(state.subMagic.url, state.subMagic.accessKey, ruleStr)
				messages.push('远程添加成功')
			} catch (e) {
				messages.push(`远程添加失败: ${e.message}`)
			}
		}

		resultEl.textContent = messages.join('\n')
		resultEl.className = 'result-box success'
	} catch (e) {
		resultEl.textContent = `操作失败: ${e.message}`
		resultEl.className = 'result-box error'
	}
}

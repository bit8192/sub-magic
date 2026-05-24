export async function getCurrentTabDomain() {
	const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
	if (!tabs || tabs.length === 0) return null
	const url = tabs[0].url || ''
	try {
		return new URL(url).hostname
	} catch {
		return null
	}
}

async function mihomoFetch(url, secret, path, options = {}) {
	let baseUrl = url.trim()
	if (!/^https?:\/\//i.test(baseUrl)) {
		baseUrl = 'http://' + baseUrl
	}
	baseUrl = baseUrl.replace(/\/+$/, '')
	const headers = { ...options.headers }
	if (secret) {
		headers.Authorization = `Bearer ${secret}`
	}
	const res = await fetch(`${baseUrl}${path}`, { ...options, headers })
	if (!res.ok) {
		const text = await res.text()
		throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
	}

	if (res.status === 204) return null

	const text = await res.text()
	if (!text) return null

	const contentType = res.headers.get('content-type') || ''
	if (contentType.includes('application/json')) {
		return JSON.parse(text)
	}

	try {
		return JSON.parse(text)
	} catch {
		return text
	}
}

function groupConnections(data, domain) {
	const rawConns = data.connections || []
	if (!domain) return { total: 0, groups: [], status: 'no_domain' }

	const filtered = rawConns.filter(c => {
		const host = c.metadata?.host || c.metadata?.sniffHost || ''
		return host.includes(domain) || host.includes(domain.replace(/^www\./, ''))
	})

	const groupMap = new Map()
	for (const conn of filtered) {
		const host = conn.metadata?.host || conn.metadata?.sniffHost || ''
		const rule = conn.rule || ''
		const key = `${host}\0${rule}`

		if (!groupMap.has(key)) {
			const chain = conn.chains || conn.chain || []
			groupMap.set(key, {
				host,
				rule,
				count: 0,
				chain: Array.isArray(chain) ? chain : [],
				rulePayload: conn.rulePayload || '',
			})
		}
		groupMap.get(key).count++
	}

	const groups = Array.from(groupMap.values()).sort((a, b) => b.count - a.count)

	return {
		total: filtered.length,
		groups,
		status: 'connected',
	}
}

function normalizeRuleType(type) {
	if (!type) return ''

	const exactMap = {
		DomainSuffix: 'DOMAIN-SUFFIX',
		Domain: 'DOMAIN',
		DomainKeyword: 'DOMAIN-KEYWORD',
		GeoSite: 'GEOSITE',
		GeoIP: 'GEOIP',
		InPort: 'IN-PORT',
		InType: 'IN-TYPE',
		InUser: 'IN-USER',
		InName: 'IN-NAME',
		IPCIDR: 'IP-CIDR',
		SrcIPCIDR: 'SRC-IP-CIDR',
		RuleSet: 'RULE-SET',
		Match: 'MATCH',
	}

	if (exactMap[type]) return exactMap[type]

	const upper = type.toUpperCase()
	if (upper === 'IPCIDR') return 'IP-CIDR'
	if (upper === 'SRCIPCIDR') return 'SRC-IP-CIDR'
	if (upper === 'INPORT') return 'IN-PORT'
	if (upper === 'INTYPE') return 'IN-TYPE'
	if (upper === 'INUSER') return 'IN-USER'
	if (upper === 'INNAME') return 'IN-NAME'
	return upper
}

function ruleEntryToString(ruleEntry) {
	if (!ruleEntry) return ''
	if (typeof ruleEntry === 'string') return ruleEntry
	if (typeof ruleEntry !== 'object') return String(ruleEntry)

	if (typeof ruleEntry.rule === 'string') return ruleEntry.rule

	const type = normalizeRuleType(ruleEntry.type || ruleEntry.ruleType || '')
	if (!type) return ''

	const target = ruleEntry.target || ruleEntry.proxy || ruleEntry.adapter || ruleEntry.policy || ''
	const payload = ruleEntry.payload || ruleEntry.rulePayload || ruleEntry.value || ''
	const noResolve = !!ruleEntry.noResolve || !!ruleEntry.no_resolve

	if (type === 'MATCH') {
		return target ? `MATCH,${target}` : 'MATCH'
	}

	const base = [type, payload, target].filter(Boolean).join(',')
	return noResolve ? `${base},no-resolve` : base
}

function normalizeRules(rules) {
	return (rules || []).map(ruleEntryToString).filter(Boolean)
}

function getInsertIndex(currentRules, previousRule = '') {
	if (!previousRule) return 0
	const previousIdx = currentRules.indexOf(previousRule)
	return previousIdx === -1 ? currentRules.length : previousIdx + 1
}

function getMatchRuleIndex(currentRules) {
	return currentRules.findIndex((rule) => parseRuleDisplay(rule).type === 'MATCH')
}

function isRulePrioritySatisfied(currentRules, ruleStr, previousRule = '') {
	const ruleIdx = currentRules.indexOf(ruleStr)
	if (ruleIdx === -1) return false
	if (!previousRule) return ruleIdx === 0
	return ruleIdx > 0 && currentRules[ruleIdx - 1] === previousRule
}

export function parseRuleDisplay(ruleStr) {
	const normalizedRule = ruleEntryToString(ruleStr)
	if (!normalizedRule) return { type: '', payload: '', target: '', noResolve: false }
	const parts = normalizedRule.split(',')
	const type = normalizeRuleType(parts[0] || '')
	const noResolve = parts.slice(3).some(p => p.trim().toLowerCase() === 'no-resolve')
	if (type === 'MATCH') return { type, payload: '', target: parts[1] || '', noResolve: false }
	const targetIndex = noResolve ? parts.length - 2 : parts.length - 1
	const target = parts.length > 2 ? (parts[targetIndex] || '') : ''
	const payload = type === 'GEOSITE' || type === 'GEOIP'
		? (parts[1] || '')
		: (parts.slice(1, noResolve ? -2 : -1).join(',') || parts[1] || '')
	return { type, payload, target, noResolve }
}

export async function findRuleByConnection(mihomoUrl, secret, ruleType, rulePayload) {
	const normalizedType = normalizeRuleType(ruleType)
	if (!normalizedType) return ''

	const rulesRes = await mihomoFetch(mihomoUrl, secret, '/rules')
	const currentRules = normalizeRules(rulesRes.rules)

	for (const rawRule of currentRules) {
		const parsed = parseRuleDisplay(rawRule)
		if (parsed.type !== normalizedType) continue
		if (normalizedType === 'MATCH') return rawRule
		if (parsed.payload === (rulePayload || '')) return rawRule
	}

	return ''
}

export function monitorConnections(mihomoUrl, secret, domain, onUpdate, onError) {
	let timer = null
	let closed = false
	let failCount = 0

	async function poll() {
		if (closed) return
		try {
			const data = await mihomoFetch(mihomoUrl, secret, '/connections')
			failCount = 0
			const grouped = groupConnections(data, domain)
			onUpdate(grouped)
		} catch (e) {
			failCount++
			if (failCount >= 3) {
				onError && onError(`连接失败: ${e.message}`)
				onUpdate({ total: 0, groups: [], status: 'disconnected' })
			} else {
				onUpdate({ total: 0, groups: [], status: 'fetching' })
			}
		}
	}

	poll()
	timer = setInterval(poll, 2000)

	return () => {
		closed = true
		if (timer) clearInterval(timer)
		timer = null
	}
}

export async function getLocalRules(mihomoUrl, secret) {
	const rulesRes = await mihomoFetch(mihomoUrl, secret, '/rules')
	return normalizeRules(rulesRes.rules)
}

export async function addRuleLocal(mihomoUrl, secret, ruleStr, previousRule = '') {
	const currentRules = await getLocalRules(mihomoUrl, secret)
	const insertIdx = getInsertIndex(currentRules, previousRule)

	const newRules = [...currentRules]
	newRules.splice(insertIdx, 0, ruleStr)

	const configRes = await mihomoFetch(mihomoUrl, secret, '/configs')
	const currentConfig = configRes || {}

	const updatedConfig = { ...currentConfig, rules: newRules }

	await mihomoFetch(mihomoUrl, secret, '/configs?force=true', {
		method: 'PUT',
		body: JSON.stringify(updatedConfig),
	})

	return { ok: true }
}

export async function getProxyGroups(url, secret) {
	const data = await mihomoFetch(url, secret, '/proxies')
	const proxies = data.proxies || {}
	return Object.values(proxies)
		.filter(p => p?.name && p.type && p.type !== 'Direct' && p.type !== 'Reject')
		.map(p => ({ name: p.name, type: p.type, now: p.now || '' }))
}

export async function getProxySnapshot(url, secret) {
	const data = await mihomoFetch(url, secret, '/proxies')
	return data.proxies || {}
}

export async function getMihomoConfigs(url, secret) {
	return mihomoFetch(url, secret, '/configs')
}

function normalizeAuthUsers(authentication) {
	if (!Array.isArray(authentication)) return []
	return authentication
		.map((entry) => {
			if (typeof entry !== 'string') return null
			const separatorIndex = entry.indexOf(':')
			if (separatorIndex === -1) return null
			const username = entry.slice(0, separatorIndex).trim()
			const password = entry.slice(separatorIndex + 1)
			return username ? { username, password } : null
		})
		.filter(Boolean)
}

function serializeAuthUsers(users) {
	return users.map((user) => `${user.username}:${user.password}`)
}

function buildIpCheckRuleProvider(domains) {
	return {
		type: 'inline',
		behavior: 'classical',
		format: 'yaml',
		payload: ensureUniqueValues(domains).map((domain) => `DOMAIN-SUFFIX,${domain}`),
	}
}

function buildIpCheckRule(providerName = 'IpCheck', groupName = 'IpCheck', username = 'IpCheck') {
	return `AND,((IN-USER,${username}),(RULE-SET,${providerName})),${groupName}`
}

function ensureUniqueValues(values) {
	return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))]
}

function findIpCheckRuleAnchor(currentRules) {
	let anchor = ''
	for (const rule of currentRules) {
		const parsed = parseRuleDisplay(rule)
		if (parsed.type !== 'GEOIP') continue
		const payload = String(parsed.payload || '').trim().toUpperCase()
		if (payload === 'LAN' || payload === 'PRIVATE') {
			anchor = rule
		}
	}
	return anchor
}

function removeManagedIpCheckRules(currentRules, providerName = 'IpCheck', groupName = 'IpCheck', username = 'IpCheck') {
	const canonicalRule = buildIpCheckRule(providerName, groupName, username)
	return currentRules.filter((rule) => {
		const normalized = String(rule || '').trim()
		if (!normalized) return false
		if (normalized === canonicalRule) return false
		if (normalized.includes(`IN-USER,${username}`) && normalized.endsWith(`,${groupName}`)) return false
		if (normalized.startsWith(`RULE-SET,${providerName},`) && normalized.endsWith(`,${groupName}`)) return false
		return true
	})
}

function insertRuleWithAnchor(currentRules, rule, anchor = '') {
	const nextRules = [...currentRules]
	const insertIdx = anchor ? getInsertIndex(nextRules, anchor) : 0
	nextRules.splice(insertIdx, 0, rule)
	return nextRules
}

export async function ensureIpCheckLocalConfig(mihomoUrl, secret, options = {}) {
	const targetGroup = String(options.targetGroup || '').trim()
	const username = String(options.username || 'IpCheck').trim()
	const password = String(options.password || '').trim()
	const groupName = String(options.groupName || 'IpCheck').trim()
	const providerName = String(options.providerName || groupName).trim()
	const domains = ensureUniqueValues(options.domains || [])

	if (!targetGroup) throw new Error('targetGroup is required')
	if (!username) throw new Error('username is required')
	if (!password) throw new Error('password is required')
	if (!groupName) throw new Error('groupName is required')
	if (!providerName) throw new Error('providerName is required')

	const currentConfig = (await getMihomoConfigs(mihomoUrl, secret)) || {}
	const authUsers = normalizeAuthUsers(currentConfig.authentication)
	const existingAuth = authUsers.find((item) => item.username === username) || null
	const nextPassword = existingAuth?.password || password
	let changed = false

	if (!existingAuth) {
		authUsers.push({ username, password: nextPassword })
		changed = true
	}

	const currentGroups = Array.isArray(currentConfig['proxy-groups']) ? [...currentConfig['proxy-groups']] : []
	const groupIdx = currentGroups.findIndex((group) => String(group?.name || '') === groupName)
	if (groupIdx === -1) {
		currentGroups.push({
			name: groupName,
			type: 'select',
			'include-all': true,
			'include-all-proxies': true,
		})
		changed = true
	} else {
		const group = currentGroups[groupIdx] || {}
		if (String(group.type || '').toLowerCase() !== 'select') {
			throw new Error(`本地代理组 ${groupName} 已存在且类型不是 select`)
		}
		const nextGroup = {
			...group,
			name: groupName,
			type: 'select',
			'include-all': true,
			'include-all-proxies': true,
		}
		delete nextGroup.hidden
		if (JSON.stringify(nextGroup) !== JSON.stringify(group)) {
			currentGroups[groupIdx] = nextGroup
			changed = true
		}
	}

	const currentProviders = (currentConfig['rule-providers'] && typeof currentConfig['rule-providers'] === 'object')
		? { ...currentConfig['rule-providers'] }
		: {}
	const nextProvider = buildIpCheckRuleProvider(domains)
	if (JSON.stringify(currentProviders[providerName] || {}) !== JSON.stringify(nextProvider)) {
		currentProviders[providerName] = nextProvider
		changed = true
	}

	const currentRules = normalizeRules(currentConfig.rules)
	const anchor = findIpCheckRuleAnchor(currentRules)
	const baseRules = removeManagedIpCheckRules(currentRules, providerName, groupName, username)
	const canonicalRule = buildIpCheckRule(providerName, groupName, username)
	const nextRules = insertRuleWithAnchor(baseRules, canonicalRule, anchor)
	if (JSON.stringify(nextRules) !== JSON.stringify(currentRules)) {
		changed = true
	}

	if (changed) {
		await mihomoFetch(mihomoUrl, secret, '/configs?force=true', {
			method: 'PUT',
			body: JSON.stringify({
				...currentConfig,
				authentication: serializeAuthUsers(authUsers),
				'rule-providers': currentProviders,
				'proxy-groups': currentGroups,
				rules: nextRules,
			}),
		})
	}

	return {
		ok: true,
		changed,
		authUser: { username, password: nextPassword },
		groupName,
		targetGroup,
	}
}

export async function getProxyProviders(url, secret) {
	const data = await mihomoFetch(url, secret, '/providers/proxies')
	return data.providers || {}
}

export async function setProxySelector(url, secret, proxyName, targetName) {
	await mihomoFetch(url, secret, `/proxies/${encodeURIComponent(proxyName)}`, {
		method: 'PUT',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ name: targetName }),
	})

	return { ok: true }
}

export async function closeConnection(url, secret, connectionId) {
	const id = String(connectionId || '').trim()
	if (!id) {
		throw new Error('connectionId is required')
	}

	await mihomoFetch(url, secret, `/connections/${encodeURIComponent(id)}`, {
		method: 'DELETE',
	})

	return { ok: true, id }
}

export async function updateRule(mihomoUrl, secret, oldRule, newRule) {
	const rulesRes = await mihomoFetch(mihomoUrl, secret, '/rules')
	const currentRules = normalizeRules(rulesRes.rules)
	const idx = currentRules.indexOf(oldRule)
	if (idx === -1) throw new Error('未找到对应规则')

	const newRules = [...currentRules]
	newRules[idx] = newRule

	const configRes = await mihomoFetch(mihomoUrl, secret, '/configs')
	const currentConfig = configRes || {}
	const updatedConfig = { ...currentConfig, rules: newRules }

	await mihomoFetch(mihomoUrl, secret, '/configs?force=true', {
		method: 'PUT',
		body: JSON.stringify(updatedConfig),
	})

	return { ok: true }
}

export async function waitForRuleUpdate(mihomoUrl, secret, oldRule, newRule, previousRule = '', maxChecks = 30, intervalMs = 1000) {
	for (let i = 0; i < maxChecks; i++) {
		await new Promise(resolve => setTimeout(resolve, intervalMs))
		const currentRules = await getLocalRules(mihomoUrl, secret)
		const hasNewRule = isRulePrioritySatisfied(currentRules, newRule, previousRule)
		const hasOldRule = oldRule === newRule ? false : currentRules.includes(oldRule)

		if (hasNewRule && !hasOldRule) {
			return { ok: true, attempts: i + 1 }
		}
	}

	return { ok: false, attempts: maxChecks }
}

export async function waitForRulePresent(mihomoUrl, secret, ruleStr, previousRule = '', maxChecks = 30, intervalMs = 1000) {
	for (let i = 0; i < maxChecks; i++) {
		await new Promise(resolve => setTimeout(resolve, intervalMs))
		const currentRules = await getLocalRules(mihomoUrl, secret)

		if (isRulePrioritySatisfied(currentRules, ruleStr, previousRule)) {
			return { ok: true, attempts: i + 1 }
		}
	}

	return { ok: false, attempts: maxChecks }
}

export async function deleteRule(mihomoUrl, secret, ruleStr) {
	const rulesRes = await mihomoFetch(mihomoUrl, secret, '/rules')
	const currentRules = normalizeRules(rulesRes.rules)
	const newRules = currentRules.filter(r => r !== ruleStr)

	const configRes = await mihomoFetch(mihomoUrl, secret, '/configs')
	const currentConfig = configRes || {}
	const updatedConfig = { ...currentConfig, rules: newRules }

	await mihomoFetch(mihomoUrl, secret, '/configs?force=true', {
		method: 'PUT',
		body: JSON.stringify(updatedConfig),
	})

	return { ok: true }
}

export async function addRuleRemote(subMagicUrl, accessKey, ruleStr, previousRule = '') {
	const baseUrl = subMagicUrl.replace(/\/+$/, '')
	const res = await fetch(`${baseUrl}/api/rules/add`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${accessKey}`,
		},
		body: JSON.stringify({ rule: ruleStr, insertAfter: previousRule }),
	})

	if (!res.ok) {
		const text = await res.text()
		throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
	}

	return res.json()
}

export async function updateRuleRemote(subMagicUrl, accessKey, oldRule, newRule, previousRule = '') {
	const baseUrl = subMagicUrl.replace(/\/+$/, '')
	const res = await fetch(`${baseUrl}/api/rules/update`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${accessKey}`,
		},
		body: JSON.stringify({ oldRule, newRule, insertAfter: previousRule }),
	})

	if (!res.ok) {
		const text = await res.text()
		throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
	}

	const text = await res.text()
	return text ? JSON.parse(text) : { ok: true }
}

export async function getRemoteProxyGroups(subMagicUrl, accessKey) {
	return subMagicFetch(subMagicUrl, accessKey, '/api/config/proxy-groups')
}

export async function getRemoteRuleProviders(subMagicUrl, accessKey) {
	return subMagicFetch(subMagicUrl, accessKey, '/api/config/rule-providers')
}

export async function createRemoteRuleProvider(subMagicUrl, accessKey, provider) {
	return subMagicFetch(subMagicUrl, accessKey, '/api/config/rule-providers', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(provider),
	})
}

export async function updateRemoteRuleProvider(subMagicUrl, accessKey, name, provider) {
	return subMagicFetch(subMagicUrl, accessKey, `/api/config/rule-providers/${encodeURIComponent(name)}`, {
		method: 'PUT',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(provider),
	})
}

export async function createRemoteProxyGroup(subMagicUrl, accessKey, group) {
	return subMagicFetch(subMagicUrl, accessKey, '/api/config/proxy-groups', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(group),
	})
}

export async function updateRemoteProxyGroup(subMagicUrl, accessKey, name, group) {
	return subMagicFetch(subMagicUrl, accessKey, `/api/config/proxy-groups/${encodeURIComponent(name)}`, {
		method: 'PUT',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(group),
	})
}

export async function getRemoteRules(subMagicUrl, accessKey) {
	return subMagicFetch(subMagicUrl, accessKey, '/api/config/rules')
}

export async function replaceRemoteRules(subMagicUrl, accessKey, rules) {
	return subMagicFetch(subMagicUrl, accessKey, '/api/config/rules', {
		method: 'PUT',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ rules }),
	})
}

export async function createProxyAuthUser(subMagicUrl, accessKey, user) {
	return subMagicFetch(subMagicUrl, accessKey, '/api/config/proxy-auth-users', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(user),
	})
}

export async function ensureIpCheckRemoteConfig(subMagicUrl, accessKey, options = {}) {
	const targetGroup = String(options.targetGroup || '').trim()
	const username = String(options.username || 'IpCheck').trim()
	const password = String(options.password || '').trim()
	const groupName = String(options.groupName || 'IpCheck').trim()
	const providerName = String(options.providerName || groupName).trim()
	const domains = ensureUniqueValues(options.domains || [])

	if (!targetGroup) throw new Error('targetGroup is required')
	if (!username) throw new Error('username is required')
	if (!password) throw new Error('password is required')
	if (!groupName) throw new Error('groupName is required')
	if (!providerName) throw new Error('providerName is required')

	let changed = false
	const remoteUsers = await getProxyAuthUsers(subMagicUrl, accessKey)
	const users = Array.isArray(remoteUsers) ? remoteUsers : []
	let authUser = users.find((item) => String(item?.username || '') === username) || null
	if (!authUser) {
		await createProxyAuthUser(subMagicUrl, accessKey, { username, password })
		authUser = { username, password }
		changed = true
	}

	const remoteGroups = await getRemoteProxyGroups(subMagicUrl, accessKey)
	const groups = Array.isArray(remoteGroups) ? remoteGroups : []
	const existingGroup = groups.find((group) => String(group?.name || '') === groupName) || null
	if (!existingGroup) {
		await createRemoteProxyGroup(subMagicUrl, accessKey, {
			name: groupName,
			type: 'select',
			'include-all': true,
			'include-all-proxies': true,
		})
		changed = true
	} else {
		if (String(existingGroup.type || '').toLowerCase() !== 'select') {
			throw new Error(`远程代理组 ${groupName} 已存在且类型不是 select`)
		}
		const nextGroup = {
			...existingGroup,
			name: groupName,
			type: 'select',
			'include-all': true,
			'include-all-proxies': true,
		}
		delete nextGroup.hidden
		if (JSON.stringify(nextGroup) !== JSON.stringify(existingGroup)) {
			await updateRemoteProxyGroup(subMagicUrl, accessKey, groupName, {
				...nextGroup,
			})
			changed = true
		}
	}

	const remoteProviders = await getRemoteRuleProviders(subMagicUrl, accessKey)
	const providers = Array.isArray(remoteProviders) ? remoteProviders : []
	const existingProvider = providers.find((provider) => String(provider?.name || '') === providerName) || null
	const nextProvider = buildIpCheckRuleProvider(domains)
	if (!existingProvider) {
		await createRemoteRuleProvider(subMagicUrl, accessKey, {
			name: providerName,
			...nextProvider,
		})
		changed = true
	} else {
		const currentProviderData = { ...existingProvider }
		delete currentProviderData.name
		if (JSON.stringify(currentProviderData) !== JSON.stringify(nextProvider)) {
			await updateRemoteRuleProvider(subMagicUrl, accessKey, providerName, nextProvider)
			changed = true
		}
	}

	const remoteRules = await getRemoteRules(subMagicUrl, accessKey)
	const currentRules = Array.isArray(remoteRules)
		? remoteRules.map((item) => ruleEntryToString(item?.raw || item)).filter(Boolean)
		: []
	const anchor = findIpCheckRuleAnchor(currentRules)
	const baseRules = removeManagedIpCheckRules(currentRules, providerName, groupName, username)
	const canonicalRule = buildIpCheckRule(providerName, groupName, username)
	const nextRules = insertRuleWithAnchor(baseRules, canonicalRule, anchor)
	if (JSON.stringify(nextRules) !== JSON.stringify(currentRules)) {
		await replaceRemoteRules(subMagicUrl, accessKey, nextRules)
		changed = true
	}

	return {
		ok: true,
		changed,
		authUser: { username: authUser.username, password: authUser.password || password },
		groupName,
		targetGroup,
	}
}

async function subMagicFetch(subMagicUrl, accessKey, path, options = {}) {
	const baseUrl = subMagicUrl.trim().replace(/\/+$/, '')
	const headers = { ...options.headers }
	if (accessKey) {
		headers.Authorization = `Bearer ${accessKey}`
	}
	const res = await fetch(`${baseUrl}${path}`, { ...options, headers })
	if (!res.ok) {
		const text = await res.text()
		throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
	}

	const text = await res.text()
	return text ? JSON.parse(text) : null
}

export async function getProxyAuthUsers(subMagicUrl, accessKey) {
	return subMagicFetch(subMagicUrl, accessKey, '/api/config/proxy-auth-users')
}

export async function getListeners(subMagicUrl, accessKey) {
	return subMagicFetch(subMagicUrl, accessKey, '/api/config/listeners')
}

export async function getExternalUiConfig(subMagicUrl, accessKey) {
	return subMagicFetch(subMagicUrl, accessKey, '/api/config/external-ui')
}

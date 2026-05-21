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
		IPCIDR: 'IP-CIDR',
		SrcIPCIDR: 'SRC-IP-CIDR',
		RuleSet: 'RULE-SET',
		Match: 'MATCH',
	}

	if (exactMap[type]) return exactMap[type]

	const upper = type.toUpperCase()
	if (upper === 'IPCIDR') return 'IP-CIDR'
	if (upper === 'SRCIPCIDR') return 'SRC-IP-CIDR'
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

export async function addRuleLocal(mihomoUrl, secret, ruleStr) {
	const rulesRes = await mihomoFetch(mihomoUrl, secret, '/rules')
	const currentRules = normalizeRules(rulesRes.rules)

	const insertIdx = currentRules.length > 0 ? currentRules.length - 1 : 0

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
	const data = await mihomoFetch(url, secret, '/group')
	const proxies = data.proxies || []
	return proxies
		.filter(p => p.type && p.type !== 'Direct' && p.type !== 'Reject')
		.map(p => ({ name: p.name, type: p.type, now: p.now || '' }))
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

export async function addRuleRemote(subMagicUrl, accessKey, ruleStr) {
	const baseUrl = subMagicUrl.replace(/\/+$/, '')
	const res = await fetch(`${baseUrl}/api/rules/add-by-key`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ key: accessKey, rule: ruleStr }),
	})

	if (!res.ok) {
		const text = await res.text()
		throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
	}

	return res.json()
}

export async function updateRuleRemote(subMagicUrl, accessKey, oldRule, newRule) {
	const baseUrl = subMagicUrl.replace(/\/+$/, '')
	const res = await fetch(`${baseUrl}/api/rules/update-by-key`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ key: accessKey, oldRule, newRule }),
	})

	if (!res.ok) {
		const text = await res.text()
		throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
	}

	const text = await res.text()
	return text ? JSON.parse(text) : { ok: true }
}

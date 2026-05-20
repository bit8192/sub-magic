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
	const headers = {
		Authorization: `Bearer ${secret}`,
		...options.headers,
	}
	const res = await fetch(`http://${url}${path}`, { ...options, headers })
	if (!res.ok) {
		const text = await res.text()
		throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
	}
	return res.json()
}

export async function queryRouting(mihomoUrl, secret, domain) {
	const [connections, rules] = await Promise.all([
		mihomoFetch(mihomoUrl, secret, '/connections').catch(() => ({ connections: [] })),
		mihomoFetch(mihomoUrl, secret, '/rules').catch(() => ({ rules: [] })),
	])

	const domainConns = (connections.connections || []).filter(c => {
		const host = c.metadata?.host || c.metadata?.destinationIP || ''
		return host.includes(domain) || host.includes(domain.replace(/^www\./, ''))
	})

	const matchedRule = domainConns.length > 0 ? domainConns[0].rule : null
	const allRules = rules.rules || []

	return {
		connections: domainConns.slice(0, 10),
		matchedRule,
		allRules,
	}
}

export async function addRuleLocal(mihomoUrl, secret, ruleStr) {
	const rulesRes = await mihomoFetch(mihomoUrl, secret, '/rules')
	const currentRules = rulesRes.rules || []

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

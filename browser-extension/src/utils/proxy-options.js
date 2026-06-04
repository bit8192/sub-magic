export const DEFAULT_PROXY_TYPE = 'http'

export function normalizeListenerPort(port) {
	const value = Number(port)
	return Number.isFinite(value) ? value : 0
}

function listenerHasTls(listener) {
	return !!(
		listener?.tls ||
		listener?.['private-key'] ||
		listener?.certificate ||
		listener?.['ca-str']
	)
}

export function getSupportedProxyTypesForListenerType(listenerType, listener = null) {
	const type = String(listenerType || '').trim().toLowerCase()
	if (type === 'http') {
		return listenerHasTls(listener) ? ['http', 'https'] : ['http']
	}
	if (type === 'mixed') {
		return listenerHasTls(listener) ? ['http', 'https', 'socks5'] : ['http', 'socks5']
	}
	if (type === 'socks') return ['socks4', 'socks5']
	return []
}

export function isProxyTypeSupportedByPortOption(option, proxyType) {
	return !!option && Array.isArray(option.supportedTypes) && option.supportedTypes.includes(proxyType)
}

export function getPreferredProxyType(option, desiredType = '', fallbackType = DEFAULT_PROXY_TYPE) {
	if (isProxyTypeSupportedByPortOption(option, desiredType)) return desiredType
	if (isProxyTypeSupportedByPortOption(option, fallbackType)) return fallbackType
	return option?.supportedTypes?.[0] || fallbackType
}

export function buildAvailableProxyPortOptions(configs, listeners) {
	const options = []
	const seenIds = new Set()

	function addOption(option) {
		if (!option || seenIds.has(option.id)) return
		seenIds.add(option.id)
		options.push(option)
	}

	function addConfigOption(configKey, port, supportedTypes) {
		const normalizedPort = normalizeListenerPort(port)
		if (normalizedPort <= 0) return
		addOption({
			id: `config:${configKey}`,
			source: 'config',
			sourceLabel: `/configs ${configKey}`,
			configKey,
			listenerName: '',
			listenerType: '',
			port: normalizedPort,
			supportedTypes: [...supportedTypes],
			label: `/configs ${configKey} · ${normalizedPort}`,
		})
	}

	addConfigOption('port', configs?.port, ['http'])
	addConfigOption('socks-port', configs?.['socks-port'], ['socks4', 'socks5'])
	addConfigOption('mixed-port', configs?.['mixed-port'], ['http', 'socks5'])

	for (const listener of Array.isArray(listeners) ? listeners : []) {
		const listenerName = String(listener?.name || '').trim()
		const listenerType = String(listener?.type || '').trim().toLowerCase()
		const port = normalizeListenerPort(listener?.port)
		const supportedTypes = getSupportedProxyTypesForListenerType(listenerType, listener)
		if (!listenerName || port <= 0 || supportedTypes.length === 0) continue
		addOption({
			id: `listener:${listenerName}`,
			source: 'listener',
			sourceLabel: `listener / ${listenerName}`,
			configKey: '',
			listenerName,
			listenerType,
			port,
			supportedTypes,
			label: `${listenerName} · ${port}${listenerType ? ` · ${listenerType}` : ''}`,
		})
	}

	return options
}

export function findProxyPortOption(options, profile = {}) {
	const list = Array.isArray(options) ? options : []
	if (list.length === 0) return null

	if (profile.source === 'listener' && profile.listenerName) {
		const byListener = list.find((option) => option.source === 'listener' && option.listenerName === profile.listenerName)
		if (byListener) return byListener
	}

	const port = normalizeListenerPort(profile.port)
	if (port > 0) {
		const byPortAndType = list.find((option) => option.port === port && isProxyTypeSupportedByPortOption(option, profile.proxyType))
		if (byPortAndType) return byPortAndType

		const byPort = list.find((option) => option.port === port)
		if (byPort) return byPort
	}

	if (profile.proxyType) {
		const byType = list.find((option) => isProxyTypeSupportedByPortOption(option, profile.proxyType))
		if (byType) return byType
	}

	return list[0]
}

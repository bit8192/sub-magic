const geoBinaryCache = new Map()
const geositeIndexCache = new Map()
const geoipIndexCache = new Map()

export async function getGeoRuleSuggestions(configs, host, destinationIps = []) {
	const geox = configs?.['geox-url'] || {}
	const geositeUrl = String(geox?.['geo-site'] || '').trim()
	const geoipUrl = String(geox?.['geo-ip'] || '').trim()
	const normalizedHost = normalizeHost(host)
	const normalizedIps = normalizeIpList(destinationIps)
	const tasks = []

	if (normalizedHost && geositeUrl) {
		tasks.push(
			loadGeositeIndex(geositeUrl)
				.then(index => matchGeositeHost(index, normalizedHost))
				.catch(() => [])
		)
	}

	if (normalizedIps.length > 0 && geoipUrl) {
		tasks.push(
			loadGeoipIndex(geoipUrl)
				.then(index => matchGeoipIps(index, normalizedIps))
				.catch(() => [])
		)
	}

	if (tasks.length === 0) return []

	const results = await Promise.all(tasks)
	return dedupeSuggestions(results.flat()).slice(0, 10)
}

async function loadGeositeIndex(url) {
	if (!geositeIndexCache.has(url)) {
		geositeIndexCache.set(
			url,
			fetchGeoBinary(url).then(bytes => parseGeositeIndex(bytes))
		)
	}
	return geositeIndexCache.get(url)
}

async function loadGeoipIndex(url) {
	if (!geoipIndexCache.has(url)) {
		geoipIndexCache.set(
			url,
			fetchGeoBinary(url).then(bytes => parseGeoipIndex(bytes))
		)
	}
	return geoipIndexCache.get(url)
}

async function fetchGeoBinary(url) {
	if (!geoBinaryCache.has(url)) {
		geoBinaryCache.set(
			url,
			fetch(url, { cache: 'force-cache' })
				.then(async (res) => {
					if (!res.ok) {
						throw new Error(`HTTP ${res.status}`)
					}
					return new Uint8Array(await res.arrayBuffer())
				})
		)
	}
	return geoBinaryCache.get(url)
}

function parseGeositeIndex(bytes) {
	const decoder = new TextDecoder('utf-8', { fatal: false })
	const categories = []
	const pos = { i: 0 }

	while (pos.i < bytes.length) {
		const tag = readVarint(bytes, pos)
		if (tag === -1 || tag === 0) break
		const fieldNum = tag >> 3
		const wireType = tag & 0x7

		if (wireType !== 2) {
			if (!skipWire(bytes, pos, wireType)) break
			continue
		}

		const len = readVarint(bytes, pos)
		if (len === -1 || pos.i + len > bytes.length) break
		if (fieldNum === 1) {
			const category = parseGeositeCategory(bytes.subarray(pos.i, pos.i + len), decoder)
			if (category?.name && category.sites.length > 0) {
				categories.push(category)
			}
		}
		pos.i += len
	}

	return categories
}

function parseGeositeCategory(buf, decoder) {
	const pos = { i: 0 }
	let name = ''
	const sites = []

	while (pos.i < buf.length) {
		const tag = readVarint(buf, pos)
		if (tag === -1 || tag === 0) break
		const fieldNum = tag >> 3
		const wireType = tag & 0x7

		if (wireType === 2) {
			const len = readVarint(buf, pos)
			if (len === -1 || pos.i + len > buf.length) break
			const slice = buf.subarray(pos.i, pos.i + len)
			if (fieldNum === 1) {
				name = decodeUtf8(decoder, slice)
			} else if (fieldNum === 2) {
				const site = parseGeositeSite(slice, decoder)
				if (site?.value) sites.push(site)
			}
			pos.i += len
			continue
		}

		if (!skipWire(buf, pos, wireType)) break
	}

	return name ? { name, sites } : null
}

function parseGeositeSite(buf, decoder) {
	const pos = { i: 0 }
	let matchType = 0
	let value = ''

	while (pos.i < buf.length) {
		const tag = readVarint(buf, pos)
		if (tag === -1 || tag === 0) break
		const fieldNum = tag >> 3
		const wireType = tag & 0x7

		if (wireType === 0) {
			const num = readVarint(buf, pos)
			if (num === -1) break
			if (fieldNum === 1) {
				matchType = num
			}
			continue
		}

		if (wireType === 2) {
			const len = readVarint(buf, pos)
			if (len === -1 || pos.i + len > buf.length) break
			if (fieldNum === 2) {
				value = decodeUtf8(decoder, buf.subarray(pos.i, pos.i + len)).toLowerCase()
			}
			pos.i += len
			continue
		}

		if (!skipWire(buf, pos, wireType)) break
	}

	if (!value) return null
	return {
		matchType,
		value,
	}
}

function matchGeositeHost(categories, host) {
	const suggestions = []

	for (const category of categories) {
		let score = 0
		for (const site of category.sites) {
			const siteScore = getGeositeMatchScore(site, host)
			if (siteScore > score) score = siteScore
			if (score >= 100) break
		}
		if (score === 0) continue
		suggestions.push({
			type: 'GEOSITE',
			value: category.name,
			label: `GEOSITE,${category.name}`,
			detail: `GeoSite ${describeGeositeMatchScore(score)}`,
			score,
		})
	}

	return suggestions.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score
		return a.value.localeCompare(b.value)
	})
}

function getGeositeMatchScore(site, host) {
	switch (site.matchType) {
		case 0:
			return host.includes(site.value) ? 44 : 0
		case 1:
			return testRegex(site.value, host) ? 36 : 0
		case 2:
			if (host === site.value) return 98
			return host.endsWith(`.${site.value}`) ? 92 : 0
		case 3:
			return host === site.value ? 100 : 0
		default:
			if (host === site.value) return 96
			if (host.endsWith(`.${site.value}`)) return 88
			return host.includes(site.value) ? 32 : 0
	}
}

function describeGeositeMatchScore(score) {
	if (score >= 98) return '精确匹配'
	if (score >= 88) return '后缀匹配'
	if (score >= 40) return '关键词匹配'
	return '正则匹配'
}

function parseGeoipIndex(bytes) {
	const decoder = new TextDecoder('utf-8', { fatal: false })
	const entries = []
	const pos = { i: 0 }

	while (pos.i < bytes.length) {
		const tag = readVarint(bytes, pos)
		if (tag === -1 || tag === 0) break
		const fieldNum = tag >> 3
		const wireType = tag & 0x7

		if (wireType !== 2) {
			if (!skipWire(bytes, pos, wireType)) break
			continue
		}

		const len = readVarint(bytes, pos)
		if (len === -1 || pos.i + len > bytes.length) break
		if (fieldNum === 1) {
			const entry = parseGeoipEntry(bytes.subarray(pos.i, pos.i + len), decoder)
			if (entry?.code && entry.cidrs.length > 0) {
				entries.push(entry)
			}
		}
		pos.i += len
	}

	return entries
}

function parseGeoipEntry(buf, decoder) {
	const pos = { i: 0 }
	let code = ''
	const cidrs = []

	while (pos.i < buf.length) {
		const tag = readVarint(buf, pos)
		if (tag === -1 || tag === 0) break
		const fieldNum = tag >> 3
		const wireType = tag & 0x7

		if (wireType === 2) {
			const len = readVarint(buf, pos)
			if (len === -1 || pos.i + len > buf.length) break
			const slice = buf.subarray(pos.i, pos.i + len)
			if (fieldNum === 1) {
				code = decodeUtf8(decoder, slice).toUpperCase()
			} else if (fieldNum === 2) {
				const cidr = parseGeoipCidr(slice)
				if (cidr) cidrs.push(cidr)
			}
			pos.i += len
			continue
		}

		if (wireType === 0) {
			if (readVarint(buf, pos) === -1) break
			continue
		}

		if (!skipWire(buf, pos, wireType)) break
	}

	return code ? { code, cidrs } : null
}

function parseGeoipCidr(buf) {
	const pos = { i: 0 }
	let ipBytes = null
	let prefix = -1

	while (pos.i < buf.length) {
		const tag = readVarint(buf, pos)
		if (tag === -1 || tag === 0) break
		const fieldNum = tag >> 3
		const wireType = tag & 0x7

		if (wireType === 2) {
			const len = readVarint(buf, pos)
			if (len === -1 || pos.i + len > buf.length) break
			if (fieldNum === 1) {
				ipBytes = Array.from(buf.subarray(pos.i, pos.i + len))
			}
			pos.i += len
			continue
		}

		if (wireType === 0) {
			const num = readVarint(buf, pos)
			if (num === -1) break
			if (fieldNum === 2) {
				prefix = num
			}
			continue
		}

		if (!skipWire(buf, pos, wireType)) break
	}

	if (!ipBytes || prefix < 0) return null
	return {
		version: ipBytes.length === 16 ? 6 : 4,
		prefix,
		bytes: ipBytes,
	}
}

function matchGeoipIps(entries, ips) {
	const parsedIps = ips
		.map(ip => parseIpAddress(ip))
		.filter(Boolean)

	if (parsedIps.length === 0) return []

	const suggestions = []
	for (const entry of entries) {
		let bestMatch = null
		for (const parsedIp of parsedIps) {
			const matchedCidr = findMatchingCidr(entry.cidrs, parsedIp)
			if (!matchedCidr) continue
			if (!bestMatch || matchedCidr.prefix > bestMatch.prefix) {
				bestMatch = {
					prefix: matchedCidr.prefix,
					ip: parsedIp.raw,
				}
			}
		}
		if (!bestMatch) continue
		suggestions.push({
			type: 'GEOIP',
			value: entry.code,
			label: `GEOIP,${entry.code}`,
			detail: `GeoIP ${bestMatch.ip}/${bestMatch.prefix}`,
			score: 50 + bestMatch.prefix,
		})
	}

	return suggestions.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score
		return a.value.localeCompare(b.value)
	})
}

function findMatchingCidr(cidrs, parsedIp) {
	let best = null
	for (const cidr of cidrs) {
		if (cidr.version !== parsedIp.version) continue
		if (!matchIpPrefix(parsedIp.bytes, cidr.bytes, cidr.prefix)) continue
		if (!best || cidr.prefix > best.prefix) {
			best = cidr
		}
	}
	return best
}

function parseIpAddress(value) {
	const raw = String(value || '').trim()
	if (!raw) return null
	if (raw.includes(':')) {
		const bytes = parseIpv6(raw)
		return bytes ? { version: 6, bytes, raw } : null
	}
	const bytes = parseIpv4(raw)
	return bytes ? { version: 4, bytes, raw } : null
}

function parseIpv4(value) {
	const parts = value.split('.')
	if (parts.length !== 4) return null
	const bytes = []
	for (const part of parts) {
		if (!/^\d+$/.test(part)) return null
		const num = Number(part)
		if (num < 0 || num > 255) return null
		bytes.push(num)
	}
	return bytes
}

function parseIpv6(value) {
	const normalized = value.toLowerCase()
	if (!/^[0-9a-f:.]+$/.test(normalized)) return null

	const [headRaw, tailRaw, extra] = normalized.split('::')
	if (extra !== undefined) return null

	const head = headRaw ? headRaw.split(':').filter(Boolean) : []
	const tail = tailRaw ? tailRaw.split(':').filter(Boolean) : []
	if (head.some(part => part.length > 4) || tail.some(part => part.length > 4)) return null

	const missing = 8 - (head.length + tail.length)
	if (missing < 0) return null
	const groups = [
		...head,
		...Array(missing).fill('0'),
		...tail,
	]
	if (groups.length !== 8) return null

	const bytes = []
	for (const group of groups) {
		const num = Number.parseInt(group || '0', 16)
		if (!Number.isFinite(num) || num < 0 || num > 0xffff) return null
		bytes.push((num >> 8) & 0xff, num & 0xff)
	}
	return bytes
}

function matchIpPrefix(ipBytes, networkBytes, prefix) {
	const wholeBytes = Math.floor(prefix / 8)
	const remainingBits = prefix % 8

	for (let i = 0; i < wholeBytes; i++) {
		if (ipBytes[i] !== networkBytes[i]) return false
	}

	if (remainingBits === 0) return true
	const mask = (0xff << (8 - remainingBits)) & 0xff
	return (ipBytes[wholeBytes] & mask) === (networkBytes[wholeBytes] & mask)
}

function normalizeHost(value) {
	return String(value || '').trim().toLowerCase().replace(/\.+$/, '')
}

function normalizeIpList(values) {
	return [...new Set((Array.isArray(values) ? values : [])
		.map(value => String(value || '').trim())
		.filter(Boolean))]
}

function dedupeSuggestions(suggestions) {
	const seen = new Set()
	const result = []
	for (const suggestion of suggestions) {
		const key = `${suggestion.type}\0${suggestion.value}`
		if (seen.has(key)) continue
		seen.add(key)
		result.push(suggestion)
	}
	return result
}

function decodeUtf8(decoder, bytes) {
	try {
		return decoder.decode(bytes)
	} catch {
		return ''
	}
}

function testRegex(pattern, input) {
	try {
		return new RegExp(pattern, 'i').test(input)
	} catch {
		return false
	}
}

function readVarint(arr, pos) {
	let val = 0
	let shift = 0
	let byte = 0
	do {
		if (pos.i >= arr.length) return -1
		byte = arr[pos.i++]
		val |= (byte & 0x7f) << shift
		shift += 7
	} while (byte & 0x80)
	return val
}

function skipWire(arr, pos, wireType) {
	if (wireType === 0) {
		return readVarint(arr, pos) !== -1
	}
	if (wireType === 1) {
		pos.i += 8
		return pos.i <= arr.length
	}
	if (wireType === 5) {
		pos.i += 4
		return pos.i <= arr.length
	}
	if (wireType === 2) {
		const len = readVarint(arr, pos)
		if (len === -1) return false
		pos.i += len
		return pos.i <= arr.length
	}
	return false
}

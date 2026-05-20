/**
 * GeoIP DAT Parser Tests
 *
 * Validates that parseGeoipDat() correctly extracts country codes and names
 * from the geoip.dat binary file.
 *
 * Usage: node test/geoip-parser.test.js
 *
 * Prerequisite: Download geoip.dat to public/GeoIP.dat first:
 *   curl -L -o public/GeoIP.dat https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip.dat
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const datPath = new URL('../public/GeoIP.dat', import.meta.url)

if (!existsSync(datPath)) {
  console.log('GeoIP.dat not found, downloading...')
  try {
    const res = await fetch('https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip.dat')
    if (!res.ok) { console.error('Download failed'); process.exit(1) }
    const buf = Buffer.from(await res.arrayBuffer())
    writeFileSync(datPath, buf)
    console.log(`Downloaded ${buf.length} bytes`)
  } catch (e) { console.error('Download failed:', e.message); process.exit(1) }
}

// Load parser functions from js/parsers/geoip.js
const appJs = readFileSync(new URL('../public/js/parsers/geoip.js', import.meta.url), 'utf8')
const fnCode = appJs
  .replace(/export const /g, 'var ')
  .replace(/export function /g, 'function ')

const geoipDat = new Uint8Array(readFileSync(datPath))

// Evaluate parser functions in global scope
const evalCode = `(function() {
  ${fnCode}
  return { parseGeoipDat, GEOIP_NAMES }
})(globalThis)`

const { parseGeoipDat, GEOIP_NAMES } = (0, eval)(evalCode)

// ---- Tests ----
let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) {
    passed++
    console.log(`  \u2713 ${msg}`)
  } else {
    failed++
    console.error(`  \u2717 ${msg}`)
  }
}

console.log('=== GeoIP Parser Tests ===\n')

// Test 1: Basic parsing
const countries = parseGeoipDat(geoipDat)
assert(countries.length > 0, `Should parse at least 1 country (got ${countries.length})`)
assert(countries.length > 50, `Should parse 50+ countries (got ${countries.length})`)

// Test 2: Structure
const first = countries[0]
assert(typeof first.code === 'string' && first.code.length > 0, `Country code should be non-empty string (got "${first.code}")`)
assert(typeof first.name === 'string' && first.name.length > 0, `Country name should be non-empty string (got "${first.name}")`)

// Test 3: Known countries exist
const knownCodes = ['CN', 'US', 'JP', 'GB', 'DE', 'FR', 'KR', 'HK', 'TW', 'SG', 'RU', 'IN', 'BR', 'AU', 'CA']
for (const code of knownCodes) {
  const found = countries.some(c => c.code === code)
  assert(found, `Country "${code}" should exist`)
}

// Test 4: Special categories (commonly in MetaCubeX geoip.dat)
const specialCodes = ['CLOUDFLARE', 'GOOGLE', 'NETFLIX', 'TWITTER', 'TELEGRAM', 'FACEBOOK', 'PRIVATE']
for (const code of specialCodes) {
  const found = countries.some(c => c.code === code)
  assert(found, `Special category "${code}" should exist`)
}

// Test 5: Chinese name mapping
const cn = countries.find(c => c.code === 'CN')
assert(cn.name === '\u4e2d\u56fd' || cn.name === 'CN', 'CN should map to Chinese name or code')

const us = countries.find(c => c.code === 'US')
assert(us.name === '\u7f8e\u56fd' || us.name === 'US', 'US should map to Chinese name or code')

// Test 6: No duplicate codes
const codes = countries.map(c => c.code)
const uniqueCodes = [...new Set(codes)]
assert(uniqueCodes.length === codes.length, 'Should have no duplicate country codes')

// Test 7: Countries should be sorted
const sorted = [...codes].sort((a, b) => a.localeCompare(b))
assert(JSON.stringify(codes) === JSON.stringify(sorted), 'Countries should be sorted alphabetically')

// Test 8: Parsing is deterministic
const countries2 = parseGeoipDat(geoipDat)
assert(countries.length === countries2.length, 'Multiple parses should return same number of countries')
assert(countries[0].code === countries2[0].code, 'Multiple parses should return same first country')

// Test 9: Country codes match expected pattern (2-3 uppercase letters, or uppercase+digits+dash)
const invalidCodes = countries.filter(c => !/^[A-Z][A-Z0-9_-]*$/.test(c.code))
assert(invalidCodes.length === 0, `All country codes should match pattern (${invalidCodes.length} invalid, e.g. "${invalidCodes[0]?.code}")`)

// Summary
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`)
process.exit(failed > 0 ? 1 : 0)

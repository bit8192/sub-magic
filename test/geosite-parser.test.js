/**
 * GeoSite DAT Parser Tests
 *
 * Validates that parseGeositeDat() correctly extracts category names and
 * domain entries from the geosite.dat binary file.
 *
 * Usage: node test/geosite-parser.test.js
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// Load parser functions from js/parsers/geosite.js
const appJs = readFileSync(new URL('../public/js/parsers/geosite.js', import.meta.url), 'utf8')
const start = appJs.indexOf('export function parseGeositeDat')
const end = appJs.length
const fnCode = appJs.slice(start, end)
  .replace(/export function /g, 'function ')
  .replace(/export const /g, 'const ')

const geositeDat = new Uint8Array(readFileSync(new URL('../public/GeoSite.dat', import.meta.url)))

// Evaluate parser functions in global scope
const evalCode = `(function() {
  ${fnCode}
  return { parseGeositeDat, parseGeositeProtobuf, parseSiteMessage }
})()`

const { parseGeositeDat } = (0, eval)(evalCode)

// ---- Tests ----
let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) {
    passed++
    console.log(`  ✓ ${msg}`)
  } else {
    failed++
    console.error(`  ✗ ${msg}`)
  }
}

console.log('=== GeoSite Parser Tests ===\n')

// Test 1: Basic parsing
const categories = parseGeositeDat(geositeDat)
assert(categories.length > 0, `Should parse at least 1 category (got ${categories.length})`)
assert(categories.length > 100, `Should parse 100+ categories (got ${categories.length})`)

// Test 2: Structure
const first = categories[0]
assert(typeof first.name === 'string' && first.name.length > 0, `Category name should be non-empty string (got "${first.name}")`)
assert(Array.isArray(first.domains), `Category domains should be an array`)

// Test 3: Known categories exist
const knownNames = ['YOUTUBE', 'GOOGLE', 'NETFLIX', 'TWITTER', 'TELEGRAM', 'CN', 'GITHUB', 'APPLE']
for (const name of knownNames) {
  const found = categories.some(c => c.name === name)
  assert(found, `Category "${name}" should exist`)
}

// Test 4: Specific category domains
const youtube = categories.find(c => c.name === 'YOUTUBE')
assert(youtube.domains.length > 0, 'YOUTUBE should have domains')
assert(youtube.domains.includes('youtube.com'), 'YOUTUBE should include "youtube.com"')
assert(youtube.domains.includes('youtu.be'), 'YOUTUBE should include "youtu.be"')
assert(youtube.domains.includes('ytimg.com'), 'YOUTUBE should include "ytimg.com"')

// Test 5: CN category has many domains
const cn = categories.find(c => c.name === 'CN')
assert(cn.domains.length > 10000, 'CN should have 10,000+ domains')

// Test 6: No duplicate names
const names = categories.map(c => c.name)
const uniqueNames = [...new Set(names)]
assert(uniqueNames.length === names.length, 'Should have no duplicate category names')

// Test 7: Categories should be sorted
const sorted = [...names].sort((a, b) => a.localeCompare(b))
assert(JSON.stringify(names) === JSON.stringify(sorted), 'Categories should be sorted alphabetically')

// Test 8: Parsing is deterministic
const categories2 = parseGeositeDat(geositeDat)
assert(categories.length === categories2.length, 'Multiple parses should return same number of categories')
assert(categories[0].name === categories2[0].name, 'Multiple parses should return same first category')

// Test 9: Category names match expected pattern
const invalidNames = categories.filter(c => !/^[a-zA-Z0-9@!._\u{80}-\u{FFFF}-]+$/u.test(c.name))
assert(invalidNames.length === 0, `All category names should match expected pattern (${invalidNames.length} invalid, e.g. "${invalidNames[0]?.name}")`)

// Summary
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`)
process.exit(failed > 0 ? 1 : 0)

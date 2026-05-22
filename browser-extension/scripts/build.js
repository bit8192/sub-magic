const fs = require('fs')
const path = require('path')

const extDir = path.resolve(__dirname, '..')
const outDir = path.resolve(extDir, '..', 'public', 'extensions')

const distChrome = path.join(extDir, 'dist', 'chrome')
const distFirefox = path.join(extDir, 'dist', 'firefox')

fs.rmSync(distChrome, { recursive: true, force: true })
fs.rmSync(distFirefox, { recursive: true, force: true })
fs.mkdirSync(distChrome, { recursive: true })
fs.mkdirSync(distFirefox, { recursive: true })

const baseManifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'))

copyDir(path.join(extDir, 'src'), path.join(distChrome, 'src'))
copyDir(path.join(extDir, 'icons'), path.join(distChrome, 'icons'))
const chromeManifest = { ...baseManifest }
delete chromeManifest.browser_specific_settings
chromeManifest.permissions = Array.from(new Set([...(chromeManifest.permissions || []), 'webRequestAuthProvider']))
chromeManifest.icons = {
  16: 'icons/icon-16.png',
  48: 'icons/icon-48.png',
  128: 'icons/icon-128.png'
}
if (chromeManifest.action) {
  chromeManifest.action = {
    ...chromeManifest.action,
    default_icon: {
      16: 'icons/icon-16.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png'
    }
  }
}
if (chromeManifest.background && chromeManifest.background.scripts) {
  chromeManifest.background = {
    service_worker: chromeManifest.background.scripts[0]
  }
}
fs.writeFileSync(path.join(distChrome, 'manifest.json'), JSON.stringify(chromeManifest, null, '\t'))

copyDir(path.join(extDir, 'src'), path.join(distFirefox, 'src'))
copyDir(path.join(extDir, 'icons'), path.join(distFirefox, 'icons'))
const firefoxManifest = { ...baseManifest }
firefoxManifest.permissions = Array.from(new Set([...(firefoxManifest.permissions || []), 'webRequestBlocking']))
fs.writeFileSync(path.join(distFirefox, 'manifest.json'), JSON.stringify(firefoxManifest, null, '\t'))

fs.mkdirSync(outDir, { recursive: true })

const chromeOut = path.join(outDir, 'sub-magic-chrome.zip')
const firefoxOut = path.join(outDir, 'sub-magic-firefox.xpi')

createZip(distChrome, chromeOut)
createZip(distFirefox, firefoxOut)

console.log(`Chrome: ${chromeOut}`)
console.log(`Firefox: ${firefoxOut}`)

fs.rmSync(path.join(extDir, 'dist'), { recursive: true, force: true })

function copyDir(src, dest) {
	fs.mkdirSync(dest, { recursive: true })
	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		const srcPath = path.join(src, entry.name)
		const destPath = path.join(dest, entry.name)
		if (entry.isDirectory()) {
			copyDir(srcPath, destPath)
		} else {
			fs.copyFileSync(srcPath, destPath)
		}
	}
}

function createZip(sourceDir, outFile) {
	const files = []
	collectFiles(sourceDir, '', files)

	const chunks = []
	let offset = 0
	const centralDirectory = []

	for (const file of files) {
		const nameBytes = Buffer.from(file.relativePath, 'utf8')
		const content = file.data
		const crc = crc32(content)

		const localHeader = Buffer.alloc(30 + nameBytes.length + content.length)
		let pos = 0
		localHeader.writeUInt32LE(0x04034b50, pos); pos += 4
		localHeader.writeUInt16LE(20, pos); pos += 2
		localHeader.writeUInt16LE(0, pos); pos += 2
		localHeader.writeUInt16LE(0, pos); pos += 2
		localHeader.writeUInt32LE(0, pos); pos += 4
		localHeader.writeUInt32LE(crc, pos); pos += 4
		localHeader.writeUInt32LE(content.length, pos); pos += 4
		localHeader.writeUInt32LE(content.length, pos); pos += 4
		localHeader.writeUInt16LE(nameBytes.length, pos); pos += 2
		localHeader.writeUInt16LE(0, pos); pos += 2
		nameBytes.copy(localHeader, pos); pos += nameBytes.length
		content.copy(localHeader, pos); pos += content.length

		chunks.push(localHeader)

		const cdEntry = Buffer.alloc(46 + nameBytes.length)
		pos = 0
		cdEntry.writeUInt32LE(0x02014b50, pos); pos += 4
		cdEntry.writeUInt16LE(20, pos); pos += 2
		cdEntry.writeUInt16LE(20, pos); pos += 2
		cdEntry.writeUInt16LE(0, pos); pos += 2
		cdEntry.writeUInt16LE(0, pos); pos += 2
		cdEntry.writeUInt16LE(0, pos); pos += 2
		cdEntry.writeUInt16LE(0, pos); pos += 2
		cdEntry.writeUInt32LE(crc, pos); pos += 4
		cdEntry.writeUInt32LE(content.length, pos); pos += 4
		cdEntry.writeUInt32LE(content.length, pos); pos += 4
		cdEntry.writeUInt16LE(nameBytes.length, pos); pos += 2
		cdEntry.writeUInt16LE(0, pos); pos += 2
		cdEntry.writeUInt16LE(0, pos); pos += 2
		cdEntry.writeUInt16LE(0, pos); pos += 2
		cdEntry.writeUInt16LE(0, pos); pos += 2
		cdEntry.writeUInt32LE(0, pos); pos += 4
		cdEntry.writeUInt32LE(offset, pos); pos += 4
		nameBytes.copy(cdEntry, pos)
		centralDirectory.push({ entry: cdEntry, offset })

		offset += localHeader.length
	}

	const cdBuffer = Buffer.concat(centralDirectory.map(cd => cd.entry))
	const cdOffset = offset
	chunks.push(cdBuffer)

	const eocd = Buffer.alloc(22)
	let pos = 0
	eocd.writeUInt32LE(0x06054b50, pos); pos += 4
	eocd.writeUInt16LE(0, pos); pos += 2
	eocd.writeUInt16LE(0, pos); pos += 2
	eocd.writeUInt16LE(files.length, pos); pos += 2
	eocd.writeUInt16LE(files.length, pos); pos += 2
	eocd.writeUInt32LE(cdBuffer.length, pos); pos += 4
	eocd.writeUInt32LE(cdOffset, pos); pos += 4
	eocd.writeUInt16LE(0, pos); pos += 2
	chunks.push(eocd)

	fs.writeFileSync(outFile, Buffer.concat(chunks))
}

function collectFiles(dir, basePath, files) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name)
		const rel = basePath ? path.join(basePath, entry.name).replace(/\\/g, '/') : entry.name
		if (entry.isDirectory()) {
			collectFiles(full, rel, files)
		} else {
			files.push({
				relativePath: rel,
				data: fs.readFileSync(full)
			})
		}
	}
}

function crc32(buf) {
	let crc = 0xFFFFFFFF
	for (let i = 0; i < buf.length; i++) {
		crc ^= buf[i]
		for (let j = 0; j < 8; j++) {
			if (crc & 1) {
				crc = (crc >>> 1) ^ 0xEDB88320
			} else {
				crc = crc >>> 1
			}
		}
	}
	return (crc ^ 0xFFFFFFFF) >>> 0
}

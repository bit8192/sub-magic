const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

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
if (chromeManifest.background && chromeManifest.background.scripts) {
  chromeManifest.background = {
    service_worker: chromeManifest.background.scripts[0]
  }
}
fs.writeFileSync(path.join(distChrome, 'manifest.json'), JSON.stringify(chromeManifest, null, '\t'))

copyDir(path.join(extDir, 'src'), path.join(distFirefox, 'src'))
copyDir(path.join(extDir, 'icons'), path.join(distFirefox, 'icons'))
fs.writeFileSync(path.join(distFirefox, 'manifest.json'), JSON.stringify(baseManifest, null, '\t'))

fs.mkdirSync(outDir, { recursive: true })

const chromeOut = path.join(outDir, 'sub-magic-chrome.zip')
const firefoxOut = path.join(outDir, 'sub-magic-firefox.xpi')

execSync(`cd "${distChrome}" && zip -r "${chromeOut}" .`, { stdio: 'pipe' })
execSync(`cd "${distFirefox}" && zip -r "${firefoxOut}" .`, { stdio: 'pipe' })

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

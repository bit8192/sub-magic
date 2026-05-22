const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const rootDir = path.resolve(__dirname, '..')
const publicDir = path.join(rootDir, 'public')
const extensionIconsDir = path.join(rootDir, 'browser-extension', 'icons')

const sourceSvg = path.join(publicDir, 'icon.svg')
const extensionSvg = path.join(extensionIconsDir, 'icon.svg')
const faviconPath = path.join(publicDir, 'favicon.ico')
const extensionSizes = [16, 48, 128]
const faviconSizes = [16, 32, 48]

assertFile(sourceSvg)

fs.mkdirSync(extensionIconsDir, { recursive: true })
fs.copyFileSync(sourceSvg, extensionSvg)

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-magic-icons-'))

try {
  for (const size of extensionSizes) {
    renderSvgToPng(sourceSvg, path.join(extensionIconsDir, `icon-${size}.png`), size)
  }

  const faviconPngs = faviconSizes.map((size) => {
    const pngPath = path.join(tempDir, `favicon-${size}.png`)
    renderSvgToPng(sourceSvg, pngPath, size)
    return pngPath
  })

  execFileSync('magick', [...faviconPngs, faviconPath], { stdio: 'inherit' })

  console.log(`Synced SVG: ${extensionSvg}`)
  console.log(`Generated favicon: ${faviconPath}`)
  for (const size of extensionSizes) {
    console.log(`Generated PNG: ${path.join(extensionIconsDir, `icon-${size}.png`)}`)
  }
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true })
}

function renderSvgToPng(inputPath, outputPath, size) {
  execFileSync(
    'rsvg-convert',
    ['--width', String(size), '--height', String(size), '--output', outputPath, inputPath],
    { stdio: 'inherit' }
  )
}

function assertFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing file: ${filePath}`)
  }
}

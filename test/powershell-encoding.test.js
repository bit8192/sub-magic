import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const powershellFiles = [
  new URL('../public/install.ps1', import.meta.url),
  new URL('../public/sub-magic.ps1', import.meta.url),
]

describe('PowerShell asset compatibility', () => {
  it('keeps shipped PowerShell scripts ASCII-only for Windows PowerShell 5.1 parsing', () => {
    for (const fileUrl of powershellFiles) {
      const content = readFileSync(fileUrl, 'utf8')
      expect([...content].every((char) => char.charCodeAt(0) <= 0x7f)).toBe(true)
    }
  })
})

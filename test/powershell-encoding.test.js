import { describe, expect, it } from 'vitest'
import installPs1 from '../public/install.ps1?raw'
import subMagicPs1 from '../public/sub-magic.ps1?raw'

describe('PowerShell asset compatibility', () => {
  it('keeps shipped PowerShell scripts ASCII-only for Windows PowerShell 5.1 parsing', () => {
    for (const content of [installPs1, subMagicPs1]) {
      expect([...content].every(char => char.charCodeAt(0) <= 0x7f)).toBe(true)
    }
  })
})

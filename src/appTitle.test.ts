import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { titleWithVersion } from '@/lib/appTitle'

describe('window title version', () => {
  it('puts the version in the title', () => {
    expect(titleWithVersion('0.11.134')).toContain('0.11.134')
  })
  it('falls back without a version', () => {
    expect(titleWithVersion(undefined)).not.toMatch(/undefined/)
  })
  it('main.tsx actually applies it', () => {
    expect(readFileSync('src/main.tsx', 'utf8')).toContain('applyVersionTitle()')
  })
})

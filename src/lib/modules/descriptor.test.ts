import { describe, it, expect } from 'vitest'
import { sandboxedDescriptor, descriptorsFor } from './descriptor'
import type { CustomModuleDef } from '@/lib/types'

const mod = (id: string, over: Partial<CustomModuleDef> = {}): CustomModuleDef => ({
  id,
  label: `Mod ${id}`,
  description: '',
  framework: 'react',
  origin: 'local',
  createdAt: '',
  updatedAt: '',
  ...over,
})

describe('sandboxedDescriptor', () => {
  it('wraps a custom module as a custom:<uuid> tab descriptor', () => {
    const d = sandboxedDescriptor(mod('aaaa'))
    expect(d.id).toBe('custom:aaaa')
    expect(d.kind).toBe('sandboxed')
    expect(d.label).toBe('Mod aaaa')
    expect(d.def?.id).toBe('aaaa')
  })

  it('carries the full def through (framework / origin / remoteId)', () => {
    const d = sandboxedDescriptor(mod('b', { framework: 'html', origin: 'installed', remoteId: 'r1' }))
    expect(d.def?.framework).toBe('html')
    expect(d.def?.origin).toBe('installed')
    expect(d.def?.remoteId).toBe('r1')
  })
})

describe('descriptorsFor', () => {
  it('preserves input order and maps every module', () => {
    const out = descriptorsFor([mod('a'), mod('b'), mod('c')])
    expect(out.map((d) => d.id)).toEqual(['custom:a', 'custom:b', 'custom:c'])
    expect(out.every((d) => d.kind === 'sandboxed')).toBe(true)
  })

  it('returns an empty list for no modules', () => {
    expect(descriptorsFor([])).toEqual([])
  })
})

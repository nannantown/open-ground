import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ProjectEntry } from '../types'
import { addImportedProjectEntry, relocateProjectEntry } from './registry'
import { canonicalize } from './canonicalize'

// relocateProjectEntry powers the missing-card "Locate folder" flow: re-point a
// project at a folder the user picks, KEEPING its uuid so its central data
// reconnects. These lock in the uuid-preservation and the overlap guard.

const reg = async (prefix: string): Promise<ProjectEntry> => {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  const r = await addImportedProjectEntry(dir)
  if ('entry' in r) return r.entry
  throw new Error(`register failed: ${r.rejection}`)
}

describe('relocateProjectEntry', () => {
  it('re-points an entry at a new folder, KEEPING its uuid', async () => {
    const a = await reg('og-rel-a-')
    const dest = await mkdtemp(join(tmpdir(), 'og-rel-dest-'))
    const res = await relocateProjectEntry(a.id, dest)
    expect('entry' in res).toBe(true)
    if ('entry' in res) {
      expect(res.entry.id).toBe(a.id) // uuid preserved → central data reconnects
      expect(res.entry.path).toBe(await canonicalize(dest))
    }
  })

  it('is a no-op (returns the entry) when relocating to its current path', async () => {
    const a = await reg('og-rel-noop-')
    const res = await relocateProjectEntry(a.id, a.path)
    expect('entry' in res && res.entry.id === a.id).toBe(true)
  })

  it('rejects relocating onto another registered project (duplicate)', async () => {
    const a = await reg('og-rel-a2-')
    const b = await reg('og-rel-b2-')
    expect(await relocateProjectEntry(a.id, b.path)).toEqual({ rejection: 'duplicate' })
  })

  it('rejects relocating onto a folder nested under another project (overlap)', async () => {
    const a = await reg('og-rel-a3-')
    const b = await reg('og-rel-b3-')
    const nested = join(b.path, 'sub')
    await mkdir(nested, { recursive: true })
    expect(await relocateProjectEntry(a.id, nested)).toEqual({ rejection: 'overlap' })
  })

  it('returns not-found for an unknown id', async () => {
    const dest = await mkdtemp(join(tmpdir(), 'og-rel-x-'))
    expect(await relocateProjectEntry('does-not-exist', dest)).toEqual({ rejection: 'not-found' })
  })
})

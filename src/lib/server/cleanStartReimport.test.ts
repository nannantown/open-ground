import { describe, it, expect } from 'vitest'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { addImportedProjectEntry, removeProjectEntry } from './registry'
import { readProjectData, writeProjectData } from './projectData'

// Load-bearing guarantee: Remove-from-canvas then re-Import the SAME folder must
// be a clean start. Because the resolver is keyed by the registry uuid (and not
// memoized by path), the re-import gets a FRESH uuid and never reconnects the
// old project's central data. (Relocate — not Import — is the path that keeps
// the uuid; see relocate.test.ts.)

describe('Remove-then-Import is a clean start', () => {
  it('a re-imported folder gets a new uuid and reads empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'og-clean-'))

    const r1 = await addImportedProjectEntry(dir)
    expect('entry' in r1).toBe(true)
    const id1 = 'entry' in r1 ? r1.entry.id : ''

    await writeProjectData(dir, {
      description: '',
      tasks: [{ id: 't1', title: 'X', done: false, createdAt: 'x', boardColumn: 'todo' }],
      notes: '',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    expect((await readProjectData(dir)).tasks).toHaveLength(1)

    await removeProjectEntry(dir)
    const r2 = await addImportedProjectEntry(dir)
    expect('entry' in r2).toBe(true)
    const id2 = 'entry' in r2 ? r2.entry.id : ''

    expect(id2).not.toBe(id1) // fresh uuid, not the dead one
    // The old central data under id1 still exists on disk but is NOT reconnected
    // — the re-imported project reads empty.
    expect((await readProjectData(dir)).tasks).toHaveLength(0)
  })
})

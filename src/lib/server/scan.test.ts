import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { getSettings, setSettings } from './store'
import { scanProjects } from './scan'
import { __resetMigrationCacheForTests } from './registry'
import type { ProjectEntry } from '../types'

// Each test gets a throwaway OPEN GROUND home so store/readProjectData touch a
// clean settings.json — never the real ~/.openground.
let home: string
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-scan-home-')))
  process.env.OPENGROUND_HOME = home
  __resetMigrationCacheForTests()
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('scanProjects — collab-linked entries are not standalone cards', () => {
  it('skips entries that carry a collabProjectId (the shared card represents them)', async () => {
    const normal = await realpath(await mkdtemp(join(tmpdir(), 'og-scan-normal-')))
    const linked = await realpath(await mkdtemp(join(tmpdir(), 'og-scan-linked-')))
    const projects: ProjectEntry[] = [
      { id: 'n1', path: normal, addedAt: 't' },
      {
        id: 'l1',
        path: linked,
        addedAt: 't',
        collabProjectId: '55555555-5555-5555-5555-555555555555',
      },
    ]
    await setSettings({ projectsMigratedAt: new Date().toISOString(), projects })

    const metas = await scanProjects(await getSettings())
    const paths = metas.map((m) => m.path)
    expect(paths).toContain(normal) // a normal project still surfaces as a card
    expect(paths).not.toContain(linked) // the member's linked checkout does NOT
    expect(metas).toHaveLength(1)
  })
})

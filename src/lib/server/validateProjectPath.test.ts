import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ProjectEntry } from '../types'

// Drive the registry (Settings.projects) without touching the real
// ~/.openground, and stub the one-shot migration to a no-op.
const settings: { projects: ProjectEntry[] } = { projects: [] }
vi.mock('./store', () => ({
  getSettings: async () => settings,
}))
vi.mock('./registry', () => ({
  ensureProjectsMigrated: async () => {},
}))

import { validateProjectPath } from './projectData'

let root: string
let root2: string
let outside: string

beforeEach(async () => {
  // realpath the tmp base so macOS /var→/private/var symlinks don't trip the
  // canonicalized comparison.
  const base = await realpath(await mkdtemp(join(tmpdir(), 'og-vpp-')))
  root = join(base, 'projects', 'alpha')
  root2 = join(base, 'elsewhere', 'beta')
  outside = join(base, 'outside')
  await mkdir(root, { recursive: true })
  await mkdir(root2, { recursive: true })
  await mkdir(outside, { recursive: true })
  // Two registered projects in unrelated locations — the registry is a
  // multi-root allowlist.
  settings.projects = [
    { id: 'a', path: root, addedAt: 't' },
    { id: 'b', path: root2, addedAt: 't' },
  ]
})
afterEach(async () => {
  settings.projects = []
  await rm(join(root, '..', '..'), { recursive: true, force: true })
})

describe('validateProjectPath (registry allowlist)', () => {
  it('accepts a registered project path itself', async () => {
    expect(await validateProjectPath(root)).toBe(true)
  })

  it('accepts a path under a registered project (e.g. a worktree)', async () => {
    const wt = join(root, '.openground', 'worktrees', 'x')
    await mkdir(wt, { recursive: true })
    expect(await validateProjectPath(wt)).toBe(true)
  })

  it('accepts a path under a SECOND registered project', async () => {
    expect(await validateProjectPath(join(root2, 'sub'))).toBe(true)
  })

  it('rejects a path under no registered project', async () => {
    expect(await validateProjectPath(outside)).toBe(false)
  })

  it('rejects ../ traversal escaping every registered root', async () => {
    expect(await validateProjectPath(join(root, '..', '..', 'outside'))).toBe(false)
  })

  it('rejects a sibling-prefix path (alpha-evil vs alpha)', async () => {
    expect(await validateProjectPath(root + '-evil')).toBe(false)
  })

  it('rejects a symlink inside a project that points outside it', async () => {
    const link = join(root, 'escape')
    await symlink(outside, link) // <root>/escape -> <base>/outside
    expect(await validateProjectPath(link)).toBe(false)
  })

  it('still accepts a not-yet-created path under a project (creation flows)', async () => {
    expect(await validateProjectPath(join(root, 'will-create-later'))).toBe(true)
  })

  it('returns false when the registry is empty', async () => {
    settings.projects = []
    expect(await validateProjectPath(join(root, 'alpha'))).toBe(false)
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

// Control settings.projectsRoot without touching the real ~/.openground.
const settings: { projectsRoot: string | null } = { projectsRoot: null }
vi.mock('./store', () => ({
  getSettings: async () => settings,
}))

import { validateProjectPath } from './projectData'

let root: string
let outside: string

beforeEach(async () => {
  // realpath the tmp base so macOS /var→/private/var symlinks don't trip the
  // canonicalized comparison.
  const base = await realpath(await mkdtemp(join(tmpdir(), 'og-vpp-')))
  root = join(base, 'projects')
  outside = join(base, 'outside')
  await mkdir(root, { recursive: true })
  await mkdir(outside, { recursive: true })
  settings.projectsRoot = root
})
afterEach(async () => {
  settings.projectsRoot = null
  await rm(join(root, '..'), { recursive: true, force: true })
})

describe('validateProjectPath', () => {
  it('accepts a real directory under projectsRoot', async () => {
    const p = join(root, 'alpha')
    await mkdir(p)
    expect(await validateProjectPath(p)).toBe(true)
  })

  it('accepts projectsRoot itself', async () => {
    expect(await validateProjectPath(root)).toBe(true)
  })

  it('rejects a path outside projectsRoot', async () => {
    expect(await validateProjectPath(outside)).toBe(false)
  })

  it('rejects ../ traversal escaping the root', async () => {
    expect(await validateProjectPath(join(root, '..', 'outside'))).toBe(false)
  })

  it('rejects a sibling-prefix path (root-evil vs root)', async () => {
    expect(await validateProjectPath(root + '-evil')).toBe(false)
  })

  it('rejects a symlink inside root that points outside (the boundary bypass)', async () => {
    const link = join(root, 'escape')
    await symlink(outside, link) // <root>/escape -> <base>/outside
    expect(await validateProjectPath(link)).toBe(false)
  })

  it('still accepts a not-yet-created path under root (creation flows)', async () => {
    expect(await validateProjectPath(join(root, 'will-create-later'))).toBe(true)
  })

  it('returns false when projectsRoot is unset', async () => {
    settings.projectsRoot = null
    expect(await validateProjectPath(join(root, 'alpha'))).toBe(false)
  })
})

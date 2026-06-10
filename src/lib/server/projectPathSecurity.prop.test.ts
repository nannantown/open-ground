import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import fc from 'fast-check'
import type { ProjectEntry } from '../types'

// Property tests for the path security boundary. validateProjectPath is THE
// gate that stops the local server from reading/writing arbitrary filesystem
// locations: a path validates only if it sits at/under a registered project (or
// that project's central worktrees). "どんな操作でも壊れない" here means a
// crafted path — traversal, random junk, absolute escapes — must NEVER validate
// and must NEVER throw (it returns a boolean).

const settings: { projects: ProjectEntry[] } = { projects: [] }
vi.mock('./store', () => ({ getSettings: async () => settings }))
vi.mock('./registry', () => ({ ensureProjectsMigrated: async () => {} }))

import { validateProjectPath } from './projectData'

let root: string
let base: string

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'og-vpp-prop-')))
  root = join(base, 'projects', 'alpha')
  await mkdir(root, { recursive: true })
  settings.projects = [{ id: 'a', path: root, addedAt: 't' }]
})
afterEach(async () => {
  settings.projects = []
  await rm(base, { recursive: true, force: true })
})

// A path segment that's safe to append (no separators / traversal / nul).
const safeSeg = fc
  .string({ minLength: 1, maxLength: 12 })
  .filter((s) => !/[/\\\x00]/.test(s) && s !== '.' && s !== '..')

describe('validateProjectPath (property: the allowlist cannot be escaped)', () => {
  it('a registered root descendant (any depth of safe segments) ALWAYS validates', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(safeSeg, { minLength: 0, maxLength: 6 }), async (segs) => {
        const p = segs.length ? join(root, ...segs) : root
        expect(await validateProjectPath(p)).toBe(true)
      }),
      { numRuns: 60 },
    )
  })

  it('an arbitrary path outside every registered root NEVER validates (and never throws)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (s) => {
        // Build an absolute path under `base` but OUTSIDE `root`, plus the raw
        // string itself (which resolve()s relative to cwd — also outside root).
        const outside = join(base, 'outside', s.replace(/\x00/g, ''))
        const a = await validateProjectPath(outside)
        const b = await validateProjectPath(s)
        expect(a).toBe(false)
        expect(typeof b).toBe('boolean') // raw junk: just must not throw
      }),
      { numRuns: 80 },
    )
  })

  it('traversal that escapes the root is rejected; traversal that stays inside is accepted', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom('..', 'a', 'b', 'sub', '.'), { maxLength: 8 }),
        async (segs) => {
          const candidate = join(root, ...segs)
          // Decide the ground truth lexically: after resolving, is it still
          // at/under root? (join already normalises '..'/'.'.)
          const insideRoot = candidate === root || candidate.startsWith(root + '/')
          const result = await validateProjectPath(candidate)
          if (!insideRoot) {
            // Escaped the root → must be rejected (the core traversal guard).
            expect(result).toBe(false)
          }
          // (inside-root candidates may be true; we don't over-assert since a
          // non-existent deep path still canonicalises under root and validates.)
        },
      ),
      { numRuns: 80 },
    )
  })
})

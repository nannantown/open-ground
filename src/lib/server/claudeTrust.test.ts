import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// fs is partially mocked: only writeFileSync is wrapped so ONE test can simulate a
// concurrent claude write landing in updateProjects' read→rename window (it injects
// a live-file rewrite right before our tmp write, via `fsControl`). Every other fs
// call — incl. this file's own mkdtemp/read/write/rm — passes through to the real
// implementation, so the rest of the suite is unaffected (the hook stays disarmed).
const fsControl = vi.hoisted(() => ({
  // When set, the NEXT `*.tmp` write fires this once (then disarms) to mimic a
  // concurrent writer racing in just before updateProjects renames.
  injectOnNextTmpWrite: null as null | (() => void),
}))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    writeFileSync: (file: unknown, data: unknown, ...rest: unknown[]) => {
      if (
        fsControl.injectOnNextTmpWrite &&
        typeof file === 'string' &&
        file.endsWith('.tmp')
      ) {
        const inject = fsControl.injectOnNextTmpWrite
        fsControl.injectOnNextTmpWrite = null
        inject()
      }
      return (actual.writeFileSync as (...a: unknown[]) => void)(file, data, ...rest)
    },
  }
})

import { ensureClaudeFolderTrusted, removeClaudeFolderTrust } from './claudeTrust'

// All tests redirect the config path to a tmp file so the real ~/.claude.json
// is never touched (see claudeTrust.ts CLAUDE_CONFIG_PATH override).
let dir: string
let cfg: string
const read = () => JSON.parse(readFileSync(cfg, 'utf8'))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claudetrust-'))
  cfg = join(dir, '.claude.json')
  process.env.CLAUDE_CONFIG_PATH = cfg
  fsControl.injectOnNextTmpWrite = null
})
afterEach(() => {
  delete process.env.CLAUDE_CONFIG_PATH
  fsControl.injectOnNextTmpWrite = null
  rmSync(dir, { recursive: true, force: true })
})

describe('ensureClaudeFolderTrusted', () => {
  it('creates the config + projects map and sets hasTrustDialogAccepted', () => {
    ensureClaudeFolderTrusted('/work/proj')
    expect(read().projects['/work/proj'].hasTrustDialogAccepted).toBe(true)
  })

  it('preserves other config keys and other projects (merge, not clobber)', () => {
    writeFileSync(
      cfg,
      JSON.stringify({
        numStartups: 5,
        projects: { '/other': { hasTrustDialogAccepted: true, allowedTools: ['x'] } },
      }),
    )
    ensureClaudeFolderTrusted('/work/proj')
    const d = read()
    expect(d.numStartups).toBe(5)
    expect(d.projects['/other']).toEqual({ hasTrustDialogAccepted: true, allowedTools: ['x'] })
    expect(d.projects['/work/proj'].hasTrustDialogAccepted).toBe(true)
  })

  it('keeps an existing project entry’s other fields when adding the trust flag', () => {
    writeFileSync(cfg, JSON.stringify({ projects: { '/work/proj': { lastCost: 1.5 } } }))
    ensureClaudeFolderTrusted('/work/proj')
    expect(read().projects['/work/proj']).toEqual({ lastCost: 1.5, hasTrustDialogAccepted: true })
  })

  it('does not write at all when the trust flag is already set (no needless churn)', () => {
    writeFileSync(cfg, JSON.stringify({ projects: { '/work/proj': { hasTrustDialogAccepted: true } } }))
    // Arm the concurrency hook: if updateProjects tried to write, the .tmp write
    // would fire it. A no-op must NOT write, so the hook must stay un-fired.
    let fired = false
    fsControl.injectOnNextTmpWrite = () => {
      fired = true
    }
    ensureClaudeFolderTrusted('/work/proj')
    expect(fired).toBe(false)
    expect(read().projects['/work/proj']).toEqual({ hasTrustDialogAccepted: true })
  })

  it('does NOT overwrite an unparseable config (a torn read of a concurrent write stays intact)', () => {
    const torn = '{ "oauthAccount": { "accessToken": "secret" }, projects'
    writeFileSync(cfg, torn)
    expect(() => ensureClaudeFolderTrusted('/work/proj')).not.toThrow()
    // The pre-existing (unparseable) bytes are left exactly as-is — we never clobber
    // a file we couldn't parse with our minimal config (that would nuke claude state).
    expect(readFileSync(cfg, 'utf8')).toBe(torn)
  })

  it('does not revert a concurrent claude write that lands between our read and rename', () => {
    // Initial state: claude has NOT yet trusted /work/proj and has NO auth recorded.
    writeFileSync(cfg, JSON.stringify({ projects: {} }))
    // Simulate a live claude session writing fresh auth/session state into the SAME
    // file in the window after updateProjects read it but before it renames. The old
    // whole-root rewrite would serialize its STALE (auth-less) snapshot over the top,
    // silently losing claude's auth; the re-read+retry must merge instead.
    fsControl.injectOnNextTmpWrite = () => {
      writeFileSync(
        cfg,
        JSON.stringify({
          oauthAccount: { accessToken: 'claude-fresh-token' },
          numStartups: 42,
          projects: {},
        }),
      )
    }
    ensureClaudeFolderTrusted('/work/proj')
    const d = read()
    // claude's concurrent write SURVIVED (not reverted to the pre-write snapshot)…
    expect(d.oauthAccount).toEqual({ accessToken: 'claude-fresh-token' })
    expect(d.numStartups).toBe(42)
    // …AND our trust pre-seed still landed on top of it.
    expect(d.projects['/work/proj'].hasTrustDialogAccepted).toBe(true)
  })

  it('is a no-op (no throw) on an unparseable config', () => {
    writeFileSync(cfg, '{ not json')
    expect(() => ensureClaudeFolderTrusted('/work/proj')).not.toThrow()
  })
})

describe('removeClaudeFolderTrust', () => {
  it('drops the entry for the given path, leaving siblings intact', () => {
    ensureClaudeFolderTrusted('/work/a')
    ensureClaudeFolderTrusted('/work/b')
    removeClaudeFolderTrust('/work/a')
    const d = read()
    expect(d.projects['/work/a']).toBeUndefined()
    expect(d.projects['/work/b'].hasTrustDialogAccepted).toBe(true)
  })

  it('round-trips: add then remove leaves no entry (no worktree-path buildup)', () => {
    const wt = '/Users/x/.openground/projects/uuid/worktrees/123-abc'
    ensureClaudeFolderTrusted(wt)
    expect(read().projects[wt]).toBeDefined()
    removeClaudeFolderTrust(wt)
    expect(read().projects[wt]).toBeUndefined()
  })

  it('preserves a concurrent claude write while dropping only the trust entry', () => {
    writeFileSync(
      cfg,
      JSON.stringify({
        oauthAccount: { accessToken: 'old' },
        projects: { '/work/wt': { hasTrustDialogAccepted: true } },
      }),
    )
    fsControl.injectOnNextTmpWrite = () => {
      writeFileSync(
        cfg,
        JSON.stringify({
          oauthAccount: { accessToken: 'rotated' },
          projects: { '/work/wt': { hasTrustDialogAccepted: true } },
        }),
      )
    }
    removeClaudeFolderTrust('/work/wt')
    const d = read()
    expect(d.oauthAccount).toEqual({ accessToken: 'rotated' }) // not reverted
    expect(d.projects['/work/wt']).toBeUndefined() // our removal still applied
  })

  it('is a no-op (no throw) when the path was never trusted', () => {
    writeFileSync(cfg, JSON.stringify({ projects: {} }))
    expect(() => removeClaudeFolderTrust('/never/seen')).not.toThrow()
  })
})

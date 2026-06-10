import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
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
})
afterEach(() => {
  delete process.env.CLAUDE_CONFIG_PATH
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

  it('is a no-op (no throw) when the path was never trusted', () => {
    writeFileSync(cfg, JSON.stringify({ projects: {} }))
    expect(() => removeClaudeFolderTrust('/never/seen')).not.toThrow()
  })
})

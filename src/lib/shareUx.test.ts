import { describe, it, expect } from 'vitest'
import { settingsSections, sharePublished, showHeaderShare } from './shareUx'

// The settings dialog's section visibility is THE seam of the share-UX
// redesign (docs/SHARE_UX_FLOWS.md §2a): solo users must never see share
// vocabulary, non-git folders must not see git workflow fields, and the
// shared section appears only while actually shared.
describe('settingsSections', () => {
  it('shared project: team + workflow, no CTA', () => {
    expect(settingsSections({ shared: true, gitRepo: true })).toEqual({
      team: true,
      workflow: true,
      worktrees: true,
      shareCta: false,
    })
  })

  it('unshared git repo (solo git user): workflow + CTA, NO team section', () => {
    expect(settingsSections({ shared: false, gitRepo: true })).toEqual({
      team: false,
      workflow: true,
      worktrees: true,
      shareCta: true,
    })
  })

  it('known non-git folder: personal only — no workflow, no worktrees, no CTA', () => {
    expect(settingsSections({ shared: false, gitRepo: false })).toEqual({
      team: false,
      workflow: false,
      worktrees: false,
      shareCta: false,
    })
  })

  it('unknown status (null): conservative fallback — workflow shown, CTA hidden', () => {
    expect(settingsSections(null)).toEqual({
      team: false,
      workflow: true,
      worktrees: true,
      shareCta: false,
    })
  })

  it('shared wins even if gitRepo is reported false (degenerate input)', () => {
    expect(settingsSections({ shared: true, gitRepo: false }).team).toBe(true)
  })
})

describe('showHeaderShare', () => {
  it('shows only for a present, unshared git repo', () => {
    expect(showHeaderShare({ shared: false, gitRepo: true }, false)).toBe(true)
  })
  it('hidden when already shared', () => {
    expect(showHeaderShare({ shared: true, gitRepo: true }, false)).toBe(false)
  })
  it('hidden for non-git folders (no share concept shown)', () => {
    expect(showHeaderShare({ shared: false, gitRepo: false }, false)).toBe(false)
  })
  it('hidden while the status is unknown', () => {
    expect(showHeaderShare(null, false)).toBe(false)
  })
  it('hidden when the folder is missing on disk', () => {
    expect(showHeaderShare({ shared: false, gitRepo: true }, true)).toBe(false)
  })
})

describe('sharePublished', () => {
  const base = {
    remoteUrl: 'git@github.com:o/r.git',
    dirty: false,
    ahead: 0,
    upstream: true,
  }
  it('published: remote exists, upstream tracked, clean, nothing ahead', () => {
    expect(sharePublished(base)).toBe(true)
  })
  it('NOT published without an upstream — ahead degrades to 0 when nothing was ever pushed', () => {
    expect(sharePublished({ ...base, upstream: false })).toBe(false)
  })
  it('not published while dirty', () => {
    expect(sharePublished({ ...base, dirty: true })).toBe(false)
  })
  it('not published with unpushed commits', () => {
    expect(sharePublished({ ...base, ahead: 2 })).toBe(false)
  })
  it('never published without a remote', () => {
    expect(sharePublished({ ...base, remoteUrl: null })).toBe(false)
  })
  it('unknown status reads as unpublished', () => {
    expect(sharePublished(null)).toBe(false)
  })
})

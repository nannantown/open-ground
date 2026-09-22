// Guards for scripts/trending-intake.ts — the GitHub-Trending intake merge.
//
// WHY THIS FILE EXISTS. The intake doc (docs/trending/INDEX.md + DETAILS.md) is
// rebuilt from 155 daily snapshots of another repository's git history, and the
// only thing standing between that history and a doc OPEN GROUND makes adoption
// decisions from is `mergeAppearances`. A merge bug does not look like a bug: it
// looks like a plausible document with a repository missing, a day double-counted,
// or an old gloss shown as current. Nobody re-reads 298 rows against git.
//
// Each case below maps to a way the merge can silently lie, and each was measured
// RED against a mutated `mergeAppearances` before being kept (2026-09-22). The
// git walk itself is NOT tested here — it needs a real checkout, so it stays out
// of the pure function on purpose; its faithfulness was verified separately by
// diffing 775 (date, repo) slots against `git log` and by re-deriving one
// repository's 16 appearance dates with an independent shell pass.

import { describe, it, expect } from 'vitest'
import { mergeAppearances, type DayFile, type DayProject } from '../../scripts/trending-intake'

const project = (fullName: string, over: Partial<DayProject> = {}): DayProject => ({
  rank: 1,
  fullName,
  name: fullName.split('/')[1],
  url: `https://github.com/${fullName}`,
  language: 'TypeScript',
  stars: 100,
  todayStars: 10,
  description: 'short',
  detail: 'detail',
  narration: 'narration',
  ...over,
})

const day = (date: string, projects: DayProject[]): DayFile => ({ date, projects })

describe('mergeAppearances — one entry per repository', () => {
  it('collects a repository appearing on several days into one entry, dates ascending', () => {
    const repos = mergeAppearances({
      days: [day('2026-05-02', [project('a/one')]), day('2026-04-01', [project('a/one')])],
    })
    expect(repos).toHaveLength(1)
    expect(repos[0].dates).toEqual(['2026-04-01', '2026-05-02'])
    expect(repos[0].count).toBe(2)
    expect(repos[0].first).toBe('2026-04-01')
    expect(repos[0].last).toBe('2026-05-02')
  })

  it('counts a date ONCE even when the repository is listed twice that day', () => {
    // A duplicate inside one day's TOP5 must not inflate the appearance count —
    // "how many days was this featured" is the number the doc is read for.
    const repos = mergeAppearances({
      days: [day('2026-04-01', [project('a/one', { rank: 1 }), project('a/one', { rank: 4 })])],
    })
    expect(repos[0].count).toBe(1)
    expect(repos[0].dates).toEqual(['2026-04-01'])
    // both raw appearances are still kept, so the detail doc can show the day twice
    expect(repos[0].appearances).toHaveLength(2)
  })

  it('splits owner and repo out of fullName', () => {
    const repos = mergeAppearances({ days: [day('2026-04-01', [project('BuilderIO/agent-native')])] })
    expect(repos[0].owner).toBe('BuilderIO')
    expect(repos[0].repo).toBe('agent-native')
  })

  it('skips projects with no fullName instead of inventing an entry', () => {
    const repos = mergeAppearances({
      days: [day('2026-04-01', [project('a/one'), { ...project('x/y'), fullName: undefined }])],
    })
    expect(repos.map((r) => r.fullName)).toEqual(['a/one'])
  })
})

describe('mergeAppearances — which day wins', () => {
  it('takes the gloss from the LATEST day, not the first', () => {
    const repos = mergeAppearances({
      days: [
        day('2026-04-01', [project('a/one', { description: 'old', detail: 'old detail', language: 'Python' })]),
        day('2026-09-01', [project('a/one', { description: 'new', detail: 'new detail', language: 'Rust' })]),
      ],
    })
    expect(repos[0].description).toBe('new')
    expect(repos[0].detail).toBe('new detail')
    expect(repos[0].language).toBe('Rust')
  })

  it('lets the LAST file given for a date replace an earlier one (correction commit)', () => {
    // readDaysFromGit walks history oldest-first, so a same-date re-commit is a
    // correction and must overwrite — not append a second copy of that day.
    const repos = mergeAppearances({
      days: [
        day('2026-04-01', [project('a/one'), project('b/two')]),
        day('2026-04-01', [project('a/one', { detail: 'corrected' })]),
      ],
    })
    expect(repos.map((r) => r.fullName)).toEqual(['a/one'])
    expect(repos[0].detail).toBe('corrected')
    expect(repos[0].appearances).toHaveLength(1)
  })

  it('reports the HIGHEST star count seen, not the last one', () => {
    const repos = mergeAppearances({
      days: [
        day('2026-04-01', [project('a/one', { stars: 9000 })]),
        day('2026-09-01', [project('a/one', { stars: 12 })]),
      ],
    })
    expect(repos[0].stars).toBe(9000)
  })
})

describe('mergeAppearances — the name-only performance history', () => {
  it('adds days the enriched file never captured', () => {
    const repos = mergeAppearances({
      days: [day('2026-04-01', [project('a/one')])],
      videos: [{ date: '2026-06-26', projects: ['a/one', 'c/three'] }],
    })
    const one = repos.find((r) => r.fullName === 'a/one')!
    expect(one.dates).toEqual(['2026-04-01', '2026-06-26'])
    expect(one.glossedDays).toBe(1)
    expect(one.appearances.some((a) => a.namesOnly)).toBe(true)
    // a repository known only from the name-only history still gets an entry,
    // and says so rather than borrowing someone else's gloss
    const three = repos.find((r) => r.fullName === 'c/three')!
    expect(three.detail).toBeNull()
    expect(three.description).toBeNull()
    expect(three.glossedDays).toBe(0)
  })

  it('does NOT re-add a day the enriched file already covers', () => {
    const repos = mergeAppearances({
      days: [day('2026-04-01', [project('a/one')])],
      videos: [{ date: '2026-04-01', projects: ['a/one', 'd/four'] }],
    })
    expect(repos.map((r) => r.fullName)).toEqual(['a/one'])
    expect(repos[0].appearances).toHaveLength(1)
    expect(repos[0].appearances[0].namesOnly).toBe(false)
  })

  it('keeps the gloss when a name-only day is the most recent appearance', () => {
    // The name-only day carries no text; picking "the latest appearance" instead
    // of "the latest GLOSSED appearance" would blank the description.
    const repos = mergeAppearances({
      days: [day('2026-04-01', [project('a/one', { detail: 'real detail' })])],
      videos: [{ date: '2026-09-19', projects: ['a/one'] }],
    })
    expect(repos[0].last).toBe('2026-09-19')
    expect(repos[0].detail).toBe('real detail')
  })
})

describe('mergeAppearances — ordering', () => {
  it('sorts by days featured, then stars, then name', () => {
    const repos = mergeAppearances({
      days: [
        day('2026-04-01', [project('few/stars-high', { stars: 5000 }), project('many/a'), project('zzz/one-day', { stars: 1 })]),
        day('2026-04-02', [project('many/a')]),
      ],
    })
    expect(repos.map((r) => r.fullName)).toEqual(['many/a', 'few/stars-high', 'zzz/one-day'])
  })

  it('breaks a full tie by name so regenerating the doc produces no diff churn', () => {
    const repos = mergeAppearances({
      days: [day('2026-04-01', [project('b/two', { stars: 7 }), project('a/one', { stars: 7 })])],
    })
    expect(repos.map((r) => r.fullName)).toEqual(['a/one', 'b/two'])
  })
})

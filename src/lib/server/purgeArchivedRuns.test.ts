import { describe, it, expect, beforeEach } from 'vitest'
import { mkdir, writeFile, readdir, rm, utimes } from 'fs/promises'
import { join } from 'path'
import { purgeArchivedRuns } from './runner'
import { runsArchiveDir } from './paths'

// Regression guard for the dismiss data-loss bug.
//
// purgeArchivedRuns is the ONLY path that actually unlinks archived run JSON.
// Its contract hinges on whether `ids` was *passed at all*, not on emptiness:
//   - purgeArchivedRuns()        → time-prune entries older than 30 days
//   - purgeArchivedRuns([])      → no-op (NEVER a time prune — the bug)
//   - purgeArchivedRuns(['x'])   → remove only entries matching id "x"
//
// All file I/O lands under OPENGROUND_HOME, which the vitest setup
// (src/test/setup-home.ts) has already redirected to a throwaway tmp dir, so
// this test never touches the real ~/.openground.

const ARCHIVE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

const seed = async (name: string, ageMs: number) => {
  const dir = runsArchiveDir()
  await mkdir(dir, { recursive: true })
  const full = join(dir, name)
  await writeFile(full, JSON.stringify({ id: name }), 'utf8')
  const when = new Date(Date.now() - ageMs)
  await utimes(full, when, when)
}

const list = async () => {
  try {
    return (await readdir(runsArchiveDir())).sort()
  } catch {
    return []
  }
}

const THIRTY_ONE_DAYS = 31 * 24 * 60 * 60 * 1000
const ONE_DAY = 24 * 60 * 60 * 1000

describe('purgeArchivedRuns', () => {
  beforeEach(async () => {
    // Start every case from an empty archive dir.
    await rm(runsArchiveDir(), { recursive: true, force: true })
  })

  it('empty ids array is a strict no-op — never time-prunes (regression guard)', async () => {
    await seed('old.json', THIRTY_ONE_DAYS) // would be pruned by a time prune
    await seed('new.json', ONE_DAY)

    await purgeArchivedRuns([])

    // Nothing removed — including the 31-day-old file.
    expect(await list()).toEqual(['new.json', 'old.json'])
  })

  it('undefined ids → time-prune removes entries older than 30 days only', async () => {
    await seed('old.json', THIRTY_ONE_DAYS)
    await seed('new.json', ONE_DAY)

    await purgeArchivedRuns()

    expect(await list()).toEqual(['new.json'])
  })

  it('explicit ids → removes only the matching entry', async () => {
    await seed('x.json', ONE_DAY)
    await seed('y.json', ONE_DAY)

    await purgeArchivedRuns(['x'])

    expect(await list()).toEqual(['y.json'])
  })

  it('explicit ids matches the <id>.<finishedAt>.json archive suffix form', async () => {
    await seed('x.2026-05-29T00-00-00-000Z.json', ONE_DAY)
    await seed('y.json', ONE_DAY)

    await purgeArchivedRuns(['x'])

    expect(await list()).toEqual(['y.json'])
  })

  it('cutoff boundary: a file exactly at the retention edge is kept', async () => {
    // Just under the cutoff (younger than 30d) must survive a time prune.
    await seed('edge.json', ARCHIVE_RETENTION_MS - 60_000)

    await purgeArchivedRuns()

    expect(await list()).toEqual(['edge.json'])
  })
})

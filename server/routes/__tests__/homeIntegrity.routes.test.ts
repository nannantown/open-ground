// Routes for the home-data damage report, against the real Hono app.
//
// These exist because the report surface is the ONLY thing standing between "your
// data may be gone" and the owner: there is no restore UI, so a route that
// silently stops answering leaves the warning pointing nowhere. Deleting the
// handler used to keep every route test green (review, 2026-07-19).
//
// OPENGROUND_HOME points at a throwaway dir per test.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, realpath, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from '../../app'
import { setCanvas, setSettings } from '@/lib/server/store'
import { checkHomeIntegrity } from '@/lib/server/homeIntegrity'
import { settingsFile } from '@/lib/server/paths'

let home: string
let savedHome: string | undefined

const projects = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `uuid-${i}`,
    path: `/Users/someone/projects/p${i}`,
    addedAt: '2026-06-01T00:00:00.000Z',
  }))

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-integrity-routes-')))
  savedHome = process.env.OPENGROUND_HOME
  process.env.OPENGROUND_HOME = home
})
afterEach(async () => {
  // NEVER unset — an empty OPENGROUND_HOME points at the user's real data
  // (paths.ts openGroundHome) and workers are reused across files.
  process.env.OPENGROUND_HOME = savedHome ?? home
  await rm(home, { recursive: true, force: true })
})

/** Damage the registry through the real save path, so a generation is left. */
const stageDamage = async () => {
  await setSettings({ projects: projects(45) })
  await setCanvas({
    positions: Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`uuid-${i}`, { x: i, y: i }])),
    viewport: { x: 0, y: 0, zoom: 1 },
    elements: [],
  })
  await checkHomeIntegrity({ notify: false }) // baseline
  await setSettings({ projects: projects(3) })
  await checkHomeIntegrity({ notify: false }) // detects + records the report
}

describe('GET /api/home-integrity', () => {
  it('answers on a clean home without inventing a problem', async () => {
    const res = await app.request('/api/home-integrity')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      lastReport: unknown
      candidates: Record<string, { dir: string; candidates: unknown[] }>
    }
    expect(body.lastReport).toBeNull()
    // The shape is always present, so a caller can render "no backups yet"
    // without special-casing a missing key.
    expect(Object.keys(body.candidates).sort()).toEqual(['canvas', 'settings'])
    expect(body.candidates.settings.candidates).toEqual([])
  })

  it('reports the damage and WHERE to restore from', async () => {
    await stageDamage()

    const res = await app.request('/api/home-integrity')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      lastReport: { at: number; message: string } | null
      candidates: Record<string, { dir: string; candidates: { entryCounts: (number | null)[] }[] }>
    }

    expect(body.lastReport?.message).toContain('45')
    expect(body.candidates.settings.dir).toBe(join(home, 'backups', 'settings'))
    // The 45-project generation is offered, and named by dimension.
    expect(body.candidates.settings.candidates[0].entryCounts[0]).toBe(45)
  })

  it('is READ-ONLY — asking does not repair the damaged file', async () => {
    await stageDamage()
    const before = await readFile(settingsFile(), 'utf8')
    await app.request('/api/home-integrity')
    expect(await readFile(settingsFile(), 'utf8')).toBe(before)
  })
})

describe('POST /api/home-integrity/acknowledge', () => {
  it('clears the standing report so the owner is not told forever', async () => {
    await stageDamage()
    // The warning is standing: the report surface still shows it long after the
    // console line scrolled away. Without acknowledge there is no way to say
    // "I dealt with this" short of editing a file by hand.
    const before = (await (await app.request('/api/home-integrity')).json()) as {
      lastReport: { message: string } | null
    }
    expect(before.lastReport?.message).toContain('45')

    const res = await app.request('/api/home-integrity/acknowledge', { method: 'POST' })
    expect(res.status).toBe(200)
    expect((await res.json() as { acknowledgedAt: number | null }).acknowledgedAt).toBeTruthy()

    const after = (await (await app.request('/api/home-integrity')).json()) as {
      lastReport: unknown
    }
    expect(after.lastReport).toBeNull()
    // …and the check stays quiet about the state that was just accepted.
    expect((await checkHomeIntegrity({ notify: false })).findings).toEqual([])
  })

  it('never touches the protected files or the backups', async () => {
    await stageDamage()
    const before = await readFile(settingsFile(), 'utf8')
    const backupsBefore = (
      (await (await app.request('/api/home-integrity')).json()) as {
        candidates: Record<string, { candidates: unknown[] }>
      }
    ).candidates.settings.candidates.length

    await app.request('/api/home-integrity/acknowledge', { method: 'POST' })

    // "Stop telling me" must never mean "throw away my only copy".
    expect(await readFile(settingsFile(), 'utf8')).toBe(before)
    const after = (
      (await (await app.request('/api/home-integrity')).json()) as {
        candidates: Record<string, { candidates: { entryCounts: (number | null)[] }[] }>
      }
    ).candidates.settings
    expect(after.candidates.length).toBe(backupsBefore)
    expect(after.candidates.some((c) => c.entryCounts[0] === 45)).toBe(true)
  })
})

// Regression tests for the generational backup of settings.json / canvas.json.
//
// GOAL CONDITION: after the 2026-07-18 incident (registry 45 → 3, card layout
// unrecoverable), overwriting either file must leave the PREVIOUS content on
// disk, the history must be bounded in both count and total bytes, and no
// pruning path may ever take the last copy.
//
// HOME is isolated per test via mkdtemp + OPENGROUND_HOME.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, readFile, readdir, realpath, rm, mkdtemp, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  KEEP_FLOOR,
  KEEP_RECENT,
  PRUNE_SLACK,
  backupDirFor,
  listGenerations,
  listRestoreCandidates,
  protectedKindOf,
  pruneBackups,
  snapshotBeforeWrite,
} from './homeBackup'
import { canvasFile, notificationsFile, settingsFile } from './paths'
import { getCanvas, getSettings, markNotificationsRead, setCanvas, setSettings } from './store'

let home: string
let savedHome: string | undefined

const settingsWith = (n: number) => ({
  projects: Array.from({ length: n }, (_, i) => ({
    id: `uuid-${i}`,
    path: `/Users/someone/projects/p${i}`,
    addedAt: '2026-06-01T00:00:00.000Z',
  })),
})

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-backup-')))
  savedHome = process.env.OPENGROUND_HOME
  process.env.OPENGROUND_HOME = home
})

afterEach(async () => {
  // NEVER `delete` this. openGroundHome() falls back to `~/.openground` when it
  // is unset (paths.ts), so an unset var points every later write in this worker
  // process at the user's REAL home — and vitest reuses worker processes across
  // files. Restoring to a still-live temp dir is always safe; unsetting is a
  // loaded gun. (A leak of exactly this shape contaminated the real
  // settings.json during this card's own development, 2026-07-19.)
  process.env.OPENGROUND_HOME = savedHome ?? home
  await rm(home, { recursive: true, force: true })
})

describe('snapshotBeforeWrite', () => {
  it('preserves the content that is about to be overwritten', async () => {
    await writeFile(settingsFile(), JSON.stringify(settingsWith(45)))
    const path = await snapshotBeforeWrite(settingsFile())
    expect(path).not.toBeNull()

    // The overwrite the real incident performed.
    await writeFile(settingsFile(), JSON.stringify(settingsWith(3)))

    const saved = JSON.parse(await readFile(path!, 'utf8'))
    expect(saved.projects).toHaveLength(45)
  })

  it('is a no-op for a file it does not protect', async () => {
    await writeFile(notificationsFile(), '{"readIds":["x"]}')
    expect(await snapshotBeforeWrite(notificationsFile())).toBeNull()
    expect(protectedKindOf(notificationsFile())).toBeNull()
  })

  it('is a no-op on the first-ever write (nothing to preserve yet)', async () => {
    expect(await snapshotBeforeWrite(settingsFile())).toBeNull()
    expect(await listGenerations('settings')).toEqual([])
  })

  it('skips an EMPTY file — a torn write is not a generation worth keeping', async () => {
    await writeFile(settingsFile(), '   \n')
    expect(await snapshotBeforeWrite(settingsFile())).toBeNull()
  })

  it('dedupes identical content so a drag-heavy canvas cannot fill the disk', async () => {
    await writeFile(canvasFile(), JSON.stringify({ positions: { a: { x: 1, y: 1 } } }))
    // Ten saves that change nothing — the shape of dragging a card and putting
    // it back.
    for (let i = 0; i < 10; i++) await snapshotBeforeWrite(canvasFile(), { now: 1_000 + i })
    expect(await listGenerations('canvas')).toHaveLength(1)

    // A real change does produce a new generation.
    await writeFile(canvasFile(), JSON.stringify({ positions: { a: { x: 2, y: 2 } } }))
    await snapshotBeforeWrite(canvasFile(), { now: 2_000 })
    expect(await listGenerations('canvas')).toHaveLength(2)
  })

  it('NEVER fails the caller when the backup itself breaks (invariant 1)', async () => {
    await writeFile(settingsFile(), JSON.stringify(settingsWith(45)))
    // Make the backup dir un-creatable by parking a FILE where it must go.
    await mkdir(join(home, 'backups'), { recursive: true })
    await writeFile(backupDirFor('settings'), 'not a directory')
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(snapshotBeforeWrite(settingsFile())).resolves.toBeNull()
    expect(err).toHaveBeenCalled() // it complains…
    err.mockRestore()

    // …and, crucially, the user's save still goes through.
    await expect(setSettings({ defaultWorkspace: '/x' })).resolves.toBeUndefined()
    expect((await getSettings()).defaultWorkspace).toBe('/x')
  })
})

describe('pruneBackups — bounded history', () => {
  /** Drop a generation file straight into the backup dir with a chosen stamp, so
   *  a policy spanning days can be built without 14 days of wall clock.
   *  `n` (entry count) defaults to the SAME value for every planted generation:
   *  these cases are about the age and size rules, and giving one of them a
   *  higher count would pin it and quietly change what they are measuring. */
  const plant = async (
    kind: 'settings' | 'canvas',
    stamp: string,
    hash: string,
    bytes = 100,
    n = 5,
  ) => {
    await mkdir(backupDirFor(kind), { recursive: true })
    await writeFile(join(backupDirFor(kind), `${stamp}-${hash}-n${n}-0.json`), 'x'.repeat(bytes))
  }

  it('bounds a busy day at KEEP_RECENT (+ the amortisation slack)', async () => {
    // Pruning is amortised — it does not run on every write — so the live count
    // rides between KEEP_RECENT and KEEP_RECENT + PRUNE_SLACK. Both halves of
    // that contract matter: it must stay BOUNDED as writes pile up, and an
    // explicit prune must bring it exactly to policy.
    await writeFile(settingsFile(), JSON.stringify(settingsWith(1)))
    for (let i = 0; i < KEEP_RECENT * 5; i++) {
      await writeFile(settingsFile(), JSON.stringify(settingsWith(i + 2)))
      await snapshotBeforeWrite(settingsFile(), { now: Date.UTC(2026, 6, 19, 12, 0, i) })
    }
    const live = await listGenerations('settings')
    expect(live.length).toBeLessThanOrEqual(KEEP_RECENT + PRUNE_SLACK)
    expect(live.length).toBeGreaterThanOrEqual(KEEP_RECENT)

    await pruneBackups({ now: Date.UTC(2026, 6, 19, 12, 30, 0) })
    // …down to policy. The +1 is the pin: the richest generation is exempt, and
    // here the counts grow with every write so the newest IS the richest.
    expect((await listGenerations('settings')).length).toBeLessThanOrEqual(KEEP_RECENT + 1)
  })

  it('thins older days to one generation each and drops days past the window', async () => {
    const now = Date.UTC(2026, 6, 19, 12, 0, 0) // 2026-07-19
    // Three generations on each of two recent days, plus one long past the
    // 14-day window.
    await plant('settings', '20260718T120000000Z', 'aaaaaaa1')
    await plant('settings', '20260718T110000000Z', 'aaaaaaa2')
    await plant('settings', '20260718T100000000Z', 'aaaaaaa3')
    await plant('settings', '20260717T120000000Z', 'bbbbbbb1')
    await plant('settings', '20260717T110000000Z', 'bbbbbbb2')
    await plant('settings', '20260717T100000000Z', 'bbbbbbb3')
    await plant('settings', '20260601T120000000Z', 'ccccccc1') // way outside the window

    await pruneBackups({ now, keepRecent: 1 })

    const left = (await listGenerations('settings')).map((g) => g.hash)
    // The three newest survive on the KEEP_FLOOR floor; 2026-07-17 is thinned to
    // its newest; the June generation is outside the daily window and goes.
    expect(left).toEqual(['aaaaaaa1', 'aaaaaaa2', 'aaaaaaa3', 'bbbbbbb1'])
  })

  it('enforces the total-size cap, oldest first', async () => {
    const now = Date.UTC(2026, 6, 19, 12, 0, 0)
    for (let i = 1; i <= 8; i++) {
      await plant('settings', `20260719T12000000${i}Z`, `dddddd0${i}`, 1_000)
    }
    // keepRecent high enough that the AGE policy keeps all 8 — so anything
    // removed here is the size cap's doing, not the age rule's.
    const report = await pruneBackups({ now, keepRecent: 100, maxTotalBytes: 4_500 })
    expect(report.totalBytes).toBeLessThanOrEqual(4_500)
    const left = await listGenerations('settings')
    expect(left).toHaveLength(4)
    // The survivors are the NEWEST four — the oldest were dropped first.
    expect(left.map((g) => g.hash)).toEqual(['dddddd08', 'dddddd07', 'dddddd06', 'dddddd05'])
  })

  it('refuses to delete the last copies even when far over the cap (invariant 2)', async () => {
    const now = Date.UTC(2026, 6, 19, 12, 0, 0)
    for (let i = 1; i <= 5; i++) {
      await plant('settings', `20260719T12000000${i}Z`, `eeeeee0${i}`, 10_000)
    }
    // A cap NO surviving set can satisfy: honouring it literally would empty the
    // dir and leave the user with nothing to restore from.
    const report = await pruneBackups({ now, keepRecent: 100, maxTotalBytes: 1 })
    expect(await listGenerations('settings')).toHaveLength(KEEP_FLOOR)
    expect(report.totalBytes).toBeGreaterThan(1) // over cap, and that is CORRECT
  })

  it('two OVERLAPPING prunes cannot empty the directory (invariant 2 under a race)', async () => {
    // Regression, adversarial review 2026-07-19. Both prunes listed the same 8
    // files; the first deleted down to the floor, and the second — whose unlinks
    // all failed because the files were already gone — went on counting them as
    // present, walked past KEEP_FLOOR and took the survivors too. Measured 8 → 0.
    // Reachable because setCanvas is unchained, so two in-flight POST /api/canvas
    // both prune.
    const now = Date.UTC(2026, 6, 19, 12, 0, 0)
    for (let i = 1; i <= 8; i++) {
      await plant('settings', `20260719T12000000${i}Z`, `aaaaaa0${i}`, 10_000)
    }
    await Promise.all([
      pruneBackups({ now, keepRecent: 100, maxTotalBytes: 1 }),
      pruneBackups({ now, keepRecent: 100, maxTotalBytes: 1 }),
    ])
    expect((await listGenerations('settings')).length).toBeGreaterThanOrEqual(KEEP_FLOOR)
  })

  it('ignores files that are not generations rather than deleting them', async () => {
    await mkdir(backupDirFor('settings'), { recursive: true })
    const stranger = join(backupDirFor('settings'), 'README.txt')
    await writeFile(stranger, 'hello')
    await plant('settings', '20260719T120000000Z', 'ffffff01')
    await pruneBackups({ now: Date.UTC(2026, 6, 19, 12, 0, 0), keepRecent: 0, maxTotalBytes: 1 })
    await expect(stat(stranger)).resolves.toBeTruthy()
  })
})

describe('listRestoreCandidates', () => {
  it('offers the richest copy first and includes the orphaned .tmp that saved the day', async () => {
    // The designed path: a real generation holding 40 projects.
    await writeFile(settingsFile(), JSON.stringify(settingsWith(40)))
    await snapshotBeforeWrite(settingsFile(), { now: Date.UTC(2026, 6, 19, 9, 0, 0) })

    // The accident that actually rescued the registry on 2026-07-18: an orphaned
    // atomic-write temp sitting next to the live file, holding MORE entries.
    await writeFile(
      join(home, '.settings.json.tmp-27332-1'),
      JSON.stringify(settingsWith(45)),
    )

    const candidates = await listRestoreCandidates('settings')
    expect(candidates).toHaveLength(2)
    expect(candidates[0]).toMatchObject({ source: 'orphan-temp', entryCounts: [45] })
    expect(candidates[1]).toMatchObject({ source: 'backup', entryCounts: [40] })
  })

  it('counts canvas card positions, not raw bytes', async () => {
    await writeFile(canvasFile(), JSON.stringify({ positions: { a: {}, b: {}, c: {} } }))
    await snapshotBeforeWrite(canvasFile(), { now: Date.UTC(2026, 6, 19, 9, 0, 0) })
    const [c] = await listRestoreCandidates('canvas')
    expect(c.entryCounts[0]).toBe(3)
  })

  it('reports an unparseable candidate rather than hiding it, ranked last', async () => {
    await writeFile(settingsFile(), JSON.stringify(settingsWith(5)))
    await snapshotBeforeWrite(settingsFile(), { now: Date.UTC(2026, 6, 19, 9, 0, 0) })
    await writeFile(join(home, '.settings.json.tmp-999-0'), '{ truncated')

    const candidates = await listRestoreCandidates('settings')
    expect(candidates).toHaveLength(2)
    expect(candidates[0].entryCounts[0]).toBe(5)
    expect(candidates[candidates.length - 1]).toMatchObject({
      source: 'orphan-temp',
      entryCounts: [null],
    })
  })

  it('never deletes an orphaned .tmp while pruning (it is evidence, not litter)', async () => {
    const orphan = join(home, '.settings.json.tmp-27332-1')
    await writeFile(orphan, JSON.stringify(settingsWith(45)))
    await pruneBackups({ now: Date.UTC(2030, 0, 1) }) // far future — max pressure
    await expect(stat(orphan)).resolves.toBeTruthy()
  })
})

describe('store.ts wiring — the feature as the app actually uses it', () => {
  it('setSettings leaves the previous registry recoverable', async () => {
    await setSettings(settingsWith(45))
    expect((await getSettings()).projects).toHaveLength(45)

    // The incident: something replaces the registry with 3 entries.
    await setSettings(settingsWith(3))
    expect((await getSettings()).projects).toHaveLength(3)

    const candidates = await listRestoreCandidates('settings')
    expect(candidates[0].entryCounts[0]).toBe(45) // the 45-entry copy is right there
  })

  it('setCanvas leaves the previous card layout recoverable — the half that was lost', async () => {
    await setCanvas({
      positions: Object.fromEntries(
        Array.from({ length: 45 }, (_, i) => [`uuid-${i}`, { x: i, y: i }]),
      ),
      viewport: { x: 0, y: 0, zoom: 1 },
      elements: [],
    })
    await setCanvas({ positions: {}, viewport: { x: 0, y: 0, zoom: 1 }, elements: [] })

    expect(Object.keys((await getCanvas()).positions)).toHaveLength(0) // wiped live…
    const candidates = await listRestoreCandidates('canvas')
    expect(candidates[0].entryCounts[0]).toBe(45) // …but the 45 positions survive
  })

  it('pan/zoom does NOT evict the generation holding real card positions', async () => {
    // Regression, adversarial review 2026-07-19. viewport lives in canvas.json,
    // so hashing the raw bytes made every pan/zoom a fresh generation; ten
    // gestures — under a minute of navigating — pushed the last copy with real
    // card positions out of the KEEP_RECENT window. That is exactly the loss
    // this module exists to prevent, so it gets a test with teeth.
    const view = (zoom: number) => ({ x: zoom, y: zoom, zoom })
    const withPositions = (n: number, zoom: number) => ({
      positions: Object.fromEntries(
        Array.from({ length: n }, (_, i) => [`uuid-${i}`, { x: i, y: i }]),
      ),
      viewport: view(zoom),
      elements: [],
    })

    await setCanvas(withPositions(45, 1))
    await setCanvas({ positions: {}, viewport: view(1), elements: [] }) // the layout is wiped

    // Now just navigate — each gesture is a distinct viewport and therefore
    // distinct raw bytes, far more of them than KEEP_RECENT.
    const pan = async (from: number, to: number) => {
      for (let z = from; z <= to; z++) {
        await setCanvas({ positions: {}, viewport: view(z), elements: [] })
      }
    }
    await pan(2, 20)
    const after19 = (await listGenerations('canvas')).length
    await pan(21, 60) // forty more
    const after59 = (await listGenerations('canvas')).length

    // The count is driven by REAL states (the 45-card layout, then the wipe),
    // never by how much the user navigated: 40 extra gestures add nothing.
    expect(after19).toBe(2)
    expect(after59).toBe(after19)
    // …so the 45 card positions are still the best thing to restore from.
    expect((await listRestoreCandidates('canvas'))[0].entryCounts[0]).toBe(45)
  })

  it('still versions a REAL canvas change that happens to move the viewport too', async () => {
    const mk = (n: number, zoom: number) => ({
      positions: Object.fromEntries(
        Array.from({ length: n }, (_, i) => [`uuid-${i}`, { x: i, y: i }]),
      ),
      viewport: { x: 0, y: 0, zoom },
      elements: [],
    })
    await setCanvas(mk(10, 1))
    await setCanvas(mk(11, 2)) // a card moved AND the view panned
    await setCanvas(mk(12, 3))
    expect(await listGenerations('canvas')).toHaveLength(2)
  })

  it('KEEPS the pre-damage generation through a busy day of later writes', async () => {
    // THE scenario this whole module exists for, and the one the first version
    // failed (review 2026-07-19). KEEP_RECENT counts WRITES, not time, so eleven
    // ordinary saves on the same day evicted the only copy holding the real data
    // — and the daily rule could not save it (same calendar day) nor could
    // KEEP_FLOOR (which protects the newest three, all post-damage copies).
    await setSettings(settingsWith(45))
    await setSettings(settingsWith(3)) // 10:00 — the damage; snapshots the 45
    expect((await listRestoreCandidates('settings'))[0].entryCounts[0]).toBe(45)

    // …then an ordinary afternoon: far more writes than KEEP_RECENT, all today.
    for (let i = 0; i < KEEP_RECENT * 3; i++) {
      await setSettings({ defaultWorkspace: `/Users/someone/w${i}` })
    }

    // The pin must have held. If it did not, every candidate is a copy of the
    // damage and the owner has nothing to go back to.
    const best = (await listRestoreCandidates('settings'))[0]
    expect(best.entryCounts[0]).toBe(45)
    expect(await listGenerations('settings')).toContainEqual(
      expect.objectContaining({ entryCounts: [45] }),
    )
  })

  it('releases the pin once the file is whole again', async () => {
    // The pin must not preserve stale data forever — only until the loss is
    // undone. Once a richer generation exists, the pin moves to it.
    await setSettings(settingsWith(45))
    await setSettings(settingsWith(3)) // generation n45 pinned
    await setSettings(settingsWith(60)) // generation n3
    await setSettings(settingsWith(61)) // generation n60 — now the richest

    for (let i = 0; i < KEEP_RECENT * 3; i++) {
      await setSettings({ defaultWorkspace: `/Users/someone/w${i}` })
    }
    const counts = (await listGenerations('settings')).map((g) => g.entryCounts[0])
    // The pin tracks the richest generation, which by now holds the recovered
    // 61 — so the stale 45 is no longer special and ages out like anything else.
    expect(Math.max(...counts.map((c) => c ?? 0))).toBe(61)
    expect(counts).not.toContain(45)
    expect((await listRestoreCandidates('settings'))[0].entryCounts[0]).toBe(61)
  })

  it('pins the richest generation even against the size cap', async () => {
    await setSettings(settingsWith(45))
    await setSettings(settingsWith(2))
    for (let i = 0; i < 6; i++) await setSettings({ defaultWorkspace: `/Users/someone/w${i}` })
    // A cap nothing can satisfy: the pin still outranks it.
    await pruneBackups({ keepRecent: 0, maxTotalBytes: 1 })
    expect((await listGenerations('settings')).map((g) => g.entryCounts[0])).toContain(45)
  })

  it('KEEPS the card layout when only STICKIES keep growing (dimension pin)', async () => {
    // THE canvas half of this card's subject, and the shape a summed count let
    // through (review, 2026-07-19). Measured with the sum: after the wipe, the
    // pin followed the rising element total to n50, n60 … and the generation
    // holding 45 card POSITIONS was pruned — best recoverable layout: 3.
    const mk = (positions: number, elements: number) => ({
      positions: Object.fromEntries(
        Array.from({ length: positions }, (_, i) => [`uuid-${i}`, { x: i, y: i }]),
      ),
      viewport: { x: 0, y: 0, zoom: 1 },
      elements: Array.from({ length: elements }, (_, i) => ({ id: `el-${i}`, type: 'sticky' as const, x: i, y: i, text: '' })),
    })

    await setCanvas(mk(45, 0))
    await setCanvas(mk(3, 0)) // the layout is destroyed; snapshots the 45

    // Now the owner just keeps adding stickies. Every save GROWS the file, so a
    // summed rank hands the pin away step by step.
    for (let i = 1; i <= 60; i++) await setCanvas(mk(3, i))

    const gens = await listGenerations('canvas')
    const bestPositions = Math.max(...gens.map((g) => g.entryCounts[0] ?? 0))
    expect(bestPositions).toBe(45)

    // …and the owner is offered THAT file first when card positions are what
    // went missing.
    const byPositions = await listRestoreCandidates('canvas', { rankBy: 0 })
    expect(byPositions[0].entryCounts[0]).toBe(45)
  })

  it('pins each dimension independently — both survive', async () => {
    const mk = (positions: number, elements: number) => ({
      positions: Object.fromEntries(
        Array.from({ length: positions }, (_, i) => [`uuid-${i}`, { x: i, y: i }]),
      ),
      viewport: { x: 0, y: 0, zoom: 1 },
      elements: Array.from({ length: elements }, (_, i) => ({ id: `el-${i}`, type: 'sticky' as const, x: i, y: i, text: '' })),
    })
    await setCanvas(mk(45, 0)) //   richest POSITIONS will live here
    await setCanvas(mk(0, 80)) //   snapshot of 45/0
    await setCanvas(mk(0, 0)) //    snapshot of 0/80 — richest ELEMENTS
    for (let i = 0; i < KEEP_RECENT * 3; i++) await setCanvas(mk(1, i % 3))

    const gens = await listGenerations('canvas')
    expect(Math.max(...gens.map((g) => g.entryCounts[0] ?? 0))).toBe(45) // positions
    expect(Math.max(...gens.map((g) => g.entryCounts[1] ?? 0))).toBe(80) // elements
  })

  it('backs up ONLY the protected pair, and creates dirs lazily', async () => {
    // A fresh home has no backups tree at all — nothing has been overwritten yet,
    // so there is nothing to preserve and no empty scaffolding to leave behind.
    await setSettings({ defaultWorkspace: '/a' })
    expect(await readdir(join(home, 'backups')).catch(() => null)).toBeNull()

    // The second write is the first one with a predecessor to save.
    await setSettings({ defaultWorkspace: '/b' })
    expect(await readdir(join(home, 'backups'))).toEqual(['settings'])
    expect(await listGenerations('settings')).toHaveLength(1)

    // notifications.json churns constantly and is NOT protected — it must never
    // acquire a backup dir of its own.
    await markNotificationsRead(['x'])
    await markNotificationsRead(['y'])
    expect(await readdir(join(home, 'backups'))).toEqual(['settings'])
    expect(await listGenerations('canvas')).toEqual([])
  })
})

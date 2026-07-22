// Regression tests for the boot-time home-data damage check.
//
// GOAL CONDITION: the 2026-07-18 incident shape — the project registry shrinking
// 45 → 3 entries, with the test-fixture value `projectsMigratedAt =
// "2026-01-02T03:04:05.000Z"` mixed in — must make the check go RED, and a
// healthy home must keep it GREEN. Both directions are asserted: a detector that
// only ever fires is as useless as one that never does.
//
// HOME is isolated per test via mkdtemp + OPENGROUND_HOME (house style — the
// global src/test/setup-home.ts already redirects, this pins it per-test so
// nothing leaks between cases). Notifications are suppressed with notify:false
// except in the one test that asserts the bell fires.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  MIN_ABSOLUTE_LOSS,
  TEST_FIXTURE_VALUES,
  buildWarningMessage,
  acknowledgeIntegrityReport,
  checkHomeIntegrity,
  listRestoreCandidatesForAll,
  readLastIntegrityReport,
} from './homeIntegrity'
import { canvasFile, integrityFile, settingsFile } from './paths'
import { setSettings } from './store'
import { listSwarmNotifications } from './swarmNotifications'

let home: string
let savedHome: string | undefined
let warn: ReturnType<typeof vi.spyOn>

/** A settings.json with `n` registered projects. */
const settingsWith = (n: number, extra: Record<string, unknown> = {}) => ({
  projects: Array.from({ length: n }, (_, i) => ({
    id: `uuid-${i}`,
    path: `/Users/someone/projects/p${i}`,
    addedAt: '2026-06-01T00:00:00.000Z',
  })),
  defaultWorkspace: '/Users/someone/projects',
  projectsMigratedAt: '2026-06-01T13:31:58.700Z',
  ...extra,
})

/** A canvas.json holding `n` card positions. */
const canvasWith = (n: number) => ({
  positions: Object.fromEntries(
    Array.from({ length: n }, (_, i) => [`uuid-${i}`, { x: i * 10, y: i * 10 }]),
  ),
  viewport: { x: 0, y: 0, zoom: 1 },
  elements: [],
})

const writeSettings = (v: unknown) => writeFile(settingsFile(), JSON.stringify(v, null, 2))
const writeCanvas = (v: unknown) => writeFile(canvasFile(), JSON.stringify(v, null, 2))

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-integrity-')))
  savedHome = process.env.OPENGROUND_HOME
  process.env.OPENGROUND_HOME = home
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  warn.mockRestore()
  // NEVER `delete` this — see the note in homeBackup.test.ts. Unset means
  // openGroundHome() falls back to the user's REAL ~/.openground, and worker
  // processes are reused across test files.
  process.env.OPENGROUND_HOME = savedHome ?? home
  await rm(home, { recursive: true, force: true })
})

describe('checkHomeIntegrity — the 2026-07-18 incident shape', () => {
  it('goes RED on the real incident: registry 45 → 3 with the fixture value mixed in', async () => {
    // Boot 1: the healthy machine — 45 registered projects, 45 card positions.
    await writeSettings(settingsWith(45))
    await writeCanvas(canvasWith(45))
    const first = await checkHomeIntegrity({ notify: false })
    expect(first.findings).toEqual([]) // no baseline yet ⇒ record only, never alert

    // …then the damage: 3 projects left, and the value only a test can write.
    await writeSettings(
      settingsWith(3, { projectsMigratedAt: '2026-01-02T03:04:05.000Z' }),
    )
    await writeCanvas(canvasWith(3))

    // Boot 2: the check must SEE it.
    const report = await checkHomeIntegrity({ notify: false })

    const shrinkSettings = report.findings.find(
      (f) => f.kind === 'shrink' && f.file === 'settings',
    )
    expect(shrinkSettings).toMatchObject({ previous: 45, current: 3 })

    // The card layout is the half that was UNRECOVERABLE in the real incident —
    // it must be detected in its own right, not implied by the registry finding.
    expect(report.findings.find((f) => f.kind === 'shrink' && f.file === 'canvas')).toMatchObject({
      previous: 45,
      current: 3,
    })

    expect(report.findings.find((f) => f.kind === 'test-fixture-value')).toMatchObject({
      field: 'projectsMigratedAt',
      value: '2026-01-02T03:04:05.000Z',
    })
    expect(report.message).not.toBe('')
  })

  it('stays GREEN on a healthy home across repeated boots', async () => {
    await writeSettings(settingsWith(45))
    await writeCanvas(canvasWith(45))
    expect((await checkHomeIntegrity({ notify: false })).findings).toEqual([])
    expect((await checkHomeIntegrity({ notify: false })).findings).toEqual([])
    // Growth is never damage.
    await writeSettings(settingsWith(50))
    await writeCanvas(canvasWith(50))
    expect((await checkHomeIntegrity({ notify: false })).findings).toEqual([])
  })

  it('stays GREEN on routine tidying (45 → 40) — both bars must be cleared', async () => {
    await writeSettings(settingsWith(45))
    await writeCanvas(canvasWith(45))
    await checkHomeIntegrity({ notify: false })
    // 5 lost clears the absolute bar but the ratio is 0.11 — deliberate deletion,
    // not damage. A checker that cries here is one the owner learns to ignore.
    await writeSettings(settingsWith(40))
    await writeCanvas(canvasWith(40))
    expect((await checkHomeIntegrity({ notify: false })).findings).toEqual([])
  })

  it('stays GREEN on a fresh install (no baseline ⇒ no alert)', async () => {
    // Nothing on disk at all: the files are absent, not damaged.
    const report = await checkHomeIntegrity({ notify: false })
    expect(report.findings).toEqual([])
    expect(report.message).toBe('')
  })

  it('does not alert when a small home loses fewer than the absolute floor', async () => {
    await writeSettings(settingsWith(6))
    await checkHomeIntegrity({ notify: false })
    await writeSettings(settingsWith(6 - (MIN_ABSOLUTE_LOSS - 1))) // 2 lost of 6
    expect((await checkHomeIntegrity({ notify: false })).findings).toEqual([])
  })

  it('alerts on a TOTAL wipe even below the absolute floor', async () => {
    // 4 → 0 loses only 4 (under MIN_ABSOLUTE_LOSS) but losing everything is
    // never routine tidying.
    await writeSettings(settingsWith(4))
    await checkHomeIntegrity({ notify: false })
    await writeSettings(settingsWith(0))
    const report = await checkHomeIntegrity({ notify: false })
    expect(report.findings.find((f) => f.kind === 'shrink')).toMatchObject({
      previous: 4,
      current: 0,
    })
  })

  it('fails SAFE when its own watermark file is corrupt', async () => {
    await writeSettings(settingsWith(45))
    await checkHomeIntegrity({ notify: false })
    await writeSettings(settingsWith(3))
    // Something mangles integrity.json. Losing the baseline must cost a missed
    // detection, never a fabricated one — an unreadable watermark is "no
    // baseline" (rule 3), and rule 3 is silence.
    await writeFile(integrityFile(), '{ not json')

    const report = await checkHomeIntegrity({ notify: false })
    expect(report.findings).toEqual([])
    expect(report.notified).toBe(false)

    // …and it heals: the baseline is re-recorded, so the NEXT loss is caught.
    await writeSettings(settingsWith(0))
    expect((await checkHomeIntegrity({ notify: false })).findings).toContainEqual(
      expect.objectContaining({ kind: 'shrink', previous: 3, current: 0 }),
    )
  })

  it('detects a settings.json that became unreadable', async () => {
    await writeSettings(settingsWith(45))
    await checkHomeIntegrity({ notify: false })
    await writeFile(settingsFile(), '{ this is not json')
    const report = await checkHomeIntegrity({ notify: false })
    expect(report.findings.find((f) => f.kind === 'unreadable')).toMatchObject({
      file: 'settings',
      previous: 45,
    })
  })

  it('persists the full report so the evidence outlives the console', async () => {
    await writeSettings(settingsWith(45))
    await checkHomeIntegrity({ notify: false })
    await writeSettings(settingsWith(3))
    await checkHomeIntegrity({ notify: false })
    const wm = JSON.parse(await readFile(integrityFile(), 'utf8'))
    // The watermark itself moves on (see below); the RECORD of what happened,
    // with the numbers and the restore paths, is what has to survive.
    expect(wm.lastReport.message).toContain('45')
    expect(wm.lastReport.message).toContain('3 件')
  })

  it('does not nag while the owner is rebuilding after an accepted loss', async () => {
    await writeSettings(settingsWith(45))
    await checkHomeIntegrity({})
    await writeSettings(settingsWith(3))
    expect((await checkHomeIntegrity({})).notified).toBe(true) // reported once

    // The owner decides to move on and adds projects back one at a time. If the
    // baseline stayed pinned at 45, each of these would compute a fresh shrink
    // (45→4, 45→5, …) with a fresh signature and alert all over again.
    for (const n of [4, 5, 6, 7]) {
      await writeSettings(settingsWith(n))
      const r = await checkHomeIntegrity({})
      expect(r.findings).toEqual([])
      expect(r.notified).toBe(false)
    }

    const bell = await listSwarmNotifications()
    expect(bell.filter((n) => n.swarmFatal?.event === 'data-integrity')).toHaveLength(1)
  })
})

describe('checkHomeIntegrity — every fixture co-signature', () => {
  // The three keys are written by ONE Promise.all in storeSettingsRace.test.ts and
  // race each other, so a partial escape can land any one of them alone.
  for (const [field, values] of Object.entries(TEST_FIXTURE_VALUES)) {
    for (const value of values) {
      it(`detects ${field}="${value}" on its own`, async () => {
        await writeSettings(settingsWith(45, { [field]: value }))
        const report = await checkHomeIntegrity({ notify: false })
        expect(report.findings).toContainEqual(
          expect.objectContaining({ kind: 'test-fixture-value', field, value }),
        )
      })
    }
  }

  it('does not flag a legitimate value in the same field', async () => {
    await writeSettings(
      settingsWith(45, {
        projectsMigratedAt: '2026-06-01T13:31:58.700Z',
        defaultWorkspace: '/Users/someone/projects',
        archiveDirName: '_archive',
      }),
    )
    const report = await checkHomeIntegrity({ notify: false })
    expect(report.findings.filter((f) => f.kind === 'test-fixture-value')).toEqual([])
  })
})

describe('checkHomeIntegrity — it never repairs what it judges', () => {
  it('leaves the damaged files byte-identical', async () => {
    await writeSettings(settingsWith(45))
    await writeCanvas(canvasWith(45))
    await checkHomeIntegrity({ notify: false })

    await writeSettings(settingsWith(3, { projectsMigratedAt: '2026-01-02T03:04:05.000Z' }))
    await writeCanvas(canvasWith(3))
    const settingsBefore = await readFile(settingsFile(), 'utf8')
    const canvasBefore = await readFile(canvasFile(), 'utf8')

    const report = await checkHomeIntegrity({ notify: false })
    expect(report.findings.length).toBeGreaterThan(0)

    // Rules 1 and 2: no repair, no auto-restore. The damaged state is EVIDENCE;
    // the user decides what happens to it.
    expect(await readFile(settingsFile(), 'utf8')).toBe(settingsBefore)
    expect(await readFile(canvasFile(), 'utf8')).toBe(canvasBefore)
  })
})

describe('checkHomeIntegrity — re-alert suppression', () => {
  it('reports a PERSISTING problem once, then stays quiet about it', async () => {
    // Contamination is the case the signature dedupe exists for: unlike a
    // shrink (detected once, because the watermark then moves to the new count)
    // a fixture value sits in the file and re-detects on every single boot.
    await writeSettings(settingsWith(45, { archiveDirName: '_arc' }))

    const first = await checkHomeIntegrity({})
    expect(first.findings).toContainEqual(
      expect.objectContaining({ kind: 'test-fixture-value', value: '_arc' }),
    )
    expect(first.notified).toBe(true)

    const second = await checkHomeIntegrity({})
    // The finding is still TRUE — the bad value really is still in the file — so
    // the report stays honest for anything reading it. Only the ALERT is muted.
    expect(second.findings).toContainEqual(
      expect.objectContaining({ kind: 'test-fixture-value', value: '_arc' }),
    )
    expect(second.notified).toBe(false)

    expect(
      (await listSwarmNotifications()).filter((n) => n.swarmFatal?.event === 'data-integrity'),
    ).toHaveLength(1)
  })

  it('detects a shrink exactly once — the baseline then follows the file', async () => {
    await writeSettings(settingsWith(45))
    await checkHomeIntegrity({ notify: false })
    await writeSettings(settingsWith(3))

    expect((await checkHomeIntegrity({ notify: false })).findings).toHaveLength(1)
    // Second boot: 3 vs a baseline of 3. Nothing new happened, so nothing is
    // reported — the incident lives on in lastReport, the bell and the backups.
    expect((await checkHomeIntegrity({ notify: false })).findings).toEqual([])
  })

  it('re-alerts for a SECOND incident from the same baseline after a clean boot', async () => {
    await writeSettings(settingsWith(45))
    await checkHomeIntegrity({ notify: false })

    // Incident 1 → alert (bell fires).
    await writeSettings(settingsWith(3))
    expect((await checkHomeIntegrity({})).notified).toBe(true)

    // The owner restores. A clean boot must CLEAR the dedupe record.
    await writeSettings(settingsWith(45))
    expect((await checkHomeIntegrity({})).findings).toEqual([])

    // Incident 2 — same 45 → 3 signature as incident 1. Deduping on the
    // signature alone would swallow this entirely.
    await writeSettings(settingsWith(3))
    expect((await checkHomeIntegrity({})).notified).toBe(true)

    const bell = await listSwarmNotifications()
    const integrity = bell.filter((n) => n.swarmFatal?.event === 'data-integrity')
    expect(integrity.length).toBe(2)
  })
})

describe('checkHomeIntegrity — a SLOW bleed across boots', () => {
  // Regression, adversarial review 2026-07-19. Making the baseline follow the
  // file (the fix for the rebuild treadmill) opened the opposite hole: a loss
  // spread one small step per boot never trips the per-boot bar and ends with
  // everything gone and nothing ever reported. Sharpest under `tsx watch`, where
  // every file save restarts the server — i.e. exactly how this gets dogfooded.
  it('catches the cumulative drop no single boot would flag', async () => {
    await writeSettings(settingsWith(45))
    await checkHomeIntegrity({ notify: false })

    // Each step is far too small for bar 1 (needs ≥50% of the previous count).
    for (const n of [40, 35, 30, 26]) {
      await writeSettings(settingsWith(n))
      expect((await checkHomeIntegrity({ notify: false })).findings).toEqual([])
    }

    // Cumulatively this is 45 → 22: half the peak is gone, and bar 2 says so.
    await writeSettings(settingsWith(22))
    const report = await checkHomeIntegrity({ notify: false })
    expect(report.findings).toContainEqual(
      expect.objectContaining({ kind: 'shrink', file: 'settings', previous: 45, current: 22 }),
    )
  })

  it('does not nag once the bleed has been reported and the owner rebuilds', async () => {
    await writeSettings(settingsWith(45))
    await checkHomeIntegrity({ notify: false })
    for (const n of [40, 35, 30, 26, 22]) {
      await writeSettings(settingsWith(n))
      await checkHomeIntegrity({ notify: false })
    }
    // The high-water mark reset to 22 when it fired, so climbing back is silent.
    for (const n of [25, 30, 35]) {
      await writeSettings(settingsWith(n))
      expect((await checkHomeIntegrity({ notify: false })).findings).toEqual([])
    }
  })

  it('reports one incident as ONE finding, not one per bar', async () => {
    await writeSettings(settingsWith(45))
    await checkHomeIntegrity({ notify: false })
    await writeSettings(settingsWith(3)) // trips bar 1 AND bar 2 at once
    const report = await checkHomeIntegrity({ notify: false })
    expect(report.findings.filter((f) => f.kind === 'shrink' && f.file === 'settings')).toHaveLength(1)
  })
})

describe('checkHomeIntegrity — the evidence outlives the incident', () => {
  it('carries lastReport forward through later clean boots', async () => {
    await writeSettings(settingsWith(45))
    await checkHomeIntegrity({ notify: false })
    await writeSettings(settingsWith(3))
    await checkHomeIntegrity({ notify: false }) // detected + recorded

    // Two quiet boots. An earlier version replaced the whole watermark on a
    // clean boot, so the report vanished one relaunch after the incident —
    // while a comment claimed it was the durable record.
    await checkHomeIntegrity({ notify: false })
    await checkHomeIntegrity({ notify: false })

    const wm = JSON.parse(await readFile(integrityFile(), 'utf8'))
    expect(wm.lastReport?.message).toContain('45')
    expect(wm.lastReport?.message).toContain('3 件')
  })
})

describe('checkHomeIntegrity — a loss confined to ONE session', () => {
  // Regression, review 2026-07-19. The watermark is written only at startup, and
  // Electron does not restart, so this sequence recorded nothing to compare
  // against and BOTH bars stayed silent while the registry was wiped:
  //   fresh install (0) → boot → owner imports 45 → something wipes it to 3.
  // The backups written during that session plainly held 45; the check just
  // wasn't consulting them. Now the high-water mark is the larger of what was
  // recorded and what the generations remember.
  it('catches a wipe that began and ended between two boots', async () => {
    // Boot 1 on a fresh install: nothing on disk, nothing to say.
    await writeSettings(settingsWith(0))
    expect((await checkHomeIntegrity({ notify: false })).findings).toEqual([])

    // The owner imports 45 projects. These go through the real save path, so
    // each one leaves a generation behind — no restart anywhere in here.
    for (let n = 1; n <= 45; n++) await setSettings(settingsWith(n))

    // …then the wipe, also within the session.
    await setSettings(settingsWith(3))

    // Boot 2. The recorded count is still 0, so only the backups know.
    const report = await checkHomeIntegrity({ notify: false })
    expect(report.findings).toContainEqual(
      expect.objectContaining({ kind: 'shrink', file: 'settings', current: 3 }),
    )
    expect(report.findings.find((f) => f.kind === 'shrink')?.previous).toBeGreaterThanOrEqual(44)
  })
})

describe('checkHomeIntegrity — one dimension must not hide another', () => {
  const canvasOf = (positions: number, elements: number) => ({
    positions: Object.fromEntries(
      Array.from({ length: positions }, (_, i) => [`uuid-${i}`, { x: i, y: i }]),
    ),
    viewport: { x: 0, y: 0, zoom: 1 },
    elements: Array.from({ length: elements }, (_, i) => ({ id: `el-${i}`, type: 'sticky' as const, x: i, y: i, text: '' })),
  })

  it('sees EVERY card position vanish even as elements pile up', async () => {
    // Measured against the summed version (review 2026-07-19): findings were [].
    // 145 → 100 is a 31% drop, under both ratio bars — so losing the entire card
    // layout, this card's subject, reported nothing at all.
    await writeCanvas(canvasOf(45, 0))
    await checkHomeIntegrity({ notify: false })

    await writeCanvas(canvasOf(45, 100)) // the owner adds a lot of stickies
    await checkHomeIntegrity({ notify: false })

    await writeCanvas(canvasOf(0, 100)) // …and every card position disappears
    const report = await checkHomeIntegrity({ notify: false })

    expect(report.findings).toContainEqual(
      expect.objectContaining({
        kind: 'shrink',
        file: 'canvas',
        dimension: 'positions',
        current: 0,
      }),
    )
  })

  it('names the dimension in the owner-facing text', async () => {
    await writeCanvas(canvasOf(45, 0))
    await checkHomeIntegrity({ notify: false })
    await writeCanvas(canvasOf(0, 0))
    const report = await checkHomeIntegrity({ notify: false })
    expect(report.message).toContain('カードの配置')
  })

  it('does not cry about elements when only elements were tidied', async () => {
    await writeCanvas(canvasOf(45, 4))
    await checkHomeIntegrity({ notify: false })
    await writeCanvas(canvasOf(45, 2)) // removed 2 of 4 stickies — routine
    expect((await checkHomeIntegrity({ notify: false })).findings).toEqual([])
  })
})

describe('checkHomeIntegrity — reporting a loss must not become nagging', () => {
  // Regression, review 2026-07-19. The pin keeps the pre-damage generation alive
  // FOREVER by design, so deriving the peak from all generations resurrected
  // "45" on every boot: each project the owner restored by hand produced a new
  // signature (45→4, 45→5, 45→6 …) that slipped the dedupe and rang a fresh
  // fatal bell + OS toast. The generation-derived peak is now windowed to after
  // the last alert.
  it('rings once for the loss, then stays silent through the repair', async () => {
    await writeSettings(settingsWith(45))
    await checkHomeIntegrity({})
    await setSettings(settingsWith(3)) // real save path ⇒ leaves the n45 generation

    expect((await checkHomeIntegrity({})).notified).toBe(true)

    // The owner puts projects back one at a time.
    for (const n of [4, 5, 6, 7]) {
      await setSettings(settingsWith(n))
      const r = await checkHomeIntegrity({})
      expect(r.notified).toBe(false)
      expect(r.findings).toEqual([])
    }

    expect(
      (await listSwarmNotifications()).filter((n) => n.swarmFatal?.event === 'data-integrity'),
    ).toHaveLength(1)
  })

  it('still catches a SECOND, genuinely new loss after the first was reported', async () => {
    await writeSettings(settingsWith(45))
    await checkHomeIntegrity({})
    await setSettings(settingsWith(3))
    expect((await checkHomeIntegrity({})).notified).toBe(true)

    // Rebuild to a healthy 40 — silent (above).
    for (const n of [10, 20, 30, 40]) {
      await setSettings(settingsWith(n))
      await checkHomeIntegrity({})
    }
    // …then it happens again. Windowing the peak must not blind us to this.
    await setSettings(settingsWith(2))
    expect((await checkHomeIntegrity({})).notified).toBe(true)
  })

  it('acknowledge accepts the current state and never touches the backups', async () => {
    await writeSettings(settingsWith(45))
    await checkHomeIntegrity({ notify: false })
    await setSettings(settingsWith(3))
    expect((await checkHomeIntegrity({ notify: false })).findings.length).toBeGreaterThan(0)

    const before = (await listRestoreCandidatesForAll()).settings.candidates.length
    await acknowledgeIntegrityReport()

    // Silent afterwards…
    expect((await checkHomeIntegrity({ notify: false })).findings).toEqual([])
    // …but "stop telling me" is not "throw away my only copy".
    const after = await listRestoreCandidatesForAll()
    expect(after.settings.candidates.length).toBe(before)
    expect(after.settings.candidates.some((c) => c.entryCounts[0] === 45)).toBe(true)
  })
})

describe('the owner-facing surface says WHERE the backups are', () => {
  // Regression, review 2026-07-19: the bell promised "you can restore" without
  // naming a location, and no route or screen existed to ask.
  it('names an absolute backup path in the bell notification', async () => {
    await writeSettings(settingsWith(45))
    await checkHomeIntegrity({ notify: false })
    await setSettings(settingsWith(3))

    const report = await checkHomeIntegrity({})
    expect(report.notified).toBe(true)

    const n = (await listSwarmNotifications()).find(
      (x) => x.swarmFatal?.event === 'data-integrity',
    )
    expect(n).toBeTruthy()
    // First line: what happened, with the numbers.
    expect(n!.swarmFatal!.detail).toContain('45')
    // Second line: where to go. An absolute path under the isolated home.
    expect(n!.swarmFatal!.logHint).toContain(join(home, 'backups', 'settings'))
    expect(n!.swarmFatal!.logHint).toMatch(/世代/)
  })

  it('serves the same report on demand, without restoring anything', async () => {
    await writeSettings(settingsWith(45))
    await checkHomeIntegrity({ notify: false })
    await setSettings(settingsWith(3))
    await checkHomeIntegrity({ notify: false })

    const [lastReport, all] = await Promise.all([
      readLastIntegrityReport(),
      listRestoreCandidatesForAll(),
    ])
    expect(lastReport?.message).toContain('45')
    expect(all.settings.dir).toBe(join(home, 'backups', 'settings'))
    expect(all.settings.candidates[0].entryCounts[0]).toBe(45)

    // Reading the report must not have changed the damaged file (rule 2).
    expect(JSON.parse(await readFile(settingsFile(), 'utf8')).projects).toHaveLength(3)
  })
})

describe('buildWarningMessage — plain Japanese for a non-programmer', () => {
  const findings = [
    { kind: 'shrink' as const, file: 'settings' as const, previous: 45, current: 3 },
  ]
  const candidates = {
    settings: [
      {
        path: '/Users/x/.openground/backups/settings/20260718T120000000Z-abcd1234.json',
        source: 'backup' as const,
        at: Date.parse('2026-07-18T12:00:00.000Z'),
        entryCounts: [45],
        bytes: 6820,
      },
    ],
  }

  it('answers all three required questions, in order', async () => {
    const msg = buildWarningMessage(findings, candidates)
    const what = msg.indexOf('【何が起きたか】')
    const choose = msg.indexOf('【何を選べるか】')
    const effect = msg.indexOf('【選ぶとどうなるか】')
    expect(what).toBeGreaterThanOrEqual(0)
    expect(choose).toBeGreaterThan(what)
    expect(effect).toBeGreaterThan(choose)
  })

  it('states the concrete numbers and offers the restore candidate with its count', () => {
    const msg = buildWarningMessage(findings, candidates)
    expect(msg).toContain('45 件')
    expect(msg).toContain('3 件')
    // The candidate is described BY DIMENSION — never a bare total, which is
    // what let a rich-looking canvas hide an empty card layout.
    expect(msg).toContain('プロジェクトの登録 45 件')
    expect(msg).toContain(candidates.settings[0].path)
  })

  it('promises no automatic restore', () => {
    expect(buildWarningMessage(findings, candidates)).toContain('勝手に元へ戻すことはありません')
  })

  it('does not accuse the owner when the deletion may have been deliberate', () => {
    // The shrink threshold cannot distinguish "45 projects were clobbered" from
    // "I cleaned out 42 old projects yesterday" — only the owner knows. The text
    // must therefore offer both readings instead of declaring damage.
    const msg = buildWarningMessage(findings, candidates)
    expect(msg).toContain('ご自身で整理された場合')
    expect(msg).toContain('心当たりがない場合')
  })

  it('uses no programmer jargon', () => {
    const msg = buildWarningMessage(findings, candidates)
    // The owner is not a programmer (docs: plain-language rule for owner-facing
    // surfaces). These are the words a draft slips into first.
    for (const jargon of [
      'registry',
      'JSON',
      'パース',
      'スキーマ',
      'マイグレーション',
      'watermark',
      'null',
      'undefined',
    ]) {
      expect(msg).not.toContain(jargon)
    }
  })

  it('is honest when there is nothing to restore from', () => {
    const msg = buildWarningMessage(findings, {})
    expect(msg).toContain('控えが見つかりませんでした')
    // It must not dangle a "restore" option it cannot deliver.
    expect(msg).not.toContain('下の控えから選んで')
  })

  it('is empty when nothing is wrong', () => {
    expect(buildWarningMessage([], {})).toBe('')
  })

  it('never renders NaN as a date', () => {
    // A generation filename can satisfy the naming regex and still not be a real
    // instant (20261345T… — month 13, day 45). "NaN年NaN月NaN日" inside a warning
    // about lost data reads as a second bug on top of the first.
    const msg = buildWarningMessage(findings, {
      settings: [
        {
          path: '/x/.openground/backups/settings/20261345T999999999Z-deadbeef.json',
          source: 'backup' as const,
          at: Date.parse('nonsense'),
          entryCounts: [45],
          bytes: 10,
        },
      ],
    })
    expect(msg).not.toContain('NaN')
    expect(msg).toContain('日時不明')
  })
})

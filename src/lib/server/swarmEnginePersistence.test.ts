import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import {
  readEngineIntent,
  writeEngineIntent,
  patchEngineIntent,
  recordEngineBoot,
  isCrashLoopTripped,
} from './swarmEnginePersistence'
import { settingsFile, engineBootsFile, projectCentralDir } from './paths'

// Real fs + canonicalize + settings I/O under load can occasionally exceed
// vitest's 5s default (reference_vitest_5s_default_is_the_flake_root) — same
// margin as this repo's sibling real-fs suites. Pinned to the canonical
// ceiling (vitest.config.ts's 60s); a shorter value here would silently
// re-cap that global back down (setConfig runs after the global config).
vi.setConfig({ testTimeout: 60_000 })

// This suite runs against the whole-file OPENGROUND_HOME tmpdir pinned by
// src/test/setup-home.ts. Registering a project touches settings.json (the
// registry) inside that same home, so each test cleans up its own project
// registration to avoid leaking into the next test in this file.

let projDir = ''
let uuid = ''

beforeEach(async () => {
  projDir = await mkdtemp(join(tmpdir(), 'og-engperst-proj-'))
  uuid = randomUUID()
  await writeFile(
    settingsFile(),
    JSON.stringify({ projects: [{ id: uuid, path: projDir, addedAt: '2026-01-01T00:00:00.000Z' }] }),
  )
})

afterEach(async () => {
  await rm(projDir, { recursive: true, force: true })
  await rm(projectCentralDir(uuid), { recursive: true, force: true }).catch(() => {})
  await writeFile(settingsFile(), JSON.stringify({ projects: [] }))
  await rm(engineBootsFile(), { force: true })
})

describe('swarmEnginePersistence — engine intent (write-through, fail-quiet-to-OFF / fail-open)', () => {
  it('readEngineIntent defaults to not-running when engine.json was never written', async () => {
    const intent = await readEngineIntent(projDir)
    expect(intent).toEqual({ desiredRunning: false, selfSupply: false, overseer: false, updatedAt: 0 })
  })

  it('round-trips a written intent', async () => {
    const ok = await writeEngineIntent(
      projDir,
      { desiredRunning: true, selfSupply: true, overseer: false },
      5000,
    )
    expect(ok).toBe(true)
    const intent = await readEngineIntent(projDir)
    expect(intent).toEqual({ desiredRunning: true, selfSupply: true, overseer: false, updatedAt: 5000 })
  })

  it('lands the file at ~/.openground/projects/<uuid>/engine.json', async () => {
    await writeEngineIntent(projDir, { desiredRunning: true, selfSupply: false, overseer: false })
    const raw = await readFile(join(projectCentralDir(uuid), 'engine.json'), 'utf8')
    expect(JSON.parse(raw).desiredRunning).toBe(true)
  })

  it('fail-quiet-to-OFF: a corrupt engine.json reads back as not-running, never throws', async () => {
    const dir = projectCentralDir(uuid)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'engine.json'), '{ this is not json')
    const intent = await readEngineIntent(projDir)
    expect(intent.desiredRunning).toBe(false)
  })

  it('fail-quiet-to-OFF: a hand-corrupted non-boolean field is coerced, never thrown', async () => {
    const dir = projectCentralDir(uuid)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'engine.json'), JSON.stringify({ desiredRunning: 'yes', overseer: 1 }))
    const intent = await readEngineIntent(projDir)
    expect(intent).toEqual({ desiredRunning: false, selfSupply: false, overseer: false, updatedAt: 0 })
  })

  it('patchEngineIntent updates only the given field, preserving the rest read fresh from disk', async () => {
    await writeEngineIntent(projDir, { desiredRunning: true, selfSupply: false, overseer: false }, 1000)
    const ok = await patchEngineIntent(projDir, { selfSupply: true }, 2000)
    expect(ok).toBe(true)
    const intent = await readEngineIntent(projDir)
    expect(intent).toEqual({ desiredRunning: true, selfSupply: true, overseer: false, updatedAt: 2000 })
  })

  it('patchEngineIntent never resurrects a stale desiredRunning:false into true, and vice versa — it only ever touches its own field', async () => {
    await writeEngineIntent(projDir, { desiredRunning: true, selfSupply: false, overseer: false })
    await patchEngineIntent(projDir, { overseer: true })
    let intent = await readEngineIntent(projDir)
    expect(intent).toMatchObject({ desiredRunning: true, selfSupply: false, overseer: true })

    await writeEngineIntent(projDir, { desiredRunning: false, selfSupply: true, overseer: false })
    await patchEngineIntent(projDir, { selfSupply: false })
    intent = await readEngineIntent(projDir)
    // desiredRunning stays FALSE — a patch call must never flip it, in EITHER
    // direction, even though nothing here explicitly asked for false.
    expect(intent).toMatchObject({ desiredRunning: false, selfSupply: false, overseer: false })
  })

  it('patchEngineIntent on a never-written project starts from defaults, not a throw', async () => {
    const ok = await patchEngineIntent(projDir, { selfSupply: true })
    expect(ok).toBe(true)
    const intent = await readEngineIntent(projDir)
    expect(intent).toMatchObject({ desiredRunning: false, selfSupply: true, overseer: false })
  })

  it('fail-open: writing for an UNREGISTERED project returns false, never throws', async () => {
    const unregistered = await mkdtemp(join(tmpdir(), 'og-engperst-unreg-'))
    try {
      const ok = await writeEngineIntent(unregistered, {
        desiredRunning: true,
        selfSupply: false,
        overseer: false,
      })
      expect(ok).toBe(false)
    } finally {
      await rm(unregistered, { recursive: true, force: true })
    }
  })

  it('fail-quiet-to-OFF: reading for an UNREGISTERED project resolves to defaults, never throws', async () => {
    const unregistered = await mkdtemp(join(tmpdir(), 'og-engperst-unreg2-'))
    try {
      const intent = await readEngineIntent(unregistered)
      expect(intent.desiredRunning).toBe(false)
    } finally {
      await rm(unregistered, { recursive: true, force: true })
    }
  })
})

describe('swarmEnginePersistence — crash-loop breaker ring', () => {
  it('recordEngineBoot appends and persists to engine-boots.json, reporting persisted:true', async () => {
    const first = await recordEngineBoot('1.0.0', 1000)
    const second = await recordEngineBoot('1.0.0', 2000)
    expect(first.persisted).toBe(true)
    expect(second.persisted).toBe(true)
    const raw = JSON.parse(await readFile(engineBootsFile(), 'utf8')) as { items: unknown[] }
    expect(raw.items).toHaveLength(2)
  })

  it('caps the ring at 10 entries (oldest dropped)', async () => {
    let items: { at: number; appVersion: string }[] = []
    for (let i = 0; i < 12; i++) {
      ;({ items } = await recordEngineBoot('1.0.0', i * 1000))
    }
    expect(items).toHaveLength(10)
    // the two oldest (at 0 and 1000) were dropped
    expect(items[0].at).toBe(2000)
  })

  it('isCrashLoopTripped: false below the threshold', () => {
    const items = [
      { at: 1000, appVersion: '1.0.0' },
      { at: 2000, appVersion: '1.0.0' },
    ]
    expect(isCrashLoopTripped(items, '1.0.0', 3000)).toBe(false)
  })

  it('isCrashLoopTripped: true at 3 boots of the SAME version within the window', () => {
    const items = [
      { at: 1000, appVersion: '1.0.0' },
      { at: 2000, appVersion: '1.0.0' },
      { at: 3000, appVersion: '1.0.0' },
    ]
    expect(isCrashLoopTripped(items, '1.0.0', 3000)).toBe(true)
  })

  it('a VERSION BUMP resets the window — older-version boots do not count', () => {
    const items = [
      { at: 1000, appVersion: '1.0.0' },
      { at: 2000, appVersion: '1.0.0' },
      { at: 3000, appVersion: '1.1.0' }, // the self-update cutover itself
    ]
    expect(isCrashLoopTripped(items, '1.1.0', 3000)).toBe(false)
  })

  it('boots OUTSIDE the 10-minute window do not count', () => {
    const items = [
      { at: 0, appVersion: '1.0.0' },
      { at: 1000, appVersion: '1.0.0' },
      { at: 20 * 60 * 1000, appVersion: '1.0.0' }, // 20 minutes later
    ]
    expect(isCrashLoopTripped(items, '1.0.0', 20 * 60 * 1000)).toBe(false)
  })

  it('recordEngineBoot never throws even if the write faults, but reports persisted:false (FAIL-CLOSED)', async () => {
    // Directing engine-boots.json AT a directory (not a file) makes the atomic
    // rename fail — the write-fault path recordEngineBoot must swallow the
    // throw, but — unlike writeEngineIntent — it must NOT claim success: the
    // breaker is the one write in this module that fails CLOSED (a caller that
    // trusted `persisted` blindly would resume unattended workers with the
    // ONE crash-loop safety valve silently unable to count anything).
    const dir = engineBootsFile()
    await mkdir(dir, { recursive: true })
    try {
      const result = await recordEngineBoot('1.0.0', 1000)
      expect(result.persisted).toBe(false)
      expect(result.items).toBeDefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('MUST-FIX: a genuinely FIRST-EVER launch (no ~/.openground/ yet) still persists — no false "disk write failed" alarm', async () => {
    // Regression for the 2nd rework's must-fix B: recordEngineBoot used to call
    // atomicWriteJson directly with no ensure-home step, so a brand-new install
    // (whose OPENGROUND_HOME directory has genuinely never been created) hit
    // ENOENT on the very first boot, came back persisted:false, and the
    // fail-CLOSED breaker (previous test) fired a fatal "couldn't save boot
    // history" notification at an owner with zero projects and a perfectly
    // healthy disk. Point OPENGROUND_HOME at a path that exists ONLY as an
    // unmaterialized subpath of a real tmp root (mkdtemp creates the root, but
    // never the leaf) — the exact shape of a fresh install's home before
    // anything has ever run.
    //
    // vi.resetModules() + a fresh dynamic import is REQUIRED here (mirrors
    // testHomeGuard.test.ts's own ensureOpenGroundHome coverage): paths.ts
    // memoizes ensureOpenGroundHome() in a module-level `homeReady` promise
    // for the life of the process, so a plain re-pin of OPENGROUND_HOME after
    // it has already resolved once in this test file (every test above did,
    // via writeEngineIntent) would just replay the STALE cached promise and
    // never actually exercise the "directory doesn't exist yet" branch this
    // test targets.
    const root = await mkdtemp(join(tmpdir(), 'og-engperst-freshroot-'))
    const neverCreated = join(root, 'never-created', '.openground')
    const prevHome = process.env.OPENGROUND_HOME
    process.env.OPENGROUND_HOME = neverCreated
    vi.resetModules()
    try {
      const fresh = await import('./swarmEnginePersistence')
      const result = await fresh.recordEngineBoot('1.0.0', 1000)
      expect(result.persisted).toBe(true)
      expect(result.items).toEqual([{ at: 1000, appVersion: '1.0.0' }])
      const raw = JSON.parse(await readFile(join(neverCreated, 'engine-boots.json'), 'utf8')) as {
        items: unknown[]
      }
      expect(raw.items).toHaveLength(1)
    } finally {
      process.env.OPENGROUND_HOME = prevHome
      vi.resetModules()
      await rm(root, { recursive: true, force: true })
    }
  })
})

// ── The daily self-supply cap must survive a restart (2026-07-29) ────────────
// `selfSupply.enabled` was already restored at boot while the DAILY COUNTER
// lived only in memory, so every restart re-armed self-supply with a fresh
// budget. The engine restarts on every self-update — i.e. exactly when it has
// been proposing work to itself — so the guard that exists to bound a runaway
// was being reset by the very loop it bounds, and each round re-spawns the full
// scan (tsc + eslint + a whole `vitest run`).
describe('EngineIntent — the self-supply daily budget round-trips', () => {
  it('persists and restores dayKey + dayCount', async () => {
    await writeEngineIntent(projDir, {
      desiredRunning: true,
      selfSupply: true,
      overseer: false,
      selfSupplyDayKey: '2026-07-29',
      selfSupplyDayCount: 4,
    })
    const back = await readEngineIntent(projDir)
    expect(back.selfSupplyDayKey).toBe('2026-07-29')
    expect(back.selfSupplyDayCount).toBe(4)
  })

  it('an OLDER engine.json without the fields degrades to "no count yet", never to unbounded', async () => {
    const dir = projectCentralDir(uuid)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'engine.json'),
      JSON.stringify({ desiredRunning: true, selfSupply: true, overseer: false, updatedAt: 1 }),
      'utf8',
    )
    const back = await readEngineIntent(projDir)
    expect(back.selfSupply).toBe(true)
    expect(back.selfSupplyDayCount).toBeUndefined() // ⇒ today's budget, not an unbounded one
  })

  it('a corrupt/negative count is ignored rather than trusted', async () => {
    await writeEngineIntent(projDir, {
      desiredRunning: true,
      selfSupply: true,
      overseer: false,
      selfSupplyDayKey: '2026-07-29',
      selfSupplyDayCount: -5,
    })
    expect((await readEngineIntent(projDir)).selfSupplyDayCount).toBeUndefined()
  })
})

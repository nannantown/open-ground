// THE KILL SWITCH MUST DRAW WHAT THE SERVER IS DOING — SO THIS FILE COMPARES
// THE TWO THINGS THAT ACTUALLY DECIDE IT, NOT TWO PIECES THAT RESEMBLE THEM.
//
// The two Swarm-tab toggles ARE the safety story of the SDK runtime: "if
// anything goes wrong, turn it off — no release needed." A toggle that reads OFF
// while the server is running SDK is not a switch the owner can trust, and they
// would be reading it at exactly the moment something had gone wrong.
//
// ⚠ WHAT THIS FILE USED TO DO, AND WHY THAT WAS WORSE THAN NOTHING. Until
// 2026-08-02 it compared `chooseWorkerRuntime` (called DIRECTLY) against a
// hand-copied `dialOf` lifted out of SwarmModule. Neither side was what ships:
//
//   • production never calls chooseWorkerRuntime with a raw settings object —
//     swarmWorker.ts hands it `await store.getWorkerRuntimeDial()`, and that
//     reader turned an ABSENT dial into an explicit {mode:'pty'}, so the rule
//     "absent ⇒ sdk" inside chooseWorkerRuntime was unreachable on the one
//     machine state that matters (a fresh install).
//   • the panel's copy was a copy: it could only ever agree with the piece it
//     was copied from.
//
// Result: this file declared "the toggles draw what the server does" and pinned
// "the SHIPPED state is SDK on both sides" — while the shipped state actually
// dispatched PTY workers under a switch drawn ON. A guard that is green while
// the defect it names is live is not a guard; it is a false receipt.
//
// WHAT IT DOES NOW. Three real things, over real settings.json states:
//
//   dispatched worker  = store.getWorkerRuntimeDial() → chooseWorkerRuntime
//                        (composed exactly as swarmWorker.ts:804 composes it)
//   seated commander   = store.getManagerRuntimeDial()   (swarmManager.ts:734)
//   what the panel draws = GET /api/settings → runtimeDialsEffective
//                        (the panel now RENDERS this; it derives nothing)
//
// The panel's number is served BY those same readers, which is the point: the
// agreement is structural, not a coincidence two copies have to keep. What is
// still worth pinning is that nothing re-opens the gap — a future
// chooseWorkerRuntime that reinterprets an EXPLICIT dial, a route that answers
// from the raw settings instead of the readers, or a panel that goes back to
// deriving. Each of those reds a case below.
//
// The two stubs on the dispatch side (empty pool, passing preflight) are
// deliberate: they hold "everything except the dial is fine" so a disagreement
// can only mean the dial. A worker that degrades because the SDK slots are full
// or the preflight failed is NOT the toggle lying — that path reports itself
// through `fellBackBecause`, per worker, and the switch still says what the
// owner chose.

import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { app } from '../../../server/app'
import { settingsFile } from './paths'
import { getManagerRuntimeDial, getWorkerRuntimeDial } from './store'
import { chooseWorkerRuntime, sdkSlotLimit } from './swarmWorkerRuntimeDial'

const write = async (raw: string) => {
  // `dirname`, NOT a file:// URL round trip — that PERCENT-ENCODES the path, so
  // on a machine whose TMPDIR contains a space this would write to a different
  // directory and the test would silently stop testing the home it pinned.
  await mkdir(dirname(settingsFile()), { recursive: true }).catch(() => {})
  await writeFile(settingsFile(), raw, 'utf8')
}

/** Back to "no settings.json at all". The chmod comes FIRST — a 000 file left by
 *  a previous case resists `rm` in some sandboxes and would poison every case
 *  after it. */
const clear = async () => {
  await chmod(settingsFile(), 0o600).catch(() => {})
  await rm(settingsFile(), { force: true }).catch(() => {})
}

/** Make the file unreadable and report whether that ACTUALLY blocks a read. Root
 *  ignores mode bits and Windows has no equivalent, so probe rather than assert
 *  something the platform never did — a case that silently tests nothing is
 *  worse than one that says it skipped. */
const denyRead = async (): Promise<boolean> => {
  await chmod(settingsFile(), 0o000)
  try {
    await readFile(settingsFile(), 'utf8')
    return false
  } catch {
    return true
  }
}

/** THE RUNTIME A WORKER DISPATCHED RIGHT NOW WOULD ACTUALLY RUN ON. Composed the
 *  way swarmWorker.ts composes it — reader first, decision second. Calling
 *  `chooseWorkerRuntime` with a raw settings object instead is what made the old
 *  version of this file green through a live defect. */
const dispatchedWorkerRuntime = async (): Promise<'pty' | 'sdk'> =>
  chooseWorkerRuntime({
    settings: { swarmWorkerRuntime: await getWorkerRuntimeDial() },
    workers: [],
    worktree: '/tmp/wt',
    poolSessions: () => [],
    preflight: () => ({ ok: true, claudeBin: '/bin/claude', cliVersion: '9.9.9', problems: [] }),
  }).runtime

/** The runtime the commander desk would seat on — swarmManager.ts's reader. */
const seatedManagerRuntime = async (): Promise<'pty' | 'sdk'> =>
  (await getManagerRuntimeDial()).mode

/** What the PANEL draws, fetched through the panel's own request. */
const panelDraws = async (): Promise<
  { worker?: unknown; manager?: unknown; workerCap?: unknown } | undefined
> => {
  const res = await app.request('/api/settings')
  const body = (await res.json()) as { runtimeDialsEffective?: Record<string, unknown> }
  return body.runtimeDialsEffective
}

/** Every settings.json state a real machine reaches: the fresh install, the two
 *  written values, the shapes a hand-edited or half-migrated file produces, and
 *  the three ways a file stops being readable. */
const FILE_STATES: { name: string; setup: () => Promise<void> }[] = [
  { name: 'nothing written yet (the SHIPPED state)', setup: clear },
  {
    name: 'a healthy file that simply has no dial keys',
    setup: () => write(JSON.stringify({ projects: [], defaultWorkspace: null })),
  },
  {
    name: 'both dials explicitly sdk',
    setup: () =>
      write(
        JSON.stringify({
          swarmWorkerRuntime: { mode: 'sdk' },
          swarmManagerRuntime: { mode: 'sdk' },
        }),
      ),
  },
  {
    name: 'both dials explicitly pty (the kill switch, thrown)',
    setup: () =>
      write(
        JSON.stringify({
          swarmWorkerRuntime: { mode: 'pty' },
          swarmManagerRuntime: { mode: 'pty' },
        }),
      ),
  },
  {
    name: 'the dials disagree with each other (workers on, commander off)',
    setup: () =>
      write(
        JSON.stringify({
          swarmWorkerRuntime: { mode: 'sdk', sdkMaxWorkers: 3 },
          swarmManagerRuntime: { mode: 'pty' },
        }),
      ),
  },
  // Every value a hand-edited `mode` can actually hold. Each becomes its own
  // state so a disagreement names the input that caused it.
  ...(['SDK', 'Pty', '', 'garbage', null, 0, 1, true] as const).map((mode) => ({
    name: `a hand-edited mode: ${JSON.stringify(mode)}`,
    setup: () =>
      write(
        JSON.stringify({
          swarmWorkerRuntime: { mode },
          swarmManagerRuntime: { mode },
        }),
      ),
  })),
  {
    // A CONTAINER we cannot read `mode` out of — `?.mode` is undefined here, so
    // this rides the ABSENT rule rather than the unrecognised-value one.
    name: 'a dial that is not an object at all',
    setup: () =>
      write(JSON.stringify({ swarmWorkerRuntime: 'sdk', swarmManagerRuntime: ['sdk'] })),
  },
  { name: 'a settings.json we cannot PARSE', setup: () => write('{ "swarmWorkerRuntime": {,,, oops') },
  { name: 'valid JSON that is not an object', setup: () => write('"sdk"') },
  {
    // Dotfiles setups symlink settings.json into a synced folder; while that
    // target is away, readFile reports ENOENT — the same code as "never written".
    name: 'a DANGLING SYMLINK where settings.json should be',
    setup: async () => {
      await clear()
      await symlink(join(dirname(settingsFile()), 'nowhere.json'), settingsFile())
    },
  },
]

afterEach(clear)

describe('the runtime toggles draw what the server actually does', () => {
  it('the panel and the server agree in EVERY settings.json state', async () => {
    const disagreements: string[] = []
    for (const state of FILE_STATES) {
      await clear()
      await state.setup()
      const drawn = await panelDraws()
      const worker = await dispatchedWorkerRuntime()
      const manager = await seatedManagerRuntime()
      const cap = sdkSlotLimit({ swarmWorkerRuntime: await getWorkerRuntimeDial() })
      if (drawn?.worker !== worker) {
        disagreements.push(`${state.name}: panel worker=${drawn?.worker} dispatch=${worker}`)
      }
      if (drawn?.manager !== manager) {
        disagreements.push(`${state.name}: panel commander=${drawn?.manager} desk=${manager}`)
      }
      if (drawn?.workerCap !== cap) {
        disagreements.push(`${state.name}: panel cap=${drawn?.workerCap} server=${cap}`)
      }
    }
    expect(
      disagreements,
      'The Swarm panel would draw a different runtime than the one the server ' +
        'runs. That is the kill switch lying, in the states below:\n  ' +
        disagreements.join('\n  '),
    ).toEqual([])
  })

  it('the SHIPPED state — nothing written yet — DISPATCHES an SDK worker', async () => {
    // Called out separately because it is the case that broke, twice. The first
    // time the panel and `chooseWorkerRuntime` agreed on 'sdk' while the composed
    // path — the only one that puts a worker on disk — answered 'pty', and this
    // file said the shipped state was SDK "on both sides" while pointing at
    // neither side that ships.
    await clear()
    expect(await dispatchedWorkerRuntime(), 'a fresh install must dispatch SDK workers').toBe('sdk')
    expect(await seatedManagerRuntime()).toBe('sdk')
    expect((await panelDraws())?.worker).toBe('sdk')
    expect((await panelDraws())?.manager).toBe('sdk')
  })

  it('OFF means OFF — an explicit pty reaches dispatch, not just the reader', async () => {
    await write(
      JSON.stringify({
        swarmWorkerRuntime: { mode: 'pty' },
        swarmManagerRuntime: { mode: 'pty' },
      }),
    )
    expect(await dispatchedWorkerRuntime()).toBe('pty')
    expect(await seatedManagerRuntime()).toBe('pty')
    expect((await panelDraws())?.worker).toBe('pty')
    expect((await panelDraws())?.manager).toBe('pty')
  })

  it('a settings.json we cannot READ draws the kill switch, not the experiment', async (ctx) => {
    // THE MIRROR OF THE DEFECT THE FILE-LEVEL FIX CREATED. Seeded with the SDK
    // explicitly ON so passing cannot be explained by the stored value: the file
    // is unreadable, the server falls to PTY on both dials — and the panel used
    // to draw SDK, because a tolerant GET reports no key and the panel read a
    // missing key as "fresh install". The firing condition was "something is
    // broken", i.e. exactly when the owner reads the switch.
    await write(
      JSON.stringify({
        swarmWorkerRuntime: { mode: 'sdk' },
        swarmManagerRuntime: { mode: 'sdk' },
      }),
    )
    // `ctx.skip()`, not `return` — an early return reports as a PASS, so on root
    // or Windows this case would go on claiming a guarantee it never exercised.
    if (!(await denyRead())) ctx.skip()
    expect(await dispatchedWorkerRuntime()).toBe('pty')
    expect(await seatedManagerRuntime()).toBe('pty')
    const drawn = await panelDraws()
    expect(drawn?.worker).toBe('pty')
    expect(drawn?.manager).toBe('pty')
    // …and WHY the panel cannot work this out for itself: in the very same
    // response the raw keys are simply absent, indistinguishable from a fresh
    // install. Deriving from them is what produced the defect above.
    const raw = (await (await app.request('/api/settings')).json()) as Record<string, unknown>
    expect(raw.swarmWorkerRuntime, 'the raw body cannot answer this').toBeUndefined()
    expect(raw.swarmManagerRuntime, 'the raw body cannot answer this').toBeUndefined()
  })

  it('the effective dials are READ-ONLY — they are not a settings key anyone can write', async () => {
    // The field is server-computed, like suggestedDisplayName. If it ever reached
    // USER_SETTINGS_KEYS a forged POST could persist a "runtime" the readers do
    // not consult, and the panel would draw that instead of the truth.
    await clear()
    await app.request('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runtimeDialsEffective: { worker: 'pty', manager: 'pty', workerCap: 9 } }),
    })
    const stored = JSON.parse(await readFile(settingsFile(), 'utf8').catch(() => '{}')) as Record<
      string,
      unknown
    >
    expect(stored.runtimeDialsEffective).toBeUndefined()
    expect((await panelDraws())?.worker).toBe('sdk')
  })

  it('the panel RENDERS the served value and derives nothing', () => {
    // The structural half of the guarantee. Everything above compares the server
    // against the server; this is what stops the panel from quietly going back to
    // computing its own answer from the raw settings — the shape that produced
    // both display-vs-truth defects on 2026-08-02.
    const src = readFileSync(
      join(__dirname, '..', '..', 'components', 'canvas', 'modules', 'SwarmModule.tsx'),
      'utf8',
    ).replace(/\/\/.*$/gm, '')
    expect(src, 'SwarmModule must draw the server-computed dials').toMatch(
      /runtimeDialsEffective/,
    )
    expect(src, '`dialOf` was the copy that drifted — it must not come back').not.toMatch(
      /const dialOf\s*=/,
    )
    expect(src, "a bare `=== 'sdk'` test is the shape that lied").not.toMatch(
      /(?:swarmWorkerRuntime|swarmManagerRuntime)\?\.mode/,
    )
  })
})

// THE KILL SWITCH MUST DRAW WHAT THE SERVER IS DOING — SO THIS FILE COMPARES
// THE TWO THINGS THAT ACTUALLY DECIDE IT, NOT TWO PIECES THAT RESEMBLE THEM.
//
// The Swarm-tab commander toggle IS the safety story of the SDK desk: "if
// anything goes wrong, turn it off — no release needed." A toggle that reads OFF
// while the server is running SDK is not a switch the owner can trust, and they
// would be reading it at exactly the moment something had gone wrong.
//
// ⚠ WHAT THIS FILE USED TO DO, AND WHY THAT WAS WORSE THAN NOTHING. Until
// 2026-08-02 it compared the runtime decision (called DIRECTLY) against a
// hand-copied `dialOf` lifted out of SwarmModule. Neither side was what ships —
// production reaches the decision through the store reader, and the panel's
// copy could only ever agree with the piece it was copied from. Result: this
// file declared "the toggles draw what the server does" while the shipped
// state dispatched PTY workers under a switch drawn ON. A guard that is green
// while the defect it names is live is not a guard; it is a false receipt.
//
// (2026-08-13: the WORKER half of this parity — dispatchedWorkerRuntime vs
// panel `worker`/`workerCap` — died with the worker dial. Workers are SDK-only
// now; there is no worker toggle to lie. The file survives RE-SCOPED to the
// one switch left, because the defect class it pins — a panel deriving its own
// answer from raw keys, or a route answering from raw settings instead of the
// reader — shipped twice and does not care which dial it happens to.)
//
// WHAT IT DOES NOW. Two real things, over real settings.json states:
//
//   seated commander     = store.getManagerRuntimeDial()   (swarmManager.ts)
//   what the panel draws = GET /api/settings → runtimeDialsEffective
//                          (the panel RENDERS this; it derives nothing)
//
// The panel's value is served BY that same reader, which is the point: the
// agreement is structural, not a coincidence two copies have to keep. What is
// still worth pinning is that nothing re-opens the gap — a route that answers
// from the raw settings instead of the reader, or a panel that goes back to
// deriving. Each of those reds a case below.

import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { app } from '../../../server/app'
import { settingsFile } from './paths'
import { getManagerRuntimeDial } from './store'

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

/** The runtime the commander desk would seat on — swarmManager.ts's reader. */
const seatedManagerRuntime = async (): Promise<'pty' | 'sdk'> =>
  (await getManagerRuntimeDial()).mode

/** What the PANEL draws, fetched through the panel's own request. */
const panelDraws = async (): Promise<{ manager?: unknown } | undefined> => {
  const res = await app.request('/api/settings')
  const body = (await res.json()) as { runtimeDialsEffective?: Record<string, unknown> }
  return body.runtimeDialsEffective
}

/** Every settings.json state a real machine reaches: the fresh install, the two
 *  written values, the shapes a hand-edited or half-migrated file produces, the
 *  three ways a file stops being readable — and a file still carrying the
 *  DELETED worker-dial key, which every pre-0.11.72 install that ever touched
 *  that toggle has on disk. */
const FILE_STATES: { name: string; setup: () => Promise<void> }[] = [
  { name: 'nothing written yet (the SHIPPED state)', setup: clear },
  {
    name: 'a healthy file that simply has no dial key',
    setup: () => write(JSON.stringify({ projects: [], defaultWorkspace: null })),
  },
  {
    name: 'the dial explicitly sdk',
    setup: () => write(JSON.stringify({ swarmManagerRuntime: { mode: 'sdk' } })),
  },
  {
    name: 'the dial explicitly pty (the kill switch, thrown)',
    setup: () => write(JSON.stringify({ swarmManagerRuntime: { mode: 'pty' } })),
  },
  {
    // The 2026-08-13 legacy state, DELIBERATE: the worker dial was deleted but
    // old installs still carry its key. It must be inert — ignored, never an
    // error, and never able to move the surviving switch.
    name: 'a LEGACY worker-dial key beside a live commander dial',
    setup: () =>
      write(
        JSON.stringify({
          swarmWorkerRuntime: { mode: 'pty', sdkMaxWorkers: 3 },
          swarmManagerRuntime: { mode: 'pty' },
        }),
      ),
  },
  // Every value a hand-edited `mode` can actually hold. Each becomes its own
  // state so a disagreement names the input that caused it.
  ...(['SDK', 'Pty', '', 'garbage', null, 0, 1, true] as const).map((mode) => ({
    name: `a hand-edited mode: ${JSON.stringify(mode)}`,
    setup: () => write(JSON.stringify({ swarmManagerRuntime: { mode } })),
  })),
  {
    // A CONTAINER we cannot read `mode` out of — `?.mode` is undefined here, so
    // this rides the ABSENT rule rather than the unrecognised-value one.
    name: 'a dial that is not an object at all',
    setup: () => write(JSON.stringify({ swarmManagerRuntime: ['sdk'] })),
  },
  { name: 'a settings.json we cannot PARSE', setup: () => write('{ "swarmManagerRuntime": {,,, oops') },
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

describe('the runtime toggle draws what the server actually does', () => {
  it('the panel and the server agree in EVERY settings.json state', async () => {
    const disagreements: string[] = []
    for (const state of FILE_STATES) {
      await clear()
      await state.setup()
      const drawn = await panelDraws()
      const manager = await seatedManagerRuntime()
      if (drawn?.manager !== manager) {
        disagreements.push(`${state.name}: panel commander=${drawn?.manager} desk=${manager}`)
      }
    }
    expect(
      disagreements,
      'The Swarm panel would draw a different runtime than the one the server ' +
        'runs. That is the kill switch lying, in the states below:\n  ' +
        disagreements.join('\n  '),
    ).toEqual([])
  })

  it('the SHIPPED state — nothing written yet — seats an SDK commander', async () => {
    // Called out separately because the shipped state is the case that broke,
    // twice, in the worker era: the panel and the rule agreed on 'sdk' while
    // the composed path answered 'pty', and the parity file pointed at neither
    // side that ships.
    await clear()
    expect(await seatedManagerRuntime()).toBe('sdk')
    expect((await panelDraws())?.manager).toBe('sdk')
  })

  it('OFF means OFF — an explicit pty reaches the desk launch, not just the reader', async () => {
    await write(JSON.stringify({ swarmManagerRuntime: { mode: 'pty' } }))
    expect(await seatedManagerRuntime()).toBe('pty')
    expect((await panelDraws())?.manager).toBe('pty')
  })

  it('a settings.json we cannot READ draws the kill switch, not the experiment', async (ctx) => {
    // THE MIRROR OF THE DEFECT THE FILE-LEVEL FIX CREATED. Seeded with the SDK
    // explicitly ON so passing cannot be explained by the stored value: the file
    // is unreadable, the server falls to PTY — and the panel used to draw SDK,
    // because a tolerant GET reports no key and the panel read a missing key as
    // "fresh install". The firing condition was "something is broken", i.e.
    // exactly when the owner reads the switch.
    await write(JSON.stringify({ swarmManagerRuntime: { mode: 'sdk' } }))
    // `ctx.skip()`, not `return` — an early return reports as a PASS, so on root
    // or Windows this case would go on claiming a guarantee it never exercised.
    if (!(await denyRead())) ctx.skip()
    expect(await seatedManagerRuntime()).toBe('pty')
    expect((await panelDraws())?.manager).toBe('pty')
    // …and WHY the panel cannot work this out for itself: in the very same
    // response the raw key is simply absent, indistinguishable from a fresh
    // install. Deriving from it is what produced the defect above.
    const raw = (await (await app.request('/api/settings')).json()) as Record<string, unknown>
    expect(raw.swarmManagerRuntime, 'the raw body cannot answer this').toBeUndefined()
  })

  it('the effective dial is READ-ONLY — it is not a settings key anyone can write', async () => {
    // The field is server-computed, like suggestedDisplayName. If it ever reached
    // USER_SETTINGS_KEYS a forged POST could persist a "runtime" the reader does
    // not consult, and the panel would draw that instead of the truth.
    await clear()
    await app.request('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runtimeDialsEffective: { manager: 'pty' } }),
    })
    const stored = JSON.parse(await readFile(settingsFile(), 'utf8').catch(() => '{}')) as Record<
      string,
      unknown
    >
    expect(stored.runtimeDialsEffective).toBeUndefined()
    expect((await panelDraws())?.manager).toBe('sdk')
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
    expect(src, 'SwarmModule must draw the server-computed dial').toMatch(
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

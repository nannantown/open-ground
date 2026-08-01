// @vitest-environment node
//
// swarmSessions × the TWO desk runtimes.
//
// THE DEFECT THIS FILE EXISTS FOR. `resolveSwarmSession`'s liveness default read
// the PTY pool alone (`isClaudeSessionLive`). With the Agent SDK runtime dialled
// on, a 司令官 / 補給官 desk can be an SDK session instead — and an SDK session IS
// a claude, appending to the very same
// ~/.claude/projects/<hyphenated-cwd>/<sessionId>.jsonl the resume seam is about
// to hand to a second process. A PTY-only reader answers "nobody is holding this
// conversation" about a conversation that is being written into right now, the
// seam returns `resume:true`, and two claudes share one transcript. Nothing
// throws and nothing logs: the pure shape of the "asked one pool" defect.
//
// ⚠ AND THE SUITE ITSELF REPRODUCED THAT DEFECT'S SHAPE (found 2026-08-01, one
// review round after it was written). The predicate's whole reason to exist is
// that it asks BOTH pools — and every case below seated only an SDK desk. Deleting
// the PTY arm (`if (isClaudeSessionLive(agentSessionId)) return true`) from
// production left this file GREEN, i.e. it guarded exactly one of the two arms it
// was named for. The `× the PTY arm` describe block is the missing half: it seats
// desks in the REAL PTY pool and, with the SDK arm untouched, fails the moment the
// PTY question stops being asked. A both-pools predicate needs a case per pool —
// covering one and calling it "both" is the same "asked one pool" mistake, moved
// into the test.
//
// WHAT THESE TESTS REFUSE TO DO.
//   • They do NOT inject `deps.isLive`. The bug IS the default, so every case
//     here calls `resolveSwarmSession(proj, role)` exactly as swarmManager.ts /
//     swarmSupply.ts do. An injected probe would test the test.
//   • They do NOT assert that some function is callable. Each case seats a REAL
//     entry in a REAL pool — SDK via `spawnSdkSession` with an injected queryFn
//     (the production constructor, no `claude` spawned), PTY via the same
//     `globalThis.__openground_terminal` seam terminal.test.ts uses (no node-pty,
//     no shell) — and then asserts on the seam's OUTPUT: which session id came
//     back, and whether `resume` was set.
//   • They pin BOTH directions, per pool. A predicate hardcoded to `true` would
//     pass the refusal cases and fail the reaped / exited / other-conversation
//     ones; a `status`-based one would pass those and fail the terminating case.
//
// Fully HOME-isolated (OPENGROUND_HOME for the app store, HOME for claude's own
// transcript tree), like swarmSessions.test.ts — the real ~/.openground and
// ~/.claude are never read or written.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, realpath, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { addProjectEntry, __resetMigrationCacheForTests } from './registry'
import { claudeDirName } from './claudeProjectDir'
import {
  spawnSdkSession,
  terminateSdkSession,
  getSdkSession,
  isSdkSessionLive,
  __resetSdkSessionsForTests,
  type SdkQueryHandle,
} from './sdkSession'
// VALUE import, deliberately — `import type` alone is erased, and then the PTY
// pool only exists because swarmSessions happens to import ./terminal. That bit:
// commenting the PTY arm out to measure this suite's teeth ALSO dropped the
// import, so `globalThis.__openground_terminal` was undefined and all 12 cases
// died in setup instead of failing on their assertions. A fixture must not be
// hostage to the production line it is measuring.
import { isClaudeSessionLive, type TerminalInfo } from './terminal'
import {
  recordSwarmSession,
  resolveSwarmSession,
  isAgentSessionLiveAnywhere,
} from './swarmSessions'

// ── the PTY pool, seated hermetically ────────────────────────────────────────
// `createTerminal` would spawn a real `zsh -l`; the pool itself lives on
// `globalThis.__openground_terminal` (so it survives tsx-watch reloads), and
// terminal.test.ts already establishes that seam as the way to seat fixtures.
// Same seam here — the PTY arm reads `sessions`, so a record placed in it IS a
// live desk as far as `claudeSessionActivity` is concerned.
interface FakePtySession {
  info: TerminalInfo
  pty: unknown
  buffer: string
  listeners: Set<unknown>
  exitListeners: Set<unknown>
}
const ptyPool = () =>
  (globalThis as { __openground_terminal?: { sessions: Map<string, FakePtySession> } })
    .__openground_terminal!

// The conversation id the store persists and the desks resume. Fixed so a
// failure names the thing that went wrong instead of a random uuid.
const CONV = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const OTHER_CONV = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'

describe('swarmSessions resume seam × PTY/SDK runtimes', () => {
  let home: string
  let claudeHome: string
  let scratch: string
  let proj: string
  let savedOgHome: string | undefined
  let savedHome: string | undefined
  /** Releases every parked fake SDK iterator so the pumps unwind after a test. */
  let releaseIterators: Array<() => void>

  // claude files a session at ~/.claude/projects/<hyphenated-cwd>/<id>.jsonl, and
  // `isSessionResumable` reads exactly that path. Writing it is what makes the
  // "would it resume?" question REACH the liveness gate at all: without a loadable
  // transcript every case would fall out at `missing` and prove nothing.
  const writeTranscript = async (cwd: string, sessionId: string) => {
    const dir = join(claudeHome, '.claude', 'projects', claudeDirName(cwd))
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, `${sessionId}.jsonl`),
      JSON.stringify({ type: 'system', subtype: 'init', sessionId }) + '\n',
    )
  }

  /** A query handle whose iterator PARKS forever — the in-test stand-in for a
   *  claude that is up and holding its transcript open. Parking (rather than
   *  yielding a canned script and returning) is the point: an iterator that
   *  returns lands in `pump`'s finally, which stamps `reaped`, and a reaped
   *  session is legitimately not live. We need the live state. */
  const parkedHandle = (): SdkQueryHandle => {
    let release!: () => void
    const parked = new Promise<void>((r) => (release = r))
    releaseIterators.push(release)
    return {
      // Hand-rolled rather than an `async *` generator: this iterator yields
      // nothing, it only PARKS, and `next()` is where the parking has to happen
      // for `pump`'s `for await` to sit on it.
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          await parked
          return { value: undefined, done: true as const }
        },
      }),
      // Deliberately NO `interrupt`: `terminateSdkSession` must not be able to
      // end the iterator, so the "asked to stop, still unwinding" window this
      // suite depends on stays open for the length of the test.
    }
  }

  /** Seat a live SDK desk in the pool holding `agentSessionId`. Returns its id. */
  const seatSdkDesk = (cwd: string, agentSessionId: string, role: 'manager' | 'supply') =>
    spawnSdkSession({
      cwd,
      role,
      agentSessionId,
      options: {},
      queryFn: parkedHandle,
    }).id

  /** Seat a claude PTY desk in the REAL terminal pool holding `agentSessionId`.
   *
   *  `finishedAt` is the one knob that matters to the arm under test: the pool
   *  keeps an exited session ~30s so the client can drain its buffer, and
   *  `claudeSessionActivity` excludes exactly those — that PTY is gone, so its
   *  conversation is free again. Seating one is how the PTY arm's OPEN direction
   *  gets pinned without waiting on a real process to die. */
  const seatPtyDesk = (
    id: string,
    cwd: string,
    agentSessionId: string | undefined,
    opts: { finishedAt?: string } = {},
  ) => {
    ptyPool().sessions.set(id, {
      info: {
        id,
        cwd,
        shell: '/bin/zsh',
        cols: 100,
        rows: 30,
        startedAt: new Date().toISOString(),
        tag: 'claude',
        ...(agentSessionId !== undefined ? { agentSessionId } : {}),
        ...(opts.finishedAt ? { finishedAt: opts.finishedAt, exitCode: 0 } : {}),
      },
      pty: {},
      buffer: '',
      listeners: new Set(),
      exitListeners: new Set(),
    })
    return id
  }

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'og-sessrt-home-')))
    claudeHome = await realpath(await mkdtemp(join(tmpdir(), 'og-sessrt-claude-')))
    scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-sessrt-scratch-')))
    savedOgHome = process.env.OPENGROUND_HOME
    savedHome = process.env.HOME
    process.env.OPENGROUND_HOME = home
    process.env.HOME = claudeHome // os.homedir() honours $HOME on POSIX
    __resetMigrationCacheForTests()
    __resetSdkSessionsForTests()
    // The PTY pool is process-global and NOT reset by the SDK helper — start
    // every case from an empty one, or a leftover desk would answer "live" for a
    // conversation the case never seated.
    ptyPool().sessions.clear()
    releaseIterators = []
    proj = join(scratch, 'proj')
    await mkdir(proj, { recursive: true })
    await addProjectEntry(proj)
  })

  afterEach(async () => {
    for (const release of releaseIterators) release()
    __resetSdkSessionsForTests()
    ptyPool().sessions.clear()
    // Restore, never delete: an unset OPENGROUND_HOME / HOME sends later
    // resolution at the REAL home dir (the 2026-07-18 data loss).
    if (savedOgHome !== undefined) process.env.OPENGROUND_HOME = savedOgHome
    if (savedHome !== undefined) process.env.HOME = savedHome
    __resetMigrationCacheForTests()
    await rm(home, { recursive: true, force: true })
    await rm(claudeHome, { recursive: true, force: true })
    await rm(scratch, { recursive: true, force: true })
  })

  // ── the defect, on the seam's own default ─────────────────────────────────

  it('REFUSES to resume a conversation a live SDK desk is holding (the PTY-only default resumed it)', async () => {
    await recordSwarmSession(proj, 'manager', CONV)
    await writeTranscript(proj, CONV) // loadable ⇒ only liveness can stop the resume
    seatSdkDesk(proj, CONV, 'manager')

    // No deps.isLive — this is the production default, which is where the bug was.
    const r = await resolveSwarmSession(proj, 'manager')

    expect(r.resume).toBe(false)
    expect(r.reason).toBe('live')
    // The id must be a NEW one: handing CONV back is precisely the two-claudes-on-
    // one-transcript outcome, and `resume:false` alone would not prevent it (the
    // manager path records whatever id comes back and launches on it).
    expect(r.agentSessionId).not.toBe(CONV)
  })

  it('same for the 補給官, which has NO upstream singleton guard at all', async () => {
    // swarmManager.adoptLiveDesk asks both pools before a commander spawn reaches
    // the seam; spawnSwarmSupply has no such check, so for this role the seam is
    // the ONLY thing between a second launch and a shared transcript.
    await recordSwarmSession(proj, 'supply', CONV)
    await writeTranscript(proj, CONV)
    seatSdkDesk(proj, CONV, 'supply')

    const r = await resolveSwarmSession(proj, 'supply')
    expect(r.resume).toBe(false)
    expect(r.reason).toBe('live')
    expect(r.agentSessionId).not.toBe(CONV)
  })

  it('a desk ASKED TO STOP still counts as holding it — status flips synchronously, the claude has not gone', async () => {
    // `terminateSdkSession` sets status 'exited' the moment it is called; `reaped`
    // lands only when the pump's iterator actually returns. A liveness check
    // written on `status` (or on `isSdkSessionAlive`) reads "gone" here and hands
    // the still-open transcript to a fresh `--resume`. That is the same trap
    // `listSdkSessionsIn` and `terminateSdkSessionsInDir` each document.
    await recordSwarmSession(proj, 'manager', CONV)
    await writeTranscript(proj, CONV)
    const id = seatSdkDesk(proj, CONV, 'manager')

    terminateSdkSession(id)
    // Pin the precondition, so a future sdkSession change that makes terminate
    // synchronous-and-reaping turns this into an honest failure rather than a
    // test that quietly stops covering anything.
    const s = getSdkSession(id)!
    expect(s.status).toBe('exited')
    expect(isSdkSessionLive(s)).toBe(true)

    const r = await resolveSwarmSession(proj, 'manager')
    expect(r.resume).toBe(false)
    expect(r.reason).toBe('live')
  })

  // ── the other direction: the gate must still OPEN ─────────────────────────
  // Without these, a predicate hardcoded to `true` would pass everything above
  // and silently destroy the whole feature — the desks would never resume again.

  it('RESUMES once the SDK desk has actually been reaped', async () => {
    await recordSwarmSession(proj, 'manager', CONV)
    await writeTranscript(proj, CONV)
    const id = seatSdkDesk(proj, CONV, 'manager')

    terminateSdkSession(id)
    // Let the parked iterator return, then let the pump's finally run — that is
    // the only in-process evidence the claude behind the session is really done.
    for (const release of releaseIterators) release()
    releaseIterators = []
    await new Promise((r) => setTimeout(r, 0))
    expect(getSdkSession(id)!.reaped).toBe(true)

    const r = await resolveSwarmSession(proj, 'manager')
    expect(r.resume).toBe(true)
    expect(r.agentSessionId).toBe(CONV)
  })

  it('RESUMES while an unrelated SDK desk runs — liveness is per CONVERSATION, not per pool', async () => {
    await recordSwarmSession(proj, 'manager', CONV)
    await writeTranscript(proj, CONV)
    seatSdkDesk(proj, OTHER_CONV, 'manager') // live, but a different conversation

    const r = await resolveSwarmSession(proj, 'manager')
    expect(r.resume).toBe(true)
    expect(r.agentSessionId).toBe(CONV)
  })

  // ── the OTHER arm ─────────────────────────────────────────────────────────
  // Everything above seats an SDK desk, so ALL of it stays green with the PTY
  // arm deleted from the predicate — which is how a "both pools" guard ended up
  // guarding one pool. These cases seat the PTY pool and leave the SDK pool
  // empty, so they are the arm's own teeth: drop
  // `if (isClaudeSessionLive(agentSessionId)) return true` and every one fails.

  describe('× the PTY arm', () => {
    it('REFUSES to resume a conversation a live claude PTY is holding', async () => {
      await recordSwarmSession(proj, 'manager', CONV)
      await writeTranscript(proj, CONV) // loadable ⇒ only liveness can stop the resume
      seatPtyDesk('t-live', proj, CONV)
      // Pin the precondition against the PTY module's OWN predicate: if the
      // fixture shape ever drifts from what `claudeSessionActivity` matches on,
      // this suite must say "the fixture stopped being a live desk" instead of
      // quietly reporting that the seam refuses to refuse.
      expect(isClaudeSessionLive(CONV)).toBe(true)

      const r = await resolveSwarmSession(proj, 'manager')

      expect(r.resume).toBe(false)
      expect(r.reason).toBe('live')
      expect(r.agentSessionId).not.toBe(CONV)
    })

    it('same for the 補給官 — the role with no upstream singleton guard', async () => {
      await recordSwarmSession(proj, 'supply', CONV)
      await writeTranscript(proj, CONV)
      seatPtyDesk('t-live-supply', proj, CONV)

      const r = await resolveSwarmSession(proj, 'supply')
      expect(r.resume).toBe(false)
      expect(r.reason).toBe('live')
      expect(r.agentSessionId).not.toBe(CONV)
    })

    it('RESUMES once that PTY has exited — a lingering entry is not a holder', async () => {
      // The pool keeps an exited session ~30s for buffer drain. Counting it as
      // live would strand the desk on a fresh session for half a minute after
      // every restart; `claudeSessionActivity` excludes it, and this pins that.
      await recordSwarmSession(proj, 'manager', CONV)
      await writeTranscript(proj, CONV)
      seatPtyDesk('t-gone', proj, CONV, { finishedAt: new Date().toISOString() })

      const r = await resolveSwarmSession(proj, 'manager')
      expect(r.resume).toBe(true)
      expect(r.agentSessionId).toBe(CONV)
    })

    it('RESUMES while an unrelated claude PTY runs — per CONVERSATION, not per pool', async () => {
      await recordSwarmSession(proj, 'manager', CONV)
      await writeTranscript(proj, CONV)
      seatPtyDesk('t-other', proj, OTHER_CONV)

      const r = await resolveSwarmSession(proj, 'manager')
      expect(r.resume).toBe(true)
      expect(r.agentSessionId).toBe(CONV)
    })

    it('answers for BOTH pools at once — an SDK holder and a PTY holder, same seam', async () => {
      // The two arms are not alternatives selected by a dial: the dial can flip
      // between two launches, so one conversation may be held by a PTY desk today
      // and an SDK desk tomorrow. One call has to cover both, and this is the
      // case that fails if either arm is removed.
      seatPtyDesk('t-pty', proj, CONV)
      seatSdkDesk(proj, OTHER_CONV, 'manager')
      expect(isAgentSessionLiveAnywhere(CONV)).toBe(true)
      expect(isAgentSessionLiveAnywhere(OTHER_CONV)).toBe(true)
    })
  })

  // ── the predicate itself ──────────────────────────────────────────────────

  it('isAgentSessionLiveAnywhere: live SDK ⇒ true, reaped ⇒ false', async () => {
    expect(isAgentSessionLiveAnywhere(CONV)).toBe(false)

    const id = seatSdkDesk(proj, CONV, 'manager')
    expect(isAgentSessionLiveAnywhere(CONV)).toBe(true)

    terminateSdkSession(id)
    for (const release of releaseIterators) release()
    releaseIterators = []
    await new Promise((r) => setTimeout(r, 0))
    expect(isAgentSessionLiveAnywhere(CONV)).toBe(false)
  })

  it('an empty id matches nobody, in either pool, with unlabelled desks live', () => {
    // ⚠ READ THE CLAIM CAREFULLY. This pins the OUTCOME, not the guard clause:
    // deleting `if (!agentSessionId) return false` from the predicate leaves this
    // test GREEN, because both arms refuse an empty id on their own
    // (`claudeSessionActivity` returns early on a falsy id; the SDK pool never
    // STORES an empty `agentSessionId`, so `s.agentSessionId === ''` is
    // unreachable). An earlier version of this file asserted the same three
    // expectations while claiming to verify the guard — it could not fail.
    //
    // What it DOES catch is the pair that would actually break the rule: someone
    // deleting the guard AND making an arm tolerant (`(s.agentSessionId ?? '') ===
    // agentSessionId`, or dropping the early return in claudeSessionActivity), at
    // which point an unlabelled live desk starts answering "yes" for '' and the
    // seam refuses to resume anything, forever. So both desks below are seated
    // WITHOUT a conversation id — that is the state the tolerant version misreads.
    expect(isAgentSessionLiveAnywhere('')).toBe(false)

    seatPtyDesk('t-unlabelled', proj, undefined)
    spawnSdkSession({ cwd: proj, role: 'manager', options: {}, queryFn: parkedHandle })

    expect(isAgentSessionLiveAnywhere('')).toBe(false)
  })
})

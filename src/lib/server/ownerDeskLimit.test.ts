import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  runOwnerDeskLimitPass,
  resetOwnerDeskLimitState,
  buildOwnerDeskLimitDetail,
  buildOwnerDeskLimitMergedDetail,
  buildOwnerDeskLimitNotification,
  type StoppedDesk,
  startOwnerDeskLimitLoop,
  stopOwnerDeskLimitLoop,
  OWNER_DESK_QUIET_MS,
  OWNER_DESK_CONFIRM_MS,
  OWNER_DESK_REARM_READS,
  OWNER_DESK_LIMIT_INTERVAL_MS,
  OWNER_DESK_MERGE_QUIET_MS,
  OWNER_DESK_MERGE_CAP_MS,
  type OwnerDeskLimitDeps,
} from './ownerDeskLimit'
import {
  MODEL_SWITCH_REMEDY,
  QUOTA_EXHAUSTION_PATTERNS,
  type QuotaRefusalKind,
} from './swarmRateLimitText'
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import {
  getTerminalScreenLogical,
  listOwnerDeskTerminals,
  type OwnerDeskTerminal,
  type TerminalInfo,
} from './terminal'
import type { SwarmInfoNotification } from '../types'

// The owner-desk model-limit watch, driven entirely by SYNTHETIC PTY screens +
// an injected clock — no node-pty, no real claude, no disk. What is pinned here
// is the 2026-07-18 gap: the owner's own conversation stopped on a spent model
// quota and NOTHING told them. Three properties matter and each gets its own
// test: it fires (once) on a real stop, it stays quiet on text that merely LOOKS
// like one, and it never touches the conversation.

// ── Fixtures ────────────────────────────────────────────────────────────────

// claude's TUI chrome: the input box + footers it repaints under its last
// message. This is the ONLY thing that follows a real limit notice on screen —
// which is exactly what the positional half of the detector keys on.
//
// The SHAPE is load-bearing, and an earlier version of this fixture got it wrong:
// it drew a `╭──╮ │ > … │ ╰──╯` bordered box, which the CLI does not render. The
// real input box is a `❯` prompt row FENCED BY RULES (`╭──╮` is the welcome
// banner alone — see the live frames in swarmQuestions.test.ts). Fixtures that
// draw furniture the CLI never paints let a broken chrome model pass: that is
// precisely how the branch shipped a sensor that went silent on real stops.
const CHROME = [
  '',
  '─'.repeat(110),
  '❯ ',
  '─'.repeat(110),
  '  ? for shortcuts · ← for agents',
  '  ⏵⏵ accept edits on · Context left until auto-compact: 12%',
].join('\n')

// VERBATIM off the owner's own desk on 2026-07-18 — the wording that stopped the
// conversation. Pinned as a literal so a CLI reword breaks this test loudly.
const LIMIT_NOTICE =
  "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model."

/** A desk that walked into the wall: work, then the notice, then only chrome. */
const stoppedScreen = (): string =>
  ['⏺ Reading src/lib/server/terminal.ts…', '⏺ Updated 2 files', '', LIMIT_NOTICE, CHROME].join('\n')

// The OTHER refusal the CLI prints, and the one round 3 found the message getting
// wrong: the whole ACCOUNT's quota is spent, not one model's. Note what is absent
// — there is no "switch models with /model" line, because switching models does
// not help. That absence is the signal the advice branches on.
const ACCOUNT_WIDE_NOTICE = 'Claude usage limit reached. Your limit will reset at 3pm.'

/** A desk stopped by an ACCOUNT-WIDE exhaustion. */
const accountWideScreen = (): string =>
  ['⏺ Working…', '', ACCOUNT_WIDE_NOTICE, CHROME].join('\n')

/** A desk that merely WROTE the wording down — reviewing this very file, or
 *  drafting a plan that quotes the notice — and then went on working. The quote
 *  is there, but claude's own prose trails it, so the notice is plainly not its
 *  last utterance. This is the false positive the watch must not raise.
 *
 *  Deliberately SHORT. The first version of this fixture padded 800+ characters
 *  of prose after the quote, which is not a shape a 32-row terminal can hold —
 *  and that padding was the only reason it went quiet, so it hid a defect where
 *  ordinary conversations notified the owner. One trailing sentence is the honest
 *  test. Real rendered screens at three terminal widths live in
 *  ownerDeskScreens.test.ts; this file drives the PASS logic. */
const quotedScreen = (): string =>
  [
    '⏺ The wording this branch pins is:',
    `    ${LIMIT_NOTICE}`,
    '  That string is matched by three independent patterns.',
    CHROME,
  ].join('\n')

/** An ordinary working screen — nothing limit-shaped anywhere. */
const normalScreen = (): string =>
  ['⏺ Running tests…', '  ✓ 4142 passed', '⏺ All green.', CHROME].join('\n')

/** A TRANSIENT fault, not a spent quota: it resolves itself, and "switch models"
 *  would be wrong advice. The broad worker-arm pattern list matches this; the
 *  quota-exhaustion subset the desk sensor uses deliberately does not. */
const overloadedScreen = (): string =>
  ['⏺ API Error: 529 overloaded_error', '  Retrying in 30s…', CHROME].join('\n')

// ── Harness ─────────────────────────────────────────────────────────────────

const T0 = 1_700_000_000_000

interface Harness {
  deps: OwnerDeskLimitDeps
  /** Notifications actually raised, in order. */
  sent: SwarmInfoNotification[]
  /** terminalIds whose screen was READ — proves the quiet gate skipped a desk. */
  reads: string[]
  desks: Map<string, { desk: OwnerDeskTerminal; screen: () => string | null }>
}

const harness = (): Harness => {
  const h: Harness = {
    sent: [],
    reads: [],
    desks: new Map(),
    deps: {
      listDesks: () => Array.from(h.desks.values()).map((d) => d.desk),
      screen: (id) => {
        h.reads.push(id)
        return h.desks.get(id)?.screen() ?? null
      },
      notify: async (n) => {
        h.sent.push(n)
      },
      // Named project by default — the resolver itself is exercised separately.
      project: async (cwd) => ({ label: `proj:${cwd.split('/').pop()}`, path: cwd }),
    },
  }
  return h
}

const addDesk = (
  h: Harness,
  id: string,
  screen: () => string | null,
  over: Partial<OwnerDeskTerminal> = {},
): void => {
  h.desks.set(id, {
    desk: { id, cwd: `/Users/me/projects/${id}`, startedAtMs: T0, lastOutputAt: T0, ...over },
    screen,
  })
}

/** Advance a desk's "last painted" stamp — i.e. it is still producing output. */
const paint = (h: Harness, id: string, at: number): void => {
  const entry = h.desks.get(id)!
  entry.desk = { ...entry.desk, lastOutputAt: at }
}

/** When a stop CONFIRMED at `t` is actually told to the owner.
 *
 *  A confirmed stop is held back one merge-quiet interval to see whether other
 *  desks are stopping too — an account-wide exhaustion stops several, each as its
 *  own in-flight request fails, so they arrive over a span rather than at once.
 *  See OWNER_DESK_MERGE_QUIET_MS. */
const toldAt = (t: number): number => t + OWNER_DESK_MERGE_QUIET_MS

/** Run the pass that flushes a stop confirmed at `t` (nothing else joined it). */
const settle = (h: Harness, t: number) => runOwnerDeskLimitPass({ now: toldAt(t), deps: h.deps })

beforeEach(() => {
  resetOwnerDeskLimitState()
})

afterEach(() => {
  stopOwnerDeskLimitLoop()
  resetOwnerDeskLimitState()
})

// ── The gates are the worker arm's, not a second set ─────────────────────────

describe('ownerDeskLimit — reuses the engine sensor rather than rebuilding it', () => {
  it('shares the WORDING with the engine and owns its TIMING', () => {
    // SHARED: the pattern tables. There is no second copy of the CLI's wording
    // here — the remedy line the message branches on is the SAME OBJECT the
    // engine's exhaustion list holds, so a CLI reword cannot fix one and miss the
    // other. (The card's "do not double-implement" applies to the judgement.)
    expect(QUOTA_EXHAUSTION_PATTERNS).toContain(MODEL_SWITCH_REMEDY)

    // OWN: the two timing gates. Review (2026-07-18) rejected importing them —
    // the engine's are defined against WORKER questions ("how long before a
    // worker's screen is worth reading"), so retuning one for a worker-side reason
    // would silently move when the OWNER gets told.
    //
    // ⚠ Pinned as LITERALS on purpose. The shipped version of this test asserted
    // equality with the engine's constants and its comment claimed they were
    // imported — neither was true, and the assertion re-imposed the very coupling
    // review had just removed: retuning the engine would have turned this red and
    // told the next reader the desk must follow. They are equal today by
    // CALIBRATION, not by coupling (round 3).
    expect(OWNER_DESK_QUIET_MS).toBe(45_000)
    expect(OWNER_DESK_CONFIRM_MS).toBe(45_000)
  })
})

// ── Detection ────────────────────────────────────────────────────────────────

describe('ownerDeskLimit — a stopped conversation', () => {
  it('notifies once, after the output lull AND the hold window', async () => {
    const h = harness()
    addDesk(h, 'desk-a', stoppedScreen)

    // Just painted ⇒ not quiet ⇒ the screen is not even read.
    let r = await runOwnerDeskLimitPass({ now: T0 + 1_000, deps: h.deps })
    expect(h.reads).toEqual([])
    expect(r.tracked).toEqual([])
    expect(h.sent).toEqual([])

    // Quiet ⇒ sampled ⇒ the notice is SIGHTED, but not yet confirmed.
    const sighted = T0 + OWNER_DESK_QUIET_MS
    r = await runOwnerDeskLimitPass({ now: sighted, deps: h.deps })
    expect(h.reads).toEqual(['desk-a'])
    expect(r.tracked).toEqual(['desk-a'])
    expect(h.sent).toEqual([])

    // Still inside the hold window ⇒ still silent (one transient frame must
    // never wake the owner).
    r = await runOwnerDeskLimitPass({ now: sighted + OWNER_DESK_CONFIRM_MS - 1, deps: h.deps })
    expect(h.sent).toEqual([])

    // Held long enough ⇒ ELIGIBLE, but not yet told: a confirmed stop waits one
    // merge-quiet interval to see whether it is part of a larger event (an
    // account-wide exhaustion stops several desks, each as its own request fails).
    const confirmed = sighted + OWNER_DESK_CONFIRM_MS
    r = await runOwnerDeskLimitPass({ now: confirmed, deps: h.deps })
    expect(r.notified).toEqual([])
    expect(h.sent).toEqual([])

    // Nothing else joined ⇒ ONE notification.
    r = await settle(h, confirmed)
    expect(r.notified).toEqual(['desk-a'])
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].event).toBe('session-limit')
  })

  it('does not notify again for the same stop (the dedup)', async () => {
    const h = harness()
    addDesk(h, 'desk-a', stoppedScreen)
    const confirmed = T0 + OWNER_DESK_QUIET_MS + OWNER_DESK_CONFIRM_MS

    await runOwnerDeskLimitPass({ now: T0 + OWNER_DESK_QUIET_MS, deps: h.deps })
    await runOwnerDeskLimitPass({ now: confirmed, deps: h.deps })
    await settle(h, confirmed)
    expect(h.sent).toHaveLength(1)

    // Ten more passes over the SAME unchanged stop.
    for (let i = 1; i <= 10; i++) {
      await runOwnerDeskLimitPass({ now: confirmed + i * 60_000, deps: h.deps })
    }
    expect(h.sent).toHaveLength(1)
  })

  it('re-arms after the conversation recovers, and notifies on a NEW stop', async () => {
    const h = harness()
    let screen = stoppedScreen()
    addDesk(h, 'desk-a', () => screen)

    const confirmed = T0 + OWNER_DESK_QUIET_MS + OWNER_DESK_CONFIRM_MS
    await runOwnerDeskLimitPass({ now: T0 + OWNER_DESK_QUIET_MS, deps: h.deps })
    await runOwnerDeskLimitPass({ now: confirmed, deps: h.deps })
    await settle(h, confirmed)
    expect(h.sent).toHaveLength(1)

    // The owner switched models: the conversation resumed and the notice is gone.
    // Re-arming takes OWNER_DESK_REARM_READS consecutive normal reads — one frame
    // is a flicker, not a recovery (see the hysteresis test below).
    screen = normalScreen()
    let recovered = confirmed
    for (let i = 1; i <= OWNER_DESK_REARM_READS; i++) {
      recovered = confirmed + i * 60_000
      const r = await runOwnerDeskLimitPass({ now: recovered, deps: h.deps })
      expect(r.tracked).toEqual(i < OWNER_DESK_REARM_READS ? ['desk-a'] : [])
    }
    expect(h.sent).toHaveLength(1)

    // …and hours later the NEW model runs out too.
    screen = stoppedScreen()
    paint(h, 'desk-a', recovered)
    const sighted2 = recovered + OWNER_DESK_QUIET_MS
    await runOwnerDeskLimitPass({ now: sighted2, deps: h.deps })
    expect(h.sent).toHaveLength(1) // sighted, not yet held
    await runOwnerDeskLimitPass({ now: sighted2 + OWNER_DESK_CONFIRM_MS, deps: h.deps })
    await settle(h, sighted2 + OWNER_DESK_CONFIRM_MS)
    expect(h.sent).toHaveLength(2) // a NEW stop is a NEW notification
  })

  it('does not re-notify when a stopped desk FLICKERS out of the match', async () => {
    // The MF-3 regression (adversarial review, 2026-07-18). "Already told" used to
    // be bound to the LAST FRAME: any single non-matching read dropped the entry,
    // `notified` and all, so the very next matching read started a fresh sighting
    // and rang a SECOND time for the SAME stop. A stopped desk flickers for
    // mundane reasons — the owner types a character into the box and deletes it,
    // a repaint catches the frame mid-draw — so this is the ordinary case, not an
    // exotic one. The stop has to outlive a dissenting frame.
    const h = harness()
    let screen = stoppedScreen()
    addDesk(h, 'desk-a', () => screen)

    const confirmed = T0 + OWNER_DESK_QUIET_MS + OWNER_DESK_CONFIRM_MS
    await runOwnerDeskLimitPass({ now: T0 + OWNER_DESK_QUIET_MS, deps: h.deps })
    await runOwnerDeskLimitPass({ now: confirmed, deps: h.deps })
    await settle(h, confirmed)
    expect(h.sent).toHaveLength(1)

    // Flap: one normal frame, then stopped again — repeatedly. Each round is
    // strictly fewer than OWNER_DESK_REARM_READS normal frames, so the desk never
    // re-arms and the owner is never told twice about a conversation that never
    // actually resumed.
    let t = confirmed
    for (let round = 0; round < 5; round++) {
      screen = normalScreen()
      t += 60_000
      await runOwnerDeskLimitPass({ now: t, deps: h.deps })
      screen = stoppedScreen()
      t += 60_000
      await runOwnerDeskLimitPass({ now: t, deps: h.deps })
      await runOwnerDeskLimitPass({ now: t + OWNER_DESK_CONFIRM_MS, deps: h.deps })
      await settle(h, t + OWNER_DESK_CONFIRM_MS)
    }
    expect(h.sent).toHaveLength(1)
  })

  it('does not count an UNREADABLE screen toward re-arming', async () => {
    // A screen read that throws is missing evidence, not evidence of recovery.
    // Counting it would let a desk whose PTY is briefly unreadable re-arm and then
    // ring again for the stop the owner has already been told about.
    const h = harness()
    let screen: (() => string) | null = stoppedScreen
    addDesk(h, 'desk-a', () => {
      if (!screen) throw new Error('screen unavailable')
      return screen()
    })

    const confirmed = T0 + OWNER_DESK_QUIET_MS + OWNER_DESK_CONFIRM_MS
    await runOwnerDeskLimitPass({ now: T0 + OWNER_DESK_QUIET_MS, deps: h.deps })
    await runOwnerDeskLimitPass({ now: confirmed, deps: h.deps })
    await settle(h, confirmed)
    expect(h.sent).toHaveLength(1)

    screen = null // unreadable, for many passes
    let t = confirmed
    for (let i = 1; i <= OWNER_DESK_REARM_READS * 3; i++) {
      t += 60_000
      const r = await runOwnerDeskLimitPass({ now: t, deps: h.deps })
      expect(r.tracked).toEqual(['desk-a']) // still tracked ⇒ still deduped
    }
    screen = stoppedScreen
    await runOwnerDeskLimitPass({ now: t + 60_000, deps: h.deps })
    expect(h.sent).toHaveLength(1)
  })

  it('watches every desk independently', async () => {
    const h = harness()
    addDesk(h, 'desk-a', stoppedScreen)
    addDesk(h, 'desk-b', normalScreen)

    await runOwnerDeskLimitPass({ now: T0 + OWNER_DESK_QUIET_MS, deps: h.deps })
    await runOwnerDeskLimitPass({
      now: T0 + OWNER_DESK_QUIET_MS + OWNER_DESK_CONFIRM_MS,
      deps: h.deps,
    })
    const r = await settle(h, T0 + OWNER_DESK_QUIET_MS + OWNER_DESK_CONFIRM_MS)
    expect(r.notified).toEqual(['desk-a'])
    expect(h.sent).toHaveLength(1)
  })
})

// ── Non-detection (the false-positive guards) ────────────────────────────────

describe('ownerDeskLimit — text that only LOOKS like a stop', () => {
  it('never reads the screen of a desk that is still producing output', async () => {
    const h = harness()
    // A session whose screen carries the wording, but which keeps painting: it is
    // working (writing this very file's fixtures, say), not stopped.
    addDesk(h, 'desk-a', stoppedScreen)

    for (let i = 1; i <= 20; i++) {
      const now = T0 + i * 30_000
      paint(h, 'desk-a', now) // fresh output every pass ⇒ the lull never opens
      await runOwnerDeskLimitPass({ now, deps: h.deps })
    }
    expect(h.reads).toEqual([]) // the quiet gate skipped it entirely
    expect(h.sent).toEqual([])
  })

  it('ignores a session that merely QUOTED the wording and kept working', async () => {
    const h = harness()
    // Idle and sampled — so the ONLY thing standing between this screen and a
    // notification is that the quote is not claude's last utterance.
    addDesk(h, 'desk-a', quotedScreen)

    let r = await runOwnerDeskLimitPass({ now: T0 + OWNER_DESK_QUIET_MS, deps: h.deps })
    expect(h.reads).toEqual(['desk-a']) // it WAS read…
    expect(r.tracked).toEqual([]) // …and judged not stopped
    r = await runOwnerDeskLimitPass({
      now: T0 + OWNER_DESK_QUIET_MS + OWNER_DESK_CONFIRM_MS + 60_000,
      deps: h.deps,
    })
    expect(h.sent).toEqual([])
  })

  it('ignores a transient overload (it resolves itself; switching models is wrong advice)', async () => {
    const h = harness()
    addDesk(h, 'desk-a', overloadedScreen)

    await runOwnerDeskLimitPass({ now: T0 + OWNER_DESK_QUIET_MS, deps: h.deps })
    await runOwnerDeskLimitPass({
      now: T0 + OWNER_DESK_QUIET_MS + OWNER_DESK_CONFIRM_MS,
      deps: h.deps,
    })
    expect(h.sent).toEqual([])
  })

  it('stays silent on an ordinary idle conversation', async () => {
    const h = harness()
    addDesk(h, 'desk-a', normalScreen)
    await runOwnerDeskLimitPass({ now: T0 + OWNER_DESK_QUIET_MS, deps: h.deps })
    await runOwnerDeskLimitPass({
      now: T0 + OWNER_DESK_QUIET_MS + OWNER_DESK_CONFIRM_MS,
      deps: h.deps,
    })
    expect(h.sent).toEqual([])
  })

  it('treats an unreadable screen as "not stopped" (fail-open, never invents a stop)', async () => {
    const h = harness()
    addDesk(h, 'desk-a', () => {
      throw new Error('session vanished mid-read')
    })
    await runOwnerDeskLimitPass({ now: T0 + OWNER_DESK_QUIET_MS, deps: h.deps })
    const r = await runOwnerDeskLimitPass({
      now: T0 + OWNER_DESK_QUIET_MS + OWNER_DESK_CONFIRM_MS,
      deps: h.deps,
    })
    expect(r.tracked).toEqual([])
    expect(h.sent).toEqual([])
  })
})

// ── Bookkeeping hygiene ─────────────────────────────────────────────────────

describe('ownerDeskLimit — bookkeeping', () => {
  it('drops state for a conversation the owner closed', async () => {
    const h = harness()
    addDesk(h, 'desk-a', stoppedScreen)
    let r = await runOwnerDeskLimitPass({ now: T0 + OWNER_DESK_QUIET_MS, deps: h.deps })
    expect(r.tracked).toEqual(['desk-a'])

    h.desks.delete('desk-a') // pane closed / PTY exited
    r = await runOwnerDeskLimitPass({ now: T0 + OWNER_DESK_QUIET_MS + 1_000, deps: h.deps })
    expect(r.tracked).toEqual([])
  })

  it('survives a listing failure without throwing', async () => {
    const h = harness()
    const deps = {
      ...h.deps,
      listDesks: () => {
        throw new Error('pool unavailable')
      },
    }
    await expect(runOwnerDeskLimitPass({ now: T0, deps })).resolves.toBeTruthy()
  })

  it('RETRIES a failed bell write, then never double-fires once it lands', async () => {
    // A failed write is not a delivered notification. Marking `notified` before
    // the await is what stops a concurrent pass double-firing — but leaving it
    // set after a throw meant the owner was NEVER told about a desk that is still
    // sitting there stopped (commander review, 2026-07-18 round 4).
    //
    // The retry is safe because a throw means nothing was recorded: the notify
    // path awaits only the bell's disk write, and the OS toast after it is total
    // (sendOsNotification catches its own IPC failure and returns false). So the
    // fake FAILS WITHOUT RECORDING — modelling the real failure instead of the
    // earlier "push, then throw", which described a half-written row that cannot
    // occur and quietly justified giving up.
    const h = harness()
    addDesk(h, 'desk-a', stoppedScreen)
    let failing = true
    const deps = {
      ...h.deps,
      notify: async (n: SwarmInfoNotification) => {
        if (failing) throw new Error('disk full')
        h.sent.push(n)
      },
    }
    const confirmed = T0 + OWNER_DESK_QUIET_MS + OWNER_DESK_CONFIRM_MS
    await runOwnerDeskLimitPass({ now: T0 + OWNER_DESK_QUIET_MS, deps })
    await runOwnerDeskLimitPass({ now: confirmed, deps })

    const failed = await runOwnerDeskLimitPass({ now: toldAt(confirmed), deps })
    expect(failed.notified).toEqual([]) // nothing was delivered, so nothing is claimed
    expect(h.sent).toEqual([])

    // The disk comes back: the very next pass tells the owner, once.
    failing = false
    const ok = await runOwnerDeskLimitPass({ now: toldAt(confirmed) + 15_000, deps })
    expect(ok.notified).toEqual(['desk-a'])
    expect(h.sent).toHaveLength(1)

    // …and a delivered write is never repeated.
    for (let i = 1; i <= 5; i++) {
      await runOwnerDeskLimitPass({ now: toldAt(confirmed) + 15_000 + i * 60_000, deps })
    }
    expect(h.sent).toHaveLength(1)
  })

  it('still notifies when the project name cannot be resolved', async () => {
    const h = harness()
    addDesk(h, 'desk-a', stoppedScreen)
    const deps = {
      ...h.deps,
      project: async () => {
        throw new Error('registry unreadable')
      },
    }
    const confirmed = T0 + OWNER_DESK_QUIET_MS + OWNER_DESK_CONFIRM_MS
    await runOwnerDeskLimitPass({ now: T0 + OWNER_DESK_QUIET_MS, deps })
    await runOwnerDeskLimitPass({ now: confirmed, deps })
    await runOwnerDeskLimitPass({ now: toldAt(confirmed), deps })
    // Naming the project is a nicety; telling the owner their conversation
    // stopped is the point. The message degrades, it does not disappear.
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].detail).toContain('/model')
  })

  it('re-arms the loop instead of stacking a second timer', () => {
    const g = globalThis as {
      __openground_owner_desk_limit_timer?: ReturnType<typeof setInterval> | null
    }
    startOwnerDeskLimitLoop(60_000)
    const first = g.__openground_owner_desk_limit_timer
    expect(first).toBeTruthy()
    startOwnerDeskLimitLoop(60_000)
    expect(g.__openground_owner_desk_limit_timer).not.toBe(first)
    stopOwnerDeskLimitLoop()
    expect(g.__openground_owner_desk_limit_timer).toBeNull()
  })
})

// ── What the owner actually reads ───────────────────────────────────────────

const one = (
  project: { label: string; path: string } | null,
  desk: string | null,
  kind: QuotaRefusalKind,
): StoppedDesk[] => [{ project, desk, kind }]

describe('ownerDeskLimit — the message the owner reads', () => {
  const detail = buildOwnerDeskLimitDetail('OPEN GROUND', null, 'model-switchable')

  it('answers the three questions a non-programmer needs answered', () => {
    expect(detail).toContain('上限に達しました') // WHAT happened
    expect(detail).toContain('止まったまま') // WHAT it means for them
    expect(detail).toContain('/model') // WHAT to do — the one action
    expect(detail).toContain('OPEN GROUND') // WHICH conversation
  })

  it('never shows a machine name — it drops the location instead', () => {
    // A desk in a swarm worktree has a cwd whose folder is a branch stamp. The
    // resolver returns null for anything it cannot name in the owner's own words,
    // and the message then simply omits WHERE rather than printing the stamp.
    const anonymous = buildOwnerDeskLimitDetail(null, null, 'model-switchable')
    expect(anonymous).toContain('上限に達しました')
    expect(anonymous).toContain('止まったまま')
    expect(anonymous).toContain('/model')
    expect(anonymous).not.toContain('「')
    // Still one readable sentence run, not a dangling clause.
    expect(anonymous).toContain('その会話はここで止まったまま')
  })

  it('carries no worktree/branch stamp when the project IS named', () => {
    const n = buildOwnerDeskLimitNotification(
      one({ label: 'OPEN GROUND', path: '/Users/me/projects/OPEN GROUND' }, null, 'model-switchable'),
    )
    expect(n.detail).toContain('OPEN GROUND')
    expect(n.detail).not.toMatch(/swarm-|worktrees|[0-9a-f]{12}/)
    // The bell opens the PROJECT, not a worktree the owner never opened.
    expect(n.projectPath).toBe('/Users/me/projects/OPEN GROUND')
  })

  it('omits the open-target rather than pointing at a folder the bell cannot open', () => {
    // A custom-module desk's cwd is `~/.openground/custom-modules/<uuid>`, which
    // resolves to no registered project. The shipped version fell back to that cwd,
    // so the row offered to "open" a machine directory the owner never opened.
    const n = buildOwnerDeskLimitNotification(one(null, null, 'model-switchable'))
    expect(n.projectPath).toBeUndefined()
    expect(n.detail).toContain('上限に達しました') // still actionable without it
  })

  it('carries no engine vocabulary, in EITHER kind of stop', () => {
    for (const text of [
      detail,
      buildOwnerDeskLimitDetail('OPEN GROUND', null, 'account-wide'),
      buildOwnerDeskLimitMergedDetail([
        { project: { label: 'OG', path: '/p' }, desk: '司令官', kind: 'account-wide' },
        { project: { label: 'OG', path: '/p' }, desk: null, kind: 'account-wide' },
      ]),
    ]) {
      for (const jargon of [
        'tier',
        'quota',
        'rate limit',
        'rate-limit',
        'PTY',
        'terminalId',
        'ティア',
        'クォータ',
        'レートリミット',
      ]) {
        expect(text.toLowerCase()).not.toContain(jargon.toLowerCase())
      }
    }
  })

  it('points at the conversation without proposing to change it for them', () => {
    const n = buildOwnerDeskLimitNotification(
      one({ label: 'test', path: '/Users/me/projects/test' }, null, 'model-switchable'),
    )
    expect(n.event).toBe('session-limit')
    expect(n.projectPath).toBe('/Users/me/projects/test')
    // The owner switches models; the app does not. Scope is notify-only, so the
    // message says "you type /model", never "we switched you to …".
    expect(n.detail).toContain('選んでください')
    expect(n.detail).not.toMatch(/切り替えました|変更しました/)
  })
})

// ── The advice has to be true of the stop it describes (round 3, MF-1) ───────

describe('ownerDeskLimit — advice matches what actually ran out', () => {
  it('sends a PER-MODEL stop to /model', () => {
    const d = buildOwnerDeskLimitDetail('test', null, 'model-switchable')
    expect(d).toContain('/model と入力')
    expect(d).toContain('別のモデルを選んでください')
  })

  it('does NOT send an ACCOUNT-WIDE stop to a menu where every entry is spent', () => {
    // THE DEFECT round 3 caught. "Claude usage limit reached. Your limit will reset
    // at 3pm." means the whole account is out — /model opens a list on which every
    // model is exhausted too. The shipped message told the owner to type it anyway,
    // so they followed the instruction, nothing happened, and the message had left
    // them with no next move at all.
    const d = buildOwnerDeskLimitDetail('test', null, 'account-wide')
    expect(d).not.toContain('/model と入力')
    // There IS still a next move, and it is the true one.
    expect(d).toContain('上限が回復するまで')
  })

  it('derives the kind from the CLI wording, end to end — not from a hand-set flag', async () => {
    // The branch above is only worth anything if the two REAL screens reach it as
    // different kinds. Driven through the whole pass, from PTY text to bell row.
    for (const [screen, expected] of [
      [stoppedScreen, '/model と入力'],
      [accountWideScreen, '上限が回復するまで'],
    ] as const) {
      resetOwnerDeskLimitState()
      const h = harness()
      addDesk(h, 'desk-a', screen)
      const sighted = T0 + OWNER_DESK_QUIET_MS
      await runOwnerDeskLimitPass({ now: sighted, deps: h.deps })
      await runOwnerDeskLimitPass({ now: sighted + OWNER_DESK_CONFIRM_MS, deps: h.deps })
      await settle(h, sighted + OWNER_DESK_CONFIRM_MS)
      expect(h.sent).toHaveLength(1)
      expect(h.sent[0].detail).toContain(expected)
    }
  })
})

// ── One event is one row, however many desks it stopped (round 3, MF-2) ──────

describe('ownerDeskLimit — desks that stop together', () => {
  /** Stop N desks — each with its OWN last-output time, i.e. its own skew — and
   *  run the watch on its real 15s tick until everything has settled.
   *
   *  ⚠ THE SKEW IS THE POINT, and its absence is why the first coalescing fix
   *  shipped broken. That version merged "the stops confirmed in the same PASS",
   *  and this helper hardcoded `lastOutputAt: T0` for every desk — so the suite
   *  only ever exercised skew = 0, the one case where per-pass merging works.
   *  Adversarial review measured the rest on the real pass: 1s of skew → 2
   *  notifications, 15s → SIX identical rows, verbatim the defect the branch was
   *  rejected for. Any future rework of the merge must keep varying this. */
  const stopTogether = async (
    desks: ReadonlyArray<{
      id: string
      cwd?: string
      deskLabel?: string
      screen?: () => string
      /** ms after T0 that this desk stopped painting — its skew. */
      skew?: number
    }>,
  ) => {
    const h = harness()
    for (const d of desks) {
      addDesk(h, d.id, d.screen ?? accountWideScreen, {
        cwd: d.cwd ?? '/Users/me/projects/OG',
        lastOutputAt: T0 + (d.skew ?? 0),
        ...(d.deskLabel ? { deskLabel: d.deskLabel } : {}),
      })
    }
    // Drive the real cadence, long enough for the widest skew to be sighted,
    // confirmed and flushed — no jumping straight to the answer.
    const widest = Math.max(...desks.map((d) => d.skew ?? 0))
    const last = T0 + widest + OWNER_DESK_QUIET_MS + OWNER_DESK_CONFIRM_MS + OWNER_DESK_MERGE_CAP_MS
    let r = { notified: [] as string[], tracked: [] as string[] }
    for (let t = T0; t <= last + OWNER_DESK_MERGE_QUIET_MS; t += OWNER_DESK_LIMIT_INTERVAL_MS) {
      const pass = await runOwnerDeskLimitPass({ now: t, deps: h.deps })
      if (pass.notified.length) r = pass
    }
    return { h, r }
  }

  it('merges desks that stop SECONDS apart, not just in the same tick', async () => {
    // THE BLOCKER the first coalescing fix left open (adversarial review, round 3).
    // An account-wide exhaustion does not stop every desk at the same instant —
    // each fails as its own in-flight request lands — and which 15s pass a desk is
    // confirmed in follows its OWN output-quiet window. One second of skew put a
    // pair either side of a bucket boundary and produced two identical rows.
    const { h } = await stopTogether([
      { id: 'pane-1', skew: 0 },
      { id: 'pane-2', skew: 1_000 },
    ])
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].detail).toContain('会話 2件')
  })

  it('merges an event that arrives spread over a quarter-minute', async () => {
    // The measured stagger: six desks failing across ~18 seconds produced THREE
    // rows under per-pass merging.
    const { h } = await stopTogether([
      { id: 'p1', skew: 0 },
      { id: 'p2', skew: 2_000 },
      { id: 'p3', skew: 3_000 },
      { id: 'p4', skew: 7_000 },
      { id: 'p5', skew: 11_000 },
      { id: 'p6', skew: 18_000 },
    ])
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].detail).toContain('会話 6件')
  })

  it('does not defer forever: a trickle is capped and told', async () => {
    // The other direction — the merge must not become "wait until nothing is
    // wrong", or a bad enough event would notify LATEST when it matters most.
    // Desks arriving one interval apart exceed the cap and are told in bounded
    // groups rather than held indefinitely.
    const { h } = await stopTogether([
      { id: 'q1', skew: 0 },
      { id: 'q2', skew: 15_000 },
      { id: 'q3', skew: 30_000 },
      { id: 'q4', skew: 45_000 },
      { id: 'q5', skew: 60_000 },
      { id: 'q6', skew: 75_000 },
    ])
    // Far fewer rows than desks (six identical rows was the rejected defect), and
    // every desk is accounted for across them.
    expect(h.sent.length).toBeGreaterThan(0)
    expect(h.sent.length).toBeLessThan(6)
  })

  it('raises ONE notification for four panes, not four identical ones', async () => {
    // THE DEFECT round 3 caught. An account-wide exhaustion stops every desk at
    // once, and `deskLabel` is set only on the commander/supply desks — so the
    // Terminal tab's panes all rendered the SAME sentence. Six identical rows is
    // one piece of information repeated until it crowds a bell that is capped and
    // holds the fatal escalations that actually need a human.
    const { h, r } = await stopTogether([
      { id: 'pane-1' },
      { id: 'pane-2' },
      { id: 'pane-3' },
      { id: 'pane-4' },
    ])
    expect(r.notified).toHaveLength(4) // all four ARE stopped…
    expect(h.sent).toHaveLength(1) // …and the owner reads one row about it
    expect(h.sent[0].detail).toContain('会話 4件')
    expect(h.sent[0].projectPath).toBe('/Users/me/projects/OG')
  })

  it('names the desks it CAN name and counts the rest', async () => {
    const { h } = await stopTogether([
      { id: 'cmd', deskLabel: '司令官' },
      { id: 'sup', deskLabel: '補給官' },
      { id: 'pane-1' },
      { id: 'pane-2' },
    ])
    expect(h.sent).toHaveLength(1)
    // Grouped by project, so four desks in one project do not repeat its name.
    expect(h.sent[0].detail).toContain('「proj:OG」の司令官・補給官・会話2件')
  })

  it('drops the open-target when the stopped desks disagree about where they are', async () => {
    const { h } = await stopTogether([
      { id: 'a', cwd: '/Users/me/projects/one' },
      { id: 'b', cwd: '/Users/me/projects/two' },
    ])
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].projectPath).toBeUndefined()
    expect(h.sent[0].detail).toContain('「proj:one」の会話、「proj:two」の会話')
  })

  it('softens the advice when even ONE of the merged stops cannot be fixed by /model', async () => {
    const { h } = await stopTogether([
      { id: 'per-model', screen: stoppedScreen },
      { id: 'account', screen: accountWideScreen },
    ])
    expect(h.sent).toHaveLength(1)
    // Telling the owner to /model out of a stop /model cannot fix is the defect
    // this round exists to close — so one account-wide desk softens the whole row.
    expect(h.sent[0].detail).not.toContain('/model と入力')
    expect(h.sent[0].detail).toContain('上限が回復するまで')
  })

  it('still speaks when NAMING a desk fails — a bad lookup must not cost the stop', async () => {
    // Every desk is flagged `notified` before the notify runs, so anything that
    // throws on the way loses that stop for good. Coalescing raised the stakes:
    // one failing lookup would take the whole pass's desks down with it. Both a
    // rejection and a SYNCHRONOUS throw are absorbed — the injected seam is not
    // obliged to be async — and an unnamed message is still one the owner can act
    // on, which is why the location is optional in the first place.
    const h = harness()
    h.deps.project = () => {
      throw new Error('registry unavailable')
    }
    addDesk(h, 'desk-a', stoppedScreen)
    addDesk(h, 'desk-b', stoppedScreen)
    const sighted = T0 + OWNER_DESK_QUIET_MS
    await runOwnerDeskLimitPass({ now: sighted, deps: h.deps })
    await runOwnerDeskLimitPass({ now: sighted + OWNER_DESK_CONFIRM_MS, deps: h.deps })
    await settle(h, sighted + OWNER_DESK_CONFIRM_MS)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].detail).toContain('上限に達しました')
    expect(h.sent[0].projectPath).toBeUndefined() // nowhere safe to point
  })

  it('still writes the single-desk message when only one desk stopped', async () => {
    const { h } = await stopTogether([{ id: 'solo' }])
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].detail).toContain('「proj:OG」で開いている会話は')
    expect(h.sent[0].detail).not.toContain('件')
  })
})

// ── Which sessions are watched at all ───────────────────────────────────────

interface FakeSession {
  info: TerminalInfo
  pty: unknown
  buffer: string
  listeners: Set<unknown>
  exitListeners: Set<unknown>
}

const pool = () =>
  (globalThis as { __openground_terminal?: { sessions: Map<string, FakeSession> } })
    .__openground_terminal!

const fake = (id: string, over: Partial<TerminalInfo> = {}): FakeSession => ({
  info: {
    id,
    cwd: `/p/${id}`,
    shell: '/bin/zsh',
    cols: 100,
    rows: 30,
    startedAt: new Date(T0).toISOString(),
    tag: 'claude',
    ...over,
  },
  pty: {},
  buffer: '',
  listeners: new Set(),
  exitListeners: new Set(),
})

describe('getTerminalScreenLogical — the PRODUCTION reader, driven directly', () => {
  // Round 3 nit: the rendering suite proved things about a hand-copy of this
  // function, never about the function. The copy is gone (it imports readScreen
  // now), and these drive the real entry point through the real session pool.

  it('returns null for a session that is gone, and for one with no headless terminal', () => {
    expect(getTerminalScreenLogical('no-such-session')).toBeNull()
    pool().sessions.set('bufferless', fake('bufferless'))
    try {
      // NOT the raw ring buffer. Its rows carry the cursor addressing claude
      // interleaves, so handing them to a row classifier does not degrade the
      // sensor — it blinds it, while every layer above still sees a string.
      expect(getTerminalScreenLogical('bufferless')).toBeNull()
    } finally {
      pool().sessions.delete('bufferless')
    }
  })

  it('rejoins soft-wrapped rows into the logical lines a human reads', async () => {
    const term = new HeadlessTerminal({ cols: 40, rows: 8, allowProposedApi: true, scrollback: 0 })
    await new Promise<void>((res) => term.write(`⏺ ${'x'.repeat(60)}\r\ndone`, () => res()))
    pool().sessions.set('live', { ...fake('live'), headless: term } as unknown as FakeSession)
    try {
      const screen = getTerminalScreenLogical('live')
      // 60 characters laid across two 40-column rows come back as ONE row. This
      // rejoin is load-bearing: without it the CLI's 95-character notice loses
      // its final phrase at 80 columns and a real stop goes unreported.
      expect(screen?.split('\n')[0]).toContain('x'.repeat(60))
    } finally {
      pool().sessions.delete('live')
    }
  })
})

describe('listOwnerDeskTerminals — only the desks a human sits at', () => {
  beforeEach(() => {
    pool().sessions.clear()
  })
  afterEach(() => {
    pool().sessions.clear()
  })

  it('includes the owner desks and excludes everything else', () => {
    const p = pool().sessions
    p.set('desk', fake('desk', { ownerDesk: true }))
    // An UNATTENDED swarm session: a visible pane, but nobody is waiting at its
    // keyboard and the engine already rescues it (hold → requeue → tier demotion).
    p.set('worker', fake('worker'))
    // A headless utility run (auto-title / auto-description).
    p.set('util', fake('util', { hidden: true }))
    // A plain shell — no claude, no limit to hit.
    p.set('shell', fake('shell', { tag: 'shell' }))
    // A desk whose PTY has exited: the conversation is over, not stopped.
    p.set('dead', fake('dead', { ownerDesk: true, finishedAt: new Date(T0).toISOString() }))

    expect(listOwnerDeskTerminals().map((d) => d.id)).toEqual(['desk'])
  })

  it('drops contradictory sessions instead of trusting the flag alone', () => {
    const p = pool().sessions
    // Both flags set is a contradiction (a headless run has no pane the owner can
    // go type /model into). Notifying about a window that does not exist would be
    // a dead end, so the pool-level filter wins over the launcher's flag.
    p.set('hidden-desk', fake('hidden-desk', { ownerDesk: true, hidden: true }))
    // A plain shell has no model to run out of, whatever flag it carries.
    p.set('shell-desk', fake('shell-desk', { ownerDesk: true, tag: 'shell' }))

    expect(listOwnerDeskTerminals()).toEqual([])
  })

  it('carries the clock inputs the watch gates on', () => {
    pool().sessions.set('desk', fake('desk', { ownerDesk: true, lastOutputAt: T0 + 5 }))
    const [d] = listOwnerDeskTerminals()
    expect(d.startedAtMs).toBe(T0)
    expect(d.lastOutputAt).toBe(T0 + 5)
  })
})

describe('overlapping passes', () => {
  beforeEach(() => resetOwnerDeskLimitState())

  // WHAT THIS DOES AND DOES NOT CLAIM. At-most-once notification does NOT depend on
  // the in-flight guard: `notified` is marked BEFORE the awaited notify, so a pass
  // that re-enters during that await already sees it set and skips. Verified by
  // deleting the guard — every other test in this file still passed, so a test
  // asserting "only one bell" here would prove nothing and quietly rot into
  // decoration. (That is the failure mode this whole feature was sent back for
  // twice; a test that cannot fail is worse than no test.)
  //
  // What the guard DOES buy is that an overlapping pass performs no WORK — it reads
  // no screens — which is both the observable difference and the property that keeps
  // at-most-once true if `screen` ever becomes async and the mark-before-await
  // window widens. So that is what is asserted.
  it('an overlapping pass reads no screens instead of rescanning', async () => {
    const h = harness()
    addDesk(h, 'desk-a', stoppedScreen)

    let release = (): void => {}
    const inFlight = new Promise<void>((res) => {
      release = res
    })
    h.deps.notify = async (n) => {
      h.sent.push(n)
      await inFlight // hold the first pass open inside its notify
    }

    const confirmed = T0 + OWNER_DESK_QUIET_MS + OWNER_DESK_CONFIRM_MS
    await runOwnerDeskLimitPass({ now: T0 + OWNER_DESK_QUIET_MS, deps: h.deps })
    await runOwnerDeskLimitPass({ now: confirmed, deps: h.deps })
    // The pass that actually NOTIFIES is the one that flushes the merge window.
    const first = runOwnerDeskLimitPass({ now: toldAt(confirmed), deps: h.deps })
    const readsBefore = h.reads.length

    // A second driver (a "check now" route) fires while the first is mid-notify.
    const second = await runOwnerDeskLimitPass({ now: toldAt(confirmed), deps: h.deps })
    expect(h.reads.length).toBe(readsBefore) // declined before touching a desk
    expect(second.notified).toEqual([])

    release()
    expect((await first).notified).toEqual(['desk-a'])
    expect(h.sent).toHaveLength(1)
  })

  it('a pass that fails leaves the watch usable rather than wedged shut', async () => {
    // The guard is released in a `finally`, so a pass that blows up cannot leave the
    // flag set and silence every future pass. Drives a failure through every
    // injected seam at once, since each is independently defended inside the pass.
    const h = harness()
    addDesk(h, 'desk-a', stoppedScreen)
    h.deps.listDesks = () => {
      throw new Error('pool exploded')
    }
    await runOwnerDeskLimitPass({ now: T0 + OWNER_DESK_QUIET_MS, deps: h.deps })

    h.deps.listDesks = () => Array.from(h.desks.values()).map((d) => d.desk)
    const confirmed = T0 + OWNER_DESK_QUIET_MS + OWNER_DESK_CONFIRM_MS
    await runOwnerDeskLimitPass({ now: T0 + OWNER_DESK_QUIET_MS, deps: h.deps })
    await runOwnerDeskLimitPass({ now: confirmed, deps: h.deps })
    const r = await settle(h, confirmed)
    expect(r.notified).toEqual(['desk-a'])
  })
})

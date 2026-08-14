// @vitest-environment node
//
// The DECISION LEDGER — the record of what the owner's stand-in ACTUALLY DID
// (answered on their behalf / asked them instead / abstained), as opposed to the
// self-report the Persona courses hold.
//
// EVERYTHING HERE IS BEHAVIOURAL, AND READ BACK THROUGH THE PRODUCTION READER.
// In particular the verdict mapping is NEVER exercised by calling recordDecision
// with a verdict already chosen — that would test the store and assert nothing
// about the thing that can actually be wrong. Instead each case drives the REAL
// production wrapper (swarmOverseer's `withDecisionLedger`, the one wired into
// defaultOverseerDeps) with a stubbed brain answer, and reads the result back with
// `readLedger()`. So an OwnerAnswer shape → verdict regression is what goes red.
//
// HOME ISOLATION: OPENGROUND_HOME is a throwaway tmp dir per test, restored (never
// unset — an unset var aims every later write at the real ~/.openground).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, readFile, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getPersonaLedger,
  ledgerMatchKey,
  markEscalationAnswered,
  readLedger,
  recordDecision,
  summarizeLedger,
  LEDGER_RECENT_LIMIT,
  LEDGER_WEEK_MS,
  MAX_LEDGER_ENTRIES,
  MAX_LEDGER_QUESTION,
} from './personaLedger'
import { personaLedgerFile } from './paths'
import {
  runOverseerPass,
  initOverseerRuntime,
  withDecisionLedger,
  type OverseerDeps,
  type OverseerEngine,
  type OverseerRuntime,
} from './swarmOverseer'
import { openEscalation, answerEscalation } from './swarmEscalations'
import type { OwnerAnswer, OwnerQuestion } from './swarmOverseerBrain'
import type { PersonaLedgerEntry } from '@/lib/types'

let home: string
let project: string
const prevHome = process.env.OPENGROUND_HOME

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-persona-ledger-')))
  process.env.OPENGROUND_HOME = home
  // A real directory so canonicalize() (escalations) resolves it cleanly.
  project = join(home, 'proj')
  await mkdir(project, { recursive: true })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  // NEVER `delete` — an unset OPENGROUND_HOME resolves to the user's REAL
  // ~/.openground, and vitest reuses worker processes across files.
  if (prevHome !== undefined) process.env.OPENGROUND_HOME = prevHome
})

const PROJECT = '/proj'
const QUESTION = 'この画面のボタンは青と緑どちらにすべきですか？'

/** Drive the PRODUCTION wrapper with a stubbed brain answer. Nothing else in this
 *  file is allowed to write a verdict — the mapping must come from here. */
const decide = async (
  answer: OwnerAnswer,
  q: Partial<OwnerQuestion> = {},
): Promise<OwnerAnswer> =>
  withDecisionLedger(async () => answer)({
    question: QUESTION,
    projectPath: PROJECT,
    ...q,
  })

const entryOf = (entries: PersonaLedgerEntry[]): PersonaLedgerEntry => {
  expect(entries).toHaveLength(1)
  return entries[0]
}

// ── The mapping: OwnerAnswer shape → verdict, landed on disk ──────────────────

describe('decision ledger — the verdict mapping (through the production wrapper)', () => {
  it("an ANSWER is recorded as 'answered', carrying its confidence and no why", async () => {
    const out = await decide({ kind: 'answer', text: '青で', confidence: 'medium' })
    expect(out).toEqual({ kind: 'answer', text: '青で', confidence: 'medium' })

    const e = entryOf(await readLedger())
    expect(e.verdict).toBe('answered')
    expect(e.confidence).toBe('medium')
    expect(e.why).toBeUndefined()
    expect(e.question).toBe(QUESTION)
    expect(e.projectPath).toBe(PROJECT)
    expect(Number.isFinite(Date.parse(e.at))).toBe(true)
    expect(e.answered).toBeUndefined() // the owner has not weighed in
  })

  it("an escalate why='insufficient-info' is recorded as 'abstained'", async () => {
    await decide({
      kind: 'escalate',
      why: 'insufficient-info',
      reason: 'コーパスに根拠が薄い',
      abstained: true,
    })
    const e = entryOf(await readLedger())
    expect(e.verdict).toBe('abstained')
    expect(e.why).toBe('insufficient-info')
    expect(e.confidence).toBeUndefined()
  })

  it("an escalate why='irreversible' is recorded as 'asked' — it went to the owner", async () => {
    await decide({ kind: 'escalate', why: 'irreversible', reason: '本番DBを消す操作' })
    const e = entryOf(await readLedger())
    expect(e.verdict).toBe('asked')
    expect(e.why).toBe('irreversible')
  })

  it("an escalate why='policy' is recorded as 'asked' too (the owner's own area)", async () => {
    await decide({ kind: 'escalate', why: 'policy', reason: '命名はオーナーの領域' })
    const e = entryOf(await readLedger())
    expect(e.verdict).toBe('asked')
    expect(e.why).toBe('policy')
  })

  it('records one entry PER decision, in order, and each keeps its own verdict', async () => {
    await decide({ kind: 'answer', text: 'a', confidence: 'high' }, { question: 'Q1' })
    await decide({ kind: 'escalate', why: 'policy', reason: 'r' }, { question: 'Q2' })
    await decide({ kind: 'escalate', why: 'insufficient-info', reason: 'r' }, { question: 'Q3' })

    const entries = await readLedger()
    expect(entries.map((e) => [e.question, e.verdict])).toEqual([
      ['Q1', 'answered'],
      ['Q2', 'asked'],
      ['Q3', 'abstained'],
    ])
  })

  it('TRUNCATES the question at the documented cap — but keys on the FULL text', async () => {
    const huge = `頭:${'あ'.repeat(5000)}:尻`
    await decide({ kind: 'escalate', why: 'irreversible', reason: 'r' }, { question: huge })

    const e = entryOf(await readLedger())
    expect(e.question).toHaveLength(MAX_LEDGER_QUESTION)
    expect(e.question).toBe(huge.slice(0, MAX_LEDGER_QUESTION))
    // …and ON DISK, not merely as the reader renders it. The reader re-clamps too
    // (a hand-edited file must not blow up the wire), which means the read-back
    // assertion above is satisfied even by a writer that stored the whole 5000
    // chars — measured 2026-08-14: mutating the write-side slice away left this
    // test GREEN. The cap's entire purpose is that the FILE stays small, so the
    // bytes are what has to be checked.
    const stored = JSON.parse(await readFile(personaLedgerFile(), 'utf8')) as {
      entries: { question: string }[]
    }
    expect(stored.entries[0].question).toHaveLength(MAX_LEDGER_QUESTION)
    // The stored row is a summary; the CORRELATION must still survive it, or the
    // owner's later answer could never be stamped onto a long question.
    expect(
      await markEscalationAnswered({ key: ledgerMatchKey({ projectPath: PROJECT, question: huge }) }),
    ).toBe(true)
    expect((await readLedger())[0].answered?.byOwner).toBe(true)
  })

  it('writes the ledger 0600 (personal data, like the corpus beside it)', async () => {
    await decide({ kind: 'answer', text: 'x', confidence: 'low' })
    const { stat } = await import('fs/promises')
    const st = await stat(personaLedgerFile())
    expect(st.mode & 0o777).toBe(0o600)
  })
})

// ── Isolation: a ledger failure may NOT break the decision path ───────────────

describe('decision ledger — isolation from the swarm decision path', () => {
  const armed = (over: Partial<OverseerRuntime> = {}): OverseerRuntime => ({
    ...initOverseerRuntime(),
    enabled: true,
    lastJanitorAt: 2_000_000_000_000, // keep the incidental W6 janitor out of the way
    ...over,
  })

  const makeEngine = (deps: OverseerDeps): { engine: OverseerEngine; deps: OverseerDeps } => ({
    engine: {
      path: PROJECT,
      running: true,
      anomalies: [],
      notified: new Set<string>(),
      workers: [
        { terminalId: 'term-1', branch: 'swarm/x', taskId: 'card-1', taskTitle: 'あるカード' },
      ],
      reviews: [],
      overseer: armed(),
    },
    deps,
  })

  const baseDeps = (over: Partial<OverseerDeps>): OverseerDeps => ({
    now: () => 1_000_000_000_000,
    isAlive: () => true,
    readHeartbeat: async () => ({ ready: false, blocked: true, blockers: QUESTION }),
    answerAsOwner: async () => ({ kind: 'answer', text: 'x', confidence: 'high' }),
    openEscalation: async () => ({
      escalation: { id: 'esc-1', status: 'open' } as never,
      deduped: false,
    }),
    canInjectInto: async () => true,
    injectAnswer: async () => true,
    notifyInfo: async () => ({}),
    peekUsagePct: () => null,
    refreshUsage: () => {},
    listEscalations: async () => [],
    listReceiptKeys: async () => new Set<string>(),
    recentFatals: async () => [],
    runJanitor: async () => ({}),
    ...over,
  })

  /** Wait for the fire-and-forget brain chain to settle into the mailbox. Polling,
   *  not a single tick: the wrapper now awaits a real disk write before the result
   *  is pushed, so "one macrotask" is not a contract this can rely on. */
  const untilSettled = async (ov: OverseerRuntime): Promise<void> => {
    for (let i = 0; i < 200 && ov.brainResults.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
  }

  it('a ledger writer that THROWS still lets the OwnerAnswer reach the mailbox', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const answer: OwnerAnswer = { kind: 'answer', text: 'Postgres を使って', confidence: 'high' }
      const { engine, deps } = makeEngine(
        baseDeps({
          answerAsOwner: withDecisionLedger(async () => answer, async () => {
            throw new Error('disk on fire')
          }),
        }),
      )

      const out = await runOverseerPass(engine, [], () => {}, deps)
      expect(out.fired).toContain('S4')
      await untilSettled(engine.overseer)

      // THE PROPERTY: the decision survived the failed write, intact.
      expect(engine.overseer.brainResults).toHaveLength(1)
      expect(engine.overseer.brainResults[0].answer).toEqual(answer)
      // …and the failure was said out loud rather than swallowed silently.
      expect(warn.mock.calls.flat().join(' ')).toContain('disk on fire')
      // Nothing was recorded — the point is that this costs a statistic, not a decision.
      expect(await readLedger()).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  it('the REAL recorder lands the decision AND the answer reaches the mailbox', async () => {
    const answer: OwnerAnswer = { kind: 'escalate', why: 'irreversible', reason: '不可逆' }
    const { engine, deps } = makeEngine(
      baseDeps({ answerAsOwner: withDecisionLedger(async () => answer) }),
    )

    await runOverseerPass(engine, [], () => {}, deps)
    await untilSettled(engine.overseer)

    expect(engine.overseer.brainResults[0].answer).toEqual(answer)
    const e = entryOf(await readLedger())
    expect(e.verdict).toBe('asked')
    expect(e.question).toBe(QUESTION)
    expect(e.projectPath).toBe(PROJECT)
  })

  it('recordDecision NEVER throws, even when the store cannot be read', async () => {
    // A DIRECTORY where the ledger file belongs: every read/write against it fails
    // with EISDIR — a non-ENOENT error, i.e. the one case the write path refuses to
    // clobber. The contract is that the caller still sees a resolved promise.
    await mkdir(personaLedgerFile(), { recursive: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(
        recordDecision({ projectPath: PROJECT, verdict: 'answered', question: 'q' }),
      ).resolves.toBeUndefined()
    } finally {
      warn.mockRestore()
    }
  })
})

// ── The cap ──────────────────────────────────────────────────────────────────

describe('decision ledger — the cap keeps the NEWEST entries', () => {
  const seed = async (count: number): Promise<void> => {
    const base = Date.parse('2026-01-01T00:00:00.000Z')
    await writeFile(
      personaLedgerFile(),
      JSON.stringify({
        version: 1,
        entries: Array.from({ length: count }, (_, i) => ({
          id: `seed-${i}`,
          at: new Date(base + i * 1000).toISOString(),
          projectPath: PROJECT,
          verdict: 'asked',
          question: `古い質問 ${i}`,
        })),
      }),
    )
  }

  it('drops the OLDEST row when one more decision arrives at the cap', async () => {
    await seed(MAX_LEDGER_ENTRIES)
    await recordDecision({
      projectPath: PROJECT,
      verdict: 'answered',
      question: '新しい質問',
      id: 'newest',
    })

    const entries = await readLedger()
    expect(entries).toHaveLength(MAX_LEDGER_ENTRIES)
    // The one that just happened is the whole point of the file.
    expect(entries.at(-1)?.id).toBe('newest')
    expect(entries.some((e) => e.id === 'newest')).toBe(true)
    // …and the fossil at the other end is what fell off.
    expect(entries.some((e) => e.id === 'seed-0')).toBe(false)
    expect(entries[0].id).toBe('seed-1')
  })

  it('a ledger ALREADY over the cap is trimmed from the front on the next write', async () => {
    await seed(MAX_LEDGER_ENTRIES + 50)
    await recordDecision({ projectPath: PROJECT, verdict: 'asked', question: 'q', id: 'newest' })
    const entries = await readLedger()
    expect(entries).toHaveLength(MAX_LEDGER_ENTRIES)
    expect(entries.at(-1)?.id).toBe('newest')
    expect(entries.some((e) => e.id === `seed-${MAX_LEDGER_ENTRIES + 49}`)).toBe(true)
  })
})

// ── summarizeLedger (PURE — the counts, without fs) ───────────────────────────

describe('summarizeLedger', () => {
  const NOW = Date.parse('2026-08-14T12:00:00.000Z')
  const at = (msAgo: number): string => new Date(NOW - msAgo).toISOString()
  const entry = (
    verdict: PersonaLedgerEntry['verdict'],
    msAgo: number,
    over: Partial<PersonaLedgerEntry> = {},
  ): PersonaLedgerEntry => ({
    id: `${verdict}-${msAgo}`,
    at: at(msAgo),
    projectPath: PROJECT,
    verdict,
    question: 'q',
    ...over,
  })

  it('counts nothing for an empty ledger (the honest fresh-machine answer)', () => {
    expect(summarizeLedger([], NOW)).toEqual({
      week: { answered: 0, asked: 0, abstained: 0 },
      total: { answered: 0, asked: 0, abstained: 0 },
      lastAt: null,
    })
  })

  it('windows at exactly 7 days: the boundary is IN, one ms older is OUT', () => {
    const s = summarizeLedger(
      [
        entry('answered', LEDGER_WEEK_MS), // exactly 7 days old — in
        entry('answered', LEDGER_WEEK_MS + 1), // one ms older — out
        entry('asked', LEDGER_WEEK_MS - 1), // just inside
        entry('asked', 30 * 24 * 60 * 60 * 1000), // a month ago — out
        entry('abstained', 0),
      ],
      NOW,
    )
    expect(s.week).toEqual({ answered: 1, asked: 1, abstained: 1 })
    expect(s.total).toEqual({ answered: 2, asked: 2, abstained: 1 })
  })

  it('"this week it answered 3 and asked you 2" — the sentence the screen needs', () => {
    const s = summarizeLedger(
      [
        entry('answered', 1000),
        entry('answered', 2000),
        entry('answered', 3000),
        entry('asked', 4000),
        entry('asked', 5000),
        entry('answered', 20 * 24 * 60 * 60 * 1000), // last month — not this week
      ],
      NOW,
    )
    expect(s.week.answered).toBe(3)
    expect(s.week.asked).toBe(2)
    expect(s.total.answered).toBe(4)
  })

  it('lastAt is the NEWEST stamp, not the last element', () => {
    const s = summarizeLedger([entry('asked', 1000), entry('answered', 99_000)], NOW)
    expect(s.lastAt).toBe(at(1000))
  })

  it('an unparseable stamp counts in total, never in the week, and never as lastAt', () => {
    const s = summarizeLedger(
      [entry('asked', 0, { at: 'not-a-date' }), entry('answered', 1000)],
      NOW,
    )
    expect(s.total).toEqual({ answered: 1, asked: 1, abstained: 0 })
    expect(s.week).toEqual({ answered: 1, asked: 0, abstained: 0 })
    expect(s.lastAt).toBe(at(1000))
  })

  it('a stamp slightly in the FUTURE (clock skew) still reads as this week', () => {
    const s = summarizeLedger([entry('answered', -60_000)], NOW)
    expect(s.week.answered).toBe(1)
  })
})

// ── The owner answers back (the escalation seam) ──────────────────────────────

describe('decision ledger — the owner answering an escalation stamps the row', () => {
  const escalationDeps = {
    // Keep the corpus + worker-delivery legs out of this test: the property under
    // test is the LEDGER stamp, and both of those have their own suites.
    appendMemory: async () => ({}),
    queueForNextDispatch: async () => {},
  }

  it('the proxy asked → the human decided → the ledger row carries byOwner', async () => {
    // 1. The stand-in declines to speak (recorded through the production wrapper).
    await decide(
      { kind: 'escalate', why: 'irreversible', reason: '本番に配布する操作' },
      { projectPath: project },
    )
    expect((await readLedger())[0].answered).toBeUndefined()

    // 2. The same question reaches the owner's inbox…
    const { escalation } = await openEscalation(
      {
        projectPath: project,
        question: QUESTION,
        context: '不可逆なので人間の判断が要る。',
        whyEscalated: 'irreversible',
        taskId: 'card-1',
      },
      { notify: async () => ({}) },
    )

    // 3. …and the owner answers it.
    const answered = await answerEscalation(escalation.id, '青にしてください', escalationDeps)

    const e = entryOf(await readLedger())
    expect(e.verdict).toBe('asked')
    expect(e.answered?.byOwner).toBe(true)
    // The SAME instant the escalation records — one decision, one timestamp.
    expect(e.answered?.at).toBe(answered.escalation.answeredAt)
  })

  // The overseer's drain raises an inbox record for a proxy answer it could NOT
  // deliver to the worker ("proxy が回答済みだが worker への配達に失敗") — same
  // project, same question, therefore the SAME key as the ledger row that says the
  // stand-in ANSWERED. The owner acting on that item is a re-delivery, not a
  // correction; stamping it would make the screen claim the proxy deferred when it
  // did the opposite.
  it('does NOT stamp a row where the PROXY answered (an undelivered answer is not a correction)', async () => {
    await decide({ kind: 'answer', text: '青で', confidence: 'high' }, { projectPath: project })
    const key = ledgerMatchKey({ projectPath: project, question: QUESTION })

    expect(await markEscalationAnswered({ key })).toBe(false)
    expect((await readLedger())[0].answered).toBeUndefined()

    // …and with a genuine deferral sitting UNDER it, the stamp finds that one and
    // still leaves the 'answered' row alone.
    await decide({ kind: 'escalate', why: 'irreversible', reason: 'r' }, { projectPath: project })
    expect(await markEscalationAnswered({ key })).toBe(true)
    const entries = await readLedger()
    expect(entries.map((e) => [e.verdict, !!e.answered])).toEqual([
      ['answered', false],
      ['asked', true],
    ])
  })

  it('an EXPLICIT ledger id may still stamp any row — the caller named it', async () => {
    await recordDecision({ projectPath: PROJECT, verdict: 'answered', question: 'q', id: 'row-1' })
    expect(await markEscalationAnswered({ id: 'row-1' })).toBe(true)
  })

  it('an escalation the proxy never saw stamps nothing (the ordinary miss)', async () => {
    await decide({ kind: 'escalate', why: 'policy', reason: 'r' }, { projectPath: project })
    const { escalation } = await openEscalation(
      {
        projectPath: project,
        question: 'まったく別の、テンプレートが上げた質問',
        context: 'S1 rework-exhausted',
        whyEscalated: 'policy',
      },
      { notify: async () => ({}) },
    )
    await answerEscalation(escalation.id, 'やり直して', escalationDeps)

    expect((await readLedger())[0].answered).toBeUndefined()
  })

  it('the stamp is monotonic — a re-answer never re-dates the first one', async () => {
    await decide({ kind: 'escalate', why: 'irreversible', reason: 'r' }, { projectPath: project })
    const key = ledgerMatchKey({ projectPath: project, question: QUESTION })
    expect(await markEscalationAnswered({ key }, { at: '2026-08-01T00:00:00.000Z' })).toBe(true)
    expect(await markEscalationAnswered({ key }, { at: '2026-08-09T00:00:00.000Z' })).toBe(false)
    expect((await readLedger())[0].answered?.at).toBe('2026-08-01T00:00:00.000Z')
  })

  it('markEscalationAnswered by ledger id works too, and a miss is false (never a throw)', async () => {
    await recordDecision({ projectPath: PROJECT, verdict: 'asked', question: 'q', id: 'row-1' })
    expect(await markEscalationAnswered({ id: 'nope' })).toBe(false)
    expect(await markEscalationAnswered({ id: 'row-1' })).toBe(true)
    expect((await readLedger())[0].answered?.byOwner).toBe(true)
  })
})

// ── Store robustness (what the route inherits) ────────────────────────────────

describe('decision ledger — store robustness', () => {
  it('a CORRUPT ledger reads as empty and is PRESERVED aside on the next write', async () => {
    await writeFile(personaLedgerFile(), 'not json at all')
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await readLedger()).toEqual([])
    } finally {
      err.mockRestore()
    }

    await recordDecision({ projectPath: PROJECT, verdict: 'answered', question: 'q' })
    const { readdir } = await import('fs/promises')
    const files = await readdir(home)
    expect(files.some((f) => f.startsWith('persona-ledger.json.corrupt-'))).toBe(true)
    expect(await readLedger()).toHaveLength(1)
  })

  it('drops junk rows rather than putting them on the wire', async () => {
    await writeFile(
      personaLedgerFile(),
      JSON.stringify({
        version: 1,
        entries: [
          { id: 'ok', at: '2026-08-14T00:00:00.000Z', projectPath: PROJECT, verdict: 'answered', question: 'q' },
          { id: 'bad-verdict', at: '2026-08-14T00:00:00.000Z', projectPath: PROJECT, verdict: 'exploded', question: 'q' },
          { id: 'no-at', projectPath: PROJECT, verdict: 'asked', question: 'q' },
          null,
          'nope',
        ],
      }),
    )
    const entries = await readLedger()
    expect(entries.map((e) => e.id)).toEqual(['ok'])
  })

  it('drops a reason class it does not know — but KEEPS the decision', async () => {
    // `why` is a union on the wire (PersonaLedgerWhy), and this reader is the only
    // thing that makes that type honest: the file is hand-editable and a NEWER
    // build can write a class this one has never heard of. Dropping the field
    // rather than the row is the whole trade — a decision with an unreadable
    // reason is still a decision, and the screen already says what happened via
    // the verdict. (Let the unknown class through and the union becomes a lie:
    // the UI's exhaustive Record<PersonaLedgerWhy, …> would then be indexed by a
    // value it has no wording for, which is the silent blank this design exists
    // to prevent.)
    const row = (id: string, why: string) => ({
      id,
      at: '2026-08-14T00:00:00.000Z',
      projectPath: PROJECT,
      verdict: 'asked',
      question: 'q',
      why,
    })
    await writeFile(
      personaLedgerFile(),
      JSON.stringify({
        version: 1,
        entries: [row('known', 'irreversible'), row('unknown', 'quantum'), row('empty', '')],
      }),
    )

    const entries = await readLedger()
    // Every row survives — none of these is a malformed decision.
    expect(entries.map((e) => e.id)).toEqual(['known', 'unknown', 'empty'])
    expect(entries.find((e) => e.id === 'known')?.why).toBe('irreversible')
    expect(entries.find((e) => e.id === 'unknown')?.why).toBeUndefined()
    expect(entries.find((e) => e.id === 'empty')?.why).toBeUndefined()
    // …and the unknown slug is nowhere on the wire, not merely unrendered.
    expect(JSON.stringify(await getPersonaLedger())).not.toContain('quantum')
  })

  it('getPersonaLedger returns newest-first, capped, with the counts beside it', async () => {
    for (let i = 0; i < LEDGER_RECENT_LIMIT + 5; i++) {
      await recordDecision({
        projectPath: PROJECT,
        verdict: i % 2 === 0 ? 'answered' : 'asked',
        question: `q${i}`,
        id: `row-${i}`,
      })
    }
    const body = await getPersonaLedger()
    expect(body.recent).toHaveLength(LEDGER_RECENT_LIMIT)
    expect(body.recent[0].id).toBe(`row-${LEDGER_RECENT_LIMIT + 4}`)
    expect(body.summary.total.answered + body.summary.total.asked).toBe(LEDGER_RECENT_LIMIT + 5)
    expect(body.summary.lastAt).toBe(body.recent[0].at)
  })

  it('the on-disk shape is the versioned envelope (what a future migration reads)', async () => {
    await recordDecision({ projectPath: PROJECT, verdict: 'abstained', question: 'q' })
    const raw = JSON.parse(await readFile(personaLedgerFile(), 'utf8')) as {
      version: number
      entries: unknown[]
    }
    expect(raw.version).toBe(1)
    expect(raw.entries).toHaveLength(1)
  })
})

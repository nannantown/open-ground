import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, readFile, realpath, writeFile, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  DETECTORS,
  _resetPersonaInterviewForTest,
  answerTodayQuestion,
  ensureTodayQuestion,
  gatherMaterial,
  localDateKey,
  nextQuestion,
  peekTodayQuestion,
  pickCandidate,
  readInterviewState,
  skipTodayQuestion,
  snip,
  type InterviewMaterial,
} from './personaInterview'
import { personaInterviewFile } from './paths'
import { splitSaidDid } from '@/lib/persona/saidDid'
import { registerTestProject } from '@/test/registerProject'
import { mutateProjectData } from './projectData'
import type { AppendJudgmentInput } from './youCorpus'
import type {
  Escalation,
  PersonaInterviewState,
  PersonaQuestionKind,
  ProjectTask,
} from '@/lib/types'

// The interview loop. Generation is deterministic (no claude is ever spawned —
// see the module header), so these tests exercise the REAL generator: nothing
// here is mocked except the clock and the material sweep, both of which are
// explicit `deps` seams rather than module mocks.

let home: string
let savedHome: string | undefined

beforeEach(async () => {
  // The once-a-day memo and the in-flight latch live on globalThis so a
  // `tsx watch` reload cannot drop them — which also means they outlive a test.
  // Reset, or one test's "already asked today" silently suppresses the next.
  _resetPersonaInterviewForTest()
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-persona-interview-')))
  savedHome = process.env.OPENGROUND_HOME
  process.env.OPENGROUND_HOME = home
})

afterEach(async () => {
  _resetPersonaInterviewForTest()
  // NEVER `delete` this — openGroundHome() falls back to the REAL ~/.openground
  // when it is unset, and vitest reuses worker processes across files.
  process.env.OPENGROUND_HOME = savedHome ?? home
  await rm(home, { recursive: true, force: true })
})

// Local noon, so a test can add/subtract hours without crossing a day boundary.
const DAY0 = new Date(2026, 6, 19, 12, 0, 0).getTime()
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

// `boardColumn` is set by default on purpose: readProjectData DROPS a card that
// carries neither a column nor a legacy `kind` (dropLegacyNonBoardTasks), so a
// fixture without one never survives a real board round-trip.
const task = (over: Partial<ProjectTask> = {}): ProjectTask => ({
  id: `t-${Math.random().toString(36).slice(2)}`,
  title: 'a card',
  done: false,
  boardColumn: 'todo',
  createdAt: new Date(DAY0 - 2 * DAY).toISOString(),
  ...over,
})

const esc = (over: Partial<Escalation> = {}): Escalation => ({
  id: `e-${Math.random().toString(36).slice(2)}`,
  receiptKey: 'r',
  createdAt: new Date(DAY0 - 5 * DAY).toISOString(),
  projectPath: '/p',
  question: 'a question',
  context: 'ctx',
  whyEscalated: 'policy',
  status: 'open',
  ...over,
})

const material = (over: Partial<InterviewMaterial> = {}): InterviewMaterial => ({
  cards: [],
  escalations: [],
  // The happy default: every source was read. Tests that care about a partial
  // sweep set it false explicitly.
  complete: true,
  ...over,
})

const gatherOf = (m: InterviewMaterial) => () => Promise.resolve(m)

const EMPTY_STATE: PersonaInterviewState = {
  version: 1,
  lastAskedDate: '',
  today: null,
  askedSubjects: [],
}

describe('the question is drawn from the owner’s record — never a personality quiz', () => {
  // THE POLICY TEST. It is driven off the EXPORTED `DETECTORS` list, not off a
  // hand-kept list of questions — that difference is the whole point. An earlier
  // version only ran the banned-phrasing check over six fixtures it happened to
  // know about, and an adversarial review proved it toothless by adding a
  // personality-quiz detector: every one of the 92 tests still passed. Now a new
  // detector with no CASE fails `every detector has a fixture`, and a new
  // detector WITH a case has its rendered question run through BANNED.
  const CASES: { kind: PersonaQuestionKind; name: string; m: InterviewMaterial; mustQuote: string[] }[] = [
    {
      kind: 'card-rework',
      name: 'a card the owner sent back',
      m: material({ cards: [{ task: task({ title: '課金フローの実装', reworkCount: 2 }), projectId: 'p' }] }),
      mustQuote: ['課金フローの実装', '2'],
    },
    {
      kind: 'decision-speed-contrast',
      name: 'one call settled fast, another held for days',
      m: material({
        escalations: [
          esc({
            id: 'fast',
            question: '価格を $8 にしていい?',
            status: 'answered',
            createdAt: new Date(DAY0 - 3 * DAY).toISOString(),
            answeredAt: new Date(DAY0 - 3 * DAY + 10 * 60 * 1000).toISOString(),
          }),
          esc({
            id: 'slow',
            question: '返金の導線を先に作るべき?',
            status: 'answered',
            createdAt: new Date(DAY0 - 9 * DAY).toISOString(),
            answeredAt: new Date(DAY0 - 6 * DAY).toISOString(),
          }),
        ],
      }),
      mustQuote: ['価格を $8 にしていい?', '返金の導線を先に作るべき?'],
    },
    {
      kind: 'card-stale-blocked',
      name: 'a card parked on hold',
      m: material({
        cards: [
          {
            task: task({
              title: 'Windows 対応',
              boardColumn: 'blocked',
              createdAt: new Date(DAY0 - 6 * DAY).toISOString(),
            }),
            projectId: 'p',
          },
        ],
      }),
      mustQuote: ['Windows 対応', '6'],
    },
    {
      kind: 'escalation-long-open',
      name: 'a question left unanswered',
      m: material({
        escalations: [
          esc({
            question: '本番にデプロイしていい?',
            status: 'open',
            createdAt: new Date(DAY0 - 4 * DAY).toISOString(),
          }),
        ],
      }),
      mustQuote: ['本番にデプロイしていい?', '4'],
    },
    {
      kind: 'todo-passed-over',
      name: 'an old todo overtaken by a newer card in the SAME project',
      m: material({
        cards: [
          {
            task: task({
              id: 'old',
              title: 'ドキュメント整理',
              boardColumn: 'todo',
              createdAt: new Date(DAY0 - 20 * DAY).toISOString(),
            }),
            projectId: 'p',
          },
          {
            task: task({
              id: 'new',
              title: 'ログイン不具合',
              boardColumn: 'doing',
              createdAt: new Date(DAY0 - 1 * DAY).toISOString(),
            }),
            projectId: 'p',
          },
        ],
      }),
      mustQuote: ['ドキュメント整理', 'ログイン不具合'],
    },
    {
      kind: 'escalation-dismissed',
      name: 'a question closed without answering',
      m: material({
        escalations: [
          esc({
            question: 'この文言でいい?',
            status: 'dismissed',
            dismissedAt: new Date(DAY0 - 1 * DAY).toISOString(),
          }),
        ],
      }),
      mustQuote: ['この文言でいい?'],
    },
    {
      kind: 'corpus-gap',
      name: 'somewhere the stand-in itself could not decide',
      m: material({
        escalations: [
          esc({
            question: '返金は何日まで受ける?',
            status: 'open',
            createdAt: new Date(DAY0 - 1 * DAY).toISOString(),
            proxyDraft: { answer: '', confidence: 'low', isAbstention: true },
          }),
        ],
      }),
      mustQuote: ['返金は何日まで受ける?'],
    },
    {
      kind: 'escalation-answer-rule',
      name: 'a past answer, quoted back to ask whether it is a rule',
      m: material({
        escalations: [
          esc({
            question: '無料枠を広げていい?',
            answer: '広げない。まず有料の価値を上げる',
            status: 'answered',
            createdAt: new Date(DAY0 - 2 * DAY).toISOString(),
            answeredAt: new Date(DAY0 - 2 * DAY + 30 * 60 * 1000).toISOString(),
          }),
        ],
      }),
      mustQuote: ['無料枠を広げていい?', '広げない。まず有料の価値を上げる'],
    },
    {
      kind: 'card-approved',
      name: 'a card the owner approved to go ahead',
      m: material({
        cards: [
          { task: task({ title: '請求書の自動発行', selfSupplyApproved: true }), projectId: 'p' },
        ],
      }),
      mustQuote: ['請求書の自動発行'],
    },
  ]

  // Phrasings a generic personality quiz would use. None can appear: every
  // question this module can produce is built from an observed fact.
  const BANNED = [
    /あなたは.*ですか/,
    /どちらかというと/,
    /性格/,
    /普段から/,
    /一般的に/,
    /are you (a|an|the)\b/i,
    /do you (generally|usually|tend)/i,
    /how would you describe yourself/i,
    /on a scale/i,
    /personality/i,
  ]

  const assertNotAQuiz = (q: string) => {
    expect(q).toMatch(/[?？]/) // it ASKS something
    for (const bad of BANNED) expect(q, `banned phrasing in: ${q}`).not.toMatch(bad)
  }

  it('EVERY detector has a fixture here — a new one cannot ship unpinned', () => {
    // The teeth. Adding a detector without adding a CASE fails right here, so
    // the banned-phrasing check below can never fall behind the code.
    expect(CASES.map((c) => c.kind).sort()).toEqual(DETECTORS.map((d) => d.kind).sort())
  })

  for (const c of CASES) {
    it(`quotes the real thing it saw: ${c.name}`, () => {
      const picked = pickCandidate(c.m, EMPTY_STATE, DAY0)
      expect(picked, `no detector fired for: ${c.name}`).not.toBeNull()
      expect(picked!.kind).toBe(c.kind)
      assertNotAQuiz(picked!.textJa)
      assertNotAQuiz(picked!.textEn)
      // The observation itself is quoted back, so the owner can tell the
      // question came from their own week and not from a template deck.
      for (const fragment of c.mustQuote) {
        expect(
          picked!.textJa.includes(fragment) || picked!.textEn.includes(fragment),
          `question did not quote "${fragment}": ${picked!.textJa}`,
        ).toBe(true)
      }
    })
  }

  it('runs the banned-phrasing check over EVERY hit of EVERY detector', () => {
    // Not just the one candidate each fixture happens to surface: a detector
    // whose second-ranked rendering is a quiz item is caught here too.
    for (const c of CASES) {
      for (const d of DETECTORS) {
        for (const hit of d.detect(c.m, DAY0)) {
          assertNotAQuiz(hit.textJa)
          assertNotAQuiz(hit.textEn)
        }
      }
    }
  })

  it('EVERY hit of EVERY detector carries a readable setting, in both languages', () => {
    // The type already forces a detector to SUPPLY one (Candidate requires it,
    // so a new detector without a setting fails the build). This pins that what
    // it supplies is worth reading: long enough to place a memory, not a
    // restatement of the ask, and never a bare date with nothing around it.
    for (const c of CASES) {
      for (const d of DETECTORS) {
        for (const hit of d.detect(c.m, DAY0)) {
          const where = `${d.kind} / ${c.kind}`
          expect(hit.contextJa.length, `${where}: JA setting too thin`).toBeGreaterThan(8)
          expect(hit.contextEn.length, `${where}: EN setting too thin`).toBeGreaterThan(8)
          // A setting describes the situation; the question does the asking.
          expect(hit.contextJa, `${where}: JA setting asks instead of setting`).not.toContain('?')
          expect(hit.contextEn, `${where}: EN setting asks instead of setting`).not.toContain('?')
          // It must also not be a lone date fragment ("3日前。").
          expect(hit.contextJa.replace(/[0-9]/g, '').length).toBeGreaterThan(8)
        }
      }
    }
  })

  it('produces NOTHING rather than inventing a question when there is no material', async () => {
    const q = await ensureTodayQuestion({ now: () => DAY0, gather: gatherOf(material()) })
    expect(q).toBeNull()
  })

  it('ignores a dismissal too old to be worth asking about', () => {
    const ancient = material({
      escalations: [
        esc({ status: 'dismissed', dismissedAt: new Date(DAY0 - 200 * DAY).toISOString() }),
      ],
    })
    expect(pickCandidate(ancient, EMPTY_STATE, DAY0)).toBeNull()
  })

  it('never claims a card MOVED or was approved AT A TIME — the board records neither', () => {
    // The constraint that makes templates necessary rather than merely cheap:
    // a card carries no move/approve timestamps, so no question may date one.
    for (const c of CASES) {
      for (const d of DETECTORS) {
        for (const hit of d.detect(c.m, DAY0)) {
          expect(hit.textJa).not.toMatch(/(昨日|今日|先週).*(完了|done|承認|移動)しました/)
          expect(hit.textEn).not.toMatch(
            /you (moved|approved|completed|finished) .*(yesterday|today|last week)/i,
          )
          // "has sat on hold for N days" is the specific fabrication that got
          // through review: card AGE rendered as time-in-column.
          expect(hit.textEn).not.toMatch(/sat on hold for/i)
          expect(hit.textJa).not.toMatch(/日、保留のままにしています/)
        }
      }
    }
  })

  it('a detector that throws costs its own kind, not the day', () => {
    const boom = { kind: 'card-rework' as const, detect: () => { throw new Error('boom') } }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      DETECTORS.unshift(boom)
      const picked = pickCandidate(
        material({
          cards: [
            {
              task: task({
                title: '保留カード',
                boardColumn: 'blocked',
                createdAt: new Date(DAY0 - 9 * DAY).toISOString(),
              }),
              projectId: 'p',
            },
          ],
        }),
        EMPTY_STATE,
        DAY0,
      )
      expect(picked?.kind).toBe('card-stale-blocked')
    } finally {
      DETECTORS.shift()
      spy.mockRestore()
    }
  })

  it('when EVERY detector throws it fails LOUDLY — never a false “nothing to ask”', () => {
    // A tolerant catch here would turn a broken build into the honest empty
    // state and mark the day, so the loop would go quiet with no error anywhere.
    const saved = DETECTORS.splice(0, DETECTORS.length)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      DETECTORS.push({
        kind: 'card-rework',
        detect: () => {
          throw new Error('boom')
        },
      })
      expect(() => pickCandidate(material(), EMPTY_STATE, DAY0)).toThrow(/all 1 detectors failed/)
    } finally {
      DETECTORS.splice(0, DETECTORS.length, ...saved)
      spy.mockRestore()
    }
  })
})

describe('the loop keeps going — one kind is never spent for good', () => {
  // The regression that mattered most: detectors used to return only their top
  // hit, so once that subject had been asked the whole KIND went silent
  // permanently while the runners-up sat unasked. Ten parked cards produced one
  // question, ever.
  const blocked = (id: string, title: string, ageDays: number) => ({
    task: task({
      id,
      title,
      boardColumn: 'blocked' as const,
      createdAt: new Date(DAY0 - ageDays * DAY).toISOString(),
    }),
    projectId: 'p',
  })

  it('walks through every parked card on consecutive days instead of going quiet', async () => {
    const m = material({
      cards: [blocked('b1', '保留A', 20), blocked('b2', '保留B', 15), blocked('b3', '保留C', 10)],
    })
    const seen: (string | null)[] = []
    for (let day = 0; day < 4; day++) {
      const q = await ensureTodayQuestion({ now: () => DAY0 + day * DAY, gather: gatherOf(m) })
      seen.push(q?.textJa ?? null)
    }
    // Three cards → three distinct questions, THEN the honest silence.
    expect(seen[0]).toContain('保留A')
    expect(seen[1]).toContain('保留B')
    expect(seen[2]).toContain('保留C')
    expect(seen[3]).toBeNull()
  })

  it('a card sent back again is NOT re-asked with the same words', () => {
    // The key is the card, not the card+count: the question reads the same at
    // 1, 2 and 3 send-backs, so re-keying on the count re-asks what was answered.
    const at = (n: number) =>
      pickCandidate(
        material({ cards: [{ task: task({ id: 'c1', title: 'X', reworkCount: n }), projectId: 'p' }] }),
        EMPTY_STATE,
        DAY0,
      )!.subjectKey
    expect(at(1)).toBe(at(3))
  })

  it('does not pair cards from DIFFERENT projects as if they raced', () => {
    // They were never competing for the same turn.
    const m = material({
      cards: [
        {
          task: task({
            id: 'a',
            title: 'Aのカード',
            boardColumn: 'todo',
            createdAt: new Date(DAY0 - 30 * DAY).toISOString(),
          }),
          projectId: 'proj-a',
        },
        {
          task: task({
            id: 'b',
            title: 'Bのカード',
            boardColumn: 'doing',
            createdAt: new Date(DAY0 - 1 * DAY).toISOString(),
          }),
          projectId: 'proj-b',
        },
      ],
    })
    const hits = DETECTORS.find((d) => d.kind === 'todo-passed-over')!.detect(m, DAY0)
    expect(hits).toHaveLength(0)
  })

  it('two projects that SHARE A FOLDER NAME are still different projects', async () => {
    // The test above passes for the wrong reason on its own: its fixture uses
    // two different names, so it never exercised what "different project"
    // means. It meant "different name" — and the registry happily holds
    // ~/work/api and ~/oss/api at once, so a neglected card in one repo got
    // paired with an unrelated card in the other, asking the owner what decided
    // an order that was never contested. Identity is the registry UUID.
    //
    // Driven through the REAL sweep, because that is where identity is assigned
    // — a hand-built fixture can only restate whatever key the test author
    // already believes in.
    const dirs = await Promise.all(
      ['og-persona-work-', 'og-persona-oss-'].map(async (prefix) => {
        const parent = await realpath(await mkdtemp(join(tmpdir(), prefix)))
        const dir = join(parent, 'api') // ← same basename, both of them
        await mkdir(join(dir, '.git'), { recursive: true })
        await registerTestProject(dir)
        return dir
      }),
    )
    await mutateProjectData(dirs[0], (data) => {
      data.tasks.push(
        task({
          id: 'waiting',
          title: '決済の見直し',
          boardColumn: 'todo',
          createdAt: new Date(DAY0 - 10 * DAY).toISOString(),
        }),
      )
    })
    await mutateProjectData(dirs[1], (data) => {
      data.tasks.push(
        task({
          id: 'moved',
          title: 'ロゴ差し替え',
          boardColumn: 'doing',
          createdAt: new Date(DAY0 - 3 * DAY).toISOString(),
        }),
      )
    })

    const swept = await gatherMaterial()
    expect(swept.cards).toHaveLength(2)
    // Same name on disk, two distinct identities in the material.
    expect(new Set(swept.cards.map((c) => c.projectId)).size).toBe(2)

    // The ages would pair these two on sight if they shared a group: 10 days
    // waiting vs a 3-day-old card that moved ahead.
    const hits = DETECTORS.find((d) => d.kind === 'todo-passed-over')!.detect(swept, DAY0)
    expect(hits).toHaveLength(0)
    // Said explicitly, because this is the sentence that would have been frozen
    // into the corpus for good.
    expect(hits.map((h) => h.textJa).join()).not.toContain('ロゴ差し替え')

    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
  })

  it('the neglected card is not re-asked every time some newer card starts', () => {
    const waiting = {
      task: task({
        id: 'old',
        title: '待たされているカード',
        boardColumn: 'todo' as const,
        createdAt: new Date(DAY0 - 30 * DAY).toISOString(),
      }),
      projectId: 'p',
    }
    const started = (id: string, ageDays: number) => ({
      task: task({
        id,
        title: `新カード${id}`,
        boardColumn: 'doing' as const,
        createdAt: new Date(DAY0 - ageDays * DAY).toISOString(),
      }),
      projectId: 'p',
    })
    const detect = DETECTORS.find((d) => d.kind === 'todo-passed-over')!.detect
    const day1 = detect(material({ cards: [waiting, started('1', 3)] }), DAY0)[0]
    const day2 = detect(material({ cards: [waiting, started('1', 3), started('2', 1)] }), DAY0)[0]
    expect(day2.subjectKey).toBe(day1.subjectKey)
  })
})

describe('one a day, across restarts', () => {
  const m = material({
    cards: [{ task: task({ title: 'カードA', reworkCount: 1 }), projectId: 'p' }],
  })

  it('asks once and returns the SAME question for the rest of the day', async () => {
    const first = await ensureTodayQuestion({ now: () => DAY0, gather: gatherOf(m) })
    const second = await ensureTodayQuestion({ now: () => DAY0 + 6 * HOUR, gather: gatherOf(m) })
    expect(first).not.toBeNull()
    expect(second?.id).toBe(first?.id)
  })

  it('the cap SURVIVES A RESTART — the day is remembered on disk, not just in memory', async () => {
    const first = await ensureTodayQuestion({ now: () => DAY0, gather: gatherOf(m) })
    // Simulate a process restart: the globalThis memo dies, the file does not.
    _resetPersonaInterviewForTest()
    const afterRestart = await ensureTodayQuestion({
      now: () => DAY0 + 3 * HOUR,
      gather: gatherOf(m),
    })
    expect(afterRestart?.id).toBe(first?.id)

    const persisted = JSON.parse(await readFile(personaInterviewFile(), 'utf8')) as PersonaInterviewState
    expect(persisted.lastAskedDate).toBe(localDateKey(DAY0))
    expect(persisted.today?.id).toBe(first?.id)
  })

  it('a new local day brings a new question', async () => {
    const day1 = await ensureTodayQuestion({ now: () => DAY0, gather: gatherOf(m) })
    const m2 = material({
      cards: [{ task: task({ title: 'カードB', reworkCount: 3 }), projectId: 'p' }],
    })
    const day2 = await ensureTodayQuestion({ now: () => DAY0 + DAY, gather: gatherOf(m2) })
    expect(day2).not.toBeNull()
    expect(day2?.id).not.toBe(day1?.id)
    expect(day2?.date).toBe(localDateKey(DAY0 + DAY))
  })

  it('a day with no material is MARKED, so an empty sweep is not repeated all day', async () => {
    const gather = vi.fn(async () => material())
    expect(await ensureTodayQuestion({ now: () => DAY0, gather })).toBeNull()
    expect(await ensureTodayQuestion({ now: () => DAY0 + HOUR, gather })).toBeNull()
    expect(gather).toHaveBeenCalledTimes(1)
  })

  it('two concurrent asks generate ONE question, not two', async () => {
    const [a, b] = await Promise.all([
      ensureTodayQuestion({ now: () => DAY0, gather: gatherOf(m) }),
      ensureTodayQuestion({ now: () => DAY0, gather: gatherOf(m) }),
    ])
    expect(a?.id).toBe(b?.id)
    const state = await readInterviewState()
    expect(state.askedSubjects).toHaveLength(1)
  })

  // ── ANOTHER ONE, ON DEMAND ────────────────────────────────────────────────
  //
  // Owner, 2026-08-16: 「新しい質問を出すボタンがあってもいいかも。1日1答にする必要は
  // ない」. The once-a-day rule was never rationing — it exists so opening the tab
  // offers something unasked, and so a barren sweep is not repeated all day.
  // Neither reason survives an explicit press.

  it('gives a SECOND question the same day, once the first is resolved', async () => {
    const first = await ensureTodayQuestion({ now: () => DAY0, gather: gatherOf(m) })
    expect(first).not.toBeNull()
    await skipTodayQuestion(first!.id, { now: () => DAY0 + HOUR })

    const m2 = material({
      cards: [{ task: task({ title: 'カードB', reworkCount: 3 }), projectId: 'p' }],
    })
    const second = await nextQuestion({ now: () => DAY0 + 2 * HOUR, gather: gatherOf(m2) })
    expect(second).not.toBeNull()
    expect(second?.id).not.toBe(first?.id)
    expect(second?.status).toBe('open')
    // It is the live one now — the tab's own read has to find it.
    const { question } = await peekTodayQuestion({ now: () => DAY0 + 2 * HOUR })
    expect(question?.id).toBe(second?.id)
  })

  it('never asks the SAME observation twice, however many times it is pressed', async () => {
    // ⚠ THE BURN HAS TO BE THE ON-DEMAND PATH'S OWN. A first version of this
    // test let the DAILY path burn the subject and then asked nextQuestion to
    // find nothing — true whether or not nextQuestion records anything, and it
    // stayed green with the append deleted. So: press, get a question, resolve
    // it, press again on the SAME material. Only the on-demand write can make
    // the second press come back empty.
    const first = await ensureTodayQuestion({ now: () => DAY0, gather: gatherOf(m) })
    await skipTodayQuestion(first!.id, { now: () => DAY0 + HOUR })

    const m2 = material({
      cards: [{ task: task({ title: 'カードB', reworkCount: 3 }), projectId: 'p' }],
    })
    const second = await nextQuestion({ now: () => DAY0 + 2 * HOUR, gather: gatherOf(m2) })
    expect(second).not.toBeNull()
    await skipTodayQuestion(second!.id, { now: () => DAY0 + 3 * HOUR })

    // Same material as the press that produced `second` — its only candidate is
    // now spent, and it is nextQuestion that had to record that.
    expect(await nextQuestion({ now: () => DAY0 + 4 * HOUR, gather: gatherOf(m2) })).toBeNull()
    const state = await readInterviewState()
    expect(state.askedSubjects).toHaveLength(2)
  })

  it('WILL NOT JUMP THE QUEUE — an open question is returned, not replaced', async () => {
    // ⚠ Replacing it would destroy it: its subject is already burned in
    // askedSubjects, so it could never be asked again. A button that claims to
    // ADD a question must never silently delete one.
    const open = await ensureTodayQuestion({ now: () => DAY0, gather: gatherOf(m) })
    const m2 = material({
      cards: [{ task: task({ title: 'カードB', reworkCount: 3 }), projectId: 'p' }],
    })
    const again = await nextQuestion({ now: () => DAY0 + HOUR, gather: gatherOf(m2) })
    expect(again?.id).toBe(open?.id)
    const state = await readInterviewState()
    expect(state.today?.id).toBe(open?.id)
    expect(state.askedSubjects).toHaveLength(1)
  })

  it('refuses to claim emptiness after a PARTIAL sweep — it throws instead', async () => {
    // Same rule as the daily path: "there is nothing left to ask about your
    // records" may not be said on the strength of records we failed to read.
    const first = await ensureTodayQuestion({ now: () => DAY0, gather: gatherOf(m) })
    await skipTodayQuestion(first!.id, { now: () => DAY0 + HOUR })
    await expect(
      nextQuestion({ now: () => DAY0 + 2 * HOUR, gather: gatherOf(material({ complete: false })) }),
    ).rejects.toThrow(/refusing to claim/)
  })

  it('a fruitless press CHANGES NOTHING — it still sweeps, and destroys no state', async () => {
    // ⚠ MEASURED ON THE STATE, not on the sweep count. A first version counted
    // gather() calls, which stayed green under a mutation that wrote a day
    // sentinel — nextQuestion never reads one, so the count could not see it.
    // What a stray commit here really costs is `today`: nulling it makes the
    // resolved question unfindable, and answer/skip both look it up by id.
    const first = await ensureTodayQuestion({ now: () => DAY0, gather: gatherOf(m) })
    await skipTodayQuestion(first!.id, { now: () => DAY0 + HOUR })
    const before = await readInterviewState()

    const gather = vi.fn(async () => material())
    expect(await nextQuestion({ now: () => DAY0 + 2 * HOUR, gather })).toBeNull()
    expect(await readInterviewState()).toEqual(before)

    // …and it is still willing to look the next time it is pressed.
    expect(await nextQuestion({ now: () => DAY0 + 3 * HOUR, gather })).toBeNull()
    expect(gather).toHaveBeenCalledTimes(2)
  })

  it('an on-demand question stops the automatic path asking a second one', async () => {
    // ⚠ ACROSS MIDNIGHT ON PURPOSE. Within one day `lastAskedDate` is already
    // today, so the assignment in nextQuestion is a no-op and a test staged
    // inside one day cannot see it at all. The real case is the tab left open
    // past midnight (or the button being the day's first action): press, and the
    // next mount's automatic sweep must find the day already answered for —
    // otherwise it generates a second question straight over the one just
    // handed out, destroying it and burning its subject.
    const first = await ensureTodayQuestion({ now: () => DAY0, gather: gatherOf(m) })
    await skipTodayQuestion(first!.id, { now: () => DAY0 + HOUR })

    const m2 = material({
      cards: [{ task: task({ title: 'カードB', reworkCount: 3 }), projectId: 'p' }],
    })
    const asked = await nextQuestion({ now: () => DAY0 + DAY, gather: gatherOf(m2) })
    expect(asked).not.toBeNull()

    const m3 = material({
      cards: [{ task: task({ title: 'カードC', reworkCount: 3 }), projectId: 'p' }],
    })
    const auto = await ensureTodayQuestion({ now: () => DAY0 + DAY + HOUR, gather: gatherOf(m3) })
    expect(auto?.id).toBe(asked?.id)
    const state = await readInterviewState()
    expect(state.askedSubjects).toHaveLength(2)
  })

  it('a state file that cannot be parsed starts fresh instead of wedging the tab', async () => {
    await writeFile(personaInterviewFile(), 'not json at all')
    _resetPersonaInterviewForTest()
    const q = await ensureTodayQuestion({ now: () => DAY0, gather: gatherOf(m) })
    expect(q).not.toBeNull()
  })

  it('peek NEVER generates — the read seam stays a read', async () => {
    const gather = vi.fn(async () => m)
    const before = await peekTodayQuestion({ now: () => DAY0 })
    expect(before.question).toBeNull()
    // ...and it says WHY it is null: nobody has swept today yet. Reporting
    // "nothing to ask about" here would be a claim about records never read.
    expect(before.generated).toBe(false)
    expect(gather).not.toHaveBeenCalled()

    await ensureTodayQuestion({ now: () => DAY0, gather })
    const after = await peekTodayQuestion({ now: () => DAY0 })
    expect(after.generated).toBe(true)
    expect(after.question?.textJa).toContain('カードA')
  })

  it('a swept-but-barren day reads as GENERATED, not as “not looked at yet”', async () => {
    await ensureTodayQuestion({ now: () => DAY0, gather: gatherOf(material()) })
    const peeked = await peekTodayQuestion({ now: () => DAY0 })
    expect(peeked.question).toBeNull()
    expect(peeked.generated).toBe(true)
  })
})

describe('the same observation is never asked about twice', () => {
  it('skips a subject already asked, even after the question was answered', async () => {
    const m = material({
      cards: [{ task: task({ id: 'card-1', title: '同じカード', reworkCount: 1 }), projectId: 'p' }],
    })
    const first = await ensureTodayQuestion({ now: () => DAY0, gather: gatherOf(m) })
    expect(first).not.toBeNull()
    // Next day, the board is unchanged — the same fact is still true, but it has
    // already been asked about.
    const second = await ensureTodayQuestion({ now: () => DAY0 + DAY, gather: gatherOf(m) })
    expect(second).toBeNull()
  })

  it('a SKIPPED question does not come back either', async () => {
    const m = material({
      cards: [{ task: task({ id: 'card-1', title: '飛ばすカード', reworkCount: 1 }), projectId: 'p' }],
    })
    const q = await ensureTodayQuestion({ now: () => DAY0, gather: gatherOf(m) })
    await skipTodayQuestion(q!.id, { now: () => DAY0 })
    expect(await ensureTodayQuestion({ now: () => DAY0 + DAY, gather: gatherOf(m) })).toBeNull()
  })

  it('skipping does NOT unlock a second question the same day', async () => {
    const m = material({
      cards: [
        { task: task({ id: 'a', title: 'A', reworkCount: 1 }), projectId: 'p' },
        {
          task: task({
            id: 'b',
            title: 'B',
            boardColumn: 'blocked',
            createdAt: new Date(DAY0 - 9 * DAY).toISOString(),
          }),
          projectId: 'p',
        },
      ],
    })
    const q = await ensureTodayQuestion({ now: () => DAY0, gather: gatherOf(m) })
    const skipped = await skipTodayQuestion(q!.id, { now: () => DAY0 })
    expect(skipped.status).toBe('skipped')
    const again = await ensureTodayQuestion({ now: () => DAY0 + HOUR, gather: gatherOf(m) })
    expect(again?.id).toBe(q!.id)
    expect(again?.status).toBe('skipped')
  })

  it('rotates KIND — ten parked cards do not mean ten days of the same question', async () => {
    const m = material({
      cards: [
        { task: task({ id: 'r', title: 'やり直しカード', reworkCount: 1 }), projectId: 'p' },
        {
          task: task({
            id: 'b1',
            title: '保留カード1',
            boardColumn: 'blocked',
            createdAt: new Date(DAY0 - 8 * DAY).toISOString(),
          }),
          projectId: 'p',
        },
        {
          task: task({
            id: 'b2',
            title: '保留カード2',
            boardColumn: 'blocked',
            createdAt: new Date(DAY0 - 7 * DAY).toISOString(),
          }),
          projectId: 'p',
        },
      ],
    })
    const day1 = await ensureTodayQuestion({ now: () => DAY0, gather: gatherOf(m) })
    const day2 = await ensureTodayQuestion({ now: () => DAY0 + DAY, gather: gatherOf(m) })
    expect(day1?.kind).toBe('card-rework')
    // Not another card-rework, and not the same card twice.
    expect(day2?.kind).toBe('card-stale-blocked')
  })
})

describe('answering feeds the corpus', () => {
  const m = material({
    cards: [{ task: task({ title: '価格の見直し', reworkCount: 1 }), projectId: 'p' }],
  })

  it('writes Q + the owner’s answer + a date into the corpus, in the same voice as an escalation', async () => {
    const appendMemory = vi.fn(async (_input: AppendJudgmentInput) => ({
      judgment: {} as never,
      meta: {} as never,
    }))
    const q = await ensureTodayQuestion({ now: () => DAY0, gather: gatherOf(m) })
    const answered = await answerTodayQuestion(q!.id, '  可逆だから即決した  ', {
      now: () => DAY0,
      appendMemory,
    })

    expect(answered.question.status).toBe('answered')
    expect(answered.question.resolvedAt).toBeTruthy()
    expect(answered.corpusStale).toBe(false)
    const arg = appendMemory.mock.calls[0][0]
    // THE SETTING GOES IN TOO (2026-08-15). The question quotes a fragment of
    // something that happened; stored without the sentence that places it, the
    // corpus keeps a permanently unreadable Q — the exact defect the owner hit
    // on screen, only durable. The stand-in reads this corpus to judge for
    // them, so an unreadable entry is worse here than it was in the corner.
    expect(arg.text).toBe(`Q: ${q!.contextJa} ${q!.textJa}\n→ オーナーの回答: 可逆だから即決した`)
    expect(arg.text).toContain('差し戻した') // …and the setting is really in it
    expect(arg.tags).toEqual(['interview', 'card-rework'])
    expect(arg.context).toContain('今日の1問')

    // ⚠ THE CROSS-CHECK FOR 「言ったこと / やったこと」. That screen splits this
    // exact string back into two columns using two code-matched markers
    // (src/lib/persona/saidDid.ts). Pinning the bytes above is not enough: the
    // parser is a SECOND copy of them, and the only thing that catches a drift
    // in either direction is running the real writer through the real parser.
    const pair = splitSaidDid({
      id: 'x',
      text: arg.text,
      tags: arg.tags,
      addedAt: '2026-08-01T00:00:00.000Z',
    })
    expect(pair?.said).toBe('可逆だから即決した')
    expect(pair?.did).toBe(`${q!.contextJa} ${q!.textJa}`)
  })

  it('EVERY question carries a setting, in both languages — none arrives as a bare quote', async () => {
    // The complaint that produced this (owner, 2026-08-15): a question read as
    // 「『Contents interrupted. どうしますか?』に『何が使えなかった?』と答えました」
    // — two quotes with no world around them. A detector added later must not
    // be able to reintroduce that, so this walks the REGISTERED list rather
    // than the questions this file happens to know about.
    const q = await ensureTodayQuestion({ now: () => DAY0, gather: gatherOf(m) })
    expect(q!.contextJa && q!.contextJa.length).toBeGreaterThan(8)
    expect(q!.contextEn && q!.contextEn.length).toBeGreaterThan(8)
    // A setting is a sentence about a situation, not a restatement of the ask.
    expect(q!.contextJa).not.toContain('?')
    expect(q!.contextEn).not.toContain('?')
  })

  it('an empty answer is refused — nothing reaches the corpus', async () => {
    const appendMemory = vi.fn(async (_input: AppendJudgmentInput) => ({
      judgment: {} as never,
      meta: {} as never,
    }))
    const q = await ensureTodayQuestion({ now: () => DAY0, gather: gatherOf(m) })
    await expect(answerTodayQuestion(q!.id, '   ', { appendMemory })).rejects.toThrow()
    expect(appendMemory).not.toHaveBeenCalled()
  })

  it('a corpus failure keeps the question OPEN instead of eating the answer', async () => {
    const appendMemory = vi.fn(async () => {
      throw new Error('disk full')
    })
    const q = await ensureTodayQuestion({ now: () => DAY0, gather: gatherOf(m) })
    await expect(
      answerTodayQuestion(q!.id, 'これは失われてはいけない', { appendMemory }),
    ).rejects.toThrow('disk full')
    // Still answerable — the UI can retry with the words still on screen.
    expect((await peekTodayQuestion({ now: () => DAY0 })).question?.status).toBe('open')
  })

  it('reports corpusStale when the judgment saved but the corpus was NOT rebuilt', async () => {
    // appendJudgment does NOT throw for this — it returns meta.skipped. Dropping
    // that signal makes the tab say "your stand-in has this now" over a corpus
    // that never got the answer.
    const appendMemory = vi.fn(async (_input: AppendJudgmentInput) => ({
      judgment: {} as never,
      meta: { skipped: true, warning: 'no mechanical sources' } as never,
    }))
    const q = await ensureTodayQuestion({ now: () => DAY0, gather: gatherOf(m) })
    const answered = await answerTodayQuestion(q!.id, '答え', { now: () => DAY0, appendMemory })
    expect(answered.question.status).toBe('answered')
    expect(answered.corpusStale).toBe(true)
  })

  it('answering twice does not write the decision to the corpus twice', async () => {
    const appendMemory = vi.fn(async (_input: AppendJudgmentInput) => ({
      judgment: {} as never,
      meta: {} as never,
    }))
    const q = await ensureTodayQuestion({ now: () => DAY0, gather: gatherOf(m) })
    await answerTodayQuestion(q!.id, '一度目', { now: () => DAY0, appendMemory })
    const again = await answerTodayQuestion(q!.id, '二度目', { now: () => DAY0, appendMemory })
    expect(appendMemory).toHaveBeenCalledTimes(1)
    expect(again.question.status).toBe('answered')
  })

  it('CONCURRENT answers write the decision to the corpus exactly once', async () => {
    // The status check and the corpus write straddle an await, so without the
    // state lock two overlapping answers both saw 'open' and both wrote —
    // recording two different answers to one question as unrelated judgments.
    // Two windows on one machine (the app and a browser on :5174) is supported.
    const appendMemory = vi.fn(async (_input: AppendJudgmentInput) => {
      await new Promise((r) => setTimeout(r, 20))
      return { judgment: {} as never, meta: {} as never }
    })
    const q = await ensureTodayQuestion({ now: () => DAY0, gather: gatherOf(m) })
    await Promise.all([
      answerTodayQuestion(q!.id, '一度目', { now: () => DAY0, appendMemory }),
      answerTodayQuestion(q!.id, '二度目', { now: () => DAY0, appendMemory }),
    ])
    expect(appendMemory).toHaveBeenCalledTimes(1)
  })

  it('a day that rolls over mid-answer does not erase the new day’s question', async () => {
    // The answer path used to commit a state snapshot taken BEFORE the corpus
    // write. A generation landing in that window was undone: lastAskedDate rolled
    // backwards, the new question vanished, and its subject was un-burned — so an
    // observation the owner was promised would not return, returned.
    let releaseAppend: () => void = () => {}
    const appendMemory = vi.fn(async (_input: AppendJudgmentInput) => {
      await new Promise<void>((r) => {
        releaseAppend = r
      })
      return { judgment: {} as never, meta: {} as never }
    })
    const day1 = await ensureTodayQuestion({ now: () => DAY0, gather: gatherOf(m) })

    const answering = answerTodayQuestion(day1!.id, '答え', { now: () => DAY0, appendMemory })
    await new Promise((r) => setTimeout(r, 0))

    // Day 2 arrives while the append is still in flight.
    const day2Material = material({
      cards: [{ task: task({ id: 'other', title: '別のカード', reworkCount: 1 }), projectId: 'p' }],
    })
    const day2Pending = ensureTodayQuestion({
      now: () => DAY0 + DAY,
      gather: gatherOf(day2Material),
    })
    releaseAppend()
    await answering
    const day2 = await day2Pending

    expect(day2).not.toBeNull()
    const peeked = await peekTodayQuestion({ now: () => DAY0 + DAY })
    expect(peeked.question?.id).toBe(day2!.id)
    const state = await readInterviewState()
    expect(state.lastAskedDate).toBe(localDateKey(DAY0 + DAY))
    expect(state.askedSubjects).toContain(day2!.subjectKey)
  })

  it('an unknown id is refused rather than answering whatever is current', async () => {
    await ensureTodayQuestion({ now: () => DAY0, gather: gatherOf(m) })
    await expect(answerTodayQuestion('not-the-id', 'x')).rejects.toThrow('question not found')
  })
})

describe('privacy + the material sweep', () => {
  it('writes the state file owner-only (0600) — it quotes the owner’s own board', async () => {
    await ensureTodayQuestion({
      now: () => DAY0,
      gather: gatherOf(
        material({ cards: [{ task: task({ title: 'x', reworkCount: 1 }), projectId: 'p' }] }),
      ),
    })
    const { stat } = await import('fs/promises')
    const mode = (await stat(personaInterviewFile())).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('sweeps every registered project’s board and the escalation inbox', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'og-persona-proj-')))
    await mkdir(join(dir, '.git'), { recursive: true })
    await registerTestProject(dir)
    await mutateProjectData(dir, (data) => {
      data.tasks.push(task({ title: '実プロジェクトのカード', reworkCount: 1 }))
    })

    const swept = await gatherMaterial()
    expect(swept.cards.map((c) => c.task.title)).toContain('実プロジェクトのカード')
    await rm(dir, { recursive: true, force: true })
  })

  it('one unreadable project does not silence the whole loop', async () => {
    await registerTestProject(await realpath(await mkdtemp(join(tmpdir(), 'og-persona-gone-'))))
    // The dir is registered but its data never written — the sweep must still
    // return, with the other sources intact.
    await expect(gatherMaterial()).resolves.toBeTruthy()
  })
})

describe('“nothing to ask about today” is a CLAIM — it needs a complete read', () => {
  // The tab renders an empty day as「今は新しく聞くことがないので、無理に作っていません」.
  // That sentence is about the OWNER'S RECORDS, so it may only be said after
  // actually reading them. A sweep that failed and an owner with a quiet week
  // produce the same empty material — and the difference is the whole point.

  const carded = (over: Partial<InterviewMaterial> = {}) =>
    material({
      cards: [{ task: task({ title: '読めたカード', reworkCount: 1 }), projectId: 'p' }],
      ...over,
    })

  it('refuses to claim emptiness — and does NOT burn the day — after a partial sweep', async () => {
    const gather = vi.fn(async () => material({ complete: false }))

    await expect(ensureTodayQuestion({ now: () => DAY0, gather })).rejects.toThrow(
      /could not be read/,
    )

    // The day is UNMARKED. Marking it would have been the real damage: the
    // false claim would then stand until tomorrow with no retry.
    expect((await readInterviewState()).lastAskedDate).toBe('')
    // ...which the route reads as 'not-generated' (hide the section), never as
    // 'no-material' (assert emptiness).
    expect((await peekTodayQuestion({ now: () => DAY0 })).generated).toBe(false)

    // And the next visit really does sweep again rather than waiting a day.
    await expect(ensureTodayQuestion({ now: () => DAY0 + HOUR, gather })).rejects.toThrow()
    expect(gather).toHaveBeenCalledTimes(2)
  })

  it('still asks when the sweep was partial but found something real', async () => {
    // Only the EMPTY answer needs a complete read. A question quoting a card
    // that was genuinely read is honest even though another project was not —
    // and refusing to ask it would make one broken project silence the loop,
    // which is exactly what the per-project tolerance exists to prevent.
    const q = await ensureTodayQuestion({
      now: () => DAY0,
      gather: gatherOf(carded({ complete: false })),
    })
    expect(q?.textJa).toContain('読めたカード')
    expect((await readInterviewState()).lastAskedDate).toBe(localDateKey(DAY0))
  })

  it('a COMPLETE sweep that finds nothing still marks the day (no regression)', async () => {
    const gather = vi.fn(async () => material())
    expect(await ensureTodayQuestion({ now: () => DAY0, gather })).toBeNull()
    expect((await readInterviewState()).lastAskedDate).toBe(localDateKey(DAY0))
    expect(gather).toHaveBeenCalledTimes(1)
  })

  it('a project entry the registry cannot resolve marks the real sweep incomplete', async () => {
    // NO MOCKS — a real fault through the real sweep. A hand-corrupted
    // settings.json (an entry with no UUID) is one the cockpit tolerates
    // elsewhere, and readProjectData throws loud on it: exactly the shape that
    // used to be swallowed into "nothing to ask about today".
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'og-persona-broken-')))
    await mkdir(join(dir, '.git'), { recursive: true })
    await writeFile(
      join(home, 'settings.json'),
      JSON.stringify({ projects: [{ path: dir, addedAt: new Date(DAY0).toISOString() }] }),
    )

    const swept = await gatherMaterial()
    expect(swept.complete).toBe(false)
    await rm(dir, { recursive: true, force: true })
  })
})

describe('helpers', () => {
  it('localDateKey is LOCAL, so the day does not roll mid-evening in JST', () => {
    expect(localDateKey(new Date(2026, 6, 19, 23, 30).getTime())).toBe('2026-07-19')
    expect(localDateKey(new Date(2026, 6, 20, 0, 30).getTime())).toBe('2026-07-20')
  })

  it('snip flattens and caps a long title so a question stays one sentence', () => {
    expect(snip('短い')).toBe('短い')
    expect(snip('a\n  b')).toBe('a b')
    expect(snip('x'.repeat(100))).toHaveLength(61) // 60 + the ellipsis
  })
})

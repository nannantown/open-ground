// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import {
  PersonaConversation,
  PROMPT_KEYS,
  nextPromptIndex,
  type PersonaConversationProps,
  type PersonaImportView,
} from './PersonaConversation'
import { messages } from '@/i18n/messages'
import type {
  ManualJudgment,
  PersonaChatTurn,
  PersonaImportResult,
  PersonaKeptWrite,
  PersonaQuestion,
} from '@/lib/types'

// THE CONVERSATION — the way into the corpus (owner, 2026-08-15: 「対話していけば
// 勝手にペルソナに入る」). What this file exists to pin is the second half of that
// sentence, which the mock's own comment spells out: 「勝手に入る」 means there is
// no approval step, NOT that anything is written behind your back.
//
// So the load-bearing tests here are the ones about VISIBILITY and LOSS:
//   • every kept line is on screen, under the message it came from, pressable;
//   • a turn that kept nothing says so;
//   • a failed send never costs the owner what they typed;
//   • the IME's Enter is never stolen;
//   • an unread thread is never drawn as an empty one;
//   • the privacy note says the true thing about where the conversation goes.
//
// `useT` is stubbed to echo keys, so assertions pin WHICH string a surface uses
// rather than its wording — except the privacy copy, which is pinned against
// the real dictionary because there the wording IS the contract.

vi.mock('@/i18n/I18nContext', () => ({
  useT: () => ({
    lang: 'en',
    t: (k: string, v?: Record<string, unknown>) => (v ? `${k}:${JSON.stringify(v)}` : k),
  }),
}))

const judgment = (over: Partial<ManualJudgment> = {}): ManualJudgment => ({
  id: 'j-1',
  text: '決めたあとに手が止まる',
  addedAt: '2026-08-15T04:00:00.000Z',
  context: 'This conversation ・ Aug 15',
  tags: ['chat', 'region:legs'],
  ...over,
})

const kept = (over: Partial<PersonaKeptWrite> = {}): PersonaKeptWrite => ({
  judgment: judgment(),
  region: 'legs',
  ...over,
})

const turn = (over: Partial<PersonaChatTurn> = {}): PersonaChatTurn => ({
  id: 't-1',
  askedAt: '2026-08-15T04:00:00.000Z',
  text: '仕事で手が止まる',
  state: 'done',
  reply: 'どのあたりが重いですか。',
  kept: [kept()],
  ...over,
})

const question = (over: Partial<PersonaQuestion> = {}): PersonaQuestion => ({
  id: 'q-1',
  date: '2026-08-15',
  kind: 'card-rework',
  subjectKey: 'card-rework:card-1:2',
  contextJa: 'Board のカードの話です。',
  contextEn: 'About a card on your board.',
  textJa: '何が足りませんでしたか?',
  textEn: 'What kept being missing?',
  createdAt: '2026-08-15T03:00:00.000Z',
  status: 'open',
  ...over,
})

const importResult = (over: Partial<PersonaImportResult> = {}): PersonaImportResult => ({
  conversations: 1284,
  ownerMessages: 900,
  unreadable: 8,
  droppedNonOwner: 900,
  considered: 400,
  notConsidered: 500,
  kept: [kept()],
  duplicatesSkipped: 0,
  keptUnreadable: 0,
  ...over,
})

let sent: string[]
let cancelled: string[]
let corrected: ManualJudgment[]
let dropped: File[]
let skipped: number
let retriedThread: number

const props = (over: Partial<PersonaConversationProps> = {}): PersonaConversationProps => ({
  turns: [],
  threadRead: true,
  onRetryThread: () => {
    retriedThread += 1
  },
  elapsedMs: 0,
  onCancel: (turnId) => {
    cancelled.push(turnId)
  },
  busy: false,
  errorKey: null,
  onSend: (t) => {
    sent.push(t)
  },
  onCorrect: (j) => {
    corrected.push(j)
  },
  question: null,
  answering: false,
  answerStale: false,
  skipFailed: false,
  onSkipQuestion: () => {
    skipped += 1
  },
  lang: 'en',
  onDropExport: (f) => {
    dropped.push(f)
  },
  importJob: null,
  ...over,
})

const draw = (over: Partial<PersonaConversationProps> = {}) =>
  render(<PersonaConversation {...props(over)} />)

const input = () => screen.getByLabelText('persona.chat.inputLabel') as HTMLInputElement

const type = (text: string) => fireEvent.change(input(), { target: { value: text } })

beforeEach(() => {
  sent = []
  cancelled = []
  corrected = []
  dropped = []
  skipped = 0
  retriedThread = 0
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('PersonaConversation — nothing is written invisibly', () => {
  // MUTATION GUARD (R4 #3). Dropping the chip while keeping the server write is
  // a one-line change that leaves the screen looking fine and the corpus
  // growing where the owner cannot see it — the exact thing 「勝手に入る」 must
  // not be allowed to mean.
  it('prints every kept line under the message it came from, and it is pressable', () => {
    draw({ turns: [turn()] })

    const chip = screen.getByRole('button', { name: /決めたあとに手が止まる/ })
    // …and it says where it came from and what pressing does.
    expect(chip.textContent).toContain('persona.chat.keptLead')
    expect(chip.textContent).toContain('This conversation ・ Aug 15')
    expect(chip.textContent).toContain('persona.correct.pressToFix')

    fireEvent.click(chip)
    // The FULL stored judgment rides back, so the correction composer opens on
    // the exact row that was written — no round-trip, no id lookup.
    expect(corrected).toHaveLength(1)
    expect(corrected[0].id).toBe('j-1')
    expect(corrected[0].text).toBe('決めたあとに手が止まる')
  })

  it('says so when a turn kept nothing — an absent chip never means a hidden write', () => {
    draw({ turns: [turn({ kept: [] })] })
    expect(screen.getByText('persona.chat.keptNone')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /persona\.chat\.keptLead/ })).toBeNull()
  })

  it('does NOT claim "nothing kept" over a turn that is still running', () => {
    draw({ turns: [turn({ state: 'running', reply: undefined, kept: undefined })] })
    expect(screen.queryByText('persona.chat.keptNone')).toBeNull()
  })

  it('counts the lines it could not read rather than swallowing them', () => {
    draw({ turns: [turn({ kept: [], keptUnreadable: 2 })] })
    expect(screen.getByText('persona.chat.keptUnreadable:{"count":2}')).toBeTruthy()
  })

  it('says a kept line is saved-but-not-rebuilt, right under that line', () => {
    draw({ turns: [turn({ kept: [kept({ corpusStale: true })] })] })
    expect(screen.getByText('persona.chat.keptStale')).toBeTruthy()
  })

  // ONLY THE OWNER'S WORDS ARE LEARNED. Server-side that is structural
  // (personaChat.ts's writer never sees the reply); here it is visible — the
  // reply is a bubble, never a chip.
  it('never offers the stand-in’s own reply as something that was kept', () => {
    draw({ turns: [turn({ reply: 'REPLY_TEXT', kept: [kept()] })] })
    expect(screen.getByText('REPLY_TEXT')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /REPLY_TEXT/ })).toBeNull()
  })
})

describe('PersonaConversation — a failed turn keeps the owner’s words', () => {
  // MUTATION GUARD (R4 #5). The input clears itself on send, so the words have
  // to exist in the TURN before that happens — a React value reset is not
  // undoable, and losing typed words is the one thing this surface must never
  // do.
  it('leaves the words on screen with a retry that re-sends exactly them', () => {
    draw({ turns: [turn({ state: 'failed', reply: undefined, kept: undefined })] })

    expect(screen.getByText('仕事で手が止まる')).toBeTruthy()
    expect(screen.getByText('persona.chat.turnFailed')).toBeTruthy()

    fireEvent.click(screen.getByText('persona.chat.retry'))
    expect(sent).toEqual(['仕事で手が止まる'])
  })

  it('states the real wait instead of animating a fake one', () => {
    const { rerender } = draw({
      turns: [turn({ state: 'running', reply: undefined, kept: undefined })],
      elapsedMs: 0,
    })
    // Nothing to count yet — and an answer to the day's question never counts
    // at all, because it is a plain save rather than a `claude` run.
    expect(screen.getByText('persona.chat.sending')).toBeTruthy()

    rerender(
      <PersonaConversation
        {...props({
          turns: [turn({ state: 'running', reply: undefined, kept: undefined })],
          elapsedMs: 42_000,
        })}
      />,
    )
    expect(screen.getByText('persona.chat.thinking:{"seconds":42}')).toBeTruthy()
  })

  it('shows a reason the bubble cannot show on its own', () => {
    draw({ errorKey: 'persona.chat.claudeLoggedOut' })
    expect(screen.getByText('persona.chat.claudeLoggedOut')).toBeTruthy()
  })
})

describe('PersonaConversation — sending', () => {
  it('sends on Enter and clears the box', () => {
    draw()
    type('転職しようか迷ってる')
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(sent).toEqual(['転職しようか迷ってる'])
    expect(input().value).toBe('')
  })

  // MUTATION GUARD (R4 #4). In Japanese, Enter CONFIRMS a conversion. Sending on
  // it posts half a sentence the owner was still writing.
  it('never sends on the Enter that confirms an IME conversion', () => {
    draw()
    type('てんしょ')
    fireEvent.keyDown(input(), { key: 'Enter', isComposing: true })
    expect(sent).toEqual([])
    expect(input().value).toBe('てんしょ')
  })

  it('refuses an empty or whitespace-only message', () => {
    draw()
    type('   ')
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(sent).toEqual([])
  })

  it('will not send while a turn is already in flight', () => {
    draw({ busy: true })
    type('二通目')
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(sent).toEqual([])
    // …and the words are NOT thrown away by the refusal.
    expect(input().value).toBe('二通目')
  })

  it('the send button is a real control, not just a glyph', () => {
    draw()
    type('押して送る')
    fireEvent.click(screen.getByRole('button', { name: 'persona.chat.send' }))
    expect(sent).toEqual(['押して送る'])
  })
})

describe('PersonaConversation — the rotating invitation', () => {
  it('offers one of the eighteen examples in the placeholder', () => {
    draw()
    const ph = input().placeholder
    expect(ph.startsWith('persona.chat.placeholder:')).toBe(true)
    const used = PROMPT_KEYS.filter((k) => ph.includes(k))
    expect(used).toHaveLength(1)
  })

  // It WANDERS rather than cycling: a fixed +1 walk turns the list into a
  // carousel whose order the reader learns. And it never stands still — a
  // "rotation" that returns the index it was given is a rotation nobody sees.
  it('never returns the index it was given, and stays in range', () => {
    for (let i = 0; i < PROMPT_KEYS.length; i++) {
      for (const r of [0, 0.34, 0.67, 0.999]) {
        const next = nextPromptIndex(i, r)
        expect(next).not.toBe(i)
        expect(next).toBeGreaterThanOrEqual(0)
        expect(next).toBeLessThan(PROMPT_KEYS.length)
      }
    }
  })

  it('reaches more than one step ahead — otherwise it is a carousel', () => {
    const steps = new Set([0, 0.34, 0.67].map((r) => (nextPromptIndex(0, r) + 18 - 0) % 18))
    expect(steps.size).toBeGreaterThan(1)
  })

  it('has eighteen examples, and every one of them is real copy', () => {
    expect(PROMPT_KEYS).toHaveLength(18)
    for (const key of PROMPT_KEYS) {
      expect(messages.ja[key], key).toBeTruthy()
      expect(messages.en[key], key).toBeTruthy()
    }
  })
})

describe('PersonaConversation — the thread it was handed', () => {
  // A FAILED READ IS NOT AN EMPTY CONVERSATION. "You have said nothing" is the
  // one claim a read that failed is in no position to make.
  it('says the thread could not be read, and offers to read it again', () => {
    draw({ threadRead: false })
    expect(screen.getByText('persona.chat.stateUnreadable')).toBeTruthy()
    fireEvent.click(screen.getByText('persona.retry'))
    expect(retriedThread).toBe(1)
  })

  it('draws no thread at all when there is genuinely nothing in it', () => {
    draw()
    expect(screen.queryByText('persona.chat.stateUnreadable')).toBeNull()
    // The rotating placeholder carries the whole invitation.
    expect(input().placeholder).toContain('persona.chat.placeholder')
  })

  it('swaps the hint once there is something to correct', () => {
    const { rerender } = draw()
    expect(screen.getByText('persona.chat.hint')).toBeTruthy()

    rerender(<PersonaConversation {...props({ turns: [turn()] })} />)
    expect(screen.getByText('persona.chat.hintCorrect')).toBeTruthy()
    expect(screen.queryByText('persona.chat.hint')).toBeNull()
  })
})

describe('PersonaConversation — the day’s question, as the opening turn', () => {
  it('asks it in the thread, with a way past it', () => {
    draw({ question: question() })
    expect(screen.getByText('persona.interview.heading')).toBeTruthy()
    expect(screen.getByText('What kept being missing?')).toBeTruthy()
    // The SETTING is above the question — the quotes never arrive naked.
    expect(screen.getByText('About a card on your board.')).toBeTruthy()

    fireEvent.click(screen.getByText('persona.interview.skip'))
    expect(skipped).toBe(1)
  })

  it('an answered question says so — and hedges when the corpus was not rebuilt', () => {
    const { rerender } = draw({ question: question({ status: 'answered' }) })
    expect(screen.getByText('persona.interview.answered')).toBeTruthy()
    expect(screen.queryByText('persona.interview.skip')).toBeNull()

    rerender(
      <PersonaConversation
        {...props({ question: question({ status: 'answered' }), answerStale: true })}
      />,
    )
    expect(screen.getByText('persona.interview.answeredStale')).toBeTruthy()
    expect(screen.queryByText('persona.interview.answered')).toBeNull()
  })

  it('a failed SKIP never borrows the answer path’s reassurance', () => {
    draw({ question: question(), skipFailed: true })
    expect(screen.getByText('persona.interview.skipFailed')).toBeTruthy()
    // There were no words on the skip path, so nothing promises they are safe.
    expect(screen.queryByText('persona.chat.turnFailed')).toBeNull()
  })
})

describe('PersonaConversation — dropping a claude.ai export', () => {
  const file = (name = 'conversations.json') =>
    new File(['[]'], name, { type: 'application/json' })

  it('takes a file on the same slot talking uses, and says so while it hovers', () => {
    draw()
    const box = input()
    fireEvent.dragOver(box, { dataTransfer: { files: [] } })
    expect(input().placeholder).toBe('persona.import.dropHint')

    const f = file()
    fireEvent.drop(box, { dataTransfer: { files: [f] } })
    expect(dropped).toEqual([f])
    // …and the hint goes back to the invitation.
    expect(input().placeholder).toContain('persona.chat.placeholder')
  })

  // EVERY FIELD, INCLUDING THE ZEROS. A number that hides its own losses is the
  // failure this app keeps hitting, so `notConsidered` and `duplicatesSkipped`
  // are rendered even when they are 0.
  it('reports what was read, what was dropped and what was NOT looked at', () => {
    const job: PersonaImportView = {
      fileName: 'conversations.json',
      state: 'done',
      counts: importResult(),
      result: importResult(),
    }
    draw({ importJob: job })

    expect(screen.getByText('persona.import.parsed:{"conversations":1284}')).toBeTruthy()
    expect(screen.getByText('persona.import.ownerOnly')).toBeTruthy()
    expect(screen.getByText('persona.import.dropped:{"count":900}')).toBeTruthy()
    expect(screen.getByText('persona.import.unreadableRows:{"count":8}')).toBeTruthy()
    expect(screen.getByText('persona.import.considered:{"count":400}')).toBeTruthy()
    expect(screen.getByText('persona.import.notConsidered:{"count":500}')).toBeTruthy()
    expect(screen.getByText('persona.import.duplicates:{"count":0}')).toBeTruthy()
    expect(screen.getByText('persona.import.keptUnreadable:{"count":0}')).toBeTruthy()
    expect(screen.getByText('persona.import.keptCount:{"count":1}')).toBeTruthy()
    // …and every kept line is pressable, exactly like a turn's.
    expect(screen.getByRole('button', { name: /決めたあとに手が止まる/ })).toBeTruthy()
  })

  it('shows the counts as soon as PARSING landed, before the reading finishes', () => {
    draw({
      importJob: {
        fileName: 'conversations.json',
        state: 'running',
        counts: importResult(),
      },
    })
    expect(screen.getByText('persona.import.parsed:{"conversations":1284}')).toBeTruthy()
    expect(screen.queryByText(/persona\.import\.keptCount/)).toBeNull()
  })

  // A PARTIAL COUNT OVER AN UNPARSED FILE is the exact failure mode, so a
  // failure prints its own sentence and no numbers at all.
  it('a file it could not read reports NO counts', () => {
    draw({
      importJob: {
        fileName: 'notes.zip',
        state: 'failed',
        errorKey: 'persona.import.zipUnsupported',
        counts: importResult(),
      },
    })
    expect(screen.getByText('persona.import.zipUnsupported')).toBeTruthy()
    expect(screen.queryByText(/persona\.import\.parsed/)).toBeNull()
    expect(screen.queryByText(/persona\.import\.considered/)).toBeNull()
  })

  it('names the day an already-imported file arrived', () => {
    draw({
      importJob: {
        fileName: 'conversations.json',
        state: 'failed',
        errorKey: 'persona.import.already',
        errorVars: { date: 'Aug 12' },
      },
    })
    expect(screen.getByText('persona.import.already:{"date":"Aug 12"}')).toBeTruthy()
  })
})

// ─── WHERE THIS GOES ────────────────────────────────────────────────────────
//
// MUTATION GUARD (R4 #6). Softening the middle claim is a one-word edit that no
// reviewer necessarily catches and every reader relies on: the files are local,
// the CONVERSATION is not, and the training switch is not ours to flip. A
// privacy lie has to be a red test, not a review finding — the same technique
// that pins PERSONA_RESULT_CAVEAT to instruments.ts.
describe('the privacy note says the true thing', () => {
  // ⚠ THE PIN MOVED ONCE, 2026-08-15, and only ever moves in this direction.
  // The first approved wording was reassuring AND FALSE in three places: it
  // said the app writes only to ~/.openground/ (a conversation also records a
  // trusted folder in ~/.claude.json), it promised only "as much as needed" of
  // the corpus is sent (nothing enforces that — the run is handed a path and
  // decides), and it said nothing about the import shipping up to 400 past
  // messages. Re-pinned to the corrected text. A future edit that makes any of
  // these SOFTER is the failure this guard exists to catch.
  const APPROVED_JA: Record<string, string> = {
    'persona.privacy.summary': 'これがどこへ行くか',
    'persona.privacy.local':
      '溜めたものは、このパソコンの ~/.openground/ に、あなただけが読める形で置かれます。どこにもアップロードしません(このアプリ自身のサーバはありません)。なお、会話をすると作業用のフォルダも同じ場所にでき、そのフォルダを「信頼済み」として ~/.claude.json に記録します — claude コマンドの仕組み上そうなります。',
    'persona.privacy.conversation':
      '分身と話すと、そのやりとりは「あなた自身の」 Claude アカウントを通って Anthropic に送られます。普通に Claude と話すのと同じです。溜めたものは「置いてある場所」を渡していて、どこまで読むかは向こうが決めます — つまり送られる量は、このアプリが縛っているわけではありません。',
    'persona.privacy.import':
      '書き出しファイルを落とすと、その中のあなた自身の過去の発言も Anthropic に送られます(一度に最大400件)。それを材料にして「分かったこと」を作るので、取り込みとはそういうものです。1年ぶんを落とす前に知っておいてください。',
    'persona.privacy.training':
      '学習に使わせないかどうかは、claude.ai 側の設定で決まります。このアプリからは変えられません（できると書くのは嘘になります）。claude.ai → 設定 → プライバシー で切り替えてください。',
  }

  it('is the approved Japanese wording, word for word', () => {
    for (const [key, value] of Object.entries(APPROVED_JA)) {
      expect(messages.ja[key], key).toBe(value)
    }
  })

  it('the English says the same four things — including the three uncomfortable ones', () => {
    const conversation = String(messages.en['persona.privacy.conversation'])
    // The conversation LEAVES this machine, through the owner's own account.
    expect(conversation).toMatch(/Anthropic/)
    expect(conversation).toMatch(/your own Claude account/i)

    const training = String(messages.en['persona.privacy.training'])
    // …and the training switch is somebody else's.
    expect(training).toMatch(/claude\.ai/)
    expect(training).toMatch(/cannot be changed from this app/i)

    // The local claim is about the FILES, and only about the files — and it
    // owns up to the second file this app causes to be written.
    const local = String(messages.en['persona.privacy.local'])
    expect(local).toMatch(/~\/\.openground\//)
    expect(local).toMatch(/~\/\.claude\.json/)

    // …and the import ships the owner's OWN past messages out, in bulk.
    const imported = String(messages.en['persona.privacy.import'])
    expect(imported).toMatch(/Anthropic/)
    expect(imported).toMatch(/400/)
  })

  it('nothing promises a limit on how much of the corpus is sent', () => {
    // THE OVERCLAIM THAT WAS ACTUALLY SHIPPED. The first wording said only
    // "as much as the exchange needs" of what you have built up is sent
    // (JA: 「その受け答えに要る分だけ」). Nothing enforces that — personaChat
    // hands the run a PATH and the model decides how much to read. Over-
    // approximate: any persona string that bounds the amount is a lie until
    // something in this repo actually bounds it.
    for (const lang of ['en', 'ja'] as const) {
      for (const [key, value] of Object.entries(messages[lang])) {
        if (!key.startsWith('persona.privacy.')) continue
        expect(String(value), `${lang} ${key}`).not.toMatch(
          /only as much as|no more than .*needed|要る分だけ|必要な分だけ|丸ごと送られることはなく/,
        )
      }
    }
  })

  it('no copy on this screen claims the CONVERSATION stays on this machine', () => {
    // Over-approximate on purpose: any persona string that promises locality
    // must be about what is WRITTEN, never about talking. The one that would
    // slip through review is a reassuring rewrite of `.conversation`.
    for (const lang of ['en', 'ja'] as const) {
      const conversation = String(messages[lang]['persona.privacy.conversation'])
      expect(conversation, `${lang} must not claim the exchange stays local`).not.toMatch(
        /stays on this (machine|computer)|never leaves|この(パソコン|端末)の中だけ|外に出ません/,
      )
    }
  })

  it('is on screen, closed, at the point of entry', async () => {
    draw()
    const summary = screen.getByText('persona.privacy.summary')
    expect(summary.closest('details')?.open).toBe(false)
    fireEvent.click(summary)
    await waitFor(() => expect(screen.getByText('persona.privacy.conversation')).toBeTruthy())
    expect(screen.getByText('persona.privacy.local')).toBeTruthy()
    expect(screen.getByText('persona.privacy.training')).toBeTruthy()
    // The import sentence is the one that existed as an i18n key for a while
    // WITHOUT any component rendering it — a privacy disclosure nobody could
    // read. Assert it reaches the screen, not merely that it is written down.
    expect(screen.getByText('persona.privacy.import')).toBeTruthy()
  })
})

// ─── the way out of a turn ───────────────────────────────────────────────────
//
// A turn is a JOB, deliberately not bound to the request that started it — that
// is what keeps a reply from being lost when the panel closes. The flip side:
// a cold `claude` start that wedges holds the single-flight slot for its full
// ten-minute ceiling, burning the owner's own subscription, and POST
// /api/persona/chat/cancel had no caller anywhere in the app until this existed.
describe('PersonaConversation — stopping a turn in flight', () => {
  it('offers a stop while a turn is running, and reports WHICH turn', () => {
    draw({ turns: [turn({ id: 't-live', state: 'running', reply: undefined, kept: undefined })] })
    fireEvent.click(screen.getByText('persona.chat.stop'))
    expect(cancelled).toEqual(['t-live'])
  })

  it('offers no stop when nothing is running', () => {
    draw({ turns: [turn()] })
    expect(screen.queryByText('persona.chat.stop')).toBeNull()
  })

  // A turn a person STOPPED is not a turn that failed. Both are `state:
  // 'failed'` on the wire, and the marker that tells them apart is the server's
  // own (`error: 'cancelled'`, set by personaChat.ts on an aborted run).
  it('says "you stopped this", not "that did not go through"', () => {
    draw({
      turns: [turn({ state: 'failed', error: 'cancelled', reply: undefined, kept: undefined })],
    })
    expect(screen.getByText('persona.chat.stopped')).toBeTruthy()
    expect(screen.queryByText('persona.chat.turnFailed')).toBeNull()
    // …and the words survive, with the same retry a real failure gets.
    expect(screen.getByText('仕事で手が止まる')).toBeTruthy()
    fireEvent.click(screen.getByText('persona.chat.retry'))
    expect(sent).toEqual(['仕事で手が止まる'])
  })

  it('a REAL failure still reads as one', () => {
    draw({ turns: [turn({ state: 'failed', reply: undefined, kept: undefined })] })
    expect(screen.getByText('persona.chat.turnFailed')).toBeTruthy()
    expect(screen.queryByText('persona.chat.stopped')).toBeNull()
  })
})

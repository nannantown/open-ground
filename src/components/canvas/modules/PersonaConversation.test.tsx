// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor, act } from '@testing-library/react'
import {
  AT_BOTTOM_PX,
  IMPORT_KEPT_PREVIEW,
  PersonaConversation,
  PROMPT_KEYS,
  PROMPT_ROTATE_MS,
  RESOLVED_NOTICE_MS,
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
let askedAnother: number
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
  moreState: 'idle',
  onAskAnother: () => {
    askedAnother += 1
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
  askedAnother = 0
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

  it('a failed SKIP never borrows the answer path’s reassurance', () => {
    draw({ question: question(), skipFailed: true })
    expect(screen.getByText('persona.interview.skipFailed')).toBeTruthy()
    // There were no words on the skip path, so nothing promises they are safe.
    expect(screen.queryByText('persona.chat.turnFailed')).toBeNull()
  })
})

// FIELD REPORT, 2026-08-16: 「答えたらずっと表示する必要なくない? ちゃんとユーザーの
// フローも考えて設計して」.
//
// The loop asks ONE question a day. A question answered at 09:01 kept its
// heading, its setting, its text and a 「保存しました」 line above the input until
// midnight — five lines whose job ended in the first minute, and, within the
// same session, saying the same thing the owner's own answer bubble said.
//
// The phases, and what each is allowed to draw:
//   ASKED    — the block. It is the point of the screen.
//   RESOLVED — a receipt, then gone. An event, not a state.
//   AFTER    — nothing at all.
describe('the question is drawn for as long as it has a job, and no longer', () => {
  const openQ = () => question({ status: 'open' })
  const answeredQ = () => question({ status: 'answered' })

  const resolve = (over: Partial<PersonaConversationProps> = {}) => {
    const view = render(<PersonaConversation {...props({ question: openQ() })} />)
    view.rerender(<PersonaConversation {...props({ question: answeredQ(), ...over })} />)
    return view
  }

  it('ASKED: draws the question and the way past it', () => {
    draw({ question: openQ() })
    expect(screen.getByText('What kept being missing?')).toBeTruthy()
    expect(screen.getByText('persona.interview.skip')).toBeTruthy()
  })

  it('RESOLVED: the question leaves immediately, and a receipt takes its place', () => {
    resolve()
    // The five lines are gone the moment the answer lands …
    expect(screen.queryByText('What kept being missing?')).toBeNull()
    expect(screen.queryByText('About a card on your board.')).toBeNull()
    expect(screen.queryByText('persona.interview.heading')).toBeNull()
    expect(screen.queryByText('persona.interview.skip')).toBeNull()
    // … and one line says what happened.
    expect(screen.getByText('persona.interview.answered')).toBeTruthy()
  })

  it('RESOLVED: the receipt goes too, rather than becoming the new standing line', () => {
    vi.useFakeTimers()
    try {
      const view = render(<PersonaConversation {...props({ question: openQ() })} />)
      view.rerender(<PersonaConversation {...props({ question: answeredQ() })} />)
      expect(screen.getByText('persona.interview.answered')).toBeTruthy()
      act(() => {
        vi.advanceTimersByTime(RESOLVED_NOTICE_MS + 100)
      })
      expect(screen.queryByText('persona.interview.answered')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('RESOLVED: it hedges when the corpus behind the save was not rebuilt', () => {
    resolve({ answerStale: true })
    expect(screen.getByText('persona.interview.answeredStale')).toBeTruthy()
    expect(screen.queryByText('persona.interview.answered')).toBeNull()
  })

  it('RESOLVED: a skip says it was skipped, not that anything was saved', () => {
    const view = render(<PersonaConversation {...props({ question: openQ() })} />)
    view.rerender(<PersonaConversation {...props({ question: question({ status: 'skipped' }) })} />)
    expect(screen.getByText('persona.interview.skipped')).toBeTruthy()
    expect(screen.queryByText('persona.interview.answered')).toBeNull()
  })

  it('AFTER: a reload later the same day says NOTHING about it', () => {
    // ⚠ THE WHOLE POINT. Mounting straight onto an answered question is what a
    // reload at 22:00 looks like, and the old build drew the full panel there.
    // A receipt for an event nobody just witnessed is the standing panel again
    // under a different name.
    draw({ question: answeredQ() })
    expect(screen.queryByText('What kept being missing?')).toBeNull()
    expect(screen.queryByText('persona.interview.heading')).toBeNull()
    expect(screen.queryByText('persona.interview.answered')).toBeNull()
    expect(screen.queryByText('persona.interview.skipped')).toBeNull()
  })

  it('ONLY SUCCESS IS TRANSIENT: a failed skip keeps the question AND its error', () => {
    // The skip did not go through, so the question is still open — there is
    // still something to do, and nothing here is on a timer.
    vi.useFakeTimers()
    try {
      render(<PersonaConversation {...props({ question: openQ(), skipFailed: true })} />)
      act(() => {
        vi.advanceTimersByTime(RESOLVED_NOTICE_MS * 3)
      })
      expect(screen.getByText('What kept being missing?')).toBeTruthy()
      expect(screen.getByText('persona.interview.skipFailed')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })
})

// FIELD REPORT, 2026-08-16: 「今日の一問もブロックに囲まれててフォームも囲まれている
// から冗長に感じるのかも。質問はテキストだけでいい」/「左のサイドラインもやめよう
// AIっぽい」.
//
// The fix for the previous report drew a card around the question and an ochre
// rail down the left of both it and the input. That made the pair read as one
// object — and also made TWO bordered things stack, only one of which can be
// typed into. The border on the input MEANS something; the one around the
// question meant nothing and competed with it.
describe('the question is TEXT — the only box on the stage is the one you type in', () => {
  // `text-ink` and friends flip with the theme. The stage does NOT (it is the
  // same near-black in both), so on it they are each wrong in one theme —
  // `text-ink` in light mode is literally the surface colour. Enforced globally
  // by src/labelPlates.test.ts for lines that DECLARE bg-bg-deep; this file
  // declares none, it is simply always rendered on one, which is the hole.
  const FLIPPING = new Set([
    'text-ink',
    'text-ink-muted',
    'text-ink-subtle',
    'text-ink-faint',
    'text-ink-inverse',
  ])
  const inks = (el: HTMLElement) =>
    el.className
      .split(/\s+/)
      .map((c) => c.split('/')[0])
      .filter((c) => FLIPPING.has(c))

  it('draws no card around the question, and no rail beside it', () => {
    draw({ question: question({ status: 'open' }) })
    const text = screen.getByText('What kept being missing?')
    const context = screen.getByText('About a card on your board.')
    const block = text.closest('div') as HTMLElement

    for (const el of [text, context, block]) {
      expect(el.className).not.toMatch(/\bbg-bg-card\b/)
      expect(el.className).not.toMatch(/\bborder(-l)?(-2)?\b/)
      expect(el.className).not.toMatch(/ochre/)
    }
  })

  it('…and the input keeps its own border, because that one is the instruction', () => {
    draw({ question: question({ status: 'open' }) })
    const box = input().closest('div') as HTMLElement
    expect(box.className).toMatch(/\bborder\b/)
    // …but nothing ochre bracketing it to the question above.
    expect(box.className).not.toMatch(/ochre/)
  })

  it('is painted for a surface that does NOT invert, in both themes', () => {
    // ⚠ FOUND BY RENDERING, NOT BY READING (2026-08-16). The box wore `bg-card`
    // and `border-line` — both flip with the theme — while sitting on `bg-deep`,
    // which does not. In the light theme that is a cream slab on near-black: the
    // one bordered object on this stage, and the thing the last two rounds of
    // work were about, looked like a different component at noon. The owner runs
    // dark and could not have seen it.
    draw()
    const box = input().closest('div') as HTMLElement
    const classes = box.className.split(/\s+/)
    expect(classes).toContain('bg-bg-cardOnDeep')
    expect(classes).toContain('border-line-onDeep')
    expect(classes).not.toContain('bg-bg-card')
    expect(classes).not.toContain('border-line')
    // The text inside has to follow the surface it is on for the same reason.
    expect(input().className).toMatch(/text-ink-onDeep/)
    expect(input().className.split(/\s+/)).not.toContain('text-ink')
  })

  it('uses the ink made for a surface that does not invert', () => {
    // Off the card, the question inherited card ink. In light mode `text-ink` on
    // `bg-deep` is the SAME COLOUR — the question would simply not be there, and
    // only for owners not developing in dark.
    draw({ question: question({ status: 'open' }) })
    expect(inks(screen.getByText('What kept being missing?'))).toEqual([])
    expect(inks(screen.getByText('About a card on your board.'))).toEqual([])
    expect(screen.getByText('What kept being missing?').className).toMatch(/text-ink-onDeep/)
  })
})

// Owner, 2026-08-16: 「新しい質問を出すボタンがあってもいいかも。1日1答にする必要は
// ない」. The daily sweep offers one unasked; this is the owner asking.
describe('asking for another question', () => {
  it('offers the control when nothing is on the table, and calls out', () => {
    draw()
    fireEvent.click(screen.getByText('persona.interview.more'))
    expect(askedAnother).toBe(1)
  })

  it('…and after the last one was answered', () => {
    draw({ question: question({ status: 'answered' }) })
    expect(screen.getByText('persona.interview.more')).toBeTruthy()
  })

  it('HIDES it while a question is still open — it is not an escape hatch', () => {
    // ⚠ The way past an open question is 「これは飛ばす」, which records that this
    // observation was declined. A second door that quietly replaced it would
    // destroy the open question's subject (already burned in askedSubjects) —
    // a button that claims to ADD one silently deleting one.
    draw({ question: question({ status: 'open' }) })
    expect(screen.queryByText('persona.interview.more')).toBeNull()
    expect(screen.getByText('persona.interview.skip')).toBeTruthy()
  })

  it('says LOOKING while it is in flight, and cannot be pressed twice', () => {
    draw({ moreState: 'loading' })
    const btn = screen.getByText('persona.interview.moreLoading').closest('button')
    expect(btn).toBeTruthy()
    expect((btn as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(btn as HTMLButtonElement)
    expect(askedAnother).toBe(0)
  })

  it('SWEPT AND FOUND NOTHING and COULD NOT SWEEP are different sentences', () => {
    // ⚠ The app's oldest lie shape: an emptiness asserted over a source nobody
    // managed to read. 'none' is only ever reached through a 2xx (the route 500s
    // on an incomplete sweep, which lands on 'failed').
    const { rerender } = draw({ moreState: 'none' })
    expect(screen.getByText('persona.interview.moreNone')).toBeTruthy()
    expect(screen.queryByText('persona.interview.moreFailed')).toBeNull()

    rerender(<PersonaConversation {...props({ moreState: 'failed' })} />)
    expect(screen.getByText('persona.interview.moreFailed')).toBeTruthy()
    expect(screen.queryByText('persona.interview.moreNone')).toBeNull()
  })
})

describe('PersonaConversation — dropping a claude.ai export', () => {
  const file = (name = 'conversations.json') =>
    new File(['[]'], name, { type: 'application/json' })

  it('takes a file on the same slot talking uses, and says so while it hovers', () => {
    draw()
    const box = input()
    // dragENTER, as a real drag does first — the root arms its depth counter
    // there (dragover alone never fires without an enter before it).
    fireEvent.dragEnter(box, { dataTransfer: { files: [] } })
    expect(input().placeholder).toBe('persona.import.dropHint')

    const f = file()
    fireEvent.drop(box, { dataTransfer: { files: [f] } })
    expect(dropped).toEqual([f])
    // …and the hint goes back to the invitation.
    expect(input().placeholder).toContain('persona.chat.placeholder')
  })

  it('crossing INTO a child does not flicker the drop hint away', () => {
    // dragleave fires on the root every time the pointer crosses into a child
    // (the thread, a bubble, the input) — with a plain boolean the ochre border
    // flickered all the way across the console. The depth counter only
    // disarms when as many leaves as enters have fired.
    draw({ turns: [turn()] })
    const box = input()
    fireEvent.dragEnter(box, { dataTransfer: { files: [] } })
    fireEvent.dragEnter(screen.getByTestId('chat-thread'), { dataTransfer: { files: [] } })
    fireEvent.dragLeave(box, { dataTransfer: { files: [] } })
    expect(input().placeholder).toBe('persona.import.dropHint')
    fireEvent.dragLeave(screen.getByTestId('chat-thread'), { dataTransfer: { files: [] } })
    expect(input().placeholder).toContain('persona.chat.placeholder')
  })

  // A NONZERO LOSS IS A SENTENCE; A ZERO LOSS IS SILENCE — the Board roll-up's
  // clause-per-known-thing rule. The receipt used to print five 「0件」 lines on
  // a clean import (the owner's own screenshot); the losses that ARE nonzero
  // here still each get their line, and the denominator sits in the
  // `considered` sentence itself so 400-of-900 can never read as "read it all".
  it('reports what was read, what was dropped and what was NOT looked at', () => {
    const job: PersonaImportView = {
      fileName: 'conversations.json',
      state: 'done',
      counts: importResult(),
      result: importResult(),
    }
    draw({ importJob: job })

    // The receipt is a CARD named for what it is, carrying the file it is about.
    const receipt = screen.getByTestId('import-receipt')
    expect(receipt.textContent).toContain('persona.import.heading')
    expect(receipt.textContent).toContain('conversations.json')

    expect(screen.getByText('persona.import.parsed:{"conversations":1284}')).toBeTruthy()
    expect(screen.getByText('persona.import.ownerOnly')).toBeTruthy()
    expect(screen.getByText('persona.import.dropped:{"count":900}')).toBeTruthy()
    expect(screen.getByText('persona.import.unreadableRows:{"count":8}')).toBeTruthy()
    // 400 read OF 900 said — the denominator the owner's screenshot lacked.
    expect(
      screen.getByText('persona.import.considered:{"total":900,"count":400}'),
    ).toBeTruthy()
    expect(screen.getByText('persona.import.notConsidered:{"count":500}')).toBeTruthy()
    // The two zero losses in this fixture say NOTHING.
    expect(screen.queryByText(/persona\.import\.duplicates/)).toBeNull()
    expect(screen.queryByText(/persona\.import\.keptUnreadable/)).toBeNull()
    expect(screen.getByText('persona.import.keptCount:{"count":1}')).toBeTruthy()
    // …and every kept line is pressable, exactly like a turn's.
    expect(screen.getByRole('button', { name: /決めたあとに手が止まる/ })).toBeTruthy()
    // A finished receipt says the conversation never saw this file — the line
    // whose absence made the owner ask the stand-in about the zip.
    expect(screen.getByText('persona.import.notChat')).toBeTruthy()
  })

  it('says each nonzero loss — duplicates and unplaceable lines get their line back', () => {
    draw({
      importJob: {
        fileName: 'conversations.json',
        state: 'done',
        counts: importResult(),
        result: importResult({ duplicatesSkipped: 3, keptUnreadable: 2 }),
      },
    })
    expect(screen.getByText('persona.import.duplicates:{"count":3}')).toBeTruthy()
    expect(screen.getByText('persona.import.keptUnreadable:{"count":2}')).toBeTruthy()
  })

  it('a clean sweep — zero dropped, zero unreadable — prints no loss lines at all', () => {
    const clean = importResult({
      droppedNonOwner: 0,
      unreadable: 0,
      notConsidered: 0,
      considered: 900,
    })
    draw({
      importJob: { fileName: 'conversations.json', state: 'done', counts: clean, result: clean },
    })
    expect(screen.queryByText(/persona\.import\.dropped:/)).toBeNull()
    expect(screen.queryByText(/persona\.import\.unreadableRows/)).toBeNull()
    expect(screen.queryByText(/persona\.import\.notConsidered/)).toBeNull()
    // …while the one sentence that remains carries the whole account: 900 of 900.
    expect(
      screen.getByText('persona.import.considered:{"total":900,"count":900}'),
    ).toBeTruthy()
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

// ─── one box, one job at a time ──────────────────────────────────────────────
//
// FIELD REPORT, 2026-08-15: 「このやりかただとどこに答えていいかわからない。なぜなら
// 質問が出ている時も入力フォームにサンプルの質問文がきているから」.
//
// Today's question sat above the box while the box's own placeholder suggested a
// DIFFERENT thing to talk about. Two prompts, one input, and nothing saying
// which one the box belonged to. The placeholder is not decoration on this
// surface — it is the only thing that says what the box is FOR.
describe('while today’s question is open, the box belongs to it', () => {
  const openQ = () => question({ status: 'open' })

  it('says ANSWER IT HERE — never a competing suggestion', () => {
    draw({ question: openQ() })
    const box = input()
    expect(box.placeholder).toBe('persona.chat.placeholderAnswer')
    // …and specifically NOT the rotating one, whatever index it landed on.
    expect(box.placeholder).not.toContain('persona.chat.placeholder:')
  })

  it('goes back to the rotating invitation once the question is answered', () => {
    // `placeholderAnswer` is for an UNANSWERED question. After that the box is a
    // plain chat box again, and the rotation is what tells a newcomer it can be
    // used for anything at all.
    draw({ question: question({ status: 'answered' }) })
    expect(input().placeholder).toContain('persona.chat.placeholder:')
  })

  it('…and with no question at all', () => {
    draw()
    expect(input().placeholder).toContain('persona.chat.placeholder:')
  })

  it('a file over the box still wins — that is a different job again', () => {
    draw({ question: openQ() })
    fireEvent.dragEnter(input().closest('div')!, { dataTransfer: { types: ['Files'] } })
    expect(input().placeholder).toBe('persona.import.dropHint')
  })

  it('does not ROTATE BEHIND the question — the invitation is where they left it', () => {
    // ⚠ MEASURED THROUGH THE ONLY THING THAT CAN SEE IT. Asserting the
    // placeholder while the question is open proves nothing: it reads
    // `placeholderAnswer` whether or not the timer is still turning underneath.
    // The observable claim is what the box says AFTERWARDS — answer the
    // question and the invitation must be the one that was there before it,
    // not one that drifted for minutes behind a cover. (A first attempt at this
    // test passed with the guard removed, which is exactly the shape this repo
    // treats as no test at all.)
    vi.useFakeTimers()
    try {
      const view = render(<PersonaConversation {...props()} />)
      const before = input().placeholder
      expect(before).toContain('persona.chat.placeholder:')

      view.rerender(<PersonaConversation {...props({ question: openQ() })} />)
      act(() => {
        vi.advanceTimersByTime(PROMPT_ROTATE_MS * 6)
      })
      expect(input().placeholder).toBe('persona.chat.placeholderAnswer')

      view.rerender(<PersonaConversation {...props({ question: question({ status: 'answered' }) })} />)
      expect(input().placeholder).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ─── THE SCROLL FOLLOWS THE READER, NOT THE OTHER WAY ROUND ─────────────────
//
// Owner, 2026-08-17, on the import receipt: 「スクロールも適当な感じ」. The first
// cut was one unconditional `scrollTop = scrollHeight` — measured on the
// running app it BOTH yanked a reader out of history on every append AND
// (because the import poll re-minted its state every 500ms) made scrolling up
// during a distillation physically impossible. These tests pin the replacement:
// follow only while the reader is at the bottom; otherwise show the pill.
//
// jsdom lays nothing out, so the geometry is stubbed per element — scrollTop
// writable so the component's own assignment is observable, the two heights
// fixed. That makes these tests about the DECISION (pin or don't), which is
// exactly the part that was wrong.
describe('the thread sticks to the bottom without yanking the reader', () => {
  const thread = () => screen.getByTestId('chat-thread')
  const geometry = (
    el: HTMLElement,
    { scrollHeight = 1000, clientHeight = 300 }: { scrollHeight?: number; clientHeight?: number } = {},
  ) => {
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight })
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight })
    Object.defineProperty(el, 'scrollTop', { configurable: true, writable: true, value: 0 })
  }
  const turns2 = [turn(), turn({ id: 't-2', text: '二つ目' })]
  const turns3 = [...turns2, turn({ id: 't-3', text: '三つ目' })]

  it('a reader AT the bottom is carried along when a message lands', () => {
    const view = draw({ turns: turns2 })
    const el = thread()
    geometry(el)
    // At the foot (within AT_BOTTOM_PX) — the follow stays armed.
    el.scrollTop = 1000 - 300 - (AT_BOTTOM_PX - 1)
    fireEvent.scroll(el)

    view.rerender(<PersonaConversation {...props({ turns: turns3 })} />)
    expect(el.scrollTop).toBe(el.scrollHeight)
    // …and no pill: the reader is already looking at the newest thing.
    expect(screen.queryByText('persona.chat.jumpLatest')).toBeNull()
  })

  it('a reader UP IN HISTORY is left exactly where they are — the pill appears instead', () => {
    const view = draw({ turns: turns2 })
    const el = thread()
    geometry(el)
    el.scrollTop = 100 // deep in history: 1000 - 100 - 300 = 600 > AT_BOTTOM_PX
    fireEvent.scroll(el)

    view.rerender(<PersonaConversation {...props({ turns: turns3 })} />)
    expect(el.scrollTop).toBe(100)
    expect(screen.getByText('persona.chat.jumpLatest')).toBeTruthy()
  })

  it('pressing the pill goes to the newest message and puts the pill away', () => {
    const view = draw({ turns: turns2 })
    const el = thread()
    geometry(el)
    el.scrollTop = 100
    fireEvent.scroll(el)
    view.rerender(<PersonaConversation {...props({ turns: turns3 })} />)

    fireEvent.click(screen.getByText('persona.chat.jumpLatest'))
    expect(el.scrollTop).toBe(el.scrollHeight)
    expect(screen.queryByText('persona.chat.jumpLatest')).toBeNull()
    // …and the follow is re-armed: the next message carries the reader again.
    view.rerender(<PersonaConversation {...props({ turns: [...turns3, turn({ id: 't-4' })] })} />)
    expect(el.scrollTop).toBe(el.scrollHeight)
  })

  it('scrolling back down by hand re-arms the follow the same way', () => {
    const view = draw({ turns: turns2 })
    const el = thread()
    geometry(el)
    el.scrollTop = 100
    fireEvent.scroll(el)
    el.scrollTop = 1000 - 300 // back at the foot
    fireEvent.scroll(el)
    expect(screen.queryByText('persona.chat.jumpLatest')).toBeNull()
    view.rerender(<PersonaConversation {...props({ turns: turns3 })} />)
    expect(el.scrollTop).toBe(el.scrollHeight)
  })

  it("the day's question appends too — it arrives ON SCREEN, not off the top", () => {
    // The question used to OPEN the thread: inserted at the top of a
    // bottom-pinned, scrollbar-less container, it arrived invisible
    // (2026-08-17 audit). Now it is part of the same append-follows contract
    // as every message: it sits at the FOOT, after the turns and the import
    // receipt, next to the box that answers it.
    draw({
      turns: turns2,
      question: question(),
      importJob: {
        fileName: 'conversations.json',
        state: 'done',
        counts: importResult(),
        result: importResult(),
      },
    })
    const bubble = screen.getByText('二つ目')
    const receipt = screen.getByTestId('import-receipt')
    const heading = screen.getByText('persona.interview.heading')
    expect(bubble.compareDocumentPosition(receipt) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(receipt.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('a question landing while stuck pins the thread to show it', () => {
    const view = draw({ turns: turns2 })
    const el = thread()
    geometry(el)
    el.scrollTop = 1000 - 300
    fireEvent.scroll(el)
    el.scrollTop = 0 // deliberately wrong, to observe the effect writing it back
    view.rerender(<PersonaConversation {...props({ turns: turns2, question: question() })} />)
    expect(el.scrollTop).toBe(el.scrollHeight)
  })
})

// ─── THE KEPT CHIPS ARE A PREVIEW, NOT A FLOOD ──────────────────────────────
describe('the import receipt previews its kept lines', () => {
  const manyKept = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      kept({ judgment: judgment({ id: `j-${i}`, text: `分かったこと ${i}` }) }),
    )

  it(`shows ${IMPORT_KEPT_PREVIEW} and folds the rest behind one button`, () => {
    // A real export kept ~40 lines; every one as a chip buried the receipt's
    // own numbers and half the thread with them (2026-08-17 audit).
    const result = importResult({ kept: manyKept(9) })
    draw({
      importJob: { fileName: 'conversations.json', state: 'done', counts: result, result },
    })
    expect(screen.getAllByText(/persona\.chat\.keptLead/)).toHaveLength(IMPORT_KEPT_PREVIEW)
    const more = screen.getByText(
      `persona.import.showMoreKept:{"count":${9 - IMPORT_KEPT_PREVIEW}}`,
    )
    fireEvent.click(more)
    expect(screen.getAllByText(/persona\.chat\.keptLead/)).toHaveLength(9)
    expect(screen.queryByText(/persona\.import\.showMoreKept/)).toBeNull()
  })

  it('a short list is simply shown — no button to press for nothing', () => {
    const result = importResult({ kept: manyKept(IMPORT_KEPT_PREVIEW) })
    draw({
      importJob: { fileName: 'conversations.json', state: 'done', counts: result, result },
    })
    expect(screen.getAllByText(/persona\.chat\.keptLead/)).toHaveLength(IMPORT_KEPT_PREVIEW)
    expect(screen.queryByText(/persona\.import\.showMoreKept/)).toBeNull()
  })
})

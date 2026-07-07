// swarmQuestions tests — C3: free-text-question detection (fail-closed: a
// false POSITIVE means typing into someone's PTY, so every negative control
// here is load-bearing) + the handleWorkerQuestion pipe (C-core's library).
// The screen fixtures are cut from LIVE claude TUI frames captured through
// terminal.ts's headless-xterm scrape on 2026-07-06 (the card's mandated
// signature verification), identities anonymised.

import { describe, it, expect } from 'vitest'
import {
  detectFreeTextQuestion,
  readInputBoxText,
  handleWorkerQuestion,
  type HandleWorkerQuestionDeps,
} from './swarmQuestions'
import type { OwnerAnswer } from './swarmOverseerBrain'
import type { Escalation } from '../types'

// ── Fixtures (structure faithful to the captured frames) ─────────────────────

const RULE = '─'.repeat(110)

/** claude asked a free-text question and idles at an EMPTY input box. */
const QUESTION_IDLE = [
  '╭──────────────────────────────────────╮',
  '│ ✻ Welcome to Claude Code!            │',
  '│   ~/projects/test                    │',
  '╰──────────────────────────────────────╯',
  ' ⚠ 2 MCP servers need authentication · run /mcp',
  '❯ これは検出テストです。ツールを使わず、1つ質問して私の回答を待ってください。',
  '⏺ 質問がひとつあります。',
  '  今日のレビューはどのファイルから始めますか？',
  '✻ Brewed for 7s',
  "                        You've used 88% of your Fable 5 limit · resets 3pm (Asia/Tokyo)",
  RULE,
  '❯ ',
  RULE,
  '  ? for shortcuts · ← for agents',
].join('\n')

/** Same question, but claude is GENERATING (submitted turn in flight). */
const QUESTION_WORKING = [
  '❯ これは検出テストです。',
  '⏺ 質問がひとつあります。',
  '  今日のレビューはどのファイルから始めますか？',
  '❯ 回答: src/lib/server/terminal.ts から始めてください。',
  '✶ Flummoxing…',
  '  ⎿  Tip: Run /install-slack-app to use Claude in Slack',
  RULE,
  '❯ ',
  RULE,
  '  esc to interrupt · ← for agents',
].join('\n')

/** Idle with the stock placeholder and NO question above (fresh boot). */
const IDLE_PLACEHOLDER = [
  '╭──────────────────────────────────────╮',
  '│ ✻ Welcome to Claude Code!            │',
  '╰──────────────────────────────────────╯',
  ' ⚠ 2 MCP servers need authentication · run /mcp',
  '                        ◉ xhigh · /effort',
  RULE,
  '❯ Try "write a test for <filepath>"',
  RULE,
  '  ? for shortcuts · ← for agents',
].join('\n')

/** A paste sits UNSENT in the input box under the question (mid-injection). */
const QUESTION_PASTE_PENDING = [
  '⏺ 質問がひとつあります。',
  '  今日のレビューはどのファイルから始めますか？',
  '✻ Brewed for 7s',
  RULE,
  '❯ 回答: src/lib/server/terminal.ts から始めてください。理由: 入力経路の変更が中心だからです。',
  RULE,
].join('\n')

/** A numbered interactive menu (the permission arm's turf) — its question line
 *  ends in '?' and an idle footer is present, so ONLY the detectMenu guard
 *  keeps this out of the question arm ("menu 誤検出ゼロ"). */
const MENU_FRAME = [
  'Do you want to proceed with this edit?',
  '❯ 1. Yes',
  '  2. Yes, allow all edits during this session (shift+tab)',
  '  3. No, and tell Claude what to do differently (esc to cancel)',
  RULE,
  '❯ ',
  RULE,
  '  ? for shortcuts',
].join('\n')

/** Idle, but the last utterance is a STATEMENT — no question to answer. */
const IDLE_STATEMENT = [
  '⏺ 実装が完了しました。テストも緑です。',
  RULE,
  '❯ ',
  RULE,
  '  ? for shortcuts · ← for agents',
].join('\n')

describe('detectFreeTextQuestion — the fail-closed screen classifier', () => {
  it('detects the live-captured question-idle frame and reassembles the block', () => {
    const q = detectFreeTextQuestion(QUESTION_IDLE)
    expect(q).not.toBeNull()
    expect(q!.question).toContain('今日のレビューはどのファイルから始めますか？')
    expect(q!.question).toContain('質問がひとつあります。')
    // Chrome (usage meter / Brewed / footers) never leaks into the question.
    expect(q!.question).not.toMatch(/Brewed|used 88%|shortcuts/)
  })

  it('never fires while claude is GENERATING (working footer)', () => {
    expect(detectFreeTextQuestion(QUESTION_WORKING)).toBeNull()
  })

  it('never fires on a fresh idle box with no question (placeholder tolerated)', () => {
    expect(detectFreeTextQuestion(IDLE_PLACEHOLDER)).toBeNull()
  })

  it('never fires while a pasted answer sits UNSENT in the input box', () => {
    expect(detectFreeTextQuestion(QUESTION_PASTE_PENDING)).toBeNull()
  })

  it('never fires on a numbered MENU frame (menu 誤検出ゼロ — detectMenu guard)', () => {
    expect(detectFreeTextQuestion(MENU_FRAME)).toBeNull()
  })

  it('never fires when the last utterance is a statement, not a question', () => {
    expect(detectFreeTextQuestion(IDLE_STATEMENT)).toBeNull()
  })

  it('never fires on null / empty / structureless screens', () => {
    expect(detectFreeTextQuestion(null)).toBeNull()
    expect(detectFreeTextQuestion('')).toBeNull()
    expect(detectFreeTextQuestion('just some plain logs\nwith lines?')).toBeNull()
  })

  it('never fires without the exact ❯ input-box glyph (unknown TUI ⇒ closed)', () => {
    const noPrompt = QUESTION_IDLE.replace(/❯/g, '>')
    expect(detectFreeTextQuestion(noPrompt)).toBeNull()
  })

  it('survives the question block being longer than the walk-up cap (returns null, not junk)', () => {
    const longBlock = [
      '⏺ 長い説明です。',
      ...Array.from({ length: 12 }, (_, i) => `  続きの行 ${i} です。`),
      '  それでどうしますか？',
      RULE,
      '❯ ',
      RULE,
      '  ? for shortcuts',
    ].join('\n')
    // Still detected (the block walk simply stops early), and stays bounded.
    const q = detectFreeTextQuestion(longBlock)
    expect(q).not.toBeNull()
    expect(q!.question).toContain('それでどうしますか？')
    expect(q!.question.length).toBeLessThan(1000)
  })
})

describe('readInputBoxText — the last-❯-row reader', () => {
  it('reads an empty idle box as empty', () => {
    expect(readInputBoxText(QUESTION_IDLE)).toBe('')
  })
  it('reads a pending paste back out of the box', () => {
    expect(readInputBoxText(QUESTION_PASTE_PENDING)).toContain('terminal.ts から始めてください')
  })
  it('returns null when no prompt row exists', () => {
    expect(readInputBoxText('no prompt here\nat all')).toBeNull()
  })
})

// ── handleWorkerQuestion — the T1 pipe (all deps faked; no LLM, no PTY) ──────

const esc = (over: Partial<Escalation> = {}): Escalation => ({
  id: 'esc-1',
  receiptKey: 'rk',
  createdAt: '2026-07-06T00:00:00Z',
  projectPath: '/proj',
  question: 'q',
  context: 'c',
  whyEscalated: 'policy',
  status: 'open',
  ...over,
})

const input = {
  projectPath: '/proj',
  question: 'どのDBを使いますか？',
  context: 'PTY tail…',
  taskId: 'task-1',
  branch: 'swarm/x',
  terminalId: 'pty-1',
}

const answerOf = (v: OwnerAnswer): HandleWorkerQuestionDeps['answer'] => async () => v

describe('handleWorkerQuestion — proxy answer → injection, everything else fail-closed', () => {
  it('injects a confident answer into the live worker PTY', async () => {
    const injected: string[] = []
    const out = await handleWorkerQuestion(input, {
      answer: answerOf({ kind: 'answer', text: 'SQLiteで十分です', confidence: 'high' }),
      canInjectInto: async () => true,
      inject: async (_id, text) => {
        injected.push(text)
        return true
      },
      escalate: async () => {
        throw new Error('must not escalate on a delivered answer')
      },
    })
    expect(out).toEqual({ outcome: 'injected', answer: 'SQLiteで十分です', confidence: 'high' })
    expect(injected).toHaveLength(1)
    expect(injected[0]).toContain('どのDBを使いますか？')
    expect(injected[0]).toContain('SQLiteで十分です')
  })

  it('escalates WITH the proxy draft when the target guard refuses', async () => {
    const raised: unknown[] = []
    const out = await handleWorkerQuestion(input, {
      answer: answerOf({ kind: 'answer', text: 'A案で', confidence: 'medium' }),
      canInjectInto: async () => false,
      inject: async () => {
        throw new Error('must not inject past a refusing guard')
      },
      escalate: async (i) => {
        raised.push(i)
        return { escalation: esc(), deduped: false }
      },
    })
    expect(out.outcome).toBe('escalated')
    const raisedInput = raised[0] as { proxyDraft?: { answer: string }; whyEscalated: string }
    expect(raisedInput.whyEscalated).toBe('policy')
    expect(raisedInput.proxyDraft?.answer).toBe('A案で')
  })

  it('escalates WITH the draft when delivery fails (Enter never landed)', async () => {
    const raised: unknown[] = []
    const out = await handleWorkerQuestion(input, {
      answer: answerOf({ kind: 'answer', text: 'B案で', confidence: 'low' }),
      canInjectInto: async () => true,
      inject: async () => false,
      escalate: async (i) => {
        raised.push(i)
        return { escalation: esc(), deduped: true }
      },
    })
    expect(out).toMatchObject({ outcome: 'escalated', why: 'policy', deduped: true })
    expect((raised[0] as { proxyDraft?: { answer: string } }).proxyDraft?.answer).toBe('B案で')
  })

  it('escalates WITHOUT injecting when the proxy itself escalates (irreversible)', async () => {
    const raised: unknown[] = []
    const out = await handleWorkerQuestion(input, {
      answer: answerOf({ kind: 'escalate', why: 'irreversible', reason: 'force-push相当' }),
      canInjectInto: async () => {
        throw new Error('must not even probe the PTY')
      },
      inject: async () => {
        throw new Error('must not inject an escalation')
      },
      escalate: async (i) => {
        raised.push(i)
        return { escalation: esc({ whyEscalated: 'irreversible' }), deduped: false }
      },
    })
    expect(out).toMatchObject({ outcome: 'escalated', why: 'irreversible' })
    expect((raised[0] as { proxyDraft?: unknown }).proxyDraft).toBeUndefined()
  })

  it('routes a confident answer to the inbox as a draft when there is NO terminal (S4 path)', async () => {
    const raised: unknown[] = []
    const out = await handleWorkerQuestion(
      { ...input, terminalId: undefined },
      {
        answer: answerOf({ kind: 'answer', text: 'C案で', confidence: 'high' }),
        inject: async () => {
          throw new Error('no terminal to inject into')
        },
        escalate: async (i) => {
          raised.push(i)
          return { escalation: esc(), deduped: false }
        },
      },
    )
    expect(out.outcome).toBe('escalated')
    expect((raised[0] as { proxyDraft?: { answer: string } }).proxyDraft?.answer).toBe('C案で')
  })

  it('fails CLOSED to the inbox when the proxy pipeline crashes', async () => {
    const out = await handleWorkerQuestion(input, {
      answer: async () => {
        throw new Error('brain exploded')
      },
      escalate: async () => ({ escalation: esc({ whyEscalated: 'insufficient-info' }), deduped: false }),
    })
    expect(out).toMatchObject({ outcome: 'escalated', why: 'insufficient-info' })
  })
})

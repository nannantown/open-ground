// swarmQuestions tests — C3: free-text-question detection (fail-closed: a
// false POSITIVE means typing into someone's PTY, so every negative control
// here is load-bearing) + the handleWorkerQuestion pipe (C-core's library).
// The screen fixtures are cut from LIVE claude TUI frames captured through
// terminal.ts's headless-xterm scrape on 2026-07-06 (the card's mandated
// signature verification), identities anonymised.

import { describe, it, expect } from 'vitest'
import {
  readInputBoxText,
} from './swarmQuestions'

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

/** A paste sits UNSENT in the input box under the question (mid-injection). */
const QUESTION_PASTE_PENDING = [
  '⏺ 質問がひとつあります。',
  '  今日のレビューはどのファイルから始めますか？',
  '✻ Brewed for 7s',
  RULE,
  '❯ 回答: src/lib/server/terminal.ts から始めてください。理由: 入力経路の変更が中心だからです。',
  RULE,
].join('\n')

// (describe('detectFreeTextQuestion — the fail-closed screen classifier') deleted
// 2026-08-13 with the PTY worker sensor layer — the PTY TUI question detector is
// gone; detectSdkFreeTextQuestion is the only worker question detector, pinned in
// swarmSdkQuestions.test.ts.)

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

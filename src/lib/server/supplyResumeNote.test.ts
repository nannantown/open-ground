// supplyResumeNote.test.ts — a president revived QUIET at boot hears its resume
// note with the first line delivered to it, once (docs/AUTONOMY-SPEC.md R-D3a,
// unit U4, 2026-11-28).
//
// What matters is what ARRIVED at the desk — the writes array — never "the
// function returned" (docs/VERIFICATION.md §2). The note is APPENDED, not
// prepended: the line's leading prefix is the frozen protocol groundMarks reads to
// tell the owner's own words from app lines, and a note in front would make an
// engine notice read as the owner speaking.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  queueSupplyOwnerSay,
  queueSupplyReply,
  resetSupplyNoticeState,
  owePresidentResumeNote,
  presidentResumeNoteOwed,
  SUPPLY_RESUME_NOTE,
  SUPPLY_PASTE_MEASURED_UNFOLDED,
  SUPPLY_REPLY_PREFIX,
} from './supplyNotice'
import { promptAuthor } from './groundMarks'
import { runSupplyContextCapPass, resetSupplyContextCapState } from './supplyContextCap'

const PROJECT = '/repo/alpha'
const DESK = 'term-supply-quiet'
const RULE = '─'.repeat(40)
const FOOTER_IDLE = '⏵⏵ bypass permissions on (shift+tab to cycle)'
const frame = (box: string) => ['⏺ done.', '', RULE, `❯ ${box}`, RULE, `  ${FOOTER_IDLE}`].join('\n')
const PASTE_OPEN = '\x1b[200~'
const PASTE_CLOSE = '\x1b[201~'

const harness = () => {
  const writes: string[] = []
  const box = new Map<string, string>()
  return {
    writes,
    deps: {
      desks: () => [{ id: DESK, cwd: PROJECT }],
      screen: (id: string) => frame(box.get(id) ?? ''),
      write: (id: string, data: string) => {
        if (data === '\r') box.delete(id)
        else {
          const text = data.slice(PASTE_OPEN.length, -PASTE_CLOSE.length)
          writes.push(text)
          box.set(id, text)
        }
        return true
      },
      sleep: async () => {},
    },
  }
}

beforeEach(() => {
  resetSupplyNoticeState()
  resetSupplyContextCapState()
})

describe('the resume note rides the first delivery (quiet boot revival)', () => {
  it('the owner’s first line carries the note once; the next line is plain', async () => {
    const h = harness()
    owePresidentResumeNote(DESK)
    await queueSupplyOwnerSay(PROJECT, '今の状況を教えて', undefined, h.deps)
    await queueSupplyOwnerSay(PROJECT, 'ありがとう', undefined, h.deps)
    expect(h.writes).toEqual([`今の状況を教えて ${SUPPLY_RESUME_NOTE}`, 'ありがとう'])
    // Still the owner's turn — the note follows the words, it does not lead them.
    expect(promptAuthor(h.writes[0])).toBe('owner')
    expect(presidentResumeNoteOwed(DESK)).toBe(false)
  })

  it('an app line keeps its leading prefix (groundMarks still reads it as the app)', async () => {
    const h = harness()
    owePresidentResumeNote(DESK)
    await queueSupplyReply(PROJECT, '統合しました', h.deps)
    expect(h.writes).toHaveLength(1)
    expect(h.writes[0].startsWith(SUPPLY_REPLY_PREFIX)).toBe(true)
    expect(h.writes[0].endsWith(SUPPLY_RESUME_NOTE)).toBe(true)
    expect(promptAuthor(h.writes[0])).toBe('other')
  })

  it('a line with no room for it goes unchanged (never past the measured paste size) and the note waits for the next', async () => {
    const h = harness()
    owePresidentResumeNote(DESK)
    const long = 'あ'.repeat(SUPPLY_PASTE_MEASURED_UNFOLDED - 10)
    await queueSupplyOwnerSay(PROJECT, long, undefined, h.deps)
    await queueSupplyOwnerSay(PROJECT, '短い', undefined, h.deps)
    expect(h.writes).toEqual([long, `短い ${SUPPLY_RESUME_NOTE}`])
    for (const w of h.writes) expect(w.length).toBeLessThanOrEqual(SUPPLY_PASTE_MEASURED_UNFOLDED)
  })

  it('a desk that was not revived quiet never hears it', async () => {
    const h = harness()
    await queueSupplyOwnerSay(PROJECT, '今の状況を教えて', undefined, h.deps)
    expect(h.writes).toEqual(['今の状況を教えて'])
  })

  it('the note itself fits one paste, is one line, and states the three obligations', () => {
    expect(SUPPLY_RESUME_NOTE.length).toBeLessThan(200)
    expect(SUPPLY_RESUME_NOTE).not.toMatch(/[\r\n]/)
    expect(SUPPLY_RESUME_NOTE).toContain('Board')
    expect(SUPPLY_RESUME_NOTE).toContain('SKILL.md')
    expect(SUPPLY_RESUME_NOTE).toContain('再実行しない')
  })
})

describe('the context cap waits for the first delivery too', () => {
  const capDeps = (sent: string[]) => ({
    desks: () => [{ id: DESK, cwd: PROJECT, agentSessionId: 'sid-big' }],
    isAlive: () => true,
    contextTokens: async () => 400_000,
    cap: async () => 300_000,
    screen: () => frame(''),
    sendCompact: (id: string) => {
      sent.push(id)
      return true
    },
    log: () => {},
    now: () => 0,
  })

  it('a quiet desk is not compacted (a compaction is a full turn) until it has been spoken to', async () => {
    const sent: string[] = []
    owePresidentResumeNote(DESK)
    await runSupplyContextCapPass(capDeps(sent))
    expect(sent).toEqual([])
    const h = harness()
    await queueSupplyOwnerSay(PROJECT, 'こんにちは', undefined, h.deps)
    await runSupplyContextCapPass(capDeps(sent))
    expect(sent).toEqual([DESK])
  })

  // Review B-S5 (2026-11-28): the owner talks to the president by typing in its
  // seat or through Remote Control — neither goes through the app's delivery, so
  // the owed note was never cleared and the cap skipped the desk for good, while
  // its context grew to the native auto-compact point (~950k). The desk's own
  // transcript is the signal every path shares: a turn moves its fill.
  it('a quiet desk spoken to outside the app (its own seat, Remote Control) is compacted once its transcript shows a turn', async () => {
    const sent: string[] = []
    let fill = 400_000
    const deps = { ...capDeps(sent), contextTokens: async () => fill }
    owePresidentResumeNote(DESK)
    await runSupplyContextCapPass(deps)
    await runSupplyContextCapPass(deps)
    expect(sent, 'no turn yet: a waiting desk costs nothing').toEqual([])
    fill = 412_000 // the owner typed into the seat; the desk answered
    await runSupplyContextCapPass(deps)
    expect(sent).toEqual([DESK])
    // The note is not what gates the cap; it still rides the app's next line.
    expect(presidentResumeNoteOwed(DESK)).toBe(true)
  })

  it('an unreadable fill is no baseline: a read that fails and then succeeds is not a turn', async () => {
    const sent: string[] = []
    let fill: number | null = null
    const deps = { ...capDeps(sent), contextTokens: async () => fill }
    owePresidentResumeNote(DESK)
    await runSupplyContextCapPass(deps)
    fill = 400_000
    await runSupplyContextCapPass(deps)
    expect(sent, 'the first readable fill is the baseline').toEqual([])
    fill = 405_000
    await runSupplyContextCapPass(deps)
    expect(sent).toEqual([DESK])
  })
})

// The same engine line typed TWICE into a president's input box, then left
// unsent (owner reports 2026-11-20 openground-ec and 2026-11-23 OPEN GROUND,
// both on 0.11.209).
//
// WHAT THE RECORDS SHOW (each project's engine-journal.jsonl, read 2026-11-23):
//   11-20 08:48:02.0 / 08:48:03.2    two cards dispatched by one engine pass
//         08:53:53  「社長の窓口への配達を5分保留中: 打ち込んだ行の Enter が通らない」
//   11-23 06:16:56.0 / 56.3 / 58.3   three cards dispatched by one engine pass
//         06:22:22   the same hold line
// One engine pass moved several cards, so supplyProgress.observeBoardProgress
// called queueSupplyProgress several times back to back — and each call starts
// its own flushSupplyNotices in the same tick.
//
// THE PATH. Each of those passes asked "is this desk free?", then AWAITED
// (automaticOperationAllowed, added 2026-11-06 in 5acd2982) before claiming the
// desk, so all of them went on to paste the same line. The re-read of the box
// right before a paste cannot stop the second one: claude paints a paste some
// ms after it is written, so the box still reads empty. Two copies in the box
// are not "only our line" (onlyOurPasteInBox), so no Enter was ever pressed —
// the doubling IS why the line stayed unsent.
//
// NOT THE CAUSE: Claude Code's own 「✔ Update installed · Restart to update」
// row, on screen both times. MEASURED 2026-11-23 on all ten live president
// desks (SSE replay → headless xterm → the server's readScreen): every one of
// them showed that row. It sits on its own row ABOVE the box's top rule, where
// no reader looks, and every idle desk read as box '' / deliverable. The frames
// below carry the row in that measured shape.
//
// RED MEASURED 2026-11-23 — see the note on each test.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  flushSupplyNotices,
  peekSupplyImportant,
  peekSupplyProgress,
  peekSupplyReplies,
  queueSupplyNotice,
  queueSupplyProgress,
  queueSupplyReply,
  resetSupplyNoticeState,
  SUPPLY_REPLY_PREFIX,
  SUPPLY_UNSENT_MAX_PASSES,
} from './supplyNotice'
import { resetSupplyContextCapState, runSupplyContextCapPass } from './supplyContextCap'
import { noticeHoldReason } from './deskDeliverable'
import { onlyOurPasteInBox } from './swarmEscalations'

// The policy read is the await the passes interleave on. Real unless a test
// holds it open, to queue something while a pass is waiting on it.
const policy = vi.hoisted(() => ({ hold: null as Promise<void> | null, deny: false }))
vi.mock('./automationPolicy', async (importOriginal) => {
  const real = await importOriginal<typeof import('./automationPolicy')>()
  return {
    ...real,
    automaticOperationAllowed: async (projectPath: string) => {
      if (policy.hold) await policy.hold
      if (policy.deny) return false
      return real.automaticOperationAllowed(projectPath)
    },
  }
})

const PROJECT = '/repo/alpha'
const DESK = 'term-president'
// The live shape (openground-ec's desk, 82 columns, 2026-11-23).
const RULE = '─'.repeat(82)
const UPDATE_ROW = `${' '.repeat(42)}✔ Update installed · Restart to update`
const box = (text: string) =>
  [
    '✻ Sautéed for 27s · done 5:48 PM',
    UPDATE_ROW,
    RULE,
    text ? `❯ ${text}` : '❯',
    RULE,
    '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent',
  ].join('\n')

/** A desk whose screen lags its input: what is written shows up only once
 *  some time has passed (any sleep) — the way a real TUI repaints. */
const laggyDesk = () => {
  const d = {
    writes: [] as string[],
    /** Every pasted text, in order. */
    pasted: [] as string[],
    content: '',
    painted: '',
    /** A paste lands in the box twice (stands in for the state the owner found). */
    doubles: false,
    givenUp: [] as string[],
  }
  const deps = {
    desks: () => [{ id: DESK, cwd: PROJECT }],
    foreignInput: () => ({ seq: 0, at: 0 }),
    screen: () => box(d.painted),
    write: (_id: string, data: string) => {
      if (data === '\r') {
        d.writes.push('ENTER')
        d.content = ''
      } else if (data.startsWith('\x1b[200~')) {
        const text = data.replace(/\x1b\[20[01]~/g, '')
        d.writes.push('PASTE')
        d.pasted.push(text)
        d.content += d.doubles ? text + text : text
      } else {
        d.writes.push(JSON.stringify(data)) // any other key — none is expected
      }
      return true
    },
    // A REAL short wait: a repaint takes longer than another pass's policy read,
    // which is what lets a second paste in before the first one shows.
    sleep: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      d.painted = d.content
    },
    onReplyExpired: () => {},
    onNoticeGivenUp: (_project: string, line: string) => {
      d.givenUp.push(line)
    },
    openQuestions: async () => [],
    log: () => {},
  }
  return { d, deps }
}

beforeEach(() => {
  policy.hold = null
  policy.deny = false
  resetSupplyNoticeState()
  resetSupplyContextCapState()
})

describe("Claude Code's own update row above the input box", () => {
  it('changes nothing about how the box reads', () => {
    const line = '【エンジンからの知らせ】進捗: 「A」に取りかかりました (自動の進捗。オーナーに1〜2行で短く。質問しない)'
    expect(noticeHoldReason(box(''))).toBeNull()
    expect(onlyOurPasteInBox(box(line), line)).toBe(true)
    // What the owner found: two copies. Not "only our line" — no Enter.
    expect(onlyOurPasteInBox(box(line + line), line)).toBe(false)
  })
})

describe('supply desk: passes started together', () => {
  // RED on the pre-fix file (origin/main 033720a7) — the owner's screenshot,
  // exactly: expected [ 'PASTE', 'PASTE' ] to deeply equal [ 'PASTE', 'ENTER' ].
  it('two cards moved by one engine pass: the progress line is typed once and submitted', async () => {
    const { d, deps } = laggyDesk()
    await Promise.all([
      queueSupplyProgress(PROJECT, '「A」に取りかかりました', deps),
      queueSupplyProgress(PROJECT, '「B」に取りかかりました', deps),
    ])
    expect(d.writes).toEqual(['PASTE', 'ENTER'])
    expect(d.pasted[0]).toContain('「A」に取りかかりました / 「B」に取りかかりました')
    expect(peekSupplyProgress().size).toBe(0)
  })

  // The 11-23 shape: waiting important notices, told as ONE bundle.
  // RED on the pre-fix file: the same — two PASTE writes of one bundle, no ENTER.
  it('two important notices queued together: one bundle, typed once and submitted', async () => {
    const { d, deps } = laggyDesk()
    await Promise.all([
      queueSupplyNotice(PROJECT, '「A」が途中で止まり、保留になりました。', deps),
      queueSupplyNotice(PROJECT, '「B」が途中で止まり、保留になりました。', deps),
    ])
    expect(d.writes).toEqual(['PASTE', 'ENTER'])
    expect(d.pasted[0]).toContain('(2件まとめて)')
    expect(peekSupplyImportant().size).toBe(0)
  })

  // A news pass reads the policy BEFORE it claims the desk, so a reply queued
  // meanwhile takes the desk in its own pass; the news follows once it is free.
  // RED with the desk claimed before that read and the lanes read before it
  // (2026-11-23 WIP): expected '【エンジンからの知らせ】進捗: …' to contain
  // '【司令官からの返事】' (the news went first). RED on the pre-fix file too:
  // both lines typed into one box, the reply left queued.
  it('a reply queued while a news pass waits on the policy read goes out first; the news follows', async () => {
    const { d, deps } = laggyDesk()
    let open: () => void = () => {}
    policy.hold = new Promise<void>((resolve) => {
      open = resolve
    })
    const news = queueSupplyProgress(PROJECT, '「A」に取りかかりました', deps)
    const reply = queueSupplyReply(PROJECT, '入れて大丈夫です', deps)
    policy.hold = null
    open()
    await Promise.all([news, reply])
    expect(d.pasted[0]).toContain(SUPPLY_REPLY_PREFIX)
    expect(peekSupplyReplies().size).toBe(0)
    await flushSupplyNotices(deps) // the news, if its pass found the desk taken
    expect(d.writes).toEqual(['PASTE', 'ENTER', 'PASTE', 'ENTER'])
    expect(peekSupplyProgress().size).toBe(0)
  })

  // `/compact` starts with a line-kill (claudeSlash). Its pass rides the same
  // timer tick as a delivery pass and, like a second delivery, reads a box
  // that does not show the paste yet.
  // RED without the in-flight check in supplyContextCap:
  // expected [ 'term-president' ] to deeply equal [].
  it('the desk compaction is not typed over a notice that is still being typed', async () => {
    const { d, deps } = laggyDesk()
    const compactions: string[] = []
    const cap = {
      desks: () => [{ id: DESK, cwd: PROJECT, agentSessionId: 'president-sid' }],
      isAlive: () => true,
      contextTokens: async () => 900_000,
      cap: async () => 300_000,
      screen: deps.screen,
      sendCompact: (id: string) => {
        compactions.push(id)
        return true
      },
      log: () => {},
      now: () => 1_000_000,
    }
    const whileTyping = {
      ...deps,
      // Between a write and its repaint: exactly when the other channel looks.
      sleep: async () => {
        await runSupplyContextCapPass(cap)
        await deps.sleep()
      },
    }
    await queueSupplyProgress(PROJECT, '「A」に取りかかりました', whileTyping)
    expect(compactions).toEqual([])
    expect(d.writes).toEqual(['PASTE', 'ENTER'])
    // The desk is free again: the compaction goes out on its own pass.
    await runSupplyContextCapPass(cap)
    expect(compactions).toEqual([DESK])
  })
})

describe('supply desk: a pass reading the policy does not hold the desk', () => {
  // Every pass reads the policy for every live desk while anything at all is
  // queued, and a line the policy refuses (news for a project outside the
  // automation frame) waits for good — important lines never expire. A desk
  // claimed through that read was "in flight" to the compaction pass on the
  // same 60 s tick, every tick: the context cap could be put off for good
  // (adversarial review 2026-11-24 — 10 modelled ticks, 0 compactions).
  // RED with the claim taken before the policy read (2026-11-23 WIP):
  // expected [] to deeply equal [ 'term-president' ].
  it('a line the policy keeps waiting does not hold off the compaction of its desk', async () => {
    const { d, deps } = laggyDesk()
    const compactions: string[] = []
    const cap = {
      desks: () => [{ id: DESK, cwd: PROJECT, agentSessionId: 'president-sid' }],
      isAlive: () => true,
      contextTokens: async () => 900_000,
      cap: async () => 300_000,
      screen: () => box(''),
      sendCompact: (id: string) => {
        compactions.push(id)
        return true
      },
      log: () => {},
      now: () => 1_000_000,
    }
    policy.deny = true
    let open: () => void = () => {}
    policy.hold = new Promise<void>((resolve) => {
      open = resolve
    })
    const news = queueSupplyNotice(PROJECT, '「B」が途中で止まり、保留になりました。', deps)
    await runSupplyContextCapPass(cap) // while that pass waits on the policy read
    policy.hold = null
    open()
    await news
    expect(compactions).toEqual([DESK])
    expect(d.writes).toEqual([]) // refused: nothing typed
    expect(peekSupplyImportant().get(PROJECT)).toHaveLength(1) // and nothing dropped
  })
})

describe('supply desk: a typed line is always tracked', () => {
  // A throw after the paste skipped the unsent record: the line sat in the box
  // untracked and was never offered its Enter again.
  // RED without the `.catch(() => false)` on injectAnswerIntoWorker (supplyNotice.ts):
  // expected [ 'PASTE', 'ENTER' ] to deeply equal [ 'PASTE', 'ENTER', 'ENTER' ].
  it('a paste whose Enter write throws: the next pass sends only the Enter', async () => {
    const { d, deps } = laggyDesk()
    let failOnce = true
    const throwing = {
      ...deps,
      write: (id: string, data: string) => {
        if (data === '\r' && failOnce) {
          failOnce = false
          d.writes.push('ENTER')
          throw new Error('pty write failed')
        }
        return deps.write(id, data)
      },
    }
    await queueSupplyProgress(PROJECT, '「A」に取りかかりました', throwing)
    expect(peekSupplyProgress().size).toBe(1)
    await flushSupplyNotices(throwing)
    expect(d.writes).toEqual(['PASTE', 'ENTER', 'ENTER'])
    expect(peekSupplyProgress().size).toBe(0)
  })
})

describe('supply desk: a box found holding two copies of our line', () => {
  it('is never sent or erased by the app; the bell rings once; later news waits and is told after the owner sends the box', async () => {
    const { d, deps } = laggyDesk()
    d.doubles = true
    await queueSupplyNotice(PROJECT, '「A」が途中で止まり、保留になりました。', deps)
    d.doubles = false
    await queueSupplyNotice(PROJECT, '「B」が途中で止まり、保留になりました。', deps)
    for (let i = 0; i < SUPPLY_UNSENT_MAX_PASSES * 2; i++) await flushSupplyNotices(deps)
    // One paste, and not one key after it: no Enter, nothing that erases.
    expect(d.writes).toEqual(['PASTE'])
    expect(d.content).toBe(d.pasted[0] + d.pasted[0])
    expect(d.givenUp).toHaveLength(1) // the owner is told the desk is stuck — once
    expect(peekSupplyImportant().get(PROJECT)).toHaveLength(2) // nothing dropped
    // The owner presses Enter themselves.
    d.content = ''
    d.painted = ''
    await flushSupplyNotices(deps) // the box read empty: the first line left it
    await flushSupplyNotices(deps) // the desk takes the next line
    expect(d.writes).toEqual(['PASTE', 'PASTE', 'ENTER'])
    expect(d.pasted[1]).toContain('「B」が途中で止まり、保留になりました。')
    expect(peekSupplyImportant().size).toBe(0)
  })
})

// A long line pasted into a SHORT president desk sat in the input box unsent
// (owner report 2026-09-26). Claude Code caps the rows its input box draws and
// scrolls a taller input to its END, so the box showed only the line's tail —
// and the Enter guard, which demanded the box equal the WHOLE line, never
// pressed Enter. Measured on real claude with scripts/probe-supply-delivery.mts:
// 473 chars at 93x16 and 93x24, 373 at 93x10 stuck; 120x32 (where the 09-23 fix
// was measured) delivered. The earlier tests stayed green because every frame
// they draw shows the whole payload.
//
// Second hole, same symptom from the owner's side (nothing arrives): the queue
// key and the desk's cwd were compared letter-for-letter, and the Kickstand desk
// runs in `…/kickstand` while its commander replies for `…/Kickstand`.
//
// RED MEASURED 2026-09-26 (production reverted by hand, then restored): with
// onlyOurPasteInBox back to exact equality, "delivers a long reply…" fails (no
// Enter, reply still queued); with deskKey back to plain `resolve`, the
// case test fails (reply still queued); without the pre-paste re-read, "does
// not paste over…" fails; without the Ctrl+A head check, "owner text typed
// just before the paste" fails; with APP_WIDE fed through realpath/resolve,
// the restart test fails.
import { mkdtempSync, existsSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { openGroundHome } from './paths'
import {
  flushSupplyNotices,
  peekSupplyImportant,
  peekSupplyReplies,
  queueSupplyOwnerSay,
  queueSupplyReply,
  resetSupplyNoticeState,
  supplyReplyLine,
} from './supplyNotice'
import { injectAnswerIntoWorker, onlyOurPasteInBox, SCROLLED_TAIL_MIN, submitPastedInput } from './swarmEscalations'
import { conversationRows, readInputBoxText } from '../claudeScreen'
import { detectMenu } from '../claudeMenu'
import { terminalForeignInput, writeDeliveryInput, writeInput } from './terminal'

const PROJECT = '/repo/alpha'
const DESK = 'term-president'
const RULE = '─'.repeat(40)
const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
const box = (text: string) => `⏺ hi\n\n${RULE}\n❯ ${text}\n${RULE}\n${FOOTER}`
const instant = async (): Promise<void> => {}
const REPLY = '確認しました。'.repeat(40) + '終わりです。'

/** A short desk: once text is in, the box shows only its last 60 chars — or
 *  its first 60 after Ctrl+A, until Ctrl+E — the way claude scrolls a tall
 *  input (measured on real claude). `content` may be preset: text the owner
 *  typed that the screen had not painted when we last looked. */
const shortDesk = (cwd = PROJECT, content: string | null = null) => {
  const writes: string[] = []
  let atStart = false
  const keys: Record<string, string> = { '\r': 'ENTER', '\x01': 'HOME', '\x05': 'END' }
  // The server's record of input that did not come from a delivery.
  const fi = { seq: 0, at: 0 }
  let keyDuringCursorMove = false
  return {
    writes,
    /** The owner presses a key while we are between Ctrl+A and Enter. */
    ownerTypesDuringCheck: () => {
      keyDuringCursorMove = true
    },
    deps: {
      desks: () => [{ id: DESK, cwd }],
      foreignInput: () => fi,
      screen: () => (content === null || writes.length === 0 ? box('') : box(atStart ? content.slice(0, 60) : content.slice(-60))),
      write: (_id: string, data: string) => {
        writes.push(keys[data] ?? 'PASTE')
        if (data === '\r') content = null
        else if (data === '\x01') atStart = true
        else if (data === '\x05') atStart = false
        else content = `${content ?? ''}${data.replace(/\x1b\[20[01]~/g, '')}`
        return true
      },
      sleep: async () => {
        if (keyDuringCursorMove && writes[writes.length - 1] === 'HOME') {
          keyDuringCursorMove = false
          fi.seq += 1 // a key, not painted (the screen still shows only our line)
        }
      },
      onReplyExpired: () => {},
      onNoticeGivenUp: () => {},
      openQuestions: async () => [],
    },
  }
}

beforeEach(() => resetSupplyNoticeState())

describe('supply desk: a long line in a scrolled input box', () => {
  it('delivers a long reply whose box shows only its tail', async () => {
    const d = shortDesk()
    await queueSupplyReply(PROJECT, REPLY, d.deps)
    expect(d.writes).toEqual(['PASTE', 'HOME', 'END', 'ENTER'])
    expect(peekSupplyReplies().get(PROJECT) ?? []).toHaveLength(0)
  })

  it('owner text typed just before the paste (not yet painted) is never submitted', async () => {
    // The pre-paste re-read saw an empty box, but 「おーなー」 was already on its
    // way; the scrolled box then shows only our tail. Ctrl+A must expose it.
    const d = shortDesk(PROJECT, 'おーなー')
    await queueSupplyReply(PROJECT, REPLY, d.deps)
    expect(d.writes).not.toContain('ENTER')
    expect(d.writes[d.writes.length - 1]).toBe('END') // cursor handed back to the end
    expect(peekSupplyReplies().get(PROJECT) ?? []).toHaveLength(1) // still queued
  })

  it('the unsent re-press never submits an older line recalled into the box', async () => {
    const ours = '【司令官からの返事】' + '今日の作業は三件とも終わりました。'.repeat(8) + '(共通の結び)'
    const older = '【司令官からの返事】' + '昨日の話です。'.repeat(20) + '今日の作業は三件とも終わりました。'.repeat(5) + '(共通の結び)'
    let atStart = false
    const writes: string[] = []
    const ok = await submitPastedInput(DESK, ours, {
      write: (_id, d) => {
        writes.push(d)
        if (d === '\x01') atStart = true
        if (d === '\x05') atStart = false
        return true
      },
      sleep: instant,
      readScreen: () => box(atStart ? older.slice(0, 60) : older.slice(-60)),
      guardEnter: true,
      // Unchanged record: input that bypasses the PTY (the phone's Remote
      // Control) — only the head check can catch it.
      foreignInput: () => ({ seq: 0, at: 0 }),
      sinceSeq: 0,
    })
    expect(ok).toBe(false)
    expect(writes).not.toContain('\r')
    expect(writes[writes.length - 1]).toBe('\x05') // cursor handed back
  })

  it('a long line whose MIDDLE the owner edited is never pressed (head and tail still ours)', async () => {
    const ours = '【司令官からの返事】' + '一番目の段落です。'.repeat(10) + '二番目の段落です。'.repeat(10) + '三番目の段落です。'.repeat(10)
    const edited = ours.replace('二番目の段落です。二番目', '二番目の段落を直した。二番目')
    expect(edited).not.toBe(ours)
    let atStart = false
    const writes: string[] = []
    const ok = await submitPastedInput(DESK, ours, {
      write: (_id, d) => {
        writes.push(d)
        if (d === '\x01') atStart = true
        if (d === '\x05') atStart = false
        return true
      },
      sleep: instant,
      readScreen: () => box(atStart ? edited.slice(0, 60) : edited.slice(-60)),
      guardEnter: true,
      foreignInput: () => ({ seq: 3, at: 0 }), // the edit's keystrokes
      sinceSeq: 2,
    })
    expect(ok).toBe(false)
    expect(writes).not.toContain('\r')
  })

  it('a key pressed between Ctrl+A and Enter stops the Enter — this pass and every re-press', async () => {
    const d = shortDesk()
    d.ownerTypesDuringCheck()
    await queueSupplyReply(PROJECT, REPLY, d.deps)
    expect(d.writes).toEqual(['PASTE', 'HOME', 'END']) // no Enter, cursor back at the end
    expect(peekSupplyReplies().get(PROJECT) ?? []).toHaveLength(1) // kept, nothing erased
    await flushSupplyNotices(d.deps) // the unsent re-press
    expect(d.writes).not.toContain('ENTER')
    expect(d.writes.filter((w) => w === 'PASTE')).toHaveLength(1) // never re-typed
  })

  it('never presses Enter when the owner typed after the paste', () => {
    const payload = 'これは長い返事です。'.repeat(10)
    expect(onlyOurPasteInBox(box(payload.slice(-60)), payload)).toBe(true)
    expect(onlyOurPasteInBox(box(`${payload.slice(-60)}あ`), payload)).toBe(false)
    // A fragment too short to vouch for anything is not accepted.
    expect(onlyOurPasteInBox(box(payload.slice(-5)), payload)).toBe(false)
  })

  it('does not paste over text the owner typed since the last read', async () => {
    const writes: string[] = []
    const ok = await injectAnswerIntoWorker(DESK, REPLY, {
      write: (_id, d) => {
        writes.push(d)
        return true
      },
      sleep: instant,
      readScreen: () => box('社長への打ちかけ'),
      guardEnter: true,
    })
    expect(ok).toBe(false)
    expect(writes).toEqual([])
  })
})

describe('supply desk: the project path spelled in another letter case', () => {
  const root = mkdtempSync(join(tmpdir(), 'og-case-'))
  const real = join(root, 'Kickstand')
  mkdirSync(real)
  const lower = join(root, 'kickstand')
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it.skipIf(!existsSync(lower))('a reply for …/Kickstand reaches the desk opened at …/kickstand', async () => {
    const d = shortDesk(lower)
    await queueSupplyReply(real, '確認しました。', d.deps)
    expect(d.writes).toContain('ENTER')
    expect(Array.from(peekSupplyReplies().values()).flat()).toHaveLength(0)
  })
})

describe('supply desk: the app-wide lane survives a restart', () => {
  it('an app-wide notice saved to disk is delivered after a reload', async () => {
    writeFileSync(
      join(openGroundHome(), 'supply-notice-queue.json'),
      JSON.stringify({ version: 1, queues: [['*app-wide*', [{ text: 'アプリ全体のお知らせです', at: Date.now() }]]] }),
    )
    resetSupplyNoticeState({ keepDisk: true })
    expect(Array.from(peekSupplyImportant().keys())).toEqual(['*app-wide*'])
    const d = shortDesk()
    await flushSupplyNotices(d.deps)
    expect(d.writes[0]).toBe('PASTE')
    expect(d.writes).toContain('ENTER')
  })
})

describe('terminal: the foreign-input record', () => {
  it('counts every writeInput (the owner, the UI, slash commands) and never a delivery write', () => {
    const pool = (globalThis as { __openground_terminal?: { sessions: Map<string, unknown> } }).__openground_terminal!
    const bytes: string[] = []
    pool.sessions.set('fi-desk', {
      info: { id: 'fi-desk', cwd: '/p', shell: '/bin/zsh', cols: 80, rows: 24, startedAt: new Date().toISOString(), tag: 'claude' },
      pty: { write: (d: string) => void bytes.push(d) },
      buffer: '',
      listeners: new Set(),
      exitListeners: new Set(),
    })
    try {
      expect(terminalForeignInput('fi-desk')).toEqual({ seq: 0, at: 0 })
      writeDeliveryInput('fi-desk', 'paste')
      expect(terminalForeignInput('fi-desk')?.seq).toBe(0)
      writeInput('fi-desk', 'a')
      expect(terminalForeignInput('fi-desk')?.seq).toBe(1)
      expect(bytes).toEqual(['paste', 'a'])
      expect(terminalForeignInput('no-such')).toBeNull()
    } finally {
      pool.sessions.delete('fi-desk')
    }
  })

  // Measured 2026-11-24 on every live president desk (scripts/probe-desk-focus-mode.mts):
  // claude 2.1.330 turns focus reporting on, and a pane opened on a desk answers
  // the device-attributes query in its replay. Neither touches the input box.
  // RED with writeInput counting every write: expected 4 to be +0.
  it("does not count what a pane sends by itself — focus in/out, a device-attributes reply — but counts every key", () => {
    const pool = (globalThis as { __openground_terminal?: { sessions: Map<string, unknown> } }).__openground_terminal!
    const bytes: string[] = []
    pool.sessions.set('fi-desk', {
      info: { id: 'fi-desk', cwd: '/p', shell: '/bin/zsh', cols: 80, rows: 24, startedAt: new Date().toISOString(), tag: 'claude' },
      pty: { write: (d: string) => void bytes.push(d) },
      buffer: '',
      listeners: new Set(),
      exitListeners: new Set(),
    })
    try {
      for (const report of ['\x1b[I', '\x1b[O', '\x1b[?1;2c', '\x1b[>0;276;0c']) writeInput('fi-desk', report)
      expect(terminalForeignInput('fi-desk')?.seq).toBe(0)
      writeInput('fi-desk', '\x1b[A') // Up: recalls an older line into the box
      writeInput('fi-desk', '\x1b[Ix') // a report and a key in one write
      expect(terminalForeignInput('fi-desk')?.seq).toBe(2)
      expect(bytes).toHaveLength(6) // every byte still reaches claude
    } finally {
      pool.sessions.delete('fi-desk')
    }
  })
})

// The 2026-11-23 layout — claude 2.1.330, measured at a president's real 58x29
// with scripts/probe-scrolled-box-frames.mts. A box taller than the 9 rows it
// shows now carries its scroll state IN its rules, and while the view is at the
// end its own `❯` row is out of view: the last `❯` on screen is the turn the
// owner submitted before. The app's reader anchored on that `❯`, read the
// conversation as the box, and no line that overflowed the box was ever
// submitted — JobSearch's president held a commander reply (330 chars, 58
// columns) from 07:53 to 10:09 UTC, journal: 「打ち込んだ行の Enter が通らない」.
// RED MEASURED 2026-11-23 with RULE_ROW_RE / readInputBoxText / inputBoxStart /
// detectMenu as on origin/main 033720a7: the delivery stops at ['PASTE'] and
// every reader assertion below fails.
describe('supply desk: claude 2.1.330 scrolled box (rules carry ↑/↓ N more, the box `❯` scrolls out)', () => {
  const W = 27 // full-width chars per row at 58 columns
  const SHOWN = 9
  const RULE58 = '─'.repeat(58)
  const FOOT = '  ⏵⏵ auto mode on (shift+tab to cycle)'
  const ABOVE = ['❯ Reply with just the word hi.', '', '⏺ hi', '', '✻ Brewed for 1s · done 10:01 PM', '']
  const wrap = (t: string): string[] => {
    const out: string[] = []
    for (let i = 0; i < t.length; i += W) out.push(t.slice(i, i + W))
    return out.length ? out : ['']
  }
  /** The frame claude 2.1.330 draws for `text` in the box — view at the END
   *  (after a paste / Ctrl+E) or at the START (after Ctrl+A). */
  const frame = (text: string, atStart = false, above = ABOVE): string => {
    const rows = wrap(text)
    const hidden = rows.length - SHOWN
    if (hidden <= 0) return [...above, RULE58, `❯ ${rows[0]}`, ...rows.slice(1).map((r) => `  ${r}`), RULE58, FOOT].join('\n')
    if (atStart) {
      const tail = rows.slice(1, SHOWN).map((r) => `  ${r}`)
      return [...above, RULE58, `❯ ${rows[0]}`, ...tail, `─── ↓ ${hidden} more ${'─'.repeat(45)}`, FOOT].join('\n')
    }
    const tail = rows.slice(hidden).map((r) => `  ${r}`)
    return [...above, `─── ↑ ${hidden} more ${'─'.repeat(45)}`, ...tail, RULE58, FOOT].join('\n')
  }
  const squash = (t: string): string => t.replace(/\s+/g, '')
  // The stuck JobSearch reply's shape: one paragraph, ~280-330 chars, 58 columns.
  const SUMMARY = 'サンプル2のスマホレビューを再開しました。' + '途中までの直しと検査の道具を引き継いでいます。'.repeat(8)
  const LONG = supplyReplyLine(SUMMARY)

  it('reads the rows in view as the box — never the turn above it, the ↓ rule or the footer', () => {
    const tailView = frame(LONG)
    const headView = frame(LONG, true)
    const tail = squash(readInputBoxText(tailView) ?? '')
    const head = squash(readInputBoxText(headView) ?? '')
    expect(tail.length).toBeGreaterThan(SCROLLED_TAIL_MIN)
    expect(squash(LONG).endsWith(tail)).toBe(true)
    expect(head.length).toBeGreaterThan(SCROLLED_TAIL_MIN)
    expect(squash(LONG).startsWith(head)).toBe(true)
    expect(readInputBoxText(frame(''))).toBe('')
    // The rule in view and nothing under it: unreadable, never "empty".
    expect(readInputBoxText([...ABOVE, `─── ↑ 3 more ${'─'.repeat(45)}`].join('\n'))).toBeNull()
    // What claude said above the box is conversation; the box is not (else the
    // quota sensor reads our own line as claude's words). RED with inputBoxStart
    // cutting nothing for a scrolled box (adversarial review 2026-11-24).
    const conversation = conversationRows(tailView)
    expect(conversation).toContain('⏺ hi')
    expect(conversation.join('\n')).not.toMatch(/more|引き継/)
  })

  it('a numbered turn above a scrolled box is not read as an open menu', () => {
    const above = ['❯ 1. 先にこちらをお願いします', '  2. そのあとで報告してください', '', '⏺ はい', '']
    expect(detectMenu(frame(LONG, false, above))).toBeNull()
    expect(onlyOurPasteInBox(frame(LONG, false, above), LONG)).toBe(true)
  })

  it('delivers a long reply: paste, Ctrl+A, Ctrl+E, Enter', async () => {
    let content: string | null = null
    let atStart = false
    const writes: string[] = []
    const keys: Record<string, string> = { '\r': 'ENTER', '\x01': 'HOME', '\x05': 'END' }
    const deps = {
      desks: () => [{ id: DESK, cwd: PROJECT }],
      foreignInput: () => ({ seq: 0, at: 0 }),
      screen: () => frame(content ?? '', atStart),
      write: (_id: string, data: string) => {
        writes.push(keys[data] ?? 'PASTE')
        if (data === '\r') content = null
        else if (data === '\x01') atStart = true
        else if (data === '\x05') atStart = false
        else content = `${content ?? ''}${data.replace(/\x1b\[20[01]~/g, '')}`
        return true
      },
      sleep: instant,
      onReplyExpired: () => {},
      onNoticeGivenUp: () => {},
      openQuestions: async () => [],
    }
    await queueSupplyReply(PROJECT, SUMMARY, deps)
    expect(writes).toEqual(['PASTE', 'HOME', 'END', 'ENTER'])
    expect(peekSupplyReplies().get(PROJECT) ?? []).toHaveLength(0)
  })

  // The unsent record's foreign-input seq was read BEFORE the awaits ahead of
  // the paste (an owner line's prepare step, the news policy read). A key that
  // reached the desk during them — long enough before the paste that the paste
  // still went ahead — left it stale, and every re-press of a scrolled box then
  // refused ("not untouched since the paste"): the line sat there for good.
  // RED with the seq read moved back above those awaits (supplyNotice.ts):
  // expected [ 'PASTE', 'HOME', 'END', 'ENTER' ] to deeply equal [ …, 'HOME', 'END', 'ENTER' ].
  it('a long line whose first Enter failed is re-pressed even if a key arrived while it was being prepared', async () => {
    let content: string | null = null
    let atStart = false
    let failEnter = true
    let heard: boolean | null = null
    const writes: string[] = []
    const keys: Record<string, string> = { '\r': 'ENTER', '\x01': 'HOME', '\x05': 'END' }
    const fi = { seq: 0, at: 0 }
    const deps = {
      desks: () => [{ id: DESK, cwd: PROJECT }],
      foreignInput: () => ({ ...fi }),
      screen: () => frame(content ?? '', atStart),
      write: (_id: string, data: string) => {
        writes.push(keys[data] ?? 'PASTE')
        if (data === '\r') {
          if (failEnter) {
            failEnter = false
            throw new Error('pty write failed')
          }
          content = null
        } else if (data === '\x01') atStart = true
        else if (data === '\x05') atStart = false
        else content = `${content ?? ''}${data.replace(/\x1b\[20[01]~/g, '')}`
        return true
      },
      sleep: instant,
      onReplyExpired: () => {},
      onNoticeGivenUp: () => {},
      openQuestions: async () => [],
    }
    const waiting = await queueSupplyOwnerSay(PROJECT, 'オーナーからの長いお願いです。'.repeat(20), (h) => { heard = h }, deps, {
      beforeSend: async () => {
        fi.seq++ // a key reached the desk while the line was being prepared
      },
    })
    expect(waiting).toBe(1)
    expect(writes).toEqual(['PASTE', 'HOME', 'END', 'ENTER'])
    await flushSupplyNotices(deps)
    expect(writes).toEqual(['PASTE', 'HOME', 'END', 'ENTER', 'HOME', 'END', 'ENTER'])
    expect(heard).toBe(true)
  })

  // The same desk through the REAL foreign-input record: after one failed Enter
  // the owner clicks into the pane and out again, and a second window opens on
  // the desk (its replay answers claude's device-attributes query). Counted as
  // foreign input, these kept the line from ever being pressed again.
  // RED with writeInput counting every write: expected [ 'PASTE', 'HOME', 'END', 'ENTER' ]
  // to deeply equal [ …, 'HOME', 'END', 'ENTER' ].
  it('a long line is re-pressed after the owner clicked into and out of the pane', async () => {
    const pool = (globalThis as { __openground_terminal?: { sessions: Map<string, unknown> } }).__openground_terminal!
    pool.sessions.set('fi-desk', {
      info: { id: 'fi-desk', cwd: PROJECT, shell: '/bin/zsh', cols: 58, rows: 29, startedAt: new Date().toISOString(), tag: 'claude' },
      pty: { write: () => {} },
      buffer: '',
      listeners: new Set(),
      exitListeners: new Set(),
    })
    let content: string | null = null
    let atStart = false
    let failEnter = true
    const writes: string[] = []
    const keys: Record<string, string> = { '\r': 'ENTER', '\x01': 'HOME', '\x05': 'END' }
    const deps = {
      desks: () => [{ id: 'fi-desk', cwd: PROJECT }],
      foreignInput: terminalForeignInput,
      screen: () => frame(content ?? '', atStart),
      write: (id: string, data: string) => {
        writes.push(keys[data] ?? 'PASTE')
        if (data === '\r') {
          if (failEnter) {
            failEnter = false
            throw new Error('pty write failed')
          }
          content = null
        } else if (data === '\x01') atStart = true
        else if (data === '\x05') atStart = false
        else content = `${content ?? ''}${data.replace(/\x1b\[20[01]~/g, '')}`
        return writeDeliveryInput(id, data)
      },
      sleep: instant,
      onReplyExpired: () => {},
      onNoticeGivenUp: () => {},
      openQuestions: async () => [],
    }
    try {
      expect(await queueSupplyReply(PROJECT, SUMMARY, deps)).toBe(1)
      expect(writes).toEqual(['PASTE', 'HOME', 'END', 'ENTER'])
      for (const report of ['\x1b[I', '\x1b[O', '\x1b[?1;2c']) writeInput('fi-desk', report)
      await flushSupplyNotices(deps)
      expect(writes).toEqual(['PASTE', 'HOME', 'END', 'ENTER', 'HOME', 'END', 'ENTER'])
      expect(peekSupplyReplies().get(PROJECT) ?? []).toHaveLength(0)
    } finally {
      pool.sessions.delete('fi-desk')
    }
  })
})

// The president's desk showed claude's PROMPT SUGGESTION — dim ghost text such
// as 「❯ いまどう？」 in the EMPTY input box — and the plain-text screen read it as
// the owner's half-typed message. Every notice for that desk was then held
// forever (owner report 2026-09-24: two deliveries and a commander reply never
// reached the president; live desk read with scripts/peek-desk.mts showed
// inputBoxText "いまどう？" rendered dim, and the queue file still held them).
//
// These frames go through a REAL headless xterm and the server's own readScreen,
// because the difference is only in the cell attributes — a string literal
// cannot show it.
//
// RED MEASURED 2026-09-24 (terminal.ts readScreen's ghost strip reverted by
// hand, then restored): "delivers to a desk whose empty box shows a suggestion"
// and "a line that landed … is not given up" both fail — the notice stays queued
// / is handed to the bell as unsent, exactly the two production symptoms.
import { beforeEach, describe, expect, it } from 'vitest'
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import { readScreen } from './terminal'
import { readInputBoxText } from '@/lib/claudeScreen'
import {
  flushSupplyNotices,
  peekSupplyImportant,
  queueSupplyNotice,
  resetSupplyNoticeState,
  SUPPLY_UNSENT_MAX_PASSES,
} from './supplyNotice'

const PROJECT = '/repo/alpha'
const DESK = 'term-president'
const RULE = '─'.repeat(40)
const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
const DIM = (s: string) => `\x1b[2m${s}\x1b[22m`

/** Render a desk frame whose input box holds `box` (raw bytes, SGR allowed). */
const render = async (box: string, extra: string[] = [], cols = 80): Promise<string> => {
  const t = new HeadlessTerminal({ cols, rows: 10, allowProposedApi: true })
  const bytes = ['⏺ 読み直しました。', '', RULE, `❯ ${box}`, ...extra, RULE, FOOTER].join('\r\n')
  await new Promise<void>((r) => t.write(bytes, r))
  const s = readScreen(t)
  t.dispose()
  return s
}

const instant = async (): Promise<void> => {}

beforeEach(() => resetSupplyNoticeState())

describe('supply notice vs claude\'s prompt-suggestion ghost text', () => {
  it('reads an all-dim suggestion as an EMPTY box, but keeps typed text', async () => {
    const ghost = await render(DIM('いまどう？'))
    expect(ghost.split('\n')[3].trim()).toBe('❯')
    const typed = await render('いまどう？')
    expect(typed).toContain('いまどう？')
    // Typed text followed by a dim completion is the owner typing — kept whole.
    const typing = await render(`/comp${DIM('act')}`)
    expect(typing).toContain('/compact')
  })

  // Review 2026-09-24 (#3–#5). RED MEASURED: the menu-row exclusion removed →
  // the menu test fails; the `isWrapped` requirement put back → the two-row test
  // fails; inverse cells counted → the cursor test fails.
  it('never touches a menu cursor row, even a dim one', async () => {
    expect(await render(DIM('1. Yes'))).toContain('1. Yes')
  })

  it('drops a suggestion claude wrapped over two rows itself (narrow pane)', async () => {
    const s = await render(DIM('いまどう？'), [`  ${DIM('続きの行')}`], 40)
    expect(readInputBoxText(s)).toBe('')
    expect(s).toContain('bypass permissions') // the footer below the rule is still read
  })

  it('drops a suggestion whose first character carries the (inverse) cursor', async () => {
    const s = await render(`\x1b[7mい\x1b[27m${DIM('まどう？')}`)
    expect(s.split('\n')[3].trim()).toBe('❯')
  })

  /** A desk: `before` until we paste, our line while it sits in the box, `after` once Enter lands it. */
  const desk = (before: string, after: string, bells: string[] = []) => {
    let state: 'before' | 'after' | string = 'before'
    return {
      desks: () => [{ id: DESK, cwd: PROJECT }],
      screen: () => (state === 'before' ? before : state === 'after' ? after : `${RULE}\n\u276f ${state}\n${RULE}\n${FOOTER}`),
      write: (_id: string, data: string) => {
        state = data === '\r' ? 'after' : data.replace(/\x1b\[20[01]~/g, '')
        return true
      },
      sleep: instant,
      onNoticeGivenUp: (_p: string, l: string) => void bells.push(l),
    }
  }

  it('delivers to a desk whose empty box shows a suggestion', async () => {
    const deps = desk(await render(DIM('\u3044\u307e\u3069\u3046\uff1f')), await render(''))
    await queueSupplyNotice(PROJECT, '\u304a\u9858\u3044\u3055\u308c\u3066\u3044\u305f\u4f5c\u696d\u304c\u53d6\u308a\u8fbc\u307e\u308c\u307e\u3057\u305f', deps)
    expect(peekSupplyImportant().get(PROJECT) ?? []).toHaveLength(0)
  })

  it('a line that landed and left a suggestion behind is not given up as unsent', async () => {
    // The Enter lands the line and claude refills the box with a suggestion. The
    // landing check must read that as "the box emptied" — or the line is left
    // "unsent", retried, and finally given up to the bell (the 23:51Z
    // supply-notice-unsent of the 2026-09-24 report).
    const bells: string[] = []
    const deps = desk(await render(''), await render(DIM('\u72b6\u6cc1\u3092\u6559\u3048\u3066')), bells)
    await queueSupplyNotice(PROJECT, '\u4f5c\u696d\u304c1\u4ef6\u672c\u4f53\u306b\u5165\u308a\u307e\u3057\u305f', deps)
    for (let i = 0; i < SUPPLY_UNSENT_MAX_PASSES + 1; i++) await flushSupplyNotices(deps)
    expect(bells).toEqual([])
    expect(peekSupplyImportant().get(PROJECT) ?? []).toHaveLength(0)
  })
})

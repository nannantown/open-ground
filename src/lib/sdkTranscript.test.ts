// The pure half of the readable-transcript pane (0803).
//
// Proven RED against mutations (2026-08-03):
//   • result pairing removed (results always lone) → 2 red
//   • lane separation dropped (sub-agent results attach to main calls) → 1 red
//   • fence parsing removed → 2 red

import { describe, it, expect } from 'vitest'
import { groupSdkFrames, parseMarkdownBlocks, toolCardSummary, type SdkFrame } from './sdkTranscript'
import type { SdkEvent } from './server/sdkEvents'

const f = (seq: number, ev: SdkEvent): SdkFrame => ({ seq, ev })
const use = (name: string, detail = '', fromSubagent?: boolean): SdkEvent =>
  ({ kind: 'tool_use', name, detail, ...(fromSubagent ? { fromSubagent } : {}) }) as SdkEvent
const result = (head: string, ok = true, fromSubagent?: boolean): SdkEvent =>
  ({ kind: 'tool_result', ok, head, ...(fromSubagent ? { fromSubagent } : {}) }) as SdkEvent
const text = (t: string): SdkEvent => ({ kind: 'text', text: t })

describe('groupSdkFrames — one tool call, one card', () => {
  it('pairs a result with its call into a single card', () => {
    const items = groupSdkFrames([f(1, text('a')), f(2, use('Read', 'x.ts')), f(3, result('…contents'))])
    expect(items).toHaveLength(2)
    const card = items[1]
    expect(card.kind).toBe('tool')
    if (card.kind === 'tool') {
      expect(card.use.name).toBe('Read')
      expect(card.result?.head).toBe('…contents')
    }
  })

  it('pairs by NEAREST preceding unpaired call (two calls, two results, LIFO)', () => {
    const items = groupSdkFrames([
      f(1, use('Read', 'a.ts')),
      f(2, use('Bash', 'ls')),
      f(3, result('ls-out')),
      f(4, result('a-contents')),
    ])
    expect(items).toHaveLength(2)
    if (items[0].kind === 'tool' && items[1].kind === 'tool') {
      expect(items[1].use.name).toBe('Bash')
      expect(items[1].result?.head).toBe('ls-out')
      expect(items[0].use.name).toBe('Read')
      expect(items[0].result?.head).toBe('a-contents')
    } else {
      throw new Error('expected two tool cards')
    }
  })

  it("a SUB-AGENT's result never attaches to a MAIN call", () => {
    const items = groupSdkFrames([f(1, use('Task', 'reviewer')), f(2, result('sub says hi', true, true))])
    // The sub result has no sub call to attach to → stays a lone event.
    expect(items).toHaveLength(2)
    expect(items[0].kind).toBe('tool')
    if (items[0].kind === 'tool') expect(items[0].result).toBeNull()
    expect(items[1].kind).toBe('event')
  })

  it('an orphan result (call scrolled out of the ring) renders alone, never mis-attached', () => {
    const items = groupSdkFrames([f(1, text('…')), f(2, result('orphan'))])
    expect(items).toHaveLength(2)
    expect(items[1].kind).toBe('event')
  })
})

describe('parseMarkdownBlocks — the subset workers actually emit', () => {
  it('splits fences, headings, lists, and paragraphs', () => {
    const blocks = parseMarkdownBlocks(
      '## 結果\n本文です。\n\n- 一つ\n- 二つ\n\n```ts\nconst a = 1\n```\n締めの段落。',
    )
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'para', 'list', 'code', 'para'])
    const code = blocks[3]
    if (code.kind === 'code') {
      expect(code.lang).toBe('ts')
      expect(code.text).toBe('const a = 1')
    }
  })

  it('an UNCLOSED fence (streaming) swallows to the end as code — never a backtick paragraph', () => {
    const blocks = parseMarkdownBlocks('説明\n```\nline1\nline2')
    expect(blocks.map((b) => b.kind)).toEqual(['para', 'code'])
    if (blocks[1].kind === 'code') expect(blocks[1].text).toBe('line1\nline2')
  })

  it('numbered lists group as ordered', () => {
    const blocks = parseMarkdownBlocks('1. あ\n2. い')
    expect(blocks).toEqual([{ kind: 'list', ordered: true, items: ['あ', 'い'] }])
  })

  it('plain prose stays one paragraph with its newlines', () => {
    expect(parseMarkdownBlocks('一行目\n二行目')).toEqual([{ kind: 'para', text: '一行目\n二行目' }])
  })
})

describe('toolCardSummary', () => {
  it('clamps a huge detail so the row cannot stretch', () => {
    const s = toolCardSummary({ name: 'Bash', detail: 'x'.repeat(200) })
    expect(s.length).toBeLessThan(100)
    expect(s.endsWith('…')).toBe(true)
  })
})

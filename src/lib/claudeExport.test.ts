import { describe, it, expect } from 'vitest'
import {
  MAX_MESSAGE_CHARS,
  MIN_MESSAGE_CHARS,
  parseClaudeExport,
} from './claudeExport'

const conv = (over: Record<string, unknown> = {}) => ({
  uuid: 'c1',
  name: '価格の決め方',
  chat_messages: [
    { uuid: 'm1', sender: 'human', text: 'この機能は無料枠に入れたい。理由は初速。', created_at: '2026-08-01T00:00:00.000Z' },
    { uuid: 'm2', sender: 'assistant', text: 'なるほど、では段階的に…', created_at: '2026-08-01T00:01:00.000Z' },
  ],
  ...over,
})

describe('parseClaudeExport — only the owner speaks', () => {
  it('keeps the human messages and DROPS the assistant’s', () => {
    // The rule the Persona rests on: it holds what the OWNER thinks. Learning
    // from the model's replies would make the stand-in a copy of a copy, and
    // nothing downstream could ever tell the two apart again.
    const r = parseClaudeExport([conv()])
    expect(r.messages).toHaveLength(1)
    expect(r.messages[0].text).toContain('無料枠')
    expect(r.droppedNonOwner).toBe(1)
    // Provenance survives, so a distilled finding can be traced back.
    expect(r.messages[0].conversationId).toBe('c1')
    expect(r.messages[0].conversationName).toBe('価格の決め方')
    expect(r.messages[0].at).toBe('2026-08-01T00:00:00.000Z')
  })

  it('an UNKNOWN or missing sender is never treated as the owner', () => {
    // Fails closed: a row we cannot attribute must not become "the owner said".
    const r = parseClaudeExport([
      conv({
        chat_messages: [
          { sender: 'system', text: 'あなたは有能なアシスタントです。よろしく。' },
          { text: 'senderが無い行。これは誰の言葉か分からない。' },
          { sender: 'HUMAN', text: '大文字でも人間は人間として読む。ここは拾う。' },
        ],
      }),
    ])
    expect(r.messages.map((m) => m.text)).toEqual([
      '大文字でも人間は人間として読む。ここは拾う。',
    ])
    expect(r.droppedNonOwner).toBe(2)
  })

  it('reads the NEWER content-block shape as well as flat text', () => {
    const r = parseClaudeExport([
      conv({
        chat_messages: [
          {
            sender: 'human',
            content: [
              { type: 'text', text: '前半の考え。' },
              { type: 'image', source: {} },
              { type: 'text', text: '後半の考え。' },
            ],
          },
        ],
      }),
    ])
    expect(r.messages[0].text).toBe('前半の考え。\n後半の考え。')
  })
})

describe('parseClaudeExport — tolerant, but never quiet about it', () => {
  it('SKIPS what it cannot read and COUNTS it', () => {
    // A count nobody can see is the failure this repo keeps hitting: a smaller
    // number shown as if it were the whole truth.
    const r = parseClaudeExport([
      conv(),
      null,
      'not a conversation',
      { uuid: 'c2' }, // no chat_messages — unreadable, not "empty"
      { uuid: 'c3', chat_messages: [null, 42, { sender: 'human', text: 'これは読める行で、十分な長さがあります。' }] },
    ])
    expect(r.skipped).toBe(5) // null, string, c2, and c3's two junk rows
    expect(r.conversations).toBe(2) // c1 and c3 — c2 could not be read at all
    expect(r.messages).toHaveLength(2)
  })

  it('throws ONLY when the file is not an export at all', () => {
    // The one case where carrying on would mean inventing a result.
    for (const bad of [null, {}, 42, 'x']) {
      expect(() => parseClaudeExport(bad)).toThrow(/conversations export/)
    }
    // An empty export is a valid answer, not an error.
    expect(parseClaudeExport([])).toEqual({
      messages: [],
      conversations: 0,
      skipped: 0,
      droppedNonOwner: 0,
    })
  })

  it('drops messages too short to say anything about anyone', () => {
    const r = parseClaudeExport([
      conv({
        chat_messages: [
          { sender: 'human', text: 'ok' },
          { sender: 'human', text: 'ありがとう' },
          { sender: 'human', text: '   ' },
          { sender: 'human', text: 'x'.repeat(MIN_MESSAGE_CHARS) },
        ],
      }),
    ])
    expect(r.messages).toHaveLength(1)
    // …and a dropped SHORT message is not counted as unreadable: we read it
    // fine, it just says nothing.
    expect(r.skipped).toBe(0)
  })

  it('caps a pasted-file-sized message instead of carrying it forward whole', () => {
    const huge = 'あ'.repeat(MAX_MESSAGE_CHARS * 3)
    const r = parseClaudeExport([conv({ chat_messages: [{ sender: 'human', text: huge }] })])
    expect(r.messages[0].text).toHaveLength(MAX_MESSAGE_CHARS)
  })

  it('an unusable timestamp becomes empty, never a fabricated date', () => {
    const r = parseClaudeExport([
      conv({
        chat_messages: [
          { sender: 'human', text: '日付が壊れている行。読めるが日付は名乗れない。', created_at: 'yesterday' },
        ],
      }),
    ])
    expect(r.messages[0].at).toBe('')
  })
})

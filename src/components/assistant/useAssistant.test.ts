// Message states (docs/CHAT_SPEC.md §5b): which own lines show 未送信 / 返事なし.
import { describe, expect, it } from 'vitest'
import { FAILED_FOR_MS, FAILED_MAX, failedLines, type AssistantLine, type FailedLine } from './useAssistant'

const NOW = 1_800_000_000_000
const owner = (id: string, at: number, extra: Partial<AssistantLine> = {}): AssistantLine => ({ id, at, who: 'owner', text: id, ...extra })
const reply = (id: string, at: number): AssistantLine => ({ id, at, who: 'assistant', text: id })
const held = (key: string, at: number): FailedLine => ({ key, text: key, at, kind: 'notSent' })

describe('failedLines', () => {
  it('an owner line with no answer after it is 返事なし — whoever sent it; an answered one, a call record and an old one are not', () => {
    const lines = [
      owner('answered', NOW - 5000),
      reply('r', NOW - 4000),
      owner('lost', NOW - 3000, { clientId: 'phone-1' }),
      owner('call', NOW - 2500, { kind: 'call' }),
      owner('next', NOW - 2000),
      reply('r2', NOW - 1000),
      owner('old', NOW - FAILED_FOR_MS - 1),
    ]
    expect(failedLines(lines, [], NOW).map((f) => [f.key, f.kind, f.entryId])).toEqual([['lost', 'noReply', 'lost']])
  })

  it('a proposal button\'s line (the app\'s own) and a president\'s retold answer are not answers to the line before them', () => {
    const lines = [
      owner('asked', NOW - 3000),
      { ...reply('pressed', NOW - 2000), app: true },
      { ...reply('retold', NOW - 1000), president: { projectId: 'p', project: 'kiwi' } },
    ]
    expect(failedLines(lines, [], NOW).map((f) => f.key)).toEqual(['asked'])
  })

  it('a held line the log has after all (by clientId) is not shown twice', () => {
    const lines = [owner('o', NOW - 2000, { clientId: 'w1' }), reply('r', NOW - 1000)]
    expect(failedLines(lines, [held('w1', NOW - 2000), held('w2', NOW - 500)], NOW).map((f) => f.key)).toEqual(['w2'])
  })

  it(`at most ${FAILED_MAX}, newest kept, in time order; none older than a day`, () => {
    const h = Array.from({ length: 7 }, (_, i) => held(`h${i}`, NOW - 7000 + i * 1000))
    expect(failedLines([], [held('stale', NOW - FAILED_FOR_MS), ...h], NOW).map((f) => f.key)).toEqual(['h2', 'h3', 'h4', 'h5', 'h6'])
  })
})

import { describe, it, expect } from 'vitest'
import { parseResult, looseParse, extractThought } from './parseResult'

describe('parseResult — happy paths', () => {
  it('returns null for an empty log', () => {
    expect(parseResult('')).toBeNull()
  })

  it('returns null when no marker is present', () => {
    expect(parseResult('Claude said some things but never the marker.')).toBeNull()
  })

  it('parses a clean OPENGROUND_RESULT line', () => {
    const log = `Working on this…
OPENGROUND_RESULT: {"topic":"テスト","completed":["did the thing"],"skipped":[],"summary":"all good","blockers":"","taskComplete":true}`
    const r = parseResult(log)
    expect(r).not.toBeNull()
    expect(r?.topic).toBe('テスト')
    expect(r?.completed).toEqual(['did the thing'])
    expect(r?.taskComplete).toBe(true)
    expect(r?.summary).toBe('all good')
  })

  it('picks the LAST marker when multiple are emitted', () => {
    const log = `OPENGROUND_RESULT: {"topic":"old","summary":"first","completed":[],"skipped":[],"blockers":""}
… intervening text …
OPENGROUND_RESULT: {"topic":"new","summary":"final","completed":[],"skipped":[],"blockers":""}`
    expect(parseResult(log)?.topic).toBe('new')
  })
})

describe('parseResult — legacy markers', () => {
  it('accepts HOVE_RESULT (archived sessions)', () => {
    const log = `HOVE_RESULT: {"topic":"legacy","completed":[],"skipped":[],"summary":"x","blockers":"","taskComplete":false}`
    expect(parseResult(log)?.topic).toBe('legacy')
  })

  it('accepts PMMAP_RESULT (very-old archived sessions)', () => {
    const log = `PMMAP_RESULT: {"topic":"ancient","completed":[],"skipped":[],"summary":"y","blockers":"","taskComplete":false}`
    expect(parseResult(log)?.topic).toBe('ancient')
  })
})

describe('parseResult — defensive parsing', () => {
  it('tolerates a trailing character after the closing brace (period, full-width space)', () => {
    const log = `OPENGROUND_RESULT: {"topic":"x","completed":[],"skipped":[],"summary":"s","blockers":""}.`
    const r = parseResult(log)
    expect(r).not.toBeNull()
    expect(r?.topic).toBe('x')
  })

  it('falls back to looseParse when JSON.parse throws (unescaped inner quote)', () => {
    // Claude routinely emits this — `5つの "デザイン専門スキル"` verbatim
    // without escaping. JSON.parse fails; looseParse should still extract.
    const log = `OPENGROUND_RESULT: {"topic":"t","completed":[],"skipped":[],"summary":"5つの "デザイン専門スキル" が並ぶ","blockers":"","taskComplete":true}`
    const r = parseResult(log)
    expect(r).not.toBeNull()
    expect(r?.summary).toContain('5つの')
    expect(r?.summary).toContain('デザイン専門スキル')
    expect(r?.taskComplete).toBe(true)
  })

  it('returns null when JSON is unparseable AND looseParse finds no anchors', () => {
    const log = `OPENGROUND_RESULT: {totally not json}`
    expect(parseResult(log)).toBeNull()
  })

  it('coerces non-array completed to empty array (defensive)', () => {
    const log = `OPENGROUND_RESULT: {"topic":"t","completed":"not an array","skipped":[],"summary":"","blockers":""}`
    expect(parseResult(log)?.completed).toEqual([])
  })

  it('keeps taskComplete=undefined when the JSON omits it', () => {
    const log = `OPENGROUND_RESULT: {"topic":"t","completed":[],"skipped":[],"summary":"s","blockers":""}`
    expect(parseResult(log)?.taskComplete).toBeUndefined()
  })

  it('strips whitespace-only topic to undefined', () => {
    const log = `OPENGROUND_RESULT: {"topic":"   ","completed":[],"skipped":[],"summary":"s","blockers":""}`
    expect(parseResult(log)?.topic).toBeUndefined()
  })

  it('preserves question when set', () => {
    const log = `OPENGROUND_RESULT: {"topic":"q","completed":[],"skipped":[],"summary":"halted","blockers":"","question":"Which approach?","taskComplete":false}`
    expect(parseResult(log)?.question).toBe('Which approach?')
  })

  it('parses the decisions array (the why / trade-off layer)', () => {
    const log = `OPENGROUND_RESULT: {"topic":"t","completed":[],"skipped":[],"summary":"s","decisions":["froze via ref not state","kept the marker scheme"],"blockers":"","taskComplete":true}`
    expect(parseResult(log)?.decisions).toEqual([
      'froze via ref not state',
      'kept the marker scheme',
    ])
  })

  it('defaults decisions to [] when the field is absent (older runs)', () => {
    const log = `OPENGROUND_RESULT: {"topic":"t","completed":[],"skipped":[],"summary":"s","blockers":""}`
    expect(parseResult(log)?.decisions).toEqual([])
  })

  it('keeps a decisions-only result (still non-null even without summary)', () => {
    const log = `OPENGROUND_RESULT: {"completed":[],"skipped":[],"summary":"","decisions":["chose A over B"],"blockers":""}`
    const r = parseResult(log)
    expect(r).not.toBeNull()
    expect(r?.decisions).toEqual(['chose A over B'])
  })
})

describe('parseResult — multi-line / brace-balanced', () => {
  it('parses a pretty-printed MULTI-LINE result (the Pass 8 gap)', () => {
    const log = [
      'some chatter',
      'OPENGROUND_RESULT: {',
      '  "topic": "マルチ行",',
      '  "summary": "did the thing",',
      '  "completed": ["x", "y"],',
      '  "skipped": [],',
      '  "blockers": "",',
      '  "taskComplete": false',
      '}',
      'trailing line',
    ].join('\n')
    const r = parseResult(log)
    expect(r?.topic).toBe('マルチ行')
    expect(r?.summary).toBe('did the thing')
    expect(r?.completed).toEqual(['x', 'y'])
    expect(r?.taskComplete).toBe(false)
  })

  it('ignores a `}` that appears inside a string value', () => {
    const log =
      'OPENGROUND_RESULT: {"topic":"t","summary":"close brace } in text","completed":[],"skipped":[],"blockers":""}'
    expect(parseResult(log)?.summary).toBe('close brace } in text')
  })

  it('skips a marker mention with no JSON payload and uses the real one', () => {
    const log =
      'OPENGROUND_RESULT: {"topic":"real","completed":[],"skipped":[],"summary":"s","blockers":""}\nreminder: always end with OPENGROUND_RESULT: on its own line\n'
    expect(parseResult(log)?.topic).toBe('real')
  })

  it('picks the LAST real marker even when multi-line', () => {
    const log = [
      'OPENGROUND_RESULT: {"topic":"first","completed":[],"skipped":[],"summary":"a","blockers":""}',
      'more work',
      'OPENGROUND_RESULT: {',
      '  "topic": "second",',
      '  "completed": [], "skipped": [], "summary": "b", "blockers": ""',
      '}',
    ].join('\n')
    expect(parseResult(log)?.topic).toBe('second')
  })
})

describe('looseParse', () => {
  it('extracts summary anchored by another field key', () => {
    const raw = `{"summary":"hello with "embedded" quote","blockers":"","completed":[],"skipped":[]}`
    const r = looseParse(raw)
    expect(r?.summary).toContain('hello')
  })

  it('returns null when no recognised keys appear', () => {
    expect(looseParse(`{"unrelated":"x"}`)).toBeNull()
  })

  it('parses array fields', () => {
    const raw = `{"completed":["a","b","c"],"skipped":[],"summary":"x","blockers":""}`
    const r = looseParse(raw)
    expect(r?.completed).toEqual(['a', 'b', 'c'])
  })

  it('parses taskComplete:false', () => {
    const raw = `{"summary":"x","blockers":"","completed":[],"skipped":[],"taskComplete":false}`
    expect(looseParse(raw)?.taskComplete).toBe(false)
  })
})

describe('extractThought', () => {
  it('returns null for non-assistant events', () => {
    expect(extractThought({ type: 'user', message: { content: [] } })).toBeNull()
    expect(extractThought({ type: 'result' })).toBeNull()
    expect(extractThought(null)).toBeNull()
    expect(extractThought('not an object')).toBeNull()
  })

  it('extracts a single text block', () => {
    const ev = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello world' }] },
    }
    expect(extractThought(ev)).toBe('hello world')
  })

  it('joins multiple text + thinking blocks with blank lines', () => {
    const ev = {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'pondering…' },
          { type: 'text', text: 'here is the answer' },
        ],
      },
    }
    expect(extractThought(ev)).toBe('pondering…\n\nhere is the answer')
  })

  it('skips empty / whitespace-only blocks', () => {
    const ev = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: '   ' },
          { type: 'text', text: 'real text' },
        ],
      },
    }
    expect(extractThought(ev)).toBe('real text')
  })

  it('returns null when content is empty / non-array', () => {
    expect(extractThought({ type: 'assistant', message: {} })).toBeNull()
    expect(extractThought({ type: 'assistant', message: { content: [] } })).toBeNull()
  })

  it('ignores tool_use blocks (handled by extractActions elsewhere)', () => {
    const ev = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
          { type: 'text', text: 'only this counts' },
        ],
      },
    }
    expect(extractThought(ev)).toBe('only this counts')
  })
})

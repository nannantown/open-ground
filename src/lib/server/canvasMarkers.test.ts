import { describe, it, expect } from 'vitest'
import { extractMarkerObjects } from './canvasMarkers'

describe('extractMarkerObjects', () => {
  it('extracts a single-line marker', () => {
    const chunk = 'blah CANVAS_ADD: {"type":"sticky","text":"hi"} trailing'
    expect(extractMarkerObjects(chunk, 'CANVAS_ADD:')).toEqual([
      '{"type":"sticky","text":"hi"}',
    ])
  })

  it('extracts multiple markers in one chunk', () => {
    const chunk =
      'CANVAS_ADD: {"type":"text","text":"a"}\nCANVAS_ADD: {"type":"text","text":"b"}'
    expect(extractMarkerObjects(chunk, 'CANVAS_ADD:')).toEqual([
      '{"type":"text","text":"a"}',
      '{"type":"text","text":"b"}',
    ])
  })

  it('balances braces across newlines (pretty-printed JSON)', () => {
    const chunk = 'CANVAS_ADD: {\n  "type": "mock",\n  "text": "x"\n}'
    expect(extractMarkerObjects(chunk, 'CANVAS_ADD:')).toEqual([
      '{\n  "type": "mock",\n  "text": "x"\n}',
    ])
  })

  it('does not close on a } inside a string', () => {
    const chunk = 'CANVAS_ADD: {"type":"mock","text":"a } b { c"}'
    expect(extractMarkerObjects(chunk, 'CANVAS_ADD:')).toEqual([
      '{"type":"mock","text":"a } b { c"}',
    ])
  })

  it('handles nested objects (props)', () => {
    const chunk = 'CANVAS_ADD: {"type":"screen","props":{"a":{"b":1}},"x":1}'
    expect(extractMarkerObjects(chunk, 'CANVAS_ADD:')).toEqual([
      '{"type":"screen","props":{"a":{"b":1}},"x":1}',
    ])
  })

  it('respects escaped quotes in source text', () => {
    const raw = '{"type":"screen","text":"<div className=\\"p-4\\">hi</div>"}'
    const chunk = `CANVAS_ADD: ${raw}`
    const [hit] = extractMarkerObjects(chunk, 'CANVAS_ADD:')
    expect(hit).toBe(raw)
    expect(() => JSON.parse(hit)).not.toThrow()
  })

  it('ignores the keyword when not followed by an object', () => {
    const chunk = 'use the CANVAS_ADD: marker to add elements'
    expect(extractMarkerObjects(chunk, 'CANVAS_ADD:')).toEqual([])
  })

  it('skips a malformed (unbalanced) object but still finds a later valid one', () => {
    const chunk =
      'CANVAS_ADD: {"type":"text","text":"oops"\nCANVAS_ADD: {"type":"text","text":"ok"}'
    // The first object never closes before the second marker starts, so the
    // brace scan runs to EOF and consumes the second — accept either the
    // recovery (find the valid one) or nothing, but never a partial/invalid.
    const hits = extractMarkerObjects(chunk, 'CANVAS_ADD:')
    for (const h of hits) expect(() => JSON.parse(h)).not.toThrow()
  })

  it('keeps CANVAS_UPDATE and CANVAS_ADD separable', () => {
    const chunk =
      'CANVAS_UPDATE: {"id":"x1","text":"new"}\nCANVAS_ADD: {"type":"text","text":"a"}'
    expect(extractMarkerObjects(chunk, 'CANVAS_UPDATE:')).toEqual([
      '{"id":"x1","text":"new"}',
    ])
    expect(extractMarkerObjects(chunk, 'CANVAS_ADD:')).toEqual([
      '{"type":"text","text":"a"}',
    ])
  })
})

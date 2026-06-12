// canvasAi.test.ts — the PURE parts of the Canvas AI engine: element
// validation (zod), prompt builders, and DONE-marker detection in a raw PTY
// buffer. The claude run itself (launchClaude / PTY) is NOT exercised here —
// see generateDescription's rationale; these tests never touch the network,
// the real CLI, or ~/.openground.

import { describe, expect, it } from 'vitest'
import {
  CANVAS_DONE_MARKER,
  MAX_GENERATED_ELEMENTS,
  buildGenerateElementsPrompt,
  buildTweakScreenPrompt,
  containsDoneMarker,
  parseGeneratedElements,
} from './canvasAi'
import type { TweakScreenRequest } from '@/lib/types'

// ── parseGeneratedElements ───────────────────────────────────────────────────

describe('parseGeneratedElements', () => {
  it('parses a valid array and reassigns ids server-side', () => {
    const out = parseGeneratedElements(
      JSON.stringify([
        { id: 'model-made-this-up', type: 'text', x: 10, y: 20, text: 'Hello' },
        { type: 'sticky', x: 0, y: 0, width: 200, height: 200, text: 'note', color: '#ffd' },
      ]),
    )
    expect(out).toHaveLength(2)
    expect(out[0].type).toBe('text')
    expect(out[0].text).toBe('Hello')
    // The model's id is never trusted — both ids are fresh UUIDs.
    expect(out[0].id).not.toBe('model-made-this-up')
    expect(out[0].id).toMatch(/[0-9a-f-]{10,}/)
    expect(out[1].id).not.toBe(out[0].id)
  })

  it('strips unknown fields', () => {
    const out = parseGeneratedElements(
      JSON.stringify([
        { type: 'frame', x: 0, y: 0, width: 100, height: 100, text: 'F', evil: 'x', parentId: 'p' },
      ]),
    )
    expect(out[0]).not.toHaveProperty('evil')
    // parentId exists on CanvasElement but is NOT generatable — stripped too.
    expect(out[0]).not.toHaveProperty('parentId')
  })

  it('drops elements with non-whitelisted types and keeps the rest', () => {
    const out = parseGeneratedElements(
      JSON.stringify([
        { type: 'mock', x: 0, y: 0, text: 'no' }, // mock is not generatable
        { type: 'image', x: 0, y: 0, text: 'no' },
        { type: 'shape', x: 0, y: 0, width: 50, height: 50, text: '', shapeKind: 'ellipse' },
      ]),
    )
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('shape')
    expect(out[0].shapeKind).toBe('ellipse')
  })

  it('clamps coordinates and sizes to the sane bands', () => {
    const out = parseGeneratedElements(
      JSON.stringify([
        { type: 'sticky', x: -999999, y: 999999, width: 0.5, height: 99999, text: '' },
      ]),
    )
    expect(out[0].x).toBe(-5000)
    expect(out[0].y).toBe(5000)
    expect(out[0].width).toBe(1)
    expect(out[0].height).toBe(4000)
  })

  it('rejects non-finite numbers (the element drops, not the batch)', () => {
    const out = parseGeneratedElements(
      `[{"type":"text","x":1e999,"y":0,"text":"inf x"},{"type":"text","x":1,"y":2,"text":"ok"}]`,
    )
    expect(out).toHaveLength(1)
    expect(out[0].text).toBe('ok')
  })

  it('drops elements whose text is not a string', () => {
    const out = parseGeneratedElements(
      JSON.stringify([
        { type: 'text', x: 0, y: 0, text: 42 },
        { type: 'text', x: 0, y: 0, text: 'fine' },
      ]),
    )
    expect(out).toHaveLength(1)
    expect(out[0].text).toBe('fine')
  })

  it(`caps the result at ${MAX_GENERATED_ELEMENTS} elements`, () => {
    const many = Array.from({ length: 80 }, (_, i) => ({
      type: 'text',
      x: i,
      y: 0,
      text: `t${i}`,
    }))
    const out = parseGeneratedElements(JSON.stringify(many))
    expect(out).toHaveLength(MAX_GENERATED_ELEMENTS)
  })

  it('tolerates the { elements: [...] } wrapper shape', () => {
    const out = parseGeneratedElements(
      JSON.stringify({ elements: [{ type: 'text', x: 0, y: 0, text: 'wrapped' }] }),
    )
    expect(out).toHaveLength(1)
    expect(out[0].text).toBe('wrapped')
  })

  it('throws on invalid JSON', () => {
    expect(() => parseGeneratedElements('not json {')).toThrow(/JSON/)
  })

  it('throws when nothing is an array', () => {
    expect(() => parseGeneratedElements('"just a string"')).toThrow(/array/)
  })

  it('throws when no element is valid (never returns an empty canvas)', () => {
    expect(() =>
      parseGeneratedElements(JSON.stringify([{ type: 'bogus', x: 0, y: 0, text: '' }])),
    ).toThrow(/no valid/)
    expect(() => parseGeneratedElements('[]')).toThrow(/no valid/)
  })

  // ── parent inference (frame containment) ───────────────────────────────────

  it('infers nested parentIds: text → inner frame → outer frame', () => {
    const out = parseGeneratedElements(
      JSON.stringify([
        { type: 'frame', x: 0, y: 0, width: 800, height: 600, text: 'Outer' },
        { type: 'frame', x: 100, y: 100, width: 300, height: 200, text: 'Card' },
        { type: 'text', x: 120, y: 120, width: 100, height: 30, text: 'inside the card' },
      ]),
    )
    const [outer, inner, text] = out
    // The SMALLEST containing frame wins — the text nests under the card, not
    // the outer frame, and the card frame nests under the outer frame.
    expect(text.parentId).toBe(inner.id)
    expect(inner.parentId).toBe(outer.id)
    expect(outer.parentId).toBeUndefined()
  })

  it('leaves elements outside every frame without a parentId', () => {
    const out = parseGeneratedElements(
      JSON.stringify([
        { type: 'frame', x: 0, y: 0, width: 200, height: 200, text: 'F' },
        { type: 'sticky', x: 500, y: 500, width: 100, height: 100, text: 'free' },
        // Overlapping but not FULLY contained — still no parent.
        { type: 'shape', x: 150, y: 150, width: 100, height: 100, text: '', shapeKind: 'rect' },
      ]),
    )
    expect(out[1].parentId).toBeUndefined()
    expect(out[2].parentId).toBeUndefined()
  })

  it('treats an un-sized text as a point: inside the frame ⇒ child', () => {
    const out = parseGeneratedElements(
      JSON.stringify([
        { type: 'frame', x: 0, y: 0, width: 200, height: 200, text: 'F' },
        { type: 'text', x: 50, y: 50, text: 'point inside' },
        { type: 'text', x: 300, y: 50, text: 'point outside' },
      ]),
    )
    expect(out[1].parentId).toBe(out[0].id)
    expect(out[2].parentId).toBeUndefined()
  })

  it('never cycles on two frames with identical rects (degenerate twins)', () => {
    const out = parseGeneratedElements(
      JSON.stringify([
        { type: 'frame', x: 0, y: 0, width: 400, height: 300, text: 'A' },
        { type: 'frame', x: 0, y: 0, width: 400, height: 300, text: 'B' },
      ]),
    )
    const [a, b] = out
    // Mutual containment is broken by array order: the earlier twin stays the
    // root, the later one may nest under it — never A→B AND B→A.
    expect(a.parentId).toBeUndefined()
    expect(b.parentId).toBe(a.id)
  })
})

// ── prompt builders ──────────────────────────────────────────────────────────

describe('buildGenerateElementsPrompt', () => {
  const prompt = buildGenerateElementsPrompt('/tmp/x/elements.json', 'a pricing page wireframe')

  it('teaches the schema, the file handoff, and the user brief', () => {
    expect(prompt).toContain('/tmp/x/elements.json')
    expect(prompt).toContain('"frame" | "shape" | "text" | "sticky"')
    expect(prompt).toContain('JSON array')
    expect(prompt).toContain('a pricing page wireframe')
    expect(prompt).toContain(String(MAX_GENERATED_ELEMENTS))
  })

  it('spells the completion marker in halves — never the literal marker', () => {
    // The TUI echoes the prompt into the PTY stream; a literal marker in the
    // prompt would false-positive completion on the first repaint.
    expect(prompt).not.toContain(CANVAS_DONE_MARKER)
    expect(prompt).toContain('OPENGROUND_CANVAS')
    expect(prompt).toContain('_DONE')
  })
})

describe('buildTweakScreenPrompt', () => {
  const req: TweakScreenRequest = {
    path: '/p',
    source: 'export default function App(){return <button>Buy</button>}',
    framework: 'react',
    instruction: 'make the button moss green',
    element: { tag: 'button', classes: 'cta', text: 'Buy', html: '<button class="cta">Buy</button>' },
  }

  it('includes the file, the picked element, and the instruction', () => {
    const p = buildTweakScreenPrompt('/tmp/x/screen.tsx', req)
    expect(p).toContain('/tmp/x/screen.tsx')
    expect(p).toContain('tag: button')
    expect(p).toContain('classes: cta')
    expect(p).toContain('<button class="cta">Buy</button>')
    expect(p).toContain('make the button moss green')
    expect(p).toContain('default-exported')
  })

  it('adapts to the html framework and never embeds the literal marker', () => {
    const p = buildTweakScreenPrompt('/tmp/x/screen.html', { ...req, framework: 'html' })
    expect(p).toContain('HTML document')
    expect(p).not.toContain('default-exported')
    expect(p).not.toContain(CANVAS_DONE_MARKER)
  })
})

// ── DONE-marker detection ────────────────────────────────────────────────────

describe('containsDoneMarker', () => {
  it('finds the bare marker', () => {
    expect(containsDoneMarker(`some output\n${CANVAS_DONE_MARKER}\n`)).toBe(true)
  })

  it('finds the marker through SGR styling and CSI positioning', () => {
    const raw = `\x1b[2J\x1b[1;1H\x1b[32m${CANVAS_DONE_MARKER}\x1b[0m\x1b[5C`
    expect(containsDoneMarker(raw)).toBe(true)
  })

  it('finds the marker even split mid-word by SGR sequences', () => {
    const raw = `OPENGROUND\x1b[1m_CANVAS\x1b[0m_DONE`
    expect(containsDoneMarker(raw)).toBe(true)
  })

  it('finds the marker across a PTY line wrap', () => {
    const raw = `…tail OPENGROUND_CAN\r\nVAS_DONE`
    expect(containsDoneMarker(raw)).toBe(true)
  })

  it('does NOT fire on the prompt echo (marker spelled in halves)', () => {
    // What the TUI echoes back is the buildDonePromptLine wording — halves
    // separated by quotes/plus, never the joined marker.
    const echoed =
      'the text "OPENGROUND_CANVAS" immediately followed by "_DONE" joined into one word'
    expect(containsDoneMarker(echoed)).toBe(false)
    // Whitespace-collapsing the echo must not fuse the halves either.
    expect(containsDoneMarker(echoed.replace(/ /g, '\n'))).toBe(false)
  })

  it('does not fire on unrelated output', () => {
    expect(containsDoneMarker('compiling…\nOPENGROUND_DESC_EN: nope')).toBe(false)
    expect(containsDoneMarker('')).toBe(false)
  })
})

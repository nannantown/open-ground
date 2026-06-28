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

  // ── frame default fill ──────────────────────────────────────────────────────

  it('defaults a fill-less frame to white (artboard), like a drawn frame', () => {
    const out = parseGeneratedElements(
      JSON.stringify([{ type: 'frame', x: 0, y: 0, width: 400, height: 300, text: 'Hero' }]),
    )
    expect(out[0].fill).toBe('#FFFFFF')
  })

  it('keeps an explicit frame fill (override wins over the white default)', () => {
    const out = parseGeneratedElements(
      JSON.stringify([
        { type: 'frame', x: 0, y: 0, width: 400, height: 300, text: 'Dark', fill: '#101010' },
      ]),
    )
    expect(out[0].fill).toBe('#101010')
  })

  it('does NOT inject a fill onto non-frame elements', () => {
    const out = parseGeneratedElements(
      JSON.stringify([{ type: 'text', x: 0, y: 0, text: 'hi' }]),
    )
    expect(out[0].fill).toBeUndefined()
  })

  // ── AI-path readable color floor (non-frame) ───────────────────────────────
  // The manual editor defaults stay as-is; the AI path pins contrasting colors
  // so a generated design can't blend into the paper canvas / a white artboard.

  it('forces a high-contrast fill onto a fill-less generated shape', () => {
    // The manual shape default (#D9CDA8) is a paper-adjacent tan; the AI path
    // pins a readable neutral (the `ink-muted` token) so the shape stays visible.
    const out = parseGeneratedElements(
      JSON.stringify([{ type: 'shape', x: 0, y: 0, width: 80, height: 80, text: '' }]),
    )
    expect(out[0].fill).toBe('#6B5847')
  })

  it('keeps an explicit shape fill (override wins over the readable default)', () => {
    const out = parseGeneratedElements(
      JSON.stringify([
        { type: 'shape', x: 0, y: 0, width: 80, height: 80, text: '', fill: '#3A6B8C' },
      ]),
    )
    expect(out[0].fill).toBe('#3A6B8C')
  })

  it('pins a readable textColor onto a text that omits one (dark ink)', () => {
    const out = parseGeneratedElements(
      JSON.stringify([{ type: 'text', x: 0, y: 0, text: 'hi' }]),
    )
    expect(out[0].textColor).toBe('#2A1F1A')
  })

  it('keeps an explicit textColor (override wins)', () => {
    const out = parseGeneratedElements(
      JSON.stringify([{ type: 'text', x: 0, y: 0, text: 'hi', textColor: '#F8F4E8' }]),
    )
    expect(out[0].textColor).toBe('#F8F4E8')
  })

  it('pins a visible body color onto a sticky that omits one', () => {
    const out = parseGeneratedElements(
      JSON.stringify([{ type: 'sticky', x: 0, y: 0, width: 200, height: 200, text: 'note' }]),
    )
    expect(out[0].color).toBe('#ECD79A')
  })

  it('keeps an explicit sticky color (override wins)', () => {
    const out = parseGeneratedElements(
      JSON.stringify([
        { type: 'sticky', x: 0, y: 0, width: 200, height: 200, text: 'note', color: '#F4B8A8' },
      ]),
    )
    expect(out[0].color).toBe('#F4B8A8')
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

  // ── auto layout (childful frames become Figma auto-layout frames) ───────────

  it('makes a childful frame an auto-layout frame and packs its children evenly', () => {
    const out = parseGeneratedElements(
      JSON.stringify([
        { type: 'frame', x: 0, y: 0, width: 400, height: 600, text: 'Stack' },
        { type: 'sticky', x: 40, y: 40, width: 100, height: 80, text: 'a' },
        { type: 'sticky', x: 40, y: 200, width: 100, height: 80, text: 'b' },
      ]),
    )
    const [frame, a, b] = out
    // The frame gained a column layout (children spread vertically) with the
    // shared auto-layout defaults (gap 20 / padding 24 / align start).
    expect(frame.layout).toEqual({ mode: 'column', gap: 20, padding: 24, align: 'start' })
    expect(a.parentId).toBe(frame.id)
    expect(b.parentId).toBe(frame.id)
    // Children are re-stacked by the engine: both at the left padding (24), the
    // first at the top padding (24), the second one child-height + gap below
    // (24 + 80 + 20 = 124) — consistent spacing, not the model's hand x/y.
    expect(a.x).toBe(24)
    expect(a.y).toBe(24)
    expect(b.x).toBe(24)
    expect(b.y).toBe(124)
  })

  it('does NOT add a layout to a childless frame (would collapse to padding)', () => {
    const out = parseGeneratedElements(
      JSON.stringify([{ type: 'frame', x: 0, y: 0, width: 200, height: 200, text: 'Empty' }]),
    )
    expect(out[0].layout).toBeUndefined()
  })

  it("respects a model-provided layout (the model's intent wins over the default)", () => {
    const out = parseGeneratedElements(
      JSON.stringify([
        {
          type: 'frame',
          x: 0,
          y: 0,
          width: 400,
          height: 200,
          text: 'Row',
          layout: { mode: 'row', gap: 8, padding: 12, align: 'center' },
        },
        { type: 'sticky', x: 20, y: 20, width: 60, height: 60, text: 'a' },
        { type: 'sticky', x: 200, y: 20, width: 60, height: 60, text: 'b' },
      ]),
    )
    const [frame, a, b] = out
    expect(frame.layout).toMatchObject({ mode: 'row', gap: 8, padding: 12, align: 'center' })
    // Packed as a row: left padding 12, then child-width + gap (12 + 60 + 8 = 80),
    // vertically centred (12 + (176 - 60) / 2 = 70).
    expect(a.x).toBe(12)
    expect(b.x).toBe(80)
    expect(a.y).toBe(70)
    expect(b.y).toBe(70)
  })

  it('fills in defaults for a partial model layout (only mode given)', () => {
    const out = parseGeneratedElements(
      JSON.stringify([
        { type: 'frame', x: 0, y: 0, width: 400, height: 400, text: 'F', layout: { mode: 'row' } },
        { type: 'sticky', x: 40, y: 40, width: 80, height: 80, text: 'x' },
      ]),
    )
    expect(out[0].layout).toEqual({ mode: 'row', gap: 20, padding: 24, align: 'start' })
  })

  it('never drops a frame for a malformed layout — supplements a valid one', () => {
    const out = parseGeneratedElements(
      JSON.stringify([
        { type: 'frame', x: 0, y: 0, width: 400, height: 400, text: 'Bad', layout: { mode: 'diagonal' } },
        { type: 'sticky', x: 40, y: 40, width: 80, height: 80, text: 'x' },
      ]),
    )
    expect(out).toHaveLength(2)
    expect(out[0].type).toBe('frame')
    // The invalid layout was discarded (.catch) and a valid one supplemented.
    expect(out[0].layout?.mode === 'row' || out[0].layout?.mode === 'column').toBe(true)
    expect(out[1].parentId).toBe(out[0].id)
  })

  // ── variable text sizing (content-fitting boxes, no overflow) ───────────────

  it('defaults a short label to auto-width and drops any oversized model box', () => {
    const out = parseGeneratedElements(
      JSON.stringify([{ type: 'text', x: 0, y: 0, width: 800, height: 200, text: 'Buy now' }]),
    )
    expect(out[0].textSizing).toBe('auto-width')
    // auto-width hugs both axes — the model's oversized 800×200 box is dropped so
    // the renderer measures the real glyph footprint.
    expect(out[0].width).toBeUndefined()
    expect(out[0].height).toBeUndefined()
  })

  it('defaults a long paragraph to auto-height with a bounded width (wraps, no overflow)', () => {
    const long =
      'This is a fairly long paragraph of body copy that must wrap within a bounded width instead of running off the canvas in one extremely long single line.'
    const out = parseGeneratedElements(
      JSON.stringify([{ type: 'text', x: 0, y: 0, width: 2000, text: long }]),
    )
    expect(out[0].textSizing).toBe('auto-height')
    expect(out[0].width).toBeLessThanOrEqual(560)
    expect(out[0].width).toBeGreaterThanOrEqual(120)
    // height is measured for auto-height — never a model-set value.
    expect(out[0].height).toBeUndefined()
  })

  it('treats a multi-line text as a paragraph (auto-height even when each line is short)', () => {
    const out = parseGeneratedElements(
      JSON.stringify([{ type: 'text', x: 0, y: 0, text: 'Line one\nLine two' }]),
    )
    expect(out[0].textSizing).toBe('auto-height')
    expect(out[0].width).toBe(360) // the default paragraph width when none given
  })

  it('respects an explicit fixed textSizing (keeps the clamped box)', () => {
    const out = parseGeneratedElements(
      JSON.stringify([
        { type: 'text', x: 0, y: 0, width: 300, height: 120, text: 'pinned', textSizing: 'fixed' },
      ]),
    )
    expect(out[0].textSizing).toBe('fixed')
    expect(out[0].width).toBe(300)
    expect(out[0].height).toBe(120)
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

  it('teaches the readability floor (paper contrast / textColor / opacity / overlap)', () => {
    // The generated-design-is-invisible fix: the prompt must name the paper
    // background and demand contrast, explicit text colors, full opacity, and no
    // legibility-killing overlaps.
    expect(prompt).toMatch(/readab/i)
    expect(prompt).toContain('#F2EDDE')
    expect(prompt).toContain('textColor')
    expect(prompt).toContain('opacity')
    expect(prompt).toMatch(/contrast/i)
  })

  it('spells the completion marker in halves — never the literal marker', () => {
    // The TUI echoes the prompt into the PTY stream; a literal marker in the
    // prompt would false-positive completion on the first repaint.
    expect(prompt).not.toContain(CANVAS_DONE_MARKER)
    expect(prompt).toContain('OPENGROUND_CANVAS')
    expect(prompt).toContain('_DONE')
  })

  it('teaches auto-layout structure and content-fitting (variable) text', () => {
    // The model must build with auto-layout frames (not loose free placement /
    // groups) and let text auto-size so it fits.
    expect(prompt).toMatch(/auto layout/i)
    expect(prompt).toContain('"row" | "column"')
    expect(prompt).toContain('layout')
    expect(prompt).toContain('textSizing')
    expect(prompt).toContain('auto-height')
    expect(prompt).toMatch(/group/i)
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

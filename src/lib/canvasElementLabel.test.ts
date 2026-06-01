import { describe, it, expect } from 'vitest'
import type { CanvasElement } from './types'
import { canvasElementLabel } from './canvasElementLabel'

const el = (over: Partial<CanvasElement> & Pick<CanvasElement, 'type'>): CanvasElement => ({
  id: 'e1',
  x: 0,
  y: 0,
  text: '',
  ...over,
})

describe('canvasElementLabel', () => {
  it('uses content for text / sticky / frame, with a type fallback when empty', () => {
    expect(canvasElementLabel(el({ type: 'text', text: 'Hello' }))).toBe('Hello')
    expect(canvasElementLabel(el({ type: 'text', text: '' }))).toBe('Text')
    expect(canvasElementLabel(el({ type: 'sticky', text: 'Ship it' }))).toBe('Ship it')
    expect(canvasElementLabel(el({ type: 'sticky', text: '' }))).toBe('Sticky note')
    expect(canvasElementLabel(el({ type: 'frame', text: 'Header' }))).toBe('Header')
    expect(canvasElementLabel(el({ type: 'frame', text: '' }))).toBe('Frame')
  })

  it('uses the first non-empty line and trims surrounding whitespace', () => {
    expect(canvasElementLabel(el({ type: 'sticky', text: '\n   \n  Real line  \nsecond' }))).toBe(
      'Real line',
    )
  })

  it('caps a long label with an ellipsis', () => {
    const long = 'x'.repeat(50)
    const label = canvasElementLabel(el({ type: 'text', text: long }))
    expect(label.endsWith('…')).toBe(true)
    expect(label.length).toBeLessThanOrEqual(29) // 28 chars + ellipsis
  })

  it('names a mock from its name, else its framework', () => {
    expect(canvasElementLabel(el({ type: 'mock', name: 'Pricing card' }))).toBe('Pricing card')
    expect(canvasElementLabel(el({ type: 'mock', framework: 'html' }))).toBe('HTML mock')
    expect(canvasElementLabel(el({ type: 'mock' }))).toBe('React mock')
  })

  it('names an image from filename, then alt, else a fallback', () => {
    expect(canvasElementLabel(el({ type: 'image', filename: 'shot.png' }))).toBe('shot.png')
    expect(canvasElementLabel(el({ type: 'image', alt: 'A diagram' }))).toBe('A diagram')
    expect(canvasElementLabel(el({ type: 'image' }))).toBe('Image')
  })

  it('names a screen from its label, then moduleId, else a fallback', () => {
    expect(canvasElementLabel(el({ type: 'screen', label: 'Home' }))).toBe('Home')
    expect(canvasElementLabel(el({ type: 'screen', moduleId: 'home-v2' }))).toBe('home-v2')
    expect(canvasElementLabel(el({ type: 'screen' }))).toBe('Screen')
  })

  it('names a shape by its primitive (rect default, ellipse when set)', () => {
    expect(canvasElementLabel(el({ type: 'shape' }))).toBe('Rectangle')
    expect(canvasElementLabel(el({ type: 'shape', shapeKind: 'ellipse' }))).toBe('Ellipse')
  })

  it('labels a comment by its body, else a fallback', () => {
    expect(canvasElementLabel(el({ type: 'comment', text: 'fix the spacing' }))).toBe(
      'fix the spacing',
    )
    expect(canvasElementLabel(el({ type: 'comment' }))).toBe('Comment')
  })
})

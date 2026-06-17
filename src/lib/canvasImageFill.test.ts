import { describe, it, expect } from 'vitest'
import type { CanvasElement } from './types'
import { imageFillStyle, resolveImageFillMode, DEFAULT_IMAGE_FILL_MODE } from './canvasImageFill'

const frame = (over: Partial<CanvasElement> = {}): CanvasElement => ({
  id: 'f1',
  type: 'frame',
  x: 0,
  y: 0,
  text: '',
  ...over,
})

describe('resolveImageFillMode', () => {
  it('defaults to cover when unset / unknown', () => {
    expect(resolveImageFillMode(frame())).toBe(DEFAULT_IMAGE_FILL_MODE)
    expect(resolveImageFillMode(frame({ fillImageMode: 'cover' }))).toBe('cover')
    expect(resolveImageFillMode(frame({ fillImageMode: 'zoom' as never }))).toBe('cover')
  })
  it('honours each valid mode', () => {
    expect(resolveImageFillMode(frame({ fillImageMode: 'contain' }))).toBe('contain')
    expect(resolveImageFillMode(frame({ fillImageMode: 'fill' }))).toBe('fill')
    expect(resolveImageFillMode(frame({ fillImageMode: 'tile' }))).toBe('tile')
  })
})

describe('imageFillStyle', () => {
  it('is null when there is no image fill', () => {
    expect(imageFillStyle(frame(), 'http://x/a.png')).toBeNull()
  })
  it('cover → background-size cover, no-repeat', () => {
    expect(imageFillStyle(frame({ fillImageId: 'a' }), 'http://x/a.png')).toEqual({
      backgroundImage: 'url("http://x/a.png")',
      backgroundSize: 'cover',
      backgroundRepeat: 'no-repeat',
      backgroundPosition: 'center',
    })
  })
  it('fill → stretch (100% 100%)', () => {
    expect(imageFillStyle(frame({ fillImageId: 'a', fillImageMode: 'fill' }), 'u')!.backgroundSize).toBe('100% 100%')
  })
  it('tile → repeat at natural size', () => {
    const s = imageFillStyle(frame({ fillImageId: 'a', fillImageMode: 'tile' }), 'u')!
    expect(s.backgroundSize).toBe('auto')
    expect(s.backgroundRepeat).toBe('repeat')
  })
  it('contain → background-size contain', () => {
    expect(imageFillStyle(frame({ fillImageId: 'a', fillImageMode: 'contain' }), 'u')!.backgroundSize).toBe('contain')
  })
  it('escapes quotes / backslashes in the url so it cannot break the declaration', () => {
    const s = imageFillStyle(frame({ fillImageId: 'a' }), 'http://x/a".png')!
    expect(s.backgroundImage).toBe('url("http://x/a\\".png")')
  })
})

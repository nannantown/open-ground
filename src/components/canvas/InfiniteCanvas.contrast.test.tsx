// @vitest-environment jsdom
//
// Wiring guard: InfiniteCanvas must hand each text its real backdrop (current
// theme + the frame under it). ElementView.contrast.test covers the colour
// maths with an explicit backdrop; this pins that the canvas actually passes
// one — dropping the `backdrop` prop turns the dark-theme cases red.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import type { CanvasElement, CanvasState } from '@/lib/types'
import { AA_TEXT_CONTRAST, contrastRatio } from '@/lib/canvasContrast'

vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (k: string) => k }) }))

import { InfiniteCanvas } from './InfiniteCanvas'

class ROStub {
  disconnect = vi.fn()
  constructor(public cb: () => void) {}
  observe() {}
  unobserve() {}
}

const makeCanvas = (elements: CanvasElement[]): CanvasState => ({
  positions: {},
  viewport: { x: 0, y: 0, zoom: 1 },
  elements,
})

const glyphColor = (container: HTMLElement, text: string): string => {
  const node = Array.from(container.querySelectorAll<HTMLElement>('*')).find((n) =>
    Array.from(n.childNodes).some((c) => c.nodeType === 3 && c.textContent === text),
  )
  expect(node, `node with "${text}"`).toBeTruthy()
  for (let n: HTMLElement | null = node!; n && n !== container; n = n.parentElement) if (n.style.color) return n.style.color
  throw new Error('no inline text colour on the render path')
}

const renderCanvas = (elements: CanvasElement[]) =>
  render(
    <InfiniteCanvas
      projects={[]}
      canvas={makeCanvas(elements)}
      onCanvasChange={vi.fn()}
      selectedIds={[]}
      onSelect={vi.fn()}
      onSelectIds={vi.fn()}
      editingId={null}
      onEditingIdChange={vi.fn()}
      tool="select"
      onToolChange={vi.fn()}
      frameVariant="design"
    />,
  ).container

const text = { id: 't', type: 'text', x: 20, y: 20, width: 120, height: 24, text: 'Heading' } as CanvasElement
const whiteFrame = { id: 'w', type: 'frame', x: 0, y: 0, width: 400, height: 300, text: 'W', fill: '#FFFFFF' } as CanvasElement

describe('InfiniteCanvas passes each text its backdrop (dark theme)', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ROStub)
    document.documentElement.dataset.theme = 'dark'
  })
  afterEach(() => {
    delete document.documentElement.dataset.theme
  })

  it('bare dark canvas → light text', () => {
    expect(contrastRatio(glyphColor(renderCanvas([text]), 'Heading'), '#2A1F1A')!).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST)
  })
  it('white frame under the text (not its parent) → dark text', () => {
    expect(contrastRatio(glyphColor(renderCanvas([whiteFrame, text]), 'Heading'), '#FFFFFF')!).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST)
  })
})

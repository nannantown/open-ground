import {
  Type,
  StickyNote,
  Frame,
  Code2,
  MessageSquareText,
  Image as ImageIcon,
  MonitorSmartphone,
  Square,
  Circle,
} from 'lucide-react'
import type { CanvasElement } from '@/lib/types'
import { resolveShapeKind } from '@/lib/canvasShape'

// One source of truth for "how do we name + ICON an element in a list" — used by
// the Layers panel (and available to any future list view). Mirrors the
// Selection Inspector's TYPE_LABEL but adds a CONTENT-derived label so the
// panel reads like Figma's layer list ("Sticky: Ship it" instead of a generic
// "Sticky note" for every row).

const MAX_LABEL = 28

// Trim to the first non-empty line, collapse inner whitespace, and cap length —
// keeps a multi-line sticky / paragraph text from blowing out the row.
const firstLine = (text: string): string => {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!line) return ''
  return line.length > MAX_LABEL ? `${line.slice(0, MAX_LABEL)}…` : line
}

// A human-readable name for one element, derived from its content with a
// type-appropriate fallback so an empty / unlabelled element still reads
// clearly. Never returns an empty string.
export function canvasElementLabel(el: CanvasElement): string {
  switch (el.type) {
    case 'text':
      return firstLine(el.text) || 'Text'
    case 'sticky':
      return firstLine(el.text) || 'Sticky note'
    case 'frame':
      return firstLine(el.text) || 'Frame'
    case 'mock':
      return el.name || (el.framework === 'html' ? 'HTML mock' : 'React mock')
    case 'comment':
      return firstLine(el.text) || 'Comment'
    case 'image':
      return el.filename || el.alt || 'Image'
    case 'screen':
      return el.label || el.moduleId || 'Screen'
    case 'shape':
      return resolveShapeKind(el) === 'ellipse' ? 'Ellipse' : 'Rectangle'
    default:
      return 'Element'
  }
}

// The Lucide glyph for an element's type, sized for a compact list row. Shape
// picks rect vs ellipse so the icon matches the primitive on the canvas.
export function CanvasElementIcon({
  element,
  size = 13,
}: {
  element: CanvasElement
  size?: number
}) {
  const props = { size, strokeWidth: 1.75 as const }
  switch (element.type) {
    case 'text':
      return <Type {...props} />
    case 'sticky':
      return <StickyNote {...props} />
    case 'frame':
      return <Frame {...props} />
    case 'mock':
      return <Code2 {...props} />
    case 'comment':
      return <MessageSquareText {...props} />
    case 'image':
      return <ImageIcon {...props} />
    case 'screen':
      return <MonitorSmartphone {...props} />
    case 'shape':
      return resolveShapeKind(element) === 'ellipse' ? (
        <Circle {...props} />
      ) : (
        <Square {...props} />
      )
    default:
      return <Square {...props} />
  }
}

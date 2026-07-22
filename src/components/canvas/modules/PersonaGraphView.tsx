// The Persona tab's "synapse map" — a read-only, token-zero graph over the
// owner's own notes (ManualJudgment[], the same list the list view renders).
// Edges are mechanical rules (buildPersonaGraphEdges: shared tag / close date
// / explicit correction) — no LLM, so opening this view costs nothing.
//
// Pan/zoom follows the same shape InfiniteCanvas uses (viewport = {x, y,
// zoom}, a CSS/SVG transform, a non-passive native wheel listener so
// preventDefault actually stops page scroll) but is deliberately its own
// small implementation: this graph never has more than a few hundred nodes
// and needs none of InfiniteCanvas's element/selection machinery. Unlike
// InfiniteCanvas's own viewport (a 1:1 CSS-px canvas), this one sits behind an
// SVG `viewBox`, so every screen coordinate is converted through
// computeViewBoxScale/screenPointToUserSpace/screenDeltaToUserSpace
// (personaGraph.ts) before it touches `viewport` — skipping that conversion
// is what makes a drag "slip" under the cursor.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '@/i18n/I18nContext'
import { Btn } from '@/components/ui/Btn'
import {
  buildPersonaGraphEdges,
  layoutPersonaGraph,
  screenDeltaToUserSpace,
  screenPointToUserSpace,
  type PersonaGraphEdge,
} from '@/lib/personaGraph'
import type { ManualJudgment } from '@/lib/types'

const LAYOUT_WIDTH = 900
const LAYOUT_HEIGHT = 620
const ZOOM_MIN = 0.35
const ZOOM_MAX = 3
const NODE_RADIUS = 7

const EDGE_COLOR: Record<PersonaGraphEdge['kind'], string> = {
  corrects: 'var(--color-accent, #b45309)',
  tag: 'var(--color-ink-muted, #8a8a86)',
  date: 'var(--color-line-strong, #d8d6d0)',
}

interface Viewport {
  x: number
  y: number
  zoom: number
}

const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))

// Code-point aware truncation — a plain `text.slice(0, n)` cuts by UTF-16
// code unit and can split a surrogate pair (an emoji becomes ``) or a
// combining mark off its base character. Array.from splits on code points,
// which is not the same as a grapheme cluster (a flag or ZWJ sequence can
// still break) but never produces the raw slice's mangled half-character.
const truncateLabel = (text: string, max: number): string => {
  const chars = Array.from(text)
  return chars.length <= max ? text : `${chars.slice(0, max).join('')}…`
}

export const PersonaGraphView = ({ judgments }: { judgments: ManualJudgment[] }) => {
  const { t, lang } = useT()
  const containerRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const dragRef = useRef<{
    sx: number
    sy: number
    vx: number
    vy: number
    rect: DOMRect
  } | null>(null)

  const byId = useMemo(() => new Map(judgments.map((j) => [j.id, j])), [judgments])

  // `judgments` is a fresh array only when `load()` actually re-fetched (see
  // PersonaModule), so keying off it re-runs the layout exactly on a real
  // data change — never on an unrelated re-render.
  const edges = useMemo(() => buildPersonaGraphEdges(judgments), [judgments])
  const positions = useMemo(
    () => layoutPersonaGraph(judgments, edges, LAYOUT_WIDTH, LAYOUT_HEIGHT),
    [judgments, edges],
  )
  const posById = useMemo(() => new Map(positions.map((p) => [p.id, p])), [positions])

  const resetView = useCallback(() => setViewport({ x: 0, y: 0, zoom: 1 }), [])

  // Re-centre whenever the note set changes (a fresh answer/note should not
  // leave the owner staring at wherever they last panned to).
  useEffect(() => {
    resetView()
    setSelectedId(null)
  }, [judgments, resetView])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey) {
        const anchor = screenPointToUserSpace(
          e.clientX,
          e.clientY,
          rect,
          LAYOUT_WIDTH,
          LAYOUT_HEIGHT,
        )
        setViewport((v) => {
          const newZoom = clampZoom(v.zoom * (1 - e.deltaY * 0.01))
          const wx = (anchor.x - v.x) / v.zoom
          const wy = (anchor.y - v.y) / v.zoom
          return { zoom: newZoom, x: anchor.x - wx * newZoom, y: anchor.y - wy * newZoom }
        })
      } else {
        const { dx, dy } = screenDeltaToUserSpace(
          e.deltaX,
          e.deltaY,
          rect,
          LAYOUT_WIDTH,
          LAYOUT_HEIGHT,
        )
        setViewport((v) => ({ ...v, x: v.x - dx, y: v.y - dy }))
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('[data-graph-node]')) return
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    dragRef.current = { sx: e.clientX, sy: e.clientY, vx: viewport.x, vy: viewport.y, rect }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    const { dx, dy } = screenDeltaToUserSpace(
      e.clientX - d.sx,
      e.clientY - d.sy,
      d.rect,
      LAYOUT_WIDTH,
      LAYOUT_HEIGHT,
    )
    setViewport((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }))
  }
  const onPointerUp = () => {
    dragRef.current = null
  }

  const selectNode = useCallback((id: string) => setSelectedId(id), [])

  // The static layer (every edge + every node) depends only on the graph
  // itself and which node is selected — NOT on `viewport`. Memoizing it means
  // a pan (which only ever changes `viewport`) re-renders the component but
  // hands the SAME element tree back to the transformed <g>, so React bails
  // out of reconciling potentially hundreds of <line>/<g> children on every
  // pointermove. (This repo has previously shipped a pan regression from
  // skipping exactly this memoization — see InfiniteCanvas's own history.)
  const graphLayer = useMemo(
    () => (
      <>
        {edges.map((e, i) => {
          const a = posById.get(e.source)
          const b = posById.get(e.target)
          if (!a || !b) return null
          return (
            <line
              key={`${e.kind}-${e.source}-${e.target}-${i}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={EDGE_COLOR[e.kind]}
              strokeWidth={e.kind === 'corrects' ? 2 : 1}
              strokeDasharray={e.kind === 'date' ? '3 3' : undefined}
              opacity={e.kind === 'date' ? 0.5 : 0.8}
            />
          )
        })}
        {positions.map((p) => {
          const j = byId.get(p.id)
          if (!j) return null
          const label = truncateLabel(j.text, 22)
          const isSelected = p.id === selectedId
          return (
            <g
              key={p.id}
              data-graph-node
              transform={`translate(${p.x} ${p.y})`}
              className="group cursor-pointer outline-none"
              role="button"
              tabIndex={0}
              aria-pressed={isSelected}
              aria-label={j.text}
              onClick={() => selectNode(p.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  selectNode(p.id)
                }
              }}
            >
              {/* Focus ring — visible only for :focus-visible (keyboard nav),
               *  same convention the rest of the app uses for focus. */}
              <circle
                r={NODE_RADIUS + 5}
                fill="none"
                stroke="var(--color-accent, #b45309)"
                strokeWidth={1.5}
                className="pointer-events-none opacity-0 group-focus-visible:opacity-100"
              />
              <circle
                r={isSelected ? NODE_RADIUS + 2.5 : NODE_RADIUS}
                className={
                  isSelected
                    ? 'fill-accent'
                    : 'fill-ink-muted transition-colors group-hover:fill-ink'
                }
                stroke="var(--color-bg-card, #fff)"
                strokeWidth={1.5}
              />
              <text
                x={0}
                y={NODE_RADIUS + 12}
                textAnchor="middle"
                className="select-none fill-ink text-[9px]"
              >
                {label}
              </text>
            </g>
          )
        })}
      </>
    ),
    [edges, positions, posById, byId, selectedId, selectNode],
  )

  const selected = selectedId ? byId.get(selectedId) ?? null : null

  if (judgments.length === 0) {
    return (
      <div className="flex flex-col gap-1.5 rounded-[3px] border border-dashed border-line px-4 py-5">
        <p className="text-[12.5px] text-ink">{t('persona.graph.empty.title')}</p>
        <p className="text-[12px] leading-relaxed text-ink-muted">
          {t('persona.graph.empty.body')}
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={containerRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        role="group"
        aria-label={t('persona.graph.heading')}
        className="relative h-[360px] w-full cursor-grab overflow-hidden rounded-[3px] border border-line bg-bg-card shadow-card active:cursor-grabbing"
      >
        <svg width="100%" height="100%" viewBox={`0 0 ${LAYOUT_WIDTH} ${LAYOUT_HEIGHT}`}>
          <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}>
            {graphLayer}
          </g>
        </svg>

        <div className="absolute right-2 top-2 flex flex-col gap-1 rounded-[3px] border border-line bg-bg-card/90 px-2 py-1.5 text-[10px] text-ink-faint shadow-card">
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-[2px] w-3"
              style={{ background: EDGE_COLOR.corrects }}
            />
            {t('persona.graph.legend.corrects')}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-[1px] w-3" style={{ background: EDGE_COLOR.tag }} />
            {t('persona.graph.legend.tag')}
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-0 w-3 border-t border-dashed"
              style={{ borderColor: EDGE_COLOR.date }}
            />
            {t('persona.graph.legend.date')}
          </span>
        </div>

        <div className="absolute bottom-2 right-2">
          <Btn variant="ghost" size="xs" onClick={resetView}>
            {t('persona.graph.resetView')}
          </Btn>
        </div>
      </div>

      <p className="text-[11px] text-ink-faint">{t('persona.graph.hint')}</p>

      {selected && (
        <article className="flex flex-col gap-2 rounded-[3px] border border-line bg-bg-card px-4 py-3 shadow-card">
          <div className="flex items-start justify-between gap-3">
            <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink">
              {selected.text}
            </p>
            <Btn variant="subtle" size="xs" onClick={() => setSelectedId(null)}>
              {t('persona.graph.close')}
            </Btn>
          </div>
          {selected.context && (
            <div className="flex flex-col gap-1 border-l-2 border-line-strong pl-3">
              <span className="label-cap text-ink-faint">
                {t(selected.correctsId ? 'persona.notes.corrects' : 'persona.notes.basis')}
              </span>
              <p className="whitespace-pre-wrap text-[11.5px] leading-relaxed text-ink-subtle">
                {selected.context}
              </p>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-ink-faint">
            <time dateTime={selected.addedAt}>
              {new Date(selected.addedAt).toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </time>
            {selected.tags?.map((tag) => (
              <span
                key={tag}
                className="rounded-[2px] border border-line-soft bg-bg-inset px-1.5 py-0.5 text-ink-muted"
              >
                {tag}
              </span>
            ))}
          </div>
        </article>
      )}
    </div>
  )
}

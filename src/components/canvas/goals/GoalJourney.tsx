import type { Goal, ProjectMilestone } from '@/lib/types'

interface Props {
  goal: Goal
  milestones: ProjectMilestone[]
}

// "Journey map" hero for a Goal: a winding road from START (bottom) up to the
// GOAL flag (top), with each milestone planted along it as a stop. The road
// segment leading INTO a milestone is coloured by that milestone's status —
// moss when verified (you've travelled it), accent when failed/blocked, azure
// while running, faint-dashed when still ahead. The first not-yet-cleared stop
// gets an "いまここ" pin. It replaces the flat progress bar with something that
// reads as progress through a route, so plotting milestones feels like drawing
// a course rather than filling a form.

const W = 320
const cx = W / 2
const amp = 84 // horizontal swing of the winding road
const ySeg = 86 // vertical distance between stops
const topPad = 74 // room for the GOAL flag + its label
const botPad = 52 // room for START

type Status = NonNullable<ProjectMilestone['status']>

const NODE_FILL: Record<Status, string> = {
  verified: 'fill-moss',
  in_progress: 'fill-azure',
  verifying: 'fill-azure',
  failed: 'fill-accent',
  blocked: 'fill-accent',
  pending: 'fill-bg-card',
}
const SEG_STROKE: Record<Status, string> = {
  verified: 'stroke-moss',
  in_progress: 'stroke-azure',
  verifying: 'stroke-azure',
  failed: 'stroke-accent',
  blocked: 'stroke-accent',
  pending: 'stroke-line-soft',
}

export const GoalJourney = ({ goal, milestones }: Props) => {
  const n = milestones.length
  const H = topPad + (n + 1) * ySeg + botPad

  // node index: 0 = START, 1..n = milestones, n+1 = GOAL
  const nodeX = (k: number) =>
    k === 0 || k === n + 1 ? cx : cx + (k % 2 === 1 ? amp : -amp)
  const nodeY = (k: number) => topPad + (n + 1 - k) * ySeg

  const segPath = (k: number) => {
    const x0 = nodeX(k - 1)
    const y0 = nodeY(k - 1)
    const x1 = nodeX(k)
    const y1 = nodeY(k)
    const ym = (y0 + y1) / 2
    return `M ${x0} ${y0} C ${x0} ${ym}, ${x1} ${ym}, ${x1} ${y1}`
  }

  const verified = milestones.filter(m => m.status === 'verified').length
  // First stop that isn't cleared yet — the traveller's current position.
  const frontier = milestones.findIndex(
    m => m.status !== 'verified' && m.status !== 'failed' && m.status !== 'blocked',
  )

  return (
    <div className="rounded-[6px] border border-line bg-bg-card/40 px-3 py-4">
      <div className="mb-1 flex items-baseline justify-between gap-2 px-1">
        <p className="label-cap text-ink-muted">ここまでの道のり</p>
        <span className="font-mono text-[11px] tabular-nums text-ink-muted">
          {n > 0 ? `${verified} / ${n}` : 'ルート未設定'}
        </span>
      </div>

      <div
        className="relative mx-auto w-full"
        style={{ maxWidth: 360, aspectRatio: `${W} / ${H}` }}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="absolute inset-0 h-full w-full overflow-visible"
        >
          {/* Road segments, drawn bottom→top */}
          {Array.from({ length: n + 1 }, (_, idx) => {
            const k = idx + 1 // segment leading into node k (1..n+1)
            const m = k <= n ? milestones[k - 1] : null
            const status: Status = m
              ? m.status ?? 'pending'
              : goal.status === 'done'
                ? 'verified'
                : 'pending'
            const dashed =
              status === 'pending' || status === 'verifying'
                ? status === 'pending'
                : false
            return (
              <path
                key={k}
                d={segPath(k)}
                fill="none"
                strokeWidth={7}
                strokeLinecap="round"
                strokeDasharray={dashed ? '1 12' : undefined}
                className={SEG_STROKE[status]}
              />
            )
          })}

          {/* START */}
          <circle
            cx={nodeX(0)}
            cy={nodeY(0)}
            r={9}
            className="fill-bg-card stroke-line-soft"
            strokeWidth={2}
          />
          <circle cx={nodeX(0)} cy={nodeY(0)} r={3.5} className="fill-ink-faint" />
          <foreignObject
            x={nodeX(0) - 60}
            y={nodeY(0) + 12}
            width={120}
            height={20}
          >
            <div className="text-center text-[10px] font-medium uppercase tracking-[0.14em] text-ink-faint">
              START
            </div>
          </foreignObject>

          {/* Milestone stops */}
          {milestones.map((m, i) => {
            const k = i + 1
            const status: Status = m.status ?? 'pending'
            const x = nodeX(k)
            const y = nodeY(k)
            const rightSide = x > cx
            const isFrontier = i === frontier
            return (
              <g key={m.id}>
                {/* pin shadow */}
                <ellipse
                  cx={x}
                  cy={y + 20}
                  rx={11}
                  ry={3}
                  className="fill-ink"
                  opacity={0.06}
                />
                <circle
                  cx={x}
                  cy={y}
                  r={16}
                  strokeWidth={2}
                  className={[
                    NODE_FILL[status],
                    status === 'pending' ? 'stroke-line' : 'stroke-transparent',
                  ].join(' ')}
                />
                {/* glyph */}
                {status === 'verified' ? (
                  <path
                    d={`M ${x - 5} ${y} l 3.4 3.6 L ${x + 6} ${y - 4.5}`}
                    fill="none"
                    className="stroke-bg-card"
                    strokeWidth={2.2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ) : status === 'failed' || status === 'blocked' ? (
                  <text
                    x={x}
                    y={y + 4}
                    textAnchor="middle"
                    className="fill-bg-card text-[13px] font-bold"
                  >
                    !
                  </text>
                ) : (
                  <text
                    x={x}
                    y={y + 4}
                    textAnchor="middle"
                    className={
                      status === 'in_progress' || status === 'verifying'
                        ? 'fill-bg-card text-[11px] font-semibold'
                        : 'fill-ink-muted text-[11px] font-semibold'
                    }
                  >
                    {k}
                  </text>
                )}

                {/* "いまここ" pin on the current frontier */}
                {isFrontier && (
                  <foreignObject x={x - 30} y={y - 44} width={60} height={22}>
                    <div className="flex justify-center">
                      <span className="animate-bounce rounded-full bg-ink px-2 py-0.5 text-[9px] font-medium text-bg-card">
                        いまここ
                      </span>
                    </div>
                  </foreignObject>
                )}

                {/* milestone name label, on the outer side */}
                <foreignObject
                  x={rightSide ? x - 16 - 132 : x + 16}
                  y={y - 20}
                  width={132}
                  height={44}
                >
                  <div
                    className={[
                      'flex h-[44px] items-center',
                      rightSide ? 'justify-end text-right' : 'justify-start',
                    ].join(' ')}
                  >
                    <span className="line-clamp-2 text-[11.5px] leading-tight text-ink">
                      {m.name || `スポット ${k}`}
                    </span>
                  </div>
                </foreignObject>
              </g>
            )
          })}

          {/* GOAL flag */}
          <line
            x1={nodeX(n + 1)}
            y1={nodeY(n + 1) - 4}
            x2={nodeX(n + 1)}
            y2={nodeY(n + 1) - 30}
            className="stroke-ink"
            strokeWidth={2}
            strokeLinecap="round"
          />
          <path
            d={`M ${nodeX(n + 1)} ${nodeY(n + 1) - 30} l 20 6 l -20 6 z`}
            className={goal.status === 'done' ? 'fill-moss' : 'fill-accent'}
          />
          <circle
            cx={nodeX(n + 1)}
            cy={nodeY(n + 1)}
            r={6}
            className="fill-ink"
          />
          <foreignObject
            x={cx - 140}
            y={nodeY(n + 1) + 12}
            width={280}
            height={40}
          >
            <div className="text-center">
              <div className="truncate font-display text-[15px] text-ink">
                {goal.title || '無題の Goal'}
              </div>
              <div className="text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                GOAL
              </div>
            </div>
          </foreignObject>
        </svg>
      </div>

      {n === 0 && (
        <p className="mt-1 text-center text-[11.5px] text-ink-faint">
          まだ航路がありません。下の「マイルストーン生成」で道を引いてみよう。
        </p>
      )}
    </div>
  )
}

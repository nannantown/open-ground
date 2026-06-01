import type { Goal, ProjectMilestone } from '@/lib/types'

interface Props {
  goal: Goal
  milestones: ProjectMilestone[]
}

// Tiny horizontal bar that shows the verified ratio across the goal's
// milestones. Failed/blocked segments are drawn in accent red, in_progress
// in azure, verified in moss green, pending in line-soft. Same colour
// language as MilestoneRow's status badges so the eye can match them up.

const SEGMENT_COLOR: Record<NonNullable<ProjectMilestone['status']>, string> = {
  pending: 'bg-line-soft',
  in_progress: 'bg-azure',
  verifying: 'bg-azure',
  verified: 'bg-moss',
  failed: 'bg-accent',
  blocked: 'bg-accent',
}

export const GoalProgressBar = ({ goal, milestones }: Props) => {
  const total = milestones.length
  const verified = milestones.filter(m => m.status === 'verified').length
  const failed = milestones.filter(
    m => m.status === 'failed' || m.status === 'blocked',
  ).length
  const running = milestones.filter(
    m => m.status === 'in_progress' || m.status === 'verifying',
  ).length
  const pct = total > 0 ? Math.round((verified / total) * 100) : 0

  if (total === 0) {
    return (
      <p className="label-cap text-ink-faint">
        マイルストーンを 1 件以上追加すると進捗が表示されます。
      </p>
    )
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="label-cap text-ink-muted">進捗</span>
        <span className="font-mono text-[11px] tabular-nums text-ink">
          {verified} / {total}
          {failed > 0 && (
            <span className="ml-2 text-accent">· {failed} failed</span>
          )}
          {running > 0 && (
            <span className="ml-2 text-azure">· {running} running</span>
          )}
        </span>
      </div>
      <div className="flex h-1.5 w-full overflow-hidden rounded-full border border-line bg-bg-card">
        {milestones.map((m, i) => {
          const cls = SEGMENT_COLOR[m.status ?? 'pending']
          return (
            <div
              key={m.id}
              className={['flex-1 transition-colors', cls].join(' ')}
              title={`${i + 1}. ${m.name} — ${m.status ?? 'pending'}`}
              style={{
                marginLeft: i === 0 ? 0 : 1,
              }}
            />
          )
        })}
      </div>
      <p className="label-cap text-ink-faint">
        Goal: <span className={
          goal.status === 'done'
            ? 'text-moss'
            : goal.status === 'blocked'
              ? 'text-accent'
              : goal.status === 'running'
                ? 'text-azure'
                : 'text-ink-muted'
        }>{goal.status}</span>
        {' '}· {pct}% complete
      </p>
    </div>
  )
}

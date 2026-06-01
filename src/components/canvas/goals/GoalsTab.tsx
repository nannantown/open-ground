import { useCallback, useEffect, useState } from 'react'
import { Target, Plus, Trash2 } from 'lucide-react'
import { Btn } from '@/components/ui/Btn'
import type { Goal, ProjectData, ProjectMilestone } from '@/lib/types'
import { api } from '@/lib/api-client'
import { GoalDetail } from './GoalDetail'

// Phase 6 — entry point for the "Tasks" tab (internal name 'goals').
//
// Layout: left rail listing the project's Goals, right pane showing the
// selected Goal's detail (description + completion criteria + milestones).
// The Goal list / milestones live in `.openground/tasks.json` (read via
// /api/project, mutated via /api/project/goals + /api/project/milestones).
//
// Phase 6.A is the skeleton — manual CRUD only, no Claude-driven plan
// generation yet (that lands in 6.B), no shell verify (6.C), no automated
// run/auto-loop (6.D). Plenty visible already so the user can build a Goal
// tree by hand and confirm persistence.

interface Props {
  projectPath: string
  /** Bumped by the parent panel whenever a run mutated this project's data,
   *  so we re-fetch in lockstep with the Chats tab's tasks.json updates. */
  dataVersion?: number
}

export const GoalsTab = ({ projectPath, dataVersion }: Props) => {
  const [data, setData] = useState<ProjectData | null>(null)
  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/project?path=${encodeURIComponent(projectPath)}`,
        { cache: 'no-store' },
      )
      if (!res.ok) {
        setError('プロジェクトデータの読み込みに失敗しました')
        return
      }
      const next = (await res.json()) as ProjectData
      // Server may omit `goals` for legacy tasks.json — normalise to an
      // array here so downstream code doesn't have to .?  every access.
      if (!Array.isArray(next.goals)) next.goals = []
      setData(next)
      // Auto-select the first Goal so the user lands on something useful
      // instead of an empty right pane.
      if (next.goals.length > 0 && !selectedGoalId) {
        setSelectedGoalId(next.goals[0].id)
      }
    } finally {
      setLoading(false)
    }
  }, [projectPath, selectedGoalId])

  useEffect(() => {
    void load()
  }, [load, dataVersion])

  // Phase 7 — keep the UI in sync with the server-driven run queue.
  // When any goal's runQueue is 'running', poll the project data every
  // 5s so milestone statuses + queue progress refresh without a full
  // SSE wire-up. Stops polling as soon as no queue is live, so we don't
  // pay the cost when the tab is idle.
  useEffect(() => {
    if (!data) return
    const anyRunning = (data.goals ?? []).some(g => g.runQueue?.status === 'running')
    if (!anyRunning) return
    const id = setInterval(() => { void load() }, 5000)
    return () => clearInterval(id)
  }, [data, load])

  const goals = data?.goals ?? []
  const milestones = data?.milestones ?? []
  const selectedGoal = goals.find(g => g.id === selectedGoalId) ?? null
  const goalMilestones = milestones
    .filter(m => m.goalId === selectedGoalId)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))

  // Signal that bumps when a freshly-created Goal needs its title focused
  // in the right pane. Linear / Notion-style: no prompt modal, just create
  // an untitled Goal and drop the cursor straight into the title field.
  const [focusTitleSignal, setFocusTitleSignal] = useState(0)
  // Inline 2-step delete confirm — see DeletePill below. Held at the
  // tab level so the rail and the row don't disagree on "is this armed?".
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null)

  const createGoal = async () => {
    // Snapshot the existing ids so we can pick out the brand-new Goal
    // regardless of where the server places it in the array.
    const before = new Set((data?.goals ?? []).map(g => g.id))
    const res = await api.api.project.goals.$post({
      json: {
        path: projectPath,
        op: 'add',
        // Start untitled — the right pane immediately focuses the title
        // input, which carries a "やりたいことを一言で（例: ログイン機能を
        // 実装）" placeholder. No modal, no system prompt; the field IS the
        // input affordance.
        title: '',
      },
    })
    if (!res.ok) {
      const e = (await res.json().catch(() => ({}))) as { error?: string }
      setError(e.error ?? '作成に失敗しました')
      return
    }
    const saved = (await res.json()) as ProjectData
    if (!Array.isArray(saved.goals)) saved.goals = []
    setData(saved)
    // Server unshifts the new Goal to the front, but find it by diffing ids
    // so we stay correct even if that placement ever changes.
    const newGoal = saved.goals.find(g => !before.has(g.id)) ?? saved.goals[0]
    if (newGoal) {
      setSelectedGoalId(newGoal.id)
      setFocusTitleSignal(s => s + 1)
    }
  }

  const deleteGoal = async (id: string) => {
    // Bypasses native confirm — the rail's hover-to-arm × is the
    // first step, this is the actual delete on second click.
    const res = await api.api.project.goals.$post({
      json: { path: projectPath, op: 'delete', goalId: id },
    })
    if (!res.ok) return
    const saved = (await res.json()) as ProjectData
    if (!Array.isArray(saved.goals)) saved.goals = []
    setData(saved)
    if (selectedGoalId === id) {
      setSelectedGoalId(saved.goals[0]?.id ?? null)
    }
    setConfirmingDeleteId(null)
  }

  const patchGoal = async (id: string, patch: Partial<Goal>) => {
    const res = await api.api.project.goals.$post({
      json: { path: projectPath, op: 'update', goalId: id, patch },
    })
    if (!res.ok) return
    const saved = (await res.json()) as ProjectData
    if (!Array.isArray(saved.goals)) saved.goals = []
    setData(saved)
  }

  const addMilestone = async (input: {
    name: string
    description?: string
    verifyCommands?: string[]
  }) => {
    if (!selectedGoalId) return
    await addMilestones([
      {
        name: input.name,
        description: input.description,
        verifyCommands: input.verifyCommands,
        order: goalMilestones.length,
      },
    ])
  }

  const addMilestones = async (
    inputs: Array<{
      name: string
      description?: string
      verifyCommands?: string[]
      order?: number
    }>,
  ) => {
    if (!selectedGoalId || inputs.length === 0) return
    const res = await api.api.project.milestones.$post({
      json: {
        path: projectPath,
        op: 'add',
        milestones: inputs.map(m => ({
          name: m.name,
          description: m.description,
          verifyCommands: m.verifyCommands,
          order: m.order,
          goalId: selectedGoalId,
        })),
      },
    })
    if (!res.ok) return
    const saved = (await res.json()) as ProjectData
    if (!Array.isArray(saved.goals)) saved.goals = []
    setData(saved)
  }

  const patchMilestone = async (id: string, patch: Partial<ProjectMilestone>) => {
    const res = await api.api.project.milestones.$post({
      json: {
        path: projectPath,
        op: 'update',
        milestoneId: id,
        patch,
      },
    })
    if (!res.ok) return
    const saved = (await res.json()) as ProjectData
    if (!Array.isArray(saved.goals)) saved.goals = []
    setData(saved)
  }

  const runMilestone = async (id: string) => {
    // Flip to in_progress optimistically so the badge updates immediately.
    setData(d => {
      if (!d) return d
      return {
        ...d,
        milestones: d.milestones.map(m =>
          m.id === id ? { ...m, status: 'in_progress' as const } : m,
        ),
      }
    })
    const res = await api.api.project.milestones.run.$post({
      json: { path: projectPath, milestoneId: id },
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      // Revert the optimistic flip; the runner never accepted the kickoff.
      await load()
      throw new Error(body.error ?? `run failed (${res.status})`)
    }
    // The session itself is registered in the global runner; the runner's
    // auto-verify step will update tasks.json on its own when the round
    // settles. Re-fetch once now so the UI shows the kickoff state, then
    // rely on `dataVersion` bumps from the parent (Chats SSE → settling)
    // to pull the final state.
    await load()
  }

  const verifyMilestone = async (id: string) => {
    // Optimistic status flip so the row shows VERIFYING while shell runs.
    setData(d => {
      if (!d) return d
      return {
        ...d,
        milestones: d.milestones.map(m =>
          m.id === id ? { ...m, status: 'verifying' as const } : m,
        ),
      }
    })
    const res = await api.api.project.milestones.verify.$post({
      json: { path: projectPath, milestoneId: id },
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      // Revert optimistic state on failure — caller surfaces the error.
      await load()
      throw new Error(body.error ?? `verify failed (${res.status})`)
    }
    const payload = (await res.json()) as { data: ProjectData }
    if (!Array.isArray(payload.data.goals)) payload.data.goals = []
    setData(payload.data)
  }

  const deleteMilestone = async (id: string) => {
    // Inline confirm lives on MilestoneRow; this just executes.
    const res = await api.api.project.milestones.$post({
      json: {
        path: projectPath,
        op: 'delete',
        milestoneId: id,
      },
    })
    if (!res.ok) return
    const saved = (await res.json()) as ProjectData
    if (!Array.isArray(saved.goals)) saved.goals = []
    setData(saved)
  }

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden bg-bg">
      {/* Left rail — Goal list */}
      <aside className="flex w-[280px] shrink-0 flex-col border-r border-line bg-bg-card">
        <header className="flex items-center justify-between border-b border-line-soft px-4 py-3">
          <span className="label-cap text-ink-muted">GOALS</span>
          <Btn variant="ghost" size="xs" onClick={createGoal} title="新しい Goal を作成">
            <Plus size={11} strokeWidth={2} /> New
          </Btn>
        </header>

        {error && (
          <div className="border-b border-line-soft px-4 py-2 text-[11px] text-accent">
            {error}
          </div>
        )}

        <ul className="flex-1 overflow-y-auto py-1">
          {goals.length === 0 && !loading && (
            <li className="px-4 py-6 text-[12px] leading-relaxed text-ink-faint">
              まだ Goal がありません。<br />
              「+ New」で最初のゴールを作りましょう。
            </li>
          )}
          {goals.map(g => {
            const active = g.id === selectedGoalId
            const mCount = milestones.filter(m => m.goalId === g.id).length
            const arming = confirmingDeleteId === g.id
            return (
              <li key={g.id}>
                <div
                  className={[
                    'group flex w-full items-start gap-2 px-4 py-2.5 transition-colors',
                    active
                      ? 'bg-bg text-ink'
                      : 'text-ink-muted hover:bg-bg/60 hover:text-ink',
                  ].join(' ')}
                >
                  <button
                    type="button"
                    onClick={() => setSelectedGoalId(g.id)}
                    className="flex min-w-0 flex-1 items-start gap-2 text-left"
                  >
                    <Target
                      size={12}
                      strokeWidth={2}
                      className={
                        active ? 'mt-[3px] text-accent' : 'mt-[3px] text-ink-faint'
                      }
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12.5px] leading-snug">
                        {g.title || '(無題)'}
                      </p>
                      <p className="mt-0.5 label-cap text-ink-faint">
                        {g.status} · {mCount} milestones
                      </p>
                    </div>
                  </button>
                  {/* Inline 2-step delete: first click arms (label flips to
                      "削除する?"), second click confirms. ESC / clicking
                      anywhere else clears the armed state. No system modal. */}
                  {arming ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        void deleteGoal(g.id)
                      }}
                      onBlur={() => setConfirmingDeleteId(null)}
                      autoFocus
                      title="もう一度クリックで削除"
                      className="flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 label-cap text-accent hover:bg-accent/10"
                    >
                      <Trash2 size={11} strokeWidth={1.75} /> 削除する?
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        setConfirmingDeleteId(g.id)
                      }}
                      title="この Goal を削除 (もう一度クリックで確定)"
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-ink-faint opacity-0 transition-opacity hover:bg-bg-inset hover:text-accent group-hover:opacity-100"
                    >
                      <Trash2 size={11} strokeWidth={1.75} />
                    </button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      </aside>

      {/* Right pane — Goal detail or empty state */}
      <main className="flex min-w-0 flex-1 flex-col">
        {selectedGoal ? (
          <GoalDetail
            projectPath={projectPath}
            goal={selectedGoal}
            milestones={goalMilestones}
            onPatchGoal={patch => patchGoal(selectedGoal.id, patch)}
            onAddMilestone={addMilestone}
            onAddMilestones={addMilestones}
            onPatchMilestone={patchMilestone}
            onDeleteMilestone={deleteMilestone}
            onVerifyMilestone={verifyMilestone}
            onRunMilestone={runMilestone}
            onReload={load}
            focusTitleSignal={focusTitleSignal}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-10 text-center">
            <div className="max-w-[440px]">
              <Target
                size={32}
                strokeWidth={1.25}
                className="mx-auto mb-4 text-ink-faint"
              />
              <h2 className="font-display text-[20px] leading-snug text-ink">
                Tasks タブへようこそ
              </h2>
              <p className="mt-3 text-[12.5px] leading-relaxed text-ink-muted">
                大きなタスクを <em>Goal</em> として宣言し、達成された状態を
                観測可能な形で書きます。Claude がそこから逆算して
                マイルストーンと verify command を提案します。
              </p>
              <div className="mt-6">
                <Btn variant="primary" size="sm" onClick={createGoal}>
                  <Plus size={11} strokeWidth={2} /> 最初の Goal を作る
                </Btn>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

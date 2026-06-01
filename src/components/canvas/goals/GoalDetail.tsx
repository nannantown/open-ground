import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AlertTriangle, HelpCircle, Plus, Play, RotateCcw, Sparkles, Target, X } from 'lucide-react'
import { Btn } from '@/components/ui/Btn'
import type { Goal, ProjectMilestone, RunSession } from '@/lib/types'
import { parseMilestonesPlan, type MilestonePlanItem } from '@/lib/milestonesPlan'
import { api } from '@/lib/api-client'
import { MilestoneRow } from './MilestoneRow'
import { GoalJourney } from './GoalJourney'

interface Props {
  projectPath: string
  goal: Goal
  milestones: ProjectMilestone[]
  onPatchGoal: (patch: Partial<Goal>) => void
  onAddMilestone: (input: {
    name: string
    description?: string
    verifyCommands?: string[]
  }) => void
  onAddMilestones: (
    inputs: Array<{
      name: string
      description?: string
      verifyCommands?: string[]
      order?: number
    }>,
  ) => Promise<void>
  onPatchMilestone: (id: string, patch: Partial<ProjectMilestone>) => void
  onDeleteMilestone: (id: string) => void
  onVerifyMilestone?: (id: string) => Promise<void>
  onRunMilestone?: (id: string) => Promise<void>
  /** Force a refetch of the project data — called after run-queue ops so
   *  the UI sees the queue state the server just persisted. */
  onReload?: () => Promise<void> | void
  /** Bumped by the parent when a freshly-created Goal needs its (empty)
   *  title focused immediately so the user can type a one-liner over the
   *  placeholder without reaching for the mouse. */
  focusTitleSignal?: number
}

// Right pane of the Tasks tab: edit the Goal's title / description /
// completionCriteria, then list its milestones with inline edit. Phase 6.A
// is manual-CRUD only — no Claude plan button, no Run / Verify yet. Those
// arrive in 6.B / 6.C / 6.D.

export const GoalDetail = ({
  projectPath,
  goal,
  milestones,
  onPatchGoal,
  onAddMilestone,
  onAddMilestones,
  onPatchMilestone,
  onDeleteMilestone,
  onVerifyMilestone,
  onRunMilestone,
  onReload,
  focusTitleSignal,
}: Props) => {
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const titleRef = useRef<HTMLInputElement>(null)
  const whyRef = useRef<HTMLTextAreaElement>(null)
  // IME composition guard for the title input. While the user is mid-
  // composition (kana → kanji conversion), we must NOT PATCH on every
  // keystroke and must NOT auto-select — doing so steals the first
  // character of Japanese input. We hold an edited copy of the title
  // locally and only flush it to the server on compositionend / change
  // (when not composing).
  const composingTitle = useRef(false)
  const [titleDraft, setTitleDraft] = useState(goal.title)

  // Keep the local draft in sync when the parent hands us a different
  // Goal (or the server echoes a saved title back) — but never clobber
  // what the user is actively composing.
  useEffect(() => {
    if (composingTitle.current) return
    setTitleDraft(goal.title)
  }, [goal.id, goal.title])

  // Empty titles are allowed now — a Goal can live untitled (the rail / hero
  // fall back to "(無題)") so we persist whatever the user leaves, including
  // an empty string when they clear it. We still skip the PATCH when nothing
  // actually changed.
  const commitTitle = (raw: string) => {
    const next = raw.trim()
    if (next === goal.title) return
    onPatchGoal({ title: next })
  }

  // When the parent says "a fresh Goal was just created", focus the title
  // so the user can type immediately. New Goals start empty, so there's
  // nothing to select — we just place the caret and the placeholder guides
  // the user. We only .select() when an existing Goal already has real text
  // to overwrite, and never mid-IME-composition (auto-select on a freshly-
  // focused input races IME and eats the first kana of Japanese input).
  useEffect(() => {
    if (!focusTitleSignal) return
    const el = titleRef.current
    if (!el) return
    // requestAnimationFrame so the focus lands after the batched render
    // flushes; otherwise focus can race the input's mount.
    const id = requestAnimationFrame(() => {
      if (composingTitle.current) return
      el.focus()
      // New Goals start with an empty title, so there's nothing to select —
      // we just place the caret and let the placeholder guide the user.
      // Only .select() when an existing Goal already has real text to
      // overwrite (and never mid-IME-composition, which would eat the first
      // kana of Japanese input).
      const cur = el.value.trim()
      if (cur) el.select()
    })
    return () => cancelAnimationFrame(id)
  }, [focusTitleSignal])
  const [planning, setPlanning] = useState(false)
  const [planError, setPlanError] = useState<string | null>(null)
  const [planPreview, setPlanPreview] = useState<MilestonePlanItem[] | null>(null)
  const [planSessionId, setPlanSessionId] = useState<string | null>(null)

  // Poll `/api/run/list` while a plan session is in flight. The session
  // completes asynchronously (Claude has to think + write the marker), so
  // we don't block the user — just flip the button to "Generating…" and
  // surface the parsed result when it's ready. 2 s polling is fast enough
  // for the user-visible "this is working" feedback and slow enough that
  // a busy cockpit isn't hammered by extra requests.
  useEffect(() => {
    if (!planSessionId) return
    let cancelled = false
    const settle = (parsed: MilestonePlanItem[] | null, errMsg?: string) => {
      if (cancelled) return
      if (parsed && parsed.length > 0) {
        setPlanPreview(parsed)
        setPlanError(null)
      } else if (errMsg) {
        setPlanError(errMsg)
      }
      setPlanSessionId(null)
      setPlanning(false)
    }
    const tick = async () => {
      try {
        const res = await api.api.run.list.$get({}, { init: { cache: 'no-store' } })
        if (!res.ok) return
        const body = (await res.json()) as { sessions: RunSession[] }
        const sess = body.sessions.find(s => s.id === planSessionId)
        if (!sess) return
        const e = sess.entries[0]
        if (!e) return
        // Whatever the session's final state — done / cancelled / error —
        // if the log carries a parseable MILESTONES_PLAN marker, use it.
        // This rescues runs where Claude forgot to emit OPENGROUND_RESULT
        // (the runner then calls them 'cancelled' on PTY close) but still
        // wrote the plan marker we actually care about.
        if (
          e.status === 'done' ||
          e.status === 'cancelled' ||
          e.status === 'error'
        ) {
          const parsed = parseMilestonesPlan(e.log ?? '')
          if (parsed && parsed.length > 0) {
            settle(parsed)
            return
          }
          if (e.status === 'cancelled') {
            settle(null, '生成が中断されました。もう一度お試しください。')
          } else if (e.status === 'error') {
            settle(null, 'Claude の起動に失敗しました。Chats タブのログを確認してください。')
          } else {
            settle(
              null,
              'マイルストーンを取り出せませんでした。Chats タブで Claude の出力を確認するか、もう一度お試しください。',
            )
          }
        }
      } catch {
        /* transient — keep polling */
      }
    }
    const id = setInterval(() => void tick(), 2000)
    // Also kick once immediately so quick plans don't wait 2 s for the
    // first poll.
    void tick()
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [planSessionId])

  const triggerPlan = async () => {
    if (planning) return
    // Accept any of the structured fields as a planning input. Claude only
    // needs *something* to bite on — Why / Outcome / AC / OOS / legacy
    // completionCriteria are all useful context.
    const hasMaterial =
      goal.description.trim().length > 0 ||
      (goal.outcome ?? '').trim().length > 0 ||
      (goal.acceptanceCriteria ?? []).some(s => s.trim().length > 0) ||
      (goal.outOfScope ?? []).some(s => s.trim().length > 0) ||
      goal.completionCriteria.trim().length > 0
    if (!hasMaterial) {
      setPlanError(
        'Why / Outcome / Acceptance Criteria のどれかを 1 行でも書いてください（Claude が逆算するための材料です）',
      )
      return
    }
    setPlanning(true)
    setPlanError(null)
    setPlanPreview(null)
    try {
      const res = await api.api.project.goals.plan.$post({
        json: { path: projectPath, goalId: goal.id },
      })
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string }
        setPlanError(err.error ?? '生成セッションの起動に失敗しました')
        setPlanning(false)
        return
      }
      const payload = (await res.json()) as { session: RunSession }
      setPlanSessionId(payload.session.id)
    } catch (e) {
      setPlanError(e instanceof Error ? e.message : 'ネットワークエラー')
      setPlanning(false)
    }
  }

  const applyPlan = async () => {
    if (!planPreview) return
    await onAddMilestones(
      planPreview.map((m, i) => ({
        name: m.name,
        description: m.description,
        verifyCommands: m.verifyCommands,
        order: typeof m.order === 'number' ? m.order : milestones.length + i,
      })),
    )
    setPlanPreview(null)
  }

  const submitAdd = () => {
    const name = newName.trim()
    if (!name) return
    onAddMilestone({ name })
    setNewName('')
    setAdding(false)
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-[760px] px-10 py-10">
        {/* Header */}
        <header className="mb-6 flex items-start gap-3">
          <Target size={22} strokeWidth={1.5} className="mt-1.5 text-accent" />
          <div className="min-w-0 flex-1">
            <input
              ref={titleRef}
              value={titleDraft}
              onChange={e => {
                setTitleDraft(e.target.value)
                // Only PATCH live when NOT mid-IME-composition. The final
                // value is flushed again on compositionend / blur.
                if (!composingTitle.current) commitTitle(e.target.value)
              }}
              onCompositionStart={() => {
                composingTitle.current = true
              }}
              onCompositionEnd={e => {
                composingTitle.current = false
                // Composition just settled — flush the confirmed text.
                const v = (e.target as HTMLInputElement).value
                setTitleDraft(v)
                commitTitle(v)
              }}
              onBlur={() => {
                if (composingTitle.current) return
                commitTitle(titleDraft)
              }}
              onKeyDown={e => {
                // Ignore Enter while composing — that Enter just confirms the
                // IME candidate; it must not move focus mid-conversion.
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && !composingTitle.current) {
                  e.preventDefault()
                  whyRef.current?.focus()
                }
              }}
              placeholder="やりたいことを一言で（例: ログイン機能を実装）"
              className="block w-full cursor-text border-b-2 border-transparent bg-transparent font-display text-[28px] leading-tight text-ink transition-colors placeholder:text-ink-faint hover:border-line focus:border-accent focus:outline-none"
            />
          </div>
        </header>

        {/* Journey map — the Goal's milestones as a winding route from START
            to the GOAL flag (replaces the flat progress bar). */}
        <section className="mb-5">
          <GoalJourney goal={goal} milestones={milestones} />
        </section>

        {/* Why + Outcome side by side on desktop — short prose fields pair well
            and halve the vertical scroll. Stacks on narrow widths. */}
        <div className="grid items-stretch gap-x-5 gap-y-4 md:grid-cols-2">
          <Section
            grow
            label="背景"
            hint="なぜこの Goal が必要か（動機・背景・解決したい問題）。OKR でいう Objective の理由づけ。"
          >
            <AutoTextarea
              textareaRef={whyRef}
              value={goal.description}
              onChange={v => onPatchGoal({ description: v })}
              placeholder="例: 認証がなく、ユーザーごとのデータ分離ができていない"
              className="grow"
            />
          </Section>

          <Section
            grow
            label="目指す状態"
            hint="達成された時の「世界の状態」を 1〜2 文で。動作ではなく結果を書く（SMART: Relevant）。"
          >
            <AutoTextarea
              value={goal.outcome ?? ''}
              onChange={v => onPatchGoal({ outcome: v })}
              placeholder="例: email + password でログインでき、リロードしても状態が保たれる"
              className="grow"
            />
          </Section>
        </div>

        {/* Acceptance Criteria + Out of Scope full-width, stacked. These are
            one-item-per-line lists each with their own + ADD button; placing
            two such variable-height lists side by side made the columns ragged
            (the + ADD buttons landed at different heights). Full width keeps
            them tidy and gives list rows a comfortable line length. */}
        <div className="mt-1">
          <Section
            label="受入基準"
            hint="観測可能な条件を 1 行 1 件で。Given / When / Then 形式が分かりやすい（INVEST: Testable）。各行が後で Milestone の verify command に対応します。"
          >
            <ListEditor
              items={goal.acceptanceCriteria ?? []}
              onChange={next => onPatchGoal({ acceptanceCriteria: next })}
              placeholder="例: Given 正しいパスワード, When ログイン, Then ホームが表示される"
            />
          </Section>

          <Section
            label="やらないこと"
            hint="この Goal に含めないこと。スコープクリープを防ぎ、Claude に「ここまで」を伝える明示。"
          >
            <ListEditor
              items={goal.outOfScope ?? []}
              onChange={next => onPatchGoal({ outOfScope: next })}
              placeholder="例: ソーシャルログイン / パスワードリセットは別 Goal"
            />
          </Section>
        </div>

        {/* Legacy free-form completion criteria — only shown when non-empty
            (Goals created before this restructure keep their text visible
            but new Goals are guided into the structured sections above). */}
        {goal.completionCriteria.trim() && (
          <Section
            label="(旧) 完了条件 — 自由記述"
            hint="旧フォーマットの自由記述です。上の構造化フィールドに移しおえたら空にして OK。"
          >
            <AutoTextarea
              value={goal.completionCriteria}
              onChange={v => onPatchGoal({ completionCriteria: v })}
            />
          </Section>
        )}

        {/* Milestones */}
        <section>
          <header className="mb-3 flex items-baseline justify-between gap-2">
            <p className="label-cap text-ink-muted">マイルストーン</p>
            <div className="flex items-center gap-1.5">
              {onRunMilestone && (
                <RunAllButton
                  projectPath={projectPath}
                  goal={goal}
                  milestones={milestones}
                  onReload={onReload}
                />
              )}
              <Btn
                variant="ghost"
                size="xs"
                onClick={triggerPlan}
                disabled={planning}
                title="Claude に Goal を逆算してマイルストーン候補を提案させる"
              >
                <Sparkles size={11} strokeWidth={2} />
                {planning ? '生成中…' : 'マイルストーン生成'}
              </Btn>
              {!adding && (
                <Btn variant="ghost" size="xs" onClick={() => setAdding(true)}>
                  <Plus size={11} strokeWidth={2} /> 追加
                </Btn>
              )}
            </div>
          </header>

          {planError && (
            <p className="mb-3 rounded-[2px] border border-accent/40 bg-accent/5 px-2.5 py-1.5 text-[11.5px] text-accent">
              {planError}
            </p>
          )}

          {planPreview && (
            <PlanPreview
              items={planPreview}
              onApply={applyPlan}
              onChange={setPlanPreview}
              onCancel={() => setPlanPreview(null)}
            />
          )}

          {adding && (
            <div className="mb-3 rounded-[3px] border border-dashed border-line-soft bg-bg-card px-3 py-3">
              <input
                autoFocus
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => {
                  // Don't submit on the Enter that confirms an IME candidate —
                  // only on a real, non-composing Enter.
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) submitAdd()
                  else if (e.key === 'Escape') {
                    setAdding(false)
                    setNewName('')
                  }
                }}
                placeholder="名前だけでOK（あとから直せます）"
                className="block w-full rounded-[2px] border border-line bg-bg px-3 py-2 text-[13px] text-ink focus:border-accent focus:outline-none"
              />
              <div className="mt-2 flex justify-end gap-1.5">
                <Btn
                  variant="ghost"
                  size="xs"
                  onClick={() => {
                    setAdding(false)
                    setNewName('')
                  }}
                >
                  キャンセル
                </Btn>
                <Btn variant="primary" size="xs" onClick={submitAdd}>
                  追加
                </Btn>
              </div>
            </div>
          )}

          {milestones.length === 0 && !adding && (
            <p className="rounded-[3px] border border-dashed border-line-soft bg-bg-card/60 px-4 py-6 text-center text-[12px] text-ink-faint">
              まだマイルストーンがありません。<br />
              「+ 追加」から短い名前でひとつ作ってみてください（あとから直せます）。
            </p>
          )}

          <div className="space-y-2">
            {milestones.map((m, i) => (
              <MilestoneRow
                key={m.id}
                index={i}
                milestone={m}
                onPatch={patch => onPatchMilestone(m.id, patch)}
                onDelete={() => onDeleteMilestone(m.id)}
                onVerify={
                  onVerifyMilestone ? () => onVerifyMilestone(m.id) : undefined
                }
                onRun={
                  onRunMilestone ? () => onRunMilestone(m.id) : undefined
                }
              />
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

// Phase 7 — sequential milestone runner, driven by the server-side
// `Goal.runQueue` (see /api/project/goals/run-queue). The button is a
// pure state machine over `goal.runQueue.status`:
//
//   idle / undefined  → "すべて実行 (N)"         calls op:'start'
//   running           → "一時停止"               calls op:'pause' + progress
//   paused / failed   → "Resume (from M+1/N)"    calls op:'resume'
//   completed         → "全 milestone verified" + Reset (op:'cancel')
//
// All progress lives on disk in tasks.json, so a dev-server crash or a
// tab close doesn't lose the sequence — the next time anyone opens
// this Goal, the same button reflects exactly where we are and offers
// the right next action.
const RunAllButton = ({
  projectPath,
  goal,
  milestones,
  onReload,
}: {
  projectPath: string
  goal: Goal
  milestones: ProjectMilestone[]
  onReload?: () => Promise<void> | void
}) => {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const queue = goal.runQueue

  const op = async (operation: 'start' | 'pause' | 'resume' | 'cancel') => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.api.project.goals['run-queue'].$post({
        json: { path: projectPath, goalId: goal.id, op: operation },
      })
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(e.error ?? `op ${operation} failed (${res.status})`)
      }
      if (onReload) await onReload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // Pending = anything not yet verified. Used to drive the "start" CTA
  // label and to suppress the button entirely when there's literally
  // nothing left to do (Goal verified, no queue ever needed).
  const pendingCount = milestones.filter(
    m =>
      (m.status ?? 'pending') !== 'verified' &&
      (m.verifyCommands ?? []).some(c => c.trim()),
  ).length

  // No queue yet, and no work to queue → render nothing (matches old behaviour).
  if (!queue && pendingCount === 0) return null

  const total = queue?.milestoneIds.length ?? pendingCount
  const doneSoFar = queue?.currentIndex ?? 0
  const status = queue?.status ?? 'idle'

  // Stranded detection. The server's startup sweep GCs queues left
  // 'running' after a crash, but between the crash and the next sweep (or
  // if the sweep never runs) a queue can sit 'running' forever with no
  // milestone actually in flight — the UI would just show "一時停止 (n/n)"
  // and poll uselessly. We flag it as stranded when it claims to be
  // running but hasn't moved in a while, and offer a one-click reset
  // (op:'cancel' → idle) so the user isn't stuck. Minimal: a badge + a
  // reset button, no auto-recovery.
  const STRANDED_MS = 5 * 60 * 1000 // 5 min without queue progress
  const lastActivity = queue?.lastActivityAt
    ? Date.parse(queue.lastActivityAt)
    : NaN
  const stranded =
    status === 'running' &&
    Number.isFinite(lastActivity) &&
    Date.now() - lastActivity > STRANDED_MS

  let label: string
  let action: 'start' | 'pause' | 'resume' | 'cancel' | null = null
  let title: string
  let tone: 'primary' | 'ghost' = 'ghost'
  let disabled = busy
  if (status === 'running') {
    label = `一時停止 (${doneSoFar}/${total})`
    action = 'pause'
    title = '走行中のマイルストーンは止めない。次の自動 kick だけを抑止する。'
  } else if (status === 'paused' || status === 'failed') {
    label = `Resume (${doneSoFar + 1}/${total} から)`
    action = 'resume'
    tone = 'primary'
    title =
      status === 'failed'
        ? 'verify に失敗して停止中。直してから再開すると次の milestone から続行する。'
        : '一時停止中。次の milestone から再開する。'
  } else if (status === 'completed') {
    label = '全 milestone verified'
    action = 'cancel'
    title = 'queue をクリアして idle に戻す（履歴 sessions[] はそのまま残る）。'
    disabled = busy
  } else {
    // idle / undefined
    label = `すべて実行 (${pendingCount})`
    action = pendingCount > 0 ? 'start' : null
    title =
      pendingCount === 0
        ? '残り pending milestone なし'
        : '残り pending milestone を順次実行 (verify pass で次へ、fail で停止)'
    disabled = busy || pendingCount === 0
  }

  return (
    <div className="flex items-center gap-1.5">
      {error && <span className="text-[11px] text-accent">{error}</span>}
      {stranded && (
        <span
          className="flex items-center gap-1 rounded-sm border border-accent/40 bg-accent/10 px-1.5 py-0.5 label-cap text-accent"
          title="この queue は running のまま進行が止まっています（直近の進捗から 5 分以上経過）。crash などで固着した可能性があります。Reset で idle に戻せます。"
        >
          <AlertTriangle size={10} strokeWidth={2} />
          固着
        </span>
      )}
      {stranded ? (
        // A stranded queue's normal action would be "一時停止" — useless when
        // nothing is actually running. Swap in a Reset (op:'cancel' → idle)
        // so the user can recover in one click.
        <Btn
          variant="ghost"
          size="xs"
          onClick={() => void op('cancel')}
          disabled={busy}
          title="固着した queue をクリアして idle に戻す（履歴 sessions[] は残る）。その後あらためて「すべて実行」できます。"
        >
          <RotateCcw size={10} strokeWidth={2} />
          Reset
        </Btn>
      ) : (
        <Btn
          variant={tone}
          size="xs"
          onClick={() => { if (action) void op(action) }}
          disabled={disabled || !action}
          title={title}
        >
          <Play size={10} fill="currentColor" />
          {label}
        </Btn>
      )}
    </div>
  )
}

// One-shot guidance block shown above the structured Goal sections.
// Distills the SMART / OKR / Acceptance Criteria literature into a short,
// scannable hint and offers a "テンプレート挿入" action that prefills the
// fields with example text so the user has something to edit rather than
// stare at empty boxes. We only flash this when the structured fields are
// all empty so existing Goals don't see the noise.
// Hover/focus hint. The "how to write a Goal" guidance used to be a wall of
// always-visible text above every field (heavy, scroll-inducing, and the guide
// box read like an input). Now each field's hint hides behind a small ⌖ icon
// next to its label — progressive disclosure. Hover or keyboard-focus reveals
// it; nothing is shown until asked for.
const InfoTip = ({ text }: { text: string }) => (
  <span className="group/tip relative inline-flex align-middle">
    <button
      type="button"
      aria-label="この項目の書き方"
      className="inline-flex h-4 w-4 items-center justify-center rounded-full text-ink-faint transition-colors hover:text-ink focus-visible:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-accent"
    >
      <HelpCircle size={12} strokeWidth={1.75} />
    </button>
    <span
      role="tooltip"
      className="pointer-events-none absolute left-0 top-full z-50 mt-1.5 w-72 rounded-[3px] border border-line bg-bg-card px-2.5 py-2 text-[11.5px] leading-relaxed text-ink-muted opacity-0 shadow-lg transition-opacity duration-150 group-hover/tip:opacity-100 group-focus-within/tip:opacity-100"
    >
      {text}
    </span>
  </span>
)

// Auto-growing textarea. Two belts:
//   1. `field-sizing: content` — native, zero-JS height-to-content (Chromium
//      126+, i.e. Electron 31 and the dev Chrome). This is the primary path.
//   2. A JS fallback (measure scrollHeight on input + on value change) so the
//      field still grows in any engine that hasn't shipped field-sizing.
// Either way the box shows the user's full text — never clipped, never a
// fixed-rows scroll-trap. `minRows` sets the resting height; there is no max,
// so long acceptance criteria stay fully visible.
const AutoTextarea = ({
  value,
  onChange,
  placeholder,
  minRows = 3,
  className = '',
  textareaRef,
  onCompositionStart,
  onCompositionEnd,
  ...rest
}: {
  value: string
  onChange: (next: string) => void
  placeholder?: string
  minRows?: number
  className?: string
  textareaRef?: React.RefObject<HTMLTextAreaElement>
} & Omit<
  React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  'value' | 'onChange' | 'className' | 'rows' | 'ref'
>) => {
  const innerRef = useRef<HTMLTextAreaElement>(null)
  const ref = textareaRef ?? innerRef

  // Mirror the controlled value locally and FREEZE it while an IME composition
  // is in flight. The parent round-trips edits (onChange → setState / async
  // PATCH → re-render with a new `value`). If that re-render reset the textarea
  // mid kana→kanji conversion, the IME composition aborts — which shows up as
  // "consonants don't register / can't type Japanese". Rendering `local` and
  // only re-syncing from the prop when NOT composing keeps the conversion
  // alive; we flush the confirmed text on compositionend.
  const composing = useRef(false)
  const [local, setLocal] = useState(value)
  useEffect(() => {
    if (!composing.current) setLocal(value)
  }, [value])

  // JS fallback: reset to auto then snap to scrollHeight. Harmless when
  // field-sizing already sized the box (scrollHeight == clientHeight).
  const grow = useCallback(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [ref])

  // Re-measure whenever the (local) value changes — useLayoutEffect so there's
  // no visible jump.
  useLayoutEffect(() => {
    grow()
  }, [grow, local])

  return (
    <textarea
      ref={ref}
      value={local}
      onChange={e => {
        setLocal(e.target.value)
        // While composing, only update the local mirror — don't push to the
        // parent (which round-trips through the server on every keystroke and
        // would reset us mid-conversion). The confirmed text is flushed on
        // compositionend.
        if (!composing.current) onChange(e.target.value)
      }}
      onCompositionStart={e => {
        composing.current = true
        onCompositionStart?.(e)
      }}
      onCompositionEnd={e => {
        composing.current = false
        const v = e.currentTarget.value
        setLocal(v)
        onChange(v)
        onCompositionEnd?.(e)
      }}
      placeholder={placeholder}
      rows={minRows}
      style={{ fieldSizing: 'content' } as React.CSSProperties}
      className={[
        'block w-full resize-none overflow-hidden rounded-[2px] border border-line bg-bg-card px-3 py-2.5 text-[13px] leading-relaxed text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none',
        className,
      ].join(' ')}
      {...rest}
    />
  )
}

// Labelled wrapper around a goal field. Label + a ⌖ hint icon on one compact
// line; the field sits directly under it. Accent (brick red) is reserved for
// primary actions and live status, not section emphasis.
const Section = ({
  label,
  hint,
  grow = false,
  children,
}: {
  label: string
  hint?: string
  // When true the section becomes a flex column that fills its grid cell, so a
  // `grow`-classed field inside stretches to the row's height. Used to make
  // side-by-side fields end at the same bottom edge regardless of text length.
  grow?: boolean
  children: React.ReactNode
}) => (
  <section className={grow ? 'mb-4 flex flex-col' : 'mb-4'}>
    <div className="mb-1.5 flex items-center gap-1">
      <p className="label-cap text-ink-muted">{label}</p>
      {hint && <InfoTip text={hint} />}
    </div>
    {children}
  </section>
)

// One-item-per-row editor for acceptanceCriteria / outOfScope. No "+ Add"
// button: pressing Enter in a row splits off a new row below (Shift+Enter
// keeps a newline inside the cell), and Backspace on an empty row removes it
// and moves up — the same muscle memory as a Notion / checklist editor. An
// empty list still shows one ready-to-type row.
const ListEditor = ({
  items,
  onChange,
  placeholder,
}: {
  items: string[]
  onChange: (next: string[]) => void
  placeholder?: string
}) => {
  const containerRef = useRef<HTMLDivElement>(null)
  // True while an IME composition is in flight in one of the rows. The Enter
  // that *confirms* a Japanese conversion must NOT be hijacked as "new row".
  const composing = useRef(false)
  // An empty list is shown as a single blank row so there's always something
  // to type into. Typing into it (updateAt(0, …)) creates the first item.
  const rows = items.length ? items : ['']

  const updateAt = (i: number, next: string) => {
    const out = items.slice()
    out[i] = next
    onChange(out)
  }
  const dropAt = (i: number) => {
    onChange(items.filter((_, j) => j !== i))
  }

  // Focus the textarea at `idx` after React has committed the new row set.
  const focusRow = (idx: number) => {
    requestAnimationFrame(() => {
      const el = containerRef.current?.querySelectorAll('textarea')[idx] as
        | HTMLTextAreaElement
        | undefined
      if (!el) return
      el.focus()
      const end = el.value.length
      el.setSelectionRange(end, end)
    })
  }

  const onRowKeyDown = (
    e: React.KeyboardEvent<HTMLTextAreaElement>,
    i: number,
  ) => {
    // While the IME is composing — or on the very keydown that confirms a
    // conversion (keyCode 229 / isComposing) — let the textarea handle the key
    // itself. Otherwise the Enter that commits Japanese gets stolen as "new
    // row" and the user can't type Japanese at all.
    if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) {
      return
    }
    // Enter (no Shift) makes a new row below.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if ((rows[i] ?? '').trim() === '') return // don't stack blank-after-blank
      const out = items.slice()
      out.splice(i + 1, 0, '')
      onChange(out)
      focusRow(i + 1)
      return
    }
    // Backspace at the very start of an empty row removes it and moves up.
    if (
      e.key === 'Backspace' &&
      (rows[i] ?? '') === '' &&
      items.length > 1
    ) {
      e.preventDefault()
      dropAt(i)
      focusRow(Math.max(0, i - 1))
    }
  }

  return (
    <div ref={containerRef} className="space-y-1.5">
      {rows.map((item, i) => (
        <div key={i} className="group relative">
          {/* No bullet/number: each row is already a bordered field box, so a
              marker only competes with the text and never aligns cleanly with
              a multi-line textarea. Same AutoTextarea as the prose fields —
              identical border, padding, font and auto-grow — so the whole form
              reads as one consistent field type. */}
          <AutoTextarea
            value={item}
            onChange={v => updateAt(i, v)}
            onKeyDown={e => onRowKeyDown(e, i)}
            onCompositionStart={() => {
              composing.current = true
            }}
            onCompositionEnd={() => {
              composing.current = false
            }}
            placeholder={placeholder}
            minRows={1}
          />
          {/* Delete button absolutely positioned top-right so the textarea keeps
              the full container width — its right edge lines up with the prose
              fields. Hidden until the row is hovered/focused; only shown once
              there's a real item to remove. */}
          {items.length > 0 && (
            <button
              type="button"
              onClick={() => dropAt(i)}
              title="この行を削除"
              aria-label="この行を削除"
              className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-sm bg-bg-card/90 text-ink-faint opacity-0 transition-opacity hover:bg-bg-inset hover:text-accent focus-visible:opacity-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-accent group-hover:opacity-100"
            >
              <X size={12} strokeWidth={1.75} />
            </button>
          )}
        </div>
      ))}
      <p className="select-none px-0.5 text-[10.5px] text-ink-faint">
        Enter で次の行 · Backspace で空行を削除
      </p>
    </div>
  )
}

// Inline editable preview of Claude's plan output. The user can tweak
// names / verifyCommands / drop items before committing — Claude's proposal
// is a suggestion, not a contract.
const PlanPreview = ({
  items,
  onApply,
  onChange,
  onCancel,
}: {
  items: MilestonePlanItem[]
  onApply: () => Promise<void>
  onChange: (next: MilestonePlanItem[]) => void
  onCancel: () => void
}) => {
  const [applying, setApplying] = useState(false)
  const update = (i: number, patch: Partial<MilestonePlanItem>) => {
    onChange(items.map((m, j) => (j === i ? { ...m, ...patch } : m)))
  }
  const drop = (i: number) => {
    onChange(items.filter((_, j) => j !== i))
  }
  const apply = async () => {
    setApplying(true)
    try {
      await onApply()
    } finally {
      setApplying(false)
    }
  }
  return (
    <div className="mb-4 space-y-3 rounded-[3px] border border-accent/40 bg-accent/5 p-3">
      <header className="flex items-baseline justify-between">
        <p className="label-cap text-accent">Claude の提案 · {items.length} 件</p>
        <button
          type="button"
          onClick={onCancel}
          className="flex h-5 w-5 items-center justify-center rounded-sm text-ink-faint hover:bg-bg-inset hover:text-ink"
          title="提案を破棄"
        >
          <X size={11} />
        </button>
      </header>
      <ul className="space-y-2">
        {items.map((m, i) => (
          <li
            key={i}
            className="group rounded-[2px] border border-line bg-bg-card px-3 py-2"
          >
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-[10px] text-ink-faint">
                {String(i + 1).padStart(2, '0')}
              </span>
              <input
                value={m.name}
                onChange={e => update(i, { name: e.target.value })}
                className="min-w-0 flex-1 bg-transparent text-[13px] leading-snug text-ink focus:outline-none"
              />
              <button
                type="button"
                onClick={() => drop(i)}
                title="この提案を採用しない"
                aria-label="この提案を採用しない"
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-ink-faint opacity-0 transition-opacity hover:bg-bg-inset hover:text-accent group-hover:opacity-100 focus:opacity-100"
              >
                <X size={11} strokeWidth={1.75} />
              </button>
            </div>
            {m.description && (
              <p className="mt-1 pl-7 text-[11.5px] leading-relaxed text-ink-muted">
                {m.description}
              </p>
            )}
            <div className="mt-1.5 pl-7">
              <textarea
                value={(m.verifyCommands ?? []).join('\n')}
                onChange={e =>
                  update(i, {
                    verifyCommands: e.target.value
                      .split('\n')
                      .map(l => l.trim())
                      .filter(Boolean),
                  })
                }
                rows={Math.max(1, (m.verifyCommands ?? []).length)}
                placeholder="verify commands (1 行 1 コマンド)"
                className="block w-full resize-y rounded-[2px] border border-line-soft bg-bg px-2 py-1 font-mono text-[11px] leading-relaxed text-ink focus:border-accent focus:outline-none"
              />
            </div>
          </li>
        ))}
      </ul>
      <div className="flex justify-end gap-1.5 pt-1">
        <Btn variant="ghost" size="xs" onClick={onCancel} disabled={applying}>
          キャンセル
        </Btn>
        <Btn variant="primary" size="xs" onClick={apply} disabled={applying || items.length === 0}>
          {applying ? '保存中…' : `${items.length} 件を追加`}
        </Btn>
      </div>
    </div>
  )
}

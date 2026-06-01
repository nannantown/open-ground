import { useEffect, useRef, useState } from 'react'
import { Trash2, ChevronDown, ChevronRight, CheckCircle2, Loader2, Play } from 'lucide-react'
import { Btn } from '@/components/ui/Btn'
import type { ProjectMilestone } from '@/lib/types'

interface Props {
  index: number
  milestone: ProjectMilestone
  onPatch: (patch: Partial<ProjectMilestone>) => void
  onDelete: () => void
  /** Phase 6.C — run the milestone's verifyCommands and update its
   *  lastVerify / status. Async because it shells out to /bin/sh. The
   *  parent owns the loading toast and re-fetches the goal tree on settle. */
  onVerify?: () => Promise<void>
  /** Phase 6.D — kick a Claude run targeted at this milestone. Returns
   *  when the run session is registered (not when Claude finishes). */
  onRun?: () => Promise<void>
}

// Status badge — colour-codes the milestone lifecycle. Same palette idiom
// as the chat run status badges (RunStatusBadge.tsx) so the user can scan
// either pane and instantly tell what's running / blocked.
const STATUS_STYLE: Record<
  NonNullable<ProjectMilestone['status']>,
  { label: string; cls: string }
> = {
  pending: { label: 'PENDING', cls: 'text-ink-faint' },
  in_progress: { label: 'RUNNING', cls: 'text-azure' },
  verifying: { label: 'VERIFY', cls: 'text-azure' },
  verified: { label: '✓ VERIFIED', cls: 'text-moss' },
  failed: { label: '✗ FAILED', cls: 'text-accent' },
  blocked: { label: 'BLOCKED', cls: 'text-accent' },
}

export const MilestoneRow = ({
  index,
  milestone,
  onPatch,
  onDelete,
  onVerify,
  onRun,
}: Props) => {
  const [expanded, setExpanded] = useState(false)
  const [name, setName] = useState(milestone.name)
  const [description, setDescription] = useState(milestone.description ?? '')
  const [verifyText, setVerifyText] = useState(
    (milestone.verifyCommands ?? []).join('\n'),
  )
  const [verifying, setVerifying] = useState(false)
  const [verifyError, setVerifyError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  // IME composition guard for the name input — see GoalDetail title input.
  // While composing Japanese, an Enter just confirms the candidate and a
  // blur/commit would PATCH a half-converted (or first-char-eaten) name.
  const composingName = useRef(false)
  // Inline 2-step delete (no system confirm). First click arms; the
  // button morphs to "削除する?" and self-cancels on blur.
  const [arming, setArming] = useState(false)

  const hasVerifyCommands = (milestone.verifyCommands ?? []).filter(c => c.trim())
    .length > 0

  const handleVerify = async () => {
    if (!onVerify || verifying || !hasVerifyCommands) return
    setVerifying(true)
    setVerifyError(null)
    try {
      await onVerify()
    } catch (e) {
      setVerifyError(e instanceof Error ? e.message : 'verify に失敗しました')
    } finally {
      setVerifying(false)
    }
  }

  const handleRun = async () => {
    if (!onRun || running) return
    setRunning(true)
    setRunError(null)
    try {
      await onRun()
    } catch (e) {
      setRunError(e instanceof Error ? e.message : 'run の起動に失敗しました')
    } finally {
      setRunning(false)
    }
  }

  // Keep local edit state in sync when the parent re-renders us with new
  // data (e.g. after Claude's plan generation lands a fresh proposal in
  // Phase 6.B).
  useEffect(() => {
    setName(milestone.name)
    setDescription(milestone.description ?? '')
    setVerifyText((milestone.verifyCommands ?? []).join('\n'))
  }, [milestone.id, milestone.name, milestone.description, milestone.verifyCommands])

  const status = milestone.status ?? 'pending'
  const badge = STATUS_STYLE[status]

  const commitName = () => {
    const next = name.trim()
    if (next && next !== milestone.name) onPatch({ name: next })
  }
  const commitDescription = () => {
    if (description !== (milestone.description ?? '')) {
      onPatch({ description })
    }
  }
  const commitVerify = () => {
    const next = verifyText
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
    const cur = milestone.verifyCommands ?? []
    if (next.length !== cur.length || next.some((c, i) => c !== cur[i])) {
      onPatch({ verifyCommands: next })
    }
  }

  return (
    <div className="rounded-[3px] border border-line bg-bg-card shadow-card">
      <header className="group/header flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          className="flex h-6 w-6 items-center justify-center rounded-sm text-ink-faint hover:bg-bg-inset hover:text-ink"
          title={expanded ? '折りたたむ' : '展開'}
        >
          {expanded ? (
            <ChevronDown size={12} strokeWidth={2} />
          ) : (
            <ChevronRight size={12} strokeWidth={2} />
          )}
        </button>
        <span className="font-mono text-[10px] text-ink-faint">
          {String(index + 1).padStart(2, '0')}
        </span>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          onCompositionStart={() => {
            composingName.current = true
          }}
          onCompositionEnd={() => {
            composingName.current = false
          }}
          onBlur={() => {
            if (composingName.current) return
            commitName()
          }}
          onKeyDown={e => {
            // Only blur (→ commit) on a real Enter, not the IME-confirm Enter.
            if (e.key === 'Enter' && !e.nativeEvent.isComposing && !composingName.current) {
              e.preventDefault()
              ;(e.currentTarget as HTMLInputElement).blur()
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-[13px] leading-snug text-ink focus:outline-none"
        />
        {/* Quick-action Run/Verify buttons in the collapsed header row.
            Visible on row hover so PENDING milestones expose their
            primary action without forcing the user to expand the row.
            Verified/blocked rows hide the buttons (nothing useful to do
            from the collapsed view). */}
        {onRun && hasVerifyCommands && status !== 'verified' && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              void handleRun()
            }}
            disabled={running || verifying}
            title="Claude にこのマイルストーン達成を依頼"
            aria-label="Run"
            className="hidden h-6 w-6 items-center justify-center rounded-sm text-ink-faint transition-colors hover:bg-accent/10 hover:text-accent disabled:opacity-40 group-hover/header:flex"
          >
            {running ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <Play size={10} fill="currentColor" />
            )}
          </button>
        )}
        {onVerify && hasVerifyCommands && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              void handleVerify()
            }}
            disabled={verifying || running}
            title="verify commands を実行して状態を確認"
            aria-label="Verify"
            className="hidden h-6 w-6 items-center justify-center rounded-sm text-ink-faint transition-colors hover:bg-bg-inset hover:text-ink disabled:opacity-40 group-hover/header:flex"
          >
            {verifying ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <CheckCircle2 size={11} strokeWidth={2} />
            )}
          </button>
        )}
        <span className={['label-cap', badge.cls].join(' ')}>{badge.label}</span>
        {arming ? (
          <button
            type="button"
            autoFocus
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
              setArming(false)
            }}
            onBlur={() => setArming(false)}
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
              setArming(true)
            }}
            title="削除 (もう一度クリックで確定)"
            className="flex h-6 w-6 items-center justify-center rounded-sm text-ink-faint hover:bg-bg-inset hover:text-accent"
          >
            <Trash2 size={11} strokeWidth={1.75} />
          </button>
        )}
      </header>

      {expanded && (
        <div className="space-y-3 border-t border-line-soft px-3 py-3">
          <div>
            <p className="mb-1 label-cap text-ink-muted">説明</p>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              onBlur={commitDescription}
              rows={2}
              placeholder="ひとことでOK（あとから直せます）"
              className="block w-full resize-y rounded-[2px] border border-line bg-bg px-2.5 py-1.5 text-[12.5px] leading-relaxed text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
            />
          </div>

          <div>
            <p className="mb-1 label-cap text-ink-muted">
              Verify commands{' '}
              <span className="font-mono normal-case tracking-normal text-ink-faint">
                (1 行 = 1 コマンド、全て exit 0 で pass)
              </span>
            </p>
            <textarea
              value={verifyText}
              onChange={e => setVerifyText(e.target.value)}
              onBlur={commitVerify}
              rows={3}
              placeholder="npm run lint&#10;npm run build&#10;test -f src/foo.ts"
              className="block w-full resize-y rounded-[2px] border border-line bg-bg px-2.5 py-1.5 font-mono text-[11.5px] leading-relaxed text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
            />
          </div>

          {milestone.lastVerify && (
            <div
              className={[
                'rounded-[2px] border px-2.5 py-2 text-[11px] leading-relaxed',
                milestone.lastVerify.passed
                  ? 'border-moss/40 bg-moss/5 text-moss'
                  : 'border-accent/40 bg-accent/5 text-accent',
              ].join(' ')}
            >
              <p className="label-cap">
                {milestone.lastVerify.passed ? 'Last verify: PASS' : 'Last verify: FAIL'}
                {milestone.lastVerify.retryCount > 0 && (
                  <span className="ml-2 font-mono normal-case tracking-normal text-ink-faint">
                    retry {milestone.lastVerify.retryCount}
                  </span>
                )}
              </p>
              {!milestone.lastVerify.passed &&
                milestone.lastVerify.outputs.length > 0 && (
                  <pre className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap rounded-[2px] bg-bg-card px-2 py-1 font-mono text-[10.5px] text-ink-muted">
                    {milestone.lastVerify.outputs.slice(-1)[0]}
                  </pre>
                )}
            </div>
          )}

          {verifyError && (
            <p className="text-[11px] text-accent">{verifyError}</p>
          )}

          {runError && <p className="text-[11px] text-accent">{runError}</p>}

          <div className="flex items-center justify-between gap-2 border-t border-line-soft pt-3">
            <p className="text-[10.5px] leading-relaxed text-ink-faint">
              {hasVerifyCommands
                ? 'Run = Claude にこのマイルストーン達成を依頼（完了後に自動 Verify、fail なら最大 5 回まで自走）。Verify = 既存のコードで commands を回すだけ。'
                : 'verify commands を 1 行以上書くと Verify / Run が有効になります。'}
            </p>
            <div className="flex shrink-0 items-center gap-1.5">
              <Btn
                variant="ghost"
                size="xs"
                onClick={handleVerify}
                disabled={verifying || running || !hasVerifyCommands || !onVerify}
              >
                {verifying ? (
                  <>
                    <Loader2 size={11} className="animate-spin" /> 検証中…
                  </>
                ) : (
                  <>
                    <CheckCircle2 size={11} strokeWidth={2} /> Verify
                  </>
                )}
              </Btn>
              <Btn
                variant="primary"
                size="xs"
                onClick={handleRun}
                disabled={running || verifying || !onRun || !hasVerifyCommands}
                title={
                  hasVerifyCommands
                    ? 'Claude を起動してこのマイルストーンを達成させる'
                    : 'verify commands が必要です'
                }
              >
                {running ? (
                  <>
                    <Loader2 size={10} className="animate-spin" /> 起動中…
                  </>
                ) : (
                  <>
                    <Play size={9} fill="currentColor" /> Run
                  </>
                )}
              </Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

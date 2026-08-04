import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { GitBranch, Loader2 } from 'lucide-react'
import { Overlay, DialogCard, DialogHeader } from '@/components/ui/overlay'
import { useT } from '@/i18n/I18nContext'
import type { BranchChangesResponse, FileDiffResponse, FileDiffScope } from '@/lib/types'

// "Branch changes" modal — opened from the ProjectPanel header's branch chip.
// Read-only view over GET /api/project/branch-changes: working-tree entries
// (git status) and what this branch changed vs the target (numstat), each row
// expandable into a unified diff fetched lazily from /api/project/file-diff.
// Text-first, minimal: no syntax highlighting, just +/− tinted mono lines.

interface Props {
  open: boolean
  path: string
  onClose: () => void
  /** Fresh fetch result bubbles up so the header chip stays in sync. */
  onData?: (d: BranchChangesResponse) => void
}

type DiffState =
  | { state: 'loading' }
  | { state: 'error'; error: string }
  | { state: 'done'; diff: string; truncated: boolean }

const diffKey = (scope: FileDiffScope, file: string) => `${scope}\0${file}`

// One unified-diff body. +/− lines get the moss/accent soft-tint pair from
// the app palette; hunk headers go azure; everything scrolls horizontally
// instead of wrapping (diff alignment is the point).
const DiffBody = ({ d }: { d: Extract<DiffState, { state: 'done' }> }) => {
  const { t } = useT()
  if (!d.diff.trim()) {
    return <p className="px-3 py-2 text-meta text-ink-faint">{t('projectPanel.branchDiffEmpty')}</p>
  }
  return (
    <div className="overflow-x-auto bg-bg">
      <pre className="min-w-max py-1 font-mono text-meta leading-[1.55]">
        {d.diff.split('\n').map((line, i) => {
          const cls =
            line.startsWith('+') && !line.startsWith('+++')
              ? 'bg-moss-soft text-moss'
              : line.startsWith('-') && !line.startsWith('---')
                ? 'bg-accent-soft text-accent-deeper'
                : line.startsWith('@@')
                  ? 'text-azure'
                  : 'text-ink-muted'
          return (
            <div key={i} className={`whitespace-pre px-3 ${cls}`}>
              {line || ' '}
            </div>
          )
        })}
      </pre>
      {d.truncated && (
        <p className="border-t border-line px-3 py-1.5 text-meta text-ink-faint">
          {t('projectPanel.branchDiffTruncated')}
        </p>
      )}
    </div>
  )
}

export const BranchChangesModal = ({ open, path, onClose, onData }: Props) => {
  const { t } = useT()
  const [info, setInfo] = useState<BranchChangesResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [diffs, setDiffs] = useState<Record<string, DiffState>>({})

  // Fresh data every time the modal opens (the chip's copy may be stale).
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setInfo(null)
    setError(null)
    setExpanded(new Set())
    setDiffs({})
    fetch(`/api/project/branch-changes?path=${encodeURIComponent(path)}`)
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as
          | BranchChangesResponse
          | { error?: string }
        if (cancelled) return
        if (!res.ok || !('isGit' in body)) {
          setError(('error' in body && body.error) || res.statusText)
          return
        }
        setInfo(body)
        onData?.(body)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : t('projectPanel.networkError'))
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, path])

  const toggleRow = useCallback(
    (scope: FileDiffScope, file: string) => {
      const key = diffKey(scope, file)
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(key)) {
          next.delete(key)
          return next
        }
        next.add(key)
        return next
      })
      setDiffs((prev) => {
        if (prev[key]) return prev // already fetched (or in flight)
        fetch(
          `/api/project/file-diff?path=${encodeURIComponent(path)}&file=${encodeURIComponent(file)}&scope=${scope}`,
        )
          .then(async (res) => {
            const body = (await res.json().catch(() => ({}))) as Partial<FileDiffResponse> & {
              error?: string
            }
            setDiffs((d) => ({
              ...d,
              [key]:
                res.ok && typeof body.diff === 'string'
                  ? { state: 'done', diff: body.diff, truncated: !!body.truncated }
                  : { state: 'error', error: body.error ?? res.statusText },
            }))
          })
          .catch((e: unknown) => {
            setDiffs((d) => ({
              ...d,
              [key]: {
                state: 'error',
                error: e instanceof Error ? e.message : t('projectPanel.networkError'),
              },
            }))
          })
        return { ...prev, [key]: { state: 'loading' } }
      })
    },
    [path, t],
  )

  if (!open) return null

  // A file row: status / ± stats LEFT, path truncating in the middle. The row
  // is a real button (hover / expanded / focus states per the UI skill).
  const fileRow = (
    scope: FileDiffScope,
    file: string,
    leading: ReactNode,
  ) => {
    const key = diffKey(scope, file)
    const isOpen = expanded.has(key)
    const diff = diffs[key]
    return (
      <li key={key} className="border-b border-line-soft last:border-b-0">
        <button
          onClick={() => toggleRow(scope, file)}
          aria-expanded={isOpen}
          className={[
            'flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors',
            'focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
            isOpen ? 'bg-bg-inset text-ink' : 'text-ink-muted hover:bg-plane hover:text-ink',
          ].join(' ')}
        >
          {leading}
          <span className="min-w-0 flex-1 truncate font-mono text-meta" title={file}>
            {file}
          </span>
          {diff?.state === 'loading' && (
            <Loader2 size={11} className="shrink-0 animate-spin text-ink-faint" />
          )}
        </button>
        {isOpen && diff && diff.state !== 'loading' && (
          <div className="border-t border-line-soft">
            {diff.state === 'error' ? (
              <p className="px-3 py-2 text-meta text-accent">
                {t('projectPanel.branchDiffFailed', { error: diff.error })}
              </p>
            ) : (
              <DiffBody d={diff} />
            )}
          </div>
        )}
      </li>
    )
  }

  const git = info && info.isGit ? info : null

  return (
    <Overlay onClose={onClose} aria-label={t('projectPanel.branchChangesTitle')}>
      <DialogCard
        className="w-[680px] max-w-[94vw] max-h-[82vh]"
        ariaLabel={t('projectPanel.branchChangesTitle')}
      >
        <DialogHeader
          separator="double"
          density="modal"
          align="start"
          onClose={onClose}
          closeLabel={t('common.close')}
          leading={
            <div className="min-w-0">
              <p className="label-cap mb-1.5 text-accent">{t('projectPanel.branchChangesTitle')}</p>
              {git && (
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="flex min-w-0 items-center gap-1.5 font-mono text-read text-ink">
                    <GitBranch size={13} strokeWidth={1.75} className="shrink-0 text-ink-muted" />
                    <span className="truncate">{git.branch ?? 'HEAD'}</span>
                  </span>
                  {git.target && !git.sameBranch && (
                    <>
                      <span className="text-ui text-ink-faint">→</span>
                      <span className="truncate font-mono text-ui text-ink-muted">{git.target}</span>
                      <span className="text-meta tabular-nums text-ink-faint">
                        {t('projectPanel.branchAheadBehind', {
                          ahead: String(git.ahead),
                          behind: String(git.behind),
                        })}
                      </span>
                    </>
                  )}
                </div>
              )}
            </div>
          }
        />

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {!info && !error && (
            <p className="flex items-center gap-2 text-ui text-ink-faint">
              <Loader2 size={12} className="animate-spin" /> {t('projectPanel.loading')}
            </p>
          )}
          {error && (
            <p className="text-ui leading-relaxed text-accent">
              {t('projectPanel.branchLoadFailed', { error })}
            </p>
          )}

          {git && (
            <div className="space-y-5">
              {/* ── Working tree ───────────────────────────────────────── */}
              <section>
                <h3 className="label-cap mb-1.5 text-ink-muted">
                  {t('projectPanel.branchWorkingHeading')}
                </h3>
                {git.working.length === 0 ? (
                  <p className="text-ui text-ink-faint">{t('projectPanel.branchNoChanges')}</p>
                ) : (
                  <ul className="rounded-[2px] border border-line">
                    {git.working.map((w) =>
                      fileRow(
                        'working',
                        w.path,
                        <span className="w-6 shrink-0 text-center font-mono text-micro text-ochre">
                          {w.status}
                        </span>,
                      ),
                    )}
                  </ul>
                )}
              </section>

              {/* ── Committed vs target ────────────────────────────────── */}
              <section>
                <h3 className="label-cap mb-1.5 text-ink-muted">
                  {git.target
                    ? t('projectPanel.branchCommittedHeading', { target: git.target })
                    : t('projectPanel.branchChangesTitle')}
                </h3>
                {!git.target ? (
                  <p className="text-ui leading-relaxed text-ink-faint">
                    {t('projectPanel.branchNoTarget')}
                  </p>
                ) : git.sameBranch ? (
                  <p className="text-ui leading-relaxed text-ink-faint">
                    {t('projectPanel.branchSameAsTarget')}
                  </p>
                ) : git.committed.length === 0 ? (
                  <p className="text-ui text-ink-faint">{t('projectPanel.branchNoChanges')}</p>
                ) : (
                  <ul className="rounded-[2px] border border-line">
                    {git.committed.map((f) =>
                      fileRow(
                        'branch',
                        f.path,
                        <span className="shrink-0 font-mono text-micro tabular-nums">
                          <span className="text-moss">+{f.additions}</span>{' '}
                          <span className="text-accent">−{f.deletions}</span>
                        </span>,
                      ),
                    )}
                  </ul>
                )}
              </section>
            </div>
          )}
        </div>
      </DialogCard>
    </Overlay>
  )
}

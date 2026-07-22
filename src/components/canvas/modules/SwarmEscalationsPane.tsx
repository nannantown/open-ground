import { useCallback, useEffect, useRef, useState } from 'react'
import { Inbox } from 'lucide-react'
import { useT } from '@/i18n/I18nContext'
import { Btn } from '@/components/ui/Btn'
import type {
  EscalationAnswerResponse,
  EscalationView,
  EscalationsResponse,
  EscalationWhy,
} from '@/lib/types'

// The Escalations inbox panel (C1 — docs/OVERSEER_DESIGN.md §8, Q5): the HUMAN
// VALVE of the unmanned swarm. Lists the OPEN questions the swarm raised to the
// owner — {question, stakes, the proxy's provisional answer, the worker's screen
// at the time} — and lets the owner answer (→ injected into the blocked worker /
// queued for its next dispatch, and written back to you-corpus memory) or
// dismiss. It used to be PINNED ABOVE the Swarm tab strip (a banner that stacked
// up over every sub-view); it now renders INSIDE the Overseer tab
// (SwarmOverseerPane) — read where the owner chooses to look, like the commander
// and worker views — and reports its open count up via `onOpenCountChange` so
// the tab label can carry the badge. Renders NOTHING while the inbox is empty
// (the Overseer pane owns the empty state). Polls the pure GET on a slow
// cadence; all mutation goes through the owner-gated POST routes. SwarmModule
// keeps this pane MOUNTED (hidden when another sub-view is active) so the poll —
// and therefore the badge — stays live no matter which view is open.
const POLL_MS = 10_000

const WHY_KEY: Record<EscalationWhy, string> = {
  irreversible: 'projectPanel.swarm.esc.whyIrreversible',
  'insufficient-info': 'projectPanel.swarm.esc.whyInsufficientInfo',
  policy: 'projectPanel.swarm.esc.whyPolicy',
}

export const SwarmEscalationsPane = ({
  projectPath,
  onOpenCountChange,
}: {
  projectPath: string
  /** Reports the OPEN-question count on every poll/action — SwarmModule shows it
   *  as the Overseer tab badge (the pane itself may be hidden). Optional so the
   *  pane stays usable standalone. */
  onOpenCountChange?: (count: number) => void
}) => {
  const { t } = useT()
  const [items, setItems] = useState<EscalationView[]>([])
  // Per-escalation draft answers. Only ever written by the textarea itself
  // (never rewritten from outside), so IME composition is never disturbed.
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/swarm/escalations?path=${encodeURIComponent(projectPath)}&status=open`,
      )
      if (!res.ok) return // signed-out / non-owner → panel simply stays empty
      const data = (await res.json()) as EscalationsResponse
      if (alive.current) setItems(data.escalations ?? [])
    } catch {
      /* transient network failure — the next poll recovers */
    }
  }, [projectPath])

  useEffect(() => {
    alive.current = true
    // A project switch must not show the PREVIOUS project's questions (or its
    // action feedback) for the first poll interval.
    setItems([])
    setDrafts({})
    setNotice(null)
    setError(null)
    setBusyId(null)
    void refresh()
    const timer = window.setInterval(() => {
      if (!document.hidden) {
        // The action feedback (notice/error) lives one poll cycle at most —
        // enough to read, never a permanent banner on an empty inbox.
        setNotice(null)
        setError(null)
        void refresh()
      }
    }, POLL_MS)
    return () => {
      alive.current = false
      window.clearInterval(timer)
    }
  }, [refresh])

  const act = useCallback(
    async (id: string, kind: 'answer' | 'dismiss', answer?: string) => {
      setBusyId(id)
      setError(null)
      setNotice(null)
      try {
        const res = await fetch(`/api/swarm/escalations/${kind}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(kind === 'answer' ? { id, answer } : { id }),
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null
          throw new Error(body?.error ?? `HTTP ${res.status}`)
        }
        if (kind === 'answer') {
          const data = (await res.json()) as EscalationAnswerResponse
          const deliveryKey =
            data.delivery === 'injected'
              ? 'projectPanel.swarm.esc.deliveryInjected'
              : data.delivery === 'queued'
                ? 'projectPanel.swarm.esc.deliveryQueued'
                : 'projectPanel.swarm.esc.deliverySkipped'
          setNotice(
            [t(deliveryKey), data.memoryWritten ? t('projectPanel.swarm.esc.memoryWritten') : '']
              .filter(Boolean)
              .join(' '),
          )
          setDrafts((d) => {
            const next = { ...d }
            delete next[id]
            return next
          })
        }
        await refresh()
      } catch (e) {
        setError(
          t('projectPanel.swarm.esc.actionFailed', {
            error: e instanceof Error ? e.message : String(e),
          }),
        )
      } finally {
        setBusyId(null)
      }
    },
    [refresh, t],
  )

  const open = items.filter((e) => e.status === 'open')

  // Surface the open count to the tab badge on every change (poll, answer,
  // dismiss, project switch) — the pane may be hidden while another sub-view is
  // active, so the badge is how a new question gets noticed.
  useEffect(() => {
    onOpenCountChange?.(open.length)
  }, [open.length, onOpenCountChange])

  // Invisible while empty — but keep showing the last action's outcome line
  // (the "answered → injected" feedback) until the next action or poll cycle.
  // The Overseer pane owns the inbox-empty state.
  if (open.length === 0 && !notice && !error) return null

  return (
    // A flat section INSIDE the Overseer tab (the old pinned-banner card chrome —
    // accent border, shadow, 45% height cap — went with the pinning; the tab is a
    // normal scroll surface now).
    <section
      aria-label={t('projectPanel.swarm.esc.title')}
      className="shrink-0 overflow-hidden rounded-[4px] border border-line bg-bg-card"
    >
      <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2">
        <Inbox size={13} strokeWidth={2} className="shrink-0 text-accent" aria-hidden />
        <span className="label-cap text-ink">{t('projectPanel.swarm.esc.title')}</span>
        {open.length > 0 && (
          <span className="rounded-full bg-accent-soft px-1.5 text-[11px] leading-[18px] text-accent">
            {open.length}
          </span>
        )}
      </div>

      {(notice || error) && (
        <p
          role="status"
          className={`border-b border-line-soft px-3 py-2 text-[11px] leading-relaxed ${error ? 'text-accent' : 'text-ink-muted'}`}
        >
          {error ?? notice}
        </p>
      )}

      <ul className="flex flex-col divide-y divide-line-soft">
        {open.map((e) => {
          // Busy is PER CARD: freezing sibling cards' textareas on every action
          // would yank focus and break mid-composition IME input.
          const busy = busyId === e.id
          const draft = drafts[e.id] ?? ''
          return (
            <li key={e.id} className="flex flex-col gap-2 px-3 py-3">
              {/* who/why line */}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span
                  className={`label-cap rounded-[2px] border px-1.5 py-0.5 ${
                    e.whyEscalated === 'irreversible'
                      ? 'border-accent/50 text-accent'
                      : 'border-line text-ink-muted'
                  }`}
                >
                  {t(WHY_KEY[e.whyEscalated])}
                </span>
                {e.branch && (
                  <span className="truncate font-mono text-[11px] text-ink-faint">{e.branch}</span>
                )}
                <span className="ml-auto text-[11px] text-ink-faint">
                  {new Date(e.createdAt).toLocaleString()}
                </span>
              </div>

              {/* 平易文 (plainQuestion) is the DEFAULT rendering — the owner is a
                  non-programmer; when it exists, the technical original
                  (question + context: file:line, branch, logs) folds behind a
                  <details>. Records predating the field (no plainQuestion)
                  keep the legacy layout: question primary, context secondary. */}
              {e.plainQuestion?.trim() ? (
                <>
                  <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink">
                    {e.plainQuestion}
                  </p>
                  <details className="min-w-0">
                    <summary className="cursor-pointer text-[11px] text-ink-faint hover:text-ink">
                      {t('projectPanel.swarm.esc.techDetails')}
                    </summary>
                    <div className="mt-1 flex flex-col gap-1">
                      <p className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-ink-muted">
                        {e.question}
                      </p>
                      <p className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-ink-muted">
                        {e.context}
                      </p>
                    </div>
                  </details>
                </>
              ) : (
                <>
                  <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink">
                    {e.question}
                  </p>
                  <p className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-ink-muted">
                    {e.context}
                  </p>
                </>
              )}

              {e.proxyDraft && (
                <div className="rounded-[2px] border border-line bg-bg-inset px-2.5 py-2">
                  <div className="flex items-center gap-2">
                    <span className="label-cap text-ink-faint">
                      {t('projectPanel.swarm.esc.proxyDraft', {
                        confidence: e.proxyDraft.confidence,
                      })}
                    </span>
                    {!e.proxyDraft.isAbstention && e.proxyDraft.answer.trim() !== '' && (
                      <Btn
                        variant="subtle"
                        size="xs"
                        disabled={busy}
                        className="enabled:active:scale-[0.99]"
                        onClick={() =>
                          setDrafts((d) => ({ ...d, [e.id]: e.proxyDraft?.answer ?? '' }))
                        }
                      >
                        {t('projectPanel.swarm.esc.useDraft')}
                      </Btn>
                    )}
                  </div>
                  {e.proxyDraft.isAbstention ? (
                    <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
                      {t('projectPanel.swarm.esc.abstention')}
                    </p>
                  ) : (
                    <p className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-ink-muted">
                      {e.proxyDraft.answer}
                    </p>
                  )}
                </div>
              )}

              {e.screenshot && (
                <details className="min-w-0">
                  <summary className="cursor-pointer text-[11px] text-ink-faint hover:text-ink">
                    {t('projectPanel.swarm.esc.screenshot')}
                  </summary>
                  <pre className="mt-1 max-h-48 overflow-auto rounded-[2px] border border-line bg-bg-inset p-2 font-mono text-[10px] leading-snug text-ink-muted">
                    {e.screenshot}
                  </pre>
                </details>
              )}

              <textarea
                value={draft}
                onChange={(ev) => setDrafts((d) => ({ ...d, [e.id]: ev.target.value }))}
                placeholder={t('projectPanel.swarm.esc.answerPlaceholder')}
                rows={2}
                disabled={busy}
                className="w-full resize-y rounded-[2px] border border-line bg-bg px-2 py-1.5 text-[12px] leading-relaxed text-ink placeholder:text-ink-faint hover:border-line-strong focus:border-accent focus:outline-none disabled:opacity-40"
              />
              <div className="flex items-center gap-2">
                <Btn
                  variant="primary"
                  size="xs"
                  disabled={busy || draft.trim() === ''}
                  onClick={() => void act(e.id, 'answer', draft.trim())}
                >
                  {t('projectPanel.swarm.esc.answerSend')}
                </Btn>
                <Btn
                  variant="subtle"
                  size="xs"
                  danger
                  disabled={busy}
                  className="enabled:active:scale-[0.99]"
                  onClick={() => void act(e.id, 'dismiss')}
                >
                  {t('projectPanel.swarm.esc.dismiss')}
                </Btn>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

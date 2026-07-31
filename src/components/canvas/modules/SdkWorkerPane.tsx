// SdkWorkerPane — one Agent SDK worker's tile.
//
// The counterpart of SwarmWorkerPane, which wraps ClaudeTerminalPane (xterm on
// a PTY). This one renders a STRUCTURED transcript instead, because an SDK
// worker does not have a screen to show — it has a stream of distilled events
// (see src/lib/server/sdkEvents.ts).
//
// That is the readable view the whole migration started from: the same work,
// legible without reading a terminal repaint. The header keeps SwarmWorkerPane's
// exact vocabulary (the azure/ochre beacon dots the Ground and Board cards use)
// so a mixed fleet reads as one fleet.
//
// See docs/SDK_WORKER_MIGRATION_PLAN.md §3.6.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Square, CornerDownLeft } from 'lucide-react'
import { useT } from '@/i18n/I18nContext'
import type { SdkEvent, SdkSessionStatus } from '@/lib/server/sdkEvents'

interface Frame {
  seq: number
  ev: SdkEvent
}

interface Props {
  /** The SDK session id (the worker's handle — there is no terminalId). */
  sdkSessionId: string
  /** Project path — every /api/sdk-session/* call is gated on it. */
  projectPath: string
  branch: string
  taskTitle: string
  /** Engine-owned workers are read-only here, exactly as in SwarmWorkerPane. */
  source?: 'manual' | 'engine'
  onExit?: () => void
}

// The SAME beacon vocabulary as SwarmWorkerPane / the Ground + Board cards:
// azure = busy, ochre = waiting for input. Inert states use ink-faint so the
// grey dot still clears the 3:1 graphic-contrast floor on the paper header.
const DOT: Record<SdkSessionStatus, string> = {
  starting: 'bg-ink-faint',
  working: 'bg-azure',
  waiting: 'bg-ochre',
  'quota-parked': 'bg-ochre',
  exited: 'bg-ink-faint',
  failed: 'bg-ink-faint',
}

const isTerminal = (s: SdkSessionStatus) => s === 'exited' || s === 'failed'

export const SdkWorkerPane = ({
  sdkSessionId,
  projectPath,
  branch,
  taskTitle,
  source = 'manual',
  onExit,
}: Props) => {
  const { t } = useT()
  const [frames, setFrames] = useState<Frame[]>([])
  const [status, setStatus] = useState<SdkSessionStatus>('starting')
  const [truncated, setTruncated] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const feedRef = useRef<HTMLDivElement | null>(null)
  const isEngine = source === 'engine'

  const qs = useMemo(
    () => `path=${encodeURIComponent(projectPath)}`,
    [projectPath],
  )

  // Subscribe. `from` is the sequence high-water mark so a re-mount resumes
  // rather than replaying from zero — and the server tells us when it could
  // NOT resume (frames dropped), which we surface rather than hide.
  useEffect(() => {
    let stopped = false
    let lastSeq = 0
    const es = new EventSource(
      `/api/sdk-session/${encodeURIComponent(sdkSessionId)}/stream?${qs}&from=0`,
    )
    es.addEventListener('init', (e) => {
      if (stopped) return
      const d = JSON.parse((e as MessageEvent).data) as {
        session: { status: SdkSessionStatus } | null
        truncated: boolean
        replay: Frame[]
      }
      setTruncated(d.truncated)
      if (d.session) setStatus(d.session.status)
      if (d.replay.length) {
        lastSeq = d.replay[d.replay.length - 1].seq
        setFrames(d.replay)
      }
    })
    es.addEventListener('frame', (e) => {
      if (stopped) return
      const f = JSON.parse((e as MessageEvent).data) as Frame
      lastSeq = f.seq
      if (f.ev.kind === 'status') setStatus(f.ev.status)
      setFrames((prev) => [...prev, f])
    })
    es.addEventListener('end', () => {
      if (stopped) return
      onExit?.()
    })
    return () => {
      stopped = true
      es.close()
      void lastSeq
    }
  }, [sdkSessionId, qs, onExit])

  // Keep the newest line in view unless the reader has scrolled up.
  useEffect(() => {
    const el = feedRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [frames])

  const post = async (suffix: string, body?: unknown) => {
    setBusy(true)
    try {
      await fetch(`/api/sdk-session/${encodeURIComponent(sdkSessionId)}${suffix}?${qs}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    } finally {
      setBusy(false)
    }
  }

  const send = async () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    await post('/input', { text })
  }

  const statusLabel: string = {
    starting: t('projectPanel.swarm.statusStarting'),
    working: t('projectPanel.swarm.statusWorking'),
    waiting: t('projectPanel.swarm.statusWaiting'),
    'quota-parked': t('projectPanel.swarm.sdk.statusQuotaParked'),
    exited: t('projectPanel.swarm.statusExited'),
    failed: t('projectPanel.swarm.sdk.statusFailed'),
  }[status]

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#1a1a1a]">
      {/* Header — same shape and vocabulary as SwarmWorkerPane. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-line-soft bg-bg-card px-2.5 py-1.5">
        <span className={`h-[6px] w-[6px] shrink-0 rounded-full ${DOT[status]}`} aria-hidden />
        <span
          className={`label-cap shrink-0 ${status === 'waiting' || status === 'quota-parked' ? 'text-[var(--beacon-waiting)]' : 'text-ink-faint'}`}
        >
          {statusLabel}
        </span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-muted"
          title={taskTitle ? `${branch} — ${taskTitle}` : branch}
        >
          {branch}
        </span>
        <span
          className="shrink-0 rounded-[3px] border border-line px-1.5 py-0.5 text-[10px] text-ink-faint"
          title={t('projectPanel.swarm.sdk.badgeHint')}
        >
          SDK
        </span>
        {!isEngine && !isTerminal(status) ? (
          <button
            type="button"
            onClick={() => void post('/interrupt')}
            disabled={busy}
            title={t('projectPanel.swarm.sdk.interrupt')}
            className="flex shrink-0 items-center gap-1 rounded-[3px] border border-line px-1.5 py-0.5 text-[10px] text-ink-muted transition-colors hover:border-accent hover:text-accent active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1"
          >
            <Square size={11} strokeWidth={2.25} />
          </button>
        ) : null}
      </div>

      {truncated ? (
        // Never let an incomplete transcript look continuous.
        <div className="shrink-0 border-b border-line-soft bg-bg-card px-2.5 py-1 text-[10px] text-ochre">
          {t('projectPanel.swarm.sdk.truncated')}
        </div>
      ) : null}

      {/* Feed */}
      <div ref={feedRef} className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2 text-[11px] leading-relaxed">
        {frames.length === 0 ? (
          <div className="text-ink-faint">{t('projectPanel.swarm.sdk.empty')}</div>
        ) : (
          frames.map((f) => <EventRow key={f.seq} ev={f.ev} t={t} />)
        )}
      </div>

      {/* Composer — the manual nudge / answer path. The engine drives this
          worker normally; this is for the owner looking over its shoulder. */}
      {!isTerminal(status) ? (
        <div className="flex shrink-0 items-center gap-1.5 border-t border-line-soft bg-bg-card px-2 py-1.5">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // IME guard: never submit while a composition is in flight.
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
            placeholder={t('projectPanel.swarm.sdk.placeholder')}
            className="min-w-0 flex-1 rounded-[3px] border border-line bg-bg-inset px-1.5 py-0.5 text-[11px] text-ink placeholder:text-ink-faint transition-colors hover:border-line-strong focus:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1 disabled:cursor-not-allowed disabled:opacity-40"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={busy || !draft.trim()}
            title={t('projectPanel.swarm.sdk.send')}
            className="flex shrink-0 items-center gap-1 rounded-[3px] border border-line px-1.5 py-0.5 text-[10px] text-ink-muted transition-colors hover:border-accent hover:text-accent active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1"
          >
            <CornerDownLeft size={11} strokeWidth={2.25} />
          </button>
        </div>
      ) : null}
    </div>
  )
}

const EventRow = ({ ev, t }: { ev: SdkEvent; t: (k: string) => string }) => {
  switch (ev.kind) {
    case 'text':
      return (
        <div className={`whitespace-pre-wrap ${ev.fromSubagent ? 'pl-3 text-ink-muted' : 'text-ink'}`}>
          {ev.text}
        </div>
      )
    case 'tool_use':
      return (
        <div className={`font-mono text-[10px] text-ink-muted ${ev.fromSubagent ? 'pl-3' : ''}`}>
          🔧 {ev.name}
          {ev.detail ? ` ${ev.detail}` : ''}
        </div>
      )
    case 'tool_result':
      return (
        <div className={`font-mono text-[10px] ${ev.ok ? 'text-ink-faint' : 'text-error'} ${ev.fromSubagent ? 'pl-3' : ''}`}>
          ↳ {ev.head}
        </div>
      )
    case 'thinking':
      return (
        <div className="font-mono text-[10px] text-ink-faint">
          {t('projectPanel.swarm.sdk.thinking')} ({ev.chars})
        </div>
      )
    case 'turn_end':
      return <div className="my-1 border-t border-line-soft" aria-hidden />
    case 'quota_refusal':
      return (
        <div className="my-1 rounded-[3px] border border-ochre/40 bg-ochre/10 px-2 py-1 text-[10px] text-ochre">
          {ev.raw}
        </div>
      )
    case 'api_error':
      return (
        <div className="my-1 rounded-[3px] border border-error/40 bg-error/10 px-2 py-1 text-[10px] text-error">
          {ev.status ? `${ev.status} — ` : ''}
          {ev.head}
        </div>
      )
    case 'rate_limit':
      return (
        <div className="font-mono text-[10px] text-ink-faint">
          {t('projectPanel.swarm.sdk.rateLimit')} {Math.round(ev.utilization * 100)}%
        </div>
      )
    case 'status':
    default:
      return null
  }
}

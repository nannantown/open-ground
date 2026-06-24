// SwarmManagerPane — the commander (司令官) tab: the THIRD Swarm main view,
// alongside the supply desk and the worker tiles. It folds TWO things onto one
// tab (information design, card 354866 + a6f477):
//
//   ① a STAGE (left, the big area) — by DEFAULT the commander CONVERSATION: an
//      interactive `claude` running /manage you talk to (status / merge /
//      advise), reusing the existing ClaudeTerminalPane VERBATIM — the same
//      PTY/SSE/xterm the supply desk and worker tiles use, so typing into it IS
//      the dialogue input (text in, Enter sends, claude responds). Clicking a
//      worker row in the sidebar swaps the stage to THAT worker's real `claude`
//      screen (also ClaudeTerminalPane); a back affordance returns to the
//      commander (whose PTY keeps running server-side and replays on return).
//      The commander PTY's lifecycle (launch / stop / persist) is owned by
//      SwarmModule, exactly like the supply session — this pane only renders it.
//
//   ② a SIDEBAR (right) — the DASHBOARD: the autonomous orchestration ENGINE's
//      controls + monitor + log. It answers, in order:
//        • Engine     — the two switches (Autonomy ① / Auto-integrate ③) + status.
//        • Workers     — every live worker as a row; click → its screen on stage.
//        • Review·統合 — review-column cards + their integration readiness.
//        • Engine log  — the drain/dispatch/monitor/integrate journal.
//
// The Board pipeline tallies (todo/doing/review/done) are deliberately NOT shown
// here — that is the Board tab's job, and duplicating the numbers only added a
// second place to keep in sync. (Removed 2026-06-24, card 354866 #2.)
//
// SPLIT OF CONCERNS: the autonomous engine lives server-side behind
// /api/swarm/orchestrator{,/start,/stop,/automerge}; its FRONT-END half (the
// poll, the switches, graceful 404 degradation) now lives in the shared
// `useSwarmEngine` hook, which SwarmModule calls ONCE and threads down here as
// props. This pane is therefore PURELY PRESENTATIONAL for the engine — it never
// fetches. That single-source hoist is what lets the worker tab and this monitor
// show the SAME worker set (manual + engine), deduped by PTY id, with no second
// poll and no second merge. The worker list this pane renders is ALREADY merged
// upstream (manual + engine.workers) by SwarmModule — see `workers` below.
//
//   • Autonomy (①) — POST /start, /stop. The engine state's `running`.
//   • Auto-integrate (③) — POST /api/swarm/orchestrator/automerge. The engine
//     lands fast-forwardable / cleanly-rebasable review cards on the trunk
//     itself (FF / rebase only, never forced; conflicts left for a human). Read
//     off the state's `autoMerge`, default OFF. Both switches dim when the route
//     is unreachable (`available === false`) and go live once it answers.
//
// The commander CONVERSATION (/manage) is a SEPARATE PTY session, independent of
// the engine route — it works whether or not the autonomous engine is available;
// its lifecycle is owned by SwarmModule (like supply) and passed in as `session`.
//
// SECURITY: mounted only inside SwarmModule, itself behind the owner+toggle gate
// (see SwarmModule's header) — the SAME gate as the supply / worker surfaces. No
// extra gating is needed here; the server /api/swarm/* routes are owner-only too.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Gauge,
  ScrollText,
  Boxes,
  GitMerge,
  GitBranch,
  MessageSquare,
  ArrowLeft,
  Power,
  Send,
  AlertTriangle,
} from 'lucide-react'
import { ClaudeTerminalPane } from '@/components/canvas/ClaudeTerminalPane'
import { useT } from '@/i18n/I18nContext'
import type { WorkerStatus } from './SwarmWorkerPane'
import type {
  EngineAnomalyKind,
  EngineLogKind,
  EngineLogLevel,
  EngineReviewStatus,
  ManagerWorkerStage,
  SwarmEngineState,
} from './useSwarmEngine'

// Re-export the engine stage type so SwarmModule (which builds the merged worker
// rows) can keep importing it from the pane it feeds — the type itself lives with
// the hook that owns the engine contract.
export type { ManagerWorkerStage } from './useSwarmEngine'

// ── Worker monitor row (already merged upstream: manual + engine) ─────────────
export interface ManagerWorker {
  terminalId: string
  taskTitle: string
  branch: string
  stage: ManagerWorkerStage
  /** Who dispatched this worker: 'manual' = the owner did it by hand (the worker
   *  tab owns its teardown), 'engine' = the autonomous orchestrator did. Surfaced
   *  as a row badge so the two are never confused on the monitor. */
  source: 'manual' | 'engine'
  /** The worker's self-reported heartbeat phase (engine source only — e.g.
   *  'audit' / 'implement' / 'verify'). Shown on the row so the worker's CURRENT
   *  phase is legible at a glance, finer than the coarse `stage` (条件3). */
  phase?: string
  /** The worker's one-line heartbeat summary (engine source only) — shown as the
   *  row's tooltip / secondary line so "what it's doing now" is visible. */
  note?: string
}

/** The commander CONVERSATION (/manage) session, owned by SwarmModule (exactly
 *  like the supply session). null = not launched — the stage shows the launch
 *  CTA. */
export interface ManagerSession {
  terminalId: string
  /** Live status from SwarmModule's active-terminal poll (the SAME vocabulary
   *  the supply / worker tiles use). */
  status: WorkerStatus
}

interface Props {
  /** Validated project path — used only to reset the on-stage worker selection
   *  when the pane is reused for another project. The engine poll lives in the
   *  shared hook now, so this pane no longer fetches with it. */
  projectPath: string
  /** The UNIFIED worker list (manual + engine), ALREADY merged + deduped by PTY
   *  id by SwarmModule. The SAME list the worker tab renders — single source. */
  workers: ManagerWorker[]
  /** The commander conversation (/manage) PTY — owned by SwarmModule (like
   *  supply). null until launched. */
  session: ManagerSession | null
  /** A launch/stop round-trip for the commander session is in flight. */
  sessionBusy: boolean
  /** Launch the commander conversation (POST /api/swarm/manager, via SwarmModule). */
  onLaunchSession: () => void
  /** Stop the commander conversation (plain PTY kill, via SwarmModule). */
  onStopSession: () => void
  /** The commander PTY closed (claude /quit, Ctrl-D) — bubble up to SwarmModule. */
  onSessionExit: () => void
  // ── Engine dashboard (from useSwarmEngine, owned by SwarmModule) ────────────
  /** Latest engine state (running / autoMerge / reviews / log). */
  engine: SwarmEngineState
  /** Whether the orchestrator route answered (false dims the switches). */
  available: boolean
  /** A start/stop or auto-merge round-trip is in flight (disables both switches). */
  busy: boolean
  /** Last engine-action failure, already localized (null when none). */
  error: string | null
  /** Autonomy switch (Card①). */
  onToggleAutonomy: (next: boolean) => void
  /** Auto-integrate switch (Card③). */
  onToggleAutoMerge: (next: boolean) => void
  /** Stop ONE engine-dispatched worker by its PTY id (tears down its worktree +
   *  PTY and parks its card). Only ENGINE-source rows show the stop control — a
   *  manual worker is stopped from the worker tab. Absent on an older host. */
  onStopWorker?: (terminalId: string) => void
}

// Clock for a log row — HH:MM:SS, 24h. Robust to a missing/garbage `at`.
const fmtTime = (iso: string): string => {
  if (!iso) return '--:--:--'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '--:--:--' : d.toLocaleTimeString(undefined, { hour12: false })
}

// Per-level ink colour — accent(red)=error, ochre=warn, neutral ink=info.
const LEVEL_COLOR: Record<EngineLogLevel, string> = {
  info: 'text-ink-faint',
  warn: 'text-ochre',
  error: 'text-accent',
}

// Worker-stage dot — starting=grey(inert), running=azure(active), done=moss(green).
// The inert "starting" grey uses ink-faint (not line-strong) so it clears the
// 3:1 graphic-contrast floor on the paper card bg (line-strong ≈ 2.1:1 was an
// almost-invisible dot — see the CLAUDE.md interactive-states contrast rule).
const STAGE_DOT: Record<ManagerWorkerStage, string> = {
  starting: 'bg-ink-faint',
  running: 'bg-azure',
  done: 'bg-moss',
}

// Commander-session status dot — the SAME beacon vocabulary as the supply tile
// (SwarmSupplyPane): azure = working, ochre = waiting, ink-faint = starting/exited
// (the inert grey, ≥3:1 on paper unlike the near-invisible line-strong).
const SESSION_DOT: Record<WorkerStatus, string> = {
  working: 'bg-azure',
  waiting: 'bg-ochre',
  starting: 'bg-ink-faint',
  exited: 'bg-ink-faint',
}

// Review-readiness dot — ff=moss(ready to land), rebase=ochre(needs a rebase),
// conflict=accent(needs a human), unknown=ink-faint (inert but VISIBLE — the old
// line-strong/60 was ~1.7:1, effectively no dot; the word label carries the
// "uncertain" sense, the dot just needs to clear 3:1).
const REVIEW_DOT: Record<EngineReviewStatus, string> = {
  ff: 'bg-moss',
  rebase: 'bg-ochre',
  conflict: 'bg-accent',
  unknown: 'bg-ink-faint',
}

// Worker-source dot — manual(ochre, "you did it") vs engine(azure, "autonomous").
// The source distinction rides a coloured DOT (a graphic — needs only 3:1, which
// the solid azure/ochre tokens clear), while the chip's LABEL stays neutral
// high-contrast ink (text-ink-muted ≥ 4.5:1 on BOTH the default bg-card row and
// the active bg-inset row). Colouring the WORDS ochre/azure would dip under
// 4.5:1 on paper (ochre ≈ 3.9:1) — so the colour goes on the dot, never the text.
// The two dots are distinct at a glance (the whole point — manual hand-dispatch
// vs engine autonomy must never be confused).
const SOURCE_DOT: Record<ManagerWorker['source'], string> = {
  manual: 'bg-ochre',
  engine: 'bg-azure',
}

// Quick commands the bar offers as one-click chips. The SENT string is the
// commander's documented Japanese trigger word (/manage responds to 状況/マージ/
// 掃除 regardless of the UI language) — only the chip LABEL is localized.
const QUICK_COMMANDS: { key: string; command: string }[] = [
  { key: 'quickStatus', command: '状況' },
  { key: 'quickMerge', command: 'マージ' },
  { key: 'quickClean', command: '掃除' },
]

export const SwarmManagerPane = ({
  projectPath,
  workers,
  session,
  sessionBusy,
  onLaunchSession,
  onStopSession,
  onSessionExit,
  engine,
  available,
  busy,
  error,
  onToggleAutonomy,
  onToggleAutoMerge,
  onStopWorker,
}: Props) => {
  const { t } = useT()

  // What the STAGE shows: null = the commander conversation (the default), else
  // a worker's PTY id (its live `claude` screen). At most one embedded
  // ClaudeTerminalPane/SSE is live on the stage at a time — switching unmounts
  // the previous one (closing its SSE, disposing xterm; the PTY survives
  // server-side and replays on return).
  const [stageWorkerId, setStageWorkerId] = useState<string | null>(null)

  // Engine-log noise filter: 'important' (default) hides the per-pass routine
  // bookkeeping (kind:'routine' — slot freed / card gone / column reconciled) so
  // the meaningful events (dispatch / promote / integrate / conflict) stand out;
  // 'all' shows every line for debugging.
  const [logFilter, setLogFilter] = useState<'important' | 'all'>('important')

  const logRef = useRef<HTMLDivElement | null>(null)

  // Reset the on-stage selection when the pane is reused for another project
  // (SwarmModule keeps one instance across project switches). The engine state
  // itself is reset by the shared hook keyed on the same path.
  useEffect(() => {
    setStageWorkerId(null)
    setLogFilter('important')
  }, [projectPath])

  // Send a command to the commander's /manage PTY WITHOUT focusing the xterm —
  // the SAME POST /api/terminal/:id/input ClaudeTerminalPane uses for keystrokes,
  // so the reply lands in the commander terminal already on the stage. A
  // single-line order (the quick chips + most free input) goes as `text + CR`:
  // the CR is a discrete control byte the claude TUI reads as Enter (never
  // coalesced into a paste), so it submits reliably. A multi-line order is sent
  // as a bracketed paste — embedded ESC stripped so the span can't be closed
  // early (the hardening the server's pastePrompt uses) — then a SEPARATE CR
  // submits it, so its internal newlines stay literal instead of each submitting.
  const commanderId = session?.terminalId ?? null
  const sendToCommander = useCallback(
    async (raw: string) => {
      const text = raw.replace(/\r/g, '')
      if (!commanderId || !text.trim()) return
      const post = (data: string) =>
        fetch(`/api/terminal/${commanderId}/input`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ data }),
        })
      try {
        if (text.includes('\n')) {
          // ESC built at runtime (String.fromCharCode) so no raw control byte or
          // \x-escape sits in the source — strip any ESC in the body, then wrap.
          const esc = String.fromCharCode(27)
          const safe = text.split(esc).join('')
          await post(`${esc}[200~${safe}${esc}[201~`)
          await post('\r')
        } else {
          await post(`${text}\r`)
        }
      } catch {
        /* PTY gone / offline — the user can retry or type in the terminal itself */
      }
    },
    [commanderId],
  )

  // Keep the log scrolled to the newest line when it grows, and after a filter
  // flip changes what's shown (live-feed behaviour).
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [engine.log.length, logFilter])

  // Engine status badge: running (moss) · stopped (grey) · offline (faint).
  const statusDot = !available ? 'bg-ink-faint' : engine.running ? 'bg-moss' : 'bg-ink-faint'
  const statusLabel = !available
    ? t('projectPanel.swarm.manager.engineOffline')
    : engine.running
      ? t('projectPanel.swarm.manager.engineRunning')
      : t('projectPanel.swarm.manager.engineStopped')

  const stageLabel: Record<ManagerWorkerStage, string> = {
    starting: t('projectPanel.swarm.manager.stageStarting'),
    running: t('projectPanel.swarm.manager.stageRunning'),
    done: t('projectPanel.swarm.manager.stageDone'),
  }

  const reviewStatusLabel: Record<EngineReviewStatus, string> = {
    ff: t('projectPanel.swarm.manager.reviewFf'),
    rebase: t('projectPanel.swarm.manager.reviewRebase'),
    conflict: t('projectPanel.swarm.manager.reviewConflict'),
    unknown: t('projectPanel.swarm.manager.reviewUnknown'),
  }

  // Why a review card is (not) integrable — the tooltip behind its status label,
  // so the "統合待ち理由" reads as a reason, not just a one-word tag.
  const reviewStatusHint: Record<EngineReviewStatus, string> = {
    ff: t('projectPanel.swarm.manager.reviewFfHint'),
    rebase: t('projectPanel.swarm.manager.reviewRebaseHint'),
    conflict: t('projectPanel.swarm.manager.reviewConflictHint'),
    unknown: t('projectPanel.swarm.manager.reviewUnknownHint'),
  }

  const sourceLabel: Record<ManagerWorker['source'], string> = {
    manual: t('projectPanel.swarm.manager.sourceManual'),
    engine: t('projectPanel.swarm.manager.sourceEngine'),
  }
  const sourceHint: Record<ManagerWorker['source'], string> = {
    manual: t('projectPanel.swarm.manager.sourceManualHint'),
    engine: t('projectPanel.swarm.manager.sourceEngineHint'),
  }

  // Short chip label for a structured log event's kind, so the event TYPE is
  // legible at a glance (dispatch / promote / integrate / …) — distinct from the
  // message text (条件1). 'routine' gets no chip: it's the hidden-by-default
  // bookkeeping, and when revealed via "All" it needs no type tag.
  const kindLabel: Record<Exclude<EngineLogKind, 'routine'>, string> = {
    dispatch: t('projectPanel.swarm.manager.logKindDispatch'),
    promote: t('projectPanel.swarm.manager.logKindPromote'),
    integrate: t('projectPanel.swarm.manager.logKindIntegrate'),
    conflict: t('projectPanel.swarm.manager.logKindConflict'),
    cleanup: t('projectPanel.swarm.manager.logKindCleanup'),
    crash: t('projectPanel.swarm.manager.logKindCrash'),
  }

  // What each detected inconsistency MEANS, in one line (条件2). The detail line
  // under it carries the specific card / branch.
  const anomalyLabel: Record<EngineAnomalyKind, string> = {
    'orphan-doing': t('projectPanel.swarm.manager.anomalyOrphanDoing'),
    'worktree-missing': t('projectPanel.swarm.manager.anomalyWorktreeMissing'),
    'worker-stale': t('projectPanel.swarm.manager.anomalyWorkerStale'),
  }

  // The worker list is ALREADY the unified (manual + engine) set, merged + deduped
  // by SwarmModule — the SAME source the worker tab renders (single source). This
  // pane neither fetches nor merges; it only displays + opens screens.
  const allWorkers = workers

  // The engine log the dashboard actually renders: 'important' (default) drops the
  // per-pass routine bookkeeping so dispatch/promote/integrate/conflict stand out;
  // 'all' shows everything. A line with no `kind` is always a meaningful event.
  const visibleLog = logFilter === 'all' ? engine.log : engine.log.filter((ev) => ev.kind !== 'routine')
  // Distinguish "engine has emitted nothing" from "everything so far is routine
  // and hidden" — the empty state copy differs (the latter points at the toggle).
  const routineHidden = logFilter === 'important' && visibleLog.length === 0 && engine.log.length > 0

  // The worker currently on the stage (if any). If the selected worker vanished
  // (terminated / engine pruned it), this resolves to null and the stage falls
  // back to the commander conversation below — so a stale stageWorkerId is
  // HARMLESS (the render keys off `stageWorker`, not the raw id, and PTY ids are
  // unique so a gone id can never re-match a different worker).
  const stageWorker = stageWorkerId ? allWorkers.find((w) => w.terminalId === stageWorkerId) ?? null : null

  return (
    // Two columns: the STAGE (commander conversation / a worker's live screen)
    // and the DASHBOARD sidebar (engine controls · worker monitor · reviews ·
    // log). min-w-0 on the stage is load-bearing so the terminal can shrink.
    <div className="flex h-full min-h-0 w-full">
      {/* ── STAGE ──────────────────────────────────────────────────────────── */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg">
        {stageWorker ? (
          <>
            {/* Worker on stage: a back affordance + the worker's identity. */}
            <div className="flex shrink-0 items-center gap-2 border-b border-line-soft bg-bg-card px-3 py-1.5">
              <button
                type="button"
                onClick={() => setStageWorkerId(null)}
                className="flex shrink-0 items-center gap-1 rounded-[3px] border border-line px-1.5 py-0.5 text-[10px] text-ink-muted transition-colors hover:border-accent hover:text-accent active:scale-[0.98] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1"
              >
                <ArrowLeft size={11} strokeWidth={2.25} />
                {t('projectPanel.swarm.manager.backToCommander')}
              </button>
              <span className={`h-[6px] w-[6px] shrink-0 rounded-full ${STAGE_DOT[stageWorker.stage]}`} aria-hidden />
              <span className="min-w-0 flex-1 truncate text-[12px] text-ink-muted" title={stageWorker.branch}>
                {stageWorker.taskTitle || stageWorker.branch}
              </span>
              <span
                className="label-cap flex shrink-0 items-center gap-1 rounded-full border border-line px-1.5 leading-[15px] text-ink-muted"
                title={sourceHint[stageWorker.source]}
              >
                <span className={`h-[5px] w-[5px] rounded-full ${SOURCE_DOT[stageWorker.source]}`} aria-hidden />
                {sourceLabel[stageWorker.source]}
              </span>
              <span className="label-cap shrink-0 text-ink-faint">{stageLabel[stageWorker.stage]}</span>
            </div>
            {/* The worker's REAL claude screen — the same ClaudeTerminalPane the
                worker tiles use (chrome={false}: our row is the header). */}
            <div className="min-h-0 flex-1">
              <ClaudeTerminalPane terminalId={stageWorker.terminalId} chrome={false} />
            </div>
          </>
        ) : session ? (
          <>
            {/* Commander conversation header — identity + status + stop. */}
            <div className="flex shrink-0 items-center gap-2 border-b border-line-soft bg-bg-card px-3 py-1.5">
              <span className={`h-[6px] w-[6px] shrink-0 rounded-full ${SESSION_DOT[session.status]}`} aria-hidden />
              <span
                className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-[11px] text-ink-muted"
                title={t('projectPanel.swarm.manager.conversationHint')}
              >
                <MessageSquare size={11} strokeWidth={2} className="shrink-0 text-ink-faint" aria-hidden />
                <span className="truncate">{t('projectPanel.swarm.manager.conversationIdentity')}</span>
              </span>
              <button
                type="button"
                onClick={onStopSession}
                disabled={sessionBusy}
                title={t('projectPanel.swarm.manager.stop')}
                className="flex shrink-0 items-center gap-1 rounded-[3px] border border-line px-1.5 py-0.5 text-[10px] text-ink-muted transition-colors hover:border-accent hover:text-accent active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1"
              >
                <Power size={10} strokeWidth={2.25} />
                {sessionBusy ? t('projectPanel.swarm.manager.stopping') : t('projectPanel.swarm.manager.stop')}
              </button>
            </div>
            {/* The commander's claude — reused verbatim. Typing into it IS the
                dialogue input (text in, Enter sends). onExit bubbles the close
                up so SwarmModule drops back to the launch CTA. */}
            <div className="min-h-0 flex-1">
              <ClaudeTerminalPane terminalId={session.terminalId} chrome={false} onExit={() => onSessionExit()} />
            </div>
            {/* Command bar: quick chips + a free-text field that POST the order to
                the commander PTY (same /input route) so you can drive /manage
                WITHOUT clicking into the xterm — the reply renders in the terminal
                above. Keyed on the PTY id so a relaunch clears the draft. */}
            <CommanderCommandBar
              key={session.terminalId}
              onSend={(text) => void sendToCommander(text)}
              disabled={sessionBusy}
              t={t}
            />
          </>
        ) : (
          // Launch CTA — the commander you talk to (status / merge / advise),
          // running /manage in the primary checkout (no worktree, like supply).
          <div className="flex flex-1 items-center justify-center bg-bg px-8 text-center">
            <div className="max-w-sm">
              <div className="mx-auto mb-4 inline-flex h-11 w-11 items-center justify-center rounded-[3px] border border-line bg-bg-inset text-ink-muted">
                <MessageSquare size={20} strokeWidth={1.75} />
              </div>
              <p className="label-cap mb-2 text-ink-faint">{t('projectPanel.swarm.manager.badge')}</p>
              <h2 className="mb-2 text-[15px] font-medium text-ink">
                {t('projectPanel.swarm.manager.conversationTitle')}
              </h2>
              <p className="mb-4 text-[12px] leading-relaxed text-ink-subtle">
                {t('projectPanel.swarm.manager.conversationEmpty')}
              </p>
              <button
                type="button"
                onClick={onLaunchSession}
                disabled={sessionBusy}
                className="inline-flex items-center gap-1.5 rounded-[3px] border border-line bg-bg-card px-3 py-1.5 text-[12px] text-ink-muted transition-colors hover:border-accent hover:text-ink active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
              >
                <MessageSquare size={13} strokeWidth={2} />
                {sessionBusy
                  ? t('projectPanel.swarm.manager.launching')
                  : t('projectPanel.swarm.manager.launch')}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── DASHBOARD sidebar: engine · workers · reviews · log ─────────────── */}
      {/* PAPER surface (bg-bg) — a dashboard, not a terminal, so the paper ink
          tokens keep 4.5:1+ contrast (the dark terminal bg lives on the stage). */}
      <aside className="flex w-[300px] shrink-0 flex-col border-l border-line bg-bg">
        {/* Engine: status + the two switches (Card① / Card③). */}
        <div className="shrink-0 border-b border-line-soft px-4 py-3">
          <div className="mb-3 flex items-center gap-2">
            <Gauge size={13} strokeWidth={2} className="shrink-0 text-ink-faint" aria-hidden />
            <span className="label-cap text-ink-faint">{t('projectPanel.swarm.manager.engineHeading')}</span>
            <span className="ml-auto flex items-center gap-1.5">
              <span className={`h-[6px] w-[6px] shrink-0 rounded-full ${statusDot}`} aria-hidden />
              <span className="text-[11px] text-ink-muted">{statusLabel}</span>
            </span>
          </div>

          <div className="flex flex-col gap-2.5">
            <ControlRow
              label={t('projectPanel.swarm.manager.autonomy')}
              hint={t('projectPanel.swarm.manager.autonomyHint')}
              value={engine.running}
              disabled={busy || !available}
              ariaLabel={t('projectPanel.swarm.manager.autonomy')}
              onToggle={(v) => onToggleAutonomy(v)}
              t={t}
            />
            <ControlRow
              label={t('projectPanel.swarm.manager.autoMerge')}
              hint={t('projectPanel.swarm.manager.autoMergeHint')}
              value={engine.autoMerge}
              disabled={busy || !available}
              ariaLabel={t('projectPanel.swarm.manager.autoMerge')}
              onToggle={(v) => onToggleAutoMerge(v)}
              t={t}
            />
          </div>

          {error && <p className="mt-2.5 text-[11px] leading-relaxed text-accent">{error}</p>}
        </div>

        {/* Everything below the (pinned) Engine controls shares ONE scroll
            container, so on a short laptop NO section is clipped: the column
            scrolls to reach Reviews / Log instead of the bottom falling off the
            aside (the overflow bug condition 6 fixes). Engine stays pinned above;
            this region flexes and scrolls as a whole. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {/* Workers: each row opens that worker's live screen ON THE STAGE. */}
          <div className="shrink-0 px-4 py-3">
          <div className="mb-2 flex items-center gap-1.5">
            <Boxes size={12} strokeWidth={2} className="shrink-0 text-ink-faint" aria-hidden />
            <p className="label-cap text-ink-faint">{t('projectPanel.swarm.manager.workersHeading')}</p>
            {allWorkers.length > 0 && (
              <span className="rounded-full border border-line px-1.5 text-[9px] font-medium leading-[14px] text-ink-faint">
                {allWorkers.length}
              </span>
            )}
          </div>
          {allWorkers.length === 0 ? (
            <p className="text-[11px] leading-relaxed text-ink-subtle">
              {t('projectPanel.swarm.manager.noWorkers')}
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {allWorkers.map((w) => {
                const onStage = stageWorkerId === w.terminalId
                // Phase line: the worker's self-reported heartbeat phase when it
                // has one (engine workers), else the coarse stage label — so the
                // row always says where the worker IS, finer than stage (条件3).
                const phaseText = w.phase || stageLabel[w.stage]
                return (
                  <li key={w.terminalId} className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setStageWorkerId((id) => (id === w.terminalId ? null : w.terminalId))}
                      aria-pressed={onStage}
                      title={
                        w.note ||
                        (onStage
                          ? t('projectPanel.swarm.manager.hideScreen')
                          : t('projectPanel.swarm.manager.showScreen'))
                      }
                      className={[
                        // flex-col = the two-row layout (title+phase / branch); min-w-0
                        // flex-1 lets it share the `<li>` flex row with the Stop button.
                        'flex min-w-0 flex-1 flex-col gap-1 rounded-[3px] border px-2.5 py-1.5 text-left transition-all duration-150',
                        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
                        onStage
                          ? 'border-accent bg-bg-inset'
                          : 'border-line bg-bg-card hover:border-line-strong hover:bg-bg-inset active:scale-[0.997]',
                      ].join(' ')}
                    >
                      {/* Row 1: stage dot · task title · source badge · phase. */}
                      <div className="flex w-full items-center gap-2">
                        <span className={`h-[6px] w-[6px] shrink-0 rounded-full ${STAGE_DOT[w.stage]}`} aria-hidden />
                        <span className="min-w-0 flex-1 truncate text-[12px] text-ink">
                          {w.taskTitle || w.branch}
                        </span>
                        {/* Source badge (condition 5): manual hand-dispatch vs
                            engine autonomy — a coloured dot + neutral high-contrast
                            label so the two are distinct AND legible (≥4.5:1). */}
                        <span
                          className="label-cap flex shrink-0 items-center gap-1 rounded-full border border-line px-1.5 leading-[15px] text-ink-muted"
                          title={sourceHint[w.source]}
                        >
                          <span className={`h-[5px] w-[5px] rounded-full ${SOURCE_DOT[w.source]}`} aria-hidden />
                          {sourceLabel[w.source]}
                        </span>
                        {/* Phase/stage: the worker's CURRENT phase (heartbeat) or
                            the coarse stage. muted (not subtle) when active — the
                            row sits on bg-inset then, where subtle dips below
                            4.5:1 (CLAUDE.md interactive-states contrast rule). */}
                        <span
                          className={`label-cap max-w-[96px] shrink-0 truncate ${onStage ? 'text-ink-muted' : 'text-ink-faint'}`}
                          title={w.phase || undefined}
                        >
                          {phaseText}
                        </span>
                      </div>
                      {/* Row 2: the worker's branch — the integration handle, made
                          VISIBLE (not only a hover title) so card / phase / branch
                          are all legible at a glance (条件3). */}
                      {w.branch && (
                        <div className="flex w-full items-center gap-1 pl-[14px]">
                          <GitBranch size={9} strokeWidth={2} className="shrink-0 text-ink-faint" aria-hidden />
                          <span
                            className={`min-w-0 flex-1 truncate font-mono text-[10px] ${onStage ? 'text-ink-muted' : 'text-ink-faint'}`}
                          >
                            {w.branch}
                          </span>
                        </div>
                      )}
                    </button>
                    {/* STOP — engine workers only (the engine owns their lifecycle,
                        so it can tear them down; a manual worker is stopped from the
                        worker tab). A sibling button, NOT nested in the row button
                        (no button-in-button). Disabled during any engine round-trip.
                        Same interactive-state vocabulary as the worker tab's
                        Terminate (hover→accent, active scale, disabled opacity). */}
                    {w.source === 'engine' && onStopWorker && (
                      <button
                        type="button"
                        onClick={() => onStopWorker(w.terminalId)}
                        disabled={busy}
                        title={t('projectPanel.swarm.manager.stopWorkerHint')}
                        aria-label={t('projectPanel.swarm.manager.stopWorkerHint')}
                        className="flex shrink-0 items-center gap-1 rounded-[3px] border border-line px-1.5 py-1 text-[10px] text-ink-muted transition-colors hover:border-accent hover:text-accent active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                      >
                        <Power size={10} strokeWidth={2.25} aria-hidden />
                        {busy ? t('projectPanel.swarm.manager.stopping') : t('projectPanel.swarm.manager.stop')}
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {/* Anomalies (条件2): state inconsistencies the engine detected — drift
            between its worker set, the Board, and the on-disk worktrees that the
            autonomy loop can't silently self-heal. Surfaced (ochre warning) so a
            drift is never missed; hidden entirely when everything is coherent. */}
        {engine.anomalies.length > 0 && (
          <div className="shrink-0 border-t border-line-soft px-4 py-3">
            <div className="mb-2 flex items-center gap-1.5">
              <AlertTriangle size={12} strokeWidth={2} className="shrink-0 text-ochre" aria-hidden />
              <p className="label-cap text-ink-faint">{t('projectPanel.swarm.manager.anomaliesHeading')}</p>
              <span className="rounded-full border border-line px-1.5 text-[9px] font-medium leading-[14px] text-ink-faint">
                {engine.anomalies.length}
              </span>
            </div>
            <ul className="flex flex-col gap-1">
              {engine.anomalies.map((a) => (
                <li
                  key={`${a.kind}:${a.ref}`}
                  className="flex items-start gap-2 rounded-[3px] border border-line bg-bg-card px-2.5 py-1.5"
                >
                  {/* Ochre dot (a graphic — needs only 3:1, which solid ochre
                      clears) carries the "warning" sense; the LABEL stays neutral
                      high-contrast ink so it's legible (CLAUDE.md contrast rule). */}
                  <span className="mt-[4px] h-[6px] w-[6px] shrink-0 rounded-full bg-ochre" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="text-[12px] leading-snug text-ink">{anomalyLabel[a.kind]}</p>
                    <p
                      className="truncate text-[11px] leading-snug text-ink-subtle"
                      title={a.branch || undefined}
                    >
                      {a.taskTitle || a.branch || a.ref}
                      {a.kind === 'worker-stale' && a.staleMinutes != null
                        ? ` · ${t('projectPanel.swarm.manager.anomalyStaleFor', { min: String(a.staleMinutes) })}`
                        : ''}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Review readiness (Card③ "統合可" — shown in both switch positions). */}
        {engine.reviews.length > 0 && (
          <div className="shrink-0 border-t border-line-soft px-4 py-3">
            <div className="mb-2 flex items-center gap-1.5">
              <GitMerge size={12} strokeWidth={2} className="shrink-0 text-ink-faint" aria-hidden />
              <p className="label-cap text-ink-faint">{t('projectPanel.swarm.manager.reviewsHeading')}</p>
              <span className="rounded-full border border-line px-1.5 text-[9px] font-medium leading-[14px] text-ink-faint">
                {engine.reviews.length}
              </span>
            </div>
            <ul className="flex max-h-[120px] flex-col gap-1 overflow-y-auto">
              {engine.reviews.map((r) => (
                <li
                  key={r.taskId}
                  className="flex items-center gap-2 rounded-[3px] border border-line bg-bg-card px-2.5 py-1.5"
                >
                  <span className={`h-[6px] w-[6px] shrink-0 rounded-full ${REVIEW_DOT[r.status]}`} aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-ink" title={r.branch}>
                    {r.taskTitle || r.branch}
                  </span>
                  <span
                    className={`label-cap shrink-0 ${r.status === 'conflict' ? 'text-accent' : 'text-ink-faint'}`}
                    title={reviewStatusHint[r.status]}
                  >
                    {reviewStatusLabel[r.status]}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Live engine log (drain · dispatch · monitor · integrate). The
            Key/All toggle drops the per-pass routine bookkeeping by default so
            dispatch / promote / integrate / conflict aren't buried (condition 3). */}
        <div className="shrink-0 border-t border-line-soft px-4 py-3">
          <div className="mb-2 flex items-center gap-1.5">
            <ScrollText size={12} strokeWidth={2} className="shrink-0 text-ink-faint" aria-hidden />
            <p className="label-cap text-ink-faint">{t('projectPanel.swarm.manager.logHeading')}</p>
            <div
              role="group"
              aria-label={t('projectPanel.swarm.manager.logHeading')}
              className="ml-auto inline-flex shrink-0 items-center rounded-[3px] border border-line p-0.5"
            >
              {([
                ['important', t('projectPanel.swarm.manager.logImportant')],
                ['all', t('projectPanel.swarm.manager.logAll')],
              ] as ['important' | 'all', string][]).map(([mode, mLabel]) => {
                const active = logFilter === mode
                return (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setLogFilter(mode)}
                    aria-pressed={active}
                    className={[
                      'h-[18px] rounded-[2px] px-1.5 text-[10px] font-medium transition-all duration-150',
                      'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
                      active
                        ? 'bg-accent text-bg-card'
                        : 'bg-transparent text-ink-muted hover:bg-bg-inset hover:text-ink',
                    ].join(' ')}
                  >
                    {mLabel}
                  </button>
                )
              })}
            </div>
          </div>
          <div
            ref={logRef}
            className="max-h-[150px] overflow-y-auto rounded-[4px] border border-line bg-bg-inset p-2"
          >
            {visibleLog.length === 0 ? (
              <p className="px-1 py-4 text-center text-[11px] leading-relaxed text-ink-subtle">
                {routineHidden
                  ? t('projectPanel.swarm.manager.logOnlyRoutine')
                  : t('projectPanel.swarm.manager.logEmpty')}
              </p>
            ) : (
              <ol className="flex flex-col gap-0.5 font-mono text-[11px] leading-relaxed">
                {visibleLog.map((ev) => (
                  <li key={ev.id} className="flex items-start gap-2 px-1">
                    <span className="shrink-0 text-ink-faint">{fmtTime(ev.at)}</span>
                    {/* Structured kind chip (条件1): the event TYPE at a glance,
                        distinct from the message + the level colour. 'routine'
                        carries no chip (it's the hidden-by-default bookkeeping). */}
                    {ev.kind && ev.kind !== 'routine' && (
                      <span className="label-cap shrink-0 rounded-[2px] border border-line px-1 leading-[14px] text-ink-muted">
                        {kindLabel[ev.kind]}
                      </span>
                    )}
                    <span className={`min-w-0 flex-1 break-words ${LEVEL_COLOR[ev.level]}`}>{ev.message}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
        </div>
      </aside>
    </div>
  )
}

// One labelled On/Off switch row. The segmented control reuses the house pattern
// (SettingsPanel's experiment toggle): selected flips BACKGROUND + TEXT together
// (bg-accent / text-bg-card) so contrast holds, with explicit hover/disabled/
// focus-visible states.
const ControlRow = ({
  label,
  hint,
  value,
  disabled,
  ariaLabel,
  onToggle,
  t,
}: {
  label: string
  hint: string
  value: boolean
  disabled: boolean
  ariaLabel: string
  onToggle: (next: boolean) => void
  t: (key: string) => string
}) => (
  <div className="flex items-start justify-between gap-3">
    <div className="min-w-0">
      <div className="text-[12px] font-medium text-ink">{label}</div>
      <div className="text-[11px] leading-snug text-ink-subtle">{hint}</div>
    </div>
    <div
      role="group"
      aria-label={ariaLabel}
      aria-disabled={disabled}
      className="inline-flex shrink-0 items-center gap-0 rounded-[3px] border border-line p-0.5"
    >
      {([
        [false, t('projectPanel.swarm.manager.off')],
        [true, t('projectPanel.swarm.manager.on')],
      ] as [boolean, string][]).map(([v, vLabel]) => {
        const active = value === v
        return (
          <button
            key={String(v)}
            type="button"
            onClick={() => {
              if (!disabled && value !== v) onToggle(v)
            }}
            aria-pressed={active}
            disabled={disabled}
            className={[
              'h-6 min-w-[40px] rounded-[2px] px-2.5 text-[11px] font-medium transition-all duration-150',
              'border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
              'disabled:cursor-not-allowed disabled:opacity-40',
              active
                ? 'border-accent bg-accent text-bg-card'
                : 'border-line bg-transparent text-ink-muted enabled:hover:border-line-strong enabled:hover:bg-bg-inset enabled:hover:text-ink',
            ].join(' ')}
          >
            {vLabel}
          </button>
        )
      })}
    </div>
  </div>
)

// The commander command bar — quick-command chips + a free-text field that issue
// orders to the /manage PTY WITHOUT the user clicking into the xterm (condition
// 1+2). It owns its own draft state so a keystroke re-renders only this bar, not
// the whole dashboard. `onSend` does the actual POST (the parent's
// sendToCommander); this component is pure input. IME-safe per the house rule:
// the draft is locally controlled (no async round-trip to rewind it mid-compose)
// and the Enter handler defers to an in-flight composition (never steals the
// kanji-confirm Enter — checking BOTH the composition ref and nativeEvent.
// isComposing, since a fast confirm can fire keydown before compositionend).
const CommanderCommandBar = ({
  onSend,
  disabled,
  t,
}: {
  onSend: (text: string) => void
  disabled: boolean
  t: (key: string) => string
}) => {
  const [value, setValue] = useState('')
  const composingRef = useRef(false)
  const taRef = useRef<HTMLTextAreaElement | null>(null)

  const submit = () => {
    if (disabled) return
    const text = value
    if (!text.trim()) return
    onSend(text)
    setValue('')
    // Keep focus for rapid follow-up orders (don't bounce the user to the xterm).
    requestAnimationFrame(() => taRef.current?.focus())
  }

  return (
    <div className="shrink-0 border-t border-line-soft bg-bg-card px-3 py-2">
      {/* Quick-command chips — one click sends the commander's documented verb. */}
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {QUICK_COMMANDS.map((q) => (
          <button
            key={q.key}
            type="button"
            disabled={disabled}
            onClick={() => onSend(q.command)}
            className="rounded-full border border-line bg-transparent px-2.5 py-0.5 text-[11px] text-ink-muted transition-colors enabled:hover:border-accent enabled:hover:text-ink active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            {t(`projectPanel.swarm.manager.${q.key}`)}
          </button>
        ))}
      </div>
      {/* Free-text order + send. Enter submits, Shift+Enter inserts a newline. */}
      <div className="flex items-end gap-2">
        <textarea
          ref={taRef}
          rows={1}
          value={value}
          disabled={disabled}
          aria-label={t('projectPanel.swarm.manager.command')}
          placeholder={t('projectPanel.swarm.manager.commandPlaceholder')}
          onChange={(e) => setValue(e.target.value)}
          onCompositionStart={() => {
            composingRef.current = true
          }}
          onCompositionEnd={() => {
            composingRef.current = false
          }}
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              !e.shiftKey &&
              !composingRef.current &&
              !(e.nativeEvent as unknown as { isComposing?: boolean }).isComposing
            ) {
              e.preventDefault()
              submit()
            }
          }}
          className="max-h-[120px] min-h-[34px] min-w-0 flex-1 resize-none rounded-[4px] border border-line bg-bg px-2.5 py-1.5 text-[12px] leading-snug text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
        />
        <button
          type="button"
          onClick={submit}
          disabled={disabled || !value.trim()}
          className="flex shrink-0 items-center gap-1 rounded-[3px] border border-line bg-bg px-2.5 py-1.5 text-[11px] text-ink-muted transition-colors enabled:hover:border-accent enabled:hover:text-ink active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        >
          <Send size={11} strokeWidth={2.25} />
          {t('projectPanel.swarm.manager.send')}
        </button>
      </div>
    </div>
  )
}

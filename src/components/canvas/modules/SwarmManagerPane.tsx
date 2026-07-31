// SwarmManagerPane — the commander (司令官) tab: the THIRD Swarm main view,
// alongside the supply desk and the worker tiles. It folds TWO things onto one
// tab:
//
//   ① a STAGE (left, the big area) — the commander CONVERSATION: an interactive
//      `claude` running /manage you talk to (status / merge / advise), reusing
//      the existing ClaudeTerminalPane VERBATIM — the same PTY/SSE/xterm the
//      supply desk and worker tiles use, so typing into it IS the dialogue input
//      (text in, Enter sends, claude responds). The commander PTY's lifecycle
//      (launch / stop / persist) is owned by SwarmModule, exactly like the supply
//      session — this pane only renders it.
//
//   ② a SIDEBAR (right) — the autonomous orchestration ENGINE's CONTROLS ONLY:
//        • Engine — the run/stop/offline status badge + the Overseer switch.
//          The autonomy ON/OFF (Card①) moved OUT to the module-level
//          master power switch (SwarmPowerBar) so the engine has a SINGLE
//          start/stop control; this dashboard no longer toggles it (it only
//          shows the resulting `running` status). The worker monitor + engine
//          log that used to live here were REMOVED: the live worker set is the
//          WORKER TAB's job now (一本化). (The Board pipeline tallies stay on the
//          Board tab; per-worker screens + their stop/resolve controls stay on
//          the worker tab.)
//
// SPLIT OF CONCERNS: the autonomous engine lives server-side behind
// /api/swarm/orchestrator{,/start,/stop}; its FRONT-END half (the
// poll, the switches, graceful 404 degradation) lives in the shared
// `useSwarmEngine` hook, which SwarmModule calls ONCE and threads down here as
// props. This pane is therefore PURELY PRESENTATIONAL for the engine — it never
// fetches. Start/stop (autonomy) is driven from SwarmModule's master power
// switch; only the Overseer is toggled here.
//
// (The Auto-wake-the-commander switch — POST /api/swarm/orchestrator/automerge —
// was RETIRED 2026-07-16: waking the commander when a worker is ready is now
// ALWAYS ON while the engine runs; the engine still never merges. Merge consent
// stays per-card ([hold] prefix + the commander's high-risk force-hold). See
// docs/commander/03-integration-review.md.)
//
// The commander CONVERSATION (/manage) is a SEPARATE PTY session, independent of
// the engine route — it works whether or not the autonomous engine is available;
// its lifecycle is owned by SwarmModule (like supply) and passed in as `session`.
//
// SECURITY: mounted only inside SwarmModule, itself behind the owner+toggle gate
// (see SwarmModule's header) — the SAME gate as the supply / worker surfaces. No
// extra gating is needed here; the server /api/swarm/* routes are owner-only too.

import { useCallback, useRef, useState } from 'react'
import { Activity, AlertTriangle, BarChart3, ClipboardCheck, Gauge, MessageSquare, Power, Send } from 'lucide-react'
import { ClaudeTerminalPane } from '@/components/canvas/ClaudeTerminalPane'
import { SdkWorkerPane } from './SdkWorkerPane'
import { useT } from '@/i18n/I18nContext'
import type { WorkerStatus } from './SwarmWorkerPane'
import { commanderPresence, type SwarmEngineState } from './useSwarmEngine'

/** The commander CONVERSATION (/manage) session, owned by SwarmModule (exactly
 *  like the supply session). null = not launched — the stage shows the launch
 *  CTA. */
export interface ManagerSession {
  /** PTY commander ⇒ its terminal id. SDK commander ⇒ '' (identity invariant:
   *  pty ⇔ terminalId, sdk ⇔ sdkSessionId, never both). */
  terminalId: string
  /** Absent ⇒ 'pty', the shape every session predating the commander dial has. */
  runtime?: 'pty' | 'sdk'
  sdkSessionId?: string
  /** Live status from SwarmModule's active-terminal poll (the SAME vocabulary
   *  the supply / worker tiles use). Only meaningful for a PTY desk — an SDK
   *  desk reports its own status on its event stream. */
  status: WorkerStatus
}

interface Props {
  /** The project this desk runs in — every /api/sdk-session/* call is gated on it. */
  projectPath: string
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
  /** Relaunch the commander conversation after it exits — wired to the exit
   *  overlay's Restart button (POST /api/swarm/manager again, via SwarmModule). */
  onRestartSession: () => void
  // ── Engine controls (from useSwarmEngine, owned by SwarmModule) ─────────────
  /** Latest engine state — only `running` / `overseer` are read here now. */
  engine: SwarmEngineState
  /** Whether the orchestrator route answered (false dims the switches). */
  available: boolean
  /** A start/stop or overseer round-trip is in flight (disables the switches). */
  busy: boolean
  /** Last engine-action failure, already localized (null when none). */
  error: string | null
  /** Overseer switch (EPIC C / C-core) — the THIRD toggle. ASYMMETRIC: an explicit
   *  autonomy OFF clears it, so the owner re-arms it every session (surfaced in its
   *  hint). Default OFF. */
  onToggleOverseer: (next: boolean) => void
  /** The overseer was armed WITHOUT the sandbox experiment (L3) — show a reduced-
   *  containment note under the switch. */
  sandboxWarning: boolean
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

// Quick commands the bar offers as one-click chips. The SENT string is the
// commander's documented Japanese trigger word (/manage responds to 状況/マージ/
// 掃除 regardless of the UI language) — only the chip LABEL is localized.
const QUICK_COMMANDS: { key: string; command: string }[] = [
  { key: 'quickStatus', command: '状況' },
  { key: 'quickMerge', command: 'マージ' },
  { key: 'quickClean', command: '掃除' },
]

// ── KPI formatting (the analytics layer's readout) ───────────────────────────
// Compact human duration for the lead-time median (ms → "12m" / "1.5h"); a rate
// (0..1) → integer percent, or an em dash when null ("no data yet" — never a
// misleading 0%). Pure presentation helpers.
const formatDuration = (ms: number): string => {
  if (ms < 1000) return '<1s'
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`
  return `${(ms / 86_400_000).toFixed(1)}d`
}
const formatPct = (rate: number | null): string =>
  rate === null ? '—' : `${Math.round(Math.min(1, Math.max(0, rate)) * 100)}%` // clamp [0,1] — never "150%"

// One STATIC stat row — a readout, not a control, so ui-interactive-states (the
// 5-state contract) doesn't apply (there's nothing to hover/press/focus). Label
// (subtle) + value (ink, tabular so digits don't jitter); `sub` is a faint
// denominator/hint under the label. Paper ink tokens keep 4.5:1+ on bg-bg.
// `valueTone='warn'` recolors the value to ochre-deep (#855E17, ≥4.5:1 on the
// paper bg) for an over-budget figure — an ADDITIVE option; the default tone is
// the existing ink value, so every current caller is unchanged.
const KpiRow = ({
  label,
  value,
  sub,
  valueTone = 'default',
}: {
  label: string
  value: string
  sub?: string
  valueTone?: 'default' | 'warn'
}) => (
  <div className="flex items-baseline justify-between gap-3 py-1">
    <div className="min-w-0">
      <div className="truncate text-[12px] text-ink-subtle">{label}</div>
      {sub && <div className="truncate text-[10px] leading-tight text-ink-faint">{sub}</div>}
    </div>
    <div
      className={`shrink-0 text-[13px] font-medium tabular-nums ${
        valueTone === 'warn' ? 'text-ochre-deep' : 'text-ink'
      }`}
    >
      {value}
    </div>
  </div>
)

export const SwarmManagerPane = ({
  session,
  sessionBusy,
  onLaunchSession,
  onStopSession,
  onSessionExit,
  onRestartSession,
  engine,
  available,
  busy,
  error,
  onToggleOverseer,
  sandboxWarning,
  projectPath,
}: Props) => {
  const { t } = useT()

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
  const sdkCommanderId = session?.runtime === 'sdk' ? (session.sdkSessionId ?? null) : null
  const sendToCommander = useCallback(
    async (raw: string) => {
      const text = raw.replace(/\r/g, '')
      if (!text.trim()) return
      // An SDK desk takes a TURN, not keystrokes: one POST carries the whole
      // order, newlines and all, and the CLI queues it even mid-generation.
      // None of the machinery below applies — no CR-as-Enter, no bracketed
      // paste, no ESC stripping — because none of its problems exist when the
      // text is not being typed into a terminal.
      if (sdkCommanderId) {
        await fetch(
          `/api/sdk-session/${encodeURIComponent(sdkCommanderId)}/input?path=${encodeURIComponent(projectPath)}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text }),
          },
        ).catch(() => {})
        return
      }
      if (!commanderId) return
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
    [commanderId, sdkCommanderId, projectPath],
  )

  // Engine status badge: running (moss) · stopped (grey) · offline (faint).
  const statusDot = !available ? 'bg-ink-faint' : engine.running ? 'bg-moss' : 'bg-ink-faint'
  const statusLabel = !available
    ? t('projectPanel.swarm.manager.engineOffline')
    : engine.running
      ? t('projectPanel.swarm.manager.engineRunning')
      : t('projectPanel.swarm.manager.engineStopped')

  // Commander presence (the inspection line): fresh heartbeat → active, else
  // standby (fail-safe on absent/unreadable). The review count is the inspection
  // queue — how many finished jobs wait for the commander's check before landing.
  const manager = engine.manager
  const presence = commanderPresence(manager)
  const reviewCount = engine.reviews.length

  // KPI roll-up (the analytics layer). "Empty" = the engine has neither logged a
  // counted event NOR completed a card this session → show the explainer instead
  // of a wall of dashes/zeros.
  const kpis = engine.kpis
  const kpiEvents =
    kpis.counts.dispatched +
    kpis.counts.integrated +
    kpis.counts.conflicted +
    kpis.counts.reworked +
    kpis.counts.crashed +
    kpis.counts.stalled
  const kpiEmpty = kpiEvents === 0 && kpis.leadTime.count === 0

  // Consumption (the budget layer) — the unattended loop's live load + session
  // spend. Run time shows a dash (not "<1s") when no worker is live, so an idle
  // loop reads cleanly rather than implying a sub-second sliver of work.
  const consumption = engine.consumption
  const consumptionRunTime =
    consumption.activeWorkers > 0 ? formatDuration(consumption.activeRunMs) : '—'

  return (
    // Two columns: the STAGE (commander conversation) and the DASHBOARD sidebar
    // (engine controls). min-w-0 on the stage is load-bearing so the terminal can
    // shrink.
    <div className="flex h-full min-h-0 w-full">
      {/* ── STAGE ──────────────────────────────────────────────────────────── */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg">
        {session ? (
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
              {session.runtime === 'sdk' && session.sdkSessionId ? (
                // An SDK commander has no terminal to render — its desk shows the
                // distilled event stream instead. This is the readable transcript
                // the whole migration started from, now on the desk the owner
                // actually reads. Same tile as an SDK worker, so a fleet and its
                // commander read as one system.
                <SdkWorkerPane
                  sdkSessionId={session.sdkSessionId}
                  projectPath={projectPath}
                  branch={t('projectPanel.swarm.manager.badge')}
                  taskTitle={t('projectPanel.swarm.manager.conversationTitle')}
                  onExit={() => onSessionExit()}
                />
              ) : (
                <ClaudeTerminalPane
                  terminalId={session.terminalId}
                  chrome={false}
                  onExit={() => onSessionExit()}
                  onRestart={onRestartSession}
                />
              )}
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

      {/* ── DASHBOARD sidebar: engine controls ONLY ────────────────────────── */}
      {/* PAPER surface (bg-bg) — a dashboard, not a terminal, so the paper ink
          tokens keep 4.5:1+ contrast (the dark terminal bg lives on the stage). */}
      <aside className="flex w-[300px] shrink-0 flex-col border-l border-line bg-bg">
        {/* Engine: status + the two switches (Card① / Card③). The worker monitor
            + engine log that used to sit below this were removed (一本化 — the
            worker tab owns live worker screens), so this is the sole section. */}
        <div className="shrink-0 px-4 py-3">
          <div className="mb-3 flex items-center gap-2">
            <Gauge size={13} strokeWidth={2} className="shrink-0 text-ink-faint" aria-hidden />
            <span className="label-cap text-ink-faint">{t('projectPanel.swarm.manager.engineHeading')}</span>
            <span className="ml-auto flex items-center gap-1.5">
              <span className={`h-[6px] w-[6px] shrink-0 rounded-full ${statusDot}`} aria-hidden />
              <span className="text-[11px] text-ink-muted">{statusLabel}</span>
            </span>
          </div>

          {/* Autonomy (Card① start/stop) moved to the module-level master power
              switch (SwarmPowerBar) — the engine's SINGLE on/off — so this
              dashboard keeps only the Overseer switch. (The auto-wake toggle was
              retired 2026-07-16: waking the commander is always on while the
              engine runs.) The engine status badge above still reads
              `engine.running` (driven by the master switch). */}
          <div className="flex flex-col gap-2.5">
            {/* Overseer (EPIC C / C-core) — the THIRD toggle. Its hint states the D1
                asymmetry: an explicit autonomy OFF disarms it, so it is re-armed each
                session (no auto-resume). Disabled while the engine is stopped — the
                overseer is a STAGE of the running tick and the server refuses to arm a
                stopped engine (§5:243 "autonomy ON 中の engine にのみ有効"), so the switch
                reflects that precondition rather than letting a click silently no-op. */}
            <ControlRow
              label={t('projectPanel.swarm.manager.overseer')}
              hint={t('projectPanel.swarm.manager.overseerHint')}
              value={engine.overseer}
              disabled={busy || !available || !engine.running}
              ariaLabel={t('projectPanel.swarm.manager.overseer')}
              onToggle={(v) => onToggleOverseer(v)}
              t={t}
            />
            {engine.overseer && sandboxWarning ? (
              <p className="text-[10px] leading-snug text-amber-500/90" role="note">
                {t('projectPanel.swarm.manager.overseerSandboxWarning')}
              </p>
            ) : null}
          </div>

          {error && <p className="mt-2.5 text-[11px] leading-relaxed text-accent">{error}</p>}
        </div>

        {/* ── Commander presence (the inspection line) ──────────────────────────
            Explains the post-worker quiet minutes: fresh heartbeat → "the
            commander is working" (+ its own one-line note + last-report age);
            stale/absent → "resting — wakes on the next finish" (fail-safe: a
            missing/unreadable heartbeat only ever degrades to this standby
            wording). When review cards are waiting, the inspection queue count
            makes the worker-finish → inspection → live pipeline position
            readable. Static readout — no controls, so the 5-state interactive
            contract doesn't apply. Owner-plain wording (owner-surface rule,
            2026-07-17); paper ink tokens keep 4.5:1+ contrast. */}
        <div className="shrink-0 border-t border-line-soft px-4 py-3">
          <div className="mb-2 flex items-center gap-2">
            <ClipboardCheck size={13} strokeWidth={2} className="shrink-0 text-ink-faint" aria-hidden />
            <span className="label-cap text-ink-faint">
              {t('projectPanel.swarm.manager.presenceHeading')}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {/* Same beacon vocabulary as the session dots: azure = working now,
                ink-faint = inert (resting). */}
            <span
              className={`h-[6px] w-[6px] shrink-0 rounded-full ${
                presence === 'active' ? 'bg-azure' : 'bg-ink-faint'
              }`}
              aria-hidden
            />
            <span className="text-[12px] font-medium text-ink">
              {presence === 'active'
                ? t('projectPanel.swarm.manager.presenceActive')
                : t('projectPanel.swarm.manager.presenceStandby')}
            </span>
          </div>
          <p className="mt-1 text-[11px] leading-snug text-ink-subtle">
            {presence === 'active'
              ? t('projectPanel.swarm.manager.presenceActiveHint')
              : t('projectPanel.swarm.manager.presenceStandbyHint')}
          </p>
          {/* The commander's own one-line note — its self-reported "doing now"
              (free-form, often Japanese). Shown only while fresh: a stale note
              describes a PAST episode and would read as a live claim. */}
          {presence === 'active' && manager?.note && (
            <p className="mt-1.5 truncate text-[11px] text-ink-muted" title={manager.note}>
              {manager.note}
            </p>
          )}
          {/* Last-report age (server clock) — shown whenever a heartbeat exists,
              so a resting desk still says how long ago it last spoke. */}
          {manager && (
            <p className="mt-0.5 text-[10px] text-ink-faint">
              {t('projectPanel.swarm.manager.presenceLastBeat', {
                ago: formatDuration(manager.ageMs),
              })}
            </p>
          )}
          {reviewCount > 0 && (
            <div className="mt-2 border-t border-line-soft pt-2">
              <div className="text-[12px] font-medium tabular-nums text-ink">
                {t('projectPanel.swarm.manager.presenceQueue', { count: reviewCount })}
              </div>
              <p className="mt-0.5 text-[10px] leading-snug text-ink-faint">
                {t('projectPanel.swarm.manager.presenceQueueHint')}
              </p>
            </div>
          )}
        </div>

        {/* ── KPI roll-up (the analytics layer) ─────────────────────────────────
            A SEPARATE panel from the live Engine status above: lead time +
            rework / conflict / worker-success rates — the "is the swarm getting
            better?" data foundation. Static readout (no controls), so the
            5-state interactive contract doesn't apply; paper ink tokens keep
            contrast in dark + light. */}
        <div className="shrink-0 border-t border-line-soft px-4 py-3">
          <div className="mb-2 flex items-center gap-2">
            <BarChart3 size={13} strokeWidth={2} className="shrink-0 text-ink-faint" aria-hidden />
            <span className="label-cap text-ink-faint">{t('projectPanel.swarm.manager.kpiHeading')}</span>
          </div>
          {kpiEmpty ? (
            <p className="text-[11px] leading-relaxed text-ink-subtle">
              {t('projectPanel.swarm.manager.kpiEmpty')}
            </p>
          ) : (
            <div className="flex flex-col">
              <KpiRow
                label={t('projectPanel.swarm.manager.kpiLeadTime')}
                value={kpis.leadTime.medianMs === null ? '—' : formatDuration(kpis.leadTime.medianMs)}
                sub={
                  kpis.leadTime.count > 0
                    ? t('projectPanel.swarm.manager.kpiLeadTimeHint', { count: kpis.leadTime.count })
                    : undefined
                }
              />
              <KpiRow
                label={t('projectPanel.swarm.manager.kpiWorkerSuccess')}
                value={formatPct(kpis.workerSuccessRate)}
                sub={
                  kpis.counts.dispatched > 0
                    ? `${kpis.counts.integrated}/${kpis.counts.dispatched}`
                    : undefined
                }
              />
              <KpiRow
                label={t('projectPanel.swarm.manager.kpiReworkRate')}
                value={formatPct(kpis.reworkRate)}
              />
              <KpiRow
                label={t('projectPanel.swarm.manager.kpiConflictRate')}
                value={formatPct(kpis.conflictRate)}
              />
            </div>
          )}
        </div>

        {/* ── Consumption (the budget layer) ────────────────────────────────────
            A SEPARATE panel from the KPI metrics above: the UNATTENDED loop's
            live load (active workers + in-flight run time) and its session spend
            (dispatched vs the configurable budget). Static readout — like KpiRow
            it is a readout, not a control, so the 5-state interactive contract
            doesn't apply (nothing to hover/press/focus). The over-budget warning
            uses ochre-deep (#855E17, ≥4.5:1 on the paper bg) per the caution
            palette — never raw ochre. */}
        <div className="shrink-0 border-t border-line-soft px-4 py-3">
          <div className="mb-2 flex items-center gap-2">
            <Activity size={13} strokeWidth={2} className="shrink-0 text-ink-faint" aria-hidden />
            <span className="label-cap text-ink-faint">
              {t('projectPanel.swarm.manager.consumptionHeading')}
            </span>
          </div>
          <div className="flex flex-col">
            <KpiRow
              label={t('projectPanel.swarm.manager.consumptionActive')}
              value={`${consumption.activeWorkers} / ${engine.maxWorkers}`}
            />
            <KpiRow
              label={t('projectPanel.swarm.manager.consumptionRunTime')}
              value={consumptionRunTime}
            />
            <KpiRow
              label={t('projectPanel.swarm.manager.consumptionDispatched')}
              value={`${consumption.dispatched} / ${consumption.limit}`}
              sub={t('projectPanel.swarm.manager.consumptionDispatchedHint')}
              valueTone={consumption.overLimit ? 'warn' : 'default'}
            />
          </div>
          {consumption.overLimit && (
            <p
              role="alert"
              className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-ochre-deep"
            >
              <AlertTriangle size={13} strokeWidth={2} className="mt-px shrink-0" aria-hidden />
              <span>
                {t('projectPanel.swarm.manager.consumptionOverLimit', {
                  dispatched: consumption.dispatched,
                  limit: consumption.limit,
                })}
              </span>
            </p>
          )}
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

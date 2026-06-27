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
//        • Engine — the run/stop/offline status badge + the Auto-integrate (③)
//          switch. The autonomy ON/OFF (Card①) moved OUT to the module-level
//          master power switch (SwarmPowerBar) so the engine has a SINGLE
//          start/stop control; this dashboard no longer toggles it (it only
//          shows the resulting `running` status). The worker monitor + engine
//          log that used to live here were REMOVED: the live worker set is the
//          WORKER TAB's job now (一本化). (The Board pipeline tallies stay on the
//          Board tab; per-worker screens + their stop/resolve controls stay on
//          the worker tab.)
//
// SPLIT OF CONCERNS: the autonomous engine lives server-side behind
// /api/swarm/orchestrator{,/start,/stop,/automerge}; its FRONT-END half (the
// poll, the switches, graceful 404 degradation) lives in the shared
// `useSwarmEngine` hook, which SwarmModule calls ONCE and threads down here as
// props. This pane is therefore PURELY PRESENTATIONAL for the engine — it never
// fetches. Start/stop (autonomy) is driven from SwarmModule's master power
// switch; only Auto-integrate is toggled here:
//
//   • Auto-integrate (③) — POST /api/swarm/orchestrator/automerge. The engine
//     lands fast-forwardable / cleanly-rebasable review cards on the trunk
//     itself (FF / rebase only, never forced; conflicts left for a human). Read
//     off the state's `autoMerge`, default OFF. The switch dims when the route
//     is unreachable (`available === false`) and goes live once it answers.
//
// The commander CONVERSATION (/manage) is a SEPARATE PTY session, independent of
// the engine route — it works whether or not the autonomous engine is available;
// its lifecycle is owned by SwarmModule (like supply) and passed in as `session`.
//
// SECURITY: mounted only inside SwarmModule, itself behind the owner+toggle gate
// (see SwarmModule's header) — the SAME gate as the supply / worker surfaces. No
// extra gating is needed here; the server /api/swarm/* routes are owner-only too.

import { useCallback, useRef, useState } from 'react'
import { Gauge, MessageSquare, Power, Send } from 'lucide-react'
import { ClaudeTerminalPane } from '@/components/canvas/ClaudeTerminalPane'
import { useT } from '@/i18n/I18nContext'
import type { WorkerStatus } from './SwarmWorkerPane'
import type { SwarmEngineState } from './useSwarmEngine'

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
  /** Latest engine state — only `running` / `autoMerge` are read here now. */
  engine: SwarmEngineState
  /** Whether the orchestrator route answered (false dims the switches). */
  available: boolean
  /** A start/stop or auto-merge round-trip is in flight (disables both switches). */
  busy: boolean
  /** Last engine-action failure, already localized (null when none). */
  error: string | null
  /** Auto-integrate switch (Card③). The autonomy ON/OFF (Card①) moved OUT of this
   *  dashboard to the module-level master power switch (SwarmPowerBar), so the
   *  engine has a SINGLE start/stop control; this pane keeps only Auto-integrate. */
  onToggleAutoMerge: (next: boolean) => void
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
  onToggleAutoMerge,
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

  // Engine status badge: running (moss) · stopped (grey) · offline (faint).
  const statusDot = !available ? 'bg-ink-faint' : engine.running ? 'bg-moss' : 'bg-ink-faint'
  const statusLabel = !available
    ? t('projectPanel.swarm.manager.engineOffline')
    : engine.running
      ? t('projectPanel.swarm.manager.engineRunning')
      : t('projectPanel.swarm.manager.engineStopped')

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
              <ClaudeTerminalPane
                terminalId={session.terminalId}
                chrome={false}
                onExit={() => onSessionExit()}
                onRestart={onRestartSession}
              />
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
              dashboard keeps only Auto-integrate (Card③), the separate
              default-off landing policy. The engine status badge above still
              reads `engine.running` (driven by the master switch). */}
          <div className="flex flex-col gap-2.5">
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

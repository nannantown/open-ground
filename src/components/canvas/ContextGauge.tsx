// ContextGauge.tsx — per-terminal context fuel gauge + the manual escape hatch.
//
// The run is meant to be hands-off (native auto-compact owns compaction), so
// this stays SMALL: a thin bar in the pane's tab. Press it and a panel opens
// with the reading in words plus three buttons for the rare moment the owner
// wants to act now — compact, clear-and-continue, or a fresh session.
//
// Same idea as the quota HUD (UsageHud), one scale down: that one measures the
// subscription budget, this one measures the SESSION's context window. Levels
// come from contextGauge.ts, which also keeps the two readings' scales apart
// (JSONL free-space vs claude's own near-limit footnote) — the gauge must never
// paint a footnote alarm green.
//
// All I/O belongs to the parent (`onAction`): it owns the pane's PTY id and, for
// a fresh session, the pane's remount. This component only renders and reports.
import { Fragment, useEffect, useRef, useState } from 'react'
import { Gauge } from 'lucide-react'
import { useT } from '@/i18n/I18nContext'
import {
  contextFillPct,
  contextLevel,
  type ContextActionOutcome,
  type ContextLeftSource,
} from '@/lib/contextGauge'
import type { UsageLevel } from '@/lib/usageThresholds'
// The same cap the server enforces when it sanitises the hint — applied here as
// the input's maxLength so the limit is felt at the keyboard rather than as a
// silent truncation after the fact.
import { MAX_SLASH_ARG } from '@/lib/contextGauge'

export type ContextAction = 'compact' | 'clear' | 'fresh'

interface Props {
  /** The pane's "% still free" reading from the beacon. null/undefined = none yet. */
  leftPct?: number | null
  /** Which scale that number is on (see contextGauge.ts). */
  source?: ContextLeftSource | null
  /** Does this pane have a live claude session? false disables the two send
   *  buttons — there is nothing to type into. */
  hasSession: boolean
  /** Perform an action. The parent does the I/O and reports back what happened.
   *  `focus` is the optional one-line guidance for `compact` (never sent for the
   *  other two — they take no argument). */
  onAction: (action: ContextAction, focus?: string) => Promise<ContextActionOutcome>
}

// Bar tones. Dark surface (the terminal strip), so the fill carries the colour
// and the track stays a faint white — the same green/amber/red ladder the quota
// HUD uses, via the shared UsageLevel.
const FILL_TONE: Record<UsageLevel, string> = {
  idle: 'bg-white/25',
  ok: 'bg-moss',
  warn: 'bg-ochre',
  over: 'bg-accent',
}
const TEXT_TONE: Record<UsageLevel, string> = {
  idle: 'text-white/50',
  ok: 'text-white/70',
  warn: 'text-ochre',
  over: 'text-accent',
}

// One shared button skin: default / hover / active / disabled / focus-visible
// all defined, per the interactive-states rule. Ghost on dark — transparent
// until touched, and unmistakably inert when disabled.
const ACTION_BTN = [
  'w-full rounded-[3px] border px-2 py-1.5 text-left text-meta font-medium transition-all duration-150',
  'border-white/15 bg-transparent text-white/70',
  'hover:border-white/25 hover:bg-white/[0.08] hover:text-white',
  'active:border-white/30 active:bg-white/[0.12] active:text-white',
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white',
  'disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:border-white/15 disabled:hover:bg-transparent disabled:hover:text-white/70',
].join(' ')

// The focus box shares the buttons' ghost-on-dark skin, with its own resting /
// hover / focus / disabled steps (a text field has no meaningful "pressed").
const FOCUS_INPUT = [
  'w-full rounded-[3px] border px-2 py-1 text-meta transition-all duration-150',
  'border-white/10 bg-white/[0.04] text-white placeholder:text-white/35',
  'hover:border-white/20 hover:bg-white/[0.07]',
  'focus:border-white/30 focus:bg-white/[0.09] focus:outline-none',
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white',
  'disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:border-white/10 disabled:hover:bg-white/[0.04]',
].join(' ')

export const ContextGauge = ({ leftPct, source, hasSession, onAction }: Props) => {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const [busyAction, setBusyAction] = useState<ContextAction | null>(null)
  const [outcome, setOutcome] = useState<ContextActionOutcome | null>(null)
  // Optional guidance for "compact now" ("keep the API redesign"). Empty is the
  // normal case — claude summarises on its own judgement then.
  const [focus, setFocus] = useState('')
  const rootRef = useRef<HTMLDivElement | null>(null)

  const level = contextLevel(leftPct, source)
  const known = level !== 'idle'
  const fill = known ? contextFillPct(leftPct as number) : 0
  const left = known ? Math.round(leftPct as number) : null
  // The footnote counts down to auto-compact, not to a full window — so it gets
  // its own wording. Anything else is the 200k-window free space.
  const readingKey =
    source === 'footnote'
      ? 'projectPanel.contextGauge.readingFootnote'
      : 'projectPanel.contextGauge.readingWindow'
  const reading = known
    ? t(readingKey, { pct: left as number })
    : t('projectPanel.contextGauge.readingNone')

  // Close on outside click / Escape, like the other in-pane popovers.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      // `isComposing` — an Escape that cancels an IME conversion in the focus
      // box must not also close the panel out from under the typist.
      if (e.key === 'Escape' && !e.isComposing) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const run = async (action: ContextAction) => {
    if (busyAction) return
    setBusyAction(action)
    setOutcome(null)
    try {
      // Only /compact takes guidance; the server ignores it for the others
      // anyway, but sending it would be a lie about what the button does. With
      // no hint typed, the call carries no second argument at all — "compact"
      // and "compact, focusing on X" stay visibly different requests.
      const hint = action === 'compact' ? focus.trim() : ''
      const result = await (hint ? onAction(action, hint) : onAction(action))
      setOutcome(result)
      // A sent hint has been consumed — leaving it in the box invites a second
      // press to silently repeat guidance the user meant for one compaction.
      if (result === 'ok' && action === 'compact') setFocus('')
    } catch {
      setOutcome('error')
    } finally {
      setBusyAction(null)
    }
  }

  const actions: { id: ContextAction; disabled: boolean }[] = [
    // Compact / clear type into a LIVE session; with no session there is
    // nothing to type into, so they read as inert rather than failing on click.
    { id: 'compact', disabled: !hasSession },
    { id: 'clear', disabled: !hasSession },
    { id: 'fresh', disabled: false },
  ]

  return (
    // The tab strip above is a drag handle — swallow mousedown so opening the
    // gauge never starts a pane drag.
    <div ref={rootRef} className="relative shrink-0" onMouseDown={e => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-label={t('projectPanel.contextGauge.label')}
        title={`${t('projectPanel.contextGauge.label')} — ${reading}`}
        className={[
          'flex items-center gap-1 rounded-[3px] px-1 py-0.5 transition-colors duration-150',
          'hover:bg-white/10 active:bg-white/[0.16]',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white',
          open ? 'bg-white/[0.14]' : '',
        ].join(' ')}
      >
        <span
          aria-hidden
          className="block h-1.5 w-7 overflow-hidden rounded-full bg-white/15"
        >
          <span
            data-testid="context-gauge-fill"
            className={`block h-full rounded-full transition-[width] duration-300 ${FILL_TONE[level]}`}
            style={{ width: `${fill}%` }}
          />
        </span>
        {/* Quiet by default: the number only joins the tab once the session is
            actually filling up (amber / red), so a healthy pane stays clean. */}
        {known && level !== 'ok' && (
          <span className={`font-mono text-plate tabular-nums ${TEXT_TONE[level]}`}>{left}%</span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t('projectPanel.contextGauge.label')}
          className="absolute right-0 top-[calc(100%+6px)] z-40 w-60 rounded-[4px] border border-white/15 bg-[#141414] p-3 text-white/85 shadow-xl"
        >
          <div className="mb-2 flex items-center gap-1.5">
            <Gauge size={12} strokeWidth={2} className={TEXT_TONE[level]} aria-hidden />
            <span className="text-meta font-semibold text-white">
              {t('projectPanel.contextGauge.label')}
            </span>
          </div>

          <div className={`text-ui font-semibold tabular-nums ${TEXT_TONE[level]}`}>
            {reading}
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className={`h-full rounded-full transition-[width] duration-300 ${FILL_TONE[level]}`}
              style={{ width: `${fill}%` }}
            />
          </div>
          <p className="mt-2 text-micro leading-relaxed text-white/50">
            {known
              ? t(
                  source === 'footnote'
                    ? 'projectPanel.contextGauge.hintFootnote'
                    : 'projectPanel.contextGauge.hintWindow',
                )
              : t('projectPanel.contextGauge.hintNone')}
          </p>

          <div className="mt-2.5 space-y-1.5 border-t border-white/10 pt-2.5">
            {actions.map(({ id, disabled }) => (
              <Fragment key={id}>
                <button
                  type="button"
                  disabled={disabled || busyAction != null}
                  onClick={() => void run(id)}
                  title={t(`projectPanel.contextGauge.${id}Hint`)}
                  className={ACTION_BTN}
                >
                  <span className="block">{t(`projectPanel.contextGauge.${id}`)}</span>
                  <span className="mt-0.5 block text-micro font-normal text-white/45">
                    {busyAction === id
                      ? t('projectPanel.contextGauge.sending')
                      : t(`projectPanel.contextGauge.${id}Hint`)}
                  </span>
                </button>
                {/* Optional guidance, attached to the button it belongs to.
                    Blank is the normal case — claude then summarises on its own
                    judgement, exactly as it does when it compacts by itself. */}
                {id === 'compact' && (
                  <input
                    type="text"
                    value={focus}
                    disabled={disabled || busyAction != null}
                    maxLength={MAX_SLASH_ARG}
                    onChange={e => setFocus(e.target.value)}
                    onKeyDown={e => {
                      // Never steal the Enter that CONFIRMS an IME conversion.
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                        e.preventDefault()
                        void run('compact')
                      }
                    }}
                    placeholder={t('projectPanel.contextGauge.focusPlaceholder')}
                    aria-label={t('projectPanel.contextGauge.focusLabel')}
                    className={FOCUS_INPUT}
                  />
                )}
              </Fragment>
            ))}
          </div>

          {outcome && (
            <p
              role="status"
              className={`mt-2 text-micro leading-relaxed ${
                outcome === 'ok' ? 'text-moss' : 'text-ochre'
              }`}
            >
              {t(`projectPanel.contextGauge.outcome.${outcome}`)}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

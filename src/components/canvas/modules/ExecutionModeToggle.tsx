// ExecutionModeMenu — the ONE global switch that trades swarm capability ↔
// weekly-budget (card 68d8e00f), folded into a compact dropdown so it no longer
// occupies a full-width row of the Swarm header (mode changes are rare — an
// "options" affordance, not an always-on strip). Self-contained: reads
// /api/settings on mount and PATCHes executionMode on change (fire-and-forget,
// merged server-side, persisted), so it needs no prop-drilling through the deep
// ProjectPanel → SwarmModule tree. Every in-app swarm launch (worker / supply /
// commander) + the parallel cap read this mode server-side; a per-card override
// still wins via the Board 実行 button.
//
// The menu carries a SECOND, independent switch beneath the modes: 使用可能モデル
// (Settings.swarmAllowedModels) — the owner's permanent per-tier ON/OFF mask. A
// mode says how much capability to spend; the mask says which models exist at all.
// They belong on the same surface because the mask BOUNDS the mode: with fable
// switched off, "Max" runs on opus, and the mode hints say so ({top}/{light} are
// interpolated from the mask) rather than promising a model the engine will never
// launch. Server-side, every claude spawn path resolves through the same mask
// (src/lib/server/swarmAllowedModels.ts) — an OFF tier is unreachable, not merely
// deprioritized.
import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, SlidersHorizontal } from 'lucide-react'
import {
  EXECUTION_MODES,
  DEFAULT_EXECUTION_MODE,
  DEFAULT_SWARM_ALLOWED_MODELS,
  SWARM_MODEL_TIERS,
  effectiveAllowedTier,
  type ExecutionMode,
  type SwarmAllowedModels,
  type SwarmModelTier,
} from '@/lib/types'
import { useT } from '@/i18n/I18nContext'
import type { MessageKey } from '@/i18n/messages'

const asMode = (v: unknown): ExecutionMode =>
  typeof v === 'string' && (EXECUTION_MODES as readonly string[]).includes(v)
    ? (v as ExecutionMode)
    : DEFAULT_EXECUTION_MODE

/** Narrow the persisted (possibly partial / absent) mask to a full map. Mirrors
 *  the server's normalizeAllowedModels: only an explicit `false` disables a tier,
 *  so a missing key reads as usable. */
const asAllowed = (v: unknown): SwarmAllowedModels => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return { ...DEFAULT_SWARM_ALLOWED_MODELS }
  const src = v as Record<string, unknown>
  const out = { ...DEFAULT_SWARM_ALLOWED_MODELS }
  for (const tier of SWARM_MODEL_TIERS) out[tier] = src[tier] !== false
  return out
}

/** Display names for the CLI aliases. Deliberately version-free ("Fable", not
 *  "Fable 5"): the alias is what the swarm passes to `claude --model`, and a
 *  version baked into copy goes stale the moment the alias points at a new one. */
const MODEL_LABEL: Record<SwarmModelTier, string> = {
  fable: 'Fable',
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
}

const LABEL_KEY: Record<ExecutionMode, MessageKey> = {
  max: 'projectPanel.swarm.mode.max',
  economy: 'projectPanel.swarm.mode.economy',
  optimize: 'projectPanel.swarm.mode.optimize',
}
const HINT_KEY: Record<ExecutionMode, MessageKey> = {
  max: 'projectPanel.swarm.mode.max.hint',
  economy: 'projectPanel.swarm.mode.economy.hint',
  optimize: 'projectPanel.swarm.mode.optimize.hint',
}

export const ExecutionModeMenu = () => {
  const { t } = useT()
  const [mode, setMode] = useState<ExecutionMode>(DEFAULT_EXECUTION_MODE)
  const [allowed, setAllowed] = useState<SwarmAllowedModels>({ ...DEFAULT_SWARM_ALLOWED_MODELS })
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let alive = true
    fetch('/api/settings')
      .then((r) => r.json())
      .then((s) => {
        if (!alive) return
        const settings = s as { executionMode?: unknown; swarmAllowedModels?: unknown }
        setMode(asMode(settings?.executionMode))
        setAllowed(asAllowed(settings?.swarmAllowedModels))
      })
      .catch(() => {
        /* offline / server not up — the menu still works, defaults to optimize */
      })
    return () => {
      alive = false
    }
  }, [])

  // Close on outside click / Escape — the standard dismissal pair for a menu.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const change = (m: ExecutionMode) => {
    setOpen(false)
    if (m === mode || busy) return
    setMode(m) // optimistic — the switch feels instant; the PATCH just persists it
    setBusy(true)
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ executionMode: m }),
    })
      .catch(() => {
        /* fire-and-forget; a failed persist self-heals on the next open (re-GET) */
      })
      .finally(() => setBusy(false))
  }

  // The tiers currently switched ON. Used both to block the LAST one from being
  // turned off (an all-OFF mask can only park the swarm — the server refuses it
  // too, see store.setUserSettings) and to resolve the mode hints below.
  const onCount = SWARM_MODEL_TIERS.filter((tier) => allowed[tier]).length

  const toggleTier = (tier: SwarmModelTier) => {
    if (busy) return
    if (allowed[tier] && onCount <= 1) return // last one standing — never leave zero
    const next: SwarmAllowedModels = { ...allowed, [tier]: !allowed[tier] }
    const prev = allowed
    setAllowed(next) // optimistic
    setBusy(true)
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ swarmAllowedModels: next }),
    })
      .then((r) => {
        // A mask that did not persist must not KEEP showing as persisted: the
        // engine would still spawn on the tier the row claims is off. Roll back
        // rather than lie (the mode toggle can afford fire-and-forget; this can't).
        if (!r.ok) setAllowed(prev)
      })
      .catch(() => setAllowed(prev))
      .finally(() => setBusy(false))
  }

  // What each mode ACTUALLY launches on, given the mask — so the hint can never
  // promise a switched-off model. `?? MODEL_LABEL[...]` is unreachable (the last
  // tier can't be turned off) but keeps the copy sane if a hand-edited
  // settings.json ever reaches the client with everything off.
  const topTier = effectiveAllowedTier('fable', allowed)
  const lightTier = effectiveAllowedTier('sonnet', allowed)
  const hintVars = {
    top: topTier ? MODEL_LABEL[topTier] : '—',
    light: lightTier ? MODEL_LABEL[lightTier] : '—',
  }

  return (
    <div ref={rootRef} className="relative shrink-0">
      {/* Trigger — a ghost chip showing the CURRENT mode, so the state is readable
          without opening the menu. Open state lifts the background (the "pressed"
          look) so the popover visually hangs off it. */}
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
        title={t('projectPanel.swarm.mode.label')}
        className={[
          'flex h-6 items-center gap-1 rounded-[4px] border px-2 text-meta transition-colors duration-150',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
          'disabled:cursor-not-allowed disabled:opacity-40',
          open
            ? 'border-line-strong bg-bg-inset text-ink'
            : 'border-line bg-transparent text-ink-muted enabled:hover:border-line-strong enabled:hover:bg-plane enabled:hover:text-ink',
        ].join(' ')}
      >
        <SlidersHorizontal size={11} strokeWidth={2} className="shrink-0 text-ink-faint" aria-hidden />
        <span className="truncate">{t(LABEL_KEY[mode])}</span>
        <ChevronDown
          size={11}
          strokeWidth={2}
          className={`shrink-0 text-ink-faint transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>

      {/* The menu — one radio-style row per mode: name + its one-line trade-off
          hint (the old always-visible row hid the hints in tooltips; the menu has
          room to spell them out). Selected row shows a check + accent name.
          Below, a checkbox row per model tier: the permanent usable-models mask. */}
      {open && (
        <div
          role="menu"
          aria-label={t('projectPanel.swarm.mode.label')}
          // Scrolls instead of running off the bottom: the mode rows + the four
          // tier rows make this ~2× the height of the old menu, and the Swarm
          // header sits close enough to the top that a short window would clip the
          // last tier out of reach. `overflow-y-auto` still clips the rounded corners.
          className="absolute right-0 top-full z-30 mt-1 max-h-[min(70vh,28rem)] w-64 overflow-y-auto rounded-[5px] border border-line bg-bg-card shadow-card"
        >
          {EXECUTION_MODES.map((m) => {
            const active = mode === m
            return (
              <button
                key={m}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                disabled={busy}
                onClick={() => change(m)}
                className={[
                  'flex w-full items-start gap-2 px-3 py-2 text-left transition-colors duration-150',
                  'focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
                  'disabled:cursor-not-allowed disabled:opacity-50',
                  active ? 'bg-bg-inset' : 'enabled:hover:bg-plane',
                ].join(' ')}
              >
                <Check
                  size={12}
                  strokeWidth={2.5}
                  className={`mt-0.5 shrink-0 ${active ? 'text-accent' : 'invisible'}`}
                  aria-hidden
                />
                <span className="min-w-0">
                  <span className={`block text-ui font-medium ${active ? 'text-accent' : 'text-ink'}`}>
                    {t(LABEL_KEY[m])}
                  </span>
                  <span className="block text-micro leading-snug text-ink-subtle">
                    {t(HINT_KEY[m], hintVars)}
                  </span>
                </span>
              </button>
            )
          })}

          {/* 使用可能モデル — the hard mask. A separate group (own label + rule)
              because it is a different KIND of setting: not "how much to spend"
              but "which models exist for this swarm at all". */}
          <div className="border-t border-line px-3 pb-1 pt-2">
            <div className="text-micro font-medium uppercase tracking-wide text-ink-faint">
              {t('projectPanel.swarm.models.label')}
            </div>
            <div className="mt-0.5 text-micro leading-snug text-ink-subtle">
              {t('projectPanel.swarm.models.hint')}
            </div>
          </div>
          <div className="pb-1">
            {SWARM_MODEL_TIERS.map((tier) => {
              const on = allowed[tier]
              const isLastOn = on && onCount <= 1
              return (
                <button
                  key={tier}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={on}
                  disabled={busy || isLastOn}
                  onClick={() => toggleTier(tier)}
                  title={isLastOn ? t('projectPanel.swarm.models.last') : undefined}
                  className={[
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors duration-150',
                    'focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
                    'disabled:cursor-not-allowed disabled:opacity-50',
                    'enabled:hover:bg-plane',
                  ].join(' ')}
                >
                  {/* A real checkbox shape (not the radio check) so the two groups
                      read as different kinds of choice at a glance. */}
                  <span
                    aria-hidden
                    className={[
                      'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border transition-colors duration-150',
                      on ? 'border-accent bg-accent text-bg-card' : 'border-line-strong bg-transparent',
                    ].join(' ')}
                  >
                    {on && <Check size={10} strokeWidth={3} />}
                  </span>
                  <span className={`text-ui ${on ? 'text-ink' : 'text-ink-faint line-through'}`}>
                    {MODEL_LABEL[tier]}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

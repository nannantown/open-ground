// ExecutionModeMenu — the ONE global switch that trades swarm capability ↔
// weekly-budget (card 68d8e00f), folded into a compact dropdown so it no longer
// occupies a full-width row of the Swarm header (mode changes are rare — an
// "options" affordance, not an always-on strip). Self-contained: reads
// /api/settings on mount and PATCHes executionMode on change (fire-and-forget,
// merged server-side, persisted), so it needs no prop-drilling through the deep
// ProjectPanel → SwarmModule tree. Every in-app swarm launch (worker / supply /
// commander) + the parallel cap read this mode server-side; a per-card override
// still wins via the Board 実行 button.
import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, SlidersHorizontal } from 'lucide-react'
import { EXECUTION_MODES, DEFAULT_EXECUTION_MODE, type ExecutionMode } from '@/lib/types'
import { useT } from '@/i18n/I18nContext'
import type { MessageKey } from '@/i18n/messages'

const asMode = (v: unknown): ExecutionMode =>
  typeof v === 'string' && (EXECUTION_MODES as readonly string[]).includes(v)
    ? (v as ExecutionMode)
    : DEFAULT_EXECUTION_MODE

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
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let alive = true
    fetch('/api/settings')
      .then((r) => r.json())
      .then((s) => {
        if (alive) setMode(asMode((s as { executionMode?: unknown })?.executionMode))
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
          'flex h-6 items-center gap-1 rounded-[4px] border px-2 text-[11px] transition-colors duration-150',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
          'disabled:cursor-not-allowed disabled:opacity-40',
          open
            ? 'border-line-strong bg-bg-inset text-ink'
            : 'border-line bg-transparent text-ink-muted enabled:hover:border-line-strong enabled:hover:bg-bg-inset enabled:hover:text-ink',
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
          room to spell them out). Selected row shows a check + accent name. */}
      {open && (
        <div
          role="menu"
          aria-label={t('projectPanel.swarm.mode.label')}
          className="absolute right-0 top-full z-30 mt-1 w-64 overflow-hidden rounded-[5px] border border-line bg-bg-card shadow-card"
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
                  active ? 'bg-bg-inset' : 'enabled:hover:bg-bg-inset',
                ].join(' ')}
              >
                <Check
                  size={12}
                  strokeWidth={2.5}
                  className={`mt-0.5 shrink-0 ${active ? 'text-accent' : 'invisible'}`}
                  aria-hidden
                />
                <span className="min-w-0">
                  <span className={`block text-[12px] font-medium ${active ? 'text-accent' : 'text-ink'}`}>
                    {t(LABEL_KEY[m])}
                  </span>
                  <span className="block text-[10.5px] leading-snug text-ink-subtle">
                    {t(HINT_KEY[m])}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

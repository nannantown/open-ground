// ExecutionModeToggle — the ONE global switch that trades swarm capability ↔
// weekly-budget (card 68d8e00f). Self-contained: reads /api/settings on mount and
// PATCHes executionMode on change (fire-and-forget, merged server-side, persisted),
// so it needs no prop-drilling through the deep ProjectPanel → SwarmModule tree.
// Every in-app swarm launch (worker / supply / commander) + the parallel cap read
// this mode server-side; a per-card override still wins via the Board 実行 button.
import { useEffect, useState } from 'react'
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

export const ExecutionModeToggle = () => {
  const { t } = useT()
  const [mode, setMode] = useState<ExecutionMode>(DEFAULT_EXECUTION_MODE)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    fetch('/api/settings')
      .then((r) => r.json())
      .then((s) => {
        if (alive) setMode(asMode((s as { executionMode?: unknown })?.executionMode))
      })
      .catch(() => {
        /* offline / server not up — the toggle still works, defaults to optimize */
      })
    return () => {
      alive = false
    }
  }, [])

  const change = (m: ExecutionMode) => {
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
    <div className="flex shrink-0 items-center gap-2 border-b border-line-soft bg-bg px-3 py-1.5">
      <span className="shrink-0 text-[11px] text-ink-muted">{t('projectPanel.swarm.mode.label')}</span>
      <div
        role="radiogroup"
        aria-label={t('projectPanel.swarm.mode.label')}
        className="inline-flex items-center gap-0.5 rounded-[6px] border border-line-soft p-0.5"
      >
        {EXECUTION_MODES.map((m) => {
          const active = mode === m
          return (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={busy}
              onClick={() => change(m)}
              title={t(HINT_KEY[m])}
              className={[
                'rounded-[4px] px-2 py-0.5 text-[11px] font-medium transition-colors duration-150',
                'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
                'disabled:cursor-not-allowed disabled:opacity-50',
                active
                  ? 'bg-accent text-bg-card'
                  : 'text-ink-muted enabled:hover:bg-line-soft enabled:hover:text-ink',
              ].join(' ')}
            >
              {t(LABEL_KEY[m])}
            </button>
          )
        })}
      </div>
    </div>
  )
}

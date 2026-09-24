// SwarmAllowedModelsSetting — 使用可能モデル (Settings.swarmAllowedModels): the
// owner's permanent per-tier ON/OFF mask for every agent-team launch. It used to
// ride the execution-mode dropdown on the team's bottom bar; that menu was
// removed (owner 2026-09-24 — the mode is changed by asking the president), and
// the mask moved here, to the Settings screen, because it is a standing setting
// rather than a moment-to-moment control.
//
// Self-contained: reads /api/settings on mount and POSTs the FULL mask on change
// (store.setUserSettings allowlists `swarmAllowedModels`). Server-side, every
// claude spawn path resolves through the same mask
// (src/lib/server/swarmAllowedModels.ts) — an OFF tier is unreachable.
import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import {
  DEFAULT_SWARM_ALLOWED_MODELS,
  SWARM_MODEL_TIERS,
  type SwarmAllowedModels,
  type SwarmModelTier,
} from '@/lib/types'
import { useT } from '@/i18n/I18nContext'

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
 *  "Fable 5"): the alias is what the team passes to `claude --model`, and a
 *  version baked into copy goes stale the moment the alias points at a new one. */
const MODEL_LABEL: Record<SwarmModelTier, string> = {
  fable: 'Fable',
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
}

export const SwarmAllowedModelsSetting = () => {
  const { t } = useT()
  const [allowed, setAllowed] = useState<SwarmAllowedModels>({ ...DEFAULT_SWARM_ALLOWED_MODELS })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    fetch('/api/settings')
      .then((r) => r.json())
      .then((s) => {
        if (alive) setAllowed(asAllowed((s as { swarmAllowedModels?: unknown })?.swarmAllowedModels))
      })
      .catch(() => {
        /* offline / server not up — show the default (all on) */
      })
    return () => {
      alive = false
    }
  }, [])

  // The LAST tier on can't be turned off: an all-OFF mask can only park the
  // team, and the server refuses it too (store.setUserSettings).
  const onCount = SWARM_MODEL_TIERS.filter((tier) => allowed[tier]).length

  const toggleTier = (tier: SwarmModelTier) => {
    if (busy) return
    if (allowed[tier] && onCount <= 1) return
    const next: SwarmAllowedModels = { ...allowed, [tier]: !allowed[tier] }
    const prev = allowed
    setAllowed(next) // optimistic
    setBusy(true)
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ swarmAllowedModels: next }),
    })
      // A mask that did not persist must not KEEP showing as persisted: the
      // engine would still spawn on the tier the row claims is off.
      .then((r) => {
        if (!r.ok) setAllowed(prev)
      })
      .catch(() => setAllowed(prev))
      .finally(() => setBusy(false))
  }

  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={t('projectPanel.swarm.models.label')}>
      {SWARM_MODEL_TIERS.map((tier) => {
        const on = allowed[tier]
        const isLastOn = on && onCount <= 1
        return (
          <button
            key={tier}
            type="button"
            role="checkbox"
            aria-checked={on}
            disabled={busy || isLastOn}
            onClick={() => toggleTier(tier)}
            title={isLastOn ? t('projectPanel.swarm.models.last') : undefined}
            className={[
              'inline-flex items-center gap-2 rounded-[3px] border border-line px-2.5 py-1.5 text-left transition-colors duration-150',
              'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
              'disabled:cursor-not-allowed disabled:opacity-50',
              'enabled:hover:border-line-strong enabled:hover:bg-plane enabled:active:bg-line-soft',
            ].join(' ')}
          >
            <span
              aria-hidden
              className={[
                'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border transition-colors duration-150',
                on ? 'border-accent bg-accent text-bg-card' : 'border-line-strong bg-transparent',
              ].join(' ')}
            >
              {on && <Check size={10} strokeWidth={3} />}
            </span>
            <span className={`text-ui ${on ? 'text-ink' : 'text-ink-faint line-through'}`}>{MODEL_LABEL[tier]}</span>
          </button>
        )
      })}
    </div>
  )
}

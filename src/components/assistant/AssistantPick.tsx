// The assistant's model and effort pick (owner 2026-11-01): auto, or one model
// the usable-models mask allows / one effort. Stored in settings.json
// (assistantModel / assistantEffort) — the session runs on this Mac, so the
// iPhone's talk follows the same pick. A picked model the mask turns off reads
// as auto, here and on the server (assistantSession.assistantModels).
import { useCallback, useState } from 'react'
import { useT } from '@/i18n/I18nContext'
import { CLAUDE_EFFORTS, SWARM_MODEL_TIERS, type ClaudeEffort, type SwarmModelTier } from '@/lib/types'

const MODEL_LABEL: Record<SwarmModelTier, string> = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' }

interface Pick {
  model?: SwarmModelTier
  effort?: ClaudeEffort
  /** The tiers the usable-models mask allows. */
  usable: SwarmModelTier[]
}

export const useAssistantPick = () => {
  const [pick, setPick] = useState<Pick>({ usable: [...SWARM_MODEL_TIERS] })
  const load = useCallback(async () => {
    try {
      const s = (await (await fetch('/api/settings')).json()) as { assistantModel?: string; assistantEffort?: string; swarmAllowedModels?: Record<string, unknown> }
      const usable = SWARM_MODEL_TIERS.filter((t) => s.swarmAllowedModels?.[t] !== false)
      const model = usable.find((t) => t === s.assistantModel)
      const effort = CLAUDE_EFFORTS.find((e) => e === s.assistantEffort)
      setPick({ model, effort, usable })
    } catch {
      /* server not up: auto is shown */
    }
  }, [])
  const save = async (patch: { model?: SwarmModelTier | null; effort?: ClaudeEffort | null }) => {
    const prev = pick
    const next = { ...pick, ...('model' in patch ? { model: patch.model ?? undefined } : {}), ...('effort' in patch ? { effort: patch.effort ?? undefined } : {}) }
    setPick(next)
    const body = { ...('model' in patch ? { assistantModel: patch.model } : {}), ...('effort' in patch ? { assistantEffort: patch.effort } : {}) }
    const ok = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then((r) => r.ok)
      .catch(() => false)
    // Not saved: never show it as picked.
    if (!ok) setPick(prev)
  }
  return { pick, load, save }
}

export const modelLabel = (m?: SwarmModelTier) => (m ? MODEL_LABEL[m] : null)

export const AssistantPickRows = ({ pick, save, focusRing }: { pick: Pick; save: ReturnType<typeof useAssistantPick>['save']; focusRing: string }) => {
  const { t } = useT()
  const pill = `rounded-full border border-line-strong px-2 py-0.5 text-ui text-ink-muted transition-colors duration-150 hover:border-ink-subtle hover:bg-plane hover:text-ink active:bg-line aria-pressed:border-ink aria-pressed:bg-ink aria-pressed:text-bg aria-pressed:hover:bg-ink-muted ${focusRing}`
  return (
    <div className="flex flex-col gap-1.5" data-testid="assistant-pick">
      <div role="group" aria-label={t('misc.assistant.model')} title={t('misc.assistant.model')} className="flex flex-wrap items-center gap-1">
        <button type="button" aria-pressed={!pick.model} onClick={() => void save({ model: null })} className={pill}>
          {t('misc.assistant.auto')}
        </button>
        {pick.usable.map((m) => (
          <button key={m} type="button" aria-pressed={pick.model === m} onClick={() => void save({ model: m })} className={pill}>
            {MODEL_LABEL[m]}
          </button>
        ))}
      </div>
      <div role="group" aria-label={t('misc.assistant.effort')} title={t('misc.assistant.effort')} className="flex flex-wrap items-center gap-1">
        <button type="button" aria-pressed={!pick.effort} onClick={() => void save({ effort: null })} className={pill}>
          {t('misc.assistant.auto')}
        </button>
        {CLAUDE_EFFORTS.map((e) => (
          <button key={e} type="button" aria-pressed={pick.effort === e} onClick={() => void save({ effort: e })} className={pill}>
            {e}
          </button>
        ))}
      </div>
    </div>
  )
}

// The assistant's model and effort pick (owner 2026-11-01): auto, or one model
// the usable-models mask allows / one effort. Stored in settings.json
// (assistantModel / assistantEffort) — the session runs on this Mac, so the
// iPhone's talk follows the same pick. A picked model the mask turns off reads
// as auto, here and on the server (assistantSession.assistantModels).
import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '@/i18n/I18nContext'
import { CHATGPT_EFFORTS, CLAUDE_EFFORTS, SWARM_MODEL_TIERS, type AiProvider, type ChatGptEffort, type ChatGptModel, type ChatGptStatus, type ClaudeEffort, type Settings, type RuntimeTransitionStatus, type SwarmModelTier } from '@/lib/types'
import { actOnRuntimeTransition, requestChatGptPreferences } from '@/lib/useChatGptConnection'
import { AiProviderPick, RuntimeTransitionRows } from '@/components/canvas/ChatGptSetting'

const MODEL_LABEL: Record<SwarmModelTier, string> = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' }

interface Pick {
  runtime?: RuntimeTransitionStatus
  transition?: (action: 'retry' | 'cancel') => void
  provider?: AiProvider
  chatgptModel?: string
  chatgptEffort?: ChatGptEffort
  chatgptModels?: ChatGptModel[]
  chatgptAvailable?: boolean
  owner?: boolean
  model?: SwarmModelTier
  effort?: ClaudeEffort
  /** The tiers the usable-models mask allows. */
  usable: SwarmModelTier[]
}

export const useAssistantPick = (chatgptEligible: boolean) => {
  const owner = useRef(chatgptEligible)
  owner.current = chatgptEligible
  const readSeq = useRef(0)
  const [pick, setPick] = useState<Pick>({ usable: [...SWARM_MODEL_TIERS] })
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const load = useCallback(async () => {
    const sequence = ++readSeq.current
    try {
      const s = (await (await fetch('/api/settings')).json()) as Settings
      if (sequence !== readSeq.current) return
      const usable = SWARM_MODEL_TIERS.filter((t) => s.swarmAllowedModels?.[t] !== false)
      const model = usable.find((t) => t === s.assistantModel)
      const effort = CLAUDE_EFFORTS.find((e) => e === s.assistantEffort)
      setPick(current => ({ ...current, model, effort, usable, provider: current.runtime?.desired.provider ?? s.assistantProvider, chatgptModel: s.chatgptModel, chatgptEffort: s.chatgptEffort }))
      // Local assistant permission does not authorize the ChatGPT account.
      if (!chatgptEligible || !owner.current) return
      const response = await fetch('/api/chatgpt/status', { cache: 'no-store' })
      if (response.ok && owner.current && sequence === readSeq.current) {
        const status = await response.json() as ChatGptStatus
        if (status.connection && Array.isArray(status.connection.models)) setPick((current) => ({ ...current, runtime: status.runtime?.assistant, provider: status.runtime?.assistant.desired.provider ?? status.preferences.assistantProvider, owner: true, chatgptAvailable: !status.lockdown && status.connection.state === 'connected', chatgptModels: status.connection.models }))
      }
    } catch {
      /* server not up: auto is shown */
    }
  }, [chatgptEligible])
  useEffect(() => {
    if (!chatgptEligible) return
    const changed = () => void load()
    window.addEventListener('openground:chatgpt-change', changed)
    const timer = pick.runtime && pick.runtime.phase !== 'stable' ? setInterval(changed, 2000) : undefined
    return () => { window.removeEventListener('openground:chatgpt-change', changed); clearInterval(timer) }
  }, [chatgptEligible, load, pick.runtime])
  const transition = async (action: 'retry' | 'cancel') => {
    if (!pick.runtime || busy) return
    setBusy(true); setFailed(false)
    try { await actOnRuntimeTransition(action, 'assistant', pick.runtime.revision); await load() } catch { setFailed(true) } finally { setBusy(false) }
  }
  const save = async (patch: { model?: SwarmModelTier | null; effort?: ClaudeEffort | null; provider?: AiProvider; chatgptModel?: string | null; chatgptEffort?: ChatGptEffort | null }) => {
    if (busy) return
    const prev = pick
    const next = { ...pick, ...('model' in patch ? { model: patch.model ?? undefined } : {}), ...('effort' in patch ? { effort: patch.effort ?? undefined } : {}), ...('provider' in patch ? { provider: patch.provider } : {}), ...('chatgptModel' in patch ? { chatgptModel: patch.chatgptModel ?? undefined } : {}), ...('chatgptEffort' in patch ? { chatgptEffort: patch.chatgptEffort ?? undefined } : {}) }
    setPick(next); setBusy(true); setFailed(false)
    try {
      if ('provider' in patch || 'chatgptModel' in patch || 'chatgptEffort' in patch) {
        const { preferences, runtime } = await requestChatGptPreferences({
          ...('provider' in patch ? { assistantProvider: patch.provider } : {}),
          ...('chatgptModel' in patch ? { chatgptModel: patch.chatgptModel } : {}),
          ...('chatgptEffort' in patch ? { chatgptEffort: patch.chatgptEffort } : {}),
        })
        setPick((current) => ({ ...current, runtime: runtime?.assistant, provider: runtime?.assistant.desired.provider ?? preferences.assistantProvider, chatgptModel: preferences.chatgptModel, chatgptEffort: preferences.chatgptEffort }))
      } else {
        const body = { ...('model' in patch ? { assistantModel: patch.model } : {}), ...('effort' in patch ? { assistantEffort: patch.effort } : {}) }
        const response = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        if (!response.ok) throw new Error('not saved')
      }
    } catch { setPick(prev); setFailed(true) } finally { setBusy(false) }
  }
  return { pick: chatgptEligible ? { ...pick, transition } : { ...pick, runtime: undefined, owner: false, chatgptAvailable: false, chatgptModels: undefined }, load, save, busy, failed }

}

export const modelLabel = (m?: SwarmModelTier) => (m ? MODEL_LABEL[m] : null)

export const AssistantPickRows = ({ pick, save, focusRing, busy = false, failed = false }: { pick: Pick; save: ReturnType<typeof useAssistantPick>['save']; focusRing: string; busy?: boolean; failed?: boolean }) => {
  const { t } = useT()
  const pill = `rounded-full border border-line-strong px-2 py-0.5 text-ui text-ink-muted transition-colors duration-150 enabled:hover:border-ink-subtle enabled:hover:bg-plane enabled:hover:text-ink enabled:active:bg-line enabled:active:text-ink aria-pressed:border-ink aria-pressed:bg-ink aria-pressed:text-bg aria-pressed:enabled:hover:bg-ink-muted disabled:opacity-40 disabled:cursor-not-allowed ${focusRing}`
  const actionBusy = busy
  const changing = !!pick.runtime && pick.runtime.phase !== 'stable'
  busy ||= changing
  const chatgpt = pick.provider === 'chatgpt'
  const pickedModel = pick.chatgptModels?.find((m) => m.id === pick.chatgptModel)
  const efforts = CHATGPT_EFFORTS.filter((e) => !pickedModel?.supportedEfforts || pickedModel.supportedEfforts.includes(e))
  return (
    <div className="flex flex-col gap-1.5" data-testid="assistant-pick">
      {pick.owner && <AiProviderPick label={t('settings.chatgpt.assistant')} value={pick.provider} disabled={busy} chatgptAvailable={pick.chatgptAvailable === true} onChange={(provider) => void save({ provider })} />}
      <RuntimeTransitionRows runtime={pick.runtime} busy={actionBusy} onAction={action => pick.transition?.(action)} />
      {failed && <span role="alert" className="text-meta text-accent">{t('settings.chatgpt.failed')}</span>}
      {chatgpt ? <>
        <div role="group" aria-label={t('misc.assistant.model')} className="flex flex-wrap gap-1">
          <select aria-label={t('misc.assistant.model')} value={pick.chatgptModel ?? ''} disabled={busy || !pick.chatgptAvailable} onChange={(e) => void save({ chatgptModel: e.target.value || null })} className={`min-w-0 max-w-full rounded-[3px] border border-line-strong bg-bg px-2 py-1 text-ui text-ink transition-colors duration-150 enabled:hover:bg-plane enabled:active:bg-line enabled:active:text-ink disabled:opacity-40 disabled:cursor-not-allowed ${focusRing}`}>
            <option value="">{t('misc.assistant.auto')}</option>
            {pick.chatgptModel && !pickedModel && <option value={pick.chatgptModel} disabled>{pick.chatgptModel}</option>}
            {pick.chatgptModels?.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </div>
        <div role="group" aria-label={t('misc.assistant.effort')} className="flex flex-wrap gap-1">
          <button type="button" disabled={busy || !pick.chatgptAvailable} aria-pressed={!pick.chatgptEffort} onClick={() => void save({ chatgptEffort: null })} className={pill}>{t('misc.assistant.auto')}</button>
          {efforts.map((e) => <button key={e} type="button" disabled={busy || !pick.chatgptAvailable} aria-pressed={pick.chatgptEffort === e} onClick={() => void save({ chatgptEffort: e })} className={pill}>{e}</button>)}
        </div>
      </> : <>
      <div role="group" aria-label={t('misc.assistant.model')} title={t('misc.assistant.model')} className="flex flex-wrap items-center gap-1">
        <button type="button" disabled={busy} aria-pressed={!pick.model} onClick={() => void save({ model: null })} className={pill}>
          {t('misc.assistant.auto')}
        </button>
        {pick.usable.map((m) => (
          <button key={m} type="button" disabled={busy} aria-pressed={pick.model === m} onClick={() => void save({ model: m })} className={pill}>
            {MODEL_LABEL[m]}
          </button>
        ))}
      </div>
      <div role="group" aria-label={t('misc.assistant.effort')} title={t('misc.assistant.effort')} className="flex flex-wrap items-center gap-1">
        <button type="button" disabled={busy} aria-pressed={!pick.effort} onClick={() => void save({ effort: null })} className={pill}>
          {t('misc.assistant.auto')}
        </button>
        {CLAUDE_EFFORTS.map((e) => (
          <button key={e} type="button" disabled={busy} aria-pressed={pick.effort === e} onClick={() => void save({ effort: e })} className={pill}>
            {e}
          </button>
        ))}
      </div>
      </>}
    </div>
  )
}

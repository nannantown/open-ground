import { ConversationRecoverySetting } from './ConversationRecoverySetting'
import { useEffect, useState } from 'react'
import { Check, ChevronRight, Loader2 } from 'lucide-react'
import { Btn } from '@/components/ui/Btn'
import { useT } from '@/i18n/I18nContext'
import { CHATGPT_EFFORTS, type AiProvider, type ChatGptStatus, type RuntimeTransitionStatus } from '@/lib/types'
import { actOnRuntimeTransition, refreshChatGptConnection, requestChatGptPreferences, useChatGptConnection, type ChatGptPreferencePatch } from '@/lib/useChatGptConnection'

const pickClass = 'rounded-[3px] border border-line-strong bg-transparent px-2.5 py-1.5 text-ui text-ink-muted transition-colors duration-150 enabled:hover:bg-plane enabled:hover:text-ink enabled:active:bg-line enabled:active:text-ink aria-pressed:bg-ink aria-pressed:text-bg aria-pressed:enabled:hover:bg-ink-muted disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
const selectClass = 'min-w-0 rounded-[3px] border border-line-strong bg-bg px-2 py-1.5 text-ui text-ink transition-colors duration-150 enabled:hover:bg-plane enabled:active:bg-line enabled:active:text-ink disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'

export const AiProviderPick = ({ label, value, disabled, chatgptAvailable, onChange }: { label: string; value?: AiProvider; disabled: boolean; chatgptAvailable: boolean; onChange: (provider: AiProvider) => void }) => (
  <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1.5">
    {(['claude', 'chatgpt'] as const).map((provider) => (
      <button key={provider} type="button" disabled={disabled || (provider === 'chatgpt' && !chatgptAvailable)} aria-pressed={(value ?? 'claude') === provider} onClick={() => onChange(provider)} className={pickClass}>
        {provider === 'claude' ? 'Claude' : 'ChatGPT'}
      </button>
    ))}
  </div>
)

/** Settings show the requested pick separately from the actor still running. */
export const RuntimeTransitionRows = ({ runtime, busy, onAction }: { runtime?: RuntimeTransitionStatus; busy: boolean; onAction: (action: 'retry' | 'cancel') => void }) => {
  const { t } = useT()
  if (!runtime) return null
  const label = (profile: RuntimeTransitionStatus['effective']) => [profile.provider === 'chatgpt' ? 'ChatGPT' : 'Claude', profile.model, profile.effort].filter(Boolean).join(' · ')
  const pending = runtime.phase !== 'stable'
  return <div className="flex flex-wrap items-center gap-2 text-meta" data-runtime-phase={runtime.phase}>
    <span role="status" className={runtime.phase === 'attention' ? 'text-accent' : pending ? 'text-status-run' : 'text-ink-muted'}>
      {t('settings.runtime.current')} {label(runtime.effective)}
      {pending && <><ChevronRight size={12} className="mx-1 inline" aria-hidden />{label(runtime.desired)} · {t(`settings.runtime.${runtime.phase}`)}</>}
    </span>
    {runtime.phase === 'attention' && runtime.error && <span className="text-accent">{runtime.error}</span>}
    {runtime.phase === 'attention' && <Btn size="xs" disabled={busy} onClick={() => onAction('retry')}>{t('settings.runtime.retry')}</Btn>}
    {runtime.phase === 'attention' && <Btn size="xs" disabled={busy} onClick={() => onAction('cancel')}>{t('settings.runtime.cancel')}</Btn>}
  </div>
}

/** Only the official authorize endpoint is ever handed to the desktop bridge. */
export const chatGptAuthorizationUrl = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null
  try {
    const u = new URL(raw)
    return u.origin === 'https://auth.openai.com' && !u.username && !u.password && u.pathname === '/api/accounts/authorize' ? u.href : null
  } catch { return null }
}

export const ChatGptSetting = ({ enabled, lockdown }: { enabled: boolean; lockdown: boolean }) => {
  const { t } = useT()
  const { status, eligible, error: readError, loading, refresh } = useChatGptConnection(enabled)
  const [prefs, setPrefs] = useState<ChatGptStatus['preferences']>({})
  const [runtime, setRuntime] = useState<ChatGptStatus['runtime']>()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [login, setLogin] = useState<{ authorizationUrl: string; loginId: string } | null>(null)
  useEffect(() => { if (status) { setPrefs(status.preferences); setRuntime(current => {
    if (!status.runtime) return current
    if (!current) return status.runtime
    const newest = (scope: 'assistant' | 'swarm') => current[scope].revision > status.runtime![scope].revision || (current[scope].revision === status.runtime![scope].revision && current[scope].updatedAt > status.runtime![scope].updatedAt) ? current[scope] : status.runtime![scope]
    return { assistant: newest('assistant'), swarm: newest('swarm') }
  }) } }, [status])
  useEffect(() => { if (status?.connection.state === 'connected') setLogin(null) }, [status?.connection.state])
  if (eligible !== true) return null
  const blocked = lockdown || status?.lockdown === true
  const connection = status?.connection
  const available = !blocked && connection?.state === 'connected'
  const models = connection?.models ?? []
  const model = models.find((m) => m.id === prefs.chatgptModel)
  const efforts = CHATGPT_EFFORTS.filter((effort) => !model?.supportedEfforts || model.supportedEfforts.includes(effort))
  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setFailed(false)
    try { await action() } catch { setFailed(true) } finally { setBusy(false); refreshChatGptConnection() }
  }
  const save = (patch: ChatGptPreferencePatch) => void run(async () => {
    const prev = prefs
    setPrefs({ ...prefs, ...Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value ?? undefined])) })
    try { const result = await requestChatGptPreferences(patch); setPrefs(result.preferences); setRuntime(result.runtime) } catch (e) { setPrefs(prev); throw e }
  })
  const post = async (path: string, body?: object) => {
    const r = await fetch(`/api/chatgpt/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    if (!r.ok) throw new Error('request failed')
    return r.json() as Promise<Record<string, unknown>>
  }
  const connect = () => void run(async () => {
    const result = await post('login')
    const url = chatGptAuthorizationUrl(result.authorizationUrl)
    if (!url || typeof result.loginId !== 'string') throw new Error('invalid authorize URL')
    setLogin({ authorizationUrl: url, loginId: result.loginId })
    const bridge = (window as unknown as { openground?: { openExternal?: (url: string) => Promise<unknown> } }).openground
    if (bridge?.openExternal && await bridge.openExternal(url) === false) throw new Error('browser did not open')
  })
  return (
    <section className="mt-6 border-t border-line pt-4" aria-label="ChatGPT">
      <div className="flex items-center justify-between gap-3">
        <h3 className="label-cap label-cap-latin text-ink">ChatGPT</h3>
        <Btn size="xs" onClick={refresh} disabled={busy || loading}>{t('settings.connection.recheck')}</Btn>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-ui text-ink-muted">
        {connection?.state === 'connected' && <span className="inline-flex items-center gap-1 text-status-done"><Check size={12} />{connection.email ?? t('settings.connection.connected')}</span>}
        {connection?.state === 'connecting' && <span className="inline-flex items-center gap-1 text-status-run"><Loader2 size={12} className="animate-spin" />{t('settings.chatgpt.connecting')}</span>}
        {connection?.state !== 'connected' && connection?.state !== 'connecting' && <Btn size="xs" onClick={connect} disabled={busy || blocked}>{t('settings.chatgpt.connect')}</Btn>}
        {connection?.state === 'connected' && <Btn size="xs" disabled={busy} onClick={() => void run(async () => { await post('disconnect'); setLogin(null) })}>{t('settings.chatgpt.disconnect')}</Btn>}
        {(login || connection?.state === 'connecting') && <Btn size="xs" disabled={busy} onClick={() => void run(async () => { await post('cancel', { loginId: login?.loginId }); setLogin(null) })}>{t('settings.chatgpt.cancel')}</Btn>}
        {login && !blocked && <a href={login.authorizationUrl} target="_blank" rel="noopener noreferrer" className={`${pickClass} inline-flex`}>{t('settings.chatgpt.openBrowser')}</a>}
      </div>
      {blocked && <p className="mt-2 text-meta text-ink-muted">{t('settings.chatgpt.workMode')}</p>}
      {(failed || readError || (connection?.state === 'error' && !blocked)) && <p role="alert" className="mt-2 text-meta text-accent">{t('settings.chatgpt.failed')}</p>}
      <div className="mt-3 flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-ui text-ink-muted">{t('settings.chatgpt.assistant')}</span><AiProviderPick label={t('settings.chatgpt.assistant')} value={runtime?.assistant.desired.provider ?? prefs.assistantProvider} disabled={busy || !!runtime?.assistant && runtime.assistant.phase !== 'stable'} chatgptAvailable={available} onChange={(assistantProvider) => save({ assistantProvider })} /></div>
        <RuntimeTransitionRows runtime={runtime?.assistant} busy={busy} onAction={action => void run(() => actOnRuntimeTransition(action, 'assistant', runtime!.assistant.revision))} />
        <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-ui text-ink-muted">{t('settings.chatgpt.automation')}</span><AiProviderPick label={t('settings.chatgpt.automation')} value={runtime?.swarm.desired.provider ?? prefs.swarmProvider} disabled={busy || !!runtime?.swarm && runtime.swarm.phase !== 'stable'} chatgptAvailable={available} onChange={(swarmProvider) => save({ swarmProvider })} /></div>
        <RuntimeTransitionRows runtime={runtime?.swarm} busy={busy} onAction={action => void run(() => actOnRuntimeTransition(action, 'swarm', runtime!.swarm.revision))} />
        <p className="text-meta leading-relaxed text-ink-muted">{t('settings.chatgpt.scope')}</p>
        <div className="flex flex-wrap gap-3">
          <label className="flex min-w-0 flex-col gap-1 text-meta text-ink-muted">
            <span>{t('settings.chatgpt.model')}</span>
            <select value={prefs.chatgptModel ?? ''} disabled={busy || !available} className={selectClass} onChange={(e) => save({ chatgptModel: e.target.value || null })}>
              <option value="">{t('misc.assistant.auto')}</option>
              {prefs.chatgptModel && !model && <option value={prefs.chatgptModel} disabled>{prefs.chatgptModel}</option>}
              {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-meta text-ink-muted">
            <span>{t('settings.chatgpt.effort')}</span>
            <select value={prefs.chatgptEffort ?? ''} disabled={busy || !available} className={selectClass} onChange={(e) => save({ chatgptEffort: CHATGPT_EFFORTS.find((v) => v === e.target.value) ?? null })}>
              <option value="">{t('misc.assistant.auto')}</option>
              {efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
            </select>
          </label>
        </div>
        <p className="text-meta leading-relaxed text-ink-muted">{t('settings.chatgpt.appliesNext')}</p>
      </div>
      <ConversationRecoverySetting />
    </section>
  )
}

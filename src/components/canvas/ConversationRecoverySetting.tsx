import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { Btn } from '@/components/ui/Btn'
import { useT } from '@/i18n/I18nContext'
import { ConversationDraftOwnerContext } from '@/lib/useConversationDraft'
import { refreshChatGptConnection } from '@/lib/useChatGptConnection'
interface Issue { id: string; scope: string; kind: 'input' | 'tool' | 'conversation' | 'launch'; tool?: string; conversationId?: string; callId?: string; projectName?: string; projectPath?: string; state: 'uncertain' }
interface Review { id: string; scope: string; kind: Issue['kind']; conversationId?: string; callId?: string; note: string; operationId: string }
const key = (issue: Issue) => JSON.stringify([issue.id, issue.scope, issue.kind, issue.conversationId, issue.callId])

/** A review records the owner's inspection. It never retries an old command. */
export const ConversationRecoverySetting = () => {
  const { t } = useT()
  const owner = useContext(ConversationDraftOwnerContext)
  const ownerRef = useRef(owner); ownerRef.current = owner
  const storageKey = `openground:operation-review:${encodeURIComponent(owner ?? '')}`
  const [issues, setIssues] = useState<Issue[]>([])
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [attempts, setAttempts] = useState<Record<string, Review>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const headers = { 'Content-Type': 'application/json', ...(owner ? { 'X-OpenGround-Owner': owner } : {}) }
  const load = useCallback(async () => {
    if (!owner) return
    const response = await fetch('/api/conversation/recovery', { cache: 'no-store', headers: { 'X-OpenGround-Owner': owner } })
    if (!response.ok) throw new Error('recovery-unavailable')
    const body = await response.json() as { issues?: Issue[] }
    if (ownerRef.current === owner) setIssues(Array.isArray(body.issues) ? body.issues : [])
  }, [owner])
  useEffect(() => {
    setIssues([]); setAttempts({}); setNotes({}); setFailed(false)
    if (!owner) return
    try {
      const raw = localStorage.getItem(storageKey)
      if (raw && raw.length < 128_000) {
        const saved = JSON.parse(raw) as Record<string, Review>
        const valid = Object.fromEntries(Object.entries(saved).filter(([, review]) => typeof review.operationId === 'string' && typeof review.note === 'string' && review.note.length <= 1000))
        setAttempts(valid); setNotes(Object.fromEntries(Object.entries(valid).map(([id, review]) => [id, review.note])))
      }
    } catch { setFailed(true) }
    const refresh = () => void load().catch(() => setFailed(true))
    refresh()
    const timer = setInterval(refresh, 5000)
    return () => clearInterval(timer)
  }, [load, owner, storageKey])
  const review = async (issue: Issue) => {
    if (!owner || busy) return
    const id = key(issue)
    const note = notes[id]?.trim()
    if (!note) return
    const attempt = attempts[id] ?? { id: issue.id, scope: issue.scope, kind: issue.kind, ...(issue.conversationId ? { conversationId: issue.conversationId } : {}), ...(issue.callId ? { callId: issue.callId } : {}), note, operationId: crypto.randomUUID() }
    const next = { ...attempts, [id]: attempt }
    setBusy(id); setFailed(false)
    try {
      localStorage.setItem(storageKey, JSON.stringify(next)); setAttempts(next)
      const response = await fetch('/api/conversation/recovery/review', { method: 'POST', headers, body: JSON.stringify(attempt) })
      if (ownerRef.current !== owner) return
      if (!response.ok) throw new Error('review-unavailable')
      delete next[id]
      localStorage.setItem(storageKey, JSON.stringify(next)); setAttempts({ ...next })
      await load(); refreshChatGptConnection()
    } catch { if (ownerRef.current === owner) setFailed(true) } finally { if (ownerRef.current === owner) setBusy(null) }
  }
  if (!owner || (!issues.length && !failed)) return null
  return <section className="mt-4 flex flex-col gap-2 border-t border-line pt-3" aria-label={t('settings.recovery.title')}>
    <h4 className="text-ui font-medium text-ink">{t('settings.recovery.title')}</h4>
    <p className="text-meta text-ink-muted">{t('settings.recovery.description')}</p>
    {issues.map(issue => <div key={key(issue)} className="flex flex-col gap-1.5 rounded border border-line px-2 py-2">
      {issue.projectPath && <p className="break-all text-meta text-ink">{issue.projectName} · {issue.projectPath}</p>}
      <p className="break-all text-meta text-ink-muted">{issue.tool ?? issue.kind} · {issue.id}</p>
      <label className="flex flex-col gap-1 text-meta text-ink-muted">
        <span>{t('settings.recovery.note')}</span>
        <textarea rows={2} maxLength={1000} value={notes[key(issue)] ?? ''} readOnly={!!attempts[key(issue)] || busy === key(issue)} onChange={event => setNotes(current => ({ ...current, [key(issue)]: event.target.value }))}
          className="min-w-0 resize-y rounded border border-line bg-bg px-2 py-1 text-ui text-ink transition-colors hover:border-line-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40" />
      </label>
      <Btn size="xs" disabled={!!busy || !notes[key(issue)]?.trim()} onClick={() => void review(issue)}>{t(attempts[key(issue)] ? 'settings.recovery.retry' : 'settings.recovery.review')}</Btn>
    </div>)}
    {failed && <p role="status" className="text-meta text-accent">{t('settings.recovery.failed')}</p>}
    <div><Btn size="xs" disabled={!!busy} onClick={() => void load().then(() => setFailed(false), () => setFailed(true))}>{t('settings.connection.recheck')}</Btn></div>
  </section>
}

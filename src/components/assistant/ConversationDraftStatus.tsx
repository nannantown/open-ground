import { useState } from 'react'
import { Btn } from '@/components/ui/Btn'
import { useT } from '@/i18n/I18nContext'
import type { useConversationDraft } from '@/lib/useConversationDraft'

export const ConversationDraftStatus = ({ draft, excludeReceiptIds }: { draft?: ReturnType<typeof useConversationDraft>; excludeReceiptIds?: ReadonlySet<string> }) => {
  const { t } = useT()
  const [busy, setBusy] = useState(false)
  if (!draft?.enabled) return null
  const act = async (action: (() => Promise<unknown>) | undefined) => {
    if (!action || busy) return
    setBusy(true)
    try { await action() } catch { /* The controller retains the draft and exposes its state. */ } finally { setBusy(false) }
  }
  const error = draft.photoError || draft.error
  return <div className="flex flex-wrap items-center gap-1.5 text-micro text-ink-muted" aria-live="polite">
    <div className="max-h-24 w-full overflow-y-auto">{draft.receipts.filter(receipt => !excludeReceiptIds?.has(receipt.id) && !['delivered', 'completed', 'replied', 'rejected', 'cancelled'].includes(receipt.state)).map(receipt => <details key={receipt.id} className="max-w-full rounded border border-line px-1.5 py-1">
      <summary className="cursor-pointer rounded transition-colors hover:bg-plane hover:text-ink active:bg-line active:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">{t(receipt.state === 'uncertain' ? 'settings.assistant.uncertain' : receipt.state === 'queued' ? 'settings.assistant.queued' : receipt.state === 'running' || receipt.state === 'executing' ? 'settings.assistant.running' : 'settings.assistant.interrupted')}</summary>
      <p className="whitespace-pre-wrap break-words">{receipt.text}</p><p className="break-all">{receipt.id}</p>
    </details>)}</div>
    {(draft.saving || draft.photoSaving) && <span>{t('settings.draft.saving')}</span>}
    {error && <span role="status">{t(draft.attempt ? 'settings.draft.pending' : 'settings.draft.failed')}</span>}
    {error && <Btn size="xs" disabled={busy} onClick={() => void act(draft.attempt ? draft.recover : draft.flush)}>{t('settings.connection.recheck')}</Btn>}
    {draft.error === 'draft-conflict' && <>
      <Btn size="xs" disabled={busy} onClick={() => void act(() => draft.resolveConflict?.(true) ?? Promise.resolve())}>{t('settings.draft.keepLocal')}</Btn>
      <Btn size="xs" disabled={busy} onClick={() => void act(() => draft.resolveConflict?.(false) ?? Promise.resolve())}>{t('settings.draft.useSaved')}</Btn>
    </>}
  </div>
}

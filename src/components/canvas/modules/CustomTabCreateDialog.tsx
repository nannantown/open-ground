import { useRef, useState } from 'react'
import { Btn } from '@/components/ui/Btn'
import { useT } from '@/i18n/I18nContext'
import type { CustomModuleDef } from '@/lib/types'

// "+" → name + description → POST /api/custom-modules (owner-only; the server
// re-checks the role). Same full-panel overlay language as the panel's other
// dialogs (DeleteConfirm / UnshareConfirm).
//
// IME rules (the project's two ironclad input policies): the fields are
// UNCONTROLLED (refs) so no async parent round-trip can roll a composition
// back mid-conversion, and the only Enter shortcut is Cmd/Ctrl+Enter, which
// additionally ignores `e.nativeEvent.isComposing` so a conversion-commit
// Enter is never stolen. Plain Enter submits nothing (the textarea keeps it
// as a newline; the Create button / Cmd+Enter submit).

// Server-side limits from the contract (docs/CUSTOM_TABS_PLAN.md) — mirrored
// here so a too-long value fails before the POST.
const LABEL_MAX = 60
const DESCRIPTION_MAX = 4000

export const CustomTabCreateDialog = ({
  onCreated,
  onClose,
}: {
  /** Called with the fresh def; the parent refreshes the list, switches to
   *  the new tab and starts the sidebar/paste setup flow. */
  onCreated: (def: CustomModuleDef) => void
  onClose: () => void
}) => {
  const { t } = useT()
  const nameRef = useRef<HTMLInputElement>(null)
  const descRef = useRef<HTMLTextAreaElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    if (busy) return
    const label = (nameRef.current?.value ?? '').trim()
    const description = (descRef.current?.value ?? '').trim()
    if (!label || label.length > LABEL_MAX) {
      setError(t('customTabs.createNameRequired'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const r = await fetch('/api/custom-modules', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          label,
          description: description.slice(0, DESCRIPTION_MAX),
        }),
      })
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string }
        setError(
          t('customTabs.createFailed', {
            error: body.error ?? `HTTP ${r.status}`,
          }),
        )
        return
      }
      onCreated((await r.json()) as CustomModuleDef)
    } catch {
      setError(
        t('customTabs.createFailed', { error: t('projectPanel.networkError') }),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      data-esc-overlay
      className="absolute inset-0 z-20 flex flex-col justify-center gap-5 bg-bg-card px-6"
      onKeyDown={e => {
        // Cmd/Ctrl+Enter submits. isComposing guard: an Enter that commits an
        // IME conversion must never double as submit.
        if (
          e.key === 'Enter' &&
          (e.metaKey || e.ctrlKey) &&
          !e.nativeEvent.isComposing
        ) {
          e.preventDefault()
          void submit()
        }
      }}
    >
      <div className="mx-auto w-full max-w-[440px]">
        <p className="label-cap text-accent mb-2">{t('customTabs.createLabel')}</p>
        <h3 className="font-display text-[20px] leading-snug text-ink tracking-tightest">
          {t('customTabs.createTitle')}
        </h3>
        <p className="mt-2.5 text-[12px] leading-relaxed text-ink-muted">
          {t('customTabs.createExplain')}
        </p>
        <label className="label-cap text-ink-muted mb-1.5 mt-5 block">
          {t('customTabs.createName')}
        </label>
        <input
          ref={nameRef}
          autoFocus
          maxLength={LABEL_MAX}
          placeholder={t('customTabs.createNamePlaceholder')}
          disabled={busy}
          className="w-full rounded-[2px] border border-line bg-bg px-3 py-2 text-[12px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        />
        <label className="label-cap text-ink-muted mb-1.5 mt-4 block">
          {t('customTabs.createDescription')}
        </label>
        <textarea
          ref={descRef}
          rows={5}
          maxLength={DESCRIPTION_MAX}
          placeholder={t('customTabs.createDescriptionPlaceholder')}
          disabled={busy}
          className="w-full resize-y rounded-[2px] border border-line bg-bg px-3 py-2 text-[12px] leading-relaxed text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        />
        {error && (
          <p className="mt-3 text-[11px] leading-relaxed text-accent">{error}</p>
        )}
        <div className="mt-5 flex items-center justify-end gap-2">
          <Btn variant="subtle" size="md" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Btn>
          <Btn
            variant="primary"
            size="md"
            onClick={() => void submit()}
            disabled={busy}
          >
            {busy ? t('customTabs.creating') : t('customTabs.create')}
          </Btn>
        </div>
      </div>
    </div>
  )
}

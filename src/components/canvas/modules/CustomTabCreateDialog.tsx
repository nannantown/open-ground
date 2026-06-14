import { useRef, useState } from 'react'
import { Btn } from '@/components/ui/Btn'
import { useT } from '@/i18n/I18nContext'
import type { CustomModuleDef } from '@/lib/types'

// "+" → name + description → POST /api/custom-modules (owner-only; the server
// re-checks the role). Shares the register-language card shell with the picker
// (variant-A redesign): kicker → Fraunces title → rule-double → form →
// rule-double → footer, on the paper card with a corner registration tick.
//
// IME rules (the project's two ironclad input policies): the fields are
// UNCONTROLLED (refs) so no async parent round-trip can roll a composition
// back mid-conversion, and the only Enter shortcut is Cmd/Ctrl+Enter, which
// additionally ignores `e.nativeEvent.isComposing` so a conversion-commit
// Enter is never stolen. Plain Enter submits nothing (the textarea keeps it
// as a newline; the Create button / Cmd+Enter submit). The backdrop does NOT
// close on click here (unlike the picker) — a stray click must not discard a
// half-typed form; Cancel is the explicit exit.

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
      className="absolute inset-0 z-20 flex items-center justify-center overflow-y-auto bg-bg-card/70 px-6 py-8"
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
      <section
        role="dialog"
        aria-label={t('customTabs.createTitle')}
        className="relative w-full max-w-[480px] overflow-hidden rounded-[8px] border border-line bg-bg-card shadow-card-hover"
      >
        <header className="relative px-[30px] pb-[18px] pt-[26px]">
          <span
            aria-hidden
            className="pointer-events-none absolute right-4 top-[14px] h-[14px] w-[14px] border-r border-t border-line-strong opacity-70"
          />
          <p className="label-cap mb-3 text-accent">{t('customTabs.createLabel')}</p>
          <h3 className="font-display text-[23px] font-medium leading-[1.12] tracking-tightest text-ink">
            {t('customTabs.createTitle')}
          </h3>
          <p className="mt-[9px] max-w-[44ch] text-[12px] leading-[1.55] text-ink-muted">
            {t('customTabs.createExplain')}
          </p>
        </header>

        <div className="rule-double" aria-hidden />

        <div className="px-[30px] py-5">
          <label className="label-cap mb-1.5 block text-ink-muted">
            {t('customTabs.createName')}
          </label>
          <input
            ref={nameRef}
            autoFocus
            maxLength={LABEL_MAX}
            placeholder={t('customTabs.createNamePlaceholder')}
            disabled={busy}
            className="w-full rounded-[3px] border border-line bg-bg px-3 py-2 text-[12px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          />
          <label className="label-cap mb-1.5 mt-4 block text-ink-muted">
            {t('customTabs.createDescription')}
          </label>
          <textarea
            ref={descRef}
            rows={5}
            maxLength={DESCRIPTION_MAX}
            placeholder={t('customTabs.createDescriptionPlaceholder')}
            disabled={busy}
            className="w-full resize-y rounded-[3px] border border-line bg-bg px-3 py-2 text-[12px] leading-relaxed text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          />
          {error && (
            <p className="mt-3 text-[11px] leading-relaxed text-accent">{error}</p>
          )}
        </div>

        <div className="rule-double" aria-hidden />

        <footer className="flex items-center justify-end gap-2 px-[30px] pb-[17px] pt-[15px]">
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
        </footer>
      </section>
    </div>
  )
}

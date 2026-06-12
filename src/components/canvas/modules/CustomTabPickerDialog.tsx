import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { Btn } from '@/components/ui/Btn'
import { useT } from '@/i18n/I18nContext'
import type { CustomModuleDef, CustomTabRole } from '@/lib/types'

// "+" → the per-project tab picker (docs/CUSTOM_TABS_PLAN.md — "Per-project
// attachment & the '+' picker"). Lists MY library: clicking an unattached
// module attaches it to the CURRENT project (the parent persists
// ProjectData.customTabs and switches the view); already-attached rows are
// inert and marked. The picker is also the only place for LIBRARY-LEVEL
// destruction (owner: delete any module; tester: uninstall installed ones) —
// two-step confirm inline, then the parent runs the server DELETE + PTY
// teardown and refreshes the list (this dialog stays open, the row vanishes
// via props). The 「新規タブを作成」 command hands off to the existing create
// dialog. Escape and a backdrop click both dismiss.

/** What library-level destruction (if any) the role offers for a module —
 *  cosmetic only, the server re-checks the role on DELETE. */
export const moduleRemoveKind = (
  role: CustomTabRole,
  mod: Pick<CustomModuleDef, 'origin'>,
): 'delete' | 'uninstall' | null => {
  if (role === 'owner') return 'delete'
  if (role === 'tester' && mod.origin === 'installed') return 'uninstall'
  return null
}

export const CustomTabPickerDialog = ({
  modules,
  role,
  attachedIds,
  onAttach,
  onCreateNew,
  onDelete,
  onClose,
}: {
  /** The caller's full library (useCustomModules order). */
  modules: CustomModuleDef[]
  role: CustomTabRole
  /** Module ids already attached to the current project. */
  attachedIds: ReadonlySet<string>
  /** Attach to the current project — the parent persists, switches the view
   *  to the new tab and closes the picker. */
  onAttach: (moduleId: string) => void
  /** Open the create dialog (owner only; the parent closes the picker). */
  onCreateNew?: () => void
  /** Library-level delete/uninstall, AFTER the in-dialog confirm: server
   *  DELETE + killEmbeddedTerminals + list refresh live in the parent. */
  onDelete: (moduleId: string) => Promise<void> | void
  onClose: () => void
}) => {
  const { t } = useT()
  // Two-step confirm: the module id whose remove button is armed.
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  // The module id whose DELETE is in flight (disables both of its buttons).
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // ESC dismisses (same pattern as the panel's settings dialog): skip an
  // Escape that cancels an IME composition or one already consumed, and
  // preventDefault so App's global Escape handler doesn't also act on it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const remove = async (moduleId: string) => {
    if (deletingId) return
    setDeletingId(moduleId)
    try {
      await onDelete(moduleId)
    } finally {
      setDeletingId(null)
      setConfirmingId(null)
    }
  }

  // The 「新規タブを作成」 command row (owner only) — rendered both in the
  // populated list (as the trailing row) and as the sole action of the empty
  // state.
  const createRow = onCreateNew && (
    <button
      type="button"
      onClick={onCreateNew}
      className="flex w-full items-center gap-2 rounded-[4px] border border-dashed border-line px-3 py-2.5 text-left text-[12px] text-ink-muted transition-colors hover:border-line hover:bg-bg-inset hover:text-ink active:bg-bg-inset active:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <Plus size={13} strokeWidth={2} className="shrink-0" />
      {t('customTabs.pickerCreateNew')}
    </button>
  )

  return (
    // Semi-opaque backdrop over the panel: a click anywhere outside the card
    // dismisses (mousedown, so a drag that starts inside doesn't close).
    <div
      data-esc-overlay
      className="absolute inset-0 z-20 flex items-center justify-center bg-bg-card/70 px-6"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-label={t('customTabs.pickerTitle')}
        className="w-full max-w-[480px] rounded-[4px] border border-line bg-bg-card p-5 shadow-card-hover"
        onMouseDown={e => e.stopPropagation()}
      >
        <p className="label-cap text-accent mb-2">{t('customTabs.pickerLabel')}</p>
        <h3 className="font-display text-[20px] leading-snug text-ink tracking-tightest">
          {t('customTabs.pickerTitle')}
        </h3>
        <p className="mt-2.5 text-[12px] leading-relaxed text-ink-muted">
          {t('customTabs.pickerExplain')}
        </p>
        <div className="mt-4 max-h-[50vh] space-y-2 overflow-y-auto pr-1">
          {modules.length === 0 ? (
            <p className="py-1 text-[12px] text-ink-subtle">
              {t('customTabs.pickerEmpty')}
            </p>
          ) : (
            modules.map(m => {
              const attached = attachedIds.has(m.id)
              const kind = moduleRemoveKind(role, m)
              const confirming = confirmingId === m.id
              const deleting = deletingId === m.id
              return (
                <div key={m.id} className="flex items-stretch gap-2">
                  {/* Attach (the row body). Attached rows are inert — the
                      「追加済み」 mark explains the disabled state. */}
                  <button
                    type="button"
                    disabled={attached || deleting}
                    onClick={() => onAttach(m.id)}
                    className={[
                      'min-w-0 flex-1 rounded-[4px] border border-line p-3 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                      attached
                        ? 'cursor-default opacity-60'
                        : 'cursor-pointer hover:border-accent hover:bg-bg-inset active:bg-bg-inset',
                      deleting ? 'cursor-not-allowed opacity-40' : '',
                    ].join(' ')}
                  >
                    <p className="flex items-baseline gap-1.5 text-[12px] text-ink">
                      <span className="truncate">{m.label}</span>
                      {typeof m.version === 'number' && (
                        <span className="shrink-0 font-mono text-[10px] text-ink-faint">
                          {t('customTabs.publishedBadge', { version: String(m.version) })}
                        </span>
                      )}
                      {m.origin === 'installed' && (
                        <span className="shrink-0 rounded-sm border border-line px-1 text-[9px] uppercase tracking-wide text-ink-faint">
                          {t('customTabs.installed')}
                        </span>
                      )}
                      {attached && (
                        <span className="ml-auto shrink-0 text-[10px] text-ink-faint">
                          {t('customTabs.pickerAttached')}
                        </span>
                      )}
                    </p>
                    {m.description && (
                      <p
                        className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-ink-muted"
                        title={m.description}
                      >
                        {m.description}
                      </p>
                    )}
                  </button>
                  {/* Library-level destruction (two-step: arm → confirm). */}
                  {kind && (
                    <button
                      type="button"
                      disabled={deleting}
                      onClick={() => {
                        if (!confirming) {
                          setConfirmingId(m.id)
                          return
                        }
                        void remove(m.id)
                      }}
                      className={[
                        'shrink-0 self-center rounded-sm border px-2 py-1 text-[10.5px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40',
                        confirming
                          ? 'border-accent bg-accent-soft text-accent hover:bg-accent hover:text-bg-card active:bg-accent active:text-bg-card'
                          : 'border-line text-ink-faint hover:border-accent hover:text-accent active:text-accent',
                      ].join(' ')}
                    >
                      {confirming
                        ? t(kind === 'delete' ? 'customTabs.deleteConfirmYes' : 'customTabs.uninstallConfirmYes')
                        : t(kind === 'delete' ? 'customTabs.delete' : 'customTabs.uninstall')}
                    </button>
                  )}
                </div>
              )
            })
          )}
          {createRow}
        </div>
        <div className="mt-5 flex items-center justify-end">
          <Btn variant="subtle" size="md" onClick={onClose}>
            {t('common.close')}
          </Btn>
        </div>
      </div>
    </div>
  )
}

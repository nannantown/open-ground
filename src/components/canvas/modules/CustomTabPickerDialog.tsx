import { useState } from 'react'
import { Plus, Store, Trash2, Check, X, Eye, EyeOff } from 'lucide-react'
import { Overlay } from '@/components/ui/overlay'
import { useT } from '@/i18n/I18nContext'
import type { CustomModuleDef, CustomTabRole } from '@/lib/types'

/** A built-in module + its per-project visibility, for the picker's "Built-in"
 *  section. `enabled` = NOT hidden via ProjectData.disabledModules. */
export interface NativePickerItem {
  id: string
  label: string
  enabled: boolean
}

// "+" → the per-project tab picker (docs/CUSTOM_TABS_PLAN.md — "Per-project
// attachment & the '+' picker"). Lists MY library as a cartographic *register*
// (variant-A redesign): tabs are horizontal-rule-separated ledger rows with a
// mono serial number (T·01…) in a faintly-ruled gutter — no boxes. Clicking an
// unattached row attaches that module to the CURRENT project (the parent
// persists ProjectData.customTabs and switches the view); already-attached rows
// are inert, dimmed, and marked with a moss check. The picker is also the only
// place for LIBRARY-LEVEL destruction (owner: delete any module; tester:
// uninstall installed ones) — the trash affordance only fades in on row hover
// (never a permanently-floating button), and arms a two-step confirm inline
// (accent「本当に削除する」+ ✓/✕) before the parent runs the server DELETE + PTY
// teardown and refreshes the list. The 「新規タブを作成」 command sits in the
// footer (accent text, not in the ruling). Escape and a backdrop click dismiss.
//
// Why the row is a <div role="button"> and not a <button>: the row body is
// clickable (attach) AND contains its own <button> children (trash / confirm).
// A <button> inside a <button> is invalid HTML — the parser lifts the inner
// button out, breaking hover/click. A div with role+tabindex keeps the whole
// row activ:able while legally nesting the action buttons.

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
  natives = [],
  canDisableNative = false,
  onToggleNative,
  onAttach,
  onCreateNew,
  onBrowseMarket,
  onDelete,
  onClose,
}: {
  /** The caller's full library (useCustomModules order). */
  modules: CustomModuleDef[]
  role: CustomTabRole
  /** Module ids already attached to the current project. */
  attachedIds: ReadonlySet<string>
  /** Built-in modules + their per-project visibility (the "Built-in" section).
   *  Personal layout, so shown for every role. Omit `onToggleNative` to hide
   *  the section entirely (e.g. in isolated tests). */
  natives?: NativePickerItem[]
  /** Whether an enabled built-in may currently be hidden — false when only one
   *  visible tab remains (the floor: a project must keep at least one). */
  canDisableNative?: boolean
  /** Show/hide a built-in in this project (`enabled` = the desired next state). */
  onToggleNative?: (moduleId: string, enabled: boolean) => void
  /** Attach to the current project — the parent persists, switches the view
   *  to the new tab and closes the picker. */
  onAttach: (moduleId: string) => void
  /** Open the create dialog (owner only; the parent closes the picker). */
  onCreateNew?: () => void
  /** Browse the marketplace (owner|tester; the parent closes the picker and
   *  opens the marketplace dialog). undefined hides the command. */
  onBrowseMarket?: () => void
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

  // The 「新規タブを作成」 command (owner only) — accent text + plus, sitting in
  // the footer outside the ruling (not a dashed box).
  const createButton = onCreateNew && (
    <button
      type="button"
      onClick={onCreateNew}
      className="group/create inline-flex items-center gap-[7px] rounded-[3px] px-0.5 py-1 text-ui font-medium text-accent transition-colors hover:text-accent-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <Plus size={14} strokeWidth={1.75} className="shrink-0" />
      <span className="underline-offset-2 group-hover/create:underline">
        {t('customTabs.pickerCreateNew')}
      </span>
    </button>
  )

  // 「マーケットで探す」 — owner|tester. Sits beside create in the footer; same
  // shape with a storefront glyph, muted so create stays the accent. The tab
  // row no longer carries a bare "Market" text entry, so this is its home.
  const marketButton = onBrowseMarket && (
    <button
      type="button"
      onClick={onBrowseMarket}
      className="group/market inline-flex items-center gap-[7px] rounded-[3px] px-0.5 py-1 text-ui font-medium text-ink-muted transition-colors hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <Store size={14} strokeWidth={1.75} className="shrink-0" />
      <span className="underline-offset-2 group-hover/market:underline">
        {t('customTabs.marketBrowse')}
      </span>
    </button>
  )

  return (
    <Overlay
      position="absolute"
      layer="local"
      backdrop="veil"
      placement="center"
      padded={false}
      className="overflow-y-auto px-6 py-8"
      onClose={onClose}
      // Backdrop dismiss (press on the veil closes) and Esc both come from the
      // shell now — the mousedown-not-click rule this file used to hand-roll is
      // the shell's, so the root onMouseDown and the section's stopPropagation
      // that gated it are both gone.
      aria-label={t('customTabs.pickerTitle')}
    >
      <section
        role="dialog"
        aria-label={t('customTabs.pickerTitle')}
        className="relative w-full max-w-[512px] overflow-hidden rounded-[8px] border border-line bg-bg-card shadow-card-hover"
      >
        {/* Header — kicker → Fraunces title → muted desc, with a faint corner
            registration tick like a map-sheet corner. */}
        <header className="relative px-[30px] pb-[18px] pt-[26px]">
          <span
            aria-hidden
            className="pointer-events-none absolute right-4 top-[14px] h-[14px] w-[14px] border-r border-t border-line-strong opacity-70"
          />
          <p className="label-cap mb-3 text-accent">{t('customTabs.pickerLabel')}</p>
          <h2 className="font-display text-head font-medium leading-[1.12] tracking-tightest text-ink">
            {t('customTabs.pickerTitle')}
          </h2>
          <p className="mt-[9px] max-w-[42ch] text-ui leading-[1.55] text-ink-muted">
            {t('customTabs.pickerExplain')}
          </p>
        </header>

        <div className="rule-double" aria-hidden />

        {/* Built-in section — the pre-installed default set (Terminal / Canvas /
            Board). Each row toggles that module's visibility in THIS project
            (personal layout, every role). The last visible tab can't be hidden.
            Rendered only when the parent wires the toggle. */}
        {onToggleNative && natives.length > 0 && (
          <>
            <div
              aria-hidden
              className="flex items-baseline justify-between px-[30px] pb-[7px] pt-3 text-ink-faint"
            >
              <span className="coord-label">
                {t('customTabs.builtinSection')}
              </span>
              <span className="coord-label opacity-85">
                {t('customTabs.pickerLegendState')}
              </span>
            </div>
            <ul className="m-0 list-none p-0">
              {natives.map((n, i) => {
                const serial = `B·${String(i + 1).padStart(2, '0')}`
                // The last visible tab can't be hidden — a project must keep one.
                const locked = n.enabled && !canDisableNative
                return (
                  <li
                    key={n.id}
                    className="group relative border-t border-line-soft first:border-t-0"
                  >
                    <div
                      role="button"
                      tabIndex={locked ? -1 : 0}
                      aria-disabled={locked}
                      aria-pressed={n.enabled}
                      title={locked ? t('customTabs.lastModuleHint') : undefined}
                      aria-label={
                        (n.enabled
                          ? t('customTabs.hideModule')
                          : t('customTabs.showModule')) +
                        ' — ' +
                        n.label
                      }
                      onClick={() => {
                        if (!locked) onToggleNative(n.id, !n.enabled)
                      }}
                      onKeyDown={e => {
                        if ((e.key === 'Enter' || e.key === ' ') && !locked) {
                          e.preventDefault()
                          onToggleNative(n.id, !n.enabled)
                        }
                      }}
                      className={[
                        'relative grid grid-cols-[44px_1fr_auto] items-center gap-x-4 px-[30px] py-[14px] transition-colors',
                        'before:absolute before:inset-y-0 before:left-[74px] before:w-px before:bg-line-soft/70',
                        locked
                          ? 'cursor-not-allowed'
                          : 'cursor-pointer hover:bg-plane active:bg-bg-elevated',
                        n.enabled ? '' : 'opacity-60',
                        'focus-visible:outline focus-visible:outline-[1.5px] focus-visible:-outline-offset-2 focus-visible:outline-accent',
                      ].join(' ')}
                    >
                      <span className="font-mono text-micro uppercase tracking-[0.06em] tabular-nums text-ink-faint group-hover:text-ink-subtle">
                        {serial}
                      </span>
                      <div className="min-w-0">
                        <div
                          className={[
                            'truncate text-ui font-medium leading-[1.3]',
                            n.enabled ? 'text-ink' : 'text-ink-muted',
                          ].join(' ')}
                        >
                          {n.label}
                        </div>
                      </div>
                      <div className="flex items-center justify-end gap-2.5">
                        {n.enabled ? (
                          <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-plate font-medium uppercase text-moss">
                            <Eye size={13} strokeWidth={2} />
                            {t('customTabs.shown')}
                          </span>
                        ) : (
                          <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-plate font-medium uppercase text-ink-faint">
                            <EyeOff size={13} strokeWidth={2} />
                            {t('customTabs.hidden')}
                          </span>
                        )}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
            <div className="rule-double" aria-hidden />
          </>
        )}

        {modules.length === 0 ? (
          // Empty state — a single ledger line with the T·— serial.
          <div className="flex items-baseline gap-3 px-[30px] py-7">
            <span className="font-mono text-micro uppercase tracking-[0.06em] text-line-strong">
              T·—
            </span>
            <span className="font-display text-ui italic text-ink-muted">
              {t('customTabs.pickerEmpty')}
            </span>
          </div>
        ) : (
          <>
            {/* Column legend — the ledger's quiet column heads. */}
            <div
              aria-hidden
              className="flex items-baseline justify-between px-[30px] pb-[7px] pt-3 text-ink-faint"
            >
              <span className="coord-label">
                {t('customTabs.pickerLegendIndex')}
              </span>
              <span className="coord-label opacity-85">
                {t('customTabs.pickerLegendState')}
              </span>
            </div>

            <ul className="m-0 list-none p-0">
              {modules.map((m, i) => {
                const attached = attachedIds.has(m.id)
                const kind = moduleRemoveKind(role, m)
                const confirming = confirmingId === m.id
                const deleting = deletingId === m.id
                const serial = `T·${String(i + 1).padStart(2, '0')}`
                return (
                  <li
                    key={m.id}
                    className="group relative border-t border-line-soft first:border-t-0"
                  >
                    <div
                      role="button"
                      tabIndex={attached ? -1 : 0}
                      aria-disabled={attached || deleting}
                      aria-label={
                        attached
                          ? `${m.label}（${t('customTabs.pickerAttached')}）`
                          : t('customTabs.addTab') + ' — ' + m.label
                      }
                      onClick={() => {
                        if (!attached && !deleting && !confirming) onAttach(m.id)
                      }}
                      onKeyDown={e => {
                        if (
                          (e.key === 'Enter' || e.key === ' ') &&
                          !attached &&
                          !deleting &&
                          !confirming
                        ) {
                          e.preventDefault()
                          onAttach(m.id)
                        }
                      }}
                      className={[
                        'relative grid grid-cols-[44px_1fr_auto] items-center gap-x-4 px-[30px] py-[14px] transition-colors',
                        // serial gutter rule (30px pad + 44px serial col = 74px)
                        'before:absolute before:inset-y-0 before:left-[74px] before:w-px before:bg-line-soft/70',
                        attached
                          ? 'cursor-default opacity-60'
                          : 'cursor-pointer hover:bg-plane active:bg-bg-elevated',
                        confirming ? 'bg-accent-soft before:bg-accent/20' : '',
                        deleting ? 'opacity-40' : '',
                        'focus-visible:outline focus-visible:outline-[1.5px] focus-visible:-outline-offset-2 focus-visible:outline-accent',
                      ].join(' ')}
                    >
                      {/* serial — mono, tabular, firms up on hover */}
                      <span className="font-mono text-micro uppercase tracking-[0.06em] tabular-nums text-ink-faint group-hover:text-ink-subtle">
                        {serial}
                      </span>

                      {/* main text column */}
                      <div className="min-w-0">
                        <div
                          className={[
                            'truncate text-ui font-medium leading-[1.3]',
                            attached ? 'text-ink-muted' : 'text-ink',
                          ].join(' ')}
                        >
                          {m.label}
                        </div>
                        {m.description && (
                          <div
                            className="mt-0.5 truncate text-meta leading-[1.4] text-ink-muted"
                            title={m.description}
                          >
                            {m.description}
                          </div>
                        )}
                      </div>

                      {/* right cluster: meta + action affordance */}
                      <div className="flex items-center justify-end gap-3">
                        {confirming ? (
                          <span className="inline-flex items-center gap-2 text-accent-deeper">
                            <span className="whitespace-nowrap text-meta font-semibold">
                              {t(
                                kind === 'delete'
                                  ? 'customTabs.deleteConfirmYes'
                                  : 'customTabs.uninstallConfirmYes',
                              )}
                            </span>
                            <button
                              type="button"
                              disabled={deleting}
                              onClick={e => {
                                e.stopPropagation()
                                void remove(m.id)
                              }}
                              aria-label={t(
                                kind === 'delete'
                                  ? 'customTabs.deleteConfirmYes'
                                  : 'customTabs.uninstallConfirmYes',
                              )}
                              className="inline-flex h-[22px] w-[22px] items-center justify-center rounded text-accent transition-colors hover:bg-accent/15 hover:text-accent-hover disabled:opacity-40 focus-visible:outline focus-visible:outline-[1.5px] focus-visible:outline-offset-1 focus-visible:outline-accent"
                            >
                              <Check size={14} strokeWidth={2} />
                            </button>
                            <button
                              type="button"
                              onClick={e => {
                                e.stopPropagation()
                                setConfirmingId(null)
                              }}
                              aria-label={t('common.cancel')}
                              className="inline-flex h-[22px] w-[22px] items-center justify-center rounded text-ink-muted transition-colors hover:bg-ink/[0.07] hover:text-ink focus-visible:outline focus-visible:outline-[1.5px] focus-visible:outline-offset-1 focus-visible:outline-accent"
                            >
                              <X size={14} strokeWidth={2} />
                            </button>
                          </span>
                        ) : (
                          <>
                            {typeof m.version === 'number' && (
                              <span className="font-mono text-meta tabular-nums text-ink-faint">
                                {t('customTabs.publishedBadge', {
                                  version: String(m.version),
                                })}
                              </span>
                            )}
                            {m.origin === 'installed' && (
                              <span className="whitespace-nowrap rounded-[3px] border border-line-strong px-[5px] py-0.5 text-plate font-medium uppercase leading-none text-ink-faint">
                                {t('customTabs.installed')}
                              </span>
                            )}
                            {attached && (
                              <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-plate font-medium uppercase text-moss">
                                <Check size={13} strokeWidth={2} />
                                {t('customTabs.pickerAttached')}
                              </span>
                            )}
                            {/* add affordance — only when there's no trash to
                                show; the whole row is the real add target. */}
                            {!attached && !kind && (
                              <span
                                aria-hidden
                                className="inline-flex h-5 w-5 items-center justify-center text-ink-faint opacity-0 transition-opacity group-hover:opacity-100"
                              >
                                <Plus size={15} strokeWidth={1.75} />
                              </span>
                            )}
                            {/* library-level destruction — fades in on row
                                hover only (arms the two-step confirm). */}
                            {kind && (
                              <button
                                type="button"
                                disabled={deleting}
                                onClick={e => {
                                  e.stopPropagation()
                                  setConfirmingId(m.id)
                                }}
                                aria-label={t(
                                  kind === 'delete'
                                    ? 'customTabs.delete'
                                    : 'customTabs.uninstall',
                                )}
                                className="-mr-1 inline-flex h-6 w-6 items-center justify-center rounded text-ink-faint opacity-0 transition-all hover:text-accent disabled:cursor-not-allowed disabled:opacity-40 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-[1.5px] focus-visible:outline-offset-1 focus-visible:outline-accent"
                              >
                                <Trash2 size={14} strokeWidth={1.75} />
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          </>
        )}

        <div className="rule-double" aria-hidden />

        <footer className="flex items-center justify-between gap-4 px-[30px] pb-[17px] pt-[15px]">
          <div className="flex items-center gap-5">
            {createButton}
            {marketButton}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-[5px] border border-line-strong px-4 py-1.5 text-ui font-medium text-ink-muted transition-colors hover:border-ink-faint hover:bg-plane hover:text-ink active:bg-bg-elevated focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {t('common.close')}
          </button>
        </footer>
      </section>
    </Overlay>
  )
}

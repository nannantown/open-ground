import { useEffect, useState } from 'react'
import { useT } from '@/i18n/I18nContext'
import type {
  CustomModuleDef,
  MarketplaceListResponse,
  MarketplaceModule,
} from '@/lib/types'

// Marketplace browser (owner|tester only — the entry point is role-gated in
// the tab bar and the server re-checks every call). Lists the published
// modules (GET /api/marketplace, anon-key read server-side) and installs one
// locally (POST /api/marketplace/install); the parent auto-attaches the
// installed module to the CURRENT project (docs/CUSTOM_TABS_PLAN.md —
// per-project attachment), so the response def is handed up.
// An already-installed row (matched by remoteId via the parent's module list)
// shows a disabled "Installed" button: module updates are out of scope this
// round (docs/CUSTOM_TABS_PLAN.md), so re-install — which the server would
// apply in place under the same local uuid — is deliberately not offered here.
//
// Shares the register-language card shell with the picker (variant-A redesign):
// published tabs are rule-separated ledger rows with a mono serial (M·01…); the
// install button is the row's explicit action (always visible — installing is
// a deliberate choice, not a hover-revealed affordance). A backdrop click
// dismisses (it's a browse view; nothing to lose).

export const MarketplaceDialog = ({
  installedRemoteIds,
  onInstalled,
  onClose,
}: {
  /** remoteIds already present locally (def.remoteId of installed/published
   *  modules) — marks rows as Installed. */
  installedRemoteIds: ReadonlySet<string>
  /** A module was installed — the parent re-fetches the module list and
   *  attaches the def to the current project. */
  onInstalled: (def: CustomModuleDef) => Promise<void> | void
  onClose: () => void
}) => {
  const { t } = useT()
  // null = loading; 'unavailable' = 503 (Supabase env missing on this machine).
  const [items, setItems] = useState<MarketplaceModule[] | null>(null)
  const [loadError, setLoadError] = useState<'unavailable' | string | null>(null)
  const [installingId, setInstallingId] = useState<string | null>(null)
  const [installError, setInstallError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/marketplace', { cache: 'no-store' })
      .then(async r => {
        if (cancelled) return
        if (!r.ok) {
          setLoadError(r.status === 503 ? 'unavailable' : `HTTP ${r.status}`)
          return
        }
        const body = (await r.json()) as MarketplaceListResponse
        if (!cancelled) setItems(Array.isArray(body.items) ? body.items : [])
      })
      .catch(() => {
        if (!cancelled) setLoadError(t('projectPanel.networkError'))
      })
    return () => {
      cancelled = true
    }
    // One fetch per open — the dialog is short-lived.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const install = async (remoteId: string) => {
    if (installingId) return
    setInstallingId(remoteId)
    setInstallError(null)
    try {
      const r = await fetch('/api/marketplace/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ remoteId }),
      })
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string }
        setInstallError(
          t('customTabs.installFailed', {
            error: body.error ?? `HTTP ${r.status}`,
          }),
        )
        return
      }
      await onInstalled((await r.json()) as CustomModuleDef)
    } catch {
      setInstallError(
        t('customTabs.installFailed', { error: t('projectPanel.networkError') }),
      )
    } finally {
      setInstallingId(null)
    }
  }

  // Message states (loading / unavailable / error / empty) share one quiet
  // ledger line with a T·— style serial, so the body never looks broken.
  const message = (text: string) => (
    <div className="flex items-baseline gap-3 px-[30px] py-7">
      <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-line-strong">
        M·—
      </span>
      <span className="text-[12px] leading-relaxed text-ink-muted">{text}</span>
    </div>
  )

  return (
    <div
      data-esc-overlay
      className="absolute inset-0 z-20 flex items-center justify-center overflow-y-auto bg-bg-card/70 px-6 py-8"
      onMouseDown={onClose}
    >
      <section
        role="dialog"
        aria-label={t('customTabs.marketTitle')}
        onMouseDown={e => e.stopPropagation()}
        className="relative w-full max-w-[520px] overflow-hidden rounded-[8px] border border-line bg-bg-card shadow-card-hover"
      >
        <header className="relative px-[30px] pb-[18px] pt-[26px]">
          <span
            aria-hidden
            className="pointer-events-none absolute right-4 top-[14px] h-[14px] w-[14px] border-r border-t border-line-strong opacity-70"
          />
          <p className="label-cap mb-3 text-accent">{t('customTabs.marketLabel')}</p>
          <h3 className="font-display text-[23px] font-medium leading-[1.12] tracking-tightest text-ink">
            {t('customTabs.marketTitle')}
          </h3>
          <p className="mt-[9px] max-w-[46ch] text-[12px] leading-[1.55] text-ink-muted">
            {t('customTabs.marketExplain')}
          </p>
        </header>

        <div className="rule-double" aria-hidden />

        <div className="max-h-[50vh] overflow-y-auto">
          {loadError !== null
            ? message(
                loadError === 'unavailable'
                  ? t('customTabs.marketUnavailable')
                  : t('customTabs.marketFailed', { error: loadError }),
              )
            : items === null
              ? message(t('customTabs.marketLoading'))
              : items.length === 0
                ? message(t('customTabs.marketEmpty'))
                : (
                    <ul className="m-0 list-none p-0">
                      {items.map((item, i) => {
                        const installed = installedRemoteIds.has(item.remoteId)
                        const installing = installingId === item.remoteId
                        const serial = `M·${String(i + 1).padStart(2, '0')}`
                        return (
                          <li
                            key={item.remoteId}
                            className="relative grid grid-cols-[44px_1fr_auto] items-center gap-x-4 border-t border-line-soft px-[30px] py-[14px] first:border-t-0 before:absolute before:inset-y-0 before:left-[74px] before:w-px before:bg-line-soft/70"
                          >
                            <span className="font-mono text-[10px] uppercase tracking-[0.06em] tabular-nums text-ink-faint">
                              {serial}
                            </span>
                            <div className="min-w-0">
                              <div className="flex items-baseline gap-2">
                                <span className="truncate text-[13px] font-medium leading-[1.3] text-ink">
                                  {item.name}
                                </span>
                                <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-faint">
                                  {t('customTabs.marketVersion', {
                                    version: String(item.version),
                                  })}
                                </span>
                              </div>
                              {item.description && (
                                <div
                                  className="mt-0.5 truncate text-[11px] leading-[1.4] text-ink-muted"
                                  title={item.description}
                                >
                                  {item.description}
                                </div>
                              )}
                            </div>
                            <button
                              type="button"
                              onClick={() => void install(item.remoteId)}
                              disabled={installing || installed}
                              className="rounded-[5px] border border-line-strong px-3 py-1 text-[11px] font-medium text-ink-muted transition-colors hover:border-ink-faint hover:bg-bg-inset hover:text-ink active:bg-bg-elevated disabled:cursor-not-allowed disabled:border-line disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-ink-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                            >
                              {installing
                                ? t('customTabs.installing')
                                : installed
                                  ? t('customTabs.installed')
                                  : t('customTabs.install')}
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  )}
        </div>

        {installError && (
          <p className="px-[30px] pt-3 text-[11px] leading-relaxed text-accent">
            {installError}
          </p>
        )}

        <div className="rule-double" aria-hidden />

        <footer className="flex items-center justify-end px-[30px] pb-[17px] pt-[15px]">
          <button
            type="button"
            onClick={onClose}
            className="rounded-[5px] border border-line-strong px-4 py-1.5 text-[12px] font-medium text-ink-muted transition-colors hover:border-ink-faint hover:bg-bg-inset hover:text-ink active:bg-bg-elevated focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {t('common.close')}
          </button>
        </footer>
      </section>
    </div>
  )
}

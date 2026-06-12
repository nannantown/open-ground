import { useEffect, useState } from 'react'
import { Btn } from '@/components/ui/Btn'
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

  return (
    <div
      data-esc-overlay
      className="absolute inset-0 z-20 flex flex-col justify-center gap-5 overflow-y-auto bg-bg-card px-6 py-8"
    >
      <div className="mx-auto w-full max-w-[520px]">
        <p className="label-cap text-accent mb-2">{t('customTabs.marketLabel')}</p>
        <h3 className="font-display text-[20px] leading-snug text-ink tracking-tightest">
          {t('customTabs.marketTitle')}
        </h3>
        <p className="mt-2.5 text-[12px] leading-relaxed text-ink-muted">
          {t('customTabs.marketExplain')}
        </p>
        <div className="mt-4 max-h-[50vh] space-y-2 overflow-y-auto pr-1">
          {loadError !== null ? (
            <p className="text-[12px] leading-relaxed text-ink-muted">
              {loadError === 'unavailable'
                ? t('customTabs.marketUnavailable')
                : t('customTabs.marketFailed', { error: loadError })}
            </p>
          ) : items === null ? (
            <p className="text-[12px] text-ink-subtle">{t('customTabs.marketLoading')}</p>
          ) : items.length === 0 ? (
            <p className="text-[12px] text-ink-subtle">{t('customTabs.marketEmpty')}</p>
          ) : (
            items.map(item => {
              const installed = installedRemoteIds.has(item.remoteId)
              const installing = installingId === item.remoteId
              return (
                <div
                  key={item.remoteId}
                  className="flex items-start gap-3 rounded-[4px] border border-line p-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex items-baseline gap-1.5 text-[12px] text-ink">
                      <span className="truncate">{item.name}</span>
                      <span className="shrink-0 font-mono text-[10px] text-ink-faint">
                        {t('customTabs.marketVersion', { version: String(item.version) })}
                      </span>
                    </p>
                    {item.description && (
                      <p
                        className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-ink-muted"
                        title={item.description}
                      >
                        {item.description}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => void install(item.remoteId)}
                    disabled={installing || installed}
                    className="shrink-0 rounded-sm border border-line px-2.5 py-1 text-[11px] text-ink-muted transition-colors hover:bg-bg-inset hover:text-ink active:bg-bg-inset active:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    {installing
                      ? t('customTabs.installing')
                      : installed
                        ? t('customTabs.installed')
                        : t('customTabs.install')}
                  </button>
                </div>
              )
            })
          )}
        </div>
        {installError && (
          <p className="mt-3 text-[11px] leading-relaxed text-accent">{installError}</p>
        )}
        <div className="mt-5 flex items-center justify-end">
          <Btn variant="subtle" size="md" onClick={onClose}>
            {t('common.close')}
          </Btn>
        </div>
      </div>
    </div>
  )
}

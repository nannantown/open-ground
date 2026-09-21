import { useT } from '@/i18n/I18nContext'

/** Display preview only. The caller retains the real owner role. */
export function OwnerViewSwitch({ publicPreview, onChange }: {
  publicPreview: boolean
  onChange: (publicPreview: boolean) => void
}) {
  const { t } = useT()
  return (
    <div role="group" aria-label={t('toolbar.viewMode')} className="pointer-events-auto inline-flex max-w-full rounded-[3px] border border-line bg-bg-card p-0.5">
      {[false, true].map(publicView => (
        <button
          key={String(publicView)}
          type="button"
          aria-pressed={publicPreview === publicView}
          onClick={() => onChange(publicView)}
          className={`min-w-0 rounded-[2px] px-2.5 py-1.5 text-meta transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 ${publicPreview === publicView
            ? 'bg-ink text-bg hover:bg-ink-muted active:bg-ink-muted'
            : 'bg-bg-card text-ink-muted hover:bg-plane hover:text-ink active:bg-bg-inset active:text-ink'}`}
        >
          {t(publicView ? 'toolbar.publicView' : 'toolbar.ownerView')}
        </button>
      ))}
    </div>
  )
}

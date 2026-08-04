import { useT } from '@/i18n/I18nContext'

/** Shown in place of the Ground when its bootstrap fetch (GET /api/projects)
 *  fails. Without it App renders a bare `<div className="bg-bg" />` forever —
 *  no message, no spinner, no way back — because `settings`/`canvas` only ever
 *  get set on a successful load. Retry re-runs that same load. */
export const GroundLoadError = ({
  detail,
  retrying,
  onRetry,
}: {
  /** Server-supplied `{ error }` text (or the HTTP status), for the small print. */
  detail: string
  retrying: boolean
  onRetry: () => void
}) => {
  const { t } = useT()
  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center gap-5 bg-bg px-6">
      <div className="max-w-sm text-center">
        <p className="text-ui text-ink">{t('misc.ground.loadFailed')}</p>
        <p className="mt-1.5 text-ui text-ink-muted">{t('misc.ground.loadFailedBody')}</p>
        {detail && (
          <p className="mt-3 break-words font-mono text-meta text-ink-faint">{detail}</p>
        )}
      </div>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="rounded-[3px] border border-line bg-bg-card px-4 py-2 text-ui text-ink-muted shadow-card transition-colors hover:bg-plane hover:text-ink active:bg-plane disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-bg-card disabled:hover:text-ink-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {retrying ? t('misc.ground.retrying') : t('misc.ground.retry')}
      </button>
    </div>
  )
}

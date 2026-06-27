import { FolderPlus, FolderInput } from 'lucide-react'
import { Btn } from '@/components/ui/Btn'
import { useT } from '@/i18n/I18nContext'

const MARK = '/brand/openground-mark.svg'

// The first surface a brand-new user sees, on the empty Ground canvas. The
// radial OPEN GROUND mark doubles as a compass rose (cardinal labels around it),
// leaning into the survey/atlas brand language. A faint oversized mark behind
// gives the paper some depth.
export const EmptyState = ({
  onCreateNew,
  onImport,
  onOpenManual,
}: {
  onCreateNew: () => void
  onImport: () => void
  /** Opens the in-app manual — the first surface a lost new user can reach. */
  onOpenManual?: () => void
}) => {
  const { t } = useT()

  return (
    <div className="fixed inset-0 z-overlay-hint flex items-center justify-center overflow-hidden">
      <style>{`
        @keyframes og-empty-in{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
        @keyframes og-empty-drift{from{transform:rotate(0)}to{transform:rotate(360deg)}}
      `}</style>

      {/* Modal backdrop — softly blurs and dims the (empty) canvas behind so the
          first-run focus is on creating a project, and the canvas tools aren't a
          confusing distraction. Captures clicks so the canvas can't be drawn on. */}
      <div className="absolute inset-0 bg-bg/55 backdrop-blur-[3px]" />

      {/* Atmospheric oversized mark, slowly turning behind the content. */}
      <img
        src={MARK}
        alt=""
        aria-hidden="true"
        className="pointer-events-none absolute h-[620px] w-[620px] select-none opacity-[0.04]"
        style={{ animation: 'og-empty-drift 300s linear infinite' }}
        draggable={false}
      />

      <div
        className="pointer-events-auto relative max-w-[460px] px-6 text-center"
        style={{ animation: 'og-empty-in 0.6s cubic-bezier(0.22,1,0.36,1) both' }}
      >
        {/* Brand mark, plain — no compass framing. */}
        <img
          src={MARK}
          alt="OPEN GROUND"
          className="mx-auto mb-8 h-[64px] w-[64px] select-none"
          draggable={false}
        />

        <p className="label-cap text-accent mb-3">{t('misc.empty.eyebrow')}</p>
        <h1
          className="mb-4 font-display text-[34px] leading-[1.05] tracking-tightest text-ink"
          style={{ fontVariationSettings: "'opsz' 36, 'SOFT' 40" }}
        >
          {t('misc.empty.title')}
        </h1>
        <p className="mx-auto mb-7 max-w-[360px] text-[13px] leading-relaxed text-ink-muted">
          {t('misc.empty.body')}
        </p>

        <div className="flex items-center justify-center gap-2.5">
          <Btn variant="primary" size="md" onClick={onCreateNew}>
            <FolderPlus size={14} />
            {t('toolbar.newProject')}
          </Btn>
          <Btn variant="subtle" size="md" onClick={onImport}>
            <FolderInput size={14} />
            {t('toolbar.importFolder')}
          </Btn>
        </div>

        {onOpenManual && (
          <button
            type="button"
            onClick={onOpenManual}
            className="mx-auto mt-6 block text-[12px] text-ink-faint underline-offset-4 transition-colors hover:text-accent hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {t('misc.empty.manual')}
          </button>
        )}
      </div>
    </div>
  )
}

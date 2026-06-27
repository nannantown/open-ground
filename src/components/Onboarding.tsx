// First-run welcome — a single overview screen. Left: the Ground canvas
// spreading behind (the real grid + scattered project cards + the radial mark),
// so you SEE what the app is before entering. Right: a calm column —
//   what OPEN GROUND is / how it works, a beta notice, and "Get started" which
//   drops you straight onto the Ground as a guest. App sign-in is NOT part of
//   onboarding (it lives in the account menu, optional, for upcoming features).
//
// We do NOT gate onboarding on Claude detection. Installing `claude` is the
// user's responsibility; the app passively REFLECTS whether Claude is connected
// (a quiet toolbar indicator + a Settings status), never blocks first-run on it.
import { useT } from '@/i18n/I18nContext'

const MARK = '/brand/openground-mark.svg'
const WORDMARK = '/brand/openground-wordmark.svg'

const rise = (ms: number): React.CSSProperties => ({
  animation: 'og-rise 0.6s cubic-bezier(0.22,1,0.36,1) both',
  animationDelay: `${ms}ms`,
})

// A decorative project card — the silhouette of a real ProjectCard (icon chip +
// title + summary lines), content abstracted to bars so it reads as "a project
// on the canvas" without inventing fake names.
const FauxCard = ({
  className,
  style,
  coord,
  running,
}: {
  className?: string
  style?: React.CSSProperties
  coord: string
  running?: boolean
}) => (
  <div
    style={style}
    className={`absolute w-[212px] rounded-[3px] border border-line bg-bg-card shadow-card ${className ?? ''}`}
  >
    <div className="coord-label absolute -top-[7px] left-3 bg-bg-card px-1.5 text-ink-subtle">{coord}</div>
    <div className="px-4 py-3.5">
      <div className="flex items-center gap-2.5">
        <div className="h-6 w-6 rounded-[2px] border border-line bg-bg-inset" />
        <div className="h-2.5 flex-1 rounded-full bg-line-strong/55" />
        {running && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
      </div>
      <div className="mt-3.5 space-y-1.5">
        <div className="h-1.5 w-full rounded-full bg-line/70" />
        <div className="h-1.5 w-[85%] rounded-full bg-line/70" />
        <div className="h-1.5 w-[60%] rounded-full bg-line/70" />
      </div>
    </div>
  </div>
)

export function Onboarding({
  open,
  onComplete,
}: {
  open: boolean
  onComplete: () => void
}): JSX.Element | null {
  const { t } = useT()

  if (!open) return null

  const primaryBtn =
    'inline-flex w-full items-center justify-center whitespace-nowrap rounded-[2px] bg-accent px-4 py-3 ' +
    'label-cap text-bg-card shadow-card transition-all duration-150 ' +
    'hover:bg-accent-hover hover:shadow-card-hover hover:-translate-y-px ' +
    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ' +
    'disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-card disabled:translate-y-0'

  return (
    <div className="fixed inset-0 z-overlay-gate flex overflow-hidden bg-bg font-body">
      <style>{`
        @keyframes og-rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
        @keyframes og-card-in{from{opacity:0;transform:translateY(20px) scale(.97)}to{opacity:1}}
        @keyframes og-drift{from{transform:rotate(0)}to{transform:rotate(360deg)}}
      `}</style>

      {/* LEFT — the Ground canvas spreading behind (hidden on narrow screens) */}
      <div className="canvas-grid relative hidden flex-1 md:block">
        <img
          src={MARK}
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute left-[34%] top-[16%] h-[480px] w-[480px] -translate-x-1/2 select-none opacity-[0.06]"
          style={{ animation: 'og-drift 260s linear infinite' }}
          draggable={false}
        />
        <FauxCard coord="x 120 · y 80" running style={{ top: '15%', left: '11%', rotate: '-4deg', animation: 'og-card-in .7s cubic-bezier(.22,1,.36,1) both', animationDelay: '120ms' }} />
        <FauxCard coord="x 360 · y 240" style={{ top: '42%', left: '36%', rotate: '3deg', animation: 'og-card-in .7s cubic-bezier(.22,1,.36,1) both', animationDelay: '220ms' }} />
        <FauxCard coord="x 80 · y 520" style={{ top: '66%', left: '14%', rotate: '-2deg', animation: 'og-card-in .7s cubic-bezier(.22,1,.36,1) both', animationDelay: '320ms' }} />
        <FauxCard coord="x 600 · y 140" style={{ top: '24%', left: '62%', rotate: '2.5deg', animation: 'og-card-in .7s cubic-bezier(.22,1,.36,1) both', animationDelay: '420ms' }} />
        <div className="pointer-events-none absolute inset-y-0 right-0 w-44 bg-gradient-to-r from-transparent to-bg-card" />
      </div>

      {/* RIGHT — the overview / entry column */}
      <div className="relative flex w-full shrink-0 flex-col justify-center overflow-y-auto border-line bg-bg-card px-10 py-10 shadow-card-hover md:w-[460px] md:border-l">
        <div className="mx-auto w-full max-w-[340px]">
          {/* header: mark + wordmark + beta tag */}
          <div className="flex items-center gap-2.5" style={rise(0)}>
            <img src={MARK} alt="" aria-hidden="true" className="h-[28px] w-[28px] select-none" draggable={false} />
            <img src={WORDMARK} alt="OPEN GROUND" className="h-[20px] w-auto select-none" draggable={false} />
            <span className="inline-flex shrink-0 select-none items-center rounded-[3px] border border-accent/40 bg-accent/10 px-1.5 pt-[3px] pb-[2px] text-[9px] font-semibold uppercase leading-none tracking-wide text-accent">
              Beta
            </span>
          </div>

          <h1 style={rise(90)} className="mt-10 font-display text-[26px] leading-[1.2] tracking-tight text-ink">
            {t('onboarding.tagline')}
          </h1>
          <div className="mt-9" style={rise(170)}>
            <div className="mb-3 label-cap text-ink-faint">{t('onboarding.how.label')}</div>
            <ol className="space-y-3">
              {['line1', 'line2', 'line3'].map((k, i) => (
                <li key={k} className="flex gap-3 text-sm leading-relaxed text-ink-subtle">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-line bg-bg-inset text-[11px] font-medium text-ink-faint">
                    {i + 1}
                  </span>
                  <span>{t(`onboarding.how.${k}`)}</span>
                </li>
              ))}
            </ol>
          </div>
          {/* Beta notice — set expectations (breaking changes) and invite
              feedback. OPEN GROUND ships a Feedback button in the toolbar. */}
          <p style={rise(210)} className="mt-7 rounded-[3px] border border-line bg-bg-inset px-3 py-2.5 text-[12px] leading-relaxed text-ink-subtle">
            <span className="font-semibold text-accent">{t('onboarding.beta.tag')}</span>{' '}
            {t('onboarding.beta.note')}
          </p>
          <div className="mt-7" style={rise(240)}>
            <button type="button" className={primaryBtn} onClick={onComplete}>
              {t('onboarding.getStarted')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

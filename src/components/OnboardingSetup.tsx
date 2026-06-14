// Full-screen, guided Claude Code installer — shown by Onboarding only when the
// `claude` CLI is missing on first run. Left: a step-by-step checklist
// (choose method → install → sign in) whose buttons drive the shell on the
// right. Right: a REAL embedded terminal (TerminalPane mode="setup", a login
// shell in $HOME via /api/setup-terminal) so the user installs and does the
// interactive `claude` sign-in without leaving the app. While the CLI is
// missing we poll /api/claude-probe and advance automatically once it appears.
//
// Detection is presence-only — we can confirm the CLI is installed, not that
// the user signed in (auth is interactive). So "Continue" unlocks on install;
// the sign-in step is driven + instructed, then trusted.
import { useEffect, useRef, useState } from 'react'
import { useT } from '@/i18n/I18nContext'
import { TerminalPane, type TerminalPaneHandle } from '@/components/canvas/TerminalPane'

const MARK = '/brand/openground-mark.svg'
const WORDMARK = '/brand/openground-wordmark.svg'

// Verified against code.claude.com/docs (June 2026). Identical across locales.
const INSTALL = {
  installer: 'curl -fsSL https://claude.ai/install.sh | bash',
  brew: 'brew install --cask claude-code',
  npm: 'npm install -g @anthropic-ai/claude-code',
} as const
const DOCS_URL = 'https://code.claude.com/docs/en/setup'
type Method = keyof typeof INSTALL
const METHODS: Method[] = ['installer', 'brew', 'npm']

const CheckMark = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export function OnboardingSetup({
  onBack,
  onDone,
}: {
  onBack: () => void
  onDone: () => void
}): JSX.Element {
  const { t } = useT()
  const [method, setMethod] = useState<Method>('installer')
  const [installed, setInstalled] = useState(false)
  const [version, setVersion] = useState<string | null>(null)
  const [installRan, setInstallRan] = useState(false)
  const [copied, setCopied] = useState(false)
  const termRef = useRef<TerminalPaneHandle>(null)

  // Poll for the CLI until it appears, then stop. force=1 bypasses the server's
  // short probe cache so "I just installed it" is reflected within one tick.
  useEffect(() => {
    if (installed) return
    let cancelled = false
    const tick = async () => {
      try {
        const r = await fetch('/api/claude-probe?force=1', { cache: 'no-store' })
        const d = (await r.json()) as { installed?: boolean; version?: string | null }
        if (!cancelled && d?.installed) {
          setInstalled(true)
          setVersion(d.version ?? null)
        }
      } catch {
        /* server momentarily unreachable — keep polling */
      }
    }
    void tick()
    const iv = setInterval(tick, 3000)
    return () => {
      cancelled = true
      clearInterval(iv)
    }
  }, [installed])

  const runInstall = () => {
    termRef.current?.sendText(INSTALL[method] + '\r')
    setInstallRan(true)
  }
  const copyCmd = () => {
    void navigator.clipboard?.writeText(INSTALL[method])
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const primaryBtn =
    'inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-[2px] bg-accent px-4 py-2.5 label-cap text-bg-card shadow-card ' +
    'transition-all duration-150 hover:bg-accent-hover hover:shadow-card-hover hover:-translate-y-px ' +
    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ' +
    'disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-card disabled:translate-y-0'
  const ghostBtn =
    'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[2px] border border-line bg-bg-card px-4 py-2.5 label-cap text-ink-subtle ' +
    'transition-all duration-150 hover:border-line-strong hover:bg-bg-inset hover:text-ink ' +
    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ' +
    'disabled:opacity-40 disabled:cursor-not-allowed'
  const methodBtn = (active: boolean) =>
    'flex-1 whitespace-nowrap rounded-[2px] border px-2 py-2 text-[11px] font-medium transition-all duration-150 ' +
    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ' +
    (active
      ? 'border-ink bg-ink text-bg-card'
      : 'border-line bg-bg-card text-ink-subtle hover:border-line-strong hover:bg-bg-inset hover:text-ink')

  // A numbered step block. `done` swaps the number for a check; `dim` greys it
  // out until its prerequisite is met.
  const Step = ({
    n,
    title,
    done,
    dim,
    children,
  }: {
    n: number
    title: string
    done?: boolean
    dim?: boolean
    children: React.ReactNode
  }) => (
    <div className={`flex gap-3.5 ${dim ? 'opacity-45' : ''}`}>
      <div
        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium ${
          done ? 'border-accent bg-accent text-bg-card' : 'border-line bg-bg-inset text-ink-faint'
        }`}
      >
        {done ? <CheckMark /> : n}
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-2 text-[13px] font-medium text-ink">{title}</div>
        {children}
      </div>
    </div>
  )

  return (
    <div className="fixed inset-0 z-[70] flex bg-bg font-body">
      {/* LEFT — the guided checklist */}
      <div className="flex w-full max-w-[480px] shrink-0 flex-col overflow-y-auto border-r border-line bg-bg-card px-9 py-9">
        <div className="flex items-center gap-2.5">
          <img src={MARK} alt="" aria-hidden="true" className="h-[26px] w-[26px] select-none" draggable={false} />
          <img src={WORDMARK} alt="OPEN GROUND" className="h-[18px] w-auto select-none" draggable={false} />
        </div>

        <h1 className="mt-8 font-display text-[24px] leading-[1.2] tracking-tight text-ink">
          {t('onboarding.setup.guideTitle')}
        </h1>
        <p className="mt-2.5 text-[13px] leading-relaxed text-ink-subtle">{t('onboarding.setup.guideIntro')}</p>

        <div className="mt-8 space-y-6">
          {/* 1 — choose method */}
          <Step n={1} title={t('onboarding.setup.step.method')} done={installed}>
            <div className="flex gap-1.5">
              {METHODS.map((m) => (
                <button key={m} type="button" className={methodBtn(method === m)} onClick={() => setMethod(m)}>
                  {t(`onboarding.setup.method.${m}`)}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-ink-faint">{t(`onboarding.setup.method.${method}Note`)}</p>
          </Step>

          {/* 2 — install */}
          <Step n={2} title={t('onboarding.setup.step.install')} done={installed}>
            <code className="block overflow-x-auto whitespace-pre rounded-[2px] border border-line bg-bg-inset px-3 py-2 font-mono text-[12px] leading-relaxed text-ink">
              {INSTALL[method]}
            </code>
            <div className="mt-2.5 flex items-center gap-2">
              <button type="button" className={primaryBtn} onClick={runInstall} disabled={installed}>
                {t('onboarding.setup.runInstall')}
              </button>
              <button type="button" className={ghostBtn} onClick={copyCmd}>
                {copied ? t('onboarding.setup.copied') : t('onboarding.setup.orCopy')}
              </button>
            </div>
            {installed ? (
              <div className="mt-2.5 flex items-center gap-2 text-[12px] font-medium text-accent">
                <CheckMark />
                {t('onboarding.setup.detectedShort')}
                {version && <span className="font-mono text-[11px] text-ink-faint">{version}</span>}
              </div>
            ) : installRan ? (
              <div className="mt-2.5 flex items-center gap-2 text-[12px] text-ink-subtle">
                <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-line-strong border-t-transparent" />
                {t('onboarding.setup.waiting')}
              </div>
            ) : null}
          </Step>

          {/* 3 — sign in: claude owns its own login. We do NOT drive it from the
              app — the CLI prompts on first use (in a Board/Terminal session) and
              persists the result itself. Onboarding only sets expectations. */}
          <Step n={3} title={t('onboarding.setup.step.signin')} dim={!installed}>
            <p className="text-[12px] leading-relaxed text-ink-subtle">{t('onboarding.setup.signinHint')}</p>
          </Step>
        </div>

        {/* footer nav */}
        <div className="mt-auto flex flex-col gap-2.5 pt-8">
          <div className="flex items-center gap-2.5">
            <button type="button" className={ghostBtn} onClick={onBack}>
              {t('onboarding.nav.back')}
            </button>
            <button type="button" className={primaryBtn} disabled={!installed} onClick={onDone}>
              {t('onboarding.setup.continue')}
            </button>
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="ml-auto label-cap text-ink-faint underline-offset-2 transition-colors duration-150 hover:text-accent hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {t('onboarding.setup.docs')}
            </a>
          </div>
          {/* Escape hatch: detection can lag reality (PATH added by the
              installer is invisible to the server until relaunch on some
              setups). The probe now re-resolves via a login shell, but a
              user must NEVER be trapped on this screen — if claude runs in
              the pane on the right, let them through. */}
          {!installed && (
            <button
              type="button"
              onClick={onDone}
              className="self-start text-[11px] text-ink-faint underline-offset-2 transition-colors duration-150 hover:text-ink hover:underline active:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {t('onboarding.setup.skipAnyway')}
            </button>
          )}
        </div>
      </div>

      {/* RIGHT — the live terminal that the steps drive */}
      <div className="relative flex min-w-0 flex-1 flex-col bg-[#1a1a1a]">
        <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-4 py-2">
          <span className="h-2 w-2 rounded-full bg-white/20" />
          <span className="label-cap text-white/45">{t('onboarding.setup.terminal')}</span>
          <span className="ml-auto text-[11px] text-white/30">{t('onboarding.setup.manualHint')}</span>
        </div>
        <div className="min-h-0 flex-1">
          <TerminalPane ref={termRef} projectPath="__setup__" mode="setup" />
        </div>
      </div>
    </div>
  )
}

import { Compass, AlertCircle, Terminal } from 'lucide-react'
import { Btn } from '@/components/ui/Btn'
import { useClaudeProbe } from '@/lib/useClaudeProbe'

export const EmptyState = ({
  onConfigure,
  configured,
}: {
  onConfigure: () => void
  configured: boolean
}) => {
  // Probe the local `claude` CLI from the empty-state — this is the first
  // surface a brand-new user sees, so it's the right place to tell them OPEN
  // GROUND drives the local CLI (subscription-only) and needs it installed.
  const claude = useClaudeProbe(true)
  const claudeMissing = claude !== null && !claude.installed

  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div className="pointer-events-auto max-w-md text-center px-6 py-10">
        {/* Compass rose */}
        <div className="relative mx-auto mb-7 h-20 w-20">
          <div className="absolute inset-0 rounded-full border border-line-strong" />
          <div className="absolute inset-2 rounded-full border border-line" />
          <Compass size={26} strokeWidth={1.25} className="absolute inset-0 m-auto text-accent" />
          <div className="absolute -top-2 left-1/2 -translate-x-1/2 coord-label text-ink-muted">N</div>
          <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 coord-label text-ink-faint">S</div>
          <div className="absolute -left-2 top-1/2 -translate-y-1/2 coord-label text-ink-faint">W</div>
          <div className="absolute -right-2 top-1/2 -translate-y-1/2 coord-label text-ink-faint">E</div>
        </div>

        <p className="label-cap text-accent mb-3">{configured ? 'Vacant Atlas' : 'New Survey'}</p>
        <h1
          className="font-display text-[32px] leading-[1.05] text-ink mb-3 tracking-tightest"
          style={{ fontVariationSettings: "'opsz' 36, 'SOFT' 40" }}
        >
          {configured ? 'No territory to chart yet.' : 'Begin your atlas.'}
        </h1>
        <p className="text-[13px] text-ink-muted leading-relaxed mb-6 max-w-[340px] mx-auto">
          {configured
            ? 'The folder was found but contained no projects to survey. Add a project there or adjust the exclude patterns.'
            : 'Point OPEN GROUND at your projects folder. Each subdirectory becomes a tile on the canvas — assign chats, run them through Claude Code, verify the results.'}
        </p>
        <Btn variant="primary" size="md" onClick={onConfigure}>
          {configured ? 'Open settings' : 'Configure folder'}
        </Btn>

        {/* Readiness note: OPEN GROUND spawns the local `claude` CLI
            (subscription-only). Warn loudly if it's missing; otherwise a quiet
            reminder of the prerequisite. */}
        {claudeMissing ? (
          <div className="mt-7 mx-auto max-w-[360px] flex items-start gap-2 rounded-[3px] border border-accent/40 bg-accent/5 px-3.5 py-3 text-left">
            <AlertCircle size={14} className="mt-[1px] shrink-0 text-accent" />
            <p className="text-[11.5px] text-ink-muted leading-relaxed">
              The <code className="font-mono text-ink">claude</code> CLI wasn't
              found. OPEN GROUND runs your local Claude Code CLI — install it and
              sign in with an active Claude subscription before launching a run.
            </p>
          </div>
        ) : (
          <p className="mt-7 mx-auto max-w-[340px] inline-flex items-center gap-1.5 text-[11px] text-ink-faint leading-relaxed">
            <Terminal size={11} className="shrink-0" />
            Needs the local <code className="font-mono text-ink-subtle">claude</code> CLI, signed in with a Claude subscription.
          </p>
        )}
      </div>
    </div>
  )
}

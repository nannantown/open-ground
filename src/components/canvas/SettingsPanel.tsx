import { useEffect, useState } from 'react'
import {
  X,
  FolderOpen,
  ChevronRight,
  Check,
  AlertCircle,
  Loader2,
  Terminal,
} from 'lucide-react'
import { Btn } from '@/components/ui/Btn'
import type { Settings } from '@/lib/types'
import { api } from '@/lib/api-client'
import { useClaudeProbe } from '@/lib/useClaudeProbe'

interface Props {
  open: boolean
  settings: Settings
  onClose: () => void
  onSave: (s: Settings) => void
}

interface FolderInfo {
  exists: boolean
  projectCount: number
  notDir?: boolean
}

export const SettingsPanel = ({ open, settings, onClose, onSave }: Props) => {
  const [projectsRoot, setProjectsRoot] = useState(settings.projectsRoot ?? '')
  const [excludePatterns, setExcludePatterns] = useState(
    settings.excludePatterns.join(', '),
  )
  const [archiveDirName, setArchiveDirName] = useState(settings.archiveDirName)
  const [runPromptTemplate, setRunPromptTemplate] = useState(
    settings.runPromptTemplate,
  )
  const [notifyOnRunComplete, setNotifyOnRunComplete] = useState(
    settings.notifyOnRunComplete !== false,
  )
  const [notifySound, setNotifySound] = useState(settings.notifySound !== false)
  const [claudePlan, setClaudePlan] = useState<Settings['claudePlan']>(
    settings.claudePlan ?? null,
  )
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [picking, setPicking] = useState(false)
  const [checking, setChecking] = useState(false)
  const [info, setInfo] = useState<FolderInfo | null>(null)
  // Probe the local `claude` CLI while the panel is open. `claudeNonce` lets
  // the user re-check after installing it without closing the panel.
  const [claudeNonce, setClaudeNonce] = useState(0)
  const claudeProbe = useClaudeProbe(open, claudeNonce)

  // Verify the folder (debounced) so the user gets feedback before saving.
  useEffect(() => {
    const path = projectsRoot.trim()
    if (!path) {
      setInfo(null)
      setChecking(false)
      return
    }
    setChecking(true)
    const t = setTimeout(async () => {
      try {
        const res = await fetch(
          '/api/folder-info?path=' + encodeURIComponent(path),
        )
        setInfo((await res.json()) as FolderInfo)
      } catch {
        setInfo(null)
      }
      setChecking(false)
    }, 450)
    return () => clearTimeout(t)
  }, [projectsRoot])

  if (!open) return null

  const browse = async () => {
    setPicking(true)
    try {
      const res = await api.api['pick-folder'].$post()
      const data = (await res.json()) as { path?: string }
      if (data.path) setProjectsRoot(data.path)
    } catch {
      /* user can still type the path manually */
    }
    setPicking(false)
  }

  const save = () => {
    onSave({
      ...settings,
      projectsRoot: projectsRoot.trim() || null,
      excludePatterns: excludePatterns
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      archiveDirName: archiveDirName.trim() || '_archive',
      runPromptTemplate,
      notifyOnRunComplete,
      notifySound,
      claudePlan,
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex flex-col w-[520px] max-w-[92vw] max-h-[88vh] bg-bg-card border border-line shadow-card-hover overflow-hidden rounded-[3px]"
      >
        <header className="shrink-0 rule-double flex items-baseline justify-between px-6 pt-5 pb-4">
          <div>
            <p className="label-cap text-accent mb-1.5">Configuration</p>
            <h2
              className="font-display text-[22px] text-ink leading-none tracking-tightest"
              style={{ fontVariationSettings: "'opsz' 24, 'SOFT' 40" }}
            >
              Settings
            </h2>
          </div>
          <Btn variant="icon" size="sm" onClick={onClose}>
            <X size={16} />
          </Btn>
        </header>

        <div className="overflow-y-auto px-6 py-5">
          {/* Primary setting — the only thing most people need to touch. */}
          <div>
            <label className="label-cap text-ink-muted block mb-1.5">
              Projects folder
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={projectsRoot}
                onChange={(e) => setProjectsRoot(e.target.value)}
                placeholder="/Users/you/projects"
                className="flex-1 min-w-0 rounded-[2px] border border-line bg-bg px-3 py-2 font-mono text-[12px] text-ink placeholder:text-ink-faint focus:outline-none focus:border-accent"
              />
              <button
                onClick={browse}
                disabled={picking}
                className="shrink-0 inline-flex items-center gap-1.5 rounded-[2px] border border-line-strong bg-bg-elevated px-3 py-2 label-cap text-ink-muted hover:text-ink hover:bg-bg-inset hover:border-ink-subtle disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {picking ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <FolderOpen size={13} />
                )}
                Browse
              </button>
            </div>
            <div className="mt-1.5 min-h-[17px] text-[11px] leading-relaxed">
              {checking && <span className="text-ink-subtle">Checking…</span>}
              {!checking && info?.exists && (
                <span className="inline-flex items-center gap-1 text-moss">
                  <Check size={12} strokeWidth={2.5} />
                  {info.projectCount} project
                  {info.projectCount === 1 ? '' : 's'} found in this folder
                </span>
              )}
              {!checking && info && !info.exists && (
                <span className="inline-flex items-center gap-1 text-accent">
                  <AlertCircle size={12} />
                  {info.notDir
                    ? 'That path is a file, not a folder.'
                    : "That folder doesn't exist on this machine."}
                </span>
              )}
              {!checking && !info && (
                <span className="text-ink-subtle">
                  Click Browse to choose the folder that holds your projects —
                  each subfolder becomes a tile.
                </span>
              )}
            </div>
          </div>

          {/* Claude Code CLI readiness — OPEN GROUND spawns the local `claude`
              CLI (subscription-only, no API key), so runs fail until it's
              installed + authenticated. A green check when present; a clear
              hint + re-check button when missing. */}
          <div className="mt-5 border-t border-line pt-4">
            <div className="flex items-center justify-between mb-1.5">
              <p className="label-cap text-ink-muted inline-flex items-center gap-1.5">
                <Terminal size={12} />
                Claude Code CLI
              </p>
              <button
                onClick={() => setClaudeNonce((n) => n + 1)}
                className="label-cap text-ink-subtle hover:text-ink transition-colors"
              >
                Re-check
              </button>
            </div>
            <div className="text-[11px] leading-relaxed">
              {claudeProbe === null && (
                <span className="inline-flex items-center gap-1 text-ink-subtle">
                  <Loader2 size={12} className="animate-spin" />
                  Checking for the claude CLI…
                </span>
              )}
              {claudeProbe?.installed && (
                <span className="inline-flex items-center gap-1 text-moss">
                  <Check size={12} strokeWidth={2.5} />
                  {claudeProbe.message}
                </span>
              )}
              {claudeProbe && !claudeProbe.installed && (
                <div className="inline-flex items-start gap-1 text-accent">
                  <AlertCircle size={12} className="mt-[2px] shrink-0" />
                  <span>{claudeProbe.message}</span>
                </div>
              )}
            </div>
            <p className="mt-2 text-[11px] text-ink-subtle leading-relaxed">
              OPEN GROUND runs your local{' '}
              <code className="font-mono text-ink-muted">claude</code> CLI — it
              never uses an Anthropic API key. Install Claude Code, sign in, and
              keep an active Claude subscription, then runs work from any tile.
            </p>
          </div>

          {/* Claude Code usage — drives the top-right HUD chip. */}
          <div className="mt-5 border-t border-line pt-4">
            <p className="label-cap text-ink-muted mb-2">Claude Code plan</p>
            <div className="flex flex-wrap gap-1.5">
              {([
                ['none', 'None'],
                ['pro', 'Pro'],
                ['max5x', 'Max 5×'],
                ['max20x', 'Max 20×'],
              ] as const).map(([key, label]) => {
                const value = key === 'none' ? null : key
                const active = (claudePlan ?? null) === value
                return (
                  <button
                    key={key}
                    onClick={() => setClaudePlan(value)}
                    className={[
                      'h-7 px-2.5 rounded-[2px] border text-[12px] transition-colors',
                      active
                        ? 'bg-accent text-bg border-accent'
                        : 'bg-bg border-line text-ink-muted hover:text-ink hover:border-ink-subtle',
                    ].join(' ')}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
            <p className="mt-2 text-[11px] text-ink-subtle leading-relaxed">
              Drives the % shown in the top-right HUD. Anthropic does not
              publish exact per-window limits; the percentage is based on
              community estimates (~44k / 220k / 880k tokens per 5-hour window).
              Pick None to show raw token counts instead.
            </p>
          </div>

          {/* Notifications — small enough to stay outside Advanced. */}
          <div className="mt-5 border-t border-line pt-4 space-y-2">
            <p className="label-cap text-ink-muted mb-1">Notifications</p>
            <ToggleRow
              checked={notifyOnRunComplete}
              onChange={setNotifyOnRunComplete}
              label="Notify when a task run finishes"
              hint="Skipped while you're already viewing that project."
            />
            <ToggleRow
              checked={notifySound}
              onChange={setNotifySound}
              disabled={!notifyOnRunComplete}
              label="Play a soft sound"
              hint="A brief chirp alongside the notification."
            />
          </div>

          {/* Everything below has working defaults. */}
          <div className="mt-5 border-t border-line pt-4">
            <button
              onClick={() => setShowAdvanced((v) => !v)}
              className="inline-flex items-center gap-1.5 label-cap text-ink-muted hover:text-ink transition-colors"
            >
              <ChevronRight
                size={13}
                className={
                  'transition-transform duration-150 ' +
                  (showAdvanced ? 'rotate-90' : '')
                }
              />
              Advanced settings
            </button>

            {showAdvanced && (
              <div className="space-y-5 mt-4">
                <Field
                  label="Archive directory"
                  hint="Folder name that archived projects are moved into, created inside your projects folder."
                >
                  <input
                    type="text"
                    value={archiveDirName}
                    onChange={(e) => setArchiveDirName(e.target.value)}
                    className="w-full rounded-[2px] border border-line bg-bg px-3 py-2 font-mono text-[12px] text-ink focus:outline-none focus:border-accent"
                  />
                </Field>

                <Field
                  label="Exclude patterns"
                  hint="Comma-separated folder names skipped while scanning — dependencies, build output, and the like."
                >
                  <input
                    type="text"
                    value={excludePatterns}
                    onChange={(e) => setExcludePatterns(e.target.value)}
                    className="w-full rounded-[2px] border border-line bg-bg px-3 py-2 font-mono text-[12px] text-ink focus:outline-none focus:border-accent"
                  />
                </Field>

                <Field
                  label="Run prompt template"
                  hint="Sent to claude -p for each project. {{tasks}} = open tasks · {{description}} = project description · {{notes}} = project notes · {{name}} = project name."
                >
                  <textarea
                    value={runPromptTemplate}
                    onChange={(e) => setRunPromptTemplate(e.target.value)}
                    className="w-full min-h-[120px] rounded-[2px] border border-line bg-bg px-3 py-2 font-mono text-[12px] text-ink focus:outline-none focus:border-accent resize-y leading-relaxed"
                  />
                </Field>
              </div>
            )}
          </div>
        </div>

        <div className="shrink-0 flex items-center justify-end gap-2 border-t border-line bg-bg-elevated px-6 py-3.5">
          <Btn variant="subtle" size="md" onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" size="md" onClick={save}>Save</Btn>
        </div>
      </div>
    </div>
  )
}

const Field = ({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) => (
  <div>
    <label className="label-cap text-ink-muted block mb-1.5">{label}</label>
    {children}
    {hint && (
      <p className="mt-1.5 text-[11px] text-ink-subtle leading-relaxed">{hint}</p>
    )}
  </div>
)

// Compact label + native checkbox row — flexible toggle without the bulk of a
// custom switch. Disables together with its sibling when the parent is off.
const ToggleRow = ({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  hint?: string
  disabled?: boolean
}) => (
  <label
    className={[
      'flex items-start gap-2.5 py-1 -mx-1 px-1 rounded-[2px]',
      disabled
        ? 'cursor-not-allowed opacity-40'
        : 'cursor-pointer hover:bg-bg-inset/60',
    ].join(' ')}
  >
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      className="mt-[3px] h-3.5 w-3.5 shrink-0 cursor-[inherit] accent-accent"
    />
    <div className="min-w-0 leading-tight">
      <p className="text-[13px] text-ink">{label}</p>
      {hint && (
        <p className="mt-0.5 text-[11px] text-ink-subtle leading-relaxed">{hint}</p>
      )}
    </div>
  </label>
)

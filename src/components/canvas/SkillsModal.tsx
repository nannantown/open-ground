import { useEffect, useState } from 'react'
import { Loader2, Sparkles, X } from 'lucide-react'
import { Btn } from '@/components/ui/Btn'
import { useT } from '@/i18n/I18nContext'
import type { ProjectSkill, ProjectSkillsResponse } from '@/lib/types'

// "Skills" modal — opened from the ProjectPanel header. Read-only list of the
// Claude Code skills defined INSIDE this project (.claude/skills/<name>/SKILL.md),
// fetched from GET /api/project/skills. (The user's GLOBAL skills live on the
// Ground Toolbar's Skills panel, not here.) Each row shows name + description +
// path. OPEN GROUND never runs a skill — the user's own `claude` CLI does.

interface Props {
  open: boolean
  path: string
  projectName: string
  onClose: () => void
}

type Load =
  | { state: 'loading' }
  | { state: 'error'; error: string }
  | { state: 'done'; skills: ProjectSkill[] }

export const SkillsModal = ({ open, path, projectName, onClose }: Props) => {
  const { t } = useT()
  const [load, setLoad] = useState<Load>({ state: 'loading' })

  // Fresh fetch every time the modal opens.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoad({ state: 'loading' })
    fetch(`/api/project/skills?path=${encodeURIComponent(path)}`)
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as
          | ProjectSkillsResponse
          | { error?: string }
        if (cancelled) return
        if (!res.ok || !('skills' in body)) {
          setLoad({ state: 'error', error: ('error' in body && body.error) || res.statusText })
          return
        }
        setLoad({ state: 'done', skills: body.skills })
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setLoad({
            state: 'error',
            error: e instanceof Error ? e.message : t('projectPanel.networkError'),
          })
        }
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, path])

  // Escape closes from anywhere (the backdrop click handles the mouse).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const count = load.state === 'done' ? load.skills.length : null

  return (
    <div
      data-esc-overlay
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[82vh] w-[560px] max-w-[94vw] flex-col overflow-hidden rounded-[3px] border border-line bg-bg-card shadow-card-hover"
      >
        <header className="rule-double flex shrink-0 items-start justify-between px-6 pt-5 pb-4">
          <div className="min-w-0">
            <p className="label-cap mb-1.5 flex items-center gap-1.5 text-accent">
              <Sparkles size={12} strokeWidth={2} />
              {t('projectPanel.skillsModalTitle')}
              {count !== null && count > 0 && (
                <span className="tabular-nums text-ink-faint">({count})</span>
              )}
            </p>
            <p className="truncate font-mono text-[12px] text-ink-muted" title={projectName}>
              {projectName}
            </p>
          </div>
          <Btn variant="icon" size="sm" onClick={onClose} aria-label={t('common.close')}>
            <X size={16} />
          </Btn>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {load.state === 'loading' && (
            <p className="flex items-center gap-2 text-[12px] text-ink-faint">
              <Loader2 size={12} className="animate-spin" /> {t('projectPanel.loading')}
            </p>
          )}

          {load.state === 'error' && (
            <p className="text-[12px] leading-relaxed text-accent">
              {t('projectPanel.skillsLoadFailed', { error: load.error })}
            </p>
          )}

          {load.state === 'done' &&
            (load.skills.length === 0 ? (
              <div className="space-y-2">
                <p className="text-[12px] leading-relaxed text-ink-muted">
                  {t('projectPanel.skillsEmptyProject')}
                </p>
                <code className="inline-block rounded-[2px] bg-bg-inset px-1.5 py-0.5 font-mono text-[11px] text-ink-faint">
                  .claude/skills/&lt;name&gt;/SKILL.md
                </code>
              </div>
            ) : (
              <ul className="space-y-2">
                {load.skills.map((s) => (
                  <li key={s.id} className="rounded-[3px] border border-line bg-bg px-3 py-2.5">
                    <p className="font-display text-[14px] leading-tight text-ink">{s.name}</p>
                    {s.description && (
                      <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">
                        {s.description}
                      </p>
                    )}
                    <p
                      className="mt-1.5 truncate font-mono text-[10px] text-ink-faint"
                      title={s.file}
                    >
                      {s.file}
                    </p>
                  </li>
                ))}
              </ul>
            ))}
        </div>
      </div>
    </div>
  )
}

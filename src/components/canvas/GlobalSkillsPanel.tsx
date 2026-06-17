import { useEffect, useState } from 'react'
import { Loader2, Sparkles, X } from 'lucide-react'
import { Btn } from '@/components/ui/Btn'
import { useT } from '@/i18n/I18nContext'
import type {
  CreateSkillResponse,
  ProjectSkill,
  ProjectSkillsResponse,
} from '@/lib/types'

// Global skills panel — opened from the Ground Toolbar. Shows the user's OWN
// skills (~/.claude/skills, available in every project) and lets them ORDER a
// new one: type a description, press "Create", and a one-off `claude` session
// authors it (server-side, subscription PTY — same idea as the card's
// auto-description). When it returns, the new skill appears in the list.

interface Props {
  open: boolean
  onClose: () => void
}

type Load =
  | { state: 'loading' }
  | { state: 'error'; error: string }
  | { state: 'done'; skills: ProjectSkill[] }

export const GlobalSkillsPanel = ({ open, onClose }: Props) => {
  const { t } = useT()
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [request, setRequest] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // Best-effort refresh used AFTER a create — a hiccup here must not clobber the
  // optimistically-shown new skill, so a failed refresh leaves the list as-is.
  const refreshList = async (): Promise<void> => {
    const res = await fetch('/api/skills/global')
      .then((r) => (r.ok ? (r.json() as Promise<ProjectSkillsResponse>) : null))
      .catch(() => null)
    if (res && Array.isArray(res.skills)) setLoad({ state: 'done', skills: res.skills })
  }

  // Fresh list every time the panel opens.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoad({ state: 'loading' })
    setCreateError(null)
    void fetch('/api/skills/global')
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
      .catch(() => {
        if (!cancelled) setLoad({ state: 'error', error: t('projectPanel.networkError') })
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Escape closes — but NOT while a creation is in flight (don't strand the
  // server-side claude session / lose the user's typed request by accident).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !creating) {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, creating])

  const create = async () => {
    const req = request.trim()
    if (!req || creating) return
    setCreating(true)
    setCreateError(null)
    try {
      const res = await fetch('/api/skills/global/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ request: req }),
      })
      const body = (await res.json().catch(() => ({}))) as
        | CreateSkillResponse
        | { error?: string; claudeMissing?: boolean }
      if (!res.ok || !('skill' in body)) {
        setCreateError(
          'claudeMissing' in body && body.claudeMissing
            ? t('projectPanel.skillsClaudeMissing')
            : t('projectPanel.skillsCreateFailed', {
                error: ('error' in body && body.error) || res.statusText,
              }),
        )
        return
      }
      setRequest('')
      // Show the new skill immediately (even if the reconciling refresh hiccups),
      // then refresh in the background to pick up the authoritative list.
      setLoad((prev) => {
        const existing = prev.state === 'done' ? prev.skills : []
        return {
          state: 'done',
          skills: [body.skill, ...existing.filter((s) => s.id !== body.skill.id)],
        }
      })
      void refreshList()
    } catch (e: unknown) {
      setCreateError(
        t('projectPanel.skillsCreateFailed', {
          error: e instanceof Error ? e.message : t('projectPanel.networkError'),
        }),
      )
    } finally {
      setCreating(false)
    }
  }

  if (!open) return null

  return (
    <div
      data-esc-overlay
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4 backdrop-blur-sm"
      onClick={() => {
        if (!creating) onClose()
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[82vh] w-[560px] max-w-[94vw] flex-col overflow-hidden rounded-[3px] border border-line bg-bg-card shadow-card-hover"
      >
        <header className="rule-double flex shrink-0 items-start justify-between px-6 pt-5 pb-4">
          <div className="min-w-0">
            <p className="label-cap mb-1.5 flex items-center gap-1.5 text-accent">
              <Sparkles size={12} strokeWidth={2} />
              {t('projectPanel.skillsPanelTitle')}
            </p>
            <p className="font-mono text-[12px] text-ink-muted">
              {t('projectPanel.skillsPanelSubtitle')}
            </p>
          </div>
          <Btn variant="icon" size="sm" onClick={onClose} disabled={creating} aria-label={t('common.close')}>
            <X size={16} />
          </Btn>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
          {/* ── Create a skill (the "order") ─────────────────────────────── */}
          <section>
            <label className="mb-1.5 block label-cap text-ink-muted" htmlFor="skill-request">
              {t('projectPanel.skillsCreateLabel')}
            </label>
            <textarea
              id="skill-request"
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              disabled={creating}
              rows={3}
              placeholder={t('projectPanel.skillsCreatePlaceholder')}
              className="w-full resize-y rounded-[3px] border border-line bg-bg px-2.5 py-2 text-[13px] leading-relaxed text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none disabled:opacity-50"
            />
            <div className="mt-2 flex items-center justify-between gap-3">
              <span className="text-[11px] leading-relaxed text-ink-faint">
                {creating ? t('projectPanel.skillsCreating') : t('projectPanel.skillsCreateHint')}
              </span>
              <Btn
                variant="primary"
                size="sm"
                onClick={() => void create()}
                disabled={!request.trim() || creating}
                className="shrink-0 whitespace-nowrap"
              >
                {creating ? (
                  <>
                    <Loader2 size={12} className="animate-spin" />
                    {t('projectPanel.skillsCreating')}
                  </>
                ) : (
                  t('projectPanel.skillsCreateButton')
                )}
              </Btn>
            </div>
            {createError && (
              <p className="mt-2 text-[12px] leading-relaxed text-accent">{createError}</p>
            )}
          </section>

          {/* ── The user's global skills ─────────────────────────────────── */}
          <section>
            <h3 className="mb-1.5 flex items-center gap-1.5 label-cap text-ink-muted">
              {t('projectPanel.skillsSectionGlobal')}
              {load.state === 'done' && load.skills.length > 0 && (
                <span className="tabular-nums text-ink-faint">({load.skills.length})</span>
              )}
            </h3>

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
                <p className="text-[12px] leading-relaxed text-ink-muted">
                  {t('projectPanel.skillsEmptyGlobal')}
                </p>
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
          </section>
        </div>
      </div>
    </div>
  )
}

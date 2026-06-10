import { useEffect, useRef, useState } from 'react'
import { X, Loader2, FolderPlus, Folder } from 'lucide-react'
import { Btn } from '@/components/ui/Btn'
import { api } from '@/lib/api-client'
import { useT } from '@/i18n/I18nContext'

interface Props {
  open: boolean
  /** Remembered parent dir for new folders. Null until the user picks one. */
  defaultWorkspace: string | null
  onClose: () => void
  /** Called after the folder is created + registered. Receives the new
   *  project's stable registry id (the server canonicalizes the path, so the id
   *  is the reliable handle for re-selecting the card). */
  onCreated: (id: string) => void
}

export const NewProjectModal = ({ open, defaultWorkspace, onClose, onCreated }: Props) => {
  const { t } = useT()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [workspace, setWorkspace] = useState<string | null>(defaultWorkspace)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  // Fresh form whenever the modal reopens.
  useEffect(() => {
    if (open) {
      setName('')
      setDescription('')
      setWorkspace(defaultWorkspace)
      setError(null)
      setBusy(false)
      // Defer to next tick so the input is mounted before focus.
      setTimeout(() => nameRef.current?.focus(), 0)
    }
  }, [open, defaultWorkspace])

  if (!open) return null

  // Native folder picker for choosing where new projects live. Stores the
  // chosen path and returns it (or null if cancelled).
  const pickWorkspace = async (): Promise<string | null> => {
    try {
      const res = await api.api['pick-folder'].$post()
      const data = (await res.json().catch(() => ({}))) as {
        path?: string
        cancelled?: boolean
        error?: string
      }
      if (data.cancelled || !data.path) {
        if (data.error) setError(data.error)
        return null
      }
      setWorkspace(data.path)
      setError(null)
      return data.path
    } catch (e: any) {
      setError(e?.message ?? t('modals.newProject.pickerFailed'))
      return null
    }
  }

  const submit = async () => {
    const clean = name.trim()
    if (!clean || busy) return
    // A location is required — prompt for one first, then continue with it.
    let ws = workspace
    if (!ws) {
      ws = await pickWorkspace()
      if (!ws) return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await api.api.projects.new.$post({
        json: { name: clean, description: description.trim(), workspace: ws },
      })
      const data = (await res.json()) as { error?: string; path?: string; id?: string }
      if (!res.ok) {
        setError(data.error ?? t('modals.newProject.createFailed'))
        setBusy(false)
        return
      }
      onCreated(data.id as string)
    } catch (e: any) {
      setError(e?.message ?? t('modals.newProject.createFailed'))
      setBusy(false)
    }
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKey}
        className="flex flex-col w-[460px] max-w-[92vw] bg-bg-card border border-line shadow-card-hover overflow-hidden rounded-[3px]"
      >
        <header className="shrink-0 rule-double flex items-baseline justify-between px-6 pt-5 pb-4">
          <div>
            <p className="label-cap text-accent mb-1.5">{t('modals.newProject.label')}</p>
            <h2
              className="font-display text-[22px] text-ink leading-none tracking-tightest"
              style={{ fontVariationSettings: "'opsz' 24, 'SOFT' 40" }}
            >
              {t('modals.newProject.title')}
            </h2>
          </div>
          <Btn variant="icon" size="sm" onClick={onClose} aria-label={t('common.close')}>
            <X size={16} />
          </Btn>
        </header>

        <div className="px-6 py-5 space-y-4">
          <div>
            <label className="label-cap text-ink-muted block mb-1.5">
              {t('modals.newProject.folderNameLabel')}
            </label>
            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-new-project"
              className="w-full rounded-[2px] border border-line bg-bg px-3 py-2 font-mono text-[12px] text-ink placeholder:text-ink-faint focus:outline-none focus:border-accent"
            />
            <div className="mt-1.5 flex items-center justify-between gap-2">
              {workspace ? (
                <p className="min-w-0 flex-1 text-[11px] font-mono text-ink-subtle truncate">
                  {workspace.replace(/\/$/, '')}/<span className="text-ink-muted">{name || '…'}</span>
                </p>
              ) : (
                <p className="min-w-0 flex-1 text-[11px] text-ink-faint truncate">
                  {t('modals.newProject.chooseLocation')}
                </p>
              )}
              <button
                type="button"
                onClick={pickWorkspace}
                className="shrink-0 inline-flex items-center gap-1 rounded-[2px] border border-line px-2 py-1 text-[10.5px] text-ink-muted hover:text-ink hover:border-line-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent transition-colors"
              >
                <Folder size={11} />
                {workspace ? t('modals.newProject.change') : t('modals.newProject.chooseLocationBtn')}
              </button>
            </div>
          </div>

          <div>
            <label className="label-cap text-ink-muted block mb-1.5">
              {t('modals.newProject.descriptionLabel')} <span className="text-ink-faint normal-case tracking-normal">{t('modals.newProject.descriptionOptional')}</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('modals.newProject.descriptionPlaceholder')}
              className="w-full min-h-[72px] rounded-[2px] border border-line bg-bg px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:outline-none focus:border-accent resize-y leading-relaxed"
            />
          </div>

          {error && (
            <p className="text-[12px] text-accent leading-relaxed">{error}</p>
          )}
        </div>

        <div className="shrink-0 flex items-center justify-end gap-2 border-t border-line bg-bg-elevated px-6 py-3.5">
          <Btn variant="subtle" size="md" onClick={onClose} disabled={busy}>{t('common.cancel')}</Btn>
          <Btn variant="primary" size="md" onClick={submit} disabled={busy || !name.trim()}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <FolderPlus size={13} />}
            {t('modals.newProject.create')}
          </Btn>
        </div>
      </div>
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { Loader2, FolderPlus, Folder } from 'lucide-react'
import { Btn } from '@/components/ui/Btn'
import { Overlay, DialogCard, DialogHeader } from '@/components/ui/overlay'
import { api } from '@/lib/api-client'
import { pickFolder } from '@/lib/pickFolder'
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
  // chosen path and returns it (or null if cancelled). pickFolder uses the
  // Electron dialog under the desktop app (cross-platform) and falls back to the
  // server's osascript route in a plain dev browser — see src/lib/pickFolder.ts.
  const pickWorkspace = async (): Promise<string | null> => {
    const data = await pickFolder()
    if (data.cancelled || !data.path) {
      if (data.error) setError(t('modals.newProject.pickerFailed'))
      return null
    }
    setWorkspace(data.path)
    setError(null)
    return data.path
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
    <Overlay onClose={onClose} closeOnEsc={false} aria-label={t('modals.newProject.title')}>
      <DialogCard
        className="w-[460px] max-w-[92vw]"
        onKeyDown={onKey}
        ariaLabel={t('modals.newProject.title')}
      >
        <DialogHeader
          align="baseline"
          eyebrow={t('modals.newProject.label')}
          title={
            <span style={{ fontVariationSettings: "'opsz' 24, 'SOFT' 40" }}>
              {t('modals.newProject.title')}
            </span>
          }
          titleClassName="font-display text-head text-ink tracking-tightest"
          onClose={onClose}
          closeLabel={t('common.close')}
        />

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
              className="w-full rounded-[2px] border border-line bg-bg px-3 py-2 font-mono text-ui text-ink placeholder:text-ink-faint focus:outline-none focus:border-accent"
            />
            <div className="mt-1.5 flex items-center justify-between gap-2">
              {workspace ? (
                <p className="min-w-0 flex-1 text-meta font-mono text-ink-subtle truncate">
                  {workspace.replace(/\/$/, '')}/<span className="text-ink-muted">{name || '…'}</span>
                </p>
              ) : (
                <p className="min-w-0 flex-1 text-meta text-ink-faint truncate">
                  {t('modals.newProject.chooseLocation')}
                </p>
              )}
              <button
                type="button"
                onClick={pickWorkspace}
                className="shrink-0 inline-flex items-center gap-1 rounded-[2px] border border-line px-2 py-1 text-micro text-ink-muted hover:text-ink hover:border-line-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent transition-colors"
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
              className="w-full min-h-[72px] rounded-[2px] border border-line bg-bg px-3 py-2 text-ui text-ink placeholder:text-ink-faint focus:outline-none focus:border-accent resize-y leading-relaxed"
            />
          </div>

          {error && (
            <p className="text-ui text-accent leading-relaxed">{error}</p>
          )}
        </div>

        <div className="shrink-0 flex items-center justify-end gap-2 border-t border-line bg-bg-elevated px-6 py-3.5">
          <Btn variant="subtle" size="md" onClick={onClose} disabled={busy}>{t('common.cancel')}</Btn>
          <Btn variant="primary" size="md" onClick={submit} disabled={busy || !name.trim()}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <FolderPlus size={13} />}
            {t('modals.newProject.create')}
          </Btn>
        </div>
      </DialogCard>
    </Overlay>
  )
}

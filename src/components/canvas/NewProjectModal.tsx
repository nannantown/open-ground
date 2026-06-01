import { useEffect, useRef, useState } from 'react'
import { X, Loader2, FolderPlus } from 'lucide-react'
import { Btn } from '@/components/ui/Btn'
import { api } from '@/lib/api-client'

interface Props {
  open: boolean
  projectsRoot: string | null
  onClose: () => void
  /** Called after the folder is created on disk. Receives the new absolute path. */
  onCreated: (path: string) => void
}

export const NewProjectModal = ({ open, projectsRoot, onClose, onCreated }: Props) => {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  // Fresh form whenever the modal reopens.
  useEffect(() => {
    if (open) {
      setName('')
      setDescription('')
      setError(null)
      setBusy(false)
      // Defer to next tick so the input is mounted before focus.
      setTimeout(() => nameRef.current?.focus(), 0)
    }
  }, [open])

  if (!open) return null

  const submit = async () => {
    const clean = name.trim()
    if (!clean || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.api.projects.new.$post({
        json: { name: clean, description: description.trim() },
      })
      const data = (await res.json()) as { error?: string; path?: string }
      if (!res.ok) {
        setError(data.error ?? 'Failed to create project')
        setBusy(false)
        return
      }
      onCreated(data.path as string)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to create project')
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
            <p className="label-cap text-accent mb-1.5">Create</p>
            <h2
              className="font-display text-[22px] text-ink leading-none tracking-tightest"
              style={{ fontVariationSettings: "'opsz' 24, 'SOFT' 40" }}
            >
              New project
            </h2>
          </div>
          <Btn variant="icon" size="sm" onClick={onClose} aria-label="Close">
            <X size={16} />
          </Btn>
        </header>

        <div className="px-6 py-5 space-y-4">
          <div>
            <label className="label-cap text-ink-muted block mb-1.5">
              Folder name
            </label>
            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-new-project"
              className="w-full rounded-[2px] border border-line bg-bg px-3 py-2 font-mono text-[12px] text-ink placeholder:text-ink-faint focus:outline-none focus:border-accent"
            />
            {projectsRoot && (
              <p className="mt-1.5 text-[11px] font-mono text-ink-subtle truncate">
                {projectsRoot.replace(/\/$/, '')}/<span className="text-ink-muted">{name || '…'}</span>
              </p>
            )}
          </div>

          <div>
            <label className="label-cap text-ink-muted block mb-1.5">
              Description <span className="text-ink-faint normal-case tracking-normal">(optional)</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="ひとことでOK（あとから直せます）"
              className="w-full min-h-[72px] rounded-[2px] border border-line bg-bg px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:outline-none focus:border-accent resize-y leading-relaxed"
            />
          </div>

          {error && (
            <p className="text-[12px] text-accent leading-relaxed">{error}</p>
          )}
        </div>

        <div className="shrink-0 flex items-center justify-end gap-2 border-t border-line bg-bg-elevated px-6 py-3.5">
          <Btn variant="subtle" size="md" onClick={onClose} disabled={busy}>Cancel</Btn>
          <Btn variant="primary" size="md" onClick={submit} disabled={busy || !name.trim() || !projectsRoot}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <FolderPlus size={13} />}
            Create
          </Btn>
        </div>
      </div>
    </div>
  )
}

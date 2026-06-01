import { useState } from 'react'
import { Archive, Trash2, X } from 'lucide-react'
import { Btn } from '@/components/ui/Btn'
import type { ProjectMeta } from '@/lib/types'

interface Props {
  projects: ProjectMeta[]
  onClear: () => void
  onReload: () => void
}

// Floating bar shown when 2+ projects are selected (Shift+click). Bulk
// Archive / Delete go through a confirmation modal that lists the projects.
export const BulkActionBar = ({ projects, onClear, onReload }: Props) => {
  const [confirming, setConfirming] = useState<null | 'archive' | 'delete'>(null)
  const [busy, setBusy] = useState(false)
  // Failures surface inline in the modal instead of a native alert, so a partial
  // failure stays readable (which projects failed) rather than being dismissed.
  const [error, setError] = useState<string | null>(null)

  const openConfirm = (kind: 'archive' | 'delete') => {
    setError(null)
    setConfirming(kind)
  }
  const closeConfirm = () => {
    setError(null)
    setConfirming(null)
  }

  const applyBulk = async (endpoint: string) => {
    setBusy(true)
    setError(null)
    const failed: string[] = []
    for (const p of projects) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: p.path }),
        })
        if (!res.ok) failed.push(p.name)
      } catch {
        failed.push(p.name)
      }
    }
    setBusy(false)
    // Reload either way so any projects that DID succeed drop off the canvas.
    onReload()
    if (failed.length) {
      // Keep the modal open with the failed list; the user can retry or cancel.
      setError(`Failed for: ${failed.join(', ')}`)
      return
    }
    onClear()
    setConfirming(null)
  }

  return (
    <>
      <div className="pointer-events-none fixed bottom-0 left-1/2 z-30 -translate-x-1/2 p-5">
        <div className="pointer-events-auto flex items-center gap-1 rounded-[3px] border border-line bg-bg-card/95 px-2 py-1.5 shadow-card-hover backdrop-blur">
          <span className="px-2 label-cap text-ink-muted tabular-nums">
            {projects.length} selected
          </span>
          <span className="h-4 w-px bg-line-soft" />
          <Btn variant="subtle" size="sm" onClick={() => openConfirm('archive')}>
            <Archive size={12} /> Archive
          </Btn>
          <Btn variant="subtle" size="sm" danger onClick={() => openConfirm('delete')}>
            <Trash2 size={12} /> Delete
          </Btn>
          <span className="h-4 w-px bg-line-soft" />
          <Btn variant="icon" size="md" onClick={onClear} title="Clear selection">
            <X size={14} />
          </Btn>
        </div>
      </div>

      {confirming && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 backdrop-blur-sm"
          onClick={() => !busy && closeConfirm()}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="flex max-h-[80vh] w-[460px] max-w-[92vw] flex-col overflow-hidden rounded-[3px] border border-line bg-bg-card shadow-card-hover"
          >
            <div className="rule-double px-6 pt-5 pb-4">
              <p className="label-cap text-accent mb-1.5">
                {confirming === 'delete' ? 'Delete projects' : 'Archive projects'}
              </p>
              <h2 className="font-display text-[21px] leading-snug text-ink tracking-tightest">
                {confirming === 'delete'
                  ? `Move ${projects.length} projects to the Trash?`
                  : `Archive ${projects.length} projects?`}
              </h2>
              <p className="mt-2 text-[12px] leading-relaxed text-ink-muted">
                {confirming === 'delete'
                  ? 'Each folder is moved to the macOS Trash — removed from OPEN GROUND, but restorable from Finder.'
                  : 'Each folder is moved into the archive folder. You can restore it later from its card.'}
              </p>
            </div>
            <ul className="flex-1 divide-y divide-line-soft overflow-y-auto px-6 py-2">
              {projects.map((p) => (
                <li
                  key={p.id}
                  className="truncate py-1.5 font-mono text-[12px] text-ink"
                >
                  {p.name}
                </li>
              ))}
            </ul>
            {error && (
              <p className="border-t border-line px-6 pt-3 text-[11px] leading-relaxed text-accent">
                {error}
              </p>
            )}
            <div className="flex items-center justify-end gap-2 border-t border-line bg-bg-elevated px-6 py-3.5">
              <Btn variant="subtle" size="md" onClick={closeConfirm} disabled={busy}>Cancel</Btn>
              <Btn
                variant="primary"
                size="md"
                onClick={() => applyBulk(confirming === 'delete' ? '/api/project/delete' : '/api/project/archive')}
                disabled={busy}
              >
                {busy
                  ? 'Working…'
                  : confirming === 'delete'
                    ? `Delete ${projects.length}`
                    : `Archive ${projects.length}`}
              </Btn>
            </div>
          </div>
        </div>
      )}
    </>
  )
}


import { useState } from 'react'
import { Archive, Trash2, X } from 'lucide-react'
import { Btn } from '@/components/ui/Btn'
import { Overlay, DialogCard, DialogHeader } from '@/components/ui/overlay'
import { destroyFramesForProject } from '@/components/canvas/modules/CustomFrameHost'
import type { ProjectMeta } from '@/lib/types'

interface Props {
  projects: ProjectMeta[]
  onClear: () => void
  onReload: () => void
}

// Floating bar shown when 2+ projects are selected (Shift+click). Bulk
// "Remove from canvas" (unregister; folder untouched) / Delete (Trash) go
// through a confirmation modal that lists the projects.
export const BulkActionBar = ({ projects, onClear, onReload }: Props) => {
  const [confirming, setConfirming] = useState<null | 'remove' | 'delete'>(null)
  const [busy, setBusy] = useState(false)
  // Failures surface inline in the modal instead of a native alert, so a partial
  // failure stays readable (which projects failed) rather than being dismissed.
  const [error, setError] = useState<string | null>(null)

  const openConfirm = (kind: 'remove' | 'delete') => {
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
    // ⚠ CARRY THE SERVER'S REASON, not just the name. Delete now REFUSES (409)
    // while a claude session is still running in the project — it stops the
    // desks and waits, and declines rather than deleting a worktree out from
    // under a live process (which is how the 2026-07-28 machine freeze was
    // manufactured). That refusal is the one failure here the owner can act on,
    // and reporting it as a bare "Failed for: foo" throws away the only sentence
    // that says what to do about it.
    const reasons = new Map<string, string>()
    for (const p of projects) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: p.path }),
        })
        if (!res.ok) {
          failed.push(p.name)
          const why = await res
            .json()
            .then((b: { error?: unknown }) => (typeof b?.error === 'string' ? b.error : ''))
            .catch(() => '')
          if (why) reasons.set(p.name, why)
        }
        // Letting go of a project — bulk Remove AND Delete both do — tears
        // down the hosted custom-tab frames it owns (same invariant as the
        // panel delete / single remove paths), so audio started there can't
        // keep playing hidden. Per-project on SUCCESS only: a failed one is
        // still registered, its frames still legitimate.
        else destroyFramesForProject(p.path)
      } catch {
        failed.push(p.name)
      }
    }
    setBusy(false)
    // Reload either way so any projects that DID succeed drop off the canvas.
    onReload()
    if (failed.length) {
      // Keep the modal open with the failed list; the user can retry or cancel.
      // One line per project when the server explained itself, so a refusal that
      // names a running session reads as an instruction rather than a mystery.
      const explained = failed.map((n) => (reasons.has(n) ? `${n} — ${reasons.get(n)}` : n))
      setError(
        explained.length === 1 && reasons.size === 1
          ? explained[0]
          : `Failed for: ${explained.join(' / ')}`,
      )
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
          <Btn variant="subtle" size="sm" onClick={() => openConfirm('remove')}>
            <Archive size={12} /> Remove
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
        <Overlay
          onClose={() => {
            if (!busy) closeConfirm()
          }}
          aria-label={
            confirming === 'delete'
              ? `Move ${projects.length} projects to the Trash?`
              : `Remove ${projects.length} projects from the Ground?`
          }
        >
          <DialogCard
            className="w-[460px] max-w-[92vw] max-h-[80vh]"
            ariaLabel={
              confirming === 'delete'
                ? `Move ${projects.length} projects to the Trash?`
                : `Remove ${projects.length} projects from the Ground?`
            }
          >
            <DialogHeader separator="double" density="modal">
              <div className="min-w-0 flex-1">
                <p className="label-cap text-accent mb-1.5">
                  {confirming === 'delete' ? 'Delete projects' : 'Remove from Ground'}
                </p>
                <h2 className="font-display text-title leading-snug text-ink tracking-tightest">
                  {confirming === 'delete'
                    ? `Move ${projects.length} projects to the Trash?`
                    : `Remove ${projects.length} projects from the Ground?`}
                </h2>
                <p className="mt-2 text-ui leading-relaxed text-ink-muted">
                  {confirming === 'delete'
                    ? 'Each folder is moved to the macOS Trash — removed from OPEN GROUND, but restorable from Finder.'
                    : 'Each card is taken off the canvas. The folders stay on disk — re-import them anytime.'}
                </p>
              </div>
            </DialogHeader>
            <ul className="flex-1 divide-y divide-line-soft overflow-y-auto px-6 py-2">
              {projects.map((p) => (
                <li
                  key={p.id}
                  className="truncate py-1.5 font-mono text-ui text-ink"
                >
                  {p.name}
                </li>
              ))}
            </ul>
            {error && (
              <p className="border-t border-line px-6 pt-3 text-meta leading-relaxed text-accent">
                {error}
              </p>
            )}
            <div className="flex items-center justify-end gap-2 border-t border-line bg-bg-elevated px-6 py-3.5">
              <Btn variant="subtle" size="md" onClick={closeConfirm} disabled={busy}>Cancel</Btn>
              <Btn
                variant="primary"
                size="md"
                onClick={() => applyBulk(confirming === 'delete' ? '/api/project/delete' : '/api/projects/remove')}
                disabled={busy}
              >
                {busy
                  ? 'Working…'
                  : confirming === 'delete'
                    ? `Delete ${projects.length}`
                    : `Remove ${projects.length}`}
              </Btn>
            </div>
          </DialogCard>
        </Overlay>
      )}
    </>
  )
}


import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import type { CanvasSummary } from '@/lib/types'

interface Props {
  canvases: CanvasSummary[]
  activeId: string | null
  onSelect: (id: string) => void
  onCreate: () => void
  onDelete: (id: string) => void
  onRename: (id: string, name: string) => void
  onReorder: (order: string[]) => void
}

// Chrome-style tab strip for the Canvas tab. One tab per Canvas.
//  • click to switch
//  • double-click the name to rename inline
//  • × hover to delete (auto-recreates an empty Canvas if it was the last one)
//  • drag a tab onto another to reorder
//
// Visually thin (32px-ish) so it lives comfortably above the Canvas workspace
// without stealing too much drawing-surface height.
export const CanvasTabBar = ({
  canvases,
  activeId,
  onSelect,
  onCreate,
  onDelete,
  onRename,
  onReorder,
}: Props) => {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)

  const startRename = (c: CanvasSummary) => {
    setEditingId(c.id)
    setDraft(c.name)
  }
  const commitRename = () => {
    if (editingId) {
      const next = draft.trim()
      if (next) onRename(editingId, next)
    }
    setEditingId(null)
  }

  return (
    <div className="flex h-9 shrink-0 items-end gap-0.5 border-b border-line bg-bg-card px-2 pt-1">
      {canvases.map((c) => {
        const isActive = c.id === activeId
        const isEditing = editingId === c.id
        const isDragOver = dragOverId === c.id && dragId && dragId !== c.id
        return (
          <button
            key={c.id}
            type="button"
            draggable={!isEditing}
            onDragStart={(e) => {
              setDragId(c.id)
              e.dataTransfer.effectAllowed = 'move'
            }}
            onDragOver={(e) => {
              if (!dragId || dragId === c.id) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              setDragOverId(c.id)
            }}
            onDragLeave={() => {
              if (dragOverId === c.id) setDragOverId(null)
            }}
            onDrop={(e) => {
              e.preventDefault()
              if (!dragId || dragId === c.id) {
                setDragId(null)
                setDragOverId(null)
                return
              }
              const order = canvases.map((x) => x.id)
              const from = order.indexOf(dragId)
              const to = order.indexOf(c.id)
              if (from < 0 || to < 0) return
              order.splice(from, 1)
              order.splice(to, 0, dragId)
              onReorder(order)
              setDragId(null)
              setDragOverId(null)
            }}
            onDragEnd={() => {
              setDragId(null)
              setDragOverId(null)
            }}
            onClick={() => !isEditing && onSelect(c.id)}
            onDoubleClick={(e) => {
              e.stopPropagation()
              startRename(c)
            }}
            className={[
              'group relative flex h-8 max-w-[180px] min-w-[80px] items-center gap-1.5 rounded-t-[6px] border border-b-0 px-2.5 text-[12px] transition-colors',
              isActive
                ? 'border-line bg-bg text-ink'
                : 'border-transparent bg-transparent text-ink-muted hover:bg-bg/60 hover:text-ink',
              isDragOver ? 'ring-1 ring-accent' : '',
            ].join(' ')}
            title={isActive ? c.name : `Switch to ${c.name}`}
          >
            {isEditing ? (
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commitRename()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    setEditingId(null)
                  }
                }}
                className="min-w-0 flex-1 bg-transparent text-[12px] text-ink focus:outline-none"
              />
            ) : (
              <span className="min-w-0 flex-1 truncate text-left">{c.name}</span>
            )}
            <span
              role="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation()
                onDelete(c.id)
              }}
              title="この Canvas を閉じる"
              className={[
                'flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-ink-faint transition-opacity hover:bg-bg-inset hover:text-ink',
                isActive ? 'opacity-70' : 'opacity-0 group-hover:opacity-70',
              ].join(' ')}
            >
              <X size={10} strokeWidth={2} />
            </span>
          </button>
        )
      })}
      <button
        type="button"
        onClick={onCreate}
        title="新しい Canvas を作成"
        className="ml-1 flex h-7 w-7 items-center justify-center rounded-[4px] text-ink-muted transition-colors hover:bg-bg hover:text-ink"
      >
        <Plus size={13} strokeWidth={2} />
      </button>
    </div>
  )
}

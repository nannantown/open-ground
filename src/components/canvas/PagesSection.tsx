import { useState } from 'react'
import { ChevronDown, ChevronRight, Plus, X } from 'lucide-react'
import { useT } from '@/i18n/I18nContext'
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

// Figma-style "Pages" section at the top of the Canvas left sidebar — the
// vertical successor of the old Chrome-style CanvasTabBar. One row per Canvas.
//  • click to switch
//  • double-click the name to rename inline (Enter commits — IME-confirm
//    Enters excluded; Escape cancels; blur commits)
//  • hover ✕ (or right-click the row) arms an inline "Delete?" confirm —
//    deleting the last remaining Canvas is not offered
//  • drag a row onto another to reorder
// Collapsible; the list scrolls and the section caps at ~40% of the sidebar so
// the Layers section below always keeps the lion's share.
export const PagesSection = ({
  canvases,
  activeId,
  onSelect,
  onCreate,
  onDelete,
  onRename,
  onReorder,
}: Props) => {
  const { t } = useT()
  const [collapsed, setCollapsed] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  // Row id whose delete is armed — the ✕ becomes a "Delete?" confirm button.
  const [confirmId, setConfirmId] = useState<string | null>(null)

  const canDelete = canvases.length > 1

  const startRename = (c: CanvasSummary) => {
    // Re-entry guard: a dblclick INSIDE the rename input (word-select) bubbles
    // back to the row's onDoubleClick — restarting would wipe the typed draft.
    if (editingId === c.id) return
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
    <section className="flex max-h-[40%] shrink-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-1 py-1.5 pl-1.5 pr-2">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
          title={collapsed ? t('canvas.expand') : t('canvas.collapse')}
          className="flex min-w-0 items-center gap-1 rounded-[4px] px-1 py-0.5 text-ink-muted transition-colors hover:bg-bg-inset hover:text-ink active:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          {collapsed ? (
            <ChevronRight size={12} strokeWidth={2.25} className="shrink-0" />
          ) : (
            <ChevronDown size={12} strokeWidth={2.25} className="shrink-0" />
          )}
          <span className="label-cap">{t('canvas.pages')}</span>
        </button>
        <button
          type="button"
          onClick={onCreate}
          title={t('canvas.newCanvas')}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[4px] text-ink-muted transition-colors hover:bg-bg-inset hover:text-ink active:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <Plus size={13} strokeWidth={2} />
        </button>
      </div>
      {!collapsed && (
        <ul aria-label={t('canvas.pages')} className="min-h-0 overflow-y-auto pb-1">
          {canvases.map((c) => {
            const isActive = c.id === activeId
            const isEditing = editingId === c.id
            const isConfirming = confirmId === c.id
            const isDragOver = dragOverId === c.id && dragId && dragId !== c.id
            return (
              <li
                key={c.id}
                draggable={!isEditing}
                onDragStart={(e) => {
                  setDragId(c.id)
                  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
                }}
                onDragOver={(e) => {
                  if (!dragId || dragId === c.id) return
                  e.preventDefault()
                  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
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
                onContextMenu={(e) => {
                  if (!canDelete) return
                  e.preventDefault()
                  setConfirmId(c.id)
                }}
                onMouseLeave={() => {
                  if (confirmId === c.id) setConfirmId(null)
                }}
                className={[
                  'group flex items-center gap-1 pr-1.5 transition-colors',
                  isActive
                    ? 'bg-accent text-bg-card hover:bg-accent-hover'
                    : 'text-ink-muted hover:bg-bg-inset hover:text-ink',
                  isDragOver ? 'ring-1 ring-inset ring-accent' : '',
                ].join(' ')}
              >
                {isEditing ? (
                  // While renaming the row swaps its <button> for a <div> — an
                  // <input> may not live inside a button (invalid HTML; screen
                  // readers mangle "textbox inside button").
                  <div className="flex h-7 min-w-0 flex-1 items-center py-1 pl-3 text-[12px]">
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => e.stopPropagation()}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        // Don't steal the Enter that CONFIRMS an IME conversion
                        // (Japanese input) — committing then would cut the
                        // composition off. Only commit on a real Enter.
                        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                          e.preventDefault()
                          commitRename()
                        } else if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
                          e.preventDefault()
                          setEditingId(null)
                        }
                      }}
                      className={[
                        'min-w-0 flex-1 bg-transparent text-[12px] focus:outline-none',
                        isActive ? 'text-bg-card' : 'text-ink',
                      ].join(' ')}
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => onSelect(c.id)}
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      startRename(c)
                    }}
                    aria-current={isActive ? 'page' : undefined}
                    title={isActive ? c.name : t('canvas.switchToCanvas', { name: c.name })}
                    className={[
                      'flex h-7 min-w-0 flex-1 items-center py-1 pl-3 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset',
                      isActive ? 'focus-visible:ring-bg-card/70' : 'focus-visible:ring-accent/60',
                    ].join(' ')}
                  >
                    <span className="min-w-0 flex-1 truncate text-left">{c.name}</span>
                  </button>
                )}
                {canDelete &&
                  (isConfirming ? (
                    <button
                      type="button"
                      autoFocus
                      onClick={() => {
                        setConfirmId(null)
                        onDelete(c.id)
                      }}
                      onBlur={() => setConfirmId(null)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          e.preventDefault()
                          e.stopPropagation()
                          setConfirmId(null)
                        }
                      }}
                      className={[
                        'shrink-0 whitespace-nowrap rounded-[4px] px-1.5 py-0.5 text-[10.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2',
                        isActive
                          ? 'bg-bg-card text-accent hover:bg-bg focus-visible:ring-bg-card/70'
                          : 'bg-accent text-bg-card hover:bg-accent-hover focus-visible:ring-accent/40',
                      ].join(' ')}
                    >
                      {t('canvas.deleteConfirm')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmId(c.id)}
                      title={t('canvas.deleteCanvas')}
                      className={[
                        'flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:opacity-100',
                        isActive
                          ? 'text-bg-card/70 opacity-70 hover:bg-bg-card/20 hover:text-bg-card focus-visible:ring-bg-card/70'
                          : 'text-ink-faint opacity-0 hover:bg-bg-elevated hover:text-ink focus-visible:ring-accent/40 group-hover:opacity-100',
                      ].join(' ')}
                    >
                      <X size={11} strokeWidth={2} />
                    </button>
                  ))}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

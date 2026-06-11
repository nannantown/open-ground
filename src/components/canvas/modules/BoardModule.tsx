import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, GitBranch, Play, Trash2, X } from 'lucide-react'
import { BoardTab } from '@/components/canvas/BoardTab'
import { newId } from '@/lib/ids'
import { api } from '@/lib/api-client'
import { deriveCardFields, wantsAutoTitle } from '@/lib/cardTitle'
import type { BoardColumn, ProjectData, ProjectMeta, ProjectTask, Settings } from '@/lib/types'
import { useT } from '@/i18n/I18nContext'
import { assigneeCandidates, withRegisteredAssignee } from '@/lib/assignees'

// The Board tab as a self-contained module (Phase D — render extraction).
// Owns: the kanban (BoardTab), board-native card creation, and the in-tab
// detail drawer (title/notes edit + the injected conversation pane). It depends
// on ProjectPanel only through this explicit prop surface — the seam a future
// pluggable-Ground contract formalizes.
export interface BoardModuleProps {
  data: ProjectData
  project: ProjectMeta
  persist: (next: ProjectData) => void
  /** Which card's detail drawer is open (lifted to ProjectPanel so it survives
   *  this module unmounting on tab switch). */
  detailId: string | null
  onOpenDetail: (id: string | null) => void
  /** Inject the per-card conversation pane (the claude terminal launcher). */
  renderConversation: (task: ProjectTask, onClose: () => void) => ReactNode
  /** True when the task already has a Terminal-tab slot (a launched claude
   *  session) — such a card is "touched" and must survive drawer close. */
  hasTerminalSlot: (taskId: string) => boolean
  /** Delete a card with full teardown (close its terminal slot, remove from
   *  tasks.json). Rendered in the drawer header, not the conversation pane. */
  onDeleteTask: (id: string) => void
  /** Launch the task's claude session (creates its Terminal-tab slot). The
   *  drawer's Draft mode owns the Launch button — the conversation pane is not
   *  rendered until a slot exists. */
  onLaunchTask: (task: ProjectTask) => Promise<void> | void
}

export const BoardModule = ({
  data,
  project,
  persist,
  detailId,
  onOpenDetail,
  renderConversation,
  hasTerminalSlot,
  onDeleteTask,
  onLaunchTask,
}: BoardModuleProps) => {
  const { t } = useT()
  // The user's display name (Settings.displayName) — feeds the drawer's "Me"
  // button and the toolbar's "Mine only" filter. The module doesn't receive
  // Settings from the panel, so fetch it lazily once per mount (cheap local
  // GET); unset/failed just hides both affordances.
  const [displayName, setDisplayName] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    api.api.settings
      .$get()
      .then(r => r.json() as Promise<Settings>)
      .then(s => {
        if (!cancelled) setDisplayName(s.displayName?.trim() || null)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])
  // "+ Add" inline input for a brand-new assignee name; closed whenever the
  // drawer switches cards so a half-typed name never leaks across tasks.
  const [addingAssignee, setAddingAssignee] = useState(false)
  useEffect(() => setAddingAssignee(false), [detailId])

  // ---- Drawer geometry (both user-draggable, both remembered) -------------
  // The complaint this answers: "the terminal only gets the bottom sliver".
  // Width: drag the drawer's left edge. Meta/terminal split: drag the divider
  // between the fields block and the conversation pane — the fields block
  // scrolls inside its share instead of dictating the terminal's height.
  const [drawerW, setDrawerW] = useState<number>(() => {
    const v = Number(localStorage.getItem('og.board.drawerW'))
    return Number.isFinite(v) && v >= 380 ? v : 560
  })
  const [metaH, setMetaH] = useState<number>(() => {
    // NB: Number(null) is 0 — the >= 96 floor (the drag clamp's own minimum)
    // doubles as the "nothing stored yet" rejection.
    const v = Number(localStorage.getItem('og.board.drawerMetaH'))
    return Number.isFinite(v) && v >= 96 ? v : 224
  })
  const splitRef = useRef<HTMLDivElement | null>(null)
  const clampW = (w: number) => Math.min(Math.max(w, 380), Math.round(window.innerWidth * 0.7))
  const clampMetaH = (h: number, hostH: number) =>
    // Keep at least ~180px of terminal and ~96px of fields visible.
    Math.min(Math.max(h, 96), Math.max(96, hostH - 180))
  // One live drag at a time; its window listeners are torn down on pointerup,
  // pointercancel (trackpad/touch gesture interruptions), AND unmount — a
  // cancelled drag must never leave a phantom resize listener on window.
  const dragCleanupRef = useRef<(() => void) | null>(null)
  useEffect(() => () => dragCleanupRef.current?.(), [])
  const beginDrag = (
    onMove: (ev: PointerEvent) => void,
    onEnd: (ev: PointerEvent) => void,
  ) => {
    dragCleanupRef.current?.()
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      dragCleanupRef.current = null
    }
    const onUp = (ev: PointerEvent) => {
      onEnd(ev)
      cleanup()
    }
    const onCancel = () => cleanup()
    dragCleanupRef.current = cleanup
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
  }
  const startWidthDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    beginDrag(
      ev => setDrawerW(clampW(window.innerWidth - ev.clientX)),
      ev => localStorage.setItem('og.board.drawerW', String(clampW(window.innerWidth - ev.clientX))),
    )
  }
  const startSplitDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const host = splitRef.current
    if (!host) return
    beginDrag(
      ev => {
        const r = host.getBoundingClientRect()
        setMetaH(clampMetaH(ev.clientY - r.top, r.height))
      },
      ev => {
        const r = host.getBoundingClientRect()
        localStorage.setItem('og.board.drawerMetaH', String(clampMetaH(ev.clientY - r.top, r.height)))
      },
    )
  }
  const detailTask = detailId ? data.tasks.find(t => t.id === detailId) : null
  const patchTask = (task: ProjectTask, patch: Partial<ProjectTask>) =>
    persist({
      ...data,
      tasks: data.tasks.map(t => (t.id === task.id ? { ...t, ...patch } : t)),
    })
  // Async continuations (auto-title responses) must patch against the LATEST
  // data, not the render that started them — persisting a stale snapshot would
  // roll back edits made while the generation ran.
  const dataRef = useRef(data)
  dataRef.current = data
  const patchTaskFresh = (taskId: string, patch: Partial<ProjectTask>) => {
    const current = dataRef.current
    persist({
      ...current,
      tasks: current.tasks.map(t => (t.id === taskId ? { ...t, ...patch } : t)),
    })
  }

  // ---- Drawer phase state --------------------------------------------------
  // Draft (no terminal slot): authoring gets the whole drawer. Session (slot
  // exists): the terminal owns it and the fields collapse behind the header.
  const [fieldsOpen, setFieldsOpen] = useState(false)
  useEffect(() => setFieldsOpen(false), [detailId])
  const [launching, setLaunching] = useState(false)
  const [regenBusy, setRegenBusy] = useState(false)

  // Single-box capture commit: first line → provisional title, rest → content,
  // both flagged titleAuto. A multi-line capture then asks the server for a
  // haiku summary title (one-off PTY, serialized server-side); it lands via
  // the panel's 5s data poll — and never over a hand-edited title (the server
  // re-checks titleAuto before writing).
  const commitCapture = (task: ProjectTask, raw: string) => {
    const fields = deriveCardFields(raw)
    if (!fields.title) return
    patchTask(task, { title: fields.title, notes: fields.notes, titleAuto: true })
    if (wantsAutoTitle(fields))
      void api.api.project['task-title']
        .$post({ json: { path: project.path, id: task.id } })
        .catch(() => {})
  }

  // Explicit "✦ regenerate": force overrides the titleAuto guard (the user
  // asked), and the result is applied immediately rather than waiting for the
  // poll. The server already persisted it, so the CAS round-trip converges.
  const regenerateTitle = async (task: ProjectTask) => {
    setRegenBusy(true)
    try {
      const res = await api.api.project['task-title'].$post({
        json: { path: project.path, id: task.id, force: true },
      })
      if (res.ok) {
        const body = (await res.json()) as { title?: string | null }
        if (body.title) patchTaskFresh(task.id, { title: body.title, titleAuto: true })
      }
    } catch {
      // keep the current title
    } finally {
      setRegenBusy(false)
    }
  }

  const launchDetail = async (task: ProjectTask) => {
    setLaunching(true)
    try {
      await onLaunchTask(task)
    } finally {
      setLaunching(false)
    }
  }

  // One line of "what happens on finish" — answers the where-does-my-code-go
  // question BEFORE launch (Draft bar) and DURING the session (status strip).
  const flowText = project.hasGit
    ? (() => {
        const base = data.config?.targetBranch?.trim() || t('board.detail.flowBaseDefault')
        return data.config?.completionFlow === 'pr'
          ? t('board.detail.flowPr', { base })
          : t('board.detail.flowMerge', { base })
      })()
    : null

  // The task fields, shared by Draft (grow=true: the content textarea fills
  // the drawer) and the Session header's expandable block (grow=false: fixed
  // share, scrolls inside). Title edits clear titleAuto on the FIRST keystroke
  // so an in-flight auto-title can never land over hand-typed text.
  const fieldsBlock = (task: ProjectTask, grow: boolean) => (
    <>
      <div className="shrink-0">
        <div className="mb-1 flex items-center justify-between gap-2">
          <label className="label-cap text-ink-faint">
            {t('board.detail.titleLabel')}
            {task.titleAuto && (
              <span className="ml-1 text-accent" title={t('board.detail.titleAutoTitle')}>
                ✦
              </span>
            )}
          </label>
          {Boolean(task.title.trim() || (task.notes ?? '').trim()) && (
            <button
              type="button"
              onClick={() => void regenerateTitle(task)}
              disabled={regenBusy}
              title={t('board.detail.regenTitle')}
              className="shrink-0 rounded-sm px-1.5 py-0.5 text-[11px] text-ink-faint transition-colors hover:bg-bg-inset hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {regenBusy ? '✦ …' : '✦'}
            </button>
          )}
        </div>
        <input
          // Remount when the SAVED title changes (own blur, haiku landing via
          // the poll) so the uncontrolled field shows the fresh value.
          key={`${task.id}:${task.title}`}
          defaultValue={task.title}
          onChange={() => {
            if (task.titleAuto) patchTask(task, { titleAuto: undefined })
          }}
          onBlur={e => {
            const v = e.target.value.trim()
            if (v && v !== task.title) patchTask(task, { title: v, titleAuto: undefined })
          }}
          onKeyDown={e => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
          placeholder={t('board.detail.titlePlaceholder')}
          className="w-full rounded-[3px] border border-line bg-bg px-2.5 py-2 text-[14px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
        />
      </div>
      <div className={grow ? 'flex min-h-0 flex-1 flex-col' : undefined}>
        <label className="mb-1 block shrink-0 label-cap text-ink-faint">
          {t('board.detail.notesLabel')}
        </label>
        <textarea
          key={task.id + ':notes'}
          defaultValue={task.notes ?? ''}
          onBlur={e => {
            const v = e.target.value
            if (v !== (task.notes ?? '')) patchTask(task, { notes: v || undefined })
          }}
          placeholder={t('board.detail.notesPlaceholder')}
          rows={grow ? undefined : 3}
          className={[
            'w-full rounded-[3px] border border-line bg-bg px-2.5 py-2 text-[12px] leading-relaxed text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none',
            grow ? 'min-h-[120px] flex-1 resize-none' : 'resize-y',
          ].join(' ')}
        />
      </div>
      {/* Pull request — appears once claude records the PR it opened
          (setPrUrl). Plain link, opens in the browser. */}
      {task.prUrl && (
        <div className="shrink-0">
          <label className="mb-1 block label-cap text-ink-faint">
            {t('board.detail.prLabel')}
          </label>
          <a
            href={task.prUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-block max-w-full truncate rounded-sm border border-line px-2.5 py-1 text-[12px] text-ink-muted transition-colors hover:border-accent hover:bg-accent/10 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {task.prUrl.replace(/^https?:\/\//, '')} ↗
          </a>
        </div>
      )}
      {/* Assignee — a chip picker, no free-floating input. Click a chip to
          assign; click the selected chip to unassign; "+ Add" registers a new
          name into the shared member list (config.members) AND assigns it. */}
      <div className="shrink-0">
        <label className="mb-1 block label-cap text-ink-faint">
          {t('board.detail.assigneeLabel')}
        </label>
        <div className="flex flex-wrap items-center gap-1.5">
          {assigneeCandidates(data, displayName, task.assignee).map(name => {
            const active = (task.assignee ?? '').trim().toLowerCase() === name.toLowerCase()
            return (
              <button
                key={name}
                type="button"
                onClick={() => patchTask(task, { assignee: active ? undefined : name })}
                title={active ? t('board.detail.assigneeUnassign') : t('board.detail.assigneeAssign', { name })}
                aria-pressed={active}
                className={
                  active
                    ? 'shrink-0 rounded-sm border border-accent bg-accent px-2.5 py-1 text-[11px] text-bg-card transition-colors hover:bg-accent/85 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
                    : 'shrink-0 rounded-sm border border-line px-2.5 py-1 text-[11px] text-ink-muted transition-colors hover:bg-bg-inset hover:text-ink active:bg-bg-inset active:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
                }
              >
                {name}
              </button>
            )
          })}
          {addingAssignee ? (
            <span className="flex items-center gap-1">
              <input
                autoFocus
                defaultValue=""
                placeholder={t('board.detail.assigneeAddPlaceholder')}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    const v = e.currentTarget.value.trim()
                    // Register into the shared member list AND assign —
                    // the name is now a chip on EVERY card.
                    if (v) persist(withRegisteredAssignee(data, task.id, v))
                    setAddingAssignee(false)
                  } else if (e.key === 'Escape') {
                    e.stopPropagation() // cancel the add only — keep the drawer open
                    setAddingAssignee(false)
                  }
                }}
                className="w-28 rounded-[3px] border border-accent bg-bg px-2 py-1 text-[12px] text-ink placeholder:text-ink-faint focus:outline-none"
              />
              <button
                type="button"
                onMouseDown={e => {
                  // commit BEFORE the input's blur (mousedown fires first)
                  e.preventDefault()
                  const input = e.currentTarget.previousElementSibling as HTMLInputElement | null
                  const v = input?.value.trim() ?? ''
                  if (v) persist(withRegisteredAssignee(data, task.id, v))
                  setAddingAssignee(false)
                }}
                className="shrink-0 rounded-sm border border-line px-2 py-1 text-[11px] text-ink-muted transition-colors hover:bg-bg-inset hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                {t('board.detail.assigneeAddConfirm')}
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setAddingAssignee(true)}
              className="shrink-0 rounded-sm border border-dashed border-line px-2.5 py-1 text-[11px] text-ink-faint transition-colors hover:border-line hover:bg-bg-inset hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {t('board.detail.assigneeAdd')}
            </button>
          )}
        </div>
      </div>
    </>
  )

  // A just-created card the user opened but never filled in: no title, no memo,
  // no launched terminal. Closing the drawer on such a card discards it, so
  // "Add a card" → open drawer → change-your-mind doesn't litter empty cards
  // (mirrors the old inline editor, which dropped an unnamed card on blur).
  const isUntouchedEmpty = (task: ProjectTask): boolean =>
    !task.title.trim() &&
    !(task.notes ?? '').trim() &&
    !hasTerminalSlot(task.id)
  const closeDrawer = () => {
    if (detailTask && isUntouchedEmpty(detailTask))
      persist({ ...data, tasks: data.tasks.filter(t => t.id !== detailTask.id) })
    onOpenDetail(null)
  }
  const closeDrawerRef = useRef(closeDrawer)
  closeDrawerRef.current = closeDrawer

  // Esc with the drawer open: cancel a field edit first (restore the original
  // value, then blur — onBlur sees no change and persists nothing), close the
  // drawer otherwise. Never fires mid-IME composition, never reaches here from
  // the assignee input (which stops propagation itself), and NEVER touches the
  // claude terminal: Esc is claude CLI's interrupt key, and xterm focuses a
  // hidden helper textarea — blurring it would silently eat the next keystrokes.
  // Layered Escape, two scopes:
  //
  // (a) Field cancel — a React onKeyDown ON THE DRAWER ITSELF (see the aside's
  //     handler below): Esc in a drawer field reverts it to its saved value
  //     and blurs, stopPropagation keeps both this window listener and App's
  //     out of it. Element-level Escape handlers inside the drawer (the
  //     assignee add-input) run first in the bubble and stop propagation, so
  //     they keep their own semantics. xterm is exempt everywhere — Esc is
  //     claude's interrupt key.
  //
  // (b) Drawer close — a window CAPTURE listener for the nothing-focused
  //     case only. Capture because App.tsx's bubble-phase window Escape
  //     (clear selection → back to Ground) registered first and would
  //     otherwise close the whole panel on the same press. It YIELDS to any
  //     open overlay ([data-esc-overlay]: ⌘K palette, feedback/account
  //     modals, panel dialogs) — Esc must serve the topmost layer, and a
  //     focused field belongs to scope (a) / the field's own handler.
  const onDrawerFieldEscape = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape' || e.nativeEvent.isComposing) return
    const el = e.target
    if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return
    if (el.closest('.xterm')) return
    e.stopPropagation()
    el.value = el.defaultValue // uncontrolled fields: defaultValue = saved value
    el.blur()
  }
  useEffect(() => {
    if (!detailId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return
      const el = document.activeElement
      // A focused field/terminal handles its own Escape (scope (a) / xterm).
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.closest('.xterm'))
      )
        return
      // An open overlay outranks the drawer — let it have the key.
      if (document.querySelector('[data-esc-overlay]')) return
      e.stopPropagation()
      closeDrawerRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [detailId])

  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-h-0 min-w-0 flex-1">
        <BoardTab
          data={data}
          onPersist={persist}
          openTaskId={detailId}
          // Board self-contained (P1): open the card's conversation in an
          // in-tab drawer.
          onOpenTask={id => onOpenDetail(id)}
          // Board self-contained (Phase A): author plan cards right here.
          // "Add a card" creates the card immediately with an EMPTY title and
          // returns its id; the Board then OPENS ITS DETAIL DRAWER so the user
          // types the title in a roomy field (an untouched card is discarded on
          // close — see isUntouchedEmpty).
          onCreateTask={(column: BoardColumn) => {
            const task: ProjectTask = {
              id: newId(),
              title: '',
              done: false,
              createdAt: new Date().toISOString(),
              boardColumn: column,
            }
            persist({ ...data, tasks: [...data.tasks, task] })
            return task.id
          }}
          projectMissing={project.missing}
          projectId={project.id}
          displayName={displayName}
        />
      </div>
      {detailTask && (
        <aside
          className="relative flex shrink-0 flex-col border-l border-line"
          style={{ width: drawerW, maxWidth: '70%' }}
          onKeyDown={onDrawerFieldEscape}
        >
          {/* Left-edge width grip — the whole edge is a 8px hit area. */}
          <div
            onPointerDown={startWidthDrag}
            role="separator"
            aria-orientation="vertical"
            aria-label={t('board.detail.resizeWidth')}
            className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize transition-colors hover:bg-accent/40 active:bg-accent/50"
          />
          {/* Header — delete (left) + close (right). The title is a labelled
              field below so it reads the same as the memo. Delete sits here, an
              anchored header action, instead of floating in the conversation
              pane (whose own delete is hidden via hideDelete). */}
          <div className="flex shrink-0 items-center justify-between border-b border-line-soft px-5 py-2">
            <button
              type="button"
              onClick={() => {
                onDeleteTask(detailTask.id)
                onOpenDetail(null)
              }}
              title={t('projectPanel.deleteTask')}
              aria-label={t('projectPanel.deleteTask')}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-ink-faint transition-colors hover:bg-accent/10 hover:text-accent"
            >
              <Trash2 size={14} />
            </button>
            <button
              type="button"
              onClick={closeDrawer}
              title={t('common.close')}
              aria-label={t('common.close')}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-ink-muted transition-colors hover:bg-bg-inset hover:text-ink"
            >
              <X size={15} />
            </button>
          </div>
          {!hasTerminalSlot(detailTask.id) ? (
            /* ── DRAFT — authoring gets the whole drawer; no terminal pane.
                  A brand-new card starts as a single capture box (first line →
                  title, rest → content); a card with text shows the full
                  fields with the content area taking the remaining height. */
            <>
              {isUntouchedEmpty(detailTask) ? (
                <div className="flex min-h-0 flex-1 flex-col px-5 py-3">
                  <label className="mb-1 block shrink-0 label-cap text-ink-faint">
                    {t('board.detail.captureLabel')}
                  </label>
                  <textarea
                    key={detailTask.id + ':capture'}
                    autoFocus
                    defaultValue=""
                    onBlur={e => commitCapture(detailTask, e.target.value)}
                    placeholder={t('board.detail.capturePlaceholder')}
                    className="min-h-0 w-full flex-1 resize-none rounded-[3px] border border-line bg-bg px-2.5 py-2 text-[13px] leading-relaxed text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
                  />
                </div>
              ) : (
                <div className="flex min-h-0 flex-1 flex-col space-y-3 px-5 py-3">
                  {fieldsBlock(detailTask, true)}
                </div>
              )}
              {/* Launch bar — anchored at the bottom; the one-line flow note
                  answers "how does this get merged?" BEFORE anything runs. */}
              <div className="shrink-0 border-t border-line-soft px-5 py-3">
                <button
                  type="button"
                  onClick={() => void launchDetail(detailTask)}
                  disabled={launching || project.missing}
                  className="flex w-full items-center justify-center gap-1.5 rounded-[4px] border border-line px-3 py-2 text-[13px] text-ink transition-colors hover:border-accent hover:bg-accent/10 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  <Play size={12} strokeWidth={2.5} />
                  {launching ? t('projectPanel.launchingClaude') : t('projectPanel.launchClaude')}
                </button>
                <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
                  {t('board.detail.launchHintShort')}
                  {flowText ? ` · ${flowText}` : ''}
                </p>
              </div>
            </>
          ) : (
            /* ── SESSION — the terminal owns the drawer. The task collapses to
                  a one-line header (chevron expands the fields) + a status
                  strip narrating where the work lives (branch / flow / PR). */
            <>
              <div className="shrink-0 border-b border-line-soft">
                <button
                  type="button"
                  onClick={() => setFieldsOpen(o => !o)}
                  aria-expanded={fieldsOpen}
                  title={t('board.detail.fieldsToggle')}
                  className="flex w-full items-center gap-1.5 px-5 py-2 text-left transition-colors hover:bg-bg-inset focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                >
                  <ChevronRight
                    size={13}
                    className={`shrink-0 text-ink-faint transition-transform ${fieldsOpen ? 'rotate-90' : ''}`}
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                    {detailTask.title.trim() || t('board.card.untitled')}
                  </span>
                </button>
                {(detailTask.branch || flowText || detailTask.prUrl) && (
                  <div className="flex items-center gap-3 px-5 pb-2 text-[11px] text-ink-faint">
                    {detailTask.branch && (
                      <span
                        className="flex min-w-0 items-center gap-1"
                        title={t('board.detail.branchTitle')}
                      >
                        <GitBranch size={11} className="shrink-0" />
                        <span className="truncate">{detailTask.branch}</span>
                      </span>
                    )}
                    {flowText && <span className="shrink-0">{flowText}</span>}
                    {detailTask.prUrl && (
                      <a
                        href={detailTask.prUrl}
                        target="_blank"
                        rel="noreferrer"
                        title={detailTask.prUrl}
                        className="shrink-0 text-ink-muted underline decoration-line underline-offset-2 transition-colors hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      >
                        PR ↗
                      </a>
                    )}
                  </div>
                )}
              </div>
              <div ref={splitRef} className="flex min-h-0 flex-1 flex-col">
                {fieldsOpen && (
                  <>
                    <div
                      // maxHeight re-clamps a metaH saved on a taller window so
                      // the terminal keeps its ~180px floor on any window size.
                      style={{ height: metaH, minHeight: 96, maxHeight: 'calc(100% - 188px)' }}
                      className="shrink-0 space-y-3 overflow-y-auto px-5 py-3"
                    >
                      {fieldsBlock(detailTask, false)}
                    </div>
                    {/* Split grip between fields and terminal — 8px hit area
                        centered on the visible divider line. */}
                    <div
                      onPointerDown={startSplitDrag}
                      onDoubleClick={() => {
                        // Toggle: fields at their minimum ⇄ default.
                        const next = metaH > 96 ? 96 : 224
                        setMetaH(next)
                        localStorage.setItem('og.board.drawerMetaH', String(next))
                      }}
                      role="separator"
                      aria-orientation="horizontal"
                      aria-label={t('board.detail.resizeSplit')}
                      title={t('board.detail.resizeSplitTitle')}
                      className="group relative z-10 -my-1 h-2 shrink-0 cursor-row-resize"
                    >
                      <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-line-soft transition-colors group-hover:h-[3px] group-hover:bg-accent/50 group-active:bg-accent/60" />
                    </div>
                  </>
                )}
                <div className="flex min-h-0 flex-1 flex-col">
                  {renderConversation(detailTask, () => onOpenDetail(null))}
                </div>
              </div>
            </>
          )}
        </aside>
      )}
    </div>
  )
}

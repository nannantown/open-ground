import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Palette, Users } from 'lucide-react'
import { useT } from '@/i18n/I18nContext'
import {
  useBoardCollabShared,
  useCanvasCollabShared,
} from '@/lib/collab/RealtimeContext'
import { BoardModule, type TaskLaunchResult } from '@/components/canvas/modules/BoardModule'
import { CanvasWorkspace } from '@/components/canvas/CanvasWorkspace'
import { CollabPresence } from '@/components/canvas/CollabPresence'
import type {
  CanvasFile,
  CollabSharedCanvasResponse,
  CollabSharedDataResponse,
  ProjectData,
  ProjectMeta,
  ProjectTask,
} from '@/lib/types'

// SharedProjectPanel — the MEMBER view of a folder-less shared project.
//
// A collaborator who joined by invite has NO local folder, so the normal
// path-keyed ProjectPanel can't open the project. This panel opens it by
// collabProjectId instead: the Y.Doc (served by the Cloudflare DO) IS the data
// source. We OWN the doc↔state sync here (adopt the authoritative doc on connect
// + on every peer change; push local edits back via the binding's seed) and feed
// the existing BoardModule a synthetic, path-less project so the kanban renders
// + edits exactly like the owner's — full realtime parity, zero BoardModule
// changes (its internal collab binding is null for a path-less project, so it
// stays inert and we drive everything).
//
// Per the product model ("the place is shared, the hands are each your own"),
// Claude/Terminal is NOT available here — a member has no local checkout to spawn
// `claude` in. The per-card conversation pane explains that instead.
//
// SCOPE: Board + Canvas. The board doc carries the shared canvas index
// (m:canvasIndex) so a member can list canvases; opening one binds its own
// canvas doc and renders the existing CanvasWorkspace (see SharedCanvasView).

// Minimal base the doc layers over (boardDocToProjectData fills the rest from the
// doc). Only the required ProjectData fields — never meaningful defaults that a
// seed could write back over the authoritative doc.
const EMPTY_DATA: ProjectData = { description: '', tasks: [], notes: '', updatedAt: '' }

// Shared, arg-ignoring no-op for the read-only cached preview's BoardModule
// callbacks (persist / open-detail / delete are inert while not synced).
const NOOP = () => {}

// Minimal CanvasFile base the canvas doc layers over (docToCanvasFile fills the
// rest from the doc). Only required fields — no meaningful defaults a seed could
// write back over the authoritative doc.
const emptyCanvas = (id: string): CanvasFile => ({
  id,
  name: '',
  viewport: { x: 0, y: 0, zoom: 1 },
  elements: [],
  chats: [],
  activeChatId: null,
  sidebarOpen: false,
  sidebarWidth: null,
  createdAt: '',
  updatedAt: '',
})

// One member-opened canvas. Owns the canvas doc↔state sync (same adopt-from-doc /
// seed-on-edit / synced-gate discipline as the board) and renders the existing
// CanvasWorkspace (data-prop-driven, like BoardModule) with a path-less project.
// Keyed by canvasId at the call site so switching canvases fully remounts.
function SharedCanvasView({
  collabProjectId,
  canvasId,
}: {
  collabProjectId: string
  canvasId: string
}) {
  const { t } = useT()
  const collab = useCanvasCollabShared(collabProjectId, canvasId)
  const [file, setFile] = useState<CanvasFile>(() => emptyCanvas(canvasId))
  const [adopted, setAdopted] = useState(false)
  // Per-canvas offline cache (cv4) — shown read-only while connecting.
  const [cached, setCached] = useState<CanvasFile | null>(null)

  useEffect(() => {
    if (!collab) {
      setAdopted(false)
      return
    }
    const adopt = () => {
      setFile((prev) => collab.extract(prev))
      setAdopted(true)
    }
    adopt()
    return collab.onRemote(adopt)
  }, [collab])

  // Hydrate this canvas's cache on open (the view is keyed by canvasId, so this
  // runs fresh per canvas). Shown READ-ONLY only while connecting → can't clobber.
  useEffect(() => {
    let cancelled = false
    fetch(
      `/api/collab/shared-canvas?collabProjectId=${encodeURIComponent(
        collabProjectId,
      )}&canvasId=${encodeURIComponent(canvasId)}`,
    )
      .then((r) => (r.ok ? (r.json() as Promise<CollabSharedCanvasResponse>) : null))
      .then((res) => {
        if (!cancelled && res?.data) setCached(res.data)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [collabProjectId, canvasId])

  const persist = useCallback(
    (next: CanvasFile) => {
      setFile(next)
      collab?.seed(next)
    },
    [collab],
  )

  // Interactive only once the authoritative canvas doc has synced (same reason as
  // the board: a pre-sync edit could seed empty meta over the doc via LWW).
  const ready = !!collab && adopted && !!collab.synced

  // Mirror the SYNCED canvas to the cache (debounced) — only once ready, so we
  // never persist the empty base or the read-only preview over a good cache.
  useEffect(() => {
    if (!ready) return
    const id = setTimeout(() => {
      void fetch('/api/collab/shared-canvas', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ collabProjectId, canvasId, data: file }),
      }).catch(() => {})
    }, 800)
    return () => clearTimeout(id)
  }, [ready, file, collabProjectId, canvasId])

  // Path-less project: CanvasWorkspace's image/asset ops need a local path and
  // degrade silently (canvas-element images are R2/u14, deferred). No docked
  // sidebars for the member MVP (layers/inspector hosts null).
  if (ready) {
    return (
      <CanvasWorkspace
        projectPath=""
        canvas={file}
        onChange={persist}
        layersHost={null}
        inspectorHost={null}
      />
    )
  }
  if (cached) {
    // Instant/offline read-only preview while connecting (pointer-events-none +
    // no-op onChange keep it inert; the live canvas replaces it on sync).
    return (
      <div className="relative h-full">
        <div className="pointer-events-none h-full select-none opacity-90">
          <CanvasWorkspace
            projectPath=""
            canvas={cached}
            onChange={NOOP}
            layersHost={null}
            inspectorHost={null}
          />
        </div>
        <div className="pointer-events-none absolute inset-x-0 top-0 border-b border-line bg-bg-card/90 px-4 py-1.5 text-center text-[11px] text-ink-muted backdrop-blur-sm">
          {t('projectPanel.collabSharedCachedBanner')}
        </div>
      </div>
    )
  }
  return (
    <div className="flex h-full items-center justify-center px-8 text-center">
      <p className="text-[12px] leading-relaxed text-ink-muted">
        {collab
          ? t('projectPanel.collabSharedConnecting')
          : t('projectPanel.collabSharedUnavailable')}
      </p>
    </div>
  )
}

export const SharedProjectPanel = ({
  collabProjectId,
  label,
  onClose,
}: {
  collabProjectId: string
  /** The owner-set shared name (member-visible). */
  label: string
  /** Back to Ground. */
  onClose: () => void
}) => {
  const { t } = useT()
  const collab = useBoardCollabShared(collabProjectId)
  const [data, setData] = useState<ProjectData>(EMPTY_DATA)
  const dataRef = useRef(data)
  dataRef.current = data
  const [detailId, setDetailId] = useState<string | null>(null)
  // Board / Canvas switcher (member view of both). activeCanvasId = the canvas
  // currently open (null = the canvas list).
  const [tab, setTab] = useState<'board' | 'canvas'>('board')
  const [activeCanvasId, setActiveCanvasId] = useState<string | null>(null)
  // True once we've adopted the doc at least once — until then the board is
  // "connecting" and NON-interactive, so a pre-sync edit can't seed-clobber the
  // authoritative doc with our empty base.
  const [adopted, setAdopted] = useState(false)
  // Option-A local cache: the last board mirrored to ~/.openground/shared/<id>/.
  // Shown READ-ONLY while connecting/offline (instant open), then replaced by the
  // live doc once synced. null = nothing cached.
  const [cached, setCached] = useState<ProjectData | null>(null)

  // Adopt the authoritative doc: once on connect, then on every peer change. The
  // binding filters our own seed-origin updates out of onRemote, so a local edit
  // doesn't re-trigger adoption (no echo loop).
  useEffect(() => {
    if (!collab) {
      setAdopted(false)
      return
    }
    const adopt = () => {
      setData((prev) => collab.extract(prev))
      setAdopted(true)
    }
    adopt()
    return collab.onRemote(adopt)
  }, [collab])

  // Hydrate the local cache once on open (the panel is keyed by collabProjectId,
  // so this runs fresh per project). It's only ever shown READ-ONLY while
  // connecting — the live doc replaces it on sync — so it can't seed-clobber.
  useEffect(() => {
    let cancelled = false
    fetch(`/api/collab/shared-data?collabProjectId=${encodeURIComponent(collabProjectId)}`)
      .then((r) => (r.ok ? (r.json() as Promise<CollabSharedDataResponse>) : null))
      .then((res) => {
        if (!cancelled && res?.data) setCached(res.data)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [collabProjectId])

  // The single write path: update local state AND push to the shared doc. seed is
  // idempotent (writes only changed keys) and, post-adoption, `next` already
  // mirrors the doc + this one edit, so reconcile never deletes a peer's card.
  const persist = useCallback(
    (next: ProjectData) => {
      setData(next)
      collab?.seed(next)
    },
    [collab],
  )

  // Realtime status. `live` = the doc has synced; `ready` = safe to render the
  // INTERACTIVE board (see the render + review Finding 2 — editing before sync
  // would seed empty whole-value meta into the shared doc via LWW).
  const live = !!collab?.synced
  const ready = !!collab && adopted && live

  // The shared canvas index (published by the owner's Canvas tab into the board
  // doc) — the member's canvas list. activeCanvasName labels the open canvas.
  const canvasList = data.canvasIndex ?? []
  const activeCanvasName = canvasList.find((c) => c.id === activeCanvasId)?.name ?? ''

  // Mirror the SYNCED board to the local cache (debounced). Only runs once ready,
  // so we never persist the empty base or the read-only preview over a good
  // cache — the cache always reflects authoritative, synced state.
  useEffect(() => {
    if (!ready) return
    const id = setTimeout(() => {
      void fetch('/api/collab/shared-data', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ collabProjectId, data }),
      }).catch(() => {})
    }, 800)
    return () => clearTimeout(id)
  }, [ready, data, collabProjectId])

  // A synthetic ProjectMeta: path '' (so BoardModule's internal collab binding is
  // null and it stays inert — we drive collab here), id = collabProjectId, name =
  // the shared label. hasGit/missing/counts are inert for the member board.
  const project = useMemo<ProjectMeta>(
    () => ({
      id: collabProjectId,
      name: label,
      path: '',
      description: '',
      lastModified: '',
      hasGit: false,
      openTaskCount: 0,
      totalTaskCount: 0,
    }),
    [collabProjectId, label],
  )

  // Delete a card → persist the board without it (members can edit the board;
  // only Claude/Terminal is gated).
  const onDeleteTask = useCallback(
    (id: string) => {
      const cur = dataRef.current
      persist({ ...cur, tasks: cur.tasks.filter((tk: ProjectTask) => tk.id !== id) })
      setDetailId((d) => (d === id ? null : d))
    },
    [persist],
  )

  // Claude is not available for a folder-less member — there is no local cwd to
  // spawn it in. The drawer's conversation pane explains this; launches are no-ops.
  const renderConversation = useCallback(
    () => (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
        <Users size={20} className="text-ink-faint" />
        <p className="font-display text-[15px] text-ink">
          {t('projectPanel.collabSharedClaudeTitle')}
        </p>
        <p className="max-w-[340px] text-[12px] leading-relaxed text-ink-muted">
          {t('projectPanel.collabSharedClaudeBody')}
        </p>
      </div>
    ),
    [t],
  )
  const launchTask = useCallback(
    async (): Promise<TaskLaunchResult> => ({ ok: false, reason: 'other' }),
    [],
  )

  // Escape closes the panel — parity with every other overlay (the global Esc
  // handler bails on data-esc-overlay, so the panel owns its own).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // If the open canvas disappears from the shared index (the owner deleted it),
  // drop back to the canvas list instead of leaving a frozen, stale canvas open
  // (review LOW). `data` changes on adopt, so this re-checks on every peer update.
  useEffect(() => {
    if (activeCanvasId && !(data.canvasIndex ?? []).some((c) => c.id === activeCanvasId)) {
      setActiveCanvasId(null)
    }
  }, [data, activeCanvasId])

  return (
    <div data-esc-overlay className="absolute inset-0 z-20 flex flex-col bg-bg-card">
      {/* Header — back to Ground, the shared name, and a realtime status pill. */}
      <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2.5">
        <button
          type="button"
          onClick={onClose}
          title={t('projectPanel.backToGround')}
          className="flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-1 text-[11px] text-ink-muted transition-colors hover:bg-bg-inset hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <ArrowLeft size={13} />
          {t('projectPanel.backToGround')}
        </button>
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-muted">
            <Users size={10} />
            {t('projectPanel.collabSharedBadge')}
          </span>
          <span className="truncate font-display text-[15px] text-ink" title={label}>
            {label}
          </span>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {/* Board / Canvas switcher. */}
          <div className="flex items-center gap-0.5 rounded-sm border border-line p-0.5">
            {(['board', 'canvas'] as const).map((tk) => (
              <button
                key={tk}
                type="button"
                onClick={() => setTab(tk)}
                className={`rounded-[2px] px-2 py-0.5 text-[11px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                  tab === tk
                    ? 'bg-ink text-bg-card'
                    : 'text-ink-muted hover:text-ink'
                }`}
              >
                {tk === 'board' ? 'Board' : 'Canvas'}
              </button>
            ))}
          </div>
          {/* Presence — who else is in this shared project right now (u15). */}
          <CollabPresence channel={collab} />
          <span
            className={`shrink-0 text-[10px] uppercase tracking-wide ${
              live ? 'text-ink-muted' : 'text-ink-faint'
            }`}
          >
            {live ? t('projectPanel.collabSharedLive') : t('projectPanel.collabSharedConnecting')}
          </span>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        {tab === 'canvas' ? (
          activeCanvasId ? (
            <div className="flex h-full flex-col">
              <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-1.5">
                <button
                  type="button"
                  onClick={() => setActiveCanvasId(null)}
                  className="flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-1 text-[11px] text-ink-muted transition-colors hover:bg-bg-inset hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  <ArrowLeft size={12} />
                  {t('projectPanel.collabCanvasBack')}
                </button>
                <span className="truncate text-[12px] text-ink" title={activeCanvasName}>
                  {activeCanvasName}
                </span>
              </div>
              <div className="relative min-h-0 flex-1">
                <SharedCanvasView
                  key={activeCanvasId}
                  collabProjectId={collabProjectId}
                  canvasId={activeCanvasId}
                />
              </div>
            </div>
          ) : (
            <div className="h-full overflow-y-auto px-4 py-4">
              {canvasList.length === 0 ? (
                <p className="text-[12px] leading-relaxed text-ink-faint">
                  {t('projectPanel.collabCanvasEmpty')}
                </p>
              ) : (
                <ul className="mx-auto max-w-[480px] space-y-1">
                  {canvasList.map((cv) => (
                    <li key={cv.id}>
                      <button
                        type="button"
                        onClick={() => setActiveCanvasId(cv.id)}
                        className="flex w-full items-center gap-2 rounded-[3px] border border-line bg-bg px-3 py-2 text-left text-[12px] text-ink transition-colors hover:border-accent hover:bg-bg-inset focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      >
                        <Palette size={13} className="shrink-0 text-ink-faint" />
                        <span className="truncate">
                          {cv.name || t('projectPanel.collabSharedDialogUntitled')}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )
        ) : ready ? (
          <BoardModule
            data={data}
            project={project}
            persist={persist}
            detailId={detailId}
            onOpenDetail={setDetailId}
            renderConversation={renderConversation}
            hasTerminalSlot={() => false}
            liveTerminalId={() => null}
            onDeleteTask={onDeleteTask}
            onLaunchTask={launchTask}
          />
        ) : cached ? (
          // Instant/offline READ-ONLY preview of the last cached board while we
          // connect. pointer-events-none + no-op writers keep it inert (no edit
          // can seed-clobber the doc); the live board replaces it on sync.
          <div className="relative h-full">
            <div className="pointer-events-none h-full select-none opacity-90">
              <BoardModule
                data={cached}
                project={project}
                persist={NOOP}
                detailId={null}
                onOpenDetail={NOOP}
                renderConversation={renderConversation}
                hasTerminalSlot={() => false}
                liveTerminalId={() => null}
                onDeleteTask={NOOP}
                onLaunchTask={launchTask}
              />
            </div>
            <div className="pointer-events-none absolute inset-x-0 top-0 border-b border-line bg-bg-card/90 px-4 py-1.5 text-center text-[11px] text-ink-muted backdrop-blur-sm">
              {t('projectPanel.collabSharedCachedBanner')}
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center px-8 text-center">
            <p className="text-[12px] leading-relaxed text-ink-muted">
              {collab
                ? t('projectPanel.collabSharedConnecting')
                : t('projectPanel.collabSharedUnavailable')}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

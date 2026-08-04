import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, FolderPlus, Palette, Users } from 'lucide-react'
import { Overlay, DialogHeader } from '@/components/ui/overlay'
import { useT } from '@/i18n/I18nContext'
import {
  useBoardCollabShared,
  useCanvasCollabShared,
} from '@/lib/collab/RealtimeContext'
import { BoardModule, type TaskLaunchResult } from '@/components/canvas/modules/BoardModule'
import { CanvasWorkspace } from '@/components/canvas/CanvasWorkspace'
import { CollabPresence } from '@/components/canvas/CollabPresence'
import { TerminalPane } from '@/components/canvas/TerminalPane'
import { pickFolder } from '@/lib/pickFolder'
import type {
  CanvasFile,
  CollabLinkResponse,
  CollabSharedCanvasResponse,
  CollabSharedDataResponse,
  ProjectData,
  ProjectMeta,
  ProjectTask,
} from '@/lib/types'

// SharedProjectBody — the MEMBER view of a folder-less shared project,
// rendered by ProjectPanel when its `shared` capability flag is set (the single
// owner/member switch — there is no separate shared panel mounted by App).
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
// Claude runs on the MEMBER's own machine in their OWN checkout — never the
// owner's code. A member who hasn't linked a folder yet sees a "Link local folder"
// call-to-action; once they pick their own clone (POST /api/collab/link registers
// it on the validateProjectPath allowlist) a Terminal tab appears, rooted at that
// folder, while Board/Canvas keep syncing over the doc. Unlinked = Board + Canvas
// only (backward-compatible).
//
// SCOPE: Board + Canvas (+ Terminal once a local folder is linked). The board doc
// carries the shared canvas index (m:canvasIndex) so a member can list canvases;
// opening one binds its own canvas doc and renders the existing CanvasWorkspace
// (see SharedCanvasView).

// Minimal base the doc layers over (boardDocToProjectData fills the rest from the
// doc). Only the required ProjectData fields — never meaningful defaults that a
// seed could write back over the authoritative doc.
const EMPTY_DATA: ProjectData = { description: '', tasks: [], notes: '', updatedAt: '' }

// Shared, arg-ignoring no-op for the read-only cached preview's BoardModule
// callbacks (persist / open-detail / delete are inert while not synced).
const NOOP = () => {}

// Map a POST /api/collab/link rejection code to a friendly i18n key (generic
// fallback for anything else, e.g. a transport error).
const linkErrorKey = (code?: string): string => {
  switch (code) {
    case 'already-linked':
      return 'projectPanel.collabLinkAlreadyLinked'
    case 'duplicate':
      return 'projectPanel.collabLinkDuplicate'
    case 'overlap':
      return 'projectPanel.collabLinkOverlap'
    case 'home-root':
    case 'filesystem-root':
      return 'projectPanel.collabLinkBadTarget'
    default:
      return 'projectPanel.collabLinkFailed'
  }
}

// Minimal CanvasFile base the canvas doc layers over (docToCanvasFile fills the
// rest from the doc). Only required fields — no meaningful defaults a seed could
// write back over the authoritative doc.
const emptyCanvas = (id: string): CanvasFile => ({
  id,
  name: '',
  // rev is a disk-OCC concept; a collab member never saves through that path
  // (they sync via the Y.Doc), so 0 is fine — docToCanvasFile layers over this.
  rev: 0,
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

export const SharedProjectBody = ({
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
  // Board / Canvas / Terminal switcher (member view). Terminal only appears once a
  // local folder is linked (linkedPath). activeCanvasId = the canvas currently open
  // (null = the canvas list).
  const [tab, setTab] = useState<'board' | 'canvas' | 'terminal'>('board')
  const [activeCanvasId, setActiveCanvasId] = useState<string | null>(null)
  // True once we've adopted the doc at least once — until then the board is
  // "connecting" and NON-interactive, so a pre-sync edit can't seed-clobber the
  // authoritative doc with our empty base.
  const [adopted, setAdopted] = useState(false)
  // Option-A local cache: the last board mirrored to ~/.openground/shared/<id>/.
  // Shown READ-ONLY while connecting/offline (instant open), then replaced by the
  // live doc once synced. null = nothing cached.
  const [cached, setCached] = useState<ProjectData | null>(null)
  // The member's LINKED local folder for this shared project (their own clone), or
  // null until they link one. Once set, the path is on the validateProjectPath
  // allowlist, so a Terminal can spawn Claude there while Board/Canvas keep syncing
  // over the doc. Fetched on open (self-contained — every member open-flow lands
  // here, so App needn't thread it through) and set on a successful link.
  const [linkedPath, setLinkedPath] = useState<string | null>(null)
  const [linking, setLinking] = useState(false)
  // Guards against a slow on-open GET /api/collab/link (it hits Supabase via the
  // membership check) landing LATE and nulling-out a folder the user just linked
  // in this session. Set on a local link, re-armed per project by the fetch below.
  const linkedLocallyRef = useRef(false)

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

  // Resolve whether this member has already linked a local folder for the project,
  // so we know to show the Terminal vs the "Link local folder" CTA. Self-contained
  // (runs on open, keyed by collabProjectId) so it works from every open-flow —
  // Ground card, invite, join dialog — without App threading the link through.
  useEffect(() => {
    let cancelled = false
    linkedLocallyRef.current = false
    setLinkedPath(null)
    fetch(`/api/collab/link?collabProjectId=${encodeURIComponent(collabProjectId)}`)
      .then((r) => (r.ok ? (r.json() as Promise<CollabLinkResponse>) : null))
      .then((res) => {
        // Skip if the user already linked locally meanwhile — a late null from
        // this initial GET must not clobber the freshly-linked path.
        if (!cancelled && res && !linkedLocallyRef.current) setLinkedPath(res.localPath)
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

  // Link the member's OWN local folder (their clone) so a Terminal can run Claude
  // in it. Native folder pick → POST /api/collab/link (registers it on the registry
  // allowlist via the SAME guard as Import — the boundary is never weakened, and
  // the owner's code is never transferred: this only points at the member's own
  // folder) → reveal the Terminal. Board/Canvas are untouched (they keep syncing).
  const handleLinkFolder = useCallback(async () => {
    if (linking) return
    setLinking(true)
    try {
      const picked = await pickFolder()
      if (picked.cancelled || !picked.path) {
        if (picked.error) alert(picked.error)
        return
      }
      const r = await fetch('/api/collab/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ collabProjectId, localPath: picked.path }),
      })
      const res = (await r.json().catch(() => ({}))) as CollabLinkResponse & { error?: string }
      if (!r.ok || !res.localPath) {
        alert(t(linkErrorKey(res.error)))
        return
      }
      linkedLocallyRef.current = true
      setLinkedPath(res.localPath)
      setTab('terminal')
    } finally {
      setLinking(false)
    }
  }, [collabProjectId, linking, t])

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

  // If the open canvas disappears from the shared index (the owner deleted it),
  // drop back to the canvas list instead of leaving a frozen, stale canvas open
  // (review LOW). `data` changes on adopt, so this re-checks on every peer update.
  useEffect(() => {
    if (activeCanvasId && !(data.canvasIndex ?? []).some((c) => c.id === activeCanvasId)) {
      setActiveCanvasId(null)
    }
  }, [data, activeCanvasId])

  // The Terminal tab only exists while a folder is linked. If we ever land on
  // 'terminal' without a linkedPath (defensive — there's no unlink yet), fall back
  // to the board so the body never renders an empty Terminal branch.
  useEffect(() => {
    if (tab === 'terminal' && !linkedPath) setTab('board')
  }, [tab, linkedPath])

  return (
    <Overlay
      position="absolute"
      layer="local"
      backdrop="surface"
      placement="fill"
      onClose={onClose}
      aria-label={label}
    >
      {/* Header — back to Ground, the shared name, and a realtime status pill. */}
      <DialogHeader
        separator="line"
        density="bar"
        align="center"
        onBack={onClose}
        backLabel={t('projectPanel.backToGround')}
        leading={
          <div className="flex min-w-0 items-center gap-2">
            <span className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-muted">
              <Users size={10} />
              {t('projectPanel.collabSharedBadge')}
            </span>
            <span className="truncate font-display text-[15px] text-ink" title={label}>
              {label}
            </span>
          </div>
        }
        actions={
          <>
            {/* Board / Canvas (+ Terminal once a local folder is linked) switcher. */}
            <div className="flex items-center gap-0.5 rounded-sm border border-line p-0.5">
              {(linkedPath
                ? (['board', 'canvas', 'terminal'] as const)
                : (['board', 'canvas'] as const)
              ).map((tk) => (
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
                  {tk === 'board' ? 'Board' : tk === 'canvas' ? 'Canvas' : 'Terminal'}
                </button>
              ))}
            </div>
            {/* Not linked yet → CTA to link a local folder, which unlocks Terminal.
                Sits where the Terminal tab will appear (the "obvious place"). */}
            {!linkedPath && (
              <button
                type="button"
                onClick={handleLinkFolder}
                disabled={linking}
                title={t('projectPanel.collabLinkFolderHint')}
                className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-line px-2 py-0.5 text-[11px] text-ink-muted transition-colors hover:border-accent hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                <FolderPlus size={12} />
                {t('projectPanel.collabLinkFolder')}
              </button>
            )}
            {/* Presence — who else is in this shared project right now (u15). */}
            <CollabPresence channel={collab} />
            <span
              className={`shrink-0 text-[10px] uppercase tracking-wide ${
                live ? 'text-ink-muted' : 'text-ink-faint'
              }`}
            >
              {live ? t('projectPanel.collabSharedLive') : t('projectPanel.collabSharedConnecting')}
            </span>
          </>
        }
      />

      <div className="relative min-h-0 flex-1">
        {tab === 'terminal' && linkedPath ? (
          // Terminal rooted at the member's OWN linked folder — a plain login shell
          // (POST /api/terminal validates the cwd is on the allowlist) where they
          // run `claude` in their own checkout. Dark, terminal-native surface to
          // match the owner's Terminal tab. Board/Canvas keep syncing meanwhile.
          <div className="flex h-full flex-col bg-[#1a1a1a]">
            <TerminalPane projectPath={linkedPath} slotKey="default" />
          </div>
        ) : tab === 'canvas' ? (
          activeCanvasId ? (
            <div className="flex h-full flex-col">
              <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-1.5">
                <button
                  type="button"
                  onClick={() => setActiveCanvasId(null)}
                  className="flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-1 text-[11px] text-ink-muted transition-colors hover:bg-plane hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
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
                        className="flex w-full items-center gap-2 rounded-[3px] border border-line bg-bg px-3 py-2 text-left text-[12px] text-ink transition-colors hover:border-accent hover:bg-plane focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
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
    </Overlay>
  )
}

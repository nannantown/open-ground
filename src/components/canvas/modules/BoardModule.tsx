import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, GitBranch, Trash2, X } from 'lucide-react'
import { BoardTab, columnOf } from '@/components/canvas/BoardTab'
import { newId } from '@/lib/ids'
import { api } from '@/lib/api-client'
import { deriveCardFields, wantsAutoTitle, provisionalTitle } from '@/lib/cardTitle'
import { buildReviewPrompt } from '@/lib/reviewPrompt'
import {
  CLAUDE_EFFORTS,
  type ActiveTerminalsResponse,
  type BoardColumn,
  type ClaudeBeaconStatus,
  type ClaudeEffort,
  type PrInfoResponse,
  type ProjectData,
  type ProjectMeta,
  type ProjectTask,
  type Settings,
  type TaskAttachment,
  type TaskRunSettings,
} from '@/lib/types'
import { useT } from '@/i18n/I18nContext'
import { assigneeCandidates, withRegisteredAssignee } from '@/lib/assignees'
import { dependencyCandidates } from '@/lib/boardDeps'
import { TASK_MODEL_CHOICES } from '@/lib/claudeLaunchChoices'

/** Result of a task-terminal launch attempt (ProjectPanel.launchTaskTerminal).
 *  `reason` is set only on failure: 'claudeMissing' = the server pre-flight
 *  said the `claude` CLI isn't installed (503 { claudeMissing: true });
 *  'other' = anything else (5xx, offline, …). On success `terminalId` carries
 *  the slot's PTY id so a caller can act on the fresh session before the
 *  panel's state write re-renders (the "Review with claude" paste). */
export type TaskLaunchResult = {
  ok: boolean
  reason?: 'claudeMissing' | 'other'
  terminalId?: string
}

/** The drawer's 実行 payload — the card's LIVE field values (drawer edits are
 *  debounced before they hit tasks.json) plus its per-card run overrides. The
 *  server composes the task prompt from these and passes it as the launch's
 *  initialPrompt, so claude starts working immediately. */
export type TaskRunPayload = {
  title: string
  notes: string
  attachmentIds: string[]
  flow?: 'merge' | 'pr'
  model?: string
  effort?: ClaudeEffort
}

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
  /** The task's LIVE claude PTY id (launched and not exited) — the target of
   *  the "Insert task into input" button; null disables it. */
  liveTerminalId: (taskId: string) => string | null
  /** Delete a card with full teardown (close its terminal slot, remove from
   *  tasks.json). Rendered in the drawer header, not the conversation pane. */
  onDeleteTask: (id: string) => void
  /** Launch the task's claude session. WITHOUT `opts.run` claude starts plain
   *  (no prompt sent — restart / review flows). WITH `opts.run` (the drawer's
   *  実行 button) the server composes the task prompt from the payload and
   *  claude starts working on it immediately. On failure, `reason`
   *  distinguishes a missing `claude` CLI from everything else so the retry
   *  footer can say "install claude" instead of a generic failure.
   *  `opts.cwd` overrides the spawn directory — the "Review with claude" flow
   *  launches the session inside the review worktree instead of the repo. */
  onLaunchTask: (
    task: ProjectTask,
    opts?: { cwd?: string; run?: TaskRunPayload },
  ) => Promise<TaskLaunchResult>
  /** Open the Project Settings dialog (owned by ProjectPanel). Optional —
   *  unset hides the Board toolbar's settings affordance. */
  onOpenProjectSettings?: () => void
  /** True when the project's Board/Canvas data is git-shared
   *  (ShareStatus.shared — the `.openground/openground.json` marker).
   *  Drives the one-line welcome strip a freshly imported shared clone
   *  shows above the board (F002/F090). */
  shared?: boolean
}

export const BoardModule = ({
  data,
  project,
  persist,
  detailId,
  onOpenDetail,
  renderConversation,
  hasTerminalSlot,
  liveTerminalId,
  onDeleteTask,
  onLaunchTask,
  onOpenProjectSettings,
  shared,
}: BoardModuleProps) => {
  const { t } = useT()
  // The user's display name (Settings.displayName) — feeds the drawer's "Me"
  // button and the toolbar's "Mine only" filter. The module doesn't receive
  // Settings from the panel, so fetch it lazily once per mount (cheap local
  // GET); unset/failed just hides both affordances.
  const [displayName, setDisplayName] = useState<string | null>(null)
  // True once the settings fetch has RESOLVED — the welcome strip's "is my
  // name registered?" check must wait for the real displayName, or it would
  // flash for every member during the initial null.
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  useEffect(() => {
    let cancelled = false
    api.api.settings
      .$get()
      .then(r => r.json() as Promise<Settings>)
      .then(s => {
        if (!cancelled) {
          setDisplayName(s.displayName?.trim() || null)
          setSettingsLoaded(true)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // Claude pane status by PTY id (working/waiting) — feeds each card's status
  // band + stamp. Same power etiquette as the Ground beacon poll (App.tsx):
  // every 5s, a hidden document skips the round (focus re-polls immediately),
  // and a failed poll keeps the last known state rather than flashing off.
  const [claudeStatusByPty, setClaudeStatusByPty] = useState<
    ReadonlyMap<string, ClaudeBeaconStatus>
  >(new Map())
  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      if (document.hidden) return
      try {
        const res = await api.api.terminal.active.$get()
        if (!res.ok) return
        const payload = (await res.json()) as ActiveTerminalsResponse
        if (cancelled) return
        const next = new Map<string, ClaudeBeaconStatus>()
        for (const a of payload.claude ?? []) next.set(a.id, a.status)
        // Keep the previous Map identity when nothing changed so the board
        // doesn't re-render every 5 seconds.
        setClaudeStatusByPty(prev =>
          prev.size === next.size &&
          Array.from(next).every(([id, st]) => prev.get(id) === st)
            ? prev
            : next,
        )
      } catch {
        /* server restarting / offline — keep the last known state */
      }
    }
    void poll()
    const id = window.setInterval(() => void poll(), 5_000)
    const onFocus = () => void poll()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.clearInterval(id)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  // ---- Shared-board welcome strip (F002/F090) ------------------------------
  // A teammate who imports a shared clone gets connected to the team board
  // silently — this one line says so the first time. Shown while the project
  // is git-shared AND the user's displayName isn't in the shared member list
  // (the "I just arrived" heuristic); ✕ dismisses it permanently per project
  // (localStorage, og.board.sharedWelcome.<projectId>).
  const welcomeKey = `og.board.sharedWelcome.${project.id}`
  const [welcomeDismissed, setWelcomeDismissed] = useState<boolean>(
    () => localStorage.getItem(welcomeKey) === '1',
  )
  const isRegisteredMember =
    !!displayName &&
    (data.config?.members ?? []).some(
      m => m.trim().toLowerCase() === displayName.toLowerCase(),
    )
  const showWelcome = !!shared && settingsLoaded && !welcomeDismissed && !isRegisteredMember
  const dismissWelcome = () => {
    localStorage.setItem(welcomeKey, '1')
    setWelcomeDismissed(true)
  }
  // "+ Add" inline input for a brand-new assignee name; closed whenever the
  // drawer switches cards so a half-typed name never leaks across tasks.
  const [addingAssignee, setAddingAssignee] = useState(false)
  useEffect(() => setAddingAssignee(false), [detailId])
  // "+ Add" picker for a new dependency (B025); same per-card reset.
  const [addingDep, setAddingDep] = useState(false)
  useEffect(() => setAddingDep(false), [detailId])

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

  // ---- PR state / diff stats (B023 — F058/F085) ----------------------------
  // When the open card carries a prUrl, ask the server once per drawer open
  // (`gh pr view`, 60s server-side cache). available:false — gh missing, bad
  // URL, network — renders NOTHING: a gh-less environment stays silent. No
  // busy state either; the chip simply appears when the answer arrives.
  const [prInfo, setPrInfo] = useState<PrInfoResponse | null>(null)
  const detailPrUrl = detailTask?.prUrl
  useEffect(() => {
    setPrInfo(null)
    if (!detailPrUrl) return
    let cancelled = false
    api.api.project['pr-info']
      .$post({ json: { path: project.path, prUrl: detailPrUrl } })
      .then(r => r.json() as Promise<PrInfoResponse>)
      .then(info => {
        // Unmount/card-switch guard — never setState on a dead effect.
        if (!cancelled && info.available) setPrInfo(info)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [detailId, detailPrUrl, project.path])

  // Async continuations (auto-title responses) must patch against the LATEST
  // data, not the render that started them — persisting a stale snapshot would
  // roll back edits made while the generation ran.
  const dataRef = useRef(data)
  dataRef.current = data

  // ---- Undo / redo history (B013 / F087) -----------------------------------
  // Snapshot history of the tasks array, transplanted from CanvasWorkspace's
  // snapshot + idle-coalescing pattern: every LOCAL persist that changes
  // `tasks` is committed to the undo stack after a short idle, so a drag /
  // typing / multi-patch burst collapses into ONE ⌘Z step. EXTERNAL updates
  // (shared auto-sync pulls, the panel's reload, a 409 adoption, project
  // switch) are never undoable: they reset the baseline and drop both stacks —
  // undoing a teammate's change from here would silently revert work this
  // client never made (the CanvasWorkspace lastLocal pattern). The one
  // exception is the drawer's delete, which routes through ProjectPanel
  // (onDeleteTask persists the removal itself) and announces itself via
  // adoptNextExternalRef so the deletion lands in history like a local edit.
  // An undo/redo result is persisted normally — on a shared board it syncs to
  // everyone, which is correct (the undo is itself an edit).
  const undoRef = useRef<ProjectTask[][]>([])
  const redoRef = useRef<ProjectTask[][]>([])
  const baselineRef = useRef<ProjectTask[]>(data.tasks)
  // The tasks array WE last emitted via persist — distinguishes the echo of
  // our own write (ProjectPanel's setData keeps the array identity) from an
  // external replacement.
  const lastLocalTasksRef = useRef<ProjectTask[]>(data.tasks)
  const histTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const adoptNextExternalRef = useRef(false)
  // Bumps to re-render the toolbar's undo/redo affordances when the stacks
  // change (they live in refs, invisible to React otherwise).
  const [, setHistVer] = useState(0)
  const HIST_IDLE_MS = 350
  const HIST_MAX = 80

  // Commit the pending coalesced change: push the last committed baseline onto
  // the undo stack and adopt the latest locally-emitted tasks as the baseline.
  const flushHistory = useCallback(() => {
    if (histTimer.current) {
      clearTimeout(histTimer.current)
      histTimer.current = null
    }
    const latest = lastLocalTasksRef.current
    if (baselineRef.current === latest) return
    undoRef.current.push(baselineRef.current)
    if (undoRef.current.length > HIST_MAX) undoRef.current.shift()
    redoRef.current = []
    baselineRef.current = latest
    setHistVer(v => v + 1)
  }, [])

  // The single local-persist entry point: every board mutation in this module
  // (and everything BoardTab persists — drag, inline edit, clear Done,
  // duplicate, reviewed stamp, …) goes through here so it lands in history.
  const persistTracked = useCallback(
    (next: ProjectData) => {
      lastLocalTasksRef.current = next.tasks
      persist(next)
      // Coalesce on idle. Harmless for config-only persists (the flush no-ops
      // when the tasks identity didn't move off the baseline).
      if (histTimer.current) clearTimeout(histTimer.current)
      histTimer.current = setTimeout(flushHistory, HIST_IDLE_MS)
    },
    [persist, flushHistory],
  )

  // A pending coalescing timer must never outlive the module (it would call
  // setState on an unmounted component after a tab switch).
  useEffect(
    () => () => {
      if (histTimer.current) clearTimeout(histTimer.current)
    },
    [],
  )

  // External tasks replacements arrive as a data prop whose tasks array is NOT
  // the one we last emitted. Adopt as the new baseline; drop the stacks unless
  // the change was a flagged local continuation (drawer delete).
  useEffect(() => {
    if (data.tasks === lastLocalTasksRef.current) return
    const adopt = adoptNextExternalRef.current
    adoptNextExternalRef.current = false
    if (adopt) {
      // Commit any pending local edit first, then record the pre-delete state
      // as one undoable step.
      flushHistory()
      undoRef.current.push(baselineRef.current)
      if (undoRef.current.length > HIST_MAX) undoRef.current.shift()
      redoRef.current = []
    } else {
      if (histTimer.current) {
        clearTimeout(histTimer.current)
        histTimer.current = null
      }
      undoRef.current = []
      redoRef.current = []
    }
    baselineRef.current = data.tasks
    lastLocalTasksRef.current = data.tasks
    setHistVer(v => v + 1)
  }, [data.tasks, flushHistory])

  const undo = useCallback(() => {
    flushHistory()
    if (!undoRef.current.length) return
    const prev = undoRef.current.pop()!
    redoRef.current.push(baselineRef.current)
    baselineRef.current = prev
    lastLocalTasksRef.current = prev
    persist({ ...dataRef.current, tasks: prev })
    setHistVer(v => v + 1)
  }, [flushHistory, persist])

  const redo = useCallback(() => {
    // Commit any pending coalesced edit first (mirrors undo). flushHistory
    // clears redo when it commits, so a fresh-edit-then-redo correctly becomes
    // a no-op that preserves the edit instead of dropping it.
    flushHistory()
    if (!redoRef.current.length) return
    const next = redoRef.current.pop()!
    undoRef.current.push(baselineRef.current)
    baselineRef.current = next
    lastLocalTasksRef.current = next
    persist({ ...dataRef.current, tasks: next })
    setHistVer(v => v + 1)
  }, [flushHistory, persist])

  // ⌘Z / ⇧⌘Z (and ⌘Y) — active only while the Board tab is mounted (this
  // module unmounts on tab switch). Never steals the combo from a focused
  // text field (CanvasWorkspace's field guard; xterm's hidden helper is a
  // textarea, so the terminal is covered too).
  // CAPTURE phase: App.tsx's Ground-canvas undo is a bubble listener on the
  // same window — capture guarantees this handler runs FIRST regardless of
  // registration order, so its preventDefault() is visible to App's
  // `e.defaultPrevented` guard and one ⌘Z can never fire BOTH the board undo
  // and the Ground-canvas undo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      const ae = document.activeElement
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return
      const k = e.key.toLowerCase()
      if (k === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      } else if (k === 'y') {
        e.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [undo, redo])

  // A change made <idle window> ago hasn't been committed to the undo stack
  // yet — treat a live divergence from the baseline as undoable too.
  const canUndo = undoRef.current.length > 0 || baselineRef.current !== data.tasks
  const canRedo = redoRef.current.length > 0

  const patchTask = (task: ProjectTask, patch: Partial<ProjectTask>) =>
    persistTracked({
      ...data,
      tasks: data.tasks.map(t => (t.id === task.id ? { ...t, ...patch } : t)),
    })
  const patchTaskFresh = (taskId: string, patch: Partial<ProjectTask>) => {
    const current = dataRef.current
    persistTracked({
      ...current,
      tasks: current.tasks.map(t => (t.id === taskId ? { ...t, ...patch } : t)),
    })
  }

  // ---- Drawer phase state --------------------------------------------------
  // Draft (no terminal slot): authoring gets the whole drawer. Session (slot
  // exists): the terminal owns it and the fields collapse behind the header.
  const [fieldsOpen, setFieldsOpen] = useState(false)
  useEffect(() => setFieldsOpen(false), [detailId])
  // The "options" disclosure (assignee · depends · due) inside the fields —
  // collapsed by default so the content-first drawer stays uncluttered; the
  // user expands it only when a task needs an owner / dependency / deadline.
  // Reset on card switch like fieldsOpen.
  const [optionsOpen, setOptionsOpen] = useState(false)
  useEffect(() => setOptionsOpen(false), [detailId])
  // The "run settings" disclosure (on-finish · model · effort) inside the run
  // footer — collapsed by default because the board's global defaults strip
  // already carries them; a card overrides them only when it must diverge. The
  // resolved values stay visible in the hint line below even while collapsed,
  // so folding this never hides "what will actually happen".
  const [runSettingsOpen, setRunSettingsOpen] = useState(false)
  useEffect(() => setRunSettingsOpen(false), [detailId])
  const [launching, setLaunching] = useState(false)
  const [regenBusy, setRegenBusy] = useState(false)

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

  const launchDetail = async (
    task: ProjectTask,
    opts?: { run?: TaskRunPayload },
  ): Promise<TaskLaunchResult> => {
    setLaunching(true)
    try {
      return await onLaunchTask(task, opts)
    } finally {
      setLaunching(false)
    }
  }

  // Launches that FAILED, keyed to the failure reason — rendered as
  // reason-specific copy next to the 実行 / restart button (a missing claude
  // CLI gets "install claude" guidance, not a generic failure). Pressing the
  // button again IS the retry — nothing relaunches by itself. (The drawer
  // auto-launch died 2026-06-12: opening a card no longer spawns anything;
  // the explicit 実行 button below is the only way a task session starts.)
  const [launchFailed, setLaunchFailed] = useState<Map<string, 'claudeMissing' | 'other'>>(
    new Map(),
  )

  // 実行 — launch the task's claude session WITH the composed task prompt
  // auto-sent (the server builds it from the LIVE fields + this card's run
  // overrides; claude starts working immediately). Per-card settings are
  // already persisted on the task (patchTask autosaves), but the payload
  // carries the live values so a just-edited card runs exactly as shown.
  const runTask = (task: ProjectTask) => {
    setLaunchFailed(prev => {
      if (!prev.has(task.id)) return prev
      const n = new Map(prev)
      n.delete(task.id)
      return n
    })
    // Content-first: the title field is gone, so the card may have no title
    // yet. The server's prompt contract still requires one (composeTaskPrompt →
    // `# Task: <title>`), so derive a provisional title from the content's
    // first line HERE — synchronously, fed straight into the payload (a state
    // round-trip could race the launch and send an empty title → 404). It is
    // also persisted with titleAuto so the post-launch haiku pass can refine
    // it (multi-line / clipped content only); a hand-typed title is untouched.
    const content = task.notes ?? ''
    let runTitle = task.title.trim()
    if (!runTitle) {
      runTitle = provisionalTitle(content)
      if (runTitle) {
        patchTask(task, { title: runTitle, titleAuto: true })
        if (wantsAutoTitle(deriveCardFields(content)))
          void api.api.project['task-title']
            .$post({ json: { path: project.path, id: task.id } })
            .catch(() => {})
      }
    }
    void launchDetail(task, {
      run: {
        title: runTitle,
        notes: content,
        attachmentIds: (task.attachments ?? []).map(a => a.id),
        flow: task.run?.flow,
        model: task.run?.model,
        effort: task.run?.effort,
      },
    }).then(res => {
      if (!res?.ok) {
        setLaunchFailed(prev => new Map(prev).set(task.id, res?.reason ?? 'other'))
      }
    })
  }

  // Restart a DEAD task session (F081): the slot still exists
  // (hasTerminalSlot) but its PTY exited (liveTerminalId === null). Relaunches
  // PLAIN (no prompt is sent — the session is for follow-ups; "Insert task
  // into input" can re-inject the content unsent). A failed restart re-flags
  // launchFailed so the reason-specific copy renders next to the button.
  const restartSession = (task: ProjectTask) => {
    setLaunchFailed(prev => {
      if (!prev.has(task.id)) return prev
      const n = new Map(prev)
      n.delete(task.id)
      return n
    })
    void launchDetail(task).then(res => {
      if (!res?.ok) {
        setLaunchFailed(prev => new Map(prev).set(task.id, res?.reason ?? 'other'))
      }
    })
  }

  // "Insert task into input" — paste the task's title + content into the live
  // claude PTY UNSENT (bracketed paste, no trailing newline): the user reviews
  // the prompt in the input box and presses Enter to run it. Raw fetch, same
  // style as ProjectPanel's launchTaskTerminal.
  // "Try this branch" — ensure a local worktree checkout of the task branch
  // and reveal it in the file manager (reviewer flow F061). One click, no
  // terminal gymnastics; errors land inline next to the button.
  const [checkoutBusy, setCheckoutBusy] = useState(false)
  const [checkoutNotice, setCheckoutNotice] = useState<string | null>(null)
  const openBranchLocally = async (task: ProjectTask) => {
    if (!task.branch) return
    setCheckoutBusy(true)
    setCheckoutNotice(null)
    try {
      const res = await fetch('/api/project/review-worktree', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: project.path, branch: task.branch }),
      })
      const json = (await res.json().catch(() => ({}))) as {
        dir?: string
        error?: string
        code?: string
      }
      if (!res.ok || !json.dir) {
        // Localize by the machine-readable code (ReviewWorktreeErrorCode) —
        // never echo the server's English git message verbatim.
        setCheckoutNotice(
          t(
            json.code === 'invalid-branch'
              ? 'board.detail.tryBranchInvalid'
              : json.code === 'git-failed'
                ? 'board.detail.tryBranchGitFailed'
                : 'board.detail.tryBranchFailed', // 'not-pushed' + anything unknown
          ),
        )
        return
      }
      await fetch('/api/project/reveal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: json.dir }),
      }).catch(() => {})
    } catch {
      setCheckoutNotice(t('board.detail.tryBranchFailed'))
    } finally {
      setCheckoutBusy(false)
    }
  }

  // "Review with claude" (F064) — one click for the reviewer: ensure the task
  // branch's review worktree, make sure the card has a LIVE claude session
  // (reuse it if alive; launch INSIDE the worktree if not), then paste a
  // diff-review instruction into the input box UNSENT (generic
  // /api/terminal/:id/paste — bracketed paste, no trailing newline). Nothing
  // runs until the user presses Enter — same philosophy as "Insert task into
  // input". Errors land inline, tryBranch-style.
  const [reviewBusy, setReviewBusy] = useState(false)
  const [reviewNotice, setReviewNotice] = useState<string | null>(null)
  const reviewWithClaude = async (task: ProjectTask) => {
    if (!task.branch) return
    setReviewBusy(true)
    setReviewNotice(null)
    try {
      const res = await fetch('/api/project/review-worktree', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: project.path, branch: task.branch }),
      })
      const json = (await res.json().catch(() => ({}))) as {
        dir?: string
        error?: string
        code?: string
      }
      if (!res.ok || !json.dir) {
        // Same code → copy mapping as "Open locally" — never echo raw git.
        setReviewNotice(
          t(
            json.code === 'invalid-branch'
              ? 'board.detail.tryBranchInvalid'
              : json.code === 'git-failed'
                ? 'board.detail.tryBranchGitFailed'
                : 'board.detail.tryBranchFailed', // 'not-pushed' + anything unknown
          ),
        )
        return
      }
      // Reuse the card's live session if there is one (claude can read any
      // path — the prompt names the worktree dir explicitly, no cd needed);
      // otherwise launch a fresh claude INSIDE the worktree and bind it to
      // this card's slot (onLaunchTask = ProjectPanel.launchTaskTerminal).
      let ptyId = liveTerminalId(task.id)
      if (!ptyId) {
        const launched = await onLaunchTask(task, { cwd: json.dir })
        if (!launched.ok) {
          setReviewNotice(t('board.detail.reviewWithClaudeFailed'))
          return
        }
        if (launched.terminalId) {
          ptyId = launched.terminalId
          // Give the freshly spawned claude a beat to bring its TUI up before
          // the paste bytes arrive — bracketed-paste markers written while the
          // shell is still exec-ing claude would land as raw keystrokes. Best-
          // effort (the paste is unsent either way, so worst case the user
          // sees it garbled and re-clicks).
          await new Promise(r => setTimeout(r, 1500))
        } else {
          // { ok: true } WITHOUT a terminalId = another launch for this task
          // was already in flight (launchTaskTerminal's double-spawn guard) —
          // not a failure. The PTY id lands in the panel's taskTerminals map
          // when that launch resolves; poll liveTerminalId for it (the prop
          // reads live refs, so a captured copy sees the update).
          for (let i = 0; i < 10 && !ptyId; i++) {
            await new Promise(r => setTimeout(r, 500))
            ptyId = liveTerminalId(task.id)
          }
          if (!ptyId) {
            setReviewNotice(t('board.detail.reviewWithClaudeFailed'))
            return
          }
        }
      }
      const text = buildReviewPrompt({
        branch: task.branch,
        dir: json.dir,
        base: data.config?.targetBranch,
      })
      const pasteRes = await fetch(`/api/terminal/${encodeURIComponent(ptyId)}/paste`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: project.path, text }),
      })
      if (!pasteRes.ok) setReviewNotice(t('board.detail.reviewWithClaudeFailed'))
    } catch {
      setReviewNotice(t('board.detail.reviewWithClaudeFailed'))
    } finally {
      setReviewBusy(false)
    }
  }

  // ---- Image attachments (B022) --------------------------------------------
  // Screenshots pasted/dropped on the content field (or picked via the file
  // input) upload to /api/project/task-asset and land on the card as
  // { id, name, mime } — the id is a content-hash file name, never a path.
  // "Insert task into input" then sends the live id list so the server appends
  // the absolute paths claude can Read.
  const MAX_ATTACH_BYTES = 5 * 1024 * 1024
  // Counter, not a boolean — parallel uploads (multi-file drop/pick) each
  // increment/decrement, so the busy state only clears when the LAST one lands.
  const [attachBusy, setAttachBusy] = useState(0)
  const [attachError, setAttachError] = useState<string | null>(null)
  useEffect(() => setAttachError(null), [detailId])
  const attachmentUrl = (a: TaskAttachment) =>
    `/api/project/task-asset?path=${encodeURIComponent(project.path)}&id=${encodeURIComponent(a.id)}`
  const uploadAttachment = async (task: ProjectTask, file: File) => {
    if (!file.type.startsWith('image/')) return
    if (file.size > MAX_ATTACH_BYTES) {
      setAttachError(t('board.detail.attachTooLarge'))
      return
    }
    setAttachBusy(n => n + 1)
    setAttachError(null)
    try {
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(file)
      })
      const res = await fetch('/api/project/task-asset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: project.path, name: file.name, mime: file.type, dataBase64 }),
      })
      if (!res.ok) {
        setAttachError(
          t(res.status === 413 ? 'board.detail.attachTooLarge' : 'board.detail.attachFailed'),
        )
        return
      }
      const saved = (await res.json()) as TaskAttachment
      // Append against the FRESH card (the upload round-trip may have raced a
      // notes edit); content-addressing makes a re-paste a no-op.
      const current = dataRef.current.tasks.find(x => x.id === task.id)
      const list = current?.attachments ?? []
      if (!list.some(a => a.id === saved.id)) {
        patchTaskFresh(task.id, { attachments: [...list, saved] })
      }
    } catch {
      setAttachError(t('board.detail.attachFailed'))
    } finally {
      setAttachBusy(n => n - 1)
    }
  }
  const uploadAttachments = (task: ProjectTask, files: Iterable<File>) => {
    for (const f of Array.from(files).filter(f => f.type.startsWith('image/'))) {
      void uploadAttachment(task, f)
    }
  }
  const removeAttachment = (task: ProjectTask, id: string) => {
    const current = dataRef.current.tasks.find(x => x.id === task.id)
    const rest = (current?.attachments ?? []).filter(a => a.id !== id)
    patchTaskFresh(task.id, { attachments: rest.length ? rest : undefined })
    // Best-effort byte cleanup — the server skips the unlink while any OTHER
    // card still references it. taskId names THIS card so its stale saved
    // reference (the persist above is debounced) doesn't block the reap.
    void fetch(
      `/api/project/task-asset?path=${encodeURIComponent(project.path)}&id=${encodeURIComponent(id)}&taskId=${encodeURIComponent(task.id)}`,
      { method: 'DELETE' },
    ).catch(() => {})
  }

  const [inserting, setInserting] = useState(false)
  const [insertError, setInsertError] = useState<string | null>(null)
  const insertTask = async (task: ProjectTask) => {
    const ptyId = liveTerminalId(task.id)
    if (!ptyId) return
    setInserting(true)
    setInsertError(null)
    try {
      // Send the LIVE title/notes (drawer edits are debounced before they hit
      // tasks.json, and a brand-new card may not be persisted yet) so the
      // server pastes exactly what's on screen, not a stale disk copy.
      const res = await fetch(`/api/terminal/${encodeURIComponent(ptyId)}/paste-task`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          path: project.path,
          taskId: task.id,
          title: task.title,
          notes: task.notes ?? '',
          // Live attachment ids (same freshness rationale as title/notes) —
          // the server resolves them to absolute paths claude can Read.
          attachmentIds: (task.attachments ?? []).map(a => a.id),
        }),
      })
      // Distinct copy per failure: 400 = the composed prompt blew the server's
      // size cap ("task content too large") — splitting the task is the fix,
      // relaunching won't help; 404 = the PTY is gone (not-found-or-finished)
      // — relaunch is the fix; anything else gets the generic copy; the catch
      // means the request never reached the server at all.
      if (!res.ok) {
        setInsertError(
          t(
            res.status === 400
              ? 'board.detail.insertTaskTooLarge'
              : 'board.detail.insertTaskFailed',
          ),
        )
      }
    } catch {
      setInsertError(t('board.detail.insertTaskFailedNetwork'))
    } finally {
      setInserting(false)
    }
  }

  // One line of "what happens on finish" — answers the where-does-my-code-go
  // question BEFORE launch (Draft bar) and DURING the session (status strip).
  // Per-card: the card's run.flow override wins over the board default.
  const flowTextFor = (task: ProjectTask): string | null => {
    if (!project.hasGit) return null
    const base = data.config?.targetBranch?.trim() || t('board.detail.flowBaseDefault')
    const flow = task.run?.flow ?? data.config?.completionFlow
    if (flow === 'pr') {
      // With the review column on, the card MOVES on PR-open — say so up
      // front, or the auto-move reads as "the board did something behind
      // my back" (F049/F050).
      return data.config?.reviewColumn
        ? t('board.detail.flowPrReview', { base })
        : t('board.detail.flowPr', { base })
    }
    return t('board.detail.flowMerge', { base })
  }

  // One quiet line for HOW the work is isolated (git: own task/ branch in its
  // own worktree) + WHICH profile the session launches with (board defaults,
  // overridden by this card's run settings). Answers "what exactly starts
  // when I run this" (F026–F028).
  const isolationText = project.hasGit ? t('board.detail.isolationNote') : null
  const profileTextFor = (task: ProjectTask): string => {
    const mode = data.launch?.permissionMode ?? 'default'
    const model =
      task.run?.model?.trim() ||
      data.launch?.model?.trim() ||
      t('board.detail.profileModelDefault')
    const effort = task.run?.effort ?? data.launch?.effort
    const base = t('board.detail.profileNote', { mode, model })
    return effort ? `${base} · ${effort}` : base
  }

  // Persist one key of the card's per-card run settings (autosaved like every
  // other drawer field). All-default collapses to `run: undefined` so a card
  // that never diverges carries no extra data.
  const patchRunSetting = (task: ProjectTask, patch: Partial<TaskRunSettings>) => {
    const next: TaskRunSettings = { ...task.run, ...patch }
    if (!next.flow) delete next.flow
    if (!next.model) delete next.model
    if (!next.effort) delete next.effort
    patchTask(task, { run: Object.keys(next).length ? next : undefined })
  }

  // The per-card run settings row (PR/merge · model · effort) + the 実行
  // button. Each select's first option is "default" = inherit the board's
  // visible defaults strip; the resolved default is spelled out in the option
  // label so "what will actually happen" never requires a settings dive.
  const runSettingsRow = (task: ProjectTask) => {
    // Roomy, full-width controls — each setting gets its own line: a fixed-width
    // small-caps label on the left, the select fills the remaining width. This
    // reads cleanly and "uses the width" instead of the old cramped inline wrap.
    const selectCls =
      'min-w-0 flex-1 rounded-[3px] border border-line bg-bg-card px-2.5 py-1.5 text-[12px] text-ink-muted transition-colors hover:border-ink-faint focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-40'
    const rowCls = 'flex items-center gap-3'
    const capCls = 'w-20 shrink-0 label-cap text-ink-faint'
    const defaultModel = data.launch?.model?.trim() || t('board.run.modelCliDefault')
    const defaultEffort = data.launch?.effort ?? t('board.run.effortCliDefault')
    const modelChoices = TASK_MODEL_CHOICES.includes(task.run?.model ?? '')
      ? TASK_MODEL_CHOICES
      : task.run?.model
        ? [task.run.model, ...TASK_MODEL_CHOICES]
        : TASK_MODEL_CHOICES
    return (
      <div className="space-y-2.5">
        {project.hasGit && (
          <label className={rowCls}>
            <span className={capCls}>{t('board.run.flowLabel')}</span>
            <select
              value={task.run?.flow ?? ''}
              onChange={e =>
                patchRunSetting(task, {
                  flow: e.target.value === 'merge' || e.target.value === 'pr'
                    ? e.target.value
                    : undefined,
                })
              }
              className={selectCls}
            >
              <option value="">
                {t('board.run.inheritDefault', {
                  value: t(
                    (data.config?.completionFlow ?? 'merge') === 'pr'
                      ? 'board.run.flowPr'
                      : 'board.run.flowMerge',
                  ),
                })}
              </option>
              <option value="merge">{t('board.run.flowMerge')}</option>
              <option value="pr">{t('board.run.flowPr')}</option>
            </select>
          </label>
        )}
        <label className={rowCls}>
          <span className={capCls}>{t('board.run.modelLabel')}</span>
          <select
            value={task.run?.model ?? ''}
            onChange={e => patchRunSetting(task, { model: e.target.value || undefined })}
            className={selectCls}
          >
            <option value="">
              {t('board.run.inheritDefault', { value: defaultModel })}
            </option>
            {modelChoices.map(m => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className={rowCls}>
          <span className={capCls}>{t('board.run.effortLabel')}</span>
          <select
            value={task.run?.effort ?? ''}
            onChange={e =>
              patchRunSetting(task, {
                effort: CLAUDE_EFFORTS.includes(e.target.value as ClaudeEffort)
                  ? (e.target.value as ClaudeEffort)
                  : undefined,
              })
            }
            className={selectCls}
          >
            <option value="">
              {t('board.run.inheritDefault', { value: defaultEffort })}
            </option>
            {CLAUDE_EFFORTS.map(lv => (
              <option key={lv} value={lv}>
                {lv}
              </option>
            ))}
          </select>
        </label>
      </div>
    )
  }

  // The task fields, shared by Draft (grow=true: the content textarea fills the
  // drawer, autoFocusContent puts the cursor there on open) and the Session
  // header's expandable block (grow=false: fixed share, scrolls inside). There
  // is NO title input — the title is auto-generated on Run (see runTask) and
  // shown on the card / Session header. Images dropped or pasted onto the
  // content attach to the card and appear as a thumbnail strip right below it;
  // there is no separate image picker. Assignee / depends / due are optional —
  // tucked behind a disclosure when collapsibleOptions (the compose drawer),
  // inline otherwise (the Session header, already behind its own chevron).
  const fieldsBlock = (
    task: ProjectTask,
    {
      grow,
      autoFocusContent = false,
      collapsibleOptions = false,
    }: { grow: boolean; autoFocusContent?: boolean; collapsibleOptions?: boolean },
  ) => (
    <>
      <div>
        <label className="mb-1 block shrink-0 label-cap text-ink-faint">
          {t('board.detail.notesLabel')}
        </label>
        <textarea
          key={task.id + ':notes'}
          // Cursor lands here when the compose drawer opens — content first.
          {...(autoFocusContent ? { autoFocus: true } : {})}
          defaultValue={task.notes ?? ''}
          onBlur={e => {
            const v = e.target.value
            if (v !== (task.notes ?? '')) patchTask(task, { notes: v || undefined })
          }}
          // Screenshot in the clipboard → attach instead of dumping bytes into
          // the text. A mixed clipboard (text + image) keeps the default text
          // insert AND attaches the image.
          onPaste={e => {
            const files = Array.from(e.clipboardData?.files ?? []).filter(f =>
              f.type.startsWith('image/'),
            )
            if (!files.length) return
            if (!e.clipboardData.getData('text/plain')) e.preventDefault()
            uploadAttachments(task, files)
          }}
          onDragOver={e => {
            if (e.dataTransfer.types.includes('Files')) e.preventDefault()
          }}
          onDrop={e => {
            // ANY file drop is consumed — a non-image (PDF etc.) must not fall
            // through to the browser default (navigating the page away).
            if (!e.dataTransfer?.types.includes('Files')) return
            e.preventDefault()
            const files = Array.from(e.dataTransfer.files).filter(f =>
              f.type.startsWith('image/'),
            )
            if (files.length) uploadAttachments(task, files)
          }}
          placeholder={t('board.detail.notesPlaceholder')}
          rows={grow ? undefined : 3}
          // Content-first but height-capped: a comfortable ~200px default that
          // no longer eats the whole drawer, vertically resizable from the
          // native bottom-right grip when a task needs more room.
          className={[
            'w-full rounded-[3px] border border-line bg-bg px-2.5 py-2 text-[12px] leading-relaxed text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none',
            grow ? 'min-h-[200px] resize-y' : 'resize-y',
          ].join(' ')}
        />
        {/* Attached images — paste/drop onto the content above lands them
            here, directly under it (they ARE part of the content); click a
            thumbnail to open the original, × removes. No add-image button:
            paste / drag-drop is the only way in. */}
        {((task.attachments ?? []).length > 0 || attachBusy > 0 || attachError) && (
          <div className="mt-2 shrink-0">
            <div className="flex flex-wrap items-center gap-2">
              {(task.attachments ?? []).map(a => (
                <span key={a.id} className="relative inline-flex">
                  <a
                    href={attachmentUrl(a)}
                    target="_blank"
                    rel="noreferrer"
                    title={a.name}
                    className="block rounded-[3px] border border-line transition-colors hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    <img
                      src={attachmentUrl(a)}
                      alt={a.name}
                      className="h-12 w-12 rounded-[2px] object-cover"
                    />
                  </a>
                  <button
                    type="button"
                    onClick={() => removeAttachment(task, a.id)}
                    title={t('board.detail.attachRemove')}
                    aria-label={t('board.detail.attachRemove')}
                    className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full border border-line bg-bg-card text-ink-faint transition-colors hover:border-accent hover:text-accent active:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
              {attachBusy > 0 && (
                <span className="label-cap text-ink-faint">{t('board.detail.attachBusy')}</span>
              )}
            </div>
            {attachError && (
              <p className="mt-1 text-[10px] text-accent" title={attachError}>
                {attachError}
              </p>
            )}
          </div>
        )}
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
      {/* Options — assignee · depends · due. Collapsed by default in the
          compose drawer (the user opens it only when needed); inline in the
          Session header (already behind its own chevron). */}
      {collapsibleOptions && (
        <button
          type="button"
          onClick={() => setOptionsOpen(o => !o)}
          aria-expanded={optionsOpen}
          className="-mx-1 flex shrink-0 items-center gap-1.5 rounded-sm px-1 py-1 text-left transition-colors hover:bg-bg-inset focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        >
          <ChevronRight
            size={12}
            className={`shrink-0 text-ink-faint transition-transform ${optionsOpen ? 'rotate-90' : ''}`}
          />
          <span className="label-cap text-ink-faint">{t('board.detail.optionsLabel')}</span>
        </button>
      )}
      {(!collapsibleOptions || optionsOpen) && (
        // Assignee · depends · due laid out side-by-side, filling the width:
        // an auto-fit grid keys off the DRAWER width (not the viewport), so a
        // wide drawer shows three columns and a narrow one folds them down —
        // no big empty gutter on the right.
        <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] items-start gap-x-8 gap-y-4">
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
                    if (v) persistTracked(withRegisteredAssignee(data, task.id, v))
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
                  if (v) persistTracked(withRegisteredAssignee(data, task.id, v))
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
      {/* Depends on (B025) — informational only: chips name the cards that
          should land first; nothing blocks on them. The "+ Add" select offers
          other cards on this board, minus self, existing deps and cards that
          already depend on THIS one (one-level cycle check). Ids of deleted
          cards are skipped at render but kept in the data. */}
      <div className="shrink-0">
        <label className="mb-1 block label-cap text-ink-faint">
          {t('board.detail.dependsLabel')}
        </label>
        <div className="flex flex-wrap items-center gap-1.5">
          {(task.dependsOn ?? []).map(depId => {
            const dep = data.tasks.find(x => x.id === depId)
            if (!dep) return null
            const depTitle = dep.title.trim() || t('board.card.untitledParen')
            return (
              <span
                key={depId}
                className="flex max-w-[180px] shrink-0 items-center gap-1 rounded-sm border border-line px-2 py-1 text-[11px] text-ink-muted"
              >
                <span className="min-w-0 truncate" title={depTitle}>
                  {depTitle}
                </span>
                <button
                  type="button"
                  aria-label={t('board.detail.dependsRemove', { title: depTitle })}
                  title={t('board.detail.dependsRemove', { title: depTitle })}
                  onClick={() => {
                    const next = (task.dependsOn ?? []).filter(id => id !== depId)
                    patchTask(task, { dependsOn: next.length ? next : undefined })
                  }}
                  className="shrink-0 rounded-sm px-0.5 text-ink-faint transition-colors hover:bg-bg-inset hover:text-ink active:bg-bg-inset active:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                >
                  ✕
                </button>
              </span>
            )
          })}
          {(() => {
            const candidates = dependencyCandidates(task, data.tasks)
            if (addingDep)
              return (
                <select
                  autoFocus
                  value=""
                  onChange={e => {
                    const id = e.target.value
                    if (id) patchTask(task, { dependsOn: [...(task.dependsOn ?? []), id] })
                    setAddingDep(false)
                  }}
                  onBlur={() => setAddingDep(false)}
                  onKeyDown={e => {
                    if (e.key === 'Escape') {
                      e.stopPropagation() // cancel the add only — keep the drawer open
                      setAddingDep(false)
                    }
                  }}
                  className="max-w-[200px] rounded-[3px] border border-accent bg-bg px-2 py-1 text-[12px] text-ink focus:outline-none"
                >
                  <option value="" disabled>
                    {t('board.detail.dependsPick')}
                  </option>
                  {candidates.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.title.trim() || t('board.card.untitledParen')}
                    </option>
                  ))}
                </select>
              )
            return (
              <button
                type="button"
                onClick={() => setAddingDep(true)}
                disabled={candidates.length === 0}
                title={candidates.length === 0 ? t('board.detail.dependsNone') : undefined}
                className="shrink-0 rounded-sm border border-dashed border-line px-2.5 py-1 text-[11px] text-ink-faint transition-colors hover:border-line hover:bg-bg-inset hover:text-ink active:bg-bg-inset active:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-faint focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                {t('board.detail.dependsAdd')}
              </button>
            )
          })()}
        </div>
      </div>
      {/* Due date (B026) — a soft deadline chip, no sorting / no alerts. The
          native date input has no IME path, so a controlled value is safe. */}
      <div className="shrink-0">
        <label className="mb-1 block label-cap text-ink-faint">
          {t('board.detail.dueLabel')}
        </label>
        <div className="flex items-center gap-1.5">
          <input
            type="date"
            value={task.dueDate ?? ''}
            onChange={e => patchTask(task, { dueDate: e.target.value || undefined })}
            className="rounded-[3px] border border-line bg-bg px-2 py-1 text-[12px] text-ink transition-colors hover:border-ink-faint focus:border-accent focus:outline-none"
          />
          {task.dueDate && (
            <button
              type="button"
              aria-label={t('board.detail.dueClear')}
              title={t('board.detail.dueClear')}
              onClick={() => patchTask(task, { dueDate: undefined })}
              className="shrink-0 rounded-sm px-1.5 py-1 text-[11px] text-ink-faint transition-colors hover:bg-bg-inset hover:text-ink active:bg-bg-inset active:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              ✕
            </button>
          )}
        </div>
      </div>
        </div>
      )}
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
      persistTracked({ ...data, tasks: data.tasks.filter(t => t.id !== detailTask.id) })
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
        // The depends-on <select> handles its own Escape (cancel the add, keep
        // the drawer) — this CAPTURE listener fires before its React handler,
        // so without the exemption Esc would close the whole drawer.
        el instanceof HTMLSelectElement ||
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
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {showWelcome && (
          <div className="flex shrink-0 items-center gap-2 border-b border-line-soft px-4 py-1.5">
            <p className="min-w-0 flex-1 truncate text-[11px] leading-relaxed text-ink-muted">
              {t('projectPanel.sharedWelcome')}
              {!displayName && <> {t('projectPanel.sharedWelcomeName')}</>}
            </p>
            <button
              type="button"
              onClick={dismissWelcome}
              title={t('projectPanel.sharedWelcomeDismiss')}
              aria-label={t('projectPanel.sharedWelcomeDismiss')}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-ink-faint transition-colors hover:bg-bg-inset hover:text-ink active:bg-bg-inset active:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            >
              <X size={12} />
            </button>
          </div>
        )}
        <div className="min-h-0 min-w-0 flex-1">
          <BoardTab
            data={data}
            onPersist={persistTracked}
            // Undo/redo (B013) — history lives HERE (the layer owning data +
            // persist); BoardTab only renders the toolbar affordance.
            undoState={{ canUndo, canRedo, onUndo: undo, onRedo: redo }}
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
              persistTracked({ ...data, tasks: [...data.tasks, task] })
              return task.id
            }}
            projectMissing={project.missing}
            hasGit={project.hasGit}
            projectId={project.id}
            // Merged-branch detection (B018): the poll needs the project path.
            projectPath={project.path}
            displayName={displayName}
            sessionStatus={taskId => {
              const ptyId = liveTerminalId(taskId)
              if (!ptyId) return null
              // A just-launched pane the poll hasn't seen yet is painting its
              // banner right now — 'working' is the truthful default.
              return claudeStatusByPty.get(ptyId) ?? 'working'
            }}
            onOpenProjectSettings={onOpenProjectSettings}
          />
        </div>
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
                // The delete persists via ProjectPanel (terminal teardown +
                // task removal) — flag it so the resulting external tasks
                // change is ADOPTED into undo history instead of wiping it
                // (誤削除 must be ⌘Z-recoverable).
                adoptNextExternalRef.current = true
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
                  Content-first: one content textarea (autofocused) fills the
                  height, images paste/drop into it, and assignee/depends/due
                  hide behind an Options disclosure. No title field — Run
                  auto-generates the title (see runTask). */
            <>
              <div className="flex min-h-0 flex-1 flex-col space-y-4 overflow-y-auto px-5 py-3">
                {fieldsBlock(detailTask, {
                  grow: true,
                  autoFocusContent: true,
                  collapsibleOptions: true,
                })}
              </div>
              {/* Run footer — nothing launches by itself anymore: the card's
                  per-card run settings (PR/merge · model · effort, autosaved
                  on the task) sit above an explicit 実行 button that launches
                  claude WITH the task prompt auto-sent. A review/blocked card
                  carrying a branch additionally offers "Review with claude"
                  (worktree + unsent diff prompt — a different action). */}
              <div className="shrink-0 space-y-2.5 border-t border-line-soft px-5 py-3">
                {project.missing ? (
                  <p className="text-[11px] leading-relaxed text-ink-faint">
                    {t('board.run.missingFolder')}
                  </p>
                ) : (
                  <>
                    {/* Run settings — collapsed by default: the board's global
                        defaults strip already carries on-finish / model / effort,
                        so a card surfaces them only when it must diverge. Even
                        folded, the hint line below still spells out the resolved
                        flow + launch profile, so "what will happen" stays visible. */}
                    <button
                      type="button"
                      onClick={() => setRunSettingsOpen(o => !o)}
                      aria-expanded={runSettingsOpen}
                      className="-mx-1 flex items-center gap-1.5 rounded-sm px-1 py-1 text-left transition-colors hover:bg-bg-inset focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                    >
                      <ChevronRight
                        size={12}
                        className={`shrink-0 text-ink-faint transition-transform ${runSettingsOpen ? 'rotate-90' : ''}`}
                      />
                      <span className="label-cap text-ink-faint">
                        {t('board.run.settingsLabel')}
                      </span>
                    </button>
                    {runSettingsOpen && (
                      <div className="pb-1 pt-0.5">{runSettingsRow(detailTask)}</div>
                    )}
                    <p className="text-[11px] leading-relaxed text-ink-faint">
                      {!(detailTask.notes ?? '').trim()
                        ? t('board.run.needsContent')
                        : t('board.run.hint')}
                      {isolationText ? ` · ${isolationText}` : ''}
                      {flowTextFor(detailTask) ? ` · ${flowTextFor(detailTask)}` : ''}
                      <span className="text-ink-faint/80" title={t('board.detail.profileTitle')}>
                        {' · '}
                        {profileTextFor(detailTask)}
                      </span>
                    </p>
                    {launchFailed.has(detailTask.id) && (
                      <p className="text-[11px] leading-relaxed text-accent">
                        {t(
                          launchFailed.get(detailTask.id) === 'claudeMissing'
                            ? 'board.run.failedClaudeMissing'
                            : 'board.run.failed',
                        )}
                      </p>
                    )}
                    {/* Action bar — 実行 anchors the bottom-right; Review (only on
                        review/blocked cards with a branch) sits to its left; a
                        review notice fills the remaining width on the left. */}
                    <div className="flex items-center justify-end gap-2">
                      {reviewNotice && (
                        <span
                          className="mr-auto min-w-0 truncate text-[10px] text-accent"
                          title={reviewNotice}
                        >
                          {reviewNotice}
                        </span>
                      )}
                      {(columnOf(detailTask) === 'review' ||
                        columnOf(detailTask) === 'blocked') &&
                        detailTask.branch && (
                          <button
                            type="button"
                            disabled={reviewBusy || launching}
                            onClick={() => void reviewWithClaude(detailTask)}
                            title={t('board.detail.reviewWithClaudeTitle')}
                            className="shrink-0 rounded-sm border border-line px-2.5 py-1 text-[11px] text-ink-muted transition-colors hover:border-accent hover:bg-accent/10 hover:text-ink active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                          >
                            {reviewBusy
                              ? t('board.detail.reviewWithClaudeBusy')
                              : t('board.detail.reviewWithClaude')}
                          </button>
                        )}
                      <button
                        type="button"
                        onClick={() => runTask(detailTask)}
                        // reviewBusy too: "Review with claude" may be mid-launch
                        // on this same card — a concurrent 実行 would hit the
                        // double-spawn guard and lie ("起動中…" with nothing
                        // launching). Mirror of the review button's `launching`.
                        // Content-first gate: Run needs CONTENT (the title is
                        // derived from it on launch), not a hand-typed title.
                        disabled={launching || reviewBusy || !(detailTask.notes ?? '').trim()}
                        title={
                          (detailTask.notes ?? '').trim()
                            ? t('board.run.buttonTitle')
                            : t('board.run.needsContent')
                        }
                        className="shrink-0 rounded-sm border border-accent bg-accent px-4 py-1.5 text-[12px] font-medium text-bg-card transition-colors hover:bg-accent/85 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      >
                        {launching ? t('board.run.buttonBusy') : t('board.run.button')}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </>
          ) : (
            /* ── SESSION — the terminal owns the drawer. The task collapses to
                  a one-line header (chevron expands the fields) + a status
                  strip narrating where the work lives (branch / flow / PR). */
            <>
              <div className="shrink-0 border-b border-line-soft">
                {/* Title row — the title is auto (no input); the chevron
                    expands the fields, the ✦ regenerates the auto-title from
                    the content (the one place manual regenerate lives now). */}
                <div className="flex items-center">
                  <button
                    type="button"
                    onClick={() => setFieldsOpen(o => !o)}
                    aria-expanded={fieldsOpen}
                    title={t('board.detail.fieldsToggle')}
                    className="flex min-w-0 flex-1 items-center gap-1.5 px-5 py-2 text-left transition-colors hover:bg-bg-inset focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                  >
                    <ChevronRight
                      size={13}
                      className={`shrink-0 text-ink-faint transition-transform ${fieldsOpen ? 'rotate-90' : ''}`}
                    />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                      {detailTask.title.trim() || t('board.card.untitled')}
                    </span>
                    {detailTask.titleAuto && (
                      <span
                        className="shrink-0 text-accent"
                        title={t('board.detail.titleAutoTitle')}
                      >
                        ✦
                      </span>
                    )}
                  </button>
                  {Boolean(detailTask.title.trim() || (detailTask.notes ?? '').trim()) && (
                    <button
                      type="button"
                      onClick={() => void regenerateTitle(detailTask)}
                      disabled={regenBusy}
                      title={t('board.detail.regenTitle')}
                      className="mr-3 shrink-0 rounded-sm px-1.5 py-0.5 text-[12px] text-ink-faint transition-colors hover:bg-bg-inset hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    >
                      {regenBusy ? '✦ …' : '✦'}
                    </button>
                  )}
                </div>
                {(detailTask.branch || flowTextFor(detailTask) || detailTask.prUrl) && (
                  /* flex-wrap: a long branch name / flow note / profile chip
                     must wrap to the next line, never push the row past the
                     drawer edge (long-text robustness, F098). */
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 pb-2 text-[11px] text-ink-faint">
                    {detailTask.branch && (
                      <span
                        className="flex min-w-0 items-center gap-1"
                        // The visible name truncates — put the FULL branch in
                        // the tooltip, not just the generic label.
                        title={`${t('board.detail.branchTitle')}: ${detailTask.branch}`}
                      >
                        <GitBranch size={11} className="shrink-0" />
                        <span className="truncate">{detailTask.branch}</span>
                      </span>
                    )}
                    {detailTask.branch && (
                      <button
                        type="button"
                        // Also disabled while the project folder is gone — the
                        // worktree checkout needs the repo on disk.
                        disabled={checkoutBusy || project.missing}
                        onClick={() => void openBranchLocally(detailTask)}
                        title={t('board.detail.tryBranchTitle')}
                        className="shrink-0 rounded-sm border border-line px-1.5 py-0.5 text-[10px] text-ink-muted transition-colors hover:border-accent hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                      >
                        {checkoutBusy ? t('board.detail.tryBranchBusy') : t('board.detail.tryBranch')}
                      </button>
                    )}
                    {checkoutNotice && (
                      <span
                        className="min-w-0 truncate text-[10px] text-accent"
                        title={checkoutNotice}
                      >
                        {checkoutNotice}
                      </span>
                    )}
                    {/* Review with claude (F064) — reviewer's one-click: shown
                        once the card is review-shaped (in the Review column or
                        carrying a PR). Ensures the review worktree, then puts
                        a diff-review instruction in the claude input UNSENT. */}
                    {detailTask.branch &&
                      (columnOf(detailTask) === 'review' || detailTask.prUrl) && (
                        <button
                          type="button"
                          disabled={reviewBusy || project.missing}
                          onClick={() => void reviewWithClaude(detailTask)}
                          title={t('board.detail.reviewWithClaudeTitle')}
                          className="shrink-0 rounded-sm border border-line px-1.5 py-0.5 text-[10px] text-ink-muted transition-colors hover:border-accent hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                        >
                          {reviewBusy
                            ? t('board.detail.reviewWithClaudeBusy')
                            : t('board.detail.reviewWithClaude')}
                        </button>
                      )}
                    {reviewNotice && (
                      <span
                        className="min-w-0 truncate text-[10px] text-accent"
                        title={reviewNotice}
                      >
                        {reviewNotice}
                      </span>
                    )}
                    {flowTextFor(detailTask) && (
                      <span
                        className="min-w-0 max-w-full truncate"
                        title={flowTextFor(detailTask) ?? undefined}
                      >
                        {flowTextFor(detailTask)}
                      </span>
                    )}
                    <span
                      className="ml-auto min-w-0 max-w-full truncate text-ink-faint/80"
                      title={`${t('board.detail.profileTitle')} — ${profileTextFor(detailTask)}`}
                    >
                      {profileTextFor(detailTask)}
                    </span>
                    {/* Salvage for a finished-but-not-marked run (F052): the
                        markDone curl is best-effort claude behavior — give the
                        human a one-click fallback right where they notice. */}
                    {columnOf(detailTask) !== 'done' && (
                      <button
                        type="button"
                        // Persisting needs the project on disk — same guard as
                        // every other board mutation.
                        disabled={project.missing}
                        onClick={() => {
                          patchTaskFresh(detailTask.id, { boardColumn: 'done', done: true })
                          onOpenDetail(null)
                        }}
                        title={t('board.detail.markDoneTitle')}
                        className="shrink-0 rounded-sm border border-line px-1.5 py-0.5 text-[10px] text-ink-muted transition-colors hover:border-moss hover:text-moss active:border-moss active:text-moss focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line disabled:hover:text-ink-muted"
                      >
                        {t('board.detail.markDone')}
                      </button>
                    )}
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
                    {/* PR state + diff stats (B023 — F058/F085): quiet chip
                        next to the link once /api/project/pr-info answers.
                        available:false (no gh, bad URL) renders nothing. */}
                    {detailTask.prUrl && prInfo?.available && (
                      <span
                        className={`shrink-0 text-[10px] ${
                          prInfo.state === 'MERGED'
                            ? 'text-moss'
                            : prInfo.state === 'CLOSED'
                              ? 'text-accent'
                              : 'text-ink-muted'
                        }`}
                        title={`${t('board.detail.prStateTitle')}: ${prInfo.title}`}
                      >
                        {prInfo.isDraft && prInfo.state === 'OPEN' ? 'DRAFT' : prInfo.state}
                        {prInfo.state === 'OPEN' &&
                          ` +${prInfo.additions} −${prInfo.deletions}`}
                      </span>
                    )}
                  </div>
                )}
                {/* Restart session (F081) — the slot exists but its PTY has
                    exited: the auto-launch effect skips slotted tasks, so a
                    dead session needs this explicit relaunch. Same launch
                    path as auto-launch (onLaunchTask rebinds the slot). */}
                {!liveTerminalId(detailTask.id) && (
                  <div className="flex items-baseline gap-2 px-5 pb-2">
                    <button
                      type="button"
                      onClick={() => restartSession(detailTask)}
                      // No restart into a missing cwd — the spawn would fail.
                      disabled={launching || project.missing}
                      className="shrink-0 rounded-sm border border-line px-2.5 py-1 text-[11px] text-ink-muted transition-colors hover:border-accent hover:bg-accent/10 hover:text-ink active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    >
                      {launching
                        ? t('projectPanel.launchingClaude')
                        : t('board.detail.restartSession')}
                    </button>
                    <span
                      className={`min-w-0 truncate text-[11px] ${launchFailed.has(detailTask.id) ? 'text-accent' : 'text-ink-faint'}`}
                      title={
                        launchFailed.has(detailTask.id)
                          ? t(
                              launchFailed.get(detailTask.id) === 'claudeMissing'
                                ? 'board.run.failedClaudeMissing'
                                : 'board.run.failed',
                            )
                          : t('board.detail.restartSessionHint')
                      }
                    >
                      {launchFailed.has(detailTask.id)
                        ? t(
                            launchFailed.get(detailTask.id) === 'claudeMissing'
                              ? 'board.run.failedClaudeMissing'
                              : 'board.run.failed',
                          )
                        : t('board.detail.restartSessionHint')}
                    </span>
                  </div>
                )}
                {/* Insert task into input — pastes title + content into the
                    claude input UNSENT; the user presses Enter to run. Sits
                    right under the status strip so the flow note (merge/PR
                    target) reads as "what happens after Enter". */}
                <div className="flex items-baseline gap-2 px-5 pb-2">
                  <button
                    type="button"
                    onClick={() => void insertTask(detailTask)}
                    disabled={inserting || !liveTerminalId(detailTask.id)}
                    className="shrink-0 rounded-sm border border-line px-2.5 py-1 text-[11px] text-ink-muted transition-colors hover:border-accent hover:bg-accent/10 hover:text-ink active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    {inserting
                      ? t('board.detail.insertTaskBusy')
                      : t('board.detail.insertTask')}
                  </button>
                  <span
                    className={`min-w-0 truncate text-[11px] ${insertError ? 'text-accent' : 'text-ink-faint'}`}
                    title={insertError ?? t('board.detail.insertTaskHint')}
                  >
                    {insertError ?? t('board.detail.insertTaskHint')}
                  </span>
                </div>
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
                      {fieldsBlock(detailTask, { grow: false })}
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

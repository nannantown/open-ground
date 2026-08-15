// BoardSupplyDock — the Board's FRONT DESK: the supply officer (補給官) seat,
// plus a roll-up of what every worker is doing, without leaving the kanban.
//
// 「ボードで全部supplyに命令から他のワーカーのモニターができるようにしたい」
// (owner, 2026-08-15). Two halves, one dock: TALK to the desk (left), WATCH the
// fleet (right).
//
// ── WHY A BOTTOM DOCK, NOT A RIGHT RAIL ────────────────────────────────────
// The side terminal dock was removed from the Board hours before this shipped
// (T1). Re-introducing a 460px right panel under a different name would be
// ignoring that. It is also mechanical: five columns at min-w-[166px] plus gaps
// already need ~900px, so a right rail forces the columns into horizontal
// scroll. A terminal is line-oriented and reads fine wide-and-short.
//
// ── ONE DESK, TWO SURFACES (the invariant this file must not break) ────────
// The Swarm tab has the same seat. They are the SAME desk: the same server-side
// PTY, the same stored record, the same hook (useSupplyDesk). This component
// NEVER spawns on mount and never "makes sure" a desk exists — it attaches to
// whatever the shared hook resolved, and only an explicit press of the CTA
// launches anything. A second 補給官 would mint a fresh session id and OVERWRITE
// the project's single stored slot, so the first desk's days-long conversation
// would be forgotten while its PTY kept running (swarmSupply.ts states the
// mechanism). The server now refuses that outright (spawn lock + adopt); this
// file's job is to not go looking for the door.
//
// ── WHAT IT REFUSES TO SAY ─────────────────────────────────────────────────
// A worker the engine cannot tie to a card gets NO card name — not a guessed
// one, not the nearest title. And while the server has not yet said whether a
// desk exists (`supplyDesk === undefined`: an older build, or simply the first
// frame before the poll lands) the dock says NEITHER "closed" NOR "open" — it
// says nothing, which is the truth. `deskReconcile.reconcileDesk` encodes the
// same rule for the record itself; this is that rule reaching the screen.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Inbox, Power } from 'lucide-react'
import { ClaudeTerminalPane } from '@/components/canvas/ClaudeTerminalPane'
import { useT } from '@/i18n/I18nContext'
import type { MessageKey } from '@/i18n/messages'
import { deriveWorkerActivity, type WorkerActivity } from '@/lib/boardWorker'
import type { ClaudeBeaconStatus } from '@/lib/types'
import type { LiveDeskHandle } from '@/lib/deskReconcile'
import { engineWorkerKey, type EngineWorker } from './useSwarmEngine'
import { useSupplyDesk } from './useSupplyDesk'

/** Same vocabulary the cards use (BoardCard's WORKER_PHASE_KEY) — the Board must
 *  not become a second vocabulary island. An UNKNOWN phase renders VERBATIM: we
 *  never invent a meaning for a word the engine coined after this build. */
const PHASE_KEY: Record<string, MessageKey> = {
  audit: 'board.card.phaseAudit',
  implement: 'board.card.phaseImplement',
  verify: 'board.card.phaseVerify',
  rework: 'board.card.phaseRework',
  blocked: 'board.card.phaseBlocked',
  done: 'board.card.phaseDone',
}

/** The beacon vocabulary, identical to SwarmSupplyPane / the Ground cards:
 *  moss = busy, ochre = waiting, ink-faint = starting/finished. */
const LAMP: Record<WorkerActivity, string> = {
  working: 'bg-moss',
  waiting: 'bg-ochre',
  starting: 'bg-ink-faint',
  done: 'bg-ink-faint',
}

const MIN_H = 180
const DEFAULT_H = 320

const dockKey = (projectId: string) => `openground.board.supplydock.${projectId}`

/** Load + SANITISE the persisted dock geometry. localStorage is untrusted, and a
 *  forged height must not be able to swallow the board — the clamp is applied
 *  again at render against the live container height. */
const loadDock = (projectId: string): { open: boolean; h: number } => {
  try {
    const raw = localStorage.getItem(dockKey(projectId))
    if (!raw) return { open: false, h: DEFAULT_H }
    const o: unknown = JSON.parse(raw)
    if (!o || typeof o !== 'object') return { open: false, h: DEFAULT_H }
    const r = o as Record<string, unknown>
    const h = typeof r.h === 'number' && Number.isFinite(r.h) ? Math.max(MIN_H, r.h) : DEFAULT_H
    return { open: r.open === true, h }
  } catch {
    return { open: false, h: DEFAULT_H }
  }
}

const saveDock = (projectId: string, v: { open: boolean; h: number }) => {
  try {
    localStorage.setItem(dockKey(projectId), JSON.stringify(v))
  } catch {
    /* quota / disabled storage — the in-memory state is still authoritative */
  }
}

export interface BoardSupplyDockProps {
  projectId: string
  projectPath: string
  /** The server's live supply handle from BoardModule's orchestrator poll.
   *  `undefined` = the server has not said (old build, or no lap has landed
   *  yet) — NEVER read as "no desk". */
  supplyDesk: LiveDeskHandle | null | undefined
  /** EVERY worker the engine is running — including the ones with no `taskId`,
   *  which is exactly why this list is not the card map. They are real work; a
   *  monitor that dropped them would under-report the fleet. */
  workers: readonly EngineWorker[] | undefined
  /** taskId → card title, for the workers that HAVE a card. Returns null when
   *  the board holds no such card — the row then says so rather than guessing. */
  taskTitle: (taskId: string) => string | null
  /** How many cards the commander is holding for integration (reviews[]).
   *  `undefined` = no orchestrator lap has landed. */
  reviewCount: number | undefined
  /** How many open questions are waiting on the owner (cards + unattributed).
   *  `undefined` = the escalation inbox has never been read successfully.
   *
   *  ⚠ THREE-VALUED, and it must stay that way. A `0` here is a claim — 「判断待ち0」
   *  is the reassurance BoardModule's THE FORBIDDEN SENTENCE comment forbids
   *  anywhere else on this surface — and at mount, on an older server that 404s
   *  the route, or through any 5xx blip, the count was 0 for the sole reason
   *  that nobody had looked. The roll-up drops the clause instead. */
  waitingCount: number | undefined
  /** PTY/SDK session id → live beacon status, from BoardModule's terminal poll.
   *  Feeds both the worker lamps and the desk's own status dot. */
  claudeStatusByPty: ReadonlyMap<string, ClaudeBeaconStatus>
}

export const BoardSupplyDock = ({
  projectId,
  projectPath,
  supplyDesk,
  workers,
  taskTitle,
  reviewCount,
  waitingCount,
  claudeStatusByPty,
}: BoardSupplyDockProps) => {
  const { t } = useT()
  // PTY ids this dock has watched die. Local because the Board has no other
  // desk bookkeeping to share it with (the Swarm tab's set also covers workers
  // and the commander).
  const [exitedIds, setExitedIds] = useState<ReadonlySet<string>>(new Set())
  const forgetPty = useCallback((id: string | undefined, keep?: string) => {
    if (!id || id === keep) return
    setExitedIds((prev) => {
      if (!prev.has(id)) return prev
      const s = new Set(prev)
      s.delete(id)
      return s
    })
  }, [])
  const { supply, busy, error, launch, stop, restart } = useSupplyDesk({
    projectId,
    projectPath,
    supplyDesk,
    exitedIds,
    forgetPty,
    // This component is only ever rendered behind BoardModule's `swarmVisible`
    // gate, so reaching here already means "allowed". Passed explicitly because
    // the hook REQUIRES it — an omission is a build error, not a silent open.
    enabled: true,
  })

  const [dock, setDock] = useState(() => loadDock(projectId))
  useEffect(() => setDock(loadDock(projectId)), [projectId])
  const setOpen = useCallback(
    (open: boolean) =>
      setDock((prev) => {
        const next = { ...prev, open }
        saveDock(projectId, next)
        return next
      }),
    [projectId],
  )

  // Height drag. Clamped to [MIN_H, 60% of the board] so the dock can never eat
  // the columns it sits under.
  const rootRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)
  /** Teardown for the drag currently in flight, or null. Held in a ref so BOTH
   *  the end-of-gesture handlers and the unmount effect below can call it. */
  const dragCleanupRef = useRef<(() => void) | null>(null)
  const startHeightDrag = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      // A second press before the first gesture ended (possible only if the
      // first was cancelled) must not stack a second listener pair.
      dragCleanupRef.current?.()
      dragRef.current = { startY: e.clientY, startH: dock.h }
      const boardH = rootRef.current?.parentElement?.getBoundingClientRect().height ?? 0
      const maxH = boardH > 0 ? Math.max(MIN_H, boardH * 0.6) : Number.POSITIVE_INFINITY
      const onMove = (ev: PointerEvent) => {
        const d = dragRef.current
        if (!d) return
        // Dragging UP grows the dock — it is anchored to the bottom edge.
        const raw = d.startH + (d.startY - ev.clientY)
        setDock((prev) => ({ ...prev, h: Math.min(maxH, Math.max(MIN_H, raw)) }))
      }
      // ⚠ THREE WAYS A DRAG ENDS, and every one of them must detach.
      //  - pointerup: the ordinary finish.
      //  - pointercancel: the browser took the gesture away (a trackpad scroll
      //    took over, touch was interrupted, the pointer was stolen). WITHOUT
      //    this the drag stayed armed FOREVER: every later mouse move, no
      //    button held, re-entered onMove and dragged the dock around, and each
      //    new press stacked another listener pair on window.
      //  - unmount: leaving the Board mid-drag detached nothing at all.
      // The sibling helper in BoardModule (beginDrag) already does all three;
      // this one was written without them.
      const detach = () => {
        dragRef.current = null
        dragCleanupRef.current = null
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onEnd)
        window.removeEventListener('pointercancel', onEnd)
      }
      const onEnd = () => {
        detach()
        setDock((prev) => {
          saveDock(projectId, prev)
          return prev
        })
      }
      dragCleanupRef.current = detach
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onEnd)
      window.addEventListener('pointercancel', onEnd)
    },
    [dock.h, projectId],
  )
  // Unmounting mid-drag: detach WITHOUT persisting — the height on screen when
  // the surface went away is not a size the owner chose.
  useEffect(() => () => dragCleanupRef.current?.(), [])

  // The desk's own lamp, from the same beacon the worker rows use.
  const deskActivity: WorkerActivity | null = supply
    ? exitedIds.has(supply.terminalId)
      ? 'done'
      : deriveWorkerActivity(undefined, claudeStatusByPty.get(supply.terminalId))
    : null

  const workingCount = useMemo(
    () =>
      (workers ?? []).reduce(
        (n, w) =>
          deriveWorkerActivity(w.stage, claudeStatusByPty.get(engineWorkerKey(w))) === 'working'
            ? n + 1
            : n,
        0,
      ),
    [workers, claudeStatusByPty],
  )

  // The roll-up, clause by clause. `undefined` ⇒ the clause is omitted, never
  // rendered as a zero — see waitingCount's contract for why that distinction
  // is the whole point of this strip.
  const rollup = useMemo(() => {
    const out: string[] = []
    if (workers !== undefined) out.push(t('board.supply.rollupWorking', { n: workingCount }))
    if (reviewCount !== undefined) out.push(t('board.supply.rollupReview', { n: reviewCount }))
    if (waitingCount !== undefined) out.push(t('board.supply.rollupWaiting', { n: waitingCount }))
    return out
  }, [t, workers, workingCount, reviewCount, waitingCount])

  // ⚠ THE THREE-VALUED READ. `supplyDesk === undefined` means the server has not
  // told us — an older build with no such field, or simply the first frame. It
  // is NOT "no desk", so the dock offers neither the "closed" sentence nor a
  // launch CTA: it stays quiet about a thing it does not know. Only a definite
  // `null` (the server looked and found none) earns the closed copy.
  const deskUnknown = supply === null && supplyDesk === undefined

  return (
    <div
      ref={rootRef}
      className="shrink-0 border-t border-line"
      data-testid="board-supply-dock"
    >
      {/* ── Collapsed strip: identity · lamp · roll-up · chevron ──────────── */}
      <div className="flex h-7 items-center gap-2 px-5">
        <Inbox size={11} strokeWidth={2} className="shrink-0 text-ink-faint" aria-hidden />
        <span className="label-cap shrink-0 text-ink-faint">{t('board.supply.title')}</span>
        {deskActivity && (
          <span
            className={`h-[6px] w-[6px] shrink-0 rounded-full ${LAMP[deskActivity]}`}
            aria-hidden
          />
        )}
        <span className="min-w-0 flex-1 truncate text-meta text-ink-muted">
          {/* ONE CLAUSE PER THING WE ACTUALLY KNOW. The roll-up used to be a
           *  single template with three slots, so an unread inbox printed
           *  「判断待ち0」 — a reassurance nobody had earned — and an engine that
           *  had not answered yet printed 「稼働0」 beside a running worker.
           *  A clause whose number is `undefined` is simply not said. */}
          {rollup.length > 0 ? rollup.join(' · ') : t('board.supply.rollupUnknown')}
        </span>
        <button
          type="button"
          onClick={() => setOpen(!dock.open)}
          title={dock.open ? t('board.supply.collapse') : t('board.supply.expand')}
          aria-label={dock.open ? t('board.supply.collapse') : t('board.supply.expand')}
          aria-expanded={dock.open}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-ink-faint transition-colors hover:bg-accent/10 hover:text-accent"
        >
          {dock.open ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
        </button>
      </div>

      {dock.open && (
        <>
          {/* Top-edge height grip. */}
          <div
            onPointerDown={startHeightDrag}
            role="separator"
            aria-orientation="horizontal"
            aria-label={t('board.supply.resize')}
            className="h-1.5 cursor-row-resize transition-colors hover:bg-accent/40 active:bg-accent/50"
          />
          <div className="flex min-h-0 border-t border-line-soft" style={{ height: dock.h }}>
            {/* ── Left: the desk itself ─────────────────────────────────── */}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {error && (
                <p className="shrink-0 border-b border-line-soft px-3 py-1.5 text-meta leading-relaxed text-accent">
                  {error}
                </p>
              )}
              {supply ? (
                <>
                  <div className="flex shrink-0 items-center justify-end border-b border-line-soft px-2.5 py-1">
                    <button
                      type="button"
                      onClick={() => void stop()}
                      disabled={busy}
                      title={t('board.supply.stop')}
                      className="flex shrink-0 items-center gap-1 rounded-[3px] border border-line px-1.5 py-0.5 text-micro text-ink-muted transition-colors hover:border-accent hover:text-accent active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1"
                    >
                      <Power size={10} strokeWidth={2.25} />
                      {busy ? t('board.supply.stopping') : t('board.supply.stop')}
                    </button>
                  </div>
                  <div className="min-h-0 flex-1">
                    {/* chrome={false}: the strip above IS the chrome — the same
                        arrangement SwarmSupplyPane uses for the same desk. */}
                    <ClaudeTerminalPane
                      terminalId={supply.terminalId}
                      chrome={false}
                      onExit={() =>
                        setExitedIds((prev) =>
                          prev.has(supply.terminalId)
                            ? prev
                            : new Set(prev).add(supply.terminalId),
                        )
                      }
                      onRestart={() => void restart()}
                    />
                  </div>
                </>
              ) : deskUnknown ? (
                // Nothing. See `deskUnknown` above: we have not been told, so we
                // say neither "closed" nor "open here".
                <div className="min-h-0 flex-1" />
              ) : (
                <div className="flex min-h-0 flex-1 flex-col items-start justify-center gap-2 px-5">
                  <p className="text-meta text-ink-muted">{t('board.supply.closed')}</p>
                  <button
                    type="button"
                    onClick={() => void launch()}
                    disabled={busy}
                    className="rounded-[3px] border border-line px-2 py-1 text-meta text-ink transition-colors hover:border-accent hover:text-accent active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1"
                  >
                    {busy ? t('board.supply.opening') : t('board.supply.open')}
                  </button>
                </div>
              )}
            </div>

            {/* ── Right: the fleet monitor ──────────────────────────────── */}
            <div className="flex w-[220px] shrink-0 flex-col border-l border-line-soft">
              <p className="label-cap shrink-0 border-b border-line-soft px-2.5 py-1 text-ink-faint">
                {t('board.supply.workers')}
              </p>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {workers === undefined ? (
                  // NOT TOLD ≠ NONE. At mount, on a restarting server, or on any
                  // 5xx, the list is empty for the sole reason that no lap has
                  // landed — and 「いま動いているワーカーはありません」 would be a
                  // flat contradiction of a worker that is at that moment
                  // mid-task. Same three-valued stance the desk itself takes
                  // above; the fleet list simply never had it.
                  <p className="px-2.5 py-2 text-meta text-ink-faint">
                    {t('board.supply.workersUnknown')}
                  </p>
                ) : workers.length === 0 ? (
                  <p className="px-2.5 py-2 text-meta text-ink-faint">
                    {t('board.supply.noWorkers')}
                  </p>
                ) : (
                  workers.map((w) => {
                    const activity = deriveWorkerActivity(
                      w.stage,
                      claudeStatusByPty.get(engineWorkerKey(w)),
                    )
                    // A worker with no taskId, or one whose card this board does
                    // not hold, gets the honest label — never a guessed title.
                    const title = w.taskId ? taskTitle(w.taskId) : null
                    return (
                      <div
                        key={engineWorkerKey(w) || w.branch}
                        className="flex items-start gap-1.5 border-b border-line-soft px-2.5 py-1.5 last:border-b-0"
                      >
                        <span
                          className={`mt-[5px] h-[6px] w-[6px] shrink-0 rounded-full ${LAMP[activity]}`}
                          aria-hidden
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-mono text-micro text-ink-muted">
                            {w.branch}
                          </p>
                          <p className="truncate text-micro text-ink-faint">
                            {w.phase
                              ? PHASE_KEY[w.phase]
                                ? t(PHASE_KEY[w.phase])
                                : w.phase
                              : ''}
                          </p>
                          <p
                            className={`truncate text-micro ${title ? 'text-ink-muted' : 'text-ink-faint'}`}
                            title={title ?? undefined}
                          >
                            {title ?? t('board.supply.workerNoCard')}
                          </p>
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

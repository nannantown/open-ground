// SdkWorkerPane — one Agent SDK worker's tile.
//
// The counterpart of SwarmWorkerPane, which wraps ClaudeTerminalPane (xterm on
// a PTY). This one renders a STRUCTURED transcript instead, because an SDK
// worker does not have a screen to show — it has a stream of distilled events
// (see src/lib/server/sdkEvents.ts).
//
// That is the readable view the whole migration started from: the same work,
// legible without reading a terminal repaint. The header keeps SwarmWorkerPane's
// exact vocabulary (the azure/ochre beacon dots the Ground and Board cards use)
// so a mixed fleet reads as one fleet.
//
// See docs/SDK_WORKER_MIGRATION_PLAN.md §3.6.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Square, CornerDownLeft, Power, Trash2, AlertTriangle, Gauge, RotateCcw } from 'lucide-react'
import { useT } from '@/i18n/I18nContext'
import type { SdkEvent, SdkSessionStatus } from '@/lib/server/sdkEvents'
import {
  groupSdkFrames,
  parseMarkdownBlocks,
  toolCardSummary,
  type SdkRenderItem,
} from '@/lib/sdkTranscript'

export interface Frame {
  seq: number
  ev: SdkEvent
}

/** The transcript ceiling — deliberately the SAME number as the server ring
 *  buffer's RING_CAPACITY (src/lib/server/sdkSession.ts). Keeping more than the
 *  server keeps buys nothing (a reconnect can never replay past it), and
 *  keeping ALL of them — which this pane did — is an unbounded browser-side
 *  leak in the one place it hurts most: the commander tile, left open for a
 *  day, holding every frame the session ever emitted with nothing to evict it.
 *  If the server's capacity ever changes, change this with it (a guard in
 *  SdkWorkerPane.test.tsx fails when the two drift apart). */
export const MAX_FRAMES = 4096

/** Append one frame, evicting oldest-first at MAX_FRAMES.
 *
 *  Pure and exported so the ceiling is provable without rendering 4096 rows —
 *  the component does its appending through here and nowhere else. */
export const appendFrame = (prev: Frame[], f: Frame): Frame[] => {
  const next = [...prev, f]
  return next.length > MAX_FRAMES ? next.slice(next.length - MAX_FRAMES) : next
}

/** What a POST to this session actually did.
 *
 *  It exists because the previous shape — `await fetch(...)` and look at
 *  nothing — made every failure indistinguishable from success. See `post`. */
export type SdkPostResult = { ok: true } | { ok: false; error: string }

/** Read a failed response into one line the owner can act on.
 *
 *  Pure and exported so the "was it accepted?" decision is testable on its own
 *  rather than living in an anonymous closure. The server's own `error` string
 *  is preferred (it says WHY — "session is no longer accepting input" for the
 *  409 that a teardown race produces); the status code is the fallback for a
 *  body that isn't the shape we expect. */
export const postFailureMessage = (status: number, body: unknown): string => {
  const e = (body as { error?: unknown } | null | undefined)?.error
  return typeof e === 'string' && e.trim() ? e : `HTTP ${status}`
}

/** What GET /api/sdk-session/:id answers with (the fields this tile reads). */
export type SdkSessionProbe = { status?: SdkSessionStatus; reaped?: boolean } | null | undefined

/** What a CONNECTION-BLIP re-check should do with that answer.
 *
 *  ⚠ LIVENESS IS `reaped`, NEVER STATUS — the client half of the rule
 *  src/lib/server/sdkSession.ts states for `isSdkSessionLive` and that
 *  routes/sdkSession.ts's `end` stands on. `terminateSdkSession` flips the
 *  status to 'exited' SYNCHRONOUSLY (it only asks the CLI to stop) while the
 *  pump keeps draining and keeps emitting the frames that say HOW the desk
 *  ended. Judged on status, a blip landing inside that window made this tile
 *  close its own EventSource and draw "終了": the server went on sending the
 *  final frames to a reader that had hung up, and the tile disagreed with the
 *  Swarm list beside it on the same screen (which counts `!reaped`).
 *
 *  Pure and exported so the decision is provable without a live stream. */
export type BlipVerdict = { close: false } | { close: true; status: SdkSessionStatus }

export const blipVerdict = (ok: boolean, body: SdkSessionProbe): BlipVerdict => {
  // 404 / 403 — gone, or never ours. Retrying cannot help.
  if (!ok) return { close: true, status: 'exited' }
  // The server answered and did NOT say reaped: still live (or still unwinding).
  // Let EventSource's own retry re-attach — that is what the blip needs.
  if (!body || body.reaped !== true) return { close: false }
  // Reaped. Honour the status we just READ: a worker that crashed must not be
  // drawn as one that finished normally.
  return { close: true, status: body.status === 'failed' ? 'failed' : 'exited' }
}

interface Props {
  /** The SDK session id (the worker's handle — there is no terminalId). */
  sdkSessionId: string
  /** Project path — every /api/sdk-session/* call is gated on it. */
  projectPath: string
  branch: string
  taskTitle: string
  /** Engine-owned workers are read-only here, exactly as in SwarmWorkerPane. */
  source?: 'manual' | 'engine'
  onExit?: () => void
  /** This desk's status, every time it changes — the ONLY way anything outside
   *  this tile can learn it. The PTY poll (GET /api/terminal/active) is blind to
   *  the SDK pool, so a parent that needs a beacon (the commander header) has no
   *  other source and, lacking this, fabricated a constant. */
  onStatus?: (status: SdkSessionStatus) => void
  /** A terminate / force-remove is in flight for this worker (SwarmModule owns
   *  the flag, keyed by worktree). Same prop, same meaning, as SwarmWorkerPane. */
  busy?: boolean
  /** Set when a soft terminate KEPT the worktree (dirty/locked) — shows the
   *  same force-remove strip SwarmWorkerPane shows. */
  retainedReason?: string
  /** Stop the session and tear its worktree down (soft: a dirty tree is kept).
   *  Manual workers only — an engine worker's lifecycle belongs to the
   *  orchestrator, so terminating it from here would fight the engine.
   *  Without this the SDK tile had NO way to clean up its worktree at all:
   *  a manual SDK worker could be started from the UI and then only removed by
   *  hand on disk. */
  onTerminate?: () => void
  /** Remove the worktree with --force (the dirty/abandon case). Manual only. */
  onForceRemove?: () => void
  /** Rendered inside a parent that provides its OWN header and composer (the
   *  manager pane, 2026-08-03). Hides this tile's duplicates — the owner's
   *  screenshot showed the desk wearing TWO stacked headers and TWO input
   *  boxes, which read as scattered chrome, not one desk. The transcript,
   *  question banner, ended-strip and restart affordance all stay. */
  embedded?: boolean
  /** Relaunch this worker once its session is finished — REUSES the same
   *  worktree, so the swarm/* branch and its in-progress work survive (the same
   *  contract SwarmWorkerPane's Restart has). Manual workers only.
   *
   *  Its ABSENCE was a DEAD END, not a missing nicety: a restart that comes up
   *  on the SDK runtime swaps the tile to THIS pane, and this pane had no
   *  restart affordance at all (grep: zero call sites). So the chain "the worker
   *  died → restart it in place" simply stopped at the first SDK worker, and the
   *  owner's only remaining move was to terminate the worktree and lose the
   *  branch. */
  onRestart?: () => void
}

// The SAME beacon vocabulary as SwarmWorkerPane / the Ground + Board cards:
// azure = busy, ochre = waiting for input. Inert states use ink-faint so the
// grey dot still clears the 3:1 graphic-contrast floor on the paper header.
const DOT: Record<SdkSessionStatus, string> = {
  starting: 'bg-ink-faint',
  working: 'bg-azure',
  waiting: 'bg-ochre',
  'quota-parked': 'bg-ochre',
  exited: 'bg-ink-faint',
  failed: 'bg-ink-faint',
}

export const SdkWorkerPane = ({
  sdkSessionId,
  projectPath,
  branch,
  taskTitle,
  source = 'manual',
  onExit,
  onStatus,
  busy = false,
  retainedReason,
  onTerminate,
  onForceRemove,
  onRestart,
  embedded = false,
}: Props) => {
  const { t } = useT()
  const [frames, setFrames] = useState<Frame[]>([])
  const [status, setStatus] = useState<SdkSessionStatus>('starting')
  // Is this desk FINISHED — i.e. can no further frame arrive? That is the
  // server's `reaped`, and it is NOT "the status is terminal".
  //
  // ⚠ This tile used to answer the question with `isTerminal(status)`, and the
  // two are different for the whole length of a teardown: `terminateSdkSession`
  // writes 'exited' synchronously while the pump keeps emitting the frames that
  // say how the desk ended. Reading status meant the interrupt control and the
  // composer disappeared the instant a stop was ASKED for, and the last frames
  // — the ones the owner needs most — landed in a tile that had already drawn
  // itself as over. One question, one predicate (docs/MAP.md §5).
  const [finished, setFinished] = useState(false)
  /** The pool has stopped ACCEPTING — a different question from `finished`.
   *  `terminateSdkSession` sets it synchronously; `reaped` lands much later. */
  const [closed, setClosed] = useState(false)
  /** Can the owner still SPEAK to this desk?
   *
   *  ⚠ ACCEPTING IS NOT ALIVENESS, and gating on the wrong one leaves a button
   *  whose only function is to produce an error. `pushSdkInput` and
   *  `interruptSdkSession` both refuse on the pool's `closed` flag, which
   *  `terminateSdkSession` sets SYNCHRONOUSLY — while `reaped` (this tile's
   *  `finished`) lands only when the pump finally unwinds, which for an
   *  interrupted turn inside a long tool call is many seconds later. Gating the
   *  composer and the ⏹ on `finished` therefore rendered both, enabled, through
   *  that whole window; every press came back 409, and since the round that
   *  landed this ALSO started surfacing 409s, the owner got an error banner for
   *  pressing a control the UI was offering.
   *
   *  A terminal status counts too: after `closed` the pump stops writing status
   *  at all, so 'exited'/'failed' arriving on the live stream is the same fact
   *  reaching us a frame earlier than a re-read would. */
  const accepting =
    !finished && !closed && status !== 'exited' && status !== 'failed'
  const [truncated, setTruncated] = useState(false)
  const [draft, setDraft] = useState('')
  // ── The open-question banner (2026-08-03, owner-requested) ─────────────────
  // The 0.11.52 acceptance put the owner in front of this exact pane while
  // their worker sat waiting on a question — and the pane said only 「待機中」.
  // The question lived in a DIFFERENT tab (監督) with nothing here pointing at
  // it. So the pane itself asks the inbox "is one of these mine?" and puts the
  // question — and where to answer it — right where the owner is looking.
  // Self-contained polling (10s) rather than prop-threading: this pane has two
  // unrelated hosts (the Board drawer and the Manager stage) and both would
  // have to grow the same plumbing.
  const [openQuestion, setOpenQuestion] = useState<string | null>(null)
  useEffect(() => {
    if (finished) {
      setOpenQuestion(null)
      return
    }
    let stopped = false
    const read = async () => {
      try {
        const r = await fetch(`/api/swarm/escalations?path=${encodeURIComponent(projectPath)}`)
        if (!r.ok || stopped) return
        const d = (await r.json()) as {
          escalations?: { status?: string; sdkSessionId?: string; question?: string; createdAt?: string }[]
        }
        const mine = (d.escalations ?? [])
          .filter((e) => e.status === 'open' && e.sdkSessionId === sdkSessionId && e.question)
          .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
        if (!stopped) setOpenQuestion(mine[0]?.question ?? null)
      } catch {
        /* keep the last known state — a fetch hiccup must not flap the banner */
      }
    }
    void read()
    const timer = setInterval(() => void read(), 10_000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [projectPath, sdkSessionId, finished])
  const [posting, setPosting] = useState(false)
  // The last refused action, in the server's own words. Null = nothing to say.
  const [actionError, setActionError] = useState<string | null>(null)
  // Either OUR own POST or the module's terminate/force-remove is in flight.
  const controlsBusy = posting || busy
  const feedRef = useRef<HTMLDivElement | null>(null)
  // Latest onExit, without making the subscription depend on its identity.
  const onExitRef = useRef(onExit)
  onExitRef.current = onExit
  // Same treatment for onStatus, and for the same reason: every caller passes an
  // inline arrow, so its identity changes on every parent render (and the
  // parents re-render on a 5 s poll).
  const onStatusRef = useRef(onStatus)
  onStatusRef.current = onStatus
  const isEngine = source === 'engine'

  const qs = useMemo(
    () => `path=${encodeURIComponent(projectPath)}`,
    [projectPath],
  )

  // Subscribe. `from` is the sequence high-water mark so a re-mount resumes
  // rather than replaying from zero — and the server tells us when it could
  // NOT resume (frames dropped), which we surface rather than hide.
  useEffect(() => {
    let stopped = false
    let lastSeq = 0
    // A RESTART reuses the tile: SwarmModule keys worker tiles by worktree, so a
    // worker relaunched in place arrives as a NEW sdkSessionId on the SAME
    // component. Everything below describes the OLD session, and `finished`
    // above all — left standing it would draw the fresh desk as already over,
    // with its own Restart button on top. Clear the slate with the id.
    setFinished(false)
    setClosed(false)
    setStatus('starting')
    setTruncated(false)
    setFrames((prev) => (prev.length ? [] : prev))
    const es = new EventSource(
      `/api/sdk-session/${encodeURIComponent(sdkSessionId)}/stream?${qs}&from=0`,
    )
    es.addEventListener('init', (e) => {
      if (stopped) return
      const d = JSON.parse((e as MessageEvent).data) as {
        session: { status: SdkSessionStatus; reaped?: boolean; closed?: boolean } | null
        truncated: boolean
        replay: Frame[]
      }
      setTruncated(d.truncated)
      if (d.session) {
        setStatus(d.session.status)
        // Same predicate as everywhere else: reaped, not status.
        if (d.session.reaped === true) setFinished(true)
        // …and the SEPARATE one for the controls (see `accepting` below).
        if (d.session.closed === true) setClosed(true)
      }
      if (d.replay.length) {
        lastSeq = d.replay[d.replay.length - 1].seq
        // The server's replay is already bounded by its ring buffer, but trim
        // it through the SAME ceiling anyway: one place decides how much
        // transcript this tile holds, so the two paths cannot disagree.
        setFrames(d.replay.slice(-MAX_FRAMES))
      }
    })
    es.addEventListener('frame', (e) => {
      if (stopped) return
      const f = JSON.parse((e as MessageEvent).data) as Frame
      lastSeq = f.seq
      if (f.ev.kind === 'status') setStatus(f.ev.status)
      setFrames((prev) => appendFrame(prev, f))
    })
    es.addEventListener('end', (e) => {
      if (stopped) return
      // Take the status the server SENT, not a blanket 'exited'. A worker that
      // died of an error ends 'failed', and overwriting that with 'exited' told
      // the owner a crashed worker had finished normally — the one distinction
      // this tile exists to make legible.
      let ended: SdkSessionStatus = 'exited'
      try {
        const d = JSON.parse((e as MessageEvent).data ?? '{}') as {
          session?: { status?: SdkSessionStatus } | null
        }
        if (d.session?.status === 'failed') ended = 'failed'
      } catch {
        /* no payload — 'exited' is the honest default for a stream that ended */
      }
      // CLOSE IT. The server writes 'end' and then ends the response, so a
      // client that leaves the EventSource open sees a dropped connection and
      // reconnects on its own — every ~3 s, replaying the whole ring buffer each
      // time. Before the server actually closed, this omission was invisible;
      // making 'end' fire turned a leaked-open stream into a reconnect storm.
      stopped = true
      es.close()
      setStatus(ended)
      // 'end' is the server saying "no further event can arrive on this stream",
      // which it only says for a session that is no longer live (reaped) — see
      // server/routes/sdkSession.ts. That, and not the status, is what makes
      // this desk finished.
      setFinished(true)
      onExitRef.current?.()
    })
    // The dead-session path. Two distinct things arrive as 'error':
    //   • the SERVER's own error event (attach failed — the session is gone from
    //     the pool, e.g. the app restarted and localStorage still points here):
    //     a MessageEvent WITH data;
    //   • a CONNECTION error (server briefly down, network blip): an Event with
    //     no data, after which EventSource retries on its own.
    // Without this handler the first kind fell through to the retry loop too:
    // the pane sat on 'starting' forever while EventSource re-attached to a
    // session that will never exist again — a dead desk rendered as a live one
    // (the exact 実行中-forever failure class the migration is meant to end).
    es.addEventListener('error', (e) => {
      if (stopped) return
      const data = (e as MessageEvent).data as unknown
      if (typeof data === 'string' && data.length) {
        // The server SAID it — no probe needed, and retrying cannot help.
        stopped = true
        es.close()
        setStatus('exited')
        setFinished(true)
        onExitRef.current?.()
        return
      }
      // Connection error: ask ONCE whether the session still exists before
      // letting the built-in retry continue. A 404/403 means the retries would
      // hammer a session that is gone (or was never ours); a live answer means
      // the blip is the server's and the retry is right.
      void fetch(`/api/sdk-session/${encodeURIComponent(sdkSessionId)}?${qs}`)
        .then(async (r) => {
          const body = r.ok ? ((await r.json().catch(() => null)) as SdkSessionProbe) : null
          if (stopped) return
          // ⚠ ASK `reaped`, NOT the status — see blipVerdict. A blip that lands
          // while a terminate is unwinding must NOT hang up: the status already
          // says 'exited' but the pump is still emitting the frames that say how
          // the desk ended, and this tile is the only place they are shown.
          const verdict = blipVerdict(r.ok, body)
          if (!verdict.close) return // still live — let EventSource retry
          stopped = true
          es.close()
          setStatus(verdict.status)
          setFinished(true)
          onExitRef.current?.()
        })
        .catch(() => {
          /* server unreachable — keep the EventSource retry, it will resolve it */
        })
    })
    return () => {
      stopped = true
      es.close()
      void lastSeq
    }
    // `onExit` is deliberately NOT a dependency. Callers pass an inline arrow
    // (SwarmModule / SwarmManagerPane / BoardModule all do), so a new identity
    // arrives on EVERY parent render — and the parents re-render on a 5 s poll.
    // Including it tore down and re-opened this EventSource every 5 seconds:
    // the transcript restarted from `from=0`, the server replayed the whole ring
    // buffer each time, and the session's own listener set churned. A ref keeps
    // the latest callback without making the subscription depend on its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sdkSessionId, qs])

  // Report the status outward. In an effect (not inline in the listeners) so it
  // fires exactly once per DISTINCT status, whichever of the four paths above
  // wrote it, and never during another component's render.
  useEffect(() => {
    onStatusRef.current?.(status)
  }, [status])

  // Follow the newest line — 3-state model (research: TanStack/Roo-Code, and
  // claude-code#76350 the other way round). `drifted` is set by the READER's
  // own scroll, never derived from post-growth distance: the old check measured
  // "near bottom" AFTER the DOM grew, so one big chunk (a long text event)
  // pushed the distance past the threshold and silently stopped following —
  // exactly the forced-scroll/stuck-scroll class the research warns about.
  const [drifted, setDrifted] = useState(false)
  const onFeedScroll = () => {
    const el = feedRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setDrifted(!nearBottom)
  }
  useEffect(() => {
    const el = feedRef.current
    if (!el || drifted) return
    el.scrollTop = el.scrollHeight
  }, [frames, drifted])
  const jumpToLatest = () => {
    const el = feedRef.current
    if (el) el.scrollTop = el.scrollHeight
    setDrifted(false)
  }

  // LOOK AT THE ANSWER. This used to await fetch and inspect nothing — no
  // `r.ok`, no status, no catch — so a refusal was indistinguishable from
  // success. The refusals are not exotic: POST /input answers 409 the moment
  // pushSdkInput declines (the session stopped accepting input), which is
  // exactly what a teardown racing the owner's Enter looks like, plus 403/404
  // for a session that is gone or not this project's, plus a fetch reject
  // whenever the dev server reloads mid-request.
  const post = async (suffix: string, body?: unknown): Promise<SdkPostResult> => {
    setPosting(true)
    try {
      const r = await fetch(`/api/sdk-session/${encodeURIComponent(sdkSessionId)}${suffix}?${qs}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      if (r.ok) return { ok: true }
      return { ok: false, error: postFailureMessage(r.status, await r.json().catch(() => null)) }
    } catch (e) {
      // A rejected fetch is the same class of event to the owner: the words
      // did not arrive. Letting it throw here left the promise unhandled and
      // the input box already empty.
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    } finally {
      setPosting(false)
    }
  }

  const send = async () => {
    const text = draft.trim()
    if (!text) return
    setActionError(null)
    setDraft('')
    const r = await post('/input', { text })
    if (r.ok) return
    // GIVE THE WORDS BACK. Clearing the field before the POST and never
    // checking the answer meant a refused message vanished in silence — and an
    // owner who watched their text disappear reasonably believes the worker
    // received it. Restoring it (and saying why) is the whole point: the
    // instruction is still there to re-send, or to paste elsewhere.
    // Only restore into an EMPTY field: if the owner started typing something
    // new while we waited, their live keystrokes win over our undo.
    setDraft((cur) => (cur ? cur : text))
    setActionError(r.error)
  }

  const interrupt = async () => {
    setActionError(null)
    const r = await post('/interrupt')
    if (!r.ok) setActionError(r.error)
  }

  const renderItems: SdkRenderItem[] = useMemo(() => groupSdkFrames(frames), [frames])

  const baseStatusLabel: string = {
    starting: t('projectPanel.swarm.statusStarting'),
    working: t('projectPanel.swarm.statusWorking'),
    waiting: t('projectPanel.swarm.statusWaiting'),
    'quota-parked': t('projectPanel.swarm.sdk.statusQuotaParked'),
    exited: t('projectPanel.swarm.statusExited'),
    failed: t('projectPanel.swarm.sdk.statusFailed'),
  }[status]
  // 「待機中」 is technically true and practically useless while a question sits
  // in the inbox — the owner's next action is ANSWERING, so the label says so.
  const statusLabel =
    openQuestion && status === 'waiting' ? t('projectPanel.swarm.sdk.statusQuestion') : baseStatusLabel

  return (
    // PAPER, not a counterfeit terminal. The rows below already speak the paper
    // ink tokens (text-ink / text-ink-muted) — on the old hardcoded #1a1a1a they
    // were near-invisible (the owner's 2026-08-03 screenshot: their worker's
    // question, rendered dark-on-dark). An SDK worker's feed is a transcript,
    // not a screen; it gets the same reading surface as every other dashboard.
    <div className="flex h-full min-h-0 flex-col bg-bg">
      {/* Header — same shape and vocabulary as SwarmWorkerPane. Hidden when
          embedded: the parent (manager pane) wears the one desk header. */}
      {embedded ? null : (
      <div className="flex shrink-0 items-center gap-2 border-b border-line-soft bg-bg-card px-2.5 py-1.5">
        <span className={`h-[6px] w-[6px] shrink-0 rounded-full ${DOT[status]}`} aria-hidden />
        <span
          className={`label-cap shrink-0 ${status === 'waiting' || status === 'quota-parked' ? 'text-[var(--beacon-waiting)]' : 'text-ink-faint'}`}
        >
          {statusLabel}
        </span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-muted"
          title={taskTitle ? `${branch} — ${taskTitle}` : branch}
        >
          {branch}
        </span>
        <span
          className="shrink-0 rounded-[3px] border border-line px-1.5 py-0.5 text-[10px] text-ink-faint"
          title={t('projectPanel.swarm.sdk.badgeHint')}
        >
          SDK
        </span>
        {isEngine ? (
          // Read-only chip, same as SwarmWorkerPane's: the engine owns this
          // worker's lifecycle. Without it, an engine tile just looks like a
          // tile whose buttons went missing.
          <span
            className="flex shrink-0 items-center gap-1 rounded-[3px] border border-line px-1.5 py-0.5 text-[10px] text-ink-faint"
            title={t('projectPanel.swarm.engineOwnedHint')}
          >
            <Gauge size={10} strokeWidth={2.25} aria-hidden />
            {t('projectPanel.swarm.engineOwned')}
          </span>
        ) : (
          <>
            {accepting ? (
              // Offered while the pool still ACCEPTS an interrupt — not while
              // the desk is merely still alive. See `accepting`.
              <button
                type="button"
                onClick={() => void interrupt()}
                disabled={controlsBusy}
                title={t('projectPanel.swarm.sdk.interrupt')}
                className="flex shrink-0 items-center gap-1 rounded-[3px] border border-line px-1.5 py-0.5 text-[10px] text-ink-muted transition-colors hover:border-accent hover:text-accent active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1"
              >
                <Square size={11} strokeWidth={2.25} />
              </button>
            ) : null}
            {onTerminate ? (
              // Kept visible after the session ends ON PURPOSE — the worktree
              // outlives the session, and this is the only way to clean it up
              // from the UI.
              <button
                type="button"
                onClick={onTerminate}
                disabled={controlsBusy}
                title={t('projectPanel.swarm.terminate')}
                className="flex shrink-0 items-center gap-1 rounded-[3px] border border-line px-1.5 py-0.5 text-[10px] text-ink-muted transition-colors hover:border-accent hover:text-accent active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1"
              >
                <Power size={10} strokeWidth={2.25} />
                {busy ? t('projectPanel.swarm.terminating') : t('projectPanel.swarm.terminate')}
              </button>
            ) : null}
          </>
        )}
      </div>
      )}

      {openQuestion ? (
        // The worker is waiting on the OWNER — say so where they are looking,
        // show the question itself, and name the place the answer box lives.
        // role="status": it matters to a screen reader exactly as much.
        <div
          role="status"
          className="shrink-0 border-b border-ochre/40 bg-ochre/10 px-2.5 py-2"
        >
          <div className="flex items-start gap-1.5">
            <AlertTriangle size={13} strokeWidth={2.25} className="mt-0.5 shrink-0 text-ochre" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-medium text-ochre">
                {t('projectPanel.swarm.sdk.questionBanner')}
              </div>
              <div className="mt-0.5 line-clamp-3 text-[12px] leading-snug text-ink" title={openQuestion}>
                {openQuestion}
              </div>
              <div className="mt-1 text-[10px] text-ink-muted">
                {t('projectPanel.swarm.sdk.questionBannerHint')}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {truncated ? (
        // Never let an incomplete transcript look continuous.
        <div className="shrink-0 border-b border-line-soft bg-bg-card px-2.5 py-1 text-[10px] text-ochre">
          {t('projectPanel.swarm.sdk.truncated')}
        </div>
      ) : null}

      {actionError ? (
        // The refusal, said out loud. role="alert" so it reaches a screen
        // reader too — a message that never left is not a visual detail.
        <div
          role="alert"
          className="shrink-0 border-b border-line-soft bg-error/10 px-2.5 py-1 text-[10px] text-error"
        >
          {t('projectPanel.swarm.sdk.sendFailed', { error: actionError })}
        </div>
      ) : null}

      {/* Retained-worktree strip — the same shape and words as
          SwarmWorkerPane's: a soft terminate kept a dirty/locked tree so the
          worker's uncommitted work isn't lost; offer an explicit force. */}
      {retainedReason && onForceRemove ? (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-line-soft bg-bg-inset px-2.5 py-1">
          <AlertTriangle size={11} className="shrink-0 text-ochre" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-[10px] text-ink-muted" title={retainedReason}>
            {t('projectPanel.swarm.retained')}
          </span>
          <button
            type="button"
            onClick={onForceRemove}
            disabled={controlsBusy}
            className="flex shrink-0 items-center gap-1 rounded-[3px] border border-line px-1.5 py-0.5 text-[10px] text-ink-muted transition-colors hover:border-accent hover:text-accent active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1"
          >
            <Trash2 size={10} strokeWidth={2.25} />
            {t('projectPanel.swarm.forceRemove')}
          </button>
        </div>
      ) : null}

      {/* Feed — grouped transcript (tool call + result = one collapsed card;
          prose = markdown blocks), with the jump-to-latest pill when the reader
          has scrolled up. */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={feedRef}
          onScroll={onFeedScroll}
          className="h-full overflow-y-auto px-6 py-5"
        >
          {/* Document measure (owner feedback 2026-08-03「paddingもないし文字も
              小さいし強弱がない」): the transcript is a REPORT, so it gets
              article typography — a capped line length instead of wall-to-wall
              text, real margins, and a type scale (ProseBlocks). Tool rows stay
              small and muted on purpose: they are the machinery, not the story. */}
          <div className="mx-auto w-full max-w-[720px] text-[12px] leading-relaxed">
            {frames.length === 0 ? (
              <div className="text-ink-faint">{t('projectPanel.swarm.sdk.empty')}</div>
            ) : (
              renderItems.map((it) =>
                it.kind === 'tool' ? (
                  <ToolCard key={it.seq} item={it} />
                ) : (
                  <EventRow key={it.seq} ev={it.ev} t={t} />
                ),
              )
            )}
          </div>
        </div>
        {drifted ? (
          <button
            type="button"
            onClick={jumpToLatest}
            className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full border border-line bg-bg-card px-2.5 py-1 text-[10px] text-ink-muted shadow-sm transition-colors hover:border-accent hover:text-accent active:scale-[0.98] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1"
          >
            ↓ {t('projectPanel.swarm.sdk.jumpLatest')}
          </button>
        ) : null}
      </div>

      {/* Session-ended strip — the SDK twin of SwarmWorkerPane's dead-PTY
          placeholder. Restart REUSES the worktree, so the branch and its work
          survive; without it the restart chain simply ended at the first SDK
          worker (this pane had no restart affordance at all). */}
      {finished && onRestart ? (
        <div className="flex shrink-0 items-center justify-center gap-2 border-t border-line-soft bg-bg-card px-2 py-1.5">
          <span className="text-[11px] text-ink-faint">{t('projectPanel.swarm.sessionEnded')}</span>
          <button
            type="button"
            onClick={onRestart}
            disabled={controlsBusy}
            className="flex shrink-0 items-center gap-1 rounded-[3px] border border-line bg-transparent px-2 py-1 text-[11px] text-ink-muted transition-colors hover:border-accent hover:bg-plane hover:text-accent active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1"
          >
            <RotateCcw size={11} strokeWidth={2.25} aria-hidden />
            {busy ? t('projectPanel.swarm.restarting') : t('projectPanel.swarm.restart')}
          </button>
        </div>
      ) : null}

      {/* Composer — the manual nudge / answer path. The engine drives this
          worker normally; this is for the owner looking over its shoulder.
          Gated on `accepting` — the pool's own answer to "will this be taken?"
          — never on liveness: a desk that was asked to stop is still ALIVE for
          a while, and it refuses every word of it. */}
      {accepting && !embedded ? (
        <div className="flex shrink-0 items-center gap-1.5 border-t border-line-soft bg-bg-card px-2 py-1.5">
          <input
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              // Typing again is the owner acting on the refusal — the banner
              // has done its job and would otherwise sit there stale.
              if (actionError) setActionError(null)
            }}
            onKeyDown={(e) => {
              // IME guard: never submit while a composition is in flight.
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
            placeholder={t('projectPanel.swarm.sdk.placeholder')}
            className="min-w-0 flex-1 rounded-[3px] border border-line bg-bg-inset px-1.5 py-0.5 text-[11px] text-ink placeholder:text-ink-faint transition-colors hover:border-line-strong focus:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1 disabled:cursor-not-allowed disabled:opacity-40"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={controlsBusy || !draft.trim()}
            title={t('projectPanel.swarm.sdk.send')}
            className="flex shrink-0 items-center gap-1 rounded-[3px] border border-line px-1.5 py-0.5 text-[10px] text-ink-muted transition-colors hover:border-accent hover:text-accent active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1"
          >
            <CornerDownLeft size={11} strokeWidth={2.25} />
          </button>
        </div>
      ) : null}
    </div>
  )
}

/** Token counts as a reader scans them, not as the API reports them: 128000 is
 *  noise, "128k" is a size. Under 1000 stays exact — a small number IS the info. */
const fmtTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

/** Inline styling for one line of worker prose: `code` spans and **bold**.
 *  A tiny hand parser on purpose — every node is a React element (nothing ever
 *  reaches innerHTML), and the subset is exactly what workers emit. */
const InlineMd = ({ text }: { text: string }) => {
  const parts: (string | { code: string } | { bold: string })[] = []
  let rest = text
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/
  for (;;) {
    const m = re.exec(rest)
    if (!m) break
    if (m.index > 0) parts.push(rest.slice(0, m.index))
    parts.push(m[1] !== undefined ? { code: m[1] } : { bold: m[2] })
    rest = rest.slice(m.index + m[0].length)
  }
  if (rest) parts.push(rest)
  return (
    <>
      {parts.map((p, i) =>
        typeof p === 'string' ? (
          <span key={i}>{p}</span>
        ) : 'code' in p ? (
          <code key={i} className="rounded-[3px] bg-bg-inset px-1.5 py-px font-mono text-[0.88em] text-ink">
            {p.code}
          </code>
        ) : (
          <strong key={i} className="font-semibold">
            {p.bold}
          </strong>
        ),
      )}
    </>
  )
}

/** Worker prose as markdown blocks — the research's core readability move. */
// Article typography for the worker's prose (2026-08-03 owner feedback): base
// 13.5px/1.75 with a real heading scale and paragraph rhythm — this is the
// PRIMARY reading surface of the desk. Sub-agent prose stays a size down and
// muted (a side conversation, not the report).
const ProseBlocks = ({ text, subagent }: { text: string; subagent?: boolean }) => (
  <div
    className={
      subagent
        ? 'pl-3 text-[12px] leading-[1.7] text-ink-muted'
        : 'text-[13.5px] leading-[1.75] text-ink'
    }
  >
    {parseMarkdownBlocks(text).map((b, i) => {
      switch (b.kind) {
        case 'heading':
          return (
            <div
              key={i}
              className={`font-semibold ${
                b.level === 1
                  ? 'mb-1.5 mt-5 text-[16px]'
                  : b.level === 2
                    ? 'mb-1 mt-4 text-[14.5px]'
                    : 'mb-1 mt-3 text-[13.5px]'
              }`}
            >
              <InlineMd text={b.text} />
            </div>
          )
        case 'code':
          return (
            <pre
              key={i}
              className="my-2.5 overflow-x-auto rounded-[4px] bg-bg-inset px-3 py-2 font-mono text-[11.5px] leading-relaxed text-ink"
            >
              {b.text}
            </pre>
          )
        case 'list':
          return (
            <ul
              key={i}
              className={`my-2 ${b.ordered ? 'list-decimal' : 'list-disc'} space-y-1 pl-5 marker:text-ink-faint`}
            >
              {b.items.map((it, j) => (
                <li key={j}>
                  <InlineMd text={it} />
                </li>
              ))}
            </ul>
          )
        default:
          return (
            <p key={i} className="my-2 whitespace-pre-wrap">
              <InlineMd text={b.text} />
            </p>
          )
      }
    })}
  </div>
)

/** One tool call as ONE collapsed card — summary row (name + clamped args),
 *  the result attached as the elbow preview, click to expand. An ERROR result
 *  ships expanded and red (the research's one no-collapse rule). */
const ToolCard = ({ item }: { item: Extract<SdkRenderItem, { kind: 'tool' }> }) => {
  const isError = item.result !== null && !item.result.ok
  const [expanded, setExpanded] = useState(isError)
  const sub = item.use.fromSubagent
  return (
    <div className={`my-0.5 ${sub ? 'pl-3' : ''}`}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-baseline gap-1 rounded-[3px] px-1 py-0.5 text-left font-mono text-[10px] text-ink-muted transition-colors hover:bg-plane hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1"
      >
        <span className="shrink-0 text-ink-faint" aria-hidden>
          {expanded ? '▾' : '▸'}
        </span>
        <span className="min-w-0 flex-1 truncate">🔧 {toolCardSummary(item.use)}</span>
        {item.result && !expanded ? (
          <span className={`min-w-0 max-w-[45%] truncate ${isError ? 'text-error' : 'text-ink-faint'}`}>
            ⎿ {item.result.head}
          </span>
        ) : null}
      </button>
      {expanded ? (
        <div className="ml-4 border-l border-line-soft pl-2">
          {item.use.detail ? (
            <div className="whitespace-pre-wrap break-all font-mono text-[10px] text-ink-muted">{item.use.detail}</div>
          ) : null}
          {item.result ? (
            <div className={`whitespace-pre-wrap break-all font-mono text-[10px] ${isError ? 'text-error' : 'text-ink-faint'}`}>
              ⎿ {item.result.head}
            </div>
          ) : (
            <div className="font-mono text-[10px] text-ink-faint">…</div>
          )}
        </div>
      ) : null}
    </div>
  )
}

const EventRow = ({ ev, t }: { ev: SdkEvent; t: (k: string) => string }) => {
  switch (ev.kind) {
    case 'text':
      // The worker's own words are the PRIMARY content of this transcript —
      // markdown blocks, full ink. Sub-agent text stays quieter.
      return <ProseBlocks text={ev.text} subagent={ev.fromSubagent} />
    case 'tool_use':
      return (
        <div className={`font-mono text-[10px] text-ink-muted ${ev.fromSubagent ? 'pl-3' : ''}`}>
          🔧 {ev.name}
          {ev.detail ? ` ${ev.detail}` : ''}
        </div>
      )
    case 'tool_result':
      return (
        <div className={`font-mono text-[10px] ${ev.ok ? 'text-ink-faint' : 'text-error'} ${ev.fromSubagent ? 'pl-3' : ''}`}>
          ↳ {ev.head}
        </div>
      )
    case 'thinking':
      return (
        <div className="font-mono text-[10px] text-ink-faint">
          {t('projectPanel.swarm.sdk.thinking')} ({ev.chars})
        </div>
      )
    case 'turn_end':
      // A turn boundary is a PAUSE, not a wall — breathing room over a rule.
      return <div className="my-4 border-t border-line-soft" aria-hidden />
    case 'quota_refusal':
      return (
        <div className="my-1 rounded-[3px] border border-ochre/40 bg-ochre/10 px-2 py-1 text-[10px] text-ochre">
          {ev.raw}
        </div>
      )
    case 'api_error':
      return (
        <div className="my-1 rounded-[3px] border border-error/40 bg-error/10 px-2 py-1 text-[10px] text-error">
          {ev.status ? `${ev.status} — ` : ''}
          {ev.head}
        </div>
      )
    case 'rate_limit':
      return (
        <div className="font-mono text-[10px] text-ink-faint">
          {t('projectPanel.swarm.sdk.rateLimit')} {Math.round(ev.utilization * 100)}%
        </div>
      )
    case 'compact':
      // Deliberately visible rather than a faint aside: this is the transcript's
      // ONLY sign that history was summarised, and a reader who does not see it
      // will wonder why the desk "forgot". The token counts are the proof.
      return (
        <div className="my-1 rounded-[3px] border border-line bg-bg-card px-2 py-1 font-mono text-[10px] text-ink-muted">
          ⟳ {t('projectPanel.swarm.sdk.compact')}
          {ev.preTokens > 0
            ? ` — ${fmtTokens(ev.preTokens)}${ev.postTokens !== null ? ` → ${fmtTokens(ev.postTokens)}` : ''}`
            : ''}
        </div>
      )
    case 'status':
    default:
      return null
  }
}

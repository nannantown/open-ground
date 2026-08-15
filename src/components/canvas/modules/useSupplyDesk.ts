// useSupplyDesk — the project's ONE supply desk (補給官 / タスク窓口), as a hook.
//
// WHY THIS IS A HOOK AND NOT COPY-PASTE (2026-08-15). The Board grew a front-desk
// seat so the owner can talk to the supply officer without leaving the kanban.
// That makes TWO surfaces driving ONE desk, and the desk's identity is a single
// localStorage record (`openground.swarm.supply.<projectId>`) reconciled against
// a single server-published handle. Two hand-written copies of that reconcile
// would not merely duplicate code — they would DISAGREE: after an app restart
// one surface would adopt the engine-woken desk and the other would keep the
// dead pre-restart id, and whichever the owner opened last would win the
// localStorage write. So the state lives here, once, and both mounts read it.
//
// WHAT THIS HOOK DOES NOT DO:
//   • It does not guarantee one desk. That is the SERVER's job and it is now
//     done there (swarmSupply.spawnSwarmSupply's spawn lock + adopt). The
//     `busy` guards below are ergonomics — they stop a double-click — and a
//     client-side guard is never a singleton invariant.
//   • It does not own the commander. The 司令官 is SDK-capable with its own
//     adoption path; folding it in here doubles the blast radius for no gain.
//   • It does not own `exitedIds`. The caller does, because the caller also
//     tracks worker/commander PTYs with the same set and derives pane status
//     from it — a private set here would leave the caller's status derivation
//     blind to a supply exit.

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api-client'
import { useT } from '@/i18n/I18nContext'
import { reconcileDesk, type LiveDeskHandle } from '@/lib/deskReconcile'
import { envIssuesErrorMessage } from './useSwarmEngine'
import type { SpawnSwarmSupplyResponse } from '@/lib/types'

/** The supply session as the client remembers it. Like a worker, the PTY
 *  (terminalId) lives SERVER-side and survives this tab unmounting; the metadata
 *  is persisted so a tab switch / reload reattaches the same session. Unlike a
 *  worker there is no branch/worktree — supply runs in the project's primary
 *  checkout — so this is just the PTY id + minted session id + start time. */
export interface SupplyDeskRecord {
  terminalId: string
  agentSessionId: string
  startedAt: string
}

export const supplyStorageKey = (projectId: string) => `openground.swarm.supply.${projectId}`

/** Load + SANITISE the persisted supply session (localStorage is untrusted — a
 *  user/extension can forge any JSON, so coerce every field; a bad shape → null
 *  rather than crashing the render). */
export const loadSupplyRecord = (projectId: string): SupplyDeskRecord | null => {
  try {
    const raw = localStorage.getItem(supplyStorageKey(projectId))
    if (!raw) return null
    const o: unknown = JSON.parse(raw)
    if (!o || typeof o !== 'object') return null
    const r = o as Record<string, unknown>
    if (typeof r.terminalId !== 'string') return null
    return {
      terminalId: String(r.terminalId),
      agentSessionId: typeof r.agentSessionId === 'string' ? r.agentSessionId : '',
      startedAt: typeof r.startedAt === 'string' ? r.startedAt : '',
    }
  } catch {
    return null
  }
}

export const saveSupplyRecord = (projectId: string, supply: SupplyDeskRecord | null) => {
  try {
    if (supply) localStorage.setItem(supplyStorageKey(projectId), JSON.stringify(supply))
    else localStorage.removeItem(supplyStorageKey(projectId))
  } catch {
    /* quota / disabled storage — the in-memory state is still authoritative */
  }
}

export interface UseSupplyDeskArgs {
  /** Registry UUID — the localStorage namespace (stable across rename/move). */
  projectId: string
  /** The project path the spawn routes validate. */
  projectPath: string
  /** The server's LIVE supply handle, straight off the caller's orchestrator
   *  poll (`SwarmOrchestratorState.supplyDesk`).
   *
   *  ⚠ THREE VALUES, THREE MEANINGS, and collapsing any two is a bug:
   *  a handle ⇒ that desk is up; `null` ⇒ the server looked and found none;
   *  `undefined` ⇒ the server did not say (an older build with no such field),
   *  which must NEVER be read as "no desk". deskReconcile.ts enforces it. */
  supplyDesk: LiveDeskHandle | null | undefined
  /** PTY ids the CALLER has confirmed dead (pane exit / dead mount probe).
   *  Required for the reconcile's `storedDead`. */
  exitedIds: ReadonlySet<string>
  /** Drop a now-dead PTY id from the caller's exited/seen bookkeeping so a
   *  relaunched session starts clean. `keep` is the freshly installed id — never
   *  evict that one. */
  forgetPty: (id: string | undefined, keep?: string) => void
  /** May this surface drive the supply desk at all?
   *
   *  ⚠ REQUIRED, not optional. A caller that forgets it is a BUILD ERROR rather
   *  than a surface that silently defaults open — the repo's own preference for
   *  over-approximation over an existence check (liveDesks.computeRestartSafety
   *  carries the same note for the same reason). `false` makes every action a
   *  no-op AND stops the reconcile, so a gated-off surface neither spawns
   *  anything nor rewrites the shared record behind the gate's back. */
  enabled: boolean
}

export interface SupplyDeskApi {
  /** The desk this client is attached to, or null (⇒ render a launch CTA). */
  supply: SupplyDeskRecord | null
  /** A launch/stop/restart round-trip is in flight. */
  busy: boolean
  /** The last action failure, already localized. */
  error: string | null
  clearError: () => void
  launch: () => Promise<void>
  stop: () => Promise<void>
  restart: () => Promise<void>
}

/** POST /api/swarm/supply, shared by launch + restart.
 *
 *  Raw fetch with a typed cast — a VERBATIM move of what SwarmModule shipped,
 *  including the env-issue message translation (the route's raw English
 *  `body.error` once reached the banner untranslated, 2026-07-22). */
const postSupply = async (
  projectPath: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
): Promise<SpawnSwarmSupplyResponse> => {
  const res = await fetch('/api/swarm/supply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: projectPath }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; envIssues?: unknown }
    throw new Error(
      envIssuesErrorMessage(t, body?.envIssues) ?? body?.error ?? `HTTP ${res.status}`,
    )
  }
  return (await res.json()) as SpawnSwarmSupplyResponse
}

export const useSupplyDesk = ({
  projectId,
  projectPath,
  supplyDesk,
  exitedIds,
  forgetPty,
  enabled,
}: UseSupplyDeskArgs): SupplyDeskApi => {
  const { t } = useT()
  const [supply, setSupply] = useState<SupplyDeskRecord | null>(() => loadSupplyRecord(projectId))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ⚠ THE DESK THE OWNER JUST CLOSED, so 停止 STICKS.
  //
  // The server publishes the live handle every ~5s, and its re-confirmation is
  // a process-table read. A stop kills the PTY and returns immediately, but the
  // NEXT poll can still be the previous one's answer — a handle for a desk that
  // is already dying. Without this, the reconcile below sees "a live desk the
  // record does not name" and does exactly what it is built to do: ADOPTS it.
  // The pane the owner just closed comes straight back, and closing it again
  // loses the same race. This is the supply twin of the commander's 停止 not
  // sticking (overnight review 2026-08-03), reached from the client side.
  //
  // Precise rather than timed: we remember the ONE handle we asked to die and
  // refuse to adopt THAT id — no window, no debounce, nothing to tune. The
  // marker clears the moment the server stops publishing it (or publishes a
  // different desk), and a deliberate launch/restart clears it outright, so it
  // can never wedge a desk the owner is asking for.
  const stoppedHandleRef = useRef<string | null>(null)

  // Re-read for the project the host is now showing. Hosts keep ONE instance of
  // themselves across project switches, so without this the desk of the previous
  // project would stay on screen (and, worse, be stoppable from here).
  useEffect(() => {
    setSupply(loadSupplyRecord(projectId))
    setBusy(false)
    setError(null)
    stoppedHandleRef.current = null
  }, [projectId])

  // ── Desk reconcile (the post-restart dead-screen fix, 2026-08-03) ───────────
  // Every engine poll carries the LIVE desk handle. Follow it: ADOPT an
  // engine-woken desk the stored record does not name (zero-click reconnect
  // after an app restart), CLEAR a confirmed-dead record with no successor
  // (an honest launch CTA instead of the eternal 「セッションが終了しました」).
  // The decision itself is pure and guarded (deskReconcile.ts — busy wins, an
  // old server changes nothing); this effect only applies the verdict.
  useEffect(() => {
    if (!enabled) return
    // Forget the just-stopped marker as soon as the server stops naming that
    // desk — from then on the normal reconcile is right again.
    if (stoppedHandleRef.current && supplyDesk?.handleId !== stoppedHandleRef.current) {
      stoppedHandleRef.current = null
    }
    const v = reconcileDesk(
      supply
        ? {
            terminalId: supply.terminalId,
            runtime: 'pty', // the supply desk is PTY-only by design
            agentSessionId: supply.agentSessionId,
            startedAt: supply.startedAt,
          }
        : null,
      supplyDesk,
      { busy, storedDead: !!supply && exitedIds.has(supply.terminalId) },
    )
    if (
      v.kind === 'adopt' &&
      v.record.runtime === 'pty' &&
      v.record.terminalId !== stoppedHandleRef.current
    ) {
      const rec: SupplyDeskRecord = {
        terminalId: v.record.terminalId,
        agentSessionId: v.record.agentSessionId,
        startedAt: v.record.startedAt,
      }
      setSupply(rec)
      saveSupplyRecord(projectId, rec)
    } else if (v.kind === 'clear') {
      setSupply(null)
      saveSupplyRecord(projectId, null)
    }
  }, [enabled, supplyDesk, supply, busy, exitedIds, projectId])

  // Launch the single supply (補給官) session: POST /api/swarm/supply spawns a
  // claude PTY in the project's PRIMARY checkout (NO worktree) running /supply.
  // No card is read — supply IS the conversation desk; the user types requests
  // into it and it files Board:todo cards.
  const launch = useCallback(async () => {
    if (!enabled || supply || busy) return
    // The owner is deliberately opening the desk — whatever they closed before
    // is no longer a reason to refuse an adopt.
    stoppedHandleRef.current = null
    setBusy(true)
    setError(null)
    try {
      const spawn = await postSupply(projectPath, t)
      // `spawn.reused` (server ≥ 2026-08-15) means the desk was ALREADY up and
      // nothing was launched — we still store the record, because the point is
      // to be attached to the desk that exists. Deliberately not surfaced as an
      // error or a warning: from the owner's side "the front desk is open" is
      // the outcome they asked for either way.
      const next: SupplyDeskRecord = {
        terminalId: spawn.terminalId,
        agentSessionId: spawn.agentSessionId,
        startedAt: new Date().toISOString(),
      }
      setSupply(next)
      saveSupplyRecord(projectId, next)
    } catch (e) {
      setError(
        t('projectPanel.swarm.supply.launchFailed', {
          error: e instanceof Error ? e.message : String(e),
        }),
      )
    } finally {
      setBusy(false)
    }
  }, [enabled, supply, busy, projectPath, projectId, t])

  // Stop the supply session: kill the PTY. There is NO worktree to tear down
  // (supply runs in the primary checkout), so unlike a worker terminate this is
  // a plain terminal kill — the session drops back to the launch CTA, and the
  // caller's exited/seen bookkeeping is cleared so a relaunch starts clean.
  const stop = useCallback(async () => {
    if (!enabled || !supply || busy) return
    const term = supply.terminalId
    // Remember it BEFORE the round-trip: the reconcile can fire on a poll that
    // lands while the kill is still in flight.
    stoppedHandleRef.current = term
    setBusy(true)
    setError(null)
    try {
      // The intent-clearing stop (2026-08-03): kills the desk server-side AND
      // clears the persisted supplyDesired flag — without it, boot auto-resume
      // would resurrect a desk the owner just closed, every restart, forever.
      await fetch('/api/swarm/supply/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: projectPath }),
      }).catch(() => {})
      // Belt-and-braces: the raw terminal delete for the stored id (the route
      // kills by desk label; a desk the pool lost the label for still dies here).
      await api.api.terminal[':id'].$delete({ param: { id: term } }).catch(() => {})
    } finally {
      setSupply(null)
      saveSupplyRecord(projectId, null)
      forgetPty(term)
      setBusy(false)
    }
  }, [enabled, supply, busy, projectId, projectPath, forgetPty])

  // ── Restart an EXITED desk (the ClaudeTerminalPane exit overlay's button) ───
  // Re-launch and SWAP IN the new terminalId, which re-keys the embedded pane's
  // effect and clears its exited overlay. The overlay only ever shows on a DEAD
  // PTY and the busy guard blocks a second click, so a restart can never
  // double-launch a live session. On failure the old (exited) id stays in place,
  // so the overlay remains and the user can retry.
  const restart = useCallback(async () => {
    if (!enabled || busy) return
    const old = supply?.terminalId
    stoppedHandleRef.current = null
    setBusy(true)
    setError(null)
    try {
      // Best-effort kill the old PTY first. The overlay normally shows only on a
      // dead PTY, but a transient mount-probe failure could surface it for a live
      // one — killing first guarantees we never orphan a still-running session.
      if (old) await api.api.terminal[':id'].$delete({ param: { id: old } }).catch(() => {})
      const spawn = await postSupply(projectPath, t)
      const next: SupplyDeskRecord = {
        terminalId: spawn.terminalId,
        agentSessionId: spawn.agentSessionId,
        startedAt: new Date().toISOString(),
      }
      setSupply(next)
      saveSupplyRecord(projectId, next)
      forgetPty(old, next.terminalId)
    } catch (e) {
      setError(
        t('projectPanel.swarm.restartFailed', {
          error: e instanceof Error ? e.message : String(e),
        }),
      )
    } finally {
      setBusy(false)
    }
  }, [enabled, supply, busy, projectPath, projectId, forgetPty, t])

  const clearError = useCallback(() => setError(null), [])

  return { supply, busy, error, clearError, launch, stop, restart }
}

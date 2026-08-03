// deskReconcile — should the Swarm tab's stored desk record follow the server?
//
// THE PROBLEM THIS SOLVES (2026-08-03 owner report, audited to file:line). The
// tab restores its commander/supply record from localStorage; after an app
// restart that record names a desk whose pool died with the old process. The
// pane then mount-probes the dead id and sits on 「セッションが終了しました」
// FOREVER, because nothing the client polled carried the id of the desk the
// ENGINE had meanwhile woken — the heartbeat has phase/note but no handle. The
// sidebar could say 「司令官は作業中」 while the stage said the session ended.
//
// getOrchestratorState now surfaces the LIVE desk handle (managerDesk /
// supplyDesk — both-pools reads). This module is the pure decision the tab
// applies on every poll: ADOPT the live desk, CLEAR a record that is dead with
// no successor, or KEEP what it has. Pure and injected-input-only so the teeth
// can bite without a DOM or a pool.

/** The tab's stored record shape (SwarmModule's SwarmManager/SwarmSupply). */
export interface StoredDeskRecord {
  terminalId: string
  runtime: 'pty' | 'sdk'
  sdkSessionId?: string
  agentSessionId: string
  startedAt: string
}

/** The server's live-desk handle (SwarmOrchestratorState.managerDesk/supplyDesk). */
export interface LiveDeskHandle {
  runtime: 'pty' | 'sdk'
  handleId: string
  agentSessionId: string | null
}

export type DeskReconcileVerdict =
  | { kind: 'keep' }
  | { kind: 'adopt'; record: StoredDeskRecord }
  | { kind: 'clear' }

/** The one id a record is ADDRESSED by (pty ⇔ terminalId, sdk ⇔ sdkSessionId —
 *  the identity invariant, workerRuntime.ts). */
const storedHandleId = (r: StoredDeskRecord): string =>
  r.runtime === 'sdk' ? (r.sdkSessionId ?? '') : r.terminalId

export const reconcileDesk = (
  stored: StoredDeskRecord | null,
  server: LiveDeskHandle | null | undefined,
  opts: {
    /** An owner action (launch/stop/restart) is in flight — never fight it. */
    busy: boolean
    /** The client already CONFIRMED its stored desk is dead (mount probe 404 /
     *  exit event). Required for 'clear': the server read and the client's
     *  probe can momentarily disagree (a desk mid-spawn), and clearing a
     *  record the client still believes is alive would flap the pane. */
    storedDead: boolean
    now?: () => number
  },
): DeskReconcileVerdict => {
  if (opts.busy) return { kind: 'keep' }
  // An OLD server omits the field entirely — keep the old behaviour, never
  // treat "the server doesn't know how to say" as "the server said none".
  if (server === undefined) return { kind: 'keep' }

  if (server === null) {
    // No live desk. Clear only a record the client itself has confirmed dead —
    // that is the exact post-restart shape (dead screen) this module exists to
    // end; a live-looking record with a momentarily empty pool read is kept.
    return stored && opts.storedDead ? { kind: 'clear' } : { kind: 'keep' }
  }

  // A live desk exists. Already pointing at it ⇒ keep; anything else ⇒ ADOPT —
  // including replacing a dead pre-restart record with the engine-woken desk,
  // which is the zero-click reconnect the owner asked for.
  if (stored && storedHandleId(stored) === server.handleId) return { kind: 'keep' }
  const nowIso = new Date((opts.now ?? Date.now)()).toISOString()
  return {
    kind: 'adopt',
    record:
      server.runtime === 'sdk'
        ? {
            terminalId: '', // EMPTY by the identity invariant
            runtime: 'sdk',
            sdkSessionId: server.handleId,
            agentSessionId: server.agentSessionId ?? '',
            startedAt: nowIso,
          }
        : {
            terminalId: server.handleId,
            runtime: 'pty',
            agentSessionId: server.agentSessionId ?? '',
            startedAt: nowIso,
          },
  }
}

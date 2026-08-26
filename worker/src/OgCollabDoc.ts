import { YServer } from 'y-partyserver'
import * as Y from 'yjs'
import type { Connection } from 'partyserver'

// The Durable Object that hosts ONE OPEN GROUND collab room (a single Yjs
// document = one board scope OR one canvas scope of one shared project).
//
// y-partyserver's `YServer` implements the full Yjs sync protocol (sync step
// 1/2 + live update relay + awareness) over the DO's hibernatable WebSocket
// API. We only customise:
//   • options.hibernate — let the DO evict from memory between edits (cheap,
//     and the reason onLoad/onSave below must persist the doc);
//   • onLoad/onSave     — round-trip the merged document through DO SQLite
//     storage so a room survives hibernation / eviction / redeploys;
//   • isReadOnly        — every connection that passed the ticket gate (in
//     index.ts onBeforeConnect) is a verified member, so all are read-write.
//
// Auth happens BEFORE the socket is accepted (onBeforeConnect in index.ts
// verifies the HMAC ticket and that it matches this room), so by the time a
// Connection reaches this class it is already authorized.

// One Y.Doc can be encoded to a single update blob (Y.encodeStateAsUpdate) and
// rebuilt by applying it (Y.applyUpdate). We persist that blob under one
// storage key. (Chunked across rows would scale further, but a board/canvas
// document is small; one key keeps load/save atomic and simple.)
const STORAGE_KEY = 'ydoc'

// NB: `extends YServer` carries NO type parameter — `YServer` is exported as a
// const intersection (not a generic class), so `YServer<Env>` is a type error.
// `this.ctx` (DurableObjectState) and `this.document` are available regardless;
// the Worker's Env binding is enforced at the entry point (src/index.ts).
export class OgCollabDoc extends YServer {
  // Hibernate when idle: the runtime can evict this DO from memory and rehydrate
  // it on the next message. onLoad/onSave make that lossless.
  static options = { hibernate: true }

  /**
   * Rehydrate the room's document from durable storage. Called by YServer once
   * per cold start (in onStart), BEFORE any client update is applied, so a
   * previously-saved room comes back intact after hibernation/eviction.
   *
   * CONTRACT: onLoad must RETURN a Y.Doc (YServer's signature is
   * `onLoad(): Promise<Doc | void>`, and onStart does
   * `const src = await this.onLoad(); if (src) applyUpdate(this.document,
   * encodeStateAsUpdate(src))`). We therefore build a fresh Y.Doc, replay the
   * saved update onto it, and hand it back — we do NOT mutate this.document here.
   * Returning nothing (no saved state) starts the room empty.
   */
  async onLoad(): Promise<Y.Doc | void> {
    const saved = await this.ctx.storage.get<Uint8Array | ArrayBuffer>(STORAGE_KEY)
    if (!saved) return
    const update = saved instanceof Uint8Array ? saved : new Uint8Array(saved)
    if (update.byteLength === 0) return
    // Convergent: applying the full state update onto a fresh doc reproduces the
    // prior state. YServer merges this into its own document via onStart.
    const doc = new Y.Doc()
    Y.applyUpdate(doc, update)
    return doc
  }

  /**
   * Persist the room's current merged state to durable storage. YServer calls
   * this (debounced) after updates and on hibernation, so the latest converged
   * document is what a future onLoad restores.
   */
  async onSave(): Promise<void> {
    const update = Y.encodeStateAsUpdate(this.document)
    await this.ctx.storage.put(STORAGE_KEY, update)
  }

  /**
   * ERASE this room: drop every live socket, then empty durable storage.
   * Called over RPC by the operator-only purge route (src/admin.ts) — never by
   * a member, and never by the ticket-gated paths.
   *
   * ORDER MATTERS:
   *
   *  1. Close the sockets first. NOT load-bearing — this is a courtesy, and the
   *     comment says so because it was MEASURED: deleting this loop entirely
   *     leaves all 62 worker checks green, since resetInstance() below tears the
   *     instance (and therefore every socket) down regardless. It is kept only
   *     so peers see a normal 1000 closure instead of an abrupt teardown, which
   *     is gentler on partysocket's reconnect backoff. Do not rely on it for
   *     correctness, and do not let a future reader believe erasure depends on
   *     it.
   *  2. THEN deleteAll(). Per Cloudflare's storage docs, dropping individual
   *     keys or tables is NOT sufficient — internal metadata survives and the
   *     object keeps existing (and billing). `deleteAll()` is the only complete
   *     erase, and an object whose storage is empty when it shuts down ceases to
   *     exist entirely.
   *
   * Emptying storage is NOT on its own enough, and this was MEASURED rather than
   * reasoned about: with only steps 1+2, the purge reported hadDoc:true, storage
   * really was empty — and a fresh client connecting a second later STILL
   * received the whole document. The instance was still resident, so YServer
   * served `this.document` straight out of memory and would have re-persisted it
   * on the next edit. Relying on the ~10s hibernation window to drop that memory
   * is not erasure, it is a race. `resetInstance()` below closes it; the caller
   * must invoke it immediately after this method.
   *
   * deleteAlarm() is explicit because this Worker's compatibility_date
   * (2024-11-01) predates the 2026-02-24 change that folded alarm deletion into
   * deleteAll(). y-partyserver does not currently set one — its persistence is a
   * debounced `document.on('update')` callback, not an alarm — but an alarm left
   * behind would keep the object alive and billable, and the call is a harmless
   * no-op when there is none.
   *
   * Returns whether a persisted document was actually present, so the caller can
   * MEASURE the erase rather than infer it from a 200.
   */
  async purgeStorage(): Promise<{ hadDoc: boolean }> {
    const existing = await this.ctx.storage.get<Uint8Array | ArrayBuffer>(STORAGE_KEY)
    const hadDoc = existing != null

    for (const conn of this.getConnections()) {
      try {
        conn.close(1000, 'room erased')
      } catch {
        // A socket already gone is exactly the state we want it in.
      }
    }

    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
    return { hadDoc }
  }

  /**
   * Tear this instance down so the in-memory Y.Doc is discarded. Pairs with
   * purgeStorage() — call it IMMEDIATELY after, never on its own (on a live room
   * it would just drop everyone for no reason).
   *
   * WHY IT IS A SEPARATE RPC: `ctx.abort()` resets the object synchronously,
   * which kills the very request that called it. Folding it into purgeStorage()
   * would destroy that method's return value, so the caller could no longer
   * learn whether a document had actually been there — the one fact that makes
   * the erase measurable. Splitting the two keeps the result deliverable, at the
   * cost of this call always appearing to fail. admin.ts therefore expects the
   * rejection and ignores it.
   *
   * The storage deletes are already awaited (and therefore committed) before
   * this runs, so the reset cannot roll them back: the reconstructed instance
   * reads empty storage and the room comes back as nothing.
   */
  resetInstance(): void {
    this.ctx.abort('room erased')
  }

  /**
   * Every connection here already cleared the ticket gate (a verified project
   * member), so none are read-only. Returning false keeps the door open for a
   * future per-role split (e.g. viewer tickets) without changing the gate.
   * (`_conn` is intentionally unused — argsIgnorePattern "^_".)
   *
   * NOTE: the ticket DOES carry a `role` claim ('owner' | 'member'), but it is
   * INTENTIONALLY IGNORED today — collab is single-role (every member is
   * read-write). This method is the seam for future viewer/edit tiering: gate
   * read-only off the verified role here (and bind it in the ticket) when the
   * product grows viewer access.
   */
  isReadOnly(_conn: Connection): boolean {
    return false
  }
}

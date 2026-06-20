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

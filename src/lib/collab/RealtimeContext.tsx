import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Doc as YDoc } from 'yjs'
import type {
  CanvasFile,
  CollabConfigResponse,
  CollabProjectResponse,
  CollabSource,
  DocScope,
  PresencePeer,
  ProjectData,
} from '../types'
import type { AwarenessLike } from './provider'

// RealtimeContext — the single client-side entry to realtime collab. It is
// STATICALLY safe: it imports only React + TYPES (erased at build), so importing
// it never pulls yjs / the mappers / the y-partyserver transport into the main
// bundle. Every heavy module is loaded with `await import()` inside the enabled
// branch ONLY, so the collab-OFF build ships none of it (the basis of the u18
// guarantee).
//
// Transport: a Cloudflare Durable Object reached via y-partyserver. There is no
// shared client/socket anymore — each doc opens its OWN WebSocket through
// connectCollabDoc, authorized by a short-lived ticket that partysocket
// re-fetches on every reconnect (so no refresh timer lives here).

interface RealtimeContextValue {
  /** Global gate: OPENGROUND_REALTIME flag + Supabase configured + signed in. */
  enabled: boolean
}

const RealtimeContext = createContext<RealtimeContextValue>({ enabled: false })

export const useCollab = (): RealtimeContextValue => useContext(RealtimeContext)

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState(false)

  // One-shot capability probe. {enabled:false} (the default build) leaves every
  // heavy import untouched.
  useEffect(() => {
    let alive = true
    fetch('/api/collab/config')
      .then((r) => (r.ok ? (r.json() as Promise<CollabConfigResponse>) : { enabled: false }))
      .then((c) => {
        if (alive) setEnabled(!!c.enabled)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  return <RealtimeContext.Provider value={{ enabled }}>{children}</RealtimeContext.Provider>
}

// ── per-doc binding ─────────────────────────────────────────────────────────

export interface CollabBinding<T> {
  doc: YDoc
  synced: boolean
  /** Authoritatively seed the doc from disk state (idempotent — re-seeding the
   *  same value emits zero Y updates, which is what makes mirroring on every
   *  local persist loop-safe). */
  seed: (value: T) => void
  /** Read the doc's shared fields back, layered over `base`. */
  extract: (base: T) => T
  /** Subscribe to REMOTE (peer) doc changes only — our own seeds (ORIGIN_SEED)
   *  are filtered out. Returns an unsubscribe fn. */
  onRemote: (cb: () => void) => () => void
  /** Presence (u15): publish THIS client's identity into the awareness channel
   *  (null clears it). No-op when the provider has no awareness. */
  setPresence: (state: { name: string; color: string } | null) => void
  /** Subscribe to the set of OTHER present peers (self excluded). Fires once
   *  immediately, then on every awareness change. Returns an unsubscribe fn. */
  onPresence: (cb: (peers: PresencePeer[]) => void) => () => void
}

// Map an awareness state set → the OTHER peers (self excluded), keeping only
// entries that carry a usable identity. Exported for unit testing — it's the
// pure projection the presence avatars depend on.
export const peersFromAwareness = (aw: AwarenessLike): PresencePeer[] => {
  const out: PresencePeer[] = []
  for (const [clientId, st] of Array.from(aw.getStates())) {
    if (clientId === aw.clientID) continue
    const name = typeof st?.name === 'string' ? st.name : ''
    const color = typeof st?.color === 'string' ? st.color : '#888888'
    if (name) out.push({ clientId, name, color })
  }
  return out
}

interface Mappers<T> {
  toDoc: (doc: YDoc, value: T) => void
  fromDoc: (doc: YDoc, base: T) => T
}

// Scope mapper loaders — module-level so the owner + member (shared) hooks share
// one closure each (stable identity, lazy-imported only inside the bound effect).
const boardMappers = (): Promise<Mappers<ProjectData>> =>
  import('./boardDoc').then((m) => ({
    toDoc: m.projectDataToBoardDoc,
    fromDoc: m.boardDocToProjectData,
  }))
const canvasMappers = (): Promise<Mappers<CanvasFile>> =>
  import('./canvasDoc').then((m) => ({
    toDoc: m.canvasFileToDoc,
    fromDoc: m.docToCanvasFile,
  }))

/** Connect a Y.Doc for (source, scope) and bind the scope's pure mappers.
 *  `source` is a local project PATH (OWNER) or a collabProjectId (MEMBER, no
 *  local folder). Returns null when collab is disabled, the project isn't
 *  collab-shared, or the caller isn't a member — the caller then keeps its
 *  local-only path unchanged. */
function useCollabBinding<T>(
  source: CollabSource | null,
  scope: DocScope,
  loadMappers: () => Promise<Mappers<T>>,
): CollabBinding<T> | null {
  const { enabled } = useCollab()
  const [binding, setBinding] = useState<CollabBinding<T> | null>(null)

  // Stable string key for the effect dep — `source` is a fresh object each
  // render, so depending on it directly would reconnect on every render.
  const sourceKey = source
    ? 'path' in source
      ? `p:${source.path}`
      : `i:${source.collabProjectId}`
    : null

  useEffect(() => {
    if (!enabled || !source || !sourceKey) {
      setBinding(null)
      return
    }
    // StrictMode double-invokes effects and the body is async, so teardown must
    // be race-proof: `cancelled` short-circuits at every await; `teardown` is
    // assigned synchronously right after the connection opens (no await between,
    // so cleanup can't interleave there); and tearDownNow is idempotent so the
    // cleanup and the post-open cancel check can both call it safely.
    let cancelled = false
    let torn = false
    let teardown: (() => void) | null = null
    const tearDownNow = () => {
      if (torn) return
      torn = true
      teardown?.()
    }

    // ?path= (owner) or ?collabProjectId= (member) — same fragment the ticket
    // call uses (provider.sourceQuery), inlined here so this pre-flight check
    // runs WITHOUT statically importing the (lazy) provider module.
    const projectQuery =
      'path' in source
        ? `path=${encodeURIComponent(source.path)}`
        : `collabProjectId=${encodeURIComponent(source.collabProjectId)}`

    void (async () => {
      const info = (await fetch(`/api/collab/project?${projectQuery}`)
        .then((r) => (r.ok ? (r.json() as Promise<CollabProjectResponse>) : null))
        .catch(() => null)) as CollabProjectResponse | null
      if (cancelled || !info?.collabProjectId || !info.member) return

      // Lazy-load the heavy modules. Heavy imports stay INSIDE this
      // enabled+member branch so the OFF build never bundles them.
      const [Y, mappers, providerMod, ydoc] = await Promise.all([
        import('yjs'),
        loadMappers(),
        import('./provider'),
        import('./ydoc'),
      ])
      if (cancelled) return
      // Mint the FIRST ticket (partysocket refreshes it on every reconnect).
      const ticket = await providerMod.fetchCollabTicket(source, scope)
      if (cancelled || !ticket) return

      const localDoc = new Y.Doc()
      const remoteHandlers = new Set<() => void>()
      const onUpdate = (_u: Uint8Array, origin: unknown) => {
        // Local seeds carry ORIGIN_SEED; everything else is a peer update.
        if (origin !== ydoc.ORIGIN_SEED) remoteHandlers.forEach((h) => h())
      }
      localDoc.on('update', onUpdate)

      // partysocket re-runs this on every (re)connect, so the ~60s ticket is
      // refreshed automatically — no timer here.
      const getFreshToken = () =>
        providerMod.fetchCollabTicket(source, scope).then((r) => r?.token ?? null)
      const conn = await providerMod.connectCollabDoc(localDoc, ticket, getFreshToken)
      // Flip `synced` once the provider reports its first server sync. The
      // provider may expose a boolean and/or emit a 'synced'/'sync' event.
      const markSynced = () =>
        setBinding((b) => (b && b.doc === localDoc ? { ...b, synced: true } : b))
      conn.provider.on?.('synced', (v) => {
        if (v !== false) markSynced()
      })
      conn.provider.on?.('sync', (v) => {
        if (v !== false) markSynced()
      })
      if (conn.provider.synced) markSynced()

      // Presence (u15): the provider's awareness channel, if any.
      const aw = conn.provider.awareness ?? null

      teardown = () => {
        localDoc.off('update', onUpdate)
        remoteHandlers.clear()
        // Clear our awareness entry so peers see us leave promptly (before the
        // socket teardown would expire it).
        try {
          aw?.setLocalState(null)
        } catch {
          /* best-effort */
        }
        conn.destroy()
        localDoc.destroy()
      }
      if (cancelled) {
        tearDownNow()
        return
      }
      setBinding({
        doc: localDoc,
        synced: !!conn.provider.synced,
        seed: (value: T) => mappers.toDoc(localDoc, value),
        extract: (base: T) => mappers.fromDoc(localDoc, base),
        onRemote: (cb) => {
          remoteHandlers.add(cb)
          return () => remoteHandlers.delete(cb)
        },
        setPresence: (state) => {
          try {
            aw?.setLocalState(state)
          } catch {
            /* no awareness / torn down */
          }
        },
        onPresence: (cb) => {
          if (!aw) return () => {}
          const handler = () => cb(peersFromAwareness(aw))
          aw.on('change', handler)
          handler() // fire once with the current peer set
          return () => {
            try {
              aw.off('change', handler)
            } catch {
              /* already torn down */
            }
          }
        },
      })
    })()

    return () => {
      cancelled = true
      tearDownNow()
      setBinding(null)
    }
    // loadMappers is stable per call site; enabled/sourceKey/scope drive reconnects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, sourceKey, scope])

  return binding
}

/** Board scope binding — OWNER flow (local project path). */
export const useBoardCollab = (
  projectPath: string | null | undefined,
): CollabBinding<ProjectData> | null =>
  useCollabBinding<ProjectData>(
    projectPath ? { path: projectPath } : null,
    'board',
    boardMappers,
  )

/** Board scope binding — MEMBER flow (folder-less shared project). */
export const useBoardCollabShared = (
  collabProjectId: string | null | undefined,
): CollabBinding<ProjectData> | null =>
  useCollabBinding<ProjectData>(
    collabProjectId ? { collabProjectId } : null,
    'board',
    boardMappers,
  )

/** Canvas scope binding (one doc per canvas) — OWNER flow. Null until a
 *  canvasId is known. */
export const useCanvasCollab = (
  projectPath: string | null | undefined,
  canvasId: string | null | undefined,
): CollabBinding<CanvasFile> | null =>
  useCollabBinding<CanvasFile>(
    canvasId && projectPath ? { path: projectPath } : null,
    canvasId ? `canvas:${canvasId}` : 'canvas:none',
    canvasMappers,
  )

/** Canvas scope binding — MEMBER flow (folder-less shared project). */
export const useCanvasCollabShared = (
  collabProjectId: string | null | undefined,
  canvasId: string | null | undefined,
): CollabBinding<CanvasFile> | null =>
  useCollabBinding<CanvasFile>(
    canvasId && collabProjectId ? { collabProjectId } : null,
    canvasId ? `canvas:${canvasId}` : 'canvas:none',
    canvasMappers,
  )

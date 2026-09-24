// streamBudget — how many long-lived streams (SSE) the window holds right now.
//
// WHY: the app talks to its server over plain HTTP/1.1 on one origin
// (127.0.0.1:47776). Chromium — and Electron, which is Chromium — opens at most
// SIX connections per host for HTTP/1.1, and every open EventSource holds one
// for as long as it lives. At six, every later fetch (terminal input, the
// engine and question polls, Start/Stop) waits for a slot that never frees:
// the app looks frozen. Until the Swarm tab became a bar under every tab
// (2026-09-24) the Terminal tab's panes and the Swarm seats never shared a
// screen; now they do, so the window has to count.
//
// HOW: every component that opens an EventSource holds a slot here for as long
// as its stream is open, tagged by WHO opened it. The page (the open tab's
// body) always wins; the Swarm bar gets only what is left of STREAM_BUDGET and
// folds any seat it cannot afford into a summary (SwarmModule). One slot is
// always kept free so ordinary requests keep flowing.
//
// 【一次資料】 MDN "EventSource" — "When not used over HTTP/2, SSE suffers from
// a limitation to the maximum number of open connections … set to a very low
// number (6)" (developer.mozilla.org/en-US/docs/Web/API/EventSource, 2026-09).

import { createContext, useContext, useSyncExternalStore } from 'react'

/** Chromium's HTTP/1.1 per-host connection cap. */
export const HOST_CONNECTION_CAP = 6
/** Long-lived streams the window may hold at once — one below the cap, so a
 *  fetch always has a connection. */
export const STREAM_BUDGET = HOST_CONNECTION_CAP - 1

export type StreamOwner = 'page' | 'swarmBar'

const live = new Map<symbol, StreamOwner>()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

/** Hold one slot until the returned release is called (idempotent). */
export const holdStream = (owner: StreamOwner): (() => void) => {
  const key = Symbol(owner)
  live.set(key, owner)
  emit()
  return () => {
    if (live.delete(key)) emit()
  }
}

export const streamCount = (owner?: StreamOwner): number => {
  if (!owner) return live.size
  let n = 0
  live.forEach((o) => {
    if (o === owner) n++
  })
  return n
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** Live count, re-rendering the caller when it changes. */
export const useStreamCount = (owner?: StreamOwner): number =>
  useSyncExternalStore(subscribe, () => streamCount(owner))

/** Which side of the window a stream-opening component belongs to. The Swarm
 *  bar provides 'swarmBar'; everything else is the page. */
export const StreamOwnerContext = createContext<StreamOwner>('page')
export const useStreamOwner = (): StreamOwner => useContext(StreamOwnerContext)

// Client-side mirror of Settings.lockdownMode (work mode) — a tiny module
// store, NOT a context, because the consumers are leaf components far from
// App's settings state (Canvas mock/screen views, custom-tab hosts) and the
// value is a single boolean the whole window shares.
//
// App.tsx seeds it whenever settings load or save; srcdoc builders read it
// synchronously (isClientLockdown) and React views subscribe via
// useClientLockdown so an ON→OFF toggle re-renders live iframes immediately
// in both directions. Until the first settings fetch resolves the mirror is
// false — the same "absent ⇒ off" default the server resolves, so a
// pre-hydration render can only ever under-block for the first paint, and the
// Electron webRequest floor (electron/main.js) still covers that window.
import { useSyncExternalStore } from 'react'

let current = false
const listeners = new Set<() => void>()

export function setClientLockdown(next: boolean): void {
  const v = next === true
  if (v === current) return
  current = v
  listeners.forEach((l) => l())
}

export function isClientLockdown(): boolean {
  return current
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useClientLockdown(): boolean {
  return useSyncExternalStore(subscribe, isClientLockdown, isClientLockdown)
}

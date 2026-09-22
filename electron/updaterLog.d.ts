// Type declarations for the plain-CJS electron/updaterLog.js (same split as
// electron/autoUpdate.d.ts): Electron loads the .js; the vitest suite types
// against this.

export const UPDATER_LOG_MAX_BYTES: number
export function updaterHome(env?: NodeJS.ProcessEnv): string
export function updaterLogPath(env?: NodeJS.ProcessEnv): string
export function pendingInstallPath(env?: NodeJS.ProcessEnv): string
export function recoveryMarkerPath(env?: NodeJS.ProcessEnv): string
export function formatArgs(args: unknown[]): string
export function appendUpdaterLog(
  line: string,
  opts: { path: string; now?: number; maxBytes?: number },
): boolean

export interface UpdaterLogger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
}
export function makeUpdaterLogger(opts: {
  path: string
  tag: string
  mirror?: boolean
  now?: () => number
}): UpdaterLogger

export function tailUpdaterLog(path: string, lines?: number): string

export interface PendingInstall {
  from: string
  to: string
  at: string
}
export function writePendingInstall(opts: { path: string; from: string; to: string; now?: number }): boolean
export function readPendingInstall(path: string): PendingInstall | null
export function clearPendingInstall(path: string): void
export type PendingInstallVerdict = 'none' | 'installed' | 'failed' | 'stale'
export function decidePendingInstall(input: {
  pending: { from: string; to: string } | null
  currentVersion: string
}): PendingInstallVerdict
export function checkPendingInstall(opts: { path: string; currentVersion: string }): {
  kind: PendingInstallVerdict
  from?: string
  to?: string
  at?: string
}

// Type declarations for the plain-CJS electron/shipIt.js (same split as
// electron/updaterLog.d.ts).

export const SHIPIT_LABEL_SUFFIX: string
export function shipItLabel(appId: string): string
export function launchdDomain(uid: number): string
export type DisabledFlag = 'disabled' | 'enabled' | 'unknown'
export function parseDisabledFlag(output: string, label: string): DisabledFlag
export interface ServicePrint {
  state: string
  runs: number | null
  lastExitCode: string | null
  pid: number | null
}
export function parseServicePrint(output: string): ServicePrint | null
export function parseShipItRequest(raw: string): { bundlePath: string; relaunchesAfterInstall: boolean } | null
export function decideInstallPreflight(input: {
  disabledBefore: DisabledFlag
  disabledAfterEnable?: DisabledFlag
}): 'proceed' | 'block'
export function decideBootRecovery(input: {
  verdict: { kind: string; from?: string; to?: string }
  lastRecovery: { from: string; to: string } | null
  stagedVersion: string | null
}): boolean
export function decideArmedRecoveryAtQuit(input: {
  runningVersion: string
  installedVersion: string | null
}): boolean
export function decideUnarmedStagedRelaunch(input: {
  stagedVersion: string | null
  runningVersion: string | null
}): boolean
export function versionFromPlistJson(json: string): string | null
export function describeShipItState(s: { label: string; disabled: string; service: ServicePrint | null }): string
export function ensureRelaunchAfterInstall(io: {
  read: () => string
  write: (text: string) => void
}): 'set' | 'already-set' | 'unusable' | 'write-failed'
export function shipItRequestIO(
  statePath: string,
  fsImpl?: {
    readFileSync: (p: string, enc: string) => string
    writeFileSync: (p: string, text: string) => void
    renameSync: (from: string, to: string) => void
    unlinkSync: (p: string) => void
  },
): { read: () => string; write: (text: string) => void }

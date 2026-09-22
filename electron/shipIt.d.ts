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
export function decideInstallPreflight(input: {
  disabledBefore: DisabledFlag
  disabledAfterEnable?: DisabledFlag
}): 'proceed' | 'block'
export function describeShipItState(s: { label: string; disabled: string; service: ServicePrint | null }): string

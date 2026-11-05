/** The packaged entry registers its normal resume policy. Review/retry can
 * release a held boot without pretending that another server boot happened. */
let resume: (() => Promise<void>) | undefined
let inFlight: Promise<void> | undefined
export const registerRuntimeRecoveryResume = (callback: () => Promise<void>): void => { resume = callback }
export const notifyRuntimeRecoveryChanged = (): Promise<void> => {
  if (!resume) return Promise.resolve()
  if (!inFlight) inFlight = resume().finally(() => { inFlight = undefined })
  return inFlight
}

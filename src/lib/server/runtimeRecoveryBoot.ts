/** The packaged entry registers its normal resume policy. Review/retry can
 * release a held boot without pretending that another server boot happened. */
let resume: (() => Promise<void>) | undefined
let inFlight: Promise<void> | undefined
let again = false
export const registerRuntimeRecoveryResume = (callback: () => Promise<void>): void => { resume = callback }
/** A change that lands while a run is in flight runs it once more afterwards
 *  (2026-11-17 review): the first run is the whole boot resume, minutes long, and
 *  an owner review made during it must still reach the held project — the 15 s
 *  timer no longer retries holds only that review clears. */
export const notifyRuntimeRecoveryChanged = (): Promise<void> => {
  const callback = resume
  if (!callback) return Promise.resolve()
  if (inFlight) { again = true; return inFlight }
  inFlight = (async () => {
    try { do { again = false; await callback() } while (again) }
    finally { inFlight = undefined }
  })()
  return inFlight
}

// The boot resume's entry, run by server/index.ts through
// registerRuntimeRecoveryResume once the runtime journal is readable, and again
// whenever runtime recovery changes (an owner review in 会話の復旧, a settled AI
// connection switch).
//
// ⚠ NO GLOBAL SAFETY ASSERT BEFORE resumeEngines (2026-11-17, the measured root
// cause). The saved-work checks (unconfirmed tool results, unsettled president
// instructions, unfinished conversations) used to run here as asserts. One stale
// receipt in any project — a commander's Bash cut off by the 2026-11-09 update —
// threw on every later boot, so resumeEngines never ran again: no president /
// commander / autopilot came back anywhere and the policy loop never started.
// They now run per project and per actor inside resumeEngines
// (savedSwarmRuntimeHold), which records the reason and retries. Pinned by
// bootResumeHook.test.ts. Lives here rather than inline in server/index.ts so
// that test can run it: importing the entry would bind the app's port.
import { resumeEngines, retryBootResumes, startAutoDrainLoop, bootAutoDrainEnabled } from './swarmOrchestrator'
import { startAutomationPolicyLoop } from './automationPolicy'
import { runtimeAdmissionBlocked } from './runtimeTransitionStore'
import { createSwarmFatalNotification } from './swarmNotifications'

let resumed = false
let journalHoldReported = false

export const bootResumeOnRecoveryChange = async (journalReady: Promise<boolean>): Promise<void> => {
  // After the first run: retry whatever is still held, including holds only the
  // owner's review clears. Not awaited — the AI-switch settle that notifies here
  // must not wait out a full retry pass (adoptions can take minutes).
  if (resumed) { void retryBootResumes({ ownerReview: true }).catch(() => {}); return }
  if (!await journalReady) {
    if (!journalHoldReported) {
      journalHoldReported = true
      await createSwarmFatalNotification({
        event: 'engine-resume-suppressed',
        detail: 'AI の作業記録を読み込めなかったため、再起動後の社長・司令官・自動運転の復帰を止めています。アプリを開き直すか、手動で立ち上げてください。',
      }).catch(() => {})
    }
    return
  }
  // An AI connection switch is mid-flight; its settle re-notifies (runtimeTransitions.ts).
  if (runtimeAdmissionBlocked('swarm')) return
  await resumeEngines()
  resumed = true
  startAutomationPolicyLoop()
  if (bootAutoDrainEnabled()) startAutoDrainLoop()
}

export const __resetBootResumeHookForTests = (): void => { resumed = false; journalHoldReported = false }

// sdkDeskLimit — "your own conversation stopped, and nobody was going to tell
// you", for an SDK desk.
//
// ownerDeskLimit.ts answers this for PTY desks, and it is elaborate for a
// reason: a PTY says nothing except by painting, so the watch has to SAMPLE the
// screen on a timer, wait out a quiet window so a desk that merely PRINTED the
// limit wording (reviewing this very file!) is not mistaken for one stopped by
// it, hold a confirm window, and re-arm on three clean reads. Every one of those
// gates exists to compensate for reading a picture instead of being told.
//
// An SDK desk is TOLD. The CLI emits its refusal as a message the SDK hands over
// verbatim, and sdkEvents distills it into a `quota_refusal` event on the
// session's own stream — no timer, no sampling, no false-positive class, and no
// possibility of confusing "the desk is displaying this text" with "the desk
// stopped because of this text". So this module is a LISTENER, not a loop.
//
// WHAT IT SHARES WITH THE PTY WATCH, on purpose:
//   • the WORDING/classification (swarmRateLimitText.classifyQuotaRefusal) — one
//     question with one right answer, never forked per runtime;
//   • the MESSAGE (ownerDeskLimit.buildOwnerDeskLimitNotification) — the owner
//     must read the same sentence whichever runtime their desk happened to use.
//
// WHAT IT DOES NOT DO, also on purpose: it never touches the desk. No retry, no
// model switch, no kill. Identical to the PTY watch's scope — notice, and say so
// once, in words a non-programmer can act on.

import { attachSdkListener, type SdkStreamFrame } from './sdkSession'
import { quotaRefusalKindOfText } from './swarmRateLimitText'
import {
  buildOwnerDeskLimitNotification,
  resolveDeskProject,
  type StoppedDesk,
} from './ownerDeskLimit'
import { createSwarmInfoNotification } from './swarmNotifications'
import type { SwarmInfoNotification } from '../types'

export interface SdkDeskLimitDeps {
  attach?: typeof attachSdkListener
  notify?: (n: SwarmInfoNotification) => Promise<unknown>
  project?: (cwd: string) => Promise<{ label: string; path: string } | null>
  classify?: typeof quotaRefusalKindOfText
}

/** Watch ONE SDK owner desk for a model-limit stop and tell the owner once.
 *
 *  Returns a detach function; calling it stops the watch (the session ending
 *  also ends it, since the pool drops the listener with the entry).
 *  Returns null when the session could not be subscribed to at all.
 *
 *  ONCE per session, deliberately: the same refusal can arrive again on a later
 *  turn (the owner types, the limit is still spent), and a bell per attempt is
 *  how a helpful notice becomes noise. The PTY watch re-arms after three clean
 *  reads because it cannot tell repeats apart; here the session IS the unit of
 *  the stop, so when the owner wants a fresh notice they open a fresh desk. */
export const watchSdkDeskForLimit = (opts: {
  sdkSessionId: string
  /** The desk's cwd — used to name its project in the message. */
  cwd: string
  /** Its role name ("司令官"), so the owner knows WHICH conversation stopped. */
  deskLabel: string | null
  deps?: SdkDeskLimitDeps
}): (() => void) | null => {
  const attach = opts.deps?.attach ?? attachSdkListener
  const notify = opts.deps?.notify ?? ((n: SwarmInfoNotification) => createSwarmInfoNotification(n))
  const project = opts.deps?.project ?? resolveDeskProject
  const classify = opts.deps?.classify ?? quotaRefusalKindOfText

  let told = false
  const onFrame = (f: SdkStreamFrame): void => {
    if (told) return
    // sdkEvents already decided this IS a refusal, using the SDK's own exported
    // prefix list — so unlike the screen watch there is no "is it really?" gate
    // to pass here. All that is left is which kind of stop, which selects the
    // advice the owner is given.
    if (f.ev.kind !== 'quota_refusal') return
    const kind = classify(f.ev.raw)
    told = true
    void (async () => {
      try {
        const stopped: StoppedDesk = {
          project: await project(opts.cwd).catch(() => null),
          desk: opts.deskLabel,
          kind,
        }
        await notify(buildOwnerDeskLimitNotification([stopped]))
      } catch {
        // A failed bell must never take down the session's event pump. The desk
        // keeps running; the owner just was not told, which is the state this
        // module exists to improve, not a state it may crash over.
      }
    })()
  }

  // fromSeq 0: replay whatever the buffer already holds, so a refusal that
  // arrived in the milliseconds between spawn and this call is not missed.
  const sub = attach(opts.sdkSessionId, 0, onFrame)
  if (!sub) return null
  sub.replay.forEach(onFrame)
  return sub.detach
}

// Canvas AI "did the server restart under me?" detector.
//
// A Canvas AI run (generate / tweak) is tracked by a server-side job kept in an
// in-memory Map on `globalThis` (src/lib/server/canvasAi.ts). That Map survives
// a dev `tsx watch` HMR reload, but a FULL process swap — Electron prod restart,
// or a real kill+respawn of the dev server — wipes it. When that happens mid-run
// the polling client gets a 404 for its job. A 404 is ALSO how a normal,
// completed-and-swept job eventually disappears (after JOB_RETAIN_MS), and in
// that case the result was already applied/persisted, so finishing silently is
// correct. These two cases look identical from a single 404, so the client used
// to treat every 404 as "swept" and quietly drop back to idle — meaning a
// restart that lost an in-flight generation looked like it had silently vanished.
//
// We tell them apart by fingerprinting the server PROCESS and noticing when it
// changes across a 404.

import { HealthSchema } from '@/lib/healthSchema'

/** Fingerprint of the running server process: its launcher boot id (present only
 *  when the app was started by the launcher / Electron) combined with the boot
 *  timestamp `/api/health` freezes at module load. `startedAt` is ALWAYS present
 *  and changes on every fresh process, so this distinguishes a real restart even
 *  for a hand-launched dev server where `bootId` is null. Returns null when the
 *  server is unreachable or answers a body that isn't ours — callers treat a null
 *  read as "can't prove anything" rather than risk a false alarm.
 *
 *  Note: an in-place HMR reload keeps the job registry alive (it lives on
 *  globalThis), so a job 404 never coincides with an HMR reload — only with a
 *  real process swap, which is exactly when this signature changes. */
export async function readBootSignature(): Promise<string | null> {
  try {
    const res = await fetch('/api/health')
    if (!res.ok) return null
    const parsed = HealthSchema.safeParse(await res.json())
    if (!parsed.success) return null
    const { bootId, startedAt } = parsed.data
    return `${bootId ?? ''}|${startedAt}`
  } catch {
    // Offline / mid-restart (old process gone, new one not up yet) — unknown.
    return null
  }
}

/** Decide whether a Canvas AI job that just 404'd was LOST to a full server
 *  restart (true) versus legitimately swept after it completed (false).
 *
 *  Proof of a restart is two CONCRETE, DIFFERENT boot signatures: `baseline`,
 *  captured while the job was known to be live, and `current`, read right after
 *  the 404. When either side is null — the server was momentarily unreachable, or
 *  the baseline wasn't captured before the first poll — we cannot prove a restart,
 *  so we report `false` and let the caller finish silently. That bias matters: a
 *  spurious "interrupted" banner on a job that actually completed is worse than
 *  occasionally missing the (already rare) restart edge. */
export function jobLostToRestart(
  baseline: string | null,
  current: string | null,
): boolean {
  return baseline !== null && current !== null && baseline !== current
}

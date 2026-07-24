// swarmTranscriptProof — card 4 (docs/ENGINE_PERSISTENCE_PLAN.md §5): the ONE
// shared "can `claude --resume <id>` actually load this session?" probe, extracted
// from swarmSessions.ts so the worker-conversation resume and the role-desk
// (supply/manager) resume PROVE loadability the same way instead of maintaining
// two copies of the transcript check (plan §5: "swarmSessions.ts から共有ヘルパへ
// 抽出・二重実装しない").
//
// claude keeps its own transcript at
// `~/.claude/projects/<cwd-hyphenated>/<sessionId>.jsonl` (transcript.sessionJsonlPath).
// `claude --resume <id>` on a session claude cannot load exits with an error — the
// desk/worker would never come up — so both callers PROVE the transcript is
// real (exists, non-empty, ≥1 parseable JSON event in its head) before asking for
// a resume; anything else is a `false`, and the caller mints / falls back instead
// of gambling the launch. Everything here is FAIL-OPEN: a missing / unreadable /
// truncated transcript resolves to "not loadable", never a throw.
//
// ORPHAN WINDOW (worker path only, plan §5) — if the server was SIGKILLed, a PTY's
// child `claude` can survive as an ORPHAN and keep appending to the SAME JSONL. Two
// processes appending to one transcript interleave-corrupt it (the exact hazard the
// role-desk `live` check guards, but at boot the PTY pool is empty so that check
// can't help). So the worker path additionally refuses a transcript whose mtime is
// within `orphanWindowMs` of now — "someone may still be writing" — and falls back
// to crash reclaim. The role-desk path leaves the window OFF (it uses the live-PTY
// check instead) by simply not passing `orphanWindowMs`.

import { open, stat } from 'fs/promises'
import { sessionJsonlPath } from './transcript'

// Only the HEAD of the transcript is read: a long session is a multi-MB JSONL and
// this runs on every desk/worker (re)launch. One parseable event in the first chunk
// is all the evidence we need that claude wrote a real session here.
const PROBE_BYTES = 64 * 1024

/** The orphan window (plan §5). A transcript touched within this many ms of `now`
 *  is presumed to still be held by a live (SIGKILL-orphaned) `claude`, so the boot
 *  must NOT `--resume` it. Sized to align "fall back" with "an orphan is likely":
 *  a FAST crash-respawn (Electron's 2s backoff — the case where a SIGKILLed child
 *  most plausibly survived) leaves the transcript's last write only a few seconds
 *  old, so this window catches it; a SLOW restart (a clean quit + reopen, or a
 *  self-update cutover — "再起動はたいていリリース", where no orphan exists because
 *  the PTYs were killed cleanly) has a much larger gap, so a genuinely-dead session
 *  reads as stale and resumes. It is a single-snapshot heuristic, not a proof of
 *  exclusivity — but every misfire is a fallback to crash reclaim, i.e. "worst case
 *  = same as today" (plan §5). Injectable so the fixtures drive both sides. */
export const ORPHAN_MTIME_WINDOW_MS = 10_000

/** Why a transcript is / isn't loadable — diagnostics for the caller's log.
 *   - `ok`          — exists, non-empty, ≥1 parseable event, (and not orphan-fresh).
 *   - `missing`     — no file / unreadable (pruned, fresh machine, ~/.claude wiped).
 *   - `empty`       — the file exists but is zero-length.
 *   - `unparseable` — non-empty but no parseable JSON line in the probed head.
 *   - `fresh`       — touched within the orphan window ⇒ presumed still-being-written. */
export type TranscriptProofReason = 'ok' | 'missing' | 'empty' | 'unparseable' | 'fresh'

export interface TranscriptProof {
  /** true ⇒ hand claude `--resume <sessionId>`; false ⇒ fall back (fresh id / reclaim). */
  loadable: boolean
  reason: TranscriptProofReason
  /** epoch ms of the transcript's last modification, when the file existed. */
  mtimeMs?: number
}

/** Can `claude --resume <sessionId>` load this session from `cwd`? See the module
 *  header. `orphanWindowMs` (opt-in) enables the SIGKILL-orphan mtime guard — the
 *  worker path passes it; the role-desk path omits it. `now` is injected (default
 *  Date.now()) so the fixtures drive the orphan branch deterministically. Never
 *  throws — every fault degrades to `{loadable:false}`. */
export const proveTranscriptLoadable = async (
  cwd: string,
  sessionId: string,
  opts: { now?: number; orphanWindowMs?: number } = {},
): Promise<TranscriptProof> => {
  const path = sessionJsonlPath(cwd, sessionId)
  let fh: Awaited<ReturnType<typeof open>> | undefined
  try {
    const st = await stat(path)
    if (!st.isFile()) return { loadable: false, reason: 'missing' }
    const mtimeMs = st.mtimeMs
    if (st.size === 0) return { loadable: false, reason: 'empty', mtimeMs }
    // Orphan window FIRST (before the read): a still-being-written transcript must
    // not be resumed no matter how parseable its head is.
    if (opts.orphanWindowMs !== undefined) {
      const now = opts.now ?? Date.now()
      if (now - mtimeMs < opts.orphanWindowMs) return { loadable: false, reason: 'fresh', mtimeMs }
    }
    fh = await open(path, 'r')
    const buf = Buffer.alloc(Math.min(PROBE_BYTES, st.size))
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    const lines = buf.subarray(0, bytesRead).toString('utf8').split('\n')
    // We stopped short of EOF ⇒ the last line is very likely cut mid-JSON. Drop it
    // so a truncated read can't be mistaken for a corrupt transcript (and, on a
    // file we DID read whole, keep it — a final line may have no trailing newline).
    if (bytesRead < st.size) lines.pop()
    const parseable = lines.some((line) => {
      const t = line.trim()
      if (!t) return false
      try {
        const ev: unknown = JSON.parse(t)
        return !!ev && typeof ev === 'object'
      } catch {
        return false
      }
    })
    return parseable ? { loadable: true, reason: 'ok', mtimeMs } : { loadable: false, reason: 'unparseable', mtimeMs }
  } catch {
    return { loadable: false, reason: 'missing' } // missing / unreadable — fail-open
  } finally {
    await fh?.close().catch(() => {})
  }
}

/** Boolean convenience for the role-desk path (swarmSessions.isSessionResumable):
 *  the plain "is it loadable?" gate with NO orphan window (that path uses the
 *  live-PTY check for the still-open hazard instead). */
export const isTranscriptLoadable = async (cwd: string, sessionId: string): Promise<boolean> =>
  (await proveTranscriptLoadable(cwd, sessionId)).loadable

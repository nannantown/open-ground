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
// can't help). So the worker path adds two signals before it will resume:
//   1. PROCESS (primary): one `ps` — a live process whose command line carries the
//      session id (`claude --session-id|--resume <id>`) holds it ⇒ refuse. This is
//      what catches an orphan sitting in a long tool call (npm test, a sub-agent)
//      that writes nothing for minutes. `ps` failing (incl. Windows, which has no
//      `ps`) ⇒ refuse too: fail-safe to crash reclaim, never resume blind.
//   2. MTIME (secondary): a transcript touched within `orphanWindowMs` is re-measured
//      once the window has passed; moved ⇒ someone is writing ⇒ refuse.
// Time-closeness alone no longer refuses: the hands-free update restarts ~10s after
// stopping the workers, so every dead session used to read as "fresh" (2026-09-24). The role-desk path leaves the window OFF (it uses the live-PTY
// check instead) by simply not passing `orphanWindowMs`.

import { open, readdir, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname } from 'path'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { sessionJsonlPath } from './transcript'

const execFile = promisify(execFileCb)

// Only the HEAD of the transcript is read: a long session is a multi-MB JSONL and
// this runs on every desk/worker (re)launch. One parseable event in the first chunk
// is all the evidence we need that claude wrote a real session here.
const PROBE_BYTES = 64 * 1024

/** The orphan window (plan §5) — the SECONDARY signal (the process check is the
 *  primary). A transcript touched within this many ms of the proof is re-measured
 *  once the window has elapsed since its last write: moved ⇒ still being written ⇒
 *  do NOT `--resume`; unmoved ⇒ resume (if no process holds the id). The old
 *  single snapshot assumed a self-update cutover leaves a gap longer than the
 *  window — false since 0.11.132 restarts without waiting (measured 9.7s,
 *  2026-09-24). The wait is capped at one window (a future mtime — clock rewind,
 *  restored ~/.claude — must not buy an unbounded sleep), and candidates are proven
 *  one after another, so after the first wait the rest are already past it. */
export const ORPHAN_MTIME_WINDOW_MS = 10_000

/** Why a transcript is / isn't loadable — diagnostics for the caller's log.
 *   - `ok`          — exists, non-empty, ≥1 parseable event, (and not orphan-fresh).
 *   - `missing`     — no file / unreadable (pruned, fresh machine, ~/.claude wiped).
 *   - `empty`       — the file exists but is zero-length.
 *   - `unparseable` — non-empty but no parseable JSON line in the probed head.
 *   - `fresh`       — still changing across the orphan window ⇒ presumed still-being-written.
 *   - `live`        — a running process holds the session id (or `ps` could not tell). */
export type TranscriptProofReason = 'ok' | 'missing' | 'empty' | 'unparseable' | 'fresh' | 'live'

/** Does a running process carry `sessionId` on its command line? `null` = could not
 *  tell (ps failed / Windows) — the caller treats that as "held". One `ps` call. */
export const isSessionHeldByProcess = async (sessionId: string): Promise<boolean | null> => {
  const out = await readProcessCommandLines()
  return out === null || out === 'unavailable' ? null : out.includes(sessionId)
}

/** One `ps` snapshot of every running command line. `'unavailable'` = this machine
 *  has no `ps` at all (win32, or ENOENT) — a permanent condition, unlike `null` =
 *  this one call failed (timeout, buffer, signal). `/bin/ps` is preferred so a
 *  stripped or shadowed PATH cannot swap the binary. */
export const readProcessCommandLines = async (
  platform: NodeJS.Platform = process.platform,
): Promise<string | null | 'unavailable'> => {
  if (platform === 'win32') return 'unavailable'
  try {
    const { stdout } = await execFile(existsSync('/bin/ps') ? '/bin/ps' : 'ps', ['-axww', '-o', 'command='], {
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
    })
    return stdout
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'unavailable' : null
  }
}

export interface TranscriptProof {
  /** true ⇒ hand claude `--resume <sessionId>`; false ⇒ fall back (fresh id / reclaim). */
  loadable: boolean
  reason: TranscriptProofReason
  /** epoch ms of the transcript's last modification, when the file existed. */
  mtimeMs?: number
}

/** Can `claude --resume <sessionId>` load this session from `cwd`? See the module
 *  header. `orphanWindowMs` (opt-in) enables the SIGKILL-orphan mtime guard — the
 *  worker path passes it; the role-desk path omits it. Time is read at PROOF time
 *  (Date.now()), never a caller's earlier snapshot. `sleep` / `isSessionHeld` are
 *  injectable so the fixtures can simulate an orphan (writing, or quiet). Never throws — every
 *  fault degrades to `{loadable:false}`. */
export const proveTranscriptLoadable = async (
  cwd: string,
  sessionId: string,
  opts: {
    orphanWindowMs?: number
    sleep?: (ms: number) => Promise<void>
    isSessionHeld?: (sessionId: string) => Promise<boolean | null>
  } = {},
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
      const held = await (opts.isSessionHeld ?? isSessionHeldByProcess)(sessionId)
      if (held !== false) return { loadable: false, reason: 'live', mtimeMs }
      const wait = Math.min(mtimeMs + opts.orphanWindowMs - Date.now(), opts.orphanWindowMs)
      if (wait > 0) {
        await (opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(wait)
        const again = await stat(path)
        if (again.mtimeMs !== mtimeMs || again.size !== st.size) {
          return { loadable: false, reason: 'fresh', mtimeMs: again.mtimeMs }
        }
      }
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

/** Is ANY claude session ever recorded for `cwd` still held by a running process?
 *  The session ids are the transcript stems in claude's per-cwd project dir — so this
 *  finds an orphaned worker (a server SIGKILL leaves its `claude` alive) even when no
 *  roster row or in-process session remembers its id. `true` = held; `false` = no
 *  transcript dir (nothing ever ran there) or no id is held; `null` = could not tell
 *  THIS time (ps call failed, dir unreadable); `'unavailable'` = this machine cannot
 *  run the check at all (no `ps` — Windows). All ids are matched against ONE ps
 *  snapshot. `readCommands` is injectable (tests / platform). */
export const isWorktreeHeldByProcess = async (
  cwd: string,
  readCommands: () => Promise<string | null | 'unavailable'> = () => readProcessCommandLines(),
): Promise<boolean | null | 'unavailable'> => {
  let names: string[]
  try {
    names = await readdir(dirname(sessionJsonlPath(cwd, 'x')))
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? false : null
  }
  const ids = names.filter((n) => n.endsWith('.jsonl')).map((n) => n.slice(0, -'.jsonl'.length))
  if (!ids.length) return false
  const out = await readCommands()
  return out === null || out === 'unavailable' ? out : ids.some((id) => out.includes(id))
}

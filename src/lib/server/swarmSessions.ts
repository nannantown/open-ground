// swarmSessions — the RESUME seam for the swarm's two long-lived, human-facing
// desks: the supply officer (補給官, swarmSupply.ts) and the commander (司令官,
// swarmManager.ts).
//
// THE PROBLEM. Both desks are CONVERSATIONS the owner talks to across days. But
// each spawn minted a throw-away `crypto.randomUUID()` and handed it to claude as
// `--session-id`, so every OPEN GROUND restart (every release, every crash) began
// a brand-new claude session: the desk woke up with total amnesia. Workers are
// disposable — one goal, one worktree, one session — and SHOULD forget. These two
// are the opposite: their whole value is accumulated context.
//
// THE FIX. Persist ONE session id per (project, role) and hand it back to claude as
// `--resume` next time. claude's `--resume <id>` REUSES the original session id by
// default (`--fork-session` is the opt-in to NOT — see `claude --help`), so the same
// uuid keeps addressing the same, growing conversation forever: persist once, resume
// for life. claudeTerminal.ts already had the `--resume` vs `--session-id` branch
// (buildClaudeArgv); it was simply never wired — this module is the missing caller.
//
// WHERE. `~/.openground/projects/<uuid>/swarm-sessions.json` — the project's CENTRAL
// data dir (CLAUDE.md: per-project data lives centrally, NEVER in the user's repo).
// Deliberately its OWN file, not tasks.json: session ids are PERSONAL, machine-local
// state (they name transcripts under this user's ~/.claude), and tasks.json MOVES
// INTO the repo in git-shared mode — pushing a teammate a pointer to a claude session
// they cannot open would be noise at best.
//
// FAIL-OPEN IS THE WHOLE CONTRACT (goal condition 4). A persisted id is a HINT, never
// a requirement: `claude --resume <id>` on a session claude cannot find exits with an
// error, which would leave the owner staring at a dead PTY where their commander used
// to be. So resolveSwarmSession() only says `resume` when it has PROVEN claude can
// load the session (its own JSONL is on disk under this cwd, non-empty, parseable) and
// no live PTY is already appending to it. Every other outcome — no record, corrupt
// record, project moved, transcript pruned, transcript truncated, session still open,
// unreadable store — degrades to a fresh session id, exactly the pre-2026-07-12
// behaviour. The desk ALWAYS launches.

import { randomUUID } from 'crypto'
import { mkdir, open, stat, readFile } from 'fs/promises'
import { dirname } from 'path'
import { atomicWriteJson } from './atomicWrite'
import { claudeDirName } from './claudeProjectDir'
import { projectDataFile } from './projectDataPath'
import { sessionJsonlPath } from './transcript'
import { isClaudeSessionLive } from './terminal'

/** The per-project central file holding the desks' session ids. */
export const SWARM_SESSIONS_FILE = 'swarm-sessions.json'

/** The two desks whose conversation is worth keeping across restarts. Workers are
 *  deliberately absent: a worker is one goal / one throw-away session. */
export const SWARM_SESSION_ROLES = ['supply', 'manager'] as const
export type SwarmSessionRole = (typeof SWARM_SESSION_ROLES)[number]

export interface SwarmRoleSession {
  /** The uuid claude knows this conversation by (`--session-id` when it was born,
   *  `--resume` on every launch after). */
  sessionId: string
  /** The cwd the session was launched in. claude files its transcript under a dir
   *  derived from the cwd (~/.claude/projects/<hyphenated-cwd>/), so a session is
   *  only addressable from the SAME cwd — a relocated project must not try to
   *  resume a transcript that lives under the old path's dir name. */
  cwd: string
  updatedAt: string
}

export type SwarmSessionsFile = Partial<Record<SwarmSessionRole, SwarmRoleSession>>

/** Why a persisted id was NOT resumed. Diagnostics only (logged + asserted in
 *  tests) — every value means the same thing to the caller: mint a fresh session.
 *   - `none`    — nothing persisted yet (first launch on this project/role).
 *   - `moved`   — the project's cwd changed, so claude's transcript for this id
 *                 lives under a different project dir and `--resume` can't see it.
 *   - `live`    — a PTY is STILL driving this session; two claude processes
 *                 appending to one transcript would interleave-corrupt it.
 *   - `missing` — claude has no loadable transcript for the id (never written,
 *                 pruned, emptied, or truncated to garbage).
 *   - `store`   — the persistence layer itself failed (unregistered path, unreadable
 *                 dir). A bug or a torn install — never a reason to block the launch. */
export type FreshSessionReason = 'none' | 'moved' | 'live' | 'missing' | 'store'

export interface ResolvedSwarmSession {
  agentSessionId: string
  /** true ⇒ hand claude `--resume <agentSessionId>`; false ⇒ `--session-id`. */
  resume: boolean
  /** Set only when `resume` is false — why we fell back to a fresh session. */
  reason?: FreshSessionReason
}

// ── the store ───────────────────────────────────────────────────────────────

// Accept only a record we could actually act on. Anything hand-edited into a
// wrong shape is DROPPED (→ fresh session) rather than fed to `claude --resume`.
const asRoleSession = (v: unknown): SwarmRoleSession | null => {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (typeof o.sessionId !== 'string' || !o.sessionId.trim()) return null
  if (typeof o.cwd !== 'string' || !o.cwd.trim()) return null
  return {
    sessionId: o.sessionId,
    cwd: o.cwd,
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : '',
  }
}

/** Parse the raw file contents into a store. Pure + exported so the tolerance
 *  rules (junk → dropped, never thrown) are unit-tested without touching disk. */
export const parseSwarmSessions = (parsed: unknown): SwarmSessionsFile => {
  if (!parsed || typeof parsed !== 'object') return {}
  const src = parsed as Record<string, unknown>
  const out: SwarmSessionsFile = {}
  for (const role of SWARM_SESSION_ROLES) {
    const rec = asRoleSession(src[role])
    if (rec) out[role] = rec
  }
  return out
}

/** Read the project's persisted desk sessions. NEVER throws for a missing or
 *  corrupt file — an empty store just means "every desk starts fresh". (An
 *  UNREGISTERED project path still throws, from projectDataFile: that is a real
 *  bug, and the spawn path catches it into a fresh session anyway.) */
export const readSwarmSessions = async (projectPath: string): Promise<SwarmSessionsFile> => {
  const file = await projectDataFile(projectPath, SWARM_SESSIONS_FILE)
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return {} // never written yet — the normal first-launch path
  }
  try {
    return parseSwarmSessions(JSON.parse(raw))
  } catch {
    // eslint-disable-next-line no-console
    console.warn(`[swarmSessions] ${SWARM_SESSIONS_FILE} is not valid JSON at ${projectPath}`)
    return {}
  }
}

// supply + manager share ONE file, so a read-modify-write from each (the owner
// starting both desks at once) could lose a role: both read {}, both write their
// own key, last write wins. Serialise the RMW per file path — a promise chain is
// enough in this single-process server, and it keeps the store a plain JSON object
// instead of dragging in a lock file.
const writeChain = new Map<string, Promise<unknown>>()
const serialise = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
  const prev = writeChain.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn) // a failed predecessor must not stall the queue
  writeChain.set(
    key,
    next.catch(() => {}),
  )
  return next
}

/** Persist `role`'s session id for this project (upsert; the other role is left
 *  untouched). Called on EVERY launch — a resumed session re-stamps `updatedAt`,
 *  a fresh one records the new id so the NEXT boot can resume it. */
export const recordSwarmSession = async (
  projectPath: string,
  role: SwarmSessionRole,
  sessionId: string,
  now: Date = new Date(),
): Promise<void> => {
  const file = await projectDataFile(projectPath, SWARM_SESSIONS_FILE)
  return serialise(file, async () => {
    const current = await readSwarmSessions(projectPath)
    const next: SwarmSessionsFile = {
      ...current,
      [role]: { sessionId, cwd: projectPath, updatedAt: now.toISOString() },
    }
    await mkdir(dirname(file), { recursive: true })
    await atomicWriteJson(file, next)
  })
}

/** Drop `role`'s record — but ONLY if it still names `sessionId`. The
 *  compare-and-delete matters more than the delete: by the time a caller learns
 *  its session was worthless, a LATER launch may already have recorded a good
 *  one over it, and clearing that would strand a healthy desk.
 *
 *  The one caller is the dead-on-arrival watch (swarmManager.watchDeskForDeathOnArrival),
 *  and ONLY for a FRESH desk that died quoting a quota refusal: its transcript
 *  contains nothing but that refusal, and leaving the record pointing at it would
 *  make the NEXT commander `--resume` a one-line conversation about being out of
 *  quota. Forgetting it is the honest state — the next launch opens a fresh desk.
 *  (A RESUMED desk's transcript is real history plus one refusal line and must
 *  never be forgotten this way — the caller enforces that distinction, not this
 *  function.)
 *
 *  Shares recordSwarmSession's per-file serialisation, so the read-modify-write
 *  cannot interleave with a concurrent record for the sibling role. Never
 *  throws: losing this cleanup costs a stale pointer, never a launch.
 *
 *  ORDERING NOTE: the caller arms its exit-watch BEFORE recordSwarmSession's
 *  write lands (measured DOA deaths take 1.4–3.8s; the write is milliseconds),
 *  so in theory a desk could die and fire this forget before the record naming
 *  it even exists — the compare-and-delete would then no-op, and the SUBSEQUENT
 *  record write persists the now-dead session id, leaving the same stale pointer
 *  this function exists to clear. Not observed in practice (the ordering above),
 *  and a regression here only reverts to pre-2026-07-22 behaviour, not a new
 *  failure mode — not worth a lock over, but worth knowing if this ever needs
 *  tightening. */
export const forgetSwarmSessionIf = async (
  projectPath: string,
  role: SwarmSessionRole,
  sessionId: string,
): Promise<boolean> => {
  try {
    // No mkdir before the read-modify-write (unlike recordSwarmSession): a delete
    // only ever matters when the file — and thus its directory — already exists;
    // an absent store has nothing to forget and readSwarmSessions handles that
    // by returning {}.
    const file = await projectDataFile(projectPath, SWARM_SESSIONS_FILE)
    return await serialise(file, async () => {
      const current = await readSwarmSessions(projectPath)
      if (current[role]?.sessionId !== sessionId) return false // superseded — leave it alone
      const next = { ...current }
      delete next[role]
      await atomicWriteJson(file, next)
      return true
    })
  } catch {
    return false
  }
}

// ── the fail-open probe ─────────────────────────────────────────────────────

// Only the HEAD of the transcript is read: a months-old commander session is a
// multi-MB JSONL and this runs on every desk launch. One parseable event in the
// first chunk is all the evidence we need that claude wrote a real session here.
const PROBE_BYTES = 64 * 1024

/** Can `claude --resume <sessionId>` actually LOAD this session from `cwd`?
 *
 *  This is the fail-open gate (goal condition 4). claude keeps its own transcript
 *  at ~/.claude/projects/<hyphenated-cwd>/<sessionId>.jsonl; if that file is gone
 *  (pruned, a fresh machine, ~/.claude wiped), empty, or truncated to garbage,
 *  `--resume` errors out and the desk would never come up. So we PROVE the session
 *  is loadable before asking for it — anything else is a `false`, and the caller
 *  mints a fresh id instead of gambling the launch. */
export const isSessionResumable = async (cwd: string, sessionId: string): Promise<boolean> => {
  const path = sessionJsonlPath(cwd, sessionId)
  let fh: Awaited<ReturnType<typeof open>> | undefined
  try {
    const st = await stat(path)
    if (!st.isFile() || st.size === 0) return false
    fh = await open(path, 'r')
    const buf = Buffer.alloc(Math.min(PROBE_BYTES, st.size))
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    const lines = buf.subarray(0, bytesRead).toString('utf8').split('\n')
    // We stopped short of EOF ⇒ the last line is very likely cut mid-JSON. Drop it
    // so a truncated read can't be mistaken for a corrupt transcript (and, on a
    // file we DID read whole, keep it — a final line may have no trailing newline).
    if (bytesRead < st.size) lines.pop()
    return lines.some((line) => {
      const t = line.trim()
      if (!t) return false
      try {
        const ev: unknown = JSON.parse(t)
        return !!ev && typeof ev === 'object'
      } catch {
        return false
      }
    })
  } catch {
    return false // missing / unreadable — fail-open to a fresh session
  } finally {
    await fh?.close().catch(() => {})
  }
}

// ── the seam the desks call ─────────────────────────────────────────────────

/** Decide how `role`'s desk should start in `projectPath`: RESUME the persisted
 *  conversation, or open a fresh one. Never throws — every failure degrades to a
 *  fresh session id (see the fail-open contract in the module header).
 *
 *  `isLive` is injected (default: the real PTY pool) so the "session still open"
 *  branch is unit-testable without spawning a terminal. */
export const resolveSwarmSession = async (
  projectPath: string,
  role: SwarmSessionRole,
  deps: { isLive?: (agentSessionId: string) => boolean } = {},
): Promise<ResolvedSwarmSession> => {
  const isLive = deps.isLive ?? isClaudeSessionLive
  const fresh = (reason: FreshSessionReason): ResolvedSwarmSession => ({
    agentSessionId: randomUUID(),
    resume: false,
    reason,
  })
  let rec: SwarmRoleSession | undefined
  try {
    rec = (await readSwarmSessions(projectPath))[role]
  } catch (e) {
    // Unregistered path / unreadable home. A real bug — but the desk still opens.
    // eslint-disable-next-line no-console
    console.warn(`[swarmSessions] cannot read the ${role} session store: ${String(e)}`)
    return fresh('store')
  }
  if (!rec) return fresh('none')
  // claude addresses a session by (cwd, id). The project moved ⇒ its transcript is
  // filed under the OLD dir name and `--resume` would not find it from here.
  if (claudeDirName(rec.cwd) !== claudeDirName(projectPath)) return fresh('moved')
  // Still open in a live PTY (double-click, a second window, a stale localStorage
  // pointing at a running desk): two claude processes appending to one transcript
  // interleave-corrupt it. Give the second desk its own session instead.
  if (isLive(rec.sessionId)) return fresh('live')
  if (!(await isSessionResumable(projectPath, rec.sessionId))) return fresh('missing')
  return { agentSessionId: rec.sessionId, resume: true }
}

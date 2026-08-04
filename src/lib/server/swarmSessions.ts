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
import { mkdir, readFile } from 'fs/promises'
import { dirname } from 'path'
import { atomicWriteJson } from './atomicWrite'
import { claudeDirName } from './claudeProjectDir'
import { projectDataFile } from './projectDataPath'
import { isTranscriptLoadable } from './swarmTranscriptProof'
import { isSdkSessionLive, listSdkSessions } from './sdkSession'
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
 *   - `live`    — a desk is STILL driving this session, on EITHER runtime (PTY or
 *                 Agent SDK); two claude processes appending to one transcript
 *                 would interleave-corrupt it.
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

/** Can `claude --resume <sessionId>` actually LOAD this session from `cwd`?
 *
 *  This is the fail-open gate (goal condition 4). claude keeps its own transcript
 *  at ~/.claude/projects/<hyphenated-cwd>/<sessionId>.jsonl; if that file is gone
 *  (pruned, a fresh machine, ~/.claude wiped), empty, or truncated to garbage,
 *  `--resume` errors out and the desk would never come up. So we PROVE the session
 *  is loadable before asking for it — anything else is a `false`, and the caller
 *  mints a fresh id instead of gambling the launch.
 *
 *  The proof itself now lives in the SHARED helper {@link isTranscriptLoadable}
 *  (swarmTranscriptProof.ts), extracted so the worker-conversation resume (card 4 —
 *  ENGINE_PERSISTENCE_PLAN §5) checks loadability the SAME way instead of a second
 *  copy. This desk path is the NO-orphan-window variant: the still-open hazard is
 *  covered here by the live-PTY `isLive` check in {@link resolveSwarmSession}, so
 *  it needs only the plain exists/non-empty/parseable proof. */
export const isSessionResumable = isTranscriptLoadable

// ── "is anyone already holding this conversation?", asked of BOTH pools ──────

/** Is a LIVE desk — on EITHER runtime — already driving this CLAUDE conversation id?
 *
 *  WHY THIS IS NOT `isClaudeSessionLive`. That predicate answers for the PTY pool
 *  alone, and it was this module's default until 2026-08-01. The question it is
 *  asked here is "would handing this id to a second claude interleave-corrupt the
 *  transcript?", and with the SDK runtime dialled on the answer lives in two
 *  pools: an SDK desk IS a claude, appending to the SAME
 *  ~/.claude/projects/<cwd>/<sessionId>.jsonl. A PTY-only reader says "free" about
 *  a conversation an SDK desk is writing into right now, {@link resolveSwarmSession}
 *  returns `resume:true`, and two claudes write one file. Silent — nothing throws,
 *  nothing logs, and the damage shows up later as a transcript neither desk can load.
 *
 *  ⚠ THE UPSTREAM GUARD IS NOT A SUBSTITUTE, AND MUST NOT BE MISTAKEN FOR ONE.
 *  swarmManager.adoptLiveDesk does ask both pools before it lets a commander spawn
 *  reach here — but it asks a DIFFERENT question: "(this project, the 司令官 label)",
 *  and it asks it ONLY on the commander spawn path. This one is "(this conversation
 *  id, either pool)", so it also covers a desk holding the id that adopt's label
 *  filter does not select. And `spawnSwarmSupply` has NO singleton guard at all —
 *  for the 補給官 this function is the ONLY thing standing between a second launch
 *  and a shared transcript.
 *
 *  ⚠ WHAT NEITHER ARM SEES — do not cite it as this predicate's reason for being.
 *  An earlier revision of this comment claimed the PTY arm catches the owner
 *  running `claude --resume <id>` by hand in a Terminal pane. It does not. The PTY
 *  arm matches on `TerminalInfo.agentSessionId` (terminal.ts, `claudeSessionActivity`),
 *  a field written ONLY by `launchClaude`; a hand-typed claude inside a `zsh -l`
 *  pane leaves it undefined, so that session is invisible here — and equally
 *  invisible to the SDK arm, which can only see sessions this server spawned.
 *  BOTH pools answer for desks OPEN GROUND itself started, and nothing else. The
 *  hand-run case is a KNOWN uncovered hole, not a covered one.
 *
 *  Liveness is `!reaped` ({@link isSdkSessionLive}), NEVER `status`:
 *  `terminateSdkSession` flips status to 'exited' SYNCHRONOUSLY — it means "we
 *  asked it to stop" — so a status reader would call a still-unwinding desk gone
 *  and hand its open transcript to a fresh `--resume`. That is the same trap
 *  documented on `listSdkSessionsIn` / `terminateSdkSessionsInDir`.
 *
 *  ERRING TOWARDS "LIVE" IS STILL THE SAFE DIRECTION — but it is NOT cheap, and an
 *  earlier revision of this comment underpriced it as "one desk its memory for ONE
 *  LAUNCH". There is no such bound in the code. A false "live" makes
 *  {@link resolveSwarmSession} mint a fresh id, and BOTH callers immediately write
 *  that fresh id over the record (swarmManager.ts / swarmSupply.ts each call
 *  `recordSwarmSession` right after launching). The store keeps ONE slot per
 *  (project, role), so the accumulated conversation is not skipped for a launch —
 *  it is FORGOTTEN: its JSONL survives under ~/.claude, but nothing addresses it
 *  any more and no code path here ever goes back for it. The direction is still
 *  right (a false "free" corrupts the transcript, which is worse than losing the
 *  pointer to it) — the price is just one whole conversation, not one launch.
 *
 *  ⚠ AND THE SDK ARM HAS A PERMANENT-"LIVE" MODE, BY DESIGN UPSTREAM. It scans the
 *  pool, and `sweepClosedSessions` (sdkSession.ts) deliberately evicts ONLY reaped
 *  entries — no reaper timeout, on purpose, so a claude wedged in D-state git keeps
 *  its worktree protected instead of having it deleted out from under it. An entry
 *  whose pump never unwinds therefore answers "live" for its conversation id for
 *  the whole life of the server process (a restart clears the in-memory pool).
 *  Composed with the paragraph above, the cost is bounded but real: the FIRST desk
 *  launch after the wedge loses that conversation for good, and every launch after
 *  it resumes normally (the freshly recorded id is held by nobody). That is the
 *  accepted trade — do not "fix" it by reading `status` here, which is exactly the
 *  false-"free" this predicate exists to prevent.
 *
 *  HOME: conceptually this belongs beside the other both-pools questions in
 *  liveDesks.ts. It is here because liveDesks answers by cwd and by beacon, not
 *  by claude conversation id, and this is its only consumer today — hoist it there
 *  the moment a second caller appears rather than growing a third copy. */
export const isAgentSessionLiveAnywhere = (agentSessionId: string): boolean => {
  // An empty id addresses nobody. BELT AND BRACES, not the load-bearing check —
  // be honest about that, because a test asserting "the empty case works" cannot
  // fail on this line's removal. Both arms already refuse it independently:
  // `claudeSessionActivity` returns early on a falsy id (terminal.ts), and the SDK
  // pool never STORES an empty `agentSessionId` (`spawnSdkSession` spreads it only
  // when truthy), so `s.agentSessionId === ''` is unreachable below. This states
  // the rule once, at the top, so it survives a change to either arm.
  if (!agentSessionId) return false
  if (isClaudeSessionLive(agentSessionId)) return true
  // ⚠ `closed` MATTERS HERE, and it is a different question from liveness
  // (2026-08-04). This predicate answers "is some desk still USING this
  // conversation?" — its only consumer refuses to `--resume` a conversation
  // another desk holds. A session that was asked to stop is closed: it accepts
  // no input, produces no more turns, and is merely unwinding. Counting it as a
  // holder made every commander RESTART mint a brand-new conversation and
  // overwrite the record with it — the days-long integration conversation kept
  // its JSONL under ~/.claude but nothing addressed it again, silently. (The
  // teardown-safety question stays `reaped`-based, where being conservative
  // protects a working directory rather than throwing away memory.)
  return listSdkSessions().some(
    (s) => s.agentSessionId === agentSessionId && isSdkSessionLive(s) && !s.closed,
  )
}

// ── the seam the desks call ─────────────────────────────────────────────────

/** How long to wait for a desk that was asked to stop to actually finish before
 *  handing its conversation to the next desk. Long enough for an ordinary
 *  unwind (milliseconds), short enough that a wedged session does not block the
 *  owner's restart. */
export const CONVERSATION_RELEASE_GRACE_MS = 3_000
const RELEASE_POLL_MS = 50

/** Resolve once NO un-reaped SDK session still holds `agentSessionId`, or once
 *  {@link CONVERSATION_RELEASE_GRACE_MS} has passed — whichever comes first.
 *  Never throws, never rejects. Pure-ish (time + the SDK pool). */
export const defaultAwaitRelease = async (
  agentSessionId: string,
  graceMs: number = CONVERSATION_RELEASE_GRACE_MS,
): Promise<void> => {
  if (!agentSessionId) return
  const deadline = Date.now() + graceMs
  // `reaped`, not `closed`: `closed` is the flag terminate sets synchronously,
  // and waiting on it would return immediately — the very blindness this wait
  // exists to cover. `reaped` means the pump's iterator returned, i.e. claude is
  // actually done with the transcript.
  const stillHolding = () =>
    listSdkSessions().some((s) => s.agentSessionId === agentSessionId && !s.reaped)
  while (stillHolding() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, RELEASE_POLL_MS))
  }
}

/** Decide how `role`'s desk should start in `projectPath`: RESUME the persisted
 *  conversation, or open a fresh one. Never throws — every failure degrades to a
 *  fresh session id (see the fail-open contract in the module header).
 *
 *  `isLive` is injected (default: {@link isAgentSessionLiveAnywhere}, i.e. BOTH
 *  desk pools) so the "session still open" branch is unit-testable without
 *  spawning a terminal. Do not narrow that default back to one pool — see the
 *  predicate's own note for what a PTY-only reader gets wrong. */
export const resolveSwarmSession = async (
  projectPath: string,
  role: SwarmSessionRole,
  deps: {
    isLive?: (agentSessionId: string) => boolean
    /** Wait for a stopping-but-not-yet-finished holder of this conversation to
     *  finish (see the call site). Injected for tests; default
     *  {@link defaultAwaitRelease}. */
    awaitRelease?: (agentSessionId: string) => Promise<void>
  } = {},
): Promise<ResolvedSwarmSession> => {
  const isLive = deps.isLive ?? isAgentSessionLiveAnywhere
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
  // Still open in a live desk on EITHER pool (double-click, a second window, a
  // stale localStorage pointing at a running desk, an SDK commander the dial
  // seated): two claude processes appending to one transcript interleave-corrupt
  // it. Give the second desk its own session instead.
  if (isLive(rec.sessionId)) return fresh('live')
  // A desk asked to STOP releases the conversation the moment `closed` is set —
  // but the claude behind it is not dead yet. terminateSdkSession only sets the
  // flag and fires a best-effort interrupt; the process keeps running until its
  // iterator returns (that is what flips `reaped`), which on a mid-tool-call
  // session can be seconds and on a WEDGED one is never. Restart is a DELETE
  // and a POST milliseconds apart, so without this wait the new desk would
  // `--resume` the same conversation while the old process is still appending
  // to it — two claude processes on one transcript, the interleave the
  // liveness predicate exists to prevent, arrived at through the stop door.
  //
  // So: give the old holder a SHORT, BOUNDED chance to finish unwinding. The
  // normal stop reaps in milliseconds and this costs nothing. A wedged session
  // never reaps, and after the grace we proceed anyway — deliberately: it
  // produces no more turns, and refusing forever would strand the owner's
  // days-long integration conversation, which is the failure this whole
  // predicate was rewritten to stop. Bounded risk beats permanent loss.
  await (deps.awaitRelease ?? defaultAwaitRelease)(rec.sessionId)
  if (!(await isSessionResumable(projectPath, rec.sessionId))) return fresh('missing')
  return { agentSessionId: rec.sessionId, resume: true }
}

// @vitest-environment node
//
// The RESTART, end to end. swarmSessions.test.ts pins the decision logic and
// swarmSupply/swarmManager.test.ts pin the launch contract; this one actually DRIVES
// the two desks through `spawnSwarmSupply` / `spawnSwarmManager` — real registry, real
// central store, real node-pty, real login shell, real launch command line — and reads
// back the exact argv `claude` was handed on each boot.
//
// Only the `claude` BINARY is stood in for (OPENGROUND_CLAUDE_BIN → a stub that dumps
// its argv and writes the session transcript exactly where claude would). That is the
// one thing we cannot drive: OPEN GROUND is subscription-only, so spawning the real CLI
// would open a live billed session. Everything the app itself does is genuinely executed.
//
// What it proves — the goal's observable conditions, in the order a user hits them:
//   BOOT 1 (cold)     → `--session-id <new>` : a fresh conversation, as before.
//   …app restarts…    → the PTY dies; nothing is left in memory; the id is on disk.
//   BOOT 2 (restart)  → `--resume <THE SAME id>`, never `--session-id`, and the commander
//                       is handed the re-read-the-Board order rather than a bare skill.
//   BOOT 3 (wiped)    → transcript deleted mid-life ⇒ back to `--session-id <new>`,
//                       the desk still launches (fail-open — no dead PTY, no 500).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, realpath, readFile, writeFile, chmod, unlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { addProjectEntry, __resetMigrationCacheForTests } from './registry'
import { claudeDirName } from './claudeProjectDir'
import { isClaudeSessionLive, killTerminal, listLiveDesksIn } from './terminal'
import {
  spawnSwarmManager,
  MANAGER_INJECTION,
  MANAGER_RESUME_INJECTION,
  MANAGER_DESK_LABEL,
} from './swarmManager'
import { spawnSwarmSupply, SUPPLY_INJECTION, SUPPLY_RESUME_INJECTION } from './swarmSupply'
import { readSwarmSessions, recordSwarmSession } from './swarmSessions'
import { setSettings } from './store'
import { defaultManagerPresence } from './swarmOrchestrator'

// A stand-in for `claude` that does the two things this test needs: dump the argv it was
// actually launched with, and write the session transcript where claude writes it (so the
// NEXT boot's resumability probe sees a real conversation on disk). Mirrors
// e2e/fixtures/fake-claude.sh's session-id parsing + claudeDirName() path derivation.
//
// TWO ordering rules make this harness deterministic. Both are load-bearing.
//
// RULE 1 — EACH LAUNCH GETS ITS OWN FILE. The desks can be up at the SAME time (the owner
// runs supply and commander side by side), so two stubs run concurrently; appending both
// argv dumps to one shared log interleaves them LINE BY LINE (the shell writes each line
// separately, and O_APPEND makes each of those a separate atomic append), which shreds
// every record into an unparseable braid. So a stub:
//   1. claims the next launch number ATOMICALLY — `mkdir` is the portable compare-and-swap:
//      it fails with EEXIST if someone already took that number, so no two launches can
//      claim the same one, with no lock file and no sleep-spin.
//   2. writes its argv to a PRIVATE temp file (no sharing ⇒ no interleaving, whatever the
//      shell's buffering does), then
//   3. `mv`s it into place — a rename within one filesystem is atomic, so a reader sees
//      `launch.N` either absent or COMPLETE, never half-written.
//
// RULE 2 — `launch.N` IS PUBLISHED LAST, AFTER THE TRANSCRIPT. It is the ONLY signal the
// test has that this boot is fully on disk, and `appRestart` kills the PTY the instant it
// sees it. Publish it before writing the transcript (as this stub first did) and the kill
// races the transcript: the shell still has to fork `sed` and `mkdir` before it appends,
// and on a loaded box the SIGKILL lands in that window. The desk then dies having written
// no conversation, the next boot correctly fail-opens to `missing`, and the test that asked
// for `resumed === true` fails — a real, load-dependent flake, not a product bug. So the
// stub writes everything the NEXT boot depends on FIRST, and only then announces itself.
const STUB = (capdir: string) => `#!/bin/sh
set -u
case "\${1:-}" in
  --version|-v) echo "stub-claude 0.0.0"; exit 0 ;;
  auth) [ "\${2:-}" = "status" ] && { echo '{"loggedIn":true}'; exit 0; } ;;
esac
n=0
while ! mkdir "${capdir}/claim.$n" 2>/dev/null; do n=$((n+1)); done
sid=""; prev=""
for a in "$@"; do
  case "$prev" in --session-id|--resume) sid="$a" ;; esac
  prev="$a"
done
if [ -n "$sid" ]; then
  dir=$(pwd -P | sed 's/[^a-zA-Z0-9]/-/g')
  mkdir -p "$HOME/.claude/projects/$dir"
  printf '{"type":"system","subtype":"init","sessionId":"%s"}\\n' "$sid" >> "$HOME/.claude/projects/$dir/$sid.jsonl"
fi
printf '%s\\n' "$@" > "${capdir}/tmp.$$"
mv "${capdir}/tmp.$$" "${capdir}/launch.$n"
[ -z "$sid" ] && exit 2
exit 0
`

// A KEEP-ALIVE variant of the stub for the bug-B test, which needs a LIVE desk in the pool
// (the resume tests deliberately want theirs to EXIT so `--resume` is exercised — the
// opposite requirement). Everything up to publishing `launch.N` is identical; then, instead
// of exiting, it blocks forever so the PTY stays live until the test kills it. `exec cat`
// is a zero-CPU wait for input that never comes (no busy sleep loop).
const ALIVE_STUB = (capdir: string) => `#!/bin/sh
set -u
case "\${1:-}" in
  --version|-v) echo "stub-claude 0.0.0"; exit 0 ;;
  auth) [ "\${2:-}" = "status" ] && { echo '{"loggedIn":true}'; exit 0; } ;;
esac
n=0
while ! mkdir "${capdir}/claim.$n" 2>/dev/null; do n=$((n+1)); done
sid=""; prev=""
for a in "$@"; do
  case "$prev" in --session-id|--resume) sid="$a" ;; esac
  prev="$a"
done
if [ -n "$sid" ]; then
  dir=$(pwd -P | sed 's/[^a-zA-Z0-9]/-/g')
  mkdir -p "$HOME/.claude/projects/$dir"
  printf '{"type":"system","subtype":"init","sessionId":"%s"}\\n' "$sid" >> "$HOME/.claude/projects/$dir/$sid.jsonl"
fi
printf '%s\\n' "$@" > "${capdir}/tmp.$$"
mv "${capdir}/tmp.$$" "${capdir}/launch.$n"
exec cat
`

interface Launch {
  argv: string[]
  /** The uuid claude was given, and which flag carried it. */
  flag: '--session-id' | '--resume' | null
  sessionId: string | null
  /** The positional prompt (always last — buildClaudeArgv's rule 2). */
  prompt: string
}

const parseLaunch = (dump: string): Launch => {
  const argv = dump.split('\n').filter((l) => l.length > 0)
  const i = argv.findIndex((a) => a === '--session-id' || a === '--resume')
  return {
    argv,
    flag: i >= 0 ? (argv[i] as '--session-id' | '--resume') : null,
    sessionId: i >= 0 ? argv[i + 1] : null,
    prompt: argv[argv.length - 1],
  }
}

// PTY + login shell + a shell script: slow under a loaded CI box, so poll to a generous
// ceiling instead of sleeping a guessed constant (the shape that de-flakes swarm tests).
const until = async <T>(what: string, probe: () => Promise<T | null>, ms = 30_000): Promise<T> => {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await probe()
    if (v !== null && v !== undefined) return v
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

// Windows frames the launch line through PowerShell and could not run an `sh` stub.
describe.skipIf(process.platform === 'win32')('swarm desks across an app restart (real PTY)', () => {
  let home: string
  let claudeHome: string
  let scratch: string
  let proj: string
  let capdir: string
  const saved: Record<string, string | undefined> = {}

  // The argv of every launch so far, in launch order — the ground truth of what claude was
  // told. Only the CONTIGUOUS prefix is returned: a stub that has claimed number N but not
  // yet published `launch.N` stops the scan, so a launch is never read half-born, and a
  // later one can never be mistaken for an earlier one.
  const launches = async (): Promise<Launch[]> => {
    const out: Launch[] = []
    for (let n = 0; ; n++) {
      let raw: string
      try {
        raw = await readFile(join(capdir, `launch.${n}`), 'utf8')
      } catch {
        return out
      }
      out.push(parseLaunch(raw))
    }
  }

  const nthLaunch = (n: number) =>
    until(`launch #${n}`, async () => {
      const l = await launches()
      return l.length >= n ? l[n - 1] : null
    })

  // The app restart. In production the whole process dies: every PTY goes with it and
  // nothing survives but the disk.
  //
  // Wait for this boot to be fully ON DISK before killing it. The capture (`launch.N`) is
  // that signal, and it means BOTH the argv and the transcript are durable — the stub
  // publishes it last, precisely so this kill cannot race the transcript (STUB, rule 2).
  // Kill any earlier and the login shell never finishes the stub, so no conversation is
  // ever written; the next boot then correctly fail-opens to a fresh session and the test
  // would be asserting the wrong branch. (Production agrees: an app killed before claude
  // boots leaves no conversation to resume.)
  //
  // `nth` is which launch OF THIS SESSION ID to wait for, and it matters precisely because
  // the feature under test reuses the id: a RESUMED desk carries the same uuid as the boot
  // before it, so "a launch with this id exists" is already true from the previous boot and
  // would let us kill the new PTY before its claude ever ran. Restarting a resumed desk
  // therefore waits for its SECOND launch.
  const appRestart = async (sessionId: string, terminalId: string, nth = 1) => {
    await until(`claude launch #${nth} of ${sessionId.slice(0, 8)}`, async () => {
      const l = await launches()
      return l.filter((x) => x.sessionId === sessionId).length >= nth ? true : null
    })
    killTerminal(terminalId)
    await until('the PTY to be gone', async () => (isClaudeSessionLive(sessionId) ? null : true))
  }

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'og-resume-home-')))
    claudeHome = await realpath(await mkdtemp(join(tmpdir(), 'og-resume-claude-')))
    scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-resume-scratch-')))
    for (const k of ['OPENGROUND_HOME', 'HOME', 'OPENGROUND_CLAUDE_BIN']) saved[k] = process.env[k]
    process.env.OPENGROUND_HOME = home
    process.env.HOME = claudeHome
    __resetMigrationCacheForTests()

    proj = join(scratch, 'proj')
    await mkdir(proj, { recursive: true })
    await addProjectEntry(proj)

    capdir = join(scratch, 'launches')
    await mkdir(capdir, { recursive: true })
    const bin = join(scratch, 'stub-claude.sh')
    await writeFile(bin, STUB(capdir))
    await chmod(bin, 0o755)
    process.env.OPENGROUND_CLAUDE_BIN = bin

    // ⚠ THIS FILE IS THE **PTY** COMMANDER'S INTEGRATION SUITE — it drives a real
    // PTY through a stub `claude` and reads what landed on its command line, so
    // it must ask for that runtime rather than inherit whichever one is current.
    // Since 2026-08-02 the absent dial means SDK, and an SDK commander spawns no
    // PTY at all: these four tests went red not because resume broke but because
    // they were suddenly testing a different runtime than their own title says.
    // The SDK commander's resume is covered in swarmManager.spawn.test.ts.
    await setSettings({ swarmManagerRuntime: { mode: 'pty' } })
  })

  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v
      // NEVER unset the home vars: empty means the user's REAL ~/.openground
      // (paths.ts openGroundHome), and vitest reuses workers across files.
      else if (!['OPENGROUND_HOME', 'HOME'].includes(k)) delete process.env[k]
    }
    __resetMigrationCacheForTests()
    await rm(home, { recursive: true, force: true })
    await rm(claudeHome, { recursive: true, force: true })
    await rm(scratch, { recursive: true, force: true })
  })

  it('COMMANDER: boot → restart → resumes the SAME conversation with `--resume`, ordered to re-read the Board', async () => {
    // ── BOOT 1: cold. Nothing persisted, so a brand-new conversation. ───────
    const cold = await spawnSwarmManager({ projectPath: proj })
    expect(cold.resumed).toBe(false)
    const first = await nthLaunch(1)
    expect(first.flag).toBe('--session-id') // fresh session — the historical launch
    expect(first.sessionId).toBe(cold.agentSessionId)
    expect(first.prompt).toBe(MANAGER_INJECTION) // a plain `/og-manage`

    // The id is now on disk, in the project's CENTRAL data dir.
    expect((await readSwarmSessions(proj)).manager?.sessionId).toBe(cold.agentSessionId)

    // ── the app restarts (a release): the PTY dies, memory is gone. ─────────
    await appRestart(cold.agentSessionId, cold.terminalId)

    // ── BOOT 2: the whole point. Same conversation, not a new one. ──────────
    const warm = await spawnSwarmManager({ projectPath: proj })
    expect(warm.resumed).toBe(true)
    expect(warm.agentSessionId).toBe(cold.agentSessionId) // ← the amnesia is gone

    const second = await nthLaunch(2)
    expect(second.flag).toBe('--resume') // ← claude is told to CONTINUE
    expect(second.sessionId).toBe(cold.agentSessionId)
    expect(second.argv).not.toContain('--session-id') // ← and never to start over

    // …and it is handed the re-read-the-Board order, not a bare skill: the conversation
    // survived the restart but the engine's roster did not, and the code may have moved.
    expect(second.prompt).toBe(MANAGER_RESUME_INJECTION)
    expect(second.prompt).toContain('状況')
    expect(second.prompt).toContain('todo/doing/review')
    // The whole order must have arrived as ONE argv token (the slash-command contract) —
    // a split prompt would reach claude as junk after `/og-manage`.
    expect(second.argv.filter((a) => a === second.prompt)).toHaveLength(1)

    await appRestart(warm.agentSessionId, warm.terminalId, 2) // its 2nd launch — same uuid

    // ── BOOT 3: claude's transcript is wiped under us (pruned / ~/.claude reset).
    // `claude --resume` would EXIT here, leaving a dead PTY where the commander should
    // be — so the desk must fall back to a fresh session instead of failing.
    const dir = join(claudeHome, '.claude', 'projects', claudeDirName(proj))
    await unlink(join(dir, `${cold.agentSessionId}.jsonl`))

    const healed = await spawnSwarmManager({ projectPath: proj })
    expect(healed.resumed).toBe(false) // fail-open …
    expect(healed.terminalId).toBeTruthy() // … and the desk still came up
    expect(healed.agentSessionId).not.toBe(cold.agentSessionId)

    const third = await nthLaunch(3)
    expect(third.flag).toBe('--session-id')
    expect(third.prompt).toBe(MANAGER_INJECTION)
    // The new id replaces the dead one, so the NEXT restart resumes this one.
    expect((await readSwarmSessions(proj)).manager?.sessionId).toBe(healed.agentSessionId)
    await appRestart(healed.agentSessionId, healed.terminalId)
  }, 90_000)

  it('SUPPLY: boot → restart → resumes the same desk, told to re-read the Board before filing', async () => {
    const cold = await spawnSwarmSupply({ projectPath: proj })
    expect(cold.resumed).toBe(false)
    const first = await nthLaunch(1)
    expect(first.flag).toBe('--session-id')
    expect(first.prompt).toBe(SUPPLY_INJECTION)

    await appRestart(cold.agentSessionId, cold.terminalId)

    const warm = await spawnSwarmSupply({ projectPath: proj })
    expect(warm.resumed).toBe(true)
    expect(warm.agentSessionId).toBe(cold.agentSessionId)

    const second = await nthLaunch(2)
    expect(second.flag).toBe('--resume')
    expect(second.sessionId).toBe(cold.agentSessionId)
    expect(second.argv).not.toContain('--session-id')
    expect(second.prompt).toBe(SUPPLY_RESUME_INJECTION)
    await appRestart(warm.agentSessionId, warm.terminalId, 2) // its 2nd launch — same uuid
  }, 90_000)

  it('the two desks resume INDEPENDENTLY (one file, two conversations)', async () => {
    const s1 = await spawnSwarmSupply({ projectPath: proj })
    const m1 = await spawnSwarmManager({ projectPath: proj })
    expect(m1.agentSessionId).not.toBe(s1.agentSessionId)
    await appRestart(s1.agentSessionId, s1.terminalId)
    await appRestart(m1.agentSessionId, m1.terminalId)

    const s2 = await spawnSwarmSupply({ projectPath: proj })
    const m2 = await spawnSwarmManager({ projectPath: proj })
    expect(s2.resumed).toBe(true)
    expect(m2.resumed).toBe(true)
    expect(s2.agentSessionId).toBe(s1.agentSessionId)
    expect(m2.agentSessionId).toBe(m1.agentSessionId)
    await appRestart(s2.agentSessionId, s2.terminalId, 2) // 2nd launch of the same uuid
    await appRestart(m2.agentSessionId, m2.terminalId, 2)
  }, 90_000)

  it('`fresh:true` abandons the stored conversation and starts a new one (the escape hatch)', async () => {
    const cold = await spawnSwarmManager({ projectPath: proj })
    await appRestart(cold.agentSessionId, cold.terminalId)

    const brandNew = await spawnSwarmManager({ projectPath: proj, fresh: true })
    expect(brandNew.resumed).toBe(false)
    expect(brandNew.agentSessionId).not.toBe(cold.agentSessionId)
    expect((await nthLaunch(2)).flag).toBe('--session-id')
    // The escape hatch REPLACES the pointer — the abandoned context is not resurrected
    // on the next restart, which is the only behaviour that makes it an escape.
    expect((await readSwarmSessions(proj)).manager?.sessionId).toBe(brandNew.agentSessionId)
    await appRestart(brandNew.agentSessionId, brandNew.terminalId)
  }, 90_000)

  // ── bug B, end to end (2026-07-20): a LIVE desk the record no longer names must NOT
  // read 'absent', and a second spawn must NOT build a twin. This is the FAITHFUL
  // reproduction — a REAL desk, the REAL pool, the REAL presence probe and the REAL
  // spawn guard, with only the `claude` binary stubbed. No injected deps.
  //
  // The commander measured 11 desks pile up with FABLE UNINVOLVED. Root cause: presence
  // and the resume seam both asked the single-slot session record "is the recorded id
  // live?", and that slot is best-effort (recordSwarmSession's write is `.catch(()=>{})`)
  // and overwritten by every spawn. Corrupt it — exactly what a swallowed write or a
  // racing spawn does — and `claudeSessionActivity(rec.sessionId)` answers live:false for
  // a desk that is very much alive. The desk was never dead; it was UNNAMED. On the old
  // code presence then returned 'absent' (the ONLY spawn trigger) and the engine built a
  // twin; here both the pool-backed presence and the pool-backed spawn guard refuse to.
  it('a live desk the record has LOST its id for is not absent, and a 2nd spawn reuses it — never a twin (bug B)', async () => {
    // This desk must STAY UP (the opposite of the resume tests), so swap in the keep-alive
    // stub before spawning — the pool can only be the existence authority for a desk that
    // is actually in it.
    const aliveBin = join(scratch, 'alive-claude.sh')
    await writeFile(aliveBin, ALIVE_STUB(capdir))
    await chmod(aliveBin, 0o755)
    process.env.OPENGROUND_CLAUDE_BIN = aliveBin

    // A real commander desk boots (real launchClaude → real PTY → live stub) and stays up.
    const desk = await spawnSwarmManager({ projectPath: proj })
    await nthLaunch(1)
    await until('the desk to be live', async () => (isClaudeSessionLive(desk.agentSessionId) ? true : null))

    // The POOL — the authority the fix relies on — sees it under its 司令官 label in this
    // cwd. (This is the empirical proof deskLabel/ownerDesk/cwd propagate to the pool.)
    const inPool = listLiveDesksIn(proj, MANAGER_DESK_LABEL)
    expect(inPool).toHaveLength(1)
    expect(inPool[0].id).toBe(desk.terminalId)
    expect(inPool[0].agentSessionId).toBe(desk.agentSessionId)

    // bug B's SYMPTOM: corrupt the single record slot (a swallowed / overwritten write).
    // claudeSessionActivity(this id) now answers live:false while the desk keeps running.
    await recordSwarmSession(proj, 'manager', '00000000-dead-dead-dead-000000000000')

    // bug B's FIX #1 (presence): consult the pool → the desk EXISTS → NOT 'absent'.
    // (Old code: rec's id not live ⇒ 'absent' ⇒ the engine spawns beside a live desk.)
    const presence = await defaultManagerPresence(proj, Date.now())
    expect(presence).not.toBe('absent')

    // bug B's FIX #2 (spawn guard): a second spawn hands back the desk that already
    // exists instead of building a twin — the invariant "≤1 commander desk per project".
    const twin = await spawnSwarmManager({ projectPath: proj })
    expect(twin.reused).toBe(true)
    expect(twin.terminalId).toBe(desk.terminalId) // the SAME desk, not a new PTY
    expect(twin.agentSessionId).toBe(desk.agentSessionId)

    // Still exactly ONE desk and ONE launch — no second `claude` was ever spawned.
    expect(listLiveDesksIn(proj, MANAGER_DESK_LABEL)).toHaveLength(1)
    expect(await launches()).toHaveLength(1)

    // …and the guard RECONCILED the corrupted slot back onto the live desk on the way
    // out, so presence stops reading 'absent' at the source.
    expect((await readSwarmSessions(proj)).manager?.sessionId).toBe(desk.agentSessionId)

    // Tear the live desk down (the keep-alive stub blocks on stdin until its PTY dies).
    killTerminal(desk.terminalId)
    await until('the desk to be gone', async () => (isClaudeSessionLive(desk.agentSessionId) ? null : true))
  }, 90_000)
})

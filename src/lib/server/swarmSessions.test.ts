// @vitest-environment node
//
// swarmSessions — the RESUME seam for the two long-lived swarm desks (補給官 /
// 司令官). Before this, every spawn minted a throw-away `--session-id`, so an OPEN
// GROUND restart (i.e. every release) left both desks amnesiac. These tests pin the
// two halves of the fix:
//
//   PERSISTENCE — one session id per (project, role), stored in the project's
//   CENTRAL data dir (~/.openground/projects/<uuid>/swarm-sessions.json — never in
//   the user's repo), surviving a process restart. The restart is simulated the only
//   way that proves anything: write the record, throw the in-memory result away, and
//   read the store back from disk exactly as a fresh boot would.
//
//   FAIL-OPEN — a persisted id is a HINT, never a requirement. `claude --resume <id>`
//   on a session claude cannot load EXITS, which would leave the owner staring at a
//   dead PTY where their commander used to be. So `resume` is only ever returned when
//   the transcript has been PROVEN loadable; every other branch (nothing stored,
//   record corrupt, project moved, transcript pruned / emptied / truncated to garbage,
//   session still open in a live PTY) degrades to a fresh id and the desk launches.
//
// Fully HOME-isolated: OPENGROUND_HOME (the app store) AND HOME (claude's own
// ~/.claude/projects transcripts) point at tmpdirs, so the suite never reads or
// writes the real ones.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, realpath, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { addProjectEntry, __resetMigrationCacheForTests } from './registry'
import { getSettings } from './store'
import { claudeDirName } from './claudeProjectDir'
import { projectDataFile } from './projectDataPath'
import { atomicWriteJson } from './atomicWrite'
import {
  SWARM_SESSIONS_FILE,
  parseSwarmSessions,
  readSwarmSessions,
  recordSwarmSession,
  resolveSwarmSession,
  isSessionResumable,
  type SwarmSessionsFile,
} from './swarmSessions'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// One realistic claude transcript event — enough for the probe to conclude "claude
// really wrote a session here" (it looks for ONE parseable JSON event in the head).
const transcriptLine = (sessionId: string) =>
  JSON.stringify({ type: 'system', subtype: 'init', sessionId, model: 'claude-opus-4-8' }) + '\n'

describe('swarmSessions (desk session persistence + resume)', () => {
  let home: string // OPENGROUND_HOME — the app's central store
  let claudeHome: string // HOME — claude's own ~/.claude/projects transcripts
  let scratch: string // where the fake project checkouts live
  let proj: string
  let savedOgHome: string | undefined
  let savedHome: string | undefined

  // Claude files a session at ~/.claude/projects/<hyphenated-cwd>/<id>.jsonl. The
  // probe reads exactly that path, so the test writes exactly that path.
  const writeTranscript = async (cwd: string, sessionId: string, body?: string) => {
    const dir = join(claudeHome, '.claude', 'projects', claudeDirName(cwd))
    await mkdir(dir, { recursive: true })
    const file = join(dir, `${sessionId}.jsonl`)
    await writeFile(file, body ?? transcriptLine(sessionId))
    return file
  }

  // Read the store the way a FRESH PROCESS would: straight off disk, at the literal
  // central path, with nothing cached in memory. This is the whole point of the
  // feature, so the test refuses to take readSwarmSessions' word for where it lives.
  const readStoreFromDisk = async (): Promise<SwarmSessionsFile> => {
    const settings = await getSettings()
    const id = (settings.projects ?? []).find((e) => e.path === proj)!.id
    const file = join(home, 'projects', id, SWARM_SESSIONS_FILE)
    return JSON.parse(await readFile(file, 'utf8'))
  }

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'og-sess-home-')))
    claudeHome = await realpath(await mkdtemp(join(tmpdir(), 'og-sess-claude-')))
    scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-sess-scratch-')))
    savedOgHome = process.env.OPENGROUND_HOME
    savedHome = process.env.HOME
    process.env.OPENGROUND_HOME = home
    process.env.HOME = claudeHome // os.homedir() honours $HOME on POSIX
    __resetMigrationCacheForTests()
    proj = join(scratch, 'proj')
    await mkdir(proj, { recursive: true })
    await addProjectEntry(proj) // register: the central data dir resolves off the registry
  })

  afterEach(async () => {
    // Restore, never delete: an unset OPENGROUND_HOME sends later resolution at the
    // REAL home dir (the 2026-07-18 data loss). See src/lib/server/testHomeGuard.ts.
    if (savedOgHome !== undefined) process.env.OPENGROUND_HOME = savedOgHome
    // Restore, never delete: an unset HOME sends later resolution at the
    // REAL home dir (the 2026-07-18 data loss). See src/lib/server/testHomeGuard.ts.
    if (savedHome !== undefined) process.env.HOME = savedHome
    __resetMigrationCacheForTests()
    await rm(home, { recursive: true, force: true })
    await rm(claudeHome, { recursive: true, force: true })
    await rm(scratch, { recursive: true, force: true })
  })

  // ── the goal: the desks survive an app restart ────────────────────────────

  it('RESTART: a recorded session id is resumed — same id, resume=true — by a fresh read off disk', async () => {
    // Launch #1 mints a fresh id (nothing persisted yet) …
    const first = await resolveSwarmSession(proj, 'manager')
    expect(first.resume).toBe(false)
    expect(first.reason).toBe('none')
    expect(first.agentSessionId).toMatch(UUID_RE)

    // … the spawn records it, and claude writes its transcript.
    await recordSwarmSession(proj, 'manager', first.agentSessionId)
    await writeTranscript(proj, first.agentSessionId)

    // --- the app restarts here: nothing in memory, everything from disk. ---
    const store = await readStoreFromDisk()
    expect(store.manager?.sessionId).toBe(first.agentSessionId)
    expect(store.manager?.cwd).toBe(proj)

    // Launch #2 resumes the SAME conversation instead of starting over.
    const second = await resolveSwarmSession(proj, 'manager')
    expect(second.resume).toBe(true)
    expect(second.agentSessionId).toBe(first.agentSessionId)
    expect(second.reason).toBeUndefined()
  })

  it('persists per (project, ROLE) — supply and the commander keep separate conversations', async () => {
    await recordSwarmSession(proj, 'supply', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    await recordSwarmSession(proj, 'manager', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
    await writeTranscript(proj, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    await writeTranscript(proj, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')

    const s = await resolveSwarmSession(proj, 'supply')
    const m = await resolveSwarmSession(proj, 'manager')
    expect(s.resume).toBe(true)
    expect(m.resume).toBe(true)
    expect(s.agentSessionId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    expect(m.agentSessionId).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
  })

  it('lands in the project CENTRAL data dir — never inside the user repo', async () => {
    await recordSwarmSession(proj, 'supply', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')
    // The literal central path (~/.openground/projects/<uuid>/swarm-sessions.json).
    await expect(readStoreFromDisk()).resolves.toMatchObject({
      supply: { sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
    })
    // …and nothing was written into the checkout (CLAUDE.md: no OG files in the repo).
    await expect(readFile(join(proj, SWARM_SESSIONS_FILE), 'utf8')).rejects.toThrow()
    await expect(readFile(join(proj, '.openground', SWARM_SESSIONS_FILE), 'utf8')).rejects.toThrow()
  })

  it('recording BOTH roles concurrently loses neither (the read-modify-write is serialised)', async () => {
    // supply + manager share ONE file: without serialisation both read {} and the
    // last writer would erase the other's id.
    await Promise.all([
      recordSwarmSession(proj, 'supply', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
      recordSwarmSession(proj, 'manager', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
    ])
    const store = await readStoreFromDisk()
    expect(store.supply?.sessionId).toBe('dddddddd-dddd-4ddd-8ddd-dddddddddddd')
    expect(store.manager?.sessionId).toBe('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')
  })

  it('re-recording the same role upserts (a fresh conversation replaces the old pointer)', async () => {
    await recordSwarmSession(proj, 'manager', '11111111-1111-4111-8111-111111111111')
    await recordSwarmSession(proj, 'manager', '22222222-2222-4222-8222-222222222222')
    const store = await readSwarmSessions(proj)
    expect(store.manager?.sessionId).toBe('22222222-2222-4222-8222-222222222222')
  })

  // ── fail-open: never let a bad record block the desk (goal condition 4) ───

  it('FAIL-OPEN: transcript missing (pruned / fresh machine) → fresh session, not an error', async () => {
    await recordSwarmSession(proj, 'manager', '33333333-3333-4333-8333-333333333333')
    // No transcript on disk — claude would exit on `--resume`.
    const r = await resolveSwarmSession(proj, 'manager')
    expect(r.resume).toBe(false)
    expect(r.reason).toBe('missing')
    expect(r.agentSessionId).toMatch(UUID_RE)
    expect(r.agentSessionId).not.toBe('33333333-3333-4333-8333-333333333333')
  })

  it('FAIL-OPEN: transcript present but EMPTY or corrupt → fresh session', async () => {
    await recordSwarmSession(proj, 'supply', '44444444-4444-4444-8444-444444444444')
    await writeTranscript(proj, '44444444-4444-4444-8444-444444444444', '')
    expect((await resolveSwarmSession(proj, 'supply')).resume).toBe(false)

    await writeTranscript(proj, '44444444-4444-4444-8444-444444444444', 'not json\nalso not json\n')
    const r = await resolveSwarmSession(proj, 'supply')
    expect(r.resume).toBe(false)
    expect(r.reason).toBe('missing')
  })

  it('FAIL-OPEN: a corrupt store file reads as empty → fresh session', async () => {
    const file = await projectDataFile(proj, SWARM_SESSIONS_FILE)
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, '{ this is not json')
    await expect(readSwarmSessions(proj)).resolves.toEqual({})
    const r = await resolveSwarmSession(proj, 'manager')
    expect(r.resume).toBe(false)
    expect(r.reason).toBe('none')
  })

  it('FAIL-OPEN: a hand-mangled record (no sessionId) is dropped → fresh session', async () => {
    const file = await projectDataFile(proj, SWARM_SESSIONS_FILE)
    await mkdir(join(file, '..'), { recursive: true })
    await atomicWriteJson(file, { manager: { cwd: proj, updatedAt: 'x' } })
    const r = await resolveSwarmSession(proj, 'manager')
    expect(r.resume).toBe(false)
    expect(r.reason).toBe('none')
  })

  it('FAIL-OPEN: the project MOVED — the transcript lives under the old cwd → fresh session', async () => {
    // relocateProjectEntry keeps the UUID, so the central store survives a move while
    // its recorded cwd goes stale. claude files transcripts BY CWD, so the old session
    // is unreachable from the new path — resuming it would just error.
    const old = join(scratch, 'old-location')
    await mkdir(old, { recursive: true })
    const file = await projectDataFile(proj, SWARM_SESSIONS_FILE)
    await mkdir(join(file, '..'), { recursive: true })
    await atomicWriteJson(file, {
      manager: { sessionId: '55555555-5555-4555-8555-555555555555', cwd: old, updatedAt: 'x' },
    })
    // A transcript exists — but under the OLD path's dir, which is exactly the trap.
    await writeTranscript(old, '55555555-5555-4555-8555-555555555555')

    const r = await resolveSwarmSession(proj, 'manager')
    expect(r.resume).toBe(false)
    expect(r.reason).toBe('moved')
  })

  it('FAIL-OPEN: the session is STILL OPEN in a live PTY → fresh session (never two claudes on one transcript)', async () => {
    await recordSwarmSession(proj, 'manager', '66666666-6666-4666-8666-666666666666')
    await writeTranscript(proj, '66666666-6666-4666-8666-666666666666')
    // Sanity: it WOULD resume if nothing were holding it open.
    expect((await resolveSwarmSession(proj, 'manager')).resume).toBe(true)

    const r = await resolveSwarmSession(proj, 'manager', { isLive: (id) => id === '66666666-6666-4666-8666-666666666666' })
    expect(r.resume).toBe(false)
    expect(r.reason).toBe('live')
    expect(r.agentSessionId).not.toBe('66666666-6666-4666-8666-666666666666')
  })

  it('FAIL-OPEN: an unregistered project cannot even resolve a store → fresh session, no throw', async () => {
    const stranger = join(scratch, 'never-registered')
    await mkdir(stranger, { recursive: true })
    const r = await resolveSwarmSession(stranger, 'manager')
    expect(r.resume).toBe(false)
    expect(r.reason).toBe('store')
    expect(r.agentSessionId).toMatch(UUID_RE)
  })

  // ── the probe + parser in isolation ──────────────────────────────────────

  describe('isSessionResumable (the fail-open gate)', () => {
    it('true only when claude really has a loadable transcript for this cwd', async () => {
      await writeTranscript(proj, 'aaaa1111-1111-4111-8111-111111111111')
      await expect(isSessionResumable(proj, 'aaaa1111-1111-4111-8111-111111111111')).resolves.toBe(true)
    })

    it('false when the file is absent, empty, or pure garbage', async () => {
      await expect(isSessionResumable(proj, 'no-such-session')).resolves.toBe(false)
      await writeTranscript(proj, 'bbbb2222-2222-4222-8222-222222222222', '')
      await expect(isSessionResumable(proj, 'bbbb2222-2222-4222-8222-222222222222')).resolves.toBe(false)
      await writeTranscript(proj, 'cccc3333-3333-4333-8333-333333333333', '<<<binary junk>>>\n')
      await expect(isSessionResumable(proj, 'cccc3333-3333-4333-8333-333333333333')).resolves.toBe(false)
    })

    it('true for a BIG transcript — only the head is read, and a mid-JSON cut is not called corrupt', async () => {
      // A months-old commander session is multi-MB: the probe must stay cheap AND must
      // not mistake its own truncated read for a corrupt file.
      const id = 'dddd4444-4444-4444-8444-444444444444'
      const big = transcriptLine(id).repeat(4000) // ≫ the 64KB probe window
      await writeTranscript(proj, id, big)
      await expect(isSessionResumable(proj, id)).resolves.toBe(true)
    })
  })

  describe('parseSwarmSessions (tolerant reader)', () => {
    it('keeps well-formed records and drops everything else', () => {
      expect(
        parseSwarmSessions({
          supply: { sessionId: 's1', cwd: '/repo', updatedAt: 'now' },
          manager: { sessionId: '', cwd: '/repo' }, // empty id → dropped
          worker: { sessionId: 'w1', cwd: '/repo' }, // not a desk role → ignored
        }),
      ).toEqual({ supply: { sessionId: 's1', cwd: '/repo', updatedAt: 'now' } })
    })

    it('never throws on junk', () => {
      expect(parseSwarmSessions(null)).toEqual({})
      expect(parseSwarmSessions('nope')).toEqual({})
      expect(parseSwarmSessions([1, 2, 3])).toEqual({})
      expect(parseSwarmSessions({ manager: 'not-an-object' })).toEqual({})
    })
  })
})

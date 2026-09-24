import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, realpath, writeFile, utimes } from 'fs/promises'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import { join } from 'path'
import { claudeDirName } from './claudeProjectDir'
import { proveTranscriptLoadable, isTranscriptLoadable, ORPHAN_MTIME_WINDOW_MS } from './swarmTranscriptProof'

// swarmTranscriptProof — the SHARED transcript-loadable proof (card 4,
// ENGINE_PERSISTENCE_PLAN §5). These are the completion-condition fixtures:
//   ① a proven transcript ⇒ loadable (the --resume path),
//   ② JSONL missing / empty / still-being-written ⇒ NOT loadable (the fallback path).
// HOME is isolated (claude files its transcripts under $HOME/.claude/projects), and
// the fixture writes the EXACT path sessionJsonlPath reads.

const transcriptLine = (sessionId: string) =>
  JSON.stringify({ type: 'system', subtype: 'init', sessionId, model: 'claude-opus-4-8' }) + '\n'

describe('swarmTranscriptProof — proveTranscriptLoadable (card 4 fixtures)', () => {
  let claudeHome: string
  let scratch: string
  let cwd: string
  let savedHome: string | undefined

  // Claude files a session at $HOME/.claude/projects/<hyphenated-cwd>/<id>.jsonl —
  // the same path sessionJsonlPath(cwd,id) derives, so the fixture writes it there.
  const writeTranscript = async (sessionId: string, body?: string): Promise<string> => {
    const dir = join(claudeHome, '.claude', 'projects', claudeDirName(cwd))
    await mkdir(dir, { recursive: true })
    const file = join(dir, `${sessionId}.jsonl`)
    await writeFile(file, body ?? transcriptLine(sessionId))
    return file
  }

  beforeEach(async () => {
    claudeHome = await realpath(await mkdtemp(join(tmpdir(), 'og-proof-home-')))
    scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-proof-scratch-')))
    savedHome = process.env.HOME
    process.env.HOME = claudeHome // os.homedir() honours $HOME on POSIX
    cwd = join(scratch, 'wt')
    await mkdir(cwd, { recursive: true })
  })

  afterEach(async () => {
    // Restore, never delete (an unset HOME would send later resolution at the REAL
    // home — the 2026-07-18 data loss; testHomeGuard.ts).
    if (savedHome !== undefined) process.env.HOME = savedHome
    await rm(claudeHome, { recursive: true, force: true })
    await rm(scratch, { recursive: true, force: true })
  })

  // ── ① proven ⇒ loadable ──────────────────────────────────────────────────
  it('proves a real (exists / non-empty / parseable) transcript loadable', async () => {
    const id = 'aaaa1111-1111-4111-8111-111111111111'
    await writeTranscript(id)
    const p = await proveTranscriptLoadable(cwd, id)
    expect(p.loadable).toBe(true)
    expect(p.reason).toBe('ok')
  })

  it('the orphan window does NOT reject a STALE (old-mtime) transcript — it still resumes', async () => {
    const id = 'aaaa2222-2222-4222-8222-222222222222'
    const file = await writeTranscript(id)
    // mtime 20s in the past, window 10s ⇒ past the window ⇒ no wait ⇒ loadable.
    const staleMs = Date.now() - 20_000
    await utimes(file, new Date(staleMs), new Date(staleMs))
    const sleep = vi.fn(async () => {})
    const p = await proveTranscriptLoadable(cwd, id, { orphanWindowMs: ORPHAN_MTIME_WINDOW_MS, sleep })
    expect(sleep).not.toHaveBeenCalled()
    expect(p.loadable).toBe(true)
    expect(p.reason).toBe('ok')
  })

  // ── ② the three fallbacks ────────────────────────────────────────────────
  it('MISSING transcript ⇒ not loadable (reason missing)', async () => {
    const p = await proveTranscriptLoadable(cwd, 'no-such-session-id')
    expect(p.loadable).toBe(false)
    expect(p.reason).toBe('missing')
  })

  it('EMPTY (zero-length) transcript ⇒ not loadable (reason empty)', async () => {
    const id = 'bbbb2222-2222-4222-8222-222222222222'
    await writeTranscript(id, '')
    const p = await proveTranscriptLoadable(cwd, id)
    expect(p.loadable).toBe(false)
    expect(p.reason).toBe('empty')
  })

  it('FRESH mtime waits out the rest of the window before re-measuring', async () => {
    const id = 'cccc3333-3333-4333-8333-333333333333'
    const file = await writeTranscript(id)
    const freshMs = Date.now() - 2_000
    await utimes(file, new Date(freshMs), new Date(freshMs))
    const sleep = vi.fn(async () => {})
    const p = await proveTranscriptLoadable(cwd, id, { orphanWindowMs: ORPHAN_MTIME_WINDOW_MS, sleep })
    // ~8s left of the 10s window (measured at proof time), then unmoved ⇒ dead ⇒ loadable.
    const waited = (sleep.mock.calls[0] as unknown as [number])[0]
    expect(waited).toBeGreaterThan(7_000)
    expect(waited).toBeLessThanOrEqual(8_000)
    expect(p.loadable).toBe(true)
  })

  // 2026-09-24 (0.11.133 hands-free update): the old app stopped every worker at
  // 01:15:42.27 and the new server booted 9.7s later ⇒ all three DEAD sessions read
  // as 'fresh' and were declined. Closeness in time alone must not decline: a fresh
  // transcript is re-measured once the window has passed, and a mtime that did not
  // move means nobody is writing ⇒ resume. Measured at PROOF time (no `now` passed).
  // TEETH (measured 2026-09-24): on the pre-fix single-snapshot implementation this
  // test is RED (reason 'fresh').
  it('a DEAD session stopped 9.7s before boot is resumed (re-measured after the window)', async () => {
    const id = 'abab7777-7777-4777-8777-777777777777'
    const file = await writeTranscript(id)
    const stopped = Date.now() - 9_700
    await utimes(file, new Date(stopped), new Date(stopped))
    const p = await proveTranscriptLoadable(cwd, id, { orphanWindowMs: ORPHAN_MTIME_WINDOW_MS })
    expect(p.loadable).toBe(true)
    expect(p.reason).toBe('ok')
  })

  it('an orphan STILL WRITING during the re-measure wait is declined (no twin)', async () => {
    const id = 'acac8888-8888-4888-8888-888888888888'
    const file = await writeTranscript(id)
    // 2s old (8s of margin, not 300ms) so a loaded machine can't slide it out of the window.
    const t0 = Date.now() - 2_000
    await utimes(file, new Date(t0), new Date(t0))
    const p = await proveTranscriptLoadable(cwd, id, {
      orphanWindowMs: ORPHAN_MTIME_WINDOW_MS,
      isSessionHeld: async () => false,
      // the orphan appends while we wait
      sleep: async () => {
        await utimes(file, new Date(t0 + 5_000), new Date(t0 + 5_000))
      },
    })
    expect(p.loadable).toBe(false)
    expect(p.reason).toBe('fresh')
  })

  // Review 2026-09-24 must-fix 1: a FUTURE mtime (clock rewind / NTP / a restored
  // ~/.claude) must not buy an unbounded sleep — resumes are proven one project at a
  // time, so an hour here stalls every later project's boot.
  it('a FUTURE mtime waits at most one orphan window', async () => {
    const id = 'adad9999-9999-4999-8999-999999999999'
    const file = await writeTranscript(id)
    const future = Date.now() + 3_600_000
    await utimes(file, new Date(future), new Date(future))
    const sleep = vi.fn(async () => {})
    await proveTranscriptLoadable(cwd, id, { orphanWindowMs: ORPHAN_MTIME_WINDOW_MS, sleep, isSessionHeld: async () => false })
    expect(sleep).toHaveBeenCalledTimes(1)
    expect((sleep.mock.calls[0] as unknown as [number])[0]).toBeLessThanOrEqual(ORPHAN_MTIME_WINDOW_MS)
  })

  // Review 2026-09-24 must-fix 3: a server SIGKILL leaves claude as an orphan and
  // Electron respawns in ~2s. An orphan inside a long tool call (npm test, a
  // sub-agent) writes nothing for minutes — mtime alone calls it dead and a
  // --resume twin lands on the same worktree. A live process holding the session
  // id must decline regardless of how quiet the transcript is.
  // TEETH (measured 2026-09-24): RED on the mtime-only implementation (loadable).
  it('a QUIET orphan (long tool call, stale transcript) still holding the session is declined', async () => {
    const id = 'aeae0000-0000-4000-8000-000000000000'
    const file = await writeTranscript(id)
    const old = Date.now() - 120_000
    await utimes(file, new Date(old), new Date(old))
    const p = await proveTranscriptLoadable(cwd, id, {
      orphanWindowMs: ORPHAN_MTIME_WINDOW_MS,
      isSessionHeld: async (sid) => sid === id,
    })
    expect(p.loadable).toBe(false)
    expect(p.reason).toBe('live')
  })

  it('the default probe sees a real process whose command line carries the session id', async () => {
    const id = 'afaf1111-1111-4111-8111-111111111111'
    const file = await writeTranscript(id)
    const old = Date.now() - 120_000
    await utimes(file, new Date(old), new Date(old))
    // stands in for `claude --resume <id>`: sh keeps the extra argv on its command line
    const child = spawn('sh', ['-c', 'sleep 30; true', 'claude', '--resume', id], { stdio: 'ignore' })
    try {
      await new Promise((r) => setTimeout(r, 200))
      const p = await proveTranscriptLoadable(cwd, id, { orphanWindowMs: ORPHAN_MTIME_WINDOW_MS })
      expect(p.reason).toBe('live')
    } finally {
      child.kill('SIGKILL')
    }
  })

  it('a FAILED process probe falls back (fail-safe) — never resumes blind', async () => {
    const id = 'b0b02222-2222-4222-8222-222222222222'
    const file = await writeTranscript(id)
    const old = Date.now() - 120_000
    await utimes(file, new Date(old), new Date(old))
    const p = await proveTranscriptLoadable(cwd, id, {
      orphanWindowMs: ORPHAN_MTIME_WINDOW_MS,
      isSessionHeld: async () => null,
    })
    expect(p.loadable).toBe(false)
    expect(p.reason).toBe('live')
  })

  // The role-desk path (no orphan window) never consults mtime. MUTATION: delete the
  // `if (opts.orphanWindowMs !== undefined)` block and the STILL-WRITING test above
  // goes RED (loadable) — that pair pins the guard as load-bearing.
  it('TEETH: a fresh transcript is loadable when the orphan window is OFF (role-desk path)', async () => {
    const id = 'dddd4444-4444-4444-8444-444444444444'
    const file = await writeTranscript(id)
    await utimes(file, new Date(Date.now() - 2_000), new Date(Date.now() - 2_000))
    // No orphanWindowMs ⇒ mtime is never consulted ⇒ loadable.
    const p = await proveTranscriptLoadable(cwd, id)
    expect(p.loadable).toBe(true)
    expect(p.reason).toBe('ok')
  })

  it('non-empty GARBAGE (no parseable JSON in the head) ⇒ not loadable (reason unparseable)', async () => {
    const id = 'eeee5555-5555-4555-8555-555555555555'
    await writeTranscript(id, '<<<binary junk>>>\nmore junk\n')
    const p = await proveTranscriptLoadable(cwd, id)
    expect(p.loadable).toBe(false)
    expect(p.reason).toBe('unparseable')
  })

  it('a BIG transcript is proven from its head only (a mid-JSON cut is not called corrupt)', async () => {
    const id = 'ffff6666-6666-4666-8666-666666666666'
    await writeTranscript(id, transcriptLine(id).repeat(4000)) // ≫ the 64KB probe window
    const p = await proveTranscriptLoadable(cwd, id)
    expect(p.loadable).toBe(true)
  })

  // The role-desk convenience wrapper is the no-orphan-window variant.
  it('isTranscriptLoadable is the boolean, no-orphan-window form', async () => {
    const id = 'aaaa7777-7777-4777-8777-777777777777'
    await writeTranscript(id)
    await expect(isTranscriptLoadable(cwd, id)).resolves.toBe(true)
    await expect(isTranscriptLoadable(cwd, 'missing-id')).resolves.toBe(false)
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, realpath, writeFile, utimes } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { claudeDirName } from './claudeProjectDir'
import { proveTranscriptLoadable, isTranscriptLoadable, ORPHAN_MTIME_WINDOW_MS } from './swarmTranscriptProof'

// swarmTranscriptProof — the SHARED transcript-loadable proof (card 4,
// ENGINE_PERSISTENCE_PLAN §5). These are the completion-condition fixtures:
//   ① a proven transcript ⇒ loadable (the --resume path),
//   ② JSONL missing / empty / orphan-fresh-mtime ⇒ NOT loadable (the fallback path).
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
    const now = 1_000_000_000_000
    // mtime 20s in the past, window 10s ⇒ now-mtime (20s) ≥ window ⇒ NOT fresh ⇒ loadable.
    const staleMs = now - 20_000
    await utimes(file, new Date(staleMs), new Date(staleMs))
    const p = await proveTranscriptLoadable(cwd, id, { now, orphanWindowMs: ORPHAN_MTIME_WINDOW_MS })
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

  it('FRESH mtime (orphan window) ⇒ not loadable (reason fresh) — the SIGKILL-orphan guard', async () => {
    const id = 'cccc3333-3333-4333-8333-333333333333'
    const file = await writeTranscript(id) // real, parseable — only the mtime disqualifies it
    const now = 1_000_000_000_000
    // mtime 2s in the past, window 10s ⇒ now-mtime (2s) < window ⇒ presumed still-being-written.
    const freshMs = now - 2_000
    await utimes(file, new Date(freshMs), new Date(freshMs))
    const p = await proveTranscriptLoadable(cwd, id, { now, orphanWindowMs: ORPHAN_MTIME_WINDOW_MS })
    expect(p.loadable).toBe(false)
    expect(p.reason).toBe('fresh')
  })

  // TEETH for the orphan guard: the SAME fresh transcript, but with NO orphan window,
  // is loadable — so the window is exactly what makes a fresh transcript fall back.
  // MUTATION: delete the `if (opts.orphanWindowMs !== undefined)` block in
  // proveTranscriptLoadable and the FRESH test above flips to loadable ⇒ that test
  // goes RED. (This asserts the "still loadable without the window" half so the two
  // together pin the guard as load-bearing.)
  it('TEETH: a fresh transcript is loadable when the orphan window is OFF (role-desk path)', async () => {
    const id = 'dddd4444-4444-4444-8444-444444444444'
    const file = await writeTranscript(id)
    const now = 1_000_000_000_000
    await utimes(file, new Date(now - 2_000), new Date(now - 2_000))
    // No orphanWindowMs ⇒ mtime is never consulted ⇒ loadable.
    const p = await proveTranscriptLoadable(cwd, id, { now })
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

// When does /api/sdk-session/:id/stream say `end`? — the liveness seam, at the
// one place the OWNER actually looks.
//
// `end` is a promise to the tile: nothing more will arrive, stop rendering,
// close the EventSource (SdkWorkerPane does exactly that). So it may be sent for
// one reason only — the session has been REAPED, i.e. the pump's async iterator
// has returned. It must NOT be sent because a terminal STATUS was written:
// `terminateSdkSession` writes 'exited' synchronously, it only ASKS the CLI to
// stop, and the CLI keeps talking afterwards — the aborted turn's own result,
// the last tool results, the exit reason. Those are precisely the frames that
// say HOW the desk ended, and a status-judged `end` threw them away while the
// Swarm list on the same screen (which counts `!reaped`) still drew the desk as
// running: one screen, two answers, about one desk.
//
// The fixture is a HAND-DRIVEN fake CLI rather than a scripted generator,
// because the whole subject is the window between "we asked" and "it let go" —
// a fixture that returns as soon as its script runs out has no such window and
// certifies nothing. No real `claude` is spawned (an isolated HOME cannot
// authenticate; queryFn is injected, as everywhere in this suite).
//
// ── WHAT EACH TEST BELOW ACTUALLY CATCHES (re-measured 2026-08-01) ───────────
//
// The commit that introduced this file claimed all seven guards went red
// against the pre-fix code. THAT WAS FALSE, and the number is written down here
// so nobody has to re-derive it. Reverting all four production hunks at once
// (routes/sdkSession.ts: endIfFinished's predicate, the every-frame ask, the
// pre-attach check; sdkSession.ts: announceStatus in the pump's finally) gives
// `4 failed | 3 passed`.
//
//   RED — these are the guards for the reap-vs-status defect:
//     • keeps an ATTACHED stream open across a terminate
//     • does NOT `end` a stream attached WHILE the stop is still unwinding
//     • the pool is ALREADY reaped when it announces the terminal status
//     • announces the reap even though terminate already wrote the SAME status
//
//   GREEN — and correctly so. They are NON-REGRESSION guards: the fix must not
//   make an ending slower, and they pass before it because it did not. They are
//   kept, but each now names the mutation it DOES catch, measured, so that
//   "green against the pre-fix code" is never again read as "guards nothing":
//     • ends AT ONCE for a session that is really gone  → the pre-attach check
//     • ends promptly for a session that finishes on its own → the ask in `send`
//     • isSdkSessionAlive has no production callers → a future caller, not a past
//       one; it was green before because the pre-fix route inlined the same
//       status comparison by hand instead of calling it.
//
// The one production hunk with NO guard at all — widening `send`'s ask from
// terminal-status frames to every frame — is argued at its own site in
// routes/sdkSession.ts: reverting it is currently unobservable because every
// path that sets `reaped` announces it with a terminal status frame. Do not
// "fix" that by writing a test that cannot fail.
//
// ── AND NOTHING HERE WAITS OUT A CLOCK ──────────────────────────────────────
//
// The non-events ("no `end` arrives") were asserted with 200ms / 300ms quiet
// windows. vitest.config.ts records, from measurement, that I/O tests in this
// repo stretch 14-20x under CPU contention — which is the NORMAL state here,
// since the swarm keeps claude workers running while a suite is verified. A
// fixed window under those conditions is a coin toss that lands on green.
// Both are now BARRIERS: push one more frame and wait for IT. `end` closes this
// stream (closeAll → the handler returns), so a frame delivered afterwards is
// positive proof that no `end` was sent — an event, not a stopwatch.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, realpath, mkdir, readdir, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { app } from '../../app'
import { registerTestProject } from '../../../src/test/registerProject'
import {
  attachSdkListener,
  getSdkSession,
  isSdkSessionReaped,
  spawnSdkSession,
  terminateSdkSession,
  __resetSdkSessionsForTests,
  __setQuotaPrefixesForTests,
  type SdkQueryFn,
} from '@/lib/server/sdkSession'
import { projectUUIDFromPath } from '@/lib/server/projectDataPath'
import { centralWorktreesDir } from '@/lib/server/paths'

// ── a CLI we can hold open ───────────────────────────────────────────────────

interface FakeCli {
  query: SdkQueryFn
  /** Deliver one raw SDK message (what the CLI says). */
  push: (msg: unknown) => void
  /** The CLI process is finally gone — the iterator returns, the pump reaps. */
  finish: () => void
}

const makeFakeCli = (): FakeCli => {
  const queued: unknown[] = []
  let wake: (() => void) | null = null
  let done = false
  const bump = () => {
    const w = wake
    wake = null
    w?.()
  }
  return {
    push: (msg) => {
      queued.push(msg)
      bump()
    },
    finish: () => {
      done = true
      bump()
    },
    query: ({ prompt }) => {
      // Drain the pool's input generator the way the SDK does. Without this the
      // generator parks forever and `terminateSdkSession`'s wake-with-null (the
      // thing that normally unwinds an idle desk) has nobody listening.
      void (async () => {
        for await (const _m of prompt) void _m
      })()
      return {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            if (queued.length) {
              yield queued.shift()!
              continue
            }
            if (done) return
            await new Promise<void>((r) => (wake = r))
          }
        },
        // Fire-and-forget, exactly like the real one: an interrupt does not end
        // the stream, it makes the CLI deliver an aborted result WHEN IT GETS
        // THERE. The test pushes that result itself, at the moment it chooses.
        interrupt: async () => {},
      }
    },
  }
}

// ── SSE reading ──────────────────────────────────────────────────────────────

type Reader = ReadableStreamDefaultReader<Uint8Array>
const dec = new TextDecoder()

const readStep = (r: Reader, ms: number): Promise<ReadableStreamReadResult<Uint8Array> | 'timeout'> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve('timeout'), ms)
    r.read().then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })

/** A reader plus the RUNNING transcript of everything it has produced.
 *
 *  Accumulating matters for the non-event assertions: `end` may well arrive in
 *  the same chunk as, or ahead of, the frame being waited for, so judging one
 *  chunk would miss it. Every assertion below is made over `all()`.
 *
 *  A timeout and a closed stream are reported DIFFERENTLY on purpose: "the
 *  server never said it" and "the server hung up first" are different defects,
 *  and both texts carry the bytes that did arrive so a failure is readable. */
const tailOf = (r: Reader) => {
  let seen = ''
  return {
    all: () => seen,
    /** Read until `pred` holds over the whole transcript. `ms` is a FAILURE
     *  deadline, never a success criterion — every passing use of it returns as
     *  soon as the bytes arrive, so load only affects how long a genuine
     *  failure takes to report. */
    until: async (pred: (seen: string) => boolean, ms = 5_000): Promise<string> => {
      const deadline = Date.now() + ms
      for (;;) {
        if (pred(seen)) return seen
        const left = deadline - Date.now()
        if (left <= 0) throw new Error(`SSE timeout. seen:\n${seen}`)
        const step = await readStep(r, left)
        if (step === 'timeout') throw new Error(`SSE timeout. seen:\n${seen}`)
        if (step.done) {
          if (pred(seen)) return seen
          throw new Error(`SSE closed before the expected event. seen:\n${seen}`)
        }
        seen += dec.decode(step.value, { stream: true })
      }
    },
  }
}
type Tail = ReturnType<typeof tailOf>

const settle = () => new Promise((r) => setTimeout(r, 10))

const assistantText = (text: string) => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text }] },
})

describe('/api/sdk-session/:id/stream — `end` follows the REAP, not the status', () => {
  let projectPath: string
  let scratch: string
  let worktree: string
  let cli: FakeCli
  let sessionId: string
  const openReaders: Reader[] = []

  beforeEach(async () => {
    __resetSdkSessionsForTests()
    __setQuotaPrefixesForTests([])
    scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-sdkstream-')))
    projectPath = join(scratch, 'proj')
    await mkdir(projectPath, { recursive: true })
    await registerTestProject(projectPath)
    // The production arrangement: a worker runs in the project's CENTRAL
    // worktree, outside the repo.
    worktree = join(centralWorktreesDir(await projectUUIDFromPath(projectPath)), 'wt1')
    await mkdir(worktree, { recursive: true })

    cli = makeFakeCli()
    sessionId = spawnSdkSession({
      cwd: worktree,
      role: 'worker',
      options: {},
      initialPrompt: 'go',
      queryFn: cli.query,
    }).id
    cli.push(assistantText('on it'))
    await settle()
  })

  afterEach(async () => {
    // Let every held-open pump unwind before the pool is cleared, so no fake CLI
    // outlives its test.
    cli.finish()
    await settle()
    for (const r of openReaders.splice(0)) await r.cancel().catch(() => {})
    __resetSdkSessionsForTests()
    __setQuotaPrefixesForTests(null)
    await rm(scratch, { recursive: true, force: true })
  })

  const openStream = async (): Promise<Tail> => {
    const res = await app.request(
      `/api/sdk-session/${sessionId}/stream?path=${encodeURIComponent(projectPath)}`,
    )
    expect(res.status).toBe(200)
    const r = res.body!.getReader()
    openReaders.push(r)
    return tailOf(r)
  }

  /** THE NON-EVENT BARRIER. Say one more thing and wait to hear it back.
   *
   *  `end` closes this stream — the route's closeAll detaches the listener and
   *  lets the handler return — so a frame that makes the round trip AFTER the
   *  moment under suspicion is positive proof that no `end` was sent up to that
   *  moment. If one was, this call fails as "SSE closed before the expected
   *  event" (listener gone) or as a timeout (frames dropped), both of which
   *  print the bytes that did arrive.
   *
   *  Called only after an awaited read, i.e. from a later macrotask than the
   *  frame whose handling is being judged — so the route's decision chain for
   *  that frame (a `.then` on the write promise) has already run. */
  const barrier = async (t: Tail, mark: string): Promise<string> => {
    cli.push(assistantText(mark))
    return t.until((s) => s.includes(mark))
  }

  it('keeps an ATTACHED stream open across a terminate, and delivers the frames that follow it', async () => {
    const t = await openStream()
    await t.until((s) => s.includes('event: init'))

    // The owner stops the desk. Status flips to 'exited' SYNCHRONOUSLY here —
    // that is the trap. The claude behind it has not gone anywhere.
    terminateSdkSession(sessionId)
    expect(getSdkSession(sessionId)!.status).toBe('exited')
    expect(isSdkSessionReaped(sessionId)).toBe(false)

    // …and now the CLI says how the turn actually ended. Judged on status, the
    // stream had already sent `end` and closed itself, so this frame — the one
    // piece of evidence about the stop — was written into a dead socket.
    cli.push({ type: 'result', subtype: 'success', terminal_reason: 'aborted_streaming', is_error: false })
    await t.until((s) => s.includes('aborted_streaming'))
    // …then the barrier. Not a quiet window: if the terminate's status frame had
    // ended this stream, the listener is already detached and THIS never arrives.
    await barrier(t, 'still-talking-after-the-stop')
    expect(t.all()).not.toContain('event: end')

    // Only when the process is really gone.
    cli.finish()
    const seen = await t.until((s) => s.includes('event: end'))
    // The payload must carry the reaped session, not a status guess — the tile
    // reads its final state out of it.
    expect(seen).toContain('"reaped":true')
  })

  it('does NOT `end` a stream attached WHILE the stop is still unwinding', async () => {
    terminateSdkSession(sessionId)
    cli.push({ type: 'result', subtype: 'success', terminal_reason: 'aborted_streaming', is_error: false })
    await settle()
    expect(isSdkSessionReaped(sessionId)).toBe(false)

    // A tile re-mounted during the teardown (the owner reopens the tab). The
    // status-judged pre-check answered with an instant `end`, so the reopened
    // tile went blank while the desk was still writing files.
    const t = await openStream()
    await t.until((s) => s.includes('event: init'))
    // The pre-check runs BEFORE the heartbeat is armed and then returns, so a
    // wrong answer here closes the stream outright — which is exactly what the
    // barrier detects, and it detects it as a hang-up rather than as silence.
    await barrier(t, 'desk-is-still-writing-files')
    expect(t.all()).not.toContain('event: end')
  })

  // ⚠ NON-REGRESSION, NOT THE DEFECT. Measured 2026-08-01: this passes against
  // the pre-fix code too — the status-judged version also ended at once here,
  // because this session is BOTH terminal-status and reaped. What it does catch
  // (measured, by deleting the pre-attach check in routes/sdkSession.ts): a
  // stream that attaches to an already-finished session and is left hanging,
  // which is a 25s stall for every tile the owner opens on a done worker.
  it('ends AT ONCE for a session that is really gone — no heartbeat wait', async () => {
    // The other half of the same claim: moving the predicate to `reaped` must
    // not make anything slower. The pump sets `reaped` BEFORE it announces the
    // terminal status, so a finished session is finished from the first read.
    terminateSdkSession(sessionId)
    cli.finish()
    await settle()
    expect(isSdkSessionReaped(sessionId)).toBe(true)

    const t = await openStream()
    // The deadline is ≪ the route's 25s heartbeat: a heartbeat-only `end`
    // cannot pass this even when the machine is 5x oversubscribed.
    const seen = await t.until((s) => s.includes('event: end'))
    expect(seen).toContain('"reaped":true')
  })

  // ⚠ NON-REGRESSION, NOT THE DEFECT — same note as above. What it does catch
  // (measured, by deleting the `endIfFinished()` call inside `send`): a session
  // that finishes while a tile is watching, where the news arrives as a frame
  // and nothing acts on it, so the tile keeps drawing a finished worker as live
  // until the next heartbeat.
  it('ends promptly for a session that finishes on its own while attached', async () => {
    const t = await openStream()
    await t.until((s) => s.includes('event: init'))
    cli.push({ type: 'result', subtype: 'success', terminal_reason: 'completed', is_error: false })
    cli.finish()
    const seen = await t.until((s) => s.includes('event: end'))
    expect(seen).toContain('"status":"exited"')
  })

  // ── the invariant the route stands on ──────────────────────────────────────

  it('the pool is ALREADY reaped when it announces the terminal status', async () => {
    // The route ends its stream from a listener callback, by re-reading the
    // pool. If `reaped` were set after the announcement, that listener would
    // look up a session that is not reaped yet, keep the stream open, and never
    // hear about it again — the 25s lag the announcement exists to remove.
    // Order, not just presence, is what makes this correct.
    const at: boolean[] = []
    attachSdkListener(sessionId, 0, (f) => {
      if (f.ev.kind === 'status' && (f.ev.status === 'exited' || f.ev.status === 'failed'))
        at.push(isSdkSessionReaped(sessionId))
    })
    terminateSdkSession(sessionId) // announcement #1: asked to stop, NOT reaped
    cli.finish()
    await settle()
    expect(at[0]).toBe(false)
    expect(at[at.length - 1]).toBe(true)
  })

  it('announces the reap even though terminate already wrote the SAME status', async () => {
    // setStatus dedupes, so the pump's terminal write was a no-op on this path
    // and the reap produced NO frame at all. Every stream reader then had
    // nothing to react to — the defect is invisible in a status-keyed test,
    // which is why this one counts FRAMES.
    const terminal: string[] = []
    attachSdkListener(sessionId, 0, (f) => {
      if (f.ev.kind === 'status' && (f.ev.status === 'exited' || f.ev.status === 'failed'))
        terminal.push(f.ev.status)
    })
    terminateSdkSession(sessionId)
    await settle()
    expect(terminal).toEqual(['exited']) // only the request so far
    cli.finish()
    await settle()
    expect(terminal).toEqual(['exited', 'exited']) // …and the reap says so too
  })
})

// ── the dead predicate stays dead ────────────────────────────────────────────

describe('isSdkSessionAlive has no production callers', () => {
  // It reads `status`, so it answers "did anyone ask this session to stop",
  // never "is the claude behind it gone". Nine seams reached for it by name and
  // every one was a silent defect. It survives only because two suites pin the
  // trap with it; this guard fails the moment PRODUCTION code names it again.
  //
  // ⚠ THE ROOTS ARE PART OF THE GUARD. It walked only src/ and server/, so the
  // two trees that ALSO ship — electron/ (the shell that forks the server) and
  // scripts/ (build + the .mts probes and one-shot tools the owner runs against
  // a live pool) — could name the trap and this would still be green. A pin
  // that covers some of production reports the same thing as a pin that covers
  // all of it, right up until it matters. The extension list is widened for the
  // same reason: electron/main.js is .js, and a guard that only reads
  // TypeScript would not have seen it.
  const SKIP = new Set(['node_modules', 'dist', 'dist-web', '.git', 'coverage'])
  const ROOTS = ['src', 'server', 'electron', 'scripts']

  const walk = async (dir: string): Promise<string[]> => {
    const out: string[] = []
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      if (SKIP.has(ent.name)) continue
      const p = join(dir, ent.name)
      if (ent.isDirectory()) out.push(...(await walk(p)))
      else if (
        /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(ent.name) &&
        !/\.(test|spec)\.(ts|tsx|js|jsx|mts|mjs)$/.test(ent.name)
      )
        out.push(p)
    }
    return out
  }

  /** Prose does not count — several files name it in a warning comment ON
   *  PURPOSE, and a guard that cannot tell a warning from a call would be
   *  deleted the first time somebody documented the trap properly. */
  const code = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  it('is named by no production file except its own declaration', async () => {
    const repo = join(__dirname, '..', '..', '..')
    const decl = join(repo, 'src', 'lib', 'server', 'sdkSession.ts')
    const offenders: string[] = []
    const scanned: Record<string, number> = {}
    for (const root of ROOTS) {
      const files = await walk(join(repo, root))
      scanned[root] = files.length
      for (const file of files) {
        const body = code(await readFile(file, 'utf8'))
        if (!/\bisSdkSessionAlive\b/.test(body)) continue
        // In the defining file the declaration itself is expected; a CALL is not.
        if (file === decl && !/\bisSdkSessionAlive\s*\(/.test(body)) continue
        offenders.push(file.slice(repo.length + 1))
      }
    }
    expect(offenders).toEqual([])
    // …and the walk must have actually walked. A renamed or emptied root would
    // otherwise shrink this guard's reach in total silence — the exact failure
    // mode that let electron/ and scripts/ sit outside it unnoticed.
    for (const root of ROOTS) expect(`${root}:${scanned[root] > 0}`).toBe(`${root}:true`)
  })
})

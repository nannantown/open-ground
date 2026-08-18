import { describe, it, expect } from 'vitest'
import { liveWorkForProject, readGroundLamps } from './groundLamps'
import { groundLamp } from '@/lib/groundLamp'
import type { ActiveTerminalsResponse, GroundLampRow, SwarmWorkerRecord } from '@/lib/types'

// The Ground lamp's SERVER half: gather three facts per project without ever
// throwing, and — the part that keeps being got wrong across this codebase —
// keep "could not read" distinct from "nothing there" on the way out.
//
// Every case drives the real `readGroundLamps` through its DI seams and reads
// the RESULT. The verdict itself belongs to the pure `groundLamp()` (guarded in
// src/lib/groundLamp.test.ts); what is measured here is what this module hands
// it, plus the one behaviour that is this module's alone: the short-circuit that
// keeps the expensive liveness read off a project with nothing started.

const P = [
  { id: 'uuid-a', path: '/repo/a' },
  { id: 'uuid-b', path: '/repo/b' },
]

const row = (lamps: GroundLampRow[], id: string): GroundLampRow =>
  lamps.find((l) => l.projectId === id)!

describe('readGroundLamps — one row per registered project', () => {
  it('carries the started count, the open questions and the liveness', async () => {
    const { lamps } = await readGroundLamps({
      projects: async () => P,
      startedFor: async (p) => (p === '/repo/a' ? 2 : 0),
      openQuestions: async () => new Map([['/repo/a', 3]]),
      liveWorkFor: async () => true,
    })
    expect(lamps).toHaveLength(2)
    expect(row(lamps, 'uuid-a')).toEqual({
      projectId: 'uuid-a',
      started: 2,
      openQuestions: 3,
      liveWork: true,
    })
    // A project the inbox never mentions has ZERO questions — that is a real
    // measurement, because the inbox itself was read.
    expect(row(lamps, 'uuid-b').openQuestions).toBe(0)
  })

  it('an UNREADABLE board leaves `started` absent — never 0', async () => {
    // ⚠ A 0 here reaches the client as "this project has nothing in flight",
    // which is a claim about a board nobody managed to open. The client skips a
    // row with no count rather than drawing a dark card off it.
    const { lamps } = await readGroundLamps({
      projects: async () => P,
      startedFor: async (p) => (p === '/repo/a' ? undefined : 1),
      openQuestions: async () => new Map(),
      liveWorkFor: async () => false,
    })
    const a = row(lamps, 'uuid-a')
    expect(a.started).toBeUndefined()
    expect('started' in a).toBe(false)
    expect(row(lamps, 'uuid-b').started).toBe(1)
  })

  it('an UNREADABLE inbox leaves `openQuestions` absent on EVERY row', async () => {
    // Same rule, the other file. `null` from the counter is not an empty map:
    // reporting 0 would say "nothing is waiting for you" out of a file that
    // could not be opened.
    const { lamps } = await readGroundLamps({
      projects: async () => P,
      startedFor: async () => 1,
      openQuestions: async () => null,
      liveWorkFor: async () => false,
    })
    for (const l of lamps) {
      expect('openQuestions' in l, l.projectId).toBe(false)
    }
  })

  it('does NOT go looking for live work when nothing is started', async () => {
    // The short-circuit is what makes this cheap enough to poll: the liveness
    // read touches the worker registry (heartbeat files, git), and a project
    // with no started cards is dark whatever it finds.
    const asked: string[] = []
    const { lamps } = await readGroundLamps({
      projects: async () => P,
      startedFor: async (p) => (p === '/repo/a' ? 1 : 0),
      openQuestions: async () => new Map(),
      liveWorkFor: async (p) => {
        asked.push(p)
        return true
      },
    })
    expect(asked).toEqual(['/repo/a'])
    expect(row(lamps, 'uuid-b').liveWork).toBe(false)
  })

  it('does not go looking over an unreadable board either', async () => {
    const asked: string[] = []
    await readGroundLamps({
      projects: async () => P,
      startedFor: async () => undefined,
      openQuestions: async () => new Map(),
      liveWorkFor: async (p) => {
        asked.push(p)
        return true
      },
    })
    expect(asked).toEqual([])
  })
})

describe('readGroundLamps — it never throws, whatever fails', () => {
  it('a failing liveness read costs that one project its liveWork, nothing else', async () => {
    const { lamps } = await readGroundLamps({
      projects: async () => P,
      startedFor: async () => 1,
      openQuestions: async () => new Map(),
      liveWorkFor: async (p) => {
        if (p === '/repo/a') throw new Error('git exploded')
        return true
      },
    })
    expect(row(lamps, 'uuid-a').liveWork).toBe(false)
    expect(row(lamps, 'uuid-b').liveWork).toBe(true)
  })

  it('a failing inbox read is the same as an unreadable one', async () => {
    const { lamps } = await readGroundLamps({
      projects: async () => P,
      startedFor: async () => 1,
      openQuestions: async () => {
        throw new Error('EIO')
      },
      liveWorkFor: async () => false,
    })
    expect(lamps).toHaveLength(2)
    expect('openQuestions' in row(lamps, 'uuid-a')).toBe(false)
  })

  it('a failing registry read answers with no lamps rather than a 500', async () => {
    expect(
      await readGroundLamps({
        projects: async () => {
          throw new Error('settings unreadable')
        },
      }),
    ).toEqual({ lamps: [] })
  })
})

describe('the rows drive the lamp the owner asked for', () => {
  // End to end through the SAME pure function the screen calls, so this file
  // proves the wire carries what that function needs — not merely that the
  // fields have the right names.
  const lampFor = (r: GroundLampRow) =>
    r.started === undefined
      ? null
      : groundLamp({
          started: r.started,
          ...(r.openQuestions === undefined ? {} : { openQuestions: r.openQuestions }),
          liveWork: r.liveWork,
        })

  it('every task done ⇒ the card is DARK, desks or no desks', async () => {
    const { lamps } = await readGroundLamps({
      projects: async () => [P[0]],
      startedFor: async () => 0,
      openQuestions: async () => new Map(),
      liveWorkFor: async () => true,
    })
    expect(lampFor(lamps[0])).toBeNull()
  })

  it('a card in doing with a worker on it ⇒ running', async () => {
    const { lamps } = await readGroundLamps({
      projects: async () => [P[0]],
      startedFor: async () => 1,
      openQuestions: async () => new Map(),
      liveWorkFor: async () => true,
    })
    expect(lampFor(lamps[0])).toBe('working')
  })

  it('a card in doing with nothing moving it ⇒ NO lamp (owner amendment, 2026-08-18)', async () => {
    // 「waitingは僕が何かをしないといけない時にだけ出しましょう」 — idle work is
    // the machine's problem; only a question in the inbox is the owner's.
    const { lamps } = await readGroundLamps({
      projects: async () => [P[0]],
      startedFor: async () => 1,
      openQuestions: async () => new Map(),
      liveWorkFor: async () => false,
    })
    expect(lampFor(lamps[0])).toBeNull()
  })

  it('an open question ⇒ waiting, even while the swarm runs', async () => {
    const { lamps } = await readGroundLamps({
      projects: async () => [P[0]],
      startedFor: async () => 1,
      openQuestions: async () => new Map([['/repo/a', 1]]),
      liveWorkFor: async () => true,
    })
    expect(lampFor(lamps[0])).toBe('waiting')
  })
})

// ─── liveWorkForProject — what counts as the project ACTUALLY moving ────────
//
// Owner, 2026-08-17, on a card stamped RUNNING beside a strip saying 稼働0:
// 「補給官の動きはrunning扱いじゃなくてもいいかも」. The supply desk wakes every
// few minutes to read the Board, its PTY paints for a few seconds, and the lamp
// counted that housekeeping as the project working. These cases pin the rule
// through the production arm's own seams: desks never count; workers and the
// owner's own pane mid-generation still do.
describe('liveWorkForProject — desks are machinery, not project work', () => {
  const canon = async (p: string) => p
  const worker = (over: Partial<SwarmWorkerRecord> = {}): SwarmWorkerRecord => ({
    worktree: '/home/u/.openground/projects/uuid-a/worktrees/w1',
    branch: 'swarm/card-1',
    ...over,
  })
  const desks = (claude: ActiveTerminalsResponse['claude']): (() => ActiveTerminalsResponse) =>
    () => ({ cwds: claude.map((c) => c.cwd), claude })

  it('a swarm worker holding a live handle counts — either runtime', async () => {
    expect(
      await liveWorkForProject('/repo/a', {
        listWorkers: async () => [worker({ sdkSessionId: 'sdk-1' })],
        listDesks: desks([]),
        canon,
      }),
    ).toBe(true)
    expect(
      await liveWorkForProject('/repo/a', {
        listWorkers: async () => [worker({ terminalId: 't-1' })],
        listDesks: desks([]),
        canon,
      }),
    ).toBe(true)
  })

  it("the SUPPLY DESK mid-pass does NOT count — the owner's own report", async () => {
    expect(
      await liveWorkForProject('/repo/a', {
        listWorkers: async () => [],
        listDesks: desks([{ id: 'pty-supply', cwd: '/repo/a', status: 'working', desk: true }]),
        canon,
      }),
    ).toBe(false)
  })

  it("…while the owner's OWN pane mid-generation still does", async () => {
    expect(
      await liveWorkForProject('/repo/a', {
        listWorkers: async () => [],
        listDesks: desks([{ id: 'pty-own', cwd: '/repo/a', status: 'working' }]),
        canon,
      }),
    ).toBe(true)
  })

  it('a pane parked at its prompt never counts, desk or not', async () => {
    expect(
      await liveWorkForProject('/repo/a', {
        listWorkers: async () => [],
        listDesks: desks([
          { id: 'p1', cwd: '/repo/a', status: 'waiting' },
          { id: 'p2', cwd: '/repo/a', status: 'waiting', desk: true },
        ]),
        canon,
      }),
    ).toBe(false)
  })

  it("another project's working pane does not leak in", async () => {
    expect(
      await liveWorkForProject('/repo/a', {
        listWorkers: async () => [],
        listDesks: desks([{ id: 'p1', cwd: '/repo/b', status: 'working' }]),
        canon,
      }),
    ).toBe(false)
  })

  it('a worker holding NO handle (dead, heartbeat only) does not count on its own', async () => {
    expect(
      await liveWorkForProject('/repo/a', {
        listWorkers: async () => [worker()],
        listDesks: desks([]),
        canon,
      }),
    ).toBe(false)
  })
})

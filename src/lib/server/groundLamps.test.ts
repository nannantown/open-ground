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

  it('an open question ⇒ question, even while the swarm runs', async () => {
    const { lamps } = await readGroundLamps({
      projects: async () => [P[0]],
      startedFor: async () => 1,
      openQuestions: async () => new Map([['/repo/a', 1]]),
      liveWorkFor: async () => true,
    })
    expect(lampFor(lamps[0])).toBe('question')
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

  // A worker's worktree lives under the central data dir, never under the
  // project path — so a worker is attributed by its HANDLE's id in the pools,
  // not by cwd. These fixtures keep that distance deliberately.
  const wt = worker().worktree

  it('a swarm worker counts while its session is WORKING — either runtime', async () => {
    // Rewritten 2026-09-17. This case used to pass on the handle alone
    // (`desks([])`): "a handle is written only while the runtime is alive" had
    // been read as "…only while the worker is working". Measured on sns-hub: an
    // SDK worker that had FINISHED (heartbeat phase done, ready:true, last beat
    // 3.5 h earlier) stays resident in the pool until the commander integrates
    // it, so its handle was live and the Ground card said RUNNING over a project
    // where nothing moved — the owner asked 「なぜrunningになっている?」 twice.
    // Alive is not working. The pane's status, the same verdict the owner's own
    // pane is judged by in the cases below, is the evidence now.
    expect(
      await liveWorkForProject('/repo/a', {
        listWorkers: async () => [worker({ sdkSessionId: 'sdk-1' })],
        listDesks: desks([{ id: 'sdk-1', cwd: wt, status: 'working' }]),
        canon,
      }),
    ).toBe(true)
    expect(
      await liveWorkForProject('/repo/a', {
        listWorkers: async () => [worker({ terminalId: 't-1' })],
        listDesks: desks([{ id: 't-1', cwd: wt, status: 'working' }]),
        canon,
      }),
    ).toBe(true)
  })

  it('a worker whose session is resident but PARKED does not count — the sns-hub RUNNING report (2026-09-17)', async () => {
    // 'waiting' = its turn is over (finished and awaiting integration, or asking
    // something — which reaches the owner through the escalation inbox, the
    // surface groundLamp() already ranks first). 'idle' = quiet for long enough
    // that nothing is being generated. Neither is the project moving.
    for (const status of ['waiting', 'idle'] as const) {
      expect(
        await liveWorkForProject('/repo/a', {
          listWorkers: async () => [worker({ sdkSessionId: 'sdk-1' })],
          listDesks: desks([{ id: 'sdk-1', cwd: wt, status }]),
          canon,
        }),
      ).toBe(false)
      expect(
        await liveWorkForProject('/repo/a', {
          listWorkers: async () => [worker({ terminalId: 't-1' })],
          listDesks: desks([{ id: 't-1', cwd: wt, status }]),
          canon,
        }),
      ).toBe(false)
    }
  })

  it('a worker whose handle is in NEITHER pool does not count — the registry said so, the pools did not', async () => {
    // The registry's record is the claim; the pools are the evidence. A handle
    // no pool can vouch for (a roster row outliving its session, a fake-deps
    // registry) must not light the lamp on its own.
    expect(
      await liveWorkForProject('/repo/a', {
        listWorkers: async () => [worker({ sdkSessionId: 'sdk-1' })],
        listDesks: desks([]),
        canon,
      }),
    ).toBe(false)
    expect(
      await liveWorkForProject('/repo/a', {
        listWorkers: async () => [worker({ terminalId: 't-1' })],
        listDesks: desks([]),
        canon,
      }),
    ).toBe(false)
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

describe('the president (supply desk) — owner decision 2026-09-25', () => {
  const pane = (id: string, cwd: string, status: 'working' | 'waiting') => ({ id, cwd, status, desk: true })
  const desks =
    (claude: ReturnType<typeof pane>[]): (() => ActiveTerminalsResponse) =>
    () => ({ cwds: claude.map((c) => c.cwd), claude })

  it('only a president that is GENERATING is reported — never the commander', async () => {
    const { presidentWorkingCwds } = await import('./groundLamps')
    const cwds = presidentWorkingCwds({
      presidentIds: () => new Set(['pty-sup', 'sdk-sup']),
      listDesks: desks([
        pane('pty-sup', '/repo/a', 'working'),
        pane('pty-mgr', '/repo/b', 'working'), // commander: still discounted
        pane('sdk-sup', '/repo/c', 'working'),
        pane('sdk-mgr', '/repo/d', 'working'),
      ]),
    })
    expect(cwds.sort()).toEqual(['/repo/a', '/repo/c'])
  })

  it('an IDLE president (at its prompt) is not reported', async () => {
    const { presidentWorkingCwds } = await import('./groundLamps')
    expect(
      presidentWorkingCwds({
        presidentIds: () => new Set(['pty-sup', 'sdk-sup']),
        listDesks: desks([pane('pty-sup', '/repo/a', 'waiting'), pane('sdk-sup', '/repo/a', 'waiting')]),
      }),
    ).toEqual([])
  })

  it('end to end: president generating ⇒ working even with nothing started; idle ⇒ dark', async () => {
    const lampOf = async (cwds: string[]) => {
      const { lamps } = await readGroundLamps({
        projects: async () => P,
        startedFor: async () => 0,
        openQuestions: async () => new Map(),
        liveWorkFor: async () => false,
        presidentWorkingCwds: () => cwds,
      })
      return lamps.map((r) =>
        groundLamp({
          started: r.started,
          openQuestions: r.openQuestions,
          liveWork: r.liveWork,
          presidentWorking: r.presidentWorking === true,
        }),
      )
    }
    expect(await lampOf(['/repo/a'])).toEqual(['working', null])
    expect(await lampOf([])).toEqual([null, null])
  })
})

describe('readGroundLamps — the question / review timestamps (2026-09-26)', () => {
  const base = {
    projects: async () => [P[0]],
    startedFor: async () => 0,
    openQuestions: async () => new Map(),
    liveWorkFor: async () => false,
    presidentWorkingCwds: () => [],
  }

  it('carries presidentAskedAt / deliveredAt / seenAt through to the row', async () => {
    const { lamps } = await readGroundLamps({
      ...base,
      presidentAskedAtFor: async () => 30,
      deliveredAtFor: async () => 20,
      seenAtFor: async () => 10,
    })
    expect(lamps[0]).toMatchObject({ presidentAskedAt: 30, deliveredAt: 20, seenAt: 10 })
    expect(
      groundLamp({ started: 0, liveWork: false, presidentAskedAt: 30, deliveredAt: 20, seenAt: 10 }),
    ).toBe('question')
  })

  it('an unreadable / throwing reader leaves the field ABSENT, never a number', async () => {
    const { lamps } = await readGroundLamps({
      ...base,
      presidentAskedAtFor: async () => {
        throw new Error('boom')
      },
      deliveredAtFor: async () => undefined,
      seenAtFor: async () => {
        throw new Error('boom')
      },
    })
    expect(lamps[0]).not.toHaveProperty('presidentAskedAt')
    expect(lamps[0]).not.toHaveProperty('deliveredAt')
    expect(lamps[0]).not.toHaveProperty('seenAt')
  })
})

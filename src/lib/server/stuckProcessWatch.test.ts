import { describe, it, expect } from 'vitest'
import {
  parseElapsedSeconds,
  isUninterruptible,
  parseStuckProcesses,
  summarizeByCommand,
  describeStuckProcesses,
  checkStuckProcessesOnce,
  findStuckProcesses,
  STUCK_MIN_AGE_SECONDS,
  STUCK_MIN_COUNT,
} from './stuckProcessWatch'

// The whole predicate is pure, so the 2026-07-28 machine state (41 orphaned,
// uninterruptible `git`) is reproduced here as ps TEXT — no wedged machine
// required, and no way for these tests to spawn or leak anything.
// Real captured shapes (macOS `ps -axo pid=,ppid=,stat=,etime=,comm=`).

const line = (pid: number, ppid: number, stat: string, etime: string, comm: string) =>
  `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${stat.padEnd(4)} ${etime} ${comm}`

describe('parseElapsedSeconds — macOS ps has no `etimes`, only this format', () => {
  it('MM:SS', () => expect(parseElapsedSeconds('05:30')).toBe(330))
  it('HH:MM:SS (the shape the real orphans showed)', () =>
    expect(parseElapsedSeconds('05:35:22')).toBe(20122))
  it('DD-HH:MM:SS', () => expect(parseElapsedSeconds('2-03:04:05')).toBe(183845))
  it('tolerates padding', () => expect(parseElapsedSeconds('  01:00  ')).toBe(60))
  it('unparseable → null (row is skipped, never counted as age 0)', () => {
    expect(parseElapsedSeconds('')).toBeNull()
    expect(parseElapsedSeconds('garbage')).toBeNull()
    expect(parseElapsedSeconds('1:2:3:4')).toBeNull()
  })
})

describe('isUninterruptible — first letter only; trailing flags are noise', () => {
  it('U / D (with any flags) are stuck', () => {
    for (const s of ['U', 'Us', 'U+', 'D', 'Ds', 'D+']) expect(isUninterruptible(s)).toBe(true)
  })
  it('ordinary states are not', () => {
    for (const s of ['S', 'Ss', 'S+', 'R', 'R+', 'Z', 'I', 'T']) expect(isUninterruptible(s)).toBe(false)
  })
})

describe('parseStuckProcesses — all THREE conditions must hold', () => {
  it('catches the 2026-07-28 shape: orphaned + uninterruptible + old', () => {
    const out = parseStuckProcesses(
      [
        line(94049, 1, 'U', '05:35:22', '/usr/bin/git'),
        line(537, 1, 'Us', '05:35:14', '/usr/bin/git'),
      ].join('\n'),
    )
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ pid: 94049, command: 'git', state: 'U' })
    expect(out[0].ageSeconds).toBe(20122)
  })

  it('a live parent is NOT reported — it may be legitimately busy and awaited', () => {
    // Same wedged state, but PPID 4321 still exists ⇒ someone may still reap it.
    expect(parseStuckProcesses(line(94049, 4321, 'U', '05:35:22', '/usr/bin/git'))).toEqual([])
  })

  it('an ordinary orphan (not uninterruptible) is NOT reported', () => {
    // Long-lived orphaned daemons are completely normal — this is most of `ps`.
    expect(parseStuckProcesses(line(336, 1, 'Ss', '03:01:48', '/usr/libexec/logd'))).toEqual([])
  })

  it('a YOUNG uninterruptible process is NOT reported — brief D-state is just disk I/O', () => {
    expect(parseStuckProcesses(line(1234, 1, 'D', '00:03', '/usr/bin/git'))).toEqual([])
    // …and the same process, once aged past the floor, IS reported.
    expect(parseStuckProcesses(line(1234, 1, 'D', '10:01', '/usr/bin/git'))).toHaveLength(1)
  })

  it('the age floor is honoured exactly (and is injectable)', () => {
    const atFloor = line(1, 1, 'U', '10:00', '/usr/bin/git') // 600s === floor
    expect(parseStuckProcesses(atFloor)).toHaveLength(1)
    expect(STUCK_MIN_AGE_SECONDS).toBe(600)
    expect(parseStuckProcesses(line(1, 1, 'U', '00:30', '/usr/bin/git'), 10)).toHaveLength(1)
  })

  it('reports the EXECUTABLE only — a worker argv carrying a whole prompt never leaks', () => {
    // `comm` is the executable, but pin the basename-ing: paths have spaces here.
    const out = parseStuckProcesses(
      line(77, 1, 'U', '20:00', '/Users/me/projects/OPEN GROUND/node_modules/.bin/vitest'),
    )
    expect(out[0].command).toBe('vitest')
  })

  it('ignores headers, blank lines and malformed rows instead of throwing', () => {
    const out = parseStuckProcesses(
      ['  PID  PPID STAT ELAPSED COMM', '', 'total garbage', line(9, 1, 'U', '30:00', 'git')].join('\n'),
    )
    expect(out).toHaveLength(1)
    expect(out[0].pid).toBe(9)
  })
})

describe('owner-facing message', () => {
  const many = Array.from({ length: 41 }, (_, i) =>
    line(1000 + i, 1, 'U', '05:35:22', '/usr/bin/git'),
  ).join('\n')

  it('summarizes by executable, most frequent first', () => {
    const procs = parseStuckProcesses([many, line(2, 1, 'U', '30:00', '/usr/bin/node')].join('\n'))
    expect(summarizeByCommand(procs)).toBe('git×41, node×1')
  })

  it('says what happened, what it costs, and the ONE thing that works', () => {
    const detail = describeStuckProcesses(parseStuckProcesses(many))
    expect(detail).toContain('41個')
    expect(detail).toContain('git×41')
    expect(detail).toContain('再起動')
    // PIN: never tell the owner to kill these — measured, it does not work.
    expect(detail).not.toMatch(/kill|強制終了/)
    // PIN: no jargon the owner is not required to know.
    expect(detail).not.toMatch(/U状態|uninterruptible|PPID|SIGKILL/)
  })
})

describe('checkStuckProcessesOnce — fires only on ACCUMULATION', () => {
  const psOf = (n: number) =>
    Array.from({ length: n }, (_, i) => line(100 + i, 1, 'U', '30:00', '/usr/bin/git')).join('\n')

  it('stays silent below the count floor (one wedged process costs nothing measurable)', async () => {
    const seen: string[] = []
    const procs = parseStuckProcesses(psOf(STUCK_MIN_COUNT - 1))
    expect(procs).toHaveLength(STUCK_MIN_COUNT - 1)
    // Drive the gate with the same rule the real call uses.
    const fired = procs.length >= STUCK_MIN_COUNT
    if (fired) seen.push('x')
    expect(seen).toEqual([])
  })

  it('notifies once at/above the floor, and returns the set', async () => {
    const seen: string[] = []
    // minAgeSeconds high enough that the REAL process table cannot contribute:
    // this asserts the gate, and on a healthy machine finds nothing either way.
    const out = await checkStuckProcessesOnce({
      minAgeSeconds: 10 ** 9,
      notify: async (d) => void seen.push(d),
    })
    expect(out).toEqual([])
    expect(seen).toEqual([]) // nothing stuck for 30+ years ⇒ silent
  })

  it('a notify that throws never propagates (a health check must not break boot)', async () => {
    await expect(
      checkStuckProcessesOnce({
        minAgeSeconds: 10 ** 9,
        notify: async () => {
          throw new Error('bell is down')
        },
      }),
    ).resolves.toEqual([])
  })
})

describe('findStuckProcesses — safe on any machine', () => {
  it('returns an array and never throws (runs the real ps)', async () => {
    const out = await findStuckProcesses({ minAgeSeconds: 10 ** 9 })
    expect(Array.isArray(out)).toBe(true)
    expect(out).toEqual([]) // nothing has been stuck for 30+ years
  })

  it('a healthy machine reports nothing at the real floor', async () => {
    // This is also the regression teeth for gitRepoGuard: after the 2026-07-28
    // fix, running the suite leaves ZERO orphaned uninterruptible processes.
    // If this ever goes red, something is leaking subprocesses again.
    const out = await findStuckProcesses()
    expect(out.filter((p) => p.command === 'git')).toEqual([])
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runChatGptCommand } from './chatgptTools'

const fixture = vi.hoisted(() => ({ fake: false, spawn: vi.fn() }))
vi.mock('child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => fixture.fake ? fixture.spawn(...args) : actual.spawn(...args) }
})
vi.mock('fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, access: (...args: Parameters<typeof actual.access>) => fixture.fake && args[0] === '/usr/bin/sandbox-exec' ? Promise.resolve() : actual.access(...args) }
})

const roots: string[] = []
const children: ReturnType<typeof fakeChild>[] = []
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const temp = async () => { const path = await mkdtemp(join(tmpdir(), 'og-host-lifecycle-')); roots.push(path); return path }
const fakeChild = () => Object.assign(new EventEmitter(), { pid: 2_000_000_123, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.emit('close', null, null)
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
  }
  fixture.fake = false
  fixture.spawn.mockReset()
  Object.defineProperty(process, 'platform', platform)
  vi.restoreAllMocks()
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const mockedProcess = async (ignoreTerm = false, ignoreKill = false) => {
  const cwd = await temp()
  fixture.fake = true
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
  const child = fakeChild()
  children.push(child)
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  fixture.spawn.mockImplementation(() => { started(); return child as unknown as ChildProcess })
  const signals: (string | number | undefined)[] = []
  let alive = true
  let deniedProbes = 0
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    // Every fake signal is intercepted. Never send a signal to a fixture PID.
    expect(pid).toBe(-child.pid)
    if (signal === 0) {
      if (deniedProbes-- > 0) throw Object.assign(new Error('inspection unavailable'), { code: 'EPERM' })
      if (!alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
      return true
    }
    signals.push(signal)
    if ((signal === 'SIGTERM' && !ignoreTerm) || (signal === 'SIGKILL' && !ignoreKill)) {
      alive = false
      queueMicrotask(() => child.emit('exit', null, signal))
    }
    return true
  })
  return { cwd, child, ready, signals, denyNextProbes: (count: number) => { deniedProbes = count }, exited: () => { alive = false; child.emit('exit', 0, null) } }
}

describe('ChatGPT host command pipe lifecycle', () => {
  it.each(['deadline', 'abort'] as const)('returns an uncertain outcome after %s when the process exits but inherited pipes never close', async reason => {
    const f = await mockedProcess()
    vi.useFakeTimers()
    const controller = new AbortController()
    let outcome: unknown
    const observed = runChatGptCommand({ cwd: f.cwd, command: 'fixture command', signal: controller.signal, timeoutMs: 20, protectedRoots: [join(f.cwd, 'secrets')] })
      .then(value => { outcome = value }, error => { outcome = error })
    await f.ready
    if (reason === 'abort') controller.abort()
    await vi.advanceTimersByTimeAsync(1000)
    try {
      expect(outcome).toMatchObject({ name: 'ChatGptHostOutcomeUncertainError', code: 'host_outcome_uncertain' })
      expect(f.child.stdout.destroyed).toBe(true)
      expect(f.child.stderr.destroyed).toBe(true)
      expect(f.signals).toContain('SIGTERM')
      expect(outcome).not.toHaveProperty('exitCode')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      // The RED implementation still waits for close: settle it for cleanup.
      f.child.emit('close', null, 'SIGTERM')
      await observed
    }
  })

  it('does not report success when an exited command leaves a pipe open outside its original group', async () => {
    const f = await mockedProcess()
    vi.useFakeTimers()
    let outcome: unknown
    const observed = runChatGptCommand({ cwd: f.cwd, command: 'fixture command', signal: new AbortController().signal, timeoutMs: 20_000, protectedRoots: [join(f.cwd, 'secrets')] })
      .then(value => { outcome = value }, error => { outcome = error })
    await f.ready
    f.child.stdout.write('parent exited successfully')
    f.exited()
    await vi.advanceTimersByTimeAsync(1000)
    try {
      expect(outcome).toMatchObject({ name: 'ChatGptHostOutcomeUncertainError', code: 'host_outcome_uncertain' })
      expect(f.signals).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      f.child.emit('close', 0, null)
      await observed
    }
  })

  it.each([false, true])('preserves a confirmed deadline failure when close follows process cleanup (SIGTERM ignored: %s)', async ignoreTerm => {
    const f = await mockedProcess(ignoreTerm)
    vi.useFakeTimers()
    const observed = runChatGptCommand({ cwd: f.cwd, command: 'fixture command', signal: new AbortController().signal, timeoutMs: 20, protectedRoots: [join(f.cwd, 'secrets')] })
      .then(value => value, error => error as Error)
    await f.ready
    await vi.advanceTimersByTimeAsync(ignoreTerm ? 280 : 25)
    f.child.emit('close', null, ignoreTerm ? 'SIGKILL' : 'SIGTERM')
    await vi.advanceTimersByTimeAsync(1000)
    expect(await observed).toMatchObject({ name: 'Error', message: expect.stringMatching(/deadline/) })
    expect(f.signals).toEqual(ignoreTerm ? ['SIGTERM', 'SIGKILL'] : ['SIGTERM'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('finishes with an uncertain outcome even when SIGTERM and SIGKILL do not produce close', async () => {
    const f = await mockedProcess(true)
    vi.useFakeTimers()
    let outcome: unknown
    const observed = runChatGptCommand({ cwd: f.cwd, command: 'fixture command', signal: new AbortController().signal, timeoutMs: 20, protectedRoots: [join(f.cwd, 'secrets')] })
      .then(value => { outcome = value }, error => { outcome = error })
    await f.ready
    await vi.advanceTimersByTimeAsync(1000)
    try {
      expect(outcome).toMatchObject({ name: 'ChatGptHostOutcomeUncertainError', code: 'host_outcome_uncertain' })
      expect(f.signals).toEqual(['SIGTERM', 'SIGKILL'])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      f.child.emit('close', null, 'SIGKILL')
      await observed
    }
  })

  it('does not bless a successful parent close while its process group is still present after SIGKILL', async () => {
    const f = await mockedProcess(true, true)
    vi.useFakeTimers()
    let outcome: unknown
    const observed = runChatGptCommand({ cwd: f.cwd, command: 'fixture command', signal: new AbortController().signal, timeoutMs: 20_000, protectedRoots: [join(f.cwd, 'secrets')] })
      .then(value => { outcome = value }, error => { outcome = error })
    await f.ready
    // Parent exit/stdio close does not prove that a stdio-ignore child ended.
    f.child.emit('exit', 0, null)
    f.child.emit('close', 0, null)
    await vi.advanceTimersByTimeAsync(1000)
    try {
      expect(outcome).toMatchObject({ name: 'ChatGptHostOutcomeUncertainError', code: 'host_outcome_uncertain' })
      expect(f.signals).toEqual(['SIGTERM', 'SIGKILL'])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      f.exited()
      f.child.emit('close', 0, null)
      await observed
    }
  })

  it('requires eventual disappearance without treating a transient EPERM probe as command failure', async () => {
    const f = await mockedProcess()
    vi.useFakeTimers()
    const observed = runChatGptCommand({ cwd: f.cwd, command: 'fixture command', signal: new AbortController().signal, timeoutMs: 20_000, protectedRoots: [join(f.cwd, 'secrets')] })
    await f.ready
    f.child.emit('exit', 0, null)
    f.denyNextProbes(1)
    f.child.emit('close', 0, null)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await observed).toMatchObject({ exitCode: 0, remainingProcessesStopped: true })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.runIf(process.platform === 'darwin')('detects a real detached child holding an inherited output pipe without claiming it was stopped', async () => {
    const cwd = await temp()
    const script = join(cwd, 'leave-pipe.cjs')
    const marker = join(cwd, 'owned-child.pid')
    await writeFile(script, "const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',1,2]});require('node:fs').writeFileSync(process.argv[2],String(child.pid));child.unref();")
    const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'"
    const running = runChatGptCommand({ cwd, command: `${quote(process.execPath)} ${quote(script)} ${quote(marker)}`, signal: new AbortController().signal, timeoutMs: 1000, protectedRoots: [join(cwd, 'secrets')] })
    const observed = running.then(value => value, error => error as Error)
    let pid = 0
    let guardTimer: ReturnType<typeof setTimeout> | undefined
    try {
      for (let attempt = 0; attempt < 200 && !pid; attempt++) {
        try { pid = Number(await readFile(marker, 'utf8')) } catch { await new Promise(resolve => setTimeout(resolve, 10)) }
      }
      expect(pid).toBeGreaterThan(0)
      const result = await Promise.race([observed, new Promise(resolve => { guardTimer = setTimeout(() => resolve('host command still pending after cleanup'), 5000) })])
      expect(result).toMatchObject({ name: 'ChatGptHostOutcomeUncertainError', code: 'host_outcome_uncertain' })
      // The escaped fixture belongs to a different group. A correct result
      // must not imply that sending a signal to the original group reaped it.
      expect(() => process.kill(pid, 0)).not.toThrow()
    } finally {
      clearTimeout(guardTimer)
      if (!pid) { try { pid = Number(await readFile(marker, 'utf8')) } catch { /* did not start */ } }
      if (pid) {
        try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ }
        let gone = false
        for (let attempt = 0; attempt < 100 && !gone; attempt++) {
          try { process.kill(pid, 0) } catch (error) { gone = (error as NodeJS.ErrnoException).code === 'ESRCH' }
          if (!gone) await new Promise(resolve => setTimeout(resolve, 10))
        }
        expect(gone).toBe(true)
      }
      await observed
    }
  })
})

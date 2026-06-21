import { describe, it, expect, afterEach, vi } from 'vitest'
import { resolveViaLoginShell, stripWindowsExeExt } from './cliResolve'

// child_process.execFile is the single OS seam these resolvers touch. We mock it
// (callback-style, since cliResolve promisifies it) so BOTH the Windows `where`
// branch and the POSIX login-shell branch can be driven on any host — `where`
// doesn't exist on macOS/Linux CI, and a unit test must never spawn a real login
// shell. process.platform is flipped to pick the branch (same seam as
// editorDetect.test.ts).
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))
vi.mock('child_process', () => ({ execFile: execFileMock }))

const realPlatform = process.platform
const setPlatform = (p: string) =>
  Object.defineProperty(process, 'platform', { value: p, configurable: true })

type ExecCb = (err: Error | null, out?: { stdout: string; stderr: string }) => void

// Make execFile(cmd, args, opts, cb) resolve cb(null,{stdout}) for the value the
// handler returns, or reject when it returns an Error.
const stubExecFile = (handler: (cmd: string, args: string[]) => string | Error) => {
  execFileMock.mockImplementation(
    (cmd: string, args: string[], opts: unknown, cb: unknown) => {
      const done = (typeof opts === 'function' ? opts : cb) as ExecCb
      const r = handler(cmd, args)
      if (r instanceof Error) done(r)
      else done(null, { stdout: r, stderr: '' })
    },
  )
}

afterEach(() => {
  setPlatform(realPlatform)
  execFileMock.mockReset()
  vi.unstubAllEnvs()
})

describe('stripWindowsExeExt', () => {
  it('strips PATHEXT extensions (case-insensitive), leaves bare/other names', () => {
    expect(stripWindowsExeExt('code.cmd')).toBe('code')
    expect(stripWindowsExeExt('cursor.EXE')).toBe('cursor')
    expect(stripWindowsExeExt('windsurf.bat')).toBe('windsurf')
    expect(stripWindowsExeExt('zed')).toBe('zed')
    expect(stripWindowsExeExt('notes.txt')).toBe('notes.txt') // not an exe ext
  })
})

describe('resolveViaLoginShell on Windows (where)', () => {
  it('maps `where` hits back to the requested name, stripping .cmd/.exe', async () => {
    setPlatform('win32')
    stubExecFile((cmd, args) => {
      expect(cmd).toBe('where')
      expect(args).toEqual(['cursor', 'code', 'windsurf', 'zed'])
      // `where` prints one absolute line per match (CRLF), PATHEXT-expanded.
      return (
        [
          'C:\\Users\\u\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd',
          'C:\\Users\\u\\AppData\\Local\\Programs\\cursor\\resources\\app\\bin\\cursor.cmd',
        ].join('\r\n') + '\r\n'
      )
    })
    const map = await resolveViaLoginShell(['cursor', 'code', 'windsurf', 'zed'])
    expect(map.code).toBe(
      'C:\\Users\\u\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd',
    )
    expect(map.cursor).toBe(
      'C:\\Users\\u\\AppData\\Local\\Programs\\cursor\\resources\\app\\bin\\cursor.cmd',
    )
    expect(map.windsurf).toBeUndefined()
    expect(map.zed).toBeUndefined()
  })

  it('first path per name wins (PATH-priority order)', async () => {
    setPlatform('win32')
    stubExecFile(() => ['C:\\a\\code.cmd', 'C:\\b\\code.cmd'].join('\r\n'))
    const map = await resolveViaLoginShell(['code'])
    expect(map.code).toBe('C:\\a\\code.cmd')
  })

  it('no `where` / nothing found → {} (never throws)', async () => {
    setPlatform('win32')
    stubExecFile(() => new Error('command not found'))
    expect(await resolveViaLoginShell(['code'])).toEqual({})
  })

  it('unsafe command names are refused without ever spawning', async () => {
    setPlatform('win32')
    stubExecFile(() => 'C:\\x\\code.cmd')
    expect(await resolveViaLoginShell(['bad; rm -rf /'])).toEqual({})
    expect(execFileMock).not.toHaveBeenCalled()
  })
})

describe('resolveViaLoginShell on POSIX (login shell)', () => {
  it('spawns the login shell and maps command -v hits to absolute paths', async () => {
    setPlatform('darwin')
    vi.stubEnv('SHELL', '/bin/zsh')
    stubExecFile((cmd, args) => {
      expect(cmd).toBe('/bin/zsh')
      expect(args).toEqual(['-lic', 'command -v cursor code'])
      return 'Last login: today\n/opt/homebrew/bin/cursor\n/usr/local/bin/code\n'
    })
    const map = await resolveViaLoginShell(['cursor', 'code'])
    expect(map).toEqual({
      cursor: '/opt/homebrew/bin/cursor',
      code: '/usr/local/bin/code',
    })
  })

  it('shell failure → {} (never throws)', async () => {
    setPlatform('darwin')
    stubExecFile(() => new Error('no shell'))
    expect(await resolveViaLoginShell(['code'])).toEqual({})
  })
})

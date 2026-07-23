import { describe, it, expect, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import {
  EDITOR_CANDIDATES,
  __resetEditorCacheForTests,
  buildEditorSpawn,
  editorLaunchTarget,
  knownEditorLocations,
  openInEditor,
  parseEditorCmd,
  resolveEditorArgv,
} from './editorCli'
import {
  loginShellResolveArgv,
  pathFromShellOutput,
  pathsFromShellOutput,
} from './cliResolve'

// Pure pieces of the "Open in editor" resolver: env-override argv splitting,
// candidate priority, known install locations, and the shared login-shell
// helpers claudeCli.ts now delegates to. The probing orchestration rides the
// same execFile seams claudeCli's covered cases do.

// The blank-override case runs REAL detection (process PATH → login shell →
// known paths) — on a machine with no editor that can take several seconds.
// Value matches the canonical ceiling in vitest.config.ts (60s).
vi.setConfig({ testTimeout: 60_000 })

describe('parseEditorCmd (OPENGROUND_EDITOR_CMD → argv)', () => {
  it('splits on whitespace; first token is the command', () => {
    expect(parseEditorCmd('subl -w')).toEqual(['subl', '-w'])
    expect(parseEditorCmd('  code   --new-window  ')).toEqual(['code', '--new-window'])
    expect(parseEditorCmd('/opt/homebrew/bin/cursor')).toEqual(['/opt/homebrew/bin/cursor'])
  })

  it('empty / blank → empty argv', () => {
    expect(parseEditorCmd('')).toEqual([])
    expect(parseEditorCmd('   ')).toEqual([])
  })
})

describe('candidate order and known locations', () => {
  it('strict priority: cursor → code → windsurf → zed', () => {
    expect([...EDITOR_CANDIDATES]).toEqual(['cursor', 'code', 'windsurf', 'zed'])
  })

  it('every candidate gets brew prefixes + ~/.local/bin', () => {
    for (const name of EDITOR_CANDIDATES) {
      const locs = knownEditorLocations(name)
      expect(locs).toContain(`/opt/homebrew/bin/${name}`)
      expect(locs).toContain(`/usr/local/bin/${name}`)
      expect(locs.some((l) => l.endsWith(`/.local/bin/${name}`))).toBe(true)
    }
  })

  it('code / cursor additionally get their .app-bundle CLI shims', () => {
    expect(knownEditorLocations('code')).toContain(
      '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
    )
    expect(knownEditorLocations('cursor')).toContain(
      '/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
    )
    expect(knownEditorLocations('zed')).toHaveLength(3)
  })
})

describe('resolveEditorArgv env override', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    __resetEditorCacheForTests()
  })

  it('OPENGROUND_EDITOR_CMD is used verbatim, no probing', async () => {
    vi.stubEnv('OPENGROUND_EDITOR_CMD', '/no/such/editor --flag')
    expect(await resolveEditorArgv()).toEqual(['/no/such/editor', '--flag'])
  })

  it('a blank override falls through to detection (does not return [])', async () => {
    vi.stubEnv('OPENGROUND_EDITOR_CMD', '   ')
    const argv = await resolveEditorArgv()
    // Whatever detection finds on this machine, a blank override must never
    // produce an empty argv (that would spawn(undefined)).
    expect(argv === null || argv.length > 0).toBe(true)
  })
})

// Launch-failure propagation (audit 856daefb): the env override is trusted
// as-is, so a bad OPENGROUND_EDITOR_CMD used to spawn into a swallowed async
// 'error' and the route answered {ok:true} with no editor. openInEditor now
// awaits the spawn's initial 'spawn'/'error', so ENOENT rejects instead of
// silently "succeeding". POSIX-only: on Windows the spawn rides a shell, where
// a missing command fails inside the shell without a spawn 'error'.
describe.skipIf(process.platform === 'win32')('openInEditor spawn-failure propagation', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    __resetEditorCacheForTests()
  })

  it('env override pointing at a missing binary → rejects (no silent {ok:true})', async () => {
    vi.stubEnv('OPENGROUND_EDITOR_CMD', '/no/such/dir/editor-xyz --flag')
    await expect(openInEditor(tmpdir())).rejects.toThrow(/ENOENT/)
  })

  it('env override naming a command invisible on PATH → rejects', async () => {
    vi.stubEnv('OPENGROUND_EDITOR_CMD', 'openground-no-such-editor-cmd-xyz')
    await expect(openInEditor(tmpdir())).rejects.toThrow(/ENOENT/)
  })

  it('env override pointing at a real binary still resolves', async () => {
    vi.stubEnv('OPENGROUND_EDITOR_CMD', '/bin/echo')
    await expect(openInEditor(tmpdir())).resolves.toBeUndefined()
  })
})

describe('cliResolve shared helpers', () => {
  it('zsh gets -lic (profile AND rc), other shells -lc', () => {
    expect(loginShellResolveArgv('/bin/zsh', ['cursor'])).toEqual([
      '/bin/zsh',
      ['-lic', 'command -v cursor'],
    ])
    expect(loginShellResolveArgv('/bin/bash', ['zed'])[1][0]).toBe('-lc')
  })

  it('several names resolve through ONE command -v invocation', () => {
    const [, args] = loginShellResolveArgv('/bin/zsh', ['cursor', 'code', 'zed'])
    expect(args[args.length - 1]).toBe('command -v cursor code zed')
  })

  it('refuses non-word command names (shell-string safety)', () => {
    expect(() => loginShellResolveArgv('/bin/zsh', ['ok; rm -rf /'])).toThrow(/unsafe/)
    expect(() => loginShellResolveArgv('/bin/zsh', ['$(x)'])).toThrow(/unsafe/)
  })

  it('pathsFromShellOutput keeps every absolute line, in order, skipping noise', () => {
    expect(
      pathsFromShellOutput('Last login: today\n/usr/local/bin/cursor\nmotd\n/opt/homebrew/bin/zed\n'),
    ).toEqual(['/usr/local/bin/cursor', '/opt/homebrew/bin/zed'])
    expect(pathsFromShellOutput('no hits here\n')).toEqual([])
  })

  it('pathFromShellOutput (claudeCli compat) still answers the LAST absolute line', () => {
    expect(pathFromShellOutput('noise\n/a/bin/claude\n')).toBe('/a/bin/claude')
    expect(pathFromShellOutput('')).toBeNull()
  })
})

describe('editorLaunchTarget (the `open -a` target for a chosen editor)', () => {
  it('prefers the explicit bundle path over the display name', () => {
    expect(
      editorLaunchTarget({ name: 'Cursor', path: '/Applications/Cursor.app', mode: 'open' }),
    ).toBe('/Applications/Cursor.app')
  })

  it('falls back to the display name when the path is missing or blank', () => {
    expect(editorLaunchTarget({ name: 'Visual Studio Code', mode: 'open' })).toBe(
      'Visual Studio Code',
    )
    expect(editorLaunchTarget({ name: 'Zed', path: '   ', mode: 'open' })).toBe('Zed')
  })
})

// Windows resolution: these tests run on macOS, so we flip process.platform to
// exercise the win32 branches (same seam editorDetect.test.ts uses). os.homedir
// isn't mocked here, so the Windows env vars are stubbed to keep the well-known
// paths deterministic.
const realPlatform = process.platform
const setPlatform = (p: string) =>
  Object.defineProperty(process, 'platform', { value: p, configurable: true })

describe('knownEditorLocations on Windows', () => {
  afterEach(() => {
    setPlatform(realPlatform)
    vi.unstubAllEnvs()
  })

  it('returns the VS Code / Cursor / Windsurf .cmd shims under the Programs dirs', () => {
    setPlatform('win32')
    vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\u\\AppData\\Local')
    vi.stubEnv('ProgramFiles', 'C:\\Program Files')
    expect(knownEditorLocations('code')).toContain(
      'C:\\Users\\u\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd',
    )
    expect(knownEditorLocations('code')).toContain(
      'C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd',
    )
    expect(knownEditorLocations('cursor')).toContain(
      'C:\\Users\\u\\AppData\\Local\\Programs\\cursor\\resources\\app\\bin\\cursor.cmd',
    )
    expect(knownEditorLocations('windsurf')).toContain(
      'C:\\Users\\u\\AppData\\Local\\Programs\\Windsurf\\resources\\app\\bin\\windsurf.cmd',
    )
  })

  it('every Windows shim ends in .cmd (so the shell stage can spawn it)', () => {
    setPlatform('win32')
    vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\u\\AppData\\Local')
    for (const name of EDITOR_CANDIDATES) {
      for (const loc of knownEditorLocations(name)) {
        expect(loc.endsWith('.cmd')).toBe(true)
      }
    }
  })
})

describe('buildEditorSpawn', () => {
  afterEach(() => setPlatform(realPlatform))

  it('POSIX: spawns the binary directly, project path appended, detached', () => {
    setPlatform('darwin')
    const { command, args, options } = buildEditorSpawn(['cursor'], '/my/proj')
    expect(command).toBe('cursor')
    expect(args).toEqual(['/my/proj'])
    expect(options.shell).toBeFalsy()
    expect(options.detached).toBe(true)
    expect(options.cwd).toBe('/my/proj')
  })

  it('Windows: runs a quoted command through the shell so spaced paths survive', () => {
    setPlatform('win32')
    const cmd = 'C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd'
    const { command, args, options } = buildEditorSpawn([cmd], 'C:\\My Projects\\app')
    expect(command).toBe(`"${cmd}"`)
    expect(args).toEqual(['"C:\\My Projects\\app"'])
    expect(options.shell).toBe(true)
    expect(options.windowsVerbatimArguments).toBe(true)
    expect(options.detached).toBe(true)
  })

  it('Windows: preserves extra argv flags before the project path', () => {
    setPlatform('win32')
    const { command, args } = buildEditorSpawn(['code', '--new-window'], 'C:\\proj')
    expect(command).toBe('"code"')
    expect(args).toEqual(['"--new-window"', '"C:\\proj"'])
  })
})

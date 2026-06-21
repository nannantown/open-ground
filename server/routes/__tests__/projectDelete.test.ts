import { describe, it, expect } from 'vitest'
import { buildTrashCommand } from '../project'

// Unit tests for the platform routing of POST /api/project/delete's trash step.
//
// buildTrashCommand is the single source of truth for "which OS trash command":
// the route does `const { cmd, args } = buildTrashCommand(process.platform,
// target)` then execFiles that pair. Testing the builder directly asserts the
// platform routing WITHOUT spawning osascript / powershell / gio — deterministic
// and hermetic (no real filesystem, no real Trash). The e2e suite deliberately
// leaves delete's logic to this unit test (see e2e/projects.spec.ts header).

const TARGET = '/Users/me/projects/demo'

describe('buildTrashCommand — POST /api/project/delete platform routing', () => {
  it('win32 → PowerShell Recycle Bin (Microsoft.VisualBasic DeleteDirectory)', () => {
    const { cmd, args } = buildTrashCommand('win32', TARGET)
    // Windows takes the PowerShell path, NOT the macOS osascript path.
    expect(cmd).toBe('powershell.exe')
    expect(cmd).not.toBe('osascript')
    // Invoked via `powershell -Command <script>`.
    expect(args).toContain('-Command')
    const script = args[args.indexOf('-Command') + 1]
    // …whose script sends the directory to the Recycle Bin via the VisualBasic
    // FileSystem helper named in the goal.
    expect(script).toContain('Microsoft.VisualBasic.FileIO.FileSystem')
    expect(script).toContain('DeleteDirectory')
    expect(script).toContain('SendToRecycleBin')
    // The target path is embedded directly (no reliance on $args).
    expect(script).toContain(TARGET)
  })

  it('darwin → osascript JXA Finder Trash (byte-for-byte the pre-split mac behaviour)', () => {
    const { cmd, args } = buildTrashCommand('darwin', TARGET)
    // macOS takes the osascript path, NOT the Windows PowerShell path.
    expect(cmd).toBe('osascript')
    expect(cmd).not.toBe('powershell.exe')
    // The EXACT arg vector the route used before the platform split — this locks
    // the no-regression requirement for macOS.
    expect(args).toHaveLength(5)
    expect(args[0]).toBe('-l')
    expect(args[1]).toBe('JavaScript')
    expect(args[2]).toBe('-e')
    // The JXA payload is the NSFileManager trashItemAtURL script (moves to Trash).
    expect(args[3]).toContain('trashItemAtURL')
    expect(args[3]).toContain('NSFileManager')
    // The path rides as the trailing argv[0] the JXA `run(argv)` reads, unchanged.
    expect(args[4]).toBe(TARGET)
  })

  it('linux/other → `gio trash <path>` (freedesktop trash)', () => {
    const { cmd, args } = buildTrashCommand('linux', TARGET)
    expect(cmd).toBe('gio')
    expect(args).toEqual(['trash', TARGET])
  })

  it("win32 doubles single quotes in the path (PowerShell string-literal safety)", () => {
    // A folder named with an apostrophe is legal on Windows; it must not break
    // out of the single-quoted PS literal or inject script.
    const { args } = buildTrashCommand('win32', "C:\\Users\\o'brien\\proj")
    const script = args[args.indexOf('-Command') + 1]
    expect(script).toContain("C:\\Users\\o''brien\\proj")
    // No bare odd-count quote survives that could terminate the literal early.
    expect(script).not.toContain("o'brien")
  })
})

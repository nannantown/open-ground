import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, readdir, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  checkAutoCompact,
  AUTO_COMPACT_SETTING,
  AUTO_COMPACT_ENV,
} from './autoCompactGuard'

// Native auto-compact non-interference.
//
// Two halves, and the SECOND is the one that actually protects the design:
//
//  1. checkAutoCompact() — observability. Notices a user-side disable and says so.
//  2. the source scan — the durable guarantee. The whole context design rests on
//     "compression is 100% native", which holds only while OG never turns native
//     compaction off. A future edit that writes autoCompactEnabled:false (or sets
//     DISABLE_AUTO_COMPACT on a spawned claude) would silently gut the design and
//     no behavioural test would notice, because the symptom is a session that
//     merely fills up slower-than-never. So it is fixed structurally instead.
//
// HOME is pinned to a tmpdir throughout: the module reads the user's REAL global
// ~/.claude/settings.json, so an unpinned run would assert against the
// developer's own personal config.

let dir: string
let home: string
let realHome: string | undefined
let realEnv: string | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'og-autocompact-'))
  home = join(dir, 'home')
  realHome = process.env.HOME
  realEnv = process.env.DISABLE_AUTO_COMPACT
  process.env.HOME = home
  // Literal key, never `delete process.env[someVar]`: a COMPUTED delete is
  // exactly what the repo guard (testHomeEnvGuard) forbids, because the same
  // shape could resolve to HOME / OPENGROUND_HOME and silently un-isolate the
  // rest of the run. The constant is still asserted against below.
  delete process.env.DISABLE_AUTO_COMPACT
})
afterEach(async () => {
  // Restore by ASSIGNMENT, never `delete process.env.HOME`: a deleted HOME makes
  // homedir() fall back to the passwd entry — the developer's real home — and
  // every later test in the run silently loses its isolation (2026-07-23).
  process.env.HOME = realHome ?? ''
  if (realEnv === undefined) delete process.env.DISABLE_AUTO_COMPACT
  else process.env.DISABLE_AUTO_COMPACT = realEnv
  await rm(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

// The tmp home's config dir is built HERE rather than in beforeEach on purpose:
// the repo guard flags any fs mutation sitting near an expression that resolves
// the real home, and beforeEach necessarily handles process.env.HOME. Keeping
// the two apart keeps the guard's signal honest instead of muting it.
const claudeDir = (): string => join(home, '.claude')
const settingsFile = (): string => join(claudeDir(), 'settings.json')

const writeRaw = async (text: string): Promise<void> => {
  await mkdir(claudeDir(), { recursive: true })
  await writeFile(settingsFile(), text, 'utf8')
}
const writeSettings = (value: unknown) => writeRaw(JSON.stringify(value))

describe('checkAutoCompact', () => {
  it('reports ok when no settings file exists — the default is ON', () => {
    // Absence of config is the COMMON case and must never read as a disable.
    return checkAutoCompact().then((s) => {
      expect(s.ok).toBe(true)
      expect(s.disabledBy).toEqual([])
    })
  })

  it('reports ok for a settings file that says nothing about auto-compact', async () => {
    await writeSettings({ model: 'opus', hooks: {} })
    expect((await checkAutoCompact()).ok).toBe(true)
  })

  it('reports ok when the setting is explicitly true', async () => {
    await writeSettings({ [AUTO_COMPACT_SETTING]: true })
    expect((await checkAutoCompact()).ok).toBe(true)
  })

  it('detects an explicit false in settings.json', async () => {
    await writeSettings({ [AUTO_COMPACT_SETTING]: false })
    const s = await checkAutoCompact()
    expect(s.ok).toBe(false)
    expect(s.disabledBy).toEqual(['settings'])
  })

  it('detects the env var', async () => {
    process.env[AUTO_COMPACT_ENV] = '1'
    const s = await checkAutoCompact()
    expect(s.ok).toBe(false)
    expect(s.disabledBy).toEqual(['env'])
  })

  it('reports BOTH sources when both are set', async () => {
    await writeSettings({ [AUTO_COMPACT_SETTING]: false })
    process.env[AUTO_COMPACT_ENV] = 'yes'
    const s = await checkAutoCompact()
    expect(s.disabledBy).toEqual(['settings', 'env'])
  })

  it.each(['', '0', 'false', 'FALSE'])(
    'treats DISABLE_AUTO_COMPACT=%o as NOT disabling',
    async (v) => {
      process.env[AUTO_COMPACT_ENV] = v
      expect((await checkAutoCompact()).ok).toBe(true)
    },
  )

  it('stays ok on malformed JSON rather than inventing an alarm', async () => {
    // claude itself falls back to defaults here, so a parse error is not
    // evidence of a disable — and a false alarm about the user's own config is
    // worse than staying quiet.
    await writeRaw('{ not json')
    expect((await checkAutoCompact()).ok).toBe(true)
  })

  it('stays ok when the settings file is a JSON non-object', async () => {
    await writeSettings(null)
    expect((await checkAutoCompact()).ok).toBe(true)
    await writeSettings([1, 2, 3])
    expect((await checkAutoCompact()).ok).toBe(true)
  })

  it('writes NOTHING — the check is read-only', async () => {
    // Restoring the knob would mean writing an UNDOCUMENTED key into a file the
    // user owns, on every boot. The module reports instead; this pins that.
    await writeSettings({ [AUTO_COMPACT_SETTING]: false })
    const before = await readFile(settingsFile(), 'utf8')
    await checkAutoCompact()
    expect(await readFile(settingsFile(), 'utf8')).toBe(before)
    // …and no backup / sidecar left behind either.
    expect(await readdir(claudeDir())).toEqual(['settings.json'])
  })

  it('gives the owner a plain-language reason, not a config dump', async () => {
    await writeSettings({ [AUTO_COMPACT_SETTING]: false })
    const s = await checkAutoCompact()
    expect(s.detail).toContain('自動圧縮')
    expect(s.detail.length).toBeGreaterThan(20)
  })

  // NOTE: the homedir() fence (assertTestHomeIsolated) is NOT re-tested here.
  // It is enforced canonically by src/testHomeEnvGuard.test.ts, where this file
  // is declared in CLAUDE_ANCHORS as a read-only ~/.claude anchor — one
  // implementation, one owner. A hand-rolled copy here would only re-assert
  // testHomeGuard's own semantics, and would drift from them.
})

describe('OG never disables native auto-compact (source scan)', () => {
  // The design's load-bearing invariant, fixed structurally. A behavioural test
  // cannot catch this: if OG ever disabled auto-compact, nothing would visibly
  // break — sessions would just quietly stop compacting and degrade.
  const SERVER_DIR = join(process.cwd(), 'src', 'lib', 'server')
  const ROUTES_DIR = join(process.cwd(), 'server', 'routes')

  const sourceFiles = async (root: string): Promise<string[]> => {
    const out: string[] = []
    const walk = async (d: string): Promise<void> => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) {
          if (e.name === 'node_modules' || e.name === '__fixtures__') continue
          await walk(p)
          continue
        }
        if (!e.name.endsWith('.ts') && !e.name.endsWith('.tsx')) continue
        if (e.name.endsWith('.test.ts') || e.name.endsWith('.test.tsx')) continue
        out.push(p)
      }
    }
    await walk(root)
    return out
  }

  it('no OG module writes autoCompactEnabled or sets DISABLE_AUTO_COMPACT', async () => {
    const files = [...(await sourceFiles(SERVER_DIR)), ...(await sourceFiles(ROUTES_DIR))]
    expect(files.length).toBeGreaterThan(50) // the scan actually found the tree

    const offenders: string[] = []
    for (const f of files) {
      // autoCompactGuard.ts names both knobs on purpose — it is the READER.
      if (f.endsWith('autoCompactGuard.ts')) continue
      const src = await readFile(f, 'utf8')
      if (/autoCompactEnabled/.test(src)) offenders.push(`${f}: mentions autoCompactEnabled`)
      if (/DISABLE_AUTO_COMPACT/.test(src)) offenders.push(`${f}: mentions DISABLE_AUTO_COMPACT`)
    }
    expect(offenders).toEqual([])
  })

  // The two files that make up the sanctioned MANUAL escape hatch (card 5/5):
  // claudeSlash.ts is the owner-pressed sender, terminal.ts hosts its
  // `:id/slash` adapter route. Every OTHER module must stay free of /compact —
  // "compression is native" means OG never drives it on its own initiative.
  const SANCTIONED_SLASH_SENDERS = ['claudeSlash.ts', 'terminal.ts']

  it('no OG module sends a /compact command to a PTY, except the manual escape hatch', async () => {
    // The other half of "compression is native": OG must not drive compaction
    // itself. Card 5/5 landed the MANUAL owner-pressed 「今すぐ圧縮」 button — an
    // explicit human action, not an automatic trigger — so the two files that
    // implement it are consciously allowed here; nothing else may mention it.
    const files = [...(await sourceFiles(SERVER_DIR)), ...(await sourceFiles(ROUTES_DIR))]
    const offenders = []
    for (const f of files) {
      if (SANCTIONED_SLASH_SENDERS.some((s) => f.endsWith(s))) continue
      const src = await readFile(f, 'utf8')
      if (/['"`]\/compact/.test(src)) offenders.push(f)
    }
    expect(offenders).toEqual([])
  })

  it('the sanctioned /compact sender is manual + fail-closed (not an autonomous trigger)', async () => {
    // Exempting claudeSlash.ts above is only safe because that sender is
    // owner-pressed and guarded: it refuses while claude is mid-turn
    // (isGenerating) and accepts an exact command enum, never an arbitrary
    // string. Pin those two properties so a future edit can't quietly turn the
    // escape hatch into an automatic compactor.
    const src = await readFile(join(SERVER_DIR, 'claudeSlash.ts'), 'utf8')
    expect(src).toMatch(/isGenerating/)
    expect(src).toMatch(/CLAUDE_SLASH_COMMANDS\s*=\s*\[\s*'compact'\s*,\s*'clear'\s*\]/)
  })
})

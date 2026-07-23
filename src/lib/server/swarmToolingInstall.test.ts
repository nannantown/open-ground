import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile, stat, chmod } from 'fs/promises'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import {
  installSwarmTooling,
  ORDER_SKILL_MARKER,
  SUPPLY_SKILL_MARKER,
  SWARM_BEAT_MARKER,
  SWARM_LIB_MARKER,
  SWARM_LIB_BASENAME,
  SWARM_TOOLING_TARGET_PATHS,
} from './swarmToolingInstall'
import { __setHookSourceModuleDirForTests } from './hooksInstall'

// The installer's ownership contract, exercised against a throwaway tmpdir —
// never the real ~/.claude (source root AND home dir are injected via the
// test-only opts). The real shipped files live at <repo>/skills/order/SKILL.md,
// <repo>/skills/supply/SKILL.md, <repo>/scripts/swarm-beat.sh and
// <repo>/scripts/openground-swarm-lib.sh; a separate describe block below pins
// that the SHIPPED files actually carry their markers.

let dir: string
let root: string
let home: string

const orderText = `---\nname: order\n---\n<!-- ${ORDER_SKILL_MARKER} -->\n\n# order\n`
const supplyText = `---\nname: supply\n---\n<!-- ${SUPPLY_SKILL_MARKER} -->\n\n# supply\n`
const beatText = `#!/usr/bin/env bash\n# ${SWARM_BEAT_MARKER}\necho beat\n`
const libText = `#!/usr/bin/env bash\n# ${SWARM_LIB_MARKER}\nsw_hbdir() { :; }\n`

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'og-swarm-tooling-'))
  root = join(dir, 'root')
  home = join(dir, 'home')
  await mkdir(join(root, 'skills', 'order'), { recursive: true })
  await mkdir(join(root, 'skills', 'supply'), { recursive: true })
  await mkdir(join(root, 'scripts'), { recursive: true })
  await writeFile(join(root, 'skills', 'order', 'SKILL.md'), orderText, 'utf8')
  await writeFile(join(root, 'skills', 'supply', 'SKILL.md'), supplyText, 'utf8')
  await writeFile(join(root, 'scripts', 'swarm-beat.sh'), beatText, 'utf8')
  await writeFile(join(root, 'scripts', SWARM_LIB_BASENAME), libText, 'utf8')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const run = () => installSwarmTooling({ sourceRoot: root, homeDir: home })

describe('installSwarmTooling', () => {
  it('installs all 4 files when targets are missing', async () => {
    const results = await run()
    expect(results.map((r) => r.name).sort()).toEqual(['order', 'supply', 'swarm-beat.sh', SWARM_LIB_BASENAME].sort())
    for (const { result: r } of results) expect(r.outcome).toBe('installed')
    expect(await readFile(join(home, '.claude', 'skills', 'order', 'SKILL.md'), 'utf8')).toBe(orderText)
    expect(await readFile(join(home, '.claude', 'skills', 'supply', 'SKILL.md'), 'utf8')).toBe(supplyText)
    expect(await readFile(join(home, '.claude', 'swarm-beat.sh'), 'utf8')).toBe(beatText)
    expect(await readFile(join(home, '.claude', SWARM_LIB_BASENAME), 'utf8')).toBe(libText)
  })

  it('installs the scripts as executable (mode 0o755)', async () => {
    await run()
    const st = await stat(join(home, '.claude', 'swarm-beat.sh'))
    expect(st.mode & 0o111).not.toBe(0)
  })

  it('is idempotent — a second run on identical targets is unchanged', async () => {
    await run()
    const results = await run()
    for (const { result: r } of results) expect(r.outcome).toBe('unchanged')
  })

  it('refreshes a stale managed copy (version-follow on app update)', async () => {
    await mkdir(join(home, '.claude', 'skills', 'order'), { recursive: true })
    await writeFile(join(home, '.claude', 'skills', 'order', 'SKILL.md'), `<!-- ${ORDER_SKILL_MARKER} -->\n# old\n`, 'utf8')
    const results = await run()
    const order = results.find((r) => r.name === 'order')!
    expect(order.result.outcome).toBe('refreshed')
    expect(await readFile(join(home, '.claude', 'skills', 'order', 'SKILL.md'), 'utf8')).toBe(orderText)
  })

  it('NEVER overwrites a user-authored file (no marker) — kept-user', async () => {
    await mkdir(dirname(join(home, '.claude', 'swarm-beat.sh')), { recursive: true })
    const users = '#!/usr/bin/env bash\necho "my own script"\n'
    await writeFile(join(home, '.claude', 'swarm-beat.sh'), users, 'utf8')
    const results = await run()
    const beat = results.find((r) => r.name === 'swarm-beat.sh')!
    expect(beat.result.outcome).toBe('kept-user')
    expect(await readFile(join(home, '.claude', 'swarm-beat.sh'), 'utf8')).toBe(users)
  })

  it('reports error (writes nothing) when a source is unreadable', async () => {
    await rm(join(root, 'scripts', SWARM_LIB_BASENAME))
    const results = await run()
    const lib = results.find((r) => r.name === SWARM_LIB_BASENAME)!
    expect(lib.result.outcome).toBe('error')
    await expect(stat(join(home, '.claude', SWARM_LIB_BASENAME))).rejects.toThrow()
    // Unrelated files still install fine.
    const order = results.find((r) => r.name === 'order')!
    expect(order.result.outcome).toBe('installed')
  })

  it('fails closed (never overwrites) when an EXISTING target is unreadable for a reason other than missing', async () => {
    await mkdir(join(home, '.claude'), { recursive: true })
    const target = join(home, '.claude', 'swarm-beat.sh')
    await writeFile(target, '#!/usr/bin/env bash\necho mine\n', 'utf8')
    await chmod(target, 0o000)
    try {
      const results = await run()
      const beat = results.find((r) => r.name === 'swarm-beat.sh')!
      expect(beat.result.outcome).toBe('error')
      expect(beat.result.error).toContain('not missing')
    } finally {
      await chmod(target, 0o644) // restore so afterEach's rm can clean up
    }
  })

  it('refuses a source that lost the managed-by marker', async () => {
    await writeFile(join(root, 'skills', 'supply', 'SKILL.md'), '# marker-less\n', 'utf8')
    const results = await run()
    const supply = results.find((r) => r.name === 'supply')!
    expect(supply.result.outcome).toBe('error')
    expect(supply.result.error).toContain('marker')
  })

  it('production source resolution refuses a worktree-resident engine (no worktree text reaches ~/.claude)', async () => {
    const savedOg = process.env.OPENGROUND_HOME
    process.env.OPENGROUND_HOME = join(dir, '.openground')
    const wt = join(dir, '.openground', 'projects', 'u', 'worktrees', 'w')
    await mkdir(join(wt, 'scripts'), { recursive: true })
    await writeFile(join(wt, 'scripts', 'openground-hook.js'), '// stub\n', 'utf8')
    await writeFile(join(wt, 'scripts', 'openground-guard.js'), '// stub\n', 'utf8')
    __setHookSourceModuleDirForTests(join(wt, 'src', 'lib', 'server'))
    try {
      const results = await installSwarmTooling({ homeDir: home }) // no sourceRoot → production resolution
      for (const { result: r } of results) {
        expect(r.outcome).toBe('error')
        expect(r.error).toContain('refusing hook source root')
      }
      await expect(stat(join(home, '.claude', 'swarm-beat.sh'))).rejects.toThrow()
    } finally {
      __setHookSourceModuleDirForTests(null)
      if (savedOg !== undefined) process.env.OPENGROUND_HOME = savedOg
    }
  })
})

describe('shipped tooling sources', () => {
  // vitest runs from the repo root, and the production installer's
  // module-anchored resolution (resolveHookSourceRoot) lands on this same
  // checkout — so the files pinned here ARE the files production installs.
  const orderPath = join(process.cwd(), 'skills', 'order', 'SKILL.md')
  const supplyPath = join(process.cwd(), 'skills', 'supply', 'SKILL.md')
  const beatPath = join(process.cwd(), 'scripts', 'swarm-beat.sh')
  const libPath = join(process.cwd(), 'scripts', SWARM_LIB_BASENAME)

  it('order/supply skills carry the managed-by marker', async () => {
    expect(await readFile(orderPath, 'utf8')).toContain(ORDER_SKILL_MARKER)
    expect(await readFile(supplyPath, 'utf8')).toContain(SUPPLY_SKILL_MARKER)
  })

  it('swarm-beat.sh / the shell helper carry the managed-by marker and never mention tmux', async () => {
    const beat = await readFile(beatPath, 'utf8')
    const lib = await readFile(libPath, 'utf8')
    expect(beat).toContain(SWARM_BEAT_MARKER)
    expect(lib).toContain(SWARM_LIB_MARKER)
    // Both files' comments MENTION the legacy tmux swarm-lib.sh to explain why the
    // deployed basename differs from it, but neither may shell out to tmux
    // (no SW_T var, no `tmux <verb>-` invocation).
    expect(beat).not.toContain('SW_T')
    expect(beat).not.toMatch(/\btmux\s+(list|send|capture|has|new|kill)-/)
    expect(lib).not.toContain('SW_T')
    expect(lib).not.toMatch(/\btmux\s+(list|send|capture|has|new|kill)-/)
  })

  it('swarm-beat.sh sources the helper from its own script dir (portable, not ~-hardcoded)', async () => {
    const beat = await readFile(beatPath, 'utf8')
    expect(beat).toContain(`$(dirname "$0")/${SWARM_LIB_BASENAME}`)
  })
})

// ── the collision this rename exists to prevent ──────────────────────────────
// Users' ~/.claude carries a hand-written swarm-lib.sh from the tmux-cockpit era
// (12 pane helpers) that ~a dozen sibling scripts source. OG's helper defines 2
// functions, so installing it under that name silently strips 10 (`sw_session:
// command not found`) — kept-user only shields it while the marker-less file is
// still there. The fix is to never TARGET that path at all.
describe('legacy ~/.claude/swarm-lib.sh collision', () => {
  const legacyText =
    '#!/usr/bin/env bash\n# tmux-era cockpit lib (user-authored, no marker)\n' +
    'sw_session() { echo s; }\nsw_worker_pane() { echo p; }\nsw_send_confirm() { echo c; }\n'

  it('never targets ~/.claude/swarm-lib.sh (the user-owned legacy path)', () => {
    expect(SWARM_TOOLING_TARGET_PATHS).not.toContain('.claude/swarm-lib.sh')
    expect(SWARM_LIB_BASENAME).not.toBe('swarm-lib.sh')
  })

  it('leaves a pre-existing legacy swarm-lib.sh byte-identical and installs alongside it', async () => {
    await mkdir(join(home, '.claude'), { recursive: true })
    const legacy = join(home, '.claude', 'swarm-lib.sh')
    await writeFile(legacy, legacyText, 'utf8')

    const results = await run()
    for (const { result: r } of results) expect(r.outcome).toBe('installed')

    // The user's file is untouched — content AND still present (not renamed away).
    expect(await readFile(legacy, 'utf8')).toBe(legacyText)
    // …and OG's own helper landed next to it, not on top of it.
    expect(await readFile(join(home, '.claude', SWARM_LIB_BASENAME), 'utf8')).toBe(libText)
    expect(results.some((r) => r.result.path === legacy)).toBe(false)
  })

  it("the installed swarm-beat.sh's source line resolves to OG's helper, not the legacy file", async () => {
    await mkdir(join(home, '.claude'), { recursive: true })
    await writeFile(join(home, '.claude', 'swarm-lib.sh'), legacyText, 'utf8')
    // Ship the REAL beat script text so the assertion reads the production source line.
    const realBeat = await readFile(join(process.cwd(), 'scripts', 'swarm-beat.sh'), 'utf8')
    await writeFile(join(root, 'scripts', 'swarm-beat.sh'), realBeat, 'utf8')

    await run()
    const installedBeat = await readFile(join(home, '.claude', 'swarm-beat.sh'), 'utf8')
    const sourced = installedBeat.match(/^\s*\.\s+"\$\(dirname "\$0"\)\/([^"]+)"/m)?.[1]
    expect(sourced).toBeDefined()
    expect(sourced).not.toBe('swarm-lib.sh')
    // Resolves (same dir as the script) to the file the installer actually wrote.
    expect(await readFile(join(home, '.claude', sourced!), 'utf8')).toBe(libText)
  })

  it('installs the helper BEFORE swarm-beat.sh (a refreshed beat never points at a missing lib)', async () => {
    const results = await run()
    const libIdx = results.findIndex((r) => r.name === SWARM_LIB_BASENAME)
    const beatIdx = results.findIndex((r) => r.name === 'swarm-beat.sh')
    expect(libIdx).toBeGreaterThanOrEqual(0)
    expect(libIdx).toBeLessThan(beatIdx)
  })
})

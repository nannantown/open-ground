import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { installOgManageSkill, OG_MANAGE_SKILL_MARKER } from './ogManageSkill'
import { __setHookSourceModuleDirForTests } from './hooksInstall'
import {
  SPECIALIST_NO_SOURCE_MARKER,
  SPECIALIST_REVIEW_MANAGER_CLAUSES,
} from './swarmSpecialistReview'

// The installer's ownership contract, exercised against a throwaway tmpdir —
// never the real ~/.claude (source AND target are injected via the test-only
// opts). The real skill text ships at <repo>/skills/og-manage/SKILL.md; a
// separate test below pins that the SHIPPED file actually carries the marker
// (the installer refuses a marker-less source, so a marker regression in the
// shipped file would silently stop every install).

let dir: string
let src: string
let dst: string

const SHIPPED = `---\nname: og-manage\n---\n<!-- ${OG_MANAGE_SKILL_MARKER} -->\n\n# og-manage v2\n`

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'og-skill-'))
  src = join(dir, 'source', 'SKILL.md')
  dst = join(dir, 'home', '.claude', 'skills', 'og-manage', 'SKILL.md')
  await mkdir(join(dir, 'source'), { recursive: true })
  await writeFile(src, SHIPPED, 'utf8')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const run = () => installOgManageSkill({ sourceFile: src, targetFile: dst })

describe('installOgManageSkill', () => {
  it('installs when the target is missing (creates the whole skills dir chain)', async () => {
    const r = await run()
    expect(r.outcome).toBe('installed')
    expect(await readFile(dst, 'utf8')).toBe(SHIPPED)
  })

  it('is idempotent — a second run on an identical target is unchanged', async () => {
    await run()
    const r = await run()
    expect(r.outcome).toBe('unchanged')
  })

  it('refreshes a stale managed copy (version-follow on app update)', async () => {
    await mkdir(join(dir, 'home', '.claude', 'skills', 'og-manage'), { recursive: true })
    await writeFile(dst, `<!-- ${OG_MANAGE_SKILL_MARKER} -->\n# old version\n`, 'utf8')
    const r = await run()
    expect(r.outcome).toBe('refreshed')
    expect(await readFile(dst, 'utf8')).toBe(SHIPPED)
  })

  it('NEVER overwrites a user-authored file (no marker) — kept-user', async () => {
    await mkdir(join(dir, 'home', '.claude', 'skills', 'og-manage'), { recursive: true })
    const users = '# my own og-manage skill\n'
    await writeFile(dst, users, 'utf8')
    const r = await run()
    expect(r.outcome).toBe('kept-user')
    expect(await readFile(dst, 'utf8')).toBe(users) // byte-untouched
  })

  it('reports error (and writes nothing) when the source is unreadable', async () => {
    await rm(src)
    const r = await run()
    expect(r.outcome).toBe('error')
    await expect(stat(dst)).rejects.toThrow() // target never created
  })

  it('refuses a source that lost the managed-by marker (would strand future updates)', async () => {
    await writeFile(src, '# marker-less source\n', 'utf8')
    const r = await run()
    expect(r.outcome).toBe('error')
    expect(r.error).toContain('marker')
    await expect(stat(dst)).rejects.toThrow()
  })

  it('production source resolution refuses a worktree-resident engine (no worktree skill text reaches ~/.claude)', async () => {
    // Point the shared module-anchored resolver at a fake engine checkout under
    // the central worktrees dir (both hook scripts present = a real-looking
    // checkout). The skill installer must degrade to an 'error' outcome and
    // write nothing — same volatile-root refusal as hooksInstall.
    const savedOg = process.env.OPENGROUND_HOME
    process.env.OPENGROUND_HOME = join(dir, '.openground')
    const wt = join(dir, '.openground', 'projects', 'u', 'worktrees', 'w')
    await mkdir(join(wt, 'scripts'), { recursive: true })
    await writeFile(join(wt, 'scripts', 'openground-hook.js'), '// stub\n', 'utf8')
    await writeFile(join(wt, 'scripts', 'openground-guard.js'), '// stub\n', 'utf8')
    __setHookSourceModuleDirForTests(join(wt, 'src', 'lib', 'server'))
    try {
      const r = await installOgManageSkill({ targetFile: dst }) // no sourceFile → production resolution
      expect(r.outcome).toBe('error')
      expect(r.error).toContain('refusing hook source root')
      await expect(stat(dst)).rejects.toThrow() // target never created
    } finally {
      __setHookSourceModuleDirForTests(null)
      // Restore, never delete: an unset OPENGROUND_HOME sends later resolution at the
      // REAL home dir (the 2026-07-18 data loss). See src/lib/server/testHomeGuard.ts.
      if (savedOg !== undefined) process.env.OPENGROUND_HOME = savedOg
    }
  })
})

describe('shipped skill source (skills/og-manage/SKILL.md)', () => {
  // vitest runs from the repo root, and the production installer's
  // module-anchored resolution (resolveHookSourceRoot) lands on this same
  // checkout — so the file pinned here IS the file production installs.
  const shippedPath = join(process.cwd(), 'skills', 'og-manage', 'SKILL.md')

  it('exists, carries the managed-by marker, and declares the og-manage skill', async () => {
    const text = await readFile(shippedPath, 'utf8')
    expect(text).toContain(OG_MANAGE_SKILL_MARKER)
    expect(text.startsWith('---\n')).toBe(true) // claude skill frontmatter
    expect(text).toContain('name: og-manage')
  })

  it('never mentions tmux — the whole point of the in-app commander protocol', async () => {
    const text = await readFile(shippedPath, 'utf8')
    expect(text.toLowerCase()).not.toContain('tmux')
    // …and never points at the tmux-cockpit helper scripts either (swarm-beat
    // is the WORKER's heartbeat writer, swarm-board the tmux-free Board bridge —
    // both fine; the pane/cockpit/watch/respawn family is not).
    for (const banned of ['swarm-pane.sh', 'swarm-cockpit.sh', 'swarm-watch.sh', 'swarm-respawn.sh', 'swarm-janitor.sh', 'swarm-new.sh', 'swarm-dispatch.sh']) {
      expect(text).not.toContain(banned)
    }
  })

  // POSITION IS THE MECHANISM (adversarial review 2026-07-19, MUST-FIX 1).
  // These pins used to toContain against the WHOLE file, which asserts only that
  // the words exist somewhere — the reviewer moved the entire block into an
  // 「## 付録(未使用メモ)」 heading at EOF and all 12 tests stayed green. But the
  // commander's half of this mechanism IS "it is in front of your eyes while you
  // read 手順4 during an integration"; a clause parked in an appendix is not
  // wired in at all. So slice 手順4 out and assert against the SLICE.
  //
  // Both anchors are verified unique in the shipped file (1 occurrence each);
  // if either stops matching, the slice throws rather than silently degrading to
  // an empty string that would make every toContain below fail confusingly.
  const STEP4_START = '4. **独立レビュー(敵対・必須)**'
  const STEP4_END = '5. `git -C <wt> merge-base --is-ancestor origin/main HEAD`'
  const mergeStep4 = (text: string): string => {
    const start = text.indexOf(STEP4_START)
    const end = text.indexOf(STEP4_END, start + 1)
    if (start < 0 || end <= start) {
      throw new Error(
        `SKILL.md 「マージ」手順4 のスライスに失敗 (start=${start}, end=${end}). ` +
          'アンカー行を編集したなら、この定数も一緒に直すこと。',
      )
    }
    return text.slice(start, end)
  }

  // The commander is prose-driven, so its half of the specialist-review
  // procedure lives in this markdown while the worker's half is a TypeScript
  // constant. SPECIALIST_REVIEW_MANAGER_CLAUSES is the seam between them: each
  // entry must appear verbatim IN 手順4, so the two surfaces cannot drift apart
  // and the text cannot drift out of the step it governs.
  //
  // ⚠ Same caveat as the HIGH_RISK_PATHS pin this mirrors: a verbatim pin proves
  // the WORDS are present and WHERE, not that the commander obeyed them.
  it('carries the specialist-review procedure inside the 「マージ」 review step (手順4)', async () => {
    const step4 = mergeStep4(await readFile(shippedPath, 'utf8'))
    for (const clause of SPECIALIST_REVIEW_MANAGER_CLAUSES) {
      expect(step4).toContain(clause)
    }
  })

  it('keeps the fetch-failure degrade from eroding the review gate’s fail-CLOSED', async () => {
    const step4 = mergeStep4(await readFile(shippedPath, 'utf8'))
    // Both rules must survive in the same step: the pre-existing stop-and-report
    // on a broken reviewer, and the new continue-with-marker on an unreachable
    // source. Losing the first is the regression this card must not introduce.
    // Sliced for the same reason as above — "in the same step" is the claim, so
    // the whole-file check was not testing it.
    expect(step4).toContain('**fail-CLOSED**: レビュアーがエラー/空 verdict なら1回だけ再試行→ダメなら止めて報告')
    expect(step4).toContain('「レビューできなかった」を「クリーン」と同一視しない')
    expect(step4).toContain(SPECIALIST_NO_SOURCE_MARKER)
  })

  it('drives the app HTTP API for every commander action', async () => {
    const text = await readFile(shippedPath, 'utf8')
    for (const api of [
      '/api/swarm/worker',
      '/api/swarm/workers',
      '/api/swarm/orchestrator',
      '/api/swarm/worktree/remove',
      '/api/terminal/',
    ]) {
      expect(text).toContain(api)
    }
  })

  // 差し戻し IS THE PROTOCOL'S HOT PATH, AND THE DEFAULT RUNTIME IS SDK.
  // The step keyed on `terminalId`, which an SDK worker does NOT have (the
  // identity invariant: pty ⇔ terminalId, sdk ⇔ sdkSessionId). So the commander
  // read a LIVE default-runtime worker as "dead", fell to the restart step, and
  // the restart 409'd on the occupancy guard — the 差し戻し never arrived and
  // nothing said why (found 2026-08-04, overnight review). Sliced like 手順4
  // above: the claim is that the runtime branch is IN the step the commander is
  // reading, not merely somewhere in the file.
  const REWORK_START = '2. **live worker がいる**'
  const REWORK_END = '### 「自動運転」/ エンジンに任せる'
  it('差し戻し step branches on RUNTIME and names the SDK conduit (not terminalId alone)', async () => {
    const text = await readFile(shippedPath, 'utf8')
    const start = text.indexOf(REWORK_START)
    const end = text.indexOf(REWORK_END, start + 1)
    if (start < 0 || end <= start) {
      throw new Error(`差し戻し step anchors not found (start=${start}, end=${end})`)
    }
    const step = text.slice(start, end)
    expect(step).toContain('/api/sdk-session/')
    expect(step).toContain('sdkSessionId')
    expect(step).toContain("runtime:'sdk'")
    // …and the trap is named where the mistake is made.
    expect(step).toContain('terminalId')
    // The literal carries backticks around the identifier — match the clause.
    expect(step).toMatch(/terminalId`? ?の有無で判断しない/)
  })
})

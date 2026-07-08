// @vitest-environment node
//
// LENS-PANEL adversarial review (card 5f85d2f5) — the pre-merge review specialized
// into INDEPENDENT correctness / security / perf / regression reviewers, so DISTINCT
// failure modes are covered instead of N homogeneous reviewers re-checking the same
// surface and a real bug getting OUTVOTED. Two layers:
//   • pure unit  — the weighted-OR tally + the lens-specialized prompt (no git, no HOME).
//   • real git   — makeAdversarialReview driven end-to-end over a REAL repo with the
//                  reviewer spawn FAKED (runReviewer), HOME isolated to a tmpdir, proving
//                  the goal's observable conditions:
//                    (1) one reviewer launched PER lens, each blind to the others;
//                    (2) ANY one lens returning must-fix sends the branch back;
//                    (3) each lens's verdict reaches the engine log via `reason`;
//                    (4) all lenses clean → integrate.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, realpath, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { addProjectEntry, __resetMigrationCacheForTests } from './registry'
import {
  makeAdversarialReview,
  tallyLensReview,
  buildReviewPrompt,
  extractReviewVerdict,
  DEFAULT_REVIEW_LENSES,
  __resetOrchestratorForTests,
  type ReviewLens,
  type ReviewLensKey,
  type ReviewVote,
  type ReviewerVerdict,
} from './swarmOrchestrator'
import { createSwarmWorktree } from './swarmWorker'
import { markCoolingUntil, __resetQuotaForTest, MODEL_TIER_LADDER } from './swarmQuota'

// ── pure unit: the weighted-OR lens tally ──────────────────────────────────────
describe('tallyLensReview — lens-panel weighted-OR decision (card 5f85d2f5)', () => {
  const v = (lens: ReviewLensKey, vote: ReviewVote | null, note = ''): ReviewerVerdict => ({
    reviewer: 0,
    lens,
    vote,
    note,
  })
  const allClean = (): ReviewerVerdict[] =>
    DEFAULT_REVIEW_LENSES.map((l) => v(l.key, 'clean'))

  it('all four lenses clean → integrate (条件4)', () => {
    const r = tallyLensReview(allClean(), DEFAULT_REVIEW_LENSES)
    expect(r.decision).toBe('integrate')
    expect(r.clean).toBe(4)
    expect(r.mustFix).toBe(0)
  })

  it('ANY single lens must-fix reworks even when every other lens is clean (条件2)', () => {
    const r = tallyLensReview(
      [v('correctness', 'must-fix', 'off-by-one in the loop'), v('security', 'clean'), v('perf', 'clean'), v('regression', 'clean')],
      DEFAULT_REVIEW_LENSES,
    )
    expect(r.decision).toBe('rework')
    expect(r.reason).toContain('correctness=must-fix')
    expect(r.reason).toContain('off-by-one in the loop') // the note reaches the log (条件3)
  })

  it('a SECURITY-only must-fix reworks — the case a homogeneous 3-panel would OUTVOTE 2-1', () => {
    // This is the whole point of lens specialization: with three identical reviewers a
    // lone security finding loses the majority and the hole auto-merges; with one
    // dedicated security lens it blocks.
    const r = tallyLensReview(
      [v('correctness', 'clean'), v('security', 'must-fix', 'path traversal in upload'), v('perf', 'clean'), v('regression', 'clean')],
      DEFAULT_REVIEW_LENSES,
    )
    expect(r.decision).toBe('rework')
    expect(r.reason).toContain('security=must-fix')
  })

  it('per-lens summary names EVERY lens in the reason the engine logs (条件3)', () => {
    const r = tallyLensReview(
      [v('correctness', 'clean'), v('security', 'clean'), v('perf', 'must-fix', 'n+1'), v('regression', 'clean')],
      DEFAULT_REVIEW_LENSES,
    )
    for (const key of ['correctness', 'security', 'perf', 'regression']) {
      expect(r.reason).toContain(key)
    }
  })

  it('a down-weighted lens (perf weight 0.5) does NOT block on its own — but is still logged (条件2「設定可」)', () => {
    const lenses: ReviewLens[] = DEFAULT_REVIEW_LENSES.map((l) => (l.key === 'perf' ? { ...l, weight: 0.5 } : l))
    const r = tallyLensReview(
      [v('correctness', 'clean'), v('security', 'clean'), v('perf', 'must-fix', 'minor n+1'), v('regression', 'clean')],
      lenses,
    )
    expect(r.decision).toBe('integrate') // 0.5 < threshold 1
    expect(r.reason).toContain('perf=must-fix') // the finding is NOT silently dropped
  })

  it('two down-weighted lenses together cross the threshold → rework (weighted OR, not a count)', () => {
    const lenses: ReviewLens[] = DEFAULT_REVIEW_LENSES.map((l) =>
      l.key === 'perf' || l.key === 'correctness' ? { ...l, weight: 0.5 } : l,
    )
    const r = tallyLensReview(
      [v('correctness', 'must-fix', 'a'), v('security', 'clean'), v('perf', 'must-fix', 'b'), v('regression', 'clean')],
      lenses,
    )
    expect(r.decision).toBe('rework') // 0.5 + 0.5 = 1.0 ≥ 1
  })

  it('an abstaining lens (no verdict) with no must-fix → defer, never merge an un-reviewed dimension', () => {
    const r = tallyLensReview(
      [v('correctness', 'clean'), v('security', null), v('perf', 'clean'), v('regression', 'clean')],
      DEFAULT_REVIEW_LENSES,
    )
    expect(r.decision).toBe('defer')
    expect(r.reason).toContain('security=abstain')
  })

  it('a real must-fix beats a co-occurring abstention → rework (a concrete flag is never deferred away)', () => {
    const r = tallyLensReview(
      [v('correctness', 'must-fix', 'bug'), v('security', null), v('perf', 'clean'), v('regression', 'clean')],
      DEFAULT_REVIEW_LENSES,
    )
    expect(r.decision).toBe('rework')
  })

  it('reworkThreshold is configurable: at threshold 2 a single weight-1 must-fix is allowed through', () => {
    const r = tallyLensReview(
      [v('correctness', 'must-fix', 'x'), v('security', 'clean'), v('perf', 'clean'), v('regression', 'clean')],
      DEFAULT_REVIEW_LENSES,
      2,
    )
    expect(r.decision).toBe('integrate') // weight 1 < threshold 2
  })

  it('mustFix/clean stay lens COUNTS so the engine’s tally line keeps meaning', () => {
    const r = tallyLensReview(
      [v('correctness', 'must-fix', 'a'), v('security', 'must-fix', 'b'), v('perf', 'clean'), v('regression', null)],
      DEFAULT_REVIEW_LENSES,
    )
    expect(r.mustFix).toBe(2)
    expect(r.clean).toBe(1)
  })
})

// ── pure unit: the lens-specialized reviewer prompt ────────────────────────────
describe('buildReviewPrompt — lens specialization (card 5f85d2f5)', () => {
  it('injects the lens key + focus and keeps the verdict contract', () => {
    const lens = DEFAULT_REVIEW_LENSES.find((l) => l.key === 'security')!
    const p = buildReviewPrompt('origin/main', lens)
    expect(p).toContain('SECURITY lens')
    expect(p).toContain(lens.focus)
    expect(p).toContain('git diff origin/main...HEAD')
    expect(p).toContain('OPENGROUND_REVIEW: <VERDICT> ::OG_REVIEW_END::')
    expect(p).toMatch(/READ-ONLY/i)
  })

  it('every default lens prompt is ECHO-SAFE — scrapes to a non-vote (incl. perf’s "clean up")', () => {
    // perf.focus literally contains "clean up after itself"; prove the marker-bounded
    // scraper never miscounts focus prose as a CLEAN vote (a false clean would let a
    // hung reviewer's echoed prompt auto-merge unreviewed code).
    for (const lens of DEFAULT_REVIEW_LENSES) {
      expect(extractReviewVerdict(buildReviewPrompt('origin/main', lens)).vote).toBeNull()
    }
  })

  it('with NO lens the prompt is the unchanged homogeneous-panel prompt', () => {
    const p = buildReviewPrompt('origin/main')
    expect(p).not.toContain('YOUR LENS')
    expect(p).toMatch(/independent adversarial code reviewer/i)
  })
})

// ── real git, HOME-isolated: makeAdversarialReview lens panel end-to-end ────────
describe('makeAdversarialReview — lens panel end-to-end (real git, HOME-isolated)', () => {
  const execFile = promisify(execFileCb)
  const git = (cwd: string, args: string[]) =>
    execFile('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })

  let home: string
  let scratch: string

  // A real repo with a real bare origin (origin/main resolvable, registered so
  // projectUUIDFromPath / centralWorktreesDir resolve under the isolated HOME).
  const setupRepo = async (): Promise<string> => {
    const origin = join(scratch, 'origin.git')
    const proj = join(scratch, 'proj')
    await git(scratch, ['init', '--bare', '-b', 'main', origin])
    await git(scratch, ['init', '-b', 'main', proj])
    await git(proj, ['config', 'user.email', 'dev@test'])
    await git(proj, ['config', 'user.name', 'Dev'])
    await git(proj, ['remote', 'add', 'origin', origin])
    await writeFile(join(proj, 'README.md'), '# base\n')
    await git(proj, ['add', '-A'])
    await git(proj, ['commit', '-m', 'base'])
    await git(proj, ['push', '-u', 'origin', 'main'])
    await addProjectEntry(proj)
    return proj
  }

  // A swarm/* branch carrying one real commit → a non-empty diff for the panel to review.
  const branchWithCommit = async (proj: string): Promise<{ branch: string; tip: string }> => {
    const wt = await createSwarmWorktree(proj)
    await writeFile(join(wt.worktree, 'feature.ts'), 'export const add = (a: number, b: number) => a + b\n')
    await git(wt.worktree, ['add', '-A'])
    await git(wt.worktree, ['commit', '-m', 'feat: add'])
    const tip = (await git(wt.worktree, ['rev-parse', 'HEAD'])).stdout.trim()
    return { branch: wt.branch, tip }
  }

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'og-lens-home-')))
    scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-lens-scratch-')))
    process.env.OPENGROUND_HOME = home
    __resetMigrationCacheForTests()
    __resetOrchestratorForTests()
  })
  afterEach(async () => {
    __resetOrchestratorForTests()
    __resetQuotaForTest() // the cooling table is a globalThis singleton — never leak across cases
    await rm(home, { recursive: true, force: true })
    await rm(scratch, { recursive: true, force: true })
  })

  it('(1) launches ONE reviewer PER lens, each handed its own lens', async () => {
    const proj = await setupRepo()
    const { branch, tip } = await branchWithCommit(proj)
    const seen: string[] = []
    const review = makeAdversarialReview({
      lenses: DEFAULT_REVIEW_LENSES,
      runReviewer: async ({ lens }) => {
        seen.push(lens!.key)
        return 'OPENGROUND_REVIEW: CLEAN ::OG_REVIEW_END::'
      },
    })
    const r = await review(proj, branch, 'main', { tip })
    expect([...seen].sort()).toEqual(['correctness', 'perf', 'regression', 'security'])
    expect(r.decision).toBe('integrate')
  }, 30_000)

  it('(2)+(4) a single lens returning must-fix sends the branch back; its note hits the log (条件3)', async () => {
    const proj = await setupRepo()
    const { branch, tip } = await branchWithCommit(proj)
    const review = makeAdversarialReview({
      lenses: DEFAULT_REVIEW_LENSES,
      runReviewer: async ({ lens }) =>
        lens!.key === 'correctness'
          ? 'reading…\nOPENGROUND_REVIEW: MUST_FIX integer overflow on large inputs ::OG_REVIEW_END::'
          : 'OPENGROUND_REVIEW: CLEAN ::OG_REVIEW_END::',
    })
    const r = await review(proj, branch, 'main', { tip })
    expect(r.decision).toBe('rework')
    expect(r.reason).toContain('correctness=must-fix')
    expect(r.reason).toContain('integer overflow on large inputs')
  }, 30_000)

  it('(4) all lenses clean → integrate', async () => {
    const proj = await setupRepo()
    const { branch, tip } = await branchWithCommit(proj)
    const review = makeAdversarialReview({
      lenses: DEFAULT_REVIEW_LENSES,
      runReviewer: async () => 'OPENGROUND_REVIEW: CLEAN ::OG_REVIEW_END::',
    })
    const r = await review(proj, branch, 'main', { tip })
    expect(r.decision).toBe('integrate')
  }, 30_000)

  it('quota park (every tier cooling) defers WITHOUT spawning a single reviewer', async () => {
    const proj = await setupRepo()
    const { branch, tip } = await branchWithCommit(proj)
    // Every ladder tier cooling well past now — the state the dispatch park holds in.
    for (const tier of MODEL_TIER_LADDER) markCoolingUntil(tier, Date.now() + 10 * 60_000)
    const seen: string[] = []
    const review = makeAdversarialReview({
      lenses: DEFAULT_REVIEW_LENSES,
      runReviewer: async ({ lens }) => {
        seen.push(lens!.key)
        return 'OPENGROUND_REVIEW: CLEAN ::OG_REVIEW_END::'
      },
    })
    const r = await review(proj, branch, 'main', { tip })
    expect(r.decision).toBe('defer') // retry next pass — defer never merges un-reviewed
    expect(r.skippedForPark).toBe(true) // engine hold, NOT a verdict — callers keep it out of the defer streak
    expect(r.reason).toContain('quota park')
    expect(seen).toHaveLength(0) // not ONE reviewer burned into the exhausted wall
  }, 30_000)

  it('an abstaining lens (no parseable verdict) → defer — never merges an un-reviewed dimension', async () => {
    const proj = await setupRepo()
    const { branch, tip } = await branchWithCommit(proj)
    const review = makeAdversarialReview({
      lenses: DEFAULT_REVIEW_LENSES,
      runReviewer: async ({ lens }) =>
        lens!.key === 'perf'
          ? 'the model rambled but never emitted a verdict'
          : 'OPENGROUND_REVIEW: CLEAN ::OG_REVIEW_END::',
    })
    const r = await review(proj, branch, 'main', { tip })
    expect(r.decision).toBe('defer')
    expect(r.reason).toContain('perf=abstain')
  }, 30_000)
})

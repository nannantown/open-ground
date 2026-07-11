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
  classifyAbstainCause,
  computeReviewTimeoutMs,
  describeAbstainTallies,
  RATE_LIMIT_TAIL_MAX,
  DEFAULT_REVIEW_LENSES,
  __resetOrchestratorForTests,
  type ReviewLens,
  type ReviewLensKey,
  type ReviewVote,
  type ReviewerVerdict,
} from './swarmOrchestrator'
import { createSwarmWorktree } from './swarmWorker'
import { markCoolingUntil, __resetQuotaForTest, MODEL_TIER_LADDER } from './swarmQuota'
import { setSettings } from './store'

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

  // The panel defaults to SWARM_LAUNCH_MODEL (fable). Before the hard mask it was
  // the "half-lung" of this feature: workers respected a retired tier, reviewers
  // did not — every reviewer abstained and the defer streak burned to needs-human
  // (the 0a7c641 symptom). These pin the panel to the same mask.
  it('a switched-OFF top tier moves the panel DOWN the ladder (not into the retired tier)', async () => {
    const proj = await setupRepo()
    const { branch, tip } = await branchWithCommit(proj)
    await setSettings({ swarmAllowedModels: { fable: false } })
    try {
      const models: string[] = []
      const review = makeAdversarialReview({
        lenses: DEFAULT_REVIEW_LENSES,
        // `model` is the tier the panel resolved for this spawn — the real runner
        // launches claude on it, so asserting here is asserting the launch.
        runReviewer: async ({ model }) => {
          models.push(model)
          return 'OPENGROUND_REVIEW: CLEAN ::OG_REVIEW_END::'
        },
      })
      const r = await review(proj, branch, 'main', { tip })
      expect(r.decision).toBe('integrate') // it RAN — fable being off is not a park
      expect(models).toHaveLength(DEFAULT_REVIEW_LENSES.length)
      expect(new Set(models)).toEqual(new Set(['opus'])) // never the retired fable
    } finally {
      await setSettings({ swarmAllowedModels: undefined })
    }
  }, 30_000)

  it('every tier switched OFF defers WITHOUT spawning a reviewer, and says a human must act', async () => {
    const proj = await setupRepo()
    const { branch, tip } = await branchWithCommit(proj)
    await setSettings({
      swarmAllowedModels: { fable: false, opus: false, sonnet: false, haiku: false },
    })
    try {
      const seen: string[] = []
      const review = makeAdversarialReview({
        lenses: DEFAULT_REVIEW_LENSES,
        runReviewer: async ({ lens }) => {
          seen.push(lens!.key)
          return 'OPENGROUND_REVIEW: CLEAN ::OG_REVIEW_END::'
        },
      })
      const r = await review(proj, branch, 'main', { tip })
      expect(r.decision).toBe('defer')
      expect(r.skippedForPark).toBe(true)
      expect(r.reason).toContain('no model tier is enabled')
      expect(r.reason).not.toContain('cooling') // there is no reset to wait for
      expect(seen).toHaveLength(0)
    } finally {
      await setSettings({ swarmAllowedModels: undefined })
    }
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

  // ── abstention ATTRIBUTION (card f3f1e5c6 完了条件1/5) — a defer must say WHO
  // abstained WHY; a bare 「多数決つかず」 froze cards with nothing to act on. ──

  it('回帰: EVERY lens abstains → defer, and the reason names each lens with its cause (完了条件5)', async () => {
    const proj = await setupRepo()
    const { branch, tip } = await branchWithCommit(proj)
    const review = makeAdversarialReview({
      lenses: DEFAULT_REVIEW_LENSES,
      runReviewer: async () => 'prose without any verdict marker', // systemic outage shape
    })
    const r = await review(proj, branch, 'main', { tip })
    expect(r.decision).toBe('defer') // fail-closed: nothing merges un-reviewed
    expect(r.skippedForPark).toBeUndefined() // a real panel verdict — consumes the defer streak
    for (const lens of DEFAULT_REVIEW_LENSES) {
      expect(r.reason).toContain(`${lens.key}=abstain(no-marker)`)
    }
    // The sizing context rides along, so the operator can judge the budget at a glance.
    expect(r.reason).toMatch(/diff \d+KB \/ budget \d+min\/reviewer/)
  }, 30_000)

  it('回帰: 2 lenses time out + 2 clean → still defer (fail-closed), but the reason RECORDS both timeouts (完了条件5)', async () => {
    const proj = await setupRepo()
    const { branch, tip } = await branchWithCommit(proj)
    // The observed f3f1e5c6 shape: the two slow lenses hit the wall-clock budget
    // (killTerminal'd before their marker), the two fast ones vote clean. The
    // structured {raw, ended} return is how the real runner reports a cut-off.
    const review = makeAdversarialReview({
      lenses: DEFAULT_REVIEW_LENSES,
      runReviewer: async ({ lens }) =>
        lens!.key === 'correctness' || lens!.key === 'regression'
          ? { raw: 'reading the diff… (killed at the budget)', ended: 'timeout' as const }
          : 'OPENGROUND_REVIEW: CLEAN ::OG_REVIEW_END::',
    })
    const r = await review(proj, branch, 'main', { tip })
    expect(r.decision).toBe('defer') // abstentions never lower the merge bar (完了条件4)
    expect(r.clean).toBe(2)
    expect(r.mustFix).toBe(0)
    expect(r.reason).toContain('correctness=abstain(timeout)')
    expect(r.reason).toContain('regression=abstain(timeout)')
    expect(r.reason).toContain('security=clean')
    expect(r.reason).toContain('perf=clean')
  }, 30_000)

  it('a reviewer that THROWS is attributed abstain(error) — not silently a bare non-vote', async () => {
    const proj = await setupRepo()
    const { branch, tip } = await branchWithCommit(proj)
    const review = makeAdversarialReview({
      lenses: DEFAULT_REVIEW_LENSES,
      runReviewer: async ({ lens }) => {
        if (lens!.key === 'security') throw new Error('PTY spawn failed')
        return 'OPENGROUND_REVIEW: CLEAN ::OG_REVIEW_END::'
      },
    })
    const r = await review(proj, branch, 'main', { tip })
    expect(r.decision).toBe('defer')
    expect(r.reason).toContain('security=abstain(error)')
  }, 30_000)
})

// ── pure unit: abstention attribution + the diff-scaled reviewer budget ─────────
describe('classifyAbstainCause — attributing WHY a reviewer produced no vote', () => {
  const NOTICE =
    "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model."

  it('a transcript ENDING in the rate-limit notice is limit — even when the loop edge was a timeout', () => {
    expect(classifyAbstainCause(NOTICE, 'timeout')).toBe('limit')
    expect(classifyAbstainCause(NOTICE)).toBe('limit')
  })

  it("the runner's cut-off edge stands when the transcript is not a limit: timeout / aborted", () => {
    expect(classifyAbstainCause('reading the diff…', 'timeout')).toBe('timeout')
    expect(classifyAbstainCause('partial output', 'aborted')).toBe('aborted')
  })

  it('a self-ended PTY with NO output at all is spawn-failed (claude never really started)', () => {
    expect(classifyAbstainCause('')).toBe('spawn-failed')
    expect(classifyAbstainCause('   \n ')).toBe('spawn-failed')
  })

  it('a self-ended PTY with output but no marker is no-marker', () => {
    expect(classifyAbstainCause('the model rambled and stopped')).toBe('no-marker')
  })

  it('quoting the limit notice and working WELL past it (beyond the tail window) is NOT limit', () => {
    const worked = `${NOTICE}\n${'x'.repeat(RATE_LIMIT_TAIL_MAX + 1)}`
    expect(classifyAbstainCause(worked, 'timeout')).toBe('timeout')
  })
})

describe('computeReviewTimeoutMs — the diff-scaled reviewer budget (root cause of the f3f1e5c6 freeze)', () => {
  const BASE = 5 * 60_000

  it('a tiny diff keeps the flat floor', () => {
    expect(computeReviewTimeoutMs(BASE, 0)).toBe(BASE)
    expect(computeReviewTimeoutMs(BASE, 512)).toBe(BASE + 10_000) // 1KB rounded up
  })

  it('the measured freeze boundary (≥34KB froze on the flat 5min) now gets a real budget', () => {
    // 33,891 bytes — the smallest diff OBSERVED to freeze (clean 2 / 2 timeouts).
    const budget = computeReviewTimeoutMs(BASE, 33_891)
    expect(budget).toBeGreaterThan(BASE) // no longer the flat floor that froze it
    expect(budget).toBe(BASE + Math.ceil(33_891 / 1024) * 10_000) // +10s per KB
  })

  it('a huge diff is capped at 20min — the budget never grows unbounded', () => {
    expect(computeReviewTimeoutMs(BASE, 122_858)).toBe(20 * 60_000) // the 122KB frozen card
    expect(computeReviewTimeoutMs(BASE, 10_000_000)).toBe(20 * 60_000)
  })

  it('an UNSIZABLE diff (git failed / overflow) budgets as if large — fail toward waiting, never the freeze', () => {
    expect(computeReviewTimeoutMs(BASE, null)).toBe(20 * 60_000)
  })

  it('an explicit base ABOVE the cap wins (the caller asked for it)', () => {
    expect(computeReviewTimeoutMs(30 * 60_000, 1024)).toBe(30 * 60_000)
    expect(computeReviewTimeoutMs(30 * 60_000, null)).toBe(30 * 60_000)
  })
})

describe('describeAbstainTallies — the needs-human hand-off fragment (完了条件3)', () => {
  it('names each lens(cause) with its streak count', () => {
    expect(describeAbstainTallies({ 'correctness(timeout)': 3, 'regression(timeout)': 3 })).toBe(
      'correctness(timeout)×3, regression(timeout)×3',
    )
  })

  it('a streak of pure ties (nobody abstained) reads なし', () => {
    expect(describeAbstainTallies({})).toBe('なし')
  })
})

describe('tallyLensReview — abstention causes reach the logged reason (完了条件1)', () => {
  it('an attributed abstention logs lens=abstain(cause), an unattributed one lens=abstain(unknown)', () => {
    const verdicts: ReviewerVerdict[] = [
      { reviewer: 1, lens: 'correctness', vote: null, note: '', abstainCause: 'timeout' },
      { reviewer: 2, lens: 'security', vote: 'clean', note: '' },
      { reviewer: 3, lens: 'perf', vote: 'clean', note: '' },
      { reviewer: 4, lens: 'regression', vote: null, note: '' },
    ]
    const r = tallyLensReview(verdicts, DEFAULT_REVIEW_LENSES)
    expect(r.decision).toBe('defer')
    expect(r.reason).toContain('correctness=abstain(timeout)')
    expect(r.reason).toContain('regression=abstain(unknown)')
  })
})

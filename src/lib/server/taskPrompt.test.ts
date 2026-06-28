import { describe, it, expect } from 'vitest'
import { buildTaskPrompt } from './taskPrompt'

// The first-prompt contract for Board-card claude sessions: title + content
// always; the branch/worktree protocol only on git projects; the markDone
// curl only when the card id is known.

describe('buildTaskPrompt', () => {
  const base = {
    cwd: '/Users/me/projects/app',
    port: 47776,
    task: {
      id: 'card-1',
      title: 'U2-153 Assign new location to the user',
      notes: 'Develop / Backlog\nNotion: https://example.com/spec',
    },
  }

  it('git project: title, content, branch protocol, worktree path, markDone curl', () => {
    const p = buildTaskPrompt({ ...base, worktreesDir: '/home/.openground/projects/u1/worktrees' })
    expect(p).toContain('# Task: U2-153 Assign new location to the user')
    expect(p).toContain('## Content')
    expect(p).toContain('Notion: https://example.com/spec')
    expect(p).toContain('`task/')
    expect(p).toContain(
      'git worktree add "/home/.openground/projects/u1/worktrees/<branch-name-without-prefix>" -b <branch>',
    )
    expect(p).toContain('Never check out branches in the main working tree (/Users/me/projects/app)')
    expect(p).toContain('finished and merged')
    expect(p).toContain(
      `curl -s -X POST http://127.0.0.1:47776/api/project/tasks -H 'content-type: application/json' -d '{"path":"/Users/me/projects/app","markDone":["card-1"]}'`,
    )
  })

  it('git project with a card id: setBranch curl right after the worktree step', () => {
    const p = buildTaskPrompt({ ...base, worktreesDir: '/home/.openground/projects/u1/worktrees' })
    expect(p).toContain(
      `curl -s -X POST http://127.0.0.1:47776/api/project/tasks -H 'content-type: application/json' -d '{"path":"/Users/me/projects/app","setBranch":[{"id":"card-1","branch":"<branch>"}]}'`,
    )
    // It must come before the completion step (4.) — record early, not at wrap-up.
    expect(p.indexOf('setBranch')).toBeLessThan(p.indexOf('4. When the task is complete'))
  })

  it('git project without a card id: no setBranch curl', () => {
    const p = buildTaskPrompt({
      cwd: '/x',
      port: 1,
      task: { title: 'No id' },
      worktreesDir: '/wt',
    })
    expect(p).not.toContain('setBranch')
  })

  it('non-git project: no branch protocol, still title + content + markDone', () => {
    const p = buildTaskPrompt({ ...base, worktreesDir: null })
    expect(p).not.toContain('git worktree')
    expect(p).not.toContain('task/')
    expect(p).toContain('## Content')
    expect(p).toContain('markDone')
    expect(p).toContain('finished, mark')
  })

  it('empty notes: no Content section; no id: no markDone block', () => {
    const p = buildTaskPrompt({
      cwd: '/x',
      port: 1,
      task: { title: 'Just a title', notes: '  ' },
      worktreesDir: null,
    })
    expect(p).toBe('# Task: Just a title')
  })

  // --- ProjectConfig (shared policy) -----------------------------------------

  const WT = '/home/.openground/projects/u1/worktrees'

  it('empty config: prompt identical to the no-config default', () => {
    const without = buildTaskPrompt({ ...base, worktreesDir: WT })
    const withEmpty = buildTaskPrompt({ ...base, worktreesDir: WT, config: {} })
    expect(withEmpty).toBe(without)
  })

  it("merge flow with explicit targetBranch: merges back into `main`, not the launch branch", () => {
    const p = buildTaskPrompt({
      ...base,
      worktreesDir: WT,
      config: { completionFlow: 'merge', targetBranch: 'main' },
    })
    expect(p).toContain('merge the task branch back into `main`')
    expect(p).not.toContain('the branch that was checked out when you started')
    // still the merge protocol: cleanup + markDone, no PR machinery
    expect(p).toContain('delete the task branch')
    expect(p).not.toContain('gh pr create')
    expect(p).toContain('markDone')
  })

  it('pr flow: gh pr create against the target base, keep the branch, never merge', () => {
    const p = buildTaskPrompt({
      ...base,
      worktreesDir: WT,
      config: { completionFlow: 'pr', targetBranch: 'develop' },
    })
    expect(p).toContain('gh pr create --base develop --head <branch>')
    expect(p).toContain('Report the PR URL')
    expect(p).toContain('`git worktree remove`')
    expect(p).toContain('KEEP the task branch')
    expect(p).toContain('Do NOT merge the pull request yourself')
    // the merge-back instruction is fully replaced
    expect(p).not.toContain('merge the task branch back')
    expect(p).not.toContain('delete the task branch')
  })

  it('pr flow without targetBranch: base falls back to the launch-time branch', () => {
    const p = buildTaskPrompt({ ...base, worktreesDir: WT, config: { completionFlow: 'pr' } })
    expect(p).toContain('gh pr create --base <launch-branch> --head <branch>')
    expect(p).toContain('the branch that was checked out when you started')
  })

  it('pr flow: records the PR URL AND moves the card to review (review lane always shown, no markDone)', () => {
    const p = buildTaskPrompt({
      ...base,
      worktreesDir: WT,
      config: { completionFlow: 'pr', targetBranch: 'main' },
    })
    expect(p).toContain(
      `curl -s -X POST http://127.0.0.1:47776/api/project/tasks -H 'content-type: application/json' -d '{"path":"/Users/me/projects/app","setPrUrl":[{"id":"card-1","url":"<PR-URL>"}],"setColumn":[{"id":"card-1","column":"review"}]}'`,
    )
    expect(p).not.toContain('markDone')
  })

  it('branch protocol tells claude to suffix on a name collision (F083)', () => {
    const p = buildTaskPrompt({ ...base, worktreesDir: WT })
    expect(p).toContain('already exists, append a numeric suffix')
  })

  it('non-pr flow never emits a setColumn move (only markDone)', () => {
    const p = buildTaskPrompt({ ...base, worktreesDir: WT, config: { completionFlow: 'merge' } })
    expect(p).toContain('markDone')
    expect(p).not.toContain('setColumn')
  })

  it('verifyCommands is RETIRED: legacy saved values never reach the prompt', () => {
    // The Settings editor for verifyCommands was removed (2026-06-11); legacy
    // data may still carry values — they must be ignored, not injected as
    // hidden prompt-steering.
    const p = buildTaskPrompt({
      ...base,
      worktreesDir: WT,
      config: { verifyCommands: ['npm test', 'rm -rf /'] },
    })
    expect(p).not.toContain('Definition of done')
    expect(p).not.toContain('npm test')
    expect(p).not.toContain('rm -rf /')
  })
})

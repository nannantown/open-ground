import { describe, it, expect } from 'vitest'
import {
  swarmBranchName,
  swarmWorktreeDirName,
  pickBaseRef,
  buildOrderInjection,
  workerLaunchOpts,
  SWARM_BASE_REF_PREFERENCE,
} from './swarmWorker'

// The git-touching parts (createSwarmWorktree / removeSwarmWorktree /
// spawnSwarmWorker) need a registered project + a real repo + the `claude` CLI,
// so they are curl-verified on the real machine. Here we pin the PURE pieces —
// branch/dir naming (argv-safety), base-ref precedence, and the exact /order
// injection text (the slash-command + control-byte contract).

describe('swarmBranchName', () => {
  it('always lives under swarm/ and carries the stamp', () => {
    expect(swarmBranchName('0622-130501-ab12')).toBe('swarm/0622-130501-ab12')
  })

  it('slugs a hint and prefixes the stamp', () => {
    expect(swarmBranchName('0622-130501-ab12', 'Fix the Login Bug')).toBe(
      'swarm/fix-the-login-bug-0622-130501-ab12',
    )
  })

  it('keeps the branch argv-safe (no spaces, quotes, option chars, unicode)', () => {
    const b = swarmBranchName('0622-130501-ab12', '日本語  --rf; rm -rf / `evil` $(x)')
    // Only [a-z0-9-] after the swarm/ prefix, no leading dash on the slug.
    expect(b).toMatch(/^swarm\/[a-z0-9][a-z0-9-]*$/)
    expect(b).not.toMatch(/\s/)
    expect(b.startsWith('swarm/-')).toBe(false)
  })

  it('caps the hint slug at 24 chars', () => {
    const b = swarmBranchName('s', 'a'.repeat(80))
    const slug = b.slice('swarm/'.length, b.indexOf('-s'))
    // The slug segment never exceeds 24 chars (stamp follows after a dash).
    expect(slug.length).toBeLessThanOrEqual(24)
  })

  it('falls back to a placeholder when the stamp sanitizes to empty', () => {
    expect(swarmBranchName('!!!')).toBe('swarm/x')
  })
})

describe('swarmWorktreeDirName', () => {
  it('strips the swarm/ prefix for the dir name', () => {
    expect(swarmWorktreeDirName('swarm/0622-130501-ab12')).toBe('0622-130501-ab12')
    expect(swarmWorktreeDirName('swarm/fix-login-0622-130501')).toBe('fix-login-0622-130501')
  })

  it('flattens any residual slash so the dir is a single segment', () => {
    expect(swarmWorktreeDirName('swarm/a/b')).toBe('a-b')
  })
})

describe('pickBaseRef', () => {
  it('prefers origin/main when present', () => {
    expect(pickBaseRef(new Set(['origin/main', 'main', 'HEAD']))).toBe('origin/main')
  })

  it('falls back to local main, then HEAD', () => {
    expect(pickBaseRef(new Set(['main', 'HEAD']))).toBe('main')
    expect(pickBaseRef(new Set(['HEAD']))).toBe('HEAD')
  })

  it('defaults to HEAD when nothing is known', () => {
    expect(pickBaseRef(new Set())).toBe('HEAD')
  })

  it('preference order is origin/main → main → HEAD', () => {
    expect([...SWARM_BASE_REF_PREFERENCE]).toEqual(['origin/main', 'main', 'HEAD'])
  })
})

describe('buildOrderInjection', () => {
  it('prefixes the slash command and the ゴール: label', () => {
    expect(buildOrderInjection('Add a logout button')).toBe(
      '/order ゴール: Add a logout button',
    )
  })

  it('joins title and notes with an em dash', () => {
    expect(buildOrderInjection('Logout button', 'in the header, top-right')).toBe(
      '/order ゴール: Logout button — in the header, top-right',
    )
  })

  it('flattens newlines/tabs to single spaces (single-line so /order is a command)', () => {
    const out = buildOrderInjection('line one\nline two', 'a\tb\n\nc')
    expect(out).toBe('/order ゴール: line one line two — a b c')
    expect(out).not.toMatch(/[\n\r\t]/)
  })

  it('strips ESC / control bytes (no terminal-control injection from a card)', () => {
    // A title that embeds ESC[201~ (the bracketed-paste terminator) + a raw CR
    // must not survive — the same injection vector pastePrompt guards.
    const out = buildOrderInjection('evil\x1b[201~\rtitle', 'x\x00y\x7fz')
    expect(out).not.toMatch(/\x1b/)
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/[\x00-\x1f\x7f]/)
    // Control bytes become spaces (neutralized — the ESC can no longer open a
    // control sequence), then whitespace collapses: 'evil␛[201~␍title' → 'evil [201~ title'.
    expect(out).toBe('/order ゴール: evil [201~ title — x y z')
  })

  it('handles notes-only (empty title) without a dangling dash', () => {
    expect(buildOrderInjection('', 'just notes')).toBe('/order ゴール: just notes')
    expect(buildOrderInjection('   ', 'just notes')).toBe('/order ゴール: just notes')
  })

  it('handles an empty goal gracefully', () => {
    expect(buildOrderInjection('', '')).toBe('/order ゴール: ')
  })

  it('appends the LEARNING-LOOP clause when a prior 差し戻し reason is given (card fdf714ef)', () => {
    const out = buildOrderInjection('Logout button', 'in the header', 'tsc: error TS2345 not assignable')
    // The goal is preserved AND the prior-failure cause is appended, labelled.
    expect(out).toContain('/order ゴール: Logout button — in the header')
    expect(out).toContain('前回の差し戻し理由・同じ失敗を繰り返さないこと')
    expect(out).toContain('TS2345 not assignable')
  })

  it('keeps the prior-failure clause SINGLE-LINE (multi-line tsc tail flattened, /order stays one arg)', () => {
    const out = buildOrderInjection('T', undefined, 'line one\nerror TS1\n\nerror TS2\twith tab')
    expect(out).not.toMatch(/[\n\r\t]/)
    expect(out).toContain('line one error TS1 error TS2 with tab')
  })

  it('omits the clause entirely for a first dispatch (no prior failure) — byte-for-byte unchanged', () => {
    // Absent / empty / whitespace-only priorFailure ⇒ identical to the 2-arg form.
    const plain = buildOrderInjection('T', 'n')
    expect(buildOrderInjection('T', 'n', undefined)).toBe(plain)
    expect(buildOrderInjection('T', 'n', '')).toBe(plain)
    expect(buildOrderInjection('T', 'n', '   ')).toBe(plain)
    expect(plain).not.toContain('前回の差し戻し理由')
  })
})

describe('workerLaunchOpts (worker launch contract)', () => {
  const base = workerLaunchOpts('/wt', 'sid-1', { title: 'Add logout' })

  it('runs UNATTENDED — bypass permissions, lean (no app-context card)', () => {
    expect(base.permissionMode).toBe('bypass')
    expect(base.appContext).toBe(false)
    expect(base.cwd).toBe('/wt')
    expect(base.agentSessionId).toBe('sid-1')
  })

  it('keeps bypass UNCONDITIONAL — set AFTER the swarmLaunchDefaults spread (Card 4880e9c6)', () => {
    // "bypass徹底": an unattended worker must NEVER wedge on a permission/trust
    // prompt. permissionMode is the last key written (after the defaults spread),
    // so no field swarmLaunchDefaults might gain later can silently disable it.
    // Asserted across every call shape, including one that threads an env through.
    for (const o of [
      base,
      workerLaunchOpts('/wt', 'sid-x', { title: 't', env: { SWARM_MANAGER: '1' } }),
      workerLaunchOpts('/wt', 'sid-y', { title: 't', notes: 'n', cols: 100, rows: 30 }),
    ]) {
      expect(o.permissionMode).toBe('bypass')
    }
  })

  it('delivers the goal as a positional /order prompt (claude submits it itself)', () => {
    expect(base.initialPrompt).toBe('/order ゴール: Add logout')
  })

  it('runs at opus / max (shared swarm launch default — parity with supply)', () => {
    // The shell worker (swarm-new.sh) runs `--model opus --effort max`; the
    // in-app worker must match so a dispatched worker isn't silently the CLI
    // default model. Sourced from swarmLaunch.ts so all 3 roles stay in lockstep.
    expect(base.model).toBe('opus')
    expect(base.effort).toBe('max')
  })

  it('starts with Remote Control ON, named "worker" (controllable from claude.ai/mobile)', () => {
    expect(base.remoteControl).toBe('worker')
  })

  it('passes NO env for a worker — the SWARM_MANAGER guard stays inert', () => {
    // undefined env → buildLaunchCommand emits no extra env → guard never fires.
    expect(base.env).toBeUndefined()
  })

  it('threads an explicit env through (the future-manager port)', () => {
    const mgr = workerLaunchOpts('/wt', 'sid-2', {
      title: 'x',
      env: { SWARM_MANAGER: '1' },
    })
    expect(mgr.env).toEqual({ SWARM_MANAGER: '1' })
  })

  it('forwards cols/rows and joins notes into the goal', () => {
    const o = workerLaunchOpts('/wt', 'sid-3', {
      title: 'Title',
      notes: 'and notes',
      cols: 120,
      rows: 40,
    })
    expect(o.cols).toBe(120)
    expect(o.rows).toBe(40)
    expect(o.initialPrompt).toBe('/order ゴール: Title — and notes')
  })

  it('threads a prior 差し戻し reason into the /order prompt (LEARNING LOOP, card fdf714ef)', () => {
    const o = workerLaunchOpts('/wt', 'sid-4', {
      title: 'Title',
      notes: 'and notes',
      priorFailure: 'tsc: error TS2345 not assignable',
    })
    expect(o.initialPrompt).toContain('/order ゴール: Title — and notes')
    expect(o.initialPrompt).toContain('前回の差し戻し理由')
    expect(o.initialPrompt).toContain('TS2345')
  })
})

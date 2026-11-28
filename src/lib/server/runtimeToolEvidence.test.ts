import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeDirName } from './claudeProjectDir'
import { findToolOutcome } from './runtimeToolEvidence'

// The projects directory is injected: nothing here reads or writes the real
// ~/.claude (setup-home.ts points TMPDIR at this file's own sandbox).
const h = vi.hoisted(() => ({ projects: '' }))
vi.mock('./transcript', async original => ({ ...(await original<typeof import('./transcript')>()), claudeProjectsRoot: () => h.projects }))
beforeEach(async () => { h.projects = await mkdtemp(join(tmpdir(), 'claude-projects-')) })
// The call's own `description` rides along (R-B3/R-B4: the owner's question names
// the operation by it); these cases are about the outcome, so it is set aside.
const outcomeOf = async (...args: Parameters<typeof findToolOutcome>) => {
  const { description: _description, ...outcome } = await findToolOutcome(...args) as Awaited<ReturnType<typeof findToolOutcome>> & { description?: string }
  return outcome
}

// Line shapes copied from real transcripts (2026-11-28, CLI 2.1.233–2.1.332),
// trimmed to the fields that carry meaning; paths and ids are fixtures.
const SESSION = '87fe9033-eb8c-4953-9cab-7e11ae365ac1'
const CWD = '/Users/me/projects/sns-hub'
const INPUT = { command: 'git worktree remove --force /fixture/worktree', description: 'Remove the finished worktree' }
const meta = (agentId?: string) => ({ isSidechain: agentId !== undefined, ...(agentId ? { agentId } : {}),
  userType: 'external', entrypoint: 'sdk-ts', cwd: CWD, sessionId: SESSION, version: '2.1.319', gitBranch: 'main' })
const use = (id: string, agentId?: string, input: unknown = INPUT, name = 'Bash') => JSON.stringify({ parentUuid: 'p', ...meta(agentId),
  message: { model: 'claude-opus-5-5', id: 'msg_fixture', type: 'message', role: 'assistant', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id, name, input, caller: { type: 'direct' } }] },
  type: 'assistant', uuid: `use-${id}`, timestamp: '2026-11-09T09:06:14.513Z' })
const hook = (id: string, agentId?: string) => JSON.stringify({ parentUuid: `use-${id}`, ...meta(agentId), type: 'attachment', uuid: `hook-${id}`,
  attachment: { type: 'hook_success', hookName: 'PreToolUse:Bash', toolUseID: id, hookEvent: 'PreToolUse', content: '', stdout: '{}', stderr: '', exitCode: 0,
    command: 'node /Users/me/.openground/guard/openground-guard.js', durationMs: 34 }, timestamp: '2026-11-09T09:06:14.556Z' })
const result = (id: string, block: Record<string, unknown>, extra: Record<string, unknown> = {}, agentId?: string) => JSON.stringify({ parentUuid: `use-${id}`,
  ...meta(agentId), promptId: 'prompt', type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, ...block }] },
  uuid: `result-${id}`, timestamp: '2026-11-09T09:06:14.660Z', sourceToolAssistantUUID: `use-${id}`, ...extra })
const unrelated = JSON.stringify({ type: 'user', ...meta(), message: { role: 'user', content: 'Saved goal for the commander.' } })

const VETO = (rule: string) => `PreToolUse:Bash hook error: [bash /Users/me/.claude/swarm-guard.sh]: swarm-guard BLOCKED: ${rule}. (manager guardrail — never do this; do it the safe way or ask the user.)\n`
const HOOK_REJECT = { toolDenialKind: 'permission-rule', permissionDecision: { decision: 'reject', source: 'hook', reasonType: 'hook', reasonCode: 'hook:PreToolUse' } }
const vetoed = (id: string, rule: string, agentId: string) => result(id, { content: VETO(rule), is_error: true }, { toolUseResult: `Error: ${VETO(rule)}`, ...HOOK_REJECT }, agentId)
const REFUSED = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."
// The SAME denial kind for a call cut off while RUNNING (real OG worker, CLI
// 2.1.329, bypassPermissions: a Bash with a 600 s timeout started 07:26:57Z and got
// this result 163 s later, then the interrupt text line). No toolDenialBeforeRun.
const CUT_WHILE_RUNNING = `${REFUSED} Correction to the text above: this call was stopped while running, not refused before it ran. It may have run in part or in full, and its changes may have been written. No permission prompt was involved. Work it started elsewhere (a remote command, a background process) may still be running, so check before starting the same work again. The instruction to stop and wait still stands.`
const ENDED = "[Tool call interrupted: the session ended before this call's result was recorded, so its outcome is unknown. Check whether it took effect before relying on it or running it again.]"
const KILLED = 'Exit code 137\n\n    /// Begins a call from the chat\'s call button and waits until it listens.'
const ACCEPTED = { sandboxed: false, permissionDecision: { decision: 'accept', source: 'config', reasonType: 'mode' } }

/** Writes the main transcript and/or one sub-agent transcript of SESSION. */
const transcript = async (files: { main?: string[]; sub?: string[] }, cwd = CWD) => {
  const dir = join(h.projects, claudeDirName(cwd))
  await mkdir(join(dir, SESSION, 'subagents'), { recursive: true })
  if (files.main) await writeFile(join(dir, `${SESSION}.jsonl`), files.main.join('\n') + '\n')
  if (files.sub) await writeFile(join(dir, SESSION, 'subagents', 'agent-a0644c3633bc342b0.jsonl'), files.sub.join('\n') + '\n')
}
const id = 'toolu_016xsz5xpQNbrbCh3iE5KgBo'
const SUB = 'a0644c3633bc342b0'

describe('what the native transcript records about one tool call (the §1.1 holds)', () => {
  it.each([
    { row: 'sns-hub — commander sub-agent, a foreign PreToolUse hook veto', files: { main: [unrelated], sub: [use(id, SUB), hook(id, SUB), vetoed(id, 'git worktree remove --force', SUB)] },
      outcome: { kind: 'result', isError: true, interrupted: false } },
    { row: 'Music Production / Documents / JobSearch — the same hook, another rule', files: { main: [unrelated], sub: [use(id, SUB), hook(id, SUB), vetoed(id, 'recursive rm on an absolute, home or parent path', SUB)] },
      outcome: { kind: 'result', isError: true, interrupted: false } },
    { row: 'openground-ec — worker, a normal result (and a transformed api-request-blob copy of the call)', files: { main: [unrelated, use(id), hook(id),
      result(id, { content: '73:  const loaded = { exports: {} }', is_error: false }, { toolUseResult: { stdout: '73:  const loaded = { exports: {} }', stderr: '', interrupted: false, isImage: false, noOutputExpected: false }, ...ACCEPTED }),
      JSON.stringify({ type: 'api-request-blob', sessionId: SESSION, hash: 'h', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: `cd /fixture && ${INPUT.command}` } }] } })] },
      outcome: { kind: 'result', isError: false, interrupted: false } },
    { row: 'OPEN GROUND — commander sub-agent, a normal result whose line has no toolUseResult', files: { sub: [use(id, SUB), hook(id, SUB), result(id, { content: 'commit\ncommit f4becfb4', is_error: false }, ACCEPTED, SUB)] },
      outcome: { kind: 'result', isError: false, interrupted: false } },
    { row: 'openground-ios — commander, Exit code 137', files: { main: [use(id), result(id, { content: KILLED, is_error: true }, { toolUseResult: `Error: ${KILLED}`, ...ACCEPTED })] },
      outcome: { kind: 'result', isError: true, interrupted: false } },
    // Review A-M1 (2026-11-28): this fixture used to carry no toolDenialBeforeRun and
    // read as "never ran" — a shape that cannot be told apart from a call cut off
    // while running (CUT_WHILE_RUNNING below). The CLI writes the flag only when the
    // call had not started (2.1.332 StreamingToolExecutor; real 2.1.331 sub-agent line).
    { row: 'a user refusal before the call ran (toolDenialBeforeRun, then the CLI’s interrupt text line)', files: { main: [use(id), result(id, { content: REFUSED, is_error: true }, { toolUseResult: 'User rejected tool use', toolDenialKind: 'user-rejected', toolDenialBeforeRun: true }),
      JSON.stringify({ type: 'user', ...meta(), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] }, interruptedMessageId: 'msg_fixture' })] },
      outcome: { kind: 'result', isError: true, interrupted: false } },
    { row: 'JobSearch president — a tool_use and no result', files: { main: [unrelated, use(id)] }, outcome: { kind: 'started-no-result' } },
    { row: 'no line names the call', files: { main: [unrelated], sub: [use('toolu_other', SUB)] }, outcome: { kind: 'no-record' } },
  ])('$row', async ({ files, outcome }) => {
    await transcript(files)
    expect(await outcomeOf(SESSION, id, { cwd: CWD })).toEqual(outcome)
  })

  it.each([
    { what: 'the CLI’s “session ended before this call’s result was recorded” stand-in', line: result(id, { content: ENDED, is_error: true }, { toolUseResult: ENDED, toolDenialKind: 'interrupted' }) },
    { what: 'an interrupted Bash result (toolUseResult.interrupted)', line: result(id, { content: 'partial output', is_error: false }, { toolUseResult: { stdout: 'partial output', stderr: '', interrupted: true } }) },
    { what: 'the request-interrupted marker as the result', line: result(id, { content: '[Request interrupted by user for tool use]', is_error: true }, { toolUseResult: 'Error: [Request interrupted by user for tool use]' }) },
    { what: 'a denial kind nobody has measured yet', line: result(id, { content: 'Denied.', is_error: true }, { toolUseResult: 'Error: Denied.', toolDenialKind: 'some-future-kind' }) },
    { what: 'a user-rejected result with no toolDenialBeforeRun (the real 163 s Bash, CLI 2.1.329)', line: result(id, { content: CUT_WHILE_RUNNING, is_error: true }, { toolUseResult: 'User rejected tool use', toolDenialKind: 'user-rejected', version: '2.1.329' }) },
    { what: 'a user-rejected result from a CLI that never wrote the flag (2.1.233)', line: result(id, { content: REFUSED, is_error: true }, { toolUseResult: 'User rejected tool use', toolDenialKind: 'user-rejected', version: '2.1.233' }) },
    { what: 'a result the CLI wrote on shutdown (interruptedByShutdown, no denial kind)', line: result(id, { content: 'partial output', is_error: true }, { toolUseResult: 'Error: partial output', interruptedByShutdown: true }) },
    { what: 'a not-yet-started refusal cut by shutdown (the CLI’s own loader relabels it interrupted)', line: result(id, { content: REFUSED, is_error: true }, { toolUseResult: 'User rejected tool use', toolDenialKind: 'user-rejected', toolDenialBeforeRun: true, interruptedByShutdown: true }) },
    { what: 'a denial the CLI marks as after the run (toolDenialAfterRun)', line: result(id, { content: 'Denied after it ran.', is_error: true }, { toolUseResult: 'Error: Denied after it ran.', toolDenialKind: 'permission-rule', toolDenialAfterRun: true }) },
  ])('reads $what as interrupted, never as a known result', async ({ line }) => {
    await transcript({ main: [use(id), line, JSON.stringify({ type: 'user', ...meta(), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } })] })
    expect(await outcomeOf(SESSION, id, { cwd: CWD })).toEqual({ kind: 'result', isError: expect.any(Boolean), interrupted: true })
  })

  it('carries the call\'s own description (with or without a result) and nothing else of its input', async () => {
    await transcript({ main: [use(id)] })
    expect(await findToolOutcome(SESSION, id, { cwd: CWD })).toEqual({ kind: 'started-no-result', description: 'Remove the finished worktree' })
    expect(JSON.stringify(await findToolOutcome(SESSION, id, { cwd: CWD }))).not.toContain('git worktree')
  })

  it('never carries a description that is another tool\'s payload (an MCP issue creator, TaskCreate)', async () => {
    await transcript({ main: [use(id, undefined, { title: 't', description: 'the issue body, an argument' }, 'mcp__tracker__create_issue')] })
    expect(await findToolOutcome(SESSION, id, { cwd: CWD })).toEqual({ kind: 'started-no-result' })
  })

  it('takes a result as evidence only for the call it belongs to (identity check on the tool_use)', async () => {
    await transcript({ main: [use(id), result(id, { content: 'done', is_error: false })] })
    const exact = (name: string, input: unknown) => name === 'Bash' && JSON.stringify(input) === JSON.stringify(INPUT)
    expect(await outcomeOf(SESSION, id, { cwd: CWD, use: exact })).toEqual({ kind: 'result', isError: false, interrupted: false })
    expect(await outcomeOf(SESSION, id, { cwd: CWD, use: name => name === 'Write' })).toEqual({ kind: 'no-record' })
  })

  it('does not count a meta or synthetic result line as evidence', async () => {
    const synthetic = JSON.parse(result(id, { content: 'done', is_error: false }))
    await transcript({ main: [use(id), JSON.stringify({ ...synthetic, isSynthetic: true }), JSON.stringify({ ...synthetic, isMeta: true })] })
    expect(await outcomeOf(SESSION, id, { cwd: CWD })).toEqual({ kind: 'started-no-result' })
  })

  it('finds the folder by session id when the receipt predates the recorded cwd', async () => {
    await transcript({ sub: [use(id, SUB), vetoed(id, 'git worktree remove --force', SUB)] }, '/Users/me/projects/elsewhere')
    expect(await outcomeOf(SESSION, id)).toEqual({ kind: 'result', isError: true, interrupted: false })
    expect(await outcomeOf(SESSION, id, { cwd: CWD })).toEqual({ kind: 'no-record' })
  })

  // Review A N1 (2026-11-28): the folder list was cached on the projects ROOT's
  // mtime, which a session file created inside an existing project folder does not
  // change — so a first miss lasted until restart and the hold stayed.
  it('finds a session that appeared in an existing folder after a first miss (old receipt, no cwd), within the re-read bound', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const dir = join(h.projects, claudeDirName('/Users/me/projects/late'))
      await mkdir(dir, { recursive: true })
      expect(await outcomeOf(SESSION, id)).toEqual({ kind: 'no-record' })
      await writeFile(join(dir, `${SESSION}.jsonl`), [use(id), result(id, { content: 'done', is_error: false })].join('\n') + '\n')
      // Bounded: within 30 s the cached miss stands (no full re-listing per tool call)…
      expect(await outcomeOf(SESSION, id)).toEqual({ kind: 'no-record' })
      // …after it, the folder is found and the result counts.
      vi.setSystemTime(Date.now() + 31_000)
      expect(await outcomeOf(SESSION, id)).toEqual({ kind: 'result', isError: false, interrupted: false })
    } finally { vi.useRealTimers() }
  })

  it('reads a transcript again once it has changed, so a result written after a first miss still counts', async () => {
    await transcript({ main: [use(id)] })
    expect(await outcomeOf(SESSION, id, { cwd: CWD })).toEqual({ kind: 'started-no-result' })
    await transcript({ main: [use(id), result(id, { content: 'done', is_error: false })] })
    expect(await outcomeOf(SESSION, id, { cwd: CWD })).toEqual({ kind: 'result', isError: false, interrupted: false })
  })

  it('skips a file above the 32 MB inspection bound (the hold stands)', async () => {
    const lines = [use(id), result(id, { content: 'done', is_error: false })].join('\n') + '\n'
    await transcript({ main: [lines + ' '.repeat(32 * 1024 * 1024)] })
    expect(await outcomeOf(SESSION, id, { cwd: CWD })).toEqual({ kind: 'no-record' })
  })

  it('treats a missing projects directory as no record', async () => {
    h.projects = join(h.projects, 'absent')
    expect(await outcomeOf(SESSION, id)).toEqual({ kind: 'no-record' })
    expect(await outcomeOf(SESSION, id, { cwd: CWD })).toEqual({ kind: 'no-record' })
  })
})

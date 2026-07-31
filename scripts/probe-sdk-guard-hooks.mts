// S0-A — THE SAFETY SPIKE for docs/SDK_WORKER_MIGRATION_PLAN.md §4-G.
//
// A swarm worker runs permission-bypass, so the PreToolUse deny veto is its ONLY
// deterministic block. In the PTY path that veto is a hook wired into the user's
// global ~/.claude/settings.json, armed per-session by OPENGROUND_GUARD=1.
// The plan assumes the Agent SDK does NOT load filesystem settings, which would
// mean a naive SDK spawn produces a worker with no veto at all — silently, since
// Claude Code fails a MISSING hook OPEN.
//
// This probe does not assume that. It MEASURES it, then measures the proposed
// replacement:
//
//   P   PREMISE — with OPENGROUND_GUARD=1 and write roots pointing ELSEWHERE,
//       does the real filesystem hook fire in an SDK session?
//         denied  ⇒ the SDK does load settings; §4-G's problem does not exist
//         allowed ⇒ §4-G confirmed; programmatic hooks are required
//   A1  Does a programmatic PreToolUse 'deny' stop the tool under bypass?
//   A2  Does that hook also fire for a tool issued by a SUBAGENT?
//   A3  If the hook THROWS, does the run fail open (tool runs) or closed?
//
// A3 decides whether OG may rely on this at all: a veto that vanishes when its
// own code errors is not a veto.
//
//   npx tsx scripts/probe-sdk-guard-hooks.mts
//
// HOME. This runs against the REAL home, deliberately. An isolated HOME was
// tried first and could not authenticate: the OAuth token lives in the macOS
// Keychain but the CLI still reports "Not logged in · Please run /login" from a
// fresh HOME even when oauthAccount/userID are seeded into .claude.json
// (measured 2026-07-30). Using the real HOME is safe HERE because this probe
// never writes to settings.json — its only mutation is the per-directory trust
// flag, applied through OG's own ensureClaudeFolderTrusted (the same write OG
// performs on every launch), and every file the model is asked to write goes to
// a mkdtemp scratch dir that is deleted at the end.
// (The 2026-07-27 rule "mutation probes need an isolated HOME" targets probes
// that MUTATE settings. This one does not.)

import { mkdtempSync, existsSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { Options, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk'
import { resolvedClaudeBin, absoluteClaudeOnPath } from '../src/lib/server/claudeConnection'
import { ensureClaudeFolderTrusted } from '../src/lib/server/claudeTrust'

// NOTE for the implementation (§4 #11): resolvedClaudeBin() is a CACHE that only
// fills after claudeConnection() has run (the server does that at boot). A
// standalone process gets null, so the pure resolver is the fallback — the SDK
// options builder must do the same rather than trusting the cache.
const CLAUDE_BIN = resolvedClaudeBin() ?? absoluteClaudeOnPath()
if (!CLAUDE_BIN) {
  console.error('claude binary not found on PATH or in known locations — cannot probe.')
  process.exit(1)
}

const root = mkdtempSync(join(tmpdir(), 'og-sdk-guard-probe-'))
const WORK = join(root, 'work')
const ELSEWHERE = join(root, 'elsewhere')
mkdirSync(WORK, { recursive: true })
mkdirSync(ELSEWHERE, { recursive: true })
ensureClaudeFolderTrusted(WORK)

const TARGET = join(WORK, 'guard-probe-target.txt')

// §4 #12: strip the child-session markers a claude launched from inside claude
// inherits (they change transcript/behaviour).
const baseEnv: Record<string, string> = {}
for (const [k, v] of Object.entries(process.env)) {
  if (v === undefined) continue
  if (k.startsWith('CLAUDE_CODE') || k === 'CLAUDECODE') continue
  baseEnv[k] = v
}

const WRITE_PROMPT =
  `Write the single word "written" to the file ${TARGET}. ` +
  `Use the Write tool. If it fails, say FAILED and stop — do not retry with another tool or path.`

interface Outcome {
  label: string
  hookFired: number
  fromSubagent: number
  fileWritten: boolean
  denials: string[]
  threw: string | null
}

const DENY = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse' as const,
    permissionDecision: 'deny' as const,
    permissionDecisionReason: 'probe: denied by OG guard',
  },
}
const ALLOW = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse' as const,
    permissionDecision: 'allow' as const,
  },
}

const run = async (
  label: string,
  opts: {
    env?: Record<string, string>
    hook?: (i: PreToolUseHookInput, out: Outcome) => Promise<unknown>
    agents?: Options['agents']
    prompt?: string
  },
): Promise<Outcome> => {
  if (existsSync(TARGET)) rmSync(TARGET)
  const out: Outcome = {
    label,
    hookFired: 0,
    fromSubagent: 0,
    fileWritten: false,
    denials: [],
    threw: null,
  }

  const options: Options = {
    cwd: WORK,
    env: opts.env ?? baseEnv,
    pathToClaudeCodeExecutable: CLAUDE_BIN,
    permissionMode: 'bypassPermissions',
    strictMcpConfig: true,
    mcpServers: {},
    maxTurns: opts.agents ? 12 : 8,
    ...(opts.agents ? { agents: opts.agents } : {}),
    ...(opts.hook
      ? {
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  async (input) => {
                    const i = input as PreToolUseHookInput
                    out.hookFired++
                    if ((i as unknown as { agent_id?: string }).agent_id) out.fromSubagent++
                    return opts.hook!(i, out) as never
                  },
                ],
              },
            ],
          },
        }
      : {}),
  }

  try {
    for await (const m of query({ prompt: opts.prompt ?? WRITE_PROMPT, options })) {
      if (m.type === 'result') {
        const d = (m as unknown as { permission_denials?: { tool_name?: string }[] })
          .permission_denials
        for (const x of d ?? []) if (x.tool_name) out.denials.push(x.tool_name)
      }
    }
  } catch (e) {
    out.threw = String((e as Error)?.message).slice(0, 180)
  }
  out.fileWritten = existsSync(TARGET)
  console.log(
    `  → hookFired=${out.hookFired} fromSubagent=${out.fromSubagent} ` +
      `written=${out.fileWritten} denials=${JSON.stringify(out.denials)}` +
      (out.threw ? ` threw=${JSON.stringify(out.threw)}` : ''),
  )
  return out
}

console.log(`work dir      : ${WORK}`)
console.log(`claude binary : ${CLAUDE_BIN}\n`)

console.log('### CONTROL — no hook at all (the write SHOULD land; proves the probe can write)')
const control = await run('control', {})

console.log('\n### P — PREMISE: real filesystem guard armed via env, write root ELSEWHERE, no programmatic hook')
const premise = await run('premise', {
  env: {
    ...baseEnv,
    OPENGROUND_GUARD: '1',
    OPENGROUND_GUARD_WRITE_ROOTS: ELSEWHERE,
  },
})

console.log('\n### A1 — programmatic hook DENIES under bypassPermissions (MUST NOT land)')
const a1 = await run('A1/deny', { hook: async () => DENY })

console.log('\n### A3 — programmatic hook THROWS (does the veto fail OPEN?)')
const a3 = await run('A3/throw', {
  hook: async () => {
    throw new Error('probe: hook implementation blew up')
  },
})

console.log('\n### A2 — SUBAGENT-issued Write under a denying hook')
const a2 = await run('A2/subagent', {
  hook: async (i) => (i.tool_name === 'Write' ? DENY : ALLOW),
  agents: {
    writer: {
      description: 'writes one file (probe only)',
      prompt: 'You write exactly the file you are told to write, then report one line.',
      tools: ['Write'],
    },
  },
  prompt:
    `Use the "writer" agent (exactly one) to write the single word "written" to ${TARGET}. ` +
    `Report in one line whether it succeeded.`,
})

console.log('\n########## VERDICT ##########')
const ok = (b: boolean) => (b ? 'YES' : 'NO')
console.log(`probe is meaningful (control wrote the file)     : ${control.fileWritten ? 'YES' : 'NO — everything below is inconclusive'}`)
console.log(
  `P  SDK loads filesystem settings (real hook fired) : ${ok(!premise.fileWritten)}` +
    (premise.fileWritten
      ? '  ⇒ §4-G CONFIRMED: settings are NOT loaded; programmatic hooks are required'
      : '  ⇒ §4-G premise WRONG: the real hook DID fire; design can lean on settings'),
)
console.log(`A1 programmatic deny blocks under bypass          : ${ok(a1.hookFired > 0 && !a1.fileWritten)}`)
console.log(`A2 subagent tools go through the same hook        : ${ok(a2.hookFired > 0 && !a2.fileWritten)}`)
console.log(
  `A3 a THROWING hook fails CLOSED                   : ${ok(!a3.fileWritten)}` +
    (a3.fileWritten ? '  ⇐ FAILS OPEN: wrap every hook body in try/catch and deny on error' : ''),
)

rmSync(root, { recursive: true, force: true })
console.log(`\nprobe dir removed: ${root}`)

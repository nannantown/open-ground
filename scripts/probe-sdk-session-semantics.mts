// S0-B / S0-C / S0-D / S0-E for docs/SDK_WORKER_MIGRATION_PLAN.md.
//
//   S0-B  mid-turn pushInput — a message sent WHILE the model is generating:
//         is it queued and handled after the turn, or dropped?
//         (§5 S7: this replaces bracketed-paste + screen re-read as the way the
//         engine injects rework / answers / nudges into a live worker.)
//   S0-C  worktree-shaped cwd — is the session JSONL written where
//         transcript.sessionJsonlPath says it is, and does effort:'max' ride?
//         (§5 S8 leans on that file's mtime as a second stall signal.)
//   S0-D  under bypassPermissions, does canUseTool ever fire?
//         (§5 S6: if it never fires, an allow-all backstop is just a tripwire.)
//   S0-E  are the refusal/warning prefix constants importable at RUNTIME, not
//         only present in the .d.ts? (§3.3 builds quota detection on them.)
//
//   npx tsx scripts/probe-sdk-session-semantics.mts
//
// Read-only against the real HOME: no settings are touched, the model is asked
// only to emit text, and the scratch dir is removed at the end.

import { mkdtempSync, existsSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { query, USAGE_LIMIT_ERROR_PREFIXES, USAGE_WARNING_PREFIXES } from '@anthropic-ai/claude-agent-sdk'
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { resolvedClaudeBin, absoluteClaudeOnPath } from '../src/lib/server/claudeConnection'
import { ensureClaudeFolderTrusted } from '../src/lib/server/claudeTrust'
import { sessionJsonlPath, sessionSubagentsDir } from '../src/lib/server/transcript'

const CLAUDE_BIN = resolvedClaudeBin() ?? absoluteClaudeOnPath()
if (!CLAUDE_BIN) {
  console.error('claude binary not found — cannot probe.')
  process.exit(1)
}

const root = mkdtempSync(join(tmpdir(), 'og-sdk-sem-probe-'))
// Shape the cwd like a central worktree so the JSONL path derivation is
// exercised on a realistic (deep, hyphen-hostile) path.
const WORK = join(root, 'projects', 'abc123', 'worktrees', 'swarm-probe-0730')
mkdirSync(WORK, { recursive: true })
ensureClaudeFolderTrusted(WORK)

const env: Record<string, string> = {}
for (const [k, v] of Object.entries(process.env)) {
  if (v === undefined) continue
  if (k.startsWith('CLAUDE_CODE') || k === 'CLAUDECODE') continue
  env[k] = v
}

const base: Options = {
  cwd: WORK,
  env,
  pathToClaudeCodeExecutable: CLAUDE_BIN,
  strictMcpConfig: true,
  mcpServers: {},
}

// ─────────────────────────────────────────── S0-E (free — no model call)
console.log('### S0-E — runtime import of the refusal/warning prefix constants')
const eOk = Array.isArray(USAGE_LIMIT_ERROR_PREFIXES) && USAGE_LIMIT_ERROR_PREFIXES.length > 0
console.log(`  USAGE_LIMIT_ERROR_PREFIXES: ${eOk ? `array, ${USAGE_LIMIT_ERROR_PREFIXES.length} entries` : 'NOT USABLE'}`)
console.log(`  USAGE_WARNING_PREFIXES    : ${Array.isArray(USAGE_WARNING_PREFIXES) ? `array, ${USAGE_WARNING_PREFIXES.length} entries` : 'NOT USABLE'}`)
if (eOk) console.log(`  sample: ${JSON.stringify(USAGE_LIMIT_ERROR_PREFIXES.slice(0, 3))}`)

// ─────────────────────────────────────────── S0-B + S0-C + S0-D (one session)
console.log('\n### S0-B/C/D — one streaming session in a worktree-shaped cwd')

const SESSION_ID = '7f3a91c2-0d64-4b8e-9a15-2c6e5b0d4a77'

const queue: SDKUserMessage[] = []
let resolveNext: ((m: SDKUserMessage | null) => void) | null = null
let closed = false
const push = (text: string) => {
  const msg = {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: '',
  } as unknown as SDKUserMessage
  if (resolveNext) {
    const r = resolveNext
    resolveNext = null
    r(msg)
  } else queue.push(msg)
}
const close = () => {
  closed = true
  if (resolveNext) {
    const r = resolveNext
    resolveNext = null
    r(null)
  }
}
async function* input(): AsyncGenerator<SDKUserMessage> {
  for (;;) {
    let m: SDKUserMessage | null
    if (queue.length) m = queue.shift()!
    else if (closed) return
    else m = await new Promise<SDKUserMessage | null>((res) => (resolveNext = res))
    if (m === null) return
    yield m
  }
}

let canUseToolFired = 0
const q = query({
  prompt: input(),
  options: {
    ...base,
    sessionId: SESSION_ID,
    permissionMode: 'bypassPermissions',
    effort: 'max',
    // S0-D: under bypass this should never fire. If it does, the plan's
    // allow-all backstop is load-bearing rather than a tripwire.
    canUseTool: async (toolName, input) => {
      canUseToolFired++
      console.log(`  ⚠ canUseTool FIRED under bypass: ${toolName}`)
      return { behavior: 'allow', updatedInput: input as Record<string, unknown> }
    },
  },
})

const MARK_A = 'PROBE_MARK_ALPHA'
const MARK_B = 'PROBE_MARK_BRAVO'

// Turn 1: something long enough that the mid-turn injection lands while busy.
push(
  `Count slowly from 1 to 40, writing each number on its own line with its English word. ` +
    `When completely finished, write ${MARK_A} on the last line.`,
)

let midTurnSent = false
let sawMarkA = false
let sawMarkB = false
let turns = 0
let effortSeen: string | null = null
let sessionIdSeen: string | null = null
const t0 = Date.now()

for await (const m of q) {
  if (m.type === 'system' && (m as { subtype?: string }).subtype === 'init') {
    const im = m as unknown as { session_id?: string; effort?: string; permissionMode?: string }
    sessionIdSeen = im.session_id ?? null
    effortSeen = im.effort ?? null
    console.log(`  init: session=${sessionIdSeen} effort=${im.effort ?? '(absent)'} mode=${im.permissionMode}`)
  }
  if (m.type === 'assistant') {
    for (const b of (m as unknown as { message?: { content?: { type: string; text?: string }[] } }).message
      ?.content ?? []) {
      if (b.type !== 'text' || !b.text) continue
      if (b.text.includes(MARK_A)) sawMarkA = true
      if (b.text.includes(MARK_B)) sawMarkB = true
      // S0-B: fire the injection WHILE the first turn is still generating.
      if (!midTurnSent && /\b(5|6|7|8)\b/.test(b.text)) {
        midTurnSent = true
        console.log(`  ↳ [${((Date.now() - t0) / 1000).toFixed(1)}s] injecting mid-turn message…`)
        push(`Ignore the counting task. Reply with exactly ${MARK_B} and nothing else.`)
      }
    }
  }
  if (m.type === 'result') {
    turns++
    const r = m as unknown as { subtype?: string; terminal_reason?: string }
    console.log(
      `  turn ${turns} result: subtype=${r.subtype} terminal_reason=${r.terminal_reason} ` +
        `(markA=${sawMarkA} markB=${sawMarkB})`,
    )
    if (turns >= 2 || (turns === 1 && !midTurnSent)) break
  }
}
close()

// S0-C: did the JSONL land where transcript.ts says it should?
const jsonl = sessionJsonlPath(WORK, sessionIdSeen ?? SESSION_ID)
const subs = sessionSubagentsDir(WORK, sessionIdSeen ?? SESSION_ID)

console.log('\n########## VERDICT ##########')
console.log(`S0-E prefix constants importable at runtime : ${eOk ? 'YES' : 'NO'}`)
console.log(`S0-D canUseTool fired under bypass          : ${canUseToolFired > 0 ? `YES (${canUseToolFired}) — backstop is load-bearing` : 'NO — backstop is a tripwire only'}`)
console.log(`S0-C session id honoured                    : ${sessionIdSeen === SESSION_ID ? 'YES' : `NO (got ${sessionIdSeen})`}`)
console.log(`S0-C effort:'max' accepted (no arg error)   : ${effortSeen ? `reported '${effortSeen}'` : 'not reported on init (accepted without error)'}`)
console.log(`S0-C JSONL at transcript.sessionJsonlPath   : ${existsSync(jsonl) ? 'YES' : 'NO'}`)
console.log(`        ${jsonl}`)
console.log(`S0-C subagents dir path derivable           : ${subs}`)
console.log(
  `S0-B mid-turn injection processed after turn : ${
    !midTurnSent ? 'NOT TESTED (turn ended too fast)' : sawMarkB ? 'YES — queued and handled' : `NO (turns=${turns})`
  }`,
)

rmSync(root, { recursive: true, force: true })
console.log(`\nprobe dir removed: ${root}`)

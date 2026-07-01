// createGlobalSkill — author a NEW global Claude skill (~/.claude/skills/<name>/
// SKILL.md) from a free-text request, by briefly running the user's local
// `claude` CLI in ~/.claude/skills and scraping a completion marker out of the
// PTY OUTPUT STREAM. Same one-off-PTY pattern as generateDescription.ts.
//
// SUBSCRIPTION-ONLY (read claudeTerminal.ts top comment): claude MUST run inside
// a real PTY so it bills the user's Claude subscription pool, NOT the
// programmatic credit pool. `claude -p` / execFile('claude', …) is FORBIDDEN.
//
// Unlike describe (read-only), this session WRITES: it creates one skill
// directory under cwd. It runs with `bypass` (--dangerously-skip-permissions)
// because no human is at the TTY to approve the Write/Bash tool calls. The
// prompt hard-scopes it to "create exactly this one skill, touch nothing else".
//
// Completion = the marker line appearing in the cleaned output:
//   `OPENGROUND_SKILL_NAME: <kebab-name> ::OG_SKILL_END::`
// We then VERIFY the skill actually exists on disk (listGlobalSkills) before
// returning it — the marker alone is the model's claim, not proof.

import { mkdir } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { newId } from '@/lib/ids'
import type { ProjectSkill } from '../types'
import { launchClaude } from './claudeTerminal'
import { killTerminal, subscribeTerminal } from './terminal'
import { listGlobalSkills } from './projectSkills'

export const SKILL_NAME_MARKER = 'OPENGROUND_SKILL_NAME:'
export const SKILL_END = '::OG_SKILL_END::'

// A skill request is a short instruction; cap it so a giant paste can't bloat
// the prompt/argv.
export const MAX_REQUEST_LEN = 2000

// Creation is a real authoring task (think + Write + verify), so allow longer
// than describe's 120s.
const DEFAULT_TIMEOUT_MS = 240_000
const POLL_MS = 500
const MAX_BUFFER = 64_000

// A valid skill directory name: kebab/underscore, 1–64 chars, no path parts.
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

// ANSI / control strip — identical rationale to generateDescription.ts: SGR
// styles delete silently (can sit mid-word), every other CSI is a positioning
// op and becomes a space, OSC titles are dropped, other control chars → space.
// eslint-disable-next-line no-control-regex
const SGR_RE = /\x1b\[[0-9;]*m/g
// eslint-disable-next-line no-control-regex
const CSI_OTHER_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
// eslint-disable-next-line no-control-regex
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

/** The LAST `OPENGROUND_SKILL_NAME: <name> ::OG_SKILL_END::` in the raw PTY
 *  output, validated as a safe skill dir name, or null. A candidate containing
 *  '<' is the prompt's own echoed placeholder and is rejected. Exported for
 *  tests. */
export const extractSkillName = (raw: string): string | null => {
  const text = raw.replace(OSC_RE, '').replace(SGR_RE, '').replace(CSI_OTHER_RE, ' ')
  let from = text.length
  for (;;) {
    const start = text.lastIndexOf(SKILL_NAME_MARKER, from - 1)
    if (start < 0) return null
    const end = text.indexOf(SKILL_END, start + SKILL_NAME_MARKER.length)
    if (end >= 0) {
      const candidate = text
        .slice(start + SKILL_NAME_MARKER.length, end)
        .replace(CTRL_RE, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (candidate && !candidate.includes('<') && SKILL_NAME_RE.test(candidate)) {
        return candidate
      }
    }
    from = start
    if (from <= 0) return null
  }
}

/** The prompt that drives the one-off skill-authoring session. The model picks
 *  a kebab name, writes ./<name>/SKILL.md (frontmatter + body) under the cwd
 *  (~/.claude/skills), and ends with the marker line. Exported for tests. */
export const buildCreateSkillPrompt = (request: string): string =>
  [
    'You are creating ONE new Claude Code "skill" in the CURRENT directory',
    '(which is the user\'s ~/.claude/skills), based on this request:',
    '',
    '<request>',
    request,
    '</request>',
    '',
    'Steps:',
    '- Choose a concise, descriptive kebab-case name (lowercase letters, digits,',
    '  hyphens only) — e.g. "pdf-export" or "commit-helper".',
    '- Create the directory ./<name>/ and write ./<name>/SKILL.md.',
    '- SKILL.md MUST begin with YAML frontmatter, then the skill body:',
    '    ---',
    '    name: <name>',
    '    description: <one clear sentence: what the skill does and when to use it>',
    '    ---',
    '    <clear, actionable instructions for the task above>',
    '- Create ONLY this one skill directory. Do not modify or delete anything',
    '  else, and never touch any .openground/ directory.',
    '- After the files are written, output EXACTLY this single line and nothing',
    '  after it (put only the bare kebab name between the marker and end token):',
    `  ${SKILL_NAME_MARKER} <name> ${SKILL_END}`,
  ].join('\n')

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface CreateSkillOpts {
  timeoutMs?: number
  /** Injectable home dir for tests (defaults to the OS home). */
  home?: string
}

/** Run a one-off claude that authors a global skill from `request`, then return
 *  the created skill (re-read from disk). Throws if the request is empty or if
 *  no verifiable skill was produced before the deadline. */
/** Thrown when a global-skill creation is requested while another is still
 *  running. The route maps it to 409. (Each run holds a bypass `claude` PTY for
 *  up to the timeout, so we serialize to one at a time.) */
export class SkillCreationBusyError extends Error {
  constructor() {
    super('a skill is already being created — please wait for it to finish')
    this.name = 'SkillCreationBusyError'
  }
}

// Single-flight guard: only one global-skill authoring run at a time across the
// whole server (the client disables its button, but a second tab / direct POST
// must not pile up concurrent bypass PTYs).
let inFlight = false

export const createGlobalSkill = async (
  request: string,
  opts: CreateSkillOpts = {},
): Promise<ProjectSkill> => {
  const clean = request.trim().slice(0, MAX_REQUEST_LEN)
  if (!clean) throw new Error('a skill request is required')
  if (inFlight) throw new SkillCreationBusyError()
  inFlight = true
  try {
    const home = opts.home ?? homedir()
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const skillsDir = join(home, '.claude', 'skills')
    // The dir may not exist yet (first global skill) — claude's cwd must exist.
    await mkdir(skillsDir, { recursive: true })

    const ref = launchClaude({
      cwd: skillsDir,
      agentSessionId: newId(),
      initialPrompt: buildCreateSkillPrompt(clean),
      // No human at the TTY to approve Write/Bash; the prompt hard-scopes the run.
      permissionMode: 'bypass',
      name: 'create-skill',
      // Utility session: keep the system prompt pristine (no board-API context)
      // so the OPENGROUND_SKILL_NAME output contract can't drift.
      appContext: false,
      // Non-sandboxed, bypass: ignore user-scope ~/.claude.json mcpServers so a
      // sandboxed claude can't plant one that this auto-run spawns outside the
      // sandbox (sandbox experiment hardening — see strictMcpConfig opt).
      strictMcpConfig: true,
    })

    let buffer = ''
    let exited = false
    const sub = subscribeTerminal(
      ref.terminalId,
      (chunk) => {
        buffer = (buffer + chunk).slice(-MAX_BUFFER)
      },
      () => {
        exited = true
      },
    )

    const deadline = Date.now() + timeoutMs
    try {
      for (;;) {
        await sleep(POLL_MS)
        const name = extractSkillName(buffer)
        if (name) {
          // The marker is the model's claim — verify the skill is really on disk
          // (and parse its name/description) before reporting success.
          const created = (await listGlobalSkills(home)).find((s) => s.id === name)
          if (created) return created
          // Marker landed but file not visible yet — give the write a moment.
        }
        if (Date.now() >= deadline) break
        if (exited || sub?.info.finishedAt) {
          // Session ended — one last look (the marker may be in the final chunk).
          const finalName = extractSkillName(buffer)
          if (finalName) {
            const created = (await listGlobalSkills(home)).find((s) => s.id === finalName)
            if (created) return created
          }
          break
        }
      }
      throw new Error('could not create a skill from the claude session')
    } finally {
      sub?.unsubscribe()
      try {
        killTerminal(ref.terminalId)
      } catch {
        // best-effort teardown
      }
    }
  } finally {
    inFlight = false
  }
}

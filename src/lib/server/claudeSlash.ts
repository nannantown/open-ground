// claudeSlash.ts — the MANUAL escape hatch: type one of claude's own slash
// commands into a LIVE claude PTY and submit it.
//
// The spike (docs/CONTEXT_MANAGEMENT_PLAN.md §3-B1/B2) proved both commands
// execute when written straight to the pty as `/<cmd>\r`, and recorded the two
// conditions that make it reliable:
//   (a) clear the input line first — a half-typed line would otherwise become a
//       prefix and the pane would submit `hello/compact`;
//   (b) don't send while claude is generating — the run owns the input box, so
//       the text just queues up and fires at an unpredictable moment.
// (a) is Ctrl-U here; (b) is the isGenerating gate below.
//
// FAIL-CLOSED ON THE COMMAND. Only the two commands the gauge offers are
// accepted, as an exact enum — the pty write is raw keystrokes, so an
// unvalidated string is arbitrary typing into the user's session. Same for the
// /compact focus text: every control character is scrubbed, because a bare CR
// inside it would submit early and run the remainder as its own command.
//
// This module never DECIDES to compact — auto-compact is native and owns that
// (spike §0). It only carries a button press through to the pane.
import { isGenerating } from '@/lib/claudeScreen'
import { MAX_SLASH_ARG } from '@/lib/contextGauge'
import { getTerminalScreen, writeInput } from './terminal'

/** The commands the escape hatch may send. Exact allowlist — see the header. */
export const CLAUDE_SLASH_COMMANDS = ['compact', 'clear'] as const
export type ClaudeSlashCommand = (typeof CLAUDE_SLASH_COMMANDS)[number]

export const isClaudeSlashCommand = (v: unknown): v is ClaudeSlashCommand =>
  typeof v === 'string' && (CLAUDE_SLASH_COMMANDS as readonly string[]).includes(v)

/** Why a send did not happen. `busy` is the only one the user can act on (wait
 *  for the turn to end); the UI phrases each in plain language. */
export type ClaudeSlashFailure = 'unknown-command' | 'not-found' | 'busy'
export type ClaudeSlashResult = { ok: true } | { ok: false; reason: ClaudeSlashFailure }

/** Ctrl-U — "kill the line" in claude's input box (readline convention). */
export const CTRL_U = '\u0015'

/** Longest /compact focus text accepted — defined in the client-safe
 *  contextGauge module and re-exported here, so the input box that collects the
 *  hint and the sender that enforces it can never drift apart. */
export { MAX_SLASH_ARG }

/** A /compact focus hint, made safe to type: every control character (ESC, CR,
 *  LF, …) becomes a space, runs of whitespace collapse, and the result is
 *  capped. Returns '' for anything unusable — callers append nothing then. */
export const sanitizeSlashArg = (raw: unknown): string => {
  if (typeof raw !== 'string') return ''
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SLASH_ARG)
}

/** Injected seams so the sender is unit-testable without a live PTY pool. */
export interface ClaudeSlashDeps {
  /** The pane's current rendered screen (read for the "is it generating" gate). */
  getScreen: (id: string) => string | null
  /** Write raw keystrokes to the pane. false = no such live pane. */
  write: (id: string, data: string) => boolean
}

const defaultDeps: ClaudeSlashDeps = { getScreen: getTerminalScreen, write: writeInput }

/**
 * Type `/<command> [focus]` into a live claude pane and press Enter.
 *
 * - `unknown-command` — not in the allowlist; nothing was written.
 * - `busy` — claude is mid-turn (its footer says `esc to interrupt`). Nothing
 *   was written: queued input would fire at an unpredictable moment. A screen
 *   we cannot read is NOT treated as busy — the escape hatch has to stay usable
 *   when the screen model is unavailable, and the worst case is the same
 *   queued keystroke the user would get by typing it themselves.
 * - `not-found` — no live pane with that id (already exited).
 */
export const sendClaudeSlash = (
  terminalId: string,
  command: unknown,
  focus?: unknown,
  deps: ClaudeSlashDeps = defaultDeps,
): ClaudeSlashResult => {
  if (!isClaudeSlashCommand(command)) return { ok: false, reason: 'unknown-command' }
  if (isGenerating(deps.getScreen(terminalId))) return { ok: false, reason: 'busy' }
  // Only /compact takes guidance ("focus on the API redesign"); /clear takes no
  // argument, and appending one would make claude reject the whole line.
  const arg = command === 'compact' ? sanitizeSlashArg(focus) : ''
  const line = arg ? `/${command} ${arg}` : `/${command}`
  // Two writes, not one: Ctrl-U must land as its own keystroke so the TUI
  // processes the line-kill before the command text arrives.
  if (!deps.write(terminalId, CTRL_U)) return { ok: false, reason: 'not-found' }
  if (!deps.write(terminalId, `${line}\r`)) return { ok: false, reason: 'not-found' }
  return { ok: true }
}

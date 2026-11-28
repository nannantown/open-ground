import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { claudeDirName } from './claudeProjectDir'
import { claudeProjectsRoot } from './transcript'

/** What Claude's own transcript records about one tool call (AUTONOMY-SPEC R-B1).
 *  Read-only evidence: nothing here re-runs, releases or decides anything. */
export type ToolOutcome =
  | { kind: 'result'; isError: boolean; interrupted: boolean; description?: string }
  | { kind: 'started-no-result'; description?: string }
  | { kind: 'no-record' }

const MAX_BYTES = 32 * 1024 * 1024 // the bound swarmNativeTranscript.inspect uses
// Tools whose `description` input describes the call itself. For others (an MCP
// issue creator, TaskCreate) it IS the payload — an argument, never copied.
export const SELF_DESCRIBED_TOOLS = new Set(['Bash', 'Agent', 'Task'])
const INTERRUPTED_TEXT = ['[Request interrupted', '[Tool call interrupted']
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const firstText = (value: unknown): string => typeof value === 'string' ? value
  : Array.isArray(value) ? String(object(value.find(item => object(item)?.type === 'text'))?.text ?? '') : ''
const interruptedText = (value: unknown): boolean => {
  const text = firstText(value).replace(/^Error: /, '').trimStart()
  return INTERRUPTED_TEXT.some(marker => text.startsWith(marker))
}
// Denial kinds decided BEFORE a call runs: a permission rule or hook veto (1,111
// local lines, every one a PreToolUse veto or a pre-call check) and the auto-mode
// classifier (3). `user-rejected` is NOT one of them (review A-M1): the CLI writes
// that kind for a prompt refusal AND for a call an interrupt or a shutdown cut off
// while running — a real worker's Bash, 163 s in. Only its `toolDenialBeforeRun:
// true` (CLI ≥ 2.1.331, set when the call had not started) proves it never ran.
const DECIDED_BEFORE_RUN = new Set(['permission-rule', 'automode-blocked'])
/** Whether one `tool_result` line leaves the call's effect unknown. Known results
 *  are a returned output or failure, or a denial PROVEN to precede the run; any
 *  other denial kind (`interrupted`, `cancelled`, `user-rejected` without the
 *  flag, kinds not yet measured), a result the CLI marks `interruptedByShutdown`
 *  (its own loader relabels those `interrupted`) or `toolDenialAfterRun`, an
 *  interrupted Bash, or the CLI's interrupt marker as the content is interrupted:
 *  the hold stands. Shared with the native resume check (swarmNativeTranscript). */
export const resultInterrupted = (item: Record<string, unknown>, block: Record<string, unknown>): boolean => {
  const denial = item.toolDenialKind
  if (object(item.toolUseResult)?.interrupted === true || item.interruptedByShutdown === true || item.toolDenialAfterRun === true) return true
  if (typeof denial === 'string' && !DECIDED_BEFORE_RUN.has(denial) && item.toolDenialBeforeRun !== true) return true
  return interruptedText(block.content) || interruptedText(item.toolUseResult)
}

/** Whole file, or null when it is over the bound or changed while being read. */
const readStable = async (file: string): Promise<string | null> => {
  const before = await stat(file)
  if (before.size > MAX_BYTES) return null
  const bytes = await readFile(file), after = await stat(file)
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) return null
  return bytes.toString('utf8')
}

// The same held receipt is asked about on every tool call and every engine pass;
// a transcript is read again only once one of its files changed.
const misses = new Map<string, { mark: string; outcome: ToolOutcome }>()
const folders = new Map<string, { mark: number; at: number; dirs: string[] }>()
/** How often a MISS is re-listed while the root is unchanged: a session file or
 *  folder created inside an existing project folder does not change the root's
 *  mtime, so a cached miss used to last until restart and keep the hold (review
 *  A N1). A hit is trusted until the root changes. */
const MISS_RELIST_MS = 30_000
/** Receipts from before `cwd` was recorded: every folder holding this session.
 *  ponytail: two stats per projects folder per listing; a miss re-lists at most
 *  every MISS_RELIST_MS — index sessions by folder if the root grows large. */
const foldersHolding = async (root: string, sessionId: string): Promise<string[]> => {
  const key = `${root}\0${sessionId}`, mark = (await stat(root)).mtimeMs, memo = folders.get(key)
  if (memo?.mark === mark && (memo.dirs.length > 0 || Date.now() - memo.at < MISS_RELIST_MS)) return memo.dirs
  const exists = (path: string) => stat(path).then(() => true, () => false)
  const dirs: string[] = []
  for (const name of await readdir(root)) {
    const dir = join(root, name)
    if (await exists(join(dir, `${sessionId}.jsonl`)) || await exists(join(dir, sessionId))) dirs.push(dir)
  }
  folders.set(key, { mark, at: Date.now(), dirs })
  return dirs
}

/** Looks up one call in `<dir>/<sessionId>.jsonl` and `<dir>/<sessionId>/subagents/*.jsonl`
 *  (a sub-agent's calls run under its parent's session and are recorded only
 *  there). `cwd` names the folder; without it every folder holding the session is
 *  searched. `use` must accept the call's tool_use block (name, input) for its
 *  result to count. Every failure to read is a miss: the hold then stands. */
export const findToolOutcome = async (sessionId: string, toolId: string,
  opts: { cwd?: string; use?: (name: string, input: unknown) => boolean } = {}): Promise<ToolOutcome> => {
  const root = claudeProjectsRoot()
  try {
    // ponytail: a recorded cwd is canonical (registry paths, OG worktrees), so it is
    // not searched further; a miss there keeps the hold.
    const dirs = opts.cwd ? [join(root, claudeDirName(opts.cwd))] : await foldersHolding(root, sessionId)
    const files: string[] = []
    for (const dir of dirs) {
      files.push(join(dir, `${sessionId}.jsonl`))
      const sub = join(dir, sessionId, 'subagents')
      for (const name of await readdir(sub).catch(() => [] as string[])) if (name.endsWith('.jsonl')) files.push(join(sub, name))
    }
    const key = `${root}\0${sessionId}\0${toolId}`
    const mark = (await Promise.all(files.map(file => stat(file).then(s => `${file}:${s.ino}:${s.size}:${s.mtimeMs}`, () => '')))).join('\n')
    const memo = misses.get(key)
    if (memo?.mark === mark) return memo.outcome
    let started = false
    // The call's own `description` input (Bash, Agent), raw: the owner's question
    // names the operation by it (R-B3/R-B4) — never by its other arguments.
    let description: string | undefined
    const results: { isError: boolean; interrupted: boolean }[] = []
    for (const file of files) {
      const text = await readStable(file).catch(() => null)
      if (text === null) continue
      for (const line of text.split('\n')) {
        if (!line.includes(toolId)) continue
        let item: Record<string, unknown> | undefined
        try { item = object(JSON.parse(line)) } catch { continue }
        const content = object(item?.message)?.content
        if (!item || item.isMeta === true || item.isSynthetic === true || !Array.isArray(content)) continue
        for (const raw of content) {
          const block = object(raw)
          if (item.type === 'assistant' && block?.type === 'tool_use' && block.id === toolId && typeof block.name === 'string'
            && (!opts.use || opts.use(block.name, block.input))) {
            started = true
            const said = object(block.input)?.description
            if (typeof said === 'string' && SELF_DESCRIBED_TOOLS.has(block.name)) description = said
          }
          if (item.type === 'user' && block?.type === 'tool_result' && block.tool_use_id === toolId)
            results.push({ isError: block.is_error === true, interrupted: resultInterrupted(item, block) })
        }
      }
    }
    // A result counts only beside the call it answers; either alone proves nothing.
    const said = description !== undefined ? { description } : {}
    const outcome: ToolOutcome = started && results.length
      ? { kind: 'result', isError: results.some(r => r.isError), interrupted: results.some(r => r.interrupted), ...said }
      : started ? { kind: 'started-no-result', ...said } : { kind: 'no-record' }
    if (outcome.kind === 'result' && !outcome.interrupted) misses.delete(key)
    else misses.set(key, { mark, outcome })
    return outcome
  } catch { return { kind: 'no-record' } }
}

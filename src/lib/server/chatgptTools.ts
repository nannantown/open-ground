// The model never executes a native provider tool. These are ordinary host
// functions, and a worker's existing deterministic guard runs before each one.
import { spawn } from 'child_process'
import { constants } from 'fs'
import { access, lstat, realpath } from 'fs/promises'
import { dirname, isAbsolute, join, resolve } from 'path'
import { z } from 'zod'
import type { ChatGptTool } from './chatgptResponses'
import { openGroundHome } from './paths'

export type ChatGptToolGuard = (input: { tool_name: string; tool_input: unknown; cwd: string }) => Promise<unknown>
export interface ChatGptHostToolOptions {
  cwd: string
  env?: NodeJS.ProcessEnv
  /** Required for workers. An explicitly trusted commander has no worker veto. */
  guard?: ChatGptToolGuard
  trusted?: boolean
  /** Server authorization, separate from the worker's command/file veto. */
  authorize?: () => Promise<void>
  maxCommandMs?: number
  /** Only a trusted host/test may override the credential boundary. */
  protectedRoots?: string[]
}
const MAX_FILE_BYTES = 1024 * 1024
const MAX_OUTPUT_BYTES = 128 * 1024
const PROCESS_STOP_GRACE_MS = 250
const OUTPUT_CLOSE_GRACE_MS = 250
/** A tool may have acted, but its process/output lifecycle was not confirmed.
 * The Responses adapter must leave its call unresolved for owner recovery,
 * rather than returning an ordinary failed-tool receipt or retrying it. */
export class ChatGptHostOutcomeUncertainError extends Error {
  readonly code = 'host_outcome_uncertain'
  constructor(readonly cause?: Error) {
    super('ChatGPT host command process-group termination and output closure could not both be confirmed. Its effects are unconfirmed; inspect the actual work before continuing and do not automatically repeat the command.')
    this.name = 'ChatGptHostOutcomeUncertainError'
  }
}
const stopped = () => new DOMException('ChatGPT host tool stopped', 'AbortError')
const checkAbort = (signal: AbortSignal): void => { if (signal.aborted) throw stopped() }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Resolve existing ancestors too: a symlink cannot rename an outside write
 * into an apparently permitted worktree path before the guard sees it. */
const canonicalPath = async (cwd: string, path: string): Promise<string> => {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, path)
  try { return await realpath(absolute) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = dirname(absolute)
    if (parent === absolute) throw error
    const suffix = absolute.slice(parent.length).replace(/^[/\\]/, '')
    return join(await canonicalPath(cwd, parent), suffix)
  }
}

const protectedPaths = async (roots?: string[]): Promise<string[]> => {
  const paths = roots ?? [join(openGroundHome(), 'secrets')]
  if (!paths.length) throw new Error('ChatGPT credential protection requires at least one protected directory')
  return Promise.all(paths.map(async (path) => {
    if (!isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw new Error('Invalid ChatGPT protected directory')
    for (let part = resolve(path); part !== dirname(part); part = dirname(part)) {
      try {
        const info = await lstat(part)
        if (info.isSymbolicLink()) {
          // Only immutable system aliases may canonicalize transparently. A
          // user-controlled ancestor link could be retargeted while a shell is
          // running, moving subsequently refreshed credentials outside its deny.
          const systemAlias = part === '/var' ? '/private/var' : part === '/tmp' ? '/private/tmp' : null
          if (!systemAlias || await realpath(part) !== systemAlias) throw new Error('ChatGPT protected directory has a mutable symlink ancestor')
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    try {
      const info = await lstat(path)
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('ChatGPT protected directory must be a real directory, never a symlink')
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    return canonicalPath('/', path)
  }))
}
const under = (path: string, root: string) => path === root || path.startsWith(root + '/')
const sbString = (path: string) => path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

/** Mandatory credential isolation for every shell, including trusted desks.
 * This is independent of the optional worktree sandbox and worker veto. */
export const chatGptShellPreflight = async (roots?: string[]): Promise<{ executable: '/usr/bin/sandbox-exec'; profile: string }> => {
  if (process.platform !== 'darwin') throw new Error('ChatGPT automatic host tools require the macOS credential sandbox')
  await access('/usr/bin/sandbox-exec', constants.X_OK)
  const protectedRoots = await protectedPaths(roots)
  const lines = ['(version 1)', '(allow default)']
  const ancestors = new Set<string>()
  for (const root of protectedRoots) {
    lines.push(`(deny file-read* (subpath "${sbString(root)}"))`, `(deny file-write* (subpath "${sbString(root)}"))`)
    // Renaming an ancestor would otherwise move the credentials to a pathname
    // outside the deny. Literal rules protect directory identities without
    // denying ordinary writes to their other children.
    for (let parent = dirname(root); parent !== dirname(parent); parent = dirname(parent)) ancestors.add(parent)
  }
  for (const parent of Array.from(ancestors)) lines.push(`(deny file-write* (literal "${sbString(parent)}"))`)
  return { executable: '/usr/bin/sandbox-exec', profile: lines.join('\n') }
}

const childEnv = (source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || key.startsWith('CLAUDE_CODE') || key === 'CLAUDECODE') continue
    // Host tools need the owner's normal build PATH, not provider credentials.
    if (/API_?KEY|ACCESS_?TOKEN|REFRESH_?TOKEN|AUTHORIZATION|CLIENT_?SECRET|PASSWORD|PRIVATE_?KEY/i.test(key)) continue
    out[key] = value
  }
  return out
}

declare global {
  // A development reload must retain groups launched by the previous module.
  // eslint-disable-next-line no-var
  var __openground_chatgpt_host_groups: Set<number> | undefined
  // eslint-disable-next-line no-var
  var __openground_chatgpt_host_reaper_installed: boolean | undefined
}
const liveHostGroups = globalThis.__openground_chatgpt_host_groups ??= new Set<number>()

/** Synchronous because the server's exit event cannot await tool cancellation. */
export const reapAllChatGptHostGroups = (): number => {
  let killed = 0
  for (const pid of Array.from(liveHostGroups)) {
    liveHostGroups.delete(pid)
    try { process.kill(-pid, 'SIGKILL'); killed++ } catch { /* already gone */ }
  }
  return killed
}

/** Real-server entry only. Importing tools must not change signal handling.
 * The exit listener also runs when the existing gate reaper exits immediately
 * from its own signal listener, regardless of listener registration order. */
export const installChatGptHostReaper = (): void => {
  if (globalThis.__openground_chatgpt_host_reaper_installed || process.platform !== 'darwin') return
  globalThis.__openground_chatgpt_host_reaper_installed = true
  process.on('exit', reapAllChatGptHostGroups)
  for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]] as const) {
    process.on(signal, () => {
      reapAllChatGptHostGroups()
      process.exit(code)
    })
  }
}

interface HostProcessOptions {
  executable: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  signal: AbortSignal
  timeoutMs: number
  protectedRoots?: string[]
  input?: string
  maxOutputBytes?: number
  readOnly?: boolean
  denyNetwork?: boolean
}
const runProtectedProcess = async (options: HostProcessOptions): Promise<{ stdout: string; stderr: string; exitCode: number | null; remainingProcessesStopped?: boolean }> => {
  checkAbort(options.signal)
  const sandbox = await chatGptShellPreflight(options.protectedRoots)
  const profile = sandbox.profile + (options.readOnly ? '\n(deny file-write*)\n(allow file-write-data (literal "/dev/null"))' : '') + (options.denyNetwork ? '\n(deny network*)' : '')
  checkAbort(options.signal)
  return new Promise((resolveResult, reject) => {
    const child = spawn(sandbox.executable, ['-p', profile, options.executable, ...options.args], { cwd: options.cwd, env: childEnv(options.env), detached: true, stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    if (child.pid) liveHostGroups.add(child.pid)
    let stdout = ''
    let stderr = ''
    let bytes = 0
    let failure: Error | null = null
    let inspectionFailure: Error | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let closeTimer: ReturnType<typeof setTimeout> | undefined
    let groupPollTimer: ReturnType<typeof setTimeout> | undefined
    let stopping = false
    let closed = false
    let groupGone = false
    let resultCode: number | null = null
    let settled = false
    let remainingProcessesStopped = false
    const clearWaits = () => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      clearTimeout(closeTimer)
      clearTimeout(groupPollTimer)
      options.signal.removeEventListener('abort', onAbort)
    }
    const finish = () => {
      if (settled || !closed || !groupGone) return
      settled = true
      if (child.pid) liveHostGroups.delete(child.pid)
      clearWaits()
      if (failure) reject(failure)
      else resolveResult({ stdout, stderr, exitCode: resultCode, ...(remainingProcessesStopped ? { remainingProcessesStopped: true } : {}) })
    }
    const groupSignal = (signal: NodeJS.Signals) => {
      if (!child.pid || groupGone) return
      try { process.kill(-child.pid, signal) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= error as Error }
    }
    const groupAlive = (): boolean => {
      // Once this group is gone, never signal/probe a subsequently reused ID.
      if (groupGone) return false
      if (!child.pid) return false
      try { process.kill(-child.pid, 0); return true } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') { groupGone = true; return false }
        // A probe can briefly return EPERM while macOS is reaping a group.
        // This is not proof of command failure or of group disappearance.
        inspectionFailure = error as Error
        return true
      }
    }
    const waitForCompletion = () => {
      if (closeTimer !== undefined) return
      const inspect = () => {
        if (settled) return
        if (!groupAlive() && closed) { finish(); return }
        groupPollTimer = setTimeout(inspect, 10)
      }
      closeTimer = setTimeout(() => {
        if (settled) return
        if (!groupAlive() && closed) { finish(); return }
        settled = true
        clearWaits()
        // A detached descendant can hold inherited pipes after the original
        // process group is gone. Destroying our pipe readers releases the
        // local wait; it does NOT prove that descendant or its effects ended.
        if (child.pid && groupGone) liveHostGroups.delete(child.pid)
        child.stdin?.destroy()
        child.stdout?.destroy()
        child.stderr?.destroy()
        reject(new ChatGptHostOutcomeUncertainError(failure ?? inspectionFailure))
      }, OUTPUT_CLOSE_GRACE_MS)
      inspect()
    }
    const finishGroup = () => {
      if (stopping) return
      stopping = true
      groupSignal('SIGTERM')
      killTimer = setTimeout(() => {
        if (groupAlive()) groupSignal('SIGKILL')
        // Sending SIGKILL is not evidence that every child has exited yet.
        // Confirm group disappearance independently of the parent's close.
        waitForCompletion()
      }, PROCESS_STOP_GRACE_MS)
    }
    const terminate = (error: Error) => {
      if (settled) return
      failure ??= error
      finishGroup()
    }
    const onAbort = () => terminate(stopped())
    const append = (chunk: string, which: 'stdout' | 'stderr') => {
      if (settled) return
      bytes += Buffer.byteLength(chunk)
      if (bytes > (options.maxOutputBytes ?? MAX_OUTPUT_BYTES)) { terminate(new Error('ChatGPT host output exceeded its limit; narrow the operation')); return }
      if (which === 'stdout') stdout += chunk
      else stderr += chunk
    }
    child.stdout!.setEncoding('utf8')
    child.stderr!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => append(chunk, 'stdout'))
    child.stderr!.on('data', (chunk: string) => append(chunk, 'stderr'))
    child.once('error', (error) => {
      failure ??= error
      if (!child.pid) { closed = true; groupGone = true; finish() }
      else terminate(error)
    })
    child.once('exit', (code) => {
      resultCode = code
      if (settled || stopping) return
      // Node's `close` waits for every inherited stdout/stderr descriptor,
      // including descriptors held by a detached child outside this group.
      // Begin foreground cleanup on process exit, not on eventual pipe close.
      if (groupAlive()) { remainingProcessesStopped = true; finishGroup() }
      else waitForCompletion()
    })
    child.once('close', (code) => {
      resultCode = code
      closed = true
      if (settled) {
        if (child.pid && !groupAlive()) liveHostGroups.delete(child.pid)
        return
      }
      // A script may leave children behind even though its shell exited zero.
      // Every tool invocation is foreground-only: settle only after its group
      // has been stopped, including on the successful-parent path.
      if (!stopping) {
        if (groupAlive()) { remainingProcessesStopped = true; finishGroup() }
      } else groupAlive() // Observe a completed SIGTERM before escalating it.
      finish()
    })
    options.signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => terminate(new Error('ChatGPT command deadline exceeded; its process group was stopped')), options.timeoutMs)
    if (options.input !== undefined) {
      child.stdin!.on('error', (error) => terminate(error))
      child.stdin!.end(options.input)
    }
    if (options.signal.aborted) onAbort()
  })
}

/** One bounded command, no persistent shell or background interaction channel. */
export const runChatGptCommand = (options: {
  command: string; cwd: string; env?: NodeJS.ProcessEnv; signal: AbortSignal; timeoutMs: number; protectedRoots?: string[]
}) => runProtectedProcess({ ...options, executable: '/bin/sh', args: ['-c', options.command] })

// This is fixed trusted program text, never interpolated with a model's path,
// content, or code. The only input is one bounded JSON packet over stdin.
// Running even file I/O inside Seatbelt closes parent-directory symlink races
// after the host's canonical-path/guard check: the kernel still denies secrets.
const FILE_HELPER_SOURCE = String.raw`
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { dirname, isAbsolute } = require('node:path');
const MAX = 1024 * 1024;
const fail = (message) => { throw new Error(message); };
const textFile = async (file) => {
  const handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX) fail('Read requires a regular file no larger than 1 MiB');
    const data = Buffer.alloc(MAX + 1);
    const { bytesRead } = await handle.read(data, 0, data.length, 0);
    if (bytesRead > MAX) fail('Read file exceeds its limit');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, bytesRead));
    if (text.includes('\0')) fail('Read supports UTF-8 text only');
    return text;
  } finally { await handle.close(); }
};
const put = async (file, content) => {
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX) fail('Write content exceeds 1 MiB');
  await fsp.mkdir(dirname(file), { recursive: true });
  const handle = await fsp.open(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(content, 'utf8'); } finally { await handle.close(); }
};
const main = async () => {
  const chunks = []; let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 16 * MAX) fail('File tool input exceeds its limit');
    chunks.push(chunk);
  }
  const packet = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const args = packet.input;
  if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.file_path !== 'string' || !isAbsolute(args.file_path) || args.file_path.length > 4096) fail('Invalid file tool path');
  const file = args.file_path;
  if (packet.operation === 'Read') {
    const offset = args.offset == null ? 1 : args.offset;
    const limit = args.limit == null ? 2000 : args.limit;
    if (!Number.isInteger(offset) || offset < 1 || !Number.isInteger(limit) || limit < 1 || limit > 4000) fail('Invalid read range');
    const lines = (await textFile(file)).split('\n');
    return { path: file, text: lines.slice(offset - 1, offset - 1 + limit).map((line, index) => (offset + index) + ': ' + line).join('\n'), totalLines: lines.length, truncated: offset - 1 + limit < lines.length };
  }
  if (packet.operation === 'Write') {
    await put(file, args.content);
    return { path: file, bytes: Buffer.byteLength(args.content) };
  }
  if (packet.operation === 'Edit') {
    if (typeof args.old_string !== 'string' || !args.old_string || typeof args.new_string !== 'string' || (args.replace_all != null && typeof args.replace_all !== 'boolean')) fail('Invalid edit arguments');
    const text = await textFile(file);
    const matches = text.split(args.old_string).length - 1;
    if (!matches || (matches > 1 && !args.replace_all)) fail(!matches ? 'Edit text was not found' : 'Edit text has multiple matches; provide more context or replace_all=true');
    await put(file, args.replace_all ? text.split(args.old_string).join(args.new_string) : text.replace(args.old_string, () => args.new_string));
    return { path: file, replacements: args.replace_all ? matches : 1 };
  }
  fail('Unsupported file tool operation');
};
main().then((result) => process.stdout.write(JSON.stringify({ ok: true, result }))).catch((error) => {
  process.stdout.write(JSON.stringify({ ok: false, error: ((error && error.code) || 'FileError') + ': ' + String(error && error.message || 'File operation failed').slice(0, 800) }));
});
`

export const runChatGptFileOperation = async (options: {
  cwd: string; operation: 'Read' | 'Write' | 'Edit'; input: Record<string, unknown>; signal: AbortSignal; protectedRoots?: string[]; env?: NodeJS.ProcessEnv
}): Promise<unknown> => {
  const packet = JSON.stringify({ operation: options.operation, input: options.input })
  if (Buffer.byteLength(packet) > 16 * MAX_FILE_BYTES) throw new Error('File tool input exceeds its limit')
  // Do not load parent NODE_OPTIONS, NODE_PATH, or dynamic-loader injection
  // into this fixed helper. File operations need no build-service environment.
  const source = options.env ?? process.env
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' }
  for (const key of ['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ']) if (source[key] !== undefined) env[key] = source[key]
  const result = await runProtectedProcess({ ...options, executable: process.execPath, args: ['-e', FILE_HELPER_SOURCE], input: packet, env, timeoutMs: 15_000, maxOutputBytes: 2 * MAX_FILE_BYTES, readOnly: options.operation === 'Read', denyNetwork: true })
  if (result.exitCode !== 0) throw new Error('ChatGPT protected file helper could not run')
  let parsed: unknown
  try { parsed = JSON.parse(result.stdout) } catch { throw new Error('ChatGPT protected file helper returned an invalid result') }
  if (!object(parsed) || parsed.ok !== true) throw new Error(object(parsed) && typeof parsed.error === 'string' ? parsed.error : 'ChatGPT file operation failed')
  return parsed.result
}

const commandSchema = z.object({ command: z.string().min(1).max(64_000), timeout_ms: z.number().int().positive().max(120_000).nullable().optional() }).strict()
const readSchema = z.object({ file_path: z.string().min(1).max(4096), offset: z.number().int().min(1).nullable().optional(), limit: z.number().int().min(1).max(4000).nullable().optional() }).strict()
const writeSchema = z.object({ file_path: z.string().min(1).max(4096), content: z.string().max(MAX_FILE_BYTES) }).strict()
const editSchema = z.object({ file_path: z.string().min(1).max(4096), old_string: z.string().min(1).max(MAX_FILE_BYTES), new_string: z.string().max(MAX_FILE_BYTES), replace_all: z.boolean().nullable().optional() }).strict()
const parameters = (schema: z.ZodType): Record<string, unknown> => z.toJSONSchema(schema) as Record<string, unknown>

export const createChatGptHostTools = (options: ChatGptHostToolOptions): ChatGptTool[] => {
  if (!options.guard && !options.trusted) throw new Error('ChatGPT worker tools require a deterministic guard')
  const cwd = resolve(options.cwd)
  const protectFile = async (file: string): Promise<void> => {
    const roots = await protectedPaths(options.protectedRoots)
    if (roots.some((root) => under(file, root))) throw new Error('OPEN GROUND credential files are unavailable to agent tools')
  }
  const authorize = async (name: string, input: unknown, signal: AbortSignal): Promise<void> => {
    checkAbort(signal)
    await options.authorize?.()
    checkAbort(signal)
    if (options.guard) {
      let out: unknown
      try { out = await options.guard({ tool_name: name, tool_input: input, cwd }) } catch { throw new Error('OPEN GROUND guard failed; action denied') }
      const hook = object(out) && object(out.hookSpecificOutput) ? out.hookSpecificOutput : null
      if (hook?.permissionDecision !== 'allow') throw new Error(typeof hook?.permissionDecisionReason === 'string' ? hook.permissionDecisionReason : 'OPEN GROUND guard denied this action')
    }
    checkAbort(signal)
  }
  const fileOperation = (operation: 'Read' | 'Write' | 'Edit', input: Record<string, unknown>, signal: AbortSignal) => runChatGptFileOperation({ cwd, operation, input, signal, protectedRoots: options.protectedRoots, env: options.env })
  return [
    {
      name: 'Bash', description: 'Run one foreground shell command in this working directory. No background processes or persistent shell sessions. Output and runtime are bounded.', parameters: parameters(commandSchema),
      invoke: async (raw, signal) => {
        const args = commandSchema.parse(raw)
        await authorize('Bash', { command: args.command }, signal)
        return runChatGptCommand({ command: args.command, cwd, env: options.env, signal, timeoutMs: Math.min(args.timeout_ms ?? 120_000, options.maxCommandMs ?? 120_000), protectedRoots: options.protectedRoots })
      },
    },
    {
      name: 'Read', description: 'Read a UTF-8 text file. offset is a one-based starting line; limit is the maximum number of lines. At most 1 MiB per file.', parameters: parameters(readSchema),
      invoke: async (raw, signal) => {
        const args = readSchema.parse(raw)
        const file = await canonicalPath(cwd, args.file_path)
        await protectFile(file)
        await authorize('Read', { file_path: file }, signal)
        return fileOperation('Read', { ...args, file_path: file }, signal)
      },
    },
    {
      name: 'Write', description: 'Write complete UTF-8 text to a file, creating its parent directories. The host guard checks the canonical target before writing.', parameters: parameters(writeSchema),
      invoke: async (raw, signal) => {
        const args = writeSchema.parse(raw)
        const file = await canonicalPath(cwd, args.file_path)
        await protectFile(file)
        await authorize('Write', { file_path: file, content: args.content }, signal)
        return fileOperation('Write', { ...args, file_path: file }, signal)
      },
    },
    {
      name: 'Edit', description: 'Replace exact text in a UTF-8 file. A non-unique match requires replace_all=true. The host guard checks the canonical target before any change.', parameters: parameters(editSchema),
      invoke: async (raw, signal) => {
        const args = editSchema.parse(raw)
        const file = await canonicalPath(cwd, args.file_path)
        await protectFile(file)
        await authorize('Edit', { file_path: file, old_string: args.old_string, new_string: args.new_string, replace_all: args.replace_all ?? false }, signal)
        return fileOperation('Edit', { ...args, file_path: file }, signal)
      },
    },
  ]
}

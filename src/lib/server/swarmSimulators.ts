// Shut down the iOS simulators a swarm worker booted, when its worktree is put
// away (card integrated / withdrawn / abandoned). Measured 2026-09-26: a worker's
// "iPhone 17 Pro" stayed booted ~55 min after its card, holding ~7 GB.
//
// "CERTAINLY BOOTED BY THIS WORKER" — a device is shut down only if ALL hold:
//   1. it is Booted now;
//   2. one of this worker's Bash commands (its claude transcripts, keyed by the
//      worktree path) names the device by UDID — or by NAME, but only when ALL of:
//      (a) no other device on this Mac (any state, any runtime) has that name,
//      (b) the command is one that boots a device (`simctl boot`, `xcodebuild
//      test` / `test-without-building` — not `build`, not grep),
//      (c) the command finished (has a tool_result; a killed command's 30-min
//      open window is UDID-only).
//      A name shared by several devices (this Mac, measured 2026-09-26: 5 ×
//      "iPhone 17 Pro" across runtimes) never matches — only its UDID does; a leak
//      we accept rather than close something the owner started. Names with a
//      single device DO match (this Mac: 7 such, e.g. "iPhone 16" / "iPhone 16
//      Pro"). Stopped devices count toward (a): the worker's own device may be
//      shut down while the owner's same-named one is up;
//   3. the device's lastBootedAt (simctl) falls inside that command's run window
//      (tool_use timestamp .. its tool_result timestamp) — so the command is what
//      booted it. A device the owner booted earlier fails this (it was already up;
//      `simctl boot` on it errors), and so does one re-booted after;
//   4. no Bash command of another live worktree names the device (a sibling
//      worker of the same app may still be using it).
// A name is matched whole ("iPhone 17" does not match "iPhone 17 Pro"). The
// name → device mapping is today's; a device renamed since is simply not matched.
// A device started by a bare `open -a Simulator` (names nothing) is never touched.
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { claudeDirName } from './claudeProjectDir'
import { openGroundHome } from './paths'
import { claudeProjectsRoot } from './transcript'

const execFile = promisify(execFileCb)
/** lastBootedAt is whole seconds; allow clock/rounding slack around the window. */
const SLACK_MS = 1_000
/** A command with no tool_result (killed mid-run): cap its window. */
const OPEN_WINDOW_MS = 30 * 60_000

export interface SimDevice {
  udid: string
  name?: string
  state?: string
  lastBootedAt?: string
}

export interface SimulatorDeps {
  /** JSONL text of every transcript this worktree's sessions wrote (incl. sub-agents). */
  readWorkerTranscripts: (claudeDir: string) => Promise<string[]>
  /** JSONL text of transcripts of every OTHER live worktree. */
  readOtherLiveTranscripts: (claudeDir: string) => Promise<string[]>
  /** Every simulator device on this Mac, any state. */
  listDevices: () => Promise<SimDevice[]>
  shutdown: (udid: string) => Promise<void>
}

interface Window {
  cmd: string
  start: number
  end: number
  /** Has a tool_result — the command ran to completion. */
  finished: boolean
}

/** Commands that boot a simulator (the action word, not a path or a scheme name). */
const BOOTS = /\bsimctl\s+boot\b|\bxcodebuild\b[^|;&\n]*\s(?:test|test-without-building)(?=\s|$)/

/** Bash command run windows (command text + tool_use..tool_result), from transcript JSONL text. */
export const bashWindows = (jsonl: string): Window[] => {
  const pending = new Map<string, Window>()
  const out: Window[] = []
  for (const line of jsonl.split('\n')) {
    if (!line.includes('"tool_use')) continue
    let rec: { timestamp?: string; message?: { content?: unknown } }
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    const ts = Date.parse(rec.timestamp ?? '')
    const content = rec.message?.content
    if (!Number.isFinite(ts) || !Array.isArray(content)) continue
    for (const c of content as Array<Record<string, unknown>>) {
      if (c.type === 'tool_use' && c.name === 'Bash') {
        // Lines are NOT joined at a trailing `\`: the joined text lets BOOTS run past a
        // `# … test …` comment on the next line (review 2026-09-26). A multi-line
        // `xcodebuild … test` is therefore not name-matched — an accepted leak.
        const cmd = String((c.input as { command?: unknown } | undefined)?.command ?? '')
        const w = { cmd, start: ts, end: ts + OPEN_WINDOW_MS, finished: false }
        out.push(w)
        pending.set(String(c.id), w)
      } else if (c.type === 'tool_result') {
        const w = pending.get(String(c.tool_use_id))
        if (w) {
          w.end = ts
          w.finished = true
        }
      }
    }
  }
  return out
}

const namesUdid = (cmd: string, d: SimDevice): boolean => cmd.toUpperCase().includes(d.udid.toUpperCase())

/** Does this command name the device — its UDID (any case) or its whole name? */
export const namesDevice = (cmd: string, d: SimDevice): boolean => {
  if (namesUdid(cmd, d)) return true
  if (!d.name) return false
  const esc = d.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Whole name: not preceded by a word char, not followed by more of a longer
  // name ("iPhone 17" inside "iPhone 17 Pro" / "iPhone 17e").
  return new RegExp(`(^|[^\\w])${esc}(?![\\w(]| [\\w(])`).test(cmd)
}

export const shutdownWorkerSimulators = async (
  worktree: string,
  claudeDir: string = claudeDirName(worktree),
  deps: SimulatorDeps = defaultSimulatorDeps,
): Promise<string[]> => {
  if (deps === defaultSimulatorDeps && process.platform !== 'darwin') return []
  const windows = (await deps.readWorkerTranscripts(claudeDir)).flatMap(bashWindows)
  if (!windows.length) return []
  const all = await deps.listDevices()
  const sameName = (d: SimDevice) => all.filter((x) => x.name === d.name).length
  const mine = all.filter((d) => {
    if (d.state !== 'Booted') return false
    const at = Date.parse(d.lastBootedAt ?? '')
    if (!Number.isFinite(at)) return false
    const nameIsUnique = !!d.name && sameName(d) === 1
    return windows.some(
      (w) =>
        at >= w.start - SLACK_MS &&
        at <= w.end + SLACK_MS &&
        (namesUdid(w.cmd, d) || (nameIsUnique && w.finished && BOOTS.test(w.cmd) && namesDevice(w.cmd, d))),
    )
  })
  if (!mine.length) return []
  // Another live worker's Bash commands naming it — it may still be using it.
  const others = (await deps.readOtherLiveTranscripts(claudeDir)).flatMap(bashWindows)
  const closed: string[] = []
  for (const d of mine) {
    if (others.some((w) => namesDevice(w.cmd, d))) continue
    try {
      await deps.shutdown(d.udid)
      closed.push(d.udid)
    } catch {
      // already shut down / simctl gone — nothing to do
    }
  }
  return closed
}


const readJsonlTree = async (dir: string): Promise<string[]> => {
  const out: string[] = []
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await readJsonlTree(p)))
    else if (e.name.endsWith('.jsonl')) out.push(await readFile(p, 'utf8').catch(() => ''))
  }
  return out
}

const liveWorktrees = async (): Promise<string[]> => {
  const root = join(openGroundHome(), 'projects')
  const out: string[] = []
  for (const p of await readdir(root).catch(() => [])) {
    const wt = join(root, p, 'worktrees')
    for (const w of await readdir(wt).catch(() => [])) out.push(join(wt, w))
  }
  return out
}

export const defaultSimulatorDeps: SimulatorDeps = {
  readWorkerTranscripts: (claudeDir) => readJsonlTree(join(claudeProjectsRoot(), claudeDir)),
  readOtherLiveTranscripts: async (claudeDir) => {
    const out: string[] = []
    for (const w of await liveWorktrees()) {
      const d = claudeDirName(w)
      if (d !== claudeDir) out.push(...(await readJsonlTree(join(claudeProjectsRoot(), d))))
    }
    return out
  },
  listDevices: async () => {
    const { stdout } = await execFile('xcrun', ['simctl', 'list', '-j', 'devices'], { timeout: 30_000 })
    const devices = (JSON.parse(stdout) as { devices?: Record<string, SimDevice[]> }).devices ?? {}
    return Object.values(devices).flat()
  },
  shutdown: async (udid) => {
    await execFile('xcrun', ['simctl', 'shutdown', udid], { timeout: 60_000 })
  },
}

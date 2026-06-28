// generateProjectDescription — auto-write a project's one-liner description
// (English + Japanese, one run) by briefly running the user's local `claude`
// CLI (haiku) in the project and scraping language-tagged marker pairs out of
// the PTY OUTPUT STREAM. Same pattern as generateTaskTitle.ts — read its top
// comment for the full rationale.
//
// SUBSCRIPTION-ONLY (read claudeTerminal.ts top comment): claude MUST run
// inside a real PTY so it bills the user's Claude subscription pool, NOT the
// programmatic credit pool. `claude -p` / execFile('claude', ...) is FORBIDDEN
// here.
//
// WHY THE PTY STREAM, NOT THE SESSION JSONL: claude ≥2.1.169 no longer writes
// the per-session transcript for these one-off sessions — the old JSONL-polling
// version of this module always timed out with "could not extract". Completion
// = BOTH marker pairs appearing in the raw output:
//   `OPENGROUND_DESC_EN: <text> ::OG_DESC_END::`
//   `OPENGROUND_DESC_JA: <text> ::OG_DESC_END::`
// The end token bounds each description against TUI repaint junk AND lets a
// PTY line-wrap inside the text be collapsed back to spaces. Candidates
// containing '<' are rejected so the prompt's own echoed placeholder can never
// match. The PTY is torn down the moment both pairs land.
//
// Model is pinned to haiku: description-writing is light summarization over a
// quick read-only skim — the cheap model returns in seconds where the default
// took the better part of a minute.

import { newId } from '@/lib/ids'
import { launchClaude } from './claudeTerminal'
import { killTerminal, subscribeTerminal } from './terminal'
import { getPromptLang, type PromptLang } from './promptLang'
import {
  ProjectDataConflictError,
  readProjectData,
  writeProjectData,
} from './projectData'
import type {
  DescribeActiveJob,
  DescribeJobState,
  DescribeJobStatus,
  ProjectData,
} from '@/lib/types'

export const DESC_MARKER_EN = 'OPENGROUND_DESC_EN:'
export const DESC_MARKER_JA = 'OPENGROUND_DESC_JA:'
export const DESC_END = '::OG_DESC_END::'

// One short sentence by contract (the UI shows it on a single truncating
// line) — anything longer is a model that ignored the limit; cap it.
export const MAX_DESC_LEN = 200

// The scrape buffer keeps only the tail — the markers are always near the
// end, and an unbounded buffer would grow with every TUI repaint.
const MAX_BUFFER = 64_000

const DEFAULT_TIMEOUT_MS = 120_000
const POLL_MS = 500

// Cheap + fast for a one-line summary (same deliberate pin as TITLE_MODEL).
const DESCRIBE_MODEL = 'haiku'

// Read-only exploration prompt. Strict: no edits, no file writes, never touch
// .openground/, and end with exactly two marker lines (English + Japanese).
// One universal prompt — both languages are always produced regardless of the
// UI language, so switching the setting later needs no regeneration.
export const buildDescribePrompt = (): string =>
  [
    'Generate a one-line description of what this project is, in BOTH English and Japanese.',
    '',
    'Steps:',
    '- Briefly read the README, directory layout, package.json, etc. to grasp the purpose of the project (read-only).',
    '- Do not create, edit, or delete any files. Do not mutate anything via commands either.',
    '- Never touch the `.openground/` directory (both reading and writing are forbidden).',
    '',
    'Output:',
    '- At the very end, output exactly these two lines (in this order), and nothing after them:',
    `${DESC_MARKER_EN} <ONE short sentence in English — what the project is> ${DESC_END}`,
    `${DESC_MARKER_JA} <日本語で短い1文 — プロジェクトが何か> ${DESC_END}`,
    '- Put only the description text between the marker and the end token; no JSON, no quotes.',
    '- HARD LIMIT: one sentence, max ~80 characters English / 40字 Japanese. It is',
    '  shown on a single truncating UI line — front-load the essence.',
  ].join('\n')

// Strip ANSI escapes / control chars from the raw PTY stream. The TUI doesn't
// just style text — it POSITIONS it: word gaps frequently arrive as cursor
// moves (CSI n C, CUP, …) instead of literal spaces, so deleting every CSI
// fuses words ("ClaudeCodemissioncontrol", observed live). Split the strip:
// SGR (style, CSI…m) deletes silently — it can sit mid-word — while every
// OTHER CSI is a positioning/erase op and becomes a space (the later \s+
// collapse de-dupes). OSC titles (]0;…BEL) are handled separately.
// eslint-disable-next-line no-control-regex
const SGR_RE = /\x1b\[[0-9;]*m/g
// eslint-disable-next-line no-control-regex
const CSI_OTHER_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
// eslint-disable-next-line no-control-regex
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

/** The LAST `<marker> … ::OG_DESC_END::` pair in the raw PTY output, cleaned
 *  and capped, or null. Marker-pair-only — no prose fallback (a wrong
 *  description is worse than none), and any candidate containing '<' is
 *  rejected: that's the prompt's own echoed placeholder, not a model answer.
 *  Exported for unit tests. */
export const extractDescMarker = (raw: string, marker: string): string | null => {
  const text = raw.replace(OSC_RE, '').replace(SGR_RE, '').replace(CSI_OTHER_RE, ' ')
  let from = text.length
  for (;;) {
    const start = text.lastIndexOf(marker, from - 1)
    if (start < 0) return null
    const end = text.indexOf(DESC_END, start + marker.length)
    if (end >= 0) {
      const candidate = text
        .slice(start + marker.length, end)
        .replace(CTRL_RE, ' ')
        // A PTY line wrap can split the sentence — collapse all whitespace
        // runs (incl. the injected newline) back to one space.
        .replace(/\s+/g, ' ')
        .trim()
      if (candidate && !candidate.includes('<')) return candidate.slice(0, MAX_DESC_LEN)
    }
    from = start
    if (from <= 0) return null
  }
}

export interface GeneratedDescriptions {
  en: string | null
  ja: string | null
}

/** Both language markers out of the raw PTY buffer (null where absent). */
export const extractMarkerPair = (raw: string): GeneratedDescriptions => ({
  en: extractDescMarker(raw, DESC_MARKER_EN),
  ja: extractDescMarker(raw, DESC_MARKER_JA),
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export const generateProjectDescription = async (
  projectPath: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<GeneratedDescriptions> => {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  // An already-aborted run (the job was cancelled before it reached the front of
  // the queue) must not burn a claude session out of the subscription window.
  if (opts.signal?.aborted) throw new Error('description generation aborted')

  // bypass (= --dangerously-skip-permissions): no human is at the TTY to
  // approve tool use, and the prompt forbids any mutation, so the read-only
  // exploration runs unattended.
  const ref = launchClaude({
    cwd: projectPath,
    agentSessionId: newId(),
    initialPrompt: buildDescribePrompt(),
    permissionMode: 'bypass',
    model: DESCRIBE_MODEL,
    name: 'describe',
    // Marker-scraped utility session: keep its system prompt pristine so the
    // OPENGROUND_DESC output contract can't drift toward "add a board card".
    appContext: false,
  })

  let buffer = ''
  let exited = false
  // An explicit cancel kills the PTY mid-flight (the ONLY thing that stops a
  // run now that it's a navigation-safe job — a dropped HTTP connection does
  // not). Same shape as canvasAi.ts's runFileTaskOnce abort handling.
  let aborted = false
  const onAbort = () => {
    aborted = true
    try {
      killTerminal(ref.terminalId)
    } catch {
      // already gone
    }
  }
  opts.signal?.addEventListener('abort', onAbort, { once: true })
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
    while (Date.now() < deadline) {
      await sleep(POLL_MS)
      if (aborted) throw new Error('description generation aborted')
      const pair = extractMarkerPair(buffer)
      // Complete only when BOTH languages landed — the two lines arrive
      // together at the very end, so a one-sided read is just mid-stream.
      if (pair.en && pair.ja) return pair
      if (exited || sub?.info.finishedAt) break
    }
    if (aborted) throw new Error('description generation aborted')
    // Timed out, or the session ended early — take whatever DID land (one
    // language alone is still better than nothing).
    const pair = extractMarkerPair(buffer)
    if (pair.en || pair.ja) return pair
    throw new Error('could not extract a description from the claude session')
  } finally {
    opts.signal?.removeEventListener('abort', onAbort)
    sub?.unsubscribe()
    try {
      killTerminal(ref.terminalId)
    } catch {
      // best-effort teardown
    }
  }
}

// ── Server-side job registry ─────────────────────────────────────────────────
//
// WHY JOBS (mirrors canvasAi.ts's registry — read its top comment): a describe
// run is a whole claude PTY session (haiku, but still up to ~2min). The old
// design held one HTTP fetch open for the entire run and the UI applied the
// result on return — so navigating away (switching tab / project / back to
// Ground re-keys or unmounts the panel) discarded the result via the panel's
// loadedDataPathRef guard, and the generated description was lost. So a run is
// now a JOB that is NOT bound to any request connection: it runs to completion
// on its OWN AbortController (killed ONLY by an explicit cancel) and PERSISTS
// the result into the project's central tasks.json server-side regardless of
// who's watching. The client polls the job for progress + result, and
// re-attaches to a still-running one after a navigation.
//
// Stored on globalThis so the registry survives `tsx watch` reloads in dev —
// same pattern as the terminal pool and the canvas AI registry.

interface DescribeJobInternal {
  id: string
  projectPath: string
  status: DescribeJobStatus
  startedAt: number
  /** Aborting this (and only this) kills the claude session — explicit cancel. */
  controller: AbortController
  finishedAt?: number
  // ── results (set on status 'done') ──
  description?: string
  descriptionJa?: string
  descriptionEn?: string
  error?: string
}

const jobGlobal = globalThis as typeof globalThis & {
  __openground_describe_jobs?: Map<string, DescribeJobInternal>
}
const describeJobs: Map<string, DescribeJobInternal> =
  jobGlobal.__openground_describe_jobs ??
  (jobGlobal.__openground_describe_jobs = new Map())

// Keep a finished job around this long so a polling client reliably catches its
// terminal state before it's swept (the client polls every ~1.5s, so this is
// ~200× the interval — a miss is effectively impossible while the panel is open).
const JOB_RETAIN_MS = 5 * 60_000

const scheduleJobSweep = (id: string): void => {
  const timer = setTimeout(() => {
    describeJobs.delete(id)
  }, JOB_RETAIN_MS)
  // Never keep the process alive just for a sweep (clean exit / tests).
  ;(timer as unknown as { unref?: () => void }).unref?.()
}

/** Read-modify-write the generated description pair into the project's central
 *  tasks.json under CAS, retrying a few times so a concurrent board edit (the
 *  user kept working in the panel while claude described) neither blocks the
 *  description nor gets clobbered by it. Mirrors the field-merge the client used
 *  to do: only the languages that landed are written, the legacy single-string
 *  `description` holds the active-language copy. */
const persistDescription = async (
  projectPath: string,
  fields: { description: string; descriptionJa?: string; descriptionEn?: string },
): Promise<void> => {
  for (let attempt = 0; ; attempt++) {
    const data = await readProjectData(projectPath)
    const next: ProjectData = {
      ...data,
      description: fields.description,
      ...(fields.descriptionJa ? { descriptionJa: fields.descriptionJa } : {}),
      ...(fields.descriptionEn ? { descriptionEn: fields.descriptionEn } : {}),
    }
    try {
      await writeProjectData(projectPath, next, {
        expectUpdatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : undefined,
      })
      return
    } catch (e) {
      // A concurrent write moved the CAS token — re-read and retry so the
      // description still lands. Bounded so a pathological write storm can't spin.
      if (e instanceof ProjectDataConflictError && attempt < 3) continue
      throw e
    }
  }
}

/** Dependencies of the describe job — injectable for tests (defaults = the real
 *  PTY engine + projectData persistence + the settings prompt language). Tests
 *  MUST inject all three so a job never spawns claude or touches ~/.openground. */
export interface DescribeJobDeps {
  generate?: typeof generateProjectDescription
  persist?: typeof persistDescription
  lang?: () => Promise<PromptLang>
}

/** Start a describe job for `projectPath`. Returns the job id immediately; on
 *  completion the description pair is persisted to the project's tasks.json
 *  server-side. SINGLE-FLIGHT per project: if a run is already going for this
 *  path, its id is returned (the client re-attaches to it) rather than spawning
 *  a second claude session — so a double-click, or a re-open mid-run, never
 *  forks the work. */
export const startDescribeJob = (
  args: { projectPath: string; timeoutMs?: number },
  deps: DescribeJobDeps = {},
): string => {
  // Single-flight: reuse a still-running job for the same project.
  const existing = Array.from(describeJobs.values()).find(
    (j) => j.status === 'running' && j.projectPath === args.projectPath,
  )
  if (existing) return existing.id
  const generate = deps.generate ?? generateProjectDescription
  const persist = deps.persist ?? persistDescription
  const lang = deps.lang ?? getPromptLang
  const id = newId()
  const controller = new AbortController()
  const job: DescribeJobInternal = {
    id,
    projectPath: args.projectPath,
    status: 'running',
    startedAt: Date.now(),
    controller,
  }
  describeJobs.set(id, job)
  // Fire-and-forget by design: the route returns {jobId} right away and the run
  // is NOT awaited by — nor bound to — the HTTP connection.
  void (async () => {
    try {
      const pair = await generate(args.projectPath, {
        signal: controller.signal,
        timeoutMs: args.timeoutMs,
      })
      if (controller.signal.aborted) throw new Error('cancelled')
      const l = await lang()
      // Active-language copy first; fall back to the other so the persisted
      // `description` is never empty when at least one language landed.
      const description = (l === 'ja' ? pair.ja : pair.en) ?? pair.en ?? pair.ja ?? ''
      if (!description) {
        throw new Error('could not extract a description from the claude session')
      }
      // A cancel that lands after claude finished but before we persist must
      // still win — otherwise a "cancelled" run would silently write the
      // description into projectData. Re-check so the abort short-circuits it.
      if (controller.signal.aborted) throw new Error('cancelled')
      await persist(args.projectPath, {
        description,
        ...(pair.ja ? { descriptionJa: pair.ja } : {}),
        ...(pair.en ? { descriptionEn: pair.en } : {}),
      })
      job.description = description
      job.descriptionJa = pair.ja ?? undefined
      job.descriptionEn = pair.en ?? undefined
      job.status = 'done'
    } catch (e) {
      job.status = 'error'
      job.error = controller.signal.aborted
        ? 'cancelled'
        : e instanceof Error
          ? e.message
          : 'description generation failed'
    } finally {
      job.finishedAt = Date.now()
      scheduleJobSweep(id)
    }
  })()
  return id
}

/** Serializable state of one describe job (GET /api/project/describe/job/:id).
 *  null when the id is unknown or already swept. `now` is injected so tests need
 *  no fake timers. */
export const getDescribeJobState = (
  id: string,
  now: number = Date.now(),
): DescribeJobState | null => {
  const j = describeJobs.get(id)
  if (!j) return null
  return {
    id: j.id,
    projectPath: j.projectPath,
    status: j.status,
    startedAt: new Date(j.startedAt).toISOString(),
    elapsedMs: Math.max(0, now - j.startedAt),
    error: j.error,
    description: j.description,
    descriptionJa: j.descriptionJa,
    descriptionEn: j.descriptionEn,
  }
}

/** Every RUNNING describe job (GET /api/project/describe/active) — the panel
 *  re-attaches to its own project's run after a navigation. Done / errored jobs
 *  are excluded. `now` injected for tests. */
export const listActiveDescribeJobs = (now: number = Date.now()): DescribeActiveJob[] => {
  const out: DescribeActiveJob[] = []
  describeJobs.forEach((j) => {
    if (j.status !== 'running') return
    out.push({
      id: j.id,
      projectPath: j.projectPath,
      elapsedMs: Math.max(0, now - j.startedAt),
    })
  })
  return out
}

/** Explicitly cancel a describe job — aborts its AbortController, which kills
 *  the claude session. This is the ONLY thing that kills a run; a dropped HTTP
 *  connection does NOT. Returns whether the job existed. */
export const cancelDescribeJob = (id: string): boolean => {
  const j = describeJobs.get(id)
  if (!j) return false
  try {
    j.controller.abort()
  } catch {
    // already torn down
  }
  return true
}

// Test-only: the registry lives on globalThis, so it would leak across test
// files without an explicit reset.
export const _resetDescribeJobsForTest = (): void => {
  describeJobs.clear()
}

// researchKnowledge — the knowledge layer over one research report: a distilled
// digest (TL;DR + a handful of points), a per-report Q&A history, and the jobs
// that produce both by running the user's own `claude` CLI over the report.
//
// WHY (owner, 2026-08-18, pitch: docs/RESEARCH_KNOWLEDGE_PITCH.md): 「文字が多くて
// 読む気が失せる」 — a good report is a wall; the knowledge the owner wants out
// of it is thirty seconds of essence plus the ability to interrogate the file.
//
// SHAPE, deliberately copied from generateDescription.ts (the third consumer of
// that pattern, not a fork of it):
//   • runs are JOBS on a globalThis registry — they survive navigation and
//     `tsx watch` reloads, are single-flight per (report, kind), and are killed
//     only by their own timeout (no cancel surface in v1: runs are short).
//   • output crosses the PTY as NUMBERED SINGLE-LINE MARKER SPANS
//     (`OG_RSCH_POINT_3: … ::OG_RSCH_END::`), extracted by the shared
//     ptyMarkers machinery. ptyMarkers collapses all whitespace inside a span
//     (a PTY wrap is indistinguishable from a space), so NOTHING here asks the
//     model for paragraphs — an answer is 1..N numbered lines, reassembled in
//     number order. Numbering also makes TUI repaints harmless: the extractor
//     takes the LAST paint of each number.
//   • the report itself is NEVER pasted into the prompt. `claude` runs with
//     cwd = the project and reads docs/research/<file> itself, read-only —
//     the same contract the describe run has held since it shipped.
//
// PERSISTENCE: one sidecar JSON per report under the project's CENTRAL data dir
// (~/.openground/projects/<uuid>/research-knowledge/) — never inside the repo
// (the pitch's hard non-goal; guarded by researchKnowledge.test.ts). The digest
// carries the sha of the report text it was made from, so the UI can say
// 「前の版から作られました」 instead of silently serving stale essence.

import { createHash } from 'crypto'
import { mkdir, readFile } from 'fs/promises'
import { join } from 'path'
import { newId } from '@/lib/ids'
import { atomicWriteJson } from './atomicWrite'
import { launchClaude } from './claudeTerminal'
import { extractMarkerSpan } from './ptyMarkers'
import { killTerminal, subscribeTerminal } from './terminal'
import { getPromptLang, type PromptLang } from './promptLang'
import { projectDataDir } from './projectDataPath'
import { readResearchReport } from './researchReports'
import type {
  ResearchDigest,
  ResearchJobStateResponse,
  ResearchKnowledgeFile,
  ResearchQaEntry,
} from '../types'

// ── The output contract (frozen protocol strings — see CLAUDE.md) ───────────
export const RSCH_END = '::OG_RSCH_END::'
export const RSCH_TLDR_MARKER = 'OPENGROUND_RSCH_TLDR:'
export const rschPointMarker = (n: number): string => `OPENGROUND_RSCH_POINT_${n}:`
export const rschAnswerMarker = (n: number): string => `OPENGROUND_RSCH_ANS_${n}:`

/** Digest: 3..MAX points. Answers: 1..MAX lines. Both bounded so a runaway
 *  model cannot fill the sidecar; the prompts state the same numbers. */
export const MAX_DIGEST_POINTS = 6
export const MAX_ANSWER_LINES = 8
const MAX_TLDR_LEN = 200
const MAX_POINT_LEN = 240
const MAX_ANSWER_LINE_LEN = 400
export const MAX_QUESTION_LEN = 500
/** Q&A history cap per report — oldest dropped past this. Enough to be a
 *  notebook, small enough that one JSON read stays trivial. */
export const MAX_QA_ENTRIES = 100

const MAX_BUFFER = 512 * 1024
const POLL_MS = 500
const DEFAULT_TIMEOUT_MS = 180_000
// Cheap + fast: both jobs are light extraction over one document the model
// reads itself (the same deliberate pin as generateDescription's haiku).
const KNOWLEDGE_MODEL = 'haiku'

// ── Sidecar store ───────────────────────────────────────────────────────────

export const contentShaOf = (content: string): string =>
  createHash('sha1').update(content, 'utf8').digest('hex')

/** `sub/name.md` must live in ONE flat central dir — encode the separator. */
const sidecarName = (file: string): string => `${encodeURIComponent(file)}.json`

const knowledgeDir = async (projectPath: string): Promise<string> =>
  join(await projectDataDir(projectPath), 'research-knowledge')

const emptyKnowledge = (file: string): ResearchKnowledgeFile => ({ file, qa: [] })

export const readResearchKnowledge = async (
  projectPath: string,
  file: string,
): Promise<ResearchKnowledgeFile> => {
  const p = join(await knowledgeDir(projectPath), sidecarName(file))
  let raw: string
  try {
    raw = await readFile(p, 'utf8')
  } catch {
    return emptyKnowledge(file)
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ResearchKnowledgeFile>
    return {
      file,
      digest: parsed.digest,
      qa: Array.isArray(parsed.qa)
        ? parsed.qa.filter(
            (e): e is ResearchQaEntry =>
              !!e &&
              typeof e.q === 'string' &&
              typeof e.a === 'string' &&
              typeof e.at === 'string',
          )
        : [],
    }
  } catch {
    // A corrupt sidecar is DERIVED data — serve empty; a regenerate rebuilds it.
    return emptyKnowledge(file)
  }
}

/** Read-modify-write under no lock: every writer is a job that already holds
 *  the per-(report,kind) single-flight slot, and digest/ask touch disjoint
 *  fields, so the worst interleave re-reads before writing below. */
const mutateKnowledge = async (
  projectPath: string,
  file: string,
  mutate: (k: ResearchKnowledgeFile) => void,
): Promise<void> => {
  const dir = await knowledgeDir(projectPath)
  await mkdir(dir, { recursive: true })
  const k = await readResearchKnowledge(projectPath, file)
  mutate(k)
  await atomicWriteJson(join(dir, sidecarName(file)), k)
}

// ── Prompts ─────────────────────────────────────────────────────────────────

const READ_ONLY_RULES = (file: string): string[] => [
  `- Read ONLY the file docs/research/${file} (and nothing else). Do not run commands.`,
  '- Do not create, edit, or delete any files. Never touch the `.openground/` directory.',
  '- No angle brackets anywhere in your output lines — a line containing one is discarded.',
]

export const buildDigestPrompt = (file: string, lang: PromptLang): string =>
  [
    lang === 'ja'
      ? `調査レポート docs/research/${file} を読み、要点を抽出してください(日本語で)。`
      : `Read the research report docs/research/${file} and extract its essence (in English).`,
    '',
    ...READ_ONLY_RULES(file),
    '',
    'Output, at the very end, exactly these lines and nothing after them:',
    `${RSCH_TLDR_MARKER} ONE sentence naming what the report found ${RSCH_END}`,
    `${rschPointMarker(1)} first key point, one short sentence ${RSCH_END}`,
    `${rschPointMarker(2)} second key point ${RSCH_END}`,
    `… (3 to ${MAX_DIGEST_POINTS} numbered POINT lines total, one sentence each,`,
    'concrete findings over generalities — numbers and names beat adjectives).',
    'Replace the placeholder text with real content; keep each line on ONE line.',
  ].join('\n')

export const buildAskPrompt = (file: string, question: string): string =>
  [
    `Read the research report docs/research/${file} and answer the question below`,
    'from the report alone. Answer in the same language as the question.',
    '',
    ...READ_ONLY_RULES(file),
    "- If the report does not contain the answer, say so — never fill the gap from general knowledge.",
    '',
    `Question: ${question}`,
    '',
    'Output, at the very end, exactly these lines and nothing after them:',
    `${rschAnswerMarker(1)} first sentence of the answer ${RSCH_END}`,
    `${rschAnswerMarker(2)} second sentence ${RSCH_END}`,
    `… (1 to ${MAX_ANSWER_LINES} numbered ANS lines total — as few as the answer needs,`,
    'one sentence per line, each on ONE line).',
  ].join('\n')

// ── Extraction ──────────────────────────────────────────────────────────────

/** Numbered marker lines 1..max out of the raw PTY buffer, in number order.
 *  A gap does not end the scan (a wrapped line can lose one number while the
 *  rest survive); repaints are harmless because extractMarkerSpan already
 *  takes the last paint per number. */
export const extractNumbered = (
  raw: string,
  markerOf: (n: number) => string,
  max: number,
  maxLen: number,
): string[] => {
  const out: string[] = []
  for (let n = 1; n <= max; n++) {
    const line = extractMarkerSpan(raw, markerOf(n), RSCH_END, { maxLen })
    if (line) out.push(line)
  }
  return out
}

// ── Jobs ────────────────────────────────────────────────────────────────────

export type ResearchJobKind = 'digest' | 'ask'

interface ResearchJobInternal {
  id: string
  kind: ResearchJobKind
  projectPath: string
  file: string
  question?: string
  status: 'running' | 'done' | 'error'
  startedAt: number
  finishedAt?: number
  error?: string
}

const jobGlobal = globalThis as typeof globalThis & {
  __openground_research_jobs?: Map<string, ResearchJobInternal>
}
const jobs: Map<string, ResearchJobInternal> =
  jobGlobal.__openground_research_jobs ?? (jobGlobal.__openground_research_jobs = new Map())

const JOB_RETAIN_MS = 5 * 60_000
const scheduleSweep = (id: string): void => {
  const timer = setTimeout(() => {
    jobs.delete(id)
  }, JOB_RETAIN_MS)
  ;(timer as unknown as { unref?: () => void }).unref?.()
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** One claude run whose ONLY output is marker lines; resolves with the raw
 *  buffer once `isComplete` says the contract landed (or on exit/timeout with
 *  whatever accumulated). Injectable for tests. */
const runMarkerSession = async (
  projectPath: string,
  prompt: string,
  isComplete: (buffer: string) => boolean,
  timeoutMs: number,
): Promise<string> => {
  const ref = launchClaude({
    cwd: projectPath,
    agentSessionId: newId(),
    initialPrompt: prompt,
    permissionMode: 'bypass',
    model: KNOWLEDGE_MODEL,
    name: 'research-knowledge',
    // Marker-scraped utility session (same stance as the describe run): a
    // pristine system prompt, no user-scope MCP servers, no visible pane.
    appContext: false,
    strictMcpConfig: true,
    hidden: true,
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
    while (Date.now() < deadline) {
      await sleep(POLL_MS)
      if (isComplete(buffer)) return buffer
      if (exited || sub?.info.finishedAt) break
    }
    return buffer
  } finally {
    sub?.unsubscribe()
    try {
      killTerminal(ref.terminalId)
    } catch {
      /* already gone */
    }
  }
}

export interface ResearchJobDeps {
  /** Test seam: replaces the whole claude session with a canned buffer. */
  run?: (projectPath: string, prompt: string) => Promise<string>
  lang?: () => Promise<PromptLang>
  timeoutMs?: number
}

const runDeps = (
  deps: ResearchJobDeps,
  isComplete: (buffer: string) => boolean,
): ((projectPath: string, prompt: string) => Promise<string>) =>
  deps.run ??
  ((projectPath, prompt) =>
    runMarkerSession(projectPath, prompt, isComplete, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS))

/** Completion for a numbered-lines contract: done when the count hits `max`
 *  (nothing more can come), or when at least `min` lines have been on screen
 *  UNCHANGED for `settleMs`. A count-based cutoff alone truncates a print in
 *  progress (the run returns between line 3 and line 4); the settle window is
 *  what lets a short answer finish early without eating the whole timeout —
 *  claude's interactive session never exits on its own, so "the model stopped
 *  adding lines" is the only honest end signal available. */
export const makeSettledCompletion = (
  countOf: (buffer: string) => number,
  opts: { min: number; max: number; settleMs?: number; now?: () => number },
): ((buffer: string) => boolean) => {
  const now = opts.now ?? Date.now
  const settleMs = opts.settleMs ?? 2_500
  let lastCount = -1
  let stableSince = now()
  return (buffer: string): boolean => {
    const n = countOf(buffer)
    if (n !== lastCount) {
      lastCount = n
      stableSince = now()
      return n >= opts.max
    }
    if (n >= opts.max) return true
    return n >= opts.min && now() - stableSince >= settleMs
  }
}

const findRunning = (
  projectPath: string,
  file: string,
  kind: ResearchJobKind,
): ResearchJobInternal | undefined =>
  Array.from(jobs.values()).find(
    (j) =>
      j.status === 'running' && j.projectPath === projectPath && j.file === file && j.kind === kind,
  )

/** Start (or re-attach to) the digest job for one report. The digest lands in
 *  the sidecar server-side; the client only polls for the terminal state. */
export const startResearchDigestJob = (
  args: { projectPath: string; file: string },
  deps: ResearchJobDeps = {},
): string => {
  const existing = findRunning(args.projectPath, args.file, 'digest')
  if (existing) return existing.id
  const id = newId()
  const job: ResearchJobInternal = {
    id,
    kind: 'digest',
    projectPath: args.projectPath,
    file: args.file,
    status: 'running',
    startedAt: Date.now(),
  }
  jobs.set(id, job)
  void (async () => {
    try {
      // Read the report FIRST: it 404s a vanished file before any spawn, and
      // the sha records exactly which text the digest distilled.
      const content = await readResearchReport(args.projectPath, args.file)
      const lang = await (deps.lang ?? getPromptLang)()
      // TLDR present + point-count settled (or maxed) — a bare ≥3 cutoff would
      // return between point 3 and point 4 and truncate the digest mid-print.
      const pointsSettled = makeSettledCompletion(
        (buffer) =>
          extractNumbered(buffer, rschPointMarker, MAX_DIGEST_POINTS, MAX_POINT_LEN).length,
        { min: 3, max: MAX_DIGEST_POINTS },
      )
      const digestDone = (buffer: string): boolean =>
        extractMarkerSpan(buffer, RSCH_TLDR_MARKER, RSCH_END, { maxLen: MAX_TLDR_LEN }) !== null &&
        pointsSettled(buffer)
      const buffer = await runDeps(deps, digestDone)(
        args.projectPath,
        buildDigestPrompt(args.file, lang),
      )
      const tldr = extractMarkerSpan(buffer, RSCH_TLDR_MARKER, RSCH_END, { maxLen: MAX_TLDR_LEN })
      const points = extractNumbered(buffer, rschPointMarker, MAX_DIGEST_POINTS, MAX_POINT_LEN)
      if (!tldr || points.length === 0) {
        throw new Error('could not extract a digest from the claude session')
      }
      const digest: ResearchDigest = {
        tldr,
        points,
        lang,
        contentSha: contentShaOf(content),
        generatedAt: new Date().toISOString(),
      }
      await mutateKnowledge(args.projectPath, args.file, (k) => {
        k.digest = digest
      })
      job.status = 'done'
    } catch (e) {
      job.status = 'error'
      job.error = e instanceof Error ? e.message : 'digest failed'
    } finally {
      job.finishedAt = Date.now()
      scheduleSweep(id)
    }
  })()
  return id
}

/** Start (or re-attach to) an ask job. The Q&A pair lands in the sidecar. */
export const startResearchAskJob = (
  args: { projectPath: string; file: string; question: string },
  deps: ResearchJobDeps = {},
): string => {
  const existing = findRunning(args.projectPath, args.file, 'ask')
  if (existing) return existing.id
  const id = newId()
  const job: ResearchJobInternal = {
    id,
    kind: 'ask',
    projectPath: args.projectPath,
    file: args.file,
    question: args.question,
    status: 'running',
    startedAt: Date.now(),
  }
  jobs.set(id, job)
  void (async () => {
    try {
      await readResearchReport(args.projectPath, args.file) // 404 a vanished file early
      const askDone = makeSettledCompletion(
        (buffer) =>
          extractNumbered(buffer, rschAnswerMarker, MAX_ANSWER_LINES, MAX_ANSWER_LINE_LEN).length,
        { min: 1, max: MAX_ANSWER_LINES },
      )
      const buffer = await runDeps(deps, askDone)(
        args.projectPath,
        buildAskPrompt(args.file, args.question),
      )
      const lines = extractNumbered(buffer, rschAnswerMarker, MAX_ANSWER_LINES, MAX_ANSWER_LINE_LEN)
      if (lines.length === 0) {
        throw new Error('could not extract an answer from the claude session')
      }
      const entry: ResearchQaEntry = {
        q: args.question,
        a: lines.join('\n'),
        at: new Date().toISOString(),
      }
      await mutateKnowledge(args.projectPath, args.file, (k) => {
        k.qa.push(entry)
        if (k.qa.length > MAX_QA_ENTRIES) k.qa.splice(0, k.qa.length - MAX_QA_ENTRIES)
      })
      job.status = 'done'
    } catch (e) {
      job.status = 'error'
      job.error = e instanceof Error ? e.message : 'the question failed'
    } finally {
      job.finishedAt = Date.now()
      scheduleSweep(id)
    }
  })()
  return id
}

export const getResearchJobState = (id: string): ResearchJobStateResponse | null => {
  const j = jobs.get(id)
  if (!j) return null
  return {
    id: j.id,
    kind: j.kind,
    file: j.file,
    status: j.status,
    startedAt: new Date(j.startedAt).toISOString(),
    ...(j.error ? { error: j.error } : {}),
  }
}

/** Test hygiene only. */
export const __resetResearchJobsForTests = (): void => {
  jobs.clear()
}

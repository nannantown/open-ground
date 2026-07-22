// youCorpus.ts — the proxy's externalised JUDGMENT AXIS ("あなたの判断軸").
//
// Phase 0 of the autonomous-overseer design (auto-memory note
// project-autonomous-overseer-design): the proxy is "the user's faithful
// function", so the investment is not runtime but WRITING THE JUDGMENT AXIS OUT
// to a single corpus that can be injected at proxy startup. This module
// assembles that corpus from three mechanical sources —
//
//   1. CONCEPT.md                        — the product soul (in-repo, tracked)
//   2. project_business_model_vision     — the business soul (an auto-memory)
//   3. the rest of the OPEN GROUND auto-memory (feedback / project / reference /
//      user notes Claude has accumulated for this repo)
//
// — plus a fourth, GROWING source: hand-added judgments appended via
// appendJudgment() (the "new decision" command/UI). The assembled result is one
// self-describing markdown file, ~/.openground/you-corpus.md, written 0600.
//
// PRIVACY (load-bearing): this is a pile of personal information. It lives ONLY
// under ~/.openground (the central app home, NEVER inside any git repo) and is
// defensively gitignored. Nothing here ever writes into a project working tree.
//
// Source locations are resolved WITHOUT depending on the server's cwd (the
// packaged app's cwd is not the OPEN GROUND repo — resolving from cwd there
// once assembled an EMPTY corpus over a 410KB one, 2026-07-17): env overrides
// win, an explicit opts.cwd is honoured (CLI/tests), then the project REGISTRY
// is searched for the OPEN GROUND repo itself, and only as a dev fallback do we
// git-resolve from process.cwd(). Fully overridable (opts args +
// OPENGROUND_MEMORY_DIR / OPENGROUND_CONCEPT_PATH env) so the test suite never
// reads the real ~/.claude memory.

import { readFile, readdir, stat, rename } from 'fs/promises'
import { homedir } from 'os'
import { join, resolve, dirname } from 'path'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { randomUUID } from 'crypto'
import { ensureOpenGroundHome, youCorpusFile, youCorpusAdditionsFile } from './paths'
import { atomicWriteText, atomicWriteJson } from './atomicWrite'
import { getSettings } from './store'
import type { ManualJudgment, YouCorpusMeta, YouCorpusStatus } from '../types'

const execFile = promisify(execFileCb)

// The auto-memory file that IS the business soul — pinned to its own prominent
// section and excluded from the generic project list so it isn't duplicated.
const BUSINESS_VISION_FILE = 'project_business_model_vision.md'
const BUSINESS_VISION_NAMES = new Set([
  'project_business_model_vision',
  'project-business-model-vision',
])
// The auto-memory INDEX is a pointer list, not a judgment — never ingest it.
const MEMORY_INDEX_FILE = 'MEMORY.md'

const FILE_MODE = 0o600 // personal data — owner-only

// ─── Source resolution ───────────────────────────────────────────────────────

// Claude Code keys its per-repo memory under ~/.claude/projects/<encoded path>/,
// where the path is the MAIN checkout's working dir with every non-alphanumeric
// char replaced by '-' (verified empirically: `/Users/k/projects/OPEN GROUND` →
// `-Users-k-projects-OPEN-GROUND`; `/.openground` → `--openground`). No
// collapsing of runs. This is Claude Code's internal convention — there is no
// API for it — so we reproduce it, but every caller treats a missing dir as
// "no memory" rather than failing.
export const encodeClaudeProjectKey = (absPath: string): string =>
  absPath.replace(/[^A-Za-z0-9]/g, '-')

// The MAIN repo root, even from a linked worktree. `git rev-parse
// --git-common-dir` returns the shared `.git` (absolute for a worktree, the
// literal `.git` for the main checkout); resolving it against cwd then taking
// the dirname yields the main working dir in BOTH cases. null on any failure
// (git missing / not a repo) — the caller degrades to "no memory".
export const resolveMainRepoRoot = async (cwd?: string): Promise<string | null> => {
  const dir = cwd ?? process.cwd()
  try {
    const { stdout } = await execFile('git', ['rev-parse', '--git-common-dir'], { cwd: dir })
    const commonDir = stdout.trim()
    if (!commonDir) return null
    return dirname(resolve(dir, commonDir))
  } catch {
    return null
  }
}

// Claude Code's auto-memory dir for a given MAIN-checkout path. Pure path
// computation — existence is the caller's concern.
export const autoMemoryDirFor = (repoPath: string): string =>
  join(homedir(), '.claude', 'projects', encodeClaudeProjectKey(repoPath), 'memory')

// The auto-memory directory resolved FROM A CWD via git (the dev-era default).
// Env override wins (tests + escape hatch); otherwise computed from the main
// repo root via the encoding above. Returns null when it cannot be resolved —
// assembly then proceeds with the other sources. Prefer resolveDefaultSources()
// for a cwd-independent resolution (registry-aware).
export const defaultAutoMemoryDir = async (cwd?: string): Promise<string | null> => {
  const override = process.env.OPENGROUND_MEMORY_DIR
  if (override) return override
  const root = await resolveMainRepoRoot(cwd)
  if (!root) return null
  return autoMemoryDirFor(root)
}

// CONCEPT.md path resolved FROM A CWD via git (the dev-era default). Env
// override wins; otherwise the tracked file at the worktree root (`git
// rev-parse --show-toplevel`), falling back to <cwd>/CONCEPT.md. The path is
// returned regardless of existence — the reader checks. Prefer
// resolveDefaultSources() for a cwd-independent resolution (registry-aware).
export const defaultConceptPath = async (cwd?: string): Promise<string> => {
  const override = process.env.OPENGROUND_CONCEPT_PATH
  if (override) return override
  const dir = cwd ?? process.cwd()
  try {
    const { stdout } = await execFile('git', ['rev-parse', '--show-toplevel'], { cwd: dir })
    const top = stdout.trim()
    if (top) return join(top, 'CONCEPT.md')
  } catch {
    /* fall through */
  }
  return join(dir, 'CONCEPT.md')
}

// Find the OPEN GROUND repo's sources via the PROJECT REGISTRY — the
// cwd-independent resolution the packaged app needs (its server cwd is not a
// git repo, so the git resolvers above see "no sources" there). Only paths
// already on the registry allowlist (the same one validateProjectPath enforces)
// are ever considered — this never reads an arbitrary path. A registry entry
// qualifies when BOTH of its corpus sources exist: <path>/CONCEPT.md and the
// path's auto-memory dir — requiring both keeps a random project that merely
// contains some CONCEPT.md from being mistaken for OPEN GROUND. Among multiple
// qualifiers (e.g. two clones) prefer the one whose memory holds the
// business-vision note, then the one with the most notes (= the live checkout).
// Returns null when nothing qualifies — callers fall back to git-from-cwd.
export const resolveSourcesFromRegistry = async (): Promise<{
  memoryDir: string
  conceptPath: string
} | null> => {
  let projects
  try {
    projects = (await getSettings()).projects ?? []
  } catch {
    return null // unreadable settings — degrade to the git fallback
  }
  interface Candidate {
    memoryDir: string
    conceptPath: string
    hasVision: boolean
    noteCount: number
  }
  const candidates: Candidate[] = []
  for (const entry of projects) {
    if (!entry?.path) continue
    const conceptPath = join(entry.path, 'CONCEPT.md')
    try {
      await stat(conceptPath)
    } catch {
      continue
    }
    const memoryDir = autoMemoryDirFor(entry.path)
    let names: string[]
    try {
      names = await readdir(memoryDir)
    } catch {
      continue
    }
    const notes = names.filter((n) => n.endsWith('.md') && n !== MEMORY_INDEX_FILE)
    candidates.push({
      memoryDir,
      conceptPath,
      hasVision: notes.includes(BUSINESS_VISION_FILE),
      noteCount: notes.length,
    })
  }
  if (candidates.length === 0) return null
  candidates.sort(
    (a, b) => Number(b.hasVision) - Number(a.hasVision) || b.noteCount - a.noteCount,
  )
  return { memoryDir: candidates[0].memoryDir, conceptPath: candidates[0].conceptPath }
}

// The default source resolution used by assembly/status when opts don't pin a
// source explicitly. Priority, per source:
//   1. env override (OPENGROUND_MEMORY_DIR / OPENGROUND_CONCEPT_PATH — tests)
//   2. an EXPLICIT cwd argument → git resolution from there (the caller said
//      "this checkout"; the CLI run from a repo may pass it)
//   3. the project registry (cwd-independent — the packaged app's path)
//   4. git resolution from process.cwd() (dev servers started inside the repo
//      before the repo is registered)
export const resolveDefaultSources = async (
  cwd?: string,
): Promise<{ memoryDir: string | null; conceptPath: string | null }> => {
  const memEnv = process.env.OPENGROUND_MEMORY_DIR
  const conEnv = process.env.OPENGROUND_CONCEPT_PATH
  // Lazily resolve the registry once, only if some source actually needs it.
  let registry: { memoryDir: string; conceptPath: string } | null | undefined
  const fromRegistry = async () =>
    registry !== undefined ? registry : (registry = await resolveSourcesFromRegistry())

  let memoryDir: string | null
  if (memEnv) memoryDir = memEnv
  else if (cwd !== undefined) memoryDir = await defaultAutoMemoryDir(cwd)
  else memoryDir = (await fromRegistry())?.memoryDir ?? (await defaultAutoMemoryDir())

  let conceptPath: string | null
  if (conEnv) conceptPath = conEnv
  else if (cwd !== undefined) conceptPath = await defaultConceptPath(cwd)
  else conceptPath = (await fromRegistry())?.conceptPath ?? (await defaultConceptPath())

  return { memoryDir, conceptPath }
}

// ─── Memory parsing ──────────────────────────────────────────────────────────

type MemoryType = 'user' | 'feedback' | 'project' | 'reference' | 'other'
interface MemoryDoc {
  filename: string
  name: string
  description: string
  type: MemoryType
  body: string
}

const asMemoryType = (raw: string | null): MemoryType => {
  const t = (raw ?? '').trim()
  if (t === 'user' || t === 'feedback' || t === 'project' || t === 'reference') return t
  return 'other'
}

const parseMemoryFile = (filename: string, raw: string): MemoryDoc => {
  const fmMatch = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(raw)
  const front = fmMatch ? fmMatch[1] : ''
  const body = (fmMatch ? fmMatch[2] : raw).trim()
  const pick = (re: RegExp): string => (re.exec(front)?.[1] ?? '').trim()
  // `^\s*type:` matches the indented `type:` inside the metadata block but NOT
  // `node_type:` (after the leading spaces the next char is `n`, not `t`).
  const name = pick(/^name:\s*(.+)$/m) || filename.replace(/\.md$/, '')
  const description = pick(/^description:\s*(.+)$/m)
  const type = asMemoryType(pick(/^\s*type:\s*(\w+)/m) || null)
  return { filename, name, description, type, body }
}

const isBusinessVision = (d: MemoryDoc): boolean =>
  d.filename === BUSINESS_VISION_FILE || BUSINESS_VISION_NAMES.has(d.name)

// Read + parse every memory note in `dir` (excluding the index). Returns [] when
// the dir is absent/unreadable — a fresh machine or a failed resolution simply
// contributes no memory section.
const readMemoryDocs = async (dir: string | null): Promise<MemoryDoc[]> => {
  if (!dir) return []
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const docs: MemoryDoc[] = []
  for (const filename of names.sort()) {
    if (!filename.endsWith('.md') || filename === MEMORY_INDEX_FILE) continue
    try {
      const raw = await readFile(join(dir, filename), 'utf8')
      docs.push(parseMemoryFile(filename, raw))
    } catch {
      /* skip an unreadable file — never let one bad note sink the corpus */
    }
  }
  return docs
}

// ─── Manual judgments (the growing, hand-added source) ───────────────────────

// "This path does not exist" — the ONLY read failure a writer may treat as
// "legitimately empty". Anything else (EACCES, EIO, EMFILE, …) means the data
// may well be there and just unreadable right now, so a writer must refuse
// rather than overwrite it. ENOTDIR is the same class (a parent component of
// the path is not a directory ⇒ the file cannot exist).
const isMissingFileError = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

const isManualJudgment = (v: unknown): v is ManualJudgment =>
  v != null &&
  typeof v === 'object' &&
  typeof (v as ManualJudgment).text === 'string' &&
  (v as ManualJudgment).text.length > 0

// Read the appended judgments (JSON array) — the READ-ONLY path (assembly,
// status, GET /judgments).
//
// UNREADABLE ≠ ABSENT, same rule as the append reader below: ENOENT is the only
// read failure that legitimately means "no judgments yet". Every other errno
// (EACCES on a file one `sudo` run left root-owned, EIO, EMFILE…) means the
// judgments ARE there and we merely could not see them — and answering [] to
// that is a confident lie in three places at once: the Persona tab shows its
// first-run invite ("nothing here yet") over a full corpus, the status reports
// manualCount 0, and an assemble writes a corpus with the manual section
// EMPTIED — silently deleting the persona from the one file the overseer reads
// before it judges anything on the owner's behalf. A surfaced error is
// recoverable; a corpus quietly missing its persona is not noticed at all.
// Reader and writer must agree here: appendJudgment already refuses on exactly
// this condition (see readManualJudgmentsForAppend).
//
// PARSE failure stays tolerant: a hand-mangled or half-written file yields []
// rather than throwing, so a corrupt additions file can never block assembly
// (mirrors the readJson guards in store.ts). The write path preserves such a
// file aside as `.corrupt-<ts>` before it writes — that is the one behaviour
// the two readers still differ on.
export const readManualJudgments = async (): Promise<ManualJudgment[]> => {
  await ensureOpenGroundHome()
  let raw: string
  try {
    raw = await readFile(youCorpusAdditionsFile(), 'utf8')
  } catch (err) {
    if (!isMissingFileError(err)) throw err
    return []
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isManualJudgment)
  } catch {
    return []
  }
}

// The read for the APPEND path. Same ENOENT-only rule on read failures as the
// reader above; it differs on CORRUPTION. The additions file is the feature's
// one IRREPLACEABLE, accumulate-only source — so where a reader may shrug a
// corrupt file off as empty, this one must NOT let the caller silently
// overwrite it (that would turn a recoverable corruption into permanent, silent
// loss of every prior judgment).
// ENOENT means legitimately empty. A parse failure (the file exists but is
// unreadable JSON / not an array) means: PRESERVE the damaged file aside as
// `.corrupt-<ts>` before the caller writes a fresh one, so nothing is destroyed.
const readManualJudgmentsForAppend = async (): Promise<ManualJudgment[]> => {
  const file = youCorpusAdditionsFile()
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (err) {
    // ENOENT-ONLY. "Absent" is the only read failure that legitimately means
    // "nothing to preserve" — every other errno (EACCES on a root-owned file
    // left by one `sudo` run, EIO, EMFILE…) means the judgments ARE there and
    // we simply could not see them. Treating those as empty would let the
    // caller write a fresh one-element array over the file: total, silent loss
    // of the one irreplaceable source, from a transient condition. Fail the
    // append instead — a surfaced error is recoverable, an erased history is
    // not. (The tolerant-reader trap: a fail-closed guard is only fail-closed
    // if its read actually throws.)
    if (!isMissingFileError(err)) throw err
    return []
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new Error('additions file is not a JSON array')
    return parsed.filter(isManualJudgment)
  } catch {
    // Move the corrupt file aside (perms are preserved by rename) so the prior
    // judgments stay recoverable, then continue from empty. Best-effort: if the
    // rename fails we still don't proceed to clobber — re-throw so the append
    // surfaces an error rather than silently overwriting.
    await rename(file, `${file}.corrupt-${Date.now()}`)
    return []
  }
}

// Serialise appends through a single-flight chain (like store.setSettings) so
// two concurrent appends can't lose each other's record (read-modify-write).
let additionsChain: Promise<unknown> = Promise.resolve()

export interface AppendJudgmentInput {
  text: string
  tags?: string[]
  context?: string
  /** id of the judgment this one corrects (see ManualJudgment.correctsId). */
  correctsId?: string
}

// Describe the corpus AS IT SITS ON DISK, without assembling. Used for the
// "saved, but not rebuilt" report below, where the assembly that would have
// measured the sources is the very thing that failed: path/size/mtime are read
// off the real file, manualCount is the count we just wrote, and the three
// source flags are reported as not-included because we genuinely do not know —
// `skipped: true` is what tells the caller the numbers describe a stale file
// (same convention as the empty-assembly fail-safe above).
const corpusMetaOnDisk = async (manualCount: number): Promise<YouCorpusMeta> => {
  let sizeBytes = 0
  let assembledAt = new Date().toISOString()
  try {
    const s = await stat(youCorpusFile())
    sizeBytes = s.size
    assembledAt = s.mtime.toISOString()
  } catch {
    /* never assembled — 0 bytes, and "now" is the best timestamp available */
  }
  return {
    path: youCorpusFile(),
    assembledAt,
    sizeBytes,
    memoryCount: 0,
    manualCount,
    conceptIncluded: false,
    businessVisionIncluded: false,
  }
}

// Append a new judgment, then re-assemble so the single injectable file is
// always current. Throws on empty text (the route maps that to 400).
export const appendJudgment = async (
  input: AppendJudgmentInput,
): Promise<{ judgment: ManualJudgment; meta: YouCorpusMeta }> => {
  const text = (input.text ?? '').trim()
  if (!text) throw new Error('judgment text is required')
  const judgment: ManualJudgment = {
    id: randomUUID(),
    text,
    addedAt: new Date().toISOString(),
    ...(input.tags && input.tags.length ? { tags: input.tags } : {}),
    ...(input.context && input.context.trim() ? { context: input.context.trim() } : {}),
    ...(input.correctsId && input.correctsId.trim()
      ? { correctsId: input.correctsId.trim() }
      : {}),
  }
  // Serialise the WHOLE read-modify-write AND the re-assemble through the chain:
  // concurrent appends then can't lose an update, and you-corpus.md can't end up
  // reflecting a stale additions set (the assemble runs INSIDE the lock, after
  // this judgment's write). fsync:true — additions is the one irreplaceable
  // source, so it must survive a power cut (atomicity alone can surface a 0-byte
  // file on a cut; see atomicWrite.ts).
  const run = additionsChain.then(async (): Promise<YouCorpusMeta> => {
    await ensureOpenGroundHome()
    // Strict read: preserves (never clobbers) a corrupt additions file.
    const current = await readManualJudgmentsForAppend()
    current.push(judgment)
    await atomicWriteJson(youCorpusAdditionsFile(), current, { mode: FILE_MODE, fsync: true })
    // The judgment is PERSISTED as of the line above. A re-assembly failure past
    // this point must NOT be reported as a failed append: the caller (the
    // Persona tab) keeps the owner's draft on error and lets them press the
    // button again, which would write the SAME judgment a second time. So
    // report what actually happened — saved, corpus not rebuilt — through the
    // same `skipped` + `warning` channel the empty-assembly fail-safe uses, and
    // which the tab already surfaces as a warning line.
    try {
      return await assembleYouCorpus()
    } catch (err) {
      const warning =
        'the judgment was saved, but re-assembling the corpus failed — the file ' +
        `the overseer reads is stale until the next successful rebuild: ${
          err instanceof Error ? err.message : String(err)
        }`
      console.warn(`[you-corpus] ${warning}`)
      return { ...(await corpusMetaOnDisk(current.length)), skipped: true, warning }
    }
  })
  additionsChain = run.catch(() => {})
  const meta = await run
  return { judgment, meta }
}

// ─── Assembly ────────────────────────────────────────────────────────────────

const MEMORY_SECTION_ORDER: { type: MemoryType; heading: string }[] = [
  { type: 'feedback', heading: 'feedback — 仕事の進め方（あなたが私に与えた指針）' },
  { type: 'project', heading: 'project — 進行中の文脈・制約' },
  { type: 'reference', heading: 'reference — 落とし穴・手順の索引' },
  { type: 'user', heading: 'user — あなた自身の像' },
  { type: 'other', heading: 'その他の記憶' },
]

const renderMemoryDoc = (d: MemoryDoc): string => {
  const lines = [`#### ${d.name}`]
  if (d.description) lines.push(`*${d.description}*`, '')
  if (d.body) lines.push(d.body)
  return lines.join('\n')
}

// Indent every line after the first to the list item's content column, so a
// MULTI-LINE judgment stays inside its own bullet. Without this the 2nd line
// starts at column 0, which ends the list item — and a note whose 2nd line
// begins with "## " or "- " then reads as a real corpus heading or a separate
// judgment. Since manual judgments render newest-first, one such note would
// re-parent every OLDER entry beneath it: the proxy misreads its own judgment
// axis. Multi-line is the normal case now that the Persona tab writes these
// through a textarea, so this is ordinary input, not an attack.
const indentContinuation = (s: string): string => s.replace(/\n/g, '\n  ')

const renderManual = (m: ManualJudgment): string => {
  const meta = [m.addedAt, ...(m.tags?.length ? [m.tags.join(', ')] : [])].join(' · ')
  const lines = [`- **${indentContinuation(m.text)}**`, `  <sub>${meta}</sub>`]
  if (m.context) lines.push(`  ${indentContinuation(m.context)}`)
  return lines.join('\n')
}

export interface AssembleOptions {
  /** Explicit memory dir. `undefined` → resolve default; `null` → no memory. */
  memoryDir?: string | null
  /** Explicit CONCEPT.md path. `undefined` → resolve default. */
  conceptPath?: string | null
  /** cwd used when resolving defaults (git). Defaults to process.cwd(). */
  cwd?: string
}

// Serialise ALL assembles (rebuild / append / readYouCorpus) through one lock so
// two never interleave their writes and leave you-corpus.md reflecting a STALE
// additions snapshot. atomicWriteText already prevents a TORN file; this prevents
// a stale-but-complete one (the append-vs-append / append-vs-rebuild race).
let assembleLock: Promise<unknown> = Promise.resolve()

// Assemble the corpus from all sources and write the single you-corpus.md
// (0600). Returns lightweight meta. Never throws on a missing source — it just
// contributes nothing.
export const assembleYouCorpus = (opts: AssembleOptions = {}): Promise<YouCorpusMeta> => {
  const run = assembleLock.then(() => assembleYouCorpusInner(opts))
  // Keep the lock advancing even if one assemble throws, so a single failure
  // can't wedge every subsequent assemble (mirrors the store.ts chains).
  assembleLock = run.catch(() => {})
  return run
}

// Does an assembled corpus text contain any MECHANICAL source (auto-memory /
// CONCEPT.md / business vision)? Read from its own `> sources:` summary line.
// An unparseable text (hand-edited, older format) counts as "has sources" — the
// conservative side, since this feeds the do-not-overwrite guard below.
const corpusHasMechanicalSources = (text: string): boolean => {
  const m = /^> sources: (.+)$/m.exec(text)
  if (!m) return true
  const line = m[1]
  if (line.includes('CONCEPT.md ✓')) return true
  if (line.includes('business_model_vision ✓')) return true
  const mem = /auto-memory (\d+)/.exec(line)
  if (!mem) return true
  return parseInt(mem[1], 10) > 0
}

const assembleYouCorpusInner = async (opts: AssembleOptions): Promise<YouCorpusMeta> => {
  await ensureOpenGroundHome()
  let memoryDir: string | null
  let conceptPath: string | null
  if (opts.memoryDir !== undefined && opts.conceptPath !== undefined) {
    memoryDir = opts.memoryDir
    conceptPath = opts.conceptPath
  } else {
    const resolved = await resolveDefaultSources(opts.cwd)
    memoryDir = opts.memoryDir !== undefined ? opts.memoryDir : resolved.memoryDir
    conceptPath = opts.conceptPath !== undefined ? opts.conceptPath : resolved.conceptPath
  }

  let conceptBody: string | null = null
  if (conceptPath) {
    try {
      conceptBody = (await readFile(conceptPath, 'utf8')).trim()
    } catch {
      conceptBody = null
    }
  }

  const docs = await readMemoryDocs(memoryDir)
  const businessVision = docs.find(isBusinessVision) ?? null
  const manual = await readManualJudgments()

  const assembledAt = new Date().toISOString()
  const conceptIncluded = conceptBody != null && conceptBody.length > 0
  const businessVisionIncluded = businessVision != null

  // FAIL-SAFE (the 2026-07-17 incident guard): when NO mechanical source
  // resolved (zero memory notes AND no CONCEPT.md) but the existing corpus was
  // built WITH mechanical sources, this assembly is almost certainly a source-
  // RESOLUTION failure (wrong cwd, unmounted disk), not the sources genuinely
  // emptying out — overwriting would silently destroy the proxy's memory. Keep
  // the file, warn, and report `skipped` in the meta. A corpus that never had
  // mechanical sources (fresh machine, manual-only use) keeps assembling
  // normally, so manual appends still land there.
  if (docs.length === 0 && !conceptIncluded) {
    let existing: string | null = null
    // ENOENT-only again (see isMissingFileError): only a genuinely ABSENT
    // corpus means "nothing to protect, first write is fine". An existing
    // corpus we merely failed to read (EACCES/EIO) must NOT be downgraded to
    // "no corpus" — that disarms this whole guard at exactly the moment it
    // matters and overwrites a populated corpus with an empty assembly, with no
    // `skipped` flag to warn anyone. Unreadable ⇒ refuse the write outright.
    try {
      existing = await readFile(youCorpusFile(), 'utf8')
    } catch (err) {
      if (!isMissingFileError(err)) throw err
      existing = null
    }
    if (existing != null && corpusHasMechanicalSources(existing)) {
      const warning =
        'no mechanical sources resolved (auto-memory 0, CONCEPT.md missing) — ' +
        'kept the existing corpus instead of overwriting it with an empty assembly. ' +
        'Check source resolution: project registry / cwd / OPENGROUND_MEMORY_DIR / ' +
        'OPENGROUND_CONCEPT_PATH.'
      console.warn(`[you-corpus] ${warning}`)
      let prevAssembledAt = assembledAt
      try {
        prevAssembledAt = (await stat(youCorpusFile())).mtime.toISOString()
      } catch {
        /* keep the current timestamp */
      }
      return {
        path: youCorpusFile(),
        assembledAt: prevAssembledAt,
        sizeBytes: Buffer.byteLength(existing, 'utf8'),
        memoryCount: 0,
        manualCount: manual.length,
        conceptIncluded: false,
        businessVisionIncluded: false,
        skipped: true,
        warning,
      }
    }
  }

  const out: string[] = []
  out.push('# あなたの判断軸 — OPEN GROUND proxy corpus')
  out.push(
    '<!-- AUTO-GENERATED by src/lib/server/youCorpus.ts. Do not hand-edit: this',
    '     file is rebuilt from source on every assemble / judgment append. To add',
    '     a judgment use `npm run you-corpus append "…"` or POST /api/you-corpus/append.',
    '     PERSONAL DATA — lives only under ~/.openground, never git-shared. -->',
  )
  out.push('')
  const summary = [
    `CONCEPT.md ${conceptIncluded ? '✓' : '–'}`,
    `business_model_vision ${businessVisionIncluded ? '✓' : '–'}`,
    `auto-memory ${docs.length}`,
    `手動追記 ${manual.length}`,
  ].join(' · ')
  out.push(`> assembled: ${assembledAt}`, `> sources: ${summary}`)
  out.push('')
  out.push(
    'あなたは OPEN GROUND のオーナーの **proxy**。以下はオーナー＝あなたの判断軸（魂と',
    '記憶）である。迷ったらこの軸で「オーナーならどう判断するか」を再現せよ。ただし',
    '**不可逆な操作（課金・公開・送金・削除）は、たとえ自信があってもオーナー本人に',
    'エスカレーションせよ**。情報が足りないと感じたら断定せず、足りないことを申告せよ。',
  )
  out.push('')

  out.push('## 1. 北極星 — プロダクトの魂 (CONCEPT.md)')
  out.push(conceptIncluded ? (conceptBody as string) : '_(CONCEPT.md が見つからない)_')
  out.push('')

  out.push('## 2. 北極星 — 事業の魂 (business_model_vision)')
  if (businessVision) {
    if (businessVision.description) out.push(`*${businessVision.description}*`, '')
    out.push(businessVision.body)
  } else {
    out.push('_(business_model_vision の記憶が見つからない)_')
  }
  out.push('')

  out.push('## 3. 判断の記憶 (auto-memory)')
  const rest = docs.filter((d) => !isBusinessVision(d))
  if (rest.length === 0) {
    out.push('_(auto-memory が見つからない)_')
  } else {
    for (const { type, heading } of MEMORY_SECTION_ORDER) {
      const group = rest.filter((d) => d.type === type)
      if (group.length === 0) continue
      out.push(`### 3.${MEMORY_SECTION_ORDER.findIndex((s) => s.type === type) + 1} ${heading}`)
      for (const d of group) {
        out.push(renderMemoryDoc(d), '')
      }
    }
  }
  out.push('')

  out.push('## 4. 手で足した判断 (manual)')
  if (manual.length === 0) {
    out.push('_(まだ無い — `npm run you-corpus append "…"` で足せる)_')
  } else {
    // Newest first: the proxy reads the most recent calls as the freshest signal.
    for (const m of [...manual].reverse()) {
      out.push(renderManual(m))
    }
  }
  out.push('')

  const text = out.join('\n')
  await atomicWriteText(youCorpusFile(), text, { mode: FILE_MODE })

  return {
    path: youCorpusFile(),
    assembledAt,
    sizeBytes: Buffer.byteLength(text, 'utf8'),
    memoryCount: docs.length,
    manualCount: manual.length,
    conceptIncluded,
    businessVisionIncluded,
  }
}

// The injectable text. Assembles first if the file does not exist yet, so a
// caller (the proxy launcher, the CLI `print`) always gets a current corpus.
export const readYouCorpus = async (opts: AssembleOptions = {}): Promise<string> => {
  await ensureOpenGroundHome()
  try {
    return await readFile(youCorpusFile(), 'utf8')
  } catch {
    await assembleYouCorpus(opts)
    return readFile(youCorpusFile(), 'utf8')
  }
}

// Status for the GET route / CLI `status`: does the file exist, how big, when
// assembled (mtime), and which sources are currently available.
export const getCorpusStatus = async (opts: AssembleOptions = {}): Promise<YouCorpusStatus> => {
  await ensureOpenGroundHome()
  // Same resolution as assembly, so the status reports the sources an assemble
  // would actually use (cwd-independent; see resolveDefaultSources).
  let memoryDir: string | null
  let conceptPath: string | null
  if (opts.memoryDir !== undefined && opts.conceptPath !== undefined) {
    memoryDir = opts.memoryDir
    conceptPath = opts.conceptPath
  } else {
    const resolved = await resolveDefaultSources(opts.cwd)
    memoryDir = opts.memoryDir !== undefined ? opts.memoryDir : resolved.memoryDir
    conceptPath = opts.conceptPath !== undefined ? opts.conceptPath : resolved.conceptPath
  }

  let exists = false
  let sizeBytes = 0
  let assembledAt: string | null = null
  try {
    const s = await stat(youCorpusFile())
    exists = true
    sizeBytes = s.size
    assembledAt = s.mtime.toISOString()
  } catch {
    /* not assembled yet */
  }

  const docs = await readMemoryDocs(memoryDir)
  // Honest "does the dir exist" — independent of whether it currently holds any
  // notes (an existing-but-empty dir is "exists: true, count: 0", not "missing").
  let memoryDirExists = false
  if (memoryDir) {
    try {
      memoryDirExists = (await stat(memoryDir)).isDirectory()
    } catch {
      memoryDirExists = false
    }
  }
  let conceptExists = false
  if (conceptPath) {
    try {
      await stat(conceptPath)
      conceptExists = true
    } catch {
      /* missing */
    }
  }
  const manual = await readManualJudgments()

  return {
    path: youCorpusFile(),
    exists,
    sizeBytes,
    assembledAt,
    manualCount: manual.length,
    memoryDir: memoryDir ?? null,
    memoryDirExists,
    memoryCount: docs.length,
    conceptPath: conceptPath ?? null,
    conceptExists,
    businessVisionExists: docs.some(isBusinessVision),
  }
}

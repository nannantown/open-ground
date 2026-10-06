// assistantMemory — the owner's assistant remembers on THIS Mac only (owner
// decision 2026-10-03, docs/PHONE_LINK.md "What the assistant remembers").
// Plain text files, no database:
//
//   ~/.openground/assistant/            0700
//     log/YYYY-MM-DD.jsonl              0600  every line said, one JSON per line (UTC day)
//     memory.md                         0600  the ONE long-term memo, kept under a fixed size
//     state.json                        0600  which log lines are already folded into the memo
//     config.json                       0600  how many days the log is kept, how long the memo may be
//     photos/YYYY-MM-DD-<id>.<ext>      0600  a photo the owner sent from the screen (deleted
//                                             with its log line, its day, or the whole log)
//
// The log is deleted day by day once older than `logDays`; what matters of it
// lives on in the memo, which the assistant rewrites (phoneAssistant.ts) when
// old lines leave its view or the owner says "remember" / "forget". Nothing
// here is ever logged to the console or kept on the relay.
import { appendFile, mkdir, readFile, readdir, rm, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { newId } from '@/lib/ids'
import type { PhoneCallRecord } from '@/lib/types'
import { atomicWriteJson, atomicWriteText } from './atomicWrite'
import { openGroundHome } from './paths'

export const ASSISTANT_LOG_DAYS = { default: 30, min: 1, max: 365 }
export const ASSISTANT_MEMORY_CHARS = { default: 4000, min: 500, max: 8000 }
/** What the owner calls the assistant, and its colour (the floating character
 *  on the Mac and on the iPhone — docs/ASSISTANT_DESIGN.md). */
export const ASSISTANT_NAME_MAX = 24
export const ASSISTANT_LOOKS = ['verm', 'moss', 'ochre', 'ink'] as const
export type AssistantLook = (typeof ASSISTANT_LOOKS)[number]
const DAY_MS = 86_400_000
const MODE = 0o600

export interface AssistantEntry extends Partial<PhoneCallRecord> {
  id: string
  at: number
  who: 'owner' | 'assistant'
  text: string
  /** Where the owner said it (both land in this one log). */
  via: 'phone' | 'screen'
  /** Stable phone say id, for reconciling an optimistic owner line by identity. */
  clientId?: string
  /** The card the assistant wrote in this answer. */
  card?: { projectId: string; taskId: string; title: string }
  /** A photo the owner sent with this line: its file name under photos/. */
  photo?: string
}
export interface AssistantConfig {
  logDays: number
  memoryChars: number
  /** '' = not named yet. */
  name: string
  look: AssistantLook
}

const dir = () => join(openGroundHome(), 'assistant')
const logDir = () => join(dir(), 'log')
const memoFile = () => join(dir(), 'memory.md')
const stateFile = () => join(dir(), 'state.json')
const configFile = () => join(dir(), 'config.json')
const photoDir = () => join(dir(), 'photos')
const ensureDir = async (d: string) => void (await mkdir(d, { recursive: true, mode: 0o700 }))
const readJson = async (f: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(f, 'utf8').catch(() => '{}')) ?? {}

// One writer at a time for the files (a delete must not race an append).
let chain: Promise<unknown> = Promise.resolve()
const locked = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = chain.then(fn, fn)
  chain = run.catch(() => {})
  return run
}

/** Bumped by every delete: a turn that started before it must not write back
 *  a memo built from what the owner has just erased. */
const g = globalThis as typeof globalThis & { __openground_assistant_epoch?: number }
export const assistantEpoch = (): number => g.__openground_assistant_epoch ?? 0
const bump = () => void (g.__openground_assistant_epoch = assistantEpoch() + 1)

// ── config ─────────────────────────────────────────────────────────────────

const inRange = (v: unknown, r: { min: number; max: number }): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= r.min && v <= r.max
// One line, no control characters (it goes into the prompt and the phone's title).
const cleanName = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const n = v
    .replace(/[\n\r\t\u2028\u2029]/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(n).length <= ASSISTANT_NAME_MAX ? n : null
}
const isLook = (v: unknown): v is AssistantLook => (ASSISTANT_LOOKS as readonly unknown[]).includes(v)

export const readAssistantConfig = async (): Promise<AssistantConfig> => {
  const c = await readJson(configFile()).catch(() => ({}) as Record<string, unknown>)
  return {
    logDays: inRange(c.logDays, ASSISTANT_LOG_DAYS) ? c.logDays : ASSISTANT_LOG_DAYS.default,
    memoryChars: inRange(c.memoryChars, ASSISTANT_MEMORY_CHARS) ? c.memoryChars : ASSISTANT_MEMORY_CHARS.default,
    name: cleanName(c.name) ?? '',
    look: isLook(c.look) ? c.look : 'verm',
  }
}

/** Change either number, the name or the look. A shorter log takes effect at once (old days go now),
 *  a shorter memo too (it is cut to the new size until the next rewrite). */
export const saveAssistantConfig = async (patch: unknown): Promise<AssistantConfig | { error: string }> => {
  const p = (patch ?? {}) as Record<string, unknown>
  if (p.logDays !== undefined && !inRange(p.logDays, ASSISTANT_LOG_DAYS))
    return { error: `logDays must be ${ASSISTANT_LOG_DAYS.min}-${ASSISTANT_LOG_DAYS.max}` }
  if (p.memoryChars !== undefined && !inRange(p.memoryChars, ASSISTANT_MEMORY_CHARS))
    return { error: `memoryChars must be ${ASSISTANT_MEMORY_CHARS.min}-${ASSISTANT_MEMORY_CHARS.max}` }
  const name = p.name === undefined ? undefined : cleanName(p.name)
  if (name === null) return { error: `name must be text of at most ${ASSISTANT_NAME_MAX} characters` }
  if (p.look !== undefined && !isLook(p.look)) return { error: `look must be one of ${ASSISTANT_LOOKS.join(', ')}` }
  // One locked step (read included, so two saves at once keep both changes): a
  // memo written or deleted meanwhile is neither lost nor brought back.
  const next = await locked(async () => {
    const next = await readAssistantConfig()
    if (p.logDays !== undefined) next.logDays = p.logDays as number
    if (p.memoryChars !== undefined) next.memoryChars = p.memoryChars as number
    if (name !== undefined) next.name = name
    if (p.look !== undefined) next.look = p.look as AssistantLook
    await ensureDir(dir())
    await atomicWriteJson(configFile(), next, { mode: MODE })
    const memo = await readAssistantMemory()
    if (charCount(memo) > next.memoryChars) await putMemo(memo, next.memoryChars)
    return next
  })
  await pruneAssistantLog(next.logDays)
  return next
}

// ── the log ────────────────────────────────────────────────────────────────

const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10)
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/
const dayFiles = async (): Promise<string[]> =>
  (await readdir(logDir()).catch(() => [] as string[])).filter((f) => DAY_FILE.test(f)).sort()
const parseLines = (raw: string): AssistantEntry[] =>
  raw.split('\n').flatMap((l) => {
    try {
      const e = JSON.parse(l) as AssistantEntry
      return typeof e?.id === 'string' && typeof e.at === 'number' && typeof e.text === 'string' ? [e] : []
    } catch {
      return []
    }
  })

// ── photos ─────────────────────────────────────────────────────────────────

/** What the screen may send: the formats Claude reads (JPEG, PNG, GIF, WebP —
 *  platform.claude.com/docs/en/build-with-claude/vision), at most 5 MB, well
 *  under the API's 10 MB (base64) per image. */
export const ASSISTANT_PHOTO_MAX_BYTES = 5 * 1024 * 1024
export type AssistantPhotoExt = 'png' | 'jpg' | 'gif' | 'webp'
export const ASSISTANT_PHOTO_TYPES: Record<AssistantPhotoExt, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
const PHOTO_FILE = /^(\d{4}-\d{2}-\d{2})-[A-Za-z0-9_-]{1,64}\.(png|jpg|gif|webp)$/

/** The format by the file's own bytes (never by what the sender claims); null = not one we take. */
export const sniffPhoto = (b: Uint8Array): AssistantPhotoExt | null => {
  const at = (o: number, ...xs: number[]) => xs.every((x, i) => b[o + i] === x)
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png'
  if (at(0, 0xff, 0xd8, 0xff)) return 'jpg'
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'gif'
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'webp'
  return null
}

/** Keeps one photo; returns its file name (the log line's `photo`). */
export const saveAssistantPhoto = async (bytes: Uint8Array, ext: AssistantPhotoExt, at = Date.now()): Promise<string> => {
  await ensureDir(photoDir())
  const name = `${dayOf(at)}-${newId()}.${ext}`
  await writeFile(join(photoDir(), name), bytes, { mode: MODE, flag: 'wx' })
  return name
}

/** A kept photo's path, or null for any name this module did not make. */
export const assistantPhotoPath = (name: string): string | null => (PHOTO_FILE.test(name) ? join(photoDir(), name) : null)

const rmPhoto = async (name: string | undefined) => {
  const p = name ? assistantPhotoPath(name) : null
  if (p) await rm(p, { force: true })
}

/** Days that ended more than `days` ago are deleted, file and all (what is
 *  read is cut to the exact time at once — readAssistantLog). */
export const pruneAssistantLog = (days?: number, now = Date.now()): Promise<number> =>
  locked(async () => {
    const keep = days ?? (await readAssistantConfig()).logDays
    const cutoff = now - keep * DAY_MS
    let removed = 0
    for (const f of await dayFiles()) {
      const dayEnd = Date.parse(f.slice(0, 10) + 'T00:00:00Z') + DAY_MS
      if (dayEnd <= cutoff) {
        await rm(join(logDir(), f), { force: true })
        removed++
      }
    }
    for (const f of await readdir(photoDir()).catch(() => [] as string[])) {
      const m = PHOTO_FILE.exec(f)
      if (m && Date.parse(m[1] + 'T00:00:00Z') + DAY_MS <= cutoff) await rm(join(photoDir(), f), { force: true })
    }
    return removed
  })

export const appendAssistantEntries = (entries: Omit<AssistantEntry, 'id'>[]): Promise<AssistantEntry[]> =>
  locked(async () => {
    await ensureDir(logDir())
    const out = entries.map((e) => ({ id: newId(), ...e }))
    for (const e of out) await appendFile(join(logDir(), `${dayOf(e.at)}.jsonl`), JSON.stringify(e) + '\n', { mode: MODE })
    return out
  })

/** Call receipts use the phone's stable id. Retrying one never appends twice,
 * including after a restart or after its replay-window entry expired. */
export const appendAssistantCall = (id: string, entry: Omit<AssistantEntry, 'id'> & PhoneCallRecord, compareTime = false): Promise<AssistantEntry> =>
  locked(async () => {
    const receiptId = `call:${id}`
    for (const file of await dayFiles()) {
      const found = parseLines(await readFile(join(logDir(), file), 'utf8')).find((e) => e.id === receiptId)
      if (found) {
        if (found.kind !== 'call' || found.projectId !== entry.projectId || found.seconds !== entry.seconds || compareTime && found.at !== entry.at)
          throw new Error('call receipt conflict')
        return found
      }
    }
    await ensureDir(logDir())
    const out = { id: receiptId, ...entry }
    await appendFile(join(logDir(), `${dayOf(out.at)}.jsonl`), JSON.stringify(out) + '\n', { mode: MODE })
    return out
  })

/** Scope shared history: absent legacy project ids mean assistant conversation. */
export const assistantEntriesFor = (entries: AssistantEntry[], projectId = 'assistant'): AssistantEntry[] =>
  entries.filter((e) => (e.projectId ?? 'assistant') === projectId)

/** Everything said within the kept days, oldest first. Old days are deleted first. */
export const readAssistantLog = async (now = Date.now()): Promise<AssistantEntry[]> => {
  const { logDays } = await readAssistantConfig()
  await pruneAssistantLog(logDays, now)
  const cutoff = now - logDays * DAY_MS
  const all: AssistantEntry[] = []
  for (const f of await dayFiles()) all.push(...parseLines(await readFile(join(logDir(), f), 'utf8').catch(() => '')))
  return all.filter((e) => e.at > cutoff).sort((a, b) => a.at - b.at)
}

/** One line out of the log. What the memo already took from it stays there. */
// Every delete bumps the epoch when it is ASKED, not when its turn at the lock
// comes: a line finishing meanwhile then sees it under the lock (writeAssistantMemory).
export const deleteAssistantEntry = (id: string, projectId?: string): Promise<boolean> => {
  bump()
  return locked(async () => {
    for (const f of await dayFiles()) {
      const path = join(logDir(), f)
      const entries = parseLines(await readFile(path, 'utf8').catch(() => ''))
      const rest = entries.filter((e) => e.id !== id || projectId !== undefined && (e.projectId ?? 'assistant') !== projectId)
      if (rest.length === entries.length) continue
      if (rest.length) await atomicWriteText(path, rest.map((e) => JSON.stringify(e) + '\n').join(''), { mode: MODE })
      else await rm(path, { force: true })
      for (const e of entries) if (!rest.includes(e)) await rmPhoto(e.photo)
      return true
    }
    return false
  })
}

export const clearAssistantLog = (projectId?: string): Promise<void> => {
  bump()
  return locked(async () => {
    // Photos only ever go to the assistant's own talk, never to a project's.
    if (projectId === undefined || projectId === 'assistant') await rm(photoDir(), { recursive: true, force: true })
    if (projectId === undefined) await rm(logDir(), { recursive: true, force: true })
    else for (const file of await dayFiles()) {
      const path = join(logDir(), file)
      const entries = parseLines(await readFile(path, 'utf8'))
      const keep = entries.filter((e) => (e.projectId ?? 'assistant') !== projectId)
      if (keep.length === entries.length) continue
      if (keep.length) await atomicWriteText(path, keep.map((e) => JSON.stringify(e) + '\n').join(''), { mode: MODE })
      else await rm(path, { force: true })
    }
    if (projectId === undefined || projectId === 'assistant') await rm(stateFile(), { force: true })
  })
}

// ── the memo ───────────────────────────────────────────────────────────────

/** Characters as the owner counts them (an emoji is one). */
export const charCount = (s: string): number => Array.from(s).length

/** At most `max` characters; cut at a line end when one is in the last half. */
export const clipMemo = (s: string, max: number): string => {
  const chars = Array.from(s.trim())
  if (chars.length <= max) return chars.join('')
  const cut = chars.slice(0, max).join('')
  const nl = cut.lastIndexOf('\n')
  return (nl >= cut.length / 2 ? cut.slice(0, nl) : cut).trimEnd()
}

export const readAssistantMemory = async (): Promise<string> => (await readFile(memoFile(), 'utf8').catch(() => '')).trim()

const putMemo = async (text: string, max: number): Promise<string> => {
  const memo = clipMemo(text, max)
  if (!memo) await unlink(memoFile()).catch(() => {})
  else {
    await ensureDir(dir())
    await atomicWriteText(memoFile(), memo + '\n', { mode: MODE })
  }
  return memo
}

/** Replace the memo; empty = no memo. Never longer than `max` nor than the size
 *  set NOW (a turn may have read an older, larger one minutes ago). A turn passes
 *  the epoch it started at: if the owner deleted anything since, nothing is
 *  written (null) — checked under the lock, so the delete wins whenever it came.
 *  `folded` = how far this memo took in the log, written in the same step. */
export const writeAssistantMemory = (text: string, max = Infinity, turn?: { epoch: number; folded?: Folded }): Promise<string | null> =>
  locked(async () => {
    if (turn && turn.epoch !== assistantEpoch()) return null
    const limit = Math.min(max, (await readAssistantConfig()).memoryChars)
    // A turn's memo over the size set NOW is not cut (its end — the newest
    // folded lines — would go while they are marked folded): nothing is written.
    if (turn && charCount(text.trim()) > limit) return null
    const memo = await putMemo(text, limit)
    if (turn?.folded) {
      await ensureDir(dir())
      await atomicWriteJson(stateFile(), { ...(await readJson(stateFile()).catch(() => ({}))), folded: turn.folded }, { mode: MODE })
    }
    return memo
  })

export const clearAssistantMemory = (): Promise<void> => {
  bump()
  return locked(async () => void (await unlink(memoFile()).catch(() => {})))
}

// ── what is already in the memo ────────────────────────────────────────────

/** The last log line folded into the memo (id first; its time if it is gone). */
export interface Folded {
  id: string
  at: number
}
export const readFolded = async (): Promise<Folded | null> => {
  const s = await readJson(stateFile()).catch(() => ({}) as Record<string, unknown>)
  const f = s.folded as Folded | undefined
  return typeof f?.id === 'string' && typeof f.at === 'number' ? f : null
}

/** The last fold-only run nobody was talking for: which line it started at,
 *  and when. Kept on disk so its retry gap outlives a restart. */
export interface IdleTried {
  head: string
  at: number
}
export const readIdleTried = async (): Promise<IdleTried | null> => {
  const t = (await readJson(stateFile()).catch(() => ({}) as Record<string, unknown>)).idleTried as IdleTried | undefined
  return typeof t?.head === 'string' && typeof t.at === 'number' ? t : null
}
export const writeIdleTried = (t: IdleTried): Promise<void> =>
  locked(async () => {
    await ensureDir(dir())
    await atomicWriteJson(stateFile(), { ...(await readJson(stateFile()).catch(() => ({}))), idleTried: t }, { mode: MODE })
  })

/** The lines not yet in the memo, oldest first. */
export const unfolded = (log: AssistantEntry[], f: Folded | null): AssistantEntry[] => {
  if (!f) return log
  const i = log.findIndex((e) => e.id === f.id)
  return i >= 0 ? log.slice(i + 1) : log.filter((e) => e.at > f.at)
}

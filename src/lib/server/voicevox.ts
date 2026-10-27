// The VOICEVOX voices for the call (owner 2026-10-27: the same voices as the
// iPhone — Nemo / 冥鳴ひまり, docs/ASSISTANT_DESIGN.md "Voice"). They are made on
// this Mac by og-listen (native/og-listen, `Vox`), which loads VOICEVOX core by
// path; this file only puts the files it needs in place. Nothing ships with the
// app: core, ONNX Runtime, the Open JTalk dictionary and one voice file each come
// on first use (a call, or picking the voice), pinned by SHA-256, into
// ~/.openground/voicevox/. A failed fetch leaves the voice missing — tried again
// on the next call or pick — and until it is there the call reads with the
// system voice, never silent (the iPhone's App/Voicevox.swift, the same files).
// Apple Silicon only (the brief); elsewhere the system voice reads.
import { createHash, randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { createWriteStream, existsSync } from 'fs'
import { mkdir, readdir, rename, rm } from 'fs/promises'
import { join } from 'path'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { promisify } from 'util'
import type { AssistantVoice } from './assistantMemory'
import { openGroundHome } from './paths'

export interface VoicevoxFile {
  /** Its name in the folder (what og-listen opens). */
  name: string
  url: string
  sha256: string
  /** An archive: the path inside it that becomes `name`. */
  inner?: string
}

// 【一次資料】 github.com/VOICEVOX/voicevox_core releases 0.17.0, VOICEVOX/onnxruntime-builder
// voicevox_onnxruntime-1.23.2 (the version core 0.17.0 recommends), voicevox_vvm 0.16.4 — GitHub digests.
export const VOICEVOX_FILES = {
  core: {
    name: 'libvoicevox_core.dylib',
    url: 'https://github.com/VOICEVOX/voicevox_core/releases/download/0.17.0/voicevox_core-osx-arm64-0.17.0.zip',
    sha256: '3769f7a7a503264cd9bf2f6f0f7222daf63549ab187f91c2177e78afd209f850',
    inner: 'voicevox_core-osx-arm64-0.17.0/lib/libvoicevox_core.dylib',
  },
  onnxruntime: {
    name: 'libvoicevox_onnxruntime.dylib',
    url: 'https://github.com/VOICEVOX/onnxruntime-builder/releases/download/voicevox_onnxruntime-1.23.2/voicevox_onnxruntime-osx-arm64-1.23.2.tgz',
    sha256: '010bdb42fefb4ca73429c0d8d3df2cb20a3b6ca0affebac3c05dc450b9fe338d',
    inner: 'voicevox_onnxruntime-osx-arm64-1.23.2/lib/libvoicevox_onnxruntime.1.23.2.dylib',
  },
  // The same pin as the iPhone app (App/Voicevox.swift).
  dictionary: {
    name: 'open_jtalk_dic_utf_8-1.11',
    url: 'https://github.com/r9y9/open_jtalk/releases/download/v1.11.1/open_jtalk_dic_utf_8-1.11.tar.gz',
    sha256: 'fe6ba0e43542cef98339abdffd903e062008ea170b04e7e2a35da805902f382a',
    inner: 'open_jtalk_dic_utf_8-1.11',
  },
  nemo: {
    name: 'n0.vvm',
    url: 'https://github.com/VOICEVOX/voicevox_vvm/releases/download/0.16.4/n0.vvm',
    sha256: 'e91e2e6ed5cfa6940ff55b61234ba89c631fce3d0146c23685552e7f5d2fe437',
  },
  himari: {
    name: '1.vvm',
    url: 'https://github.com/VOICEVOX/voicevox_vvm/releases/download/0.16.4/1.vvm',
    sha256: '8df20815be9a84a4b4723b9e778d2ef6a4df277e4872fe9efe29676a60e02774',
  },
} satisfies Record<string, VoicevoxFile>

/** Each voice's ノーマル style (the iPhone's: Nemo 女声1, 冥鳴ひまり). */
const STYLE = { nemo: 10005, himari: 14 } as const

/** How long a download may go without a byte. */
export const VOICEVOX_IDLE_MS = 60_000

export const voicevoxDir = () => join(openGroundHome(), 'voicevox')
export const voicevoxSupported = (): boolean => process.platform === 'darwin' && process.arch === 'arm64'

const needs = (v: AssistantVoice): VoicevoxFile[] =>
  v === 'system' ? [] : [VOICEVOX_FILES.core, VOICEVOX_FILES.onnxruntime, VOICEVOX_FILES.dictionary, VOICEVOX_FILES[v]]
const has = (f: VoicevoxFile) => existsSync(join(voicevoxDir(), f.name))

// Survives `tsx watch` reloads (CLAUDE.md): a download is never started twice.
const g = globalThis as typeof globalThis & { __openground_voicevox?: { getting: Map<string, Promise<boolean>>; chosen: AssistantVoice; boot: string; swept?: boolean } }
const st: NonNullable<typeof g.__openground_voicevox> = (g.__openground_voicevox ??= { getting: new Map(), chosen: 'nemo', boot: randomUUID() })

export type VoiceFilesState = 'ready' | 'getting' | 'missing'
export const voiceFilesState = (v: AssistantVoice): VoiceFilesState => {
  if (v === 'system') return 'ready'
  if (!voicevoxSupported()) return 'missing'
  const files = needs(v)
  if (files.every(has)) return 'ready'
  return files.some((f) => st.getting.has(f.name)) ? 'getting' : 'missing'
}

const run = promisify(execFile)

/** Downloads `f`, checks it, and puts it in place whole or not at all. true = there. */
export const fetchVoicevoxFile = (f: VoicevoxFile, get: typeof fetch = fetch, idleMs = VOICEVOX_IDLE_MS): Promise<boolean> => {
  if (has(f)) return Promise.resolve(true)
  const going = st.getting.get(f.name)
  if (going) return going
  const p = (async () => {
    const dir = voicevoxDir()
    // A server killed mid-download left its staging behind: gone once (this run's own are marked `boot`).
    if (!st.swept) {
      st.swept = true
      for (const n of await readdir(dir).catch(() => [] as string[]))
        if (n.startsWith('staging-') && !n.startsWith(`staging-${st.boot}-`)) await rm(join(dir, n), { recursive: true, force: true })
    }
    const staging = join(dir, `staging-${st.boot}-${randomUUID()}`)
    // A connection that stops sending is given up after VOICEVOX_IDLE_MS (not left "getting" for half an hour).
    const idle = new AbortController()
    let quiet: ReturnType<typeof setTimeout> | undefined
    const alive = () => {
      clearTimeout(quiet)
      quiet = setTimeout(() => idle.abort(new Error('stalled')), idleMs)
    }
    try {
      await mkdir(staging, { recursive: true, mode: 0o700 })
      alive()
      const res = await get(f.url, { signal: AbortSignal.any([idle.signal, AbortSignal.timeout(30 * 60_000)]) })
      alive()
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      const download = join(staging, 'download')
      const hash = createHash('sha256')
      const tee = new Transform({ transform: (chunk: Buffer, _e, done) => (alive(), hash.update(chunk), done(null, chunk)) })
      await pipeline(Readable.fromWeb(res.body as import('stream/web').ReadableStream), tee, createWriteStream(download), { signal: idle.signal })
      clearTimeout(quiet)
      if (hash.digest('hex') !== f.sha256) throw new Error('checksum')
      // Checked first: only the pinned archive is unpacked (bsdtar reads .zip and .tgz alike).
      if (f.inner) await run('/usr/bin/tar', ['-xf', download, '-C', staging])
      if (has(f)) return true // another fetch put it meanwhile
      await rename(join(staging, f.inner ?? 'download'), join(dir, f.name))
      return true
    } catch (e) {
      console.warn(`[voicevox] ${f.name}: ${e instanceof Error ? e.message : e}`)
      return false
    } finally {
      clearTimeout(quiet)
      st.getting.delete(f.name)
      await rm(staging, { recursive: true, force: true }).catch(() => {})
    }
  })()
  st.getting.set(f.name, p)
  return p
}

/** Fetches what `v` needs (one file at a time: the dictionary is shared). true = ready. */
export const fetchVoice = async (v: AssistantVoice, get: typeof fetch = fetch): Promise<boolean> => {
  if (!voicevoxSupported()) return v === 'system'
  for (const f of needs(v)) if (!(await fetchVoicevoxFile(f, get))) return false
  return true
}

/** The owner's pick, as the call last heard of it (set on a call's start and on a pick). */
export const noteVoiceChoice = (v: AssistantVoice): void => {
  st.chosen = v
  if (voiceFilesState(v) === 'missing') void fetchVoice(v)
}

/** What og-listen reads a Japanese line with: the chosen VOICEVOX voice when its files
 *  are in place, else null (the system voice). VOICEVOX speaks Japanese only. */
export const voicevoxLine = (): { model: string; style: number } | null => {
  const v = st.chosen
  if (v === 'system' || voiceFilesState(v) !== 'ready') return null
  return { model: VOICEVOX_FILES[v].name, style: STYLE[v] }
}

// Local voice dictation engine (Wispr Flow-style) backed by whisper.cpp.
//
// OPEN GROUND does NOT bundle whisper — the user installs `whisper-cli`
// themselves (Homebrew) and the ggml model files are downloaded on demand into
// ~/.openground/models/. Everything here is local: audio never leaves the
// machine. The optional claude-CLI cleanup pass (VoiceSettings.formatWithClaude)
// is wired by the route layer, not here — this module is pure STT.
//
// Contract types: VoiceSettings / VoiceStatus in src/lib/types.ts.

import { execFileSync, execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { accessSync, constants, createWriteStream, existsSync, statSync } from 'fs'
import { mkdir, rename, rm, unlink, writeFile } from 'fs/promises'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { ensureOpenGroundHome, openGroundHome } from './paths'
import type { Settings, VoiceSettings, VoiceStatus } from '../types'

const execFile = promisify(execFileCb)

type VoiceModel = NonNullable<VoiceSettings['model']>

// --- whisper binary resolution ----------------------------------------------

// Plain executable-file check. X_OK alone passes for directories, so pair it
// with an isFile stat — a directory named whisper-cli must not "resolve".
const isExecutableFile = (p: string): boolean => {
  try {
    accessSync(p, constants.X_OK)
    return statSync(p).isFile()
  } catch {
    return false
  }
}

// Locate the whisper-cli binary: the settings override wins, then PATH, then
// the usual Homebrew install locations (arm64 / intel). Returns null when none
// is found — callers surface that as a machine-readable 'whisper-binary-missing'
// so the UI can show install guidance instead of a raw spawn error.
export const resolveWhisperBinary = (override?: string | null): string | null => {
  if (override && isExecutableFile(override)) return override
  try {
    // Absolute `which` path + argv array — never a shell string, so an
    // override or env value can't inject into a shell.
    const found = execFileSync('/usr/bin/which', ['whisper-cli'], { encoding: 'utf8' }).trim()
    if (found && isExecutableFile(found)) return found
  } catch {
    // not on PATH — fall through to the fixed candidates
  }
  for (const candidate of ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli']) {
    if (isExecutableFile(candidate)) return candidate
  }
  return null
}

// --- model files --------------------------------------------------------------

// ggml model files live centrally under the OPEN GROUND home (NOT in any
// project), named exactly as whisper.cpp ships them so a user can also drop
// one in by hand.
export const voiceModelsDir = () => join(openGroundHome(), 'models')
export const voiceModelPath = (model: VoiceModel) =>
  join(voiceModelsDir(), `ggml-${model}.bin`)

// In-flight download record, kept on globalThis so it survives `tsx watch`
// server reloads in dev (same pattern as src/lib/server/terminal.ts). progress
// is 0..1; a failed download keeps its record (with `error`) so /status can
// report it until the next attempt resets it.
interface VoiceDownload {
  model: string
  progress: number
  error?: string
}

declare global {
  // eslint-disable-next-line no-var
  var __openground_voice_download: VoiceDownload | null | undefined
}

const MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

// Stream-download a ggml model into ~/.openground/models/. Atomic: written to
// a temp sibling first, renamed only on success — a half-downloaded model can
// never be mistaken for a real one. Double-starts are guarded (the in-flight
// record short-circuits); callers fire-and-forget and poll /api/voice/status.
export const downloadVoiceModel = (model: VoiceModel): Promise<void> => {
  const active = globalThis.__openground_voice_download
  if (active && !active.error && active.progress < 1) return Promise.resolve()
  const record: VoiceDownload = { model, progress: 0 }
  globalThis.__openground_voice_download = record
  return (async () => {
    await ensureOpenGroundHome()
    const dest = voiceModelPath(model)
    await mkdir(dirname(dest), { recursive: true })
    const tmp = `${dest}.part-${randomUUID()}`
    try {
      const res = await fetch(`${MODEL_BASE_URL}/ggml-${model}.bin`)
      if (!res.ok || !res.body) throw new Error(`model download failed: HTTP ${res.status}`)
      const total = Number(res.headers.get('content-length') || 0)
      let received = 0
      const body = Readable.fromWeb(res.body as import('stream/web').ReadableStream)
      body.on('data', (chunk: Buffer) => {
        received += chunk.length
        // Cap below 1 until the rename lands — 1 means "really done".
        if (total > 0) record.progress = Math.min(received / total, 0.99)
      })
      await pipeline(body, createWriteStream(tmp))
      await rename(tmp, dest)
      record.progress = 1
      globalThis.__openground_voice_download = null
    } catch (err) {
      record.error = err instanceof Error ? err.message : String(err)
      await rm(tmp, { force: true })
    }
  })()
}

// --- transcription -------------------------------------------------------------

// whisper-cli (with -nt, no timestamps) prefixes each transcript line with a
// space and pads with blank lines. Pure normaliser, exported for tests: trim
// every line, drop the empty ones.
export const cleanWhisperOutput = (s: string): string =>
  s
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')

// Whisper emits non-speech annotations as bracketed/parenthesized lines —
// [BLANK_AUDIO], (wind blowing), [Music], (拍手) … — which must never be
// pasted into a terminal as if the user said them. A line is dropped only
// when it is NOTHING BUT such an annotation; inline brackets inside real
// speech are content and stay. Pure, exported for tests.
export const stripNoiseAnnotations = (s: string): string =>
  s
    .split('\n')
    .filter((line) => !/^\s*(\[[^\]]*\]|\([^)]*\)|（[^）]*）)\s*$/.test(line))
    .join('\n')
    .trim()

// Run whisper-cli over a WAV buffer and return the cleaned transcript. The
// buffer round-trips through a tmp file because whisper-cli only reads files;
// always unlinked, even on failure. Throws machine-readable
// 'whisper-binary-missing' / 'model-missing' for the route layer's 422s.
export const transcribeWav = async (
  wavBuffer: Buffer,
  opts: { model: VoiceModel; language: 'auto' | 'ja' | 'en'; whisperPath?: string | null },
): Promise<string> => {
  const binary = resolveWhisperBinary(opts.whisperPath)
  if (!binary) throw new Error('whisper-binary-missing')
  const modelPath = voiceModelPath(opts.model)
  if (!existsSync(modelPath)) throw new Error('model-missing')
  const wavPath = join(tmpdir(), `openground-voice-${randomUUID()}.wav`)
  await writeFile(wavPath, wavBuffer)
  try {
    const { stdout } = await execFile(
      binary,
      ['-m', modelPath, '-f', wavPath, '-l', opts.language, '-np', '-nt'],
      { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
    )
    return stripNoiseAnnotations(cleanWhisperOutput(stdout))
  } finally {
    await unlink(wavPath).catch(() => {})
  }
}

// --- status ---------------------------------------------------------------------

// Assemble the GET /api/voice/status payload from persisted settings + the
// live download record. Defaults mirror VoiceSettings' documented ones.
// `modelOverride` lets the settings UI probe a model it has selected but not
// yet saved (the drawer's draft state).
export const getVoiceStatus = (settings: Settings, modelOverride?: VoiceModel): VoiceStatus => {
  const voice = settings.voice
  const model = modelOverride ?? voice?.model ?? 'small'
  return {
    binaryPath: resolveWhisperBinary(voice?.whisperPath),
    model,
    modelPresent: existsSync(voiceModelPath(model)),
    download: globalThis.__openground_voice_download ?? null,
  }
}

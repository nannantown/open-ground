// server/routes/voice.ts — Hono sub-router for the voice dictation feature.
// Declares FULL /api/voice/... paths (mounted with an empty prefix in app.ts).
// Handlers are THIN ADAPTERS over src/lib/server/voice.ts — no STT logic here.
//
// Binary-missing / model-missing are 422s with a machine-readable error code
// so the client can render install/download guidance instead of a raw failure.
//
// Method-chaining style (new Hono().get(...).post(...)) so hc<AppType> on the
// client recovers this group's route tree.

import { basename } from 'path'
import { Hono } from 'hono'
import { getSettings } from '@/lib/server/store'
import { validateProjectPath } from '@/lib/server/projectData'
import { downloadVoiceModel, getVoiceStatus, transcribeWav } from '@/lib/server/voice'
import { formatTranscript } from '@/lib/server/voiceFormat'
import type { VoiceSettings, VoiceStatus, VoiceTranscribeResponse } from '@/lib/types'

type VoiceModel = NonNullable<VoiceSettings['model']>
const isVoiceModel = (v: unknown): v is VoiceModel =>
  v === 'base' || v === 'small' || v === 'medium'

type SpokenLanguage = NonNullable<VoiceSettings['spokenLanguage']>
const isSpokenLanguage = (v: unknown): v is SpokenLanguage =>
  v === 'auto' || v === 'ja' || v === 'en'

export const voiceRoutes = new Hono()
  // --- GET /api/voice/status ------------------------------------------------
  // ?model= probes a model other than the persisted one — the settings drawer
  // checks its unsaved draft selection this way.
  .get('/api/voice/status', async (c) => {
    const settings = await getSettings()
    const queryModel = c.req.query('model')
    const body: VoiceStatus = getVoiceStatus(
      settings,
      isVoiceModel(queryModel) ? queryModel : undefined,
    )
    return c.json(body)
  })
  // --- POST /api/voice/model/download ----------------------------------------
  // Kicks off the (long) ggml download and returns the status snapshot
  // immediately — the client polls /api/voice/status for progress.
  .post('/api/voice/model/download', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const settings = await getSettings()
    const requested = (body as { model?: unknown }).model
    const model = isVoiceModel(requested) ? requested : (settings.voice?.model ?? 'small')
    // Fire-and-forget: downloadVoiceModel registers its progress record
    // synchronously, so the snapshot below already reflects the new download.
    void downloadVoiceModel(model)
    const status: VoiceStatus = getVoiceStatus(settings)
    return c.json(status)
  })
  // --- POST /api/voice/transcribe ---------------------------------------------
  // Raw WAV body in, transcript out. ?language= overrides the persisted
  // spokenLanguage for this one request. ?projectPath= (a REGISTERED project —
  // validateProjectPath, same boundary as every path-accepting route) opts the
  // request into the claude cleanup pass when settings.voice.formatWithClaude
  // is on: formatTranscript runs a one-off haiku PTY in that cwd and is
  // best-effort by contract — any failure falls back to the raw transcript,
  // so this route never 500s because of formatting.
  .post('/api/voice/transcribe', async (c) => {
    const settings = await getSettings()
    const voice = settings.voice
    const queryLang = c.req.query('language')
    const language = isSpokenLanguage(queryLang)
      ? queryLang
      : (voice?.spokenLanguage ?? 'auto')
    const projectPath = c.req.query('projectPath')
    const wav = Buffer.from(await c.req.arrayBuffer())
    try {
      const raw = await transcribeWav(wav, {
        model: voice?.model ?? 'small',
        language,
        whisperPath: voice?.whisperPath,
      })
      if (raw && voice?.formatWithClaude && projectPath && (await validateProjectPath(projectPath))) {
        const { text, formatted } = await formatTranscript(raw, {
          cwd: projectPath,
          language: settings.language ?? 'en',
          projectName: basename(projectPath),
        })
        const body: VoiceTranscribeResponse = { text, raw, formatted }
        return c.json(body)
      }
      const body: VoiceTranscribeResponse = { text: raw, raw, formatted: false }
      return c.json(body)
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      if (message === 'whisper-binary-missing' || message === 'model-missing') {
        return c.json({ error: message }, 422)
      }
      throw err
    }
  })

// Browser-side microphone recorder for voice dictation.
//
// getUserMedia → AudioContext + ScriptProcessorNode (4096-frame, mono): Float32
// chunks accumulate while recording, then stop() concatenates, downsamples to
// 16 kHz and encodes a PCM16 WAV (wav.ts) ready to POST to /api/voice/
// transcribe. ScriptProcessorNode is deprecated but deliberate: AudioWorklet
// needs its processor served as a separate file, which the Vite SPA doesn't
// ship — and a dictation-length capture is far below where the deprecated
// node's main-thread cost matters. Browser-only (no unit tests beyond type
// checking); the pure pieces live in wav.ts / keybinding.ts.

import { downsampleTo16k, encodeWavPcm16Mono } from './wav'

export class VoiceRecorder {
  private stream: MediaStream | null = null
  private ctx: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private processor: ScriptProcessorNode | null = null
  private chunks: Float32Array[] = []
  private active = false
  private startedAt = 0

  /** True between a successful start() and the matching stop()/cancel(). */
  get recording(): boolean {
    return this.active
  }

  /** Elapsed recording time in ms (0 when not recording). */
  get durationMs(): number {
    return this.active ? Date.now() - this.startedAt : 0
  }

  /** Ask for the mic and start accumulating Float32 chunks. Rejects if a
   *  recording is already in progress (multi-start guard). */
  async start(): Promise<void> {
    if (this.active) throw new Error('VoiceRecorder: already recording')
    this.active = true
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      // cancel()/stop() may have run while the permission prompt was up
      // (active flipped back to false). Without this check the stream below
      // would be assigned to a recorder nobody holds — the mic indicator
      // stays on until the page closes.
      if (!this.active) {
        for (const track of stream.getTracks()) track.stop()
        return
      }
      const ctx = new AudioContext()
      const source = ctx.createMediaStreamSource(stream)
      const processor = ctx.createScriptProcessor(4096, 1, 1)
      processor.onaudioprocess = (e) => {
        // getChannelData returns a live view into the processing buffer —
        // copy it, or every chunk ends up holding the same (last) audio.
        this.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)))
      }
      source.connect(processor)
      processor.connect(ctx.destination)
      this.stream = stream
      this.ctx = ctx
      this.source = source
      this.processor = processor
      this.chunks = []
      this.startedAt = Date.now()
    } catch (err) {
      this.active = false
      await this.teardown()
      throw err
    }
  }

  /** Stop recording and return the capture as a 16 kHz mono PCM16 WAV. */
  async stop(): Promise<ArrayBuffer> {
    if (!this.active) throw new Error('VoiceRecorder: not recording')
    const chunks = this.chunks
    const inputRate = this.ctx?.sampleRate ?? 16000
    this.active = false
    await this.teardown()
    const total = chunks.reduce((n, c) => n + c.length, 0)
    const merged = new Float32Array(total)
    let offset = 0
    for (const c of chunks) {
      merged.set(c, offset)
      offset += c.length
    }
    return encodeWavPcm16Mono(downsampleTo16k(merged, inputRate))
  }

  /** Abort the recording and discard everything captured so far. */
  async cancel(): Promise<void> {
    this.active = false
    await this.teardown()
  }

  /** Release every browser resource: disconnect the audio graph, stop all
   *  MediaStream tracks (turns the mic indicator off) and close the context. */
  private async teardown(): Promise<void> {
    this.processor?.disconnect()
    this.source?.disconnect()
    if (this.processor) this.processor.onaudioprocess = null
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    const ctx = this.ctx
    this.stream = null
    this.ctx = null
    this.source = null
    this.processor = null
    this.chunks = []
    if (ctx && ctx.state !== 'closed') await ctx.close()
  }
}

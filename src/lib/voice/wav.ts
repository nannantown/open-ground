// 16 kHz mono PCM16 WAV encoding for whisper.cpp.
//
// whisper-cli expects 16 kHz mono 16-bit PCM WAV; the browser records Float32
// at the device rate (typically 44.1/48 kHz), so the recorder downsamples and
// then encodes. Pure functions (no DOM / Web Audio) so they unit-test in
// isolation; `VoiceRecorder` (recorder.ts) is the only caller.

/** Linear-interpolation resample to 16 kHz. Always returns a fresh array —
 *  even when the input is already 16 kHz — so callers may mutate it freely. */
export function downsampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === 16000) return input.slice()
  if (input.length === 0) return new Float32Array(0)
  const outLen = Math.max(1, Math.round((input.length * 16000) / inputRate))
  const out = new Float32Array(outLen)
  const ratio = inputRate / 16000
  const last = input.length - 1
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio
    const i0 = Math.min(Math.floor(pos), last)
    const i1 = Math.min(i0 + 1, last)
    const frac = pos - i0
    out[i] = input[i0] * (1 - frac) + input[i1] * frac
  }
  return out
}

/** Encode Float32 samples ([-1, 1], clamped) as a mono PCM16 WAV file:
 *  44-byte RIFF header followed by little-endian Int16 samples. */
export function encodeWavPcm16Mono(samples: Float32Array, sampleRate = 16000): ArrayBuffer {
  const dataBytes = samples.length * 2
  const buf = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buf)
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true) // RIFF chunk size
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // audio format: PCM
  view.setUint16(22, 1, true) // channels: mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return buf
}

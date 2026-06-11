import { describe, it, expect } from 'vitest'
import { downsampleTo16k, encodeWavPcm16Mono } from './wav'

const ascii = (buf: ArrayBuffer, offset: number, len: number) =>
  Array.from(new Uint8Array(buf, offset, len), (b) => String.fromCharCode(b)).join('')

describe('encodeWavPcm16Mono', () => {
  it('writes the RIFF/WAVE/fmt/data magic at the right offsets', () => {
    const buf = encodeWavPcm16Mono(new Float32Array([0, 0.5, -0.5]))
    expect(ascii(buf, 0, 4)).toBe('RIFF')
    expect(ascii(buf, 8, 4)).toBe('WAVE')
    expect(ascii(buf, 12, 4)).toBe('fmt ')
    expect(ascii(buf, 36, 4)).toBe('data')
  })

  it('sizes: 44-byte header + 2 bytes per sample, chunk sizes consistent', () => {
    const buf = encodeWavPcm16Mono(new Float32Array(100))
    const view = new DataView(buf)
    expect(buf.byteLength).toBe(44 + 200)
    expect(view.getUint32(4, true)).toBe(36 + 200) // RIFF chunk size
    expect(view.getUint32(40, true)).toBe(200) // data chunk size
  })

  it('declares 16 kHz mono PCM16 in the fmt chunk', () => {
    const view = new DataView(encodeWavPcm16Mono(new Float32Array(8)))
    expect(view.getUint32(16, true)).toBe(16) // fmt chunk size
    expect(view.getUint16(20, true)).toBe(1) // PCM
    expect(view.getUint16(22, true)).toBe(1) // mono
    expect(view.getUint32(24, true)).toBe(16000) // sample rate
    expect(view.getUint32(28, true)).toBe(32000) // byte rate
    expect(view.getUint16(32, true)).toBe(2) // block align
    expect(view.getUint16(34, true)).toBe(16) // bits per sample
  })

  it('honors a custom sample rate', () => {
    const view = new DataView(encodeWavPcm16Mono(new Float32Array(4), 48000))
    expect(view.getUint32(24, true)).toBe(48000)
    expect(view.getUint32(28, true)).toBe(96000)
  })

  it('clamps out-of-range samples and maps ±1 to Int16 extremes', () => {
    const view = new DataView(
      encodeWavPcm16Mono(new Float32Array([2, -2, 1, -1, 0])),
    )
    expect(view.getInt16(44, true)).toBe(32767) // 2 clamps to +1
    expect(view.getInt16(46, true)).toBe(-32768) // -2 clamps to -1
    expect(view.getInt16(48, true)).toBe(32767)
    expect(view.getInt16(50, true)).toBe(-32768)
    expect(view.getInt16(52, true)).toBe(0)
  })

  it('handles empty input (header-only file)', () => {
    const buf = encodeWavPcm16Mono(new Float32Array(0))
    expect(buf.byteLength).toBe(44)
    expect(new DataView(buf).getUint32(40, true)).toBe(0)
  })
})

describe('downsampleTo16k', () => {
  it('48 kHz input shrinks to 1/3 length', () => {
    const out = downsampleTo16k(new Float32Array(4800), 48000)
    expect(out.length).toBe(1600)
  })

  it('44.1 kHz input shrinks proportionally', () => {
    const out = downsampleTo16k(new Float32Array(4410), 44100)
    expect(out.length).toBe(1600)
  })

  it('16 kHz input returns an equal COPY, not the same array', () => {
    const input = new Float32Array([0.1, 0.2, 0.3])
    const out = downsampleTo16k(input, 16000)
    expect(out).not.toBe(input)
    expect(Array.from(out)).toEqual(Array.from(input))
  })

  it('picks every Nth sample on integer ratios', () => {
    const out = downsampleTo16k(new Float32Array([0, 1, 2, 3]), 32000)
    expect(Array.from(out)).toEqual([0, 2])
  })

  it('linearly interpolates between neighbors on fractional positions', () => {
    // ratio 1.5: output[1] sits at input position 1.5 → midpoint of 3 and 6
    const out = downsampleTo16k(new Float32Array([0, 3, 6]), 24000)
    expect(out.length).toBe(2)
    expect(out[0]).toBe(0)
    expect(out[1]).toBeCloseTo(4.5)
  })

  it('empty input yields empty output', () => {
    expect(downsampleTo16k(new Float32Array(0), 48000).length).toBe(0)
  })
})

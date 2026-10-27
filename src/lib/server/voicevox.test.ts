// The VOICEVOX files the call's voice needs: a download is put in place only
// when it matches its pinned SHA-256 (else nothing is left behind and the call
// reads with the system voice), an archive gives up just the file asked for,
// and a file is never downloaded twice at once. No network: fetch is faked.
// HOME is tmpdir-isolated by setup-home.ts.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createHash } from 'crypto'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fetchVoicevoxFile, noteVoiceChoice, voiceFilesState, voicevoxDir, voicevoxLine, voicevoxSupported, VOICEVOX_FILES } from './voicevox'

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const serve = (b: Buffer) => vi.fn(async () => new Response(new Uint8Array(b))) as unknown as typeof fetch

beforeEach(() => rmSync(voicevoxDir(), { recursive: true, force: true }))

describe('fetching a VOICEVOX file', () => {
  it('puts a file that matches its SHA-256 in place', async () => {
    const body = Buffer.from('a voice')
    expect(await fetchVoicevoxFile({ name: 'x.vvm', url: 'https://example.test/x.vvm', sha256: sha(body) }, serve(body))).toBe(true)
    expect(readFileSync(join(voicevoxDir(), 'x.vvm'), 'utf8')).toBe('a voice')
  })

  it('a file that does not match is not kept, and nothing half-done is left', async () => {
    const f = { name: 'x.vvm', url: 'https://example.test/x.vvm', sha256: sha(Buffer.from('the real one')) }
    expect(await fetchVoicevoxFile(f, serve(Buffer.from('something else')))).toBe(false)
    expect(readdirSync(voicevoxDir())).toEqual([])
  })

  it('offline (fetch throws) = missing, not an error', async () => {
    const offline = vi.fn(async () => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch
    expect(await fetchVoicevoxFile({ name: 'x.vvm', url: 'https://example.test/x.vvm', sha256: '0' }, offline)).toBe(false)
    expect(existsSync(join(voicevoxDir(), 'x.vvm'))).toBe(false)
  })

  it('an archive gives up the one file asked for, under its own name', async () => {
    const src = mkdtempSync(join(tmpdir(), 'og-vv-tgz-'))
    try {
      mkdirSync(join(src, 'pkg', 'lib'), { recursive: true })
      writeFileSync(join(src, 'pkg', 'lib', 'libx.1.2.dylib'), 'the library')
      writeFileSync(join(src, 'pkg', 'README'), 'not wanted')
      execFileSync('tar', ['-czf', join(src, 'x.tgz'), '-C', src, 'pkg'])
      const tgz = readFileSync(join(src, 'x.tgz'))
      const f = { name: 'libx.dylib', url: 'https://example.test/x.tgz', sha256: sha(tgz), inner: 'pkg/lib/libx.1.2.dylib' }
      expect(await fetchVoicevoxFile(f, serve(tgz))).toBe(true)
      expect(readdirSync(voicevoxDir())).toEqual(['libx.dylib'])
      expect(readFileSync(join(voicevoxDir(), 'libx.dylib'), 'utf8')).toBe('the library')
    } finally {
      rmSync(src, { recursive: true, force: true })
    }
  })

  it('a connection that stops sending is given up (not left "getting"), and nothing is kept', async () => {
    let pulls = 0
    const stalled = vi.fn(async () => new Response(new ReadableStream({ pull: (c) => void (pulls++ === 0 && c.enqueue(new Uint8Array([1, 2, 3]))) }))) as unknown as typeof fetch
    const f = { name: 'x.vvm', url: 'https://example.test/x.vvm', sha256: '0' }
    expect(await fetchVoicevoxFile(f, stalled, 100)).toBe(false)
    expect(readdirSync(voicevoxDir())).toEqual([])
    // Asked again, it starts afresh (the stalled one no longer blocks it).
    const body = Buffer.from('a voice')
    expect(await fetchVoicevoxFile({ ...f, sha256: sha(body) }, serve(body), 100)).toBe(true)
  })

  it('two asks at once download it once', async () => {
    const body = Buffer.from('a voice')
    const get = serve(body)
    const f = { name: 'x.vvm', url: 'https://example.test/x.vvm', sha256: sha(body) }
    expect(await Promise.all([fetchVoicevoxFile(f, get), fetchVoicevoxFile(f, get)])).toEqual([true, true])
    expect(get).toHaveBeenCalledTimes(1)
  })
})

describe('which voice a call line is read with', () => {
  it('the system voice when picked', () => {
    noteVoiceChoice('system')
    expect(voicevoxLine()).toBeNull()
  })

  it.runIf(voicevoxSupported())('VOICEVOX only once all its files are there (else the system voice)', () => {
    const d = voicevoxDir()
    mkdirSync(join(d, VOICEVOX_FILES.dictionary.name), { recursive: true })
    for (const f of [VOICEVOX_FILES.core, VOICEVOX_FILES.onnxruntime]) writeFileSync(join(d, f.name), '')
    expect(voiceFilesState('nemo')).toBe('missing')
    writeFileSync(join(d, VOICEVOX_FILES.nemo.name), '')
    expect(voiceFilesState('nemo')).toBe('ready')
    noteVoiceChoice('nemo')
    expect(voicevoxLine()).toEqual({ model: 'n0.vvm', style: 10005 })
    // 冥鳴ひまり's file is not there: asked, it would read with the system voice.
    expect(voiceFilesState('himari')).toBe('missing')
    noteVoiceChoice('system')
  })
})

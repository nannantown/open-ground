// A photo sent to the assistant from the screen (owner request 2026-10-06):
// the route refuses what is not a photo we take or is too large, keeps the rest
// on this Mac, the model's run gets a copy inside its own confined dir (and the
// Read tool only then), the log line carries it, and every delete takes it too.
// Asserted on disk and on what the model run is handed. HOME is tmpdir-isolated.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { phoneLinkRoutes } from '../phoneLink'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { openGroundHome } from '@/lib/server/paths'
import { setLockdownCache } from '@/lib/server/lockdown'
import {
  ASSISTANT_PHOTO_MAX_BYTES,
  assistantPhotoPath,
  clearAssistantLog,
  deleteAssistantEntry,
  pruneAssistantLog,
  readAssistantLog,
  saveAssistantPhoto,
  sniffPhoto,
} from '@/lib/server/assistantMemory'
import { __resetAssistantMemory, assistantTools, type AssistantDeps } from '@/lib/server/phoneAssistant'

const real = vi.hoisted(() => ({ ask: null as null | ((t: string, d: AssistantDeps) => Promise<unknown>) }))
const seen = vi.hoisted(() => ({ calls: [] as { text: string; photo?: string }[] }))
vi.mock('@/lib/server/swarmGate', () => ({ isSwarmLocalOwnerUnlocked: async () => true }))
vi.mock('@/lib/server/roles', () => ({ getCustomTabRole: async () => null }))
vi.mock('@/lib/server/phoneAssistant', async (orig) => {
  const m = await orig<typeof import('@/lib/server/phoneAssistant')>()
  real.ask = m.askAssistant as never
  return {
    ...m,
    // The route's call is recorded, then answered by a stand-in model.
    askAssistant: (text: string, deps: AssistantDeps = {}) => {
      seen.calls.push({ text, photo: deps.photo })
      return m.askAssistant(text, { ...deps, run: async () => JSON.stringify({ reply: 'ok' }), digest: async () => ({ text: '(none)', projects: [] }) })
    },
  }
})
const app = new Hono().route('/', phoneLinkRoutes)

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const photos = () => readdir(join(openGroundHome(), 'assistant', 'photos')).catch(() => [] as string[])
const say = (body: object) => app.request('/api/phone-link/assistant/say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

beforeEach(async () => {
  __resetAssistantMemory()
  setLockdownCache(false)
  await clearAssistantLog()
  seen.calls = []
})

describe('what counts as a photo', () => {
  it('by its bytes: PNG, JPEG, GIF, WebP — not SVG, text or a renamed file', () => {
    expect(sniffPhoto(PNG)).toBe('png')
    expect(sniffPhoto(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg')
    expect(sniffPhoto(Buffer.from('GIF89a'))).toBe('gif')
    expect(sniffPhoto(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp')
    expect(sniffPhoto(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
    expect(sniffPhoto(Buffer.from('RIFF\0\0\0\0WAVEfmt '))).toBeNull()
  })
  it('only names this module made resolve to a path', () => {
    expect(assistantPhotoPath('2026-10-06-abc.png')).not.toBeNull()
    for (const n of ['../settings.json', '2026-10-06-abc.svg', 'x.png', '2026-10-06-a/b.png']) expect(assistantPhotoPath(n)).toBeNull()
  })
})

describe('the say route with a photo', () => {
  it('refuses a non-photo (415) and one too large (413), keeping nothing', async () => {
    const svg = await say({ text: '', photo: Buffer.from('<svg/>').toString('base64') })
    expect(svg.status).toBe(415)
    expect((await svg.json()).error).toBe('photo-type')
    const big = await say({ text: 'x', photo: Buffer.concat([PNG, Buffer.alloc(ASSISTANT_PHOTO_MAX_BYTES)]).toString('base64') })
    expect(big.status).toBe(413)
    expect((await big.json()).error).toBe('photo-too-large')
    expect(await photos()).toEqual([])
    expect(seen.calls).toEqual([])
  })

  it('a photo alone is taken: kept 0600, on the log line, servable — words alone still work as before', async () => {
    const r = await say({ text: '', photo: PNG.toString('base64') })
    expect(r.status).toBe(200)
    const [name] = await photos()
    expect(seen.calls).toEqual([{ text: '', photo: name }])
    const owner = (await readAssistantLog()).find((e) => e.who === 'owner')!
    expect(owner).toMatchObject({ text: '', photo: name, via: 'screen' })
    const got = await app.request(`/api/phone-link/assistant/photo/${name}`)
    expect(got.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await got.arrayBuffer())).toEqual(PNG)
    expect((await app.request('/api/phone-link/assistant/photo/..%2Fconfig.json')).status).toBe(404)

    const plain = await say({ text: 'やあ' })
    expect(plain.status).toBe(200)
    expect(seen.calls[1]).toEqual({ text: 'やあ', photo: undefined })
    expect((await say({ text: '' })).status).toBe(400)
  })
})

describe('the model run gets the photo', () => {
  it('a copy inside its own dir, named in the prompt, with Read allowed only then; later turns know a photo was sent', async () => {
    const name = await saveAssistantPhoto(PNG, 'png')
    const runs: { prompt: string; cwd: string; photo?: string; bytes?: Buffer }[] = []
    const run: AssistantDeps['run'] = async (prompt, _file, cwd, photo) => {
      runs.push({ prompt, cwd, photo, bytes: photo ? await readFile(photo) : undefined })
      return JSON.stringify({ reply: '赤い四角だね' })
    }
    const digest: AssistantDeps['digest'] = async () => ({ text: '(none)', projects: [] })
    await real.ask!('これ何?', { run, digest, via: 'screen', photo: name })
    expect(dirname(runs[0].photo!)).toBe(runs[0].cwd)
    expect(runs[0].bytes).toEqual(PNG)
    expect(runs[0].prompt).toContain(`sent a photo: ${runs[0].photo}`)
    expect(runs[0].prompt).toContain('Read nothing but the photo')
    expect(assistantTools(runs[0].photo)).toEqual(['Read', 'Write'])
    expect(assistantTools(undefined)).toEqual(['Write'])

    await real.ask!('ありがとう', { run, digest, via: 'screen' })
    expect(runs[1].photo).toBeUndefined()
    expect(runs[1].prompt).toContain('Owner: これ何? [sent a photo]')
    expect(runs[1].prompt).toContain('Do not read files')
  })
})

describe('a photo leaves with its line', () => {
  it('deleting the line, clearing the talk, or its day expiring deletes the file', async () => {
    await say({ text: 'a', photo: PNG.toString('base64') })
    const owner = (await readAssistantLog()).find((e) => e.who === 'owner')!
    expect(await photos()).toHaveLength(1)
    await deleteAssistantEntry(owner.id, 'assistant')
    expect(await photos()).toEqual([])

    await say({ text: 'b', photo: PNG.toString('base64') })
    await clearAssistantLog('assistant')
    expect(await photos()).toEqual([])

    const old = Date.now() - 40 * 86_400_000
    const kept = await saveAssistantPhoto(PNG, 'png', old)
    const fresh = await saveAssistantPhoto(PNG, 'png')
    await pruneAssistantLog(30)
    expect(await photos()).toEqual([fresh])
    expect(kept).not.toBe(fresh)
  })
})

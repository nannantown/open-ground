import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, realpath, writeFile, readdir, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from '../../app'
import { __resetMigrationCacheForTests } from '@/lib/server/registry'
import { projectDataDir } from '@/lib/server/projectDataPath'
import { TASK_ASSETS_SUBDIR } from '@/lib/server/taskAssets'

// Route-level contract for /api/project/task-asset (B022 — Board-card image
// attachments): base64-JSON upload with a 5MB cap and an image-only mime
// whitelist, content-hash ids (sha1.ext — the GET/DELETE traversal guard),
// binary serving with the right content-type. All bytes live centrally
// (~/.openground/projects/<uuid>/task-assets/) — the repo stays untouched.

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

// 1×1 transparent PNG.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const PNG_BYTES = Buffer.from(PNG_B64, 'base64')

let home: string
let scratch: string

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-asset-home-')))
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-asset-scratch-')))
  process.env.OPENGROUND_HOME = home
  __resetMigrationCacheForTests()
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
})

const makeRegisteredDir = async (name: string): Promise<string> => {
  const dir = join(scratch, name)
  await mkdir(dir)
  await writeFile(join(dir, 'README.md'), `# ${name}\n`)
  const res = await app.request('/api/projects/import', json({ path: dir }))
  expect(res.status).toBe(200)
  return dir
}

const upload = (path: string, over: Record<string, unknown> = {}) =>
  app.request(
    '/api/project/task-asset',
    json({ path, name: 'shot.png', mime: 'image/png', dataBase64: PNG_B64, ...over }),
  )

const assetUrl = (path: string, id: string) =>
  `/api/project/task-asset?path=${encodeURIComponent(path)}&id=${encodeURIComponent(id)}`

describe('POST /api/project/task-asset — upload', () => {
  it('stores the image under the CENTRAL task-assets dir and returns the content-hash id', async () => {
    const dir = await makeRegisteredDir('central')
    const res = await upload(dir)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: string; name: string; mime: string }
    expect(body.id).toMatch(/^[0-9a-f]{40}\.png$/)
    expect(body.name).toBe('shot.png')
    expect(body.mime).toBe('image/png')
    // Bytes live centrally (~/.openground/projects/<uuid>/task-assets/<id>),
    // and the repo stays free of OPEN GROUND files.
    const central = join(await projectDataDir(dir), TASK_ASSETS_SUBDIR)
    expect(await readdir(central)).toEqual([body.id])
    // The repo working tree stays free of OPEN GROUND files.
    await expect(stat(join(dir, '.openground'))).rejects.toThrow()
    // Content-addressed: re-uploading the same bytes returns the SAME id.
    const again = (await (await upload(dir)).json()) as { id: string }
    expect(again.id).toBe(body.id)
    expect(await readdir(central)).toEqual([body.id])
  })

  it('rejects a non-image mime with 400', async () => {
    const dir = await makeRegisteredDir('badmime')
    for (const mime of ['text/plain', 'application/pdf', 'image/svg+xml', '']) {
      const res = await upload(dir, { mime })
      expect(res.status).toBe(400)
    }
  })

  it('rejects an over-5MB image with 413 (encoded-length pre-check)', async () => {
    const dir = await makeRegisteredDir('toobig')
    const big = Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64')
    const res = await upload(dir, { dataBase64: big })
    expect(res.status).toBe(413)
  })

  it('rejects an unregistered path with 403, empty data with 400', async () => {
    expect((await upload('/etc')).status).toBe(403)
    const dir = await makeRegisteredDir('empty')
    expect((await upload(dir, { dataBase64: '' })).status).toBe(400)
  })
})

describe('GET /api/project/task-asset — serving + traversal guard', () => {
  it('serves the bytes with the right content-type', async () => {
    const dir = await makeRegisteredDir('serve')
    const { id } = (await (await upload(dir)).json()) as { id: string }
    const res = await app.request(assetUrl(dir, id))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG_BYTES)).toBe(true)
  })

  it('rejects every non-content-hash id with 400 — traversal cannot reach the fs', async () => {
    const dir = await makeRegisteredDir('traverse')
    for (const id of [
      '../../../etc/passwd',
      '..%2F..%2Fetc%2Fpasswd',
      'a'.repeat(40), // no extension
      `${'a'.repeat(40)}.sh`, // non-image extension
      `${'A'.repeat(40)}.png`, // uppercase hex rejected (ids are lowercase)
      `${'a'.repeat(39)}.png`, // wrong hash length
      'tasks.json',
      '',
    ]) {
      const res = await app.request(assetUrl(dir, id))
      expect(res.status, `id=${JSON.stringify(id)}`).toBe(400)
    }
  })

  it('valid-shaped but absent id → 404; unregistered path → 403', async () => {
    const dir = await makeRegisteredDir('absent')
    const ghost = `${'0'.repeat(40)}.png`
    expect((await app.request(assetUrl(dir, ghost))).status).toBe(404)
    expect((await app.request(assetUrl('/etc', ghost))).status).toBe(403)
  })
})

describe('DELETE /api/project/task-asset — reference-counted cleanup', () => {
  it('unlinks an unreferenced asset, keeps a referenced one', async () => {
    const dir = await makeRegisteredDir('cleanup')
    const { id } = (await (await upload(dir)).json()) as { id: string }
    const central = join(await projectDataDir(dir), TASK_ASSETS_SUBDIR)

    // Reference it from a card → DELETE must keep the bytes.
    const tasksRes = await app.request('/api/project/tasks', json({ path: dir, add: ['Bug'] }))
    const data = await tasksRes.json()
    const { readProjectData, writeProjectData } = await import('@/lib/server/projectData')
    const pd = await readProjectData(dir)
    pd.tasks = pd.tasks.map((t: any) =>
      t.id === data.tasks[0].id
        ? { ...t, attachments: [{ id, name: 'shot.png', mime: 'image/png' }] }
        : t,
    )
    await writeProjectData(dir, pd)

    const kept = await app.request(assetUrl(dir, id), { method: 'DELETE' })
    expect(await kept.json()).toEqual({ ok: true, deleted: false })
    expect(await readdir(central)).toEqual([id])

    // Drop the reference → DELETE reaps the bytes.
    const pd2 = await readProjectData(dir)
    pd2.tasks = pd2.tasks.map((t: any) => ({ ...t, attachments: undefined }))
    await writeProjectData(dir, pd2)
    const gone = await app.request(assetUrl(dir, id), { method: 'DELETE' })
    expect(await gone.json()).toEqual({ ok: true, deleted: true })
    expect(await readdir(central)).toEqual([])
  })

  it('taskId excludes that card\'s SAVED reference (debounced persist race)', async () => {
    const dir = await makeRegisteredDir('debounce')
    const { id } = (await (await upload(dir)).json()) as { id: string }
    const central = join(await projectDataDir(dir), TASK_ASSETS_SUBDIR)

    // Two cards; only "mine" references the asset ON DISK. The client just
    // removed it from "mine" but the drawer's persist is debounced — the stale
    // saved reference must not block the reap when taskId names the card.
    await app.request('/api/project/tasks', json({ path: dir, add: ['mine', 'other'] }))
    const { readProjectData, writeProjectData } = await import('@/lib/server/projectData')
    const pd = await readProjectData(dir)
    const mine = pd.tasks.find((t: any) => t.title === 'mine')!
    pd.tasks = pd.tasks.map((t: any) =>
      t.id === mine.id ? { ...t, attachments: [{ id, name: 'shot.png', mime: 'image/png' }] } : t,
    )
    await writeProjectData(dir, pd)

    const reaped = await app.request(
      `${assetUrl(dir, id)}&taskId=${encodeURIComponent(mine.id)}`,
      { method: 'DELETE' },
    )
    expect(await reaped.json()).toEqual({ ok: true, deleted: true })
    expect(await readdir(central)).toEqual([])

    // …but ANOTHER card's reference still protects the bytes.
    const { id: id2 } = (await (await upload(dir)).json()) as { id: string }
    const pd2 = await readProjectData(dir)
    pd2.tasks = pd2.tasks.map((t: any) =>
      t.title === 'other'
        ? { ...t, attachments: [{ id: id2, name: 'shot.png', mime: 'image/png' }] }
        : { ...t, attachments: undefined },
    )
    await writeProjectData(dir, pd2)
    const kept = await app.request(
      `${assetUrl(dir, id2)}&taskId=${encodeURIComponent(mine.id)}`,
      { method: 'DELETE' },
    )
    expect(await kept.json()).toEqual({ ok: true, deleted: false })
    expect(await readdir(central)).toEqual([id2])
  })
})

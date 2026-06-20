// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { uploadCanvasAsset } from './assetSync'

afterEach(() => vi.unstubAllGlobals())

describe('uploadCanvasAsset (u14b owner upload helper)', () => {
  it('POSTs to /api/collab/asset and returns the storageKey on ok', async () => {
    const fn = vi.fn(
      async (_url: string | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true, storageKey: 'p/c/a' }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fn as unknown as typeof fetch)
    const key = await uploadCanvasAsset('/proj', 'cv1', 'a1')
    expect(key).toBe('p/c/a')
    const [url, init] = fn.mock.calls[0]
    expect(String(url)).toContain('/api/collab/asset')
    expect(String(url)).toContain('path=' + encodeURIComponent('/proj'))
    expect(String(url)).toContain('canvasId=cv1')
    expect(String(url)).toContain('assetId=a1')
    expect(init?.method).toBe('POST')
  })

  it('returns null on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 403 })) as unknown as typeof fetch,
    )
    expect(await uploadCanvasAsset('/p', 'c', 'a')).toBeNull()
  })

  it('returns null when the body says ok:false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ ok: false, storageKey: '' }), { status: 200 }),
      ) as unknown as typeof fetch,
    )
    expect(await uploadCanvasAsset('/p', 'c', 'a')).toBeNull()
  })

  it('returns null on a network throw', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('net')
      }) as unknown as typeof fetch,
    )
    expect(await uploadCanvasAsset('/p', 'c', 'a')).toBeNull()
  })
})

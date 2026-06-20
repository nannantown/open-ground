// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import type { CanvasElement } from '@/lib/types'

// i18n mock: t returns the key so we can assert on the message identity.
vi.mock('@/i18n/I18nContext', () => ({
  useT: () => ({ t: (k: string) => k }),
}))

import { ImageView } from './ImageView'

const el = (over: Partial<CanvasElement>): CanvasElement =>
  ({ id: 'e1', type: 'image', x: 0, y: 0, width: 100, height: 80, ...over }) as CanvasElement

const noop = () => {}

afterEach(cleanup)

describe('ImageView — asset resolution (u14a placeholders + u14b shared storage)', () => {
  it('no assetId AND no storageKey → "not found" placeholder, no <img>', () => {
    const { container } = render(
      <ImageView element={el({})} selected={false} onPointerDown={noop} projectPath="/p" canvasId="c1" />,
    )
    expect(screen.getByText('canvasEl.image.notFound')).toBeTruthy()
    expect(container.querySelector('img')).toBeNull()
  })

  it('folder-less member (empty projectPath) → "not synced" placeholder, NO doomed request', () => {
    const { container } = render(
      <ImageView
        element={el({ assetId: 'a1' })}
        selected={false}
        onPointerDown={noop}
        projectPath=""
        canvasId="c1"
      />,
    )
    // Neutral "not synced" copy, and crucially no <img> is mounted (the asset
    // API would 400 on an empty path — we never fire that request).
    expect(screen.getByText('canvasEl.image.unavailable')).toBeTruthy()
    expect(container.querySelector('img')).toBeNull()
  })

  it('owner with a real path + assetId → renders the <img> against the asset API', () => {
    const { container } = render(
      <ImageView
        element={el({ assetId: 'a1' })}
        selected={false}
        onPointerDown={noop}
        projectPath="/home/me/proj"
        canvasId="c1"
      />,
    )
    const img = container.querySelector('img')
    expect(img).toBeTruthy()
    const src = img!.getAttribute('src') ?? ''
    expect(src).toContain('/api/canvas/asset')
    expect(src).toContain(`path=${encodeURIComponent('/home/me/proj')}`)
    expect(src).toContain('assetId=a1')
  })

  it('a broken asset load swaps the <img> for the "not found" placeholder', () => {
    const { container } = render(
      <ImageView
        element={el({ assetId: 'a1' })}
        selected={false}
        onPointerDown={noop}
        projectPath="/home/me/proj"
        canvasId="c1"
      />,
    )
    const img = container.querySelector('img')!
    fireEvent.error(img)
    expect(screen.getByText('canvasEl.image.notFound')).toBeTruthy()
    expect(container.querySelector('img')).toBeNull()
  })

  it('member (empty path) WITH storageKey → renders <img> against the collab proxy', () => {
    const { container } = render(
      <ImageView
        element={el({ assetId: 'a1', storageKey: 'pid-1/cv-2/a1' })}
        selected={false}
        onPointerDown={noop}
        projectPath=""
        canvasId="cv-2"
      />,
    )
    const img = container.querySelector('img')
    expect(img).toBeTruthy()
    const src = img!.getAttribute('src') ?? ''
    expect(src).toContain('/api/collab/asset')
    expect(src).toContain('collabProjectId=pid-1')
    expect(src).toContain('canvasId=cv-2')
    expect(src).toContain('assetId=a1')
  })

  it('owner WITH both local assetId and storageKey → prefers the fast local route', () => {
    const { container } = render(
      <ImageView
        element={el({ assetId: 'a1', storageKey: 'pid-1/cv-2/a1' })}
        selected={false}
        onPointerDown={noop}
        projectPath="/home/me/proj"
        canvasId="cv-2"
      />,
    )
    const src = container.querySelector('img')!.getAttribute('src') ?? ''
    expect(src).toContain('/api/canvas/asset')
    expect(src).not.toContain('/api/collab/asset')
  })
})

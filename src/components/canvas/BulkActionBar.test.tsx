// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, fireEvent } from '@testing-library/react'

// Bulk Remove/Delete must tear down the hosted custom-tab frames of every
// project it successfully lets go of (the panel-delete invariant: audio
// started from a released project must not keep playing hidden) — and must
// NOT touch the frames of a project whose call failed (still registered).

import { BulkActionBar } from './BulkActionBar'
import {
  __resetCustomFramesForTest,
  attachFrameAnchor,
  detachFrameAnchor,
  getCustomFramesSnapshot,
  setFrameSource,
} from '@/components/canvas/modules/CustomFrameHost'
import {
  __resetPlaybackForTest,
  getPlaybackSnapshot,
  reportPlayback,
} from '@/lib/playback/playbackStore'
import type { ProjectMeta } from '@/lib/types'

const MODULE_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const MODULE_B = 'bbbbbbbb-0000-4000-8000-00000000000b'

const meta = (name: string, path: string): ProjectMeta =>
  ({
    id: name,
    name,
    path,
    description: '',
    hasGit: false,
    missing: false,
    openTaskCount: 0,
    totalTaskCount: 0,
  }) as ProjectMeta

const PROJ_OK = meta('ok', '/tmp/proj-ok')
const PROJ_FAIL = meta('fail', '/tmp/proj-fail')

let anchors: HTMLDivElement[] = []
const makeAnchor = () => {
  const el = document.createElement('div')
  document.body.appendChild(el)
  anchors.push(el)
  return el
}

beforeEach(() => {
  __resetCustomFramesForTest()
  __resetPlaybackForTest()
})

afterEach(() => {
  anchors.forEach((a) => a.remove())
  anchors = []
  vi.unstubAllGlobals()
})

const playingMsg = { type: 'og-playback' as const, playing: true, title: 'T' }

// A hidden keep-alive frame playing audio, owned by `path`.
const seedHiddenPlayingFrame = (moduleId: string, path: string) => {
  attachFrameAnchor(moduleId, makeAnchor(), 'Tab', path)
  setFrameSource(moduleId, '<html>x</html>', 'Tab')
  reportPlayback(moduleId, playingMsg)
  detachFrameAnchor(moduleId)
}

describe('BulkActionBar frame teardown', () => {
  it('destroys frames of successfully released projects; keeps a failed one\'s', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { path?: string }
        return { ok: body.path === PROJ_OK.path, status: 500, json: async () => ({}) }
      }),
    )
    act(() => {
      seedHiddenPlayingFrame(MODULE_A, PROJ_OK.path)
      seedHiddenPlayingFrame(MODULE_B, PROJ_FAIL.path)
    })
    const { getByText } = render(
      <BulkActionBar
        projects={[PROJ_OK, PROJ_FAIL]}
        onClear={() => {}}
        onReload={() => {}}
      />,
    )
    fireEvent.click(getByText('Remove'))
    await act(async () => {
      fireEvent.click(getByText('Remove 2'))
    })
    // Released project's frame (and its audio) is gone…
    expect(getCustomFramesSnapshot().has(MODULE_A)).toBe(false)
    expect(getPlaybackSnapshot().has(MODULE_A)).toBe(false)
    // …the failed one is still registered, its frame untouched.
    expect(getCustomFramesSnapshot().has(MODULE_B)).toBe(true)
    expect(getPlaybackSnapshot().has(MODULE_B)).toBe(true)
  })

  it('bulk Delete routes through the same teardown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })),
    )
    act(() => {
      seedHiddenPlayingFrame(MODULE_A, PROJ_OK.path)
    })
    const { getByText } = render(
      <BulkActionBar
        projects={[PROJ_OK, PROJ_FAIL]}
        onClear={() => {}}
        onReload={() => {}}
      />,
    )
    fireEvent.click(getByText('Delete'))
    await act(async () => {
      fireEvent.click(getByText('Delete 2'))
    })
    expect(getCustomFramesSnapshot().has(MODULE_A)).toBe(false)
    expect(getPlaybackSnapshot().has(MODULE_A)).toBe(false)
  })
})

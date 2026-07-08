// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, fireEvent } from '@testing-library/react'

// Keep-alive contract for hosted custom-tab iframes: while a module's embedded
// app is PLAYING audio, its iframe must survive detach (tab/project switch)
// hidden — display:none, never unmounted — and a hidden frame that stops
// playing is destroyed after the grace period. A silent frame keeps the old
// lifecycle: detach destroys it immediately. Plus the message intake: only a
// sender inside one of OUR hosted iframes may drive the playback store.
// Guard rails on top: any open <Overlay> surface ([data-esc-overlay]) hides
// visible frames for its duration; hidden frames are listed in an always-on
// indicator with a stop button; and NO frame may live hidden past the hard
// cap, however fresh its heartbeats (forged playing:true buys nothing
// invisible or unbounded).

import {
  CustomFrameHost,
  HIDDEN_HARD_CAP_MS,
  KEEPALIVE_GRACE_MS,
  __resetCustomFramesForTest,
  attachFrameAnchor,
  destroyFrameIfProject,
  destroyFramesForProject,
  detachFrameAnchor,
  getCustomFramesSnapshot,
  setFrameSource,
  windowChainContains,
} from './CustomFrameHost'
import {
  __resetPlaybackForTest,
  getPlaybackSnapshot,
  reportPlayback,
} from '@/lib/playback/playbackStore'

const MODULE_ID = 'bbbbbbbb-0000-4000-8000-000000000002'
const PROJ = '/Users/someone/projects/nene'
const PROJ_B = '/Users/someone/projects/other'

// jsdom has no ResizeObserver; the host only needs observe/disconnect.
class ROStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let anchor: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ROStub)
  __resetCustomFramesForTest()
  __resetPlaybackForTest()
  anchor = document.createElement('div')
  document.body.appendChild(anchor)
})

afterEach(() => {
  anchor.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const playingMsg = (playing: boolean) => ({
  type: 'og-playback' as const,
  playing,
  title: 'Song A',
  projectName: 'NENE',
})

describe('CustomFrameHost keep-alive', () => {
  it('renders an anchored frame once its source lands', () => {
    const { container, unmount } = render(<CustomFrameHost />)
    act(() => {
      attachFrameAnchor(MODULE_ID, anchor, 'Songs', PROJ)
    })
    // No srcDoc yet → nothing rendered.
    expect(container.querySelector('iframe')).toBeNull()
    act(() => {
      setFrameSource(MODULE_ID, '<html>x</html>', 'Songs')
    })
    const iframe = container.querySelector('iframe')
    expect(iframe).not.toBeNull()
    expect(iframe!.getAttribute('sandbox')).toBe('allow-scripts')
    expect(iframe!.style.display).not.toBe('none')
    unmount()
  })

  it('destroys a SILENT frame on detach (the old lifecycle)', () => {
    const { container, unmount } = render(<CustomFrameHost />)
    act(() => {
      attachFrameAnchor(MODULE_ID, anchor, 'Songs', PROJ)
      setFrameSource(MODULE_ID, '<html>x</html>', 'Songs')
    })
    act(() => {
      detachFrameAnchor(MODULE_ID)
    })
    expect(getCustomFramesSnapshot().has(MODULE_ID)).toBe(false)
    expect(container.querySelector('iframe')).toBeNull()
    unmount()
  })

  it('keeps a PLAYING frame alive hidden across detach, and re-anchors it', () => {
    const { container, unmount } = render(<CustomFrameHost />)
    act(() => {
      attachFrameAnchor(MODULE_ID, anchor, 'Songs', PROJ)
      setFrameSource(MODULE_ID, '<html>x</html>', 'Songs')
      reportPlayback(MODULE_ID, playingMsg(true))
    })
    act(() => {
      detachFrameAnchor(MODULE_ID)
    })
    const hidden = container.querySelector('iframe')
    expect(hidden).not.toBeNull()
    expect(hidden!.style.display).toBe('none')
    // Tab reopened (possibly from another project): same frame, visible again.
    act(() => {
      attachFrameAnchor(MODULE_ID, anchor, 'Songs', PROJ)
    })
    const revived = container.querySelector('iframe')
    expect(revived).toBe(hidden) // same DOM node — the iframe never remounted
    expect(revived!.style.display).not.toBe('none')
    unmount()
  })

  it('destroys a hidden frame after the grace period once playback stops', () => {
    vi.useFakeTimers()
    const { unmount } = render(<CustomFrameHost />)
    act(() => {
      attachFrameAnchor(MODULE_ID, anchor, 'Songs', PROJ)
      setFrameSource(MODULE_ID, '<html>x</html>', 'Songs')
      reportPlayback(MODULE_ID, playingMsg(true))
      detachFrameAnchor(MODULE_ID)
    })
    expect(getCustomFramesSnapshot().has(MODULE_ID)).toBe(true)
    // Still playing → survives well past the grace period.
    act(() => {
      vi.advanceTimersByTime(KEEPALIVE_GRACE_MS + 60_000)
      reportPlayback(MODULE_ID, playingMsg(true)) // fresh beat vs the stale sweep
    })
    expect(getCustomFramesSnapshot().has(MODULE_ID)).toBe(true)
    // Stop → hidden AND silent for the grace period → destroyed.
    act(() => {
      reportPlayback(MODULE_ID, playingMsg(false))
    })
    act(() => {
      vi.advanceTimersByTime(KEEPALIVE_GRACE_MS + 1_000)
    })
    expect(getCustomFramesSnapshot().has(MODULE_ID)).toBe(false)
    unmount()
  })

  it('cancels the pending destroy when playback resumes within the grace period', () => {
    vi.useFakeTimers()
    const { unmount } = render(<CustomFrameHost />)
    act(() => {
      attachFrameAnchor(MODULE_ID, anchor, 'Songs', PROJ)
      setFrameSource(MODULE_ID, '<html>x</html>', 'Songs')
      reportPlayback(MODULE_ID, playingMsg(true))
      detachFrameAnchor(MODULE_ID)
    })
    act(() => {
      reportPlayback(MODULE_ID, playingMsg(false)) // pause — grace timer arms
    })
    act(() => {
      vi.advanceTimersByTime(KEEPALIVE_GRACE_MS - 1_000)
      reportPlayback(MODULE_ID, playingMsg(true)) // resume just in time
    })
    act(() => {
      vi.advanceTimersByTime(10_000) // old timer's would-be deadline passes
    })
    expect(getCustomFramesSnapshot().has(MODULE_ID)).toBe(true)
    unmount()
  })

  it('accepts og-playback messages only from a hosted frame\'s window chain', () => {
    const { container, unmount } = render(<CustomFrameHost />)
    act(() => {
      attachFrameAnchor(MODULE_ID, anchor, 'Songs', PROJ)
      setFrameSource(MODULE_ID, '<html>x</html>', 'Songs')
    })
    const iframe = container.querySelector('iframe')!
    // From inside our hosted iframe (jsdom gives srcDoc frames a real
    // contentWindow) → accepted.
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: playingMsg(true),
          source: iframe.contentWindow,
        }),
      )
    })
    expect(getPlaybackSnapshot().get(MODULE_ID)).toEqual({
      title: 'Song A',
      projectName: 'NENE',
    })
    // Same payload from an unrelated sender (source: null — e.g. another
    // surface's iframe) → ignored.
    act(() => {
      reportPlayback(MODULE_ID, playingMsg(false)) // reset
      window.dispatchEvent(
        new MessageEvent('message', { data: playingMsg(true), source: null }),
      )
    })
    expect(getPlaybackSnapshot().has(MODULE_ID)).toBe(false)
    unmount()
  })
})

describe('overlay coverage (MF1)', () => {
  it('hides a visible frame while any [data-esc-overlay] surface is open', async () => {
    const { container, unmount } = render(<CustomFrameHost />)
    act(() => {
      attachFrameAnchor(MODULE_ID, anchor, 'Songs', PROJ)
      setFrameSource(MODULE_ID, '<html>x</html>', 'Songs')
    })
    const iframe = container.querySelector('iframe')!
    expect(iframe.style.display).not.toBe('none')
    // A dialog opens somewhere (panel settings, picker, delete confirm… —
    // every <Overlay> marks its root). The frame must duck under it.
    const overlay = document.createElement('div')
    overlay.setAttribute('data-esc-overlay', '')
    await act(async () => {
      document.body.appendChild(overlay)
      await Promise.resolve() // MutationObserver fires on the microtask queue
    })
    expect(iframe.style.display).toBe('none')
    expect(getCustomFramesSnapshot().has(MODULE_ID)).toBe(true) // alive, just hidden
    await act(async () => {
      overlay.remove()
      await Promise.resolve()
    })
    expect(iframe.style.display).not.toBe('none')
    unmount()
  })
})

describe('hidden hard cap + background indicator (MF3)', () => {
  it('destroys a hidden frame at the hard cap even with fresh heartbeats', () => {
    vi.useFakeTimers()
    const { unmount } = render(<CustomFrameHost />)
    act(() => {
      attachFrameAnchor(MODULE_ID, anchor, 'Songs', PROJ)
      setFrameSource(MODULE_ID, '<html>x</html>', 'Songs')
      reportPlayback(MODULE_ID, playingMsg(true))
      detachFrameAnchor(MODULE_ID)
    })
    // A (possibly forged) heartbeat keeps arriving every 5s — the stale sweep
    // never fires, the frame stays "playing"… and the cap still ends it. The
    // frames-guard mirrors the real intake: once the frame is destroyed its
    // iframe (the only accepted sender) is gone, so no further report lands.
    act(() => {
      const iv = setInterval(() => {
        if (getCustomFramesSnapshot().has(MODULE_ID))
          reportPlayback(MODULE_ID, playingMsg(true))
      }, 5_000)
      vi.advanceTimersByTime(HIDDEN_HARD_CAP_MS + 10_000)
      clearInterval(iv)
    })
    expect(getCustomFramesSnapshot().has(MODULE_ID)).toBe(false)
    expect(getPlaybackSnapshot().has(MODULE_ID)).toBe(false)
    unmount()
  })

  it('lists hidden frames in the indicator; its stop button destroys the frame', () => {
    const { getByText, queryByText, getByRole, unmount } = render(<CustomFrameHost />)
    act(() => {
      attachFrameAnchor(MODULE_ID, anchor, 'Songs', PROJ)
      setFrameSource(MODULE_ID, '<html>x</html>', 'Songs')
      reportPlayback(MODULE_ID, playingMsg(true))
    })
    // Visible frame → no indicator.
    expect(queryByText('Songs')).toBeNull()
    act(() => {
      detachFrameAnchor(MODULE_ID)
    })
    // Hidden → indicator names the frame.
    expect(getByText('Songs')).toBeTruthy()
    fireEvent.click(getByRole('button', { name: 'Stop Songs' }))
    expect(getCustomFramesSnapshot().has(MODULE_ID)).toBe(false)
    expect(getPlaybackSnapshot().has(MODULE_ID)).toBe(false)
    expect(queryByText('Songs')).toBeNull()
    unmount()
  })
})

describe('per-frame grace window (independent of other frames)', () => {
  it("is NOT reset by another frame's playback changes", () => {
    vi.useFakeTimers()
    const OTHER_ID = 'cccccccc-0000-4000-8000-000000000003'
    const anchor2 = document.createElement('div')
    document.body.appendChild(anchor2)
    const { unmount } = render(<CustomFrameHost />)
    const otherMsg = (title: string) => ({
      type: 'og-playback' as const,
      playing: true,
      title,
      projectName: 'RADIO',
    })
    act(() => {
      // Frame A: hidden AND silent — its grace window starts now.
      attachFrameAnchor(MODULE_ID, anchor, 'Songs', PROJ)
      setFrameSource(MODULE_ID, '<html>x</html>', 'Songs')
      reportPlayback(MODULE_ID, playingMsg(true))
      detachFrameAnchor(MODULE_ID)
      reportPlayback(MODULE_ID, playingMsg(false))
      // Frame B: hidden and audibly playing.
      attachFrameAnchor(OTHER_ID, anchor2, 'Radio', PROJ)
      setFrameSource(OTHER_ID, '<html>y</html>', 'Radio')
      reportPlayback(OTHER_ID, otherMsg('X'))
      detachFrameAnchor(OTHER_ID)
    })
    // Keep B's heartbeat alive (identity-stable — no effect re-runs) and burn
    // most of A's grace.
    act(() => {
      const iv = setInterval(() => reportPlayback(OTHER_ID, otherMsg('X')), 5_000)
      vi.advanceTimersByTime(KEEPALIVE_GRACE_MS - 30_000)
      clearInterval(iv)
    })
    expect(getCustomFramesSnapshot().has(MODULE_ID)).toBe(true)
    // B changes track → playback snapshot changes → the GC effect re-runs.
    // A's grace start must survive that re-run…
    act(() => {
      reportPlayback(OTHER_ID, otherMsg('Y'))
    })
    // …so A dies at its ORIGINAL deadline, not a reset one.
    act(() => {
      const iv = setInterval(() => reportPlayback(OTHER_ID, otherMsg('Y')), 5_000)
      vi.advanceTimersByTime(40_000)
      clearInterval(iv)
    })
    expect(getCustomFramesSnapshot().has(MODULE_ID)).toBe(false)
    expect(getCustomFramesSnapshot().has(OTHER_ID)).toBe(true)
    anchor2.remove()
    unmount()
  })
})

describe('project-scoped teardown (MF2: remove / bulk / delete share one entry point)', () => {
  it('destroyFramesForProject kills only that project\'s frames (audio dead)', () => {
    const anchor2 = document.createElement('div')
    document.body.appendChild(anchor2)
    const OTHER_ID = 'cccccccc-0000-4000-8000-000000000003'
    const { container, unmount } = render(<CustomFrameHost />)
    act(() => {
      // Frame from project A, playing, then hidden (keep-alive).
      attachFrameAnchor(MODULE_ID, anchor, 'Songs', PROJ)
      setFrameSource(MODULE_ID, '<html>x</html>', 'Songs')
      reportPlayback(MODULE_ID, playingMsg(true))
      detachFrameAnchor(MODULE_ID)
      // Unrelated frame from project B.
      attachFrameAnchor(OTHER_ID, anchor2, 'Radio', PROJ_B)
      setFrameSource(OTHER_ID, '<html>y</html>', 'Radio')
    })
    expect(container.querySelectorAll('iframe').length).toBe(2)
    // Letting go of project A — remove-from-Ground / bulk / delete all route here.
    act(() => {
      destroyFramesForProject(PROJ)
    })
    expect(getCustomFramesSnapshot().has(MODULE_ID)).toBe(false)
    expect(getPlaybackSnapshot().has(MODULE_ID)).toBe(false)
    expect(container.querySelectorAll('iframe').length).toBe(1) // B untouched
    expect(getCustomFramesSnapshot().has(OTHER_ID)).toBe(true)
    anchor2.remove()
    unmount()
  })

  it('destroyFrameIfProject guards against killing another project\'s session', () => {
    const { unmount } = render(<CustomFrameHost />)
    act(() => {
      attachFrameAnchor(MODULE_ID, anchor, 'Songs', PROJ)
      setFrameSource(MODULE_ID, '<html>x</html>', 'Songs')
      reportPlayback(MODULE_ID, playingMsg(true))
      detachFrameAnchor(MODULE_ID)
    })
    // Detach intent from project B (same module attached there too) must NOT
    // kill A's live session…
    act(() => {
      destroyFrameIfProject(MODULE_ID, PROJ_B)
    })
    expect(getCustomFramesSnapshot().has(MODULE_ID)).toBe(true)
    // …while the owning project's detach does.
    act(() => {
      destroyFrameIfProject(MODULE_ID, PROJ)
    })
    expect(getCustomFramesSnapshot().has(MODULE_ID)).toBe(false)
    unmount()
  })

  it('re-attaching from a DIFFERENT project takes the frame over fresh (no cross-project session)', () => {
    const anchor2 = document.createElement('div')
    document.body.appendChild(anchor2)
    const { container, unmount } = render(<CustomFrameHost />)
    act(() => {
      attachFrameAnchor(MODULE_ID, anchor, 'Songs', PROJ)
      setFrameSource(MODULE_ID, '<html>x</html>', 'Songs')
      reportPlayback(MODULE_ID, playingMsg(true))
      detachFrameAnchor(MODULE_ID) // A's session keeps playing hidden
    })
    const oldIframe = container.querySelector('iframe')
    // The same module opened from project B: A's session (audio included) is
    // torn down, B starts clean — not A's audio under B's tab.
    act(() => {
      attachFrameAnchor(MODULE_ID, anchor2, 'Songs', PROJ_B)
    })
    expect(getPlaybackSnapshot().has(MODULE_ID)).toBe(false)
    const f = getCustomFramesSnapshot().get(MODULE_ID)!
    expect(f.projectPath).toBe(PROJ_B)
    expect(f.srcDoc).toBeNull() // fresh frame awaiting its own source
    act(() => {
      setFrameSource(MODULE_ID, '<html>x</html>', 'Songs')
    })
    const newIframe = container.querySelector('iframe')
    expect(newIframe).not.toBe(oldIframe) // A's iframe (its audio) is gone
    // Same-project re-attach keeps the frame (control case).
    act(() => {
      detachFrameAnchor(MODULE_ID)
    })
    expect(getCustomFramesSnapshot().has(MODULE_ID)).toBe(false) // silent → destroyed
    anchor2.remove()
    unmount()
  })
})

describe('windowChainContains', () => {
  it('walks parent chains and rejects foreign/cyclic ones', () => {
    const top = { parent: null } as unknown as Window
    ;(top as unknown as { parent: Window }).parent = top // top.parent === top
    const mid = { parent: top } as unknown as Window
    const leaf = { parent: mid } as unknown as Window
    expect(windowChainContains(leaf, mid)).toBe(true)
    expect(windowChainContains(leaf, top)).toBe(true)
    expect(windowChainContains(mid, leaf)).toBe(false)
    expect(windowChainContains(null, top)).toBe(false)
    expect(windowChainContains(leaf, null)).toBe(false)
    // A chain that never reaches the target terminates (self-parent top).
    const stranger = { parent: null } as unknown as Window
    ;(stranger as unknown as { parent: Window }).parent = stranger
    expect(windowChainContains(stranger, top)).toBe(false)
  })
})

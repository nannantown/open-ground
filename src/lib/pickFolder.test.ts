// @vitest-environment jsdom
//
// Asserts the central contract of src/lib/pickFolder.ts: in an Electron
// environment (the preload bridge is present) the picker goes through the
// cross-platform IPC dialog and NEVER touches the server; in a plain dev
// browser (no bridge) it falls back to the osascript server route. This is the
// fix for the Windows/Linux "Could not open the folder picker" bug — packaged
// builds must take the IPC path because osascript only exists on macOS.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Network-free api client. The fallback path calls api.api['pick-folder'].$post;
// hoisted so the mock factory can reference it.
const { post } = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('@/lib/api-client', () => ({
  api: { api: { 'pick-folder': { $post: post } } },
}))

import { pickFolder } from './pickFolder'

type Bridge = { showOpenDialog: ReturnType<typeof vi.fn> } | undefined
const setBridge = (bridge: Bridge) => {
  ;(window as unknown as { openground?: Bridge }).openground = bridge
}

describe('pickFolder', () => {
  beforeEach(() => {
    post.mockReset()
    // Default server reply for the fallback path.
    post.mockResolvedValue({ json: () => Promise.resolve({ path: '/srv/picked' }) })
  })
  afterEach(() => {
    delete (window as unknown as { openground?: unknown }).openground
  })

  describe('electron environment (IPC bridge present)', () => {
    it('uses the IPC dialog with openDirectory and NEVER hits the server', async () => {
      const showOpenDialog = vi
        .fn()
        .mockResolvedValue({ canceled: false, filePaths: ['/Users/me/proj'] })
      setBridge({ showOpenDialog })

      const r = await pickFolder()

      expect(showOpenDialog).toHaveBeenCalledWith({ properties: ['openDirectory'] })
      expect(post).not.toHaveBeenCalled() // crucial: no osascript route
      expect(r).toEqual({ path: '/Users/me/proj' })
    })

    it('passes a Windows path (drive letter + backslashes) straight through', async () => {
      setBridge({
        showOpenDialog: vi
          .fn()
          .mockResolvedValue({ canceled: false, filePaths: ['C:\\Users\\me\\proj'] }),
      })

      const r = await pickFolder()

      expect(r).toEqual({ path: 'C:\\Users\\me\\proj' })
      expect(post).not.toHaveBeenCalled()
    })

    it('maps Electron canceled:true → cancelled (single-l → double-l)', async () => {
      setBridge({
        showOpenDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }),
      })

      const r = await pickFolder()

      expect(r).toEqual({ cancelled: true })
      expect(post).not.toHaveBeenCalled()
    })

    it('treats an empty filePaths as cancelled even when canceled is false', async () => {
      setBridge({
        showOpenDialog: vi.fn().mockResolvedValue({ canceled: false, filePaths: [] }),
      })

      const r = await pickFolder()

      expect(r).toEqual({ cancelled: true })
    })
  })

  describe('non-electron environment (no bridge → server fallback)', () => {
    it('falls back to POST /api/pick-folder (osascript route)', async () => {
      setBridge(undefined)

      const r = await pickFolder()

      expect(post).toHaveBeenCalledTimes(1)
      expect(r).toEqual({ path: '/srv/picked' })
    })

    it('propagates the server cancelled result', async () => {
      setBridge(undefined)
      post.mockResolvedValue({ json: () => Promise.resolve({ cancelled: true }) })

      const r = await pickFolder()

      expect(r).toEqual({ cancelled: true })
    })

    it('propagates the server error result', async () => {
      setBridge(undefined)
      post.mockResolvedValue({
        json: () => Promise.resolve({ error: 'Could not open the folder picker.' }),
      })

      const r = await pickFolder()

      expect(r.error).toBe('Could not open the folder picker.')
    })

    it('returns an error (never throws) when the server route rejects', async () => {
      setBridge(undefined)
      post.mockRejectedValue(new Error('network down'))

      const r = await pickFolder()

      expect(r.error).toBe('Could not open the folder picker.')
    })
  })
})

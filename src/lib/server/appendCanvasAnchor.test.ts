import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { appendCanvasElement, writeCanvasFile, readCanvasFile } from './canvasData'
import type { CanvasElement, CanvasFile } from '../types'

// Comment-anchor integrity at the write boundary.
//
// The observer's CANVAS_ADD handler fires-and-forgets without reading the
// Canvas file, so it can't verify that a comment's `anchorId` names a real
// element. appendCanvasElement DOES read the file, so it's the last line of
// defense: an unresolvable anchorId must be dropped before it's persisted,
// while a valid one is kept. All I/O lands in a throwaway tmp project dir.

const CANVAS_ID = 'canvas-1'

const seed = async (projectPath: string, elements: CanvasElement[]) => {
  const now = new Date().toISOString()
  const file: CanvasFile = {
    id: CANVAS_ID,
    name: 'Test',
    viewport: { x: 0, y: 0, zoom: 1 },
    elements,
    chats: [],
    activeChatId: null,
    sidebarOpen: false,
    sidebarWidth: null,
    createdAt: now,
    updatedAt: now,
  }
  await writeCanvasFile(projectPath, file)
}

describe('appendCanvasElement comment-anchor integrity', () => {
  let projectPath: string

  beforeEach(async () => {
    projectPath = await mkdtemp(join(tmpdir(), 'og-canvas-anchor-'))
  })

  it('drops an anchorId that names no existing element', async () => {
    await seed(projectPath, [])
    const comment: CanvasElement = {
      id: 'c1',
      type: 'comment',
      x: 10,
      y: 10,
      text: 'fix this',
      anchorId: 'does-not-exist',
    }
    const after = await appendCanvasElement(projectPath, CANVAS_ID, comment)
    const stored = after!.elements.find((e) => e.id === 'c1')!
    expect(stored.anchorId).toBeUndefined()
    expect(stored.text).toBe('fix this') // rest of the comment survives

    // And it round-trips from disk without the dangling anchor.
    const reread = await readCanvasFile(projectPath, CANVAS_ID)
    expect(reread!.elements.find((e) => e.id === 'c1')!.anchorId).toBeUndefined()

    await rm(projectPath, { recursive: true, force: true })
  })

  it('keeps an anchorId that resolves to a real element', async () => {
    await seed(projectPath, [
      { id: 'mock1', type: 'mock', x: 0, y: 0, text: '<div/>' },
    ])
    const comment: CanvasElement = {
      id: 'c1',
      type: 'comment',
      x: 10,
      y: 10,
      text: 'fix this',
      anchorId: 'mock1',
    }
    const after = await appendCanvasElement(projectPath, CANVAS_ID, comment)
    expect(after!.elements.find((e) => e.id === 'c1')!.anchorId).toBe('mock1')

    await rm(projectPath, { recursive: true, force: true })
  })
})

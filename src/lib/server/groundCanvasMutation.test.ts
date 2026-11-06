import { beforeEach, describe, expect, it } from 'vitest'
import { rm, writeFile } from 'node:fs/promises'
import { getCanvas, mutateCanvas, removeCanvasProjectPosition, setCanvas } from './store'
import { canvasFile, ensureOpenGroundHome } from './paths'
import { createAutomationFrame } from '../automationFrame'

beforeEach(async () => {
  await ensureOpenGroundHome()
  await rm(canvasFile(), { force: true })
})

describe('Ground producers share one read/modify/write boundary', () => {
  it('a delayed owner save and a simultaneous unregister preserve the new policy and remove only the intended position', async () => {
    await setCanvas({ positions: { removed: { x: 10, y: 10 }, kept: { x: 300, y: 10 } }, viewport: { x: 0, y: 0, zoom: 1 }, elements: [] })
    let release!: () => void
    let entered!: () => void
    const ready = new Promise<void>((resolve) => { entered = resolve })
    const waiting = new Promise<void>((resolve) => { release = resolve })
    const save = mutateCanvas(async (current) => {
      entered()
      await waiting
      const next = createAutomationFrame(current, 'auto', '自動運用')
      next.automation!.revision = 1
      return next
    })
    await ready
    const cleanup = removeCanvasProjectPosition('removed')
    release()
    await Promise.all([save, cleanup])
    const current = await getCanvas()
    expect(current.automation).toMatchObject({ enabled: true, frameId: 'auto', revision: 2 })
    expect(current.elements.find((element) => element.id === 'auto')?.groundRole).toBe('automation')
    expect(current.positions).toEqual({ kept: { x: 300, y: 10 } })
  })

  it('a no-op cleanup does not advance the revision and an unreadable canvas is never replaced with defaults', async () => {
    const seeded = createAutomationFrame({ positions: {}, viewport: { x: 0, y: 0, zoom: 1 }, elements: [] }, 'auto', '自動運用')
    seeded.automation!.revision = 4
    await setCanvas(seeded)
    await removeCanvasProjectPosition('missing')
    expect((await getCanvas()).automation?.revision).toBe(4)
    await writeFile(canvasFile(), '{bad', 'utf8')
    await expect(removeCanvasProjectPosition('missing')).rejects.toMatchObject({ status: 503 })
    await expect(mutateCanvas(() => seeded)).rejects.toMatchObject({ status: 503 })
  })
})

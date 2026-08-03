import { describe, it, expect, vi } from 'vitest'
import { startGenerateJob, startTweakJob, getCanvasAiJobState } from './canvasAi'
import { narrowCanvasAiModel } from '../../../server/routes/canvasAi'
import { setSettings } from './store'

// Canvas AI model selection (owner request 2026-08-03「モデルも選べるように」).
// Pins the two seams a silent regression would hide in:
//   1. THREADING — the job layer must hand the picked model to the runner
//      (drop it anywhere along startJob→generate/tweak and every run silently
//      reverts to the hardcoded default; the UI select keeps working, lying).
//   2. NARROWING — the route boundary must refuse unknown aliases and
//      mask-disabled tiers (falling back to undefined = server default),
//      because `model` reaches the claude CLI argv.

const waitDone = async (id: string) => {
  for (let i = 0; i < 200; i++) {
    const s = getCanvasAiJobState(id)
    if (s && s.status !== 'running' && s.status !== 'queued') return s
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('job never settled')
}

describe('canvas AI model threading (job → runner)', () => {
  it('startGenerateJob hands args.model to the generator', async () => {
    const generate = vi.fn(async () => [])
    const persist = vi.fn(async () => [])
    const id = startGenerateJob(
      { projectPath: '/tmp/p1', canvasId: 'c1', prompt: 'x', model: 'opus' },
      { generate: generate as never, persist: persist as never },
    )
    await waitDone(id)
    expect(generate).toHaveBeenCalledWith('x', expect.objectContaining({ model: 'opus' }))
  })

  it('startTweakJob hands args.model to the tweaker', async () => {
    const tweak = vi.fn(async () => ({ source: 'ok' }))
    const persist = vi.fn(async () => undefined)
    const id = startTweakJob(
      {
        projectPath: '/tmp/p2',
        canvasId: 'c1',
        elementId: 'e1',
        req: {
          path: '/tmp/p2',
          source: 's',
          framework: 'html',
          instruction: 'i',
          element: {},
        } as never,
        model: 'haiku',
      },
      { tweak: tweak as never, persist: persist as never },
    )
    await waitDone(id)
    expect(tweak).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ model: 'haiku' }),
    )
  })
})

describe('narrowCanvasAiModel (route boundary)', () => {
  it('accepts a known tier', async () => {
    await setSettings({ swarmAllowedModels: undefined })
    expect(await narrowCanvasAiModel('opus')).toBe('opus')
    expect(await narrowCanvasAiModel('haiku')).toBe('haiku')
  })
  it('refuses unknown aliases and non-strings (server default wins)', async () => {
    expect(await narrowCanvasAiModel('gpt-5')).toBeUndefined()
    expect(await narrowCanvasAiModel('')).toBeUndefined()
    expect(await narrowCanvasAiModel(42)).toBeUndefined()
    expect(await narrowCanvasAiModel(undefined)).toBeUndefined()
  })
  it('refuses a mask-disabled tier — the 使用可能モデル switches govern this spawn path too', async () => {
    await setSettings({
      swarmAllowedModels: { fable: true, opus: false, sonnet: true, haiku: true },
    })
    try {
      expect(await narrowCanvasAiModel('opus')).toBeUndefined()
      expect(await narrowCanvasAiModel('sonnet')).toBe('sonnet')
    } finally {
      await setSettings({ swarmAllowedModels: undefined })
    }
  })
})

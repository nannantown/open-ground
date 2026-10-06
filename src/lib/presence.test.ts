// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDLE_MS, isPresent, watchPresence } from './presence'

// Looping motion runs only while someone is looking (2026-10-06: with nothing
// running, the assistant's breath and the working scan kept the renderer +
// GPU at ~50% around the clock). jsdom has no Web Animations, so the page's
// animations are stand-ins that record what was done to them — the observable
// result is each one's playState.

class FakeAnimation {
  playState: AnimationPlayState = 'running'
  /** Mid-cycle — e.g. a running dot at its faint half-beat. */
  currentTime: number | null = 675
  constructor(
    readonly iterations: number,
    readonly animationName = 'loop',
    readonly delay = 0,
  ) {}
  effect = {
    getComputedTiming: () => ({ iterations: this.iterations }),
    getTiming: () => ({ delay: this.delay }),
  }
  pause() {
    this.playState = 'paused'
  }
  play() {
    this.playState = 'running'
  }
}

let anims: FakeAnimation[] = []
let focused = true
let reduced = false
let onReduceChange: (() => void) | null = null
let stop: (() => void) | null = null

beforeEach(() => {
  vi.useFakeTimers()
  anims = [new FakeAnimation(Infinity, 'og-ast-breathe'), new FakeAnimation(Infinity, 'survey-scan'), new FakeAnimation(1, 'fade')]
  focused = true
  reduced = false
  ;(document as unknown as { getAnimations: () => FakeAnimation[] }).getAnimations = () => anims
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
  window.matchMedia = ((q: string) => ({
    matches: q.includes('reduced-motion') && reduced,
    addEventListener: (_t: string, fn: () => void) => (onReduceChange = fn),
    removeEventListener: () => (onReduceChange = null),
  })) as unknown as typeof window.matchMedia
  stop = watchPresence()
})

afterEach(() => {
  stop?.()
  stop = null
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const blur = () => {
  focused = false
  window.dispatchEvent(new Event('blur'))
}
const focus = () => {
  focused = true
  window.dispatchEvent(new Event('focus'))
}

describe('presence — looping motion only while someone is looking', () => {
  it('pauses every looping animation when the window loses focus, and resumes them on return', () => {
    expect(isPresent()).toBe(true)
    blur()
    expect(isPresent()).toBe(false)
    expect(anims.map((a) => a.playState)).toEqual(['paused', 'paused', 'running'])
    focus()
    expect(isPresent()).toBe(true)
    expect(anims.map((a) => a.playState)).toEqual(['running', 'running', 'running'])
  })

  it('leaves a finite animation (a dialog fading) to finish', () => {
    blur()
    expect(anims[2].playState).toBe('running')
  })

  it('goes away after IDLE_MS without input even while focused, and input brings it back', () => {
    vi.advanceTimersByTime(IDLE_MS - 1_000)
    expect(isPresent()).toBe(true)
    // Input part-way through restarts the clock.
    window.dispatchEvent(new Event('pointermove'))
    vi.advanceTimersByTime(IDLE_MS - 1_000)
    expect(isPresent()).toBe(true)
    vi.advanceTimersByTime(2_000)
    expect(isPresent()).toBe(false)
    expect(anims[0].playState).toBe('paused')
    window.dispatchEvent(new Event('keydown'))
    expect(isPresent()).toBe(true)
    expect(anims[0].playState).toBe('running')
  })

  it('does not resume an animation someone else paused', () => {
    anims[1].pause()
    blur()
    focus()
    expect(anims[1].playState).toBe('paused')
  })

  it('pauses a loop that starts while away', () => {
    blur()
    const el = document.createElement('div')
    const late = new FakeAnimation(Infinity, 'survey-pulse')
    ;(el as unknown as { getAnimations: () => FakeAnimation[] }).getAnimations = () => [late]
    document.body.appendChild(el)
    const ev = new Event('animationstart', { bubbles: true }) as AnimationEvent
    Object.defineProperty(ev, 'animationName', { value: 'survey-pulse' })
    el.dispatchEvent(ev)
    expect(late.playState).toBe('paused')
    el.remove()
  })

  it('input while the window is unfocused does not count as looking', () => {
    blur()
    window.dispatchEvent(new Event('pointermove'))
    expect(isPresent()).toBe(false)
  })
})

// Held still, the app must look EXACTLY as it does under "reduce motion"
// (rework M1, 2026-10-06): a pause() alone froze each loop at whatever frame it
// was on, so a running dot stopped at its faint half-beat about a third of the
// time and read as a faded idle seat — against the app's state colours.
describe('presence — the still look is the reduce-motion look', () => {
  const motion = () => document.documentElement.dataset.motion

  // MUTATION that turns this red: stop setting data-motion in applyMotion.
  it('marks the page still while away, the same mark reduce-motion sets', () => {
    expect(motion()).toBeUndefined()
    blur()
    expect(motion()).toBe('still')
    focus()
    expect(motion()).toBeUndefined()
    reduced = true
    onReduceChange?.()
    expect(motion()).toBe('still')
    reduced = false
    onReduceChange?.()
    expect(motion()).toBeUndefined()
  })

  it('keeps the still mark after return when the OS asks for reduced motion', () => {
    reduced = true
    onReduceChange?.()
    blur()
    focus()
    expect(motion()).toBe('still')
  })

  // MUTATION that turns this red: drop the currentTime rewind in pauseLoops.
  it('pauses a loop CSS does not cover at its first frame, not mid-cycle', () => {
    const negative = new FakeAnimation(Infinity, 'eq-like', -550)
    const positive = new FakeAnimation(Infinity, 'delayed', 240)
    anims.push(negative, positive)
    blur()
    expect(anims[0].currentTime).toBe(0)
    expect(negative.currentTime).toBe(550)
    expect(positive.currentTime).toBe(0)
    expect(anims[2].currentTime).toBe(675) // finite: untouched
  })

  it('resumes, on return, a loop that started while away', () => {
    blur()
    const el = document.createElement('div')
    const late = new FakeAnimation(Infinity, 'spin')
    ;(el as unknown as { getAnimations: () => FakeAnimation[] }).getAnimations = () => [late]
    document.body.appendChild(el)
    anims.push(late)
    const ev = new Event('animationstart', { bubbles: true }) as AnimationEvent
    Object.defineProperty(ev, 'animationName', { value: 'spin' })
    el.dispatchEvent(ev)
    expect(late.playState).toBe('paused')
    expect(late.currentTime).toBe(0)
    focus()
    expect(late.playState).toBe('running')
    el.remove()
  })
})

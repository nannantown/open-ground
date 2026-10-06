// presence.ts — is anyone looking at the window? Looping motion runs only then.
//
// WHY (measured 2026-10-06): every looping animation — the assistant's breath,
// the working card's scan, a seat sprite's rAF loop — makes the renderer and
// the GPU draw a new frame on EVERY display refresh, forever. With the app
// open and nothing running, the floating assistant alone kept the renderer at
// ~12% and the GPU at ~10% (the SVG transforms run on the main thread: ~120
// style+layout passes a second); a working card's scan added ~25% GPU. With
// every loop held still both read 0%. The owner saw OPEN GROUND sitting near
// the top of Activity Monitor while they were looking at Activity Monitor.
//
// So: the owner is PRESENT while the window is visible AND focused AND has had
// input in the last IDLE_MS. While away the app holds still exactly the way it
// does under the OS "reduce motion" setting — both set `html[data-motion=
// 'still']`, and globals.css draws ONE still look for it (each status loop at
// its full resting look; never frozen mid-fade, where a running dot would read
// as a faded idle seat). Any other infinite loop (Tailwind's `animate-*`, an
// inline keyframe) is paused at its first frame — the look it has with no
// animation at all — and canvas loops read `usePresent()` and hold still.
// Finite animations (a dialog's fade) are left to finish. Nothing about state
// is lost: the colours still say working / asking / done.

import { useSyncExternalStore } from 'react'

/** No pointer / key / wheel input for this long ⇒ away, even when focused. */
export const IDLE_MS = 120_000

const REDUCE_MOTION = '(prefers-reduced-motion: reduce)'

let present = true
let lastInput = Date.now()
const listeners = new Set<() => void>()
/** The animations WE paused — resumed on return. Never ones paused by others.
 *  Weak: a window left visible but unfocused for hours keeps mounting and
 *  unmounting loops, and an unmounted one must not keep its DOM alive here.
 *  NOTE: once paused/played through this API, a CSSAnimation stops following
 *  CSS `animation-play-state` — do not build a CSS pause (e.g. on hover) on it. */
let pausedByUs = new WeakSet<Animation>()

const reduceMotion = (): boolean =>
  typeof window.matchMedia === 'function' && window.matchMedia(REDUCE_MOTION).matches

/** `still` while nobody is looking or the OS asks for reduced motion. */
const applyMotion = (): void => {
  const root = document.documentElement
  if (!present || reduceMotion()) root.dataset.motion = 'still'
  else delete root.dataset.motion
}

const isLooping = (a: Animation): boolean =>
  a.effect?.getComputedTiming().iterations === Infinity

/** Pause a loop at its first frame (after a positive delay: the not-yet-
 *  started look; after a negative one: the frame the delay skipped to 0). */
const pauseLoops = (anims: Animation[]): void => {
  for (const a of anims) {
    if (a.playState === 'running' && isLooping(a)) {
      a.pause()
      a.currentTime = Math.max(0, -Number(a.effect?.getTiming().delay ?? 0))
      pausedByUs.add(a)
    }
  }
}

const setPresent = (next: boolean): void => {
  if (next === present) return
  present = next
  // The attribute first: the loops globals.css covers are then removed by CSS
  // itself, and getAnimations() (which flushes style) returns only the rest.
  applyMotion()
  if (!next) {
    pauseLoops(document.getAnimations())
  } else {
    // Only what is still on the page: an element removed while away took its
    // animation with it.
    for (const a of document.getAnimations()) {
      if (a.playState === 'paused' && pausedByUs.has(a)) a.play()
    }
    pausedByUs = new WeakSet()
  }
  listeners.forEach((fn) => fn())
}

export const isPresent = (): boolean => present

const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** true while someone is looking — for loops CSS cannot pause (canvas rAF). */
export const usePresent = (): boolean => useSyncExternalStore(subscribe, isPresent, () => true)

/** Start watching. Call once at boot; returns a stop function (tests). */
export const watchPresence = (): (() => void) => {
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const looking = () => document.visibilityState === 'visible' && document.hasFocus()

  // One timer, re-armed only when it fires early — input itself just stamps.
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimer = null
      const left = IDLE_MS - (Date.now() - lastInput)
      if (left > 0) armIdle()
      else setPresent(false)
    }, Math.max(0, IDLE_MS - (Date.now() - lastInput)))
  }
  const onInput = () => {
    lastInput = Date.now()
    if (!present && looking()) {
      setPresent(true)
      armIdle()
    }
  }
  const onFocusChange = () => {
    if (looking()) {
      lastInput = Date.now() // coming back counts as input
      setPresent(true)
      armIdle()
    } else {
      setPresent(false)
    }
  }
  // A loop that starts while away (a card turns 'working', a panel mounts) is
  // paused as it starts. `animationstart` fires after any delay, during which
  // nothing is drawn anyway.
  const onAnimationStart = (e: AnimationEvent) => {
    if (present || !(e.target instanceof Element)) return
    pauseLoops(e.target.getAnimations().filter((a) => (a as CSSAnimation).animationName === e.animationName))
  }

  const mq = typeof window.matchMedia === 'function' ? window.matchMedia(REDUCE_MOTION) : null
  const inputs = ['pointermove', 'pointerdown', 'keydown', 'wheel'] as const
  for (const t of inputs) window.addEventListener(t, onInput, { passive: true, capture: true })
  window.addEventListener('focus', onFocusChange)
  window.addEventListener('blur', onFocusChange)
  document.addEventListener('visibilitychange', onFocusChange)
  document.addEventListener('animationstart', onAnimationStart, true)
  mq?.addEventListener('change', applyMotion)
  applyMotion()
  onFocusChange()

  return () => {
    if (idleTimer) clearTimeout(idleTimer)
    for (const t of inputs) window.removeEventListener(t, onInput, { capture: true })
    window.removeEventListener('focus', onFocusChange)
    window.removeEventListener('blur', onFocusChange)
    document.removeEventListener('visibilitychange', onFocusChange)
    document.removeEventListener('animationstart', onAnimationStart, true)
    mq?.removeEventListener('change', applyMotion)
    setPresent(true)
    delete document.documentElement.dataset.motion
  }
}

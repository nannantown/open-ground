// src/lib/anchoredPopover.ts — where a popover anchored UNDER a trigger button
// sits, in client coordinates, and how tall it may be.
//
// ⚠ THE BUG THIS EXISTS FOR (owner, 2026-09-13). Inside a project, the usage
// popover ("残りのトークン数") was cut off: it opened as `absolute … z-30`
// INSIDE the project panel's own stacking context, and the Board's supply dock
// (BoardSupplyDock, also z-30, later in the DOM) therefore painted straight over
// it. Anything the popover had to say below the dock's top edge was simply not
// there — the owner could see a gauge and nothing else.
//
// Two separate things make a popover in that position readable, and the old code
// had neither:
//   1. it must LEAVE the panel's stacking context — a body portal at
//      z-overlay-modal (the project panel is one stacking context, so no z
//      inside it can beat a sibling drawn later; tailwind.config.ts documents
//      the scale), and
//   2. it must fit the VIEWPORT — right-aligned to the trigger but never off
//      an edge, and capped in height so a long body (the 7-day breakdown) ends
//      in a scroll rather than off the bottom of the screen.
//
// This module is (2), as a pure function: geometry is exactly the part that is
// wrong in ways a render test cannot see, and it needs no DOM to check.

/** Just the trigger-rect fields the placement reads (a DOMRect satisfies it). */
export interface PopoverAnchor {
  /** Client x of the trigger's right edge — the popover is right-aligned to it. */
  right: number
  /** Client y of the trigger's bottom edge — the popover opens below it. */
  bottom: number
}

export interface PopoverViewport {
  width: number
  height: number
}

export interface PopoverBox {
  /** CSS `right` offset (from the viewport's right edge), for a `fixed` element. */
  right: number
  /** CSS `top`. */
  top: number
  /** CSS `max-height`; pair it with overflow-y-auto. */
  maxHeight: number
}

/** Breathing room between the trigger and the popover. */
export const POPOVER_GAP = 6
/** Smallest gap kept to any viewport edge. */
export const POPOVER_MARGIN = 8
/** A popover shorter than this is useless, so on a very short viewport we
 *  deliberately keep this height and let it overflow rather than collapse to a
 *  sliver. The scroll container inside keeps every row reachable either way. */
export const POPOVER_MIN_HEIGHT = 160

/**
 * Place a popover under its trigger, clamped to the viewport.
 *
 * @param anchor the trigger's client rect
 * @param viewport window inner size
 * @param opts `width` (the popover's fixed width) enables the left-edge clamp —
 *        without it a trigger near the left edge would push the popover off
 *        screen; `gap` / `margin` / `minHeight` override the constants above.
 */
export const anchoredPopoverBox = (
  anchor: PopoverAnchor,
  viewport: PopoverViewport,
  opts?: { width?: number; gap?: number; margin?: number; minHeight?: number },
): PopoverBox => {
  const gap = opts?.gap ?? POPOVER_GAP
  const margin = opts?.margin ?? POPOVER_MARGIN
  const minHeight = opts?.minHeight ?? POPOVER_MIN_HEIGHT
  const top = anchor.bottom + gap
  // Right-aligned to the trigger. Clamped at BOTH ends: `margin` keeps it on
  // screen when the trigger sits flush against the right edge, and the width
  // clamp keeps it on screen when the trigger sits near the LEFT edge (a right
  // offset larger than viewport-width minus the popover's own width would push
  // its left side off the display).
  let right = Math.max(margin, viewport.width - anchor.right)
  if (opts?.width != null) {
    right = Math.min(right, Math.max(margin, viewport.width - opts.width - margin))
  }
  const maxHeight = Math.max(minHeight, viewport.height - top - margin)
  return { right, top, maxHeight }
}

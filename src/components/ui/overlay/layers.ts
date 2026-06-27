/**
 * Overlay layering — the SINGLE SOURCE OF TRUTH for how every full-screen panel
 * and modal surface stacks (z-index), what backdrop it wears, and where it sits
 * (fixed vs absolute). Before this existed each surface hand-rolled `fixed/
 * absolute inset-0` + a magic `z-[n]` + a one-off `bg-*` backdrop, so the layer
 * order drifted (z-20 / z-40 / z-50 / z-[60]) and was impossible to reason about.
 *
 * New full-screen / modal surfaces MUST render through `<Overlay>` (which consumes
 * these tokens) instead of inventing their own positioning + z + backdrop.
 *
 * ## Layer scale (z-index) — lower sits behind higher
 *
 * | token    | z  | use                                                         |
 * |----------|----|-------------------------------------------------------------|
 * | `hint`   | 8  | the empty-Ground hint — sits *below* every overlay          |
 * | `local`  | 20 | a surface rendered INSIDE the project module: it fills the   |
 * |          |    | module and shares its `relative` stacking context (the      |
 * |          |    | member panel, the panel's own sub-dialogs/confirms)         |
 * | `panel`  | 40 | the owner project full-screen module panel itself          |
 * | `modal`  | 50 | an app-level centred modal — opens ABOVE the panel         |
 * | `top`    | 60 | a top-most full-screen surface (the manual)                |
 * | `gate`   | 70 | a first-run gate that must sit above everything (onboarding) |
 *
 * (Historical wrinkle: the owner panel rides `panel`/40 while the *member* panel
 * rides `local`/20 — they are mutually-exclusive branches of the same overlay so
 * the gap is harmless, App never shows both at once.)
 *
 * The numbers preserve the historical de-facto order, so moving a surface off its
 * old magic number onto the matching token is a no-op visually.
 *
 * ## Position — the `fixed` vs `absolute` rule
 *
 * - `fixed`    covers the viewport. Use for app-level surfaces (modals, the
 *              project panel, the manual) that must not scroll with anything
 *              beneath them.
 * - `absolute` fills the nearest positioned ancestor. Use for in-module surfaces
 *              (the `local` layer) that overlay ONLY the project module, not the
 *              whole app — they ride inside the module's own stacking context.
 *
 * ## Backdrop tones
 *
 * - `scrim`        `bg-ink/30` + blur — the default modal veil (paper-tinted dark)
 * - `scrimStrong`  `bg-black/60`      — heavier, for destructive confirms
 * - `veil`         `bg-bg-card/70`    — translucent paper, for in-module dialogs
 * - `surface`      `bg-bg-card`       — an opaque full-screen panel (its own card bg)
 * - `paper`        `bg-bg`            — an opaque full-screen panel on page paper
 * - `none`         no background
 */

/** z-index tokens → tailwind `z-overlay-*` utilities (see tailwind.config.ts). */
export const OVERLAY_LAYER = {
  hint: 'z-overlay-hint',
  local: 'z-overlay-local',
  panel: 'z-overlay-panel',
  modal: 'z-overlay-modal',
  top: 'z-overlay-top',
  gate: 'z-overlay-gate',
} as const
export type OverlayLayer = keyof typeof OVERLAY_LAYER

/** Backdrop tone → tailwind background utilities. */
export const OVERLAY_BACKDROP = {
  scrim: 'bg-ink/30 backdrop-blur-sm',
  scrimStrong: 'bg-black/60',
  veil: 'bg-bg-card/70',
  surface: 'bg-bg-card',
  paper: 'bg-bg',
  none: '',
} as const
export type OverlayBackdrop = keyof typeof OVERLAY_BACKDROP

export type OverlayPosition = 'fixed' | 'absolute'

/** How the overlay arranges its children. */
export const OVERLAY_PLACEMENT = {
  /** Header + scrolling body fill the whole surface (full-screen panels). */
  fill: 'flex flex-col',
  /** A card centred in the viewport (the common modal). */
  center: 'flex items-center justify-center',
  /** A card pinned near the top (command-palette style). */
  top: 'flex items-start justify-center pt-[14vh]',
  /** The root itself scrolls; the child handles its own centring (used by
   *  in-module panels that grow taller than the surface, e.g. settings). */
  scroll: 'overflow-y-auto',
} as const
export type OverlayPlacement = keyof typeof OVERLAY_PLACEMENT

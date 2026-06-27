// Shared overlay shell — the single home for full-screen panel / modal chrome.
// See layers.ts for the z-index / backdrop / position conventions every surface
// must follow, and README.md for the "new surface" recipe.
export { Overlay, type OverlayProps } from './Overlay'
export { DialogCard } from './DialogCard'
export { DialogHeader } from './DialogHeader'
export { DialogBody } from './DialogBody'
export { CloseButton } from './CloseButton'
export { BackLink } from '@/components/ui/BackLink'
export {
  OVERLAY_LAYER,
  OVERLAY_BACKDROP,
  OVERLAY_PLACEMENT,
  type OverlayLayer,
  type OverlayBackdrop,
  type OverlayPlacement,
  type OverlayPosition,
} from './layers'

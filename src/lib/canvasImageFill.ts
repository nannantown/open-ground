// Image fill (Figma image paint) for frames + shapes. The image is a per-canvas
// asset (`fillImageId`); this builds the CSS to paint it as the element's
// background. The asset URL is resolved by the caller (it needs the canvas
// context) and passed in, keeping this pure + unit-testable.

import type { CanvasElement } from './types'

export type ImageFillMode = 'cover' | 'contain' | 'fill' | 'tile'
export const IMAGE_FILL_MODES: ImageFillMode[] = ['cover', 'contain', 'fill', 'tile']
export const DEFAULT_IMAGE_FILL_MODE: ImageFillMode = 'cover'

/** Resolve the sizing mode, snapping unknown/none to the default. */
export function resolveImageFillMode(el: CanvasElement): ImageFillMode {
  return el.fillImageMode && IMAGE_FILL_MODES.includes(el.fillImageMode)
    ? el.fillImageMode
    : DEFAULT_IMAGE_FILL_MODE
}

/** CSS background properties painting `url` as the element's image fill, or null
 *  when the element has no image fill. The mode maps to background-size /
 *  -repeat: cover / contain (fit), fill (stretch = 100% 100%), tile (repeat at
 *  natural size). The caller spreads the result onto the body style ABOVE the
 *  colour `background` so the image wins. */
export function imageFillStyle(
  el: CanvasElement,
  url: string,
): { backgroundImage: string; backgroundSize: string; backgroundRepeat: string; backgroundPosition: string } | null {
  if (!el.fillImageId) return null
  const mode = resolveImageFillMode(el)
  const size = mode === 'fill' ? '100% 100%' : mode === 'tile' ? 'auto' : mode // cover / contain pass through
  return {
    // `url()` value is CSS-escaped (quotes + parens) so an asset URL with odd
    // characters can't break out of the declaration.
    backgroundImage: `url("${url.replace(/["\\]/g, '\\$&')}")`,
    backgroundSize: size,
    backgroundRepeat: mode === 'tile' ? 'repeat' : 'no-repeat',
    backgroundPosition: 'center',
  }
}

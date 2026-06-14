// Client-side image preparation for in-app feedback attachments.
//
// Feedback images are stored INLINE (base64 in the feedback row's `images`
// jsonb column) rather than in object storage — feedback is low-volume and
// owner-only, so an inline blob is simpler than a bucket + signed URLs (see the
// FeedbackImage doc in types.ts). To keep the row small we downscale to a max
// edge and re-encode to WebP before upload; a 4MB phone screenshot becomes a
// few hundred KB. Runs in the browser / Electron renderer (Chromium), so
// createImageBitmap + canvas.toBlob('image/webp', …) are always available.

import type { FeedbackImage } from '@/lib/types'

/** Longest-edge cap; larger images are scaled down preserving aspect ratio. */
export const FEEDBACK_IMAGE_MAX_EDGE = 1600
/** WebP quality for the re-encode. 0.82 is visually clean for screenshots. */
export const FEEDBACK_IMAGE_QUALITY = 0.82
/** Max images per submission (mirrors the zod cap + DB check constraint). */
export const FEEDBACK_IMAGE_MAX_COUNT = 6
/** Reject absurd originals before decoding (cheap guard; the real size control
 *  is the downscale + re-encode below, not this). */
export const FEEDBACK_IMAGE_MAX_SOURCE_BYTES = 40 * 1024 * 1024

/** True for files we can attach (any raster image; we re-encode to WebP). */
export const isFeedbackImageFile = (file: File): boolean =>
  file.type.startsWith('image/')

const blobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      // readAsDataURL → "data:<mime>;base64,<data>"; keep only <data>.
      const result = String(reader.result)
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : '')
    }
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(blob)
  })

const fit = (w: number, h: number, max: number): { w: number; h: number } => {
  if (w <= max && h <= max) return { w, h }
  const scale = max / Math.max(w, h)
  return {
    w: Math.max(1, Math.round(w * scale)),
    h: Math.max(1, Math.round(h * scale)),
  }
}

/** Downscale + re-encode a user-picked image File to a small WebP, returned as
 *  a base64 FeedbackImage ready to POST. Throws on an undecodable / oversized
 *  file so the caller can surface a per-file error and skip it. */
export const fileToFeedbackImage = async (file: File): Promise<FeedbackImage> => {
  if (!isFeedbackImageFile(file)) throw new Error('not an image')
  if (file.size > FEEDBACK_IMAGE_MAX_SOURCE_BYTES) throw new Error('source too large')

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error('could not decode image')
  }

  try {
    const { w, h } = fit(bitmap.width, bitmap.height, FEEDBACK_IMAGE_MAX_EDGE)
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    ctx.drawImage(bitmap, 0, 0, w, h)

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/webp', FEEDBACK_IMAGE_QUALITY),
    )
    if (!blob) throw new Error('encode failed')

    const data = await blobToBase64(blob)
    if (!data) throw new Error('encode produced no data')
    return { name: file.name || undefined, mime: 'image/webp', data }
  } finally {
    bitmap.close()
  }
}

/** `data:` URL for rendering a stored FeedbackImage in an <img src>. */
export const feedbackImageDataUrl = (img: { mime: string; data: string }): string =>
  `data:${img.mime};base64,${img.data}`

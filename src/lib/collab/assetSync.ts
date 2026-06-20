// u14b — owner-side upload of a local canvas image's bytes to shared object
// storage (Cloudflare R2, via the loopback proxy → Worker) so folder-less
// members can fetch them. The shared Y.Doc only carries the returned object key
// (CanvasElement.storageKey), never the bytes.
//
// Lazy-imported ONLY from the owner's collab path (ProjectCanvas's sweep effect)
// so it stays out of the default bundle, matching the collab-module convention.
// It imports no transport (just fetch + a type), so it can't affect the
// OFF-bundle guarantee even if it were eager.

import type { CollabAssetUploadResponse } from '@/lib/types'

/**
 * Upload one local canvas asset to shared storage and return the storageKey to
 * write onto the element, or null on any failure (the caller keeps the element
 * local-only and may retry on a later sweep). The bytes are read server-side
 * from the owner's project folder — the client only triggers it.
 */
export async function uploadCanvasAsset(
  projectPath: string,
  canvasId: string,
  assetId: string,
): Promise<string | null> {
  try {
    const res = await fetch(
      `/api/collab/asset?path=${encodeURIComponent(projectPath)}` +
        `&canvasId=${encodeURIComponent(canvasId)}&assetId=${encodeURIComponent(assetId)}`,
      { method: 'POST' },
    )
    if (!res.ok) return null
    const data = (await res.json()) as CollabAssetUploadResponse
    return data?.ok && typeof data.storageKey === 'string' ? data.storageKey : null
  } catch {
    return null
  }
}

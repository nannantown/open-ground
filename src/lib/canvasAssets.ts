// Per-canvas image asset helpers — the one place that knows the /api/canvas/asset
// URL shape, shared by image ELEMENTS (paste/drop), image FILLS (frame/shape
// background), and anywhere else that uploads or resolves a canvas asset.

export interface CanvasAssetRef {
  assetId: string
  filename: string
}

/** The GET URL for a stored canvas asset. */
export function canvasAssetUrl(projectPath: string, canvasId: string, assetId: string): string {
  return (
    `/api/canvas/asset?path=${encodeURIComponent(projectPath)}` +
    `&canvasId=${encodeURIComponent(canvasId)}` +
    `&assetId=${encodeURIComponent(assetId)}`
  )
}

/** Upload one file to the canvas's asset store, returning its id + stored
 *  filename, or null on any failure (network / non-OK / malformed response) —
 *  callers degrade gracefully (no asset placed). */
export async function uploadCanvasAsset(
  projectPath: string,
  canvasId: string,
  file: File,
): Promise<CanvasAssetRef | null> {
  const form = new FormData()
  form.append('file', file)
  let res: Response
  try {
    res = await fetch(
      `/api/canvas/asset?path=${encodeURIComponent(projectPath)}&canvasId=${encodeURIComponent(canvasId)}`,
      { method: 'POST', body: form },
    )
  } catch {
    return null
  }
  if (!res.ok) return null
  try {
    const { assetId, filename } = (await res.json()) as { assetId: string; filename: string }
    if (typeof assetId !== 'string' || !assetId) return null
    return { assetId, filename: typeof filename === 'string' ? filename : '' }
  } catch {
    return null
  }
}

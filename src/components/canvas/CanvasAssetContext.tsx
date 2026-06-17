import { createContext, useContext } from 'react'

// The current canvas's asset context (project path + canvas id), provided by
// CanvasWorkspace so deeply-nested consumers — the inspector's image-fill
// upload, the frame/shape views resolving an image-fill URL — can reach the
// asset API WITHOUT prop-drilling through every layer. null when unavailable
// (e.g. rendered outside a canvas), where consumers degrade to no image fill.
export interface CanvasAssetCtx {
  projectPath: string
  canvasId: string
}

const Ctx = createContext<CanvasAssetCtx | null>(null)

export const CanvasAssetProvider = Ctx.Provider

export function useCanvasAsset(): CanvasAssetCtx | null {
  return useContext(Ctx)
}

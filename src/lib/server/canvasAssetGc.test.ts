// canvasAssetGc.test.ts — image-asset garbage collection on canvas write.
//
// pruneCanvasAssets is wired into saveCanvasFile (the client-save path) and
// appendCanvasElements (the AI-append path): once an image element stops
// referencing an asset — the image is REPLACED (a fresh upload issues a NEW
// assetId) or the element is DELETED — and the canvas is saved, the orphaned
// bytes are reclaimed; a still-referenced asset is kept regardless of age.
//
// The 2-minute upload grace (GC_MIN_AGE_MS in canvasImages.ts) protects an asset
// whose referencing canvas-write hasn't arrived yet (upload and save are two
// separate round-trips). So the "should be reclaimed" cases back-date the asset
// file's mtime past the grace window with utimes() to make GC deterministic
// without sleeping. HOME is the throwaway test home (setup-home.ts), so all
// writes land there, never the real ~/.openground.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readdir, utimes } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createCanvas,
  readCanvasFile,
  saveCanvasFile,
  appendCanvasElements,
} from './canvasData'
import { writeCanvasAsset, centralCanvasAssetsDir, pruneCanvasAssets } from './canvasImages'
import { registerTestProject } from '../../test/registerProject'
import type { CanvasElement, CanvasFile } from '@/lib/types'

// Bytes are irrelevant to GC (it keys off references + mtime, never content).
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47])
// Valid v4-form asset ids (writeCanvasAsset doesn't validate, but stay realistic).
const A_ID = '11111111-1111-4111-8111-111111111111'
const B_ID = '22222222-2222-4222-8222-222222222222'

// `text` is required on CanvasElement (image alt for an image element).
const imageEl = (id: string, assetId: string): CanvasElement => ({
  id,
  type: 'image',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  text: '',
  assetId,
})

// A frame/shape whose BACKGROUND is an image FILL (`fillImageId`) — a DIFFERENT
// field than an image element's `assetId`, but the same asset dir + id-namespace
// + upload endpoint. prune must treat it as a live reference, or it silently
// reaps the fill bytes (broken background on next render).
const fillEl = (
  id: string,
  fillImageId: string,
  type: 'frame' | 'shape' = 'frame',
): CanvasElement => ({
  id,
  type,
  x: 0,
  y: 0,
  width: 200,
  height: 200,
  text: '',
  fillImageId,
})

// Make an on-disk asset look older than the GC grace window so prune is allowed
// to reap it — a freshly-written file is within GC_MIN_AGE_MS and always kept.
const ageAssetPastGrace = async (projectPath: string, canvasId: string, assetId: string) => {
  const dir = await centralCanvasAssetsDir(projectPath, canvasId)
  const entries = await readdir(dir)
  const match = entries.find((e) => e.startsWith(`${assetId}.`))
  if (!match) throw new Error(`asset ${assetId} not on disk to age`)
  const old = new Date(Date.now() - 10 * 60 * 1000) // 10 min ago (> 2 min grace)
  await utimes(join(dir, match), old, old)
}

const assetExists = async (
  projectPath: string,
  canvasId: string,
  assetId: string,
): Promise<boolean> => {
  const dir = await centralCanvasAssetsDir(projectPath, canvasId)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return false
  }
  return entries.some((e) => e.startsWith(`${assetId}.`))
}

describe('canvas image-asset GC (pruneCanvasAssets wired into canvas writes)', () => {
  let projectPath: string
  let canvasId: string
  beforeEach(async () => {
    projectPath = await mkdtemp(join(tmpdir(), 'og-canvas-gc-'))
    await registerTestProject(projectPath)
    const { canvas } = await createCanvas(projectPath, 'C1')
    canvasId = canvas.id
  })
  afterEach(async () => {
    await rm(projectPath, { recursive: true, force: true }).catch(() => {})
  })

  // (1) Deleting the image element and saving reclaims the now-orphaned asset.
  it('reclaims an asset once its image element is removed and saved', async () => {
    await writeCanvasAsset(projectPath, canvasId, A_ID, 'image/png', PNG)
    const base = await readCanvasFile(projectPath, canvasId)
    const withImg = await saveCanvasFile(projectPath, {
      ...base!,
      elements: [imageEl('img', A_ID)],
    })
    expect(withImg.ok).toBe(true)
    expect(await assetExists(projectPath, canvasId, A_ID)).toBe(true) // referenced → kept

    // Age it past the grace window, then save the canvas WITHOUT the image.
    await ageAssetPastGrace(projectPath, canvasId, A_ID)
    const cur = await readCanvasFile(projectPath, canvasId)
    const out = await saveCanvasFile(projectPath, { ...cur!, elements: [] })
    expect(out.ok).toBe(true)
    expect(await assetExists(projectPath, canvasId, A_ID)).toBe(false) // reclaimed
  })

  // (1') Replacing an image (new assetId on the same element) reclaims the OLD
  // asset's bytes while keeping the new one.
  it('reclaims the old asset when an image is replaced with a new upload', async () => {
    await writeCanvasAsset(projectPath, canvasId, A_ID, 'image/png', PNG)
    const base = await readCanvasFile(projectPath, canvasId)
    await saveCanvasFile(projectPath, { ...base!, elements: [imageEl('img', A_ID)] })

    // Upload the replacement, age the OLD asset, save the element pointing at B.
    await writeCanvasAsset(projectPath, canvasId, B_ID, 'image/png', PNG)
    await ageAssetPastGrace(projectPath, canvasId, A_ID)
    const cur = await readCanvasFile(projectPath, canvasId)
    const out = await saveCanvasFile(projectPath, { ...cur!, elements: [imageEl('img', B_ID)] })
    expect(out.ok).toBe(true)
    expect(await assetExists(projectPath, canvasId, A_ID)).toBe(false) // old reclaimed
    expect(await assetExists(projectPath, canvasId, B_ID)).toBe(true) // new kept
  })

  // (2) A still-referenced asset is NEVER deleted, even once it is older than the
  // grace window — the reference, not the age, protects it.
  it('keeps a referenced asset even when it is older than the grace window', async () => {
    await writeCanvasAsset(projectPath, canvasId, A_ID, 'image/png', PNG)
    const base = await readCanvasFile(projectPath, canvasId)
    await saveCanvasFile(projectPath, { ...base!, elements: [imageEl('img', A_ID)] })
    await ageAssetPastGrace(projectPath, canvasId, A_ID)

    // Save again, still referencing A (e.g. the element was moved).
    const cur = await readCanvasFile(projectPath, canvasId)
    const out = await saveCanvasFile(projectPath, { ...cur!, elements: [imageEl('img', A_ID)] })
    expect(out.ok).toBe(true)
    expect(await assetExists(projectPath, canvasId, A_ID)).toBe(true) // referenced → kept
  })

  // (grace) An unreferenced but freshly-uploaded asset survives a save — the
  // upload→referencing-write window must not reap a not-yet-referenced asset.
  it('does NOT reclaim a fresh (within-grace) unreferenced asset', async () => {
    await writeCanvasAsset(projectPath, canvasId, A_ID, 'image/png', PNG)
    const cur = await readCanvasFile(projectPath, canvasId)
    // Save with NO reference to A, but A was just written (within grace).
    const out = await saveCanvasFile(projectPath, { ...cur!, elements: [] })
    expect(out.ok).toBe(true)
    expect(await assetExists(projectPath, canvasId, A_ID)).toBe(true) // fresh → kept
  })

  // A REJECTED (conflict) save must not prune: it wrote nothing, so an asset the
  // current on-disk canvas still references must survive the stale save attempt.
  it('does not reclaim a referenced asset on a rejected (stale) save', async () => {
    await writeCanvasAsset(projectPath, canvasId, A_ID, 'image/png', PNG)
    const base = await readCanvasFile(projectPath, canvasId)
    await saveCanvasFile(projectPath, { ...base!, elements: [imageEl('img', A_ID)] })
    await ageAssetPastGrace(projectPath, canvasId, A_ID)

    // A stale client save (old rev) that dropped the image — must be rejected,
    // and must NOT prune A even though its own (stale) element set omits it.
    const stale = await readCanvasFile(projectPath, canvasId)
    const out = await saveCanvasFile(projectPath, {
      ...stale!,
      elements: [],
      rev: (stale!.rev as number) - 1, // behind the on-disk rev → conflict
    })
    expect(out.ok).toBe(false)
    expect(out.conflict).toBe(true)
    expect(await assetExists(projectPath, canvasId, A_ID)).toBe(true) // still referenced on disk → kept
  })

  // appendCanvasElements also prunes: an asset orphaned by an earlier save (and
  // since aged past the grace window) is reclaimed on the next AI append, even
  // though append itself only adds elements.
  it('prunes orphaned assets on appendCanvasElements', async () => {
    await writeCanvasAsset(projectPath, canvasId, A_ID, 'image/png', PNG)
    const base = await readCanvasFile(projectPath, canvasId)
    await saveCanvasFile(projectPath, { ...base!, elements: [imageEl('img', A_ID)] })
    // De-reference via a save while A is still fresh, so this save's prune keeps it.
    const cur = await readCanvasFile(projectPath, canvasId)
    await saveCanvasFile(projectPath, { ...cur!, elements: [] })
    expect(await assetExists(projectPath, canvasId, A_ID)).toBe(true)

    // Now age it and let an append sweep it up.
    await ageAssetPastGrace(projectPath, canvasId, A_ID)
    await appendCanvasElements(projectPath, canvasId, [
      { id: 'note', type: 'text', x: 0, y: 0, text: 'hi' },
    ])
    expect(await assetExists(projectPath, canvasId, A_ID)).toBe(false) // reaped on append
  })

  // REGRESSION (the bug an adversarial review caught): an asset referenced ONLY
  // by a frame's image FILL (fillImageId) — with NO image element anywhere — must
  // be kept across later saves, even once it is past the grace window. A prune
  // that only looked at image-element assetIds would reap it as a false orphan.
  it('keeps an asset referenced only by a frame image fill (fillImageId)', async () => {
    await writeCanvasAsset(projectPath, canvasId, A_ID, 'image/png', PNG)
    const base = await readCanvasFile(projectPath, canvasId)
    await saveCanvasFile(projectPath, { ...base!, elements: [fillEl('f', A_ID, 'frame')] })
    await ageAssetPastGrace(projectPath, canvasId, A_ID)
    // A later save (still only a fill reference, no image element) must NOT reap it.
    const cur = await readCanvasFile(projectPath, canvasId)
    const out = await saveCanvasFile(projectPath, { ...cur!, elements: [fillEl('f', A_ID, 'frame')] })
    expect(out.ok).toBe(true)
    expect(await assetExists(projectPath, canvasId, A_ID)).toBe(true) // fill ref → kept
  })

  // Same protection for a SHAPE image fill.
  it('keeps an asset referenced only by a shape image fill (fillImageId)', async () => {
    await writeCanvasAsset(projectPath, canvasId, A_ID, 'image/png', PNG)
    const base = await readCanvasFile(projectPath, canvasId)
    await saveCanvasFile(projectPath, { ...base!, elements: [fillEl('s', A_ID, 'shape')] })
    await ageAssetPastGrace(projectPath, canvasId, A_ID)
    const cur = await readCanvasFile(projectPath, canvasId)
    const out = await saveCanvasFile(projectPath, { ...cur!, elements: [fillEl('s', A_ID, 'shape')] })
    expect(out.ok).toBe(true)
    expect(await assetExists(projectPath, canvasId, A_ID)).toBe(true)
  })

  // Clearing the fill (SelectionInspector "Fill: Image" → off drops fillImageId)
  // DOES make the asset collectable — the frame stays, the asset goes.
  it('reclaims a fill asset once the image fill is removed and saved', async () => {
    await writeCanvasAsset(projectPath, canvasId, A_ID, 'image/png', PNG)
    const base = await readCanvasFile(projectPath, canvasId)
    await saveCanvasFile(projectPath, { ...base!, elements: [fillEl('f', A_ID, 'frame')] })
    await ageAssetPastGrace(projectPath, canvasId, A_ID)
    // Frame kept, but its fill is cleared → asset now unreferenced.
    const cleared: CanvasElement = { ...fillEl('f', A_ID, 'frame'), fillImageId: undefined }
    const cur = await readCanvasFile(projectPath, canvasId)
    const out = await saveCanvasFile(projectPath, { ...cur!, elements: [cleared] })
    expect(out.ok).toBe(true)
    expect(await assetExists(projectPath, canvasId, A_ID)).toBe(false) // fill removed → reclaimed
  })

  // Defensive: prune with an INDETERMINATE element set (non-array `elements`,
  // only reachable via a corrupt payload) must KEEP everything and not throw —
  // never reap on "references unknown". Calls pruneCanvasAssets directly with a
  // cast, since the typed saveCanvasFile boundary can't express a non-array.
  it('keeps all assets (and never throws) when elements is not an array', async () => {
    await writeCanvasAsset(projectPath, canvasId, A_ID, 'image/png', PNG)
    await ageAssetPastGrace(projectPath, canvasId, A_ID)
    const corrupt = { id: canvasId, elements: 'not-an-array' } as unknown as CanvasFile
    await expect(pruneCanvasAssets(projectPath, canvasId, corrupt)).resolves.toBeUndefined()
    expect(await assetExists(projectPath, canvasId, A_ID)).toBe(true) // indeterminate → kept
  })
})

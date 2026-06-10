import { readFile } from 'fs/promises'
import { ensureOpenGroundHome, settingsFile, canvasFile } from './paths'
import { atomicWriteJson } from './atomicWrite'
import type { Settings, CanvasState } from '../types'

const DEFAULT_SETTINGS: Settings = {
  projects: [],
  defaultWorkspace: null,
  // projectsMigratedAt intentionally absent — its absence is what triggers the
  // one-shot legacy migration (see ensureProjectsMigrated). A fresh install
  // (projectsRoot=null) still runs migration once, which simply stamps the
  // sentinel and leaves `projects` empty.
  projectsRoot: null,
  archiveDirName: '_archive',
  excludePatterns: ['node_modules', '.next', 'dist', 'build', '.cache', '_archive'],
  openApps: [],
}

const DEFAULT_CANVAS: CanvasState = {
  positions: {},
  viewport: { x: 0, y: 0, zoom: 1 },
  elements: [],
}

const readJson = async <T>(path: string, fallback: T): Promise<T> => {
  // Ensure the legacy ~/.pmmap home is migrated before we resolve the path —
  // otherwise the very first read would silently return defaults from a
  // not-yet-renamed directory.
  await ensureOpenGroundHome()
  try {
    const raw = await readFile(path, 'utf8')
    return { ...fallback, ...JSON.parse(raw) }
  } catch {
    return fallback
  }
}

const writeJson = async (path: string, data: unknown) => {
  await ensureOpenGroundHome()
  await atomicWriteJson(path, data)
}

export const getSettings = () => readJson<Settings>(settingsFile(), DEFAULT_SETTINGS)
// Merge so a partial save from one UI (e.g. the Settings panel) does not
// clobber fields owned by another (e.g. the project panel's openApps).
//
// Serialised through a single-flight chain: setSettings is a read-modify-write
// (read current → merge patch → write). Two concurrent calls — e.g. a registry
// mutation patching `projects` and a settings-panel save patching
// `defaultWorkspace` — would each read the same `current` and the second write
// would clobber the first caller's keys (a lost update). The chain makes every
// call re-read inside the lock, so patches to different keys all survive.
// (registry.ts has its own withRegistryLock for its read-compute-write; this
// closes the residual cross-caller race that lock can't see. Mirrors the
// module-level chain pattern registry.ts already uses.)
let settingsChain: Promise<unknown> = Promise.resolve()
export const setSettings = async (patch: Partial<Settings>): Promise<void> => {
  const run = settingsChain.then(async () => {
    const current = await getSettings()
    await writeJson(settingsFile(), { ...current, ...patch })
  })
  // Keep the chain advancing even if one write throws, so a single failure
  // can't wedge every subsequent settings save.
  settingsChain = run.catch(() => {})
  return run
}

export const getCanvas = () => readJson<CanvasState>(canvasFile(), DEFAULT_CANVAS)
export const setCanvas = (c: CanvasState) => writeJson(canvasFile(), c)

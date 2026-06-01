import { readFile } from 'fs/promises'
import { ensureOpenGroundHome, settingsFile, canvasFile } from './paths'
import { atomicWriteJson } from './atomicWrite'
import type { Settings, CanvasState } from '../types'

const DEFAULT_RUN_PROMPT = `{{repoDigest}}

---

次のタスクを順に実装してください。コミットはまだ作らず、変更内容と次のステップを最後にまとめて報告してください。

{{tasks}}`

const DEFAULT_SETTINGS: Settings = {
  projectsRoot: null,
  archiveDirName: '_archive',
  excludePatterns: ['node_modules', '.next', 'dist', 'build', '.cache', '_archive'],
  runPromptTemplate: DEFAULT_RUN_PROMPT,
  openApps: [],
  notifyOnRunComplete: true,
  notifySound: true,
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
export const setSettings = async (patch: Partial<Settings>) => {
  const current = await getSettings()
  await writeJson(settingsFile(), { ...current, ...patch })
}

export const getCanvas = () => readJson<CanvasState>(canvasFile(), DEFAULT_CANVAS)
export const setCanvas = (c: CanvasState) => writeJson(canvasFile(), c)

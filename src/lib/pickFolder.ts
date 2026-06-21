// src/lib/pickFolder.ts — one seam for "ask the OS for an absolute folder path".
//
// The Ground needs real on-disk folder paths in three flows: create a new
// project (pick where it lives), import an existing folder, and relocate a
// missing one. A browser <input type=file webkitdirectory> can't reveal an
// absolute path, so OPEN GROUND asks the OS directly. There are two backends,
// feature-detected at call time:
//
//  1. Electron desktop app: window.openground.showOpenDialog (preload bridge →
//     main's `dialog:showOpenDialog` handler → Electron's native dialog). This
//     is the ONLY backend that works on every OS — main calls Electron's
//     cross-platform dialog, no shell-out. Windows / Linux MUST take this path.
//  2. Plain dev browser (vite, no Electron): POST /api/pick-folder, which the
//     server answers by shelling out to macOS `osascript`. macOS-only and
//     dev-only — a packaged Windows/Linux build always carries the Electron
//     bridge, so it never reaches this fallback. Before this seam existed the
//     four call sites hit this route DIRECTLY, which is exactly why the picker
//     failed with "Could not open the folder picker" on Windows (no osascript).
//     The route is now the fallback, not the default.
//
// Both backends are normalized to ONE result shape the call sites already use:
// { path?, cancelled?, error? }. Electron's native result is { canceled,
// filePaths } (single-l `canceled`); we translate to the app's `cancelled`.

import { api } from '@/lib/api-client'

export interface PickFolderResult {
  /** Absolute path of the chosen folder, or undefined if none was chosen. */
  path?: string
  /** True when the user dismissed the picker (no path, but not an error). */
  cancelled?: boolean
  /** Human-readable failure to surface, or undefined on success / cancel. */
  error?: string
}

// Minimal shape of the optional Electron bridge (electron/preload.js). Mirrors
// Electron's OpenDialogReturnValue; the preload already swallows IPC errors and
// returns a canceled-style result, so this never throws in practice. Feature-
// detected — absent in a plain dev browser (`window.openground` is undefined).
interface ShowOpenDialogBridge {
  showOpenDialog?: (options: {
    properties?: string[]
  }) => Promise<{ canceled?: boolean; filePaths?: string[] }>
}

const bridge = (): ShowOpenDialogBridge | undefined =>
  (window as unknown as { openground?: ShowOpenDialogBridge }).openground

/** Open a native folder picker; resolve to the chosen absolute path (or a
 *  cancelled / error result). Uses the Electron dialog under the desktop app
 *  (cross-platform — Windows / Linux / macOS), else the server's osascript
 *  route (dev browser, macOS only). Never throws — every failure becomes a
 *  result field so callers branch on data, not try/catch. */
export const pickFolder = async (): Promise<PickFolderResult> => {
  const og = bridge()
  if (og?.showOpenDialog) {
    try {
      const r = await og.showOpenDialog({ properties: ['openDirectory'] })
      const chosen = r?.filePaths?.[0]
      if (r?.canceled || !chosen) return { cancelled: true }
      return { path: chosen }
    } catch {
      // Defensive: the preload already degrades to { canceled: true }.
      return { error: 'Could not open the folder picker.' }
    }
  }
  // Dev-browser fallback: the local server's osascript picker (macOS only).
  try {
    const res = await api.api['pick-folder'].$post()
    return (await res.json().catch(() => ({}))) as PickFolderResult
  } catch {
    return { error: 'Could not open the folder picker.' }
  }
}

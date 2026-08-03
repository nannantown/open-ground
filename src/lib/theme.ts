import type { Settings } from '@/lib/types'

/** Colour theme plumbing (第三弾「計器盤」2026-08-03).
 *
 *  The palettes live entirely in CSS: src/app/globals.css defines the paper
 *  palette on :root and the night instrument palette on html[data-theme='dark'],
 *  and every Tailwind token reads those variables (tailwind.config.ts). So
 *  "applying" a theme is just stamping the attribute — no component knows.
 *
 *  Source of truth is settings.json (`theme`, via POST /api/settings — the key
 *  is on the USER_SETTINGS_KEYS allowlist). localStorage('og-theme') is only a
 *  fast mirror read by the inline pre-paint script in index.html so a dark-mode
 *  window never flashes paper before React mounts. */

export type ThemeName = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'og-theme'

/** Narrow a Settings value to a theme name. Unset/garbage ⇒ 'light' (the
 *  original paper look — the safe default for existing users). */
export const themeFromSettings = (settings: Pick<Settings, 'theme'> | null | undefined): ThemeName =>
  settings?.theme === 'dark' ? 'dark' : 'light'

/** Read the currently applied theme off the document. */
export const currentTheme = (): ThemeName =>
  document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'

/** Stamp the theme on <html> and refresh the pre-paint mirror. Storage errors
 *  (private mode, disabled storage) only lose the flash-free boot — the theme
 *  itself still applies. */
export const applyTheme = (theme: ThemeName): void => {
  if (theme === 'dark') document.documentElement.dataset.theme = 'dark'
  else delete document.documentElement.dataset.theme
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // mirror only — ignore
  }
}

/** Persist the choice server-side. Fire-and-forget from the toggle: the UI has
 *  already switched via applyTheme, and on failure the next boot simply falls
 *  back to the last stored value. */
export const persistTheme = (theme: ThemeName): Promise<void> =>
  fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme }),
  })
    .then(() => undefined)
    .catch(() => undefined)

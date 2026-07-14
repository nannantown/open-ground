// Hand-written declarations for electron/lockdown.js (plain CJS — see the .js
// header). Lets the vitest suite import the real implementation type-safely.
export function settingsFilePath(env?: NodeJS.ProcessEnv): string
export function lockdownFromSettingsRaw(raw: string | null | undefined): boolean
export function isLockdownEnabled(env?: NodeJS.ProcessEnv): boolean
export function isRendererUrlAllowedUnderLockdown(rawUrl: string): boolean

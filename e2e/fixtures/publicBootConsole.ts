export interface BootConsoleError {
  text: string
  url: string
}

/** Call only after asserting this exact response is the owner-only refusal.
 * Chromium also logs a network error for that deliberately refused probe.
 * No other URL, status text, JS error or missing location is permitted. */
export const unexpectedBootConsoleErrors = (errors: BootConsoleError[], refusedOwnerLogUrl: string): BootConsoleError[] =>
  errors.filter((error) => error.url !== refusedOwnerLogUrl || error.text !== 'Failed to load resource: the server responded with a status of 403 (Forbidden)')

// Type declarations for the plain-CJS electron/forkEnv.js. The module stays JS
// (Electron loads electron/main.js directly and cannot import TypeScript); the
// vitest suite gets types from here — the same split as electron/runtimeConfig.d.ts.

/** Inputs for buildServerForkEnv — the pieces electron/main.js assembles into the
 *  forked Hono server's env. */
export interface BuildServerForkEnvOptions {
  /** The PUBLIC config baked into the shipped build (readBakedAuthEnv()). */
  bakedAuthEnv: NodeJS.ProcessEnv
  /** The launch environment (process.env). */
  processEnv: NodeJS.ProcessEnv
  /** Fixed Hono port. */
  port: number
  /** Bind host. */
  host: string
  /** This launch's bootId (echoed by /api/health). */
  bootId: string
  /** Project dir reported to the server. */
  projectDir: string
  /** Resolved dist-web root, or null/undefined when not found. */
  webRoot?: string | null
  /** The resolved login-shell PATH. */
  enrichedPath: string
}

/** Assemble the env bag for the forked Hono server. The baked collab WS URL, when
 *  present, wins over any OPENGROUND_COLLAB_WS_URL in processEnv (the token-relay
 *  destination lock); every other baked key stays env-overridable. */
export function buildServerForkEnv(opts: BuildServerForkEnvOptions): NodeJS.ProcessEnv

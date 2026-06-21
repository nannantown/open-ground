// electron/forkEnv.js — assemble the env bag for the forked Hono server (prod),
// extracted from electron/main.js's spawnServerChild so the security-critical
// layering is unit-testable without spawning a process
// (server/__tests__/forkEnv.test.ts).
//
// THE INVARIANT THIS LOCKS — collab token-relay destination lock: the collab
// Worker WS endpoint (OPENGROUND_COLLAB_WS_URL) is where the signed-in user's
// Supabase access token is relayed (server-to-server) to mint a ticket. In a
// SHIPPED build that destination must be the value we baked and NOTHING the local
// launch environment can change — otherwise a tampered
// `OPENGROUND_COLLAB_WS_URL=wss://attacker` in the user's env would redirect the
// token relay. So when a baked WS URL exists we re-apply it AFTER ...processEnv so
// it wins over any env override. When NO WS URL was baked (a local/dev
// electron:prod build) processEnv still flows through, so a developer can still
// point at a local/staging Worker — i.e. env override is dev-only.
// OPENGROUND_REALTIME stays overridable on purpose: flipping the flag off is a
// legitimate opt-out, not an attack, and it can't change where the token goes.
//
// Plain CommonJS (no `electron` import), like cacheReset.js / runtimeConfig.js, so
// electron/main.js can require it directly and the vitest suite can run it in node.

/**
 * Build the env object passed to fork() for the bundled Hono server. The returned
 * object is byte-for-byte what electron/main.js used to assemble inline.
 *
 * @param {object} opts
 * @param {NodeJS.ProcessEnv} opts.bakedAuthEnv  PUBLIC config baked into the
 *   shipped build (electron/runtimeConfig.js readBakedAuthEnv()).
 * @param {NodeJS.ProcessEnv} opts.processEnv  The launch environment (process.env).
 * @param {number} opts.port  Fixed Hono port.
 * @param {string} opts.host  Bind host.
 * @param {string} opts.bootId  This launch's bootId (echoed by /api/health).
 * @param {string} opts.projectDir  Project dir reported to the server.
 * @param {string|null|undefined} opts.webRoot  Resolved dist-web root, or
 *   null/undefined when not found.
 * @param {string} opts.enrichedPath  The resolved login-shell PATH.
 * @returns {NodeJS.ProcessEnv} the assembled child env.
 */
function buildServerForkEnv(opts) {
  const {
    bakedAuthEnv,
    processEnv,
    port,
    host,
    bootId,
    projectDir,
    webRoot,
    enrichedPath,
  } = opts
  return {
    // Baked PUBLIC config (login + collab) first, so an explicit env override
    // still wins for the OVERRIDABLE keys…
    ...bakedAuthEnv,
    ...processEnv,
    ELECTRON_RUN_AS_NODE: '1',
    PORT: String(port),
    HOSTNAME: host,
    OPENGROUND_BOOT_ID: bootId,
    OPENGROUND_PROJECT_DIR: projectDir,
    ...(webRoot ? { OPENGROUND_WEB_ROOT: webRoot } : {}),
    PATH: enrichedPath,
    // …EXCEPT the collab WS URL: when baked, re-apply it AFTER processEnv so a
    // tampered OPENGROUND_COLLAB_WS_URL in the launch env can't redirect the token
    // relay. No baked value → processEnv's (dev-only) override survives.
    ...(bakedAuthEnv.OPENGROUND_COLLAB_WS_URL
      ? { OPENGROUND_COLLAB_WS_URL: bakedAuthEnv.OPENGROUND_COLLAB_WS_URL }
      : {}),
  }
}

module.exports = { buildServerForkEnv }

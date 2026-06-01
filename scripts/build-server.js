// scripts/build-server.js
//
// Bundles the Hono backend (server/index.ts) into a single self-contained
// CommonJS file at server/dist/index.cjs. This replaces the old Next
// `output: 'standalone'` tree: Electron prod forks THIS file instead of
// `.next/standalone/server.js`.
//
// Why esbuild + CJS:
//   - Electron forks the server with ELECTRON_RUN_AS_NODE=1; a single .cjs
//     file is the most reliable thing to `fork` (no ESM loader resolution,
//     no node_modules layout to ship).
//   - node-pty is a NATIVE module (.node binding + spawn-helper) — it CANNOT
//     be bundled. It stays `external` and is required at runtime from the
//     real node_modules (shipped via electron-builder asarUnpack).
//   - `@/*` (src/*) and server/* TS sources are bundled in, so src/lib/server/*
//     (the unchanged business logic) ride along without a separate compile.
//
// Pure Node, run via `node scripts/build-server.js`.

const esbuild = require('esbuild')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..')

esbuild
  .build({
    entryPoints: [path.join(repoRoot, 'server', 'index.ts')],
    outfile: path.join(repoRoot, 'server', 'dist', 'index.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    // node-pty loads a native .node binding by runtime path — never bundle it.
    // Keep it (and its optional deps) external so `require('node-pty')` in
    // src/lib/server/terminal.ts hits the real installed module on disk.
    // fsevents is an optional native dep (chokidar → screenWatcher on macOS);
    // like node-pty it ships a .node binding that can't be bundled.
    external: ['node-pty', 'fsevents'],
    // `@/*` → `src/*` (mirrors tsconfig paths) so server/routes/*.ts imports of
    // '@/lib/server/*' resolve during bundling.
    alias: {
      '@': path.join(repoRoot, 'src'),
    },
    // Helpful when debugging the forked server in prod.
    sourcemap: true,
    logLevel: 'info',
  })
  .then(() => {
    console.log('[build-server] wrote server/dist/index.cjs')
  })
  .catch((err) => {
    console.error('[build-server] failed', err)
    process.exit(1)
  })

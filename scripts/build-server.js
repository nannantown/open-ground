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
    // bufferutil / utf-8-validate are `ws`'s OPTIONAL native accelerators,
    // required inside try/catch — mark them external so bundling `ws` (the
    // collabMirror WebSocket polyfill for Electron's Node 20, which lacks a
    // global WebSocket) doesn't fail on the unresolvable optional requires;
    // at runtime the try/catch falls back to the pure-JS paths.
    // @anthropic-ai/claude-agent-sdk is external for the SAME reason node-pty is:
    // it locates and spawns a native `claude` binary, and it does so with
    // `require.resolve` from its OWN package directory. Bundled, that resolution
    // has no package directory to resolve from — the SDK's own README documents
    // this failure for compiled bundles. OPEN GROUND always passes
    // `pathToClaudeCodeExecutable` (subscription-only: it must be the USER'S
    // claude, never the SDK's bundled copy), so that path is not load-bearing
    // here — but bundling a 4MB SDK for an OFF-by-default feature, and defeating
    // the deliberate lazy `require()` in sdkSession.ts while doing it, is not
    // something to leave to chance. Verified 2026-07-31: bundled it was inlined.
    external: [
      'node-pty',
      'fsevents',
      'bufferutil',
      'utf-8-validate',
      '@anthropic-ai/claude-agent-sdk',
    ],
    // `@/*` → `src/*` (mirrors tsconfig paths) so server/routes/*.ts imports of
    // '@/lib/server/*' resolve during bundling.
    alias: {
      '@': path.join(repoRoot, 'src'),
    },
    // Helpful when debugging the forked server in prod.
    sourcemap: true,
    logLevel: 'info',
    // hooksInstall.ts falls back to import.meta.url for its ESM runtime
    // (vitest); in this CJS bundle that branch is dead code behind a
    // `typeof __dirname` guard, so esbuild's "import.meta will be empty"
    // warning is expected + harmless here.
    logOverride: { 'empty-import-meta': 'silent' },
  })
  .then(() => {
    console.log('[build-server] wrote server/dist/index.cjs')
  })
  .catch((err) => {
    console.error('[build-server] failed', err)
    process.exit(1)
  })

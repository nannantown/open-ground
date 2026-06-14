import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

// Vite + React SPA front-end for OPEN GROUND.
//
// The Next.js front-end is being replaced by this SPA; the Hono backend
// (server/) serves the built assets out of `dist-web/` in production, and in
// dev the Vite dev server hosts index.html while the API is proxied to the
// Hono server on the fixed port 47776.
//
// - `@/*` resolves to ./src (mirrors tsconfig paths).
// - `base: '/'` (absolute) is REQUIRED: the app serves a deep SPA route
//   `/screen/<slug>/<moduleId>` (iframe src, see ScreenView.tsx) via the Hono
//   index.html fallback. Relative asset URLs would resolve against
//   `/screen/<slug>/` and 404; absolute `/assets/...` always resolve from root.
//   The whole app is served from origin root on 47776, so '/' is correct.
// - build.outDir = 'dist-web' is the contract with the Hono static handler.
//
// Port convention: the primary (daily-driver) instance owns the fixed pair
// 5174/47776. Extra dev instances (worktrees, parallel branches) run
// `npm run dev:alt`, which picks the first free pair from 5175/47777 upward
// and passes it in via these env vars — without them nothing changes.
const webPort = Number(process.env.OPENGROUND_WEB_PORT) || 5174
const apiPort = Number(process.env.OPENGROUND_API_PORT || process.env.PORT) || 47776

export default defineConfig({
  plugins: [react()],
  base: '/',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist-web',
    emptyOutDir: true,
  },
  server: {
    // Dev only. Electron dev drives its own port; the API lives on apiPort.
    port: webPort,
    // strictPort: FAIL LOUDLY if 5174 is already taken instead of silently
    // drifting to 5175/5176. The convention is ONE primary on 5174/47776 and
    // every extra instance via `npm run dev:alt` (which pre-claims a free pair
    // with firstFree(), so it never collides here). A silent web-port drift is
    // how a second `npm run dev` used to vacate the canonical pair and strand
    // the daily-driver tab — pinned to :5174 — on a dead API (endless
    // "Loading…"). With strict, a duplicate `dev` errors out immediately and
    // concurrently -k tears the rest down, so the mistake is obvious.
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
})

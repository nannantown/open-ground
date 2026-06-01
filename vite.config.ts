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
    // Dev only. Electron dev drives its own port; the API lives on 47776.
    port: 5174,
    strictPort: false,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:47776',
        changeOrigin: true,
      },
    },
  },
})

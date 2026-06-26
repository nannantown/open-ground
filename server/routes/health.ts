// GET /api/health — OPEN GROUND's identity probe (CONTRACT §3.2). The launcher
// hits this and treats the server as "ours" only if app === 'openground' AND
// bootId matches what it wrote to server.json. A byte-for-byte port of
// src/app/api/health/route.ts; the only change is NextResponse.json -> c.json.
//
// Everything is read off the env the launcher set when it spawned this process.
// STARTED_AT is frozen at module load so successive probes report the same boot
// moment (the server's uptime), not the time of the latest GET.

import { Hono } from 'hono'
import type { Health } from '@/lib/healthSchema'
// App version, read from package.json at BUILD time: esbuild inlines the JSON
// into the server bundle and tsx/vitest resolve it via resolveJsonModule, so the
// value is cwd-independent — the packaged app reports the real shipped version,
// not whatever package.json the forked server's cwd happens to resolve.
import { version as APP_VERSION } from '../../package.json'

// Frozen at module load — this module is evaluated once per server boot, so
// `startedAt` reports when the server came up, not when /api/health was polled.
const STARTED_AT = new Date().toISOString()

export const health = new Hono().get('/api/health', (c) => {
  const body: Health = {
    app: 'openground',
    projectDir: process.env.OPENGROUND_PROJECT_DIR || process.cwd(),
    bootId: process.env.OPENGROUND_BOOT_ID || null,
    port: process.env.PORT ? Number(process.env.PORT) : null,
    startedAt: STARTED_AT,
    version: APP_VERSION,
  }
  return c.json(body)
})

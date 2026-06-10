# OPEN GROUND: rationale for the Next.js → Vite + React + Hono migration

> A handoff for other agents/developers. It contrasts the current
> implementation (Next.js) with the Hono approach, and lays out "why we should
> rewrite it" and "the contracts you must not break when you start."

## 0. Premises (immovable constraints)

OPEN GROUND is a **local, single-user desktop tool** (bundled with Electron).
The back end **requires Node** — because its core feature is PTY-driving the
`claude` CLI with `node-pty`. **Adopting Electron and a Node back end are
settled.** This document is about what's inside that: "do we keep the renderer +
API layer on Next.js, or move to Vite+React+Hono."

**Conclusion: we should rewrite it to Vite + React + Hono (+ the `hc` client +
`@hono/zod-validator`).** The rationale follows.

---

## 1. Next.js's flagship features are all dead in this app

| Next.js's value | Relevance in OPEN GROUND |
|---|---|
| SSR / RSC | **Not needed** (local, SEO-irrelevant, the initial render is instant on localhost) |
| Page routing | **Not needed** (the UI is effectively an SPA where all state lives in the one `src/app/page.tsx` page) |
| Image optimization / ISR / Edge | **Not needed** |
| File-based **API** routing (45 of them) | ✅ Useful (but can also be organized in Hono) |
| Zero-config dev / HMR | ✅ Useful (but Vite is as fast or faster) |

→ **We've draped a full SSR web framework over a local SPA + API server.** We're
paying the weight of features we don't use.

## 2. The clincher: Next's standalone tracer structurally fights node-pty

This is the biggest reason. `next.config.js` requires workarounds because Next's
`output:'standalone'` tracer **can't follow node-pty's native bindings
(`.node`)**:

```js
output: 'standalone',
experimental: { serverComponentsExternalPackages: ['node-pty'] },
outputFileTracingIncludes: {           // bundle the .node manually
  './node_modules/node-pty/build/Release/**/*',
  './node_modules/node-pty/prebuilds/**/*',
}
```

On top of that, `electron/main.js`'s `resolveStandaloneServer()` carries logic
that **hunts for `.next/standalone/server.js` across multiple candidate paths**,
and `package.json`'s `build.asarUnpack` needs a workaround to push node-pty
outside the asar.

**These are all Next-specific friction.** A Hono server is "just a Node file",
so Electron simply `fork`s it. There's no fighting a tracer, and node_modules is
right there. **The fight between the app's core (node-pty) and the packaging
machinery disappears entirely.**

## 3. Everything we'd worry about losing can be kept in Hono

The current HTTP-server design has **three genuine advantages worth keeping**.
Keep Hono as a **localhost HTTP server** and all three are preserved:

1. **Claude×Chrome debugging** — the workflow of opening
   `http://127.0.0.1:47776` in a regular Chrome and having Claude operate it. As
   long as it's served over localhost HTTP, Next vs Hono is irrelevant →
   **preserved**
2. **HMR** — `vite dev` serves the renderer, and Electron points at it (same
   shape as today's `electron:dev`) → **preserved**
3. **The 3 SSE channels** (`run/events` · `terminal/[id]/stream` ·
   `screen/watch`) — SSE is a native first-class citizen in Hono via
   `streamSSE` → **portable with a "no rewrite needed" mindset**

> ※ pure IPC (going all-in on `ipcMain`/`ipcRenderer`) breaks 1 and 3 above, so
> we **don't take it**. The point is to keep Hono as an HTTP server.

## 4. Type safety actually gets better than it is now

As the git history shows with `zod on every API` (026de2d), zod is hand-written
per API. With Hono:

- **`@hono/zod-validator`** → reuse the existing zod schemas directly as the
  route validators
- **`hc` (the Hono RPC client)** → import the server's types into the client →
  obtain **tRPC-like end-to-end type safety** without a separate framework

The string URLs + manual typing of `fetch('/api/...')` (14 sites on the client)
get replaced by typed RPC calls.

### Why Hono, and not tRPC or Express/Fastify

- **Express** → a downgrade. Callback-style, weak types, manual SSE, no typed client.
- **Fastify** → a sideways move to slightly heavier. Aimed at large-scale validated REST; overkill for this app.
- **Elysia** → shows its value on Bun. Electron forks Node, so the advantage evaporates.
- **tRPC** → attractive for a single TS client, but **subscriptions (streaming)
  are heavier to wire than plain SSE**. SSE's 3 channels are core to this app, so
  it cancels out. → **It's better to take type safety via Hono's `hc` while
  keeping SSE native.**

---

## 5. Porting map (current → Hono)

| Current (Next.js) | Hono version |
|---|---|
| `src/app/api/**/route.ts` (45) | Hono routes (`app.get/post(...)`, split into files) |
| `Request`/`Response` in Next route handlers | Hono is Fetch-API-compliant, so it moves over almost as-is |
| zod validation (hand-written) | `@hono/zod-validator` |
| SSE (`text/event-stream` hand-written, 3 sites) | the `streamSSE` helper |
| client `fetch('/api/...')` ×14 | the `hc` RPC client |
| `src/app/page.tsx` + components | a Vite + React SPA (the logic is largely reused) |
| `output:'standalone'` + fork + tracer workarounds | **not needed** (Electron `fork`s Hono directly) |
| the launch sequence in `electron/main.js` | **preserved** (only the fork target changes from server.js → the Hono entry) |

---

## 6. Contracts that must not break (the receiving side must keep these)

- **Fixed port 47776 / `127.0.0.1`** (a prerequisite for the single-instance design in `CLAUDE.md`)
- **The `GET /api/health` contract**: returns `{ app:'openground', bootId, port,
  projectDir, startedAt }`. It is the identity probe that `electron/main.js`'s
  `waitForReady` uses to require a matching `bootId` in prod
- **The `validateProjectPath()` security boundary** (allow only under
  `projectsRoot`) — always preserved on path-accepting APIs
- **The two-store structure**: app settings `~/.openground/` and per-project
  `<project>/.openground/` (`src/lib/server/paths.ts` and others)
- **`src/lib/types.ts`** preserved as the shared client/server contract
- **Legacy migration & the `OPENGROUND_RESULT:` parser** (compatible with the legacy `HOVE_/PMMAP_` markers)
- **The approach of placing in-memory runner state on `globalThis.__openground_runner`**
  (survives across HMR/reloads)

---

## 7. Risks and caveats

- **An honest weakness**: Next's "just drop a `route.ts`" convention magic
  shrinks, and Hono describes routes explicitly. But around 45 of them are
  manageable, and what we gain (the disappearance of node-pty friction, the
  lighter footprint, type safety) outweighs it
- **SSE backpressure/disconnect**: the auto-reconnect behavior of the current
  `EventSource` (see the comment in `run/events/route.ts`) must be guaranteed on
  the Hono `streamSSE` side too
- **The `terminal/[id]` dynamic route**: move to Hono's parameter routing
  (`/terminal/:id/...`)
- **Migration: all-at-once vs incremental**: the safe path is to introduce `hc`
  and Hono, move the 3 SSE channels and the node-pty path first, then port the
  rest of the REST incrementally

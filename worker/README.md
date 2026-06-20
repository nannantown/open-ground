# og-collab-worker

The Cloudflare **Worker + Durable Object** that hosts OPEN GROUND's realtime
collaboration rooms.

One Durable Object class (`OgCollabDoc`, a [`y-partyserver`](https://github.com/cloudflare/partykit/tree/main/packages/y-partyserver)
`YServer`) holds **one Yjs document per room**. A room is one shared scope of one
shared project:

```
ROOM = collabProjectId + ":" + scope        scope = "board" | "canvas:<id>"
```

`YServer` implements the full Yjs sync protocol (sync step 1/2, live update
relay, awareness) over the DO's **hibernatable** WebSocket API. We add:

- `onLoad` / `onSave` — persist the merged doc to **DO SQLite storage**, so a
  room survives hibernation, eviction, and redeploys.
- a **ticket gate** (`onBeforeConnect` in `src/index.ts`) — every WebSocket
  upgrade must carry a short-lived HMAC ticket minted by the Hono side and bound
  to that exact room. No valid ticket → `401`, socket never opens.

The `claude` PTY is **never** part of collab — only Board (`ProjectData.tasks` /
`notes`) and Canvas (`CanvasFile.elements`) document state syncs here.

## Files

| file | role |
|------|------|
| `src/index.ts` | Worker entry: `routePartykitRequest` + `onBeforeConnect` ticket gate; re-exports the DO; tiny `/health`. |
| `src/OgCollabDoc.ts` | `YServer<Env>` subclass: `hibernate: true`, `onLoad`/`onSave` (DO SQLite), `isReadOnly`. |
| `src/ticket.ts` | `verifyTicket(token, secret, room)` — Web Crypto HMAC-SHA256, exp check, room (pid+scope) binding. **No node crypto.** |
| `wrangler.jsonc` | Canonical config (used by `wrangler dev`/`deploy` and the test). |
| `wrangler.toml` | Minimal mirror, kept only as an `unstable_dev` TOML fallback. |
| `test/local.mjs` | Programmatic 2-client convergence + late-joiner + deny-ticket test. |

## Ticket wire format

Shared byte-for-byte with the Hono minter and re-verified here:

```
ticket = base64url(JSON{pid,scope,sub,role,exp}) + "." + base64url(HMAC_SHA256(secret, firstPart))
```

- `pid` = `collabProjectId`, `scope` = `"board"` | `"canvas:<id>"`
- `sub` = user id, `role` = `"owner"` | `"member"`
- `exp` = epoch **milliseconds**, ~60 s TTL
- secret = `OPENGROUND_COLLAB_TICKET_SECRET` (the SAME value on both sides)

The Worker recomputes the HMAC over the first part, checks `exp` is in the
future, and checks `pid + ":" + scope === room`.

## Local test

From this directory, after installing deps:

```bash
npm install        # partyserver, y-partyserver, yjs, wrangler, ws
npm test           # == node test/local.mjs
```

`npm test` boots the worker with `wrangler unstable_dev` (`{ local: true,
config: "wrangler.jsonc" }` — it loads the **`.jsonc`**, not the `.toml`),
injects a test `OPENGROUND_COLLAB_TICKET_SECRET`, mints valid/invalid tickets
in-process (node `crypto`, same wire format), then asserts:

1. two `YProvider` clients in the same room converge on a `Y.Map` value;
2. a **late** third client receives prior state (proves the DO holds the doc);
3. a **tampered** ticket gets `401` (no upgrade) and a **wrong-room** ticket
   never reaches `synced`; a correct canvas-room ticket *is* accepted (control).

Exit code `0` = all green, `1` = a failure. The test always calls
`worker.stop()` and `process.exit`.

## Deploy

```bash
# 1. Authenticate wrangler with your Cloudflare account.
wrangler login

# 2. Set the shared HMAC secret (the SAME value the Hono app signs tickets
#    with — env OPENGROUND_COLLAB_TICKET_SECRET on the app side).
wrangler secret put OPENGROUND_COLLAB_TICKET_SECRET

# 3. Deploy. The "v1" migration creates the OgCollabDoc SQLite DO on first push.
wrangler deploy
```

After deploy, wrangler prints the Worker URL, e.g.
`https://og-collab.<your-subdomain>.workers.dev`. Set the **`wss://`** form of
it on the Hono side as `OPENGROUND_COLLAB_WS_URL` so the ticket route returns it
to clients:

```bash
# in the OPEN GROUND app's environment (e.g. .env.local):
OPENGROUND_COLLAB_WS_URL=wss://og-collab.<your-subdomain>.workers.dev
OPENGROUND_COLLAB_TICKET_SECRET=<same secret you put on the Worker>
```

The client opens `wss://…/parties/og-collab-doc/<room>?token=<ticket>`;
`partysocket` re-runs the ticket query on every (re)connect, so tickets refresh
automatically without a manual timer.

## Notes

- **Party name** must stay `og-collab-doc` (the kebab-case of `OgCollabDoc`) on
  both ends — it is the DO route segment and the client's `party` option.
- **`new_sqlite_classes`** (not `new_classes`) in the migration is required: it
  gives the DO a SQLite backend (free tier + `this.ctx.storage` SQL), which the
  hibernation + `onLoad`/`onSave` persistence rely on.
- **`nodejs_compat`** is enabled for `yjs`. `src/ticket.ts` deliberately uses
  **Web Crypto only** — never the node `crypto` module — because it runs in the
  Workers request path.

// Ambient binding types for the collab Worker.
//
// `partyserver` types its public API against the ambient `Cloudflare.Env`
// namespace (`routePartykitRequest<Env extends Cloudflare.Env>`, `Server<Env>`,
// `Lobby<Env>`). In a normal Cloudflare project that namespace is produced by
// running `wrangler types` (which writes a generated worker-configuration.d.ts).
// We declare it here directly so the Worker typechecks WITHOUT a generated file
// — it stays in sync with wrangler.jsonc by hand (only two bindings).
//
// Keep this identical to the exported `Env` interface in src/index.ts.

declare namespace Cloudflare {
  interface Env {
    // DO namespace — binding name === class name (see wrangler.jsonc).
    // Parameterised by the class so RPC calls (stub.purgeStorage()) typecheck.
    // Inline `import(...)` type syntax is deliberate: a top-level `import`
    // would turn this ambient file into a module and the `declare namespace
    // Cloudflare` block would stop being ambient.
    OgCollabDoc: DurableObjectNamespace<import('./src/OgCollabDoc').OgCollabDoc>
    // Shared HMAC secret (wrangler secret put OPENGROUND_COLLAB_TICKET_SECRET).
    OPENGROUND_COLLAB_TICKET_SECRET: string
    // R2 bucket for shared canvas image bytes (u14b). Optional — absent until
    // the user provisions it; the asset routes 503 without it.
    ASSET_BUCKET?: R2Bucket
    // Supabase PUBLIC config for the zero-config ticket route (POST /ticket).
    // Optional — absent, /ticket 503s and only server-minted tickets work. Never
    // the service-role key. Keep in sync with the Env interface in src/index.ts.
    SUPABASE_URL?: string
    SUPABASE_ANON_KEY?: string
    // Operator-only erase secret for POST /admin/rooms/purge. Optional — while
    // unset the admin route is inert (503).
    OPENGROUND_COLLAB_ADMIN_SECRET?: string
  }
}

// Convenience global alias mirroring the wrangler-generated shape.
interface Env extends Cloudflare.Env {}

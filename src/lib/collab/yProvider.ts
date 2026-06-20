// OBSOLETE — the bespoke Supabase-broadcast Yjs provider lived here.
//
// The realtime transport now runs over a Cloudflare Durable Object via
// y-partyserver (see ./provider.ts → connectCollabDoc, which dynamically imports
// the YProvider default export of "y-partyserver/provider"). The two-step
// broadcast handshake (SupabaseYjsProvider) and its base64 codec are no longer
// used by any runtime path, so this module is intentionally empty.
//
// It is kept as a placeholder (rather than deleted) only so the file stays in
// the tracked set; nothing imports it. The ORIGIN_SEED filter that the broadcast
// provider's comments referenced still lives in ./ydoc.ts and is consumed by
// RealtimeContext + the pure mappers — untouched by this transport swap.

export {}

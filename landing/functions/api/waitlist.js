// landing/functions/api/waitlist.js — Cloudflare Pages Function for the
// marketing-site waitlist.
//
// WHY A SERVER PROXY (not a direct browser → Supabase call):
// The landing site is a fully static, public bundle on Cloudflare Pages. If we
// called Supabase straight from the page we'd have to ship the anon key in the
// client where anyone can scrape it. Instead this Function runs at the edge and
// forwards the insert SERVER-SIDE, reading SUPABASE_URL + SUPABASE_ANON_KEY
// from the Pages environment only — so no credentials are ever baked into what
// the browser downloads. (Mirrors server/routes/feedback.ts in the app.)
//
// GRACEFUL DEGRADE: when the env vars are unset (e.g. a preview deploy without
// secrets) we return a clear 503 "waitlist not configured" rather than
// attempting a forward with no credentials. NO hardcoded secrets, ever.
//
// Target table: waitlist(email, lang, source) with RLS enabled and an
// anon INSERT-only policy. We use Prefer: return=minimal so we never read rows
// back to the client.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function onRequestPost({ request, env }) {
  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'invalid request body' }, 400);
    }

    // Honeypot: a hidden form field real users never see or fill. A bot that
    // auto-fills every input trips it. Drop the request with a fake success so
    // the bot gets no signal to adapt — and we never touch Supabase. Zero-config
    // first line of defence; a stronger Turnstile / KV rate limit can layer on
    // top later (needs Cloudflare dashboard setup, so it's not wired here).
    const trap = typeof body?.company === 'string' ? body.company.trim() : '';
    if (trap) {
      return json({ ok: true }, 200);
    }

    const email = typeof body?.email === 'string' ? body.email.trim() : '';
    const rawLang = typeof body?.lang === 'string' ? body.lang.trim() : '';
    // Only ever store 'ja' or 'en' — anything else (incl. injected junk) → 'en'.
    const lang = rawLang === 'ja' ? 'ja' : 'en';

    // Basic validation: length-capped + shape check. Reject before we touch
    // Supabase so bad input never costs a round trip.
    if (!email || email.length > 200 || !EMAIL_RE.test(email)) {
      return json({ error: 'a valid email is required' }, 400);
    }

    const url = env.SUPABASE_URL?.trim();
    const anonKey = env.SUPABASE_ANON_KEY?.trim();
    if (!url || !anonKey) {
      return json({ error: 'waitlist not configured' }, 503);
    }

    const endpoint = `${url.replace(/\/+$/, '')}/rest/v1/waitlist`;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        'Content-Type': 'application/json',
        // We only insert; never read rows back to the public client.
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ email, lang, source: 'landing' }),
    });

    if (!res.ok) {
      // Surface Supabase's reason in the Function log (it may carry RLS / schema
      // hints the operator needs) but return a generic message so we never leak
      // the URL/key context downstream.
      const detail = await res.text().catch(() => '');
      console.error(`[openground:waitlist] supabase ${res.status}: ${detail}`);
      return json({ error: 'could not join the waitlist' }, 502);
    }

    return json({ ok: true }, 200);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'waitlist request failed';
    console.error('[openground:waitlist] forward failed', msg);
    return json({ error: 'could not join the waitlist' }, 502);
  }
}

function json(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

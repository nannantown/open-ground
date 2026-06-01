# Billing plan (deferred)

**Status: login ships now; billing/premium gating is NOT built.**

## What ships now

The optional Google/GitHub login (see [AUTH_SETUP.md](./AUTH_SETUP.md)). It is
the app's own account, distinct from the Claude CLI subscription. It is
**purely optional** and **gates nothing** — every feature works signed out.

## Why no billing yet

OPEN GROUND is in **MVP-lockdown**: the per-project surface is intentionally
minimal and we do not add gating/scope-creep features ahead of need. Building a
billing system (entitlements, plan tiers, payment integration, paywalls) now
would be premature: there is no premium feature to gate, and a half-built
entitlement check is worse than none. So we built **only the seam**, not the
mechanism.

## The seam a future entitlement check hooks into

When billing is actually needed, it reads from these existing pieces — no new
plumbing for "who is this user" is required:

| Layer  | Seam | Notes |
|--------|------|-------|
| Client | `useAuth()` in `src/lib/auth/AuthContext.tsx` | The single place the UI asks "who is signed in?". An entitlement value would live alongside `user`/`status` here. |
| Wire   | `GET /api/auth/session` → `AuthSessionResponse` | Returns the public `AuthUser`. A future `entitlement`/`plan` field would be added to this response shape. |
| Types  | `Session`, `AuthUser` in `src/lib/types.ts` | The shared client/server contract. Extend `AuthUser` (or `Session`) with plan/entitlement fields when needed. |
| Server | `server/routes/auth.ts` + `src/lib/server/authStore.ts` | Owns the Supabase tokens (never sent to the client). A future check would query Supabase (or a billing provider) here, server-side, using the stored access token. |

## Explicit non-goals (today)

- No payment provider integration (Stripe, etc.).
- No plan tiers, no paywalls, no premium-only features.
- No per-project auth — login is global and optional.
- No change to the Claude CLI "subscription-only" boundary: OPEN GROUND still
  only ever drives the user's `claude` CLI; the app account is unrelated.

When billing becomes real, add an `entitlement` to the session response, surface
it through `useAuth()`, and gate the one feature that needs it — nothing else in
this seam should have to move.

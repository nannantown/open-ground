-- Realtime collab v2 — anon hardening. Collab is AUTHENTICATED-ONLY: every read
-- and write in the collab path runs with the signed-in user's OWN JWT (the
-- `authenticated` role) under the 0005 owner-managed RLS policies. The `anon`
-- role is never used for collab, so it must hold NO privileges on these tables.
--
-- Why this exists: 0005 grants/policies all target `authenticated`, but PostgREST
-- still exposes og_projects / og_project_members to whatever the `anon` role is
-- granted. Even though their RLS policies only admit `authenticated`, leaving any
-- residual table-level grant to `anon` is a latent footgun (a future permissive
-- policy or a grant slip could expose rows to unauthenticated callers). Revoke
-- everything from `anon` so the tables are flatly unreachable without a session.
--
-- This is idempotent and safe to re-run. RLS + the authenticated grants from 0005
-- are untouched, so the collab feature is unaffected.
-- Apply via Supabase MCP, then get_advisors(security) — expect ZERO new findings.

revoke all on public.og_projects from anon;
revoke all on public.og_project_members from anon;

-- Post-release grant hygiene — strip LATENT `authenticated` privileges left over
-- from Supabase's default table grants. Supabase grants ALL privileges on new
-- public tables to anon/authenticated at creation time; RLS still gates every
-- row, but a standing table privilege that a future *permissive* policy could be
-- paired with is a latent footgun. This is the `authenticated`-role analogue of
-- the anon cleanups in 0006 (og_projects/og_project_members) and 0008/0010
-- (og_project_invites / og_project_join_requests vs anon).
--
-- Idempotent and safe to re-run: REVOKE of a privilege that is not held is a
-- no-op (no error). NOTHING here grants — it only removes privileges that are
-- not part of any intended client write path. Apply via Supabase MCP, then
-- get_advisors(security) — expect ZERO new findings.

-- ── og_project_join_requests — the approval queue (created in 0010) ──────────
-- Intended client privileges are SELECT + DELETE ONLY (the owner lists pending
-- requests and denies/clears them); 0010 granted exactly those. Rows are
-- INSERTed solely by the SECURITY DEFINER redeem RPC join_with_invite(), which
-- runs as the function OWNER (not as `authenticated`) — so this REVOKE cannot
-- affect it. There is no UPDATE path at all (a deny is a DELETE). Strip any
-- latent INSERT/UPDATE so the queue can never be written directly by a client,
-- even if a permissive policy is added later.
revoke insert, update on public.og_project_join_requests from authenticated;

-- ── og_project_members — the roster (created in 0001, opened up in 0005) ─────
-- DELIBERATELY revoke ONLY UPDATE — NOT INSERT.
--   * INSERT is LOAD-BEARING and MUST stay: the owner seeds the roster with a
--     DIRECT authenticated insert under RLS policy "og members owner insert"
--     (0005). See upsertProjectMembers() in src/lib/server/projectMembers.ts,
--     called from POST /api/collab/* (server/routes/collab.ts:145 seeds the
--     owner's own membership row; :354 seeds invited emails). Revoking INSERT
--     would 403 that path and break enabling collaboration. (The code inserts
--     rows one-by-one precisely because a bulk on_conflict upsert trips this
--     table's RLS WITH CHECK.)
--   * UPDATE has NO intended path: no migration grants it and no policy allows
--     it (a role change is not a client operation). Revoke the latent UPDATE so
--     a member can never mutate a roster row (e.g. self-escalate role) even if a
--     permissive UPDATE policy slips in later.
revoke update on public.og_project_members from authenticated;

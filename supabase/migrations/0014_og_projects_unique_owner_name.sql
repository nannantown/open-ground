-- Realtime collab — DEDUP GUARD for owner-managed projects (fixes a duplicate
-- og_projects row / split collab-room bug). Apply via Supabase MCP, then
-- get_advisors(security) — expect ZERO new findings (this adds only an index).
--
-- THE BUG: findOrCreateOwnProject() keys a project by an opaque per-owner hash
-- sha256(owner_id ':' canonicalPath) stored in og_projects.name. It was a
-- NON-ATOMIC find-then-create with NO uniqueness at the DB level. When a project
-- opens, every collab scope (board + each canvas) mounts its own RealtimeProvider
-- and fires GET /api/collab/project AT ONCE, so findOrCreate ran N times
-- concurrently for the same folder: each SELECT missed (no row yet), each then
-- INSERTed → multiple og_projects rows with the SAME (owner_id, name). A later
-- find (limit 1, no ORDER BY) then returned DIFFERENT ids to different
-- scopes/invited members, silently splitting the collab room.
--
-- THE FIX is two-layer:
--   * Server (projectMembers.ts): single-flight the concurrent resolves + a
--     DETERMINISTIC order=created_at.asc,id.asc find so callers converge on one
--     (oldest) row. That alone closes the in-process race (and needs no DB change).
--   * This migration: a UNIQUE (owner_id, name) index so even a cross-process
--     race can't persist duplicates — the losing INSERT 409s and the server
--     re-finds the winner. Defense in depth.
--
-- NULL names stay DISTINCT under standard SQL unique-index semantics, so
-- ensureOwnProject()'s "always mint a fresh shareable project" path (name IS NULL)
-- is UNAFFECTED — only the hashed dedup key dedups. (We deliberately do NOT use
-- NULLS NOT DISTINCT.)

-- ── 1) Collapse any pre-existing duplicates (NO-OP on a clean DB) ─────────────
-- Required so the unique index below can build on a DB that already accumulated
-- duplicates during the buggy era. Survivor = the OLDEST row per (owner_id, name)
-- by (created_at, id) — the SAME tiebreak projectMembers.ts now finds with, so
-- the row the app keeps using is exactly the one kept here. Re-points roster rows
-- onto the survivor (og_project_members.project_id is a bare uuid, NOT an FK, so
-- it would otherwise orphan) and deletes the duplicate project rows (their
-- og_project_invites cascade away — those are regenerable 7-day link secrets).
-- The `where id <> keep_id` guard means every statement is a true no-op once
-- there are no duplicates, so this is safe to re-run.

-- 1a) Drop roster rows on a duplicate that would COLLIDE on the survivor's
--     (project_id, email) unique index (same non-null email = already a member of
--     the survivor), so the re-point in 1b can't violate it. Plain `=` skips NULL
--     emails (NULLs are distinct in that index, so they re-point harmlessly).
delete from public.og_project_members m
 using (
   with ranked as (
     select id,
            first_value(id) over (
              partition by owner_id, name order by created_at asc, id asc
            ) as keep_id
       from public.og_projects
      where name is not null
   )
   select id as dup_id, keep_id from ranked where id <> keep_id
 ) d
 where m.project_id = d.dup_id
   and exists (
     select 1 from public.og_project_members k
      where k.project_id = d.keep_id
        and k.email = m.email
   );

-- 1b) Re-point the surviving roster rows from each duplicate onto the survivor.
update public.og_project_members m
   set project_id = d.keep_id
  from (
   with ranked as (
     select id,
            first_value(id) over (
              partition by owner_id, name order by created_at asc, id asc
            ) as keep_id
       from public.og_projects
      where name is not null
   )
   select id as dup_id, keep_id from ranked where id <> keep_id
 ) d
 where m.project_id = d.dup_id;

-- 1c) Delete the duplicate project rows (FK cascade removes their invite links).
delete from public.og_projects p
 using (
   with ranked as (
     select id,
            first_value(id) over (
              partition by owner_id, name order by created_at asc, id asc
            ) as keep_id
       from public.og_projects
      where name is not null
   )
   select id as dup_id, keep_id from ranked where id <> keep_id
 ) d
 where p.id = d.dup_id;

-- ── 2) The guard: one row per (owner_id, name) ───────────────────────────────
-- A named unique index (not just a constraint) so a future PostgREST on_conflict
-- could target it by name if ever needed. NULL names remain distinct.
create unique index if not exists og_projects_owner_name_key
  on public.og_projects (owner_id, name);

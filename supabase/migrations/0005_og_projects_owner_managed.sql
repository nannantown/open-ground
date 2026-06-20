-- Realtime collab v2 (Cloudflare Durable Object transport) — OWNER-MANAGED
-- project membership, NO service-role. Replaces the v1 model where the
-- cross-user collabProjectId came from the git-share marker and member writes
-- went through the service-role key. Now:
--   * og_projects is the canonical project row; its id IS the collabProjectId.
--   * The project OWNER (auth.uid() = owner_id) manages the roster directly under
--     RLS with their own JWT — no SUPABASE_SERVICE_ROLE_KEY for collab.
-- Apply via Supabase MCP, then get_advisors(security) — expect ZERO new findings.
-- Lint hygiene: every policy uses (select auth.uid()) / (select auth.jwt())
-- (auth_rls_initplan), never with_check(true), and exactly ONE permissive policy
-- per (role, action) (no multiple_permissive_policies).

-- ── 1) Drop obsolete v1 collab objects ───────────────────────────────────────
-- The DO's own SQLite storage replaces og_doc_snapshots; Cloudflare R2 replaces
-- the Supabase Storage bucket; there is no Supabase Realtime broadcast under the
-- DO transport. Dropping these also frees the og_is_member* helpers of every
-- caller so they can be moved to a non-exposed schema below.
drop table if exists public.og_doc_snapshots cascade;
drop policy if exists "og members read broadcast" on realtime.messages;
drop policy if exists "og members send broadcast" on realtime.messages;
drop policy if exists "og collab read assets" on storage.objects;
drop policy if exists "og collab insert assets" on storage.objects;
drop policy if exists "og collab update assets" on storage.objects;
drop policy if exists "og collab delete assets" on storage.objects;
-- NOTE: the og-collab-assets bucket row itself can't be removed via SQL (storage
-- protect trigger); its policies are dropped above so it's inert (no access).
-- Delete it via the Storage API / dashboard if desired (images are on R2 now).

-- ── 2) Membership helper → a NON-API-EXPOSED `private` schema ─────────────────
-- WHY private + SECURITY DEFINER:
--  * DEFINER: the helper's inner read of og_project_members BYPASSES that table's
--    RLS, which is what breaks the og_projects <-> og_project_members policy
--    recursion cycle (each table's SELECT policy needs to consult the other).
--  * private schema: PostgREST only exposes `public`, so a DEFINER function in
--    `private` is NOT callable via /rest/v1/rpc — this clears the
--    "anon/authenticated can execute SECURITY DEFINER function" advisor that a
--    public DEFINER function trips, while RLS policies can still call it.
-- It leaks nothing: the body filters strictly by the CALLER's own identity and
-- returns only a boolean (never rows), so a caller can only learn about their OWN
-- membership.
create schema if not exists private;
grant usage on schema private to authenticated;

-- old public helpers are now unreferenced (their v1 policies were dropped above)
drop function if exists public.og_is_member_text(text);
drop function if exists public.og_is_member(uuid);

create or replace function private.og_is_member(pid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.og_project_members m
    where m.project_id = pid
      and ( ((select auth.uid()) is not null and m.user_id = (select auth.uid()))
         or (m.email is not null and lower(m.email) = lower(coalesce((select auth.jwt() ->> 'email'), ''))) )
  );
$$;
grant execute on function private.og_is_member(uuid) to authenticated;

-- ── 3) og_projects — id IS the collabProjectId ───────────────────────────────
create table if not exists public.og_projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text,
  created_at timestamptz not null default now()
);
create index if not exists og_projects_owner_idx on public.og_projects (owner_id);
alter table public.og_projects enable row level security;

-- ONE SELECT policy (owner OR member) — avoids multiple_permissive_policies.
drop policy if exists "og projects owner select" on public.og_projects;
drop policy if exists "og projects member select" on public.og_projects;
drop policy if exists "og projects read" on public.og_projects;
create policy "og projects read" on public.og_projects
  for select to authenticated
  using ( (select auth.uid()) = owner_id or private.og_is_member(id) );
drop policy if exists "og projects owner insert" on public.og_projects;
create policy "og projects owner insert" on public.og_projects
  for insert to authenticated with check ( (select auth.uid()) = owner_id );
drop policy if exists "og projects owner update" on public.og_projects;
create policy "og projects owner update" on public.og_projects
  for update to authenticated
  using ( (select auth.uid()) = owner_id ) with check ( (select auth.uid()) = owner_id );
drop policy if exists "og projects owner delete" on public.og_projects;
create policy "og projects owner delete" on public.og_projects
  for delete to authenticated using ( (select auth.uid()) = owner_id );
grant select, insert, update, delete on public.og_projects to authenticated;

-- ── 4) og_project_members — owner-managed writes + roster read ───────────────
-- 0001 created this table with a self-only SELECT and service-role writes. Move
-- writes under RLS (owner of the project, identified via og_projects) and let any
-- member read the whole roster (for the invite UI). Single SELECT policy.
drop policy if exists "og members read own membership" on public.og_project_members;
drop policy if exists "og members read roster" on public.og_project_members;
create policy "og members read roster" on public.og_project_members
  for select to authenticated using ( private.og_is_member(project_id) );

drop policy if exists "og members owner insert" on public.og_project_members;
create policy "og members owner insert" on public.og_project_members
  for insert to authenticated with check (
    exists ( select 1 from public.og_projects p
             where p.id = og_project_members.project_id
               and p.owner_id = (select auth.uid()) )
  );
drop policy if exists "og members owner delete" on public.og_project_members;
create policy "og members owner delete" on public.og_project_members
  for delete to authenticated using (
    exists ( select 1 from public.og_projects p
             where p.id = og_project_members.project_id
               and p.owner_id = (select auth.uid()) )
  );
grant insert, delete on public.og_project_members to authenticated;

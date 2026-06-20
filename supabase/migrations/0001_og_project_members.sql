-- Realtime collab — membership allowlist (the RLS basis for every collab object).
-- Applied to project tlyicnxiitfoxzvojwhy via Supabase MCP (2026-06-14). This
-- file reproduces the FINAL state on a fresh project (definer→invoker flip folded
-- in). Mirrors og_roles' self-scoped pattern but uses (select auth.uid()) /
-- (select auth.jwt()) to avoid the auth_rls_initplan perf lint. Writes
-- (invite/leave) are SERVICE-ROLE only — no authenticated write policy.

create table if not exists public.og_project_members (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  user_id uuid references auth.users(id) on delete cascade,
  email text,
  role text not null default 'member' check (role in ('owner','member')),
  created_at timestamptz not null default now()
);
-- Dedup key, targetable by PostgREST on_conflict for idempotent upserts. The
-- writer always lowercases emails, so case-dedup holds without lower() here.
create unique index if not exists og_project_members_proj_email_uniq
  on public.og_project_members (project_id, email);
create index if not exists og_project_members_project_idx on public.og_project_members (project_id);
create index if not exists og_project_members_user_idx on public.og_project_members (user_id);

alter table public.og_project_members enable row level security;

-- Membership check reused by every collab policy. SECURITY INVOKER: it only ever
-- reveals the CALLER's own membership (RLS below scopes reads to self), so no
-- definer surface. Called from OTHER tables' policies (snapshots/realtime/storage)
-- where reading og_project_members is a different table = no RLS recursion.
create or replace function public.og_is_member(pid uuid)
returns boolean language sql stable security invoker set search_path = public as $$
  select exists (
    select 1 from public.og_project_members m
    where m.project_id = pid
      and ( ((select auth.uid()) is not null and m.user_id = (select auth.uid()))
         or (m.email is not null and lower(m.email) = lower(coalesce((select auth.jwt() ->> 'email'), ''))) )
  );
$$;

-- Safe text wrapper: validates a uuid segment before casting so a malformed
-- realtime topic / storage object key fails CLOSED (false) instead of throwing.
create or replace function public.og_is_member_text(seg text)
returns boolean language sql stable set search_path = public as $$
  select case
    when seg ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then public.og_is_member(seg::uuid)
    else false
  end;
$$;

-- A signed-in user reads only their OWN membership rows (direct self-match to
-- avoid recursion via og_is_member).
create policy "og members read own membership" on public.og_project_members
  for select to authenticated using (
    ((user_id is not null) and (user_id = (select auth.uid())))
    or ((email is not null) and (lower(email) = lower(coalesce((select auth.jwt() ->> 'email'), ''))))
  );

grant select on public.og_project_members to authenticated;

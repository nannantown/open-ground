-- Realtime collab — LINK-based join (login still required). The owner mints a
-- secret invite link (token, 7-day expiry); any LOGGED-IN user who presents a
-- valid token self-joins as a member. Coexists with email-invite (0005).
--
-- Self-join needs a controlled privilege escalation: a member-insert is normally
-- owner-only (0005 RLS), but the invitee is NOT the owner. So join_with_invite()
-- is an INTENTIONAL user-callable SECURITY DEFINER RPC — it inserts ONLY the
-- CALLER (uid/email from their JWT) into the token's project, role capped by the
-- invite; it cannot add others, pick the project, or escalate. (This is the
-- standard secure invite pattern; it WILL appear on the "definer executable by
-- authenticated" advisor BY DESIGN — tightly scoped + reviewed, unlike the
-- internal helpers which live in the private schema.)

create table if not exists public.og_project_invites (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.og_projects(id) on delete cascade,
  token text not null unique,                              -- the link secret
  role text not null default 'member' check (role in ('member')),
  expires_at timestamptz not null default (now() + interval '7 days'),
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists og_project_invites_project_idx on public.og_project_invites (project_id);
alter table public.og_project_invites enable row level security;

-- The project OWNER manages (create/list/revoke) its invite links. No one else
-- can read the tokens (they ARE the secret).
drop policy if exists "invites owner all" on public.og_project_invites;
create policy "invites owner all" on public.og_project_invites
  for all to authenticated
  using (
    exists (select 1 from public.og_projects p
            where p.id = og_project_invites.project_id and p.owner_id = (select auth.uid()))
  )
  with check (
    exists (select 1 from public.og_projects p
            where p.id = og_project_invites.project_id and p.owner_id = (select auth.uid()))
  );
grant select, insert, update, delete on public.og_project_invites to authenticated;

-- Controlled self-join. Inserts ONLY the caller (JWT uid/email) into the token's
-- project. Idempotent (on conflict do nothing). Raises on invalid/expired token.
create or replace function public.join_with_invite(invite_token text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  inv public.og_project_invites;
  caller_uid uuid := (select auth.uid());
  caller_email text := (select auth.jwt() ->> 'email');
begin
  if caller_uid is null then raise exception 'not authenticated'; end if;
  select * into inv from public.og_project_invites where token = invite_token;
  if not found then raise exception 'invalid invite'; end if;
  if inv.expires_at < now() then raise exception 'invite expired'; end if;
  insert into public.og_project_members (project_id, user_id, email, role)
  values (inv.project_id, caller_uid, caller_email, inv.role)
  on conflict (project_id, email) do nothing;
  return inv.project_id;
end $$;
revoke all on function public.join_with_invite(text) from public, anon;
grant execute on function public.join_with_invite(text) to authenticated;

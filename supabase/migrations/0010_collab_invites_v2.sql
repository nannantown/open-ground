-- Realtime collab — Figma-style invite links v2 (docs/COLLAB_ZEROCONFIG_PLAN.md
-- §3). Extends the 0007/0008 link-join with per-link PERMISSION MODE + bounds and
-- an owner APPROVAL queue, all still owner-managed under RLS with NO service-role.
--
-- What's new vs 0007/0008:
--   1. og_project_invites.mode — 'open' (join immediately, today's behavior) or
--      'approval' (opening the link files a PENDING request the owner must approve).
--   2. og_project_invites.max_uses / use_count — bound how far ONE link spreads
--      (null = unlimited, 1 = single-use, n = at most n redemptions). use_count is
--      bumped in the SAME transaction as the redemption, under a row lock, so the
--      cap is ATOMIC (no two concurrent redeems can both slip past n).
--   3. og_projects.member_cap — a PROJECT-level "max N collaborators" (null =
--      unlimited). Holds regardless of how many links exist; in approval mode it is
--      enforced at APPROVE time (the queue may hold more than the cap).
--   4. og_project_join_requests — the approval queue. Owner-managed (SELECT/DELETE
--      under RLS); rows are inserted ONLY by the caller via the SECURITY DEFINER
--      redeem RPC (never by direct client write — anon/authenticated have no INSERT
--      grant on it).
--   5. join_with_invite(token) returns jsonb {project_id, status} and BRANCHES on
--      mode: open → enrol the caller (status 'joined'); approval → file a pending
--      request (status 'pending'). Idempotent: an already-member / already-pending
--      caller is a no-op success that consumes NO use.
--   6. approve_join_request(id) — owner-only SECURITY DEFINER: cap-check, enrol the
--      requester, delete the request, all in one call. Deny is a plain owner-RLS
--      DELETE of the request row (no RPC needed).
--
-- Privilege model is UNCHANGED from 0007/0008 and sound: every definer function
-- inserts ONLY rows it derives from the caller's own JWT or from an owner-verified
-- request; it can neither add a third party nor escalate a role. Apply via Supabase
-- MCP, then get_advisors(security) — the two user-callable definer RPCs
-- (join_with_invite, approve_join_request) appear on the "definer executable by
-- authenticated" advisor BY DESIGN (the standard secure-invite pattern), exactly
-- like 0007's join_with_invite.

-- ── 1) Per-link permission mode + spread bounds ──────────────────────────────
alter table public.og_project_invites
  add column if not exists mode text not null default 'open'
    check (mode in ('open', 'approval'));
alter table public.og_project_invites
  add column if not exists max_uses int
    check (max_uses is null or max_uses >= 1);
alter table public.og_project_invites
  add column if not exists use_count int not null default 0;

-- ── 2) Project-level collaborator cap ────────────────────────────────────────
alter table public.og_projects
  add column if not exists member_cap int
    check (member_cap is null or member_cap >= 1);

-- ── 3) The approval queue ────────────────────────────────────────────────────
-- One PENDING request per (project, email) — the unique index lets the redeem RPC
-- `on conflict do nothing` so a double-click can't pile up duplicate requests, and
-- mirrors og_project_members' (project_id, email) single-identity invariant.
create table if not exists public.og_project_join_requests (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.og_projects(id) on delete cascade,
  invite_id uuid references public.og_project_invites(id) on delete set null,
  user_id uuid not null,
  email text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  created_at timestamptz not null default now(),
  unique (project_id, email)
);
create index if not exists og_project_join_requests_project_idx
  on public.og_project_join_requests (project_id);
alter table public.og_project_join_requests enable row level security;

-- The project OWNER reads (to list pending) and deletes (to deny / clear) requests.
-- NO insert/update grant to clients: rows are created only by the SECURITY DEFINER
-- redeem RPC below (which inserts ONLY the caller), so a member can't forge a
-- request for someone else or self-approve. Single permissive policy per action.
drop policy if exists "join requests owner select" on public.og_project_join_requests;
create policy "join requests owner select" on public.og_project_join_requests
  for select to authenticated using (
    exists (select 1 from public.og_projects p
            where p.id = og_project_join_requests.project_id
              and p.owner_id = (select auth.uid()))
  );
drop policy if exists "join requests owner delete" on public.og_project_join_requests;
create policy "join requests owner delete" on public.og_project_join_requests
  for delete to authenticated using (
    exists (select 1 from public.og_projects p
            where p.id = og_project_join_requests.project_id
              and p.owner_id = (select auth.uid()))
  );
-- Only SELECT/DELETE reach clients; INSERT/UPDATE stay RPC-only (definer).
grant select, delete on public.og_project_join_requests to authenticated;
-- The token/queue are crown-jewel secrets — never leave a latent anon grant
-- (0008 did the same for og_project_invites).
revoke all on public.og_project_join_requests from anon;

-- ── 4) Redeem RPC v2 — branch on mode, atomic caps, idempotent ───────────────
-- Returns jsonb {project_id, status} where status ∈ {'joined','pending'}. Inserts
-- ONLY the caller (uid/email from their JWT), exactly like 0007/0008. The invite
-- row is locked FOR UPDATE so use_count checks+bumps are serialized — two
-- simultaneous redeems of a single-use link cannot both succeed.
--
-- 0007's join_with_invite(text) returned uuid; this v2 returns jsonb. Postgres
-- `create or replace function` cannot change a function's return type, so the old
-- definition must be dropped first (same (text) signature). Without this DROP the
-- apply fails with "cannot change return type of existing function". `if exists`
-- keeps a clean first-time apply (0007 → 0010) and re-apply both safe.
drop function if exists public.join_with_invite(text);
create or replace function public.join_with_invite(invite_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  inv public.og_project_invites;
  caller_uid uuid := (select auth.uid());
  -- Lowercased to match the email-invite path → one identity, one roster row,
  -- a removable member (0008 fix #1).
  caller_email text := lower((select auth.jwt() ->> 'email'));
  cap int;
  cur_members int;
begin
  if caller_uid is null then raise exception 'not authenticated'; end if;
  if caller_email is null then raise exception 'no email on account'; end if;

  -- Lock the invite row: serializes concurrent redemptions so the max_uses gate
  -- below is atomic (check + bump happen with no interleave).
  select * into inv from public.og_project_invites where token = invite_token for update;
  if not found then raise exception 'invalid invite'; end if;
  if inv.expires_at < now() then raise exception 'invite expired'; end if;

  -- Idempotency: an existing MEMBER re-clicking a link is an instant success that
  -- consumes no use (otherwise a member re-opening a single-use link would see it
  -- "exhausted"). Matches the email-key single-identity invariant.
  if exists (select 1 from public.og_project_members m
             where m.project_id = inv.project_id and m.email = caller_email) then
    return jsonb_build_object('project_id', inv.project_id, 'status', 'joined');
  end if;

  if inv.mode = 'approval' then
    -- Already queued? No-op success, no new use consumed.
    if exists (select 1 from public.og_project_join_requests r
               where r.project_id = inv.project_id and r.email = caller_email
                 and r.status = 'pending') then
      return jsonb_build_object('project_id', inv.project_id, 'status', 'pending');
    end if;
    -- A redemption (= filing a request) counts against max_uses.
    if inv.max_uses is not null and inv.use_count >= inv.max_uses then
      raise exception 'invite exhausted';
    end if;
    insert into public.og_project_join_requests (project_id, invite_id, user_id, email, status)
    values (inv.project_id, inv.id, caller_uid, caller_email, 'pending')
    on conflict (project_id, email) do nothing;
    -- Count a use ONLY when a request was actually filed. `found` is false when the
    -- INSERT hit the (project_id,email) conflict (a concurrent duplicate that slipped
    -- past the exists-check above) — so a redemption that produced no new request
    -- burns no use, keeping max_uses an honest spread bound.
    if found then
      update public.og_project_invites set use_count = use_count + 1 where id = inv.id;
    end if;
    return jsonb_build_object('project_id', inv.project_id, 'status', 'pending');
  end if;

  -- open mode: max_uses, then member_cap, then enrol.
  if inv.max_uses is not null and inv.use_count >= inv.max_uses then
    raise exception 'invite exhausted';
  end if;
  select member_cap into cap from public.og_projects where id = inv.project_id;
  if cap is not null then
    select count(*) into cur_members from public.og_project_members where project_id = inv.project_id;
    if cur_members >= cap then raise exception 'project full'; end if;
  end if;
  insert into public.og_project_members (project_id, user_id, email, role)
  values (inv.project_id, caller_uid, caller_email, inv.role)
  on conflict (project_id, email) do nothing;
  -- Count a use ONLY when a member was actually enrolled (a racing duplicate that
  -- hit the conflict consumes no use — see the approval branch).
  if found then
    update public.og_project_invites set use_count = use_count + 1 where id = inv.id;
  end if;
  return jsonb_build_object('project_id', inv.project_id, 'status', 'joined');
end $$;
revoke all on function public.join_with_invite(text) from public, anon;
grant execute on function public.join_with_invite(text) to authenticated;

-- ── 5) Approve a pending request — owner-only, cap-checked, atomic ───────────
-- The owner could in principle INSERT the member + DELETE the request via their
-- existing 0005 RLS grants, but that wouldn't enforce member_cap atomically and
-- would be two round-trips. This definer RPC does the owner check, the cap check,
-- the enrol and the request-delete in one call. It enrols ONLY the requester named
-- on the row (no caller-supplied identity), so it can't be turned into "add anyone".
create or replace function public.approve_join_request(request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  req public.og_project_join_requests;
  cap int;
  cur_members int;
begin
  if (select auth.uid()) is null then raise exception 'not authenticated'; end if;
  select * into req from public.og_project_join_requests where id = request_id;
  if not found then raise exception 'no such request'; end if;
  -- Owner gate: the caller must OWN the request's project.
  if not exists (select 1 from public.og_projects p
                 where p.id = req.project_id and p.owner_id = (select auth.uid())) then
    raise exception 'not the owner';
  end if;
  -- Member cap enforced at APPROVE time (the queue may exceed it; the owner just
  -- can't approve past it).
  select member_cap into cap from public.og_projects where id = req.project_id;
  if cap is not null then
    select count(*) into cur_members from public.og_project_members where project_id = req.project_id;
    if cur_members >= cap then raise exception 'project full'; end if;
  end if;
  insert into public.og_project_members (project_id, user_id, email, role)
  values (req.project_id, req.user_id, req.email, 'member')
  on conflict (project_id, email) do nothing;
  delete from public.og_project_join_requests where id = request_id;
  return jsonb_build_object('project_id', req.project_id, 'status', 'approved');
end $$;
revoke all on function public.approve_join_request(uuid) from public, anon;
grant execute on function public.approve_join_request(uuid) to authenticated;

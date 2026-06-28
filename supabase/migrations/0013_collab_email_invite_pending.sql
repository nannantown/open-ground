-- Realtime collab — EMAIL invites become a true PENDING→ACCEPTED path (the "safe
-- primary invite": the owner names exactly who may enter; that person holds NO
-- collab access until they explicitly accept the in-app お知らせ). docs/
-- COLLAB_EMAIL_INVITE_PENDING_PLAN.md.
--
-- BEFORE: an email invite (upsertProjectMembers) inserted a full og_project_members
-- row, so the invitee was an immediate, full-access member the moment the owner
-- typed their address — "invited" and "joined" were the SAME state, with no
-- pre-confirm gate and nothing for the invitee to accept.
--
-- AFTER: og_project_members gains a `status` ∈ {pending, accepted}. An email invite
-- lands `pending` (pre-confirmed identity, ZERO access); the invitee promotes their
-- OWN row to `accepted` via the accept_invite RPC (the お知らせ "Join" action). Link
-- self-joins (join_with_invite) and owner-approvals (approve_join_request) stay
-- immediate (they insert with the column default `accepted`). Access gating
-- (getMyMembership / the Worker's resolveMembership / the ticket route) requires
-- `accepted`-or-owner, so a pending row grants no WS/ticket/content access — but the
-- roster-READ RLS (private.og_is_member, UNCHANGED) still lets the invitee read the
-- project's roster + label (metadata only — no Y.Doc, no tickets, no secrets), which
-- is how the お知らせ bell surfaces the invite. This metadata read is PRE-EXISTING
-- (0005) and is a NET REDUCTION here: pre-0013 the same email-invitee was an
-- immediate FULL member (metadata AND content); now they're metadata-only until they
-- accept. Nothing here weakens the owner-self-managed-RLS / no-service-role model.
--
-- Privilege model is UNCHANGED and sound: accept_invite (like join_with_invite)
-- acts ONLY on rows it derives from the CALLER's own JWT (email or uid) — it can
-- neither accept someone else's invite, enrol a non-invited caller (no matching
-- row → 0 rows updated), nor escalate a role. Apply via Supabase MCP, then
-- get_advisors(security): accept_invite joins join_with_invite / approve_join_request
-- on the "definer executable by authenticated" advisor BY DESIGN (the standard
-- secure-invite pattern).
--
-- DEPLOY ORDER (the column is a hard dependency for the new code): apply THIS
-- migration FIRST, then deploy the Worker (resolveMembership selects `status`),
-- then ship the app. The column default `accepted` backfills every existing row,
-- so a still-running OLD app/Worker keeps working against the migrated DB
-- (they simply ignore the new column) — the ordering only protects the NEW code.

-- ── 1) Membership acceptance status ──────────────────────────────────────────
-- default 'accepted' so (a) EVERY existing row backfills to accepted = no
-- regression for current collaborators, and (b) the paths that should grant
-- access immediately — the owner seed (upsertProjectMembers role 'owner'), the
-- link self-join (join_with_invite), and the owner approval (approve_join_request)
-- — all insert WITHOUT naming status and correctly get 'accepted'. ONLY the
-- email-invite path (upsertProjectMembers role 'member') explicitly writes
-- 'pending'.
alter table public.og_project_members
  add column if not exists status text not null default 'accepted'
    check (status in ('pending', 'accepted'));

-- A partial index for the per-user pending-invite scan (listInvitesForMe reads the
-- caller's rosters and keeps only pending rows). Small + selective; harmless when
-- nobody has pending invites.
create index if not exists og_project_members_pending_idx
  on public.og_project_members (project_id)
  where status = 'pending';

-- ── 2) Accept an email invite — the invitee promotes their OWN pending row ────
-- The Ground お知らせ "Join" action calls this. SECURITY DEFINER (direct UPDATE on
-- og_project_members is REVOKED — migration 0011 — so a definer RPC is the only
-- write path), but it flips ONLY the CALLER's OWN pending row, matched by the
-- caller's verified JWT email OR uid. It therefore can NOT accept another person's
-- invite, and a caller with no pending row updates 0 rows (cannot self-enrol — only
-- the owner INSERTs rows). Binds user_id now that the account is known (an email
-- invite seeded before first login has user_id null). Idempotent: re-accepting is a
-- 0-row no-op success.
create or replace function public.accept_invite(p_project_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  caller_uid uuid := (select auth.uid());
  -- Lowercased to match how email invites are stored (upsertProjectMembers lowercases),
  -- so the same identity resolves one roster row.
  caller_email text := lower((select auth.jwt() ->> 'email'));
  flipped int;
begin
  if caller_uid is null then raise exception 'not authenticated'; end if;
  if caller_email is null then raise exception 'no email on account'; end if;
  update public.og_project_members
     set status = 'accepted',
         user_id = coalesce(user_id, caller_uid)
   where project_id = p_project_id
     and status = 'pending'
     and (email = caller_email or user_id = caller_uid);
  get diagnostics flipped = row_count;
  return jsonb_build_object('project_id', p_project_id, 'accepted', flipped);
end $$;
revoke all on function public.accept_invite(uuid) from public, anon;
grant execute on function public.accept_invite(uuid) to authenticated;

-- ── 3) Link redeem also ACCEPTS a pending email invite (hybrid coexistence) ───
-- Re-declares join_with_invite (migration 0010) with ONE change: the idempotency
-- branch (an existing row for the caller → instant success consuming no use) now
-- ALSO flips a still-PENDING row to 'accepted'. Without this, a person invited BY
-- EMAIL (pending) who is ALSO handed a link would redeem it, hit the "already a
-- member" short-circuit, and stay pending — a successful-looking redeem that grants
-- no access. Redeeming a link IS an acceptance gesture, so we accept here too.
-- Everything else is byte-identical to 0010's definition (same jsonb return type,
-- so no DROP is needed). The privilege model is unchanged: still inserts/updates
-- ONLY the caller's own (uid/email) row.
create or replace function public.join_with_invite(invite_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  inv public.og_project_invites;
  caller_uid uuid := (select auth.uid());
  caller_email text := lower((select auth.jwt() ->> 'email'));
  cap int;
  cur_members int;
begin
  if caller_uid is null then raise exception 'not authenticated'; end if;
  if caller_email is null then raise exception 'no email on account'; end if;

  select * into inv from public.og_project_invites where token = invite_token for update;
  if not found then raise exception 'invalid invite'; end if;
  if inv.expires_at < now() then raise exception 'invite expired'; end if;

  -- Idempotency: an existing row for the caller is an instant success consuming no
  -- use. ALSO accept a still-PENDING email invite (flip → accepted, bind user_id)
  -- so an email-invited caller handed a link isn't left stuck pending.
  if exists (select 1 from public.og_project_members m
             where m.project_id = inv.project_id and m.email = caller_email) then
    update public.og_project_members
       set status = 'accepted', user_id = coalesce(user_id, caller_uid)
     where project_id = inv.project_id and email = caller_email and status = 'pending';
    return jsonb_build_object('project_id', inv.project_id, 'status', 'joined');
  end if;

  if inv.mode = 'approval' then
    if exists (select 1 from public.og_project_join_requests r
               where r.project_id = inv.project_id and r.email = caller_email
                 and r.status = 'pending') then
      return jsonb_build_object('project_id', inv.project_id, 'status', 'pending');
    end if;
    if inv.max_uses is not null and inv.use_count >= inv.max_uses then
      raise exception 'invite exhausted';
    end if;
    insert into public.og_project_join_requests (project_id, invite_id, user_id, email, status)
    values (inv.project_id, inv.id, caller_uid, caller_email, 'pending')
    on conflict (project_id, email) do nothing;
    if found then
      update public.og_project_invites set use_count = use_count + 1 where id = inv.id;
    end if;
    return jsonb_build_object('project_id', inv.project_id, 'status', 'pending');
  end if;

  -- open mode: max_uses, then member_cap, then enrol (default status 'accepted').
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
  if found then
    update public.og_project_invites set use_count = use_count + 1 where id = inv.id;
  end if;
  return jsonb_build_object('project_id', inv.project_id, 'status', 'joined');
end $$;
revoke all on function public.join_with_invite(text) from public, anon;
grant execute on function public.join_with_invite(text) to authenticated;

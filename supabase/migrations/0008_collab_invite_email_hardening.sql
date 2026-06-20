-- Realtime collab — link-join email hardening (adversarial-review follow-up to
-- 0007). Two correctness fixes inside join_with_invite + one defense-in-depth
-- grant cleanup. The privilege model of 0007 is unchanged and sound; this only
-- fixes how the CALLER'S EMAIL is stored and tightens anon grants.
--
-- 1. LOWERCASE the caller email inside join_with_invite. 0007 inserted the raw
--    JWT email, but every OTHER membership write lowercases (upsertProjectMembers
--    / removeProjectMember in src/lib/server/projectMembers.ts). The mismatch
--    meant:
--      (a) REVOCATION BYPASS — an owner's "remove member" issues
--          DELETE ... email=eq.<lowercased>, which could NOT match a link-joiner
--          whose email had uppercase letters, so the "removed" collaborator kept
--          collab access permanently (the stranded row still satisfies
--          private.og_is_member); and
--      (b) DEDUP BYPASS — a pre-invited (lowercased) email plus the same human's
--          link-join (mixed case) produced TWO roster rows, because the unique
--          index og_project_members (project_id, email) is case-sensitive so
--          ON CONFLICT never collapsed them.
--    Lowercasing restores the single-identity invariant the unique index assumes.
-- 2. REQUIRE an email. A NULL email (anonymous / phone-only / no-email OAuth) is
--    DISTINCT under the unique index, so ON CONFLICT never fires and one caller
--    could insert unlimited rows. collab identity is email-based throughout, so
--    raise rather than enrol a NULL-identity member. (Latent today — anon auth is
--    off and all users have emails — but closed now so enabling anon can't
--    regress it.)
-- 3. REVOKE anon's default table grants on og_project_invites. 0006 did this for
--    og_projects / og_project_members but predates this table. RLS already blocks
--    anon, but the invite TOKEN is the crown-jewel secret, so we don't leave a
--    latent grant a future permissive-policy slip could turn into a token leak.

revoke all on public.og_project_invites from anon;

create or replace function public.join_with_invite(invite_token text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  inv public.og_project_invites;
  caller_uid uuid := (select auth.uid());
  -- Lowercased to match the email-invite path → one identity, one roster row,
  -- and a removable member (see fix #1 above).
  caller_email text := lower((select auth.jwt() ->> 'email'));
begin
  if caller_uid is null then raise exception 'not authenticated'; end if;
  if caller_email is null then raise exception 'no email on account'; end if;
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

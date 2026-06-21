-- og_roles grant hygiene — strip latent client WRITE privileges. og_roles is the
-- custom-tabs ROLE source of truth (src/lib/server/roles.ts): the client only ever
-- READS its own role (GET .../og_roles?select=role under the user's OWN JWT + a
-- self-scoped RLS SELECT). Role ASSIGNMENT is an out-of-band / admin operation
-- (service role / SQL / dashboard), NEVER a client write — so anon + authenticated
-- must hold NO INSERT/UPDATE/DELETE on this table.
--
-- Why this exists: Supabase grants ALL privileges on a new public table to anon +
-- authenticated at creation time; RLS still gates every row, but a standing WRITE
-- privilege that a future *permissive* policy could be paired with is a latent
-- footgun here in particular — a user able to INSERT/UPDATE their own og_roles row
-- could self-grant 'admin' / 'owner' and unlock gated custom tabs. This is the
-- og_roles analogue of the collab grant cleanups in 0006 / 0008 / 0010 / 0011.
--
-- EXISTENCE GUARD: og_roles is created OUT-OF-BAND (custom-tabs / dashboard), not
-- by any migration in this folder, so a fresh / CI / brand-new Supabase that runs
-- the migrations top-to-bottom may not have the table yet. A bare REVOKE on a
-- missing relation ERRORs and would hard-fail apply_migration, so wrap it in a DO
-- block gated on to_regclass(...) — when og_roles is absent we skip cleanly (the
-- REVOKE is meaningless until the table exists, and re-running this migration once
-- it does is safe). The REVOKE itself is unchanged + idempotent: revoking a
-- privilege that is not held is a no-op (no error).
--
-- NOTHING here grants — SELECT (the ONLY intended client privilege) is deliberately
-- left untouched, so the read path in roles.ts is unaffected. Apply via Supabase
-- MCP, then get_advisors(security) — expect ZERO new findings.

do $$
begin
  if to_regclass('public.og_roles') is not null then
    revoke insert, update, delete on public.og_roles from anon, authenticated;
  else
    raise notice 'og_roles not present — skipping REVOKE (table is created out-of-band)';
  end if;
end $$;

-- Hosted billing service only. No local data migration, no client writes.
create table if not exists public.og_billing (
  user_id uuid primary key references auth.users(id) on delete cascade,
  customer_id text not null unique,
  status text not null default 'none',
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  checked_at timestamptz not null default '-infinity'
);
alter table public.og_billing enable row level security;
revoke all on public.og_billing from anon, authenticated;
grant all on public.og_billing to service_role;

-- Overlapping webhook/state refreshes cannot overwrite a newer Stripe read.
create or replace function public.og_apply_billing_snapshot(
  p_customer_id text, p_status text, p_end timestamptz,
  p_cancel boolean, p_checked_at timestamptz
) returns void language sql security invoker set search_path = '' as $$
  update public.og_billing set status = p_status, current_period_end = p_end,
    cancel_at_period_end = p_cancel, checked_at = p_checked_at
  where customer_id = p_customer_id and checked_at <= p_checked_at;
$$;
revoke all on function public.og_apply_billing_snapshot(text,text,timestamptz,boolean,timestamptz) from public, anon, authenticated;
grant execute on function public.og_apply_billing_snapshot(text,text,timestamptz,boolean,timestamptz) to service_role;

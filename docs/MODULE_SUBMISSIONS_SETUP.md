# Tab submissions (tester → owner review) — setup

OPEN GROUND lets a **tester** build a custom tab locally and **submit** it to the
owner for review; the owner approves (→ the tab is **published** to the
marketplace, where anyone can install it) or rejects. Like in-app feedback, the
browser never talks to Supabase directly — the loopback Hono server proxies it:

```
tester  ──POST /api/module-submissions──▶  local Hono server  ──REST insert──▶  Supabase
         (built tab's source)                (anon key, SERVER env only)        og_module_submissions
                                                                                   (private, insert-only)
owner   ──Settings → Tab submissions────▶  local Hono server  ──service-role──▶  read / approve / reject
                                            (owner machine only)        approve → publishModule INSERT
                                                                          into og_custom_modules (public)
```

This builds on the **custom tabs / marketplace** integration
(`docs/CUSTOM_TABS_PLAN.md`): submissions are a *private review queue* in front
of the existing public `og_custom_modules` table. The anon key **never** enters
the client bundle. **If the env is unset the feature degrades gracefully** —
`POST /api/module-submissions` returns `503` (the tester's "Submit to owner"
button reports it) and the owner review inbox never appears. The public build is
safe with **no credentials baked in**.

> Prerequisite: the marketplace must already be configured (the same
> `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`; see `docs/CUSTOM_TABS_PLAN.md`),
> because **approve** publishes through the existing `publishModule` path into
> `og_custom_modules`.

---

## 1. Create the Supabase table + RLS policy

In the Supabase dashboard → **SQL Editor**, run (this is the migration the app
ships with — `og_module_submissions`):

```sql
create table public.og_module_submissions (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  submitter_email     text,                 -- display-only (client-supplied); not trusted for auth
  name                text not null,
  description         text not null default '',
  framework           text not null default 'react' check (framework in ('react','html')),
  source              text not null,
  status              text not null default 'pending' check (status in ('pending','approved','rejected')),
  reviewed_at         timestamptz,
  published_remote_id uuid,                  -- the og_custom_modules id, set on approve
  check (char_length(source)      <= 200000),
  check (char_length(name)        <= 60),
  check (char_length(description)  <= 4000),
  check (char_length(coalesce(submitter_email, '')) <= 320)
);

alter table public.og_module_submissions enable row level security;

-- A SINGLE policy: the anon role may INSERT a fresh PENDING row, nothing else.
-- No select/update/delete policy exists, so the anon key can only submit — it can
-- never read, edit, or moderate the queue. The owner reads + approves/rejects with
-- the service-role key (Settings → Tab submissions), which bypasses RLS.
create policy "anon can submit" on public.og_module_submissions
  for insert to anon
  with check (status = 'pending' and reviewed_at is null and published_remote_id is null);
```

Why this is safe to expose the anon key for:

- RLS is **enabled** and the only policy is `for insert`, pinned to
  `status = 'pending'`. The anon key cannot `select` (the queue is private until
  the owner approves + publishes), `update`, or `delete`, and it cannot
  pre-approve a row.
- The `char_length` checks mirror the server-side `SubmitModuleBodySchema`
  validation, so an oversized body is rejected even if the proxy is bypassed.
- Unlike `og_custom_modules` (which has an `anon SELECT` policy so the
  marketplace is publicly listable), submissions have **no anon read** — only
  owner-approved code ever reaches the public table.

---

## 2. Set the server environment variables

The routes read these from the **server** process env (never the client):

| Variable                      | Required | Default                  | Notes                                                                                          |
| ----------------------------- | -------- | ------------------------ | ---------------------------------------------------------------------------------------------- |
| `SUPABASE_URL`                | yes      | —                        | Project URL (trailing slash optional).                                                         |
| `SUPABASE_ANON_KEY`           | yes      | —                        | The `anon` `public` key. Powers the **submit** (POST) path.                                    |
| `SUPABASE_SERVICE_ROLE_KEY`   | no       | —                        | **Owner-only.** Enables the **Tab submissions** review inbox + approve/reject. Also used by approve's publish. Never ship it. |
| `MODULE_ADMIN_EMAILS`         | no       | (`FEEDBACK_ADMIN_EMAILS`) | Optional comma-separated owner allowlist for reading the queue. Falls back to `FEEDBACK_ADMIN_EMAILS` when unset. |
| `SUPABASE_SUBMISSIONS_TABLE`  | no       | `og_module_submissions`  | Override only if you renamed the table.                                                         |

- If **either** required var (`SUPABASE_URL`, `SUPABASE_ANON_KEY`) is missing,
  submitting stays disabled (`POST` → 503, the tester's button reports it).
- `SUPABASE_SERVICE_ROLE_KEY` is **separate and optional**. When present the
  server can read + moderate: `GET /api/module-submissions/config` reports
  `canReview:true` and the **Settings → Tab submissions** inbox appears. Without
  it the inbox stays hidden and the review routes return `503`. **Only ever set
  this on your own machine's `.env.local` — never in a distributed build.**

```bash
# .env.local (owner machine only — gitignored)
SUPABASE_URL="https://abcdefgh.supabase.co"
SUPABASE_ANON_KEY="eyJ...your-anon-key..."
SUPABASE_SERVICE_ROLE_KEY="eyJ...your-service-role-key..."   # owner-only, enables review + publish
MODULE_ADMIN_EMAILS="you@example.com"                        # optional; defaults to FEEDBACK_ADMIN_EMAILS
```

### Restricting reads to a signed-in owner (`MODULE_ADMIN_EMAILS`)

By default the service-role key alone gates reading — anything that can reach the
loopback port can read the queue. To tighten this, set `MODULE_ADMIN_EMAILS` to a
comma-separated owner allowlist: the review routes (and `canReview` in `/config`)
then **additionally require a signed-in app account** (Settings → account,
Google/GitHub OAuth) whose email is on the list; everyone else gets `403`. Match
is case-insensitive. When unset it falls back to `FEEDBACK_ADMIN_EMAILS`, so an
owner who already gated feedback doesn't have to set a second variable. The
service-role key is still required either way — this is an identity layer on top.

The dev scripts load `.env.local` automatically
(`tsx watch --env-file-if-exists=.env.local`). A fresh clone with no env still
boots, with submissions simply disabled.

---

## 3. Reviewing submissions

Set `SUPABASE_SERVICE_ROLE_KEY` on your own machine, then open **Settings → Tab
submissions**. It lists pending submissions newest-first — name, description,
framework, submitter — with a Refresh button, and the settings gear shows a dot
when new submissions have arrived since you last opened it. Expand **View code**
to see the submitted source rendered in the same sandboxed iframe a custom tab
runs in (scripts only, no host access) plus the raw source.

- **Approve & publish** copies the source into `og_custom_modules` via the
  existing service-role publish path (an INSERT — a fresh marketplace row), then
  stamps the submission `approved` and links it to the new id. Everyone can now
  install the tab from the marketplace ("+" picker → "Browse the marketplace").
- **Reject** marks the submission `rejected` and drops it from the queue.

The list shows the **newest 200** pending rows (the count badge appends `+` when
more exist); older/approved/rejected rows are visible in the Supabase Table
Editor (which uses the service role and bypasses RLS).

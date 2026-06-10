# In-app feedback — setup

OPEN GROUND has an optional **Send feedback** affordance (toolbar, top-right).
Because the app ships to strangers and its Hono server is loopback-only,
feedback does **not** go from the browser straight to a database. Instead:

```
browser  ──POST /api/feedback──▶  local Hono server  ──REST insert──▶  Supabase
          (message + optional email)   (adds app_version, os, project_count;
                                        holds the anon key in SERVER env only)
```

The Supabase anon key **never** enters the client bundle. The route reads it
from server-side environment variables. **If those vars are unset the feature
degrades gracefully** — the toolbar entry is hidden and `POST /api/feedback`
returns `503 feedback not configured`. So the public build is safe with **no
credentials baked in**; you only turn feedback on for the builds you run with
the env set.

This is a *single, owner-run* integration: you create one Supabase table with
an **insert-only** RLS policy for the `anon` role, then set two env vars.

---

## 1. Create the Supabase table + RLS policy

In the Supabase dashboard → **SQL Editor**, run:

```sql
-- Table -----------------------------------------------------------------
create table public.feedback (
  id            uuid        default gen_random_uuid() primary key,
  created_at    timestamptz default now(),
  message       text        not null check (char_length(message) <= 5000),
  email         text,
  app_version   text,
  os            text,
  project_count int
);

-- Row Level Security ----------------------------------------------------
alter table public.feedback enable row level security;

-- A SINGLE policy: allow INSERT for the anon role, nothing else.
-- No select / update / delete policy exists, so with RLS enabled the anon
-- key can ONLY insert rows — it can never read, edit, or delete feedback.
-- (Submissions are read by YOU in the Table Editor, which uses the service
--  role and bypasses RLS — see step 4.)
create policy "anon can insert feedback"
  on public.feedback
  for insert
  to anon
  with check (true);

-- Index ----------------------------------------------------------------
-- Both owner read paths (the inbox list and the unread-count poll) sort /
-- filter on created_at, so index it descending.
create index if not exists feedback_created_at_desc
  on public.feedback (created_at desc);
```

Why this is safe to expose the anon key for:

- RLS is **enabled** and the only policy is `for insert`. The anon key cannot
  `select` (read other people's feedback), `update`, or `delete`.
- The `char_length(message) <= 5000` check mirrors the server-side validation,
  so an over-long body is rejected even if the proxy is bypassed.

---

## 2. Get your project URL + anon key

Supabase dashboard → **Project Settings → API**:

- **Project URL** → e.g. `https://abcdefgh.supabase.co`
- **Project API keys → `anon` `public`** → the anon key

> For the **collect** (POST) path use the **anon** key. The **service_role** key
> is only for the optional owner-only **read** path (step 3 /
> `SUPABASE_SERVICE_ROLE_KEY`); it bypasses RLS and must stay on your own machine
> — never in any distributed build.

---

## 3. Set the server environment variables

The route reads these from the **server** process env (never the client):

| Variable                     | Required | Default    | Notes                                                       |
| ---------------------------- | -------- | ---------- | ----------------------------------------------------------- |
| `SUPABASE_URL`               | yes      | —          | Project URL (trailing slash optional).                      |
| `SUPABASE_ANON_KEY`          | yes      | —          | The `anon` `public` key. Powers the **collect** (POST) path.|
| `SUPABASE_SERVICE_ROLE_KEY`  | no       | —          | **Owner-only.** Enables the in-app **Incoming feedback** inbox (read path). Never ship it. |
| `FEEDBACK_ADMIN_EMAILS`      | no       | —          | Optional comma-separated owner allowlist. When set, reads also require a signed-in app account on the list (see below). |
| `SUPABASE_FEEDBACK_TABLE`    | no       | `feedback` | Override only if you renamed the table.                     |

If **either** required var (`SUPABASE_URL`, `SUPABASE_ANON_KEY`) is
missing/empty, feedback stays disabled (entry hidden, `POST` → 503). Both must
be set to enable submitting.

`SUPABASE_SERVICE_ROLE_KEY` is **separate and optional**. When it's also present
the server can read submissions back: `GET /api/feedback/config` reports
`canRead:true` and the **Settings → Incoming feedback** inbox appears so you can
read feedback inside the app. Without it the inbox stays hidden and
`GET /api/feedback/list` returns `503`. **Only ever set this on your own
machine's `.env.local` — never in a distributed build or committed file.** The
service-role key bypasses RLS, so the rows it can read it could also delete;
keep it loopback-side. The server returns rows to the local client but never the
key itself.

```bash
# .env.local (owner machine only — gitignored)
SUPABASE_URL="https://abcdefgh.supabase.co"
SUPABASE_ANON_KEY="eyJ...your-anon-key..."
SUPABASE_SERVICE_ROLE_KEY="eyJ...your-service-role-key..."   # owner-only, optional
FEEDBACK_ADMIN_EMAILS="you@example.com"                      # optional identity gate
```

### Restricting reads to a signed-in owner (`FEEDBACK_ADMIN_EMAILS`)

By default the service-role key alone gates reading — anything that can reach the
loopback port can read submissions. Feedback rows hold third-party emails (PII),
so you can tighten this: set `FEEDBACK_ADMIN_EMAILS` to a comma-separated list of
owner emails. When set, `GET /api/feedback/list` and `/unread` (and `canRead` in
`/config`) **additionally require a signed-in app account** (Settings → account,
Google/GitHub OAuth) whose email is on the list; everyone else gets `403` and the
inbox/dot stay hidden. Match is case-insensitive. Leave it unset to keep the
service-key-only behaviour. The service-role key is still required either way —
this is an identity layer on top, not a replacement (the email used must be the
one on your Google/GitHub account you sign in with).

**Dev** (`npm run dev` / `npm run dev:server` / `npm run electron:dev`):

Create a gitignored `.env.local` in the repo root (matched by `.gitignore`'s
`.env*.local`):

```bash
SUPABASE_URL="https://abcdefgh.supabase.co"
SUPABASE_ANON_KEY="eyJ...your-anon-key..."
```

The dev scripts load it automatically — each runs
`tsx watch --env-file-if-exists=.env.local server/index.ts`, which uses Node's
native env-file loader. **No `set -a; source .env.local` needed.** If the file
is absent (a fresh clone) the server still boots, with feedback simply disabled.
You can still override per-invocation by exporting the vars inline before
`npm run dev`.

**Packaged Electron app:** set the vars in the environment that launches
Electron (the server is forked by `electron/main.js` and inherits its env).
For a personal build, exporting them in your login shell before launching the
`.app` is enough. **Do not commit the key** — the repo and the public `.dmg`
must ship without it.

---

## 4. Where to read submissions

**In the app (recommended):** set `SUPABASE_SERVICE_ROLE_KEY` (step 3) on your
own machine, then open **Settings → Incoming feedback**. It lists submissions
newest-first — message, email, `app_version`, `os`, `project_count` — with a
Refresh button, and the settings gear shows a dot when new feedback has arrived
since you last opened it. This section only appears when the service key is
configured (`canRead:true`), so it never shows on a build you distribute. The
list shows the **newest 200** rows (the count badge appends `+` and a note when
more exist); read older rows in the Supabase table editor below.

**In Supabase:** dashboard → **Table Editor → `feedback`** works too. The Table
Editor uses the service role, so it sees every row regardless of the insert-only
anon policy — handy as a fallback or for bulk editing.

---

## 5. (Optional) Pipe new feedback to Slack

Supabase dashboard → **Database → Webhooks → Create a new hook**:

- **Table:** `feedback`
- **Events:** `INSERT`
- **Type:** HTTP Request → `POST` to your Slack **Incoming Webhook** URL.

A minimal Slack payload shape (set in the webhook's HTTP body, or via an Edge
Function if you want to format the columns):

```json
{ "text": "New OPEN GROUND feedback: <message> (<email>)" }
```

For richer formatting (pulling `app_version` / `os` into the message) point the
webhook at a small Supabase **Edge Function** that builds the Slack block kit
payload from the inserted row. The plain webhook above is enough to get a ping.

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

> Use the **anon** key, never the **service_role** key. The service_role key
> bypasses RLS and must stay out of any distributed build.

---

## 3. Set the server environment variables

The route reads these from the **server** process env (never the client):

| Variable                  | Required | Default    | Notes                                  |
| ------------------------- | -------- | ---------- | -------------------------------------- |
| `SUPABASE_URL`            | yes      | —          | Project URL (trailing slash optional). |
| `SUPABASE_ANON_KEY`       | yes      | —          | The `anon` `public` key.               |
| `SUPABASE_FEEDBACK_TABLE` | no       | `feedback` | Override only if you renamed the table.|

If **either** of the two required vars is missing/empty, feedback stays
disabled (entry hidden, `POST` → 503). Both must be set to enable it.

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

Supabase dashboard → **Table Editor → `feedback`**. Each row carries the
message, optional email, and the server-added `app_version`, `os`, and
`project_count` metadata. The Table Editor uses the service role, so it sees
every row regardless of the insert-only anon policy.

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

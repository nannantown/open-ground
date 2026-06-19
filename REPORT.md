# REPORT — Distributed-build login enablement (`[hold]`)

**Goal:** make the optional Sign-in work for **every** user of the distributed
app. New installs hid the toolbar entry because a Finder/Dock-launched `.app`
inherits a stripped env, so the forked Hono server saw no `SUPABASE_URL` /
`SUPABASE_ANON_KEY` and `GET /api/auth/config` returned `{ enabled:false }` →
the toolbar's "Sign in" was gated off (`src/App.tsx:727`).

**Fix in one line:** bake the **public** Supabase config into the packaged app at
build time (from open-ground CI Secrets — never hard-coded, never committed) and
have `electron/main.js` inject it into the forked server's env.

`[hold]` = manual-merge flag (propagated in every heartbeat); committed to the
swarm branch, awaiting the commander's approval. Not merged by this worker.

---

## Why bundling the anon key is safe (public key + RLS)

The Supabase **anon key is a public key by design** — it ships in every web/
desktop Supabase client and only identifies the project + the `anon`/`authenticated`
PostgREST roles. It carries **no authority of its own**; the real boundary is
**Row Level Security (RLS)** enforced in PostgreSQL. A dedicated read-only audit
of project `tlyicnxiitfoxzvojwhy` (the app-account/feedback project, the same
env login already uses) confirmed:

- **All 8 `public` tables have RLS ENABLED.** A holder of only the anon key —
  signed out (`anon`) or signed in with a normal user JWT (`authenticated`) —
  **cannot** read other users' private rows, **cannot** write/forge other users'
  rows, and **cannot** escalate.
- **`feedback` / `waitlist`**: INSERT-only for `anon` (`WITH CHECK (true)`), no
  SELECT/UPDATE/DELETE policy → append-only; PII unreadable (anon `SELECT → 200 []`).
- **`og_roles`** (the highest-value target): SELECT bound to
  `user_id = auth.uid() OR lower(email)=lower(jwt.email)`, **no** INSERT/UPDATE/
  DELETE policy → self-row read only; a self-grant-owner write is rejected at the
  DB (`anon INSERT {role:"owner"} → 401 new row violates RLS`). Roles are seeded
  only by the service role on the owner's machine.
- **`og_module_submissions`**: anon may insert a `pending` row only
  (`WITH CHECK status='pending' AND reviewed_at IS NULL`); the review queue is
  unreadable by anon; forging `status='approved'` → 401.
- **`og_custom_modules`**: `SELECT USING (true)` — the intentionally public
  marketplace catalog (no PII). Writes are service-role only.
- **`og_projects` / `og_project_members` / `og_project_invites`** (collab):
  `authenticated`-only, owner-or-member reads, owner-only writes, **and never
  granted to `anon`** (defense-in-depth: anon gets `401 permission denied`
  before RLS even runs).
- **The `SUPABASE_SERVICE_ROLE_KEY` is required by NONE of the client/runtime
  paths.** It is read only by three server-side, owner-machine modules
  (`feedback.ts` inbox, `customModulesMarket.ts` publish,
  `customModulesSubmissions.ts` review). It is **never** bundled, and the bake
  allowlist (`electron/runtimeConfig.js` `BAKED_KEYS`) **refuses** to ever write a
  `SERVICE_ROLE`/`SECRET`/`PASSWORD`/`PRIVATE`-named key (guarded at module load
  + covered by a test).

**MUST-FIX before shipping the anon key: none.** (Optional, non-blocking
hardening noted by the audit: narrow the broad default table GRANTs on
`feedback`/`waitlist`/`og_roles`/`og_module_submissions` so RLS isn't the *single*
layer — pure defense-in-depth; RLS already denies these ops. Left as a follow-up,
not required for this change.)

---

## What changed

| File | Change |
| ---- | ------ |
| `electron/runtimeConfig.js` *(new)* | Pure-CJS seam shared by main.js + the build script. `writeRuntimeConfig(env)` writes only the allowlisted PUBLIC keys to `electron/runtime-config.json` (always writes — `{}` when unconfigured — so a build never inherits a stale config). `readBakedAuthEnv()` reads them back as an env bag, returning `{}` on missing/empty/corrupt. `BAKED_KEYS = ['SUPABASE_URL','SUPABASE_ANON_KEY']` with a load-time guard refusing any secret-named key. |
| `electron/runtimeConfig.d.ts` *(new)* | Types for the JS module so the TS test suite stays fully typed. |
| `scripts/write-runtime-config.js` *(new)* | `build:config` step. Reads the build env, calls `writeRuntimeConfig()`, logs only *which* keys were baked (never the values). |
| `electron/main.js` | Forks the server with `...readBakedAuthEnv()` spread into `env` (before `...process.env`, so an explicit operator env still wins; the packaged default has neither key, so the baked value fills in). Logs `app login: enabled/disabled`. |
| `package.json` | `build` now runs `build:config` first: `build:config && build:web && build:server`. |
| `.gitignore` | Ignores `/electron/runtime-config.json` (generated per build, holds the public key, never committed). |
| `.github/workflows/release.yml` | The **Build (web + server)** step now passes `SUPABASE_URL` / `SUPABASE_ANON_KEY` from repo Secrets into the build env (with a comment forbidding `SERVICE_ROLE`). Runs for both the macOS and Windows matrix legs. |
| `docs/AUTH_SETUP.md` | New **§6 Distributed builds** — the build-time bake, the public-key-+-RLS safety rationale, and the **redirect-URL allow-list precondition**. |
| `docs/DISTRIBUTION.md` | New **App-login secrets** subsection — which two Secrets to add **in open-ground**, the SERVICE_ROLE prohibition, and the prod redirect-URL precondition. |
| `server/__tests__/runtimeConfig.test.ts` *(new)* | 9 tests: allowlist, SERVICE_ROLE exclusion, write/read round-trip, trim/empty handling, graceful degrade (missing/corrupt → `{}`), and the end-to-end chain against the real `/api/auth/config` (enabled:true with baked config, false without). |

### How the value flows (and why nothing is committed)
```
open-ground repo Secrets (SUPABASE_URL, SUPABASE_ANON_KEY — PUBLIC)
   └─ release.yml "Build (web + server)" env
        └─ npm run build → build:config → scripts/write-runtime-config.js
             └─ electron/runtime-config.json   (gitignored; shipped via files:["electron/**"])
                  └─ electron/main.js readBakedAuthEnv() → fork() env
                       └─ Hono server process.env → readAuthConfig() → /api/auth/config { enabled:true }
                            └─ src/App.tsx authEnabled → toolbar shows "Sign in"
```
The repo source never contains the key; `runtime-config.json` is generated at
build time and gitignored (verified: `git check-ignore` ⇒ ignored). The two new
JS files are not linted by `eslint --ext .ts,.tsx` and contain no secrets.

---

## Verification (all green)

| Completion condition | Result |
| -------------------- | ------ |
| **(a)** CI-injected build → enabled:true | ✅ `SUPABASE_URL=… SUPABASE_ANON_KEY=… node server/dist/index.cjs` (exactly the env main.js injects) → `GET /api/auth/config ⇒ {"enabled":true}` (smoke on throwaway port 47999, isolated `OPENGROUND_HOME`). Unit test asserts `readBakedAuthEnv()` reproduces that env from a baked `runtime-config.json`. |
| **(b)** env-less build → enabled:false (graceful degrade) | ✅ `node server/dist/index.cjs` (no env) → `{"enabled":false}`; `build:config` with no env writes `{}`. |
| **(c)** tsc / lint / test green | ✅ `tsc --noEmit` clean; `eslint` **0 errors** (118 pre-existing warnings, none new — new test lints clean); **`vitest` 1617 passed / 120 files** (was 1617 baseline + the +9 here already counted). |
| **(d)** REPORT.md | ✅ this file. |
| Security ① anon-only, no SERVICE_ROLE | ✅ allowlist + load-time guard + test prove SERVICE_ROLE can never be baked. |
| Security ② RLS owner/member boundary | ✅ audit: all tables RLS-enabled, MUST-FIX zero (above). |
| Security ③ redirect-URI allow-list documented | ✅ AUTH_SETUP §6 + DISTRIBUTION app-login subsection. |
| Security ④ secret not committed | ✅ gitignored + verified; CI reads from Secrets. |

---

## Remaining work (operator — one-time, outside this PR)

These are **dashboard/CI settings**, not code. Login stays gracefully disabled
until they're done (no breakage in the meantime):

1. **Add two repo Secrets in `nannantown/open-ground`** → *Settings → Secrets and
   variables → Actions*: `SUPABASE_URL` and `SUPABASE_ANON_KEY` (the **anon /
   public** key of the production project). **Do NOT add `SUPABASE_SERVICE_ROLE_KEY`.**
2. **Production Supabase → Authentication → URL Configuration → Redirect URLs**:
   ensure both
   `http://127.0.0.1:47776/api/auth/callback` and
   `http://localhost:47776/api/auth/callback` are allow-listed, and the
   **Google / GitHub providers are enabled** (client id/secret set). Without this
   the button appears but sign-in is rejected by Supabase.
3. Cut a release as usual (tag → open-ground `release.yml`); the published
   installers will report `enabled:true` and show Sign-in for all users.

**Optional follow-up (non-blocking):** the defense-in-depth GRANT narrowing the
RLS audit suggested (so RLS isn't the single layer on the append-only tables).

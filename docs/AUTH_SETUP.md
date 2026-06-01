# Optional login setup (Google / GitHub via Supabase Auth)

OPEN GROUND ships with an **optional** "Sign in" entry in the toolbar. It is the
app's own account (a seam for future, not-yet-built billing — see
[BILLING_PLAN.md](./BILLING_PLAN.md)); it gates nothing today and the app works
fully without it.

The entry is **hidden** unless the server has Supabase env configured — exactly
like in-app feedback. **It reuses feedback's env: there is no new secret.** If
you already set up feedback ([FEEDBACK_SETUP.md](./FEEDBACK_SETUP.md)), you only
need to enable the providers (steps 1–4) — your `SUPABASE_URL` /
`SUPABASE_ANON_KEY` are already in place.

The flow is server-side authorization-code + PKCE running on the fixed loopback
Hono port. The OAuth redirect URI is **always**
`http://127.0.0.1:47776/api/auth/callback` in both dev and prod — no per-machine
or per-environment redirect to manage.

> Replace `<your-supabase-ref>` below with your project ref (the subdomain of
> your `SUPABASE_URL`, e.g. `tlyicnxiitfoxzvojwhy`).

---

## 1. Google Cloud Console — OAuth 2.0 client

1. Open <https://console.cloud.google.com/apis/credentials> (pick/create a project).
2. **Create credentials → OAuth client ID → Application type: Web application**.
3. Under **Authorized redirect URIs**, add exactly:

   ```
   https://<your-supabase-ref>.supabase.co/auth/v1/callback
   ```

   (This is **Supabase's** callback — Supabase then redirects on to OPEN GROUND.
   You do **not** put the loopback URL here.)
4. Save. Copy the **Client ID** and **Client secret**.

## 2. GitHub — OAuth App

1. Open <https://github.com/settings/developers> → **OAuth Apps → New OAuth App**.
2. **Homepage URL**: anything (e.g. `https://github.com/your/repo`).
3. **Authorization callback URL** — the same Supabase callback as Google:

   ```
   https://<your-supabase-ref>.supabase.co/auth/v1/callback
   ```
4. Register, then **Generate a new client secret**. Copy the **Client ID** and
   **Client secret**.

## 3. Supabase dashboard — enable the providers

In your Supabase project → **Authentication → Providers**:

1. **Google**: toggle on, paste the Client ID + Client secret from step 1, save.
2. **GitHub**: toggle on, paste the Client ID + Client secret from step 2, save.

## 4. Supabase dashboard — Redirect URLs (the loopback callback)

In **Authentication → URL Configuration → Redirect URLs**, **add both**:

```
http://127.0.0.1:47776/api/auth/callback
http://localhost:47776/api/auth/callback
```

(Supabase only redirects back to allow-listed URLs. The app always uses the
`127.0.0.1` form; the `localhost` alias is added for robustness.)

## 5. Server env (`.env.local`)

Ensure the server env has the same two vars feedback uses. **No new secret.**

```bash
SUPABASE_URL=https://<your-supabase-ref>.supabase.co
SUPABASE_ANON_KEY=<your-anon-public-key>
```

`.env.local` is gitignored — the anon key never enters the client bundle. The
server runs the entire OAuth + token exchange and persists the session to
`~/.openground/auth.json` (mode 0600). The browser/SPA only ever sees the public
user fields (id / email / name / avatar / provider), never a token.

Restart the dev server (or relaunch the app). The toolbar will now show the
**Account** entry, and `GET /api/auth/config` reports `{ "enabled": true }`.

---

## How to verify

1. `npm run dev` (or `npm run electron:dev`), open <http://127.0.0.1:5174>.
2. The toolbar shows an account icon. Click it → **Continue with Google / GitHub**.
3. A browser window opens to the provider; authorize. The tab shows
   "Signed in — you can return to OPEN GROUND" and closes itself.
4. Return to OPEN GROUND — the modal flips to your name / email / avatar.
   **Sign out** clears `~/.openground/auth.json`.

If the entry never appears, the server env isn't set (check step 5). If sign-in
fails, re-check the Supabase **Redirect URLs** (step 4) and provider
**client id/secret** (step 3).

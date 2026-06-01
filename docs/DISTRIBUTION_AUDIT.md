# OPEN GROUND — Distribution Readiness Audit

Audit + remediation pass to take OPEN GROUND from a single-author dogfood build
to something a third party can install, run, and (if they fork it) re-publish.

Status legend: ✅ fixed in this pass · 🔧 action remains for the publisher.

---

## 1. Findings + what was fixed

### 1.1 Update feed pinned to the author's private repo ✅

**Finding.** The in-app update banner and the electron-builder publish target
both pointed at `nannantown/PMmap` (a private repo named after an old
codename). A fork would silently check the original author's releases.

**Fixed.**
- `server/routes/misc.ts` — `RELEASES_REPO` is now
  `process.env.OPENGROUND_RELEASES_REPO || 'nannantown/open-ground'`. A
  re-publisher points the running app at their own repo by setting that env
  var; the public default is `nannantown/open-ground`.
- `package.json` — `build.publish.repo` changed from `PMmap` to `open-ground`
  (owner unchanged). This bakes the matching update feed into the bundle and is
  what `--publish` uploads to.
- The GitHub repo is **not** renamed by this change — it only re-points where
  the code *looks*. Creating/renaming the public repo is a publisher step
  (§2.1).

### 1.2 Signing identity hardcoded to the author's cert ✅

**Finding.** `package.json` `build.mac.identity` was
`"Koki Naniwa (A3FD22BRKP)"`, so any other builder's signing would fail (or
silently mis-target) unless they edited the manifest.

**Fixed.** Removed `build.mac.identity` entirely. electron-builder now uses its
standard auto-discovery (`CSC_IDENTITY_AUTO_DISCOVERY`, default on) to pick
whichever "Developer ID Application" cert is in the keychain; a builder with
several certs disambiguates with `CSC_NAME`. Documented in
`docs/DISTRIBUTION.md` §1.

### 1.3 Author Apple Team ID / Apple ID baked into docs + scripts ✅

**Finding.** The real Team ID `A3FD22BRKP` and `you@example.com` appeared as if
they were the values to use, in `docs/DISTRIBUTION.md` and
`scripts/sign-and-notarize.sh`.

**Fixed.** Replaced with clearly-labeled placeholders + fill-in comments:
- `docs/DISTRIBUTION.md` — the per-release env block now uses
  `APPLE_TEAM_ID="YOUR_TEAM_ID"` / `APPLE_ID="you@example.com"` with "fill in
  your own" comments and an optional `CSC_NAME` hint; the legacy
  `store-credentials` + `DEVELOPER_ID` examples use `YOUR_TEAM_ID` /
  `Your Name`.
- `scripts/sign-and-notarize.sh` — header comments now read the placeholders
  from `${APPLE_ID:-…}` / `${APPLE_TEAM_ID:-YOUR_TEAM_ID}` and tell the builder
  to use their own. The script already drove `DEVELOPER_ID` / `NOTARY_PROFILE`
  from env (no real secret was embedded in executable code).

### 1.4 No end-user README ✅

**Finding.** The repo had architecture docs (`CLAUDE.md`, `CONCEPT.md`) but
nothing aimed at a person who just downloaded the app.

**Fixed.** Added top-level `README.md`: one-line summary; prerequisites (macOS
arm64 **or** Windows x64; `claude` CLI installed + authenticated; active Claude
subscription — subscription-only, no API key); per-platform install (macOS:
download `.dmg` → Applications; Windows: run `.exe` → SmartScreen *More info →
Run anyway* → install); first launch (pick projects folder = `projectsRoot`,
confirm CLI, run a project); FAQ (no API key, where data lives, safety,
platform support, updates); and how to file feedback.

### 1.5 No Claude-CLI readiness signal ✅

**Finding.** OPEN GROUND spawns the local `claude` CLI inside a PTY. If the CLI
is missing, a run failed with a bare `command not found` buried in the terminal
scrollback — no up-front signal, no actionable message.

**Fixed (probe + hints + run-failure message; no first-run wizard).**
- `src/lib/server/claudeCli.ts` (new) — `probeClaudeCli()` runs
  `claude --version` (5s timeout, 10s cache, `force` to bypass). Presence-only;
  auth is interactive and out of scope.
- `server/routes/misc.ts` — `GET /api/claude-probe` (`?force=1` to re-check)
  returns `{ installed, version, message }`.
- `server/routes/run.ts` — `POST /api/run` pre-flights the probe and returns
  `503 { error, claudeMissing: true }` with a clear hint instead of letting the
  PTY fail cryptically.
- `src/lib/useClaudeProbe.ts` (new) — client hook (used by Settings +
  empty-state; `force` on explicit re-check).
- `src/components/canvas/SettingsPanel.tsx` — a "Claude Code CLI" section: green
  "detected (version)" check, or a red hint + **Re-check** button, plus a note
  that OPEN GROUND runs the local `claude` CLI and never uses an API key.
- `src/components/canvas/EmptyState.tsx` — first-run surface now warns loudly if
  the CLI is missing, else shows a quiet "needs the local `claude` CLI"
  reminder.
- `src/lib/useRuns.ts` + `src/App.tsx` — a refused run surfaces the server's
  message as a dismissable toast with an "Open settings" shortcut, so a no-op
  run never fails silently.

---

## 2. What remains for the publisher 🔧

These are operational / account-bound steps the code cannot do for you. The
build/publish **automation now exists** — CI workflows (`.github/workflows/
ci.yml` + `release.yml`), the Windows build scaffolding, and the Windows
`build/icon.ico` are all in place. The remaining steps are: (2.1) make the
public repo exist, (2.2) add the macOS signing Secrets, and (2.3) cut a
Release by pushing a tag.

### 2.1 Create (or rename) the public GitHub repo to `open-ground`

The code now defaults to `nannantown/open-ground`. Either:
- create a new public repo `open-ground` under the publishing account and push
  there, **or**
- rename the existing repo to `open-ground` and make it public.

The CI release pipeline publishes to **this same repo's** Releases, and both
the in-app banner and electron-updater read from it. If you publish under a
**different** owner/repo, set both:
- `package.json` `build.publish.owner`/`.repo`, and
- the `OPENGROUND_RELEASES_REPO=<owner>/<repo>` env for the running app.

### 2.2 Add the macOS signing + notarization Secrets to the repo

The CI release flow (see `docs/DISTRIBUTION.md` §0) signs + notarizes the
macOS build from **GitHub repo Secrets** — add these under the repo's
**Settings → Secrets and variables → Actions**:

- `CSC_LINK` — base64 of your **Developer ID Application** `.p12` export
  (`base64 -i DeveloperID.p12 | pbcopy`).
- `CSC_KEY_PASSWORD` — the password used when exporting that `.p12`.
- `APPLE_ID` — the Apple ID that owns the Developer ID cert.
- `APPLE_APP_SPECIFIC_PASSWORD` — app-specific password for notarytool.
- `APPLE_TEAM_ID` — your 10-char Apple Team ID.

`GITHUB_TOKEN` is auto-provided by Actions — no manual secret needed. The
**Windows** job needs **no secrets** (it ships unsigned). All this requires an
Apple Developer Program membership + a "Developer ID Application" certificate.

> For the local/manual `npm run dist` fallback you instead export your own env
> vars (`APPLE_TEAM_ID` / `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` /
> `GH_TOKEN`, optional `CSC_NAME`) — see `docs/DISTRIBUTION.md` §1–§2.

### 2.3 Cut a Release by pushing a `vX.Y.Z` tag

Bump `package.json` `version`, commit, then push a matching tag — that fires
`release.yml`, which builds both platforms and publishes the `.dmg` + `.exe`
to one Release:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

### 2.4 Out-of-scope / future hardening (not blocking distribution)

- **`spike/electron-skeleton/`** still contains the original author's Team ID
  in `package.json` / `SPIKE.md`. It is a throwaway prototype — **not built,
  shipped, or referenced by the app** — left intact as a historical record.
  Delete the `spike/` dir before open-sourcing if you'd rather not ship the
  reference at all.
- **Auth verification & first-run wizard.** The probe checks *presence*, not
  that the user is signed in or that the subscription is active (auth is
  interactive in the CLI's own TTY). A guided first-run wizard is explicitly
  out of scope for this pass.
- **Cross-platform — addressed (Windows), with a caveat.** Windows is now a
  real build target: the CI release pipeline builds a native Windows NSIS
  `.exe` (unsigned → SmartScreen bypass), the `build/icon.ico` is present, and
  several Windows code bugs are fixed (session-dir naming for `\`/drive-colon
  paths, path-separator splits, the Claude hook now invoked via `node`). The
  **remaining caveat** is that Windows has not been validated on real hardware
  — node-pty/ConPTY runtime and whether the `claude` CLI **subscription** path
  behaves identically still need a real Windows run to confirm. See
  `docs/DISTRIBUTION.md` §6. Linux / Intel-mac builds are still not wired.

---

## 3. Verification

All green on `feat/release-prep` at the time of this audit:

| Check               | Result                          |
| ------------------- | ------------------------------- |
| `npx tsc --noEmit`  | 0 errors                        |
| `npm run lint`      | 0 errors (104 pre-existing warnings, none in changed files) |
| `npm test`          | 268 passed (20 files)           |
| `npm run build`     | web + server bundles built OK   |
| `/api/claude-probe` | 200, correct payload (smoke)    |

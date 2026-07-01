# OPEN GROUND — Distribution

How to ship OPEN GROUND to other people's machines (macOS + Windows).

The `.app` you get from `scripts/make-app.sh` runs **on your own machine**
fine because macOS doesn't quarantine apps you built locally. The moment
that bundle is downloaded by another user, however, Gatekeeper will block
it as "from an unidentified developer" — they need a signed + notarized
version.

This doc walks through the **recommended CI-based release flow** (§0), the
one-time Apple setup it relies on (§1), the local/manual `npm run dist`
fallback (§2), how the app finds updates (§3), and the Windows story (§6).

---

## 0. CI-based release (recommended)

Cutting a release is **driven by pushing a git tag** — you don't build the
artifacts on your own laptop. Two GitHub Actions workflows live in
`.github/workflows/`:

- **`ci.yml`** — runs on every push / PR (lint, typecheck, tests, build) so
  `main` stays green.
- **`release.yml`** — triggers on a pushed tag matching `v*.*.*` (e.g.
  `v0.2.0`). It builds **both platforms in parallel on native runners** and
  publishes both artifacts to the **same** GitHub Release:
  - a **macOS** job on a `macos` runner produces a **signed + notarized
    arm64 `.dmg`** (+ `latest-mac.yml`),
  - a **Windows** job on a native `windows` runner produces an **NSIS
    `.exe`** (+ `latest.yml`). Windows is **unsigned** (see §6).

> ⚠️ **The release tag goes to `open-ground`, NOT `origin` (PMmap).** The
> signing secrets and the working `release.yml` live in **open-ground**; PMmap
> has no secrets, so `git push origin <tag>` fires a CI run that fails at the
> macOS signing + Windows build steps. `open-ground/main` is a **squashed clean
> history with no shared ancestry** to PMmap — each release is ONE snapshot
> commit `OPEN GROUND X.Y.Z` whose tree equals PMmap's tree. So you snapshot
> PMmap's tree onto open-ground with `commit-tree` (a plain `git push openground
> main` is impossible — unrelated histories).

```bash
# 1. Land code + bump package.json version on PMmap main (origin), as usual.
git add package.json && git commit -m "release: X.Y.Z"
git push origin <feature-branch>:main      # or however main is updated

# 2. Snapshot PMmap's tree onto open-ground's clean history, then tag THERE.
git fetch openground
SNAP=$(git commit-tree "main^{tree}" -p openground/main -m "OPEN GROUND X.Y.Z")
git push openground "$SNAP":main           # fast-forward on open-ground/main
git tag vX.Y.Z "$SNAP"
git push openground vX.Y.Z                  # pushing the tag to OPEN-GROUND fires release.yml
```

> Runners: `release.yml` pins **windows-2022**. The floating `windows-latest`
> moved to a VS2026 image where node-gyp can't find a usable Visual Studio,
> breaking node-pty's native rebuild — windows-2022 (VS2022 C++) is the
> known-good toolchain.

electron-builder creates the Release as a **DRAFT** — nothing is public (and
neither the landing download redirect nor electron-updater sees it) until you
publish. Once both CI jobs are green, write the release notes (bilingual,
`### English` + `### 日本語` sections — the in-app update banner and the
landing footer's "Release notes" link both surface them) and publish:

```bash
gh release edit vX.Y.Z --repo nannantown/open-ground \
  --notes-file notes.md --draft=false --latest
```

> **Before that publish, verify the built dmg.** Download the draft Release's
> macOS artifact and run `scripts/verify-dmg.sh <dmg> X.Y.Z [marker]` (see §4) —
> it confirms the bundle's version + arm64 slice from the dmg's **own `hdiutil`
> mount**, which is exactly the check the 2026-06-25 wrong-volume / Rosetta
> footguns broke (a phantom version misread → an /Applications downgrade). Only
> flip the draft `--draft=false` once it reports `verify-dmg: OK`.

That's it — no local signing, no Wine, no Windows hardware needed to *build*.
electron-builder's `--publish` uploads each runner's artifact to the Release
named after the tag. Both `latest-mac.yml` (macOS) and `latest.yml` (Windows)
land on that one Release, which is exactly what **electron-updater** and the
**in-app update banner** read (§3).

### Required GitHub repo Secrets (macOS signing only)

Set these in the repo's **Settings → Secrets and variables → Actions**. They
are consumed by the macOS job to sign + notarize; the Windows job needs **no
secrets** (it ships unsigned).

| Secret | What it is |
| ------ | ---------- |
| `CSC_LINK` | base64 of your **Developer ID Application** `.p12` export. Generate with `base64 -i DeveloperID.p12 \| pbcopy` and paste. |
| `CSC_KEY_PASSWORD` | the password you set when exporting that `.p12`. |
| `APPLE_ID` | the Apple ID that owns the Developer ID certificate. |
| `APPLE_APP_SPECIFIC_PASSWORD` | an app-specific password for `notarytool` (create at <https://appleid.apple.com/account/manage> → App-Specific Passwords). |
| `APPLE_TEAM_ID` | your 10-char Apple Team ID. |

`GITHUB_TOKEN` is **auto-provided** by Actions — there is no manual secret to
add for publishing the Release.

> **dev / CI safety:** if the Apple secrets are absent, the macOS job still
> builds an **unsigned** `.dmg` (electron-builder logs `skipped macOS
> notarization`) instead of failing the whole release. Add the secrets above
> to get a Gatekeeper-clean build.

<a id="app-login-secrets"></a>
### App-login secrets (optional — enables "Sign in" for all users)

To ship the optional Google/GitHub login (see [AUTH_SETUP.md](./AUTH_SETUP.md))
so it works on **every user's** install, add two more repo Secrets in
**open-ground** → *Settings → Secrets and variables → Actions*. `release.yml`'s
**Build (web + server)** step reads them and bakes them into the packaged app
(`scripts/write-runtime-config.js` → `electron/runtime-config.json`).

| Secret | What it is |
| ------ | ---------- |
| `SUPABASE_URL` | your project URL, e.g. `https://<ref>.supabase.co`. **Public.** |
| `SUPABASE_ANON_KEY` | the project's **anon / public** key. Public by design — safe to ship in the binary; the security boundary is Supabase **Row Level Security** (audited — see `REPORT.md`). |

> 🔒 **Never add `SUPABASE_SERVICE_ROLE_KEY` (or any other server-secret) to this
> build.** It is the admin key (full DB bypass) and must stay server-only. The
> bake allowlist in `electron/runtimeConfig.js` only ever ships the two public
> values above; anything secret-named is refused.

> ⚠️ **Prod Supabase precondition.** The loopback callback
> `http://127.0.0.1:47776/api/auth/callback` (+ the `localhost` alias) must be
> in the **production** project's Authentication → URL Configuration → Redirect
> URLs, and the Google/GitHub providers must be enabled there — otherwise
> sign-in is rejected even though the button shows. See
> [AUTH_SETUP.md §6](./AUTH_SETUP.md).

If these two Secrets are **absent**, the build writes an empty config and login
stays hidden — a clean graceful degrade, no failure.

> **Local `dist` note:** `build:config` reads the **shell** env, not `.env.local`
> (unlike `npm run dev`). To bake login into a local `npm run dist` / `dist:local`
> build, `export SUPABASE_URL=… SUPABASE_ANON_KEY=…` in the shell first — values
> that live only in `.env.local` are picked up in dev but **not** in a packaged
> build.

The CI path is the supported way to publish. The local `npm run dist`
(§2) / `npm run dist:win` (§6) commands remain documented as a **manual /
local fallback** — e.g. for a dry run, or publishing from a machine that
already holds your cert.

---

## 1. One-time setup (for the manual / local fallback)

You need:

1. **Apple Developer Program** ($99/year) — sign up at
   <https://developer.apple.com/programs/>.
2. **Developer ID Application certificate** — generate one in Xcode:
   Settings → Accounts → your Apple ID → Manage Certificates → `+` →
   "Developer ID Application". This installs into your login keychain.
   `package.json` no longer pins a `build.mac.identity`, so electron-builder
   **auto-discovers** whichever "Developer ID Application" cert is in your
   keychain (`CSC_IDENTITY_AUTO_DISCOVERY`, default on). If you have more than
   one and need to disambiguate, export `CSC_NAME="Developer ID Application:
   Your Name (TEAMID)"` — you sign with *your own* cert, not the original
   author's.
3. **App-specific password** for notarization — create at
   <https://appleid.apple.com/account/manage> → App-Specific Passwords →
   `+`. Call it e.g. "OPEN GROUND notary". You only see it once; copy it
   immediately.
4. **A GitHub token** with `repo` scope (for publishing the Release +
   `latest-mac.yml` that electron-updater reads). Export it as
   `GH_TOKEN`.

The modern path is **`npm run dist`** — electron-builder signs, notarizes,
staples, and (optionally) publishes in one command, reading the Apple
credentials from env vars. The legacy `scripts/sign-and-notarize.sh` is
kept as a manual fallback (it signs the `make-app.sh`-built bundle using a
keychain profile instead).

---

## 2. Manual / local fallback (`npm run dist`)

> **Prefer the CI flow in §0.** This section is the local-build escape hatch
> — useful for a dry run, or publishing from a machine that already holds
> your signing cert.

`package.json` carries everything electron-builder needs:

- `build.mac.notarize: true` — turns on notarization. The Team ID, Apple
  ID, and app-specific password come from env vars (below); electron-builder
  runs `notarytool` and staples the ticket automatically.
- `build.publish` — points at the public `github` repo (default
  `nannantown/open-ground`). This both bakes the update feed
  (`latest-mac.yml` / `app-update.yml`) into the bundle for electron-updater
  **and** lets `--publish` upload artifacts to the Release. A re-publisher
  edits `build.publish.owner` / `.repo` in `package.json` to their own repo
  (and sets the matching `OPENGROUND_RELEASES_REPO=<owner>/<repo>` env so the
  running app's in-app update banner queries the same place — see
  `server/routes/misc.ts`).

```bash
# 1. Bump the version in package.json (semver). Commit + tag.
git commit -am "release: 0.2.0"
git tag v0.2.0
git push --tags

# 2. Export YOUR OWN signing + notarization credentials. electron-builder reads
#    these directly — no keychain profile needed. Fill in your own values:
export APPLE_TEAM_ID="YOUR_TEAM_ID"           # 10-char Apple Team ID, e.g. ABCDE12345
export APPLE_ID="you@example.com"             # the Apple ID that owns the cert
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
#    (optional) disambiguate the signing cert if you have several:
# export CSC_NAME="Developer ID Application: Your Name (YOUR_TEAM_ID)"
#    (alternatively, an App Store Connect API key:
#     APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER)

# 3. Token so --publish can create/attach to the GitHub Release.
export GH_TOKEN="ghp_…"

# 4. Build → sign → notarize → staple → publish, in one command.
#    The Apple notary roundtrip adds 1–5 min.
npm run dist -- --publish always
```

`npm run dist` alone (no `--publish`) builds + signs + notarizes locally
without uploading — useful for a dry run. Drop the `--publish always` to
keep the artifacts in `dist-electron/` only.

**dev / CI safety:** when the signing certificate or the Apple env vars are
absent (e.g. a CI machine, or a plain local build), electron-builder logs
`skipped macOS notarization` and produces an unsigned bundle instead of
failing. Set `CSC_IDENTITY_AUTO_DISCOVERY=false` to force-skip signing on a
machine that happens to have a cert but shouldn't use it.

### Legacy fallback: `scripts/sign-and-notarize.sh`

Still works against a `scripts/make-app.sh`-built `OPEN GROUND.app`, using a
keychain profile rather than env vars:

```bash
# Fill in YOUR OWN Apple ID + Team ID:
xcrun notarytool store-credentials "openground-notary" \
  --apple-id "you@example.com" --team-id "YOUR_TEAM_ID" \
  --password "xxxx-xxxx-xxxx-xxxx"
scripts/make-app.sh
export DEVELOPER_ID="Developer ID Application: Your Name (YOUR_TEAM_ID)"
scripts/sign-and-notarize.sh
```

---

## 3. How the running app discovers + applies updates

Two layers:

**a) In-app banner (`GET /api/update/check`).** The Hono server queries the
GitHub Releases API (no auth, 60 req/hr per IP) and compares the latest
published tag against the bundled `package.json` version, returning:

```json
{
  "current": "0.1.0",
  "latest": "0.2.0",
  "hasUpdate": true,
  "releaseUrl": "https://github.com/.../releases/tag/v0.2.0",
  "publishedAt": "2026-06-01T10:00:00Z",
  "notes": "Release notes markdown…"
}
```

The UI surfaces this as a non-blocking banner: *"OPEN GROUND 0.2.0 is out —
release notes →"*.

**b) electron-updater auto-download (packaged builds only).** On launch (and
every 4h), the Electron main process calls
`autoUpdater.checkForUpdatesAndNotify()` against the GitHub feed baked in by
`build.publish`. It **auto-downloads** a newer release in the background,
then **notifies** the user (`update-downloaded`) with a "Restart now /
Later" dialog. It deliberately does **not** auto-restart: `quitAndInstall`
mid-run would kill an in-flight `claude` child / run queue, so applying the
update is an explicit user action. `autoInstallOnAppQuit` is disabled for the
same reason. This whole path is gated on `app.isPackaged`, so a dev run never
contacts GitHub or logs updater errors.

> **Restart-now ordering invariant (regression-guarded).** "Restart now" must
> tear the forked Hono server child down **before** calling `quitAndInstall()`.
> The `before-quit` handler reaps that child by `event.preventDefault()`-ing the
> quit; `quitAndInstall()` also triggers a quit, so if `before-quit` intercepts
> *that* one it replaces the install with a plain `app.quit()` and the update is
> downloaded but never applied — "Restart now" becomes a silent no-op (observed
> 2026-06-25, fixed in 0.11.8 / `cc529d9`). Tearing the server down first leaves
> `serverChild` null (it exited) or `killed` (SIGKILL flips the flag
> synchronously), so `before-quit`'s "are there live children?" predicate is
> false and it returns early without intercepting. The ordering and that
> predicate now live as pure functions in **`electron/autoUpdate.js`**
> (`applyDownloadedUpdate` / `hasLiveForkedChildren`), and
> **`server/__tests__/autoUpdate.test.ts`** locks both — reorder the teardown or
> drop the `killed` arm of the predicate and the suite goes red.

---

## 4. Validating a downloaded build before opening it

**Authenticity** (is this bundle genuinely signed + notarized?):

If you ship to someone else and they want to sanity-check the bundle is
genuine, they can run:

```bash
codesign --verify --deep --strict --verbose=2 "/Applications/OPEN GROUND.app"
spctl --assess --type execute --verbose "/Applications/OPEN GROUND.app"
xcrun stapler validate "/Applications/OPEN GROUND.app"
```

All three should succeed. If `spctl` reports "rejected", the bundle isn't
properly notarized — re-run step 2 above.

**Identity** (is this dmg really vX.Y.Z, arm64?) — use the script, not ad-hoc
shell:

```bash
scripts/verify-dmg.sh "OPEN GROUND-0.11.11-arm64.dmg" 0.11.11 swarmOrchestrator
```

It mounts the dmg, prints the bundle's `CFBundleShortVersionString` + Mach-O
arch, optionally greps a feature marker in the server bundle, and detaches —
exiting non-zero on a version mismatch or a missing feature marker, and **warning
(not failing)** on a missing arm64 slice (the Intel `--x64` dmg legitimately has
none, so that stays a heads-up, not an error). **Always verify through this
script** rather than eyeballing `/Volumes/…`, because two footguns
have bitten this exact step before (2026-06-25 release post-mortem; the memory is
`reference_og_dmg_verify_and_autoupdate`):

- **Wrong-volume mix-up.** Mounting several OG dmgs leaves multiple
  `/Volumes/OPEN GROUND …` volumes (macOS appends ` 1`, ` 2`). Picking one with
  `ls -d "/Volumes/OPEN GROUND"* | head -1` grabs an **unrelated, different-version**
  volume and misreads its version — that once produced a phantom *"v0.11.7 dmg
  actually contains 0.10.1"* and an /Applications **downgrade**. The script takes
  the mount point from **this attach's own `hdiutil` output** instead:

  ```bash
  attach_out=$(hdiutil attach -nobrowse -noverify -noautoopen "$DMG" 2>&1)
  VOL=$(printf '%s\n' "$attach_out" | grep -oE '/Volumes/.*' | tail -1)  # never `ls /Volumes | head`
  ```

- **Rosetta arch misread.** Under Rosetta 2 a shell runs as x86_64 on Apple
  Silicon, so **`uname -m` reports Intel** on an M-series Mac. Read the real
  hardware with `sysctl` and the artifact's arch with `lipo`, never `uname -m`:

  ```bash
  sysctl -n hw.optional.arm64        # 1 = Apple Silicon (untranslated)
  lipo -archs "/Volumes/…/OPEN GROUND.app/Contents/MacOS/OPEN GROUND"   # artifact slices
  ```

Both anti-footgun shapes are regression-locked by
**`server/__tests__/verifyDmgScript.test.ts`** — revert the script to `ls`-of-
`/Volumes` or `uname -m` and the suite goes red.

---

## 5. Future hardening (not yet done)

- **Auto-apply on quit** — inline self-update download is now wired via
  electron-updater (§3b), but it only auto-downloads + notifies; the
  restart is a manual button so it never kills an in-flight run. A future
  pass could auto-apply once the run queue is known idle.
- **Per-release CHANGELOG generation** from commit history.

---

## 6. Windows (UNSIGNED — built on native CI, not yet hardware-validated)

Windows is now a **real build target**: the CI release pipeline (§0) builds
the Windows NSIS `.exe` on a **native Windows runner** and publishes it to
the same GitHub Release as the macOS `.dmg`. The interactive-terminal code
paths carry Windows-specific branches (see below). What is **not** yet done is
end-to-end validation on real Windows hardware — so treat Windows as *shipping
but provisional*, not *fully verified*.

### How it's built

In CI (recommended), the `windows` job in `release.yml` runs
`electron-builder --win` natively — **no Wine, no cross-build**. Locally you
can still build it on a Windows machine with:

```bash
npm run dist:win   # npm run build && electron-builder --win  → NSIS .exe
```

`package.json` `build.win` targets `nsis` with an interactive installer
(`oneClick: false`, `perMachine: false`, `allowToChangeInstallationDirectory:
true`) and uses **`build/icon.ico`** (now present). `asar: false` is kept
(node-pty ships unpacked on every platform).

> Building Windows from macOS would need Wine and is **not** the supported
> path. Use the native Windows CI runner (§0) — it's also closer to the
> environment users actually run.

### Unsigned → SmartScreen (what end users see)

There is **no Windows code-signing certificate**, so the `.exe` is
**unsigned**. On first launch Windows SmartScreen shows a blue *"Windows
protected your PC"* dialog. To proceed, the user:

1. clicks **More info**, then
2. clicks **Run anyway**.

This is a one-time bypass per download. Document it for end users (the README
covers it) so the warning doesn't look like the app is broken or malicious.

### Obsolete: the batch-runner-era Windows fixes

An earlier version of this section listed Windows fixes to the **batch runner /
observer / verifier** — Claude-session-dir `\`/drive-colon normalization for
locating JSONL (`observer.ts` / `runner.ts` `toDirName`), path-separator splits
in the worktree/git logic, and `cmd.exe` milestone verification
(`verifier.ts`). **Those subsystems were deleted in the terminal-only purge**
(2026-06), so the fixes are moot: there is no batch runner, no JSONL observer,
and no milestone verifier left to make Windows-safe. The only execution path
now is the interactive PTY, whose Windows handling is the guards below.

### Platform guards already in place

- **`electron/main.js`** — the `zsh -lic` login-PATH probe is macOS-only
  (`process.platform === 'darwin'`); on Windows `resolveEnrichedPath()`
  returns `process.env.PATH` unchanged (a GUI-launched `.exe` inherits the
  user's registry PATH). The `lsof` port-conflict probe is skipped on
  Windows (no reliable one-liner; the generic error still shows). The prod
  server-fork + window-load path is platform-neutral.
- **`src/lib/server/terminal.ts`** — picks `powershell.exe` and drops the
  `-l` login flag on win32.
- **`src/lib/server/claudeTerminal.ts`** — the `claude` launch command is
  PowerShell-shaped on Windows (`$env:OPENGROUND_OWNED='1'; claude … ; exit`
  vs the POSIX `VAR=1 claude … ; exit`), with PowerShell single-quote
  escaping for the prompt argument (covered by `claudeTerminal.test.ts`).
- **`src/lib/server/hooksInstall.ts`** — the Claude Code hook is invoked via
  `node "<path>/openground-hook.js" <arg>` rather than a unix shebang (Windows
  has no shebang/exec-bit), and command quoting switches to double quotes for
  `cmd.exe` / PowerShell on win32.

### MUST-validate-on-real-Windows caveats (genuinely unverified)

The code paths exist and the obvious bugs are fixed, but the following have
**not** been exercised on real Windows hardware — do not assume they work
until someone runs them:

- **node-pty / ConPTY runtime**: PTY spawn of `powershell.exe` + interactive
  `claude` under ConPTY is untested. PTY exit signalling, resize, and Ctrl-C
  (`\x03`) behaviour may differ from the macOS path it was developed
  against.
- **`claude` CLI on Windows**: assumes `claude` (or `claude.cmd`) is on the
  user's PATH and runs interactively under ConPTY. Unverified that the
  **subscription** path behaves identically — i.e. that the CLI's
  subscription/TTY billing flow applies the same way on Windows as on macOS.
- **PowerShell command quoting**: multi-line prompt arguments with embedded
  quotes/newlines, typed through a PTY-driven PowerShell command line, are
  fragile and unverified. May mangle prompts.

These are the honest open items. Until a real Windows run confirms them,
Windows is best treated as a community-supported best-effort build, not a
guaranteed-working platform.

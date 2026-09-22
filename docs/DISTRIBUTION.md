# OPEN GROUND — Distribution

How to ship OPEN GROUND to other people's machines (macOS + Windows).

The `.app` you get from `npm run dist` runs **on your own machine**
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
    `.exe`** (+ `latest.yml`). Windows is **unsigned by decision** (see §6).

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
#    ALWAYS author the snapshot as the GitHub noreply identity — public commits
#    must never carry a real name/email (PII hygiene, see below + PII_SCRUB_RUNBOOK.md).
#    fetch first: the parent MUST be the current openground/main (a stale ref as
#    parent would resurrect pre-reset history).
git fetch openground
SNAP=$(GIT_AUTHOR_NAME=nannantown GIT_AUTHOR_EMAIL=48724510+nannantown@users.noreply.github.com \
       GIT_COMMITTER_NAME=nannantown GIT_COMMITTER_EMAIL=48724510+nannantown@users.noreply.github.com \
       git commit-tree "main^{tree}" -p openground/main -m "OPEN GROUND X.Y.Z")
git push openground "$SNAP":main           # fast-forward on open-ground/main
git tag vX.Y.Z "$SNAP"
git push openground vX.Y.Z                  # pushing the tag to OPEN-GROUND fires release.yml
```

> **PII hygiene (2026-07 incident, permanent rules).** Personal information
> (real email / real name / home paths) must NEVER reach open-ground — neither
> in the tree nor in commit author/committer metadata:
>
> 1. **Tree**: `src/repoPiiGuard.test.ts` (runs in `npm test` = PMmap CI) scans
>    every tracked text file; the release gate requires the snapshot tree to be
>    identical to the tested `origin/main` tree; and `release.yml` re-runs the
>    guard against the tag's own tree as the final line of defense before
>    building installers.
> 2. **Author metadata**: snapshot commits are authored as
>    `nannantown <48724510+nannantown@users.noreply.github.com>` via the env
>    overrides above — never as the local `git config` identity.
> 3. **History reset (2026-07-14)**: open-ground's main + all 46 tags were/are
>    to be repointed onto a single clean root snapshot commit to purge PII from
>    all published history, keeping every Release asset (dmg/exe/yml) and the
>    electron-updater feed intact. Full runbook, actor split (force ops are
>    user-only), rollback and GitHub-cache purge steps:
>    **`docs/PII_SCRUB_RUNBOOK.md`**. After that reset, main remains a linear
>    snapshot chain and normal FF-only releases continue from the new root —
>    no force pushes needed again.

> Runners: `release.yml` pins **windows-2022**. The floating `windows-latest`
> moved to a VS2026 image where node-gyp can't find a usable Visual Studio,
> breaking node-pty's native rebuild — windows-2022 (VS2022 C++) is the
> known-good toolchain.

> **⚠ 2026-08-13 訂正(現物が正 — 00-INDEX §6-4 の規則で本段落を実態に合わせた)**:
> 下の旧記述「electron-builder はドラフトを作り、人間が publish するまで何も公開されない」は
> **タグ push 起動の release.yml では成立しない**。両ジョブは `--publish always` で回るため、
> **タグ起動なら CI が緑になった時点でリリースは自動的に公開される**(実測: v0.11.67〜
> v0.11.70 はすべて `github-actions[bot]` が published・draft:false)。含意: ①タグ経路で
> 公開を止めたいなら**タグを打つ前**に止める — 打った後に効く弁は無い。②「publish 前に
> dmg を検品」(下の §4 参照ブロック)は「publish 後すみやかに検品し、問題があれば
> release を削除して差し替える」に読み替える。
> **例外 = workflow_dispatch 起動**(同日実測・v0.11.71): タグが無いビルドは全アセットを
> 上げた**未タグのドラフト**で止まる。その場合は **`publish-draft.yml` を dispatch**
> (inputs: `tag` / `target_sha`=ビルドしたスナップショット sha / `notes_b64`)して公開する —
> 公開時に GitHub が `target_sha` にタグを作るので、タグの木 = 出荷物の木が保たれる。
> **(2026-08-28 更新: この二段目は自動化された。** release.yml 内の `publish` ジョブが
> 同じ処理を run 内で実行する — 両ビルド緑 + 資産7点の点呼合格 → タグ作成 + 公開、
> notes は `docs/release-notes/vX.Y.Z.md` から。ドラフトで止まるのは `publish=false`
> 指定時か、点呼失敗などの異常時のみで、そのときの復旧路として publish-draft.yml は存続。)
> (タグ push ができない環境 — 2026-08-13 のクラウドセッションの git プロキシはブランチ
> push は通しタグ push を黙って落とした — の正規の逃げ道でもある。)
>
> **⚠ クラウドセッションでは「タグ push が通らない」が既定だと思ってよい**(2026-08-17・
> v0.11.85 で再現、これで2回目)。落ち方は 2026-08-13 と違い**沈黙ではなく明示エラー**だった:
> `git push openground v0.11.85` が `RPC failed; HTTP 403` +
> `send-pack: unexpected disconnect` を4回とも返し、直後に `Everything up-to-date` と
> 続けて出す。**この "Everything up-to-date" は成功ではない** — 同じコマンドの中で
> `git ls-remote --tags openground vX.Y.Z` を必ず実行し、**行が返ることを確認するまで
> タグは無いものとして扱う**こと(ブランチ push は同セッションで通るので、「push できた」
> という感触は当てにならない)。
>
> したがってクラウドから切るときの手順は最初から dispatch 経路で組む
> (2026-08-28 に一段化。v0.11.82〜v0.11.101 は旧・二段 dispatch だった):
> ①リリースノートを `docs/release-notes/vX.Y.Z.md` にコミットしてから、スナップショットを
> `openground/main` に push(これは通る) →
> ②`release.yml` を **workflow_dispatch**(ref=`main`)→ **以降は無人**: 両ビルド成功後、
> 同 run 内の `publish` ジョブが資産の点呼 → タグ作成 → 公開(notes 添付)まで行う →
> ③待つ側は固定 sleep ではなく **`actions_get` を約30秒間隔でポーリング**し、run 完了 =
> 公開完了(実測 v0.11.101: 固定 sleep + 二段目 dispatch で毎回1〜2分の純調整コストが
> 出ていた)。run が失敗したらドラフトのまま残るので、従来どおり repair-release.yml /
> publish-draft.yml で復旧する。
>
> なお **`curl https://api.github.com/...` もクラウドセッションからは使えない**
> (`GitHub access is not enabled for this session` が返る)。CI の進行確認は GitHub MCP
> の `actions_list` / `actions_get` で行う。`gh` CLI も無い。

Once the run is green the release is already live, **with the body taken from
the committed `docs/release-notes/vX.Y.Z.md`** (the `publish` job attaches it —
commit the bilingual notes, `### English` + `### 日本語` sections, BEFORE
dispatching; the in-app update banner and the landing footer's "Release notes"
link both surface them). The command below remains for fixing notes after the
fact:

```bash
gh release edit vX.Y.Z --repo nannantown/open-ground \
  --notes-file notes.md --latest
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

**After publishing, ring the local app's bell (optional but free):**

```bash
curl -s -X POST http://127.0.0.1:47776/api/update/check-now || true
```

Installed apps discover a release at their next periodic check (hourly since
0.11.73; 4h before that). This nudge makes the app on *this* machine — the one
that just ran the release — check immediately instead, so it downloads within
seconds and applies at the next safe moment (`settings.autoUpdate` policy,
electron/autoUpdatePolicy.js). It only reaches this machine; everyone else
waits for their poll. Best-effort: if no app is running the curl just fails
quietly, and in dev the server answers `{"queued":false,"reason":"no-electron-parent"}`
because there is no Electron main process to ring (the relay is
src/lib/server/updateNudge.ts → fork IPC → electron/main.js, rate-limited to
one real check per minute).

The bell also takes `{"apply":"asap"}` as a JSON body — a **user command** that
waives the 30-minute away-timer for whatever this ring downloads (10-minute
window), restarting as soon as the server safety probe agrees nothing running
would be destroyed. The setting, work mode, and the safety probe are never
waived. The release runbook deliberately rings the PLAIN bell — a release must
not restart the app out from under someone using it; `asap` is for the person
who just asked for the update:

```bash
curl -s -X POST http://127.0.0.1:47776/api/update/check-now \
  -H 'content-type: application/json' -d '{"apply":"asap"}'
```

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

The path is **`npm run dist`** — electron-builder signs, notarizes,
staples, and (optionally) publishes in one command, reading the Apple
credentials from env vars. (A `scripts/sign-and-notarize.sh` used to sit
beside it as a manual fallback; it signed the `make-app.sh` bundle, and both
were removed on 2026-08-06 together with the shell launcher — see §2.)

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

### Removed: the shell launcher and its signer (2026-08-06)

`scripts/make-app.sh`, `scripts/openground-launch.sh`,
`scripts/openground-activate.sh`, `scripts/sign-and-notarize.sh` and
`scripts/entitlements.plist` are gone. They built and signed a shell-script
`.app` that predates Electron, and CLAUDE.md had them marked "kept only until
the Electron path is dogfood-proven". It is proven — the packaged app is the
owner's daily driver.

They were removed the day the leftover bundle caused a real problem: a built
`OPEN GROUND.app` sitting in the repo root registered the bundle id
`local.openground.launcher`, so macOS resolved the DISPLAY NAME "OPEN GROUND"
to IT rather than to `/Applications/OPEN GROUND.app` (`local.openground.app`).
Launching by name — from Spotlight, from a script, from anything that asks the
OS by name — started the dead launcher, which then showed
「OPEN GROUND is already running from another checkout」 and quit. A deprecated
artifact does not sit quietly; it shadows the real one.

**The keychain-profile setup those scripts documented is still worth keeping**,
because it is the fallback if the CI secrets ever lapse. electron-builder can
read the same credentials from env vars:

```bash
# One-time, if you want a keychain profile rather than env vars:
xcrun notarytool store-credentials "openground-notary" \
  --apple-id "you@example.com" --team-id "YOUR_TEAM_ID" \
  --password "xxxx-xxxx-xxxx-xxxx"

# The actual local build — signs, notarizes and staples in one step:
export APPLE_ID="you@example.com" APPLE_TEAM_ID="YOUR_TEAM_ID"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
npm run dist
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
update is an explicit user action. This whole path is gated on
`app.isPackaged`, so a dev run never contacts GitHub or logs updater errors.
(`autoInstallOnAppQuit` used to be described as "disabled for the same reason".
On macOS that was both wrong and load-bearing — see the next box.)

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

> **`autoInstallOnAppQuit` is NOT a policy knob on macOS (observed 2026-09-11,
> fixed in 0.11.107).** The owner restarted repeatedly and kept getting the same
> "0.11.106 has been downloaded" dialog: the update downloaded every time and
> was never applied. Cause: `main.js` set the flag from `settings.autoUpdate`,
> reading it as "install when the app quits". That meaning belongs to
> electron-updater's `BaseUpdater` (Windows NSIS / Linux). **`MacUpdater extends
> AppUpdater`, which has no quit handler at all** — on macOS the flag's only two
> readers are inside `MacUpdater` (v6.8.3, `out/MacUpdater.js`):
>
> - `updateDownloaded()` — `if (autoInstallOnAppQuit) nativeUpdater.checkForUpdates()`.
>   This is the hand-off that makes **Squirrel.Mac actually fetch + stage** the
>   downloaded zip. `else resolve([])`: Squirrel is told nothing.
> - `quitAndInstall()` — takes the quit path only `if (squirrelDownloadedUpdate)`.
>   Otherwise it registers a listener, kicks off `checkForUpdates()` and
>   **returns without quitting.**
>
> So with the flag false, "Restart now" does not restart. It starts a fetch +
> unpack that lands tens of seconds later — by which time the ordering invariant
> above has already torn the forked server down, leaving a window whose back-end
> is dead and which refuses to quit. Force-quit it and the staged update dies
> with the process; every launch repeats the loop. On macOS the flag must be
> **true, always** (`eagerSquirrelHandoff` in `electron/autoUpdate.js`); elsewhere
> it keeps its documented meaning and follows the user's setting.
>
> Two guards lock it, both measured red: the pure decision, and a **source pin**
> on `electron/main.js` asserting every `autoInstallOnAppQuit` assignment goes
> through `eagerSquirrelHandoff()` — the helper was never the part that broke,
> the call site was.

> **Wait for the OS installer; never tear the app down to wait (0.11.108).**
> Pinning the flag above moves staging to download time, so a click is *usually*
> instant — but a user who clicks within seconds of the dialog appearing still
> arrives before Squirrel has finished unpacking, and the mandatory
> teardown-first ordering then produced an unusable window that would not quit,
> for as long as unpacking took. Staging is therefore **observed, not guessed**:
> `electron.autoUpdater` (the native updater MacUpdater drives) emits
> `update-downloaded` when the update is staged, so `applyUpdateWhenStaged` waits
> on that with the app **whole — server alive, window usable** — and quits the
> instant it lands. The wait is visible (OS toast + indeterminate dock bar) and
> bounded by `STAGE_WAIT_MS`; on timeout the `install-not-ready` dialog says the
> app is fine, because it is. `installReadiness()` is the pure decision, and a
> source pin asserts `applyDownloadedUpdate` — which performs the teardown — has
> exactly ONE call site and that it sits inside the gate.

> **The updater has a memory (0.11.111).** Third sighting, 2026-09-13: "Restart
> now" → the app quit → it came back on the OLD version, and nothing on disk
> said why. Every updater line (ours AND electron-updater's) went to a packaged
> app's stdout; the OS installer's own log (`~/Library/Caches/local.openground.app.ShipIt/ShipIt_stderr.log`)
> had no entry at all — which only says where the failure was NOT. Now
> (`electron/updaterLog.js`): **every updater line lands in
> `~/.openground/updater.log`** (`autoUpdater.logger` is pointed at the same
> file, so Squirrel's proxy/request narrative and native errors are in it),
> capped at 512 KB; and **a pending-install marker** (`update-pending.json`,
> "quitting to install X, running Y") is written right before the install call
> so the **next boot** can compare itself to it — woke up as Y ⇒ the
> `install-failed` dialog, with the log's tail and an "Open log" button, instead
> of the same "downloaded" dialog as if nothing had happened. Diagnosing from
> a Terminal launch (`"/Applications/OPEN GROUND.app/Contents/MacOS/OPEN GROUND"`)
> still works — the logger mirrors to the console.

> **The install is a launchd job, and launchd can decline to run it (0.11.117).**
> The 2026-09-21 release operator found the cause behind the 2026-09-13 report:
> after "Restart now" the app quit and came back on the OLD version because
> *the registered app-specific ShipIt service had zero runs* — Squirrel.Mac had
> submitted its launchd agent (`local.openground.app.ShipIt`) and launchd never
> ran it; starting the service by hand and repeating the update worked
> (`docs/commander/PRODUCT-HANDOFF-2026-09-21.md`). macOS 13+ leaves a
> submitted launch agent in exactly that state when it is switched off under
> System Settings → General → Login Items & Extensions → *Allow in the
> Background*. The app cannot watch the install (it is gone by then), but it
> can read launchd: `electron/shipIt.js` parses `launchctl print-disabled
> gui/<uid>` (the Background Items override) and `launchctl print
> gui/<uid>/<label>` (loaded? runs? last exit?), `main.js` logs that line to
> `updater.log` at **boot** and **immediately before every install**, and
> `applyUpdateWhenStaged` runs a **pre-flight**: a disabled label gets one
> `launchctl enable`, is re-read, and if still disabled the app shows the
> `install-blocked` dialog (with the System Settings deep link and the
> one-line terminal fix) **instead of tearing itself down into nothing**.
> Uncertainty never blocks — off-macOS, a missing `launchctl`, a timeout or an
> unparseable answer all read as "proceed"; the boot check still reports a
> failed install afterwards. ⚠ Not yet verified on a real Mac in the disabled
> state — the parsers are pinned against launchctl's documented output shapes;
> the first real occurrence lands in `updater.log` either way.

> **…and it declines with the label ENABLED too, so the app starts the job
> itself (0.11.119).** 2026-09-22, 0.11.118 did not apply: the pre-flight line
> above read `loaded: state=not running, runs=0, last exit=(never exited);
> background-items flag=enabled`, the app quit, and the next boot logged
> `pending install 0.11.117 → 0.11.118 — failed`. ShipIt's own stderr log had
> **no line for the attempt** and `log show --predicate 'process == "ShipIt"'`
> was empty — launchd held the job and never started it, with no override to
> blame. Five failures across 0.11.112–0.11.118 (0.11.117 succeeded): it is
> **intermittent**, and the mechanism is in Squirrel.Mac itself — the job dict
> `SQRLShipItLauncher.m` submits carries **no `RunAtLoad`**, so it runs only
> when its Mach service is messaged. Who does the messaging, and what actually
> goes wrong, is spelled out in the next paragraph — read it before forming a
> model from this one.
>
> Note the mechanism precisely, because a plausible-sounding wrong version of it
> survived a full review round. Squirrel writes the request and submits the job
> in `-prepareUpdateForInstallation:` (`SQRLUpdater.m:1070-1089`) at
> **download/stage** time — from `-downloadAndPrepareUpdate:` (`:526`), before
> `update-downloaded` — and memoises the launcher for the session
> (`shipItSubmitted:400-424`), so there is exactly **one** submission per
> session. `quitAndInstall` runs only `-relaunchToInstallUpdate` (`:1092-1110`):
> re-read the request, set `launchAfterInstallation = YES`, write it back,
> terminate. It does **not** re-submit. And the job is not un-triggered — the
> submitted dict has no `RunAtLoad`, so Squirrel pokes its Mach service over XPC
> itself (`SQRLShipItLauncher.m:165`); what we observe is that poke **not
> producing a launch**.
>
> **Why the nudge is not at pre-flight.** Two reasons, both structural:
> (a) `applyUpdateWhenStaged` calls the pre-flight *before* it waits for
> staging, so at that moment the job may genuinely not exist yet — nothing to
> kick, nothing to conclude; and (b) `launchAfterInstallation` is only set to
> YES inside `quitAndInstall`, so a pre-flight kick would run an install that
> swaps the app and then **does not relaunch it** — the user quits into a
> version that never comes back up. So the pre-flight gate stays a
> disabled-label check and nothing more (`decideInstallPreflight`, unchanged).
>
> **The nudge lives at `will-quit`** (`kickstartShipItBeforeExit` →
> `kickstartShipItSync`): the job has been submitted since staging,
> `launchAfterInstallation` is now YES, and this process is about to exit — so
> the install both happens and relaunches, and nothing can come between. It is
> `execFileSync` (no event loop left) with a 2 s timeout, and deliberately
> **without `-k`** — killing a ShipIt that IS mid-install is the one destructive
> move here, and a kickstart on an already-running job is a harmless no-op,
> which is exactly why racing Squirrel's own XPC trigger costs nothing.
> ⚠ `app.exit()` bypasses `will-quit`, so a fatal-startup exit spends the pair's
> one recovery ticket without trying; accepted, because the ticket is written at
> ARM time precisely so a run that dies cannot re-arm forever.
>
> **Boot self-repair ARMS that same rail** (`armInstallSelfRepair`): a `failed`
> verdict arms the next quit's kickstart when the version the pending request
> points at is the one we failed to install. The version is read from
> **`ShipItState.plist` → `updateBundleURL`** (`parseShipItRequest`) —
> that file is named `.plist` but holds JSON (`SQRLShipItRequest.m:184-200`,
> Mantle → `NSJSONSerialization`; keys at `:63-70`), and it is the exact request
> a kicked ShipIt replays. NOT a walk of `update.*`: several of those can be
> present (other Squirrel apps on the owner's Mac held two-month-old ones), so
> readdir order could name a build the request does not point at, and a bundle
> nested one level deeper would read as "nothing staged" — disabling self-repair
> on a real machine while every test stayed green. It
> deliberately does **not** start ShipIt there: ShipIt blocks until every
> instance of the app has quit (`-waitForTermination`,
> `Squirrel/SQRLTerminationListener.m:51`), so a mid-session kick parks a
> process that then installs its
> staged build on whatever quit comes next — including one right after the user
> took the `install-failed` dialog's release-page route and installed something
> **newer** by hand. And because `launchAfterInstallation` is YES only between
> `quitAndInstall` and the next `-prepareUpdateForInstallation:`, a download
> landing *after* the arm rewrites the request with it back to NO — so the
> self-repair arm (and only that arm) re-reads the request at `will-quit` and
> stands down unless it still relaunches; otherwise the kick would install
> without reopening the app, which is the opposite of what its dialog promised.
> `decideArmedRecoveryAtQuit` closes the other half: at `will-quit`
> the bundle's own `CFBundleShortVersionString` must still equal the running
> version, or the kick stands down. While a retry is armed the `install-failed`
> dialog says so — "quitting the app finishes the install" — instead of pointing
> at the release page.
>
> Armed at most **once per `from`→`to` pair**, remembered in
> `~/.openground/update-recovery.json` (written before arming, never cleared on
> boot). Every decision is pure and pinned in `server/__tests__/shipIt.test.ts`
> (`decideBootRecovery` / `decideArmedRecoveryAtQuit` / `parseShipItRequest` / `versionFromPlistJson`),
> the wiring is source-pinned in `server/__tests__/autoUpdate.test.ts`, and
> `launchctl` only ever runs from `main.js`. ⚠ Unverified on a real Mac — the
> failure is intermittent by nature; the next occurrence lands in `updater.log`
> with its kickstart line either way, and a packaged-app pass belongs in an
> owner-attended acceptance check (`docs/VERIFICATION.md` §4.1).
>
> 【一次資料】 `man launchctl` (macOS 26.5.1 / Darwin 25.5.0) — `kickstart [-kp]
> gui/<uid>/<label>` "run the specified service immediately, regardless of its
> configured launch conditions", `-k` kills a running instance first;
> `github.com/Squirrel/Squirrel.Mac@master` (read 2026-09-22) —
> `SQRLShipItLauncher.m` (`SMJobSubmit`, `<bundle id>.ShipIt`, no `RunAtLoad`,
> XPC trigger at `:165`, launcher memoised `:400-424`), `SQRLUpdater.m`
> (`-prepareUpdateForInstallation:` `:1070-1089` called from `:526` at stage
> time; `-relaunchToInstallUpdate` `:1092-1110` only sets
> `launchAfterInstallation`), `SQRLShipItRequest.m` (JSON body `:184-200`, keys
> `:63-70`), `SQRLDirectoryManager.m` (`ShipItState.plist` path),
> `SQRLTerminationListener.m:51` (`-waitForTermination` — ShipIt blocks until
> every instance of the target bundle has quit).

> **Never let an install fail silently.** Both sightings of this defect
> (2026-06-25, 2026-09-11) presented identically to the user: a button that did
> nothing. `applyDownloadedUpdate` therefore arms a **watchdog before** calling
> the install step (anything after it is unreachable on the happy path, where the
> process is already gone). If the app is still alive `INSTALL_WATCHDOG_MS` later,
> it says so and offers the release page — the `install-stuck` dialog in
> `electron/updateMenu.js`. Whatever the next cause turns out to be, it cannot be
> invisible.

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

⚠ **A feature marker proves code SHIPPED, not that it RUNS.** Twice now a defect
existed *only* in the distributed build and *only* at runtime: the guard hook's
`createRequire(import.meta.url)` (0801 `dd311acc`) and the `require()` of the
ESM-only Agent SDK (0802 `e26d5efb` — shipped broken in 0.11.47/0.11.48, where
the SDK runtime never started once). A presence-grep passes in both cases. For
this class the useful check is the *absence* of a pattern:

```bash
# BOTH lines, and check both numbers — absence alone is not evidence.
#   require(…) must be 0: a CJS bundle cannot require() an ESM-only package on
#                         Node 20, which is what Electron 31 ships. Non-zero ⇒
#                         every SDK desk degrades to a PTY.
#   import(…)  must be ≥1: if the SDK is ever dropped from `external` in
#                         build-server.js it gets BUNDLED, and then NEITHER form
#                         appears — so a require-only check passes on a build
#                         whose lazy load has silently vanished.
# ⚠ `grep -c` exits 1 when the count is 0, so under `set -e` these must be run
#   as `|| true` (or with `set +e`) or the script stops on the healthy case.
grep -c 'require("@anthropic-ai/claude-agent-sdk")' server/dist/index.cjs || true   # want 0
grep -c 'import("@anthropic-ai/claude-agent-sdk")'  server/dist/index.cjs || true   # want >=1
```

⚠ **That grep is a source check, and the unit suite's runtime check is not run on
Electron's Node.** `sdkEsmLoadFromCjsBundle.test.ts` executes the bundle on the
dev machine's Node with `require(esm)` disabled — close, but *not* the Node 20.18
that Electron 31.7.7 embeds and forks. Both defects of this class were "green on
the dev Node, dead on the forked Electron Node", so once per release, on a machine
where the app is **installed**, run the real thing. The runtime that matters lives
inside the installed `.app` — **not** in `node_modules/electron`:

```bash
# Run from the repo root: the bare specifier resolves through ./node_modules,
# while the runtime executing it is the shipped app's Electron-as-Node.
ELECTRON_RUN_AS_NODE=1 "/Applications/OPEN GROUND.app/Contents/MacOS/OPEN GROUND" -e "
  console.log('node', process.versions.node, '| electron', process.versions.electron);
  try { require('@anthropic-ai/claude-agent-sdk'); console.log('require(ESM): OK') }
  catch (e) { console.log('require(ESM): FAIL', e.code) }
  import('@anthropic-ai/claude-agent-sdk').then(
    m => console.log('import(ESM): OK', m.USAGE_LIMIT_ERROR_PREFIXES.length),
    e => console.log('import(ESM): FAIL', e.code))"
# measured 2026-08-03, against the installed app at 0.11.54. Re-run this every release
# and record the version YOU measured (do not carry 0.11.54 forward) — read it with:
#   plutil -extract CFBundleShortVersionString raw \
#     "/Applications/OPEN GROUND.app/Contents/Info.plist"
#   → node 20.18.0 | electron 31.7.7
#     require(ESM): FAIL ERR_REQUIRE_ESM   ← diagnostic only (see below), NOT the gate
#     import(ESM): OK 12                   ← this line is the pass/fail
# ⚠ This is a DIFFERENT run from the 0.11.49 end-to-end record in
#   SDK_WORKER_MIGRATION_PLAN.md §12. There, `import()` was confirmed by an SDK worker
#   reaching `done` — not by this probe. Here both forms were probed directly.
```

⚠ **Install the build you are about to ship BEFORE running this.** The command resolves
the bare specifier through the **checkout's** `node_modules` but executes it on the
**installed** app's Electron-as-Node — so run it too early and you measure the *previous*
release's runtime and call it green. Concretely, check that the installed bundle's
version equals the version you are about to ship:

```bash
plutil -extract CFBundleShortVersionString raw "/Applications/OPEN GROUND.app/Contents/Info.plist"
grep -m1 '"version"' package.json
# the two must agree — measured 2026-08-03: 0.11.55  /  "version": "0.11.55",  ✓
```

If they diverge you measured the old runtime and the result means nothing — exactly the
"didn't measure the production arrangement" failure this section exists to prevent.
⚠ **Do not use the printed `electron` version as that check.** The `electron`
devDependency (`^31.7.0` ⇒ `31.7.7`) does not move between OPEN GROUND releases, so it
reads ✓ against a months-old `.app` — it has no teeth for the accident you are trying to
catch. The app version does move every release, which is why it is the one to compare.
⚠ Pointing the command at the `.app` mounted from the dmg you just built (instead of an
installed one) **has not been tried** — plausible, but **unverified as of 2026-08-03**.
Run it through once before relying on it.

**The pass/fail line is `import(ESM): OK` — nothing else.** A run that prints
`import(ESM): FAIL` — **or that prints neither line at all** (see the hollow-namespace
note below) — means the SDK cannot load in the shipped app at all: every SDK desk
will silently degrade to a PTY. That is a release blocker.

**The `require` line is diagnostic, not a gate.** On the currently shipped Electron
31.7.7 (Node **20.18.0**) `require(ESM): FAIL ERR_REQUIRE_ESM` is the *expected* value:
`require(esm)` is only **enabled by default** from Node **20.19 / 22.12 / 23.0** onward
(it was *added* earlier — 20.17 / 22.0 — but behind `--experimental-require-module`,
which we do not pass). So the failure is a fact about that runtime, not a verdict on
the fix. (It is also the mechanism of the
0.11.47/0.11.48 defect: the CJS bundle used to `require()` the SDK, so on this Node every
spawn died — hence the switch to dynamic `import()`.) **Move to an Electron whose embedded
Node is ≥ 20.19 or ≥ 22.12 and this line flips to `require(ESM): OK`. That is neither a
regression nor permission to go back to `require()`** — judge by the `import` line only.
The "20.18.0, not Node 20" correction is in `docs/VERIFICATION.md` §4.1 and
`docs/SDK_WORKER_MIGRATION_PLAN.md` §9/§12.

⚠ Do not assume the next Electron major clears that bar, and **do not read the bar off
the major at all** — a line can cross it mid-way. Checked mechanically against every
stable entry in `https://releases.electronjs.org/releases.json` (fetched 2026-08-03):

| Electron | initial release | final release | first release over 20.19 / 22.12 |
| --- | --- | --- | --- |
| 31 (ours) | 31.0.0 → node 20.14.0 | 31.7.7 → 20.18.0 | never |
| 32 | 32.0.0 → 20.16.0 | 32.3.3 → 20.18.1 | never |
| 33 | 33.0.0 → 20.18.0 | 33.4.11 → 20.18.3 | never |
| 34 | 34.0.0 → 20.18.1 | 34.5.8 → 20.19.1 | **34.5.0 → 20.19.0** |
| 35 | 35.0.0 → 22.14.0 | 35.7.5 → 22.16.0 | 35.0.0 — from day one |

So **32 and 33 never cross, not even at their final patch** (20.18.1 / 20.18.3) —
`require` keeps failing for the whole life of both lines. **34 crosses mid-line**: its
initial 34.0.0 still carries 20.18.1, but **34.5.0 reaches 20.19.0**. The first major
that is over the line **from its initial release** is **35.0.0 (Node 22.14.0)**.

That mid-line crossing is the point: a stable line keeps taking Node minor/patch bumps
after release (our own 31.7.7 carries 20.18.0 although 31.0.0 shipped 20.14.0), so the
Electron major alone cannot tell you which side of the line you are on. Read
`process.versions.node` off the probe output above.

The `12` is `USAGE_LIMIT_ERROR_PREFIXES.length` in the bundled SDK **0.3.220** — the
number itself is not the pass condition, it is only evidence that the module's exports
were really readable. Expect it to change when the SDK is upgraded.

⚠ **A resolved-but-hollow namespace does not print `undefined` — it prints nothing at
all.** If the import resolves but that export is missing, `m.USAGE_LIMIT_ERROR_PREFIXES`
is `undefined` and `.length` throws `TypeError: Cannot read properties of undefined
(reading 'length')` *inside* the `onFulfilled` callback — and a throw there is **not**
caught by the second argument of the **same** `.then` (an exception raised in
`onFulfilled` never reaches the `onRejected` of that same call). So **neither the `OK`
line nor the `FAIL` line is printed**: you get an unhandled-rejection stack and exit 1.
**The missing line is itself the failure.** Read the probe as: pass ⇔ a line beginning
`import(ESM): OK` appears — a `FAIL` line, a bare stack, or no output at all are all
failures.

⚠ **Do not decide this with a loose `grep 'import(ESM)'`.** The unhandled-rejection
stack **echoes the offending source line**, and that line contains the literal text
`import(ESM): OK` — so a substring grep matches on the *failing* run too and hands you a
false green. Anchor it (`grep '^import(ESM): OK'`) or just read the output.
(Measured 2026-08-03 with a hollow stand-in namespace: zero lines starting with
`import(ESM):`, one TypeError stack, exit 1 — while a substring grep for `import(ESM)`
still counted 1 hit, from the echoed source line.)

If you must probe from a scratch directory (no `node_modules` in cwd), borrow the
`.app`'s own — use the exact `ln -sfn` / `rm -f` forms in `docs/VERIFICATION.md` §4.1
and do not improvise, because that recipe has **two destructive footguns, one at setup
and one at teardown**: a bare `ln -s` re-run follows the existing link and writes a new
symlink *inside* the shipped `.app`'s `node_modules` (exit 0, no warning), and
`rm -rf node_modules/` — with the trailing slash — follows the link and deletes the
`.app`'s `node_modules` outright, after which the app will not start. (A third caution
there, forgetting to delete `probe.cjs`, only leaves `.scratch/` behind; it is untidy,
not destructive.)

(Measured once on 2026-08-03 against the packaged `.app` at 0.11.49 — a **different,
earlier run** than the probe above, and an end-to-end one rather than a two-form probe:
one worker dispatched with the runtime dial untouched came up `runtime:'sdk'` and reached commit —
docs/SDK_WORKER_MIGRATION_PLAN.md §12「実機実測ログ 2」. That was a single
owner-machine pass, not a suite run, and it does not retire the per-release probe.
⚠ What a checkout could not supply here was the **Electron binary, not the SDK**: on
this machine `node_modules/electron/dist` held only `LICENSE`,
`LICENSES.chromium.html` and `version` — why the binary is absent was not determined
(`electron` is an ordinary devDependency, so a fresh install may well have it).
Module resolution from the checkout is fine, which is exactly why the command above
pairs the checkout's `node_modules` with the installed `.app`. Use the BARE specifier
as written; requiring the unexported subpath `…/claude-agent-sdk/sdk.mjs` fails
`ERR_PACKAGE_PATH_NOT_EXPORTED` on every runtime and mimics this defect.)

`verify-dmg.sh` mounts the dmg, prints the bundle's `CFBundleShortVersionString`
+ Mach-O arch, optionally greps a feature marker in the server bundle, and detaches —
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

## 6. Windows (UNSIGNED **by decision** — built on native CI, not yet hardware-validated)

Windows is now a **real build target**: the CI release pipeline (§0) builds
the Windows NSIS `.exe` on a **native Windows runner** and publishes it to
the same GitHub Release as the macOS `.dmg`. The interactive-terminal code
paths carry Windows-specific branches (see below). What is **not** yet done is
end-to-end validation on real Windows hardware — so treat Windows as *shipping
but provisional*, not *fully verified*.

> **Commander operation (og-manage) is macOS / Git Bash only (decided
> 2026-07-27, GAP-8).** `og-manage` — the human-commander experience for
> swarm — is a single skill file (`skills/og-manage/SKILL.md`) whose
> procedures are bash/curl one-liners, and it breaks under a plain Windows
> PowerShell: there is no bash to run those lines, and in **Windows
> PowerShell 5.1 `curl` is an alias of `Invoke-WebRequest`** (per its
> reference page's Notes), so a `curl -s -X POST -d …` line binds to a
> different cmdlet that accepts different parameters — the curl flags do
> not bind, so it does not work as curl. (PowerShell 7 dropped that alias —
> its Notes list only `iwr`. A real `curl.exe` *does* ship with Windows 10
> — curl.se dates that to insider build 17063, so the first generally
> available release carrying it is 1803 — but under 5.1 that rescues
> nothing: PowerShell resolves names in the order **Alias → Function →
> Cmdlet → external executable**, so the built-in `curl` alias shadows any
> `curl.exe` on PATH. The bash half is unconditional either way.) This is a deliberate scope decision, not a bug: swarm is
> an owner-only hidden feature, so there are currently zero Windows users of
> the human-commander flow, and PowerShell support would mean rewriting
> every bash/curl call for a benefit no one collects yet.
>
> **The unattended engine is a narrower claim than "unaffected".** The
> engine's **server-side code** (worker spawn / integrate / janitor /
> overseer) carries **no bash dependency** — but the way a worker says
> "I'm done" is the **bash script `scripts/swarm-beat.sh`** (which a worker
> invokes at its installed path, `~/.claude/swarm-beat.sh`), the only writer
> of the heartbeat's `readyToMerge` flag (there is no HTTP worker-beat
> route — `POST /api/swarm/manager/beat` is the commander desk's own).
> Since `classifyWorker` promotes doing→review only on that `ready` signal
> (or on a dead PTY — but a `claude` TUI normally lingers after `/order`
> finishes, so the stall path dominates in practice), a worker on a
> bash-less Windows can commit but never
> self-declare: it stalls, gets reclaimed, and — having `commitsAhead > 0` —
> retreats to `blocked`. **Running the unattended loop on Windows therefore
> also needs Git Bash**, and even then this path, like the rest of §6,
> remains **unvalidated on real Windows hardware** (see the caveats below).
>
> **And Git Bash may not be sufficient.** The heartbeat directory's key is
> derived *twice, independently*, and the two derivations are assumed to
> produce the same string: bash's `sw_repokey()`
> (`scripts/openground-swarm-lib.sh:23-29`) hashes `cd "$cdir" && pwd -P`,
> while Node's `swarmRepoKey()` (`src/lib/server/swarmOrchestrator.ts:3917-3934`)
> hashes `canonicalize(resolve(projectPath, commonDir))` — the comment there
> names the coupling outright ("exactly like swarm-beat's `cd "$cdir" &&
> pwd -P`"). Under Git Bash (MSYS) `pwd -P` yields `/c/Users/…` while Node's
> `resolve` yields `C:\Users\…`, so the sha1 inputs — and therefore the keys
> — can diverge: the worker would write `~/.openground/swarm/<keyA>/` while
> the engine reads `<keyB>/`, and `ready` never arrives. `sw_repokey` also
> needs `shasum` on PATH; without it `scripts/swarm-beat.sh:27` exits 1 and
> **no heartbeat is written at all** (whether Git for Windows ships `shasum`
> is unconfirmed). Nobody has run any of this on Windows — **look here
> first** when someone does.
> The `swarm-beat.sh` worker-heartbeat script gets the same call as
> og-manage: no PowerShell port, same rationale. See
> [RELEASE_READINESS_GOALS.md §5 GAP-8](RELEASE_READINESS_GOALS.md) and
> [commander/00-INDEX.md](commander/00-INDEX.md).
> [SWARM_GA_AUDIT.md §1.4 A-1](SWARM_GA_AUDIT.md) reaches the same
> `breaks / critical` verdict on this bash dependency but **scopes it
> wider** — it argues the same hole opens for non-developer users on
> *macOS* too, and that GAP-8 should be widened to "every non-developer
> environment on every OS". Note that A-1's premise ① (`swarm-beat.sh` is
> the developer's private file, not shipped) is **obsolete**: the app
> self-installs it at boot (`swarmToolingInstall.ts`, and the script is
> listed in electron-builder's `build.files`), so **deployment is solved —
> only the bash dependency remains**. That correction was written back into
> the audit itself on 2026-07-28 (§1.4 A-1 and the NEW-4 row); its §0 🔴
> count and §5 availability row still carry the old premise and need a
> separate re-evaluation.

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

### Unsigned → SmartScreen (accepted policy, not an open TODO)

There is **no Windows code-signing certificate**, and **we are not buying
one** — owner decision, **2026-07-27** ("初回警告出すための証明書買わない").
The `.exe` therefore ships **unsigned**, and that is the intended steady
state, not a gap waiting to be closed. Do not add signing to `release.yml`
and do not spend on a certificate (incl. EV) without a *new* owner decision;
the question is only worth re-opening if Windows becomes a seriously-sold
platform. Tracking row: [RELEASE_READINESS_GOALS.md §5
GAP-4](RELEASE_READINESS_GOALS.md).

Because the binary carries no signature and no SmartScreen reputation, the
first launch shows a blue *"Windows protected your PC"* dialog reporting an
unrecognized publisher. To proceed, the user:

1. clicks **More info**, then
2. clicks **Run anyway**.

This is a one-time bypass per download; nothing else about the app is
impaired.

**Accepting the warning means disclosing it** — shipping an unexpected
warning silently is exactly what makes an app look broken or malicious. The
fact is stated, in plain language, in:

- **`landing/index.html`** (the public page) — hero download notes, **JA +
  EN**: the always-visible caveat says the build isn't signed and will warn on
  first launch; the Windows-only `.win-note` adds the *More info → Run anyway*
  walk-through.
- **`README.md`** §Install / §Platform support — the same one-time bypass.
- this section.

Keep those three in sync if the wording changes. **Do not** "fix" the warning
with installer tricks — the policy is to state it honestly.

> **Source note:** Microsoft Learn documents the *behavior* — a file or
> signature with no established reputation gets a warning ([Microsoft Defender
> SmartScreen
> overview](https://learn.microsoft.com/en-us/windows/security/operating-system-security/virus-and-threat-protection/microsoft-defender-smartscreen/),
> ms.date 2026-04-23) — but does not publish the dialog's verbatim strings.
> The quoted title and button labels above are the long-standing shipping UI
> text; treat them as approximate until confirmed on real hardware (GAP-3).

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
- **swarm worker heartbeat (needs Git Bash) and the commander flow**: the
  unattended loop's only completion signal is the bash script
  `~/.claude/swarm-beat.sh`, so running it on Windows requires **Git Bash**
  (decided 2026-07-27, GAP-8 — no PowerShell port). Neither that Git-Bash
  path nor the `og-manage` commander flow has been exercised on real
  Windows hardware; see the GAP-8 note at the top of this section.

These are the honest open items. Until a real Windows run confirms them,
Windows is best treated as a community-supported best-effort build, not a
guaranteed-working platform.

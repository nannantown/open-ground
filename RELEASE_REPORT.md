# RELEASE_REPORT — OPEN GROUND **0.9.1** release prep (`[hold]`)

**Status:** ✅ Safe prep done · dry-run green · ⏸ outward/irreversible steps **NOT executed** —
gated on commander approval. `[hold]` = manual-merge flag, propagated in every heartbeat.

**Worker:** `swarm/w2-0618-185214-91539` · **Date:** 2026-06-18 · **Author of release ops:** this worker (no feature code changed)

> ### ⚠️ Why this file is `RELEASE_REPORT.md`, not `REPORT.md`
> The repo's existing **`REPORT.md` is already taken** — it is the committed *distributed-build
> login* security audit that landed in `f7f6235`. It is **load-bearing**: both
> `docs/DISTRIBUTION.md` (App-login secrets subsection) and `.github/workflows/release.yml`
> link to `REPORT.md` for the Supabase **RLS** rationale. Overwriting it would break those two
> references and erase the audit record, so this release report is a **new** file. If you want it
> at `REPORT.md`, rename deliberately and update the two links — do **not** clobber.

---

## TL;DR

- **0.9.1 ships exactly one thing: the distributed-build login feature** (baked *public* Supabase
  config). It is the only delta since 0.9.0 — the 11 files of `f7f6235` (+492 / −1).
- **Done (safe, reversible, on this swarm branch):**
  - version bump `0.9.0 → 0.9.1` committed → `9374d91 release: 0.9.1` (package.json only).
  - this report (`RELEASE_REPORT.md`).
  - full verification **green** (tsc / build / lint / test).
  - `git commit-tree` snapshot **dry-run** validated against the *real* `openground/main` — **no push**.
- **NOT done — needs commander approval (outward to the PUBLIC repo & irreversible):**
  merge → `origin/main`, snapshot+**tag push** to `open-ground`, **publish** the draft Release.
  The exact, copy-pasteable commands are in **§② Runbook → RED ZONE** and **§④**.
- **Human-required before the headline feature actually works in 0.9.1** (graceful-degrades to
  hidden if missing, so not a *build* blocker): open-ground repo Secrets `SUPABASE_URL` +
  `SUPABASE_ANON_KEY`, and prod Supabase redirect-URL + provider config. See **§Blockers**.

---

## Repo topology (recap — see memory `release_repo_topology` + `docs/DISTRIBUTION.md` §0)

| Role | Remote | Repo | Visibility | History |
| ---- | ------ | ---- | ---------- | ------- |
| **Code body** | `origin` | `nannantown/PMmap` | private | the real dev history |
| **Distribution** | `openground` | `nannantown/open-ground` | **public** | squashed, **clean, UNRELATED** history — one snapshot commit per release |

The release **tag goes to `open-ground`, NOT `origin`** — the signing/CI Secrets and the working
`release.yml` live in open-ground; `origin` has no Secrets, so pushing a tag there would fire a
failing CI run. Because open-ground/main shares **no ancestry** with PMmap, you cannot
`git push openground main` (unrelated histories) — instead you snapshot PMmap's *tree* onto
open-ground's history with `git commit-tree`. Each release = one commit `OPEN GROUND X.Y.Z`
whose tree equals PMmap's tree.

---

## Completion conditions (the goal's 5, true/false)

| # | Condition | Status | Where |
| - | --------- | ------ | ----- |
| ① | PMmap→open-ground sync procedure identified + documented | ✅ true | §① (canonical source = `docs/DISTRIBUTION.md` §0, verified accurate) |
| ② | 0.9.1 tag-creation procedure organized | ✅ true | §② runbook (concrete, 0.9.1-filled) |
| ③ | Safe prep (version bump) done + dry-run | ✅ true | §③ (commit `9374d91`; build green; commit-tree dry-run validated) |
| ④ | Tag push / publish NOT executed; last command left for approval | ✅ true | §④ — RED ZONE fenced, nothing pushed to open-ground |
| ⑤ | Procedure / blockers / human-needs in a report | ✅ true | this file |

---

## ① PMmap → open-ground code-sync procedure  *(identified & documented)*

**Canonical source already in the repo:** `docs/DISTRIBUTION.md` **§0 "CI-based release (recommended)"**.
It is accurate — I validated the core `commit-tree` mechanism live (see §③). Reproduced here for
operability:

```bash
# Pre: the version bump is already on PMmap main (origin). open-ground/main is the
#      previous release snapshot. Run from a checkout that has BOTH remotes.
git fetch origin openground

# Snapshot PMmap main's TREE onto open-ground's clean (unrelated) history:
SNAP=$(git commit-tree "origin/main^{tree}" -p openground/main -m "OPEN GROUND X.Y.Z")
git push openground "$SNAP":main      # fast-forwards open-ground/main to the snapshot
git tag vX.Y.Z "$SNAP"
git push openground vX.Y.Z            # → fires release.yml on open-ground
```

`release.yml` (tag `v*.*.*`) then builds **both platforms on native runners** and publishes to one
GitHub Release as a **DRAFT**:
- **macOS** (`macos-14`, arm64 **+** x64): signed + notarized `.dmg`/`.zip` + `latest-mac.yml`
  (Secrets: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`).
- **Windows** (`windows-2022`): **unsigned** NSIS `.exe` + `latest.yml` (no Secrets).
- The **Build** step also bakes the *public* app-login config from Secrets `SUPABASE_URL` /
  `SUPABASE_ANON_KEY` (never `SERVICE_ROLE`). If absent, login degrades to hidden.

Nothing is public until you publish the draft (electron-updater + the landing download only see
**published** releases). Pipeline is **proven working**: v0.9.0 is published with arm64+x64 dmg/zip,
the exe, and both update manifests (checked live, 2026-06-17).

---

## ② 0.9.1 tag-creation runbook  *(organized)*

### 🟢 GREEN ZONE — already done by this worker (safe, reversible, on `swarm/w2-0618-185214-91539`)

1. `package.json` version `0.9.0 → 0.9.1` → commit **`9374d91 release: 0.9.1`** (package.json only,
   matching the `78031d8 release: 0.9.0` convention).
2. `RELEASE_REPORT.md` (this file).
3. Verification **green** + `commit-tree` snapshot **dry-run** validated (§③). **No remote was pushed.**

### 🔴 RED ZONE — approval-gated · outward to the PUBLIC repo · irreversible

> Run ONLY after the commander OKs. Use a checkout that has both `origin` (PMmap) **and**
> `openground` remotes (e.g. the primary checkout). git is done by Opus / the commander, never delegated.

```bash
# 0. Integrate this worker's branch into PMmap main (private — internal, not yet public).
#    Per swarm protocol: FF if main hasn't moved, else rebase the swarm branch on origin/main, re-verify, then FF.
git fetch origin
git merge-base --is-ancestor origin/main swarm/w2-0618-185214-91539 && echo "FF ok" || echo "rebase needed"
git push origin swarm/w2-0618-185214-91539:main          # FF the version bump + report onto PMmap main

# 1. Snapshot PMmap main's tree onto open-ground's clean history (unrelated histories ⇒ commit-tree).
git fetch origin openground
SNAP=$(git commit-tree "origin/main^{tree}" -p openground/main -m "OPEN GROUND 0.9.1")
git diff "$SNAP" origin/main          # sanity: MUST print nothing (identical tree)

# 2. Fast-forward open-ground/main to the snapshot (public main advances — outward).
git push openground "$SNAP":main

# 3. *** POINT OF NO RETURN #1 — tag push FIRES release.yml (builds installers) ***
git tag v0.9.1 "$SNAP"
git push openground v0.9.1

# 4. Wait for BOTH CI jobs green; CI creates a DRAFT Release v0.9.1.
gh run list  --repo nannantown/open-ground --limit 5
gh run watch --repo nannantown/open-ground   # or: gh release view v0.9.1 --repo nannantown/open-ground

# 5. *** POINT OF NO RETURN #2 — PUBLISH (public, user-facing; electron-updater + landing start serving) ***
#    Write bilingual notes first: "### English" + "### 日本語" (in-app update banner + landing read these).
gh release edit v0.9.1 --repo nannantown/open-ground \
  --notes-file notes.md --draft=false --latest
```

**The single last command (condition ④)** = step 5 `gh release edit … --draft=false --latest`.
Step 3 (`git push openground v0.9.1`) is the earlier irreversible trigger that *builds*; step 5 is
what makes 0.9.1 *public*. Everything in the RED ZONE is left **unexecuted** for the commander.

---

## ③ Safe prep + dry-run results

### Version bump (safe prep)
- `package.json` `0.9.0 → 0.9.1`, committed **`9374d91`** on this swarm branch. Reversible; not on main.
- `package-lock.json` root `version` is `0.8.0` (already 2 behind — it was `0.8.0` for the 0.9.0
  release too, and CI's `npm ci` shipped 0.9.0 fine). **Left as-is to match the package.json-only
  release convention; non-blocking.** Optional cleanup: `npm version --no-git-tag-version 0.9.1`.

### Verification — all green (delegated to an isolated subagent in this worktree)
| Check | Result |
| ----- | ------ |
| `npx tsc --noEmit` | **0 errors** |
| `npm run build` (the CI release gate: `build:config && build:web && build:server`) | **PASS** — web + server bundles built; output shows `openground@0.9.1` |
| `npm run lint` | **0 errors** (118 pre-existing warnings, none new) |
| `npm test` (`vitest run`) | **1617 passed · 0 failed · 120 files** |

### `commit-tree` snapshot dry-run (release mechanism, validated — **nothing pushed**)
Ran `SNAP=$(git commit-tree "HEAD^{tree}" -p openground/main -m "OPEN GROUND 0.9.1")` against the
freshly-fetched real `openground/main` (735918d, v0.9.0):
- **`git diff "$SNAP" HEAD` → 0 lines** — the snapshot's tree is **identical** to PMmap's tree. ✅
- **`parent(SNAP) == openground/main` (735918d)** — fast-forwardable. ✅
- **message `OPEN GROUND 0.9.1`**, stat = the 11-file auth-feature delta. ✅
- The SNAP object is a harmless **dangling** commit (no ref, gc'd). `openground` still has only the
  `v0.9.0` tag — **nothing was pushed.** ✅

> The frozen SNAP hash is *illustrative* — at release time the commander re-creates SNAP against the
> then-current `origin/main` (after the merge). What's validated is the **command + mechanism**, which
> reproduce exactly.

---

## ④ The approval-gated commands (point of no return)

Left **unexecuted**, ready for commander approval — full sequence in **§② RED ZONE**. The two
irreversible, outward steps:

1. `git push openground v0.9.1`  → fires `release.yml`, builds the installers (draft Release).
2. `gh release edit v0.9.1 --repo nannantown/open-ground --notes-file notes.md --draft=false --latest`
   → **publishes** 0.9.1 to all users (electron-updater auto-download + landing download redirect).

This worker pushed **nothing** to `open-ground` and did **not** merge to `origin/main`.

---

## Blockers / human-required (人手要否)

**Operator/dashboard steps the code/worker cannot do** — none block the *build*, but the first
group blocks the **headline login feature from actually working** in 0.9.1:

1. **open-ground repo Secrets** → *Settings → Secrets and variables → Actions*: add `SUPABASE_URL`
   and `SUPABASE_ANON_KEY` (the **anon / public** key of the production Supabase project). If absent,
   0.9.1 builds fine but **login stays hidden** (graceful degrade). **Never** add `SUPABASE_SERVICE_ROLE_KEY`.
   *(Cannot be verified from here — repo Secrets are write-only via the API. Confirm in the dashboard.)*
2. **Prod Supabase → Authentication → URL Configuration**: allow-list
   `http://127.0.0.1:47776/api/auth/callback` **and** `http://localhost:47776/api/auth/callback`,
   and enable the Google / GitHub providers. Without this the Sign-in button appears but auth is rejected.
3. **macOS signing Secrets** (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
   `APPLE_TEAM_ID`) — **inferred present** (v0.9.0 published signed dmg assets), but if a cert/password
   rotated, the mac leg would fall back to an unsigned dmg. Confirm before relying on a notarized build.
4. **The RED ZONE push/publish itself** — needs push access to `open-ground` + the publishing GitHub
   account (`gh` is currently authed as `nannantown` here) and a commander decision (`[hold]`).
5. **After CI green:** author bilingual release notes (`### English` / `### 日本語`) before `--draft=false`.

**Genuine MUST-FIX before shipping: none** found. All gates are green; the only true prerequisites are
the operator Secrets/dashboard items above (which only gate the *visibility* of login, not the build).

---

## What this worker did NOT do (guardrails honored)

- ❌ No push to `open-ground` (no main advance, **no tag**, **no publish**).
- ❌ No push/merge to `origin/main` (left for the commander per `[hold]`).
- ❌ No `npm run dist` electron-builder packaging run, no signing, no notarization (CI's job; would
  also need the cert locally).
- ❌ No feature/product code changed — release ops only (version string + docs).
- ✅ All work is on `swarm/w2-0618-185214-91539`, reversible, awaiting commander integration.

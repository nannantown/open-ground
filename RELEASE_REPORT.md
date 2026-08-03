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

---

## 0.11.50: 実機観測ログ 2026-08-03 — packaged `.app` の API を実測

> このセクションは本文書 H1(0.9.1 release prep)とはスコープが別(0.11.50 の実機観測)。
> 追記位置はカード指示に従い末尾。

`GET /api/health` に応答したのは **署名済みの packaged `.app`**
(`projectDir: /Applications/OPEN GROUND.app/Contents/Resources/app`, `version: "0.11.50"`)。
`:5174`(dev サーバ)は無応答(`curl -m 2 http://127.0.0.1:5174/` → 接続不可)で、dev インスタンスは
存在しない。**以下はすべてこの packaged `.app` 0.11.50 が応答した API から取得した値**
(2026-08-03 11:16〜11:20 JST・自分で取得。vitest のみワークツリー上で実行)。

- **占有409(経路の確認 + 単体テスト緑・実機の409応答そのものは未取得)**:
  `WorktreeOccupiedError` の catch(`server/routes/swarm.ts`)が worktree 占有中の再要求に
  `c.json({ error: e.message, worktree: e.worktree, occupied: true }, 409)` を返すコードパスを
  目視確認。対応テスト `src/lib/server/swarmWorktreeOccupancy.test.ts` を単体実行(コード変更なし):
  ```
  npx vitest run src/lib/server/swarmWorktreeOccupancy.test.ts
  ✓ src/lib/server/swarmWorktreeOccupancy.test.ts (10 tests) 7ms
  Test Files  1 passed (1)
  Tests  10 passed (10)
  ```
  実機に対して実際に409応答を受け取った記録ではない(そこは未実測)。
- **差し戻し通知(実機の journal を観測)**: 本カード自身
  (`swarm/docs-0-11-50-release-rep-0803-111619-f27f452f638e`)の review→doing 差し戻しが、
  この packaged `.app` の engine journal へ実際に記録されたことを
  `GET /api/swarm/orchestrator?path=<このプロジェクトの絶対パス>` の `log[]` で確認:
  ```
  2026-08-03T02:17:47.069Z  Board 側の差し戻し(review→doing)を観測 — worker を再作業中へ:
                             swarm/docs-0-11-50-release-rep-0803-111619-f27f452f638e
  2026-08-03T02:17:47.071Z  差し戻しを worker の卓に伝えました:
                             swarm/docs-0-11-50-release-rep-0803-111619-f27f452f638e
  ```
  同型のイベントがこのカードの2回目の差し戻しでも `02:19:02.144Z` / `02:19:02.146Z` に再発生。
  なお「伝えました」は engine の自己申告行であり単独では送達の証拠にならない
  (auto-memory の実測知見)。より強い裏取り: 実際に worker が再作業してコミット
  `1f29c04c` を作り、心拍ファイルが `updatedAt: 2026-08-03T02:20:20Z` へ動いた
  (`~/.openground/swarm/OPEN_GROUND-11c067a6/swarm-docs-0-11-50-release-rep-...json`)。
  journal の自己申告 + worker 側の実際の応答(コミット・心拍)が揃っており、「届いた」を
  観測できている。
- **SDK点火(この packaged `.app` 0.11.50 で1体点火 — 範囲限定の実測)**: 本カード自身の
  worker を `GET /api/swarm/workers` で確認したところ `runtime: "sdk"`,
  `sdkSessionId: "0cd5552b-e53b-4908-9695-292cc8f23690"` が入り `terminalId: null`
  (= PTY 経由ではなく SDK worker として起動)。この `.app` の `startedAt` は
  `2026-08-03T02:09:24Z`、本カードの dispatch は `2026-08-03T02:16:20Z`(journal 実測、上記)
  — dispatch は起動後なので、**この packaged `.app`(0.11.50)自身が SDK worker を1体
  点火した**ことが時系列で確定する。0.11.47/0.11.48 で「配布ビルドでは SDK worker が
  1体も起動しない」既知事象(auto-memory `reference_electron_node_cannot_require_esm_sdk.md`)
  の**逆**が本カードの worker 自身で観測できている。ただし配布アプリの受入手順一般
  (`docs/VERIFICATION.md` §4.1 の言う packaged `.app` を新規に起動して一巡させる検証)を
  網羅したものではない — 「1体の点火を実測」に範囲を限定する。

## 0.11.52: 散文質問(SDK worker → オーナー → 回答配達)の実機確認

> このセクションは本文書 H1(0.9.1 release prep)とはスコープが別(0.11.52 の実機観測)。

本カード自身の worker(この packaged `.app` 0.11.52、`sdkSessionId` 経由の SDK worker)が
末尾を「?」で終える散文の質問を出し、実際に本人(オーナー)から回答を受け取れることを、
別枠の作り物ではなく**この受入カードの実行そのもの**で確認した — 受け取った回答文が
`buildAnswerInjection`(`src/lib/server/swarmEscalations.ts:639-656`)の **`plainQuestion`
未指定の分岐**(4行構成: 先頭行「【本人からの回答】エスカレーションした質問に、本人
（オーナー）が回答しました。」→ `Q:` 行 → `オーナーの回答:` 行 → 末尾行「この回答を前提に、
ブロックされていた作業を再開してください。」)が生成する固定文言と一字一句一致することを
目視確認した。これは本カードの質問が worker 自身の起票(plainQuestion なし)だったために
通ったのがこの分岐だった、というだけで、`plainQuestion` 有りの分岐(5行構成: `Q:` 行の代わりに
「オーナーに表示された質問…」「あなたが出した元の質問:」の2行)は今回未実測。

実測できた具体値(再現用): escalation id `482d8f21-9301-4964-8ab0-0773c99c4352` /
runtime `sdk` / `sdkSessionId 7cb0f12f-8879-416e-a933-cc1a66a2d2a5` /
`createdAt 04:02:06.533Z` / `answeredAt 04:16:09.063Z`(answer "B") /
`injectedAt 04:16:09.161Z`。

`swarmSdkQuestions.test.ts` の16本は本番の `sdkRecentOutputHead`/`renderSdkTail` builder で
組み立てた fixture による単体検証(手書きの模造 head ではない — それを殺す番人がある)。
本カードは fixture を介さず「実際に動いている SDK worker が実際に質問し実際に回答が届く」まで
を通しで実測した初回。ただし実測できたのは**質問1本・worker 1体・`plainQuestion` 無しの分岐・
生きた worker への live injection レーン(`status: 'injected'`)だけ**であり、次は未実測のまま
残る: worker 死亡時の queued レーン(`swarmEscalations.ts` の `queueForNextDispatch`)、
`plainQuestion` 有りのレーン、検知の fail-closed 側(working / quota-parked / マーカー行で
'question' と誤判定しないこと)。

0802 のクラウド中心決定(auto-memory `project_cloud_centric_for_now`)は再検討条件を3つ挙げ、
そのうち2つが成立したとしている(自動運転の完走、および本カードで実測した散文質問)。
未成立の1つは「オーナーが最初の数回に張り付ける時間があると言ったとき」で、これはオーナー側の
判断待ちのため今回も変わらず未成立。この段落の根拠は auto-memory(リポジトリ外)のみであり
読者が直接検証できない点に注意 — リポジトリ内で確認できる一次情報は上記の escalation id と
コード引用のみ。

(カード指示は `docs/RELEASE_REPORT.md` を指していたが、実体は本リポジトリ直下の
`RELEASE_REPORT.md` のみでこのパスは存在しない。直下に追記した — 次にこのカードを書く人は
同じ食い違いを踏まないこと。)

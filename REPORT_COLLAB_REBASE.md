# REPORT — collab v2 → 0.9.1 rebase

**Date:** 2026-06-19
**Branch:** `swarm/w1-0618-153923-57300` (collab v2 — Cloudflare DO realtime)
**Rebased onto:** `origin/main` = `1059f1c` (0.9.1)
**Status:** ✅ rebase complete · tsc / lint / test all green · **`[hold]` — awaiting manager review (no auto-merge)**

---

## 1. Outcome at a glance

| | before | after |
|---|---|---|
| rebased collab tip | `b2626ca` (merge commit) | `6900b18` (linear; this report is a doc commit on top) |
| base | `78031d8` (0.9.0) | `1059f1c` (0.9.1) |
| shape | 46 collab commits + 1 merge | **46 collab commits, linear, 0 merges** |
| `origin/main` ancestor of tip? | no (behind 5) | **yes → manager can FF `HEAD:main`** |
| verification | (b2626ca era ~1580–1792) | **tsc 0 err · lint 0 err · test 1817/1817 (140 files)** |

- **Recovery:** pre-rebase tip preserved at branch **`backup/w1-pre-rebase-b2626ca`** (= `b2626ca`).
- The merge commit `b2626ca` was intentionally dropped by the linear rebase; its conflict resolution was re-derived (and improved — see §4).
- **Force-push was not performed.** The branch is local-only (never on origin), so the rewrite is safe; integration is the manager's call.

## 2. Topology

`swarm/w1` was `feat/collab-cf-do` (tip `99df780`, 46 commits) merged into 0.9.0 via `b2626ca`
(parents: `78031d8` 0.9.0 / `99df780` collab). `origin/main` advanced 0.9.0 → 0.9.1 with **5 commits**:

```
f7f6235 feat(auth): enable login on distributed builds via baked public Supabase config
9febb85 fix(auth): gate claude run routes on loggedIn — stop signed-out OAuth browser loop
6a53c92 fix(claude): absolute-path resolution for title/desc gen + gate usage scraper on loggedIn
09ad614 release: 0.9.1
1059f1c docs: 0.9.1 release runbook + readiness report (RELEASE_REPORT.md)
```

`git rebase origin/main` dropped the now-redundant merge and replayed the 46 collab commits on 0.9.1.
**rerere was enabled** for the run.

## 3. Conflicts & resolutions

Only **2 of 46 commits** conflicted (the rest auto-merged because hunks sat in disjoint regions).

### 3.1 `144e052` (commit 5/46) — `server/app.ts`
Both sides add a sub-router as slot "J". `origin/main` has `moduleSubmissionsRoutes` (J); collab adds `collabRoutes`.
**Resolution — additive (matches the original `b2626ca` resolution):** keep both imports; mount
`moduleSubmissionsRoutes` as **J** and `collabRoutes` as **K**. `src/lib/types.ts` auto-merged in the same commit.

### 3.2 `5edeed7` (commit 21/46) — `src/App.tsx`, `src/components/canvas/Toolbar.tsx`, `src/i18n/messages/toolbar.ts`
collab's "Shared with me" member entry vs main's Skills button / module-submission inbox.

- **`toolbar.ts`** — additive: keep `toolbar.skills` (main) **and** `toolbar.shared` (collab), same order as `b2626ca`.
- **`App.tsx`** — additive, two hunks:
  - state: keep `skillsPanelOpen` (main) **and** the collab member-flow state (`collabEnabled` / `sharedDialogOpen` / `openShared`).
  - `<Toolbar>` props: keep main's `unreadFeedback={feedbackUnread + moduleSubmissionUnread}` (preserves the module-submission inbox dot) **and** add collab's `onShared={…}`. Result is byte-identical to `b2626ca`'s `App.tsx`.
- **`Toolbar.tsx`** — see §4 (the one intentional divergence from `b2626ca`).

`src/i18n/messages/projectPanel.ts` and the collab dialog files auto-merged in the same commit.

## 4. Intentional divergence from `b2626ca` — `ClaudeConnectionIndicator` (flag for reviewer)

The collab side of `Toolbar.tsx` carried `<ClaudeConnectionIndicator />` (the `>_` glyph) + its `Terminal` import + its
`toolbar.claudeConnected` / `toolbar.claudeNotConnected` i18n keys — because `feat/collab-cf-do` branched from an **older
main that still had it**. main **deliberately deleted that component** in `ddc0742`
*("remove dead Claude-connection terminal icon from the toolbar")*, which is an ancestor of `origin/main` (0.9.0/0.9.1 ship
without it). The original `b2626ca` integration **resurrected** it (the memory note "ClaudeConnectionIndicator系をサイレント脱落
→tscで捕捉し復元" describes that resurrection).

**Decision:** respect main's removal — drop `ClaudeConnectionIndicator`, its `Terminal` import, and its two i18n keys; keep
**Skills (main) + Shared (collab)**. This is the only place the rebased tree intentionally differs from `b2626ca`, and it is
**more correct** than the old integration (it stops re-introducing code main intentionally deleted). Internally consistent:
no dangling reference remains (`grep ClaudeConnectionIndicator|Terminal` in `Toolbar.tsx` → 0; tsc green).

> If the manager *wants* the indicator back, that's a separate product decision — it should be re-added to main, not carried
> in via collab.

## 5. The flagged interactions — each verified

| interaction (from the order) | finding |
|---|---|
| collab claude-run × 修正A run-gate (`terminal.ts`, `project.ts`, `canvasAi.ts`) | `terminal.ts`/`canvasAi.ts` are **main-only** (collab never touches them) → **byte-identical to `origin/main`** in the rebased tree; gates intact (`claudeRunPreflight` ×6 / ×4). `collab.ts` **spawns no claude** (0 `launchClaude`/pty refs) → no competing run path, no gate bypass. `project.ts` carries **both** the 3× `claudeRunPreflight` gate (main) **and** collab's new `/api/projects/display-name` route; that route sets a cosmetic name and correctly needs no run-gate. |
| distributed-build claude absolute-path resolution (`claudeConnection.ts`, `claudeTerminal.ts`, `claudeUsageCli.ts`) | **main-only** → **byte-identical to `origin/main`** after rebase. `claudePreflight.ts` (new in 0.9.1) present and unmodified. Fully preserved. |
| login (`auth.ts`, `supabaseAuth.ts`, `App.tsx`, `package.json`) | 0.9.1 does **not** touch `auth.ts`/`supabaseAuth.ts`/`App.tsx` (login shipped ≤0.9.0), so no textual conflict; collab's edits replay cleanly. `App.tsx` merged additively (byte-identical to `b2626ca`). `package.json` carries **both** version 0.9.1 + `build:config` (main) **and** the collab deps (`yjs`/`y-partyserver`/`y-protocols`/`partysocket`). |

**Silent-drop audit.** For every file 0.9.1 did *not* touch but collab did, the rebased tree was diffed against the
known-good `b2626ca`: all identical **except** `Toolbar.tsx` + `toolbar.ts` (the §4 divergence) and `package-lock.json`
(§7). For the 5 files both sides touched and that auto-merged (`ProjectPanel.tsx`, `BoardModule.tsx`,
`BoardModule.modes.test.tsx`, `projectPanel.ts`, `.gitignore`), `diff b2626ca..HEAD` is **textually identical** to main's
own 0.9.1 change to each file → collab's contribution landed exactly as in `b2626ca`, nothing dropped.

## 6. Verification

| check | result |
|---|---|
| `npx tsc --noEmit` | **exit 0, 0 errors** |
| `npm run lint` | **exit 0, 0 errors** (121 pre-existing `no-explicit-any` warnings in untouched files; baseline) |
| `npm test` (`vitest run`) | **140 files / 1817 tests passed**, exit 0 |
| `npm run build` | **exit 0** — `build:config` + vite (`dist-web/`) + esbuild (`server/dist/index.cjs`, 1.2 MB) all produced; stamped `openground@0.9.1` (chunk-size >500 kB warning is pre-existing/cosmetic) |
| no conflict markers in tree | confirmed (`git grep` clean) |
| `npm ci` | clean (deps incl. collab `yjs`/`y-partyserver` install; lock functionally in sync) |

## 7. Residual risks / notes for the adversarial re-review

1. **§4 divergence is a judgment call.** It is intentional and defensible (follows main's `ddc0742`), but it is the one spot
   where the rebased tree is NOT what `b2626ca` shipped. Reviewer should confirm dropping the `>_` indicator is desired.
2. **`package-lock.json` `version` field is cosmetically stale (`0.8.2`).** Left **as the rebase produced it** — NOT fixed,
   to keep the surface a pure rebase. This is pre-existing on main itself (`origin/main` ships lock `version: 0.8.0` against
   `package.json` 0.9.1) — the release process never bumps the lock's top-level version. `npm ci` is green, so it is
   functional metadata only, not a dependency-tree drift. If desired, a one-line bump to `0.9.1` can be applied separately.
3. **Realtime collab is env-gated and untested live here.** This rebase verifies *compile + unit/integration tests*; it does
   **not** re-run the live owner/member QA (Worker `og-collab.mindbrew.workers.dev`, R2, Supabase). The collab feature
   behaviour is unchanged by this rebase — only its base moved 0.9.0 → 0.9.1 — so prior live QA should still hold, but a
   smoke of owner-invite/member-join after integration is prudent.
4. **No e2e (`playwright`) run.** Out of the stated scope (tsc/lint/test); `npm run build` covers bundling.

## 8. Integration instructions (manager — `[hold]`)

- `origin/main` is an ancestor of the rebased tip → **`git push origin swarm/w1-0618-153923-57300:main` is a clean
  fast-forward** (no further conflict). Re-fetch + re-confirm FF immediately before pushing in case main moved.
- **Do not force-push.** Recovery point: `backup/w1-pre-rebase-b2626ca`.
- Worktree: `~/projects/OG-collab-rebase` (this report lives there). Safe to remove after integration.

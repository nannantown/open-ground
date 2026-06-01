# Electron Migration Spike — Results

Goal: de-risk the OPEN GROUND → Electron migration before committing to the
full multi-PR plan. Specifically prove the parts 3 independent reviewers
flagged as `needs_major_rework` (confidence 3/10).

## Verdict: GO ✅

Every critical risk was disproven empirically on 2026-05-29.

## What was proven

| Risk (reviewer concern) | Result |
|---|---|
| node-pty rebuild against Electron ABI | ✅ `electron-builder install-app-deps` + `electron-rebuild` both produce arm64 `pty.node` |
| node-pty fails to load under `ELECTRON_RUN_AS_NODE=1` | ✅ `child-test.js` forked with that env loaded node-pty fine |
| hardened-runtime + dlopen blocks node-pty | ✅ signed `flags=0x10000(runtime)` app loaded node-pty AND spawned `claude --version` → `2.1.156 (Claude Code)` |
| 4 separate entitlements files needed (main/Helper/Renderer/Plugin) | ❌ NOT needed — electron-builder embeds entitlements into each Helper automatically. One `entitlements.mac.plist` + `entitlements.mac.inherit.plist` is enough |
| notarization rejects the bundle | ✅ `notarytool ... --keychain-profile openground-notary` → `status: Accepted`, stapled, `spctl: accepted source=Notarized Developer ID` |
| reusing existing Developer ID cert / notary profile | ✅ `openground-notary` profile + `Developer ID Application: Koki Naniwa (A3FD22BRKP)` worked unchanged |

## File-log evidence (cold run from signed hardened-runtime app)

```
[child] starting ELECTRON_RUN_AS_NODE=1 node=v20.18.0 arch=arm64
[child] node-pty loaded OK
[echo-pty] data="hello-from-pty\r\n"
[echo-pty] exited code=0
[child] claude found at ~/.local/bin/claude — spawning --version
[claude-pty] data="2.1.156 (Claude Code)\r\n"
[claude-pty] exited code=0 — SPIKE COMPLETE
```

## Key learnings for the real implementation

1. **Entitlements**: electron-builder auto-applies entitlements per Helper.
   `allow-jit` + `allow-unsigned-executable-memory` + `disable-library-validation`
   on the main entitlements, same set + `inherit` on the inherit file. Done.
2. **node-pty**: pin to a stable release (used `^1.0.0`, NOT the `1.2.0-beta`
   the reviewers warned about). `asarUnpack: ["**/node_modules/node-pty/**/*"]`
   is required so the `.node` + `spawn-helper` are loadable outside the asar.
3. **CI notarization**: `notarize.teamId` in package.json triggers a deprecation
   warning and gets skipped — use the `APPLE_TEAM_ID` env var (or App Store
   Connect API key .p8) in CI instead. For local dev, the keychain-profile
   `notarytool` path works.
4. **Bundle size**: ~95MB dmg (Chromium included). Acceptable; the alternative
   (Tauri) can't reach its 3MB ideal because claude CLI spawn requires a bundled
   Node runtime anyway — see memory `project-subscription-only`.
5. **App Translocation** appears when you `cp` + manually set quarantine. Real
   users dragging from a DMG in Finder won't translocate. Test with quarantine
   stripped (`xattr -cr`) to simulate the post-drag state.

## Still unproven (deferred to real PRs, low risk)

- Forking the REAL `.next/standalone/server.js` (spike used a stub child).
  The fork+node-pty coexistence is proven; remaining work is wiring the
  standalone build output.
- electron-updater full cycle (download → verify → quitAndInstall → relaunch)
  with in-flight run-queue drain.
- TCC prompts (NSDocumentsFolderUsageDescription etc.) when scanning a
  projectsRoot under ~/Documents.

## How to reproduce

```bash
cd spike/electron-skeleton
npm install              # installs + rebuilds node-pty for Electron ABI
npm run build            # --dir, signs with hardened runtime
xattr -cr "/Applications/OPEN GROUND Spike.app"   # simulate post-Finder-drag
open "/Applications/OPEN GROUND Spike.app"
cat ~/.openground-spike.log   # the evidence
```

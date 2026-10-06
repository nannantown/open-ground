# Idle CPU — causes found and fixed (2026-10-06)

Owner report: OPEN GROUND sat near the top of Activity Monitor with nothing
asked of it. Packaged app 0.11.172, 12 h after launch: server (forked
`index.cjs`) 50–90%, renderer 25–50%, GPU 38–46%.

## How it was measured

- **Server, live, packaged app**: `kill -USR1 <server pid>` opens Node's
  inspector on the Electron-forked server (checked first on a throwaway
  Electron-as-node process that the signal does not kill it); a CDP client
  took 20 s and 60 s CPU profiles and closed the inspector again
  (`process._debugEnd()`).
- **Server, per request**: CPU-time delta of the live server while firing 100
  identical requests, minus its baseline rate.
- **Server, before/after under the same load**: the `main` bundle and the fixed
  bundle each booted the way the packaged app boots them (Electron's bundled
  Node, `ELECTRON_RUN_AS_NODE=1`) against an isolated `OPENGROUND_HOME` holding
  only a copy of the registry (52 projects) and their `tasks.json`; a script
  replayed the idle client poll mix (Ground + one project on the Board, agent
  team bar folded) for 60 s.
- **Transcript readers, before/after**: the old and new `claudeUsage.ts` run
  against the real `~/.claude/projects` (13 live desk sessions, 2,682 files)
  under the beacon + HUD poll cadence for 60 s.
- **Renderer / GPU**: the built SPA in Chromium (Playwright), CPU time of the
  renderer and GPU processes over 15 s, plus CDP Performance metrics
  (layouts / style recalcs per second), with and without each animation.

## Causes (function level)

| # | where | what | cost before |
|---|---|---|---|
| 1 | `claudeUsage.sessionContextTokens` (via `attachContextLeftPct`, `GET /api/terminal/active`, polled every 5 s by up to 3 panels) | read and decoded **every live pane's whole transcript** on every poll — 13 desks ≈ 160 MB; the 4 s directory-walk memo never hit at a 5 s cadence | 372 ms CPU per request (85% of it the transcript read) |
| 2 | `claudeUsage.collectClaudeUsage` (`GET /api/usage`, every 60 s, two HUD copies with a project open) | re-read every transcript touched in the last 6 h (≈190 MB) | with #1: 16.4% of a core |
| 3 | `projectDataPath.projectUUIDFromPath` (via `readProjectData`, the ground marks, …; `GET /api/ground/lamps` every 5 s on every screen) | realpath'd **every registered root and worktrees dir on every call**; lamps makes ~5 calls per project ⇒ O(N²) | 598 ms CPU per lamps request with 52 projects |
| 4 | `.og-ast-shard` / `.og-ast-blink` (floating assistant, every screen) | infinite SVG transform animations run on the main thread: ~120 style + layout passes a second | renderer ~12%, GPU ~10% |
| 5 | `.run-scan` / `.run-pulse`, `SwarmSprite` rAF loop | any looping animation makes the compositor draw every refresh, watched or not | GPU ~25% while anything shows as working |

Checked and **not** a meaningful cost: the president seat's 5 s
`/api/phone-link/call-notes` poll (a few ms per request — the assistant log is
16 KB), `getTerminalScreen` / `readScreen` inside the beacon (did not appear in
the profile), the engine's idle tick on the main thread (<0.5%).

## Fixes

1. **Transcripts are read incrementally** (`claudeUsage.ts`): each file once,
   then only the appended bytes; an unchanged file costs one `stat`. The bytes
   before the resume point are re-checked so a rewritten file is re-read from
   the start. A session's transcript path is remembered, so a live pane no
   longer walks `~/.claude/projects`. Outputs verified identical to the old
   reader on the real data. Scans of files that vanish or age out, and
   entries older than the widest window (`USAGE_BREAKDOWN_MAX_DAYS` = 7, the
   one window the HUD asks for; the route caps at it), are dropped — a 30-day
   keep held ~30–35 MB on the heap.
2. **Canonical registry roots are reused** (`projectDataPath.ts`), keyed by the
   registry entries read fresh on every call (any registry change recomputes
   at once), for at most 10 s.
3. **Looping motion runs only while someone is looking** (`src/lib/presence.ts`):
   window in front AND input within 2 minutes. Otherwise the page is marked
   `html[data-motion='still']` — the SAME mark the OS "reduce motion" setting
   now sets — and globals.css draws one still look for it: every status loop
   at its full resting look (a first version only paused each loop wherever
   it was, so a running dot froze at its faint half-beat about a third of the
   time and read as a faded idle seat). Loops the stylesheet does not cover
   (Tailwind `animate-*`, inline keyframes) are paused at their first frame
   through the Web Animations API, and `SwarmSprite` holds one frame.
   Verified in Chromium: the computed opacity / transform of `.run-pulse`,
   `.run-scan`, `.og-ast-shard`, `.og-ast-blink` while away are identical to
   the reduce-motion ones (opacity 1, transform none). Guards:
   `src/lib/presence.test.ts`, `src/lib/stillMotion.test.ts` (every
   `infinite` loop in globals.css needs a still rule).

## Numbers

| measurement | before | after |
|---|---|---|
| transcript readers, real data, beacon + HUD cadence | 16.4% of a core | 0.5% |
| `/api/ground/lamps`, 52 projects | 598 ms CPU / request | 89 ms |
| server, packaged-style boot, idle poll mix, 60 s | 13.8% | 2.3% |
| ⇒ server idle estimate (poll mix + transcripts) | ≈30% (live: 48–57%) | ≈3% |
| renderer + GPU, Ground, nobody looking | 17% + 36% | 0% + 0% |
| renderer + GPU, project panel, nobody looking | 24% + 37% | 0% + 0% |
| renderer + GPU, while the owner is using the window | unchanged (the designed motion) | |

Still to do once a release carrying this is installed: re-measure the
packaged app itself (`ps`/`top` on the server, renderer and GPU processes)
after it has been left alone for a few minutes.

# Songs / NENE Handoff to Claude

## Stop Point

The owner asked to stop Codex implementation because its remaining usage is low
and prepare a handoff to Claude. Do not treat this document as authorization to
start Swarm workers, publish a release, or expand scope. No implementation work
is left running by this handoff. Existing development servers are left available.

Current work is saved in TWO local Git repositories. Do not look only in OPEN
GROUND for the Songs implementation, and do not switch branches over user data.

| Repository | Branch | Latest implementation commit |
| --- | --- | --- |
| `~/projects/OPEN GROUND` | `codex/songs-workspace-controls` | `a4335156` |
| `~/projects/NENE` | `codex/songs-scale-guide` | `5b3689a` |

This document is committed after the OPEN GROUND implementation commit above.
No push, tag, release or installation was performed for these final changes.
The branches have no upstream configured. Local `main` is not the delivery
branch; cached remote refs already indicate newer changes. Before integration,
fetch and review divergence rather than assuming these branches are current.

## What the Owner Can Use Now

- A compact one-row OPEN GROUND project header, and now a separate one-row
  Songs header containing title, score/fretboard toggles, metadata, memo/settings.
  Narrow Songs layouts put key/BPM/duration in settings instead of a second row.
- Independent score and fretboard icon toggles; at least one remains visible.
  The duplicate song-list close control is removed. The split boundary can be
  dragged, with keyboard resizing and remembered proportions.
- Playback-linked guitar scale suggestions, note roles, next-chord guidance and
  a fretboard tab for chord fingerings. The fret control represents a moving
  six-fret window, not a range starting at zero.
- Space/Enter transport priority throughout the visible Songs tab, including
  focused controls. Text entry, IME and ordinary editing retain their behavior.
  Browsing another song does not change the currently playing song's volume.
- A collapsible bottom recording desk instead of a modal: input device and
  channel selection, input meter, optional app monitoring, one active clip,
  retained takes, waveform move/trim, undo/redo, mute/solo/volume and WAV export.
- Right-edge terminal drawers are removed; ordinary Terminal and Swarm remain.

## Commit Trail and Entry Points

OPEN GROUND, based on `fa21a20d` (0.11.117):

- `42d43fdb`: remove right-edge custom-tab terminal docks. Main files:
  `src/components/canvas/ProjectPanel.tsx`, `EmbeddedClaudeTerminal.tsx`,
  `modules/CustomModuleView.tsx`; regressions in `CustomModuleDock.test.tsx`,
  `e2e/project-header.spec.ts`, `workerAddressingInventory.test.ts`.
- `a4335156`: explicit NENE microphone-capable frame. Main files:
  `src/lib/localAppFrame.ts`, `src/lib/types.ts`,
  `src/components/canvas/modules/CustomFrameHost.tsx`, `CustomModuleView.tsx`.
  Tests: `localAppFrame.test.ts`, `CustomFrameHost.test.tsx`,
  `e2e/nene-recording-frame.spec.ts`. See `docs/CUSTOM_TABS_PLAN.md` and MAP.

NENE, six commits beyond local `main`:

- `cf6fbb2`: playback-synced guitar scale guide.
- `19f7f0e`: score plus fretboard default workspace and secondary tools.
- `1b119a9`: independent toggles, chord fingerings and resizable panels.
- `63e0d94`: transport keyboard priority and playing-song volume isolation.
- `1af8b37`: non-destructive docked single-track recorder.
- `5b3689a`: single-row Songs header; `index.html`, `assets/workspace.css`,
  `package.json`, `tools/verify_song_header.mjs`.

NENE UI and transport start in `index.html`; layout is in
`assets/workspace.css`. Read `docs/SCALE_GUIDE.md` and
`docs/RECORDING_DESK.md` before changing their respective features.
Recording source: `music/recording-desk.mjs`, `music/recording-model.mjs`;
generated offline bundle/style/license: `assets/recording*`.
`serve.js` owns persistence. Use `git show --stat <commit>` for complete file lists.

## Local Integration and Data Safety

- Development OPEN GROUND: `http://127.0.0.1:5175/`.
- NENE: `http://127.0.0.1:8899/`; launcher on port 8898. HTML/CSS updates
  only need a Songs reload; server route changes need the NENE server restarted.
  Check for playback, recording and pending saves before either operation.
- The final header was verified in the actual development Songs frame after
  confirming playback was paused and recording was inactive, then reloading.
- Local custom-module ID: `2fa048ce-82b7-4763-bfa0-9461ae34e20c`.
  `~/.openground/custom-modules/index.json` now carries `localApp: 'nene-songs'`
  for this entry. Its `source.tsx` was synced from NENE's
  `openground/songs-tab.tsx`. These local integration changes are outside Git.
- NENE gets an explicit fixed, separate loopback origin and microphone
  delegation. Arbitrary custom tabs remain opaque sandbox frames. Never solve
  microphone restrictions by globally relaxing iframe or browser security.
  Lockdown disables the special NENE frame.
- Original takes stay in `NENE/audio/recordings/`; edit metadata is in
  `NENE/audio/.recording-projects/<songId>.json`. Removing a clip only removes
  its reference, not the original take. Revision conflicts return 409.
- Preserve dirty NENE `memos.json`, `setlist.json`, untracked `.claude/`,
  `.codex/`, ignored `songs-data.js` and all audio. OPEN GROUND has unrelated
  untracked `.agents/`, `.codex/`, `AGENTS.md`. Never stash or discard these.
- The latest header work left song/memo/setlist hashes unchanged. Temporary
  pre-recording backup: `/private/tmp/nene-before-recording-deRsst` (includes
  module registry/source); this is not durable archival storage.
- `NENE/openground/README.md` describes the older nested-frame launcher; use
  `docs/RECORDING_DESK.md` plus OPEN GROUND's microphone capability section
  for the current recording path. Do not reapply historical playback patches.

## Verification Already Completed

These are recorded completed runs, not a claim that suites were rerun at handoff.
Node used: `~/.nvm/versions/node/v22.22.0/bin/node`.

- OPEN GROUND at `a4335156`: TypeScript/build passed; Vitest 7,287 passed,
  2 skipped across 419 files; ESLint zero errors, 196 existing warnings.
  Custom-tab browser checks and fixed-origin fake-input microphone/keyboard
  regression passed. Previous implementation fails the new frame regression.
- NENE recording: `npm run test:recording` passed with disposable songs and
  synthetic audio. Covers actual capture/output signals, timing, edit history,
  persistence, export, failures/conflicts and preservation of original files.
  This does NOT establish real hardware or packaged Electron compatibility.
- At final header commit: `node tools/check_syntax.mjs`,
  `npm run test:guide:browser`, `npm run test:playback:browser`, and
  `npm run test:header:browser` passed. Header suite checks 320 through 1600px,
  long titles, single-row geometry, no overlap, settings/memo/toggles and
  contextual selection actions. It failed on the previous header (red baseline).
- Header screenshots were inspected; actual Songs displayed a 48px header.
  `git diff --check` passed. User data was not used in automated browser tests.

## Remaining Acceptance and Suggested Next Step

1. Read this handoff and inspect both branches; report the current state to the
   owner before adding features. There is no unfinished header implementation.
2. With the owner's audio interface connected, verify permission, available
   inputs/channels, a short take against a song, playback sync, monitoring with
   headphones, export, undo/redo and reopening saved edits. Do not record the
   owner's real input without their participation/authorization.
3. Verify microphone permission and recording in a newly packaged Electron app.
   The currently installed release is NOT evidence for the new host capability.
4. Only when integration/release is requested: reconcile both repositories with
   current remote changes, run relevant verification, then release. An OPEN
   GROUND release alone does not distribute the separate local NENE repository.

Known scope limits: monitoring defaults off; browser/hardware latency may need
manual correction; only the first two exposed input channels are supported;
undo history is session-only; pending failed-upload Blobs are memory-only and
not crash-proof. Exported mixes include the original song and performance, not
synthesized chord/metronome audio. This is a one-track practice recorder, not a
sample-accurate replacement for Logic. Preserve these honest boundaries.

Older product cleanup and Swarm handoff history lives in
`docs/commander/PRODUCT-HANDOFF-2026-09-21.md`; do not restart that work from
the conversation alone. Do not stop existing owner-started workers merely
because this Codex task is stopping.

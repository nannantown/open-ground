# Swarm Simplification (2026-09-19)

This is the current contract for the owner's approved removals. Older chapter
descriptions of these retired paths are historical. No release is implied by this
source change, and no user data migration or deletion is performed.

## Removed

- Persona: Ground entry, settings controls, questionnaires, portrait, conversation,
  import, corpus readers/writers, learning from owner answers and proxy decisions.
  `/api/persona/*` and `/api/you-corpus/*` have no handlers. Old opt-ins are inert.
- The dormant engine integration pipeline: verify worktrees, adversarial reviewer
  panel, automatic rebase/push and the engine's TypeScript integration lock. These
  had no live integration caller since commander ownership began on 2026-07-15.
  Removing them does not remove an active model expense.
- `swarmSelfSupply`: automatic repository scanning and improvement proposals,
  enable/budget persistence, `/api/swarm/orchestrator/selfsupply` and
  `/api/swarm/orchestrator/selfsupply/approve`. This is NOT the conversational supply desk.

## Preserved

- Human questions and actual answers: `swarmEscalations.ts`, `swarmQuestions.ts`,
  `server/routes/swarm.ts` (the `SwarmEscalationsPane.tsx` UI was removed with the
  監督 tab on 2026-09-23 — answers go through the president; 06 §1.7). The answer is persisted
  before delivery. SDK/PTY addressing, pending-answer retries, next-dispatch
  delivery, explicit dismiss, unanswered-record retention and path checks remain.
- Deterministic monitoring: `swarmOverseer.ts`. S4 heartbeat questions go directly
  to the owner at every usage level. A failed inbox write is retried; an SDK
  worker retains its complete address. No model is asked to impersonate the owner.
  Fatal receipts, stall/dwell notices, usage alerts and bounded janitor runs remain.
  Monitoring still turns off on stop/restart and must be explicitly re-armed.
- Stop, recovery and salvage: `swarmOrchestrator.ts`, `swarmEnginePersistence.ts`,
  `swarmWorker.ts`, `worktreeCleanup.ts`, existing process/SDK termination guards.
  Engine/desk restoration and crash-loop protection remain.
- Backup/integrity: `homeBackup.ts`, `homeIntegrity.ts`, general boot retention.
  Persona-specific scratch cleanup is removed, so archived Persona data is not
  pruned as part of this change.
- Quota/permission gates: `swarmQuota.ts`, `swarmTierProbe.ts`, `swarmLaunch.ts`,
  usage and rate-limit detectors, model allow masks, worker hook guards and the
  project-path allowlist. The active model roles are worker, manager and supply.
- Commander integration: `runIntegratePass` still classifies review readiness and
  wakes the commander. `swarmIntegrate.ts` retains read-only classification/target
  resolution. `scripts/swarm-lock.js` remains the manual commanders' lock.
  Holds, high-risk rules and explicit conflict/rework resolutions remain.
- Conversational task supply, daily fuel reports, context caps and card difficulty
  tiers. Collaboration, local custom tabs, Canvas, WordPress and Research
  are outside this removal.

## Follow-up: Tab Distribution (2026-09-20)

The owner separately approved removing marketplace, publishing, submission and
review features. Local custom tabs and their files remain; see
`docs/CUSTOM_TABS_PLAN.md` for the current contract. Fuel reports and automatic
fuel-improvement cards remain unchanged.

The unused Persona proxy singleton was also removed. The shared host allowlist
and matcher still enforce Work mode, and `createEgressProxy` remains available
to the explicit sandbox diagnostic. Neither starts a Persona session.

## Follow-up: Public Product Scope (2026-09-21)

Automatic daily fuel reports and improvement cards now require the actual app
owner role on each tick. Existing reports, sentinels and proposal cards are not
removed. This does not gate token meters, quota detection, human confirmation,
stop/recovery or Swarm's public opt-in. Skills management UI is owner-only, but
CLI skill files and the Swarm toolkit remain available. The owner can preview
public UI without changing roles or pausing jobs; see `docs/PUBLIC_PRODUCT_SCOPE.md`.

## Follow-up: SDK-only Manager (2026-09-21)

- All new managers use SDK, for owners and public users alike. The runtime switch,
  settings reader/normalizer, derived settings response and PTY launch plan/watch
  are removed. Old `swarmManagerRuntime` values remain inert on disk; POST ignores
  them. There is no PTY fallback when SDK startup fails.
- Conversation IDs, transcripts, task data and context-cap behavior remain.
  Singleton locking, quota refusal learning, human questions, stop/restart and
  the engine's existing recovery/backoff policy remain.
- Existing live PTY managers may survive a development reload. Detection,
  adoption, delivery, rendering and stopping remain compatible with those desks
  so they are not orphaned or duplicated. Once stopped, the next launch uses SDK.
  This is compatibility for in-flight work, not an alternative launch path.
- The supply/task desk and ordinary terminals remain PTY-based. Phone access
  goes through the supply desk; the SDK manager has no Remote Control session.
- Sub-tab ordering and Swarm's public opt-in are unchanged. No data migration,
  release, push or installation is part of this change.
- (Superseded 2026-09-23.) The sub-tabs and the manager dashboard are gone:
  the Swarm tab is one screen of seats, and the manager's seat is a nameplate
  (running / stopped / not there + a quiet start/stop). Monitoring moved to the
  top bar. See 06 §1.7.

### SDK-only Verification

- Full Vitest run: 7,245 passed, 2 skipped across 416 files. TypeScript and the
  production build passed; ESLint reported zero errors and 193 warnings.
- Playwright: 11 passed (manager, Board and smoke), including owner/public
  manager settings at 1280px and 390px. Screenshots were inspected. The mobile
  manager-tab click failed before the layout fix and passed afterwards.
- Regression guards failed against the original runtime preference/launch path
  and original selector UI, then passed after removal.
- The installed Electron executable ran the new server bundle with the actual
  Agent SDK and an offline CLI fixture, in an isolated temporary home. Public
  and owner boots resumed the same legacy conversation, retained transcript and
  project data, delivered a message, reused the singleton and stopped it.
- The local fixture preview was restarted at the same URL. No live model call,
  newly packaged GUI, release, push or installation was performed.

## Follow-up: Swarm Screen Inventory (2026-09-23, card ③)

The owner talks only to the president. The test for each item was: does the owner need to see it,
and is it used in the current model (president as the front desk, SDK-only, this document and
`docs/PUBLIC_PRODUCT_SCOPE.md`)? Server routes and local data were not removed. Details are in
06 §1.7.

| Screen element | Decision | Reason |
|---|---|---|
| Manager conversation stream (SDK transcript / PTY terminal) | Remove | The owner talks only to the president |
| Manager command box (状況 / マージ / 掃除 + free text) | Remove | Same; the president relays (`/api/swarm/manager/say`) |
| KPI panel (lead time, success / rework / conflict rates) | Remove | The owner does not need to read it |
| Landed-per-week chart (and `useLandedKpi`) | Remove | The owner asks the president 「着地は?」 and the president reads `GET /api/swarm/kpi/landed` (supply skill 「状況」 ④). The ledger and route stay, and `docs/OUTWARD_TRIAL.md` reads its weekly number that way |
| Consumption panel | Remove | Only the over-budget notice mattered, so it moved to one line under the top bar |
| Manager presence line + review-queue count | Remove | The seat's three-word status is enough |
| Monitoring (overseer) switch | Move (top bar) | Needed to turn on question / stall / usage notices |
| Monitoring re-arm reminder, restart-resume notices | Keep | Decisions the owner makes after a restart |
| Top bar status, on/off switch, execution mode | Keep | The owner's main controls |
| Setup banner (git missing etc.), error banner | Keep | Explains why nothing can start. Engine errors now also show above the seats |
| First-run explainer | Keep | For first-time users |
| President seat, worker seats | Keep | As built by card ② |
| Manager-only parts of the worker pane (`embedded`, `onStatus`) | Remove | Only the manager seat used them |
| Unused client functions (`stopWorker`, `resolveReview`) | Remove | No callers. The server routes stay because the commander skill uses them |
| 77 unused UI strings | Remove | No code references them |

## Local Compatibility

`~/.openground/you-corpus*`, `persona-*.json` and Persona scratch/session data are
left where they are. The application no longer interprets or updates them. Old
unknown settings may remain on disk but do not enable any feature.

Existing proposal cards retain `selfSupplyKey` and `selfSupplyApproved` as legacy
safety fields. An unapproved old proposal must NOT silently become runnable just
because its generator was removed. Review/recreate such work explicitly; there
is no automatic approval migration. Historical inbox records remain readable;
old proxy drafts have no UI or new-write contract. Answer responses no longer
contain `memoryWritten`.

## Verification Entry Points

- `retiredPersona.routes.test.ts`: routes absent with legacy opt-ins; archive intact.
- `App.render.test.tsx`: no Persona entry or setting even with stale enabled flags.
- `swarmOverseer.test.ts`, `swarmSdkChannels.test.ts`: direct human questions,
  retry and per-worker SDK addressing.
- `escalations.routes.test.ts`, `swarmEscalations.test.ts`: human answer persistence,
  delivery, retry, archive preservation and retired proposal routes.
- `swarmOrchestrator*.test.ts`, `swarmSafety.test.ts`, `homeBackup.test.ts`,
  `homeIntegrity.test.ts`, quota tests and HOME/addressing inventories: retained
  engine and safety behavior. Dedicated tests of deleted implementations retire
  with those implementations; shared guards stay.

## Verification Results

- Full suite: 7,306 passed, 2 skipped across 418 files; TypeScript and build passed.
- ESLint: zero errors, 203 warnings (217 warnings before this work).
- Browser checks: 7 passed, including Ground/Settings without Persona and the
  retained card difficulty flow at desktop and mobile sizes.
- Mutation check: disabling owner-question delivery made 7 focused tests fail;
  restoring it returned the full suite to green. The retired-route guard also
  failed against the old handlers before removal.
- The installed Electron executable ran the new server bundle through two boots
  with an isolated home and fake CLI. Archives survived, settings/backups were
  written, old Persona opt-ins stayed inert, and the test port was released.
- No real Claude session, newly packaged app UI, release or installation was
  exercised. The installed application remains unchanged.

# Swarm Efficiency: Local Integration Handoff

## Scope and Delivery

The owner asked Codex to finish Claude's pending work from this conversation.
This is a local code handoff, not an implementation of Codex as a Swarm runtime.

- Starting point: `814b4dc0` (0.11.114).
- Integration branch: `codex/finish-swarm-efficiency`.
- Context-cap card: `477e6d41-7aca-4a47-aa24-d25ecd02eaed`;
  merged `swarm/0918-114918-9ee7a32dcced` at `cdb8af68`.
- Difficulty-tier card: `2d7c8224-6035-489f-88eb-99fb5616aea7`;
  merged `swarm/tier-0918-114919-8299e7af5feb` at `32181eec`.
- Both original branches and worktrees remain intact. The two cards remain in
  review because their stated final destination, `origin/main`, has not changed.
- No push, release, version bump, app replacement, or Persona feature removal.
- Only this project's engine, commander, and supply desk were stopped for the
  handoff. They remain stopped; other projects were not stopped.

## Integrated Behavior

The resident-desk cap defaults to 300,000 tokens (`0` disables it). At the next
spawn, a commander above the cap gets a fresh conversation with the existing
instructions to re-read current state. The supply desk is compacted once idle,
with guards for generation, nonempty input, menus, and repeated sends.

Cards now carry optional difficulty (`touch`, `standard`, `design`, `ultra`).
Optimize-mode workers use that value; long descriptions alone no longer select
the top tier. Safety keywords impose a minimum desired difficulty of `design`.
The existing max/economy modes and quota fallback remain unchanged.

Integration review found and fixed two manual-launch gaps: Auto must send
`tier: null` to clear a saved override before autosave, and title-only launches
must also forward an explicit tier. The saved-card safety floor still applies.
The API contract is documented in `05-board-api-contract.md`, section 6.2.

## Verification Performed by Codex

- Full Vitest suite: **453 files, 8,346 passed, 0 failed, 2 skipped**.
  Isolated temporary HOME, Node 22.22.0, Git 2.50.1, `--maxWorkers=4`.
- `npm run typecheck`: passed, including scripts.
- `npm run lint`: passed with 0 errors and 217 existing warnings.
- `npm run build`: passed.
- Playwright `e2e/board-tier.spec.ts e2e/smoke.spec.ts`: **5 passed**.
  Difficulty save/reset/reload and the safety-floor status were exercised at
  1280x900 and 390x844. Both screenshots were visually inspected. Only launch
  and feature visibility were intercepted; persistence used the real API.
- New route/UI regression tests: 4 observed failures before the fix, then all
  20 tests in the two affected files passed.
- The built server booted twice using the installed app's Electron runtime
  (Node 20.18.0), isolated HOME, and fake Claude CLI. The cap round-tripped through
  POST/GET settings, rejected an invalid update, and survived restart at `0`.
  Both processes exited and the test port was confirmed released.
- `git diff --check`: passed.

## Test Portability Corrections

Three pre-existing failures were reproduced on the original `814b4dc0` checkout.
Only their tests changed: public Swarm availability follows the host OS; retained
trust entries may include both a live path and its canonical alias; the Persona
geometry snapshot pins coordinates to 1e-9 figure units instead of runtime-specific
floating-point bytes. Node 22 and packaged Node 20 produce the same quantized hash.
Changing the geometry seed made the revised snapshot fail, then the seed was
restored. Persona production behavior is unchanged. Git 2.28 also caused an
environment-only identity-test failure; Git 2.50.1 passed without a source change.

## Not Reverified or Delivered

No real Claude request was made during this handoff because its usage limit was
exhausted. Earlier worker-recorded live checks remain in the inherited docs;
they are not fresh Codex verification. The packaged-runtime smoke is not a full
newly packaged GUI or live-model acceptance test. Upstream integration, release,
installation, and any fresh live-Claude acceptance remain separate delivery steps.

Concurrent untracked `AGENTS.md`, `.agents/`, and `.codex/` additions were preserved
and excluded from these commits.

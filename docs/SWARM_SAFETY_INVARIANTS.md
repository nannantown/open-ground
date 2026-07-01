# In-app swarm — safety invariants (the regression net)

The in-app swarm (`swarmOrchestrator` / `swarmIntegrate` / `swarmWorker` /
`swarmJanitor` + `server/routes/swarm.ts`) drives `claude` PTYs and mutates git
on the user's real machine. Before it can safely *improve itself* it needs a net
that **rejects a self-destroying change at the door** — the in-app counterpart of
the tmux toolkit's `~/.claude/test-swarm-safety.sh` (74 objective assertions).

This file is the canonical list of the safety invariants that net guards. Each
invariant is asserted by a regression test that is **green today** and that goes
**red the moment the invariant is broken** — and, for the four highest-risk ones,
a companion *negative-control* test performs the unsafe action directly to prove
the assertion has teeth (i.e. that "deliberately breaking it" really is caught).

Tests:

- `src/lib/server/swarmSafety.test.ts` — invariants **A**, **B**, **D** (real git
  fixtures in a tmpdir; no mocks, no network).
- `server/routes/__tests__/swarmSafety.routes.test.ts` — invariant **C** (the real
  Hono app via `app.request`, owner gate swept across *every* `/api/swarm` route).

All tests run with `OPENGROUND_HOME` pinned to a throwaway tmp dir (see
`src/test/setup-home.ts` + each file's `beforeEach`), so the suite **never touches
the real `~/.openground`** — the home-isolation invariant the whole vitest suite
already enforces.

---

## The guarded invariants

### A — Integration never force-pushes; a non-fast-forward push is rejected
`swarmIntegrate.integrateBranch` / `rebaseAndPush` push the worker branch at the
trunk with a **plain** `git push` — never `--force` / `-f`, never a `+refspec`,
never a `:ref` deletion. If another worker landed a commit on the trunk between
our fetch and our push, the push is **rejected as non-fast-forward** and the
function returns `{status:'error'}` — it never forces past it, so the other
worker's commit on the trunk is never clobbered.
*Code:* `swarmIntegrate.ts` (the FF arm and the post-rebase push, both no-force).
*Mirrors:* `test-swarm-safety.sh` §13 (`git push --force` / `-f` / `:main` → BLOCK).
*Negative control:* a raw `git push --force` in the same fixture **destroys** the
rival commit — exactly what test A1 forbids.

### B — Worktree teardown only ever deletes inside the central worktrees dir
`swarmWorker.removeSwarmWorktree` removes a path **only** when it sits strictly
under this project's central worktrees dir (`~/.openground/projects/<uuid>/worktrees/`,
canonicalized + symlink-resolved). The bare central root, the **main checkout**,
an **out-of-central linked worktree**, and a **symlink escaping central** are all
refused (`{removed:false, reason:'not a central worktree'}`) *before* any
git / PTY-kill / unlink runs. Even `force:true` cannot make it leave that boundary.
*Code:* `swarmWorker.ts` (`removeSwarmWorktree` guard) + `worktreeCleanup.isUnderCentralDir`.
*Mirrors:* `test-swarm-safety.sh` §16/§21 (never touches the main tree / non-swarm).
*Negative control:* the raw `git worktree remove --force` a guard-less impl would
run **does** delete the out-of-central worktree — proving the guard is the only
thing that stopped it.

### C — Every `/api/swarm` route is owner-gated
Every route in `server/routes/swarm.ts` returns **403** for a signed-out caller
**and** for a signed-in non-owner (tester) — *before* any body parse, path
validation, preflight, or git — closing the local `curl` / SDK direct-call hole
(the UI hiding the tab is not the only guard). The sweep is driven off the live
Hono route table, so a **newly added swarm route that forgets the gate** also trips
it.
*Code:* `server/routes/swarm.ts` (the `getCustomTabRole() !== 'owner'` gate atop
every handler).
*Mirrors:* `test-swarm-safety.sh` §13 (the PreToolUse gate is owner-scoped).
*Negative control:* a hand-built **un-gated** swarm route returns non-403 when
signed out — exactly what the sweep forbids.

### D — A merge conflict aborts; integration never continues through it
`swarmIntegrate.integrateBranch` rebases the worker branch onto the trunk in a
throwaway detached worktree; a **conflict is `--abort`ed**, nothing is pushed, the
worker branch ref is left untouched, and no half-rebase / leftover worktree
remains. It **never auto-resolves** a conflict — so a conflicting branch can never
silently overwrite the trunk's concurrent edit.
*Code:* `swarmIntegrate.ts` (`rebaseAndPush`: capture conflict → `rebase --abort`
→ `{status:'conflict'}`).
*Mirrors:* `test-swarm-safety.sh` §12 (the merge-block latch HELD on a recorded
failure) + the module's "NO automatic conflict resolution" contract.
*Negative control:* a merge that **continues through the conflict** (`-X theirs` +
push) silently overwrites the trunk's edit — what test D1 prevents.

---

## Supporting invariants (asserted by the pre-existing swarm tests)

These are already covered by `swarmIntegrate.test.ts` / `swarmJanitor.test.ts` /
`swarm.test.ts`; the safety net above deepens the four highest-risk ones and adds
the negative controls. Listed here so the full safety surface is in one place:

- Integration only ever touches the worker's **own `swarm/*` branch** (a non-swarm
  ref is `skipped`), and only the trunk (via a plain push) is ever written.
- A repo with **no remote trunk** is `skipped` — the trunk is the user's local
  checkout, which the engine must never move underneath them.
- Branch sweeps delete with `git branch -d` (git's own "fully merged" refusal is
  the net); **`-D` force-delete only on an explicit `force:true`**, and **never**
  for an `unknown`/unjudgeable branch.
- A remote branch sweep is a **non-force** `push --delete`, opt-in, swarm/* only.
- Heartbeat files are reaped only when **stale AND provably gone**; a fresh file
  (a live worker writing it) is always kept.
- The whole suite is **`OPENGROUND_HOME`-isolated** to a tmp dir — it never reads
  or writes the user's real `~/.openground`.

---

## Enforcement — the self-modification merge gate (card 34d42890)

Having the net is not enough: the commander engine must **refuse to auto-merge a
swarm change that breaks it**. So the integration path (`swarmOrchestrator`'s
`runIntegratePass` → `makeVerify`) carries a **diff-gated** check on top of the
always-on `tsc` gate:

1. **Detect.** Before landing a review branch, the engine computes the branch's own
   changed files vs the trunk (`changedFilesVsTrunk`: `git diff --name-only
   <trunk>...<tip>`). `touchesSwarmPaths` matches them against the swarm-code globs —
   `src/lib/server/swarm*.ts`, `server/routes/swarm.ts`,
   `src/components/canvas/modules/Swarm*`, **and the route safety net itself**
   (`server/routes/__tests__/swarmSafety.routes.test.ts`) so deleting/weakening it
   trips the gate too (the unit net is already covered by the `swarm*.ts` glob).
2. **Gate.** If (and only if) the branch touches swarm code, the engine runs the
   safety suite above (`SWARM_SAFETY_TESTS`) with the project's own `vitest`, inside
   the **same throwaway worktree it already builds for `tsc`** (branch rebased onto
   the trunk = exactly what would land). A RED suite returns `verify → ok:false`.
3. **Block.** A RED verify takes the existing path a RED `tsc` does: the card is sent
   **review→doing** (差し戻し) for the worker to fix, and parked in **`blocked`** after
   `MAX_REWORKS` (`reworkOrPark`). Nothing is pushed; the trunk is untouched.
4. **Don't slow the rest.** A branch that touches **no** swarm code never runs the
   suite — the diff gate skips it, so unrelated work pays nothing.

This closes the self-improvement loop safely: when the swarm edits the swarm, a
change that would break invariants A–D **cannot auto-merge** — the net it would have
broken is what stops it at the door. *Code:* `swarmOrchestrator.ts`
(`touchesSwarmPaths` / `changedFilesVsTrunk` / `swarmSafetyCheck` /
`swarmSafetyConditional` / the `makeVerify` conditional-check loop). *Tests:*
`swarmOrchestrator.integration.test.ts` (swarm+RED→block, swarm+GREEN→land,
non-swarm→suite skipped; real git + real diff detection, HOME-isolated).

---

## Generalized — the project-wide quality floor on EVERY branch (card 4e7f2151)

B2 above gated **one** suite (swarm-safety) for **swarm-touching** branches only. This
**generalizes** that to the project's full quality floor: before **any** swarm branch may
auto-merge, it must be **lint-clean, type-clean, AND have the full `npm test` suite green**.
The mechanism is the same `makeVerify` worktree run (branch rebased onto the trunk = exactly
what would land), now with three **always-on** checks plus B2's diff-gated one:

- **`tscCheck`** — `tsc --noEmit` (the always-on primary, unchanged).
- **`lintCheck`** — `eslint . --ext .ts,.tsx` (`npm run lint`), always-on (`lintConditional`,
  `appliesTo ⇒ true`).
- **`testCheck`** — `vitest run` (`npm test`, the **FULL** suite), always-on (`testConditional`).
- **`swarmSafetyConditional`** — **KEPT**, still diff-gated to swarm code. B2 is *contained*
  two ways: the full `npm test` SUBSUMES the swarm-safety suite, and the conditional remains
  on top purely for its **tamper guard** (a branch that DELETES a safety file passes the full
  suite — vitest silently skips a missing file — yet trips `swarmSafetyCheck`'s existence check).

Order is cheapest-first / heaviest-last (**tsc → lint → swarm-safety → test**), first-red-blocks,
so a fast failure never pays for the full suite. A RED check takes the **identical** path a RED
`tsc` does — **review→doing 差し戻し**, then `blocked` after `MAX_REWORKS` — and the failing
check's **label** (`lint` / `tsc` / `test` / `swarm-safety`) rides the reason into both the
**engine log** and the **worker's fix instruction**. Each check's own `applicable` still skips a
project lacking the tooling (an eslint / vitest config), so a non-OPEN-GROUND repo the engine
drives is never blocked on a gate it cannot run (mirrors `tscCheck`). *Code:* `swarmOrchestrator.ts`
(`lintCheck` / `testCheck` / `lintConditional` / `testConditional`; `defaultDeps` wires
`makeVerify(tscCheck, [lintConditional, swarmSafetyConditional, testConditional])`). *Tests:*
`swarmOrchestrator.integration.test.ts` (lint/test `applicable`+binary-missing RED; non-swarm
all-green→land with lint+test run & swarm-safety skipped; lint-RED→差し戻し; test-RED→差し戻し;
swarm branch runs all four & lands — real git + real diff detection, HOME-isolated).

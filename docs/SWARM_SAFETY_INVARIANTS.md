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
*Code:* `server/routes/swarm.ts` (the `hasSwarmOwnerAccess()` gate atop every
handler — `src/lib/server/swarmGate.ts`: the signed-in owner role OR the
explicit server-local unlock for login-disabled machines, env
`OPENGROUND_LOCAL_OWNER=1` / hand-edited `settings.swarmLocalOwner`; see
`docs/SECURITY.md` for why that unlock is not a boundary change).
*Mirrors:* `test-swarm-safety.sh` §13 (the PreToolUse gate is owner-scoped).
*Negative control:* a hand-built **un-gated** swarm route returns non-403 when
signed out — exactly what the sweep forbids.
*Unlock caveat:* the sweep above runs with the unlock ABSENT (its env var is
cleared in `beforeEach`), pinning the locked shipped default. The unlocked
side — both sources open every route signed-out, the unlock is swarm-scoped
(marketplace stays 403), and `POST /api/settings` can never set the key — is
pinned by `server/routes/__tests__/swarmLocalOwner.routes.test.ts`.

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

### E — The PreToolUse deny veto blocks destructive commands deterministically (A3 / safety layer L4)
`scripts/openground-guard.js` is the ONE veto that survives
`--dangerously-skip-permissions`. Under **worker-only scoping** (2026-07) it
polices exactly ONE kind of session: the confined, unattended **worker / overseer**
(`OPENGROUND_GUARD=1` + write roots). For that session it exits **2** (block) on a
destructive tool call; for **every other** session — including the trusted swarm
**manager / supply** (`SWARM_MANAGER=1`) and any plain claude — it exits **0** (a
byte-for-byte `{}` no-op). Policing the unconfined manager was unbounded
whack-a-mole (a Turing-complete shell has no finite carve-out — every adversarial
round leaked in the manager path); the manager is a trusted human-in-the-loop desk,
so it is not policed, which closes that whole class by design. Claude Code treats
**only exit 2** as a block — exit 1 is a *non-blocking* hook error that lets the
tool through — so the guard **never** exits 1 and **fails closed** (exit 2) on any
input it cannot parse. It denies the A3 classes — recursive `rm` outside the write
roots, `git push` in EVERY shape for the policed worker (plain/FF included — the
2e7beb2 lesson; the plumbing spellings `send-pack`/`http-push`, `git svn`'s
outbound writes, and the dash-form binaries `git-push`/`git-send-pack`/
`git-http-push`/`git-svn` — callable by absolute libexec path — are routed to the
same deny), history nukes (`reset --hard`, `clean -f`,
`filter-branch`, `update-ref -d`, `branch -D`, `stash drop/pop`, `checkout -f/--`,
`restore .`, `reflog expire`, `gc --prune=now`), and writes outside the roots
(redirections, `tee`/`cp`/`mv`/`dd`/`sed -i`/`perl -i`/`tar -x -C`/`unzip -d`, and
the `Write`/`Edit`/`NotebookEdit` file paths) — plus the substrate (the guard's own
installed copy, the `settings.json` hook wiring, `~/.claude/swarm-*.sh`, `CLAUDE.md`)
in the worker session. It defeats the evasion routes the official docs warn a
naive argument-regex misses: command-position variables/substitutions, `eval`/
`source`, `sh -c`/`bash -c`, an interpreter reading its program from **stdin** in
any form — pipe (`curl … | sh`, `base64 -d | bash`), heredoc (`python3 <<EOF`),
here-string (`node <<< …`) or input redirect — alias/function definitions, `sudo`,
`xargs` into a destructive verb (targets from stdin), `find -exec <destructive>`
over a dangerous start point, inline-code flags (`node -e`/`python -c`/`perl -pe`),
`git -c alias.*=…`/`--exec-path`/`ext::` transport injection, and quoting/ANSI-C
obfuscation — all via a real POSIX-shell
lexer that reasons about STRUCTURE (an `rm -rf /` inside a commit message is a
quoted *word*, never a command). Wired globally by `hooksInstall.ts` (which copies
the guard to the sandbox-write-denied `~/.openground/guard/` and adds a per-tool
`PreToolUse` entry); armed per-worker by `swarmWorker.ts` via
`launchClaude({guard:{writeRoots:[worktree]}})`. Independent of the L3 sandbox — L4
holds when the experiment is off, and runs *inside* the Seatbelt boundary when it's
on.
**The wiring itself is fail-closed at spawn time (GAP-2, 2026-07-11).** Claude
Code fails a MISSING PreToolUse hook OPEN, and the boot-time `installHooks()`
(server/index.ts) is fire-and-forget — so an install failure used to leave the
next worker spawn unguarded. `spawnSwarmWorker` now verifies the full wiring
BEFORE the worktree exists — `ensureGuardWiring()` (hooksInstall.ts): the
settings.json `PreToolUse` entry for every guarded tool must match the expected
command, AND the installed guard body must be byte-identical to the expected
version (`scripts/openground-guard.js`); one idempotent `installHooks()`
self-heal attempt, then a fresh read-back re-verify — still unverified ⇒ the
spawn is REFUSED (`GuardWiringError`) and a `'guard-unwired'` fatal notification
(bell + OS toast, throttled) surfaces the refusal. The verifier is a STRICT
reader — any read/parse failure, missing entry, or byte mismatch is NOT-verified
(a tolerant reader would make the gate fail-open in disguise). Every worker path
(engine dispatch, `POST /api/swarm/worker`, RESTART) funnels through this gate;
asserted by `swarmSafety.test.ts` INVARIANT **E-FAILCLOSED** (deliberately broken
wiring ⇒ refusal + no worktree + bell record; negative control: intact wiring
passes the gate).
*Code:* `scripts/openground-guard.js` (`evaluate` / `analyzeBash` / `analyzeGit` /
`makePathPolicy`); wiring in `hooksInstall.ts` + `sandbox.ts` + `claudeTerminal.ts`
+ `swarmWorker.ts`.
*Honest scope:* not a sandbox — a payload staged *inside* the write roots then run
from a live process (`node planted.js`), and a stream editor's own script commands
(`sed 'w /path'`/`e`), are L3's job (OS-enforced), documented in the guard header.
*Known residuals of the push ban (documented in the guard header too):*
(1) a **pre-existing** user/system gitconfig alias (`[alias] p = push` → `git p`)
is statically unresolvable and stays ALLOW — every *in-session* route into it is
closed (`git config alias.*`, inline `git -c alias.*=…`/`--config-env`,
`--exec-path` are all denied), so it takes an alias the user already shipped
before spawn; neutralizing those via `GIT_CONFIG_GLOBAL=/dev/null` (+
`GIT_CONFIG_SYSTEM`) was considered and rejected — it strips `user.name`/`email`
and credential helpers, breaking the worker's core commit/fetch flow.
(2) `git apply` / `patch` can rewrite the repo's **tracked** guard source
(`scripts/openground-guard.js` sits inside the write roots; the substrate
basename rule covers Write/Edit/shell writes/`git mv|rm`, not content-level patch
application) — the **installed** copy (`~/.openground/guard/`) stays write-denied,
so this cannot disarm the live veto; it is a plant-and-wait-for-deploy channel,
closed at integration time by the commander's re-verify + adversarial review +
the swarm-code merge gate below, not at L4.
(3) the tmux-era worker (`~/.claude/swarm-guard.sh` toolkit) remains
**prompt-discipline-only** — the machine-enforced push ban polices the in-app
worker (`OPENGROUND_GUARD=1`).
*Negative control:* with the worker gate env **absent** — including a manager
(`SWARM_MANAGER=1`) session, which is now a full no-op — the same `rm -rf /` /
force-push exit **0** (the veto is worker-scoped; only `OPENGROUND_GUARD=1` arms the
teeth); the
end-to-end tests spawn the real script and assert the process **exit code** (2 vs
0), so a regression to exit 1/0 on a dangerous command goes red.

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
   `src/lib/server/swarm*.ts`, `server/routes/swarm.ts`, `server/routes/project.ts`
   (the Board API — the swarm contract's real surface, docs/commander/05),
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

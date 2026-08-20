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
- `src/lib/server/gateEnv.test.ts` — invariant **F** (the handoff policy + a
  source-text pin on every spawn site). Deliberately spawn-free: it runs inside
  the merge gate's 240s budget, so it must stay cheap and deterministic.
  - `src/lib/server/gateEnvTamper.test.ts` — **F**'s end-to-end demonstration (a
    fixture worktree with deliberately tampered `vitest.config.ts` +
    `setup-home.ts`, run through the real `testCheck`). NOT in the net: it spawns
    a real vitest, and nesting that inside the gate's budget invites load-induced
    false REDs. It runs on every branch via the full suite instead.
- `src/lib/server/testHomeGuard.test.ts` — invariant **G** (the production-home
  fence; teeth measured — see below). Includes child-process cases, because the
  one hole found by review could only be reproduced with the poisoning in place
  *before* the guard module loads.
  - `src/testHomeEnvGuard.test.ts` — **G**'s static half (51 cases): sweeps that
    share ONE file enumeration (`git ls-files` + a JS-side `SOURCE_EXT`, so
    `.mts`/`.cts`/`.jsx` cannot fall through a pathspec, and a file carrying NUL
    bytes cannot be skipped in silence the way `grep` skips it). The unset sweep
    fails the build if `delete process.env.<home var>` comes back — including the
    `vi.stubEnv(…, undefined)`, aliased-`env`, whole-object-replacement and
    empty-string spellings of the same act; the resolver sweep fails it if a
    SECOND home resolver appears outside the choke point, in any of six spellings
    (`homedir` / `process.env.HOME` / `process.env['HOME']` / `USERPROFILE` /
    `HOMEPATH` / `getPath('home')`). Both matchers are pure functions with their
    own teeth, because a sweep returns `[]` both when nothing is wrong and when
    it looked at nothing — measured 2026-07-21, when the narrower version stayed
    **51/51 green** with two real violations planted in `scripts/` and
    `electron/` (`docs/commander/07` §4.14).

All tests run with `OPENGROUND_HOME` pinned to a throwaway tmp dir (see
`src/test/setup-home.ts` + each file's `beforeEach`), so the suite **never touches
the real `~/.openground`**.

> **CORRECTION (2026-07-19).** Until this date the paragraph above was a claim,
> not a fact. The pin existed, but the check that "verified" it was a tautology
> (`join(tmpdir(), …)` asserted with `startsWith(tmpdir())`), and on **2026-07-18
> a vitest run overwrote the user's real `~/.openground/settings.json` — 45
> registered projects collapsed to 3, and `canvas.json`'s card layout was lost
> for good.** Home isolation is now enforced by invariant **G** below, at the
> resolution seam, and its teeth are measured rather than asserted. Full contract:
> [docs/commander/07-test-isolation-contract.md](commander/07-test-isolation-contract.md).

**That in-suite pin is not a security control, and must not be read as one**
(invariant **F**): when the *engine* runs this suite against a branch, both
`setup-home.ts` and the `vitest.config.ts` that loads it come **from that branch**.
The isolation that matters is the one the engine imposes from OUTSIDE, before the
child starts.

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
`OPENGROUND_LOCAL_OWNER=1` / hand-edited `settings.swarmLocalOwner`, OR — since
0.11.94 — the PUBLIC macOS opt-in `Settings.swarmOptIn` (`isSwarmOptInEnabled`,
macOS only, user-settable behind a "still being tuned" warning). All three are
feature-visibility openers, not boundary changes; see `docs/SECURITY.md` for why
(the loopback-only API already runs arbitrary shells via `POST /api/terminal`).
*Mirrors:* `test-swarm-safety.sh` §13 (the PreToolUse gate is owner-scoped).
*Negative control:* a hand-built **un-gated** swarm route returns non-403 when
signed out — exactly what the sweep forbids.
*Unlock caveat:* the sweep above runs with every opener ABSENT (the local-unlock
env var is cleared in `beforeEach`, and the opt-in setting is unset + the test
host is non-macOS), pinning the locked shipped default. The unlocked side — both
local-unlock sources open every route signed-out, the unlock is swarm-scoped
(marketplace stays 403), and `POST /api/settings` can never set the `swarmLocalOwner`
key — is pinned by `server/routes/__tests__/swarmLocalOwner.routes.test.ts`. The
public opt-in opener (macOS-only, swarm-scoped, opens the gate but NEVER
sandbox/persona) is pinned by `src/lib/server/swarmGate.test.ts` +
`experiments.test.ts` + `swarmOptInSetting.test.ts`.

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

### F — The engine never hands untrusted branch code the production home
Every engine spawn that runs **code from the artifact being judged** — the merge
gate's `tsc` / `eslint` / `vitest`, the self-supply scanners, and the self-update
`npm run build` / `npm test` — receives an `OPENGROUND_HOME` that the **engine**
mkdtemp'd, never the real one. Loading a worktree's `vitest.config.ts` and its
`setupFiles` is arbitrary code execution before any assertion runs, so "the suite
isolates itself" was circular: that isolation ships **inside the artifact**. The
production-data pointers (`OPENGROUND_HOME`, `OPENGROUND_MEMORY_DIR`,
`OPENGROUND_CONCEPT_PATH`, `CLAUDE_CONFIG_PATH`) are **redirected** — never unset,
since every reader falls back to a `homedir()`-derived production path — and the
secrets/authority the engine really carries (`SUPABASE_*`, the admin/owner email
allowlists, `OPENGROUND_LOCAL_OWNER`) are stripped.
*Deliberately NOT redirected:* `OPENGROUND_SOURCE_ROOT` — it names the checkout the
child is already running inside (its own `cwd`/`.git`), so passing it grants no
reach the child does not already have, and the self-update request path it feeds
(`selfUpdateSignal`) is an engine concern, not something a test/lint/build child
can invoke. This list is the whole set; anything not named here is passed through.
*Code:* `src/lib/server/gateProcess.ts` (`gateEnvFor` / `withGateEnv`), duplicated
for the Electron main process in `electron/gateEnv.js` (parity pinned by
`server/__tests__/gateEnvParity.test.ts` — as SETS, not just by output equality,
because output equality alone cannot see a key ADDED to only one copy).
*Exception — producers:* a step that BUILDS the shipped artifact must keep its
build inputs. `npm run build`'s first stage bakes `BAKED_KEYS` into
`electron/runtime-config.json` (and always rewrites the file, so stripping erases
rather than preserves), which silently shipped a build with sign-in and collab
disabled. `electron/gateEnv.js buildProducerEnv` exempts exactly that allowlist —
read from `runtimeConfig.js`, whose own `assertBakeable` guard refuses to admit a
secret or authority key. **That guard and the strip policy must be ONE set of
rules**: the exemption overrides stripping, so any name the guard admits is a name
handed to untrusted code. They were not one, twice — round 3: the guard's pattern
lacked `TOKEN`; round 4: the guard checked only the pattern while stripping was
pattern ∪ list, so listed-but-not-secret-named keys (`FEEDBACK_ADMIN_EMAILS`,
`OPENGROUND_OWNER_EMAILS`, `SUPABASE_*_TABLE`, `OPENGROUND_LOCAL_OWNER`) could pass
it. Both now read `electron/secretPolicy.js`, which splits the strip list into
**FORBIDDEN** (secrets + authority — never bakeable) and **HERMETIC** (public
values stripped only for test hygiene — deliberately baked and handed back to
producers). Conflating those two again either re-opens round 4 or re-breaks the
build. The parity test pins all three copies equal and asserts no BAKED_KEY is
forbidden.
Verifier steps (tsc / eslint / vitest / scanners) strip everything.
**Producer-ness is TRANSITIVE**: the `e2e` regression step runs no build itself,
but playwright's `webServer.command` starts with `npm run build && …`, so it is a
producer too (`buildStepEnv` + a per-step `producer` flag). The flags are
cross-checked against `package.json` + `playwright.config.ts`, so a build added to
another step's script fails a test instead of erasing the config.
*Beyond the hand list:* a secret-NAME pattern
(`/SERVICE_ROLE|SECRET|PASSWORD|PRIVATE|TOKEN/i`, mirroring the bake-side guard)
strips secrets nobody enumerated — added after `OPENGROUND_COLLAB_TICKET_SECRET`
was found missing from the list.
*Negative control:* the fixture worktree ships a `vitest.config.ts` with no
`setupFiles` **and** a gutted `setup-home.ts`, and its probe reports the home it can
actually reach; the assertion is that the reported home is the engine's throwaway
and **not** the engine's own. Reverting any spawn site to `{ ...process.env }` makes
the reported home identical to the engine's → red (verified by hand, 2026-07-19).
*Scope:* an env-handoff control, **not a sandbox** — `HOME` itself is deliberately
untouched, so code that actively deletes the injected var can still derive
`homedir()/.openground`. Reasoning, measurements and the rejected alternatives:
`docs/commander/03-integration-review.md` §2.9.
### G — A test process can never resolve an OPEN GROUND home outside tmpdir
While a test process is running, every OPEN GROUND home path **must** canonicalize
under the OS temp dir; anything else **throws — reads included**. The check lives
at the single resolution seam (`paths.openGroundHome()`, which every `*File()` /
`*Dir()` builder is made from) plus the one anchor it structurally cannot cover
(`hooksInstall`'s deliberately `homedir()`-anchored install dirs), and both call
**one** implementation so they cannot drift. There is deliberately no opt-out env.
*Code:* `src/lib/server/testHomeGuard.ts` (`testHomeProblem` decides,
`assertTestHomeIsolated` throws), wired into `paths.openGroundHome()` plus the
four `homedir()`-anchored resolvers (`hooksInstall` / `claudeTrust` /
`ogManageSkill` / `generateSkill`); detection + blame in `src/test/setup-home.ts`
(`verifyAndRepin`, which calls the SAME predicate rather than restating it).
Referenced by symbol, not line: the line numbers in this file rotted twice in one
day, and a stale anchor sends the next reader to the wrong code.
*Why it must sit in the path BUILDER, not inside the fs call:* `store.readJson` is
a tolerant reader (`catch { return fallback }`), so a fence thrown during
`readFile` would be swallowed and `getSettings()` would hand back defaults as if
nothing were wrong — fail-closed degrading to fail-open, a shape this repo has
been bitten by before. Pinned by the *"getSettings REJECTS rather than falling
back to defaults"* case.
*Negative control (measured, not assumed):* neutering `assertTestHomeIsolated` to
a no-op turns **15 of 22** cases red; breaking test-mode detection turns **16**
red; re-introducing a single unconditional `delete process.env.OPENGROUND_HOME`
turns `swarmNotifications.test.ts` **10 red and names the offending file**.
Re-measured after each later round — most recently, reverting the
poisoned-`TMPDIR` fix turns exactly the **2** child-process cases red while the
isolated-`$HOME` regression case stays green.
*Denominator caveat (2026-07-20):* the **/22** above is the case count as of the
§4.3 baseline; the file now holds **43**. That specific ratio has NOT been
re-measured since, and deliberately so — obtaining it means running all 43 cases
with `assertTestHomeIsolated` neutered, which is the exact condition that
destroyed the user's data on 2026-07-18. The per-round reverts quoted above are
narrow (revert ONE fix, watch ITS cases) and carry no such exposure. Read the
ratio as "most cases, measured once at that size", not as a current figure.
*Known boundary:* this invariant is about a test process resolving a home. It does
**not** cover a `--pool=threads` run: `worker_threads` share one `process.env`
view for `os.homedir()`, so the seven files that pin `HOME` lose their isolation.
That direction is **fail-closed** (the fence sees the real home and throws), so it
surfaces as a red suite rather than as damage.
Procedure + full results: `docs/commander/07-test-isolation-contract.md` §4.

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
   the trunk = exactly what would land), and — since 2026-07-19 — with an
   `OPENGROUND_HOME` the engine mkdtemp'd rather than its own (invariant **F**).
   A RED suite returns `verify → ok:false`.
   *Membership rule for `SWARM_SAFETY_TESTS`:* a file belongs in that list when its
   **deletion would silently re-open a hole**, because the list's real power is the
   existence check in `swarmSafetyCheck.run` (vitest silently skips a missing file,
   so a deleted test would otherwise pass vacuously). `gateEnv.test.ts` was added on
   those grounds — it is the only pin on the env handoff.
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

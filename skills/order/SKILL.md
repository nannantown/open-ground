---
name: order
description: |
  Max-effort mode: pursue a goal (observable "done" condition) via
  git-worktree-isolated parallel tracks x team-scale multi-agent fanout
  (Workflow, ultracode-equivalent) x loop-until-done. One worktree per
  track so concurrent terminals/claude/subagents never collide.
  goal-workflow's no-compromise superset.
  Trigger: **explicit only** - `/order` typed, or swarm spawning a worker
  (`/order ゴール: ...`, ORDER_PREFIX). Not phrase-triggered (removed
  2026-07-22, swarm always passes `/order` explicitly). Expensive -
  explicit max-effort asks only; normal tasks fit goal-workflow/one agent.
---
<!-- managed-by: openground - auto-deployed on launch, hand edits
     overwritten. Canonical: skills/order/SKILL.md in the OPEN GROUND
     repo. Remove marker -> treated as user-authored, stops updating. -->

# order - worktree isolation x ultracode team x loop-until-done

Three pillars: (1) **non-colliding parallelism** - one git worktree per
track; (2) **team fanout** - `/effort ultracode`-equivalent: Workflow
staffs a team per phase (understand->design->implement->review),
implementation worktree-isolated, review adversarial-majority-vote,
integrate last - best beyond one context; (3) **loop to done** - `/goal`
spirit, loop Audit->implement->verify->integrate until observable
condition holds (tests green, checklist 100%). Superset of goal-workflow,
no compromises; light tasks use goal-workflow or one agent.

Owner-facing text (chat, escalation/blocker questions, status reports)
follows the launch prompt's `[Reply language]`/`【返答言語】` line (Settings.language),
not this file's language. Commit/PR text follows CLAUDE.md instead.

## Inputs (confirm if ambiguous)
1. **Goal (required)** - observable, true/false-checkable, e.g. "Board
   chat->reflect/frame/text/comment work; tests/tsc/lint/e2e green." Ban
   infinite superlatives ("perfect") - use measurable proxies. **State
   final placement** (project's Canvas/Board/file) separate from where
   it's *verified* - "verified in test/dev" isn't placement. Unstated ->
   ask, or default to target project. **Swarm-core edits need a
   docs-followup condition**: touching SWARM_CODE_PATHS
   (swarmOrchestrator/swarmWorker/swarmQuota/swarmAllowedModels/
   swarmLaunch/swarmIntegrate/swarmOverseer*/swarmEscalations/
   swarmNotifications/swarmWorkerRegistry/swarmJanitor/server/routes/
   swarm/server/routes/project) -> add "update matching docs/commander/
   chapter (or note none needed)" (docs/commander/TARGET-STATE.md §6).
   Structural changes -> also add "update matching docs/MAP.md entry."
2. **Parallel unit** - (a) independent subtasks (b) multiple approaches
   (c) multiple targets; non-overlapping files per unit.
3. **Branch/PR policy** - default: feature branch+PR per unit; protected
   main -> no direct push, CI required; optional squash branch.
4. **Scale/budget** - max agents/rounds/time-token cap.

## Pipeline (every round)
**0. Where to run** - local repo/worktree/app-run/visual check -> local
only (cloud `/schedule` is headless, no local FS access); local triggers
-> `/loop` (needs session+machine alive).

**1. Audit** - break goal into an observable checklist ("done when...");
check current state (round 1); re-split items to be independent with
non-overlapping files.

**2. Fan out via worktrees** - one worktree + one parallel agent per
unfinished independent item. Agent tool `Agent({ isolation: "worktree" })`
(auto-cleaned if unchanged), or Workflow `agent(prompt, { isolation:
'worktree' })` via `parallel()`/`pipeline()` (concurrency ~16, cap 1000).
Isolate whenever concurrent writes are possible. Explicit file/dir scope
per agent, no going outside it. **Don't fan out parallel implementers
when the integration target is one file/component** (same-file writers
collide) - one worktree, fanout limited to read-only audit/review.
`order`'s value is the loop, not parallelism itself; N implementers on
one target is a misuse.

**3. Verify** - each worktree: `build`/`test`/`lint`(+`e2e`); fail ->
revert/retry. Important findings get adversarial review (separate agent:
"is this actually right? what breaks it?"); ultracode scale = multiple
reviewers + majority vote per item.

**4. Integrate** - commit each worktree's result to a feature branch -> PR
per unit; protected main: PR+CI, merge only once green. **Never `git
merge` on the shared primary checkout** (dirty pre-commit WIP from others
blocks it, PR or not). Instead: `git push origin <branch>:main` (one step
if FF), or merge in a disposable worktree off `origin/main`. Merge
sequence, exactly (git run inline by Opus/main loop, never delegate to
Sonnet, [[git-ops-use-sonnet]]):
1. `git fetch origin main` first - don't assume FF.
2. Confirm tests green (tsc/test per goal criteria); red -> stop, no push.
3. `git merge-base --is-ancestor origin/main HEAD` -> FF possible? ->
   `git push origin <branch>:main`.
4. No FF but no conflict (another track landed first, **routine, not an
   error**) -> `git rebase origin/main` -> re-verify -> green -> FF push.
   Check overlap via `git diff --name-only $(git merge-base origin/main
   HEAD)..HEAD`. **Never treat not-FF->rebase->FF as an anomaly and stop.**
5. Real conflict -> stop, report. **Never force-push**, never displace
   another session's WIP via commit/stash/discard.
Clean up merged branches, unneeded worktrees (`git worktree remove`).

**5. Completion check -> loop or stop** - evaluate checklist+tests every
round; not met -> repeat on remaining items. Stop: checklist 100%+tests
green, OR budget/time guard hit, OR requester stops. On stop: clean up,
report (severity counts, remaining issues, PR list).

**6. Heartbeat (always emit)** - so `manager` (commander session) can
monitor/integrate multiple workers, update at every phase boundary
(`worker` writes the initial one, you overwrite thereafter):
```
bash ~/.claude/swarm-beat.sh <phase> <ready:true|false> "<one-line status>" ["<blocker>"]
```
When: Audit done / implementing (summary changed) / before a long step
(build/test) / verifying / `done true "..."` once merge-ready / `blocked
false "..." "reason"` if stuck. Recency=liveness (30+ min silent =
stuck). `ready=true` = tests green, integrable; manager acts on it.
**`[hold]` propagation - never drop it**: goal started with `[hold]` ->
every heartbeat's summary also starts with `[hold]` (e.g. `done true
"[hold] editor-select UI done, awaiting approval"`) so commander holds
for approval instead of auto-merging (default=auto-merge, `[hold]` is
the only opt-out). Strip it from goal text before implementing (it's a
merge-policy flag, not a feature to build). **Dropping the prefix even
once disarms the hold gate.** Always include it.
File: `~/.openground/swarm/<repo-key>/<branch>.json`. **Never merge your
own work or remove your own worktree** - commander's job (and it cleans
the heartbeat with it).

## Worktree / dev-server operational notes
`.git/worktrees`-managed; each a full checkout (disk-heavy). Gitignore
your worktree dir (e.g. `.claude/worktrees/`). **Never touch another
session's worktree/dev server** - an unfamiliar change may be legitimate
WIP. `git worktree remove <path>` when done (no-change isolated worktrees
auto-clean). **Never `git stash`** - commit or discard.

Worktrees isolate files, not ports (stale `npm run dev` can evict the
standard pair, Web 5174/API 47776). Extra instances always `npm run
dev:alt` (plain `npm run dev` fights over 5174/47776). Stop your own dev
server on cleanup too (`git worktree remove` leaves it running). Never
kill another session's dev server -
distinguish via `ps -eo pid,lstart,command` path
(`.../<repo>/node_modules`=main vs `.../.claude/worktrees/X/...`=other) +
start time; kill only old main-owned, confirm unused first. Kill with
literal PIDs (`kill 111 222 333` - `kill $VAR` silently no-ops in zsh,
word-split with `${=VAR}`); verify after. Diagnose: `lsof -nP -iTCP
-sTCP:LISTEN | grep -E ':(5174|47776)'` - nothing listening -> port lost,
plain `npm run dev` reclaims it; green `tsc` rules out a code cause.

## Guardrails
Never push directly to protected branches, PR+CI always. Stick to
observable goals - vague criteria loop forever. Small batches, cut by
checklist item. Local execution needs machine+session alive - say so. No
destructive ops, prod-data writes, or undisclosed deploys; tests isolate
HOME/prod stores. Respect project constraints (e.g. subscription-only, no
API keys). **Within OPEN GROUND**: new work defaults English, no
retroactive translation of existing Japanese (exceptions/owner-facing
output/frozen markers: canon = CLAUDE.md "Language policy").

## Request template
```
/order
Goal (completion condition): <observable fact, e.g. Board run executes in priority order, tsc/test/lint/e2e green>
Checklist: <independent items, non-overlapping files>
Parallel unit: <independent subtasks / multiple approaches / multiple targets>
Isolation: worktree (default - 1 track = 1 worktree)
Branch/PR: <branch name / PR per unit / protected main=PR required / final integration branch>
Scale/budget: <agent count / round cap / time-token cap>
```

## Related
[[goal-workflow]] - lighter (scheduled trigger x parallel x loop), enough
day-to-day. No concurrent-write risk -> shared-tree fanout, no isolation.

# AUTONOMY-SPEC — unattended operation the owner can trust

**Status:** requirements + specification only (2026-11-28). Nothing here is implemented.
**Base:** origin/main = release 0.11.211 (`07ae82aa`). Symbols are cited by file + name, never by line.
**Reader:** the engineer who implements it, and the commander who integrates it.
**Evidence:** measured read-only on the owner's machine on 2026-11-28 (receipt journal, Claude
transcripts, the live app's GET endpoints, 7 days of token records). Every claim about current
behaviour names the code that produces it. Where a claim could not be measured, it says so.

---

## 0. オーナー向け

### 実装すると実現されること

- アプリの更新・再起動・使用量の上限のあとも、社長・マネージャー・ワーカーは自分で戻り、
  止まっていた作業を続きから再開します。オーナーが何かを押す必要はありません。
- 「中断した作業の確認」がほとんど出なくなります。いま残っている 8 件のうち 7 件は、調べると
  結果が記録に残っていました。こうしたものはアプリが自分で確かめて片づけます。
- 本当に結果が分からない操作が残ったときも、止まるのはその会話だけです。同じプロジェクトの
  ほかの作業や、社長との会話は止まりません。
- その確認は、質問と同じ場所(黄色い手のしるし)に 1 件の質問として届きます。何が・いつ・
  だれの作業で止まったのかが普通の言葉で書かれ、ボタン 1 つで答えられます。社長に聞けば
  説明してくれます。設定の奥を探す必要はなくなります。
- 使用量の上限に作業の途中でぶつかることが、ほとんどなくなります。残りが少ないときは新しい
  作業を始めず、動いている作業を先に終わらせます。上限が戻ると自動で再開します。
- 1 週間の使用量を配分します。週の前半で使い切って後半が止まることが起きにくくなり、
  オーナー自身が社長と話すための分はいつも残ります。
- 待っているだけの社長・マネージャーは使用量を使いません。アプリを起動しただけで使用量が
  減ることがなくなります。
- どのプロジェクトが動いていて、どれが待っていて、なぜ待っているのかが、ひと目で分かります。
  理由なしに止まっている状態は、アプリ自身が見つけて知らせます。

### やらないこと

- 結果が本当に分からない操作を、自動でもう一度実行することはしません(これまでどおり)。
- API キーは使いません。Claude の契約(サブスクリプション)だけで動かします。
- 画面に説明の文字や絵文字を増やしません。しるしの色は今の 3 色(緑・青・黄)のままです。
- 本線への取り込み(統合)のやり方と、マネージャーだけが統合する決まりは変えません。
- Windows 対応、共有機能、ChatGPT 接続の作り直しは対象外です。
- オーナーの設定(実行モードなど)を勝手に書き換えません。変えるときは社長に頼む形のままです。

オーナーに決めていただきたいことは §7 にまとめています(4 件)。

---

## 1. Measured facts this spec rests on

### 1.1 The eight holds (GET `/api/conversation/recovery`, `~/.openground/runtime/receipts-v2.json`)

Each receipt's `body.sessionId` / `body.toolId` was looked up in `~/.claude/projects/`. **Every one of the
seven tool receipts has its outcome recorded in a transcript.** Five of them sit in the sub-agent file
`<project>/<sessionId>/subagents/agent-*.jsonl`, which is why an earlier search of `<sessionId>.jsonl`
reported "in no transcript".

| Project | Claimed (UTC) | Actor | What the transcript records | Why the receipt stayed open | Really unknown? |
|---|---|---|---|---|---|
| sns-hub | 11-09 09:06:14 | commander's sub-agent | 85 ms later: `PreToolUse:Bash hook error: [bash ~/.claude/swarm-guard.sh]: swarm-guard BLOCKED: git worktree remove --force` | veto by a hook the audit does not wrap, in a sub-agent | no — never ran |
| Music Production | 11-09 23:27:28 | commander's sub-agent | same hook: recursive rm on an absolute, home or parent path | same | no — never ran |
| Documents | 11-15 02:19:17 | commander's sub-agent | same | same | no — never ran |
| JobSearch | 11-26 05:28:09 | commander's sub-agent | same | same | no — never ran |
| openground-ec | 11-20 09:03:31 | worker | normal result, `PostToolUse` recorded | second process (fixed in 0.11.211) | no — completed |
| OPEN GROUND | 11-26 06:31:35 | commander's sub-agent | normal result 0.6 s later; the parent turn was refused by the 5-hour limit 0.17 s earlier | the closing callback was never recorded | no — completed |
| openground-ios | 11-26 23:02:21 | commander | `Exit code 137` 1.8 s later | the server process ended before the failure callback | no — returned failure |
| JobSearch (`native-…`) | 11-26 23:01:03 | president (PTY) | `tool_use`, no result, no `PreToolUse` record; the app relaunched at 23:01:06 (`engine-boots.json`) | PTY sessions have no receipts; `inspectSwarmNativeConversation` sees an unfinished tool | yes (the only one) |

All seven carry `error: "The app restarted after this operation began…"` — the boot sweep in
`conversationReceipts.transaction` flips every `executing` receipt of a gone process, whatever happened to
the call. Journal totals: 1,026 delivered (3 of them as `sdk-native-pretool-failure`), 30 rejected
(`source: sdk-guard-veto`), 7 uncertain, plus 4 review records. Why the OPEN GROUND row's callback was
not recorded cannot be proven from disk (a teardown race or a failed write are both possible); R-B1 does
not depend on which.

Two facts the code comments get wrong today:
- **SDK sessions do load `~/.claude/settings.json`.** `sdkManagerLaunchPlan` / the worker plan omit
  `settingSources`; Agent SDK 0.3.220 documents "When omitted, all sources are loaded". So the owner's
  `swarm-guard.sh` (active because the commander runs with `SWARM_MANAGER=1`) and the command-hook copy of
  `openground-guard.js` both run inside SDK desks and their sub-agents. `docs/MAP.md` §5 still says the SDK
  reads no filesystem settings.
- `hasChatGptAccess()` (`chatgptAccess.ts`) means "the signed-in app **owner role**". It has nothing to do
  with a ChatGPT connection. Receipts are recorded and enforced only for that role
  (`createClaudeRuntimeToolAudit`, `listUncertainRuntimeActions`); the review screen is rendered inside
  `ChatGptSetting.tsx` only because the feature was born with the ChatGPT runtime.

### 1.2 Where the tokens went (7 days to 2026-11-28, all `~/.claude/projects` transcripts, de-duplicated by message id + request id; total matches GET `/api/usage/breakdown` = 49.4 M)

| Who | Billed (input + output + cache write) | Cache read | API calls | Avg context read per call |
|---|---|---|---|---|
| Worker, main conversation | 15.5 M (31%) | 525 M | 2,581 | 203 k |
| Worker, sub-agents | 11.8 M (24%) | 272 M | 1,972 | 138 k |
| Commander, main | 6.4 M (13%) | 279 M | 1,178 | 237 k |
| Commander, sub-agents | 6.2 M (12.5%) | 207 M | 983 | 211 k |
| President | 6.3 M (12.6%) | 72 M | 460 | 156 k |
| Owner's own sessions | 2.9 M (6%) | 99 M | 298 | — |
| Other folders | 0.5 M (1%) | 0.6 M | 68 | 8 k |

- The app's "other 39%" **is sub-agents** (18.4 M of 18.9 M): `claudeUsage.collectUsageBreakdown` names a
  transcript's source from its parent folder, and a sub-agent file's parent folder is `subagents`.
  Workers are 55% of billed tokens, not 33%; sub-agents alone are 37%.
- Cache reads are 1,454 M — 29 times the billed figure — and the breakdown does not show them. They are
  driven by context size times call count; one commander conversation read 191 M.
- `~/.openground/settings.json`: `executionMode: "max"`. `swarmLaunch.desiredModelEffort` returns the top
  tier at `max` effort for **every** role in that mode (workers, commander, president).
- `GET /api/usage` at 2026-11-28 03:31 UTC read session 5%, week 1%; the operator read week 98% a day
  earlier with the same reset date. One of the two readings is wrong or the provider reset the week.
  Nothing in this spec may depend on an unverified `/usage` parse (§3 R-D1 uses the structured signal).

### 1.3 What already exists and must be reused, not rebuilt

- Per-cause notices and holds from 0.11.211: `refreshSavedWorkHold`, `commanderFailureWords`,
  `dispatchFailureNotice`, `awaitToolBoundary`, `refusedThenGone`, `sdkSession` quota pause.
- The auto-update tool-boundary wait: `electron/autoUpdatePolicy.decideAutoApply` + `sdkToolCallsInFlight`.
- The question inbox (`swarmEscalations.raiseEscalationToOwner` / `answerEscalation`), which already lights
  the yellow hand on Ground (`groundLamps.ts`) and the count on the agent-team bar.
- The dispatch park seam: `swarmAllowedModels.spawnBlock` + `engine.parkUntil`, already shown by the UI.
- The structured rate-limit signal: Agent SDK `rate_limit_event` (`status`, `resetsAt`, `rateLimitType`,
  `utilization`). `sdkEvents.distillSdkMessage` already turns it into a `rate_limit` event; its only reader
  is a display line in `SdkWorkerPane.tsx`. `docs/SDK_WORKER_MIGRATION_PLAN.md` row S4 records a real
  capture (`rateLimitType: "seven_day", utilization: 0.55`) and planned it as "record only".

---

## 2. Requirements

Each requirement is a condition that is true or false on a running system. "Automatic work" means
anything the engine starts without the owner pressing something: dispatch, commander wake, boot revival.

### A — Desks start when needed and never stop in silence

**R-A1 Start on need.** For a project inside the automation frame, within 120 s of a need arising the
actor that serves it is running, or the project's standing (R-E1) names why not. Needs: a dispatchable
`todo` card with a free slot (worker); a review-ready card, an answer owed to the commander, or a live
worker (commander); an undelivered notice or the owner opening the seat (president).

**R-A2 Never silent.** There is no 15-minute interval in which a need exists, nothing progresses, and the
standing has no reason. When the engine finds that state it adds the reason `unexplained`, writes one
journal line with the measured facts, and raises one `automation-stalled` notice per episode.
`unexplained` is a defect report, not a normal state.

**R-A3 The president is always reachable.** An owner-initiated president open succeeds, or the seat shows
its own question (R-B4), within 30 s in every hold state. A hold that belongs to another conversation
never prevents it.

- *Now.* Wake paths exist (boot `resumeEngines`, dispatch, wake-on-ready in 03 §2.3). 0.11.211 added a
  notice per known cause. `engine.savedWorkHold`, `sdkSpawnHold`, `parkUntil`, `manualStop`,
  `managerOfflineHold` and the boot map `bootResumePending` each hold work and each tell the owner through
  a different path. Boot revival of the president is held by `savedSwarmRuntimeHold(…, 'supply')` (its
  own conversation cut mid-tool, or an unsettled president instruction); the owner's manual open
  (`POST /api/swarm/supply/open`) is not, but nothing tells the owner that it still works.
- *Gap.* Nothing states "need versus serving" in one place, so every silent stop so far was found by the
  owner and patched one cause at a time (card 1123-151658 has 13 such conditions). The next unknown cause
  is silent again.
- *Design.* One pure function, `standingOf(facts)` in a new `swarmStanding.ts`, computes needs, progress
  and reasons from the fields above. The engine calls it once per pass and runs the R-A2 check on its
  result. Existing notices stay; the watchdog only catches what they miss. R-A3 follows from R-B3.
- *Tests.* `swarmStanding.test.ts`: (1) for every hold field set alone with a need present and no progress,
  `reasons` is non-empty and carries that field's kind — remove one field's adapter and exactly that case
  must go red (measure it); (2) all fields clear, need present, no progress for 15 min: `unexplained`
  appears and `notify` is called once, not again on the next pass; (3) progress within the window: no
  reason. `swarmOrchestrator` wiring test: a pass with a stalled fake engine raises `automation-stalled`.

### B — Recovery holds

**R-B1 No avoidable hold.** A tool call whose outcome is recorded in the native transcript never holds
anything. This covers a call denied by any `PreToolUse` hook (in-process or from settings, main
conversation or sub-agent), a call the user or the permission system refused, a call that returned a
failure (including `Exit code 137`), and a call that completed while its closing callback was lost.
*Measured by:* the eight shapes in §1.1 as fixtures; on the owner's machine, GET
`/api/conversation/recovery` drops from 8 to at most 1 after the first start, with no owner action.

- *Now.* `runtimeActionReceipts.createClaudeRuntimeToolAudit` claims a receipt in its own `PreToolUse`
  hook and closes it only from live callbacks: `PostToolUse`, `PostToolUseFailure`, or `observeSdkMessage`
  matching one of two exact shapes — `veto` (the wrapped in-process guard said `openground-guard BLOCKED:`)
  or `nativeFailure` (requires `parent_tool_use_id === null`). Anything else calls `forget(callId)` and the
  receipt stays `executing`. It becomes `uncertain` at the next start (`conversationReceipts.transaction`
  boot sweep), or when its actor is gone (`runtimeRecovery.runtimeRecoveryIssues`), and it holds from the
  moment the actor is gone (`listUncertainRuntimeActions`: `executing && !originalActorLive`). A failed
  `PostToolUse` write adds the id to `recordingFaults`, which only that same callback can remove — so one
  failed write denies every later tool call of the session ("No action was authorized").
- *Gap (root cause).* Closing depends on a live in-process callback that can be lost in at least five
  measured ways (foreign hook veto, sub-agent, teardown, limit refusal, server exit), while a durable
  record of the outcome already exists in the transcript and is never consulted for tool receipts.
- *Design.* New `runtimeToolEvidence.ts`: `findToolOutcome(sessionId, toolId, cwd?)` reads
  `<claude projects>/<dir>/<sessionId>.jsonl` and `<dir>/<sessionId>/subagents/*.jsonl` (bounded like
  `swarmNativeTranscript.inspect`: 32 MB, changed-during-read is a miss) and returns one of:
  `result` (a `tool_result` block for that id; with `isError`, and `interrupted` when the entry's
  `toolUseResult.interrupted === true` or the content is the CLI's request-interrupted marker),
  `started-no-result`, or `no-record`.
  `listUncertainRuntimeActions` — the one predicate behind the launch guard, the per-call check, the
  engine's `savedWorkHoldCount`, the boot `savedSwarmRuntimeHold` and the review list — first reconciles
  each receipt that would hold (`uncertain` and not owner-reviewed, or `executing` with a gone actor):
  `result` and not interrupted ⇒ settle as `delivered` with
  `{confirmed: true, failed: isError, source: 'native-transcript', automaticReplay: false}`; everything
  else ⇒ still holds. A receipt checked once without a result is not re-read until the next start (an
  in-memory set). `conversationReceipts` gains `settleReceiptFromEvidence`, the only writer allowed to move
  `uncertain → delivered` besides `reviewConversationReceipt`, and only with that `source`.
  `runtimeRecoveryIssues` calls the same reconcile before listing. In the audit's `PreToolUse`, a non-empty
  `recordingFaults` is reconciled the same way before denying, so a session heals itself.
  New receipts record `cwd` in their body so the lookup is one folder; old receipts fall back to finding
  the folder by session id. No migration code: the reconcile on first use clears the old holds.
  Nothing is added to `observeSdkMessage`; its `veto` / `nativeFailure` branches stay as the fast path.
- *Tests.* `runtimeToolEvidence.test.ts` with one fixture per §1.1 row, built from the real line shapes
  (sub-agent file, foreign-hook text, `Exit code 137`, user refusal, normal result, no result, interrupted
  result) and an injected projects directory — never the real `~/.claude` (1,595 folders left there by
  earlier tests were found during this investigation). `runtimeActionReceipts.test.ts`: (a) sub-agent
  `tool_result` denied by a settings hook, then the actor ends ⇒ `assertNoUncertainRuntimeActions` passes;
  red today. (b) `PostToolUse` write fails once, the transcript has the result ⇒ the next call is allowed;
  red today. (c) `started-no-result` ⇒ still throws; must stay green before and after. (d) an
  owner-reviewed or `rejected` receipt is never rewritten. Real machine: §6 check 1.

**R-B2 The app does not create unknown results itself.** Every stop the app initiates — update install,
quit or relaunch, engine stop, quota stop, desk rebuild — first refuses new tool calls without claiming
them, then waits for calls in flight up to a stated bound. *Measured by:* quitting the packaged app while
a command with 8 s left runs leaves no receipt that holds; §6 check 2.

- *Now.* Covered: auto-update (`decideAutoApply`, 15 min) and engine stops (`awaitToolBoundary`,
  `TOOL_BOUNDARY_WAIT_MS` = 30 min in code; 04 §3.4.1 says 15). Not covered: `server/index.ts` installs no
  signal handler, so the SIGTERM that `electron/main.js` `terminateChild` sends (hard kill after
  `CHILD_SIGTERM_GRACE_MS` = 5 s) ends the server at once — on owner quit, "Restart now", and the release
  install the operator runs under the standing permission. Three starts within 75 minutes on 11-26/27
  (`engine-boots.json`) coincide with two of the eight holds.
- *Design.* `sdkSession.beginShutdown()`: sets a flag the audit's `PreToolUse` reads **before** accepting
  a receipt (deny with "OPEN GROUND is restarting; this call did not run" — no receipt exists, nothing to
  close), then resolves when `sdkToolCallsInFlight()` is 0 or after `SHUTDOWN_TOOL_GRACE_MS` (20 s).
  `server/index.ts` calls it on SIGTERM/SIGINT and exits when it resolves. `CHILD_SIGTERM_GRACE_MS`
  rises to that bound plus 5 s so the hard kill cannot land inside the wait. A release install uses the app's own apply path (the
  update bell with `apply: 'asap'`), never a process kill. A call that outlives the bound is cut as today
  and R-B1 decides at the next start.
- *Known limitation (review A S4, 2026-11-28).* The wait covers SDK sessions only. PTY desks — the
  president's seat is one — have no receipts and no in-process hook, so a quit or an update install does
  not wait for a command running in them: it is cut off. That is exactly the one truly unknown hold in
  §1.1 (JobSearch president, cut by a relaunch). What follows is bounded: the native check sees the call
  without a result, the president's conversation is held alone (R-B3), and ONE question waits in the
  inbox; the owner answers it in the bar's 「あなたへの質問」 without the president (HoldQuestionDialog),
  and the seat then opens a new conversation. Closing the gap would need a PTY-side tool boundary,
  which does not exist.
- *Tests.* `sdkSessionShutdown.test.ts`: after `beginShutdown`, a `PreToolUse` returns deny and the journal
  gains no receipt; with one call in flight the promise resolves when its `tool_result` arrives, and at the
  bound otherwise (fake timers). `server/__tests__/autoUpdate.test.ts`: the child is not hard-killed before
  the grace. Both red today (the function does not exist).

**R-B3 A truly unknown result holds only what could repeat it.** With one unknown call in conversation S:
S is not resumed and S's later tool calls are denied; S's card moves to `blocked`; no other conversation
in the project is refused a launch or a tool call. *Measured by:* with a `started-no-result` receipt for
worker W1, a second worker W2 in the same project completes a tool call and the commander starts.

- *Now.* `assertNoUncertainRuntimeActions(cwd, false)` is asked per **project** by `subscriptionQuery`
  (every SDK launch), by the audit's `PreToolUse` (every tool call of every running session),
  by `swarmManager.launchNewDesk`, and mirrored by `refreshSavedWorkHold` (no dispatch, no commander wake).
  01 §7.4e calls this "the safeguard, and correct".
- *Gap.* The rule to keep is "an unknown result is never run again automatically". The only actor that can
  run it again is the conversation that issued it. Stopping every other worker, the commander and the
  president protects nothing more and is what turned one stale receipt into days of no automation.
- *Design.* `listUncertainRuntimeActions` / `assertNoUncertainRuntimeActions` take the asking
  conversation's `sessionId`; a receipt holds only the session in `receipt.execution.sessionId`
  (`body.sessionId` for old receipts). Callers pass their own session; `refreshSavedWorkHold` stops
  parking the project and instead, per held worker conversation, moves its card to `blocked` and raises
  the question of R-B4. A held commander or president conversation is not resumed; the next need opens a
  **fresh** conversation (`fresh: true` already exists on both spawns) whose opening line states the
  unknown operation (tool name, time, the call's own `description` field when present — never its
  arguments) and that it must look at the current state before doing anything similar. The president's
  own held PTY conversation is the one exception to "fresh on need": its seat shows the question and waits
  (R-B4), because the owner's history lives there. `drainSwarmRuntime`'s whole-app asserts are unchanged.
  This reverses a documented position, so it needs the owner's word (§7-1) and a specialist review of the
  safety argument before integration (03 §5).
- *Tests.* `swarmSavedWorkHold.test.ts`: rewrite "holding new dispatch and the commander's launch" into
  the scoped contract (state the reason in the test, as the 2026-08-04 note in memory requires): W1 held,
  W2 dispatches, the commander wakes, W1's card is `blocked`, one question is open. `runtimeActionReceipts
  .test.ts`: a `PreToolUse` in S2 is allowed while S1 holds; in S1 it is denied. Mutation: make the
  predicate ignore `sessionId` ⇒ both go red.

**R-B4 One obvious place, and the president can explain.** Within 60 s of an unknown result being
established, exactly one question exists in the question inbox for it, in the owner's language, stating
what was being done, by which seat, when, and what is known — without asking the owner to inspect Git.
One answer clears it. GET `/api/swarm/standing` carries the same text, so the president can retell it and
submit the owner's answer.

- *Now.* The only door is Settings › 詳細設定 › ChatGPT ›「中断した作業の確認」
  (`ConversationRecoverySetting.tsx` inside `ChatGptSetting.tsx`). Its instruction is to check Board, Git
  and external results first (`settings.recovery.description`). The list shows a tool name and a project.
- *Design.* `savedWorkHold.ts` builds `unconfirmedOperationQuestion(facts)` in the three-part plain shape
  (what to decide, the options, what each does). The engine raises it with `raiseEscalationToOwner` under
  the stable key `hold:<receipt id>` (one open question per key, also after a restart).
  Options: A "continue from where it stopped" ⇒ `reviewConversationReceipt` /
  `reviewNativeConversationRecovery` with the answer text as the note and the escalation id as
  `operationId`, then `notifyRuntimeRecoveryChanged()`; B "leave that conversation and start this work
  again" ⇒ the card returns to `todo` with no resume session (the owner asked for the redo), or the desk
  stays on its fresh conversation. `OWNER_REVIEW_WHERE` changes to name the question inbox. The Settings
  panel keeps working through the same review functions and is not extended.
- *Tests.* `swarmEscalations.test.ts`: raising twice for one receipt yields one open question; answering A
  leaves the receipt `delivered` with `ownerReviewed` and the standing without that reason; answering B
  moves the card. `savedWorkHold` text test: the question contains the seat, the time and the tool's
  description, and no path, branch name or command text. Real machine: §6 check 3.

**R-B5 No hold without a door.** For a user who is not the signed-in owner (public opt-in, local unlock),
no state exists in which boot revival waits on a condition that user cannot satisfy.

- *Now (read, not run).* For such a user `resumeEngines` still calls `savedSwarmRuntimeHold`; a desk
  conversation cut mid-tool raises `NativeUnfinishedToolsError`, `nativeConversationRecoveryReviewed` then
  calls `runtimeOwnerKey()`, which throws "Owner sign-in is required", and the outer catch returns
  「オーナーのアカウント確認がまだ取れていません」 — retried forever, pointing at nothing.
- *Design.* With R-B3/B4 the native check raises the same inbox question for every user (the inbox is
  gated by `hasSwarmOwnerAccess`, which those users pass); the native review marker is keyed by the local
  user when no owner key exists. Rename nothing; add a one-line comment at `hasChatGptAccess` saying what
  it means.
- *Tests.* `swarmOrchestrator.resumeEngines.test.ts`: role not owner, president transcript with an
  unfinished tool ⇒ the hold reason names the inbox question and the question exists; red today.

### C — Automatic resume

**R-C1 After a limit lifts, work resumes without the owner.** Within 5 minutes of the reset time of a
5-hour or weekly limit, every card the limit stopped is running or queued behind the worker cap, and
every message kept for a desk has been handed over. Holds across an app restart during the wait.

- *Now.* 0.11.211: all-model refusal cools every tier (`coolQuotaWall`, `refusalClosesEveryModel`), the
  card returns to `todo`, the cooling table persists (`swarm-quota.json`), an SDK desk's `quotaPause` lifts
  by timer. The reset time is parsed from the refusal sentence (`resolveCoolingUntil`), then the `/usage`
  cache, then a flat 20 minutes.
- *Gap.* (1) The reset time and "all models or one" are read from display text with a history of misreads
  (04 §2.4), while the SDK states both in `rate_limit_event`. (2) "Once the pool has forgotten the session
  … the old crash rule applies" (04 §3.4.2): a worker refused by the limit followed by an app restart is a
  crash, and a branch with commits goes to `blocked`, where nothing returns it.
- *Design.* (1) R-D1's window store answers `rejectedUntil(limitType)`; `coolQuotaWall` and
  `sdkSession.refuseInput` use it first and fall back to today's chain when the session saw no event.
  `distillSdkMessage` must emit `rate_limit` when `status` is `rejected` or `resetsAt` is present, not only
  when `utilization` is a number, and carry `status`. (2) The dead-worker path in `monitorWorkers` and the
  boot reconcile read the worker transcript's last assistant entry: `isApiErrorMessage: true` plus a
  usage-limit prefix ⇒ recover as `rate-limit` (card to `todo`), exactly as `refusedThenGone` does while
  the pool remembers.
- *Tests.* `sdkEvents.test.ts`: a rejected event without `utilization` distils to a `rate_limit` with
  `status: 'rejected'` (red today: returns `[]`). `swarmQuotaStopFailFast.test.ts` fixed clock: refusal
  with `resetsAt` three days ahead ⇒ every tier cools until exactly that instant, survives
  `ensureCoolingTableLoaded` after a simulated restart, and the first pass after it dispatches.
  `swarmEngineSdkBlindspots.test.ts`: worker gone, pool empty, transcript ends in a limit refusal ⇒ card in
  `todo`, journal says quota stop (red today: `blocked`).

**R-C2 A turn ended by a transient error resumes by itself.** A worker or commander turn that ends with
`terminal_reason: api_error` (network loss, sleep, provider 5xx) and no usage refusal is given one
"continue" input within 2 minutes of the API host being reachable, at most 3 times per card attempt.

- *Now.* `sdkEvents` distils `api_error`; no reader acts on it. The worker sits in `waiting` until the
  stall arm (10 minutes of silence, then nudges, then reclaim). Measured 11-23 after a lid-close sleep.
- *Design.* In `monitorWorkers`, a worker whose last turn ended in `api_error` and that is `waiting` gets
  the existing nudge text through `runtimeOf(w)` once the offline hold (03 §5.9) reports reachable; a
  counter on the worker record bounds it. The commander gets the same through `sayToManagerDesk`.
- *Tests.* `swarmEngineSdkBlindspots.test.ts`: `api_error` turn end + reachable ⇒ one input within the next
  pass; unreachable ⇒ none; fourth occurrence ⇒ none and the stall path takes over. Red today.

### D — Token efficiency and budget

**R-D1 No start the window cannot carry.** Automatic work starts a new worker only when the 5-hour
window's used share is below the start ceiling for the card's effective tier (touch 90, standard 80,
design 70, ultra 60 — named constants). Workers in flight are never stopped by this rule. *Measured by:*
over any 7 days, worker runs ending in a quota stop are at most 5% of dispatches (journal
`worker quota-stopped` lines against dispatch lines); if not, lower the ceilings.

**R-D2 The week is paced and the owner's share is kept.** Automatic work does not start while the week's
used share is above the pace line (elapsed share of the week × 100 + `PACE_BURST` 15), and never above
100 − `OWNER_RESERVE` (10). When held, the standing says until when; dispatch resumes by itself when the
line passes. Owner-initiated actions (Board Run, talking to the president) are never held by pacing.

- *Now.* Layer D (`isTopTierExhaustedByUsage`) acts only at 100%. Nothing reads utilization before the
  wall: the `rate_limit` event has no decision reader. Dispatch therefore runs every free slot into the
  wall; three workers stopped together at 15:31 JST on 11-26.
- *Design.* New `usageWindows.ts`: latest `{usedPct, resetsAt, at, status}` per window (`five_hour`,
  `seven_day`, per-model weeks), fed by every SDK session's `rate_limit` event (one forwarding line in
  `sdkSession`'s distil loop; the event's `utilization` is a 0–1 fraction and is stored as 0–100),
  persisted next to the cooling table, with the existing `/usage` cache (`peekCachedUsage`) as the reading
  when no event is younger than 30 minutes. New pure `swarmBudget.budgetGate(windows, now, policy, card)`
  returns `allow` or `{hold, kind, until}`; `kind` is `window-headroom`, `weekly-pace` or
  `weekly-reserve`. No reading younger than 30 minutes ⇒ allow, with the standing note `usage-unknown`
  (today's behaviour, now visible). `runDispatchPass` asks it where it asks `spawnBlock`, per card, and
  records its own hold (`engine.budgetHold`, never `engine.parkUntil` — review 2026-11-28 B-S1: the
  standing must not call a budget hold a usage limit). The commander's wake for finished work is held
  only by `weekly-reserve`. Policy lives in `Settings.swarmBudget` (`pace: 'even' | 'free'`,
  `ownerReservePct`), default per §7-2, changed by the president on the owner's request like the other
  owner-requested settings; the key must be added to the settings POST allow-list and read back through
  the production reader in its test.
  Ledger rule 1: this adds no sensor and no text pattern. It consumes a stable SDK message type; the
  experimental `usage_EXPERIMENTAL_…` call is not used.
- *Tests.* `swarmBudget.test.ts` (pure, fixed clock): each kind's boundary on both sides; `until` for
  `weekly-pace` is the instant the line reaches the used share; stale reading ⇒ allow + note; a running
  worker is never in the function's output. `swarmOrchestrator` dispatch test: used 85%, one standard card
  and one touch card ⇒ only the touch card dispatches; Board Run on the standard card still spawns.
  A read-back test for `swarmBudget` beside `server/routes/__tests__/settingsRuntimeDials.test.ts` (POST,
  then read through `store`'s reader; the key is in `USER_SETTINGS_KEYS`). All red today (no gate exists).
  First step of the unit, before any behaviour depends on it: record the raw events one real session
  emits (count, fields, unit) into the unit's notes and into 04; if `utilization` arrives only on
  threshold crossings the 30-minute freshness rule decides how often the `/usage` reading is used.

**R-D3 A waiting desk costs nothing, and a commander's context is bounded.**
(a) In the 10 minutes after an app start with no need (R-A1) in a project, that project's desks bill 0
tokens. (b) A commander is not woken into a conversation above `MANAGER_CONTEXT_CAP` (120,000 tokens,
named constant; `Settings.deskContextCapTokens` still overrides both desks): at every wake while idle, an
over-cap conversation is closed and a fresh one opened.

- *Now.* `resumeEngines` revives the president and the commander of every project in the frame whose
  `engine.json` says `supplyDesired` / `managerDesired` (17 and 14 projects carry those flags on the
  owner's machine; how many sit inside the frame was not measured), each with an auto-sent resume prompt
  (`supplyLaunchOpts` → `SUPPLY_RESUME_INJECTION`, `sdkManagerLaunchPlan` → `MANAGER_RESUME_INJECTION`) —
  one full turn over the whole context per desk per start. `recycleDeskSessionIfOverCap` runs only inside
  `swarmManager.launchNewDesk`, so a commander that stays up is never recycled; measured average context
  per commander call is 237 k against a cap of 300 k.
- *Design.* Boot: the commander is spawned only when a commander need exists; otherwise `managerDesired`
  stays set and the existing wake-on-need path starts it. The unit must first prove, with a test, that
  every need (review-ready card, owed answer, `manager/say`) starts an absent commander; a path that does
  not is fixed in the same unit. The president's PTY is revived with **no** auto-sent prompt; the resume
  note is prepended to the first thing delivered to it (a notice or the owner's message). Wake: the
  engine's commander wake checks the cap for an idle SDK desk and rebuilds it through the same
  close-and-reopen it already uses for `manager-unresponsive`.
- *Tests.* `swarmOrchestrator.resumeEngines.test.ts`: `managerDesired` and no need ⇒ `spawnManager` not
  called and the intent still set; a review-ready card on the next pass ⇒ called once (first half red
  today). `swarmSupply.test.ts`: resume launch options carry no initial prompt; the first delivery carries
  the note once. `deskContextCap.test.ts`: idle desk above the cap at wake ⇒ rebuilt; busy desk ⇒ not.
  Real machine: §6 check 5.

**R-D4 The usage breakdown tells the truth.** A sub-agent's tokens are attributed to the actor that
started it; cache reads are reported beside billed tokens; "other" contains only sessions outside every
registered project and worktree. *Measured by:* on the §1.2 data the "other" row is under 2%.

- *Design.* In `collectUsageBreakdown`, a file under `<dir>/<sessionId>/subagents/` takes its source from
  `<dir>` and `<sessionId>` (worktree name, desk ledger, project list) exactly as the parent file does;
  `UsageBreakdownRow` gains `cacheRead`; `UsageHud` shows it as a second figure in the existing popover.
- *Tests.* `claudeUsage.test.ts`: fixture tree with a worker and a commander that each have a sub-agent
  file ⇒ rows `swarm-worker` and `manager` include them, `other` is empty (red today).

**R-D5 Review depth follows the card.** The commander's integration review starts reviewer sub-agents
according to the card's effective tier: touch/standard — none, the commander reads the diff itself;
design — one; ultra or any safety-floor card (`resolveCardTier`) — the full panel as today.

- *Now.* The worker side has this since 2026-09-22 (`TIER_DIRECTIVE`); the commander's skill reviews every
  card at full weight. Commander sub-agents are 12.5% of billed tokens at 211 k context per call.
- *Design / tests.* Text in `skills/og-manage/SKILL.md` plus its pin in `ogManageSkill.test.ts`; the
  fail-closed integration gate and the safety floor are not loosened. Depends on §7-3.

### E — The owner can see it at a glance

**R-E1 One truth.** GET `/api/swarm/standing?path=` returns, per project:
`state` (`running` | `needs-owner` | `waiting` | `idle` | `off`), `needs`, `progressedAt`, and
`reasons[]` of `{kind, plain, until?, ownerAction?}` where `plain` is one sentence in the owner's
language. The Ground lamp, the agent-team bar and the president's status answer read this and nothing
else for "is it held and why". Kinds: `owner-question`, `usage-limit`, `window-headroom`, `weekly-pace`,
`weekly-reserve`, `spawn-backoff`, `offline`, `boot-pending`, `models-off`, `manual-stop`,
`outside-frame`, `usage-unknown` (note only), `unexplained`.

**R-E2 Marks stay within the three colours.** `needs-owner` is the existing yellow hand (it already
follows open questions, which now include holds). `running` is the existing blue. `waiting` adds no
colour: per §7-4 either nothing, or one muted lucide `Clock` on the Ground card and beside the bar's
switch, with the reason as hover text only. No label, no arrow glyph, no emoji; both themes.

- *Now.* `OrchestratorState` exposes `parkUntil`, `managerOfflineHold`, `manualStop`; `savedWorkHold`,
  `sdkSpawnHold` and the boot map are server-only. The bar's folded line shows questions and cards
  awaiting integration. A project waiting four hours for a limit looks the same as one with nothing to do.
- *Design.* The route is a thin adapter over `standingOf` (R-A2's function). `groundLamps.ts` adds
  `standing.state` to its payload; `groundLamp.ts` maps it; `SwarmBottomBar.tsx` renders the muted mark.
  `skills/supply/SKILL.md`: the status answer retells `reasons[].plain` word for word.
- *Tests.* Route test: each engine fixture yields the expected `state` and a non-empty `plain` in ja and
  en. `groundLamp.test.ts`: `needs-owner` outranks `running` outranks `waiting`. `SwarmBottomBar.test.tsx`
  + `statusColors.test.ts` + `noEmojiGuard.test.ts`: the waiting mark uses no state-colour token and no
  text. Screenshots in both themes attached to the card.

---

## 3. Design constraints that apply to every unit

- Subscription only; SDK-only swarm roles; the president's PTY stays. No new PTY sensor or screen pattern
  (PLATFORM-GAP-LEDGER rule 1). Units that touch a ledger row state why in their card.
- An unknown result is never run again automatically. Every unit that changes a hold has a test that the
  holding conversation is not resumed and its input is not handed to another actor.
- Fail direction: evidence that cannot be read ⇒ the hold stands; a usage reading that is missing ⇒ no
  budget hold, said in the standing; a standing that cannot be computed ⇒ `unexplained`.
- Owner-facing text is Japanese-first plain language through the existing i18n tables; new docs, comments
  and commit messages are English. No emoji, chevrons only, three state colours.
- Never start a second server on the real data folder to verify anything (VERIFICATION §4.2). Use
  `npm run dev:alt` (its own home) or a packaged build with its own `OPENGROUND_HOME`. Tests that read
  Claude transcripts inject the projects directory.
- Every guard is shown red against the pre-fix code once, and the measurement is written in the card
  (VERIFICATION §1). Anything touching process, filesystem, git or `claude` gets one pass on the packaged
  app (VERIFICATION §4.1).

---

## 4. Work breakdown

Ordered by what the owner gains first. "Files" are the ones a unit owns; `swarmOrchestrator.ts` is shared
and split by symbol.

| # | Unit | Requirements | Owns (files / symbols) | Must update |
|---|---|---|---|---|
| U1 | Settle from the transcript | R-B1 | new `runtimeToolEvidence.ts`; `runtimeActionReceipts.ts`; `conversationReceipts.ts` (`settleReceiptFromEvidence`); `runtimeRecovery.ts` | commander/01 §7.4e and §7.4b3; 00-INDEX symptom row; MAP §0 and the §5 line about filesystem settings; ledger row "transcript JSONL" |
| U2 | Hold only the conversation; question in the inbox | R-B3, R-B4, R-B5, R-A3 | `runtimeActionReceipts.ts` (predicate signature, after U1); `savedWorkHold.ts`; `swarmRuntimeTransition.savedSwarmRuntimeHold`; `swarmEscalations.ts` (answer hook); orchestrator `refreshSavedWorkHold`; `sdkSession.subscriptionQuery`; `swarmManager.launchNewDesk`; `skills/supply/SKILL.md` | 01 §7.4e (replace "stops every launch"); 06 §2.2; PRESIDENT_COMMAND_RECOVERY.md |
| U3 | Budget gate and structured limit times | R-D1, R-D2, R-C1(1) | new `usageWindows.ts`, `swarmBudget.ts`; `sdkEvents.ts` (rate-limit case); one line in `sdkSession.ts`; orchestrator `runDispatchPass` gate + `coolQuotaWall`; `store.ts` + settings allow-list; `types.ts` | 04 new §5.10 and §2.4; ledger rows A/D/E (structured source noted); TARGET-STATE §1 |
| U4 | Desks that cost nothing while waiting | R-D3 | orchestrator `resumeEngines` (desk blocks) and the commander wake; `swarmSupply.supplyLaunchOpts`; `deskContextCap.ts`; `swarmManager.ts` (cap at wake) | 03 §2.3; 05 §10.6 |
| U5 | Standing, watchdog, marks | R-A1, R-A2, R-E1, R-E2 | new `swarmStanding.ts`; `server/routes/swarm.ts` (one route); `types.ts`; one call in the engine pass; `groundLamps.ts`, `groundLamp.ts`, `SwarmBottomBar.tsx` | 00-INDEX (what to trust); 01 §7; MAP §1 lamps and §5 |
| U6 | Resume gaps | R-C1(2), R-C2 | orchestrator `monitorWorkers` (dead-worker classification, `api_error` retry); boot reconcile | 04 §3.4.2; 02 §5.4 |
| U7 | Stops that wait | R-B2 | `sdkSession.beginShutdown`; `server/index.ts`; `electron/main.js` `terminateChild`; DISTRIBUTION §0 install step | 01 §7.4e; 04 §3.4.1 (state the real `TOOL_BOUNDARY_WAIT_MS`) |
| U8 | Truthful breakdown | R-D4 | `claudeUsage.ts`; `types.ts` (`UsageBreakdownRow`); `UsageHud.tsx` | 04 §5.9.1 |
| U9 | Review depth by tier | R-D5 | `skills/og-manage/SKILL.md`; `ogManageSkill.test.ts`; read-only `GET /api/swarm/card-tier` (the worker's own `resolveCardTier` — review 2026-11-28 D-M1: a jq copy of the regex disagreed with JS) | 03 §5 |

Dependencies: U2 after U1 (same predicate). U5 can start at once and gains reasons as U2/U3 land (its
adapters are one line each). U3, U4, U6, U7, U8, U9 are independent of each other; U3, U4, U5, U6 touch
different symbols of `swarmOrchestrator.ts` and `types.ts` and must be integrated one at a time.
U1 and U8 change no behaviour the owner must decide and can ship first.

**Completion conditions (in addition to each requirement's tests, tsc, lint, full suite, build):**

- U1: the §1.1 fixtures settle as listed; red measured for cases (a) and (b); on the installed build the
  recovery list is at most 1 with no owner action; no test writes under the real `~/.claude`.
- U2: scoped-hold tests green and red under the "ignore sessionId" mutation; specialist review of the
  safety argument recorded; one inbox question per unknown result; the president opens in every hold
  state; §7-1 answered.
- U3: raw event capture recorded; gate tests green; read-back test for the new setting; on the installed
  build the standing shows `window-headroom` at the ceiling and dispatch resumes after the reset with no
  input; §7-2 answered.
- U4: zero desk tokens after an idle start (measured with the U8 breakdown or the §6 command); a
  commander need still starts an absent commander within 120 s.
- U5: every hold field maps to a reason (adapter-removal reds measured); `unexplained` fires once on a
  stalled fake engine; screenshots in both themes; §7-4 answered.
- U6: limit-then-restart lands in `todo`; `api_error` turn resumes within one pass when reachable.
- U7: the packaged-app quit checks of §6 pass; the release install step no longer kills the process.
- U8: "other" under 2% on the fixture and on the owner's data. U9: skill pin green; §7-3 answered (if the
  answer is A, the mode itself is switched by the president on the owner's word — an existing
  owner-requested setting, no code).

---

## 5. Risks and non-goals

**Risks**
- *Transcript format.* The JSONL layout (including the `subagents/` folder) is not an official contract
  (ledger row). A layout change makes `findToolOutcome` miss, which leaves the hold in place — today's
  behaviour, never a wrong release. The fixtures are real captured shapes; a CLI upgrade that breaks them
  shows as holds returning, and the standing names them.
- *"Result recorded" versus "effect known".* A recorded failure can leave partial effects. This is the
  rule the audit already applies to `PostToolUseFailure` ("a returned failure is a confirmed result");
  R-B1 extends the same rule to the same fact read from disk. Interrupted results stay unknown.
- *Narrowing the hold (R-B3)* removes a wide safety margin on purpose. The argument is in the requirement;
  it must be reviewed against primary sources (how `claude --resume` presents an unfinished call) before
  integration, and it is the owner's call (§7-1). If declined, U2 ships R-B4/R-B5 only.
- *Event frequency.* If `rate_limit_event` is rare, the budget gate leans on the `/usage` reading, whose
  parse gave contradictory values (§1.2). The gate then says `usage-unknown` rather than guessing.
- *Starving work.* A wrong ceiling parks dispatch. Bounded by: owner-initiated runs are never gated, the
  hold always carries `until`, and the standing shows it.
- *Foreign hooks.* The SDK's "load all settings" default may change with an upgrade; R-B1 does not depend
  on which hook denied.
- *Shared file.* Four units edit `swarmOrchestrator.ts`; integrate serially and re-run the saved-work,
  quota and resume suites after each.

**Non-goals**
- Re-running any recorded tool call; clearing a hold without evidence or the owner.
- Extending receipts to users without the owner role; removing or redesigning the Settings recovery panel;
  renaming `hasChatGptAccess`.
- New quota sensors, screen patterns or probes; using the SDK's experimental usage call.
- Changing who integrates, the integration gate, or the worker completion gate.
- Changing `executionMode` or any owner setting automatically.
- A per-card token forecast that learns from history (the ceilings are constants with one measured
  acceptance number; add learning only if that number cannot be met).
- Windows, collab, ChatGPT runtime, PTY worker paths.
- Cleaning the 1,595 test-made folders under the owner's `~/.claude/projects` (separate card; noted here
  because U1's tests must not add to them).

---

## 6. Acceptance on the real machine (after the units ship; packaged app, the owner's data)

1. **Old holds clear themselves (U1).** `curl -s localhost:47776/api/conversation/recovery` lists at most
   the JobSearch president's conversation, with no owner action since install.
2. **Quit does not create a hold (U7).** In a test project, a worker runs a command with 8 s left; quit
   the app; start it: the list in check 1 is unchanged and the worker continues. Repeat with 60 s left:
   exactly one question appears, for that conversation only (U2). Not covered (known limitation, R-B2):
   a command running in a PTY desk (the president) is not waited for — with one running, the quit cuts it
   and exactly one question appears for the president's conversation, answerable from the bar.
3. **One question, one press (U2).** The question appears on the Ground card (yellow hand) and in the bar
   within 60 s; asking the president 「何が止まっていますか」 returns the same sentence; answering A puts
   that card back for a NEW conversation that continues the saved work (the held conversation itself is
   never resumed — review 2026-11-28); a second worker in the project never stopped.
4. **Limit and back (U3, U6).** At the next real 5-hour limit: the journal shows no dispatch above the
   ceiling, no `worker quota-stopped` for a worker started after the ceiling, and the first dispatch after
   the reset within 5 minutes, with no owner input. Recorded in TARGET-STATE with the journal lines.
5. **Idle start is free (U4).** Start the app with no dispatchable card: over the next 10 minutes the
   transcripts of desk sessions gain no assistant entry (count lines with `"usage"` newer than the start).
6. **Nothing unexplained for 48 hours (U5).** Two days unattended: zero `automation-stalled` notices, or
   each one filed as a defect with its facts; the share of worker runs ending in a quota stop is at most 5%.

---

## 7. オーナーに決めていただきたいこと

**決定(オーナー、2026-11-28)**: 1 = A(その会話だけ止める)/ 2 = B(配分しない。オーナー用に 1 割を残す:
`pace: 'free'`, `ownerReservePct: 10`)/ 3 = A(「最適化」。同日 `executionMode: 'optimize'` に切り替え済み・読み戻し確認済み)/
4 = A(灰色の小さな時計、文字なし、理由と再開時刻はホバーのみ)。

1. **結果が分からない操作が残ったときの止め方**
   - A(おすすめ): その操作をした会話だけを止めます。同じプロジェクトのほかの作業と社長は動き続けます。
     止まった会話は、オーナーが質問に答えるまで再開しません。
   - B: これまでどおり、そのプロジェクトの自動の作業をすべて止めます。安全側ですが、1 件残るだけで
     プロジェクト全体が何時間も止まります(今回 7 プロジェクトで起きたことです)。
2. **1 週間の使用量の配り方**
   - A(おすすめ): 均等に使います。毎日ほぼ同じ量まで自動で進め、週の終わりまで止まりにくくします。
     オーナー自身の会話用に 1 割を残します。
   - B: 配分しません。早く進みますが、週の後半は自動の作業が止まることがあります(残す 1 割は同じ)。
   - 残す量を 2 割にすることもできます。
3. **ふだんの実行モード**(いまは「最大出力」で、全員がいつも最大の力で動いています)
   - A(おすすめ): ふだんは「最適化」にします。カードの難しさに合わせて力の入れ方を変え、難しい
     カードと安全にかかわるカードだけ今と同じ重さで確認します。使用量が大きく減ります。
   - B: 今のまま「最大出力」。品質は最大ですが、使用量の減りは今のままです。
4. **「待っている」ことの見せ方**(上限待ちなど、時間がたてば自分で再開する待ち)
   - A(おすすめ): Ground のカードとチームのバーに、灰色の小さな時計のしるしを出します。
     文字は出さず、カーソルを合わせると理由と再開の時刻が出ます。
   - B: しるしは出しません。社長に聞くか、バーを開くと分かります。

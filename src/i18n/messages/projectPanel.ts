// Owned by the ProjectPanel translation track. Add keys as 'projectPanel.*'.
// English is the source of truth; keep `en` and `ja` key sets identical.
export const projectPanel = {
  en: {
    // Header
    'projectPanel.backToGround': 'Back to Ground',
    'projectPanel.claudeNotFound': 'claude CLI not found — install Claude Code, then restart OPEN GROUND',
    'projectPanel.generating': 'Generating…',
    'projectPanel.cancelDescription': 'Stop generating',
    'projectPanel.regenerateDescription': 'Refresh description',
    'projectPanel.generateDescription': 'Generate description',
    // Open in… / pick app
    'projectPanel.pickFailed': "Couldn't add the app: {error} — pick the application again.",
    'projectPanel.folderGone': "That folder no longer exists on disk — remove the card from the canvas, or re-import the folder if you moved it.",
    'projectPanel.openFailed': "Couldn't open the project in that app: {error} — check the app is still installed, then try again.",
    'projectPanel.networkError': 'network error (server unreachable)',
    // Missing-folder banner
    'projectPanel.missingBanner': 'This folder no longer exists on disk. Runs and “Open in…” are disabled. Locate the folder if you moved it, or use Remove from Ground to take the card off.',
    'projectPanel.locateFolder': 'Locate folder…',
    'projectPanel.locateFolderHint': 'Point this card at the folder’s new location — your tasks, notes and canvases reconnect.',
    // Loading
    'projectPanel.loading': 'Loading…',
    'projectPanel.loadFailed': "Couldn't load the project — the server is unreachable. Check that the dev server is running, then retry.",
    'projectPanel.retry': 'Retry',
    // Swarm — owner-only experiment (the in-app swarm orchestration surface,
    // project_inapp_swarm_port). Never shown unless the experiment is on
    // (owner + the settings toggle, resolved server-side).
    'projectPanel.swarm.badge': 'Experimental',
    'projectPanel.swarm.title': 'Swarm orchestration',
    'projectPanel.swarm.body': 'Run a team of Claude sessions across your projects from one surface. This is an early experiment, off by default.',
    // Master power switch (SwarmPowerBar) — the SINGLE Start/Stop for the whole
    // Swarm tab. ON starts the autonomous engine AND launches the manager +
    // supply conversations together (idempotent); OFF only halts new dispatch
    // (running workers finish, worktrees are kept). The status shows running /
    // stopped + how many workers are live. (No separate auto-integrate switch —
    // retired 2026-07-16; the engine never pushes.)
    'projectPanel.swarm.power.label': 'Swarm',
    'projectPanel.swarm.power.start': 'Start',
    'projectPanel.swarm.power.stop': 'Stop',
    'projectPanel.swarm.power.running': 'Running',
    'projectPanel.swarm.power.stopped': 'Stopped',
    // Deliberate owner pause (manualStop — persisted server-side, survives
    // restarts), distinct from a merely never-started "Stopped".
    'projectPanel.swarm.power.manualStop': 'Stopped by hand',
    'projectPanel.swarm.power.offline': 'Not available yet',
    'projectPanel.swarm.power.workers': '{count} workers',
    'projectPanel.swarm.power.hint':
      'Start the engine, manager, and supply officer together. Stop halts new dispatch only — running workers finish and their worktrees are kept.',
    // Restart reminder (autonomyRemembered) — autonomy is NEVER auto-resumed on
    // relaunch; if it was on last session the banner offers a one-click resume.
    'projectPanel.swarm.autonomyReminder':
      'Autonomy was on for this project last session. It relaunched OFF — nothing is running.',
    'projectPanel.swarm.autonomyReminder.resume': 'Resume',
    'projectPanel.swarm.autonomyReminder.dismiss': 'Dismiss',
    // Execution mode (token budget) — one switch for every swarm launch (card 68d8e00f).
    'projectPanel.swarm.mode.label': 'Mode',
    'projectPanel.swarm.mode.max': 'Max',
    // {top}/{light} are the tiers these modes ACTUALLY resolve to under the
    // usable-models switches below — never a model the swarm may not launch.
    'projectPanel.swarm.mode.max.hint':
      'Every role on the top usable model ({top}) / max effort, heavy parallelism — peak quality, peak spend. For crunch time.',
    'projectPanel.swarm.mode.economy': 'Economy',
    'projectPanel.swarm.mode.economy.hint':
      '{light}, low/medium effort, fewer parallel workers — minimise the weekly-budget burn.',
    'projectPanel.swarm.mode.optimize': 'Optimize',
    'projectPanel.swarm.mode.optimize.hint':
      'Per-card weight decides — heavy/safety work gets the top tier ({top}), chores drop to {light}. The smart default.',
    // Usable models — the owner's PERMANENT per-tier switch (hard mask). Not the
    // transient quota cooling: an OFF tier never comes back on its own.
    'projectPanel.swarm.models.label': 'Usable models',
    'projectPanel.swarm.models.hint':
      'No swarm role ever launches on a model switched off here — it survives restarts, unlike a rate-limit cooldown.',
    'projectPanel.swarm.models.last': 'At least one model must stay on',
    // OFF / first-run onboarding (SwarmOnboarding) — the SINGLE centered screen
    // shown while the swarm is fully idle (engine stopped + no supply / manager
    // / worker sessions). It explains the three roles and how a request flows
    // through them BEFORE the owner presses Start. Role NAMES reuse the existing
    // supply / manager / worker keys above; only this flow + role-summary copy is
    // new — no duplicate text (条件3).
    'projectPanel.swarm.onboarding.intro':
      'Tell the team what you want — three Claude roles carry it from request to merged, working together.',
    'projectPanel.swarm.onboarding.flowHeading': 'How work flows',
    'projectPanel.swarm.onboarding.roleYou': 'You',
    'projectPanel.swarm.onboarding.flowRequest': 'A request',
    'projectPanel.swarm.onboarding.flowQueue': 'Filed to Board · To do',
    'projectPanel.swarm.onboarding.flowDispatch': 'Pulled & dispatched',
    'projectPanel.swarm.onboarding.flowImplement': 'Built in an isolated worktree',
    'projectPanel.swarm.onboarding.flowReview': 'Review',
    'projectPanel.swarm.onboarding.flowIntegrate': 'Integrated',
    'projectPanel.swarm.onboarding.flowDone': 'Done',
    'projectPanel.swarm.onboarding.rolesHeading': 'The three roles',
    'projectPanel.swarm.onboarding.roleSupply':
      'Turns your requests into observable to-do cards on the Board. Writes the Board only — never code.',
    'projectPanel.swarm.onboarding.roleManager':
      'Pulls cards off To do, dispatches one worker each, then reviews and integrates what comes back.',
    'projectPanel.swarm.onboarding.roleWorker':
      'A `claude` session that builds one card in its own isolated worktree, then hands it back for review.',
    'projectPanel.swarm.onboarding.startNote':
      'Press Start: the engine, supply officer and manager all come up together and begin draining the Board automatically. (Stopping later halts new dispatch only — running workers finish.)',
    // Workers list. Manual hand-dispatch was removed (the to-do rail is gone —
    // browse todos on the Board tab); workers are started by the autonomous
    // engine (the master power switch above) or the manager session.
    'projectPanel.swarm.workersEmpty': 'No workers running yet. Start the swarm with the switch above (or ask the manager) to dispatch one — each gets its own isolated worktree and `claude` session.',
    'projectPanel.swarm.statusWorking': 'Working',
    'projectPanel.swarm.statusWaiting': 'Waiting',
    'projectPanel.swarm.statusStarting': 'Starting…',
    'projectPanel.swarm.statusExited': 'Exited',
    // Exit overlay (ClaudeTerminalPane) — a dead PTY shows "session ended ·
    // Restart" instead of a black screen + raw error. Shared by all three swarm
    // roles (supply / manager / worker); the role decides which API relaunches.
    'projectPanel.swarm.sessionEnded': 'Session ended',
    'projectPanel.swarm.sessionExitCode': 'exit code {code}',
    'projectPanel.swarm.restart': 'Restart',
    'projectPanel.swarm.restarting': 'Restarting…',
    'projectPanel.swarm.restartFailed': "Couldn't restart the session: {error}",
    'projectPanel.swarm.terminate': 'Terminate',
    'projectPanel.swarm.terminating': 'Terminating…',
    'projectPanel.swarm.retained': 'Worktree kept — it has uncommitted changes.',
    'projectPanel.swarm.forceRemove': 'Force remove',
    'projectPanel.swarm.forceFailed': "Couldn't remove the worktree: {reason}. Remove it by hand if needed.",
    'projectPanel.swarm.engineOwned': 'Engine',
    'projectPanel.swarm.engineOwnedHint':
      'The autonomous engine spawned and owns this worker — manage it from the Manager tab.',
    // Supply officer (タスク窓口) — the conversation desk that turns the user's
    // requests into Board:todo cards. Writes the Board only; never edits code.
    'projectPanel.swarm.workersTab': 'Workers',
    'projectPanel.swarm.supply.tab': 'Supply',
    'projectPanel.swarm.supply.badge': 'Supply officer',
    'projectPanel.swarm.supply.title': 'Turn requests into to-do cards',
    'projectPanel.swarm.supply.empty':
      'Talk to the supply officer — a `claude` PM that sharpens your vague requests into observable to-do cards and files them on the Board to the left. It only writes the Board; it never edits code or dispatches workers.',
    'projectPanel.swarm.supply.launch': 'Start supply officer',
    'projectPanel.swarm.supply.launching': 'Starting…',
    'projectPanel.swarm.supply.launchFailed': "Couldn't start the supply officer: {error}",
    'projectPanel.swarm.supply.identity': 'Supply · files to-do',
    'projectPanel.swarm.supply.hint':
      'The supply officer files your requests as Board to-do cards — it never edits code or dispatches workers.',
    'projectPanel.swarm.supply.stop': 'Stop',
    'projectPanel.swarm.supply.stopping': 'Stopping…',
    // Manager (マネージャー) dashboard — the third Swarm view: the worker-monitor +
    // integration-control surface. Drives the autonomous orchestration engine
    // (start/stop · overseer), lets each worker's live screen open inline,
    // and shows the engine's live log. (Board pipeline tallies live on the Board.)
    // (The auto-wake-the-manager toggle was retired 2026-07-16 — with the engine
    // ON, a ready worker always wakes the manager desk; the engine never merges.)
    'projectPanel.swarm.manager.tab': 'Manager',
    'projectPanel.swarm.manager.badge': 'Manager',
    'projectPanel.swarm.manager.overseer': 'Overseer (proxy-you)',
    'projectPanel.swarm.manager.overseerHint':
      'An autonomous proxy of YOU that watches the swarm: on a judgment edge it answers a blocked worker’s free-text question as you would (grounded in your corpus), or — for anything irreversible or that it cannot ground — raises it to your inbox. It only READS, ASKS, or ANSWERS; it never merges or dispatches. Budget-capped and off by default. Turning autonomy OFF also disarms this — so you re-arm it each session (it is never auto-resumed). On macOS its brain always runs kernel-sandboxed with network egress closed to Anthropic only.',
    'projectPanel.swarm.manager.overseerSandboxWarning':
      '⚠ Kernel-level containment is unavailable on this host (macOS sandbox-exec required) — the overseer’s brain runs with the permission-layer safeguards only. Its read-only design and budget still hold.',
    'projectPanel.swarm.manager.on': 'On',
    'projectPanel.swarm.manager.off': 'Off',
    'projectPanel.swarm.manager.engineRunning': 'Engine running',
    'projectPanel.swarm.manager.engineStopped': 'Engine stopped',
    'projectPanel.swarm.manager.engineOffline': 'Engine not available yet',
    'projectPanel.swarm.manager.engineFailed': "Couldn't reach the engine: {error}",
    'projectPanel.swarm.manager.workersHeading': 'Workers',
    'projectPanel.swarm.manager.showScreen': 'Show live screen',
    'projectPanel.swarm.manager.hideScreen': 'Hide live screen',
    'projectPanel.swarm.manager.stageStarting': 'Starting',
    'projectPanel.swarm.manager.stageRunning': 'Running',
    'projectPanel.swarm.manager.stageDone': 'Done',
    'projectPanel.swarm.manager.noWorkers': 'No workers running.',
    'projectPanel.swarm.manager.reviewsHeading': 'Review · integration',
    'projectPanel.swarm.manager.reviewFf': 'Ready',
    'projectPanel.swarm.manager.reviewRebase': 'Needs rebase',
    'projectPanel.swarm.manager.reviewConflict': 'Conflict',
    'projectPanel.swarm.manager.reviewUnknown': 'Checking…',
    // Why each review card is (not) integrable — the tooltip on its status label.
    'projectPanel.swarm.manager.reviewFfHint': 'Fast-forwardable — ready to land on the trunk now.',
    'projectPanel.swarm.manager.reviewRebaseHint': 'Diverged from the trunk — needs a rebase (which may conflict).',
    'projectPanel.swarm.manager.reviewConflictHint': 'A rebase hit a conflict — needs manual integration.',
    'projectPanel.swarm.manager.reviewUnknownHint': 'Not judgeable yet (no remote trunk, or still checking).',
    // Worker source badge: manual (you dispatched it) vs engine (autonomous).
    'projectPanel.swarm.manager.sourceManual': 'Manual',
    'projectPanel.swarm.manager.sourceEngine': 'Auto',
    'projectPanel.swarm.manager.sourceManualHint': 'You dispatched this worker by hand.',
    'projectPanel.swarm.manager.sourceEngineHint': 'The autonomous engine dispatched this worker.',
    'projectPanel.swarm.manager.logHeading': 'Engine log',
    'projectPanel.swarm.manager.logImportant': 'Key',
    'projectPanel.swarm.manager.logAll': 'All',
    // Structured log-event kind chips (条件1) — the event TYPE at a glance.
    'projectPanel.swarm.manager.logKindDispatch': 'Dispatch',
    'projectPanel.swarm.manager.logKindPromote': 'Review',
    'projectPanel.swarm.manager.logKindIntegrate': 'Merge',
    'projectPanel.swarm.manager.logKindConflict': 'Conflict',
    'projectPanel.swarm.manager.logKindCleanup': 'Cleanup',
    'projectPanel.swarm.manager.logKindCrash': 'Crash',
    // Anomalies (条件2) — state inconsistencies the engine detected.
    'projectPanel.swarm.manager.anomaliesHeading': 'Inconsistencies',
    'projectPanel.swarm.manager.anomalyOrphanDoing': 'Card stuck in Doing — its worker is gone',
    'projectPanel.swarm.manager.anomalyWorktreeMissing': "Worker's worktree is missing",
    'projectPanel.swarm.manager.anomalyWorkerStale': 'Worker silent — possibly stuck',
    'projectPanel.swarm.manager.anomalyStaleFor': 'no heartbeat for {min} min',
    // Move-stuck anomaly (anti-zombie): a Board column move kept failing past the
    // retry budget, so the card couldn't follow its work. The intent names the
    // exact zombie on the detail line.
    'projectPanel.swarm.manager.anomalyMoveStuck': "Card can't follow its work — its board move keeps failing",
    'projectPanel.swarm.manager.moveStuckReview': 'worker finished, stuck in Doing',
    'projectPanel.swarm.manager.moveStuckDone': 'landed on the trunk, stuck in Review',
    'projectPanel.swarm.manager.moveStuckRecover': 'lost worker, stuck in Doing',
    'projectPanel.swarm.manager.moveStuckRecoverReview': 'finished worker stopped, could not return to Review',
    // Review resolution — take a stuck (conflict / failing-verify) card out of review.
    'projectPanel.swarm.manager.resolvePrompt': 'Resolve:',
    'projectPanel.swarm.manager.resolvePark': 'Park',
    'projectPanel.swarm.manager.resolveParkHint':
      'Move this card to Needs decision and take its branch over by hand (rebase in a terminal), then mark it done.',
    'projectPanel.swarm.manager.resolveRequeue': 'Requeue',
    'projectPanel.swarm.manager.resolveRequeueHint':
      'Move this card back to To do so a fresh worker re-attempts it off the current trunk.',
    'projectPanel.swarm.manager.logOnlyRoutine': 'Only routine bookkeeping so far — switch to All to see it.',
    'projectPanel.swarm.manager.logEmpty':
      'No engine events yet. Turn on Autonomy to let the engine drain the Board.',
    // Manager command bar — issue an order to /manage without focusing the xterm.
    'projectPanel.swarm.manager.command': 'Command the manager',
    'projectPanel.swarm.manager.commandPlaceholder':
      'Tell the manager what to do… (Enter to send, Shift+Enter for a new line)',
    'projectPanel.swarm.manager.send': 'Send',
    'projectPanel.swarm.manager.quickStatus': 'Status',
    'projectPanel.swarm.manager.quickMerge': 'Merge',
    'projectPanel.swarm.manager.quickClean': 'Clean up',
    // Manager conversation (/manage) — the human-in-the-loop counterpart to
    // the autonomous engine: a `claude` you talk to (status / merge / advise),
    // launched in the primary checkout (no worktree, like supply). It shares the
    // tab with the engine controls + worker monitor + log.
    'projectPanel.swarm.manager.engineHeading': 'Engine',
    // KPI roll-up (the analytics layer) — the manager dashboard's "is the swarm
    // getting better?" panel: lead time + rework / conflict / worker-success rates.
    'projectPanel.swarm.manager.kpiHeading': 'Metrics',
    'projectPanel.swarm.manager.kpiLeadTime': 'Lead time',
    'projectPanel.swarm.manager.kpiLeadTimeHint': 'Median todo→done · {count} completed',
    'projectPanel.swarm.manager.kpiWorkerSuccess': 'Worker success',
    'projectPanel.swarm.manager.kpiReworkRate': 'Rework rate',
    'projectPanel.swarm.manager.kpiConflictRate': 'Conflict rate',
    'projectPanel.swarm.manager.kpiEmpty': 'No completed work yet — metrics appear as the engine runs.',
    // Consumption (the budget layer) — the unattended loop's live load + session
    // spend + its ceiling. A SEPARATE section from the KPI metrics above.
    'projectPanel.swarm.manager.consumptionHeading': 'Consumption',
    'projectPanel.swarm.manager.consumptionActive': 'Active workers',
    'projectPanel.swarm.manager.consumptionRunTime': 'Active run time',
    'projectPanel.swarm.manager.consumptionDispatched': 'Dispatched · session',
    'projectPanel.swarm.manager.consumptionDispatchedHint': 'Workers spawned since the engine started',
    'projectPanel.swarm.manager.consumptionOverLimit':
      'Over budget — the loop has dispatched {dispatched} / {limit} workers this session. Check it.',
    // Manager presence (the inspection line) — explains the quiet minutes after
    // a worker finishes: the manager checks the work before it goes live. Fed by
    // the manager heartbeat file via the orchestrator poll; owner-plain wording
    // (the 2026-07-17 owner-surface rule): everyday language, no jargon.
    'projectPanel.swarm.manager.presenceHeading': 'Inspection',
    'projectPanel.swarm.manager.presenceActive': 'The manager is working',
    'projectPanel.swarm.manager.presenceActiveHint':
      'It is checking finished work and putting it into the main code. This usually takes a few minutes per job.',
    'projectPanel.swarm.manager.presenceStandby': 'The manager is resting',
    'projectPanel.swarm.manager.presenceStandbyHint':
      'It wakes up on its own the next time a worker finishes something — no action needed.',
    'projectPanel.swarm.manager.presenceQueue': 'Waiting for inspection: {count}',
    'projectPanel.swarm.manager.presenceQueueHint':
      'Finished work goes live only after the manager checks it.',
    'projectPanel.swarm.manager.presenceLastBeat': 'Last report {ago} ago',
    'projectPanel.swarm.manager.conversationTitle': 'Talk to the manager',
    'projectPanel.swarm.manager.conversationEmpty':
      'Start a `claude` manager running /manage in this project. Ask it for status, to integrate finished branches (fast-forward / rebase only), to clean up, or for advice. It runs in the primary checkout — no worktree — alongside the autonomous engine.',
    'projectPanel.swarm.manager.launch': 'Start manager',
    'projectPanel.swarm.manager.launching': 'Starting…',
    'projectPanel.swarm.manager.launchFailed': "Couldn't start the manager: {error}",
    'projectPanel.swarm.manager.stop': 'Stop',
    'projectPanel.swarm.manager.stopping': 'Stopping…',
    'projectPanel.swarm.manager.stopWorkerHint':
      'Stop this worker — tear down its worktree and `claude`, and park its card in Needs decision.',
    'projectPanel.swarm.manager.conversationIdentity': 'Manager · /manage',
    'projectPanel.swarm.manager.conversationHint':
      'The manager monitors workers and integrates finished branches — talk to it here.',
    'projectPanel.swarm.manager.backToCommander': 'Back to manager',
    // Overseer tab (監督) — where the swarm's messages to the owner live: the
    // escalation inbox (esc.* below) + the needs-attention feed (fatal events +
    // engine anomalies, carried over from the removed Flow tab). Read when
    // opened — never pinned over the other sub-views; the tab badge carries the
    // open-question count. Anomaly labels REUSE the manager.* keys above.
    'projectPanel.swarm.overseer.tab': 'Overseer',
    'projectPanel.swarm.overseer.alertsHeading': 'Needs attention',
    'projectPanel.swarm.overseer.emptyTitle': 'Nothing needs you',
    'projectPanel.swarm.overseer.emptyBody':
      "Questions the swarm escalates to you and fatal events land here. Arm the overseer from the Manager tab's Overseer switch while the swarm runs.",
    'projectPanel.swarm.overseer.ago': '{age} ago',
    'projectPanel.swarm.overseer.anomalyReworkExhausted': 'Card retried too many times — parked in Needs decision',
    'projectPanel.swarm.overseer.anomalyNoHeartbeat': 'Worker active but has never sent a heartbeat — protocol violation',
    'projectPanel.swarm.overseer.anomalyReviewPanelFailed': 'Review panel indecisive — merge withheld, needs a human',
    'projectPanel.swarm.overseer.anomalyHighRiskHold': 'High-risk paths touched — auto-merge withheld, merge manually',
    // Fatal-event labels — the escalation events the safety valve
    // (card 6fe48c1f) persists. The engine-side ones plus two from the
    // Electron self-update cycle. The server `detail` (Japanese) rides as a
    // secondary line; these label WHAT fired in the UI language.
    'projectPanel.swarm.overseer.fatalReworkExhausted': 'Card parked · rework limit',
    'projectPanel.swarm.overseer.fatalAllWorkersDown': 'All workers stopped',
    'projectPanel.swarm.overseer.fatalExecTimeout': 'Worker hit time limit',
    'projectPanel.swarm.overseer.fatalRollback': 'Self-update rolled back',
    'projectPanel.swarm.overseer.fatalCanaryFailed': 'Self-update canary failed',
    'projectPanel.swarm.overseer.fatalReviewPanelFailed': 'Review panel failed · merge withheld',
    'projectPanel.swarm.overseer.fatalHighRiskHold': 'High-risk paths · awaiting manual merge',
    // Escalations inbox (C1) — questions the swarm raised to YOU, waiting for
    // your answer. Fail-closed: nothing proceeds until you decide.
    'projectPanel.swarm.esc.title': 'Escalations — waiting for your answer',
    'projectPanel.swarm.esc.whyIrreversible': 'Irreversible',
    'projectPanel.swarm.esc.whyInsufficientInfo': 'Needs your knowledge',
    // Same reason as the ja string: name what is being ASKED OF the reader, not the
    // internal classification. This badge marks "your area, your call".
    'projectPanel.swarm.esc.whyPolicy': 'Your call',
    'projectPanel.swarm.esc.proxyDraft': 'Proxy draft · confidence {confidence}',
    'projectPanel.swarm.esc.abstention': 'The proxy abstained — it lacks your context here.',
    'projectPanel.swarm.esc.useDraft': 'Use draft',
    'projectPanel.swarm.esc.techDetails': 'Technical details',
    'projectPanel.swarm.esc.screenshot': "Worker's screen at the time",
    'projectPanel.swarm.esc.answerPlaceholder': 'Your answer…',
    'projectPanel.swarm.esc.answerSend': 'Answer & resume',
    'projectPanel.swarm.esc.dismiss': 'Dismiss',
    'projectPanel.swarm.esc.deliveryInjected': 'Answer injected into the live worker — it resumes now.',
    'projectPanel.swarm.esc.deliveryQueued': "Worker is gone — recorded; while the swarm is running, the card's next dispatch carries this answer.",
    'projectPanel.swarm.esc.deliverySkipped': 'Recorded. Nothing live to deliver to.',
    'projectPanel.swarm.esc.memoryWritten': 'Learned — written back to your corpus.',
    'projectPanel.swarm.esc.actionFailed': 'Escalation action failed: {error}',
    // Sidebar resizer
    // Chat header
    // Delete confirm
    'projectPanel.deleteProjectLabel': 'Delete project',
    'projectPanel.moveToTrashQuestion': 'Move “{name}” to the Trash?',
    'projectPanel.deleteExplain': 'The entire project folder is moved to the macOS Trash and removed from OPEN GROUND — but you can still restore it from the Trash in Finder. (To just take it off the Ground without touching the folder, use “Remove from Ground” instead.)',
    'projectPanel.typeToConfirmBefore': 'Type',
    'projectPanel.typeToConfirmAfter': 'to confirm',
    'projectPanel.deleteFailed': 'Delete failed: {error} — the folder was not removed. Try again, or move it to the Trash in Finder yourself.',
    'projectPanel.deleting': 'Deleting…',
    // Tabs
    'projectPanel.dragToReorder': 'Drag to reorder · Alt+←/→ to move',
    // More menu
    'projectPanel.moreActions': 'More actions',
    'projectPanel.revealInFinder': 'Reveal in Finder',
    'projectPanel.revealInExplorer': 'Show in Explorer',
    'projectPanel.revealFolder': 'Open folder',
    // Open in editor (header icon button + chooser dropdown)
    'projectPanel.openInEditor': 'Open in editor',
    'projectPanel.openInEditorWith': 'Open in {name}',
    'projectPanel.chooseEditor': 'Choose editor',
    'projectPanel.editorNoneFound': 'No editors found',
    'projectPanel.editorSetDefault': 'Set as default',
    'projectPanel.editorClearDefault': 'Clear default',
    'projectPanel.editorPickOther': 'Choose another app…',
    'projectPanel.editorOpenFailed': "Couldn't open an editor: {error}",
    // Branch changes (header chip + modal)
    'projectPanel.branchChipTitle': 'Show branch changes',
    'projectPanel.branchMenuTitle': 'Active branches',
    'projectPanel.branchMenuCurrent': 'current',
    'projectPanel.branchMenuEmpty': 'No branches',
    'projectPanel.branchChangesTitle': 'Branch changes',
    'projectPanel.branchAheadBehind': 'ahead {ahead} · behind {behind}',
    'projectPanel.branchWorkingHeading': 'Working tree changes',
    'projectPanel.branchCommittedHeading': 'Changes from {target}',
    'projectPanel.branchNoTarget': 'No target branch (main / master not found) — nothing to compare against.',
    'projectPanel.branchSameAsTarget': 'This is the target branch — only working tree changes are shown.',
    'projectPanel.branchNoChanges': 'No changes',
    'projectPanel.branchLoadFailed': "Couldn't read branch changes: {error}",
    'projectPanel.skillsButton': 'Skills',
    'projectPanel.skillsButtonHint': "List this project's Claude skills (.claude/skills)",
    'projectPanel.skillsModalTitle': 'Skills',
    'projectPanel.skillsSectionGlobal': 'Your global skills',
    'projectPanel.skillsEmptyProject': 'No skills in this project yet.',
    'projectPanel.skillsEmptyGlobal': "No global skills yet — create one below.",
    'projectPanel.skillsLoadFailed': "Couldn't read skills: {error}",
    'projectPanel.skillsPanelTitle': 'Your skills',
    'projectPanel.skillsPanelSubtitle': '~/.claude/skills · available in every project',
    'projectPanel.skillsCreateLabel': 'Create a new skill',
    'projectPanel.skillsCreatePlaceholder': 'Describe the skill you want (e.g. "a skill that generates a PDF report from a folder of images")',
    'projectPanel.skillsCreateHint': 'Claude will write it into ~/.claude/skills.',
    'projectPanel.skillsCreating': 'Creating… this can take up to a minute',
    'projectPanel.skillsCreateButton': 'Create skill',
    'projectPanel.skillsCreateFailed': "Couldn't create the skill: {error}",
    'projectPanel.skillsClaudeMissing': 'The claude CLI isn’t available — install / sign in to create skills.',
    'projectPanel.branchDiffFailed': "Couldn't load the diff: {error}",
    'projectPanel.branchDiffEmpty': 'No diff to show.',
    'projectPanel.branchDiffTruncated': 'Diff truncated — the full change is too large to show here.',
    'projectPanel.removeFromCanvas': 'Remove from Ground',
    'projectPanel.deleteProjectMenu': 'Delete project…',
    // Project settings dialog (shared policy + personal launch prefs)
    'projectPanel.projectSettingsMenu': 'Project settings…',
    'projectPanel.settingsDialogLabel': 'Project settings',
    'projectPanel.settingsBack': 'Back',
    // Section headings adapt to the share/git state (docs/SHARE_UX_FLOWS.md):
    // solo users see "Task workflow" with zero share vocabulary; the team
    // section appears only while the project is actually shared.
    'projectPanel.settingsWorkflowHeading': 'Task workflow',
    'projectPanel.settingsWorkflowHint': 'What claude does when a task in this project is finished.',
    'projectPanel.settingsDisplayName': 'Your display name',
    'projectPanel.settingsDisplayNameHint': 'Used as your name on cards — a global setting, shared across all projects.',
    'projectPanel.settingsDisplayNameSaveFailed': 'Couldn’t save your display name: {error} — edit the field again to retry.',
    'projectPanel.settingsPersonalHeading': 'Personal',
    'projectPanel.settingsPersonalHint': 'Stored only on this machine — never synced.',
    'projectPanel.settingsCompletionFlow': 'Completion flow',
    'projectPanel.settingsFlowMerge': 'Merge directly',
    'projectPanel.settingsFlowPr': 'Open a PR',
    'projectPanel.reviewWaitingTitle': 'Cards waiting in Review',
    'projectPanel.settingsGhMissing': 'GitHub CLI (gh) not found — PR creation will fail. Install it (brew install gh), then run gh auth login.',
    'projectPanel.settingsGhUnauthenticated': 'gh is installed but not signed in — run gh auth login before finishing a task with a PR.',
    'projectPanel.settingsFlowMergeHint':
      'Claude merges the finished task branch straight into the target branch.',
    'projectPanel.settingsFlowPrHint':
      'Claude pushes the branch and opens a PR — a human reviews and merges. With the Review column on, the card moves there automatically.',
    'projectPanel.settingsTargetBranch': 'Target branch',
    'projectPanel.settingsTargetBranchPlaceholder': 'branch at launch',
    'projectPanel.settingsBranchDefault': 'Branch at launch (default)',
    'projectPanel.settingsMembers': 'Members',
    // Unshared git projects: the same list, share-free vocabulary (solo
    // users assign cards too — docs/SHARE_UX_FLOWS.md S033/S034).
    'projectPanel.settingsAssigneeNames': 'Assignee names',
    'projectPanel.settingsAssigneeNamesHint': 'Names offered as one-click assignee choices on this board’s cards.',
    'projectPanel.settingsMemberAddPlaceholder': 'Add a member…',
    'projectPanel.settingsMemberAdd': 'Add',
    'projectPanel.settingsMemberRemove': 'Remove {name}',
    // Permission-mode labels — used by the Board's run-defaults strip (the
    // dialog's own profile rows moved there, 2026-06-12).
    'projectPanel.settingsPermDefault': 'Default (confirm each action)',
    'projectPanel.settingsPermAcceptEdits': 'Accept edits automatically',
    'projectPanel.settingsPermPlan': 'Plan mode',
    'projectPanel.settingsPermBypass': 'Bypass — fully automatic, no confirmations',
    'projectPanel.settingsLaunchMovedHint':
      'The launch profile (model · effort · permissions · completion flow) now lives in the “Run defaults” strip above the board.',
    // Worktrees cleanup (B012/F082)
    'projectPanel.settingsWorktrees': 'Worktrees',
    'projectPanel.settingsWorktreesLoading': 'Checking…',
    'projectPanel.settingsWorktreesNone': 'None',
    'projectPanel.settingsWorktreesCount': '{count} active · {dirty} with uncommitted changes',
    'projectPanel.settingsWorktreesUnavailable': 'Could not check worktrees.',
    'projectPanel.settingsWorktreesClean': 'Clean unused worktrees',
    'projectPanel.settingsWorktreesCleaning': 'Cleaning…',
    'projectPanel.settingsWorktreesResult': 'Removed {removed} · skipped {skipped} (uncommitted changes)',
    'projectPanel.settingsWorktreesFailed': "Couldn't clean worktrees: {error}",
    'projectPanel.settingsWorktreesHint':
      'Task and review checkouts that piled up under ~/.openground. Cleaning removes only the ones with no uncommitted changes — anything in progress is kept.',
    'projectPanel.inviteCopy': 'Copy',
    'projectPanel.inviteCopied': 'Copied',
    'projectPanel.inviteDone': 'Done',
    // Realtime collaboration — invite (link-based self-join). OFF by default;
    // these only render when collab is enabled (OPENGROUND_REALTIME + worker).
    'projectPanel.collabEntry': 'Invite',
    'projectPanel.collabEntryTitle': 'Invite collaborators (realtime)',
    'projectPanel.collabLabel': 'Realtime collaboration',
    'projectPanel.collabTitle': 'Invite to “{name}”',
    'projectPanel.collabExplain': 'Collaborators edit this project’s Board and Canvas with you in realtime. Each person runs Claude with their own subscription — the workspace is shared, the work is each your own.',
    'projectPanel.collabSharedName': 'Shared name',
    'projectPanel.collabSharedNameHint': 'What collaborators see for this project. Your local folder path stays private.',
    'projectPanel.collabSharedNameRequired': 'Enter a shared name first',
    'projectPanel.collabCreateLink': 'Create invite link',
    'projectPanel.collabCreating': 'Creating…',
    'projectPanel.collabCodeLabel': 'Invite code',
    'projectPanel.collabExpires': 'Expires in 7 days. Anyone signed in to OPEN GROUND with this code can join as an editor.',
    'projectPanel.collabAfterNote': 'Send this code to your collaborator — they join from their own OPEN GROUND.',
    'projectPanel.collabCreateFailed': 'Couldn’t create an invite link — check your connection and that you’re signed in, then try again.',
    'projectPanel.collabNewLink': 'New link',
    'projectPanel.collabRevoke': 'Revoke all links',
    'projectPanel.collabRevoking': 'Revoking…',
    'projectPanel.collabRevoked': 'All invite links revoked.',
    'projectPanel.collabRevokeHint': 'Revoke outstanding links (e.g. after removing someone).',
    'projectPanel.collabRevokeFailed': 'Couldn’t revoke the links — try again.',
    // Collaborators roster (owner): list + invite-by-email + remove.
    'projectPanel.collabMembersLabel': 'Collaborators',
    'projectPanel.collabNoMembers': 'No collaborators yet — invite by email or share a link.',
    'projectPanel.collabMemberNoEmail': '(no email)',
    'projectPanel.collabMemberOwner': 'Owner',
    'projectPanel.collabMemberRole': 'Member',
    // A non-owner whose email invite hasn't been accepted yet (no access until they do).
    'projectPanel.collabMemberPending': 'Invited',
    'projectPanel.collabMemberRemove': 'Remove',
    'projectPanel.collabMemberRemoveFailed': 'Couldn’t remove that collaborator — try again.',
    'projectPanel.collabInviteCancel': 'Cancel invite',
    'projectPanel.collabInviteCancelFailed': 'Couldn’t cancel that invite — try again.',
    'projectPanel.collabInviteEmailPlaceholder': 'name@example.com',
    'projectPanel.collabInviteEmailBtn': 'Invite',
    'projectPanel.collabInviteEmailBusy': 'Inviting…',
    'projectPanel.collabInviteEmailFailed': 'Couldn’t invite — check the email and try again.',
    // Email invite as the recommended (safe) path — you name exactly who joins.
    'projectPanel.collabInviteEmailLabel': 'Invite by email',
    'projectPanel.collabInviteRecommended': 'Recommended',
    'projectPanel.collabInviteEmailExplain':
      'Only this person can join — you choose exactly who’s in. They get a notice inside OPEN GROUND and join by accepting it. Safer than a link.',
    // Quick share link as the looser, faster alternative.
    'projectPanel.collabQuickShareLabel': 'Quick share link',
    'projectPanel.collabQuickShareExplain':
      'Anyone signed in who has the link can join — handy for a fast hand-off, but you can’t pre-confirm exactly who ends up in.',
    // Shared-project (member) view — opening a folder-less project you joined.
    'projectPanel.collabSharedBadge': 'Shared',
    'projectPanel.collabSharedLive': 'Live',
    'projectPanel.collabSharedConnecting': 'Connecting to the shared project…',
    'projectPanel.collabSharedUnavailable': 'This shared project is unavailable — it may have been un-shared, or your access was removed.',
    'projectPanel.collabSharedClaudeTitle': 'Claude runs on your own machine',
    'projectPanel.collabSharedClaudeBody': 'This is a shared workspace — the Board syncs in realtime, but Claude runs in your own local checkout with your own subscription. Open this project’s repository locally to run Claude on a task.',
    'projectPanel.collabSharedCachedBanner': 'Connecting — showing your last saved copy (read-only)',
    'projectPanel.collabLinkFolder': 'Link local folder',
    'projectPanel.collabLinkFolderHint':
      'Link a folder on this computer — your own clone of this project — to open a Terminal and run Claude on it. Board & Canvas keep syncing in realtime; the owner’s code is never sent to you.',
    'projectPanel.collabLinkFailed': 'Couldn’t link folder',
    'projectPanel.collabLinkAlreadyLinked':
      'This shared project is already linked to a different folder.',
    'projectPanel.collabLinkDuplicate': 'That folder is already registered as another project.',
    'projectPanel.collabLinkOverlap':
      'That folder overlaps an existing project — pick a separate folder.',
    'projectPanel.collabLinkBadTarget':
      'Pick a normal project folder (not your home folder or the disk root).',
    'projectPanel.collabCanvasBack': 'All canvases',
    'projectPanel.collabCanvasEmpty': 'No canvases in this project yet.',
    // "Shared with me" dialog (the member entry point — join by code + open).
    'projectPanel.collabSharedDialogTitle': 'Shared with me',
    'projectPanel.collabSharedDialogJoinLabel': 'Join with a code or link',
    'projectPanel.collabSharedDialogJoinPlaceholder': 'Paste invite code or link',
    'projectPanel.collabSharedDialogJoin': 'Join',
    'projectPanel.collabSharedDialogJoining': 'Joining…',
    'projectPanel.collabSharedDialogJoinFailed': 'Couldn’t join — check the code or link (it may be invalid or expired) and that you’re signed in.',
    'projectPanel.collabSharedDialogErrorInvalid': 'This invite is invalid or has expired. Ask the owner for a fresh invite link.',
    'projectPanel.collabSharedDialogErrorSignedOut': 'Sign in (Google or GitHub) first, then paste the invite to join.',
    'projectPanel.collabSharedDialogListLabel': 'Your shared projects',
    'projectPanel.collabSharedDialogEmpty': 'No shared projects yet. Paste an invite code above to join one.',
    'projectPanel.collabSharedDialogUntitled': 'Untitled shared project',
    'projectPanel.collabSharedDialogAwaiting': 'Request sent — awaiting approval',
    'projectPanel.collabSharedDialogAwaitingBody': 'The owner of this project approves new collaborators. You’ll be able to open it once they approve your request.',
    // Ground shared card — a project shared WITH you (owned:false), shown on the
    // Ground canvas alongside your own cards (collab enabled only).
    'projectPanel.groundSharedBadge': 'Shared',
    'projectPanel.groundSharedTitle': 'Shared with you',
    // Invite link v2 — permission mode + bounds picker (owner, before minting).
    'projectPanel.collabModeLabel': 'Who can join',
    'projectPanel.collabModeOpen': 'Anyone with the link',
    'projectPanel.collabModeApproval': 'Approve each request',
    'projectPanel.collabModeOpenHint': 'Signing in and opening the link joins immediately.',
    'projectPanel.collabModeApprovalHint': 'Opening the link asks to join — you approve each person below.',
    'projectPanel.collabSingleUse': 'Single use (the link works once)',
    'projectPanel.collabMemberCapField': 'Max collaborators',
    'projectPanel.collabMemberCapPlaceholder': 'No limit',
    // Invite link v2 — active links roster + per-link revoke + reset.
    'projectPanel.collabLinksLabel': 'Active invite links',
    'projectPanel.collabLinkModeOpen': 'Open',
    'projectPanel.collabLinkModeApproval': 'Approval',
    'projectPanel.collabLinkUsesUnlimited': '{used} joined',
    'projectPanel.collabLinkUsesCapped': '{used}/{max} used',
    'projectPanel.collabLinkRevoke': 'Revoke this link',
    'projectPanel.collabResetLink': 'Reset link',
    'projectPanel.collabResetting': 'Resetting…',
    'projectPanel.collabResetFailed': 'Couldn’t reset the link — try again.',
    'projectPanel.collabMemberCapCurrent': 'Limit: {cap} collaborators',
    // Invite link v2 — approval queue (owner).
    'projectPanel.collabRequestsLabel': 'Requests to join',
    'projectPanel.collabApprove': 'Approve',
    'projectPanel.collabApproving': 'Approving…',
    'projectPanel.collabDeny': 'Deny',
    'projectPanel.collabRequestFailed': 'Couldn’t update that request — try again.',
    // Copy button
    // Conflict resolution
    // RoundView labels
    // PastRunFallback
    // TaskThread composer
    'projectPanel.deleteTask': 'Delete task',
    // TaskThread inline
    // TasksSection
    // Terminal split view
    'projectPanel.closeTerminal': 'Close terminal',
    'projectPanel.newTerminal': 'New terminal',
    'projectPanel.new': 'New',
    'projectPanel.renameTerminal': 'Double-click to rename',
    'projectPanel.launchClaude': 'Launch Claude',
    'projectPanel.launchingClaude': 'Launching…',
    // The single "sign in to Claude" terminal (opened from a run that hit
    // claudeLoggedOut). One claude PTY the user authenticates in — claude opens
    // its OAuth once; after signing in, runs go through normally.
    'projectPanel.claudeLogin.title': 'Sign in to Claude',
    'projectPanel.claudeLogin.hint':
      'Complete sign-in in this terminal (your browser opens once). Then close this and run again.',
    'projectPanel.claudeLogin.starting': 'Opening a Claude terminal to sign in…',
    'projectPanel.claudeLogin.retry': 'Try again',
    // Embedded claude terminal + terminal dock (Canvas / Board sidebar)
    'projectPanel.embTermHint':
      'Launch claude in this project — respond and approve permission prompts right in this terminal.',
    'projectPanel.dockTitle': 'Terminal',
    'projectPanel.dockOpen': 'Open {title}',
    'projectPanel.dockCloseTab': 'Close this terminal',
    'projectPanel.dockAddTab': 'Add terminal',
    'projectPanel.dockClose': 'Close dock',
    'projectPanel.canvasDockHint':
      'Launch claude in this project to drive Canvas design work — edit and review files from this terminal.',
    'projectPanel.boardDockHint':
      'Launch claude in this project — edit and review files from this terminal.',
    // Notes
    // CompactTaskRow
    // NewTaskComposer
    // EditableTaskTitle
    // EditableTitle
    'projectPanel.doubleClickToRename': 'Double-click to rename',
    'projectPanel.clickToRenameProject': 'Click to rename project',
    // Running roster — live claude lanes for the project.
  } as Record<string, string>,
  ja: {
    // Header
    'projectPanel.backToGround': 'Ground に戻る',
    'projectPanel.claudeNotFound': 'claude CLI が見つかりません — Claude Code をインストールして OPEN GROUND を再起動してください',
    'projectPanel.generating': '生成中…',
    'projectPanel.cancelDescription': '生成を停止',
    'projectPanel.regenerateDescription': '説明を更新',
    'projectPanel.generateDescription': '説明を生成',
    // Open in… / pick app
    'projectPanel.pickFailed': 'アプリを追加できませんでした: {error} — もう一度アプリを選び直してください。',
    'projectPanel.folderGone': 'そのフォルダはディスク上に存在しません。カードを Ground から外すか、移動した場合はフォルダを再インポートしてください。',
    'projectPanel.openFailed': 'アプリでプロジェクトを開けませんでした: {error} — アプリがインストールされているか確認して、もう一度お試しください。',
    'projectPanel.networkError': 'ネットワークエラー（サーバーに接続できません）',
    // Missing-folder banner
    'projectPanel.missingBanner': 'このフォルダはディスク上に存在しません。実行と「Open in…」は無効です。移動した場合は「場所を選ぶ」で指定し直すか、カードを外すには「Ground から外す」を使ってください。',
    'projectPanel.locateFolder': '場所を選ぶ…',
    'projectPanel.locateFolderHint': 'このカードをフォルダの新しい場所に指し直します。タスク・ノート・Canvas が再接続されます。',
    // Loading
    'projectPanel.loading': '読み込み中…',
    'projectPanel.loadFailed': 'プロジェクトを読み込めませんでした — サーバーに接続できません。dev サーバーが起動しているか確認して、再試行してください。',
    'projectPanel.retry': '再試行',
    // Swarm — オーナー限定の実験（アプリ内 swarm オーケストレーション面、project_inapp_swarm_port）。
    // 実験 ON（オーナー＋設定トグル、サーバー解決）時のみ表示。
    'projectPanel.swarm.badge': '実験的',
    'projectPanel.swarm.title': 'Swarm オーケストレーション',
    'projectPanel.swarm.body': '複数プロジェクトにまたがる Claude セッションのチームを 1 つの画面から動かします。これは初期の実験で、既定ではオフです。',
    // 電源スイッチ（SwarmPowerBar）— Swarm タブ全体の単一の開始/停止。オンで自律
    // エンジンを起動し、マネージャー＋タスク窓口の対話もまとめて起動（冪等）。オフは新規の
    // 振り分けを止めるだけ（走行中の worker は完走・worktree は温存）。状態として
    // 稼働中/停止中＋稼働ワーカー数を表示。（自動統合の別スイッチは廃止
    // (2026-07-16) — エンジンは push しない。）
    'projectPanel.swarm.power.label': 'Swarm',
    'projectPanel.swarm.power.start': '開始',
    'projectPanel.swarm.power.stop': '停止',
    'projectPanel.swarm.power.running': '稼働中',
    'projectPanel.swarm.power.stopped': '停止中',
    // 手動停止(manualStop — サーバ側で永続化・再起動を跨いで維持)。単なる未起動の「停止中」と区別。
    'projectPanel.swarm.power.manualStop': '手動停止中',
    'projectPanel.swarm.power.offline': '未配備',
    'projectPanel.swarm.power.workers': 'ワーカー {count}',
    'projectPanel.swarm.power.hint':
      'エンジン・マネージャー・タスク窓口をまとめて起動します。停止は新規の振り分けを止めるだけで、走行中の worker は完走し worktree も残ります。',
    // 再起動リマインダー（autonomyRemembered）— 再起動で自律は自動再開しない。前回 ON
    // だった場合だけ、ワンクリック再開のバナーを出す。
    'projectPanel.swarm.autonomyReminder':
      '前回このプロジェクトで自律ドレインが ON でした。再起動で OFF になっています（何も動いていません）。',
    'projectPanel.swarm.autonomyReminder.resume': '再開',
    'projectPanel.swarm.autonomyReminder.dismiss': '閉じる',
    // 実行モード（トークン節約）— swarm 起動全体に効く1スイッチ（card 68d8e00f）。
    'projectPanel.swarm.mode.label': 'モード',
    'projectPanel.swarm.mode.max': '最大出力',
    // {top}/{light} は下の「使用可能モデル」を踏まえて実際に起動する tier。OFF にした
    // モデル名は出さない（「最大出力 = Fable」と嘘をつかない）。
    'projectPanel.swarm.mode.max.hint':
      '全ロール最上位モデル({top}) / max effort・重並列。最高品質・最高コスト。ここぞの時に。',
    'projectPanel.swarm.mode.economy': '節約',
    'projectPanel.swarm.mode.economy.hint':
      '{light}・低〜中effort・並列控えめ。週次枠の消費を最小化。',
    'projectPanel.swarm.mode.optimize': '最適化',
    'projectPanel.swarm.mode.optimize.hint':
      'カードの重みで自動割当 — 安全系/重い仕事は最上位({top})、雑務は {light}。賢い既定（推奨）。',
    // 使用可能モデル — 恒久的な per-tier スイッチ（hard mask）。一時的な quota 冷却とは
    // 別レイヤーで、OFF にした tier は期限で復活しない。
    'projectPanel.swarm.models.label': '使用可能モデル',
    'projectPanel.swarm.models.hint':
      'OFF にしたモデルには swarm のどの役割も起動しません。rate limit の冷却と違い、再起動しても残ります。',
    'projectPanel.swarm.models.last': '最低1つは ON にしてください',
    // OFF・初回オンボーディング（SwarmOnboarding）— swarm が完全に待機状態（エンジン
    // 停止かつタスク窓口／マネージャー／worker セッションなし）のとき中央に出す1枚。3つの役割
    // と、要望がそこをどう流れるかを「開始」前に説明する。役割の名称は上の supply /
    // manager / worker キーを流用し、ここで新規なのはフロー＋役割サマリの文言のみ
    // （重複文言は増やさない・条件3）。
    'projectPanel.swarm.onboarding.intro':
      '要望を伝えるだけ。3つの役割の Claude が、チームで要望から統合済みまで運びます。',
    'projectPanel.swarm.onboarding.flowHeading': '仕事の流れ',
    'projectPanel.swarm.onboarding.roleYou': 'あなた',
    'projectPanel.swarm.onboarding.flowRequest': '要望',
    'projectPanel.swarm.onboarding.flowQueue': 'Board・todo に積む',
    'projectPanel.swarm.onboarding.flowDispatch': '引いて worker に振る',
    'projectPanel.swarm.onboarding.flowImplement': '隔離 worktree で実装',
    'projectPanel.swarm.onboarding.flowReview': 'review',
    'projectPanel.swarm.onboarding.flowIntegrate': '統合',
    'projectPanel.swarm.onboarding.flowDone': 'done',
    'projectPanel.swarm.onboarding.rolesHeading': '3つの役割',
    'projectPanel.swarm.onboarding.roleSupply':
      '要望を観測可能な todo カードにして Board に積みます。Board に書くだけで、コードは編集しません。',
    'projectPanel.swarm.onboarding.roleManager':
      'todo からカードを引いて worker に振り、戻ってきたものを review・統合します。',
    'projectPanel.swarm.onboarding.roleWorker':
      '1枚のカードを自分専用の隔離 worktree で実装し、review に戻す `claude` セッションです。',
    'projectPanel.swarm.onboarding.startNote':
      '「開始」を押すと、エンジン・タスク窓口・マネージャーがまとめて立ち上がり、Board を自動で回し始めます。（あとで停止しても新規の振り分けが止まるだけで、走行中の worker は完走します。）',
    // Workers リスト。手動の「振る」は撤去（todo 一覧は Board タブへ一本化）。
    // worker は自律エンジン（上の電源スイッチ）またはマネージャーセッションが起動します。
    'projectPanel.swarm.workersEmpty': 'worker はまだ動いていません。上のスイッチで Swarm を開始する（またはマネージャーに頼む）と振り分けが始まります — それぞれに隔離された worktree と `claude` セッションが割り当てられます。',
    'projectPanel.swarm.statusWorking': '稼働中',
    'projectPanel.swarm.statusWaiting': '待機中',
    'projectPanel.swarm.statusStarting': '起動中…',
    'projectPanel.swarm.statusExited': '終了',
    // 終了オーバーレイ（ClaudeTerminalPane）— 落ちた PTY は黒画面＋生エラーでなく
    // 「セッション終了 · 再起動」を出す。3ロール（タスク窓口／マネージャー／worker）共通で、
    // どの API で立て直すかはロール側が決める。
    'projectPanel.swarm.sessionEnded': 'セッションが終了しました',
    'projectPanel.swarm.sessionExitCode': '終了コード {code}',
    'projectPanel.swarm.restart': '再起動',
    'projectPanel.swarm.restarting': '再起動中…',
    'projectPanel.swarm.restartFailed': 'セッションを再起動できませんでした: {error}',
    'projectPanel.swarm.terminate': '終了',
    'projectPanel.swarm.terminating': '終了中…',
    'projectPanel.swarm.retained': 'worktree を残しました — 未コミットの変更があります。',
    'projectPanel.swarm.forceRemove': '強制撤去',
    'projectPanel.swarm.forceFailed': 'worktree を撤去できませんでした: {reason}。必要なら手動で削除してください。',
    'projectPanel.swarm.engineOwned': 'エンジン',
    'projectPanel.swarm.engineOwnedHint':
      '自律エンジンが起動・管理している worker です — 操作はマネージャータブから行ってください。',
    // Supply officer (タスク窓口) — 要望を Board:todo カードに積む対話デスク。
    // Board に書くだけで、コードは編集しない。
    'projectPanel.swarm.workersTab': 'ワーカー',
    'projectPanel.swarm.supply.tab': 'タスク窓口',
    'projectPanel.swarm.supply.badge': 'タスク窓口（PM）',
    'projectPanel.swarm.supply.title': '要望を todo カードに変える',
    'projectPanel.swarm.supply.empty':
      'タスク窓口と話してください。あいまいな要望を観測可能な todo カードに整えて、左の Board に積む `claude` の PM です。Board に書くだけで、コードの編集や worker への割り当てはしません。',
    'projectPanel.swarm.supply.launch': 'タスク窓口を起動',
    'projectPanel.swarm.supply.launching': '起動中…',
    'projectPanel.swarm.supply.launchFailed': 'タスク窓口を起動できませんでした: {error}',
    'projectPanel.swarm.supply.identity': 'タスク窓口 · todo に供給',
    'projectPanel.swarm.supply.hint':
      'タスク窓口は要望を Board の todo カードに積みます（コードの編集や worker への割り当てはしません）。',
    'projectPanel.swarm.supply.stop': '停止',
    'projectPanel.swarm.supply.stopping': '停止中…',
    // マネージャー（manager）ダッシュボード — Swarm の3つ目のビュー。worker 監視＋統合
    // コントロールの面。自律オーケストレーションエンジン（起動/停止・監督）を
    // 操作し、各 worker のライブ画面をその場で開け、エンジンのライブログを見せる。
    // （Board のパイプライン件数は Board タブで見る。）
    // （「マネージャーを自動で起こす」トグルは 2026-07-16 に廃止 — エンジン ON なら worker の
    // ready で常にマネージャーを起こす。エンジン自身は統合しない。）
    'projectPanel.swarm.manager.tab': 'マネージャー',
    'projectPanel.swarm.manager.badge': 'マネージャー',
    'projectPanel.swarm.manager.overseer': '監督（あなたの代理）',
    'projectPanel.swarm.manager.overseerHint':
      'あなたの自律代理が swarm を監視します。判断のエッジで、ブロックされた worker の自由文の質問にあなたの代わりに回答し（あなたのコーパスに基づく）、不可逆なもの・根拠が持てないものはあなたの受信箱へエスカレーションします。できるのは「読む・尋ねる・答える」だけ — 統合も dispatch もしません。予算上限つき・既定オフ。autonomy をオフにすると監督も解除されます — 毎セッション再度オンにしてください（自動復帰しません）。macOS では大脳は常にカーネル sandbox で動き、外部通信は Anthropic のみに封鎖されます。',
    'projectPanel.swarm.manager.overseerSandboxWarning':
      '⚠ この環境ではカーネルレベルの封じ込め（macOS の sandbox-exec）が利用できません — 監督の大脳は permission 層の防壁のみで動きます。読み取り専用設計と予算上限は有効です。',
    'projectPanel.swarm.manager.on': 'オン',
    'projectPanel.swarm.manager.off': 'オフ',
    'projectPanel.swarm.manager.engineRunning': 'エンジン稼働中',
    'projectPanel.swarm.manager.engineStopped': 'エンジン停止中',
    'projectPanel.swarm.manager.engineOffline': 'エンジンは未配備です',
    'projectPanel.swarm.manager.engineFailed': 'エンジンに到達できませんでした: {error}',
    'projectPanel.swarm.manager.workersHeading': 'ワーカー',
    'projectPanel.swarm.manager.showScreen': 'ライブ画面を表示',
    'projectPanel.swarm.manager.hideScreen': 'ライブ画面を隠す',
    'projectPanel.swarm.manager.stageStarting': '起動中',
    'projectPanel.swarm.manager.stageRunning': '稼働中',
    'projectPanel.swarm.manager.stageDone': '完了',
    'projectPanel.swarm.manager.noWorkers': 'worker は動いていません。',
    'projectPanel.swarm.manager.reviewsHeading': 'review · 統合',
    'projectPanel.swarm.manager.reviewFf': '統合可',
    'projectPanel.swarm.manager.reviewRebase': '要 rebase',
    'projectPanel.swarm.manager.reviewConflict': '要手動統合',
    'projectPanel.swarm.manager.reviewUnknown': '判定中',
    // 各 review カードがなぜ統合可（不可）か — ステータスラベルの tooltip。
    'projectPanel.swarm.manager.reviewFfHint': '早送り可能 — いま本流へ取り込めます。',
    'projectPanel.swarm.manager.reviewRebaseHint': '本流から分岐 — rebase が必要です（衝突する可能性あり）。',
    'projectPanel.swarm.manager.reviewConflictHint': 'rebase で衝突 — 手動統合が必要です。',
    'projectPanel.swarm.manager.reviewUnknownHint': 'まだ判定できません（リモート本流なし／確認中）。',
    // worker のソースバッジ: 手動（あなたが割り当て）か 自律（エンジンが割り当て）か。
    'projectPanel.swarm.manager.sourceManual': '手動',
    'projectPanel.swarm.manager.sourceEngine': '自律',
    'projectPanel.swarm.manager.sourceManualHint': 'あなたが手動で割り当てた worker です。',
    'projectPanel.swarm.manager.sourceEngineHint': '自律エンジンが割り当てた worker です。',
    'projectPanel.swarm.manager.logHeading': 'エンジンログ',
    'projectPanel.swarm.manager.logImportant': '重要',
    'projectPanel.swarm.manager.logAll': 'すべて',
    // 構造化ログイベントの種別チップ（条件1）— イベントの種類が一目で分かる。
    'projectPanel.swarm.manager.logKindDispatch': '起動',
    'projectPanel.swarm.manager.logKindPromote': 'review',
    'projectPanel.swarm.manager.logKindIntegrate': '統合',
    'projectPanel.swarm.manager.logKindConflict': '衝突',
    'projectPanel.swarm.manager.logKindCleanup': '掃除',
    'projectPanel.swarm.manager.logKindCrash': '異常終了',
    // 不整合（条件2）— エンジンが検出した状態の食い違い。
    'projectPanel.swarm.manager.anomaliesHeading': '不整合',
    'projectPanel.swarm.manager.anomalyOrphanDoing': 'doing のまま放置 — 担当 worker が消失',
    'projectPanel.swarm.manager.anomalyWorktreeMissing': 'worker の worktree が消失',
    'projectPanel.swarm.manager.anomalyWorkerStale': 'worker が無応答 — 停滞の可能性',
    'projectPanel.swarm.manager.anomalyStaleFor': '{min}分 心拍なし',
    // Move-stuck anomaly（ゾンビ防止）: 列移動が予算超で失敗し続け、カードが作業に
    // 追従できない状態。intent が詳細行で具体的なゾンビを示す。
    'projectPanel.swarm.manager.anomalyMoveStuck': 'カードが作業に追従できず — 列移動が失敗し続けています',
    'projectPanel.swarm.manager.moveStuckReview': 'worker 完了済みだが doing で滞留',
    'projectPanel.swarm.manager.moveStuckDone': 'trunk へ統合済みだが review で滞留',
    'projectPanel.swarm.manager.moveStuckRecover': 'worker 消失だが doing で滞留',
    'projectPanel.swarm.manager.moveStuckRecoverReview': '完了済み worker を停止したが review へ戻せず滞留',
    // Review 解決 — 滞留した（衝突／検証失敗）カードを review から退避させる。
    'projectPanel.swarm.manager.resolvePrompt': '解決:',
    'projectPanel.swarm.manager.resolvePark': '保留',
    'projectPanel.swarm.manager.resolveParkHint':
      'このカードを判断待ちに移し、ブランチを手動で解決（ターミナルで rebase）してから done にします。',
    'projectPanel.swarm.manager.resolveRequeue': 'やり直す',
    'projectPanel.swarm.manager.resolveRequeueHint':
      'このカードを To do に戻し、新しい worker が現在の trunk から再挑戦します。',
    'projectPanel.swarm.manager.logOnlyRoutine': 'いまは定常処理のみ — 「すべて」で表示します。',
    'projectPanel.swarm.manager.logEmpty':
      'まだエンジンのイベントはありません。自律をオンにすると、エンジンが Board を drain します。',
    // マネージャーへの命令バー — xterm にフォーカスせず /manage に指示を出す。
    'projectPanel.swarm.manager.command': 'マネージャーに指示',
    'projectPanel.swarm.manager.commandPlaceholder':
      'マネージャーへの指示を入力…（Enter で送信・Shift+Enter で改行）',
    'projectPanel.swarm.manager.send': '送信',
    'projectPanel.swarm.manager.quickStatus': '状況',
    'projectPanel.swarm.manager.quickMerge': 'マージ',
    'projectPanel.swarm.manager.quickClean': '掃除',
    // マネージャーとの対話（/manage）— 自律エンジンの human-in-the-loop 対。状況/統合/
    // 相談を頼める対話型 `claude` を primary checkout に起動する（worktree なし・
    // supply と同型）。エンジン制御＋worker 監視＋ログと同じタブに同居する。
    'projectPanel.swarm.manager.engineHeading': 'エンジン',
    // KPI 集計（分析レイヤ）— マネージャーダッシュボードの「swarm は良くなっているか」
    // パネル: リードタイム＋差し戻し / コンフリクト / worker 成功率。
    'projectPanel.swarm.manager.kpiHeading': 'メトリクス',
    'projectPanel.swarm.manager.kpiLeadTime': 'リードタイム',
    'projectPanel.swarm.manager.kpiLeadTimeHint': 'todo→done 中央値 ・ 完了 {count} 件',
    'projectPanel.swarm.manager.kpiWorkerSuccess': 'worker 成功率',
    'projectPanel.swarm.manager.kpiReworkRate': '差し戻し率',
    'projectPanel.swarm.manager.kpiConflictRate': 'コンフリクト率',
    'projectPanel.swarm.manager.kpiEmpty': 'まだ完了タスクがありません — エンジン稼働とともに集計されます。',
    // 消費（バジェットレイヤ）— 無人ループの稼働負荷＋セッション消費＋上限。上の
    // KPI メトリクスとは別セクション。
    'projectPanel.swarm.manager.consumptionHeading': '消費',
    'projectPanel.swarm.manager.consumptionActive': '稼働 worker',
    'projectPanel.swarm.manager.consumptionRunTime': '実行中の合計時間',
    'projectPanel.swarm.manager.consumptionDispatched': '累計起動 ・ セッション',
    'projectPanel.swarm.manager.consumptionDispatchedHint': 'エンジン起動以降に spawn した worker 数',
    'projectPanel.swarm.manager.consumptionOverLimit':
      '上限超過 — ループはこのセッションで {dispatched} / {limit} 件の worker を起動しました。確認してください。',
    // マネージャーの動き(検品の現在地)— worker 完了後の「静かな数分」の説明: 仕上がった
    // 作業はマネージャーの検品を通ってから本番に反映される。心拍ファイル(manager.json)を
    // orchestrator poll 経由で表示。オーナー向け平易文(2026-07-17 規約): 生活言語で。
    'projectPanel.swarm.manager.presenceHeading': '検品',
    'projectPanel.swarm.manager.presenceActive': 'マネージャーが動いています',
    'projectPanel.swarm.manager.presenceActiveHint':
      '仕上がった作業を検品して、本番のコードに反映しています。1件あたり数分かかるのが普通です。',
    'projectPanel.swarm.manager.presenceStandby': 'マネージャーは休んでいます',
    'projectPanel.swarm.manager.presenceStandbyHint':
      '次に worker の作業が仕上がると自動で起きます — 何もしなくて大丈夫です。',
    'projectPanel.swarm.manager.presenceQueue': '検品待ち: {count} 件',
    'projectPanel.swarm.manager.presenceQueueHint':
      '仕上がった作業は、マネージャーの検品を通ってから本番に反映されます。',
    'projectPanel.swarm.manager.presenceLastBeat': '最終報告 {ago}前',
    'projectPanel.swarm.manager.conversationTitle': 'マネージャーと対話する',
    'projectPanel.swarm.manager.conversationEmpty':
      'このプロジェクトで /manage を実行する `claude` マネージャーを起動します。状況確認・完了ブランチの統合（早送り/rebase のみ）・掃除・相談を頼めます。primary checkout で動き（worktree なし）、上の自律エンジンと並行して働きます。',
    'projectPanel.swarm.manager.launch': 'マネージャーを起動',
    'projectPanel.swarm.manager.launching': '起動中…',
    'projectPanel.swarm.manager.launchFailed': 'マネージャーを起動できませんでした: {error}',
    'projectPanel.swarm.manager.stop': '停止',
    'projectPanel.swarm.manager.stopping': '停止中…',
    'projectPanel.swarm.manager.stopWorkerHint': 'この worker を停止 — worktree と `claude` を片付け、カードを判断待ちに戻します。',
    'projectPanel.swarm.manager.conversationIdentity': 'マネージャー · /manage',
    'projectPanel.swarm.manager.conversationHint':
      'マネージャーは worker を監視し、完了ブランチを統合します。ここで対話してください。',
    'projectPanel.swarm.manager.backToCommander': 'マネージャーに戻る',
    // 監督タブ — swarm からあなたへのメッセージが集まる場所: エスカレーション
    // 受信箱（下の esc.*）＋要注意フィード（致命イベント＋エンジン anomaly —
    // 削除した Flow タブから移設）。開いた時に読む — 他のサブビューには
    // 覆い被せず、タブバッジが未回答数を運ぶ。anomaly ラベルは上の
    // manager.* キーを再利用。
    'projectPanel.swarm.overseer.tab': '監督',
    'projectPanel.swarm.overseer.alertsHeading': '要注意',
    'projectPanel.swarm.overseer.emptyTitle': 'いま対応が要るものはありません',
    'projectPanel.swarm.overseer.emptyBody':
      'swarm があなたに上げた質問と致命イベントがここに届きます。稼働中の監督（あなたの代理）はマネージャータブの「監督」スイッチでオンにします。',
    'projectPanel.swarm.overseer.ago': '{age} 前',
    'projectPanel.swarm.overseer.anomalyReworkExhausted': 'リトライ上限超過 — 判断待ちに退避',
    'projectPanel.swarm.overseer.anomalyNoHeartbeat': '稼働中なのに心拍ゼロ — worker 規律違反の疑い',
    'projectPanel.swarm.overseer.anomalyReviewPanelFailed': 'レビューパネル決着せず — 統合保留・人間の確認待ち',
    'projectPanel.swarm.overseer.anomalyHighRiskHold': '高リスクパスに接触 — 自動統合を保留・手動マージ待ち',
    // 致命イベントのラベル — 安全弁（カード 6fe48c1f）が永続化する
    // エスカレーションイベント。エンジン由来のものと、Electron 自己更新
    // サイクル由来の2つ。サーバの detail（日本語）は副行に出し、ここでは何が起きたかを
    // UI 言語で示す。
    'projectPanel.swarm.overseer.fatalReworkExhausted': 'カード退避 · 差し戻し上限',
    'projectPanel.swarm.overseer.fatalAllWorkersDown': '全ワーカー停止',
    'projectPanel.swarm.overseer.fatalExecTimeout': 'ワーカーが時間上限に到達',
    'projectPanel.swarm.overseer.fatalRollback': '自己更新をロールバック',
    'projectPanel.swarm.overseer.fatalCanaryFailed': '自己更新カナリア失敗',
    'projectPanel.swarm.overseer.fatalReviewPanelFailed': 'レビューパネル不成立 · 統合保留',
    'projectPanel.swarm.overseer.fatalHighRiskHold': '高リスクパス · 手動マージ待ち',
    // エスカレーション受信箱（C1）— swarm があなたに上げた質問の回答待ち。
    // fail-closed: あなたが決めるまで何も先に進まない。
    'projectPanel.swarm.esc.title': 'エスカレーション — あなたの回答待ち',
    'projectPanel.swarm.esc.whyIrreversible': '不可逆',
    'projectPanel.swarm.esc.whyInsufficientInfo': '情報不足',
    // 「ポリシー」は非エンジニアのオーナーには何のことか伝わらない。この why が付くのは
    // 「あなたの領域だから、あなたが決める」ケース(ESCALATE OWNER のルーティング判定と
    // 恒久境界)なので、分類名ではなく“何を求められているか”を出す。
    'projectPanel.swarm.esc.whyPolicy': 'あなたが決めること',
    'projectPanel.swarm.esc.proxyDraft': 'proxy の暫定回答 · 確信度 {confidence}',
    'projectPanel.swarm.esc.abstention': 'proxy は回答を保留しました（あなたの情報が不足）。',
    'projectPanel.swarm.esc.useDraft': '暫定回答を使う',
    'projectPanel.swarm.esc.techDetails': '技術的な詳細',
    'projectPanel.swarm.esc.screenshot': 'その時の worker 画面',
    'projectPanel.swarm.esc.answerPlaceholder': '回答を入力…',
    'projectPanel.swarm.esc.answerSend': '回答して再開',
    'projectPanel.swarm.esc.dismiss': '見送る',
    'projectPanel.swarm.esc.deliveryInjected': '回答を実行中の worker に注入しました — 作業が再開します。',
    'projectPanel.swarm.esc.deliveryQueued': 'worker 不在 — 回答は記録済み。swarm 稼働中なら同じカードの次回 dispatch に同梱されます。',
    'projectPanel.swarm.esc.deliverySkipped': '記録しました（配達先の worker/カードなし）。',
    'projectPanel.swarm.esc.memoryWritten': '記憶に追記しました（you-corpus）。',
    'projectPanel.swarm.esc.actionFailed': 'エスカレーション操作に失敗: {error}',
    // Sidebar resizer
    // Chat header
    // Delete confirm
    'projectPanel.deleteProjectLabel': 'プロジェクトを削除',
    'projectPanel.moveToTrashQuestion': '「{name}」をゴミ箱に移動しますか？',
    'projectPanel.deleteExplain': 'プロジェクトフォルダ全体が macOS のゴミ箱に移動し、OPEN GROUND から削除されます。ただし Finder のゴミ箱から復元できます。（フォルダはそのままに Ground から外すだけなら「Ground から外す」を使ってください。）',
    'projectPanel.typeToConfirmBefore': '確認のため',
    'projectPanel.typeToConfirmAfter': 'と入力してください',
    'projectPanel.deleteFailed': '削除に失敗しました: {error} — フォルダは残っています。もう一度試すか、Finder でゴミ箱に移動してください。',
    'projectPanel.deleting': '削除中…',
    // Tabs
    'projectPanel.dragToReorder': 'ドラッグで並べ替え · Alt+←/→ で移動',
    // More menu
    'projectPanel.moreActions': 'その他の操作',
    'projectPanel.revealInFinder': 'Finderで開く',
    'projectPanel.revealInExplorer': 'エクスプローラーで表示',
    'projectPanel.revealFolder': 'フォルダを開く',
    // Open in editor (header icon button + chooser dropdown)
    'projectPanel.openInEditor': 'エディタで開く',
    'projectPanel.openInEditorWith': '{name} で開く',
    'projectPanel.chooseEditor': 'エディタを選択',
    'projectPanel.editorNoneFound': 'エディタが見つかりません',
    'projectPanel.editorSetDefault': 'デフォルトにする',
    'projectPanel.editorClearDefault': 'デフォルトを解除',
    'projectPanel.editorPickOther': '別のアプリを選ぶ…',
    'projectPanel.editorOpenFailed': 'エディタを開けませんでした: {error}',
    // Branch changes (header chip + modal)
    'projectPanel.branchChipTitle': 'ブランチの変更を表示',
    'projectPanel.branchMenuTitle': 'アクティブなブランチ',
    'projectPanel.branchMenuCurrent': '現在',
    'projectPanel.branchMenuEmpty': 'ブランチがありません',
    'projectPanel.branchChangesTitle': 'ブランチの変更',
    'projectPanel.branchAheadBehind': '{ahead} 先行 · {behind} 遅れ',
    'projectPanel.branchWorkingHeading': '作業ツリーの変更',
    'projectPanel.branchCommittedHeading': '{target} からの変更',
    'projectPanel.branchNoTarget': '比較先のブランチがありません（main / master が見つかりません）。',
    'projectPanel.branchSameAsTarget': 'これはターゲットブランチです — 作業ツリーの変更のみ表示します。',
    'projectPanel.branchNoChanges': '変更はありません',
    'projectPanel.branchLoadFailed': 'ブランチの変更を取得できませんでした: {error}',
    'projectPanel.skillsButton': 'スキル',
    'projectPanel.skillsButtonHint': 'このプロジェクトの Claude スキル（.claude/skills）を一覧',
    'projectPanel.skillsModalTitle': 'スキル',
    'projectPanel.skillsSectionGlobal': 'あなたのグローバルスキル',
    'projectPanel.skillsEmptyProject': 'このプロジェクトにスキルはまだありません。',
    'projectPanel.skillsEmptyGlobal': 'グローバルスキルはまだありません — 下から作成できます。',
    'projectPanel.skillsLoadFailed': 'スキルを取得できませんでした: {error}',
    'projectPanel.skillsPanelTitle': 'あなたのスキル',
    'projectPanel.skillsPanelSubtitle': '~/.claude/skills · どのプロジェクトでも使えます',
    'projectPanel.skillsCreateLabel': '新しいスキルを作る',
    'projectPanel.skillsCreatePlaceholder': '作りたいスキルを説明（例：画像フォルダから PDF レポートを生成するスキル）',
    'projectPanel.skillsCreateHint': 'Claude が ~/.claude/skills に書き込みます。',
    'projectPanel.skillsCreating': '作成中… 1分ほどかかることがあります',
    'projectPanel.skillsCreateButton': 'スキルを作成',
    'projectPanel.skillsCreateFailed': '作成に失敗しました: {error}',
    'projectPanel.skillsClaudeMissing': 'claude CLI が見つかりません — スキル作成にはインストール／ログインが必要です。',
    'projectPanel.branchDiffFailed': '差分を取得できませんでした: {error}',
    'projectPanel.branchDiffEmpty': '表示できる差分はありません。',
    'projectPanel.branchDiffTruncated': '差分が大きいため以降は省略されました。',
    'projectPanel.removeFromCanvas': 'Ground から外す',
    'projectPanel.deleteProjectMenu': 'プロジェクトを削除…',
    // Project settings dialog (shared policy + personal launch prefs)
    'projectPanel.projectSettingsMenu': 'プロジェクト設定…',
    'projectPanel.settingsDialogLabel': 'プロジェクト設定',
    'projectPanel.settingsBack': '戻る',
    // セクション構成は共有/git 状態で変わる（docs/SHARE_UX_FLOWS.md）:
    // ソロ利用者には共有の語彙を一切見せない。
    'projectPanel.settingsWorkflowHeading': 'タスクのワークフロー',
    'projectPanel.settingsWorkflowHint': 'このプロジェクトのタスク完了時に claude が何をするかの設定です。',
    'projectPanel.settingsDisplayName': 'あなたの表示名',
    'projectPanel.settingsDisplayNameHint': 'カードの担当者名として使われます — 全プロジェクト共通のグローバル設定です。',
    'projectPanel.settingsDisplayNameSaveFailed': '表示名を保存できませんでした: {error} — もう一度入力すると再試行されます。',
    'projectPanel.settingsPersonalHeading': '自分だけの設定',
    'projectPanel.settingsPersonalHint': 'この端末にだけ保存され、同期されません。',
    'projectPanel.settingsCompletionFlow': '完了フロー',
    'projectPanel.settingsFlowMerge': '直接マージ',
    'projectPanel.settingsFlowPr': 'PRを作成',
    'projectPanel.reviewWaitingTitle': 'レビュー待ちのカード',
    'projectPanel.settingsGhMissing': 'GitHub CLI (gh) が見つかりません — PR 作成は失敗します。インストール（brew install gh）して gh auth login を実行してください。',
    'projectPanel.settingsGhUnauthenticated': 'gh は未サインインです — PR で完了する前に gh auth login を実行してください。',
    'projectPanel.settingsFlowMergeHint':
      '完了したタスクブランチを claude がターゲットブランチへ直接マージします。',
    'projectPanel.settingsFlowPrHint':
      'claude がブランチを push して PR を作成 — 人間がレビューしてマージします。レビュー列が有効ならカードは自動でレビュー列へ移動します。',
    'projectPanel.settingsTargetBranch': 'ターゲットブランチ',
    'projectPanel.settingsTargetBranchPlaceholder': '起動時のブランチ',
    'projectPanel.settingsBranchDefault': '起動時のブランチ（既定）',
    'projectPanel.settingsMembers': 'メンバー',
    // 非共有 git プロジェクト用 — 共有語彙を使わない同じ名簿（S033/S034）。
    'projectPanel.settingsAssigneeNames': '担当者の名簿',
    'projectPanel.settingsAssigneeNamesHint': 'カードの担当者としてワンクリックで選べる名前の一覧です。',
    'projectPanel.settingsMemberAddPlaceholder': '名前を追加…',
    'projectPanel.settingsMemberAdd': '追加',
    'projectPanel.settingsMemberRemove': '{name} を削除',
    // 権限モードのラベル — ボードの「実行デフォルト」ストリップが使用
    // （ダイアログ側のプロファイル行は 2026-06-12 にそちらへ移設）。
    'projectPanel.settingsPermDefault': '標準（操作ごとに確認）',
    'projectPanel.settingsPermAcceptEdits': '編集を自動で許可',
    'projectPanel.settingsPermPlan': 'プランモード',
    'projectPanel.settingsPermBypass': 'Bypass — 全自動・確認なし',
    'projectPanel.settingsLaunchMovedHint':
      '起動プロファイル（モデル · effort · 権限 · 完了フロー）はボード上部の「実行デフォルト」で編集できます。',
    // Worktrees cleanup (B012/F082)
    'projectPanel.settingsWorktrees': 'Worktree',
    'projectPanel.settingsWorktreesLoading': '確認中…',
    'projectPanel.settingsWorktreesNone': 'なし',
    'projectPanel.settingsWorktreesCount': '{count} 件 · うち未コミットの変更あり {dirty} 件',
    'projectPanel.settingsWorktreesUnavailable': 'worktree を確認できませんでした。',
    'projectPanel.settingsWorktreesClean': '使われていない worktree を掃除',
    'projectPanel.settingsWorktreesCleaning': '掃除中…',
    'projectPanel.settingsWorktreesResult': '削除 {removed} 件 · スキップ {skipped} 件（未コミットの変更あり）',
    'projectPanel.settingsWorktreesFailed': 'worktree の掃除に失敗しました: {error}',
    'projectPanel.settingsWorktreesHint':
      '~/.openground 配下に溜まったタスク／レビュー用チェックアウトです。掃除で消えるのは未コミットの変更がないものだけ — 作業中のものは残ります。',
    'projectPanel.inviteCopy': 'コピー',
    'projectPanel.inviteCopied': 'コピーしました',
    'projectPanel.inviteDone': '完了',
    // リアルタイム共同編集 — 招待（リンクベースの自己参加）。既定はOFF。
    'projectPanel.collabEntry': '招待',
    'projectPanel.collabEntryTitle': '共同編集に招待（リアルタイム）',
    'projectPanel.collabLabel': 'リアルタイム共同編集',
    'projectPanel.collabTitle': '「{name}」に招待',
    'projectPanel.collabExplain': '共同編集者はこのプロジェクトの Board と Canvas をあなたとリアルタイムで編集します。Claude は各自のサブスクリプションで動かします（場は共有・作業は各自）。',
    'projectPanel.collabSharedName': '共有名',
    'projectPanel.collabSharedNameHint': '共同編集者に表示される名前です。あなたのローカルのフォルダパスは非公開のままです。',
    'projectPanel.collabSharedNameRequired': '先に共有名を入力してください',
    'projectPanel.collabCreateLink': '招待リンクを作成',
    'projectPanel.collabCreating': '作成中…',
    'projectPanel.collabCodeLabel': '招待コード',
    'projectPanel.collabExpires': '7日で失効します。OPEN GROUND にサインイン済みでこのコードを持つ人はエディターとして参加できます。',
    'projectPanel.collabAfterNote': 'このコードを共同編集者に渡してください。相手は自分の OPEN GROUND から参加します。',
    'projectPanel.collabCreateFailed': '招待リンクを作成できませんでした。接続とサインイン状態を確認して、もう一度お試しください。',
    'projectPanel.collabNewLink': '新しいリンク',
    'projectPanel.collabRevoke': 'すべてのリンクを失効',
    'projectPanel.collabRevoking': '失効中…',
    'projectPanel.collabRevoked': 'すべての招待リンクを失効しました。',
    'projectPanel.collabRevokeHint': '発行済みのリンクを失効します（例: メンバー削除後）。',
    'projectPanel.collabRevokeFailed': 'リンクを失効できませんでした。もう一度お試しください。',
    // 共同編集者一覧（オーナー）: 一覧＋メール招待＋削除。
    'projectPanel.collabMembersLabel': '共同編集者',
    'projectPanel.collabNoMembers': 'まだ共同編集者はいません — メールで招待するかリンクを共有してください。',
    'projectPanel.collabMemberNoEmail': '(メールなし)',
    'projectPanel.collabMemberOwner': 'オーナー',
    'projectPanel.collabMemberRole': 'メンバー',
    // 招待をまだ承認していない非オーナー（承認するまでアクセス権なし）。
    'projectPanel.collabMemberPending': '招待中',
    'projectPanel.collabMemberRemove': '削除',
    'projectPanel.collabMemberRemoveFailed': '共同編集者を削除できませんでした。もう一度お試しください。',
    'projectPanel.collabInviteCancel': '招待を取消',
    'projectPanel.collabInviteCancelFailed': '招待を取り消せませんでした。もう一度お試しください。',
    'projectPanel.collabInviteEmailPlaceholder': 'name@example.com',
    'projectPanel.collabInviteEmailBtn': '招待',
    'projectPanel.collabInviteEmailBusy': '招待中…',
    'projectPanel.collabInviteEmailFailed': '招待できませんでした。メールアドレスを確認してください。',
    // メール招待を「安全な推奨経路」として提示 — 誰を入れるか事前に確定。
    'projectPanel.collabInviteEmailLabel': 'メールで招待',
    'projectPanel.collabInviteRecommended': 'おすすめ',
    'projectPanel.collabInviteEmailExplain':
      'この人だけが参加できます（誰を入れるかを事前に確定）。相手には OPEN GROUND 内にお知らせが届き、承認すると参加できます。リンクより安全です。',
    // クイック共有リンクは手早い・ゆるめの代替手段。
    'projectPanel.collabQuickShareLabel': 'クイック共有リンク',
    'projectPanel.collabQuickShareExplain':
      'リンクを知っていてサインインした人なら誰でも参加できます。手早い共有に便利ですが、誰が入るかは事前に確定できません。',
    // 共有プロジェクト（メンバー）ビュー — 参加したフォルダ無しプロジェクトを開く。
    'projectPanel.collabSharedBadge': '共有',
    'projectPanel.collabSharedLive': 'ライブ',
    'projectPanel.collabSharedConnecting': '共有プロジェクトに接続中…',
    'projectPanel.collabSharedUnavailable': 'この共有プロジェクトは利用できません — 共有解除されたか、あなたのアクセスが削除された可能性があります。',
    'projectPanel.collabSharedClaudeTitle': 'Claude は各自のマシンで動きます',
    'projectPanel.collabSharedClaudeBody': '共有ワークスペースです — Board はリアルタイムで同期しますが、Claude は各自のローカルチェックアウトで自分のサブスクリプションで動きます。タスクで Claude を動かすには、このプロジェクトのリポジトリをローカルで開いてください。',
    'projectPanel.collabSharedCachedBanner': '接続中 — 最後に保存したコピーを表示中（読み取り専用）',
    'projectPanel.collabLinkFolder': 'ローカルフォルダを紐づける',
    'projectPanel.collabLinkFolderHint':
      'このコンピュータ上のフォルダ（このプロジェクトのあなた自身のクローン）を紐づけると、Terminal が開いて Claude を動かせます。Board と Canvas は引き続きリアルタイムで同期します。オーナーのコードがあなたに送られることはありません。',
    'projectPanel.collabLinkFailed': 'フォルダを紐づけられませんでした',
    'projectPanel.collabLinkAlreadyLinked':
      'この共有プロジェクトはすでに別のフォルダに紐づけられています。',
    'projectPanel.collabLinkDuplicate': 'そのフォルダはすでに別のプロジェクトとして登録されています。',
    'projectPanel.collabLinkOverlap':
      'そのフォルダは既存のプロジェクトと重なっています — 別のフォルダを選んでください。',
    'projectPanel.collabLinkBadTarget':
      '通常のプロジェクトフォルダを選んでください（ホームフォルダやディスクのルートは不可）。',
    'projectPanel.collabCanvasBack': 'すべての Canvas',
    'projectPanel.collabCanvasEmpty': 'このプロジェクトにはまだ Canvas がありません。',
    // 「共有プロジェクト」ダイアログ（メンバーの入口 — コードで参加＋開く）。
    'projectPanel.collabSharedDialogTitle': '共有プロジェクト',
    'projectPanel.collabSharedDialogJoinLabel': 'コードまたはリンクで参加',
    'projectPanel.collabSharedDialogJoinPlaceholder': '招待コードまたはリンクを貼り付け',
    'projectPanel.collabSharedDialogJoin': '参加',
    'projectPanel.collabSharedDialogJoining': '参加中…',
    'projectPanel.collabSharedDialogJoinFailed': '参加できませんでした — コードまたはリンク（無効か失効の可能性）とサインイン状態を確認してください。',
    'projectPanel.collabSharedDialogErrorInvalid': '招待が無効か期限切れです。オーナーに新しい招待リンクを発行してもらってください。',
    'projectPanel.collabSharedDialogErrorSignedOut': 'まずサインイン（Google または GitHub）してから招待を貼り付けて参加してください。',
    'projectPanel.collabSharedDialogListLabel': '参加中の共有プロジェクト',
    'projectPanel.collabSharedDialogEmpty': 'まだ共有プロジェクトはありません。上に招待コードを貼って参加してください。',
    'projectPanel.collabSharedDialogUntitled': '名称未設定の共有プロジェクト',
    'projectPanel.collabSharedDialogAwaiting': 'リクエストを送信しました — 承認待ちです',
    'projectPanel.collabSharedDialogAwaitingBody': 'このプロジェクトはオーナーが新しい共同編集者を承認します。承認されると開けるようになります。',
    // Ground 共有カード — あなたに共有された（owned:false）プロジェクト。Ground
    // キャンバスで自分のカードと並べて表示（collab 有効時のみ）。
    'projectPanel.groundSharedBadge': '共有',
    'projectPanel.groundSharedTitle': 'あなたに共有されたプロジェクト',
    // 招待リンク v2 — 権限モード + 上限の選択（オーナー・作成前）。
    'projectPanel.collabModeLabel': '参加できる人',
    'projectPanel.collabModeOpen': 'リンクを知っている人は誰でも',
    'projectPanel.collabModeApproval': 'リクエストを個別に承認',
    'projectPanel.collabModeOpenHint': 'サインインしてリンクを開くとすぐに参加します。',
    'projectPanel.collabModeApprovalHint': 'リンクを開くと参加申請になります — 下で個別に承認します。',
    'projectPanel.collabSingleUse': '使い切り（リンクは1回のみ有効）',
    'projectPanel.collabMemberCapField': '共同編集者の上限',
    'projectPanel.collabMemberCapPlaceholder': '上限なし',
    // 招待リンク v2 — 発行済みリンク一覧 + 個別失効 + リセット。
    'projectPanel.collabLinksLabel': '発行中の招待リンク',
    'projectPanel.collabLinkModeOpen': 'オープン',
    'projectPanel.collabLinkModeApproval': '承認制',
    'projectPanel.collabLinkUsesUnlimited': '{used}人が参加',
    'projectPanel.collabLinkUsesCapped': '{used}/{max} 使用',
    'projectPanel.collabLinkRevoke': 'このリンクを失効',
    'projectPanel.collabResetLink': 'リンクをリセット',
    'projectPanel.collabResetting': 'リセット中…',
    'projectPanel.collabResetFailed': 'リンクをリセットできませんでした。もう一度お試しください。',
    'projectPanel.collabMemberCapCurrent': '上限: 共同編集者 {cap} 人',
    // 招待リンク v2 — 承認キュー（オーナー）。
    'projectPanel.collabRequestsLabel': '参加リクエスト',
    'projectPanel.collabApprove': '承認',
    'projectPanel.collabApproving': '承認中…',
    'projectPanel.collabDeny': '却下',
    'projectPanel.collabRequestFailed': 'リクエストを更新できませんでした。もう一度お試しください。',
    // Copy button
    // Conflict resolution
    // RoundView labels
    // PastRunFallback
    // TaskThread composer
    'projectPanel.deleteTask': 'タスクを削除',
    // TaskThread inline
    // TasksSection
    // Terminal split view
    'projectPanel.closeTerminal': 'ターミナルを閉じる',
    'projectPanel.newTerminal': '新しいターミナル',
    'projectPanel.new': '新規',
    'projectPanel.renameTerminal': 'ダブルクリックで名前を変更',
    'projectPanel.launchClaude': 'Claude を起動',
    'projectPanel.launchingClaude': '起動中…',
    // The single "sign in to Claude" terminal (opened from a run that hit
    // claudeLoggedOut). One claude PTY the user authenticates in.
    'projectPanel.claudeLogin.title': 'Claude にサインイン',
    'projectPanel.claudeLogin.hint':
      'このターミナルでサインインを完了してください（ブラウザが 1 回開きます）。完了したら閉じて、もう一度実行してください。',
    'projectPanel.claudeLogin.starting': 'サインイン用の Claude ターミナルを開いています…',
    'projectPanel.claudeLogin.retry': 'もう一度試す',
    // Embedded claude terminal + terminal dock (Canvas / Board sidebar)
    'projectPanel.embTermHint':
      'このプロジェクトで claude を起動します。応答や権限確認はこのターミナルで操作します。',
    'projectPanel.dockTitle': 'ターミナル',
    'projectPanel.dockOpen': '{title}を開く',
    'projectPanel.dockCloseTab': 'このターミナルを閉じる',
    'projectPanel.dockAddTab': 'ターミナルを追加',
    'projectPanel.dockClose': 'ドックを閉じる',
    'projectPanel.canvasDockHint':
      'このプロジェクトで claude を起動して Canvas のデザイン作業を進めます（ファイル編集・確認はこのターミナルで操作）。',
    'projectPanel.boardDockHint':
      'このプロジェクトで claude を起動します（ファイル編集・確認はこのターミナルで操作）。',
    // Notes
    // CompactTaskRow
    // NewTaskComposer
    // EditableTaskTitle
    // EditableTitle
    'projectPanel.doubleClickToRename': 'ダブルクリックで名前を変更',
    'projectPanel.clickToRenameProject': 'クリックでプロジェクト名を変更',
    // Running roster — live claude lanes for the project.
  } as Record<string, string>,
}

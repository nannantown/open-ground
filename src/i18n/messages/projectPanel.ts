// Owned by the ProjectPanel translation track. Add keys as 'projectPanel.*'.
// English is the source of truth; keep `en` and `ja` key sets identical.
export const projectPanel = {
  en: {
    // Header
    'projectPanel.backToGround': 'Back to Ground',
    'projectPanel.projectDetails': 'Project details',
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
    // The Swarm bottom bar (2026-09-24 — replaced the Swarm tab).
    'projectPanel.swarm.bar.expand': 'Open Swarm',
    'projectPanel.swarm.bar.collapse': 'Fold Swarm away',
    'projectPanel.swarm.bar.resize': 'Drag to change the height of Swarm',
    // "Questions", not "waiting on you": the Board's blocked column is called
    // "Needs decision"/「判断待ち」 and counts something else — one word must
    // never name two different numbers on the same screen.
    'projectPanel.swarm.bar.questions': '{count} questions for you',
    'projectPanel.swarm.bar.reviews': '{count} awaiting integration',
    // A pane past the stream budget (a layout saved under the old cap of 6).
    'projectPanel.terminalOverBudget':
      'This pane is paused to keep the app responsive — too many live views are open. Its shell keeps running; close another pane to see it again.',
    'projectPanel.swarm.bar.streamLimit':
      'Too many live views are open at once, so some Swarm seats show a summary. Close a terminal pane or switch tabs to see them live.',
    'projectPanel.swarm.bar.questionsHint': 'Open the bar and tell the president your answers.',
    'projectPanel.swarm.bar.attention': 'There is a notice inside — open the bar to read it.',
    'projectPanel.swarm.power.hint':
      'Start the engine, manager, and supply officer together. Stop halts new dispatch only — running workers finish and their worktrees are kept.',
    // Restart reminder (autonomyRemembered) — autonomy is NEVER auto-resumed on
    // relaunch; if it was on last session the banner offers a one-click resume.
    'projectPanel.swarm.autonomyReminder':
      'Autonomy was on for this project last session. It relaunched OFF — nothing is running.',
    'projectPanel.swarm.autonomyReminder.resume': 'Resume',
    'projectPanel.swarm.autonomyReminder.dismiss': 'Dismiss',
    // Restored notice (autonomyResumed) — the OTHER half of the reminder above. A
    // restart now brings the drain back on its own, so the "resume?" prompt (gated on
    // !running) never fires for a restored project; without this line the restoration
    // would happen in silence. Shown only when the BOOT restored it — never after a
    // plain manual ON.
    'projectPanel.swarm.autonomyRestored':
      'Autonomy was on last session, so it started again automatically after the restart.',
    // Overseer restore banner (overseerRemembered, card 2b). The supervisor is the ONE
    // switch a restart never brings back — deliberately, because it does more than
    // watch. Plain language for a non-programmer owner: what it does when it is on, so
    // the owner presses the button KNOWING what they are turning back on.
    'projectPanel.swarm.overseerReminder':
      'The supervisor was on last session. After the restart it stays off until you turn it back on.',
    'projectPanel.swarm.overseerReminder.effects':
      'When on, the supervisor does more than send you messages: it starts up an AI on its own, steps in and gives instructions to work already in progress, and tidies up finished work.',
    'projectPanel.swarm.overseerReminder.needsAutonomy':
      'Turn autonomy on first, then you can bring the supervisor back.',
    'projectPanel.swarm.overseerReminder.restore': 'Turn it back on',
    // Its own label rather than a bare "Dismiss": this [×] can sit right under the
    // autonomy notice's [×], and two identically-named buttons in a row are
    // ambiguous to anyone navigating by screen reader.
    'projectPanel.swarm.overseerReminder.dismiss': 'Dismiss the supervisor notice',
    // Env preflight (git/shell) — GET /api/swarm/preflight (swarmEnvPreflight),
    // the same gate the worker/supply/manager spawn routes enforce. Shown as ONE
    // banner listing every unmet prerequisite; ids mirror SwarmEnvIssueId. Plain
    // language for a non-programmer owner (完了条件5): what's missing, how it
    // gets fixed (never a command for the owner to type), what becomes possible
    // once it is.
    'projectPanel.swarm.envPreflight.title':
      "This project can't start AI workers yet:",
    'projectPanel.swarm.envPreflight.gitMissing':
      "A tool called git, which workers need to make their own private working copy of this project, isn't installed on this computer. Ask someone technical to install it for you — once it's done, workers will be able to start here.",
    'projectPanel.swarm.envPreflight.notAGitRepo':
      "This project folder hasn't been set up to track changes (with a tool called git), which workers need in order to make their own private working copy to work in. Ask someone technical to set that up for this folder — once it's done, workers will be able to start here.",
    'projectPanel.swarm.envPreflight.shellMissing':
      "Something this computer needs to open a working session couldn't be found — this points to a problem with the computer itself, not this project. Ask someone technical to look into it — once it's fixed, workers, the task desk, and the commander will all be able to start.",
    // Footnote: which parts of swarm still work despite the issue(s) above —
    // without this, the title alone ("can't start AI workers yet") reads as
    // "nothing here works", when the task desk (and often the commander) are
    // unaffected. See envBannerFootnoteKey in SwarmModule.tsx for which applies.
    'projectPanel.swarm.envPreflight.footnoteSupplyOnly':
      'The task desk still works, so you can keep filing work for later. Workers and the commander need this fixed first.',
    'projectPanel.swarm.envPreflight.footnoteSupplyAndManager':
      'The task desk and the commander still work. Only starting new AI workers needs this fixed first.',
    // One-click fix for the notAGitRepo issue above (POST /api/project/git-init):
    // OPEN GROUND runs the set-up itself — the owner presses a button instead of
    // asking someone technical. Done/Error keep the banner's plain, no-commands
    // register; the error may carry a raw git detail in parens after it (for
    // whoever technical does get asked).
    'projectPanel.swarm.preflight.gitInit': 'Set up git here',
    'projectPanel.swarm.preflight.gitInitDone':
      'Done — git is ready. Workers can run here now.',
    'projectPanel.swarm.preflight.gitInitError': "Couldn't set up git here.",
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
      "Each card's difficulty decides — Ultra cards get the top tier ({top}), Touch cards drop to {light}, the rest run in between. The smart default.",
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
    'projectPanel.swarm.onboarding.reopen': 'How it works',
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
    'projectPanel.swarm.workersEmpty': 'No workers yet — Start the swarm (or ask the manager) to dispatch one.',
    'projectPanel.swarm.statusWorking': 'Working',
    'projectPanel.swarm.statusWaiting': 'Waiting',
    'projectPanel.swarm.statusOfflineHold': 'Waiting for network',
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
    // Agent SDK worker tile (docs/SDK_WORKER_MIGRATION_PLAN.md). A worker running
    // on the SDK runtime has no terminal screen — the tile renders its distilled
    // event stream instead.
    'projectPanel.swarm.sdk.statusQuotaParked': 'Quota wait',
    // Question banner (2026-08-03): the worker asked the OWNER something and is
    // waiting. Shown in the pane the owner is actually looking at, with the
    // question text and where the answer box lives.
    'projectPanel.swarm.sdk.statusQuestion': 'Waiting for your answer',
    'projectPanel.swarm.sdk.jumpLatest': 'Latest',
    'projectPanel.swarm.sdk.questionBanner': 'This worker asked you a question',
    'projectPanel.swarm.sdk.questionBannerHint':
      'Tell the president your answer — in the President seat of the Swarm bar at the bottom of the screen. The worker resumes on your reply.',
    'projectPanel.swarm.sdk.statusFailed': 'Failed',
    'projectPanel.swarm.sdk.interrupt': 'Stop the current turn (the session stays open)',
    'projectPanel.swarm.sdk.send': 'Send',
    'projectPanel.swarm.sdk.placeholder': 'Say something to this worker…',
    'projectPanel.swarm.sdk.empty': 'Waiting for the first turn…',
    'projectPanel.swarm.sdk.thinking': 'thought',
    'projectPanel.swarm.sdk.rateLimit': 'Usage',
    'projectPanel.swarm.sdk.compact': 'History summarised to make room',
    'projectPanel.swarm.sdk.truncated':
      'Older lines were dropped — this transcript starts mid-conversation.',
    // Shown when a message (or a Stop) was REFUSED. It is not decoration: the
    // composer clears on Enter, so without this the owner watched their words
    // disappear into a session that never received them and had every reason
    // to believe they had arrived. {error} is the server's own sentence.
    'projectPanel.swarm.sdk.sendFailed': "Not delivered — {error}. Your text is back in the box.",
    // Supply officer (タスク窓口) — the conversation desk that turns the user's
    // requests into Board:todo cards. Writes the Board only; never edits code.
    'projectPanel.swarm.workersTab': 'Workers',
    'projectPanel.swarm.seat.worker': 'Worker',
    'projectPanel.swarm.seat.vacant': 'No one yet',
    'projectPanel.swarm.seat.openLog': 'Watch the work',
    'projectPanel.swarm.seat.closeLog': 'Close',
    // The question hint INSIDE the Swarm tab, where the president sits in the
    // seat on the left (the Board drawer keeps sdk.questionBannerHint).
    'projectPanel.swarm.seat.questionHint':
      'Tell the president your answer in the President seat on the left (if it is stopped, press “Call the president” first). The worker resumes on your reply.',
    'projectPanel.swarm.supply.tab': 'President',
    'projectPanel.swarm.supply.badge': 'President',
    'projectPanel.swarm.supply.empty':
      'Hears what you want, turns it into work, and reports progress and deliveries back to you.',
    'projectPanel.swarm.supply.launch': 'Call the president',
    'projectPanel.swarm.supply.launching': 'Starting…',
    'projectPanel.swarm.supply.launchFailed': "Couldn't start the president: {error}",
    'projectPanel.swarm.supply.hint':
      'The president hears your requests, files them as work, and tells you about progress, questions and finished work. The commander and workers stay behind the scenes.',
    'projectPanel.swarm.supply.stop': 'Stop',
    'projectPanel.swarm.supply.stopping': 'Stopping…',
    // Manager (マネージャー) seat — since 2026-09-23 a nameplate only (running /
    // stopped / not there + a quiet start/stop); the owner talks only to the
    // president. `overseer*` label the Monitoring switch on the top bar.
    'projectPanel.swarm.manager.tab': 'Manager',
    'projectPanel.swarm.manager.badge': 'Manager',
    'projectPanel.swarm.manager.overseer': 'Monitoring',
    'projectPanel.swarm.manager.overseerHint': 'Questions, stalled work and usage alerts. Off when stopped or restarted.',
    'projectPanel.swarm.manager.engineFailed': "Couldn't reach the engine: {error}",
    'projectPanel.swarm.manager.stageStarting': 'Starting',
    'projectPanel.swarm.manager.stageRunning': 'Running',
    'projectPanel.swarm.manager.stageDone': 'Done',
    'projectPanel.swarm.manager.reviewFf': 'Ready',
    'projectPanel.swarm.manager.reviewRebase': 'Needs rebase',
    'projectPanel.swarm.manager.reviewConflict': 'Conflict',
    'projectPanel.swarm.manager.reviewUnknown': 'Checking…',
    // Why each review card is (not) integrable — the tooltip on its status label.
    'projectPanel.swarm.manager.reviewFfHint': 'Fast-forwardable — ready to land on the trunk now.',
    'projectPanel.swarm.manager.reviewRebaseHint': 'Diverged from the trunk — needs a rebase (which may conflict).',
    'projectPanel.swarm.manager.reviewConflictHint': 'A rebase hit a conflict — needs manual integration.',
    'projectPanel.swarm.manager.reviewUnknownHint': 'Not judgeable yet (no remote trunk, or still checking).',
    'projectPanel.swarm.manager.launch': 'Start manager',
    'projectPanel.swarm.manager.launching': 'Starting…',
    'projectPanel.swarm.manager.launchFailed': "Couldn't start the manager: {error}",
    'projectPanel.swarm.manager.stop': 'Stop',
    'projectPanel.swarm.manager.stopping': 'Stopping…',
    'projectPanel.swarm.manager.conversationHint':
      "The manager hands the president's jobs to workers and integrates finished work. You don't need to talk to it.",
    'projectPanel.swarm.overLimit':
      'The swarm has started {dispatched} workers since the app opened (guide: {limit}). It keeps going — check it is doing what you want.',
    'projectPanel.swarm.manager.start': 'Start',
    'projectPanel.swarm.manager.stopFull': 'Stop manager',
    'projectPanel.swarm.manager.stateRunning': 'Running',
    'projectPanel.swarm.manager.stateStopped': 'Stopped',
    'projectPanel.swarm.manager.stateAbsent': 'Not started',
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
    // Context fuel gauge (per pane) + its manual escape hatch. Written for a
    // reader who has never used a terminal: no "context window", no "tokens".
    'projectPanel.contextGauge.label': 'Context',
    'projectPanel.contextGauge.readingWindow': '{pct}% of the room still free',
    'projectPanel.contextGauge.readingFootnote': '{pct}% left before it summarises itself',
    'projectPanel.contextGauge.readingNone': 'Nothing to read yet',
    'projectPanel.contextGauge.hintWindow':
      'How much room this conversation still has. Claude summarises on its own when it fills up — you do not have to do anything.',
    'projectPanel.contextGauge.hintFootnote':
      'Claude is about to summarise this conversation by itself. Nothing is thrown away — it keeps a summary and carries on.',
    'projectPanel.contextGauge.hintNone':
      'No Claude session in this pane yet, so there is nothing to measure.',
    'projectPanel.contextGauge.compact': 'Compact now',
    'projectPanel.contextGauge.compactHint': 'Summarise the conversation to free up room.',
    'projectPanel.contextGauge.focusLabel': 'What the summary should keep (optional)',
    'projectPanel.contextGauge.focusPlaceholder': 'e.g. keep the payment work',
    'projectPanel.contextGauge.clear': 'Clear and continue',
    'projectPanel.contextGauge.clearHint': 'Start a clean conversation in this same pane.',
    'projectPanel.contextGauge.fresh': 'New session',
    'projectPanel.contextGauge.freshHint': 'Restart Claude here from scratch.',
    'projectPanel.contextGauge.sending': 'Sending…',
    'projectPanel.contextGauge.outcome.ok': 'Done.',
    'projectPanel.contextGauge.outcome.busy':
      'Claude is working right now — try again once it stops.',
    'projectPanel.contextGauge.outcome.gone': 'This session has already ended.',
    'projectPanel.contextGauge.outcome.error': 'That did not go through. Please try again.',
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
    // Embedded claude terminal + terminal dock (custom tabs' module dock)
    'projectPanel.embTermHint':
      'Launch claude in this project — respond and approve permission prompts right in this terminal.',
    'projectPanel.dockTitle': 'Terminal',
    'projectPanel.dockOpen': 'Open {title}',
    'projectPanel.dockCloseTab': 'Close this terminal',
    'projectPanel.dockAddTab': 'Add terminal',
    'projectPanel.dockClose': 'Close dock',
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
    'projectPanel.projectDetails': 'プロジェクトの詳細',
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
    // Swarm の下部バー(2026-09-24 — Swarm タブの置き換え)。
    'projectPanel.swarm.bar.expand': 'Swarm をひらく',
    'projectPanel.swarm.bar.collapse': 'Swarm をたたむ',
    'projectPanel.swarm.bar.resize': 'ドラッグで Swarm の高さを変える',
    // 「判断待ち」は Board の blocked 列の見出しで別の数 — 同じ言葉で別の数を指さない。
    'projectPanel.swarm.bar.questions': 'あなたへの質問 {count}',
    'projectPanel.swarm.bar.reviews': '統合待ち {count}',
    'projectPanel.terminalOverBudget':
      'アプリが固まらないよう、このペインの表示を止めています(同時に開ける接続の上限)。中のシェルは動いたままです。ほかのペインを閉じると、また表示されます。',
    'projectPanel.swarm.bar.streamLimit':
      '同時に開ける接続の上限に近いため、一部の席は要約表示にしています。ターミナルを1枚閉じるか、別のタブに移ると表示されます。',
    'projectPanel.swarm.bar.questionsHint': 'バーをひらいて、社長に答えを伝えてください。',
    'projectPanel.swarm.bar.attention': '中にお知らせがあります — バーをひらいて確認してください。',
    'projectPanel.swarm.power.hint':
      'エンジン・マネージャー・タスク窓口をまとめて起動します。停止は新規の振り分けを止めるだけで、走行中の worker は完走し worktree も残ります。',
    // 再起動リマインダー（autonomyRemembered）— 再起動で自律は自動再開しない。前回 ON
    // だった場合だけ、ワンクリック再開のバナーを出す。
    'projectPanel.swarm.autonomyReminder':
      '前回このプロジェクトで自律ドレインが ON でした。再起動で OFF になっています（何も動いていません）。',
    'projectPanel.swarm.autonomyReminder.resume': '再開',
    'projectPanel.swarm.autonomyReminder.dismiss': '閉じる',
    // 復元のお知らせ(autonomyResumed)— 上のリマインダーのもう半分。再起動で自動運転が
    // ひとりでに戻るようになったため、!running を条件にした「再開しますか?」は復元された
    // プロジェクトでは出ない。この1行が無いと復元が黙って起きる。手動 ON では出さず、
    // 起動時に復元されたときだけ出す。
    'projectPanel.swarm.autonomyRestored':
      '前回このプロジェクトで自動運転が ON だったので、再起動のあと自動でまた動き出しています。',
    // 監督の復帰バナー(overseerRemembered・card 2b)。監督は再起動で戻さない唯一のスイッチ
    // ——「見ているだけ」ではないので意図的にそうしている。オーナー(非プログラマ)向けの
    // 平易文で「ONにすると何をするのか」を書き、理由を分かった上で押せるようにする。
    'projectPanel.swarm.overseerReminder':
      '前回は監督もオンでした。再起動のあとはオフのままなので、必要なら戻してください。',
    'projectPanel.swarm.overseerReminder.effects':
      '監督はオンのあいだ、お知らせを出すだけではありません。自分で AI を立ち上げ、すでに進んでいる作業に横から指示を入れ、終わった作業の後片付けもします。',
    'projectPanel.swarm.overseerReminder.needsAutonomy': '先に自動運転をオンにすると、監督を戻せます。',
    'projectPanel.swarm.overseerReminder.restore': '戻す',
    // 単なる「閉じる」にしないのは、autonomy の復元通知の [×] と縦に並びうるため。
    // 同名ボタンが連続すると読み上げでどちらか分からない。
    'projectPanel.swarm.overseerReminder.dismiss': '監督のお知らせを閉じる',
    // 環境の事前チェック(git/shell) — GET /api/swarm/preflight(swarmEnvPreflight)。
    // worker/supply/manager の起動ルートと同じ判定を、起動前に1枚のバナーで表示する。
    // 完了条件5: 非プログラマ向けの平易文(①何が足りないか ②どうすれば直るか(オー
    // ナーにコマンドは打たせない) ③直るとどうなるか)。
    'projectPanel.swarm.envPreflight.title': 'このプロジェクトでは、まだ AI ワーカーを起動できません:',
    'projectPanel.swarm.envPreflight.gitMissing':
      'ワーカーがこのプロジェクトの作業用コピーを自分専用に作るのに必要な「git」という道具が、このパソコンに入っていません。詳しい方にインストールをお願いしてください — 入れば、このプロジェクトでもワーカーが動かせるようになります。',
    'projectPanel.swarm.envPreflight.notAGitRepo':
      'このプロジェクトのフォルダは、ワーカーが作業用コピーを作るのに必要な「変更を記録する仕組み(git)」の準備がまだできていません。詳しい方にこのフォルダの設定をお願いしてください — 済めば、このプロジェクトでもワーカーが動かせるようになります。',
    'projectPanel.swarm.envPreflight.shellMissing':
      '作業を開始するためにこのパソコンに必要なものが見つかりませんでした — これはこのプロジェクトではなく、パソコン自体の問題です。詳しい方に調べてもらってください — 直れば、ワーカー・タスク受付・司令官のすべてが起動できるようになります。',
    // 補足: 上の問題があっても swarm のどの部分は使えるか(これが無いと「AI ワーカー
    // を起動できません」という見出しだけで「何もできない」と誤読される — タスク受付・
    // 司令官は多くの場合影響を受けない)。どの補足を出すかは SwarmModule.tsx の
    // envBannerFootnoteKey を参照。
    'projectPanel.swarm.envPreflight.footnoteSupplyOnly':
      'タスク受付は引き続き使えるので、あとで対応する作業を登録しておけます。ワーカーと司令官はこの問題が直ってから使えます。',
    'projectPanel.swarm.envPreflight.footnoteSupplyAndManager':
      'タスク受付と司令官は引き続き使えます。新しく AI ワーカーを起動することだけが、この問題が直るまでできません。',
    // 上の notAGitRepo をその場で直すワンクリック (POST /api/project/git-init)。
    // 「詳しい方にお願いして」ではなく OPEN GROUND 自身が準備する。Done/Error は
    // バナーと同じ平易文の調子(オーナーにコマンドは打たせない)。エラーには生の
    // git の詳細が括弧書きで続くことがある(結局相談された詳しい方のため)。
    'projectPanel.swarm.preflight.gitInit': 'このフォルダでgitを準備する',
    'projectPanel.swarm.preflight.gitInitDone':
      '完了 — gitの準備ができました。これでワーカーを走らせられます。',
    'projectPanel.swarm.preflight.gitInitError': 'gitの準備に失敗しました。',
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
      'カードの難易度で割当 — 「最難」は最上位({top})、「軽微」は {light}、その間は中間のモデル。賢い既定（推奨）。',
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
    'projectPanel.swarm.onboarding.reopen': '仕組みを見る',
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
    'projectPanel.swarm.workersEmpty': 'worker はまだいません — 開始（またはマネージャーに依頼）で配車されます。',
    'projectPanel.swarm.statusWorking': '稼働中',
    'projectPanel.swarm.statusWaiting': '待機中',
    'projectPanel.swarm.statusOfflineHold': 'オフライン待ち',
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
    // Agent SDK worker のタイル(docs/SDK_WORKER_MIGRATION_PLAN.md)。SDK ランタイムで
    // 動く worker には端末画面が無いので、蒸留したイベント列を表示する。
    'projectPanel.swarm.sdk.statusQuotaParked': '上限待ち',
    'projectPanel.swarm.sdk.statusQuestion': '回答待ち',
    'projectPanel.swarm.sdk.jumpLatest': '最新へ',
    'projectPanel.swarm.sdk.questionBanner': 'この作業者から質問が届いています',
    'projectPanel.swarm.sdk.questionBannerHint':
      '答えは社長に伝えてください(画面の一番下の Swarm のバーをひらいて「社長」の席へ)。答えると作業者はそのまま再開します。',
    'projectPanel.swarm.sdk.statusFailed': '失敗',
    'projectPanel.swarm.sdk.interrupt': '今のターンを止める(セッションは続きます)',
    'projectPanel.swarm.sdk.send': '送信',
    'projectPanel.swarm.sdk.placeholder': 'この worker に話しかける…',
    'projectPanel.swarm.sdk.empty': '最初のターンを待っています…',
    'projectPanel.swarm.sdk.thinking': '思考',
    'projectPanel.swarm.sdk.rateLimit': '使用量',
    'projectPanel.swarm.sdk.compact': 'これまでの記憶を要約して空きを作りました',
    'projectPanel.swarm.sdk.truncated':
      '古い行は破棄されました — この記録は会話の途中から始まっています。',
    // 送信（や停止）が拒否されたときに出す。飾りではない: 入力欄は Enter で空になるので、
    // これが無いと「届いていない言葉が消えた」だけになり、オーナーは届いたと信じてしまう。
    // {error} はサーバ自身の文言。
    'projectPanel.swarm.sdk.sendFailed': '届いていません — {error}。入力した文は欄に戻しました。',
    // Supply officer (タスク窓口) — 要望を Board:todo カードに積む対話デスク。
    // Board に書くだけで、コードは編集しない。
    'projectPanel.swarm.workersTab': 'ワーカー',
    'projectPanel.swarm.seat.worker': 'ワーカー',
    'projectPanel.swarm.seat.vacant': 'まだいません',
    'projectPanel.swarm.seat.openLog': '作業の様子を見る',
    'projectPanel.swarm.seat.closeLog': '閉じる',
    'projectPanel.swarm.seat.questionHint':
      '答えは左の「社長」の席で社長に伝えてください(社長が止まっていたら先に「社長を呼ぶ」)。答えるとこのワーカーはそのまま再開します。',
    'projectPanel.swarm.supply.tab': '社長',
    'projectPanel.swarm.supply.badge': '社長',
    'projectPanel.swarm.supply.empty':
      'あなたの要望をヒアリングして仕事にし、進み具合・質問・完成品を報告します。',
    'projectPanel.swarm.supply.launch': '社長を呼ぶ',
    'projectPanel.swarm.supply.launching': '起動中…',
    'projectPanel.swarm.supply.launchFailed': '社長を呼べませんでした: {error}',
    'projectPanel.swarm.supply.hint':
      '社長があなたの要望を聞いて仕事にし、進み具合・質問・完成品をあなたに伝えます。司令官やワーカーは裏で動きます。',
    'projectPanel.swarm.supply.stop': '停止',
    'projectPanel.swarm.supply.stopping': '停止中…',
    // マネージャーの席 — 2026-09-23 から名札だけ(動いている/止まっている/いない＋
    // 控えめな起動・停止)。オーナーが話すのは社長だけ。overseer* は上部バーの監視スイッチ。
    'projectPanel.swarm.manager.tab': 'マネージャー',
    'projectPanel.swarm.manager.badge': 'マネージャー',
    'projectPanel.swarm.manager.overseer': '状況の監視',
    'projectPanel.swarm.manager.overseerHint': '質問・作業の停滞・利用上限を通知。停止・再起動時はオフ。',
    'projectPanel.swarm.manager.engineFailed': 'エンジンに到達できませんでした: {error}',
    'projectPanel.swarm.manager.stageStarting': '起動中',
    'projectPanel.swarm.manager.stageRunning': '稼働中',
    'projectPanel.swarm.manager.stageDone': '完了',
    'projectPanel.swarm.manager.reviewFf': '統合可',
    'projectPanel.swarm.manager.reviewRebase': '要 rebase',
    'projectPanel.swarm.manager.reviewConflict': '要手動統合',
    'projectPanel.swarm.manager.reviewUnknown': '判定中',
    // 各 review カードがなぜ統合可（不可）か — ステータスラベルの tooltip。
    'projectPanel.swarm.manager.reviewFfHint': '早送り可能 — いま本流へ取り込めます。',
    'projectPanel.swarm.manager.reviewRebaseHint': '本流から分岐 — rebase が必要です（衝突する可能性あり）。',
    'projectPanel.swarm.manager.reviewConflictHint': 'rebase で衝突 — 手動統合が必要です。',
    'projectPanel.swarm.manager.reviewUnknownHint': 'まだ判定できません（リモート本流なし／確認中）。',
    'projectPanel.swarm.manager.launch': 'マネージャーを起動',
    'projectPanel.swarm.manager.launching': '起動中…',
    'projectPanel.swarm.manager.launchFailed': 'マネージャーを起動できませんでした: {error}',
    'projectPanel.swarm.manager.stop': '停止',
    'projectPanel.swarm.manager.stopping': '停止中…',
    'projectPanel.swarm.manager.conversationHint':
      'マネージャーは社長が受けた仕事を worker に割り振り、仕上がりを統合します。話しかける必要はありません。',
    'projectPanel.swarm.overLimit':
      'アプリを開いてから worker を {dispatched} 回動かしました（目安 {limit} 回）。止まらずに続いています —— 狙いどおりに動いているか確認してください。',
    'projectPanel.swarm.manager.start': '起動',
    'projectPanel.swarm.manager.stopFull': 'マネージャーを停止',
    'projectPanel.swarm.manager.stateRunning': '動いている',
    'projectPanel.swarm.manager.stateStopped': '止まっている',
    'projectPanel.swarm.manager.stateAbsent': 'いない',
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
    // コンテキスト燃料ゲージ(ペインごと)と手動の逃げ道。ターミナルを触ったことが
    // ない人が読む前提の文面 — 「コンテキストウィンドウ」「トークン」は使わない。
    'projectPanel.contextGauge.label': 'コンテキスト',
    'projectPanel.contextGauge.readingWindow': '空きは残り {pct}%',
    'projectPanel.contextGauge.readingFootnote': '自動で要約するまで残り {pct}%',
    'projectPanel.contextGauge.readingNone': 'まだ計測できていません',
    'projectPanel.contextGauge.hintWindow':
      'この会話にどれだけ余裕があるかです。いっぱいになると Claude が自分で要約するので、何もしなくて構いません。',
    'projectPanel.contextGauge.hintFootnote':
      'まもなく Claude が自分でこの会話を要約します。捨てられるわけではなく、要約を残して続きます。',
    'projectPanel.contextGauge.hintNone':
      'このペインにはまだ Claude のセッションがないので、測るものがありません。',
    'projectPanel.contextGauge.compact': '今すぐ圧縮',
    'projectPanel.contextGauge.compactHint': '会話を要約して空きを作ります。',
    'projectPanel.contextGauge.focusLabel': '要約に残したいこと(任意)',
    'projectPanel.contextGauge.focusPlaceholder': '例: 決済まわりの作業を残す',
    'projectPanel.contextGauge.clear': 'クリアして継続',
    'projectPanel.contextGauge.clearHint': '同じペインで、まっさらな会話を始めます。',
    'projectPanel.contextGauge.fresh': '新規セッション',
    'projectPanel.contextGauge.freshHint': 'このペインの Claude を起動し直します。',
    'projectPanel.contextGauge.sending': '送信中…',
    'projectPanel.contextGauge.outcome.ok': '完了しました。',
    'projectPanel.contextGauge.outcome.busy':
      'いま Claude が作業中です。止まってからもう一度押してください。',
    'projectPanel.contextGauge.outcome.gone': 'このセッションはすでに終了しています。',
    'projectPanel.contextGauge.outcome.error': 'うまくいきませんでした。もう一度お試しください。',
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
    // Embedded claude terminal + terminal dock (custom tabs' module dock)
    'projectPanel.embTermHint':
      'このプロジェクトで claude を起動します。応答や権限確認はこのターミナルで操作します。',
    'projectPanel.dockTitle': 'ターミナル',
    'projectPanel.dockOpen': '{title}を開く',
    'projectPanel.dockCloseTab': 'このターミナルを閉じる',
    'projectPanel.dockAddTab': 'ターミナルを追加',
    'projectPanel.dockClose': 'ドックを閉じる',
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

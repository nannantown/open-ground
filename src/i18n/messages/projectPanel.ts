// Owned by the ProjectPanel translation track. Add keys as 'projectPanel.*'.
// English is the source of truth; keep `en` and `ja` key sets identical.
export const projectPanel = {
  en: {
    // Header
    'projectPanel.backToGround': 'Back to Ground',
    'projectPanel.claudeNotFound': 'claude CLI not found — install Claude Code, then restart OPEN GROUND',
    'projectPanel.generating': 'Generating…',
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
    // Phase 1 controls (dispatch a Board to-do card to an isolated claude worker).
    'projectPanel.swarm.todoHeading': 'To do',
    'projectPanel.swarm.alreadyRunning': 'Running',
    'projectPanel.swarm.boardMoveFailed': 'Worker started, but moving the card to Doing failed — move it by hand in the Board tab.',
    'projectPanel.swarm.todoEmpty': 'No to-do cards. Add cards in the Board tab, then dispatch them here.',
    'projectPanel.swarm.untitled': '(untitled)',
    'projectPanel.swarm.dispatch': 'Dispatch',
    'projectPanel.swarm.dispatching': 'Dispatching…',
    'projectPanel.swarm.workersEmpty': 'No workers running. Dispatch a to-do card to start one — it gets its own isolated worktree and `claude` session.',
    'projectPanel.swarm.workersFull': 'Worker limit reached (6). Finish or terminate one to dispatch more.',
    'projectPanel.swarm.statusWorking': 'Working',
    'projectPanel.swarm.statusWaiting': 'Waiting',
    'projectPanel.swarm.statusStarting': 'Starting…',
    'projectPanel.swarm.statusExited': 'Exited',
    'projectPanel.swarm.terminate': 'Terminate',
    'projectPanel.swarm.terminating': 'Terminating…',
    'projectPanel.swarm.retained': 'Worktree kept — it has uncommitted changes.',
    'projectPanel.swarm.forceRemove': 'Force remove',
    'projectPanel.swarm.forceFailed': "Couldn't remove the worktree: {reason}. Remove it by hand if needed.",
    'projectPanel.swarm.dispatchFailed': 'Dispatch failed: {error}',
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
    'projectPanel.collabMemberRemove': 'Remove',
    'projectPanel.collabMemberRemoveFailed': 'Couldn’t remove that collaborator — try again.',
    'projectPanel.collabInviteEmailPlaceholder': 'Invite by email',
    'projectPanel.collabInviteEmailBtn': 'Invite',
    'projectPanel.collabInviteEmailBusy': 'Inviting…',
    'projectPanel.collabInviteEmailFailed': 'Couldn’t invite — check the email and try again.',
    // Shared-project (member) view — opening a folder-less project you joined.
    'projectPanel.collabSharedBadge': 'Shared',
    'projectPanel.collabSharedLive': 'Live',
    'projectPanel.collabSharedConnecting': 'Connecting to the shared project…',
    'projectPanel.collabSharedUnavailable': 'This shared project is unavailable — it may have been un-shared, or your access was removed.',
    'projectPanel.collabSharedClaudeTitle': 'Claude runs on your own machine',
    'projectPanel.collabSharedClaudeBody': 'This is a shared workspace — the Board syncs in realtime, but Claude runs in your own local checkout with your own subscription. Open this project’s repository locally to run Claude on a task.',
    'projectPanel.collabSharedCachedBanner': 'Connecting — showing your last saved copy (read-only)',
    'projectPanel.collabCanvasBack': 'All canvases',
    'projectPanel.collabCanvasEmpty': 'No canvases in this project yet.',
    // "Shared with me" dialog (the member entry point — join by code + open).
    'projectPanel.collabSharedDialogTitle': 'Shared with me',
    'projectPanel.collabSharedDialogJoinLabel': 'Join with a code',
    'projectPanel.collabSharedDialogJoinPlaceholder': 'Paste invite code',
    'projectPanel.collabSharedDialogJoin': 'Join',
    'projectPanel.collabSharedDialogJoining': 'Joining…',
    'projectPanel.collabSharedDialogJoinFailed': 'Couldn’t join — check the code (it may be invalid or expired) and that you’re signed in.',
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
    // Phase 1 の操作（Board の todo カードを隔離 claude worker に振る）。
    'projectPanel.swarm.todoHeading': '未着手',
    'projectPanel.swarm.alreadyRunning': '起動済み',
    'projectPanel.swarm.boardMoveFailed': 'worker は起動しましたが、カードを Doing に移動できませんでした — Board タブで手動で移動してください。',
    'projectPanel.swarm.todoEmpty': 'todo カードがありません。Board タブで追加してから、ここで振ってください。',
    'projectPanel.swarm.untitled': '（無題）',
    'projectPanel.swarm.dispatch': '振る',
    'projectPanel.swarm.dispatching': '起動中…',
    'projectPanel.swarm.workersEmpty': 'worker は動いていません。todo カードを振ると、隔離された worktree と `claude` セッションが割り当てられます。',
    'projectPanel.swarm.workersFull': 'worker は上限（6体）です。1 体を完了または終了すると追加できます。',
    'projectPanel.swarm.statusWorking': '稼働中',
    'projectPanel.swarm.statusWaiting': '待機中',
    'projectPanel.swarm.statusStarting': '起動中…',
    'projectPanel.swarm.statusExited': '終了',
    'projectPanel.swarm.terminate': '終了',
    'projectPanel.swarm.terminating': '終了中…',
    'projectPanel.swarm.retained': 'worktree を残しました — 未コミットの変更があります。',
    'projectPanel.swarm.forceRemove': '強制撤去',
    'projectPanel.swarm.forceFailed': 'worktree を撤去できませんでした: {reason}。必要なら手動で削除してください。',
    'projectPanel.swarm.dispatchFailed': '振り分けに失敗しました: {error}',
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
    'projectPanel.collabMemberRemove': '削除',
    'projectPanel.collabMemberRemoveFailed': '共同編集者を削除できませんでした。もう一度お試しください。',
    'projectPanel.collabInviteEmailPlaceholder': 'メールアドレスで招待',
    'projectPanel.collabInviteEmailBtn': '招待',
    'projectPanel.collabInviteEmailBusy': '招待中…',
    'projectPanel.collabInviteEmailFailed': '招待できませんでした。メールアドレスを確認してください。',
    // 共有プロジェクト（メンバー）ビュー — 参加したフォルダ無しプロジェクトを開く。
    'projectPanel.collabSharedBadge': '共有',
    'projectPanel.collabSharedLive': 'ライブ',
    'projectPanel.collabSharedConnecting': '共有プロジェクトに接続中…',
    'projectPanel.collabSharedUnavailable': 'この共有プロジェクトは利用できません — 共有解除されたか、あなたのアクセスが削除された可能性があります。',
    'projectPanel.collabSharedClaudeTitle': 'Claude は各自のマシンで動きます',
    'projectPanel.collabSharedClaudeBody': '共有ワークスペースです — Board はリアルタイムで同期しますが、Claude は各自のローカルチェックアウトで自分のサブスクリプションで動きます。タスクで Claude を動かすには、このプロジェクトのリポジトリをローカルで開いてください。',
    'projectPanel.collabSharedCachedBanner': '接続中 — 最後に保存したコピーを表示中（読み取り専用）',
    'projectPanel.collabCanvasBack': 'すべての Canvas',
    'projectPanel.collabCanvasEmpty': 'このプロジェクトにはまだ Canvas がありません。',
    // 「共有プロジェクト」ダイアログ（メンバーの入口 — コードで参加＋開く）。
    'projectPanel.collabSharedDialogTitle': '共有プロジェクト',
    'projectPanel.collabSharedDialogJoinLabel': 'コードで参加',
    'projectPanel.collabSharedDialogJoinPlaceholder': '招待コードを貼り付け',
    'projectPanel.collabSharedDialogJoin': '参加',
    'projectPanel.collabSharedDialogJoining': '参加中…',
    'projectPanel.collabSharedDialogJoinFailed': '参加できませんでした — コード（無効か失効の可能性）とサインイン状態を確認してください。',
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

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
    // Open in editor (header icon button)
    'projectPanel.openInEditor': 'Open in editor',
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
    'projectPanel.settingsWorkflowSharedHint': 'Applies to everyone on the team — synced via git.',
    'projectPanel.settingsTeamHeading': 'Shared with your team',
    'projectPanel.settingsTeamHint': 'This project’s Board & Canvas sync through the repository.',
    'projectPanel.settingsDisplayName': 'Your display name',
    'projectPanel.settingsDisplayNameHint': 'Used as your name on cards — a global setting, shared across all projects.',
    'projectPanel.settingsDisplayNameSaveFailed': 'Couldn’t save your display name: {error} — edit the field again to retry.',
    'projectPanel.settingsMembersSyncHint': 'Synced to the whole team — names appear as one-click assignee choices on every card.',
    'projectPanel.settingsAutoSyncDeviceNote': 'Personal — affects this device only.',
    'projectPanel.settingsInviteLink': 'Show how to invite…',
    'projectPanel.settingsShareCtaText': 'Share the Board & Canvas with your team through this repository.',
    'projectPanel.settingsShareCta': 'Share this project…',
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
    // Git share (.openground/ in the repo — docs/SHARED_DATA_PLAN.md)
    'projectPanel.sync': 'Sync',
    'projectPanel.syncing': 'Syncing…',
    'projectPanel.syncHint': 'Commit .openground/ changes, pull, then push',
    'projectPanel.syncDirtyHint': 'Unsynced local changes — commit, pull, then push',
    'projectPanel.syncBehindHint': '{count} shared change(s) on the remote — Sync to pull them',
    'projectPanel.syncDone': 'Synced',
    // Post-sync board digest — what the pull changed (boardDiffDigest segments,
    // joined with ' · '). {names} = distinct assignees of the added cards.
    'projectPanel.syncDigestAddedOne': '+1 card',
    'projectPanel.syncDigestAdded': '+{count} cards',
    'projectPanel.syncDigestAddedOneBy': '+1 card ({names})',
    'projectPanel.syncDigestAddedBy': '+{count} cards ({names})',
    'projectPanel.syncDigestTitle': '"{title}"',
    'projectPanel.syncDigestAddedTitles': '+{titles}',
    'projectPanel.syncDigestAddedTitlesBy': '+{titles} ({names})',
    'projectPanel.syncDigestDoneTitles': '{titles} done',
    'projectPanel.syncDigestMovedOne': '{title} → {column}',
    'projectPanel.syncDigestAssigned': '{title} → {name}',
    'projectPanel.syncDigestAssigneeChanged': '{count} reassigned',
    'projectPanel.syncDigestRemovedTitles': '{titles} removed',
    'projectPanel.syncDigestDone': '{count} done',
    'projectPanel.syncDigestMoved': '{count} moved',
    'projectPanel.syncDigestRemoved': '{count} removed',
    'projectPanel.syncConflict': 'Sync hit a conflict — pick which version to keep in the resolve dialog. (Conflicted code files are yours to resolve in git.)',
    'projectPanel.syncConflictItems': 'Conflicted: {items}',
    // Shared-board welcome strip — shown on the Board tab of a freshly
    // imported shared clone until dismissed (F002/F090). The Name suffix is
    // appended only while Settings.displayName is unset.
    'projectPanel.sharedWelcome': 'This board is shared via git — edits sync with your teammates.',
    'projectPanel.sharedWelcomeName': 'Set your display name to claim cards.',
    'projectPanel.sharedWelcomeDismiss': 'Dismiss',
    // Auto-sync (Live) indicator + personal setting
    'projectPanel.autoLive': 'Live',
    'projectPanel.autoLiveHint':
      'Auto-sync is on — your board edits publish themselves and teammate changes arrive automatically. Click to force a sync now.',
    'projectPanel.autoPausedCode': 'Paused',
    'projectPanel.autoPausedCodeHint':
      'Auto-sync is paused: your own code commits are waiting to be pushed. Push them yourself when ready (clicking Sync would push those code commits too).',
    'projectPanel.autoConflict': 'Conflict',
    'projectPanel.autoConflictHint': 'A sync conflict needs your decision — click to resolve it.',
    'projectPanel.autoOffline': 'Offline',
    'projectPanel.autoBlocked': 'Paused',
    'projectPanel.autoBlockedHint': 'The repo is mid rebase/merge — auto-sync waits until it finishes.',
    'projectPanel.autoError': 'Error',
    'projectPanel.autoErrorHint': 'The last auto-sync failed — click to retry.',
    'projectPanel.settingsAutoSync': 'Auto-sync shared data (Live)',
    'projectPanel.settingsAutoSyncHint':
      'Publishes your board/canvas edits a few seconds after you stop, and pulls teammate changes automatically. Your code is never touched — any code commit of yours pauses auto-sync until YOU push it.',
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
    'projectPanel.syncResolveLabel': 'Sync conflict',
    'projectPanel.syncResolveTitle': 'Choose which version to keep',
    'projectPanel.syncResolveExplain':
      'You and a teammate changed the same items. Pick a side for each — the version you don\'t pick still stays in the git history.',
    'projectPanel.syncResolveMine': 'My version',
    'projectPanel.syncResolveTheirs': "Teammate's version",
    'projectPanel.syncResolveDeleted': '(deleted — choosing this removes it)',
    'projectPanel.syncResolveConfirm': 'Resolve & sync',
    'projectPanel.syncResolveWorking': 'Resolving…',
    'projectPanel.syncResolvedDone': 'Conflicts resolved and synced',
    'projectPanel.syncFailed': 'Sync failed: {error}',
    // Machine-readable ShareSyncResult.reason → actionable notices.
    'projectPanel.syncBlockedRebase':
      'Sync paused: a rebase is in progress in this repo. Finish or abort it first (git rebase --continue / --abort), then sync again — nothing was changed.',
    'projectPanel.syncBlockedMerge':
      'Sync paused: a merge is in progress in this repo. Finish or abort it first (git merge --continue / --abort), then sync again — nothing was changed.',
    'projectPanel.syncBlockedDetached':
      'Sync needs a branch: the repo is on a detached HEAD. Switch back to a branch (git switch <branch>), then sync again.',
    'projectPanel.syncAutostashConflict':
      'Board synced, but restoring your uncommitted code changes hit a conflict — they are also saved in git stash. Resolve the conflict markers in your code (or restore from the stash), then continue as usual.',
    'projectPanel.syncNoIdentity':
      'Sync failed: git does not know who you are on this machine. Run `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"`, then sync again.',
    'projectPanel.syncOffline':
      'Could not reach the remote — your changes are committed locally and nothing is lost. Check the connection and press Sync again.',
    'projectPanel.syncNoRemote':
      'No git remote is configured — committed locally only. To collaborate, add one: git remote add origin <url>',
    'projectPanel.syncForcedUpdate':
      '⚠ The remote history was rewritten (force-push). This sync absorbed it — please review the board.',
    'projectPanel.syncForcedHint': 'The remote history was rewritten (force-push) — Sync will absorb it',
    'projectPanel.syncBranchHint': 'Current branch — the shared Board/Canvas data follows the checked-out branch',
    'projectPanel.syncLastAt': 'Last sync: {time}',
    // Header "Share…" (the pre-share occupant of the Sync/Live slot)
    'projectPanel.shareButton': 'Share…',
    'projectPanel.shareButtonHint': 'Share this project’s Board & Canvas with your team through this git repository',
    'projectPanel.unshareMenu': 'Stop sharing…',
    'projectPanel.shareDialogLabel': 'Share via Git',
    'projectPanel.shareDialogExplain': 'A .openground/ folder is created inside the repository and the Board + Canvas data moves into it. Anyone who clones the repo gets the same board and canvases; Sync pushes and pulls with your own git remote and credentials — OPEN GROUND never talks to a Git host directly.',
    // Share-start dialog (ShareStartDialog)
    'projectPanel.shareStartTitle': 'Share “{name}” with your team',
    'projectPanel.shareStartBranchNote': 'Shared data follows the checked-out branch (current: {branch}).',
    'projectPanel.shareStartRemoteLabel': 'Remote',
    'projectPanel.shareStartNoRemote': 'No git remote is configured — the shared data would only be committed locally. We recommend adding a remote (GitHub etc.) first, but you can also add one later and press Sync.',
    'projectPanel.shareStartDisplayName': 'Your display name',
    'projectPanel.shareStartDisplayNameHint': 'Shown as the assignee on cards — your teammates will see this name.',
    'projectPanel.shareStartNameRequired': 'Enter your display name to start sharing',
    'projectPanel.shareStartNameLoading': 'Loading your saved name…',
    'projectPanel.shareStartMembersHint': 'Your display name is included automatically. You can add more members anytime.',
    'projectPanel.shareStartConfirm': 'Start sharing',
    'projectPanel.shareStartWorking': 'Preparing to share…',
    // Invite panel (after enable + settings "Show how to invite…")
    'projectPanel.inviteLabel': 'Invite your team',
    'projectPanel.inviteTitle': 'Sharing is on',
    'projectPanel.inviteUnpublished': 'Not published to the remote yet.',
    'projectPanel.invitePublishNow': 'Publish now (Sync)',
    'projectPanel.invitePublishNoRemote': 'Add a git remote first — there is nowhere to publish yet.',
    'projectPanel.invitePublished': 'Published — teammates can join anytime.',
    'projectPanel.inviteStep1': 'Give your teammate access to the repository (push permission) — on GitHub or your git host.',
    'projectPanel.inviteStep2': 'They clone the repository.',
    // Quotes the toolbar.importFolder label VERBATIM — keep in sync with it.
    'projectPanel.inviteStep3': 'In OPEN GROUND they use “Import folder” — the same Board and Canvas appear immediately, no setup needed.',
    'projectPanel.inviteTextLabel': 'Invite message',
    // Quotes the toolbar.importFolder label VERBATIM — keep in sync with it.
    'projectPanel.inviteText': 'Clone the repo (git clone {url}), then open that folder with OPEN GROUND’s “Import folder”. The Board and Canvas connect automatically.',
    'projectPanel.inviteTextNoRemote': 'Add a git remote and the invite message will appear here.',
    'projectPanel.inviteCopy': 'Copy',
    'projectPanel.inviteCopied': 'Copied',
    'projectPanel.inviteDone': 'Done',
    'projectPanel.unshareDialogLabel': 'Stop sharing',
    'projectPanel.unshareDialogTitle': 'Move Board & Canvas data back to local storage?',
    'projectPanel.unshareDialogExplain': 'The data is copied back into OPEN GROUND’s local storage and the .openground/ folder is removed from the working tree. The folder’s deletion still needs a commit — the app does not commit it for you.',
    'projectPanel.unshareTeammateNote': 'Heads-up: once you commit and push the removal, your teammates’ boards will look empty on their side — let them know beforehand.',
    'projectPanel.unshareConfirm': 'Stop sharing',
    'projectPanel.shareWorking': 'Working…',
    'projectPanel.shareFailed': "Couldn't change sharing: {error} — check the repo state (git status), then try again.",
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
    // Open in editor (header icon button)
    'projectPanel.openInEditor': 'エディタで開く',
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
    'projectPanel.settingsWorkflowSharedHint': 'チーム全員に適用され、git で同期されます。',
    'projectPanel.settingsTeamHeading': 'チームと共有中',
    'projectPanel.settingsTeamHint': 'このプロジェクトの Board と Canvas はリポジトリ経由で同期されています。',
    'projectPanel.settingsDisplayName': 'あなたの表示名',
    'projectPanel.settingsDisplayNameHint': 'カードの担当者名として使われます — 全プロジェクト共通のグローバル設定です。',
    'projectPanel.settingsDisplayNameSaveFailed': '表示名を保存できませんでした: {error} — もう一度入力すると再試行されます。',
    'projectPanel.settingsMembersSyncHint': 'チーム全員に同期されます。登録した名前は各カードの担当者欄でワンクリック選択できます。',
    'projectPanel.settingsAutoSyncDeviceNote': '個人設定 — この端末にだけ効きます。',
    'projectPanel.settingsInviteLink': '招待方法を表示…',
    'projectPanel.settingsShareCtaText': 'Board と Canvas をこのリポジトリ経由でチームと共有できます。',
    'projectPanel.settingsShareCta': 'このプロジェクトを共有する…',
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
    // Git share (.openground/ in the repo — docs/SHARED_DATA_PLAN.md)
    'projectPanel.sync': 'Sync',
    'projectPanel.syncing': 'Sync中…',
    'projectPanel.syncHint': '.openground/ の変更をコミットして pull → push します',
    'projectPanel.syncDirtyHint': '未同期のローカル変更があります — コミットして pull → push します',
    'projectPanel.syncBehindHint': 'リモートに共有データの変更が {count} 件あります — Sync で取り込みます',
    'projectPanel.syncDone': '同期しました',
    'projectPanel.syncDigestAddedOne': 'カード+1',
    'projectPanel.syncDigestAdded': 'カード+{count}',
    'projectPanel.syncDigestAddedOneBy': 'カード+1（{names}）',
    'projectPanel.syncDigestAddedBy': 'カード+{count}（{names}）',
    'projectPanel.syncDigestTitle': '「{title}」',
    'projectPanel.syncDigestAddedTitles': '+{titles}',
    'projectPanel.syncDigestAddedTitlesBy': '+{titles}（{names}）',
    'projectPanel.syncDigestDoneTitles': '完了: {titles}',
    'projectPanel.syncDigestMovedOne': '{title}→ {column}',
    'projectPanel.syncDigestAssigned': '{title}→ {name}',
    'projectPanel.syncDigestAssigneeChanged': '担当変更{count}',
    'projectPanel.syncDigestRemovedTitles': '削除: {titles}',
    'projectPanel.syncDigestDone': '完了{count}',
    'projectPanel.syncDigestMoved': '移動{count}',
    'projectPanel.syncDigestRemoved': '削除{count}',
    'projectPanel.syncConflict': '同期が競合しました — 競合解決ダイアログでどちらを残すか選んでください。（コードファイルの競合はご自身で git で解決します。）',
    'projectPanel.syncConflictItems': '衝突箇所: {items}',
    // 共有ボードの歓迎ストリップ（F002/F090）— 共有クローンを import した直後の
    // Board タブに、閉じるまで表示。後半は displayName 未設定のときだけ付ける。
    'projectPanel.sharedWelcome': 'このボードは git で共有されています — 編集はチームに同期されます。',
    'projectPanel.sharedWelcomeName': '表示名を設定するとカードを担当できます。',
    'projectPanel.sharedWelcomeDismiss': '閉じる',
    // 自動同期（Live）インジケータ + 個人設定
    'projectPanel.autoLive': 'Live',
    'projectPanel.autoLiveHint':
      '自動同期が有効です — ボードの編集は自動で送信され、同僚の変更も自動で届きます。クリックで今すぐ同期します。',
    'projectPanel.autoPausedCode': '一時停止',
    'projectPanel.autoPausedCodeHint':
      '未pushのコードコミットがあるため自動同期は一時停止中です。コードはご自身のタイミングで push してください（Sync を押すとそのコードコミットも一緒に push されます）。',
    'projectPanel.autoConflict': '衝突',
    'projectPanel.autoConflictHint': '同期が競合しています — クリックして解決してください。',
    'projectPanel.autoOffline': 'オフライン',
    'projectPanel.autoBlocked': '一時停止',
    'projectPanel.autoBlockedHint': 'リポジトリが rebase/merge 中のため、終わるまで自動同期は待機します。',
    'projectPanel.autoError': 'エラー',
    'projectPanel.autoErrorHint': '前回の自動同期が失敗しました — クリックで再試行します。',
    'projectPanel.settingsAutoSync': '共有データを自動同期（Live）',
    'projectPanel.settingsAutoSyncHint':
      '編集が止まって数秒後に自動で送信し、同僚の変更も自動で取り込みます。コードには一切触れません — あなたのコードコミットがある間は自動同期が一時停止し、あなたが push するまで待ちます。',
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
    'projectPanel.syncResolveLabel': '同期の競合',
    'projectPanel.syncResolveTitle': 'どちらの版を残すか選んでください',
    'projectPanel.syncResolveExplain':
      'あなたと同僚が同じ項目を変更しています。それぞれ残す側を選んでください — 選ばなかった版も git の履歴には残ります。',
    'projectPanel.syncResolveMine': '自分の版',
    'projectPanel.syncResolveTheirs': '相手の版',
    'projectPanel.syncResolveDeleted': '（削除 — 選ぶとこのカードは消えます）',
    'projectPanel.syncResolveConfirm': '解決して同期',
    'projectPanel.syncResolveWorking': '解決中…',
    'projectPanel.syncResolvedDone': '競合を解決して同期しました',
    'projectPanel.syncFailed': '同期に失敗しました: {error}',
    // ShareSyncResult.reason → 行動につながる通知文
    'projectPanel.syncBlockedRebase':
      '同期を中止しました: このリポジトリで rebase が進行中です。先に解決または中止してから（git rebase --continue / --abort）もう一度 Sync してください。リポジトリには何も触れていません。',
    'projectPanel.syncBlockedMerge':
      '同期を中止しました: このリポジトリで merge が進行中です。先に解決または中止してから（git merge --continue / --abort）もう一度 Sync してください。リポジトリには何も触れていません。',
    'projectPanel.syncBlockedDetached':
      'ブランチ上にいないため同期できません（detached HEAD）。ブランチに戻ってから（git switch <ブランチ名>）もう一度 Sync してください。',
    'projectPanel.syncAutostashConflict':
      'ボードの同期は完了しましたが、退避していたコード変更の復元が衝突しました。変更は git stash にも保存されています。コード内の競合マーカーを解決するか stash から復元してから、通常どおり作業を続けてください。',
    'projectPanel.syncNoIdentity':
      '同期に失敗しました: このマシンの git に名前とメールが設定されていません。`git config --global user.name "名前"` と `git config --global user.email "you@example.com"` を実行してから、もう一度 Sync してください。',
    'projectPanel.syncOffline':
      'リモートに接続できませんでした。変更はローカルにコミット済みで失われていません — 接続を確認して、もう一度 Sync してください。',
    'projectPanel.syncNoRemote':
      'リモートが未設定のため、ローカルへのコミットのみ行いました。共同作業するには git remote add origin <URL> を設定してください。',
    'projectPanel.syncForcedUpdate':
      '⚠ リモートの履歴が書き換えられていました（force-push）。この同期で取り込み済みです — ボードの内容を確認してください。',
    'projectPanel.syncForcedHint': 'リモート履歴が書き換えられています（force-push）— Sync で取り込みます',
    'projectPanel.syncBranchHint': '現在のブランチ — 共有データ（Board/Canvas）はチェックアウト中のブランチの内容に従います',
    'projectPanel.syncLastAt': '最終Sync: {time}',
    // ヘッダーの「共有…」（共有後に Sync/Live が現れるのと同じスロット）
    'projectPanel.shareButton': '共有…',
    'projectPanel.shareButtonHint': 'このプロジェクトの Board と Canvas を、この git リポジトリ経由でチームと共有します',
    'projectPanel.unshareMenu': '共有を解除…',
    'projectPanel.shareDialogLabel': 'Gitで共有',
    'projectPanel.shareDialogExplain': 'リポジトリ内に .openground/ フォルダを作成し、Board と Canvas のデータをそこへ移します。リポジトリを clone した人は同じボードとキャンバスを共有でき、Sync はあなた自身の git リモートと認証情報で push / pull します — OPEN GROUND が Git ホストに直接アクセスすることはありません。',
    // 共有開始ダイアログ（ShareStartDialog）
    'projectPanel.shareStartTitle': '「{name}」をチームと共有',
    'projectPanel.shareStartBranchNote': '共有データはチェックアウト中のブランチに従います（現在: {branch}）。',
    'projectPanel.shareStartRemoteLabel': 'リモート',
    'projectPanel.shareStartNoRemote': 'リモートが設定されていません。共有データはローカルにしかコミットされません — GitHub 等に remote を追加してから始めることをおすすめします（あとから追加して Sync しても公開できます）。',
    'projectPanel.shareStartDisplayName': 'あなたの表示名',
    'projectPanel.shareStartDisplayNameHint': 'カードの担当者として表示されます — 同僚にもこの名前が見えます。',
    'projectPanel.shareStartNameRequired': '表示名を入力すると共有を開始できます',
    'projectPanel.shareStartNameLoading': '保存済みの名前を取得中…',
    'projectPanel.shareStartMembersHint': '自分の表示名は自動で含まれます。メンバーはあとからでも追加できます。',
    'projectPanel.shareStartConfirm': '共有を開始',
    'projectPanel.shareStartWorking': '共有を準備中…',
    // 招待パネル（enable 成功直後 + 設定「招待方法を表示…」）
    'projectPanel.inviteLabel': 'チームを招待',
    'projectPanel.inviteTitle': '共有中です',
    'projectPanel.inviteUnpublished': 'まだリモートに公開されていません。',
    'projectPanel.invitePublishNow': '今すぐ公開 (Sync)',
    'projectPanel.invitePublishNoRemote': 'まだ公開先がありません — 先に git remote を追加してください。',
    'projectPanel.invitePublished': '公開済み — 相手はいつでも参加できます。',
    'projectPanel.inviteStep1': '相手にリポジトリのアクセス権（push 権限）を渡します — GitHub 等のホスト側で。',
    'projectPanel.inviteStep2': '相手がリポジトリを clone します。',
    // toolbar.importFolder の実ラベルをそのまま引用 — 変更時は揃えること。
    'projectPanel.inviteStep3': 'OPEN GROUND の「フォルダをインポート」でそのフォルダを開くと、同じ Board と Canvas がすぐに表示されます（設定不要）。',
    'projectPanel.inviteTextLabel': '招待メッセージ',
    // toolbar.importFolder の実ラベルをそのまま引用 — 変更時は揃えること。
    'projectPanel.inviteText': 'git clone {url} したら、OPEN GROUND の「フォルダをインポート」でそのフォルダを開いてください。Board と Canvas が自動でつながります。',
    'projectPanel.inviteTextNoRemote': 'remote を追加すると招待文がここに表示されます。',
    'projectPanel.inviteCopy': 'コピー',
    'projectPanel.inviteCopied': 'コピーしました',
    'projectPanel.inviteDone': '完了',
    'projectPanel.unshareDialogLabel': '共有を解除',
    'projectPanel.unshareDialogTitle': 'Board と Canvas のデータをローカル保存に戻しますか？',
    'projectPanel.unshareDialogExplain': 'データを OPEN GROUND のローカル保存にコピーし直し、作業ツリーから .openground/ フォルダを削除します。フォルダ削除のコミットはアプリでは行いません — ご自身でコミットしてください。',
    'projectPanel.unshareTeammateNote': '同僚側では、あなたが解除をコミット・push した後にボードが空に見えます — 事前に伝えてください。',
    'projectPanel.unshareConfirm': '共有を解除',
    'projectPanel.shareWorking': '処理中…',
    'projectPanel.shareFailed': '共有設定を変更できませんでした: {error} — リポジトリの状態（git status）を確認して、もう一度お試しください。',
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
    // Running roster — live claude lanes for the project.
  } as Record<string, string>,
}

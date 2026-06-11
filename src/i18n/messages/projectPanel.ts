// Owned by the ProjectPanel translation track. Add keys as 'projectPanel.*'.
// English is the source of truth; keep `en` and `ja` key sets identical.
export const projectPanel = {
  en: {
    // Header
    'projectPanel.backToGround': 'Back to Ground',
    'projectPanel.claudeNotFound': 'claude CLI not found',
    'projectPanel.generating': 'Generating…',
    'projectPanel.regenerateDescription': 'Refresh description',
    'projectPanel.generateDescription': 'Generate description',
    // Open in… / pick app
    'projectPanel.pickFailed': 'Pick failed: {error}',
    'projectPanel.folderGone': "That folder no longer exists on disk — remove the card from the canvas, or re-import the folder if you moved it.",
    'projectPanel.openFailed': 'Open failed: {error}',
    'projectPanel.networkError': 'network error',
    // Missing-folder banner
    'projectPanel.missingBanner': 'This folder no longer exists on disk. Runs and “Open in…” are disabled. Locate the folder if you moved it, or use Remove from Ground to take the card off.',
    'projectPanel.locateFolder': 'Locate folder…',
    'projectPanel.locateFolderHint': 'Point this card at the folder’s new location — your tasks, notes and canvases reconnect.',
    // Loading
    'projectPanel.loading': 'Loading…',
    // Sidebar resizer
    // Chat header
    // Delete confirm
    'projectPanel.deleteProjectLabel': 'Delete project',
    'projectPanel.moveToTrashQuestion': 'Move “{name}” to the Trash?',
    'projectPanel.deleteExplain': 'The entire project folder is moved to the macOS Trash and removed from OPEN GROUND — but you can still restore it from the Trash in Finder. (To just take it off the Ground without touching the folder, use “Remove from Ground” instead.)',
    'projectPanel.typeToConfirmBefore': 'Type',
    'projectPanel.typeToConfirmAfter': 'to confirm',
    'projectPanel.deleteFailed': 'Delete failed: {error}',
    'projectPanel.deleting': 'Deleting…',
    // Tabs
    'projectPanel.dragToReorder': 'Drag to reorder · Alt+←/→ to move',
    // More menu
    'projectPanel.moreActions': 'More actions',
    'projectPanel.revealInFinder': 'Reveal in Finder',
    'projectPanel.revealInExplorer': 'Show in Explorer',
    'projectPanel.revealFolder': 'Open folder',
    'projectPanel.removeFromCanvas': 'Remove from Ground',
    'projectPanel.deleteProjectMenu': 'Delete project…',
    // Project settings dialog (shared policy + personal launch prefs)
    'projectPanel.projectSettingsMenu': 'Project settings…',
    'projectPanel.settingsDialogLabel': 'Project settings',
    'projectPanel.settingsSharedHeading': 'Shared policy',
    'projectPanel.settingsSharedHint': 'Applies to everyone on this board (synced via git when the project is shared).',
    'projectPanel.settingsPersonalHeading': 'Personal',
    'projectPanel.settingsPersonalHint': 'Stored only on this machine — never synced.',
    'projectPanel.settingsCompletionFlow': 'Completion flow',
    'projectPanel.settingsFlowMerge': 'Merge directly',
    'projectPanel.settingsFlowPr': 'Open a PR',
    'projectPanel.settingsTargetBranch': 'Target branch',
    'projectPanel.settingsTargetBranchPlaceholder': 'branch at launch',
    'projectPanel.settingsBranchDefault': 'Branch at launch (default)',
    'projectPanel.settingsMembers': 'Members',
    'projectPanel.settingsMemberAddPlaceholder': 'Add a member…',
    'projectPanel.settingsMemberAdd': 'Add',
    'projectPanel.settingsMemberRemove': 'Remove {name}',
    'projectPanel.settingsMembersHint': 'Registered names appear as one-click assignee choices on every card.',
    'projectPanel.settingsPermissionMode': 'Permission mode',
    'projectPanel.settingsPermDefault': 'Default (confirm each action)',
    'projectPanel.settingsPermAcceptEdits': 'Accept edits automatically',
    'projectPanel.settingsPermPlan': 'Plan mode',
    'projectPanel.settingsPermBypass': 'Bypass — fully automatic, no confirmations',
    'projectPanel.settingsModel': 'Model',
    'projectPanel.settingsModelDefault': 'CLI default',
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
    'projectPanel.syncConflict': 'Sync hit a conflict — pull and resolve it manually.',
    'projectPanel.syncConflictItems': 'Conflicted: {items}',
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
    'projectPanel.shareMenu': 'Share via Git…',
    'projectPanel.shareNeedsGitRepo': 'This folder is not a git repository',
    'projectPanel.unshareMenu': 'Stop sharing…',
    'projectPanel.shareDialogLabel': 'Share via Git',
    'projectPanel.shareDialogTitle': 'Share Board & Canvas through this repo?',
    'projectPanel.shareDialogExplain': 'A .openground/ folder is created inside the repository and the Board + Canvas data moves into it. Anyone who clones the repo gets the same board and canvases; Sync pushes and pulls with your own git remote and credentials — OPEN GROUND never talks to a Git host directly.',
    'projectPanel.shareConfirm': 'Share',
    'projectPanel.shareEnabledNotice': 'Sharing is on — press Sync to publish the board to the remote.',
    'projectPanel.unshareDialogLabel': 'Stop sharing',
    'projectPanel.unshareDialogTitle': 'Move Board & Canvas data back to local storage?',
    'projectPanel.unshareDialogExplain': 'The data is copied back into OPEN GROUND’s local storage and the .openground/ folder is removed from the working tree. The folder’s deletion still needs a commit — the app does not commit it for you.',
    'projectPanel.unshareConfirm': 'Stop sharing',
    'projectPanel.shareWorking': 'Working…',
    'projectPanel.shareFailed': 'Failed: {error}',
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
    'projectPanel.claudeNotFound': 'claude CLI が見つかりません',
    'projectPanel.generating': '生成中…',
    'projectPanel.regenerateDescription': '説明を更新',
    'projectPanel.generateDescription': '説明を生成',
    // Open in… / pick app
    'projectPanel.pickFailed': 'Pick failed: {error}',
    'projectPanel.folderGone': 'そのフォルダはディスク上に存在しません。カードを Ground から外すか、移動した場合はフォルダを再インポートしてください。',
    'projectPanel.openFailed': 'Open failed: {error}',
    'projectPanel.networkError': 'network error',
    // Missing-folder banner
    'projectPanel.missingBanner': 'このフォルダはディスク上に存在しません。実行と「Open in…」は無効です。移動した場合は「場所を選ぶ」で指定し直すか、カードを外すには「Ground から外す」を使ってください。',
    'projectPanel.locateFolder': '場所を選ぶ…',
    'projectPanel.locateFolderHint': 'このカードをフォルダの新しい場所に指し直します。タスク・ノート・Canvas が再接続されます。',
    // Loading
    'projectPanel.loading': 'Loading…',
    // Sidebar resizer
    // Chat header
    // Delete confirm
    'projectPanel.deleteProjectLabel': 'Delete project',
    'projectPanel.moveToTrashQuestion': '「{name}」をゴミ箱に移動しますか？',
    'projectPanel.deleteExplain': 'プロジェクトフォルダ全体が macOS のゴミ箱に移動し、OPEN GROUND から削除されます。ただし Finder のゴミ箱から復元できます。（フォルダはそのままに Ground から外すだけなら「Ground から外す」を使ってください。）',
    'projectPanel.typeToConfirmBefore': '確認のため',
    'projectPanel.typeToConfirmAfter': 'と入力してください',
    'projectPanel.deleteFailed': 'Delete failed: {error}',
    'projectPanel.deleting': 'Deleting…',
    // Tabs
    'projectPanel.dragToReorder': 'Drag to reorder · Alt+←/→ to move',
    // More menu
    'projectPanel.moreActions': 'More actions',
    'projectPanel.revealInFinder': 'Finderで開く',
    'projectPanel.revealInExplorer': 'エクスプローラーで表示',
    'projectPanel.revealFolder': 'フォルダを開く',
    'projectPanel.removeFromCanvas': 'Ground から外す',
    'projectPanel.deleteProjectMenu': 'プロジェクトを削除…',
    // Project settings dialog (shared policy + personal launch prefs)
    'projectPanel.projectSettingsMenu': 'プロジェクト設定…',
    'projectPanel.settingsDialogLabel': 'プロジェクト設定',
    'projectPanel.settingsSharedHeading': '共有ポリシー',
    'projectPanel.settingsSharedHint': 'このボードを使う全員に適用されます（プロジェクト共有時は git で同期）。',
    'projectPanel.settingsPersonalHeading': '自分だけの設定',
    'projectPanel.settingsPersonalHint': 'この端末にだけ保存され、同期されません。',
    'projectPanel.settingsCompletionFlow': '完了フロー',
    'projectPanel.settingsFlowMerge': '直接マージ',
    'projectPanel.settingsFlowPr': 'PRを作成',
    'projectPanel.settingsTargetBranch': 'ターゲットブランチ',
    'projectPanel.settingsTargetBranchPlaceholder': '起動時のブランチ',
    'projectPanel.settingsBranchDefault': '起動時のブランチ（既定）',
    'projectPanel.settingsMembers': 'メンバー',
    'projectPanel.settingsMemberAddPlaceholder': '名前を追加…',
    'projectPanel.settingsMemberAdd': '追加',
    'projectPanel.settingsMemberRemove': '{name} を削除',
    'projectPanel.settingsMembersHint': '登録した名前は、各カードの担当者欄でワンクリック選択できます。',
    'projectPanel.settingsPermissionMode': '権限モード',
    'projectPanel.settingsPermDefault': '標準（操作ごとに確認）',
    'projectPanel.settingsPermAcceptEdits': '編集を自動で許可',
    'projectPanel.settingsPermPlan': 'プランモード',
    'projectPanel.settingsPermBypass': 'Bypass — 全自動・確認なし',
    'projectPanel.settingsModel': 'モデル',
    'projectPanel.settingsModelDefault': 'CLIの既定',
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
    'projectPanel.syncConflict': '同期が競合しました。手動で pull して解決してください。',
    'projectPanel.syncConflictItems': '衝突箇所: {items}',
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
    'projectPanel.shareMenu': 'Gitで共有…',
    'projectPanel.shareNeedsGitRepo': 'このフォルダは git リポジトリではありません',
    'projectPanel.unshareMenu': '共有を解除…',
    'projectPanel.shareDialogLabel': 'Gitで共有',
    'projectPanel.shareDialogTitle': 'Board と Canvas をこのリポジトリで共有しますか？',
    'projectPanel.shareDialogExplain': 'リポジトリ内に .openground/ フォルダを作成し、Board と Canvas のデータをそこへ移します。リポジトリを clone した人は同じボードとキャンバスを共有でき、Sync はあなた自身の git リモートと認証情報で push / pull します — OPEN GROUND が Git ホストに直接アクセスすることはありません。',
    'projectPanel.shareConfirm': '共有する',
    'projectPanel.shareEnabledNotice': '共有を有効にしました — Sync を押すとリモートに公開されます。',
    'projectPanel.unshareDialogLabel': '共有を解除',
    'projectPanel.unshareDialogTitle': 'Board と Canvas のデータをローカル保存に戻しますか？',
    'projectPanel.unshareDialogExplain': 'データを OPEN GROUND のローカル保存にコピーし直し、作業ツリーから .openground/ フォルダを削除します。フォルダ削除のコミットはアプリでは行いません — ご自身でコミットしてください。',
    'projectPanel.unshareConfirm': '共有を解除',
    'projectPanel.shareWorking': '処理中…',
    'projectPanel.shareFailed': 'Failed: {error}',
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
    'projectPanel.doubleClickToRename': 'Double-click to rename',
    // Running roster — live claude lanes for the project.
  } as Record<string, string>,
}

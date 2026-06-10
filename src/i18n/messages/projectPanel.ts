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
    'projectPanel.resizeHint': 'Drag to resize / double-click for default width',
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
    'projectPanel.settingsVerifyCommands': 'Verify commands',
    'projectPanel.settingsVerifyPlaceholder': 'One command per line (e.g. npm test)',
    'projectPanel.settingsReviewColumn': 'Show an “In review” column',
    'projectPanel.settingsMembers': 'Members',
    'projectPanel.settingsMembersPlaceholder': 'One name per line',
    'projectPanel.settingsMembersHint': 'Registered names appear as one-click assignee choices on every card.',
    'projectPanel.settingsPermissionMode': 'Permission mode',
    'projectPanel.settingsPermDefault': 'Default (confirm each action)',
    'projectPanel.settingsPermAcceptEdits': 'Accept edits automatically',
    'projectPanel.settingsPermPlan': 'Plan mode',
    'projectPanel.settingsPermBypass': 'Bypass — fully automatic, no confirmations',
    'projectPanel.settingsModel': 'Model',
    'projectPanel.settingsModelPlaceholder': 'CLI default (e.g. sonnet)',
    // Git share (.openground/ in the repo — docs/SHARED_DATA_PLAN.md)
    'projectPanel.sync': 'Sync',
    'projectPanel.syncing': 'Syncing…',
    'projectPanel.syncHint': 'Commit .openground/ changes, pull, then push',
    'projectPanel.syncDirtyHint': 'Unsynced local changes — commit, pull, then push',
    'projectPanel.syncDone': 'Synced',
    // Post-sync board digest — what the pull changed (boardDiffDigest segments,
    // joined with ' · '). {names} = distinct assignees of the added cards.
    'projectPanel.syncDigestAddedOne': '+1 card',
    'projectPanel.syncDigestAdded': '+{count} cards',
    'projectPanel.syncDigestAddedOneBy': '+1 card ({names})',
    'projectPanel.syncDigestAddedBy': '+{count} cards ({names})',
    'projectPanel.syncDigestDone': '{count} done',
    'projectPanel.syncDigestMoved': '{count} moved',
    'projectPanel.syncDigestRemoved': '{count} removed',
    'projectPanel.syncConflict': 'Sync hit a conflict — pull and resolve it manually.',
    'projectPanel.syncFailed': 'Sync failed: {error}',
    'projectPanel.shareMenu': 'Share via Git…',
    'projectPanel.shareNeedsGitRepo': 'This folder is not a git repository',
    'projectPanel.unshareMenu': 'Stop sharing…',
    'projectPanel.shareDialogLabel': 'Share via Git',
    'projectPanel.shareDialogTitle': 'Share Board & Canvas through this repo?',
    'projectPanel.shareDialogExplain': 'A .openground/ folder is created inside the repository and the Board + Canvas data moves into it. Anyone who clones the repo gets the same board and canvases; Sync pushes and pulls with your own git remote and credentials — OPEN GROUND never talks to a Git host directly.',
    'projectPanel.shareConfirm': 'Share',
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
    'projectPanel.launchClaudeInPane': 'Launch claude in this pane',
    'projectPanel.claudeSessionEnded': 'The claude session has ended',
    'projectPanel.relaunchClaude': 'Relaunch Claude',
    'projectPanel.taskSlotFallback': 'Task',
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
    'projectPanel.resizeHint': 'ドラッグで幅を変更 / ダブルクリックで初期幅',
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
    'projectPanel.settingsVerifyCommands': '検証コマンド',
    'projectPanel.settingsVerifyPlaceholder': '1行に1コマンド（例: npm test）',
    'projectPanel.settingsReviewColumn': '「レビュー待ち」列を表示',
    'projectPanel.settingsMembers': 'メンバー',
    'projectPanel.settingsMembersPlaceholder': '1行に1人',
    'projectPanel.settingsMembersHint': '登録した名前は、各カードの担当者欄でワンクリック選択できます。',
    'projectPanel.settingsPermissionMode': '権限モード',
    'projectPanel.settingsPermDefault': '標準（操作ごとに確認）',
    'projectPanel.settingsPermAcceptEdits': '編集を自動で許可',
    'projectPanel.settingsPermPlan': 'プランモード',
    'projectPanel.settingsPermBypass': 'Bypass — 全自動・確認なし',
    'projectPanel.settingsModel': 'モデル',
    'projectPanel.settingsModelPlaceholder': 'CLIの既定（例: sonnet）',
    // Git share (.openground/ in the repo — docs/SHARED_DATA_PLAN.md)
    'projectPanel.sync': 'Sync',
    'projectPanel.syncing': 'Sync中…',
    'projectPanel.syncHint': '.openground/ の変更をコミットして pull → push します',
    'projectPanel.syncDirtyHint': '未同期のローカル変更があります — コミットして pull → push します',
    'projectPanel.syncDone': '同期しました',
    'projectPanel.syncDigestAddedOne': 'カード+1',
    'projectPanel.syncDigestAdded': 'カード+{count}',
    'projectPanel.syncDigestAddedOneBy': 'カード+1（{names}）',
    'projectPanel.syncDigestAddedBy': 'カード+{count}（{names}）',
    'projectPanel.syncDigestDone': '完了{count}',
    'projectPanel.syncDigestMoved': '移動{count}',
    'projectPanel.syncDigestRemoved': '削除{count}',
    'projectPanel.syncConflict': '同期が競合しました。手動で pull して解決してください。',
    'projectPanel.syncFailed': '同期に失敗しました: {error}',
    'projectPanel.shareMenu': 'Gitで共有…',
    'projectPanel.shareNeedsGitRepo': 'このフォルダは git リポジトリではありません',
    'projectPanel.unshareMenu': '共有を解除…',
    'projectPanel.shareDialogLabel': 'Gitで共有',
    'projectPanel.shareDialogTitle': 'Board と Canvas をこのリポジトリで共有しますか？',
    'projectPanel.shareDialogExplain': 'リポジトリ内に .openground/ フォルダを作成し、Board と Canvas のデータをそこへ移します。リポジトリを clone した人は同じボードとキャンバスを共有でき、Sync はあなた自身の git リモートと認証情報で push / pull します — OPEN GROUND が Git ホストに直接アクセスすることはありません。',
    'projectPanel.shareConfirm': '共有する',
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
    'projectPanel.launchClaudeInPane': 'このペインで claude を起動',
    'projectPanel.claudeSessionEnded': 'claude セッションが終了しました',
    'projectPanel.relaunchClaude': 'Claude を再起動',
    'projectPanel.taskSlotFallback': 'タスク',
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

// Owned by the Board translation track. Add keys as 'board.*'.
// English is the source of truth; keep `en` and `ja` key sets identical.
export const board = {
  en: {
    // Columns
    'board.col.todo': 'To do',
    'board.col.todo.hint': 'Top = highest priority',
    'board.col.doing': 'In progress',
    'board.col.review': 'In review',
    'board.col.done': 'Done',
    'board.col.blocked': 'Blocked',
    'board.col.blocked.hint': 'Conflict / needs attention',
    // Card status
    // Card reason
    // Toolbar
    'board.toolbar.count': 'Board · {count} cards',
    'board.toolbar.mineOnly': 'Mine only',
    'board.toolbar.mineOnlyNeedsName': 'Set your display name in Settings to filter by assignee',
    'board.toolbar.reviewColumn': 'Review',
    'board.toolbar.reviewColumnShowHint':
      'Add an "In review" column for PR-waiting cards — shared with everyone on this board.',
    'board.toolbar.reviewColumnHideHint':
      'Hide the review column — cards parked there fold into In progress until it returns.',
    // Card
    'board.card.untitled': 'Untitled',
    'board.card.untitledParen': '(Untitled)',
    'board.card.ariaLabel': '{title} — {column}. Press Enter to open',
    // Composer
    'board.composer.placeholder': '＋ Add a card',
    // Detail drawer
    'board.detail.titleLabel': 'Title',
    'board.detail.titlePlaceholder': 'What this task is',
    'board.detail.notesLabel': 'Content',
    'board.detail.notesPlaceholder': 'What this task should do — passed to claude together with the title at launch',
    'board.detail.assigneeLabel': 'Assignee',
    'board.detail.assigneeAdd': '+ Add',
    'board.detail.assigneeAddPlaceholder': 'Name',
    'board.detail.assigneeAddConfirm': 'Add',
    'board.detail.assigneeAssign': 'Assign to {name}',
    'board.detail.assigneeUnassign': 'Click to unassign',
    'board.detail.resizeWidth': 'Drag to resize the panel width',
    'board.detail.resizeSplit': 'Drag to resize the terminal height',
    'board.detail.resizeSplitTitle': 'Drag to resize · double-click to maximize the terminal',
    'board.detail.prLabel': 'Pull request',
    'board.detail.captureLabel': 'Task',
    'board.detail.capturePlaceholder':
      'What should be done?\nThe first line becomes the title — for longer text an AI summary title replaces it automatically (✦).',
    'board.detail.launchHintShort':
      'Launches claude with the title + content as the first prompt. Also appears in the Terminal tab.',
    'board.detail.flowBaseDefault': 'the launch branch',
    'board.detail.flowPr': 'On finish: PR → {base} (a human merges)',
    'board.detail.flowMerge': 'On finish: merge → {base}',
    'board.detail.titleAutoTitle': 'Auto-generated title — editing it makes it yours',
    'board.detail.regenTitle': 'Regenerate the title from the content (AI)',
    'board.detail.fieldsToggle': 'Show / hide the task fields',
    'board.detail.branchTitle': 'Task branch',
    // Task terminal (drawer launch CTA)
    'board.taskTerminal.hint':
      'Launch claude for this task. The title AND the content are passed as the first prompt; in a git project claude works on its own task branch in its own worktree, so several tasks can run in parallel. Respond and approve permission prompts in this terminal. It also appears in the Terminal tab, labelled with the title.',
  } as Record<string, string>,
  ja: {
    // Columns
    'board.col.todo': '未着手',
    'board.col.todo.hint': '上から優先度順',
    'board.col.doing': '実行中',
    'board.col.review': 'レビュー待ち',
    'board.col.done': '完了',
    'board.col.blocked': 'ブロック',
    'board.col.blocked.hint': 'コンフリクト / 要対応',
    // Card status
    // Card reason
    // Toolbar
    'board.toolbar.count': 'ボード · {count} カード',
    'board.toolbar.mineOnly': '自分のみ',
    'board.toolbar.mineOnlyNeedsName': '設定で表示名を設定すると、担当者で絞り込めます',
    'board.toolbar.reviewColumn': 'レビュー',
    'board.toolbar.reviewColumnShowHint':
      'PR レビュー待ちカード用の「レビュー待ち」列を追加します — このボードの全員に共有されます。',
    'board.toolbar.reviewColumnHideHint':
      'レビュー列を隠します — 置かれていたカードは再表示まで「実行中」に畳まれます。',
    // Card
    'board.card.untitled': '無題',
    'board.card.untitledParen': '（無題）',
    'board.card.ariaLabel': '{title} — {column}。Enter で開く',
    // Composer
    'board.composer.placeholder': '＋ カードを追加',
    // Detail drawer
    'board.detail.titleLabel': 'タイトル',
    'board.detail.titlePlaceholder': 'このタスクの内容',
    'board.detail.notesLabel': '内容',
    'board.detail.notesPlaceholder': 'このタスクでやること — 起動時にタイトルと一緒に claude へ渡されます',
    'board.detail.assigneeLabel': '担当者',
    'board.detail.assigneeAdd': '＋ 追加',
    'board.detail.assigneeAddPlaceholder': '名前',
    'board.detail.assigneeAddConfirm': '追加',
    'board.detail.assigneeAssign': '{name} に割り当て',
    'board.detail.assigneeUnassign': 'クリックで解除',
    'board.detail.resizeWidth': 'ドラッグでパネル幅を変更',
    'board.detail.resizeSplit': 'ドラッグでターミナルの高さを変更',
    'board.detail.resizeSplitTitle': 'ドラッグでサイズ変更 · ダブルクリックでターミナル最大化',
    'board.detail.prLabel': 'プルリクエスト',
    'board.detail.captureLabel': 'タスク',
    'board.detail.capturePlaceholder':
      'やることを書いてください\n1行目がタイトルになります — 長い内容は AI が短いタイトルに自動で整えます（✦）',
    'board.detail.launchHintShort':
      'タイトルと内容を最初のプロンプトとして claude を起動します。Terminal タブにも並びます。',
    'board.detail.flowBaseDefault': '起動時のブランチ',
    'board.detail.flowPr': '完了時: PR → {base}（人間がマージ）',
    'board.detail.flowMerge': '完了時: {base} へマージ',
    'board.detail.titleAutoTitle': '自動生成タイトル — 編集すると固定されます',
    'board.detail.regenTitle': '内容からタイトルを再生成（AI）',
    'board.detail.fieldsToggle': 'タスク詳細の表示切替',
    'board.detail.branchTitle': 'タスクブランチ',
    // Task terminal (drawer launch CTA)
    'board.taskTerminal.hint':
      'このタスクで claude を起動します。タイトルと内容が最初のプロンプトとして渡され、git プロジェクトでは claude がタスク専用のブランチ＋worktree で作業するため、複数タスクを並列に実行できます。応答や権限確認はこのターミナルで操作します。Terminal タブにもタイトル付きで並びます。',
  } as Record<string, string>,
}

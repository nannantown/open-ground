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
    // Task terminal (drawer launch CTA)
    'board.taskTerminal.hint':
      'このタスクで claude を起動します。タイトルと内容が最初のプロンプトとして渡され、git プロジェクトでは claude がタスク専用のブランチ＋worktree で作業するため、複数タスクを並列に実行できます。応答や権限確認はこのターミナルで操作します。Terminal タブにもタイトル付きで並びます。',
  } as Record<string, string>,
}

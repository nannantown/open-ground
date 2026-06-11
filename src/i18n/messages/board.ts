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
    'board.detail.notesPlaceholder': 'What this task should do — "Insert task into input" pastes it into claude together with the title',
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
    'board.detail.autoLaunchHint':
      'claude launches here automatically once the card has a title. Nothing is sent — you stay in control.',
    'board.detail.autoLaunchDone':
      'This card is in Done — no session is started. Move it back to launch claude.',
    'board.detail.autoLaunchMissing':
      'The project folder is missing — claude can’t start until it’s relocated.',
    'board.detail.autoLaunchFailed':
      'Couldn’t start claude. Check that the claude CLI is installed, then retry.',
    'board.detail.autoLaunchRetry': 'Retry launch',
    'board.detail.insertTask': 'Insert task into input',
    'board.detail.insertTaskBusy': 'Inserting…',
    'board.detail.insertTaskHint': 'Pastes the title + content unsent — press Enter to run.',
    'board.detail.insertTaskFailed': 'Insert failed — the session may have ended. Try again.',
    'board.detail.flowBaseDefault': 'the launch branch',
    'board.detail.flowPr': 'On finish: PR → {base} (a human merges)',
    'board.detail.flowMerge': 'On finish: merge → {base}',
    'board.detail.titleAutoTitle': 'Auto-generated title — editing it makes it yours',
    'board.detail.regenTitle': 'Regenerate the title from the content (AI)',
    'board.detail.fieldsToggle': 'Show / hide the task fields',
    'board.detail.branchTitle': 'Task branch',
    // Task terminal (drawer relaunch CTA — shown after the session exits)
    'board.taskTerminal.hint':
      'Launch claude in this project (plain — no prompt is sent). Use "Insert task into input" to paste the title + content into the input box, then press Enter to run. Respond and approve permission prompts in this terminal.',
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
    'board.detail.notesPlaceholder': 'このタスクでやること —「タスク内容を入力欄へ」でタイトルと一緒に claude へ貼り付けられます',
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
    'board.detail.autoLaunchHint':
      'タイトルを付けると claude がここで自動起動します。何も送信されません — 実行はあなたが決めます。',
    'board.detail.autoLaunchDone':
      '完了列のカードでは起動しません。起動するには列を戻してください。',
    'board.detail.autoLaunchMissing':
      'プロジェクトフォルダが見つかりません。場所を再設定するまで claude は起動できません。',
    'board.detail.autoLaunchFailed':
      'claude を起動できませんでした。claude CLI が入っているか確認して再試行してください。',
    'board.detail.autoLaunchRetry': '再試行',
    'board.detail.insertTask': 'タスク内容を入力欄へ',
    'board.detail.insertTaskBusy': '挿入中…',
    'board.detail.insertTaskHint': 'タイトルと内容を未送信で貼り付け — Enter で実行が始まります。',
    'board.detail.insertTaskFailed': '挿入に失敗しました — セッションが終了した可能性があります。もう一度お試しください。',
    'board.detail.flowBaseDefault': '起動時のブランチ',
    'board.detail.flowPr': '完了時: PR → {base}（人間がマージ）',
    'board.detail.flowMerge': '完了時: {base} へマージ',
    'board.detail.titleAutoTitle': '自動生成タイトル — 編集すると固定されます',
    'board.detail.regenTitle': '内容からタイトルを再生成（AI）',
    'board.detail.fieldsToggle': 'タスク詳細の表示切替',
    'board.detail.branchTitle': 'タスクブランチ',
    // Task terminal (drawer relaunch CTA — shown after the session exits)
    'board.taskTerminal.hint':
      'このプロジェクトで claude を起動します（プレーン起動 — プロンプトは送信されません）。「タスク内容を入力欄へ」でタイトルと内容を入力欄に貼り付け、Enter で実行します。応答や権限確認はこのターミナルで操作します。',
  } as Record<string, string>,
}

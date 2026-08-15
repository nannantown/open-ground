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
    'board.col.blocked': 'Needs decision',
    'board.col.blocked.hint': 'Waiting for your decision — nothing moves automatically',
    // Card status
    // Card reason
    // Toolbar
    'board.toolbar.count': 'Board · {count} cards',
    'board.toolbar.mineOnly': 'Mine only',
    'board.toolbar.mineOnlyNeedsName': 'Set your display name in Settings to filter by assignee',
    'board.toolbar.projectSettings': 'Settings',
    'board.toolbar.clearDone': 'Clear',
    'board.toolbar.clearDoneTitle': 'Delete every card in Done',
    'board.toolbar.clearDoneConfirm':
      'Delete {count} cards in Done. On a shared board the deletion applies to everyone.',
    // Card
    'board.card.untitled': 'Untitled',
    'board.empty.guide': 'Write a card → Run → the terminal does the task → done merges.',
    'board.card.sessionWorking': 'Claude is working on this card',
    // The visible stamp on the card. Short by design — the mock's state line is
    // a word, not a sentence, and it sits inline before the title.
    'board.card.sessionWorkingLabel': 'working',
    'board.card.sessionWaitingLabel': 'your turn',
    'board.card.sessionWaiting': 'Claude is waiting for your input on this card',
    'board.detail.markDone': '✓ Done',
    'board.detail.markDoneTitle': 'Move this card to Done now (use when the run finished but the card didn\'t move)',
    'board.card.markReviewed': 'Mark reviewed',
    'board.card.markReviewedTitle': 'Stamp this card as reviewed by you (visible to the whole board)',
    'board.card.reviewedBy': 'Reviewed by {name}',
    'board.card.reviewedClear': 'Click to clear the reviewed stamp',
    'board.card.merged': 'Merged',
    'board.card.mergedTitle': "This card's branch is already merged into the target branch",
    'board.card.mergedToDone': '→ Done',
    'board.card.mergedToDoneTitle':
      'Move this card to Done — the branch has landed (nothing moves without this click)',
    'board.card.integrationConflict': 'Needs manual merge',
    'board.card.integrationConflictTitle':
      'Auto-integration hit a rebase conflict on this branch — it was aborted (never force-merged). Integrate it by hand, then move the card.',
    'board.card.managerLabel': 'Commander',
    // The figures on a card (SwarmSprite) convey state by how they MOVE, which
    // a screen reader cannot see — so each one's accessible name is
    // "<who> <what>", built from these two plus the existing state words. A
    // figure that says something only in pixels says nothing to half the room.
    'board.card.workerLabel': 'Worker',
    'board.card.managerMissing': 'Away',
    // Needs-you badge — an OPEN escalation names this card. Lane-independent:
    // a todo/blocked card can be waiting on you too. Read-only (answering
    // declares a declineEffect, which does not belong behind one tap).
    'board.card.needsYou': 'Needs you',
    'board.card.needsYouIrreversible': "can't be undone",
    'board.card.needsYouInsufficientInfo': 'not enough to decide',
    'board.card.needsYouPolicy': 'outside its remit',
    // Prefix on a worker note whose heartbeat has gone quiet — the note is a
    // statement about the PAST, and must not read as one about now.
    'board.card.noteStale': 'last report:',
    // Board-altitude honesty line: activity the engine cannot tie to any card.
    'board.swarm.unattributedWorkers': '{n} running, not tied to a card',
    'board.swarm.unattributedQuestions': '{n} waiting on you, not tied to a card',
    // ── The Board's front-desk seat (the supply officer, in a bottom dock) ──
    // The SAME desk the Swarm tab shows, never a second one: one server-side
    // desk, one stored record, one shared hook (useSupplyDesk).
    'board.supply.title': 'Front desk',
    'board.supply.open': 'Open the front desk',
    'board.supply.opening': 'Opening…',
    'board.supply.closed': 'The front desk is closed',
    // The monitor half, rolled up. Counts only — the detail is one click away.
    // ONE STRING PER CLAUSE, joined only for the ones we can evidence — a
    // single three-slot template forced a number where there was none.
    'board.supply.rollupWorking': '{n} working',
    'board.supply.rollupReview': '{n} in review',
    'board.supply.rollupWaiting': '{n} waiting on you',
    'board.supply.rollupUnknown': 'Checking…',
    'board.supply.workersUnknown': 'Not checked yet — the engine has not answered.',
    'board.supply.expand': 'Open the front desk panel',
    'board.supply.collapse': 'Close the front desk panel',
    'board.supply.stop': 'Close the desk',
    'board.supply.stopping': 'Closing…',
    'board.supply.resize': 'Drag to resize the front desk panel',
    'board.supply.workers': 'Workers',
    // A worker the engine cannot tie to a card gets NO card link — never a
    // guessed one. Same rule as the honesty line above.
    'board.supply.workerNoCard': 'not tied to a card',
    'board.supply.noWorkers': 'No workers are running right now',
    'board.card.phaseAudit': 'auditing',
    'board.card.phaseImplement': 'implementing',
    'board.card.phaseVerify': 'verifying',
    'board.card.phaseRework': 'reworking',
    'board.card.phaseBlocked': 'stuck',
    'board.card.phaseDone': 'wrapping up',
    'board.review.managerWorkingTitle':
      'The commander is on integration duty right now — no need to open the Swarm tab.',
    'board.card.untitledParen': '(Untitled)',
    'board.card.duplicate': 'Duplicate card',
    'board.card.duplicateTitle':
      'Duplicate this card right below — content and assignee are copied; branch, PR and review state are not',
    'board.card.ariaLabel': '{title} — {column}. Press Enter to open',
    // Composer
    'board.composer.placeholder': '＋ Add a card',
    // Detail drawer. titlePlaceholder is kept — BoardTab's inline card editor
    // still uses it (the drawer's own title field is gone; the title is auto).
    'board.detail.titlePlaceholder': 'What this task is',
    'board.detail.notesLabel': 'Content',
    'board.detail.notesPlaceholder':
      'What should this task do?\nDrop or paste an image to attach it. The title is generated for you when you run.',
    // Image attachments (B022) — paste/drop only now (no picker button).
    'board.detail.attachBusy': 'Attaching…',
    'board.detail.attachRemove': 'Remove image',
    'board.detail.attachTooLarge': 'Image is too large (max 5MB)',
    'board.detail.attachFailed': 'Could not attach the image — please try again',
    'board.detail.assigneeLabel': 'Assignee',
    'board.detail.assigneeAdd': '+ Add',
    'board.detail.assigneeAddPlaceholder': 'Name',
    'board.detail.assigneeAddConfirm': 'Add',
    'board.detail.assigneeAssign': 'Assign to {name}',
    'board.detail.assigneeUnassign': 'Click to unassign',
    'board.detail.dependsLabel': 'Depends on',
    'board.detail.dependsAdd': '+ Add',
    'board.detail.dependsPick': 'Pick a card…',
    'board.detail.dependsNone': 'No cards left to depend on',
    'board.detail.dependsRemove': 'Remove the dependency on "{title}"',
    'board.detail.dependsCycleWarn':
      'Circular dependency — these cards wait on each other, so the swarm will never start them. Remove a link to break the loop.',
    'board.detail.dueLabel': 'Due',
    'board.detail.dueClear': 'Clear the due date',
    // Priority (in-app swarm dispatch order) — picker labels + the card chip.
    'board.detail.priorityLabel': 'Priority',
    'board.detail.priority.urgent': 'Urgent',
    'board.detail.priority.high': 'High',
    'board.detail.priority.normal': 'Normal',
    'board.detail.priority.low': 'Low',
    'board.detail.priorityHint': 'Higher priority is dispatched first; cards left waiting climb on their own.',
    'board.card.priorityTitle': 'Priority: {label}',
    'board.card.depsTitle': 'Waiting on: {titles}',
    'board.card.cycleTitle':
      'Circular dependency — this card and its prerequisites wait on each other, so the swarm will never start them. Break the loop on the board.',
    'board.card.cycleChip': 'Cycle',
    'board.card.dueTitle': 'Due {date}',
    'board.detail.resizeWidth': 'Drag to resize the panel width',
    'board.detail.resizeSplit': 'Drag to resize the terminal height',
    'board.detail.resizeSplitTitle': 'Drag to resize · double-click to maximize the terminal',
    'board.detail.prLabel': 'Pull request',
    'board.detail.optionsLabel': 'Options',
    'board.run.button': 'Run',
    'board.run.buttonBusy': 'Starting…',
    'board.run.buttonTitle':
      'Launch a claude session and start this task right away (the prompt is sent for you)',
    'board.run.needsContent': 'Write what to do to run this task.',
    'board.run.hint': 'Run opens the terminal and starts this task automatically.',
    'board.run.missingFolder':
      'The project folder is missing — claude can’t start until it’s relocated.',
    'board.run.failed':
      'Couldn’t start claude. Make sure the claude CLI is installed and on your PATH (run `claude` in a terminal to check), then run again.',
    'board.run.failedClaudeMissing':
      'The claude CLI was not found on this machine — install Claude Code and sign in, then restart OPEN GROUND and run again.',
    'board.run.failedClaudeLoggedOut':
      'Claude is installed but not signed in. Sign in once below — a single Claude terminal opens; finish signing in there, then run again.',
    'board.run.signIn': 'Sign in to Claude',
    'board.run.settingsLabel': 'Run settings',
    'board.run.flowLabel': 'On finish',
    'board.run.flowMerge': 'Merge',
    'board.run.flowPr': 'Open a PR',
    'board.run.modelLabel': 'Model',
    'board.run.effortLabel': 'Effort',
    'board.run.inheritDefault': 'Default ({value})',
    'board.run.modelCliDefault': 'CLI model',
    'board.run.effortCliDefault': 'CLI effort',
    'board.defaults.label': 'Run defaults',
    'board.defaults.title':
      'Defaults for every task run on this board — each card can override them in its drawer. Completion flow is shared with the team; model / effort / permissions are personal.',
    'board.defaults.cliDefault': 'CLI default',
    'board.defaults.permLabel': 'Permissions',
    'board.detail.restartSession': 'Restart session',
    'board.detail.restartSessionHint':
      'The claude session has ended — restart it to keep working on this task.',
    'board.detail.insertTask': 'Insert task into input',
    'board.detail.insertTaskBusy': 'Inserting…',
    'board.detail.insertTaskHint': 'Pastes the title + content unsent — press Enter to run.',
    'board.detail.insertTaskFailed':
      'Couldn’t insert — the claude session has probably ended. Relaunch it with "Launch Claude", then insert again.',
    'board.detail.insertTaskFailedNetwork':
      'Couldn’t reach the server — check that OPEN GROUND is still running, then insert again.',
    'board.detail.insertTaskTooLarge':
      'The task content is too large to paste — split it into smaller tasks, then insert again.',
    'board.detail.flowBaseDefault': 'the launch branch',
    'board.detail.flowPr': 'On finish: PR → {base} (a human merges)',
    'board.detail.flowPrReview': 'On finish: PR → {base}, card moves to Review (a human merges)',
    'board.detail.isolationNote': 'Works on its own task/ branch in an isolated worktree',
    'board.detail.profileNote': '{mode} · {model}',
    'board.detail.profileModelDefault': 'CLI default model',
    'board.detail.profileTitle':
      'Launch profile for this run — board defaults (the strip above the board) overridden by this card’s run settings',
    'board.detail.flowMerge': 'On finish: merge → {base}',
    'board.detail.titleAutoTitle': 'Auto-generated title — editing it makes it yours',
    'board.detail.regenTitle': 'Regenerate the title from the content (AI)',
    'board.detail.fieldsToggle': 'Show / hide the task fields',
    'board.detail.branchTitle': 'Task branch',
    'board.detail.prStateTitle': 'Pull request',
    'board.detail.tryBranch': 'Open locally',
    'board.detail.tryBranchBusy': 'Checking out…',
    'board.detail.tryBranchTitle': 'Check this branch out into its own worktree and open the folder — review the actual code without touching your working tree',
    'board.detail.tryBranchFailed':
      "Couldn't check out the branch — it may not be pushed yet. Push it from the task's session (or run git push), then retry.",
    'board.detail.tryBranchInvalid':
      "This branch name can't be checked out — check the task's branch name.",
    'board.detail.tryBranchGitFailed':
      "Git couldn't check out the branch — check the repository state (git status), then retry.",
    // Review with claude (F064 — reviewer flow)
    'board.detail.reviewWithClaude': 'Review with claude',
    'board.detail.reviewWithClaudeBusy': 'Preparing review…',
    'board.detail.reviewWithClaudeTitle':
      "Check the branch out into its own worktree and put a diff-review instruction into this card's claude input — nothing is sent until you press Enter",
    'board.detail.reviewWithClaudeFailed':
      "Couldn't prepare the review session — restart the session and retry.",
    // Task terminal (drawer relaunch CTA — shown after the session exits)
    'board.taskTerminal.hint':
      'Launch claude here, then use “Insert task into input” and press Enter.',
  } as Record<string, string>,
  ja: {
    // Columns
    'board.col.todo': '未着手',
    'board.col.todo.hint': '上から優先度順',
    'board.col.doing': '実行中',
    'board.col.review': 'レビュー待ち',
    'board.col.done': '完了',
    'board.col.blocked': '判断待ち',
    'board.col.blocked.hint': 'あなたの判断を待っています — 自動では動きません',
    // Card status
    // Card reason
    // Toolbar
    'board.toolbar.count': 'ボード · {count} カード',
    'board.toolbar.mineOnly': '自分のみ',
    'board.toolbar.mineOnlyNeedsName': '設定で表示名を設定すると、担当者で絞り込めます',
    'board.toolbar.projectSettings': '設定',
    'board.toolbar.clearDone': 'クリア',
    'board.toolbar.clearDoneTitle': '完了列のカードをすべて削除',
    'board.toolbar.clearDoneConfirm':
      'Done のカード {count} 枚を削除します。共有ボードではボード全員に反映されます。',
    // Card
    'board.card.untitled': '無題',
    'board.empty.guide': 'カードを書く → 実行 → ターミナルが走る → 完了でマージ。',
    'board.card.sessionWorking': 'このカードで claude が作業中です',
    'board.card.sessionWorkingLabel': '稼働',
    'board.card.sessionWaitingLabel': '待ち',
    'board.card.sessionWaiting': 'このカードで claude があなたの入力を待っています',
    'board.detail.markDone': '✓ 完了にする',
    'board.detail.markDoneTitle': 'このカードを今すぐ Done へ（ランは終わったのにカードが動かなかった時に）',
    'board.card.markReviewed': 'レビュー済みにする',
    'board.card.markReviewedTitle': 'このカードをあなたがレビュー済みにします（ボード全員に見えます）',
    'board.card.reviewedBy': '{name} がレビュー済み',
    'board.card.reviewedClear': 'クリックでレビュー済みを解除',
    'board.card.merged': 'マージ済み',
    'board.card.mergedTitle': 'このカードのブランチはターゲットブランチへマージ済みです',
    'board.card.mergedToDone': '→ 完了',
    'board.card.mergedToDoneTitle':
      'このカードを完了列へ移動します — ブランチはマージ済み（クリックするまで動きません）',
    'board.card.integrationConflict': '要手動統合',
    'board.card.integrationConflictTitle':
      '自動統合がこのブランチの rebase で衝突したため中止しました（強制マージはしません）。手動で統合してからカードを移動してください。',
    'board.card.managerLabel': '司令官',
    'board.card.workerLabel': '作業者',
    'board.card.managerMissing': '不在',
    // 判断待ちバッジ — このカードを名指しした未回答のエスカレーション。列を問わない
    // （未着手・判断待ちのカードでもあなたを待っていることがある）。読むだけ。
    'board.card.needsYou': 'あなたの判断待ち',
    'board.card.needsYouIrreversible': '取り消せない操作',
    'board.card.needsYouInsufficientInfo': '情報が足りない',
    'board.card.needsYouPolicy': '権限の外',
    // 心拍が途絶えた worker のメモに付く前置き — 「いま」の話ではないと分かるように。
    'board.card.noteStale': '最後の報告:',
    // 盤面の高さでしか言えない事実（どのカードにも結び付かない稼働・質問）。
    'board.swarm.unattributedWorkers': 'カードに結び付かない稼働が{n}件',
    'board.swarm.unattributedQuestions': 'カード外であなたの判断待ちが{n}件',
    // ── ボードのタスク窓口（補給官を下段ドックに座らせたもの）──
    // Swarm タブと同じ卓であって、二人目ではない。卓もレコードも1つ、
    // 駆動するフック（useSupplyDesk）も1つ。
    'board.supply.title': 'タスク窓口',
    'board.supply.open': 'タスク窓口をひらく',
    'board.supply.opening': 'ひらいています…',
    'board.supply.closed': 'タスク窓口はいま閉じています',
    // 監視側の要約。数だけ — 中身はワンクリック先にある。
    'board.supply.rollupWorking': '稼働{n}',
    'board.supply.rollupReview': 'レビュー{n}',
    'board.supply.rollupWaiting': '判断待ち{n}',
    'board.supply.rollupUnknown': '確認中…',
    'board.supply.workersUnknown': 'まだ確認できていません(エンジンから返事がありません)。',
    'board.supply.expand': 'タスク窓口をひらく',
    'board.supply.collapse': 'タスク窓口をとじる',
    'board.supply.stop': '窓口を閉じる',
    'board.supply.stopping': '閉じています…',
    'board.supply.resize': 'ドラッグでタスク窓口の高さを変える',
    'board.supply.workers': 'ワーカー',
    // どのカードの担当か分からない worker にはカード名を出さない（推測で結び付けない）。
    'board.supply.workerNoCard': 'カード未特定',
    'board.supply.noWorkers': 'いま動いているワーカーはありません',
    'board.card.phaseAudit': '調査中',
    'board.card.phaseImplement': '実装中',
    'board.card.phaseVerify': '検証中',
    'board.card.phaseRework': '手直し中',
    'board.card.phaseBlocked': '停滞中',
    'board.card.phaseDone': '完了報告',
    'board.review.managerWorkingTitle':
      '司令官がいま統合作業中です（Swarmタブを開かなくてもここで分かります）。',
    'board.card.untitledParen': '（無題）',
    'board.card.duplicate': 'カードを複製',
    'board.card.duplicateTitle':
      'このカードをすぐ下に複製します — 内容と担当者はコピー、ブランチ・PR・レビュー状態は引き継ぎません',
    'board.card.ariaLabel': '{title} — {column}。Enter で開く',
    // Composer
    'board.composer.placeholder': '＋ カードを追加',
    // Detail drawer. titlePlaceholder は BoardTab のインライン編集が今も使う
    // ため残す（ドロワー自体のタイトル欄は廃止＝タイトルは自動生成）。
    'board.detail.titlePlaceholder': 'このタスクの内容',
    'board.detail.notesLabel': '内容',
    'board.detail.notesPlaceholder':
      'このタスクでやることは？\n画像はドロップ／貼り付けで添付できます。タイトルは実行時に自動生成されます。',
    // Image attachments (B022) — 貼り付け／ドロップのみ（追加ボタンは廃止）。
    'board.detail.attachBusy': '添付中…',
    'board.detail.attachRemove': '画像を削除',
    'board.detail.attachTooLarge': '画像が大きすぎます（最大5MB）',
    'board.detail.attachFailed': '画像を添付できませんでした — もう一度お試しください',
    'board.detail.assigneeLabel': '担当者',
    'board.detail.assigneeAdd': '＋ 追加',
    'board.detail.assigneeAddPlaceholder': '名前',
    'board.detail.assigneeAddConfirm': '追加',
    'board.detail.assigneeAssign': '{name} に割り当て',
    'board.detail.assigneeUnassign': 'クリックで解除',
    'board.detail.dependsLabel': '依存',
    'board.detail.dependsAdd': '＋ 追加',
    'board.detail.dependsPick': 'カードを選ぶ…',
    'board.detail.dependsNone': '依存に追加できるカードがありません',
    'board.detail.dependsRemove': '「{title}」への依存を外す',
    'board.detail.dependsCycleWarn':
      '循環依存です — これらのカードは互いを待ち合うため、swarm は永久に起動しません。どれかの依存を外して循環を断ってください。',
    'board.detail.dueLabel': '期限',
    'board.detail.dueClear': '期限をクリア',
    // 優先度（アプリ内 swarm のディスパッチ順）— ピッカーのラベル + カードのチップ。
    'board.detail.priorityLabel': '優先度',
    'board.detail.priority.urgent': '緊急',
    'board.detail.priority.high': '高',
    'board.detail.priority.normal': '通常',
    'board.detail.priority.low': '低',
    'board.detail.priorityHint': '優先度が高いほど先にディスパッチされます。待たされたカードは自動で上がります。',
    'board.card.priorityTitle': '優先度: {label}',
    'board.card.depsTitle': '先行タスク: {titles}',
    'board.card.cycleTitle':
      '循環依存 — このカードと先行タスクが互いを待ち合うため、swarm は永久に起動しません。ボードで循環を断ってください。',
    'board.card.cycleChip': '循環',
    'board.card.dueTitle': '期限 {date}',
    'board.detail.resizeWidth': 'ドラッグでパネル幅を変更',
    'board.detail.resizeSplit': 'ドラッグでターミナルの高さを変更',
    'board.detail.resizeSplitTitle': 'ドラッグでサイズ変更 · ダブルクリックでターミナル最大化',
    'board.detail.prLabel': 'プルリクエスト',
    'board.detail.optionsLabel': 'オプション',
    'board.run.button': '実行',
    'board.run.buttonBusy': '起動中…',
    'board.run.buttonTitle':
      'claude セッションを起動して、このタスクをすぐに開始します（プロンプトは自動送信されます）',
    'board.run.needsContent': '内容を書くと実行できます。',
    'board.run.hint': '実行するとターミナルが開き、このタスクが自動で始まります。',
    'board.run.missingFolder':
      'プロジェクトフォルダが見つかりません。場所を再設定するまで claude は起動できません。',
    'board.run.failed':
      'claude を起動できませんでした。claude CLI がインストールされ PATH が通っているか（ターミナルで `claude` が動くか）確認して、もう一度実行してください。',
    'board.run.failedClaudeMissing':
      'claude CLI が見つかりません — Claude Code をインストールしてサインインし、OPEN GROUND を再起動してから、もう一度実行してください。',
    'board.run.failedClaudeLoggedOut':
      'Claude にサインインしていません。下のボタンから一度だけサインインしてください（Claude のターミナルが 1 つ開きます。そこでサインインを済ませて、もう一度実行してください）。',
    'board.run.signIn': 'Claude にサインイン',
    'board.run.settingsLabel': '実行設定',
    'board.run.flowLabel': '完了時',
    'board.run.flowMerge': 'マージ',
    'board.run.flowPr': 'PR を作成',
    'board.run.modelLabel': 'モデル',
    'board.run.effortLabel': 'effort',
    'board.run.inheritDefault': 'デフォルト（{value}）',
    'board.run.modelCliDefault': 'CLI 既定',
    'board.run.effortCliDefault': 'CLI 既定',
    'board.defaults.label': '実行デフォルト',
    'board.defaults.title':
      'このボードのタスク実行のデフォルト — 各カードのドロワーで個別に上書きできます。完了フローはチーム共有、モデル / effort / 権限は個人設定です。',
    'board.defaults.cliDefault': 'CLI 既定',
    'board.defaults.permLabel': '権限',
    'board.detail.restartSession': 'セッションを再起動',
    'board.detail.restartSessionHint':
      'claude セッションは終了しています — 再起動するとこのタスクの作業を続けられます。',
    'board.detail.insertTask': 'タスク内容を入力欄へ',
    'board.detail.insertTaskBusy': '挿入中…',
    'board.detail.insertTaskHint': 'タイトルと内容を未送信で貼り付け — Enter で実行が始まります。',
    'board.detail.insertTaskFailed':
      '挿入できませんでした — claude セッションが終了している可能性があります。「Claude を起動」で再起動してから、もう一度挿入してください。',
    'board.detail.insertTaskFailedNetwork':
      'サーバーに接続できませんでした — OPEN GROUND が起動しているか確認して、もう一度挿入してください。',
    'board.detail.insertTaskTooLarge':
      'タスク内容が大きすぎて貼り付けられません — 内容を小さなタスクに分割してから、もう一度挿入してください。',
    'board.detail.flowBaseDefault': '起動時のブランチ',
    'board.detail.flowPr': '完了時: PR → {base}（人間がマージ）',
    'board.detail.flowPrReview': '完了時: PR → {base}、カードはレビュー列へ（人間がマージ）',
    'board.detail.isolationNote': '専用の task/ ブランチ + worktree に隔離して作業',
    'board.detail.profileNote': '{mode} · {model}',
    'board.detail.profileModelDefault': 'CLI 既定モデル',
    'board.detail.profileTitle':
      'この実行の起動プロファイル — ボード上部のデフォルトを、このカードの実行設定が上書きします',
    'board.detail.flowMerge': '完了時: {base} へマージ',
    'board.detail.titleAutoTitle': '自動生成タイトル — 編集すると固定されます',
    'board.detail.regenTitle': '内容からタイトルを再生成（AI）',
    'board.detail.fieldsToggle': 'タスク詳細の表示切替',
    'board.detail.branchTitle': 'タスクブランチ',
    'board.detail.prStateTitle': 'プルリクエスト',
    'board.detail.tryBranch': '手元で開く',
    'board.detail.tryBranchBusy': 'チェックアウト中…',
    'board.detail.tryBranchTitle': 'このブランチを専用 worktree にチェックアウトしてフォルダを開きます — 作業ツリーを汚さずに実コードを確認できます',
    'board.detail.tryBranchFailed':
      'ブランチをチェックアウトできませんでした — まだ push されていない可能性があります。タスクのセッション（または git push）で push してから、もう一度お試しください。',
    'board.detail.tryBranchInvalid':
      'このブランチ名はチェックアウトできません — タスクのブランチ名を確認してください。',
    'board.detail.tryBranchGitFailed':
      'git のチェックアウトに失敗しました — リポジトリの状態（git status）を確認して、もう一度お試しください。',
    // Review with claude (F064 — reviewer flow)
    'board.detail.reviewWithClaude': 'claude とレビュー',
    'board.detail.reviewWithClaudeBusy': 'レビュー準備中…',
    'board.detail.reviewWithClaudeTitle':
      'ブランチを専用 worktree にチェックアウトし、diff レビューの指示をこのカードの claude 入力欄に未送信で挿入します — Enter を押すまで送信されません',
    'board.detail.reviewWithClaudeFailed':
      'レビューセッションを準備できませんでした — セッションを再起動してもう一度お試しください。',
    // Task terminal (drawer relaunch CTA — shown after the session exits)
    'board.taskTerminal.hint':
      'ここで claude を起動し、「タスク内容を入力欄へ」→ Enter で実行します。',
  } as Record<string, string>,
}

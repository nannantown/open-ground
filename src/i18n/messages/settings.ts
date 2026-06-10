// Owned by the Settings drawer. Section headings stay short (English reads fine
// as a label), but every description / option / button follows the active
// language so the panel is never half-translated. English is the source of truth.
export const settings = {
  en: {
    'settings.eyebrow': 'Preferences',
    // Feedback entry
    'settings.feedback.heading': 'Feedback',
    'settings.feedback.body': 'Your feedback shapes OPEN GROUND — we ship updates fast, often within days.',
    'settings.feedback.button': 'Send feedback',
    // Language
    'settings.language.heading': 'Language',
    'settings.language.hint': 'Auto-detected from your system; override it here.',
    // Display name (assignee identity on shared boards)
    'settings.displayName.heading': 'Display name',
    'settings.displayName.hint': 'Used as your assignee name on shared boards.',
    // Notifications
    // Advanced disclosure
    'settings.advanced': 'Advanced',
    // Plan
    // Workspace
    'settings.workspace.heading': 'Default workspace',
    'settings.workspace.hint': 'Where newly created projects are placed. Importing an existing folder works from anywhere.',
    'settings.workspace.browse': 'Browse',
    // Projects registry
    // Claude CLI status
    'settings.cli.heading': 'Claude Code CLI',
    'settings.cli.recheck': 'Re-check',
    'settings.cli.checking': 'Checking for the claude CLI…',
    'settings.cli.hint': 'OPEN GROUND runs your local claude CLI — never an Anthropic API key. Install Claude Code and sign in with an active subscription.',
    // Run prompt
    // Owner inbox
    'settings.inbox.heading': 'Incoming feedback',
    'settings.inbox.refresh': 'Refresh',
    'settings.inbox.loading': 'Loading submissions…',
    'settings.inbox.empty': 'No feedback yet. Submissions show up here, newest first.',
    'settings.inbox.error': "Couldn't load feedback. Is Supabase reachable?",
    'settings.inbox.truncated': 'Showing the newest 200. Older feedback lives in the Supabase table editor.',
  } as Record<string, string>,
  ja: {
    'settings.eyebrow': '環境設定',
    'settings.feedback.heading': 'フィードバック',
    'settings.feedback.body': 'いただいた声が OPEN GROUND を形づくります。数日のうちに反映されることもあります。',
    'settings.feedback.button': 'フィードバックを送る',
    'settings.language.heading': '言語',
    'settings.language.hint': 'システム言語から自動判定します。ここで手動変更できます。',
    'settings.displayName.heading': '表示名',
    'settings.displayName.hint': '共有ボードでの担当者名として使われます。',
    'settings.advanced': '詳細設定',
    'settings.workspace.heading': 'デフォルトの作業フォルダ',
    'settings.workspace.hint': '新規作成したプロジェクトの置き場所です。既存フォルダのインポートはどこからでも可能です。',
    'settings.workspace.browse': '参照',
    'settings.cli.heading': 'Claude Code CLI',
    'settings.cli.recheck': '再チェック',
    'settings.cli.checking': 'claude CLI を確認中…',
    'settings.cli.hint': 'OPEN GROUND はお使いのローカル claude CLI を動かします（Anthropic API キーは使いません）。Claude Code をインストールし、有効なサブスクリプションでサインインしてください。',
    'settings.inbox.heading': '受信したフィードバック',
    'settings.inbox.refresh': '再読み込み',
    'settings.inbox.loading': '送信内容を読み込み中…',
    'settings.inbox.empty': 'まだフィードバックはありません。届くと新しい順にここに表示されます。',
    'settings.inbox.error': 'フィードバックを読み込めませんでした。Supabase に到達できますか？',
    'settings.inbox.truncated': '新しい順に200件まで表示しています。それ以前は Supabase のテーブルエディタで確認できます。',
  } as Record<string, string>,
}

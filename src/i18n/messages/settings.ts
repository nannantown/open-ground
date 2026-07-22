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
    // Experiments (owner-only — hidden unless the server marks you eligible)
    'settings.experiments.heading': 'Experiments',
    'settings.experiments.hint': 'Early, owner-only features. Off by default; not covered by support.',
    'settings.experiments.swarm': 'Swarm orchestration',
    'settings.experiments.swarmHint':
      'Reveals the Swarm tab and its controls for you only — nothing runs on its own. Worker dispatch and the overseer both default off and stay off until you explicitly arm them, and reset to off on every restart. See the manual’s Swarm chapter for the full disclosure.',
    'settings.experiments.sandbox': 'Sandbox Claude (macOS)',
    'settings.experiments.persona': 'Persona',
    'settings.experiments.personaHint':
      'Reveals the Persona tab for you only — a place to read and correct what your stand-in knows about how you decide things. It only reads and writes your own notes on this machine; nothing is shared and nothing runs on its own.',
    'settings.experiments.off': 'Off',
    'settings.experiments.on': 'On',
    // Work mode (lockdown) — the non-Anthropic egress kill switch
    'settings.lockdown.heading': 'Work mode',
    'settings.lockdown.label': 'Block non-Anthropic connections',
    'settings.lockdown.hint':
      'For confidential machines. Turns off everything that talks to a server other than your own Claude: update checks, release notes, feedback, marketplace, sign-in, and shared projects. Your claude CLI keeps working as usual. Turning it off restores everything.',
    'settings.lockdown.badge': 'Work mode is on — connections other than Claude are blocked.',
    // Plan
    // Workspace
    'settings.workspace.heading': 'Default workspace',
    'settings.workspace.hint': 'Where newly created projects are placed. Importing an existing folder works from anywhere.',
    'settings.workspace.browse': 'Browse',
    // Projects registry
    // Claude connection status (passive — reflects `claude auth status`)
    'settings.connection.heading': 'Claude connection',
    'settings.connection.recheck': 'Re-check',
    'settings.connection.checking': 'Checking Claude connection…',
    'settings.connection.connected': 'Connected',
    'settings.connection.plan': 'Claude {plan}',
    'settings.connection.notInstalled': "Claude Code CLI not found. Install Claude Code, then sign in.",
    'settings.connection.notSignedIn': 'Claude Code is installed but not signed in. Run `claude` once and sign in with a paid Claude plan.',
    'settings.connection.hint': 'OPEN GROUND runs your local claude CLI — never an Anthropic API key. This just reflects whether it’s connected; installing Claude is up to you.',
    // Run prompt
    // Release notes
    'settings.releaseNotes.heading': 'Release notes',
    'settings.releaseNotes.loading': 'Loading releases…',
    'settings.releaseNotes.error': "Couldn't load release notes. Check your connection and try again.",
    'settings.releaseNotes.lockdown': 'Disabled while work mode is on.',
    'settings.releaseNotes.current': 'Current',
    // App version (so users can confirm an update actually took effect)
    'settings.version.heading': 'Version',
    // Owner inbox
    'settings.inbox.heading': 'Incoming feedback',
    'settings.inbox.refresh': 'Refresh',
    'settings.inbox.loading': 'Loading submissions…',
    'settings.inbox.empty': 'No feedback yet. Submissions show up here, newest first.',
    'settings.inbox.error': "Couldn't load feedback. Is Supabase reachable?",
    'settings.inbox.truncated': 'Showing the newest 200. Older feedback lives in the Supabase table editor.',
    'settings.inbox.imageAlt': 'Attached image',
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
    'settings.experiments.heading': '実験的機能',
    'settings.experiments.hint': '初期段階のオーナー限定機能です。既定はオフで、サポート対象外です。',
    'settings.experiments.swarm': 'Swarm オーケストレーション',
    'settings.experiments.swarmHint':
      'この端末で Swarm タブと操作を可視化するだけで、それ自体では何も自動実行されません。worker 起動・監督はどちらも既定オフで、あなたが個別に明示オンにするまで動かず、再起動のたびにオフへ戻ります。詳しくはマニュアルの Swarm 章を参照してください。',
    'settings.experiments.sandbox': 'Claude をサンドボックス化 (macOS)',
    'settings.experiments.persona': 'ペルソナ',
    'settings.experiments.personaHint':
      'この端末でペルソナタブを可視化します。あなたの分身が持っている「あなたの決め方」を読み、違っていれば訂正できる場所です。この端末にあるあなた自身の記録を読み書きするだけで、外部には共有されず、それ自体では何も自動実行されません。',
    'settings.experiments.off': 'オフ',
    'settings.experiments.on': 'オン',
    'settings.lockdown.heading': '業務モード',
    'settings.lockdown.label': 'Anthropic 以外の外部通信を遮断',
    'settings.lockdown.hint':
      '機密情報を扱うマシン向け。自分の Claude 以外のサーバーと通信する機能 — アップデート確認・リリースノート・フィードバック・マーケットプレイス・サインイン・共有プロジェクト — をすべて止めます。claude CLI はそのまま使えます。オフに戻せば全機能が復帰します。',
    'settings.lockdown.badge': '業務モード ON — Claude 以外の外部通信を遮断中',
    'settings.workspace.heading': 'デフォルトの作業フォルダ',
    'settings.workspace.hint': '新規作成したプロジェクトの置き場所です。既存フォルダのインポートはどこからでも可能です。',
    'settings.workspace.browse': '参照',
    'settings.connection.heading': 'Claude 接続',
    'settings.connection.recheck': '再チェック',
    'settings.connection.checking': 'Claude 接続を確認中…',
    'settings.connection.connected': '接続済み',
    'settings.connection.plan': 'Claude {plan}',
    'settings.connection.notInstalled': 'Claude Code CLI が見つかりません。Claude Code をインストールしてサインインしてください。',
    'settings.connection.notSignedIn': 'Claude Code はインストール済みですが未サインインです。一度 `claude` を実行し、有料プランでサインインしてください。',
    'settings.connection.hint': 'OPEN GROUND はお使いのローカル claude CLI を動かします（Anthropic API キーは使いません）。これは接続状態を表示するだけで、Claude のインストールはご自身で行ってください。',
    'settings.releaseNotes.heading': 'リリースノート',
    'settings.releaseNotes.loading': 'リリース情報を読み込み中…',
    'settings.releaseNotes.error': 'リリースノートを取得できませんでした。接続を確認して再度開いてください。',
    'settings.releaseNotes.lockdown': '業務モード中は無効です。',
    'settings.releaseNotes.current': '使用中',
    'settings.version.heading': 'バージョン',
    'settings.inbox.heading': '受信したフィードバック',
    'settings.inbox.refresh': '再読み込み',
    'settings.inbox.loading': '送信内容を読み込み中…',
    'settings.inbox.empty': 'まだフィードバックはありません。届くと新しい順にここに表示されます。',
    'settings.inbox.error': 'フィードバックを読み込めませんでした。Supabase に到達できますか？',
    'settings.inbox.truncated': '新しい順に200件まで表示しています。それ以前は Supabase のテーブルエディタで確認できます。',
    'settings.inbox.imageAlt': '添付画像',
  } as Record<string, string>,
}

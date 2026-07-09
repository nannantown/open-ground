// Owned by the Misc translation track (SkillPicker, UsageHud, ProjectCard,
// ProjectCanvas). Add keys as 'misc.*'. English is the source of truth.
export const misc = {
  en: {
    // SkillPicker
    // UsageHud
    'misc.usage.heading': 'Claude usage',
    'misc.usage.session': 'Session',
    'misc.usage.week': 'This week',
    'misc.usage.weekShort': 'wk',
    'misc.usage.resetsAt': 'resets {time}',
    'misc.usage.resetsIn': 'in {rel}',
    'misc.usage.updated': 'Updated {ago}',
    'misc.usage.refresh': 'Refresh now',
    'misc.usage.waiting': 'Reading claude /usage…',
    'misc.usage.justNow': 'just now',
    'misc.usage.minAgo': '{n}m ago',
    'misc.usage.hourAgo': '{n}h ago',
    'misc.usage.live': 'Live from claude /usage — matches claude.ai exactly.',
    // Why the gauge has no live % (shown in place of a silent "—"): an explicit
    // reason, plus the local-jsonl token estimate as a real fallback value.
    'misc.usage.reason.signedOut': 'Sign in to Claude to see your usage %.',
    'misc.usage.reason.notInstalled': "Claude CLI not found — can't read /usage.",
    'misc.usage.reason.scrapeFailed': "Couldn't read claude /usage right now.",
    'misc.usage.localEstimate': 'Local: ≈{tokens} tokens · {hours}h window',
    // EmptyState (Ground, no projects yet)
    'misc.empty.eyebrow': 'New survey',
    'misc.empty.title': 'Begin your atlas.',
    'misc.empty.body':
      'Add your first project — start a fresh folder, or import one you already have. Each becomes a card on the canvas: chat with it, run Claude Code, see where it stands.',
    'misc.empty.manual': 'New here? Read the manual',
    // ProjectCard
    // ProjectCanvas
    // Ground-level project actions (App.tsx confirm/alert dialogs)
    'misc.ground.removeConfirm': 'Remove "{name}" from the Ground? The folder stays on disk.',
    'misc.ground.removeFailed': 'Remove failed: {error}',
    'misc.ground.importFailed': 'Import failed: {error}',
    'misc.ground.locateFailed': 'Locate failed: {error}',
    'misc.ground.saveSettingsFailed': 'Settings could not be saved: {error}',
    // Terminal SSE connection status (TerminalPane / ClaudeTerminalPane). When
    // the output stream drops, the browser auto-reconnects and the next `init`
    // repaints — but a silent frozen screen reads as a hang, so we surface a
    // transient "Reconnecting…" pill (debounced past quick blips) and, if the
    // stream is closed for good, a manual Reconnect.
    'misc.terminal.reconnecting': 'Reconnecting…',
    'misc.terminal.connectionLost': 'Connection lost',
    'misc.terminal.reconnect': 'Reconnect',
  } as Record<string, string>,
  ja: {
    // SkillPicker
    // UsageHud
    'misc.usage.heading': 'Claude 使用量',
    'misc.usage.session': 'セッション',
    'misc.usage.week': '今週',
    'misc.usage.weekShort': '週',
    'misc.usage.resetsAt': '{time} にリセット',
    'misc.usage.resetsIn': 'あと {rel}',
    'misc.usage.updated': '更新: {ago}',
    'misc.usage.refresh': '今すぐ更新',
    'misc.usage.waiting': 'claude /usage を取得中…',
    'misc.usage.justNow': 'たった今',
    'misc.usage.minAgo': '{n}分前',
    'misc.usage.hourAgo': '{n}時間前',
    'misc.usage.live': 'claude /usage の実数（claude.ai と一致）',
    // 使用率が取得できない理由（無言の「—」の代わり）＋ローカル推定の実値
    'misc.usage.reason.signedOut': 'Claude にサインインすると使用率が表示されます。',
    'misc.usage.reason.notInstalled': 'claude CLI が見つかりません（/usage を取得できません）。',
    'misc.usage.reason.scrapeFailed': 'claude /usage を取得できませんでした。',
    'misc.usage.localEstimate': 'ローカル: 約{tokens} トークン · 直近{hours}時間',
    // EmptyState (Ground, no projects yet)
    'misc.empty.eyebrow': '新しい測量',
    'misc.empty.title': 'ここから地図を広げる。',
    'misc.empty.body':
      '最初のプロジェクトを追加しましょう — 新しいフォルダを作るか、既存のフォルダをインポート。それぞれがキャンバス上のカードになり、チャット・Claude Code の実行・現在地の確認ができます。',
    'misc.empty.manual': 'はじめて？ マニュアルを読む',
    // ProjectCard
    // ProjectCanvas
    // Ground-level project actions (App.tsx confirm/alert dialogs)
    'misc.ground.removeConfirm': '「{name}」を Ground から外しますか？フォルダはディスクに残ります。',
    'misc.ground.removeFailed': 'Ground から外せませんでした: {error}',
    'misc.ground.importFailed': 'インポートに失敗しました: {error}',
    'misc.ground.locateFailed': 'フォルダの指定に失敗しました: {error}',
    'misc.ground.saveSettingsFailed': '設定を保存できませんでした: {error}',
    // Terminal SSE connection status (TerminalPane / ClaudeTerminalPane)
    'misc.terminal.reconnecting': '再接続中…',
    'misc.terminal.connectionLost': '接続が切れました',
    'misc.terminal.reconnect': '再接続',
  } as Record<string, string>,
}

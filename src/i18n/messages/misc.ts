// Owned by the Misc translation track (SkillPicker, UsageHud, ProjectCard,
// ProjectCanvas). Add keys as 'misc.*'. English is the source of truth.
export const misc = {
  en: {
    // SkillPicker
    // UsageHud
    'misc.usage.heading': 'Claude usage',
    'misc.usage.session': 'Session',
    'misc.usage.week': 'This week',
    'misc.usage.resetsAt': 'resets {time}',
    'misc.usage.resetsIn': 'in {rel}',
    'misc.usage.updated': 'Updated {ago}',
    'misc.usage.refresh': 'Refresh now',
    'misc.usage.waiting': 'Reading claude /usage…',
    'misc.usage.justNow': 'just now',
    'misc.usage.minAgo': '{n}m ago',
    'misc.usage.hourAgo': '{n}h ago',
    'misc.usage.live': 'Live from claude /usage — matches claude.ai exactly.',
    // EmptyState (Ground, no projects yet)
    'misc.empty.eyebrow': 'New survey',
    'misc.empty.title': 'Begin your atlas.',
    'misc.empty.body':
      'Add your first project — start a fresh folder, or import one you already have. Each becomes a card on the canvas: chat with it, run Claude Code, see where it stands.',
    'misc.empty.cliMissing':
      "The claude CLI wasn't found. OPEN GROUND runs your local Claude Code CLI — install it and sign in with an active Claude subscription before a run.",
    'misc.empty.cliNote': 'Needs the local claude CLI, signed in with a Claude subscription.',
    // ProjectCard
    // ProjectCanvas
    // Ground-level project actions (App.tsx confirm/alert dialogs)
    'misc.ground.removeConfirm': 'Remove "{name}" from the Ground? The folder stays on disk.',
    'misc.ground.removeFailed': 'Remove failed: {error}',
    'misc.ground.importFailed': 'Import failed: {error}',
    'misc.ground.locateFailed': 'Locate failed: {error}',
  } as Record<string, string>,
  ja: {
    // SkillPicker
    // UsageHud
    'misc.usage.heading': 'Claude 使用量',
    'misc.usage.session': 'セッション',
    'misc.usage.week': '今週',
    'misc.usage.resetsAt': '{time} にリセット',
    'misc.usage.resetsIn': 'あと {rel}',
    'misc.usage.updated': '更新: {ago}',
    'misc.usage.refresh': '今すぐ更新',
    'misc.usage.waiting': 'claude /usage を取得中…',
    'misc.usage.justNow': 'たった今',
    'misc.usage.minAgo': '{n}分前',
    'misc.usage.hourAgo': '{n}時間前',
    'misc.usage.live': 'claude /usage の実数（claude.ai と一致）',
    // EmptyState (Ground, no projects yet)
    'misc.empty.eyebrow': '新しい測量',
    'misc.empty.title': 'ここから地図を広げる。',
    'misc.empty.body':
      '最初のプロジェクトを追加しましょう — 新しいフォルダを作るか、既存のフォルダをインポート。それぞれがキャンバス上のカードになり、チャット・Claude Code の実行・現在地の確認ができます。',
    'misc.empty.cliMissing':
      'claude CLI が見つかりませんでした。OPEN GROUND はお使いのローカル Claude Code CLI を動かします。実行前にインストールし、有効な Claude サブスクリプションでサインインしてください。',
    'misc.empty.cliNote': 'ローカルの claude CLI（Claude サブスクでサインイン済み）が必要です。',
    // ProjectCard
    // ProjectCanvas
    // Ground-level project actions (App.tsx confirm/alert dialogs)
    'misc.ground.removeConfirm': '「{name}」を Ground から外しますか？フォルダはディスクに残ります。',
    'misc.ground.removeFailed': 'Ground から外せませんでした: {error}',
    'misc.ground.importFailed': 'インポートに失敗しました: {error}',
    'misc.ground.locateFailed': 'フォルダの指定に失敗しました: {error}',
  } as Record<string, string>,
}

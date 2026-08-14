// Owned by the Toolbar/Settings translation track (incl. the EN/JA language
// toggle labels). Add keys as 'toolbar.*'. English is the source of truth.
export const toolbar = {
  en: {
    'toolbar.add': 'Add project',
    // Concise visible label for the pill button; `toolbar.add` stays the tooltip.
    'toolbar.addLabel': 'Add',
    'toolbar.newProject': 'New project',
    'toolbar.importFolder': 'Import folder',
    'toolbar.refresh': 'Refresh',
    'toolbar.sendFeedback': 'Send feedback',
    'toolbar.feedback': 'Feedback',
    'toolbar.signIn': 'Sign in',
    'toolbar.signOut': 'Sign out',
    'toolbar.account': 'Account',
    'toolbar.settings': 'Settings',
    'toolbar.settingsWithUnread': 'Settings ({count} new feedback)',
    'toolbar.manual': 'Manual',
    'toolbar.skills': 'Skills',
    // Persona — the Ground entry to the owner's stand-in (owner-only; the entry
    // is absent unless the persona or swarm experiment is open). `persona` is
    // the permanent button label, `personaTooltip` the hover, which is where the
    // "what is this" lives since the label is one word.
    'toolbar.persona': 'Persona',
    'toolbar.personaTooltip': 'Persona — what your stand-in knows about how you decide',
    'toolbar.themeDark': 'Switch to dark mode',
    'toolbar.themeLight': 'Switch to light mode',
    'toolbar.sharedWithMe': 'Shared with me',
    // Visible label on the toolbar Join entry; `sharedWithMe` stays the tooltip.
    'toolbar.joinShared': 'Join shared',
    'toolbar.language': 'Language',
    'toolbar.langEn': 'EN',
    'toolbar.langJa': 'JA',
    'toolbar.betaTooltip': 'Beta — breaking changes may still land.',
  } as Record<string, string>,
  ja: {
    'toolbar.add': 'プロジェクトを追加',
    'toolbar.addLabel': '追加',
    'toolbar.newProject': '新規プロジェクト',
    'toolbar.importFolder': 'フォルダをインポート',
    'toolbar.refresh': '再読み込み',
    'toolbar.sendFeedback': 'フィードバックを送る',
    'toolbar.feedback': 'フィードバック',
    'toolbar.signIn': 'サインイン',
    'toolbar.signOut': 'サインアウト',
    'toolbar.account': 'アカウント',
    'toolbar.settings': '設定',
    'toolbar.settingsWithUnread': '設定（新着フィードバック {count} 件）',
    'toolbar.manual': 'マニュアル',
    'toolbar.skills': 'スキル',
    'toolbar.persona': 'ペルソナ',
    'toolbar.personaTooltip': 'ペルソナ — 分身が持っている「あなたの決め方」',
    'toolbar.themeDark': 'ダークモードに切り替え',
    'toolbar.themeLight': 'ライトモードに切り替え',
    'toolbar.sharedWithMe': '共有プロジェクト',
    'toolbar.joinShared': '共有に参加',
    'toolbar.language': '言語',
    'toolbar.langEn': 'EN',
    'toolbar.langJa': 'JA',
    'toolbar.betaTooltip': 'ベータ版です。今後、破壊的な変更が入る可能性があります。',
  } as Record<string, string>,
}

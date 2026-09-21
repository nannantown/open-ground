// Owned by the custom-tabs track (docs/CUSTOM_TABS_PLAN.md). Add keys as
// 'customTabs.*'. English is the source of truth; keep `en` and `ja` key sets
// identical.
export const customTabs = {
  en: {
    // Tab bar affordances
    'customTabs.addTab': 'Add tab',
    'customTabs.addTabHint': 'Add a custom tab to this project (pick from your library or create one)',
    // "+" picker dialog (per-project attachment)
    'customTabs.pickerLabel': 'Custom tabs',
    'customTabs.pickerTitle': 'Add a tab to this project',
    'customTabs.pickerExplain': 'Your library. Attaching is per project — a tab appears in this project’s tab row only after you add it here.',
    'customTabs.pickerEmpty': 'No tabs yet.',
    'customTabs.pickerAttached': 'Added',
    'customTabs.pickerCreateNew': 'Create a new tab',
    // Picker ledger section heads + the Built-in (native) show/hide section.
    'customTabs.pickerLegendIndex': 'Library',
    'customTabs.pickerLegendState': 'State',
    'customTabs.builtinSection': 'Built-in',
    'customTabs.shown': 'Shown',
    'customTabs.hidden': 'Hidden',
    'customTabs.showModule': 'Show in this project',
    'customTabs.hideModule': 'Hide from this project',
    'customTabs.lastModuleHint': 'Keep at least one tab visible.',
    // Create dialog
    'customTabs.createLabel': 'New custom tab',
    'customTabs.createTitle': 'Create a custom tab',
    'customTabs.createExplain': 'Name the tab and describe what it should show. claude opens beside the new tab to generate the component — review the prompt and press Enter to start.',
    'customTabs.createName': 'Name',
    'customTabs.createNamePlaceholder': 'e.g. Release checklist',
    'customTabs.createDescription': 'What should it show?',
    'customTabs.createDescriptionPlaceholder': 'Describe the tab’s content and behavior…',
    'customTabs.create': 'Create',
    'customTabs.creating': 'Creating…',
    'customTabs.createFailed': 'Couldn’t create the tab: {error}',
    'customTabs.createNameRequired': 'Enter a name (1–60 characters).',
    'customTabs.publishedBadge': 'v{version}',
    // Tab-row right-click menu (non-destructive detach) + the picker's
    // library-level destruction (two-step confirm inside the picker)
    'customTabs.detach': 'Remove from tab row',
    'customTabs.disableModule': 'Hide from tab row',
    'customTabs.delete': 'Delete',
    'customTabs.deleteConfirmYes': 'Delete tab',
    'customTabs.uninstall': 'Uninstall',
    'customTabs.uninstallConfirmYes': 'Uninstall tab',
    'customTabs.sourceLoadFailed': 'Couldn’t load this tab’s component. The module may have been removed — try reopening the project.',
    'customTabs.sourceLoading': 'Loading…',
    // Sidebar (claude PTY in the module dir)
    'customTabs.sidebarHint': 'claude runs in this tab’s module folder — ask it to edit source.tsx and the preview reloads on every save.',
    'customTabs.launchFailed': 'Couldn’t launch claude — check the server is running, then try again.',
    'customTabs.claudeNotFound': 'claude CLI not found — install Claude Code, then restart OPEN GROUND.',
    'customTabs.installed': 'Installed',
  },
  ja: {
    // Tab bar affordances
    'customTabs.addTab': 'タブを追加',
    'customTabs.addTabHint': 'このプロジェクトにカスタムタブを追加（ライブラリから選ぶ・新規作成）',
    // "+" picker dialog (per-project attachment)
    'customTabs.pickerLabel': 'カスタムタブ',
    'customTabs.pickerTitle': 'このプロジェクトにタブを追加',
    'customTabs.pickerExplain': 'あなたのライブラリです。タブはプロジェクトごとに追加します — ここで追加したタブだけが、このプロジェクトのタブ列に表示されます。',
    'customTabs.pickerEmpty': 'まだタブがありません。',
    'customTabs.pickerAttached': '追加済み',
    'customTabs.pickerCreateNew': '新規タブを作成',
    // Picker ledger section heads + the Built-in (native) show/hide section.
    'customTabs.pickerLegendIndex': 'ライブラリ',
    'customTabs.pickerLegendState': '状態',
    'customTabs.builtinSection': '標準タブ',
    'customTabs.shown': '表示中',
    'customTabs.hidden': '非表示',
    'customTabs.showModule': 'このプロジェクトで表示',
    'customTabs.hideModule': 'このプロジェクトで非表示',
    'customTabs.lastModuleHint': '最低1つのタブは表示しておく必要があります。',
    // Create dialog
    'customTabs.createLabel': '新しいカスタムタブ',
    'customTabs.createTitle': 'カスタムタブを作成',
    'customTabs.createExplain': 'タブの名前と、表示したい内容を書いてください。作成すると新しいタブの横で claude が起動し、コンポーネント生成のプロンプトが入力欄に未送信で入ります — 確認して Enter で開始します。',
    'customTabs.createName': '名前',
    'customTabs.createNamePlaceholder': '例: リリースチェックリスト',
    'customTabs.createDescription': '何を表示しますか？',
    'customTabs.createDescriptionPlaceholder': 'タブの内容や動作を書いてください…',
    'customTabs.create': '作成',
    'customTabs.creating': '作成中…',
    'customTabs.createFailed': 'タブを作成できませんでした: {error}',
    'customTabs.createNameRequired': '名前を入力してください（1〜60文字）。',
    'customTabs.publishedBadge': 'v{version}',
    // Tab-row right-click menu (non-destructive detach) + the picker's
    // library-level destruction (two-step confirm inside the picker)
    'customTabs.detach': 'タブの列から外す',
    'customTabs.disableModule': 'タブの列から隠す',
    'customTabs.delete': '削除',
    'customTabs.deleteConfirmYes': '本当に削除する',
    'customTabs.uninstall': 'アンインストール',
    'customTabs.uninstallConfirmYes': '本当にアンインストールする',
    'customTabs.sourceLoadFailed': 'このタブのコンポーネントを読み込めませんでした。モジュールが削除された可能性があります — プロジェクトを開き直してください。',
    'customTabs.sourceLoading': '読み込み中…',
    // Sidebar (claude PTY in the module dir)
    'customTabs.sidebarHint': 'claude はこのタブのモジュールフォルダで動いています — source.tsx の編集を頼むと、保存のたびにプレビューがリロードされます。',
    'customTabs.launchFailed': 'claude を起動できませんでした — サーバの起動を確認して、もう一度試してください。',
    'customTabs.claudeNotFound': 'claude CLI が見つかりません — Claude Code をインストールして OPEN GROUND を再起動してください。',
    'customTabs.installed': 'インストール済み',
  },
}

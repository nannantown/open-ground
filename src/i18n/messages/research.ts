// Owned by the per-project Research tab (src/components/canvas/modules/
// ResearchModule.tsx). Add keys as 'research.*'. English is the source of
// truth. The two locales are deliberately NOT literal translations — each is
// written to read naturally on its own.
//
// `research.tabLabel` is the ONE key that names the tab everywhere (row + "+"
// picker, via TabDef.labelKey) — renaming the tab is a two-line edit here.
export const research = {
  en: {
    'research.tabLabel': 'Research',

    // --- Empty state (no reports yet): what this tab is, and how to feed it --
    'research.empty.title': 'No research yet',
    'research.empty.how':
      'Ask for research on the Board — file a card like "Look into how people talk about X" and run it. The report lands here when the work is merged.',
    'research.empty.channels':
      'What the researcher can reach is listed in Settings → Research channels.',

    // --- Report list + reader -----------------------------------------------
    'research.list.heading': 'Reports',
    'research.reload': 'Reload',
    'research.copy': 'Copy markdown',
    'research.copied': 'Copied',
    'research.select': 'Choose a report on the left.',
    'research.loadError': "Couldn't load this report.",

    // ── Knowledge layer (digest + Q&A + read-aloud) ──
    'research.digest.heading': 'Key points',
    'research.digest.make': 'Distill key points',
    'research.digest.remake': 'Redo',
    'research.digest.working': 'Distilling\u2026 {seconds}s',
    'research.digest.failed': "Couldn't distill this report.",
    'research.digest.retry': 'Try again',
    'research.digest.note': 'AI-extracted from this report \u2014 the full text is below.',
    'research.digest.stale':
      'The report has changed \u2014 these points came from an earlier version.',
    'research.digest.speak': 'Read aloud',
    'research.digest.speakStop': 'Stop',
    'research.qa.heading': 'Questions',
    'research.qa.placeholder': 'Ask this report\u2026',
    'research.qa.empty': 'No questions yet.',
    'research.qa.working': 'Answering\u2026 {seconds}s',
    'research.qa.failed': "Couldn't answer this one.",
    'research.qa.retry': 'Ask again',
    'research.qa.collapse': 'Minimize',
    'research.qa.expand': 'Expand',
    'research.knowledge.claudeMissing': 'The `claude` command was not found on this machine.',
    'research.knowledge.claudeLoggedOut': 'Your `claude` is signed out. Sign in and try again.',
    'research.fulltext': 'Full text',
  } as Record<string, string>,
  ja: {
    // Deliberately ENGLISH in the ja locale too — the tab strip is a row of
    // English wordmarks (BOARD / SWARM / CANVAS / TERMINAL), and 「調査」 sat in
    // it as the one Japanese label (owner, 2026-08-18: 「他のタブは日本語設定でも
    // 英語なので英語にしよう」). Everything INSIDE the tab stays Japanese.
    'research.tabLabel': 'Research',

    'research.empty.title': 'まだ調査レポートはありません',
    'research.empty.how':
      'Boardに「◯◎の評判を調べて」のようなカードを積んで実行すると、調査レポートが完成後ここに並びます。',
    'research.empty.channels':
      '調査がどこまで見に行けるかは「設定 → 調査チャンネル」で確認できます。',

    'research.list.heading': 'レポート',
    'research.reload': '再読み込み',
    'research.copy': 'Markdownをコピー',
    'research.copied': 'コピーしました',
    'research.select': '左の一覧からレポートを選んでください。',
    'research.loadError': 'レポートを読み込めませんでした。',

    // ── ナレッジ層(要点・質問・読み上げ) ──
    'research.digest.heading': '要点',
    'research.digest.make': '要点を作る',
    'research.digest.remake': '作り直す',
    'research.digest.working': '抜き出しています… {seconds}秒',
    'research.digest.failed': '要点を作れませんでした。',
    'research.digest.retry': 'もう一度',
    'research.digest.note': 'この要点は AI がレポートから抜き出したものです。全文は下にあります。',
    'research.digest.stale': 'レポートが更新されています — この要点は前の版から作られました。',
    'research.digest.speak': '読み上げ',
    'research.digest.speakStop': '停止',
    'research.qa.heading': '質問',
    'research.qa.placeholder': 'このレポートに質問…',
    'research.qa.empty': '質問はまだありません。',
    'research.qa.working': '答えています… {seconds}秒',
    'research.qa.failed': '答えられませんでした。',
    'research.qa.retry': 'もう一度きく',
    'research.qa.collapse': 'たたむ',
    'research.qa.expand': 'ひらく',
    'research.knowledge.claudeMissing': 'このパソコンで `claude` が見つかりませんでした。',
    'research.knowledge.claudeLoggedOut': '`claude` がサインアウトしています。サインインしてからお試しください。',
    'research.fulltext': '全文',
  } as Record<string, string>,
}

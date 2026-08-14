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
  } as Record<string, string>,
  ja: {
    'research.tabLabel': '調査',

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
  } as Record<string, string>,
}

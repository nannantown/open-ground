// Owned by the Screen track (screenSrcdoc runtime-rendered strings, if any are
// user-facing). Add keys as 'screen.*'. English is the source of truth.
export const screen = {
  en: {
    'screen.starter.heading': 'New screen',
    'screen.starter.body':
      'Double-click to edit the source, or ask Claude in Canvas chat to "make this screen into …". Tailwind and the project tokens (bg-bg-card / text-ink / accent / moss / azure) plus lucide-react all work out of the box.',
    'screen.starter.htmlBody': 'Double-click to edit the HTML.',
    // srcdoc iframes (mock / screen / custom tab) while work mode blocks
    // their external-CDN runtime — the explicit placeholder, never a silent
    // blank frame.
    'srcdoc.lockdown.title': 'Blocked by work mode',
    'srcdoc.lockdown.body':
      'This element loads its runtime from an external CDN (unpkg / tailwindcss), which work mode blocks. Turn work mode off in Settings to render it.',
  } as Record<string, string>,
  ja: {
    'screen.starter.heading': '新しい画面',
    'screen.starter.body':
      'ダブルクリックでソースを編集、または Canvas チャットで Claude に「この画面を◯◯にして」と頼んでください。Tailwind と project tokens（bg-bg-card / text-ink / accent / moss / azure）、lucide-react がそのまま使えます。',
    'screen.starter.htmlBody': 'ダブルクリックで HTML を編集できます。',
    'srcdoc.lockdown.title': '業務モードによりブロック中',
    'srcdoc.lockdown.body':
      'この要素は外部 CDN（unpkg / tailwindcss）からランタイムを読み込むため、業務モード中は描画されません。描画するには Settings で業務モードを OFF にしてください。',
  } as Record<string, string>,
}

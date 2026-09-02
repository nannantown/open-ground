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
    'research.blog.send': 'Send to blog',
    'research.blog.sending': 'Sending…',
    'research.blog.sendTitle': 'Create a DRAFT of this report on your WordPress site (publishing stays on the WP side)',
    'research.blog.openDraft': 'Open the blog draft',
    'research.blog.notConfigured': 'Connect WordPress in Settings first',
    'research.blog.lockdown': 'Unavailable in work mode',
    'research.blog.sendFailed': 'Could not send — try again',
    'research.blog.draft': 'Draft on blog',
    'research.blog.editedOnWp': 'Edited on WordPress — auto-update stopped',
    'research.blog.deletedOnWp': 'Deleted on WordPress — not re-posted',
    'research.blog.failed': 'Blog post failed',
    'research.blog.reason.auth':
      'WordPress rejected the login (401). Check the username and the application password — and on shared hosting the Authorization header is often stripped by the server; ask your host, or add the .htaccess rule for application passwords.',
    'research.blog.reason.forbidden':
      'WordPress refused the request (403). A security plugin or the host may be blocking the REST API, or the user cannot create posts.',
    'research.blog.reason.notFound':
      'The posts endpoint was not found (404). Check the site URL: opening <site>/wp-json/wp/v2/posts in a browser should show JSON. If WordPress lives in a subfolder (e.g. /wp), include it.',
    'research.blog.reason.network':
      'Could not reach the site. Check the URL, your connection, and that the site is up (https required).',
    'research.blog.reason.server':
      'The site answered with an error (5xx) — a broken plugin or PHP error on the WordPress side. Open the WordPress admin to check.',
    'research.blog.reason.other': 'The blog post failed. Detail:',
    'research.blog.reason.detail': 'Detail',
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
    'research.blog.send': 'ブログへ',
    'research.blog.sending': '送信中…',
    'research.blog.sendTitle': 'このレポートを WordPress に下書きとして送ります（公開は WordPress 側で押します）',
    'research.blog.openDraft': 'ブログの下書きを開く',
    'research.blog.notConfigured': '先に設定で WordPress を接続してください',
    'research.blog.lockdown': '業務モード中は使えません',
    'research.blog.sendFailed': '送信できませんでした — もう一度お試しください',
    'research.blog.draft': 'ブログ下書きあり',
    'research.blog.editedOnWp': 'WordPress側で編集済み（自動更新停止）',
    'research.blog.deletedOnWp': 'WordPress側で削除済み（再投稿しません）',
    'research.blog.failed': 'ブログ投稿に失敗',
    'research.blog.reason.auth':
      'WordPress にログインを拒否されました(401)。ユーザー名とアプリケーションパスワードを確認してください。共有サーバーでは認証ヘッダーがサーバー側で削られることがよくあります(ホスティング会社に確認するか、アプリケーションパスワード用の .htaccess 設定を追加)。',
    'research.blog.reason.forbidden':
      'WordPress に拒否されました(403)。セキュリティプラグインやサーバーが REST API を止めているか、このユーザーに投稿権限がありません。',
    'research.blog.reason.notFound':
      '投稿先が見つかりません(404)。サイトURLを確認してください: ブラウザで <サイト>/wp-json/wp/v2/posts を開くと JSON が出るはずです。WordPress がサブフォルダ(例 /wp)にある場合はそこまで含めます。',
    'research.blog.reason.network':
      'サイトに接続できませんでした。URL・ネット接続・サイトが起動しているか(https 必須)を確認してください。',
    'research.blog.reason.server':
      'サイト側がエラーを返しました(5xx)。WordPress 側のプラグイン不具合や PHP エラーです。WordPress の管理画面を開いて確認してください。',
    'research.blog.reason.other': 'ブログ投稿に失敗しました。詳細:',
    'research.blog.reason.detail': '詳細',
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

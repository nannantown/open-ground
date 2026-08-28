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
      'Reveals the Persona entry in the top toolbar for you only — a place to read and correct what your stand-in knows about how you decide things. It only reads and writes your own notes on this machine; nothing is shared and nothing runs on its own. Turning Swarm on also reveals it, so the entry can be there with this switch off.',
    'settings.experiments.off': 'Off',
    'settings.experiments.on': 'On',
    // Public swarm opt-in (all users, macOS only) — "still being tuned"
    'settings.swarmOptIn.heading': 'Swarm (experimental)',
    'settings.swarmOptIn.hint': 'Still being tuned. Off by default — turn it on only if you want it.',
    'settings.swarmOptIn.label': 'Enable the Swarm tab',
    'settings.swarmOptIn.warning':
      'Swarm runs autonomous Claude workers for you. Before turning it on, know: it uses your own Claude subscription and can run several sessions at once, so it may consume your quota heavily; workers run Claude with tool-permission prompts skipped, inside isolated copies of your project; and its notifications are currently in Japanese only. It is still being tuned and is not covered by support.',
    'settings.personaOptIn.heading': 'Persona (experimental)',
    'settings.personaOptIn.hint': 'Still being tuned. Off by default — turn it on only if you want it.',
    'settings.personaOptIn.label': 'Enable the Persona screen',
    'settings.personaOptIn.warning':
      'Persona builds a private picture of you from your own conversations, to help you understand yourself. Before turning it on, know: everything stays on this machine (your own corpus, never shared); each turn spends your own Claude subscription; and a turn runs Claude with tool-permission prompts skipped, inside a locked-down scratch session. It is still being tuned and is not covered by support.',
    // Completion chime (settings.soundOnDone / soundOnDoneVolume)
    'settings.wordpress.heading': 'Blog publishing (WordPress)',
    'settings.wordpress.hint':
      'Research reports are mirrored to your own WordPress site as DRAFTS — publishing stays a button you press on the WP side. Filling this in turns the sync on; Disconnect turns it off. A draft you edit or delete on WordPress is never overwritten or re-posted. Self-hosted WordPress only (a site whose admin lives at your-domain/wp-admin) — wordpress.com-hosted sites are not supported.',
    'settings.wordpress.baseUrl': 'Site URL',
    'settings.wordpress.username': 'Username',
    'settings.wordpress.appPassword': 'Application password',
    'settings.wordpress.appPasswordHint':
      'WP admin → Users → Profile → Application Passwords. Not your login password — revocable there at any time.',
    'settings.wordpress.save': 'Save',
    'settings.wordpress.saved': 'Connected',
    'settings.wordpress.clear': 'Disconnect',
    'settings.wordpress.invalid': 'Fill in all three fields; the URL must start with https://',
    'settings.sound.heading': 'Completion sound',
    'settings.sound.label': 'Play a sound when Claude finishes',
    'settings.sound.hint':
      'Rings once when a Claude session you are watching finishes its turn — terminal panes and board runs. Swarm workers stay silent.',
    'settings.sound.volume': 'Volume',
    'settings.sound.test': 'Test',
    // Hands-free updates (settings.autoUpdate)
    'settings.autoUpdate.heading': 'Automatic updates',
    'settings.autoUpdate.label': 'Apply updates automatically',
    // ⚠ This copy was WRONG on both halves until 2026-08-04 and has to stay
    // honest, because the setting's whole value is that you can trust it while
    // not looking. It said "no more restart dialogs" — but ON also removed the
    // only notice that always worked, so ON delivered updates LESS reliably
    // than OFF. And it promised to wait "while a terminal pane is open", which
    // is why it waited forever: an empty shell counted as work.
    'settings.autoUpdate.hint':
      'New versions install themselves while you are away — nothing interrupts you, and you are still told an update is waiting so you can take it now. It waits for real work: Claude generating, and any terminal pane with something running in it. A pane sitting empty at the prompt does not hold it up. Quitting the app also applies a waiting update.',
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
    // Research channels (Settings → Research channels; GET /api/research/channels)
    'settings.research.heading': 'Research channels',
    'settings.research.hint':
      'Sources the swarm can draw on when you ask it to research something. Web pages work out of the box; the hints below unlock more. All checks run on this computer only.',
    'settings.research.recheck': 'Re-check',
    'settings.research.status.ok': 'Ready',
    'settings.research.status.part': 'Partly ready',
    'settings.research.status.miss': 'Not set up',
    'settings.research.copy': 'Copy command',
    'settings.research.copied': 'Copied',
    'settings.research.copyHint': 'Paste it into any terminal and press Enter.',
    'settings.research.web.name': 'Web pages',
    'settings.research.web.state.ready': 'Any public page can be read as clean text.',
    'settings.research.web.state.no-curl': 'curl is missing — install it to enable web reading.',
    'settings.research.websearch.name': 'Web search',
    'settings.research.websearch.state.ready': 'Searches the web through Exa.',
    'settings.research.websearch.state.missing': 'Install mcporter to enable web search.',
    'settings.research.twitter.name': 'X (Twitter)',
    'settings.research.twitter.state.full': 'Signed in — single posts and search both work.',
    'settings.research.twitter.state.bin-only':
      'Single posts work now; add your cookies below to unlock search and timelines.',
    'settings.research.twitter.state.missing':
      'Needs the twitter-cli tool — copy the command below to install it (cookies come after).',
    'settings.research.twitter.state.cookies-only':
      'Your cookies are saved. One step left: install twitter-cli with the command below, and posts and search both start working.',
    'settings.research.reddit.name': 'Reddit',
    'settings.research.reddit.state.cli': 'The rdt tool is installed; sign-in is confirmed the first time a search runs.',
    'settings.research.reddit.state.baseline': 'Public posts are readable as-is; the rdt tool adds signed-in features.',
    'settings.research.reddit.state.unreachable': 'curl is missing, so Reddit cannot be reached.',
    'settings.research.youtube.name': 'YouTube',
    'settings.research.youtube.state.ready': 'Reads subtitles, so videos can be digested without watching them.',
    'settings.research.youtube.state.missing': 'Install yt-dlp to enable video digests.',
    'settings.research.github.name': 'GitHub',
    'settings.research.github.state.cli': 'The gh tool is installed — search included.',
    'settings.research.github.state.baseline': 'Public repositories are readable as-is; the gh tool adds search.',
    'settings.research.github.state.unreachable': 'curl is missing, so GitHub cannot be reached.',
    'settings.research.rss.name': 'RSS feeds',
    'settings.research.rss.state.full': 'Feeds are parsed with feedparser.',
    'settings.research.rss.state.no-feedparser': 'Feeds are readable; installing feedparser makes parsing sturdier.',
    'settings.research.rss.state.baseline': 'Feeds are fetched and read directly.',
    'settings.research.rss.state.unreachable': 'curl is missing, so feeds cannot be fetched.',
    // X cookies (advanced) — the local-only promise here must stay true to
    // researchAuth.ts (values never leave the machine, never echoed back).
    'settings.research.x.disclosure': 'Use X search (advanced)',
    'settings.research.x.tos':
      "This route reads X through your own signed-in browser session, outside X's official API terms. Use it at your own discretion.",
    'settings.research.x.promise':
      'Both values stay on this computer. They are never uploaded, never shown back, and are handed only to the research tools running here.',
    'settings.research.x.howto':
      'In the browser where you are signed in to X: open x.com, press F12, go to Application → Cookies → x.com, and copy the values of auth_token and ct0.',
    'settings.research.x.save': 'Save',
    'settings.research.x.clear': 'Remove',
    'settings.research.x.saved': 'Cookies saved — X search will be available to new research runs.',
    'settings.research.x.error': "Couldn't save. Enter both values (or leave both empty to remove).",
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
      'この端末で上部ツールバーに「ペルソナ」の入口を出します。あなたの分身が持っている「あなたの決め方」を読み、違っていれば訂正できる場所です。この端末にあるあなた自身の記録を読み書きするだけで、外部には共有されず、それ自体では何も自動実行されません。なお Swarm をオンにすると同じ入口が出るため、このスイッチがオフでも入口が見えていることがあります。',
    'settings.experiments.off': 'オフ',
    'settings.experiments.on': 'オン',
    'settings.swarmOptIn.heading': 'Swarm(試験運用)',
    'settings.swarmOptIn.hint': 'まだ調整中です。既定はオフ — 使いたい場合だけオンにしてください。',
    'settings.swarmOptIn.label': 'Swarm タブを有効にする',
    'settings.swarmOptIn.warning':
      'Swarm はあなたの代わりに自律的な Claude ワーカーを走らせます。オンにする前に確認してください: あなた自身の Claude サブスクを使い、複数セッションを同時に走らせることがあるため、消費が大きくなる場合があります。ワーカーはツールの許可確認をスキップした Claude を、プロジェクトの隔離コピーの中で実行します。通知は当面日本語のみです。まだ調整中で、サポート対象外です。',
    'settings.personaOptIn.heading': 'ペルソナ(試験運用)',
    'settings.personaOptIn.hint': 'まだ調整中です。既定はオフ — 使いたい場合だけオンにしてください。',
    'settings.personaOptIn.label': 'ペルソナ画面を有効にする',
    'settings.personaOptIn.warning':
      'ペルソナは、あなた自身の会話からあなた像を組み立て、自己理解を助けます。オンにする前に確認してください: すべてこのパソコンの中だけに保存されます(あなた自身のコーパスで、外には出ません)。1ターンごとにあなた自身の Claude サブスクを使います。1ターンはツールの許可確認をスキップした Claude を、隔離されたスクラッチセッションの中で実行します。まだ調整中で、サポート対象外です。',
    'settings.wordpress.heading': 'ブログ投稿 (WordPress)',
    'settings.wordpress.hint':
      '調査レポートを自分の WordPress サイトへ下書きとして自動で送ります。公開は WordPress 側であなたが押します。この欄を埋める＝オン、解除＝オフ。WordPress 側で編集・削除した下書きには二度と触りません。対象は自分でインストールした WordPress のみ（管理画面が 自分のドメイン/wp-admin にあるタイプ）。wordpress.com のサイトは対象外です。',
    'settings.wordpress.baseUrl': 'サイトURL',
    'settings.wordpress.username': 'ユーザー名',
    'settings.wordpress.appPassword': 'アプリケーションパスワード',
    'settings.wordpress.appPasswordHint':
      'WordPress 管理画面 → ユーザー → プロフィール → アプリケーションパスワードで発行。ログインパスワードではありません（いつでも無効化できます）。',
    'settings.wordpress.save': '保存',
    'settings.wordpress.saved': '設定済み',
    'settings.wordpress.clear': '解除',
    'settings.wordpress.invalid': '3つとも入力してください。URL は https:// で始まる必要があります',
    'settings.sound.heading': '完了音',
    'settings.sound.label': 'Claude の命令が終わったら音を鳴らす',
    'settings.sound.hint':
      'あなたが見ている Claude（ターミナルのペインやボード実行）が返事を書き終えたときに1回鳴ります。swarm の worker は鳴りません。',
    'settings.sound.volume': '音量',
    'settings.sound.test': '試聴',
    'settings.autoUpdate.heading': '自動アップデート',
    'settings.autoUpdate.label': '新しい版を自動で適用する',
    'settings.autoUpdate.hint':
      '席を外しているあいだに、新しい版へ自動で入れ替えます。作業は邪魔しませんが、更新が待っていることはお知らせするので、今すぐ入れることもできます。待つのは本当に作業がある場合だけ — Claude が生成中のときと、中で何かが走っているターミナルです。プロンプトのまま放置しているターミナルは、待つ理由になりません。アプリを閉じたときにも適用されます。',
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
    'settings.research.heading': '調査チャンネル',
    'settings.research.hint':
      '調査をお願いしたとき、swarm がどこまで見に行けるかの一覧です。Webページは最初から使えます。足りないものは下のヒントで解放できます。チェックはこのパソコンの中だけで行われます。',
    'settings.research.recheck': '再チェック',
    'settings.research.status.ok': '使える',
    'settings.research.status.part': '一部使える',
    'settings.research.status.miss': '未設定',
    'settings.research.copy': 'コマンドをコピー',
    'settings.research.copied': 'コピーしました',
    'settings.research.copyHint': 'ターミナルに貼り付けて Enter を押すだけです。',
    'settings.research.web.name': 'Webページ',
    'settings.research.web.state.ready': '公開ページを読みやすいテキストにして取り込めます。',
    'settings.research.web.state.no-curl': 'curl が見つかりません。導入するとWebページを読めるようになります。',
    'settings.research.websearch.name': 'Web検索',
    'settings.research.websearch.state.ready': 'Exa 経由でWebを検索できます。',
    'settings.research.websearch.state.missing': 'mcporter を入れるとWeb検索が使えます。',
    'settings.research.twitter.name': 'X（Twitter）',
    'settings.research.twitter.state.full': 'ログイン済み — 投稿の取得も検索も使えます。',
    'settings.research.twitter.state.bin-only':
      '投稿の単体取得は使えます。検索とタイムラインは、下でCookieを設定すると使えるようになります。',
    'settings.research.twitter.state.missing':
      'twitter-cli が必要です。下のコマンドをコピーして入れてください（Cookieはその後で）。',
    'settings.research.twitter.state.cookies-only':
      'Cookieは保存済みです。あと一歩 — 下のコマンドで twitter-cli を入れると、投稿の取得も検索も使えるようになります。',
    'settings.research.reddit.name': 'Reddit',
    'settings.research.reddit.state.cli': 'rdt 導入済み。ログイン状態は最初の検索時にわかります。',
    'settings.research.reddit.state.baseline': '公開投稿はこのまま読めます。rdt を入れるとログインが要る機能も使えます。',
    'settings.research.reddit.state.unreachable': 'curl がないため Reddit に届きません。',
    'settings.research.youtube.name': 'YouTube',
    'settings.research.youtube.state.ready': '字幕を読むので、動画を再生せずに中身を要約できます。',
    'settings.research.youtube.state.missing': 'yt-dlp を入れると動画の要約が使えます。',
    'settings.research.github.name': 'GitHub',
    'settings.research.github.state.cli': 'gh 導入済み — 検索まで使えます。',
    'settings.research.github.state.baseline': '公開リポジトリはこのまま読めます。gh を入れると検索も使えます。',
    'settings.research.github.state.unreachable': 'curl がないため GitHub に届きません。',
    'settings.research.rss.name': 'RSSフィード',
    'settings.research.rss.state.full': 'feedparser でフィードを構造的に読めます。',
    'settings.research.rss.state.no-feedparser': 'フィードは読めます。feedparser を入れると解析が安定します。',
    'settings.research.rss.state.baseline': 'フィードを直接取得して読みます。',
    'settings.research.rss.state.unreachable': 'curl がないためフィードを取得できません。',
    'settings.research.x.disclosure': 'Xの検索を使う（上級者向け）',
    'settings.research.x.tos':
      'この方法は、あなた自身がログインしているブラウザのセッションを使ってXを読みます。Xの公式API規約の枠外のやり方なので、使うかどうかはご自身の判断でお願いします。',
    'settings.research.x.promise':
      '2つの値はこのパソコンから出ません。どこにも送信されず、画面に再表示されることもなく、この端末で動く調査ツールにだけ渡されます。',
    'settings.research.x.howto':
      'Xにログインしているブラウザで x.com を開き、F12 → Application → Cookies → x.com の順にたどって、auth_token と ct0 の値をコピーしてください。',
    'settings.research.x.save': '保存',
    'settings.research.x.clear': '削除',
    'settings.research.x.saved': 'Cookieを保存しました — 次の調査からXの検索が使えます。',
    'settings.research.x.error': '保存できませんでした。2つの値を両方入れてください（空にして削除もできます）。',
    'settings.inbox.heading': '受信したフィードバック',
    'settings.inbox.refresh': '再読み込み',
    'settings.inbox.loading': '送信内容を読み込み中…',
    'settings.inbox.empty': 'まだフィードバックはありません。届くと新しい順にここに表示されます。',
    'settings.inbox.error': 'フィードバックを読み込めませんでした。Supabase に到達できますか？',
    'settings.inbox.truncated': '新しい順に200件まで表示しています。それ以前は Supabase のテーブルエディタで確認できます。',
    'settings.inbox.imageAlt': '添付画像',
  } as Record<string, string>,
}

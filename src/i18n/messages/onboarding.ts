// Owned by the Onboarding track (first-run welcome screen). Add keys as
// 'onboarding.*'. English is the source of truth; the JA set MUST mirror the
// EN key set exactly. (Code comments are NOT translated.)
//
// The first-run flow is a 2-step wizard: Overview → Set up Claude Code (a hard
// gate — the local `claude` CLI must be detected before you can continue),
// then "Get started" enters the app as a guest (no sign-in step; the optional
// app account lives in the account menu). Install commands themselves live in
// the component (they're identical across locales), not here.
export const onboarding = {
  en: {
    'onboarding.tagline': 'Every claude terminal. One ground.',

    // beta notice
    'onboarding.beta.tag': 'Beta.',
    'onboarding.beta.note':
      'OPEN GROUND is still in beta — things may change in breaking ways. Hit a bug or a rough edge? Please send it via the Feedback button — it directly shapes what we fix next.',

    // nav
    'onboarding.nav.back': 'Back',
    'onboarding.nav.next': 'Next',

    // step 1 — overview
    'onboarding.how.label': 'What you get',
    'onboarding.how.line1': 'Every project is a card on one infinite canvas — a beacon glows wherever Claude is at work.',
    'onboarding.how.line2': 'One click opens a real claude terminal, already in that project’s folder. No cd, no tab juggling.',
    'onboarding.how.line3': 'Each project unfolds into Terminal, Board, and Canvas — run the work, plan it, sketch it, in one place.',

    // step 2 — set up Claude Code (gate)
    'onboarding.setup.label': 'Set up Claude Code',
    'onboarding.setup.intro':
      'OPEN GROUND runs your local Claude Code CLI — subscription-only, never an API key. Install it and sign in with a paid Claude plan — Pro, Max, Team, or Enterprise — to run projects.',
    'onboarding.setup.checking': 'Checking for the Claude Code CLI…',
    'onboarding.setup.ready': 'Claude Code CLI detected',
    'onboarding.setup.readyHint':
      "You're set — Pro, Max, Team, and Enterprise plans all work (all models; usage limits apply). If you haven't yet, run `claude` in a terminal and sign in.",
    'onboarding.setup.method.installer': 'Official installer',
    'onboarding.setup.method.installerNote': 'Recommended — auto-updates.',
    'onboarding.setup.method.brew': 'Homebrew',
    'onboarding.setup.method.brewNote': 'If you already use Homebrew.',
    'onboarding.setup.method.npm': 'npm',
    'onboarding.setup.method.npmNote': 'Needs Node.js 18+. Don’t use sudo.',
    'onboarding.setup.copied': 'Copied',
    'onboarding.setup.docs': 'Installation docs',

    // full-screen guided installer (OnboardingSetup) — embedded terminal
    'onboarding.setup.guideTitle': "Let's install Claude Code",
    'onboarding.setup.guideIntro':
      'Run each step in the terminal on the right. OPEN GROUND drives your local Claude Code — subscription-only, never an API key.',
    'onboarding.setup.step.method': 'Choose how to install',
    'onboarding.setup.step.install': 'Install the CLI',
    'onboarding.setup.step.signin': 'Sign in',
    'onboarding.setup.runInstall': 'Run in terminal',
    'onboarding.setup.runSignin': 'Run sign-in',
    'onboarding.setup.orCopy': 'Copy command',
    'onboarding.setup.waiting': 'Waiting for the CLI… run the command on the right.',
    'onboarding.setup.detectedShort': 'Claude Code detected',
    'onboarding.setup.signinHint':
      'A browser window opens — log in with a paid Claude plan (Pro, Max, Team, or Enterprise). When done, continue.',
    'onboarding.setup.continue': 'Continue to OPEN GROUND',
    'onboarding.setup.terminal': 'Terminal',
    'onboarding.setup.manualHint': 'You can also type any command directly in the terminal.',

    'onboarding.getStarted': 'Get started',
  } as Record<string, string>,
  ja: {
    'onboarding.tagline': 'すべての claude ターミナルを、1枚の大地に。',

    // beta notice
    'onboarding.beta.tag': 'ベータ版。',
    'onboarding.beta.note':
      'OPEN GROUND はまだベータ版です。今後、破壊的な変更が入ることがあります。バグや使いにくい点を見つけたら、ぜひ「フィードバック」から送ってください。今後の改善に直結します。',

    // nav
    'onboarding.nav.back': '戻る',
    'onboarding.nav.next': '次へ',

    // step 1 — overview
    'onboarding.how.label': 'できること',
    'onboarding.how.line1': 'すべてのプロジェクトが、1枚の無限キャンバスのカードに。Claude が働く場所にはビーコンが灯る。',
    'onboarding.how.line2': 'ワンクリックで、そのフォルダに座った本物の claude ターミナルが開く。cd もタブの切り替えも不要。',
    'onboarding.how.line3': 'プロジェクトを開けば Terminal・Board・Canvas ── 実行も、計画も、スケッチも、同じ場所で。',

    // step 2 — set up Claude Code (gate)
    'onboarding.setup.label': 'Claude Code のセットアップ',
    'onboarding.setup.intro':
      'OPEN GROUND はお使いのローカル Claude Code CLI を動かします（サブスクリプション専用・API キーは使いません）。プロジェクトを実行するには、CLI のインストールと、有料プラン（Pro・Max・Team・Enterprise）でのサインインが必要です。',
    'onboarding.setup.checking': 'Claude Code CLI を確認しています…',
    'onboarding.setup.ready': 'Claude Code CLI を検出しました',
    'onboarding.setup.readyHint':
      '準備OK。Pro・Max・Team・Enterprise いずれのプランでも使えます（全モデル利用可・利用量の上限あり）。まだなら、ターミナルで `claude` を実行してサインインしてください。',
    'onboarding.setup.method.installer': '公式インストーラ',
    'onboarding.setup.method.installerNote': '推奨 — 自動アップデート。',
    'onboarding.setup.method.brew': 'Homebrew',
    'onboarding.setup.method.brewNote': 'Homebrew を使っている場合。',
    'onboarding.setup.method.npm': 'npm',
    'onboarding.setup.method.npmNote': 'Node.js 18+ が必要。`sudo` は付けないでください。',
    'onboarding.setup.copied': 'コピーしました',
    'onboarding.setup.docs': 'インストール手順（ドキュメント）',

    // full-screen guided installer (OnboardingSetup) — embedded terminal
    'onboarding.setup.guideTitle': 'Claude Code をインストールしましょう',
    'onboarding.setup.guideIntro':
      '右のターミナルで各ステップを実行します。OPEN GROUND はお使いのローカル Claude Code を動かします（サブスクリプション専用・API キーは使いません）。',
    'onboarding.setup.step.method': 'インストール方法を選ぶ',
    'onboarding.setup.step.install': 'CLI をインストール',
    'onboarding.setup.step.signin': 'サインイン',
    'onboarding.setup.runInstall': 'ターミナルで実行',
    'onboarding.setup.runSignin': 'サインインを実行',
    'onboarding.setup.orCopy': 'コマンドをコピー',
    'onboarding.setup.waiting': 'CLI を待機中… 右のターミナルでコマンドを実行してください。',
    'onboarding.setup.detectedShort': 'Claude Code を検出しました',
    'onboarding.setup.signinHint':
      'ブラウザが開きます — 有料プラン（Pro・Max・Team・Enterprise）でログインしてください。完了したら次へ。',
    'onboarding.setup.continue': 'OPEN GROUND へ進む',
    'onboarding.setup.terminal': 'ターミナル',
    'onboarding.setup.manualHint': 'ターミナルに直接コマンドを入力してもかまいません。',

    'onboarding.getStarted': 'はじめる',
  } as Record<string, string>,
}

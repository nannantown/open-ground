// Owned by the Onboarding track (first-run welcome screen). Add keys as
// 'onboarding.*'. English is the source of truth; the JA set MUST mirror the
// EN key set exactly. (Code comments are NOT translated.)
//
// The first-run flow is a single overview screen: what OPEN GROUND is / how it
// works, a beta notice, then "Get started" which enters the app as a guest (no
// sign-in step; the optional app account lives in the account menu). Onboarding
// does NOT gate on Claude detection — installing `claude` is the user's
// responsibility and the app passively reflects whether it's connected.
export const onboarding = {
  en: {
    'onboarding.tagline': 'Every claude terminal. One ground.',

    // beta notice
    'onboarding.beta.tag': 'Beta.',
    'onboarding.beta.note':
      'OPEN GROUND is still in beta — things may change in breaking ways. Hit a bug or a rough edge? Please send it via the Feedback button — it directly shapes what we fix next.',

    // overview
    'onboarding.how.label': 'What you get',
    'onboarding.how.line1': 'Every project is a card on one infinite canvas — a beacon glows wherever Claude is at work.',
    'onboarding.how.line2': 'One click opens a real claude terminal, already in that project’s folder. No cd, no tab juggling.',
    'onboarding.how.line3': 'Each project unfolds into Terminal, Board, and Canvas — run the work, plan it, sketch it, in one place.',

    'onboarding.getStarted': 'Get started',
  } as Record<string, string>,
  ja: {
    'onboarding.tagline': 'すべての claude ターミナルを、1枚の大地に。',

    // beta notice
    'onboarding.beta.tag': 'ベータ版。',
    'onboarding.beta.note':
      'OPEN GROUND はまだベータ版です。今後、破壊的な変更が入ることがあります。バグや使いにくい点を見つけたら、ぜひ「フィードバック」から送ってください。今後の改善に直結します。',

    // overview
    'onboarding.how.label': 'できること',
    'onboarding.how.line1': 'すべてのプロジェクトが、1枚の無限キャンバスのカードに。Claude が働く場所にはビーコンが灯る。',
    'onboarding.how.line2': 'ワンクリックで、そのフォルダに座った本物の claude ターミナルが開く。cd もタブの切り替えも不要。',
    'onboarding.how.line3': 'プロジェクトを開けば Terminal・Board・Canvas ── 実行も、計画も、スケッチも、同じ場所で。',

    'onboarding.getStarted': 'はじめる',
  } as Record<string, string>,
}

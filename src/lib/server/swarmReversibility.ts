// swarmReversibility — the shared REVERSIBILITY gate (EPIC C / card C4).
//
// The autonomous overseer's escalation valve is cut on REVERSIBILITY, not
// confidence (OVERSEER_DESIGN §2 K6): an irreversible action — charging money,
// publishing, sending funds, deleting data, a production deploy, exposing
// credentials — goes to the human owner EVEN WHEN the proxy is confident, and
// anything we cannot PROVE reversible fails closed to the owner too ("不明は
// 不可逆に倒す"). This module is the single classifier three call sites share
// (OVERSEER_DESIGN §9 L5): the proxy-you answer function (C2), the PreToolUse
// deny veto (A3, once retrofitted off its own denylist — C4 Done ③), and the
// overseer's own T3 valve.
//
// PURELY STATIC (labels / keywords / structure) — it NEVER calls a model, for
// the same reason classifyCardWeight doesn't: a judgment gate that itself spent
// an LLM call would be both slow and, worse, non-deterministic on the one axis
// that must be dependable. It lives in the swarm glob (src/lib/server/swarm*.ts)
// ON PURPOSE so any change to this safety layer is caught by the swarm-safety
// diff gate (OVERSEER_DESIGN §7.3 / K9) — do not move it out.
//
// SCOPE — a BEST-EFFORT STRUCTURAL BACKSTOP, not a complete semantic judge. A
// keyword classifier cannot survive every paraphrase of "delete the prod DB";
// that is why the proxy's PRIMARY judge is the brain (an LLM reading the owner's
// corpus, which itself says "escalate irreversible") — see swarmOverseerBrain's
// ESCALATE decision. This gate's job is narrower and dependable: (1) catch the
// CLEAR, COMMON irreversible actions cheaply so obvious cases skip the brain, and
// (2) be the structural backstop that catches an irreversible directive a
// PROMPT-INJECTED brain might emit. It is deliberately tuned for PRECISION over
// recall: every money/publish/delete/credential rule is qualified by an OBJECT or
// an AMOUNT (a bare mention — "add a payment button", "ショートカットキーを教えて",
// "transfer 100k records" — must NOT trip), because a false positive that
// escalates every billing/credentials/UI chore erodes the owner's trust in the
// real escalations. Paraphrase beyond this list is the brain's job, not the gate's.
//
// PERFORMANCE: every pattern is bounded (no unbounded quantifier adjacent to a
// broad class) so classifying attacker-controlled free text is linear — an
// earlier `\d[\d,.]*` amount run went quadratic on long digit strings (a real
// ReDoS on the free-text `question` path); amount runs are now length-capped.

export type ReversibilityKind = 'bash' | 'tool' | 'question'
export type ReversibilityVerdict = 'reversible' | 'irreversible' | 'unknown'

export interface ReversibilityInput {
  /** What the text IS: a shell command, a tool invocation (name [+ args]), or a
   *  natural-language question/answer. Selects which structural rules apply. */
  kind: ReversibilityKind
  text: string
}

export interface ReversibilityResult {
  verdict: ReversibilityVerdict
  /** Short human-readable rationale — the matched category, or why it's unknown.
   *  Carried into the escalation context / engine log; never load-bearing. */
  reason: string
}

// A currency-tagged sum — the structural signal that a money verb is about REAL
// funds (so "pay the invoice" needs an amount/target, but "pay attention" never
// trips). Digit runs are LENGTH-CAPPED ({0,15}) so a 50k-digit string can't drive
// quadratic backtracking (ReDoS). NOTE: no bare `Nk` unit — it misread "100k
// records" as money; a `$`/¥/€ or a spelled currency word is required.
const AMOUNT = String.raw`(?:[$¥€]\s?\d[\d,.]{0,15}|\d[\d,.]{0,15}\s*(?:dollars?|usd|cents?|円|ドル|万円|億円))`

// ─── Irreversible-action signals (EN + JA) ───────────────────────────────────
// FIRST match wins and supplies the reason. Money/publish/delete/credential verbs
// are qualified by an OBJECT or an AMOUNT so a bare noun in dev work does NOT trip.
const IRREVERSIBLE_SIGNALS: { re: RegExp; reason: string }[] = [
  // ── money: transfers, refunds, charges, and any move of a specific sum ──
  { re: /送金|振(?:り)?込(?:んで|んどい|んでおい|む|みたい|みます|して|しと)|振込(?:して|しと)/i, reason: 'money transfer (JA)' },
  { re: /返金|払い戻し|ペイアウト|\brefund\b|\bpayout\b|\bchargeback\b|\b(?:wire|bank)\s+transfer\b|\bremit(?:tance)?\b/i, reason: 'refund / payout / bank transfer' },
  { re: /課金(?:する|して|しと|され|しろ)|請求(?:する|して|しと|を(?:確定|送))|決済(?:する|して|を(?:実行|処理|確定))/i, reason: 'charge / bill / settle (JA)' },
  {
    re: new RegExp(String.raw`\b(?:charge|bill|invoice)\b[^\n]{0,24}(?:card|customer|account|${AMOUNT})|\bprocess(?:es|ing)?\b[^\n]{0,12}payment|\bcapture\b[^\n]{0,12}(?:payment|charge)`, 'i'),
    reason: 'charge / bill a customer',
  },
  {
    re: new RegExp(String.raw`\b(?:pay|send|transfer|remit|wire|charge|refund|move)\b[^\n]{0,30}(?:${AMOUNT}|\bbalance\b|\bfunds\b)|${AMOUNT}[^\n]{0,16}(?:を|の)?(?:送|払|振込|振り込|チャージ|charge|pay|transfer)`, 'i'),
    reason: 'move a specific sum of money',
  },
  { re: /\bwire\b[^\n]{0,20}(?:transfer|to\s+(?:the\s+)?(?:supplier|vendor|account|bank)|funds)/i, reason: 'wire funds' },
  { re: /(?:円|ドル|カード|口座|顧客|お客|クレジット)[^\n]{0,10}(?:を|に)?チャージ|チャージ(?:する|して|しと|しといて)/i, reason: 'charge money (katakana)' },
  { re: /お金[^\n]{0,10}(?:を|の)?(?:送|振込|振り込|払|渡)/i, reason: 'send money (JA colloquial)' },
  { re: /\b(?:settle|pay|clear|void)\b[^\n]{0,12}\b(?:invoices?|bills?)\b(?!(?:['’]s)?\s+(?:input|field|form|component|list|table|row|column|number|id|template|preview|layout|section|page|tabs?|filter|view|modal|dialog|ui|screen|button|label|placeholder|amount))|(?:請求(?:書)?|請求書)[^\n]{0,6}(?:を)?(?:支払|決済|清算|払)/i, reason: 'settle / pay an invoice' },

  // ── publication / release / production deploy ──
  { re: /\bnpm\s+publish\b|一般公開|世に出す|ローンチ(?:する|して)|\bgo[- ]?live\b/i, reason: 'publish / launch' },
  { re: /\bmake\s+(?:it|this|the\s+\S+)\s+(?:public|visible|live)\b|\bvisible\s+to\s+(?:everyone|all|the\s+public|the\s+world)\b|(?:一般|外部|世間|みんな|全員|ユーザー)(?:に|へ)[^\n]{0,6}公開|公開(?:する|して|しと|しろ)/i, reason: 'make public' },
  { re: /\b(?:publish|deploy|ship|release|roll\s*out|promote|deliver|launch|push|submit)\b[^\n]{0,40}\b(?:prod|production|live|users?|customers?|public|everyone|the\s+world|store|marketplace|app\s*store)\b/i, reason: 'release to users / production deploy' },
  { re: /(?:本番|プロダクション|prod(?:uction)?)(?:に|へ)[^\n]{0,10}(?:上げ|出し|反映|投入|プッシュ|push|デプロイ|流)|本番[^\n]{0,12}(?:公開|デプロイ|反映|リリース|投入|プッシュ|出す|上げ)/i, reason: 'production deploy (JA/mixed)' },
  { re: /(?:app\s*store|ストア)[^\n]{0,10}(?:submit|提出|申請|審査|公開|release|リリース)|submit[^\n]{0,20}(?:app\s*store|store)|(?:実|全)ユーザー[^\n]{0,10}(?:公開|配信|反映|展開|に出|ロールアウト)|\b100\s*%[^\n]{0,16}(?:real\s+)?users?\b/i, reason: 'store submission / roll out to all users' },

  // ── deletion of DATA / RESOURCES (not code) ──
  { re: /\brm\s+-[a-z]*[rf][a-z]*\b/i, reason: 'rm -rf' },
  { re: /\bdrop\s+(?:table|database|schema|collection)\b|\btruncate\s+(?:table|database|\w)/i, reason: 'drop / truncate' },
  {
    re: /\b(?:delete|remove|destroy|wipe|purge|erase|empt(?:y|ies)|clear|flush|nuke|truncate|drop)\b[^\n]{0,40}\b(?:database|db|prod|production|account(?!\s+(?:settings?|page|menu|tab|section|nav|link|button|form|dropdown|list|view|screen|modal|icon|ui|name|number|id|holder|type|label))|user\s*data|customer\s*(?:data|records?|accounts?)|bucket|volume|dataset|backup|snapshot|namespace|cluster|table(?!\s+(?:columns?|fields?))|collection|records?|repo(?:sitory)?)\b/i,
    reason: 'delete data / resource',
  },
  { re: /\b(?:delete|remove|drop|wipe|purge)\b[^\n]{0,12}\b(?:all|every)\b[^\n]{0,12}\b(?:users?|customers?|records?|accounts?)\b|\b(?:all|every)\b[^\n]{0,12}\b(?:users?|customers?|records?|accounts?)\b[^\n]{0,16}\b(?:delete|remove|drop|wipe|purge)\b/i, reason: 'delete all users/customers/records' },
  // Delete / deactivate / cancel a bare ENTITY (customer / user / account /
  // subscription) — the object lists above require a data-noun, so "delete the
  // customer", "cancel the subscription", "deactivate their account permanently"
  // slip through and an injected brain could hand one back. The negative lookahead
  // spares CODE work ("remove the customer SCHEMA FIELD", "delete the user ROLE
  // dropdown") so it stays reversible.
  { re: /\b(?:delete|remove|deactivate|disable|close|cancel|terminate|suspend|drop|purge|ban|deprovision)\b[^\n]{0,16}\b(?:customers?|users?|accounts?|subscriptions?|members?|tenants?|workspaces?|orgs?|organizations?)\b(?!(?:['’]s)?\s+(?:schema|field|type|interface|model|component|prop|props|column|attribute|list|count|name|id|role|avatar|icon|menu|tabs?|section|button|form|input|settings?|preference|dropdown|filter|view|page|route|endpoint|enum|constant|variable|import|function|method|class|test|mock|fixture|placeholder|label|tooltip|badge|card|row|cell|header|modal|dialog|toggle|checkbox|select|option|table|record))/i, reason: 'delete / deactivate / cancel an entity (account / subscription / customer)' },
  { re: /(?:サブスク(?:リプション)?|契約|購読|アカウント|会員|メンバー)[^\n]{0,8}(?:を)?(?:解約|キャンセル|停止|無効化|閉鎖|凍結|退会|解除)|(?:解約|退会)(?:する|して|しと|しろ)/i, reason: 'cancel subscription / deactivate account (JA)' },
  { re: /(?:データベース|DB|本番|アカウント|ユーザー|顧客|バックアップ|テーブル|コレクション|スナップショット|リポジトリ|レコード|口座)[^\n]{0,12}(?:を|の中身を|全部|すべて)?(?:削除|消去|抹消|破棄|ドロップ|drop|truncate|空に|全消し|クリア|初期化|リセット|消し(?:て|と)?|消す)/i, reason: 'delete data / resource (JA)' },
  { re: /(?:全て?の|すべての|全)[^\n]{0,8}(?:ユーザー|アカウント|レコード|データ)[^\n]{0,8}(?:を)?(?:削除|消)/i, reason: 'delete all users/records (JA)' },

  // ── credentials / secrets (SPECIFIC nouns only — bare キー/token/password do NOT trip) ──
  { re: /認証情報|秘密鍵/i, reason: 'credentials referenced' },
  { re: /(?:api[_\s-]?key|secret[_\s-]?key|access[_\s-]?token|APIキー|api\s*キー|クレデンシャル|credentials?|\.env)[^\n]{0,16}(?:を)?(?:教え|見せ|貼|共有|share|paste|expose|leak|reveal|dump|送|漏|rotate|ローテ|revoke|失効|無効化|reset|リセット|print|echo)/i, reason: 'credential exposure / rotation' },
  { re: /\b(?:share|paste|expose|leak|reveal|print|echo|post|dump|send)\b[^\n]{0,20}\b(?:password|secret[_\s-]?key|api[_\s-]?key|access[_\s-]?token|credentials?)\b/i, reason: 'credential exposure' },
  { re: /\b(?:rotate|revoke)\b[^\n]{0,16}\b(?:api[_\s-]?key|secret[_\s-]?key|access[_\s-]?token|credentials?|the\s+key)\b/i, reason: 'credential rotation / revocation' },
  { re: /(?:本番|prod(?:uction)?)[^\n]{0,12}(?:APIキー|api[_\s-]?key|access[_\s-]?token|secret[_\s-]?key|認証情報|秘密鍵|token|key|キー|鍵|secret|password|パスワード)/i, reason: 'production credential' },

  // ── destructive git / filesystem structure ──
  // The `git push`→flag and `curl`→`| sh` windows are LENGTH-CAPPED: an unbounded
  // `[^\n]*` here went quadratic when the anchor (`git push` / `curl`) repeats many
  // times in attacker free text (each occurrence rescans to the end). A force flag
  // sits within a few tokens of `git push`; a piped URL within a couple hundred chars.
  { re: /\bgit\s+push\b[^\n]{0,80}(?:--force(?:-with-lease)?|(?<![\w-])-f(?![\w-]))|\bforce[- ]?push\b|強制プッシュ|\bgit\s+reset\s+--hard\b/i, reason: 'force-push / hard reset' },
  { re: /\bdd\s+if=|\bmkfs\b|>\s*\/dev\/[sh]d|\bchmod\s+-R\s+777\s+\//i, reason: 'destructive disk / device operation' },
  { re: /\b(?:curl|wget)\b[^\n|]{0,200}\|\s*(?:sudo\s+)?(?:ba)?sh\b/i, reason: 'pipe-to-shell of remote code' },
]

// Shell commands that only OBSERVE — no state change, fully reversible. STRICT:
// the whole line must be one safe command whose args contain NO shell
// metacharacter — no redirect (`> < `), chaining (`& ; |`), command substitution
// (backtick / `$( )`), or newline. That closes the launder holes an earlier,
// looser pattern had (`cat x && ./deploy.sh`, `vitest && ./evil.sh`, `echo x >
// ~/.zshrc`, newline-chained tails). Commands with a destructive FLAG (find
// -delete, git branch -D, git remote set-url, sort -o) are simply OFF this list —
// they fall through to `unknown` (fail-closed).
const READONLY_BASH =
  /^\s*(?:ls|ll|cat|head|tail|pwd|whoami|hostname|uname|which|type|echo|printf|date|wc|grep|egrep|rg|stat|file|tree|git\s+(?:status|diff|log|show|blame|rev-parse|ls-files|ls-tree|describe|cat-file)|npm\s+(?:test|ls|list|why|view|outdated)|node\s+--check|tsc|vitest|jest|eslint)(?:[ \t]+[^\n><&;|`$()]*)?\s*$/i

// Tool names whose worst case is a pure READ (no state change regardless of the
// path). Write-ish tools are intentionally NOT here: whether an Edit/Write is
// git-revertible depends on the target path being inside a worktree, which this
// name-only seam can't verify — so they fall through to `unknown` (fail-closed),
// and A3 (which resolves the absolute path) can prove worktree-locality itself.
const READONLY_TOOLS = new Set([
  'read', 'grep', 'glob', 'ls', 'notebookread', 'webfetch', 'websearch', 'todoread', 'todowrite',
])

const firstIrreversible = (text: string): string | null => {
  for (const { re, reason } of IRREVERSIBLE_SIGNALS) if (re.test(text)) return reason
  return null
}

/** Classify how reversible an action is (OVERSEER_DESIGN §10 C4). Never throws;
 *  an empty/whitespace text is trivially `reversible` (nothing happens). Contract:
 *   - `irreversible` — the text names a real-world irreversible effect.
 *   - `reversible`   — PROVABLY recoverable (a natural-language question/answer
 *     with no irreversible action named; a read-only shell command; a read tool).
 *     For NL there is no `unknown`: answering advice is itself reversible — it's
 *     words — and the brain (not this gate) is the semantic judge of a paraphrased
 *     irreversible request.
 *   - `unknown`      — a bash/tool op we can neither prove read-only nor match to
 *     a named irreversible action. The gate ({@link requiresOwnerApproval}) fails
 *     this CLOSED to the owner (K6). */
export const classifyReversibility = (input: ReversibilityInput): ReversibilityResult => {
  const text = (input.text ?? '').trim()
  if (!text) return { verdict: 'reversible', reason: 'empty' }

  const irrev = firstIrreversible(text)
  if (irrev) return { verdict: 'irreversible', reason: irrev }

  if (input.kind === 'question') {
    // Natural-language question OR the proxy's answer text, with no irreversible
    // action named above. Answering (and the advice itself) is reversible — the
    // C2 common case that keeps the proxy useful. A paraphrased irreversible that
    // slips this best-effort list is caught by the brain's own ESCALATE decision
    // (the semantic judge), not treated as reversible-and-safe here.
    return { verdict: 'reversible', reason: 'no irreversible action named' }
  }

  if (input.kind === 'bash') {
    if (READONLY_BASH.test(text)) return { verdict: 'reversible', reason: 'read-only command' }
    return { verdict: 'unknown', reason: 'unrecognized command — treated as unknown (fail-closed)' }
  }

  // kind === 'tool': first whitespace-delimited token is the tool name. Only pure
  // reads are provably reversible; everything else (writes, bash, unknown tools)
  // fails closed for the shared A3/overseer callers.
  const name = text.split(/\s+/, 1)[0]?.toLowerCase() ?? ''
  if (READONLY_TOOLS.has(name)) return { verdict: 'reversible', reason: 'read-only tool' }
  return { verdict: 'unknown', reason: 'non-read tool — treated as unknown (fail-closed)' }
}

/** The fail-closed GATE (OVERSEER_DESIGN §2 K6 / §9 L5). Only a PROVABLY
 *  reversible verdict may be auto-handled by the proxy; BOTH `irreversible` and
 *  `unknown` route to the human owner. This is the single predicate A3 / C2 / the
 *  overseer T3 valve share so "不明は不可逆に倒す" is encoded in exactly one place. */
export const requiresOwnerApproval = (verdict: ReversibilityVerdict): boolean => verdict !== 'reversible'

// swarmDecisionRouting — WHO decides. The routing layer that sits in FRONT of
// the escalations inbox (swarmEscalations.ts).
//
// THE DEFECT THIS CLOSES (owner instruction 2026-07-18): the inbox classifies
// WHY a question is escalated (irreversible / insufficient-info / policy) but
// never asked WHETHER THE OWNER IS THE RIGHT ADDRESSEE. A worker stuck on a
// technical trade-off could therefore land that trade-off in the owner's inbox —
// a MISDELIVERY. The goal: the only questions that reach the owner are the ones
// only the owner can decide.
//
// ── THE CANON (do NOT invent categories here) ────────────────────────────────
// The routing map is NOT a technical/non-technical taxonomy — the owner rejected
// that framing explicitly ("カテゴリのハードコードはしない", 2026-07-18). It is an
// OBSERVATION MAP: the layers the owner is observed to actually think about are
// the owner's; the areas they are observed to delegate are decided by the AI
// side. There are exactly TWO canonical sources, and this module only ever
// DIGESTS them — it never adds a category of its own:
//
//   1. 「関与の観測地図」— the owner's hand-written persona section in
//      ~/.openground/you-corpus.md (§4 手動追記). Entries are (a) a quote from
//      the owner + date, or (b) an observed act of engagement / delegation.
//      The owner keeps changing, so the map keeps growing: a NEWER observation
//      beats an older record.
//   2. The PERMANENT boundaries — docs/commander/TARGET-STATE.md §5's
//      「人間承認が必須で残る操作」table. Those are not observations that can be
//      re-learned; they are standing policy.
//
// ── WHY THE WORKER GETS A DIGEST INSTEAD OF READING THE CORPUS ───────────────
// The map lives in you-corpus, and the overseer's BRAIN reads it live (by path —
// swarmOverseerBrain.ts). A worker must NOT: the corpus is ~hundreds of KB of
// the owner's personal data (mode 0600), and unlike the brain PTY — which is
// structurally denied WebFetch / WebSearch / Bash / Task precisely so the corpus
// cannot leave the machine — a worker has full tooling and is an egress path.
// So the worker gets this DIGEST burned into its /order rules instead
// (swarmWorker.ts WORKER_ORDER_RULES), which is the fallback the owner named:
// 「you-corpus はワーカーから読める前提が無ければ、地図の要旨をワーカー標準指示に
// 同梱し、更新は地図追記と同期」.
//
// ⚠️ PRIVACY — PARAPHRASE, NEVER QUOTE. The corpus map's entries are built from
// the owner's own words, and this file is TRACKED SOURCE: every release snapshots
// origin/main's tree into the PUBLIC open-ground repo (docs/DISTRIBUTION.md §PII
// hygiene — "personal information must NEVER reach open-ground"). So the digest
// below carries only the observed FACT of each entry, never the sentence the
// owner said. `src/repoPiiGuard.test.ts` will NOT catch a violation here — it
// scans for emails / real names / home paths, not for quoted private speech — so
// this is a rule the author must hold, not one the gate enforces. The quotes stay
// where they belong: in ~/.openground/you-corpus.md, mode 0600, never git-shared.
//
// ⚠️ SYNC OBLIGATION: this digest is a SNAPSHOT of the corpus map. When the
// owner appends to 「関与の観測地図」, update {@link OWNER_MAP_ENGAGED} /
// {@link OWNER_MAP_DELEGATED} in the same pass. The digest may only ever contain
// what the map contains — a new bullet here that is not in the corpus is exactly
// the "想像でつくるな" failure the owner corrected twice on 2026-07-18.
//
// ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────
// NOT a ban on discussing technology with the owner. The owner asks how the
// machinery works, unprompted, and follows it deeply (the loop / token designs
// in this very swarm came from their own questions). What is banned is handing
// them a technical TRADE-OFF to decide. Explanation: yes. Delegation of an
// engineering judgment: no. Every string in this module keeps that distinction
// visible, because a rule that reads as "don't talk tech to the owner" would be
// a worse misreading than the bug it fixes.

/** Areas the owner is OBSERVED to decide → an escalation here is correctly
 *  addressed. Digest of the corpus map's 「関与する」 list (2026-07-18). */
export const OWNER_MAP_ENGAGED: readonly string[] = [
  'システムの構造と役割の設計',
  '名前と言葉',
  '進め方の戦略',
  '判断の記録(ペルソナ)の作り方',
  'リリース・公開',
  '使い心地への違和感',
]

/** Areas the owner is OBSERVED to delegate → decide these on the technical side;
 *  they must NOT become escalations. Digest of the corpus map's 「関与しない」
 *  list (2026-07-18).
 *
 *  PARAPHRASED, NEVER QUOTED (see the PRIVACY note in the header): the corpus
 *  entries carry the owner's own words; this file is published, so it carries
 *  only the observed FACT each entry records. */
export const OWNER_MAP_DELEGATED: readonly string[] = [
  'トークン最適化の実装方式(本人が明示的に委任)',
  'コードレベルの実装選択・アルゴリズム',
  'git/統合/検品の手順(司令塔・技術側が決める領域)',
]

/** Standing policy, NOT observations: these always go to the owner whatever the
 *  map says. Digest of docs/commander/TARGET-STATE.md §5. (force-push / git
 *  stash are absent on purpose — they are FORBIDDEN outright, so they are
 *  refused rather than asked about.) */
export const PERMANENT_OWNER_BOUNDARIES: readonly string[] = [
  'リリース・公開',
  'プロジェクトの削除',
  '使用可能モデルの変更',
  '停止(none-allowed park)の解除',
  '自案カードの着手承認',
  '過去 escalation への回答',
  '[hold] カードの統合',
]

/** The owner is a non-engineer. The corpus records this as their own words (the
 *  persona rule: quotes or observed acts, never inference); this published file
 *  states only the recorded FACT and points at the corpus for the wording. */
export const OWNER_NON_ENGINEER_PREMISE =
  'オーナーは非エンジニア(本人が明示・2026-07-18 観測地図に記録)'

/** The one question asked when a domain is NOT on the map — the owner's design:
 *  don't guess the addressee, ask WHO OWNS THIS KIND OF CALL once, and let the
 *  answer grow the map (the answer→you-corpus path already exists, unchanged).
 *
 *  WIRED IN ONE LANE ONLY (deliberate, 2026-07-18): the overseer's S4 abstention
 *  (swarmOverseer.ts — gated on OwnerAnswer.abstained, never on `why`). Two
 *  sibling paths raise worker questions WITHOUT this routing wrapper and are left
 *  as-is: the engine's S4-THROTTLED direct raise (swarmOrchestrator.ts — the brain
 *  is paused, so nothing consulted the map; the same reason the failure lanes are
 *  excluded) and swarmQuestions.ts's handleWorkerQuestion (not on the live path
 *  today). If either is ever put in front of the owner's inbox, decide its routing
 *  explicitly — silence here would read as "already covered". */
export const UNCLASSIFIED_ROUTING_ASK =
  'これはあなたが決めたい種類の話ですか?それともこちらで決めますか?'

/** Worker-facing routing rules, appended to WORKER_ORDER_RULES so every spawn
 *  carries them. SINGLE LINE (no \n/\r/\t): the whole /order goal must stay one
 *  slash-command argument — same constraint as the rest of the worker rules. */
// `/` joins the lists: the entries themselves contain `・`, so a `・` separator
// would dissolve the item boundaries into one run-on list (N3).
const LIST_SEP = ' / '

export const DECISION_ROUTING_RULES =
  ' 【判断の宛先・厳守】オーナーに質問を上げる前に、宛先を仕分けろ。' +
  `${OWNER_NON_ENGINEER_PREMISE}。` +
  '宛先はカテゴリ(技術/非技術)では決まらない — 基準は「関与の観測地図」、' +
  'つまりオーナーが実際に考えていると観測された領域だけがオーナー宛て: ' +
  `${OWNER_MAP_ENGAGED.join(LIST_SEP)}。` +
  'オーナーが関与しないと観測済みの領域は、オーナーではなく技術側(あなた・司令塔)が決める領域なので自分で決めろ(escalation にしない): ' +
  `${OWNER_MAP_DELEGATED.join(LIST_SEP)}。` +
  '(統合そのものは従来どおり司令塔の仕事 — ここで言う「自分で決める」は、手順や方式をオーナーに問わないという意味。)' +
  '自分で決めきれないなら、オーナーに投げずにまず自分で調べろ。それでも決まらないときは心拍の blocker(swarm-beat.sh の第4引数)に書け — ' +
  '司令塔はそれを本文ごと読める(GET /api/swarm/workers)。監督が起動していれば S4 が拾い、大脳(proxy)が答えをあなたの PTY に注入する(大脳が答えられなければオーナーの受信箱に回る)。' +
  'blocker は必ず質問の形で書け(「?」を入れるのが確実) — 質問と判定されない文は S4 が拾わない。' +
  '地図と無関係に必ずオーナーへ上げる恒久境界: ' +
  `${PERMANENT_OWNER_BOUNDARIES.join(LIST_SEP)}。` +
  `地図に無い未分類の話は決めつけず、平易文で最初に1問だけ「${UNCLASSIFIED_ROUTING_ASK}」と聞け(その回答が地図を育てる)。` +
  'これは技術の説明を禁じるものではない — オーナーは仕組みを自分から質問し深く理解する人なので、' +
  '聞かれたら遠慮なく深く説明してよい。禁じるのは技術的トレードオフの「判断の委任」だけ。'

/** The routing rule injected into the overseer BRAIN's prompt (English, like the
 *  rest of that prompt). The brain reads the corpus live, so it consults the REAL
 *  map rather than this module's digest — these lines only tell it to route
 *  before escalating, and that routing never overrides the irreversibility valve
 *  (K6: an irreversible action escalates whatever area it sits in).
 *
 *  UNNUMBERED: the caller prefixes the rule number to the first line and the
 *  continuation indent to the rest, so the prompt can renumber its rules without
 *  this module knowing their order.
 *
 *  The parenthesised examples MIRROR {@link OWNER_MAP_ENGAGED} /
 *  {@link OWNER_MAP_DELEGATED} one-for-one and carry the same no-invention rule:
 *  an example that is not on the corpus map does not belong here. (Money was
 *  wrongly listed once — it is not a mapped AREA; charging / sending funds is
 *  already caught upstream as an IRREVERSIBLE action.)
 *
 *  ⚠️ THE STANDING BOUNDARIES MUST BE HERE, NOT ONLY IN THE WORKER DIGEST
 *  (2026-07-19 差し戻し4). The DELEGATE bullet grants the brain "git / integration
 *  procedure" — which literally covers 「[hold] カードの統合」, a boundary. Before the
 *  routing rule existed, such a question fell to RULE 1 (corpus does not ground it)
 *  → ABSTAIN → owner; granting the delegated area without restating the exceptions
 *  turned that into ANSWER → injected into the worker, with the owner never seeing
 *  it. The worker digest resolves the same contradiction (DECISION_ROUTING_RULES
 *  carries both the 但し書き and the boundary list), so leaving the brain — the ONLY
 *  consumer that can answer with no human in the loop — without them was the exact
 *  asymmetry to avoid. The list is INTERPOLATED from
 *  {@link PERMANENT_OWNER_BOUNDARIES} rather than restated in English so the two
 *  surfaces cannot drift: adding a boundary reaches the brain automatically, and the
 *  pin in swarmDecisionRouting.test.ts checks the rendered PROMPT for every entry.
 *  Japanese verbatim is deliberate — the questions and the corpus are Japanese, so
 *  these are the strings the brain must actually match against. */
export const BRAIN_ROUTING_RULE_LINES: readonly string[] = [
  'WHO DECIDES — route BEFORE you hand anything to the human. The corpus carries',
  'the owner\'s 「関与の観測地図」: the areas they are observed to decide, and the',
  'areas they are observed to delegate. Consult it first.',
  '- An area the owner is observed to DELEGATE (implementation choices,',
  '  algorithms, token-optimisation mechanics, git / integration procedure):',
  '  the corpus DOES ground this — the owner\'s recorded judgment is "you',
  '  decide". ANSWER with that call. Never hand a technical trade-off to the',
  '  owner; that is a MISDELIVERY, not caution.',
  '- EXCEPT the standing boundaries below. These OUTRANK the delegated bullet',
  '  above: emit ESCALATE OWNER even when one sits inside a delegated area, and',
  '  whatever the map says. (Integrating a card IS "integration procedure" — but',
  '  integrating a [hold] card is the owner\'s call, not yours.) The boundaries:',
  `    ${PERMANENT_OWNER_BOUNDARIES.join(' / ')}`,
  '- An area the owner is observed to DECIDE (the system\'s structure and the',
  '  roles in it, naming and wording, how the work is sequenced, how this',
  '  judgment record itself is built, release / publishing, friction in how the',
  '  product feels to use): emit ESCALATE OWNER — correctly addressed, and the',
  '  OWNER qualifier says "their area", not "irreversible" (use bare ESCALATE',
  '  ONLY for the irreversible case in the rule above).',
  '- NOT on the map: ABSTAIN. The human is then asked ONE plain question about',
  '  who should own this kind of call, and their answer grows the map.',
  'This NEVER overrides the irreversibility rule above: an irreversible action',
  'escalates whatever area it sits in. And explaining technology to the owner is',
  'fine — what is banned is DELEGATING a technical trade-off to them.',
]

/** Render {@link BRAIN_ROUTING_RULE_LINES} as one numbered rule block: `n. ` on
 *  the first line, a matching continuation indent on the rest. */
export const brainRoutingRule = (n: number): string[] => {
  const head = `${n}. `
  const pad = ' '.repeat(head.length)
  return BRAIN_ROUTING_RULE_LINES.map((l, i) => (i === 0 ? head + l : pad + l))
}

/** Longest slice of the worker's own question quoted into the routing question's
 *  plain lead. The FULL text always stays on the record's `question` field. */
export const ROUTING_QUESTION_SUBJECT_MAX = 200

/**
 * The two answer tokens for the routing question — WORDS, deliberately not
 * 「A」/「B」.
 *
 * WHY (the misattribution this closes): the owner's raw reply is paired with a
 * question and shipped to two places — you-corpus (the learning loop) and the
 * blocked worker's PTY (the answer injection). The worker's OWN question is very
 * often itself an A/B menu ("A: 既存テーブルを拡張 / B: 新テーブルを追加"), because
 * the worker rules ask for options. So a bare "A" answering the ROUTING question
 * ("is this yours to decide?") lands next to a technical question whose option A
 * is something else entirely — and reads as the owner picking it. A single letter
 * is a UNIVERSAL option label, so it collides with every menu; a word carries its
 * own meaning and cannot be re-bound by the neighbouring text.
 *
 * This is one of the two halves of the fix — the other is that the injection
 * carries the question the owner actually READ (swarmEscalations.buildAnswerInjection).
 */
export const ROUTING_CHOICE_DELEGATE = 'まかせる'
export const ROUTING_CHOICE_OWN = '自分で決める'

/**
 * The 平易文 for the UNCLASSIFIED lane: the proxy abstained (the corpus does not
 * ground this — i.e. the domain is not on the map), so instead of forwarding a
 * question the owner may not even want, ask the ONE routing question first.
 *
 * Shape follows the owner's 3-element rule (①何を決めてほしいか ②選択肢
 * ③選ぶとどうなるか, in living language — user-plain-language-for-owner-surfaces):
 * the second option invites the substantive answer in the SAME reply, so a
 * question the owner does want to own still costs only one round trip.
 *
 * SUBJECT FIRST: the lead sentence opens with the worker's question, not with
 * the "the AI got stuck" preamble. This text is also the notification toast's
 * teaser, which is cut at 120 chars — a preamble-first lead spent that budget on
 * boilerplate and truncated the one thing the owner needs to recognise.
 *
 * Returns '' for an empty subject: a routing question about NOTHING cannot be
 * answered, and '' is exactly what {@link openEscalation} already collapses to
 * "no plainQuestion", so the record raises bare (the worker's own text as the
 * primary) instead of showing 「」. Unreachable on the live path — the S4 caller
 * only fires on a non-empty blocker — so this is a guard, not a lane.
 */
export const buildUnclassifiedRoutingPlainQuestion = (workerQuestion: string): string => {
  const subject = workerQuestion.replace(/\s+/g, ' ').trim()
  if (!subject) return ''
  const quoted =
    subject.length > ROUTING_QUESTION_SUBJECT_MAX
      ? `${subject.slice(0, ROUTING_QUESTION_SUBJECT_MAX)}…`
      : subject
  return [
    `聞かれているのは「${quoted}」です。AIが自分では判断できずに止まりました。`,
    `まず、これが「あなたが決めたい種類の話」かどうかだけ教えてください(中身の答えは後でかまいません)。`,
    // 「止まりません」 would be a deterministic promise the mechanism cannot make: the
    // answer is appended to you-corpus as ONE entry, and whether the next question of
    // this kind gets answered is the brain re-reading that entry and judging — a
    // probabilistic path, not a stored rule. Overclaiming here would cost exactly what
    // this card is about: the owner trusting a routing answer to bind harder than it does.
    `「${ROUTING_CHOICE_DELEGATE}」と書く → AIが判断して先へ進みます。次から同じ種類の話では、なるべく止めないようにします。`,
    `「${ROUTING_CHOICE_OWN}」と書く → 続けてあなたの考えをそのまま書いてください。それがそのまま答えになります。`,
  ].join('\n')
}

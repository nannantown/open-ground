// swarmDecisionRouting — the WHO-DECIDES routing layer in front of the inbox.
//
// These pins exist because the wording IS the mechanism: the routing map never
// runs as code, it runs as text inside a worker's /order rules and the overseer
// brain's prompt. The most important assertions here are the NEGATIVE ones —
// the engaged/delegated lists are pinned EXACTLY, so a future edit that invents
// a category (rather than digesting the owner's 「関与の観測地図」 in you-corpus)
// fails loudly. That is the failure the owner corrected twice on 2026-07-18
// (「想像でつくるな」/「観測地図にせよ」).

import { describe, it, expect } from 'vitest'
import {
  BRAIN_ROUTING_RULE_LINES,
  DECISION_ROUTING_RULES,
  OWNER_MAP_DELEGATED,
  OWNER_MAP_ENGAGED,
  OWNER_NON_ENGINEER_PREMISE,
  PERMANENT_OWNER_BOUNDARIES,
  ROUTING_CHOICE_DELEGATE,
  ROUTING_CHOICE_OWN,
  ROUTING_QUESTION_SUBJECT_MAX,
  UNCLASSIFIED_ROUTING_ASK,
  brainRoutingRule,
  buildUnclassifiedRoutingPlainQuestion,
} from './swarmDecisionRouting'
import { buildOverseerAnswerPrompt } from './swarmOverseerBrain'

describe('the observation map is a DIGEST of the corpus — not invented here', () => {
  // Exact-match on purpose (not toContain): adding a bullet that is not in the
  // owner's you-corpus map must break this test. To change it, append to the
  // corpus map FIRST, then mirror it here (the sync obligation in the module
  // header).
  it('pins the areas the owner is OBSERVED to decide', () => {
    expect([...OWNER_MAP_ENGAGED]).toEqual([
      'システムの構造と役割の設計',
      '名前と言葉',
      '進め方の戦略',
      '判断の記録(ペルソナ)の作り方',
      'リリース・公開',
      '使い心地への違和感',
    ])
  })

  it('pins the areas the owner is OBSERVED to delegate', () => {
    expect([...OWNER_MAP_DELEGATED]).toEqual([
      'トークン最適化の実装方式(本人が明示的に委任)',
      'コードレベルの実装選択・アルゴリズム',
      'git/統合/検品の手順(司令塔・技術側が決める領域)',
    ])
  })

  it('pins the permanent boundaries (TARGET-STATE §5) — standing policy, not observations', () => {
    expect([...PERMANENT_OWNER_BOUNDARIES]).toEqual([
      'リリース・公開',
      'プロジェクトの削除',
      '使用可能モデルの変更',
      '停止(none-allowed park)の解除',
      '自案カードの着手承認',
      '過去 escalation への回答',
      '[hold] カードの統合',
    ])
  })

  it('records the non-engineer premise as an observed fact, dated', () => {
    expect(OWNER_NON_ENGINEER_PREMISE).toContain('オーナーは非エンジニア')
    expect(OWNER_NON_ENGINEER_PREMISE).toContain('2026-07-18')
  })

  // PRIVACY (M3). This file is TRACKED SOURCE and every release snapshots the tree
  // into the PUBLIC open-ground repo (docs/DISTRIBUTION.md §PII hygiene), while the
  // corpus it digests is the owner's private 0600 file. repoPiiGuard scans for
  // emails / names / home paths — it would NOT catch quoted private speech, so the
  // digest carries observed FACTS only. 「」 is the tell: a quoted sentence.
  it('never publishes the owner’s verbatim words — paraphrase only', () => {
    const surfaces = [
      OWNER_NON_ENGINEER_PREMISE,
      ...OWNER_MAP_ENGAGED,
      ...OWNER_MAP_DELEGATED,
      ...PERMANENT_OWNER_BOUNDARIES,
    ]
    for (const s of surfaces) expect(s).not.toMatch(/[「『]/)
    // Every 「」 span in the worker rules is an ALLOWLIST entry — all of them are
    // text WE authored (the question we put in front of the owner, the map's name,
    // and two emphasised terms). Nothing the owner said. A new span here fails this
    // test on purpose: it forces the author to confirm it isn't private speech.
    const quoted = DECISION_ROUTING_RULES.match(/「[^」]*」/g) ?? []
    expect(quoted.sort()).toEqual(
      [
        `「${UNCLASSIFIED_ROUTING_ASK}」`,
        '「判断の委任」',
        '「自分で決める」',
        '「関与の観測地図」',
        '「?」', // the character S4's question detector looks for
      ].sort(),
    )
  })

  // The other two published surfaces this module owns. The rule is about the FILE
  // being public, so leaving them unscanned left the claim with a hole: a verbatim
  // quote pasted into the brain prompt or the owner-facing question would ship
  // exactly the same way, with the suite still green.
  it('keeps the brain prompt and the owner-facing question free of quoted speech too', () => {
    const brain = BRAIN_ROUTING_RULE_LINES.join('\n')
    // The brain prompt names the map (our label for it) and nothing else quoted.
    expect(brain.match(/「[^」]*」/g) ?? []).toEqual(['「関与の観測地図」'])
    expect(brain).not.toMatch(/『/)

    // The routing question interpolates the WORKER's text as its subject, so scan
    // with a known subject and subtract it: what remains is this module's own
    // wording, and all of it must be ours.
    const subject = 'テスト用の質問'
    const spans =
      buildUnclassifiedRoutingPlainQuestion(subject).match(/「[^」]*」/g) ?? []
    expect(spans.sort()).toEqual(
      [
        `「${subject}」`, // the worker's question, quoted back at runtime
        '「あなたが決めたい種類の話」',
        `「${ROUTING_CHOICE_DELEGATE}」`,
        `「${ROUTING_CHOICE_OWN}」`,
      ].sort(),
    )
  })

  it('never asks about force-push / git stash — those are refused outright, not escalated', () => {
    expect(PERMANENT_OWNER_BOUNDARIES.join('')).not.toMatch(/force-push|stash/)
    expect(DECISION_ROUTING_RULES).not.toMatch(/force-push|stash/)
  })
})

describe('DECISION_ROUTING_RULES — the worker-facing contract', () => {
  it('stays a single line (the whole /order goal is ONE slash-command argument)', () => {
    expect(DECISION_ROUTING_RULES).not.toMatch(/[\n\r\t]/)
    // eslint-disable-next-line no-control-regex
    expect(DECISION_ROUTING_RULES).not.toMatch(/[\x00-\x1f\x7f]/)
  })

  it('routes by the observation map, NOT by a technical/non-technical category', () => {
    expect(DECISION_ROUTING_RULES).toContain('【判断の宛先・厳守】')
    expect(DECISION_ROUTING_RULES).toContain('宛先はカテゴリ(技術/非技術)では決まらない')
    expect(DECISION_ROUTING_RULES).toContain('「関与の観測地図」')
    expect(DECISION_ROUTING_RULES).toContain(OWNER_NON_ENGINEER_PREMISE)
  })

  it('carries every mapped area on both sides', () => {
    for (const area of OWNER_MAP_ENGAGED) expect(DECISION_ROUTING_RULES).toContain(area)
    for (const area of OWNER_MAP_DELEGATED) expect(DECISION_ROUTING_RULES).toContain(area)
    for (const b of PERMANENT_OWNER_BOUNDARIES) expect(DECISION_ROUTING_RULES).toContain(b)
  })

  it('tells the worker to DECIDE the delegated areas itself instead of escalating', () => {
    expect(DECISION_ROUTING_RULES).toContain('自分で決めろ(escalation にしない)')
  })

  // These rules CLOSE the escalation valve for delegated areas, so the escape
  // hatch they point at has to be a mechanism that EXISTS — otherwise the worker's
  // real options collapse to guessing or stalling. A previous revision named a
  // 「専門レビュアー(別カード)」 that lives only as an unimplemented Board todo, and the
  // test then froze that fiction by quoting it back. Each path below was traced in
  // code before being named here:
  //   • heartbeat 4th arg → `blockers`            (swarm-beat.sh → readHeartbeat)
  //   • surfaced to the commander                 (GET /api/swarm/workers → blocked/blockers)
  //   • picked up as S4 → proxy brain → PTY inject (swarmOverseer detectWorkerQuestions)
  //   • S4 requires an INTERROGATIVE               (looksLikeQuestion — a statement is dropped)
  it('points the stuck worker at a technical path that actually exists', () => {
    expect(DECISION_ROUTING_RULES).toContain('心拍の blocker')
    expect(DECISION_ROUTING_RULES).toContain('第4引数')
    expect(DECISION_ROUTING_RULES).toContain('GET /api/swarm/workers')
    expect(DECISION_ROUTING_RULES).toMatch(/S4/)
    // The gate that makes the difference between "reaches the brain" and "silently
    // ignored" — omitting it would leave the named path broken in practice.
    expect(DECISION_ROUTING_RULES).toContain('質問の形で書け')
    expect(DECISION_ROUTING_RULES).toContain('質問と判定されない文は S4 が拾わない')
    // …stated as the GATE's behaviour, not as a claim about declarative sentences:
    // looksLikeQuestion is a best-effort substring match, so a status report
    // containing 「いずれ」/「どうしても」 does pass it. Over-claiming here would be the
    // same class of error as naming a mechanism that doesn't exist.
    expect(DECISION_ROUTING_RULES).not.toContain('平叙文')
  })

  // Accuracy of the named path is the whole point of this section, so the claims
  // are pinned as CONDITIONAL where the code is conditional. Two ways to overstate:
  //   • the S4→brain leg only runs when the overseer is armed (OFF by default,
  //     in-memory, re-arms OFF on restart) — so it cannot be stated flatly;
  //   • the brain is not a guaranteed answerer — when it can't answer, the
  //     question lands in the OWNER's inbox, which the worker should expect.
  it('states the conditional legs as conditional, not as promises', () => {
    expect(DECISION_ROUTING_RULES).toContain('監督が起動していれば')
    expect(DECISION_ROUTING_RULES).toContain('大脳が答えられなければオーナーの受信箱に回る')
  })

  it('names no ESCALATION route that does not exist (the 専門レビュアー regression)', () => {
    // 2026-07-19 — THE DELIBERATE CHANGE THIS LINE ASKED FOR. The 専門レビュアー
    // DID ship (swarmSpecialistReview.ts). The previous note said "not
    // implemented anywhere — if it ever ships, wire it and change this line
    // deliberately, not by accident", so: it shipped, and the assertion STAYS.
    //
    // Why it stays. The regression this guards was never "the name is fictional"
    // — it was that the routing rules CLOSE a valve (「委任領域は escalation に
    // するな」) and pointed at 専門レビュアー as the road to take instead. What
    // shipped is not that road: it is the worker's OWN procedure for deciding
    // (read the current primary source first), carried in the same /order rules.
    // It is what you do BEFORE you are stuck, not somewhere to send a question.
    // The escalation route is unchanged and still the only one named here:
    // heartbeat blocker → commander (+ S4 → brain when the overseer is armed).
    //
    // So naming it HERE would still be the original defect — a worker told to
    // "hand it to the specialist reviewer" has nowhere to hand anything. Flipping
    // this assertion because the name now exists in the tree is exactly the
    // accident the previous author was warning about.
    expect(DECISION_ROUTING_RULES).not.toContain('専門レビュアー')
  })

  it('asks ONE plain routing question for an unmapped area', () => {
    expect(DECISION_ROUTING_RULES).toContain('地図に無い未分類の話は決めつけず')
    expect(DECISION_ROUTING_RULES).toContain(UNCLASSIFIED_ROUTING_ASK)
    expect(DECISION_ROUTING_RULES).toContain('その回答が地図を育てる')
  })

  // The owner's own correction (2026-07-18): this rule must never read as
  // "don't discuss technology with the owner" — they ask how the machinery works
  // unprompted. Only the DELEGATION of a trade-off decision is banned.
  it('separates EXPLAINING tech (allowed, deeply) from DELEGATING a trade-off (banned)', () => {
    expect(DECISION_ROUTING_RULES).toContain('これは技術の説明を禁じるものではない')
    expect(DECISION_ROUTING_RULES).toContain('聞かれたら遠慮なく深く説明してよい')
    expect(DECISION_ROUTING_RULES).toContain(
      '禁じるのは技術的トレードオフの「判断の委任」だけ',
    )
  })
})

describe('BRAIN_ROUTING_RULE_LINES — the proxy brain’s copy', () => {
  it('points AT the corpus map rather than hardcoding the categories', () => {
    const text = BRAIN_ROUTING_RULE_LINES.join('\n')
    expect(text).toContain('「関与の観測地図」')
    expect(text).toMatch(/observed to DELEGATE/)
    expect(text).toMatch(/observed to DECIDE/)
    expect(text).toMatch(/NOT on the map: ABSTAIN/)
  })

  it('stays subordinate to the irreversibility valve (K6) and allows explanation', () => {
    const text = BRAIN_ROUTING_RULE_LINES.join('\n')
    expect(text).toContain('NEVER overrides the irreversibility rule above')
    expect(text).toMatch(/explaining technology to the owner is\s+fine/)
    expect(text).toMatch(/banned is DELEGATING a technical trade-off/)
  })

  // Regression on a real slip while writing this card: "money" was listed as an
  // area the owner decides. It is NOT on the observation map — and charging /
  // sending funds is already caught upstream as an IRREVERSIBLE action, so the
  // only thing the extra example added was an invented category.
  it('does not invent an area that is absent from the corpus map', () => {
    const text = BRAIN_ROUTING_RULE_LINES.join('\n')
    expect(text).not.toMatch(/\bmoney\b/i)
    // Every mapped area the owner DELEGATES has an example standing in for it.
    expect(text).toMatch(/implementation choices/)
    expect(text).toMatch(/algorithms/)
    expect(text).toMatch(/token-optimisation mechanics/)
    expect(text).toMatch(/git \/ integration procedure/)
  })

  // ⚠️ THE REGRESSION THIS BRANCH INTRODUCED (2026-07-19 差し戻し4). Granting the
  // brain the delegated area "git / integration procedure" also handed it
  // 「[hold] カードの統合」 — a PERMANENT boundary. Before the routing rule existed
  // that question hit RULE 1 (corpus does not ground it) → ABSTAIN → owner's inbox;
  // afterwards the brain could match the delegated bullet and ANSWER, injecting
  // straight into the worker with the owner never seeing it. The pre-gate does not
  // save it either — classifyReversibility('この [hold] カードを統合していいですか？')
  // is 'reversible'. The worker digest already carried the boundaries; the brain,
  // the only consumer that answers with NO human in the loop, did not.
  it('carries the standing boundaries, and makes them OUTRANK the delegated areas', () => {
    const text = BRAIN_ROUTING_RULE_LINES.join('\n')
    // Every boundary verbatim — interpolated from the constant, so adding one to
    // PERMANENT_OWNER_BOUNDARIES reaches the brain without a second edit here.
    for (const b of PERMANENT_OWNER_BOUNDARIES) expect(text).toContain(b)
    // Presence alone is not enough: the brain has just been told it OWNS the
    // delegated areas, so the exception has to say it wins that conflict.
    expect(text).toMatch(/OUTRANK/)
    expect(text).toMatch(/ESCALATE OWNER even when one sits inside a delegated area/)
  })

  // The teeth for the above: the constant is only worth anything if it reaches the
  // PROMPT the brain actually reads. Asserting on the rendered prompt catches both
  // a gutted constant AND a broken wiring (e.g. brainRoutingRule dropped from
  // buildOverseerAnswerPrompt), which an assertion on the constant alone cannot.
  it('puts every standing boundary into the prompt the brain actually reads', () => {
    const prompt = buildOverseerAnswerPrompt({
      question: 'この [hold] カードを統合していいですか？',
      context: '',
      corpusPath: '/tmp/corpus.md',
    })
    for (const b of PERMANENT_OWNER_BOUNDARIES) expect(prompt).toContain(b)
  })

  // N4 — the ENGAGED side deserves the same coverage: without this, deleting
  // "release / publishing" from the DECIDE examples would still pass.
  it('keeps an example for every area the owner is observed to DECIDE', () => {
    const text = BRAIN_ROUTING_RULE_LINES.join(' ').replace(/\s+/g, ' ')
    expect(text).toMatch(/structure and the roles in it/) // システムの構造と役割の設計
    expect(text).toMatch(/naming and wording/) // 名前と言葉
    expect(text).toMatch(/how the work is sequenced/) // 進め方の戦略
    expect(text).toMatch(/judgment record itself is built/) // 判断の記録の作り方
    expect(text).toMatch(/release \/ publishing/) // リリース・公開
    expect(text).toMatch(/feels to use/) // 使い心地への違和感
  })

  // N1 — an owner-domain escalation must NOT be labelled irreversible, so the rule
  // has to teach the qualifier that carries the distinction.
  it('directs the owner-area verdict to ESCALATE OWNER, reserving bare ESCALATE for irreversible', () => {
    const text = BRAIN_ROUTING_RULE_LINES.join(' ').replace(/\s+/g, ' ')
    expect(text).toContain('emit ESCALATE OWNER')
    expect(text).toMatch(/bare ESCALATE ONLY for the irreversible case/)
  })

  it('numbers + indents as one rule block, so the prompt can renumber freely', () => {
    const lines = brainRoutingRule(3)
    expect(lines).toHaveLength(BRAIN_ROUTING_RULE_LINES.length)
    expect(lines[0]).toBe(`3. ${BRAIN_ROUTING_RULE_LINES[0]}`)
    // Continuation lines get the number's width as padding, and keep whatever
    // relative indent they already had (the sub-bullets stay hanging).
    lines.slice(1).forEach((l, i) => expect(l).toBe(`   ${BRAIN_ROUTING_RULE_LINES[i + 1]}`))
    // A two-digit rule number widens the padding to match.
    expect(brainRoutingRule(10)[1]).toBe(`    ${BRAIN_ROUTING_RULE_LINES[1]}`)
  })
})

describe('buildUnclassifiedRoutingPlainQuestion — the ONE question for an unmapped area', () => {
  const q = buildUnclassifiedRoutingPlainQuestion('この機能の価格はいくらにすべき？')

  it('leads with the subject, then asks only WHO owns the call', () => {
    expect(q).toContain('この機能の価格はいくらにすべき？')
    expect(q).toContain('「あなたが決めたい種類の話」かどうかだけ')
    expect(q).toContain('中身の答えは後でかまいません')
    // SUBJECT FIRST, literally: this same text is the toast teaser, cut at 120
    // chars, so a preamble in front of it burns the budget the owner needs to
    // recognise what is being asked.
    expect(q.startsWith('聞かれているのは「')).toBe(true)
    expect(q.indexOf('この機能の価格')).toBeLessThan(q.indexOf('AIが自分では判断できず'))
  })

  it('offers the two routing options with their consequence (the 3-element rule)', () => {
    expect(q).toContain(`「${ROUTING_CHOICE_DELEGATE}」と書く`)
    // Stated as an intention, not a guarantee: the answer becomes one you-corpus
    // entry that the NEXT brain run has to read and judge. A flat 「止まりません」
    // promises a stored rule that does not exist.
    expect(q).toContain('なるべく止めないようにします')
    expect(q).not.toContain('次から同じ種類の話では止まりません')
    expect(q).toContain(`「${ROUTING_CHOICE_OWN}」と書く`)
    // The second option must let the owner answer the substance in the SAME
    // reply — one round trip.
    expect(q).toContain('それがそのまま答えになります')
  })

  // MISATTRIBUTION GUARD (the reason the tokens are words). The worker's own
  // question is usually an A/B menu, and the owner's raw reply gets paired with a
  // question in you-corpus and in the worker's PTY. A bare "A" is a UNIVERSAL
  // option label, so it re-binds to whatever menu sits next to it — "A" answering
  // "is this yours to decide?" reads as picking the worker's option A. A word
  // cannot be re-bound that way.
  it('labels the choices with WORDS, never bare A/B letters', () => {
    expect(ROUTING_CHOICE_DELEGATE).not.toMatch(/^[A-Za-z]$/)
    expect(ROUTING_CHOICE_OWN).not.toMatch(/^[A-Za-z]$/)
    // No line may present an option as "A:" / "B:" — that is the colliding shape.
    for (const line of q.split('\n')) expect(line).not.toMatch(/^[AB][:：]/)
  })

  it('flattens and truncates a long/multi-line worker question (the full text stays on the record)', () => {
    const long = `a\nb\t${'長'.repeat(400)}`
    const out = buildUnclassifiedRoutingPlainQuestion(long)
    expect(out).toContain('a b 長')
    expect(out).toContain('…')
    expect(out).not.toContain('長'.repeat(ROUTING_QUESTION_SUBJECT_MAX + 1))
  })

  // An empty subject cannot be routed — asking "is THIS yours to decide?" about
  // nothing is unanswerable, and 『聞かれているのは「」です』 is worse than saying
  // nothing. '' is precisely what openEscalation collapses to "no plainQuestion",
  // so the record falls back to raising the worker's own text bare.
  it('returns empty for an empty/blank question rather than quoting nothing', () => {
    expect(buildUnclassifiedRoutingPlainQuestion('')).toBe('')
    expect(buildUnclassifiedRoutingPlainQuestion('   \n\t ')).toBe('')
  })
})

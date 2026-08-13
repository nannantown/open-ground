import { SWARM_LAUNCH_MODEL } from './swarmLaunch'
import { describe, it, expect } from 'vitest'
import {
  swarmBranchName,
  swarmWorktreeDirName,
  pickBaseRef,
  buildOrderInjection,
  SWARM_BASE_REF_PREFERENCE,
  WORKER_ORDER_RULES,
  WORKER_RESUME_INJECTION,
} from './swarmWorker'
import { DECISION_ROUTING_RULES } from './swarmDecisionRouting'
import { SPECIALIST_REVIEW_RULES } from './swarmSpecialistReview'
import { languageDirective } from './promptLang'

// The git-touching parts (createSwarmWorktree / removeSwarmWorktree /
// spawnSwarmWorker) need a registered project + a real repo + the `claude` CLI,
// so they are curl-verified on the real machine. Here we pin the PURE pieces —
// branch/dir naming (argv-safety), base-ref precedence, and the exact /order
// injection text (the slash-command + control-byte contract).

describe('swarmBranchName', () => {
  it('always lives under swarm/ and carries the stamp', () => {
    expect(swarmBranchName('0622-130501-ab12')).toBe('swarm/0622-130501-ab12')
  })

  it('slugs a hint and prefixes the stamp', () => {
    expect(swarmBranchName('0622-130501-ab12', 'Fix the Login Bug')).toBe(
      'swarm/fix-the-login-bug-0622-130501-ab12',
    )
  })

  it('keeps the branch argv-safe (no spaces, quotes, option chars, unicode)', () => {
    const b = swarmBranchName('0622-130501-ab12', '日本語  --rf; rm -rf / `evil` $(x)')
    // Only [a-z0-9-] after the swarm/ prefix, no leading dash on the slug.
    expect(b).toMatch(/^swarm\/[a-z0-9][a-z0-9-]*$/)
    expect(b).not.toMatch(/\s/)
    expect(b.startsWith('swarm/-')).toBe(false)
  })

  it('caps the hint slug at 24 chars', () => {
    const b = swarmBranchName('s', 'a'.repeat(80))
    const slug = b.slice('swarm/'.length, b.indexOf('-s'))
    // The slug segment never exceeds 24 chars (stamp follows after a dash).
    expect(slug.length).toBeLessThanOrEqual(24)
  })

  it('falls back to a placeholder when the stamp sanitizes to empty', () => {
    expect(swarmBranchName('!!!')).toBe('swarm/x')
  })
})

describe('swarmWorktreeDirName', () => {
  it('strips the swarm/ prefix for the dir name', () => {
    expect(swarmWorktreeDirName('swarm/0622-130501-ab12')).toBe('0622-130501-ab12')
    expect(swarmWorktreeDirName('swarm/fix-login-0622-130501')).toBe('fix-login-0622-130501')
  })

  it('flattens any residual slash so the dir is a single segment', () => {
    expect(swarmWorktreeDirName('swarm/a/b')).toBe('a-b')
  })
})

describe('pickBaseRef', () => {
  it('prefers origin/main when present', () => {
    expect(pickBaseRef(new Set(['origin/main', 'main', 'HEAD']))).toBe('origin/main')
  })

  it('falls back to local main, then HEAD', () => {
    expect(pickBaseRef(new Set(['main', 'HEAD']))).toBe('main')
    expect(pickBaseRef(new Set(['HEAD']))).toBe('HEAD')
  })

  it('defaults to HEAD when nothing is known', () => {
    expect(pickBaseRef(new Set())).toBe('HEAD')
  })

  it('preference order is origin/main → main → HEAD', () => {
    expect([...SWARM_BASE_REF_PREFERENCE]).toEqual(['origin/main', 'main', 'HEAD'])
  })
})

describe('WORKER_ORDER_RULES token discipline', () => {
  it('carries the tool-bundling / scoped-read / tail-output / two-stage-test clauses', () => {
    expect(WORKER_ORDER_RULES).toMatch(/【トークン規律・厳守】/)
    expect(WORKER_ORDER_RULES).toMatch(/1応答に束ねて並列実行する/)
    expect(WORKER_ORDER_RULES).toMatch(/調べものはできるだけまとめて一度に/)
    expect(WORKER_ORDER_RULES).toMatch(/範囲指定 Read か grep で当たりを付けてから読む/)
    expect(WORKER_ORDER_RULES).toMatch(/同じファイルを読み直さない/)
    expect(WORKER_ORDER_RULES).toMatch(/tail\/要約で受ける/)
    expect(WORKER_ORDER_RULES).toMatch(/フルスイート\(npm test\)は完了ゲートとして最後に1回/)
    expect(WORKER_ORDER_RULES).toMatch(/「当たり」\(対象ファイル\)があれば探索せず直行する/)
  })

  it('does not relax the completion gate or pre-ready self-commit rule', () => {
    expect(WORKER_ORDER_RULES).toMatch(
      /完了ゲート\(npx tsc --noEmit \/ npm test \/ lint の3点\)と ready 前セルフコミットの規約は一切緩めない/,
    )
  })

  // 2026-07-22 の (a) 書き換えは「条件付きルール → 既定の反転」だった。効くのは
  // 見出し句ではなく、その下の機構2文 — ①単発応答を『その結果を見ないと次が決まらない
  // 時』だけに絞る既定文 と ②送信直前の自己点検 — である。束ね率の定義は
  // `tool_use 数 ÷ tool_use を含む応答数`(swarmTokenAudit.ts)なので比を動かせるのは
  // 「1応答あたりの道具数」だけで、その数を実際に増やすのはこの2文だからだ。
  // ⚠ 当初のピンは見出し句 `調べものはできるだけまとめて一度に` 1本きりで、機構2文は
  // **両方消してもスイート全緑**だった(= スローガンだけが守られ、効く部分は無防備)。
  // 見出しは「何と呼ぶか」しか固定しない。ここで固定するのは「何をさせるか」の方。
  // 併せて (b) 手前までを (a) 節として切り出し、機構が **(a) の中に在る**ことまで
  // 見る — 別の節へ流れて (a) が見出しだけの殻に戻る書き換えも赤にするため。
  it('pins the DEFAULT-INVERSION mechanism of (a), not just its heading', () => {
    const blockStart = WORKER_ORDER_RULES.indexOf('【トークン規律・厳守】')
    const blockEnd = WORKER_ORDER_RULES.indexOf('【質問は平易文で・厳守】')
    expect(blockStart).toBeGreaterThan(-1)
    expect(blockEnd).toBeGreaterThan(blockStart)
    const tokenBlock = WORKER_ORDER_RULES.slice(blockStart, blockEnd)

    const aStart = tokenBlock.indexOf('(a) ')
    const aEnd = tokenBlock.indexOf(' (b) ')
    expect(aStart).toBeGreaterThan(-1)
    expect(aEnd).toBeGreaterThan(aStart) // 切り出しの健全性: (a)(b) の順序が壊れたら赤
    const clauseA = tokenBlock.slice(aStart, aEnd)

    expect(clauseA).toContain('調べものはできるだけまとめて一度に')
    // ① 既定の反転そのもの — 束ねるのが既定で、単発は結果依存の時だけの例外
    expect(clauseA).toContain('既定は「まとめて出す」側だと考えろ')
    expect(clauseA).toContain(
      '道具を1つだけ載せた応答が許されるのは、その結果を見ないと次に何をするか決まらない時だけ',
    )
    // ② 既定を行動に変える送信直前の自己点検(これが無いと既定文は心構えで終わる)
    expect(clauseA).toContain('1つだけ送りそうになったら')
    expect(clauseA).toContain(
      '送信する前に「この後どうせ要る調べものは?」を先に洗い出して同じ応答に足せ',
    )
  })

  /** 【トークン規律】節から letter の条文だけを切り出す。閉じ位置は「次の lettered
   *  条文」— (a) が ' (b) ' で閉じているのと同じ形を、次条文がまだ無い**最終条文**でも
   *  成り立つように一般化したもの。⚠ 固定文字列(節末の完了ゲート文)で閉じてはいけない:
   *  (g) の後ろに条文が挿し込まれた瞬間にスライスがそれを飲み込み、「機構が別節へ流れて
   *  見出しだけの殻に戻る」書き換えを取り逃す — 2026-07-28 の敵対レビュー m5(機構を
   *  新設 (h) へ移す変異)が 51 passed で素通りした実測がある。**探すのは letter より
   *  後ろの英字だけ**: 条文本文が他条文を「(a)」のように参照するので、[a-z] で探すと
   *  その参照でスライスが早期に閉じてしまう。 */
  const tokenClause = (letter: string): string => {
    const blockStart = WORKER_ORDER_RULES.indexOf('【トークン規律・厳守】')
    const blockEnd = WORKER_ORDER_RULES.indexOf('【質問は平易文で・厳守】')
    expect(blockStart).toBeGreaterThan(-1)
    expect(blockEnd).toBeGreaterThan(blockStart)
    const tokenBlock = WORKER_ORDER_RULES.slice(blockStart, blockEnd)

    const start = tokenBlock.indexOf(`(${letter}) `)
    expect(start).toBeGreaterThan(-1)
    const nextRe = new RegExp(`\\s\\([${String.fromCharCode(letter.charCodeAt(0) + 1)}-z]\\)\\s`)
    const rel = tokenBlock.slice(start + 4).search(nextRe)
    const gate = tokenBlock.indexOf('完了ゲート(npx tsc --noEmit')
    expect(gate).toBeGreaterThan(start)
    const clause = tokenBlock.slice(start, rel === -1 ? gate : Math.min(start + 4 + rel, gate))
    // 境界そのもののピン: スライスが後続条文を飲み込んでいない(m5 を赤にする一行)
    expect(clause).not.toMatch(nextRe)
    return clause
  }

  // 2026-07-28 の (g) 追加も (a) と同じ設計 — 効くのは見出しではなく機構である。
  // 計量器は sidechain 応答を turns/toolTurns/toolUses/maxContext の**すべてから
  // 除外**する(swarmTokenAudit.ts)。⚠ ただし**その効き目は指標ごとに向きが違う**
  // (初版のこのコメントは「比は上がる」と一方向に書いていた — 誤り):
  //   文脈max: 全トリガで**下がる**(subagent が読んだ中身が親の文脈に積まれない)。
  //            (g) の無条件の効き目はこちらで、燃費カードの「文脈」項目の解。
  //   束ね率 : **上下する**。②(当たりが絞れない探索)では単発の調査手 k 個が Task 1手
  //            に畳まれ、超過分(toolUses − toolTurns)不変のまま分母が k−1 縮んで比が
  //            上がる。だが①(3+ファイル横断)の反実仮想は「単発 b 手」ではなく **(a)
  //            が生むはずだった b 個入り1応答**で、Task に回すと分母は動かず分子だけ
  //            b−1 減る = **比は下がる**。①は必須かつ (a) より具体的なので b≥3 では
  //            (g) が勝ち、(a) の最も束ねた応答をちょうど食う。
  // その効き目を実際に生むのは次の4点で、どれか1つでも消えると条項は殻になる:
  //   ① 明示指示であること — harness 既定は「ユーザーが要求しない限り subagent を
  //      控える」なので、「使ってよい」に薄めると発火率0のままになる(実測: 既存の
  //      一次資料ブロックの「重い調査は sub-agent へ」は8カード連続で sidechain 0)。
  //   ② トリガが観測可能であること — 「重い調査」のような主観語に戻すと、(a) が
  //      書き換えられたのと同じ理由(気づけた時しか発火しない)で空振りする。
  //   ③ 要点だけ受け取ること — 全文を親に戻させたら 文脈max は下がらない。
  //   ④ (a) との優先関係 — ①が (a) の束ね読みを食う経路を絞る唯一の文。これを落とすと
  //      「読む場所が分かっている 3ファイル」まで Task 1手に化け、束ね率の下げ幅が
  //      そのまま残る(2026-07-28 敵対レビュー MUST-FIX 1)。
  // 切り出しに tokenClause を使うのは、機構が別節へ流れて (g) が見出しだけの殻に戻る
  // 書き換え(m5)も赤にするため — その保証は閉じ位置そのものに掛かっている。
  it('pins the SUBAGENT-OFFLOAD mechanism of (g), not just its heading', () => {
    const clauseG = tokenClause('g')

    expect(clauseG).toContain('長い調べものは自分で読まず subagent に投げる')
    // ① 許可ではなく指示(既定の抑制を上書きする)
    expect(clauseG).toContain('これは「使ってもよい」ではなく明示指示だ')
    // ② 観測可能なトリガ3つ(主観語「重い調査」への差し戻しを赤にする)
    expect(clauseG).toContain('自分で読み始める前に Task ツールで subagent を1手起こせ')
    expect(clauseG).toContain('3ファイル以上を横断して読む必要がある')
    expect(clauseG).toContain('grep の当たりが絞れず探索になる')
    expect(clauseG).toContain('ログ・テスト出力・大きな生成物を読み解く')
    // ③ 要点だけ受け取る(全文を戻させたら 文脈max は下がらない)
    expect(clauseG).toContain('受け取るのは要点だけにしろ')
    expect(clauseG).toContain('全文を戻させるな')
    // ④ (a) との優先関係 — ①が (a) の高束ね応答を食う経路を絞る
    expect(clauseG).toContain('ただし①が (a) とぶつかったら (a) が勝つ')
    expect(clauseG).toContain('読む場所が既に file:line で特定できているなら')
    expect(clauseG).toContain('探索になる時だけだ')
    // 境界 — 投げるのは調査だけ。判断・実装・完了ゲートは worker 自身の仕事のまま
    expect(clauseG).toContain('投げるのは調査だけで、判断・実装・完了ゲートは自分でやる')
  })

  // (g) は (a) と噛み合って初めて最大に効く: Task も「まとめて1応答」の対象である
  // ことを落とすと、subagent 起動そのものが単発手として分母に戻ってしまう。
  // ⚠ assert は (g) スライス限定 — 全体に対して見ていると、この一文が別節へ移動しても
  // 緑のまま通る(2026-07-28 敵対レビュー 非ブロッカー1)。
  it('keeps (g) wired to (a) — parallel Tasks ride the same batching default', () => {
    expect(tokenClause('g')).toContain(
      '独立した調べものが複数あるなら Task も同じ応答にまとめて出す',
    )
  })
})

describe('WORKER_ORDER_RULES decision routing (2026-07-18 — WHO decides)', () => {
  // The plain-language rule made an owner-bound question READABLE; this one stops
  // the wrong question being sent at all. The wording itself is pinned in
  // swarmDecisionRouting.test.ts — here we only pin that every spawn carries it.
  it('appends the routing rules verbatim (every /order gets the addressing gate)', () => {
    expect(WORKER_ORDER_RULES).toContain(DECISION_ROUTING_RULES)
    expect(WORKER_ORDER_RULES).toContain('【判断の宛先・厳守】')
  })

  it('keeps the routing clause on the SAME single line as the rest of the order', () => {
    expect(WORKER_ORDER_RULES).not.toMatch(/[\n\r\t]/)
  })

  it('reaches the actual injected prompt, not just the constant', () => {
    expect(buildOrderInjection('カードの題名', undefined, undefined, 'en')).toContain(DECISION_ROUTING_RULES)
  })
})

describe('WORKER_ORDER_RULES specialist review (2026-07-19 — HOW it is decided)', () => {
  // The routing rules above decide a technical call is NOT the owner's — which
  // makes this worker its receiver, and the receiver has a training cutoff. This
  // clause makes it read the current primary source before deciding. The wording
  // is pinned in swarmSpecialistReview.test.ts; here we pin that every spawn
  // carries it (same split as the routing pins directly above).
  it('appends the sourcing procedure verbatim (every /order gets it)', () => {
    expect(WORKER_ORDER_RULES).toContain(SPECIALIST_REVIEW_RULES)
    expect(WORKER_ORDER_RULES).toContain('【技術判断は一次資料で・厳守】')
  })

  it('reaches the actual injected prompt, not just the constant', () => {
    expect(buildOrderInjection('カードの題名', undefined, undefined, 'en')).toContain(SPECIALIST_REVIEW_RULES)
  })

  it('keeps the whole rule-set on ONE line even with both clauses appended', () => {
    expect(WORKER_ORDER_RULES).not.toMatch(/[\n\r\t]/)
  })
})

describe('buildOrderInjection', () => {
  // `lang` is a REQUIRED 4th argument (2026-08-13 rework — see the function's
  // doc comment). Every fixture below fixes it to 'en' so these assertions
  // (about title/notes/priorFailure composition) stay independent of the
  // dedicated `lang` describe block further down.
  it('prefixes the slash command and the ゴール: label (worker rules appended)', () => {
    expect(buildOrderInjection('Add a logout button', undefined, undefined, 'en')).toBe(
      '/order ゴール: Add a logout button' + WORKER_ORDER_RULES + languageDirective('en'),
    )
  })

  it('joins title and notes with an em dash', () => {
    expect(buildOrderInjection('Logout button', 'in the header, top-right', undefined, 'en')).toBe(
      '/order ゴール: Logout button — in the header, top-right' + WORKER_ORDER_RULES + languageDirective('en'),
    )
  })

  it('flattens newlines/tabs to single spaces (single-line so /order is a command)', () => {
    const out = buildOrderInjection('line one\nline two', 'a\tb\n\nc', undefined, 'en')
    expect(out).toBe('/order ゴール: line one line two — a b c' + WORKER_ORDER_RULES + languageDirective('en'))
    expect(out).not.toMatch(/[\n\r\t]/)
  })

  it('strips ESC / control bytes (no terminal-control injection from a card)', () => {
    // A title that embeds ESC[201~ (the bracketed-paste terminator) + a raw CR
    // must not survive — the same injection vector pastePrompt guards.
    const out = buildOrderInjection('evil\x1b[201~\rtitle', 'x\x00y\x7fz', undefined, 'en')
    expect(out).not.toMatch(/\x1b/)
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/[\x00-\x1f\x7f]/)
    // Control bytes become spaces (neutralized — the ESC can no longer open a
    // control sequence), then whitespace collapses: 'evil␛[201~␍title' → 'evil [201~ title'.
    expect(out).toBe('/order ゴール: evil [201~ title — x y z' + WORKER_ORDER_RULES + languageDirective('en'))
  })

  it('handles notes-only (empty title) without a dangling dash', () => {
    expect(buildOrderInjection('', 'just notes', undefined, 'en')).toBe(
      '/order ゴール: just notes' + WORKER_ORDER_RULES + languageDirective('en'),
    )
    expect(buildOrderInjection('   ', 'just notes', undefined, 'en')).toBe(
      '/order ゴール: just notes' + WORKER_ORDER_RULES + languageDirective('en'),
    )
  })

  it('handles an empty goal gracefully', () => {
    expect(buildOrderInjection('', '', undefined, 'en')).toBe(
      '/order ゴール: ' + WORKER_ORDER_RULES + languageDirective('en'),
    )
  })

  it('burns the worker discipline into EVERY order — push ban, §6 stop-at-ready, heartbeats (2e7beb2)', () => {
    // The exact contract: single-line, and it names the three behaviors the
    // 2e7beb2 worker violated — pushing, skipping §6 (stop at ready, commander
    // integrates), and never beating a heartbeat.
    expect(WORKER_ORDER_RULES).not.toMatch(/[\n\r\t]/)
    expect(WORKER_ORDER_RULES).toContain('git push は全形態禁止')
    expect(WORKER_ORDER_RULES).toContain('司令塔用なので実行しない')
    expect(WORKER_ORDER_RULES).toContain('done true で「停止」')
    expect(WORKER_ORDER_RULES).toContain('swarm-beat.sh')
    expect(WORKER_ORDER_RULES).toContain('30 分無心拍は anomaly')
    // Plain-language questions (2026-07-17 owner feedback): a worker's question
    // reaches a NON-PROGRAMMER owner verbatim — the rules must demand the
    // 3-element 平易文 (①決めること ②選択肢 ③影響) with tech detail demoted.
    expect(WORKER_ORDER_RULES).toContain('質問は平易文で')
    expect(WORKER_ORDER_RULES).toContain('プログラムを書いたことがない人')
    expect(WORKER_ORDER_RULES).toContain('選択肢')
    // ...and it rides every spawn prompt, learning-loop dispatches included.
    // (ends with WORKER_ORDER_RULES + the reply-language directive, in that order.)
    expect(
      buildOrderInjection('T', 'n', undefined, 'en').endsWith(WORKER_ORDER_RULES + languageDirective('en')),
    ).toBe(true)
    expect(
      buildOrderInjection('T', 'n', 'prior fail', 'en').endsWith(WORKER_ORDER_RULES + languageDirective('en')),
    ).toBe(true)
  })

  it('orders the worker to COMMIT BEFORE the completion gate (the 2026-07-12 全損)', () => {
    // The old rule read 実装→検証→git commit: commit AFTER the gate. A worker
    // obeyed it, was force-reclaimed at the execution ceiling mid-gate, and lost 15
    // uncommitted files with its worktree. The discipline must now say, in the
    // prompt every worker actually reads: commit at every phase boundary, and never
    // enter the gate dirty. (The engine's salvage commit is the net — this is the
    // discipline; a worker whose own commits exist never needs the net.)
    expect(WORKER_ORDER_RULES).toContain('フェーズの境目ごとに必ず git commit')
    expect(WORKER_ORDER_RULES).toContain('完了ゲート')
    expect(WORKER_ORDER_RULES).toContain('WIP コミットを打ってから回す')
    // The WHY has to ride along — a rule without its reason is the first one dropped.
    expect(WORKER_ORDER_RULES).toContain('worktree ごと強制回収')
    // Still one line (the whole order is a single slash-command argument).
    expect(WORKER_ORDER_RULES).not.toMatch(/[\n\r\t]/)
  })

  it('appends the LEARNING-LOOP clause when a prior 差し戻し reason is given (card fdf714ef)', () => {
    const out = buildOrderInjection('Logout button', 'in the header', 'tsc: error TS2345 not assignable', 'en')
    // The goal is preserved AND the prior-failure cause is appended, labelled.
    expect(out).toContain('/order ゴール: Logout button — in the header')
    expect(out).toContain('前回の差し戻し理由・同じ失敗を繰り返さないこと')
    expect(out).toContain('TS2345 not assignable')
  })

  it('keeps the prior-failure clause SINGLE-LINE (multi-line tsc tail flattened, /order stays one arg)', () => {
    const out = buildOrderInjection('T', undefined, 'line one\nerror TS1\n\nerror TS2\twith tab', 'en')
    expect(out).not.toMatch(/[\n\r\t]/)
    expect(out).toContain('line one error TS1 error TS2 with tab')
  })

  it('omits the clause entirely for a first dispatch (no prior failure) — byte-for-byte unchanged', () => {
    // Absent / empty / whitespace-only priorFailure ⇒ identical output (lang fixed to 'en').
    const plain = buildOrderInjection('T', 'n', undefined, 'en')
    expect(buildOrderInjection('T', 'n', '', 'en')).toBe(plain)
    expect(buildOrderInjection('T', 'n', '   ', 'en')).toBe(plain)
    expect(plain).not.toContain('前回の差し戻し理由')
  })

  describe('lang (Settings.language ⇒ the worker replies in that language, REQUIRED param)', () => {
    // `lang` is required, not optional (2026-08-13 rework) — "omitted" no
    // longer exists as a call shape, TS refuses to compile it (M1: a caller
    // that forgets to pass `lang` now fails `tsc`, not a silent no-op). What
    // is left to prove: 'en' and 'ja' each carry their OWN literal marker and
    // never the other's — checked against literal substrings, not by
    // re-deriving the expectation from `languageDirective` itself (a mutation
    // that swapped in an empty string for one branch would still satisfy
    // `toBe(X + languageDirective(lang))` if both sides call the same
    // function under test).
    it('en ⇒ appends the English reply-language directive (literal marker)', () => {
      const out = buildOrderInjection('T', 'n', undefined, 'en')
      expect(out.endsWith(languageDirective('en'))).toBe(true)
      expect(out).toContain('[Reply language]')
      expect(out).not.toContain('【返答言語】')
    })
    it('ja ⇒ appends the Japanese reply-language directive (literal marker)', () => {
      const out = buildOrderInjection('T', 'n', undefined, 'ja')
      expect(out.endsWith(languageDirective('ja'))).toBe(true)
      expect(out).toContain('【返答言語】')
      expect(out).not.toContain('[Reply language]')
    })
    it('stays single-line with lang appended (delivery contract)', () => {
      expect(buildOrderInjection('T', 'n', 'err\nline', 'en')).not.toMatch(/[\n\r\t]/)
    })
  })
})

describe('WORKER_RESUME_INJECTION (card 4 — the resume prompt)', () => {
  it('is a SINGLE slash-command line (the buildOrderInjection delivery contract)', () => {
    // ONE line so the whole thing lands as one slash-command argument (no [Pasted
    // text] chip). Same constraint as the sisters MANAGER_/SUPPLY_RESUME_INJECTION.
    expect(WORKER_RESUME_INJECTION).not.toMatch(/[\n\r\t]/)
    expect(WORKER_RESUME_INJECTION.startsWith('/order ')).toBe(true)
  })

  it('re-orients the worker WITHOUT reading as a new goal', () => {
    expect(WORKER_RESUME_INJECTION).toContain('セッション再開')
    // the crux: the REAL goal is in history — do not treat this line as the goal
    expect(WORKER_RESUME_INJECTION).toContain('新しいゴールと取り違えるな')
    expect(WORKER_RESUME_INJECTION).toContain('完了条件は変わっていない')
    // re-read the Board + re-beat before continuing
    expect(WORKER_RESUME_INJECTION).toContain('swarm-beat.sh')
    expect(WORKER_RESUME_INJECTION).toContain('git push')
  })
})


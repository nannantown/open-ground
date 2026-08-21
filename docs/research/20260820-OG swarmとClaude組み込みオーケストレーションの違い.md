# OG swarm と Claude 組み込みオーケストレーションの違い

> 調査日: 2026-08-20。手段: コードベースの実読(前段の公開可否監査 + CLAUDE.md / docs/commander)。Web調査ではなく現物確認。

## この調査の問い

オーナーの疑問(2026-08-20): 「OGでオーケストレーション的なのあるけど、claudeに元々ついてるworkflow的なのとちがうの？」。知りたいことは、**OGのswarmと、Claude Code が元々持つ Workflow / subagent は何が違うのか。同じことを二度作っていないか**。

## 問いへの答え

**重なるのは「複数のClaudeを束ねる」という素材だけ。目的と寿命が別物で、二重開発ではない。** Claude組み込みは*1ターン使い切りの道具*、OG swarmは*何日も立ち続ける常設チーム*。そして OG swarm は Claude の機能を**土台にして**作られている(競合ではなく、その上に乗る製品レイヤー)。

| | Claude組み込み Workflow / subagent | OG swarm |
|---|---|---|
| 寿命 | 1ターン・使い切り(答えたら消える) | 常設エンジン(何日も稼働・再起動しても続く) |
| 束ねる相手 | モデル自身の助っ人(文脈を共有しデータを返す) | 独立した本物の `claude` セッション(各自の worktree・各自のツール) |
| 状態の置き場 | スクリプト内の変数・戻り値(揮発) | Board+git worktree+受信箱(ディスク上・人が見える・永続) |
| 人の関わり | 起動して結果を待つ | Boardを整え、エスカレーションに答える(非同期の人間監督) |
| 成果物 | この会話への答え | 実プロジェクトへのコミット(ブランチ・マージ・レポート) |
| 対象範囲 | いま開いている1タスク | 複数プロジェクトを横断する常設の作業場 |
| 主導権 | モデルが扇状に分岐 | 人がBoardで舵、司令官が配分 |

要するに — Claude組み込みは**エンジン部品**(1回の賢いターンを扇状に広げる強力な道具)、OG swarmは**コックピットと常駐クルー**(それを常設運用に組み上げた製品)。

## 観測: コードが示す事実

### 1. OG swarm の構造(現物)
- 役割分担: 司令官(commander/manager)・補給官(supply/PM)・ワーカー(worker)・監督(overseer)。別々の「席」で分業。
- Board 駆動: `todo` → 司令官が引く → ワーカーに配る → `doing`→`review`→`done`。Board が受け渡し点。
- 各ワーカーは**本物の claude**(サブスク専用・ユーザー自身の claude)を **git worktree 隔離**(`~/.openground/projects/<uuid>/worktrees/`)で実行。PreToolUse ガードで危険操作を拒否。
- **エスカレーション**: 詰まったら平易文でオーナーに質問(plainQuestion)。非同期の人間監督が設計に組み込まれている。
- 何日も稼働(engine-ON の7日窓・再起動しても続く・自己更新・通知)。
- 出典: `docs/commander/00-INDEX.md` / `TARGET-STATE.md`、`src/lib/server/swarmOrchestrator.ts` / `swarmWorkerSdk.ts` / `swarmSupply.ts`、CLAUDE.md「Terminal execution」「Swarm」節。

### 2. Claude 組み込みの構造(この会話で使ったもの)
- Workflow ツール: 決定的な JS スクリプトで subagent を `parallel`/`pipeline` に扇状展開。1ターンで走って結果を返し、終わる。
- subagent / Agent ツール: スコープを切った子エージェントを起動し結果を受け取る。
- いずれも**1セッション内・モデル主導・揮発**。人は最終結果を見る。
- 実例: このレポートの前段でやった「公開可否の6並列監査+敵対検証」がまさにこれ。
- 出典: この会話で実際に使用した Workflow 実行(監査タスク)。

### 3. 依存関係(重要)
- OG swarm は Claude の CLI / Agent SDK ランタイムを**土台に**している(`swarmWorkerSdk.ts` は Agent SDK、PTY 経路は node-pty が `claude` を spawn)。
- つまり素材は同じ。OG は「1回の賢いターン」を「Boardから仕事を引く常設の人間監督チーム」に組み上げている。
- 出典: CLAUDE.md「Architecture」、システムプロンプト「running within the Claude Agent SDK」。

## 解釈: OG swarm の固有価値と戦略メモ

*(ここから統合=解釈)*

Claude組み込みには無くて OG swarm にあるものは4つ:

1. **永続性** — 1ターンで消えず、何日も立ち続けエンジンとして働く。
2. **Board(かんばん)** — 仕事の受け渡しと状態が、人が見えるディスク上の板にある。
3. **人間監督** — 平易文エスカレーションと受信箱で、人が非同期に舵を取る。
4. **横断コックピット** — 複数プロジェクトを1つの面で束ねる(OG の元思想「Claude Code のコックピット」の延長)。

**戦略メモ(正直に)**: Claude の組み込みオーケストレーションが強くなるほど、「swarm だけの価値は何か」を問われる。答えは上の4点。ここが薄れると「Claudeで足りる」になる。だから磨くべきは機能の派手さではなく、**Boardで人が舵を取る常設運用**という体験そのもの。0.11.94 の opt-in 公開も、この4点を一般ユーザーが体験できる入口を開けた、という位置づけ。

## この面での判断材料(既知の弱点)
- swarm はまだ調整中(GAP-1: ワーカーが約1時間で死ぬ・双子ブランチ・通知遅延)。だから 0.11.94 は opt-in+注意書きにした。
- 通知が日本語ハードコード・Windows ガード未検証。これも成熟度側の課題で、Claude組み込みとの差ではなく「常設運用の作り込み」の残作業。

## 出典一覧

- docs/commander/00-INDEX.md / TARGET-STATE.md(swarm の正典・理想形)
- src/lib/server/swarmOrchestrator.ts / swarmWorkerSdk.ts / swarmSupply.ts / swarmOverseer.ts(エンジン)
- CLAUDE.md「What this is」「Architecture」「Terminal execution」「Swarm / 司令塔まわりの正典」節
- docs/research/20260820-swarmとリサーチを全ユーザーに公開してよいか.md(前段の公開可否監査)
- この会話の Workflow 実行(Claude 組み込みオーケストレーションの実例)

【調査手法の注記】外部サイトではなくコードベースと会話内の実行の実読による。swarm 側の事実は前段の並列監査(敵対検証済み)から、Claude 組み込み側の事実はこのセッションで実際に走らせた Workflow から取った。

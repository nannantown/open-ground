# PLATFORM-GAP-LEDGER — 待てば消える工事の台帳(維持のみ・拡張禁止)

**制定: 2026-08-12。** 対象読者: swarm コアを改修する worker と司令塔。

## 0. この台帳が存在する理由

OG の swarm はプラットフォーム(claude CLI / Agent SDK)が**公開していない信号**を、
画面スクレイプ・プローブ・心拍ファイルで補って動いている。この補償工事は必要だが、
**プラットフォーム側が公式に埋めに来る領域**でもある — 公式が埋めた瞬間、工事は
資産から負債(保守コスト+CLI 更新のたびに割れるセンサー)に変わる。

実測の根拠: quota 検知だけで**五層**(04 章)、その調律の事故記録が docs/commander の
かなりの割合を占める。センサー層は本質的に砂上 — `claude` の TUI 文言・画面構造が
変わるたびに割れる(04 章 §3.7 の 3 幅レンダリング回帰テストは、その脆さの防波堤そのもの)。

**規則(非交渉の2つ):**

1. **この台帳に載った機構への「新機能」追加は設計のスメル。** バグ修正・安全修正・
   誤検知修正は通常どおり行う。だが検知能力の拡張・新パターン追加・新センサー新設を
   したくなったら、まず「公式にその信号を出す経路が来ていないか」を確認し、カードに
   「なぜ今 OG 側で作るか(公式経路の現状)」を明記してから着手する。
2. **削除トリガが満たされたら、削除カードを起票する。** この台帳の理想の最終状態は
   **空**である。行が減ることが前進で、行が増えるのは(新たな補償が本当に必要なら)
   やむを得ない後退 — 増やすカードはこの台帳への行追加を完了条件に含める。

## 1. 台帳

| 機構 | 正典(コード) | 補償しているプラットフォームギャップ | 削除トリガ(公式側にこれが来たら) | 方針 |
|---|---|---|---|---|
| quota 層A: 冷却テーブル(永続) | `swarmQuota.ts`(`markRateLimited` / cooling) | per-model の枯渇状態を問い合わせる API が無い | 公式 quota/usage API が per-model の残量・reset 時刻を返す | 維持のみ |
| quota 層B: rate-limit **画面スクレイプ**(45s 沈黙サンプリング・onset 窓・`limitScreen` クランプ) | `swarmRateLimitText.ts` + `swarmOrchestrator.ts` の検知部 | PTY worker では CLI の TUI 文言が枯渇の唯一の信号 | **公式 API 不要** — SDK worker は構造化イベント(`quota_refusal` = `sdkDeskLimit.ts`)で同じ事実を受け取れる | **凍結** — TARGET-STATE §9 の削除条件(PTY fallback 0 の 4 週)で worker 経路を削除 |
| quota 層D: `/usage` キャッシュの pre-launch veto | `claudeUsageCli.ts` + `swarmLaunch.ts` | `/usage` が per-model 行を出さない(fable 単独枯渇が見えない — 04 章 §5.7) | 同上(per-model usage API) | 維持のみ |
| quota 層E: 起動前プローブ(headless 1 発で拒否文言を読む) | `swarmTierProbe.ts` | per-model 枯渇を起動前に知る手段が無い(プローブ実測 19〜73s) | 同上 | 維持のみ・パターン追加は規則 1 の手続きで |
| bash 心拍(`readyToMerge` の唯一の書き手) | `scripts/swarm-beat.sh` + `openground-swarm-lib.sh`(読み手は `swarmHeartbeatFiles.ts`) | PTY worker の完了自己申告に HTTP/イベント経路が無い(GAP-8 — 00-INDEX 0727/0728 追記) | **公式 API 不要** — SDK worker はセッションイベントで代替可能 | PTY 凍結と運命共同体(TARGET-STATE §9)。PowerShell 版は作らない(決定済み) |
| オーナー卓の上限画面監視 | `ownerDeskLimit.ts` | 人間が開いている卓の枯渇を CLI が外部へ通知しない | CLI がネイティブ通知/イベントを出す | **維持**(人間の卓は SDK 化しないので、PTY 凍結後も残る唯一のスクレイプ) |
| transcript JSONL 直読 | `transcript.ts` / `swarmTranscriptProof.ts` / `swarmTokenAudit.ts` | セッション内容・トークン消費を問い合わせる API が無い | 公式 transcript / usage-per-session API | 維持のみ |
| 会話 resume 台帳 | `swarmSessions.ts`(swarm-sessions.json) | セッション一覧と「この卓の前回会話」を引く API が限定的 | 公式 session list/resume API の拡充 | 維持のみ |
| guard hook(PreToolUse deny) | `~/.openground/guard/openground-guard.js`(配備は `installHooks`) | 破壊操作の構造的封鎖を CLI 側 permission だけでは表現しきれない | CLI の permission 体系がパス単位 deny を吸収 | 維持(安全装置 — 消すのは最後) |

## 2. 使い方

- **worker / 司令塔**: この表の機構に触れるカードを受けたら、まず「方針」列を読む。
  「維持のみ」の機構に機能追加を求めるカードは、起票者に規則 1 の確認
  (公式経路の現状)を差し戻してよい。
- **棚卸し**: リリースノート(Claude Code / Agent SDK)で削除トリガ列に該当する機能が
  出たら、該当行の削除カードを起票し、行に `→ 削除カード起票済み(<id>)` を追記する。
- この台帳は**機構の存在理由**を記録するもので、機構の**仕様**は各正典(コード+各章)が持つ。
  仕様の疑問はこの台帳で解決しないこと。

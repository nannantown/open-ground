# Research ナレッジ(要点ダイジェスト+質問ボックス+読み上げ) — 一枚企画

> 日付 / 版: 2026-08-18 / v1

## きっかけ

8/18、オーナーが AIResearch の調査レポートを開いて一言:「文字が多くて読む気が
失せる」。レポートは /research スキルが良質な長文を積むほど、開いた瞬間の壁は
高くなる。「調査ファイルに対しての質問ボックスとか、要点だけまとめて読み上げる
機能とか(NotebookLM が近い?)。ナレッジとして使える感じにしてほしい」。

## どんなときに使うか

調査カードが完了してレポートが並んだとき、全文を読む前に**30秒で要点を掴み、
気になった点だけをそのレポートに質問して**、次の判断(買う/作る/やめる)に進みたい。

## かける量 (Appetite)

**上限:** 1日(このセッション内、0.11.92 として1リリース)
**溢れたら削るもの:** ①回答ごとの読み上げボタン(要点の読み上げだけ残す)
②stale 表示(再生成ボタンだけ残す)。**横断検索はそもそも入れない**(下記)。

## やらないこと (Non-goals)

- **レポート横断の質問(RAG)はしない** — 今回の器は「1レポート=1ナレッジ」。
  横断は保存形も UI も別物で、1日に入らない。
- **NotebookLM 的な音声番組(対話形式の音声生成)はしない** — 読み上げは OS の
  音声合成(SpeechSynthesis)のみ。通信ゼロ・追加コストゼロ・オフラインで動く。
- ~~**ダイジェストを自動生成しない** — claude 実行は明示ボタンのみ。開いただけで
  オーナーのサブスク時間を燃やさない(実行主体は常にオーナー)。~~
  **↑ 0.11.93 でオーナー自身が修正**(2026-08-18:「要点はデフォルトでだしておこう」)。
  要点が**まだ無い**レポートを開いたときだけ自動で1回抽出する。作り直し(stale 含む)は
  引き続き明示ボタンのみ・失敗しても自動リトライはしない(1マウント1レポート1回)。
- **本文の編集・削除はしない** — この面は読み取り専用のまま。リポジトリへは
  今後も一切書かない(ダイジェストと Q&A は中央データ側に置く)。
- **要約に点数や判定をつけない** — 要点は「抽出」であり「評価」ではない。

## 言ってよいこと

- ◯ 「要点は AI がこのレポートから抜き出したものです。全文は下にあります。」
  (生成物と原文の区別を画面が自分で言う)
- ◯ 「レポートが更新されています — この要点は前の版から作られました。」(stale)
- ◯ 失敗時: 「要点を作れませんでした。」+ 再試行(数字なし)
- ◯ 「質問はまだありません。」(Q&A の読みが成功して空のときだけ)
- ✕ 「このレポートの結論は◯◯」という**判定枠**は作らない
- ✕ 読めなかったときに「質問はまだありません」と言わない(読めない≠空)

## 材料はあるか

- レポート本文: **ある**(docs/research/*.md、researchReports.ts が確保済み)。
- ダイジェスト/Q&A の保存先: **ない → この企画で作る**。派生データなので遡及不要
  (`~/.openground/projects/<uuid>/research-knowledge/`、レポート内容の sha で
  版ずれを検出)。作った日から使える。
- claude 実行の型: **ある**(generateDescription のジョブ登録簿+マーカー抽出、
  personaChat の失敗コピー)。

## いちばん危ういところ

**リスク:** 実現性 — 複数行の回答を PTY 画面から欠けなく回収できるか
(ANSI・折返し・エコーの中から BEGIN/END 行で切り出す。既存マーカーは1行専用)。
**確かめ方:** リリース前に実機一巡 — コンテナの本番ビルドで本物の claude に
実レポートへの質問を1本通し、回収した回答が画面に完全に出ることを目視する。

## できたと言える状態

実機(本番ビルド)で: レポートを開く → 「要点を作る」を押す → TL;DR+要点3〜6点の
カードが出て、**再起動後も残る**。質問ボックスに日本語で聞くと回答が Q&A に残る。
読み上げボタンで要点が音声になる(停止もできる)。レポートを書き換えると「前の版」
表示が出て作り直せる。プロジェクトのリポジトリには何も書き込まれていない。

## 検証記録 (2026-08-18, container 実機一巡)

The done-state above was verified on the production build (`node
server/dist/index.cjs`, fresh `OPENGROUND_HOME`, registered smoke repo), with
the claude leg split in two because the container cannot legitimately accept
claude's interactive Bypass-Permissions consent dialog (root + first run —
on the owner's Mac that consent has existed for months):

1. **Real model, production prompts** — `claude --model haiku -p` over the
   real report emitted the full marker contract (TLDR + 6 POINT lines ja;
   2 ANS lines for a ja question), and the production `extractNumbered` /
   `extractMarkerSpan` recovered everything through injected ANSI/CRLF noise.
2. **Full pipeline + UI** — via the documented `OPENGROUND_CLAUDE_BIN` seam,
   a stub replayed THOSE real model bytes line-by-line with delays (settle
   path exercised); Playwright drove the actual buttons: 要点を作る → working
   line → card; question → answer in the notebook (multi-line intact); stale
   line after editing the report; digest+Q&A survive a server restart; sidecar
   under `~/.openground/projects/<uuid>/research-knowledge/`; repo file list
   byte-identical before/after.

Container bench states needed to get real claude running at all (all
user-level CLI state that already exists on any real machine):
`hasCompletedOnboarding` in `~/.claude.json` (else the first-run welcome
swallows the auto-sent prompt — found via a `script(1)` recording of the
hidden PTY), and the login-shell PATH not containing the claude bin (the
absolute-path `OPENGROUND_CLAUDE_BIN`/resolvedBin seam covers it). The
Bypass-Permissions consent screen is the one residual only a human can
answer; the owner's first real 「要点を作る」 press runs on a machine where it
was answered long ago.

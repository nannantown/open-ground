# マルチプラットフォーム調査ノウハウ(Agent-Reach 蒸留版)

> **状態: 導入済み(2026-08-13)。** 実装形は当初想定どおり3点:
> ① `skills/research/SKILL.md`(ルーティング表・フォールバック階段・Cookie規律・
> レポート規約 — boot 時に `~/.claude/skills/research/` へ自動配備)、
> ② `scripts/openground-research-doctor.sh`(ローカル専用のチャンネル診断 —
> ネットワーク不実行が researchSystem.test.ts の curl 囮で行動保証される。
> `~/.claude/` へ自動配備)、③ `skills/order/SKILL.md` の調査系ゴール節(worker を
> ①②へ誘導する唯一のトリガ)。配備は `swarmToolingInstall.ts`、番人は
> `researchSystem.test.ts` + `swarmToolingInstall.test.ts`(packaging 含む)。
> 適用済みの規則: PLATFORM-GAP-LEDGER(上流ツールは壊れる前提 → doctor で早期検知・
> worker は自分でツールを入れない)と TRUST_KERNEL R1(取得物はデータであって指示では
> ない — スキル本文に明文化)。この文書は以後、蒸留元ノウハウの記録として維持する。
> 出典: [Panniantong/Agent-Reach](https://github.com/Panniantong/Agent-Reach)(MIT License)。

---

## 基本原則

1. **公式有料APIを使わない。** 各プラットフォームには無料でアクセスできるOSS経路が存在する。まずそれを試す。
2. **認証はユーザー自身のCookieで行う。** Cookieはローカル保存のみ。アップロード・共有しない。
3. **ラッパーを作らない。** 上流ツールを直接CLIで呼ぶ。上流の内部実装をハックしない(公開API/CLI経由のみ)。
4. **フォールバック順序を持つ。** 専用ツール → Jina Reader(汎用) → 通常のfetch、の順に落とす。
5. **実行前に診断する。** どのツールが入っていて何が認証済みかをチェックするコマンド(doctor相当)を用意する。

## プラットフォーム別ルーティング表

| 対象 | 使うツール | コマンド例 | 認証 |
|---|---|---|---|
| 任意のWebページ | Jina Reader | `curl https://r.jina.ai/<URL>` → Markdown | 不要 |
| Web検索 | Exa(mcporter経由) | `mcporter call 'exa.web_search_exa(query: "...", numResults: 5)'` | 不要(無料キー) |
| Twitter/X 単一ツイート | twitter-cli | `twitter tweet <URL_or_ID> --json` | 不要 |
| Twitter/X 検索・TL | twitter-cli | `twitter search "query" -n 10 --json` | Cookie必須 |
| Reddit | rdt-cli | `rdt search "query"` / `rdt read <POST_ID>` | Cookie(`rdt login`) |
| YouTube メタ情報 | yt-dlp | `yt-dlp --dump-json "<URL>"` | 不要 |
| YouTube 字幕 | yt-dlp | `yt-dlp --write-sub --write-auto-sub --sub-lang "ja,en" --skip-download -o "/tmp/%(id)s" "<URL>"` | 不要 |
| GitHub 公開リポジトリ | gh CLI | `gh repo view owner/repo` / `gh search repos "query" --sort stars` | 不要(書き込みは `gh auth login`) |
| RSS/Atom | feedparser (Python) | `feedparser.parse(url)` | 不要 |
| Bilibili | yt-dlp | YouTubeと同じ | 不要(サーバーIPはプロキシ要) |
| LinkedIn 公開ページ | Jina Reader | `curl https://r.jina.ai/<URL>` | 不要 |

## Cookie認証の扱い方

- ユーザーにブラウザ拡張(Cookie-Editor等)でCookieをエクスポートしてもらい、環境変数または設定ファイルに保存する。
  - 例: Twitter は `TWITTER_AUTH_TOKEN` と `TWITTER_CT0` をプロセス環境に設定してから twitter-cli を呼ぶ。
- QRコードログインや自動ログインは実装しない(不安定・規約リスク大)。手動エクスポートのみ。
- Cookieは絶対に外部送信しない。設計としてローカル保存を保証し、それをユーザーに明示する。

## 環境の注意点

- **サーバー/データセンターIPはブロックされやすい**(Reddit 403、Bilibili等)。ローカル実行なら不要だが、サーバーデプロイ時はレジデンシャルプロキシ(月$1程度、Webshare等)を挟む。
- 一時ファイルは `/tmp/` に、永続データは専用ディレクトリ(例: `~/.myapp/`)に置き、作業ディレクトリを汚さない。
- 上流ツールは仕様変更で突然壊れる。定期的にバージョン追従し、doctor相当の診断で早期検知する。

## 診断(doctor)の設計

各チャンネルに `check()` を実装し、以下を一覧表示する:
- ✅ 利用可能(ツール導入済み・認証済み)
- ⚠️ 部分的に利用可(例: 閲覧のみ可、検索はCookie待ち)
- ⬜ 未設定(何をすれば解放されるかを1行で示す)

## アーキテクチャの型(差し替え可能なチャンネル設計)

```
channels/
├── base.py       # 共通契約: can_handle(url) / read(url) / search(query) / check()
├── web.py        # → Jina Reader(Firecrawl等に差し替え可)
├── twitter.py    # → twitter-cli
├── youtube.py    # → yt-dlp
├── github.py     # → gh CLI
├── reddit.py     # → rdt-cli
└── rss.py        # → feedparser
```

- 1プラットフォーム=1ファイル。チャンネルは「上流ツールの存在確認とルーティング」だけを担い、取得ロジック自体は持たない。
- 気に入らないバックエンドはファイル単位で差し替える。

## 調査タスクの組み立て方(ユースケース)

- **競合調査**: GitHub Issues(バグ・要望の生データ)+ Reddit(実ユーザーの評価)を組み合わせる。公式ドキュメントに載らない生の声が取れる。
- **SNSモニタリング**: Twitter検索+Reddit検索で自社プロダクト名・業界キーワードの言及を収集。
- **動画コンテンツの要約**: yt-dlpで字幕を取得してLLMに渡す(動画を「見る」必要はない)。

## リスクと免責(アプリに組み込む際の注意)

- スクレイピング経路は各プラットフォームの利用規約上グレー。商用アプリに組み込む場合は規約リスクを自分で評価すること。
- レート制限の代わりに「動く保証がない」のがコスト。重要フローには公式APIへのフォールバックか、壊れた時の通知を用意する。

# OPEN GROUND: 会話データモデル移行プラン

> 合意方針 (2026-05-29): **OPEN GROUND は会話 full 本文を永久保存しない。**
> ① 最新サマリ = 軽量・強永続 / ② 過去 full = claude JSONL を参照だけ /
> ③ ライブログ = in-memory + SSE、完了後 ① に畳む。
> 背景と事故 (dismiss all が runs/ 全消し): メモリ `project-chat-data-model`
> / `feedback-tests-isolate-home` 参照。

## 現状の実態 (調査確定)

- THREAD 本文・カード hero は `~/.openground/runs/*.json` が**唯一の disk ソース**
  (`listSessions()` runner.ts:390)。これが空だと THREAD も hero も空。
- カード hero は client 側で run entries から都度計算 (useRuns.ts:694)、**永続なし**。
- 会話本文は claude が `~/.claude/projects/<toDirName(cwd)>/<sessionId>.jsonl` に
  永久保存。observer (observer.ts) がこれを tail して RunEntry を構築。
- `ProjectTask` は軽量 (id/title/done/milestoneId/createdAt)。run metadata なし。
- `clearFinishedSessions` (dismiss all) が runs/*.json を**即 unlink、回復不可**。

## 新データモデル

```ts
// src/lib/types.ts (新規)
interface TaskRunSummary {   // ① 最新サマリ。本文・log は含めない
  kind: 'done'|'review'|'skipped'|'error'|'overloaded'|'cancelled'
  topic?: string; summary: string; blockers: string
  followups?: string[]; question?: string; taskComplete?: boolean
  sessionId: string; finishedAt: string
}
interface TranscriptRef {    // ② claude JSONL への参照。本文は持たない
  sessionId: string; cwd: string; jsonlPath: string
}
// ProjectTask 拡張 (全 optional、後方互換)
//   latestRun?: TaskRunSummary
//   agentSessionId?: string
//   transcriptRef?: TranscriptRef
```

- `task.latestRun` を tasks.json に永続 → fresh app でも hero/THREAD サマリが出る。
- `task.transcriptRef` で過去 full は claude JSONL から遅延読み。
- `~/.openground/runs/` は**キャッシュ**に降格。消えても ① が残る。

## フェーズ (各 PR 独立)

| # | risk | 名前 | Goal state | Expected behavior |
|---|---|---|---|---|
| 1 | low | 再発防止 | `OPENGROUND_HOME` env で HOME 隔離可、vitest が tmp HOME、dismiss が unlink→archive | テストが本番 ~/.openground を壊さない。dismiss all しても archive から復元可 |
| 2 | low | 型・スキーマ拡張 | TaskRunSummary/TranscriptRef + ProjectTask 3 フィールド (optional)、zod 対応、往復 OK | 既存 tasks.json 互換のまま新フィールドを書ける |
| 3 | med | ①最新サマリ永続 | run 完了で targetedTasks の task.latestRun/agentSessionId/transcriptRef を tasks.json に書く | fresh app でカード hero と THREAD サマリが runs/ 無しでも出る |
| 4 | med | ②過去ログ API | `GET /api/run/transcript` が transcriptRef から JSONL をページング返却 (validateProjectPath) | 「過去ログを見る」で claude JSONL の full 本文が読める |
| 5 | med | 既存移行 + runs キャッシュ降格 | 起動 sweep で既存 runs/*.json から latestRun 未設定 task を一度だけ埋める。以後 runs/ は純キャッシュ | 移行後 resume/observer/Phase7 が全て動き、runs/ が消えても hero/サマリ無事 |

依存: 1 → 2 → 3 → {4, 5}。

## 壊してはいけない契約 (移行中 verify)

- **resume**: `claude --resume <sessionId>` — agentSessionId が保持され続ける
- **observer JSONL tail**: transcriptPath/sessionId が要る
- **run queue (Phase 7)**: goal.runQueue.sessions の sessionId 参照
- **worktree 隔離・merge**、**SSE (run/events)** の live ストリーム
- **カード hero / auto-loop / question turn**
- **後方互換**: 既存 tasks.json (新フィールドなし) / 既存 runs/ を持つユーザーが壊れない

## open questions の判断 (デフォルト確定、再協議不要)

1. **畳む単位**: targetedTasks の**全 task** に latestRun を書く (各 task が自分の最新を持つ)
2. **task 消失 run**: 捨てる (軽量優先、claude JSONL には残る)
3. **archive 保持**: 30日 mtime auto-prune
4. **transcript キャッシュ**: まず毎回素読み (遅ければ後で in-memory)
5. **dismiss**: archive 一本化 + 「完全削除」は確認モーダル付きで別途残す
6. **hero 優先**: finishedAt 比較で新しい方
7. **移行トリガー**: サーバ起動 sweep に相乗り (透明)

## 移行 (後方互換)

- 新フィールドは全 optional。既存 tasks.json は読めるまま。
- Phase 5 の起動 sweep が既存 runs/*.json を一度だけ走査し、latestRun 未設定の
  task を埋める (data loss なく前進)。今は runs/ が空なので埋まらないが、仕組みは
  入れる (今後の run が ① を永続するので fresh app で消えなくなる)。

# 05 — Board 列ライフサイクルと /api/project・/api/swarm API 契約

> **対象コミット: `cc7c60e`** (origin/main tip, 2026-07-10 —
> "fix(swarm): 手動 dispatch とエンジンの二重 dispatch 窓を両方向とも塞ぐ")。
> 行番号は原則このコミット時点。読者 = 将来の司令塔(og-manage / manage セッション)。
> **例外: §6.2 の `/api/swarm/*` 行番号は 2026-07-12(会話 resume 実装)に現物から実測し直した**
> (`server/routes/swarm.ts` は +17 シフトしていた)。同日 **§10(会話 resume)** を追加。
> 本文書の主張には全て `file:line` の根拠を付けてある。裏取りは §9 の検証コマンドで自分で行うこと。

## 0. 司令塔が最初に覚える 5 行

1. **Board の真実はサーバ**: `~/.openground/projects/<uuid>/tasks.json` が唯一の永続体
   (`src/lib/server/projectData.ts:50-53`)。UI もエンジンも全員 HTTP API 経由でここを読む/書く。
2. **カード操作の id は必ずフル UUID**。全 verb が `t.id === id` の完全一致
   (`server/routes/project.ts:940` ほか)。短縮 id は `unknown task id` — 0707 の誤診の根っこ。
3. **列移動は 2 経路で意味が違う**: API の `setColumn` は done/todo 着地で `reworkCount` を
   リセットする(`server/routes/project.ts:956-957`)が、**UI ドラッグはリセットしない**
   (`src/components/canvas/BoardTab.tsx:214-254` — `reworkCount` に触れない)。
4. **書き込みは全部ロック/CAS 越し**: 読んで直したいなら `POST /api/project/tasks` の verb を使う
   (サーバ側 `mutateProjectData` がロック内 read-modify-write)。`PUT /api/project` の全量上書きは
   CAS トークン(`updatedAt`)必須 — 落とすと素通りで他人の書き込みを潰す(§4.2)。
5. **手動 dispatch は必ず `POST /api/swarm/worker` に `taskId` を渡す**。claim 先行 CAS +
   エンジン `pendingDispatch` の両方向封鎖(cc7c60e)はこのルートの中にある(§5)。
   自前で `setColumn doing` → PTY 起動、をバラで組むと封鎖の外に出る。

---

## 1. 構造 — 何がどこにあるか

| 層 | ファイル | 役割 |
|---|---|---|
| ルート(Board/project) | `server/routes/project.ts` | `/api/project*` の Hono チェーン。thin adapter — 実ロジックは `src/lib/server/*` (`server/routes/project.ts:1-8`) |
| ルート(swarm) | `server/routes/swarm.ts` | `/api/swarm/*` の Hono チェーン。**全ルート owner gate** (`server/routes/swarm.ts:34-41`) |
| データ読み書き | `src/lib/server/projectData.ts` | `readProjectData` / `writeProjectData`(CAS) / `mutateProjectData`(per-project ロック) |
| カード schema | `src/lib/schemas.ts:39-156` | `ProjectTaskSchema`(zod)。`src/lib/schemas.ts:158-196` が `ProjectDataSchema` |
| TS 契約 | `src/lib/types.ts:1440-1532` | `ProjectTask`。`:1577` `BoardColumn`。API レスポンス型もここ |
| path 検証 | `server/middleware/projectPath.ts:68-75` | `requireProjectPath`(body→query の順で path を読む `:44-56`)。実体は `src/lib/server/projectData.ts:373-374` → `projectDataPath.ts` の registry allowlist |
| owner gate | `src/lib/server/roles.ts:115-134` | `getCustomTabRole()` — **サーバ永続 session**(`readSession`)から解決。リクエストの cookie/ヘッダは見ない → 同一マシンの curl でも owner ログイン済みなら通る |
| エンジン | `src/lib/server/swarmOrchestrator.ts` | 自律 dispatch/monitor/integrate。状態は `globalThis.__openground_swarm_orchestrator`(`:1532-1534`) — **in-memory、再起動で消える** |
| 手動 worker 生成 | `src/lib/server/swarmWorker.ts` (`spawnSwarmWorker`) | 中央 worktree + claude PTY + /order 注入。ルートから呼ばれる |

- Hono マウント: ルートはフルパス宣言で `server/app.ts` が `app.route('/', …)` する
  (`server/routes/project.ts:7-8`)。ポートは 47776 固定。
- **エンジンも Board API の客**: エンジンの列移動は全て自分の loopback へ
  `POST /api/project/tasks` を投げる(`src/lib/server/swarmOrchestrator.ts:2127-2153`
  setColumn+setBranch、`:2335-2347` recover=setColumn、`:3593-3601` done、
  `:3603-3615` setIntegrationConflict)。つまり列移動の書き込みセマンティクスは
  この文書の §4 が唯一の正典で、エンジン専用の裏口は無い。

## 2. カード schema(zod)と .catch レジリエンス

### 2.1 フィールド一覧(`src/lib/schemas.ts:39-156` / `src/lib/types.ts:1440-1532`)

| フィールド | zod | 不正値のとき |
|---|---|---|
| `id` | `z.string().min(1)` | **カードごと drop**(identity) |
| `title` | `z.string()` | **カードごと drop**(identity) |
| `done` | `z.boolean()` | **カードごと drop**(identity) |
| `createdAt` | `z.string().catch('').default('')` | `''` に落ちてカード生存 (`schemas.ts:60`) |
| `boardColumn` | `z.enum([todo,doing,review,done,blocked]).optional().catch('todo')` | **`'todo'` に落ちる**(undefined ではない — 次回読み込みで legacy 扱い消失するのを防ぐ `schemas.ts:61-68`) |
| `notes` `assignee` `boardOrder` `prUrl` `branch` `reviewedBy` `titleAuto` `dependsOn` | `.optional().catch(undefined)` | フィールドだけ drop |
| `priority` | `z.enum([urgent,high,normal,low]).optional().catch(undefined)` | 同上(absent = 'normal') |
| `dueDate` | `regex(YYYY-MM-DD).optional().catch(undefined)` | 同上 |
| `run` | `{flow?, model?, effort?}.optional().catch(undefined)` | 同上 |
| `attachments` | preprocess で**要素単位** filter + `.catch(undefined)` (`schemas.ts:104-109`) | 壊れた要素だけ drop、非配列ならフィールド drop |
| `integrationConflict` | `.optional().catch(undefined)` | フィールド drop |
| `selfSupplyKey` / `selfSupplyApproved` | `.optional().catch(undefined)` | drop。approved が落ちる方向は**ゲート閉**で安全 (`schemas.ts:148-149`) |
| `reworkCount` | `z.number().int().nonnegative().optional().catch(undefined)` | drop(負数/小数でループガードを無効化できない `schemas.ts:150-155`) |

### 2.2 「不正 1 フィールドでカードが消えない」二段構え

1. **フィールド段**: identity 3 つ(id/title/done)以外は全て `.catch` — 壊れた値は
   そのフィールドだけ落ちる(drop-the-field-never-the-card 契約、`schemas.ts:42-48`)。
2. **カード段**: それでも whole-file の `ProjectDataSchema.safeParse` が失敗したら、
   `readProjectData` は空で返さず **per-card 回収**に落ちる —
   `filterValid(obj.tasks, ProjectTaskSchema)` で個々に通ったカードだけ残す
   (`src/lib/server/projectData.ts:85-110`)。identity が壊れたカードは
   **ここで初めて丸ごと消える**(だから .catch の網羅が効いている)。

補助として: 壊れた tasks.json を上書きする直前に `tasks.corrupt-<epoch>.json` へ**隔離退避**
する(`src/lib/server/projectData.ts:229-231, :253-260`) — 消える前のデータは disk に残る。

### 2.3 スキーマ 3 点セットの掟(フィールドを増やすとき)

永続フィールドの正典は **types.ts + schemas.ts の 2 点**(`normalizeCard` は削除済み —
`schemas.ts:91-93`)。zod 側に足し忘れると **read→write ラウンドトリップで silent strip**
(zod object は unknown key を剥ぐ、`schemas.ts:71-76` priority の注記)。

### 2.4 reworkCount の載り方

- **増える**: `POST /api/project/tasks {rework:[{id}]}` だけが +1 する
  (`server/routes/project.ts:1000`)。
- **消える(リセット)**: `setColumn` で `done`/`todo` に着地 (`project.ts:956-957`)、
  `markDone` (`project.ts:881`)。
- **保持**: UI ドラッグ(§3.3)、`review`/`doing`/`blocked` への setColumn。
- **別物に注意 — カウンタは 3 系統ある**:
  - `card.reworkCount`(この文書の対象 — API verb が管理)
  - エンジン内部の `engine.reworks` Map(in-memory。エンジンの差し戻しは
    `moveToDoing`=setColumn を使い **{rework} verb を叩かない** —
    `swarmOrchestrator.ts:2149-2150, :4423, :4754, :4897` は全て `deps.moveToDoing`)
  - `~/.claude/swarm-board.sh rework` の心拍ディレクトリ内カウンタファイル
    (`types.ts:1526-1528` に「別管理・干渉しない」と明記)
  つまり「エンジンが 3 回差し戻したのにカードの reworkCount が 0」は正常であり得る。

## 3. 列ライフサイクル正典(状態機械)

`BoardColumn = 'todo' | 'doing' | 'review' | 'done' | 'blocked'` (`src/lib/types.ts:1577`)。
`done` フラグは列に従属: setColumn は常に `done: mv.column === 'done'` に同期する
(`server/routes/project.ts:949`)。

```
                （worker 起動が自動で移す）
   todo ────────────────────────────────▶ doing
    ▲   手動: claimCardForDispatch (CAS)     │
    │   エンジン: moveToDoing                │ worker が READY（心拍 done true / 完了サイン）
    │                                        ▼
    │      rework verb（counter+1）       review ──── 統合(main入り確認後) ───▶ done
    └── resolve 'todo' ◀──┐                 │  エンジン autoMerge=defaultMoveToDone
                          │                 │  司令塔=手動マージ後 setColumn done
        counter > maxReworks（既定3）        │
   blocked ◀──────────────┴─────────────────┘（resolve 'blocked' / 人間判断）
```

### 3.1 各遷移の実装箇所

| 遷移 | 誰が | 根拠 |
|---|---|---|
| todo→doing | **手動 dispatch**: `POST /api/swarm/worker` が spawn **前**に claim CAS で移す | `server/routes/swarm.ts:177-190, :317` |
| todo→doing | **エンジン**: spawn 成功後に `deps.moveToDoing`(=setColumn doing + setBranch) | `swarmOrchestrator.ts:4595, :2127-2150` |
| doing→review | **エンジン monitor**: 完了判定(commit-gated)で promote | `swarmOrchestrator.ts:3945`; stage 定義 `types.ts:984-998` |
| doing→review | **司令塔(手動)**: worker の心拍 `done true` を見て `setColumn review` | 運用(§9 のコマンド) |
| review→done | **main 入り確認後のみ**。エンジン autoMerge(FF/クリーン rebase のみ・conflict は自動解決しない) | `swarmOrchestrator.ts:3593-3601, :4613-4628`; トグルは `server/routes/swarm.ts:606-627` |
| review→doing | **rework verb**(counter+1) | `server/routes/project.ts:984-1014` |
| review→blocked | rework の counter が maxReworks(既定 3)を**超えた**とき(`count > max`) | `server/routes/project.ts:1000-1001` |
| 任意→blocked/todo | `POST /api/swarm/orchestrator/review/resolve`(スタック review カードの人間裁定) | `server/routes/swarm.ts:628-652` |
| crash 回収 | エンジンがカードを todo(再投入)/blocked(退避)へ | `swarmOrchestrator.ts:2332-2347` |

### 3.2 blocked 列の二面性

- **正典**: 人間判断待ち(rework 上限超過の退避先 `project.ts:983`、worker/stop の駐機先
  `server/routes/swarm.ts:583-590`、resolve の 'blocked')。
- **慣行**: **保留レーンとしての流用**(依存待ちカードを `[Phase1保留]` 等のタイトルで置く)。
  ディスパッチ対象は todo 列だけなので安全に寝かせられる — エンジンの `selectDispatch` は
  todo しか拾わず(`swarm.ts:159-160` の claim コメント「selectDispatch only ever picks todo
  cards」)、claim 判定でも blocked/done は「誰も取り合わない列」(`swarm.ts:164-167`)。
  依存が解けたら補給官/司令塔が todo へ戻す。

### 3.3 UI ドラッグは別の書き込み経路(ここを混同すると誤診する)

UI のドラッグは `withCardMoved`(`src/components/canvas/BoardTab.tsx:214-254`)が
クライアント側で `boardColumn`/`boardOrder`/`done` を書き換え、`reviewedBy`(active 列行き)と
`integrationConflict`(review 外行き)は**クリアする**が **`reworkCount` は `...t` のまま保持**。
保存は debounce 350ms 後の `PUT /api/project`(全量、CAS 付き —
`src/components/canvas/ProjectPanel.tsx:808-859`)。409 を食らうと**自分の draft を捨てて
サーバ側を採用**する(`:831-846`)。

→ 帰結: 「done へ手で運んだのに reworkCount が残ってる」は仕様。counter を確実に消したいなら
API の `setColumn done`(または markDone)を使う。

## 4. 書き込みの原子性

### 4.1 mutateProjectData — verb 系の土台(per-project ロック)

`POST /api/project/tasks` の全 verb は `mutateProjectData(path, mutate)` の**ロック内**
read-modify-write で実行される(`server/routes/project.ts:857`)。

- ロックは per-project の Promise 直列キュー `withBoardLock`
  (`src/lib/server/projectData.ts:151-163`)。**lock key は解決済み central dir**
  (UUID 由来) — raw path で鍵を作ると `/tmp` と `/private/tmp` のような同一プロジェクトの
  別表記が別キューに割れて CAS を素通りするため(`projectData.ts:140-150`)。
- キューは `globalThis.__openground_board_writes` に置かれ tsx watch リロードを生き延びる
  (`projectData.ts:129-153`)。
- ロック内で read → mutate → `writeCasGuarded`(read したばかりの `updatedAt` を CAS token に)。
  **敗者は勝者の write の後ろに並んで勝者の結果の上に自分の mutation を適用**するので、
  worker の setBranch とエンジンの setColumn が同時に飛んでも両方残る
  (`projectData.ts:309-354`、route 側の意図コメント `project.ts:841-847`)。
- `ProjectDataConflictError` がここから出るのは「ロックを通らない trusting writer が
  割り込んだ」ときだけ → route は 409 `{error, conflict:true}` にマップ
  (`project.ts:1028-1036`)。

`writeCasGuarded` 自体(`projectData.ts:238-268`): 1 回の read で CAS compare / 次スタンプの
種 / 破損検知を賄い、破損(corrupt/damaged)なら隔離退避してから atomic write(fsync 付き)。
`updatedAt` は**厳密単調**(同一 ms 内の連続書き込みでも +1ms して一意 —
`projectData.ts:177-185`)。

### 4.2 PUT /api/project — 全量上書きの CAS

- body の `updatedAt` が「最後に読んだスナップショットの token」として
  `expectUpdatedAt` に渡る(`server/routes/project.ts:275-294`)。ズレたら 409。
- **⚠️ 落とし穴**: `typeof body.updatedAt === 'string'` でないと `expectUpdatedAt` は
  `undefined` = **trusting write(CAS スキップ)** (`project.ts:285`,
  `projectData.ts:246-250`)。curl で全量 PUT するとき `updatedAt` を落とすと、
  並行して動いている UI / エンジンの直近の書き込みを**黙って潰せてしまう**。
  司令塔は原則 PUT を使わず verb(POST tasks)を使うこと。

### 4.3 POST /api/project/tasks — verb ごとの入力検証と結果

**共通**: `path` 必須 + `validateProjectPath`(`project.ts:815-816`)。7 つの mutation
フィールドは「存在するのに配列でない」を 400 で弾く(`add:'Hi'` が 'H','i' の 2 カードに
化ける事故の恒久対策 — `project.ts:818-839`)。

| verb | 入力検証 | 効果 | per-item 結果(`results.*`) |
|---|---|---|---|
| `add: string[]` | trim して空は skip | 新カード `{id: randomUUID(), done:false, boardColumn:'todo'}` (`project.ts:858-871`) | **なし** |
| `markDone: string[]` | — | `done:true, boardColumn:'done', reworkCount:undefined` (`project.ts:873-884`) | **なし — unknown id は今も黙殺**(§8) |
| `setPrUrl: [{id,url}]` | http(s) のみ・500 文字 cap・`''` はクリア (`project.ts:886-903`) | `prUrl` 記録/クリア | **なし**(§8) |
| `setBranch: [{id,branch}]` | `BRANCH_RE`(`project.ts:234`)・200 cap・`''` はクリア | `branch` 記録/クリア | あり (`project.ts:905-932`) |
| `setColumn: [{id,column}]` | column は 5 列 enum (`project.ts:236, :936`) | 列移動 + `done` 同期 + review 外で `integrationConflict` クリア + done/todo で `reworkCount` クリア (`project.ts:944-961`) | あり (`project.ts:934-962`) |
| `setIntegrationConflict: [{id,value}]` | boolean 必須 | フラグ設定(false は undefined 化) (`project.ts:964-978`) | あり |
| `rework: [{id,maxReworks?}]` | maxReworks は非負整数・既定 3 (`project.ts:990-993`) | counter+1 → `doing`、`count > max` なら `blocked`。`done:false`・conflict クリア (`project.ts:984-1014`) | あり — `{column:'doing'|'blocked', count}` 付き (`project.ts:250-259`) |

- `results` は**送った verb の分だけ**レスポンスに載る(送ってない verb のキーは無い —
  `project.ts:1016-1027`)。返り値本体は保存後の `ProjectData` そのもの
  (`{...saved, results}`)。
- **per-item 結果の読み方**: `{id, ok:true}` / `{id, ok:false, error:'unknown task id'|'invalid item'|…}`。
  これが 0707「短縮 id 黙殺 no-op」の恒久対策(`project.ts:238-248` に事故の経緯が明記)。
  **司令塔は書き込み後に必ず `results` を確認し、さらに GET で読み戻す**(§9)。

### 4.4 エンジン・swarm ルートからの書き込みも同じ土俵

- claim / release / recordCardBranch(手動 dispatch ルート内)は `mutateProjectData` 直呼び
  (`server/routes/swarm.ts:177, :199, :217`)。
- エンジンの列移動は loopback HTTP で §4.3 の verb を叩く(§1 表末尾)。
- つまり Board への**全書き込み**が同一ロック+CAS 機構を通る。「エンジンだけ裏口で書く」は無い。

## 5. 手動 dispatch の claim 先行 CAS とエンジンの両方向封鎖(cc7c60e)

### 5.1 なぜ: twin-dispatch の窓

worktree spawn は git fetch+checkout で数百 ms〜数秒かかる。**claim を spawn の後に置くと、
その間カードは todo のまま** → エンジンの次 pass が同じカードを拾って第 2 worker を spawn →
1 カードに `swarm/*` ブランチ 2 本、統合で確定 conflict(`server/routes/swarm.ts:147-161`,
`swarmOrchestrator.ts:1507-1517`)。

### 5.2 手動ルート側(`POST /api/swarm/worker`)の三段ガード

`server/routes/swarm.ts:301-345`:

1. **(a) pre-check**: `isCardDispatchInFlight(path, taskId)` — エンジンが mid-spawn
   (`pendingDispatch`)か live roster(`workers`)に居たら **409** (`swarm.ts:310-312`)。
   probe は pure read(エンジンを作らない — `swarmOrchestrator.ts:1622-1634`)。
2. **(b) claim CAS**: `claimCardForDispatch` — Board ロック内で todo→doing の
   compare-and-swap(`swarm.ts:162-190`)。todo でなければ:
   `doing`/`review` → busy(409)、`blocked`/`done` → 'free'(そのまま列は触らず先へ —
   これらは誰も取り合わない列 `swarm.ts:164-167`)、消えていたら 404。
3. **(c) claim 後の再チェック**: (a) は CAS **前**の読みなので、その間にエンジンが
   予約→spawn を始めた可能性がある。claim 成功後にもう一度 `isCardDispatchInFlight` を読み、
   真なら **claim を返して(releaseCardClaim)409** (`swarm.ts:330-345`)。
   revert が todo 方向なのは安全側(エンジンの todo→doing 移動 or reconcile が復元する)。

- **spawn 失敗時の revert**: claim 済みで `spawnSwarmWorker` が throw したら
  `releaseCardClaim` で todo へ戻す — worker 不在の doing で座礁させない
  (`swarm.ts:359-364`)。release は「まだ doing のときだけ」戻す(他者の列変更を上書きしない
  `swarm.ts:196-206`)。
- **成功後**: `recordCardBranch` で branch をカードに記録(claim できた場合のみ —
  `swarm.ts:365-368`)。
- **restart は免除**: body に `worktree` を渡す再起動は既存ブランチへの再入場なので
  claim/pre-check をスキップ(カードが doing なのは正当 — `swarm.ts:296-299, :326-328`)。

### 5.3 エンジン側(`runDispatchPass`)の対向ガード

`src/lib/server/swarmOrchestrator.ts:4510-4610`:

1. **予約 BEFORE first spawn**: この pass で spawn する **picks 全部**を先に
   `engine.pendingDispatch` に入れる(1 枚ずつだと picks[1..] が picks[0] の spawn 中
   無防備 — `:4512-4522`)。これが手動ルートの (a)/(c) が読む集合。
2. **spawn 直前の fresh re-read**: 手動ルートの claim が予約**前**に着地していた場合は
   board にしか見えないので、カードごとに読み直して todo でなければ skip
   (`:4537-4558`)。
3. **finally で全解放**: 正常終了/mid-pass stop/throw どの経路でも自分が予約した id だけ
   解放(`:4602-4610`)。
4. spawn 成功 → **roster 追加が先、列移動が後**(移動が拒否されても worker は counted、
   次 pass の reconcile が移動をリトライ — `:4569-4600`)。

### 5.4 司令塔の実務ルール

- カードから worker を立てるときは**必ず** `POST /api/swarm/worker {path, taskId}`。
  409 が返ったら**それは正常動作**(誰かが先に持っている)。二重起動を疑う前に
  `GET /api/swarm/workers` で現物を見る。
- `setColumn doing` を手で打ってから PTY を別途立てる、はこの封鎖の**外**。やらない。

## 6. API 一覧表

### 6.1 `/api/project*`(`server/routes/project.ts` — owner gate **なし**、path 検証のみ)

owner gate なし = 同一マシンから誰でも叩ける(local single-user tool の設計)。
`path` は登録済みプロジェクトの絶対パス(registry allowlist —
`src/lib/server/projectData.ts:362-374`)。

| Method Path | 主要入力 | 返り値 / 特記 | 行 |
|---|---|---|---|
| GET `/api/project` | `?path=` | `ProjectData`(tasks 含む全量) | `project.ts:270` |
| PUT `/api/project` | `?path=` body:`ProjectData` | 保存後 `ProjectData`。CAS: body.updatedAt。409 `{conflict:true}`。**司令塔は原則使わない(§4.2)** | `:275` |
| POST `/api/project/tasks` | `{path, add?, markDone?, setColumn?, setPrUrl?, setBranch?, setIntegrationConflict?, rework?}` | `{...ProjectData, results?}` — **Board 操作の正門**(§4.3) | `:813` |
| GET `/api/project/branches` | `?path=` | ローカル branch 一覧 | `:298` |
| GET `/api/project/active-branches` | `?path=` | branch+worktree 注釈 | `:307` |
| POST `/api/project/merged-branches` | `{path, branches(≤50), targetBranch?}` | 各 branch が trunk 入りか(純 git ancestry・500 にならず 'unknown') | `:318` |
| POST `/api/project/pr-info` | `{path, prUrl}` | PR 状態。失敗は常に `{available:false}` | `:343` |
| GET/POST/PUT `/api/project/open` | `{path, app}` 等 | フォルダを外部 app で開く/一覧/保存 | `:353,:357,:393` |
| POST `/api/project/review-worktree` | `{path, branch}` | 中央 worktree にレビュー checkout を用意し絶対パス返却 | `:419` |
| GET `/api/project/worktrees` | `?path=` | 中央 worktrees 一覧(main tree は載らない) | `:449` |
| POST `/api/project/worktrees/clean` | `{path}` | clean な中央 worktree を削除(`{removed, skippedDirty}` — dirty は常に skip) | `:458` |
| POST `/api/project/reveal` | `{path}` | OS ファイラで表示 | `:469` |
| POST `/api/project/open-editor` | `{path, editor?}` | エディタで開く | `:494` |
| GET `/api/project/editors` | — | 検出済みエディタ | `:520` |
| PUT `/api/project/default-editor` | `{editor\|null}` | 既定エディタ保存 | `:539` |
| GET `/api/project/branch-changes` | `?path=` | trunk 比の変更 | `:554` |
| GET `/api/project/file-diff` | `?path=&file=&scope=working\|branch` | 単ファイル diff(file は repo 相対のみ) | `:568` |
| GET `/api/project/skills` | `?path=` | プロジェクト内 skills | `:589` |
| GET `/api/skills/global` | — | ~/.claude/skills 一覧 | `:604` |
| POST `/api/skills/global/create` | `{request}` | 新規 global skill(one-off claude PTY・blocking) | `:618` |
| POST `/api/project/open/pick` | — | .app ピッカー(macOS) | `:643` |
| POST `/api/project/rename` | `{path, name}` | フォルダ rename + registry 追従 | `:666` |
| POST `/api/project/delete` | `{path}` | **登録済み root のみ** OS trash + 登録解除 + 中央データ `rm -rf`(不可逆) | `:712` |
| POST `/api/projects/relocate` | `{id, newPath}` | 消えた project の UUID を新フォルダへ再接続 | `:766` |
| POST `/api/projects/display-name` | `{path, displayName}` | 表示名(64 字・disk 非接触) | `:792` |
| POST/GET/DELETE `/api/project/task-asset` | base64 upload / `?path=&id=` | カード添付画像(content-hash id・5MB cap) | `:1045,:1086,:1101` |
| GET/POST `/api/project/canvases` | `?path[&id]` / `?action=` | Canvas CRUD(OCC、409 で現物返し) | `:1124,:1138` |
| POST `/api/project/describe` (+`/active`,`/job/:id`,`/job/:id/cancel`) | `?path=` | 説明文生成ジョブ | `:1209-1239` |
| POST `/api/project/task-title` | `{path, id, force?}` | カード title 自動生成(titleAuto のみ) | `:1246` |

関連(スコープ外・`server/routes/misc.ts`): GET `/api/projects`(一覧 `:146`)、
POST `/api/projects/new`(`:164`)/`import`(`:256`)/`remove`(`:302` — 登録解除のみ、
フォルダは触らない)。

### 6.2 `/api/swarm/*`(`server/routes/swarm.ts` — **全ルート owner gate**)

全ルートが最初に `getCustomTabRole() !== 'owner'` → 403(body parse より前 —
`swarm.ts:241-247` ほか各ルート先頭)。owner 判定はサーバ保存 session なので、
**owner がアプリにログイン済みのマシンなら curl でもそのまま通る**(§1 表)。

| Method Path | 主要入力 | 返り値 / 特記 | 行 |
|---|---|---|---|
| POST `/api/swarm/worker` | `{path, taskId?\|title?, notes?, hint?, worktree?, cols?, rows?}` | `SpawnSwarmWorkerResponse {terminalId, agentSessionId, worktree, branch, model?}`(`types.ts:939-950`)。taskId 有 = claim 先行 CAS(§5)。409=already dispatched、404=task not found、503=claude 未準備、400=goal 空/8KiB 超(`swarm.ts:113`) | `swarm.ts:241` |
| POST `/api/swarm/supply` | `{path, cols?, rows?, fresh?}` | 補給官 PTY(primary checkout・worktree なし)。`{terminalId, agentSessionId, resumed}` — **既定で前回の会話を resume**(§10)。`fresh:true` で新規会話 | `:381` |
| POST `/api/swarm/manager` | `{path, cols?, rows?, fresh?}` | 司令官 PTY(primary checkout・worktree なし)。同上 — **resume 時は Board を読み直してから喋る**(§10) | `:430` |
| POST `/api/swarm/worktree/remove` | `{path, worktree, force?}` | `{removed, reason?}` — dirty は force なしで拒否 | `:468` |
| GET `/api/swarm/orchestrator` | `?path=` | `SwarmOrchestratorState`(`types.ts:1280-1361`)。**pure read — spawn しない**(eadb25e6) | `:503` |
| GET `/api/swarm/workers` | `?path=` | **サーバ真実の worker 一覧**(PTY+roster+心拍の合成、`types.ts:1047-1092`) | `:518` |
| POST `/api/swarm/orchestrator/drain-tick` | `{path}` | state 返すだけ(auto-start は廃止済み) | `:533` |
| GET `/api/swarm/notifications` | — | FATAL 通知(マシン全体) | `:552` |
| POST `/api/swarm/orchestrator/start` | `{path}` | 自律 dispatch ON(冪等)。503=claude 未準備 | `:563` |
| POST `/api/swarm/orchestrator/stop` | `{path}` | OFF(冪等)。走行中 worker は放置 | `:587` |
| POST `/api/swarm/orchestrator/worker/stop` | `{path, terminalId}` | エンジン worker 1 体停止 + カード blocked 駐機。unknown id は no-op | `:608` |
| POST `/api/swarm/orchestrator/automerge` | `{path, enabled}` | Card③ 自動統合トグル(autonomy とは別スイッチ・既定 OFF) | `:631` |
| POST `/api/swarm/orchestrator/review/resolve` | `{path, taskId, target:'blocked'\|'todo'}` | スタック review カードの人間裁定 | `:653` |
| POST `/api/swarm/orchestrator/selfsupply` | `{path, enabled}` | 自己補給トグル | `:678` |
| POST `/api/swarm/orchestrator/overseer` | `{path, enabled}` | 監督ノードトグル(+`sandboxWarning`) | `:705` |
| POST `/api/swarm/orchestrator/selfsupply/approve` | `{path, cardId}` | 自己補給カードの承認(dispatch ゲート解除) | `:731` |
| GET `/api/swarm/escalations` | `?path=&status=` | 人間への質問 inbox | `:757` |
| POST `/api/swarm/escalations/open` | `{path, question, context, whyEscalated, …}` | 質問を上げる(receiptKey で冪等) | `:778` |
| POST `/api/swarm/escalations/answer` | `{id, answer}` | 回答 → live PTY 注入 or 次回 dispatch へ | `:850` |
| POST `/api/swarm/escalations/dismiss` | `{id}` | 未回答クローズ | `:875` |
| GET `/api/swarm/quota` | — | `SwarmQuotaResponse {now, tiers, launchTier, allCoolingUntil}`(`types.ts:2228-2244`)。path 不要(subscription 全体の話) | `:897` |
| POST `/api/swarm/quota/cool` | `{tier, untilMs\|minutes}` | tier を手動冷却(上限 `MAX_MANUAL_COOLING_MS`) | `:911` |
| POST `/api/swarm/quota/uncool` | `{tier}` | 冷却解除(冪等) | `:943` |

### 6.3 id の掟

- **カード id は `crypto.randomUUID()` のフル UUID**(`project.ts:862`)。全 verb・
  `taskId`・`cardId` は完全一致で照合(`project.ts:940` `data.tasks.some((t) => t.id === id)`)。
  **短縮 id(先頭 8 桁など)は絶対に通らない** — results ありの verb は
  `{ok:false, error:'unknown task id'}`、**results なしの verb(markDone/setPrUrl)は
  200 のまま黙って何も起きない**(§8-1)。
- `terminalId` も同様にフル id(terminal pool のキー)。

## 7. 落とし穴(司令塔が実際に踏んだ事象を含む)

1. **短縮 id 黙殺 no-op(incident 0707)** — 短縮/stale id の setColumn が 200 の中で
   silent no-op になり、worker の「自分で列を動かした」報告が虚偽化 → 誤診 2 連。
   恒久対策が per-item `results`(`project.ts:238-248`)。**ただし markDone / setPrUrl には
   results が無い**(§8-1) — 書き込んだら必ず読み戻す(§9-2)。
2. **twin-dispatch(0707)** — 根因は「エンジンの running/manualStop が外から不可視」+
   claim 後置。可視化が `manualStop`/`manualStopPersisted`(`types.ts:1285-1301`)、
   封鎖が cc7c60e の §5。**手動 dispatch 前に `GET /api/swarm/orchestrator` で
   running を確認**する掟は生きている(same-repo dispatcher は常に 1 つ)。
3. **stale 全量 PUT による board wipe(incident 2026-06-10)** — 共有直前の空 board を
   持った別窓が全量 PUT して共有済みカードを消した。CAS(`expectUpdatedAt`)の由来
   (`project.ts:280-286`, `projectData.ts:166-175`)。§4.2 の「updatedAt を落とすと素通り」
   と併せて、**全量 PUT を司令塔の道具にしない**。
4. **collab 共有中の巻き戻り(bug c2e4c57c)** — 共有中は Y.Doc が権威で、API 書き込みを
   doc に知らせないと次の (re)connect で巻き戻された。今は書き込み成功ごとに
   `queueBoardMirrorSafe` が doc へミラー(`projectData.ts:270-280, :305, :352`)。
   それでも「動かしたのに戻る」を見たら共有状態(collab)をまず疑う。
5. **reworkCount の消え方の非対称**(§3.3) — API setColumn done/todo はリセット、
   UI ドラッグは保持。「counter がおかしい」の前にどちらの経路で動いたか確認。
6. **blocked/done カードへの taskId 指定 dispatch は「free」扱い**(`swarm.ts:164-167`) —
   409 にならず spawn まで走るが、**claim していないので列は動かず branch も記録されない**
   (`swarm.ts:329, :367` — claimed のときだけ recordCardBranch)。保留レーン(blocked)の
   カードを起動したいならまず todo へ戻すのが正道。
7. **GET /api/swarm/orchestrator は絶対に spawn しない**(`swarm.ts:481-485` K8 契約、
   drain-tick の auto-start も eadb25e6 で廃止 `swarm.ts:508-515`)。「GET したら
   エンジンが動き出した」ようにみえたら別の原因を探す。
8. **エンジン状態は in-memory**(`swarmOrchestrator.ts:1529-1534`) — アプリ再起動で
   running/workers/pendingDispatch は消える(worker の PTY/worktree/branch は disk に残る)。
   永続なのは `manualStopPersisted`(Settings)だけ(`types.ts:1295-1301`)。
   再起動後の「エンジン居ない+worker 居る」は異常ではなく既定(自動再開しない —
   `types.ts:1343-1351`)。
9. **中身の無い goal は 400** — `POST /api/swarm/worker` は title+notes 合計 8KiB cap
   (`swarm.ts:110-113, :276-281`)。カードの notes に全文を積む運用ではここに当たり得る。

## 8. 既知の穴(観察のみ・修正しない — file:line 付き)

1. **markDone / setPrUrl / add に per-item 結果が無い**(`project.ts:873-903`) —
   0707 対策の `results` は setColumn/setBranch/setIntegrationConflict/rework の 4 verb のみ
   (`project.ts:1022-1026`)。markDone に unknown/短縮 id を渡すと**今も 200 で黙殺**される。
   回避: done 化は `setColumn:[{id,column:'done'}]` を使えば results が返る(効果も同等 —
   `project.ts:944-961` は done 同期+reworkCount リセットを含む)。
2. **PUT /api/project の trusting write**(`project.ts:284-286`) — body.updatedAt が
   無い/非 string だと CAS 不発で無条件上書き。設計上は「初回書き込み」semantics だが、
   外部 caller が事故で使うと 3 章の 2026-06-10 型の wipe を再演できる。
3. **rework の maxReworks に上限が無い**(`project.ts:990-993`) — 非負整数なら
   `maxReworks: 999999` も通り、blocked 退避(無限ループガード)を呼び出し側が事実上
   無効化できる。既定 3 を変えない運用が安全。
4. **TasksBody は unchecked cast**(`project.ts:814` `as TasksBody`) — トップレベルの
   配列検査(`:826-839`)はあるが、要素の形は各ループ内の ad-hoc 検査に依存
   (zod の API body schema 群 `schemas.ts:198-` に tasks POST は入っていない)。
   現状は各ループが型ガードしているので実害未確認、ただし verb 追加時の検査漏れが
   起きやすい構造。
5. **`POST /api/swarm/worker` の title-only 経路はカードと無関係に worker を作る**
   (`swarm.ts:270-274`) — Board にカードが無い worker は claim/twin ガードの対象外
   (taskId が無いので §5 全体をスキップ)。同じゴール文で 2 回叩けば 2 体立つ。
   カード運用(taskId)を正とする。

## 9. 検証コマンド集(司令塔がそのまま打つ)

前提: `P` に対象プロジェクトの登録済み絶対パス。ポートは 47776 固定。
`/api/swarm/*` は owner ログイン済みマシンであること(§6.2)。

```bash
P=/Users/kokinaniwa/projects/OPEN-GROUND   # 例
API=http://127.0.0.1:47776
```

### 9-1. 対象コミット・文書鮮度の確認

```bash
git -C "$P" fetch origin main && git -C "$P" log --oneline -1 origin/main
# → cc7c60e より進んでいたら、この文書の行番号は要再検証
```

### 9-2. Board を読む / 書いたら読み戻す(掟)

```bash
# カード一覧(id はフル UUID で扱う)
curl -s "$API/api/project?path=$P" | jq '.tasks[] | {id, title, boardColumn, done, reworkCount, branch, prUrl}'

# 列移動(per-item 結果を必ず見る)
ID=<フルUUID>
curl -s -X POST "$API/api/project/tasks" -H 'content-type: application/json' \
  -d "{\"path\":\"$P\",\"setColumn\":[{\"id\":\"$ID\",\"column\":\"review\"}]}" | jq '.results'
# → [{"id":"…","ok":true}] 以外は失敗。'unknown task id' = id 間違い(短縮 id を疑う)

# 読み戻し(results が ok でも最後はこれ)
curl -s "$API/api/project?path=$P" | jq --arg id "$ID" '.tasks[] | select(.id==$id) | {boardColumn, done, reworkCount}'
```

### 9-3. 差し戻し(rework)と blocked 退避

```bash
curl -s -X POST "$API/api/project/tasks" -H 'content-type: application/json' \
  -d "{\"path\":\"$P\",\"rework\":[{\"id\":\"$ID\"}]}" | jq '.results.rework'
# → [{"id":"…","ok":true,"column":"doing","count":1}] / count>3 なら column:"blocked"
```

### 9-4. エンジン・worker・二重 dispatch の事前確認

```bash
# 手動 dispatch 前の掟: エンジン稼働状況を見る(pure read・spawn しない)
curl -s "$API/api/swarm/orchestrator?path=$P" | jq '{running, manualStop, manualStopPersisted, autoMerge, parkUntil, workers: [.workers[] | {taskId, branch, stage, terminalId}]}'

# サーバ真実の worker 一覧(エンジン外の worker も出る)
curl -s "$API/api/swarm/workers?path=$P" | jq '.workers[] | {worktree, branch, terminalId, taskId, phase, ready, blocked}'

# カードから worker を立てる(409 は「先客あり」= 正常)
curl -s -X POST "$API/api/swarm/worker" -H 'content-type: application/json' \
  -d "{\"path\":\"$P\",\"taskId\":\"$ID\"}" | jq .
```

### 9-5. quota / tier(park の理由確認)

```bash
curl -s "$API/api/swarm/quota" | jq '{launchTier, allCoolingUntil, tiers}'
# launchTier=null = 全 tier 冷却 or 全 OFF → エンジンは dispatch を park する
```

### 9-6. 永続体を直接見る(HTTP と突き合わせ)

```bash
# プロジェクト UUID は registry から(path 完全一致で引く)
jq -r --arg p "$P" '.projects[] | select(.path==$p) | .id' ~/.openground/settings.json
UUID=<↑の出力>
jq '.updatedAt, (.tasks | length)' ~/.openground/projects/$UUID/tasks.json
ls ~/.openground/projects/$UUID/          # tasks.corrupt-*.json があれば過去に隔離退避が起きている
ls ~/.openground/projects/$UUID/worktrees # worker の中央 worktree
```

### 9-7. 統合前の branch 確認(review→done は main 入り確認後)

```bash
curl -s -X POST "$API/api/project/merged-branches" -H 'content-type: application/json' \
  -d "{\"path\":\"$P\",\"branches\":[\"swarm/<branch>\"]}" | jq .
# 'merged' になって初めて setColumn done(または markDone 相当)を打つ
```

---

## 10. 司令官・補給官の会話 resume(2026-07-12)

司令官と補給官は**日をまたいで育つ会話**であり、使い捨ての worker とは性質が逆
(worker は 1 ゴール 1 worktree 1 セッションで、忘れてよい)。にもかかわらず 2026-07-12 まで、
両者は起動のたびに `crypto.randomUUID()` を `--session-id` に渡していた。つまり
**OPEN GROUND を再起動するたび(= リリースのたび)に、司令官も補給官も記憶喪失で立ち上がっていた**。

現在は **(プロジェクト × 役割) ごとに session id を永続化し、次回は `claude --resume <id>` で
同じ会話を続ける**。seam は `src/lib/server/swarmSessions.ts`(`resolveSwarmSession` /
`recordSwarmSession`)。`--resume` / `--session-id` の分岐自体は元から
`claudeTerminal.ts:314-318`(`buildClaudeArgv`)に在り、呼ばれていなかっただけ。

### 10.1 どこに何が永続化されるか

| | |
|---|---|
| ファイル | `~/.openground/projects/<projectUUID>/swarm-sessions.json` |
| なぜ中央 dir か | CLAUDE.md の原則(per-project data はユーザーの repo に書かない)。**tasks.json とは別ファイル**なのも意図的 — git 共有モードでは tasks.json が repo に移動するが、session id は**このマシンの `~/.claude` を指す個人状態**で、共有しても相手は開けない |
| 形 | `{"manager":{"sessionId":"<uuid>","cwd":"<起動時の絶対パス>","updatedAt":"<ISO>"}, "supply":{…}}` |
| 対象ロール | `supply` / `manager` **のみ**(`SWARM_SESSION_ROLES`)。worker は意図的に対象外 |
| 書き込み | 毎起動(resume でも `updatedAt` を打ち直す)。supply と manager が 1 ファイルを共有するため read-modify-write は**パス単位で直列化**(同時起動でも片方のキーが消えない) |
| tier 全滅時 | `NoAllowedModelTierError` は **record より前**に throw(04 章 §2.6)。spawn を拒んだのに「存在しない会話の id」を書き残すことはない |

`cwd` を持つのは、claude が transcript を **cwd から導いたディレクトリ名**
(`~/.claude/projects/<cwd をハイフン化>/<sessionId>.jsonl` — `claudeProjectDir.ts`)に置くから。
プロジェクトを移動すると同じ id でも `--resume` が届かないので、その場合は新規に落とす(§10.3 `moved`)。

### 10.2 resume した司令官が最初にやること =「状況」(非対称性の罠)

**再起動で復元されるのは会話だけ**。これを取り違えると、司令官は**実在しない worker の話**を
続ける(00-INDEX §2.1 の表が正典):

- **会話履歴** → ✅ 生き残る(resume)
- **エンジンの in-memory 認知**(worker roster / reviews / quota 冷却 / 自動運転 ON) → ❌ **全消え**(01 章 §2)
- **Board / branch / 心拍 / escalations**(永続体) → ✅ ディスクに在る = **唯一の足場**
- **コード自体** → ⚠️ 変わっている可能性大(再起動はたいていリリース)。各章の file:line も疑う

だから resume 起動時は、`/og-manage` に**「まず『状況』を頭から実行し、Board 実体(todo/doing/review)・
worker 一覧・エンジン状態を API と git で読み直してから喋れ」**という命令が同梱される
(`swarmManager.ts` `MANAGER_RESUME_INJECTION` / 補給官は `swarmSupply.ts` `SUPPLY_RESUME_INJECTION`
= 「積む前に Board を読み直せ」)。**新しい読み込みロジックではなく、既存の「状況」を呼ぶだけ。**
「前回こう言っていた」は根拠にならない — 現物(API/git)が正。

### 10.3 fail-open — resume されない 5 つの理由(壊れても必ず起動する)

`claude --resume <id>` は claude が**読めない id**を渡すとエラー終了する。それは
「司令官を開いたのに死んだ PTY が出る」ということなので、**resume は「証明できたときだけ」**行う
(`isSessionResumable` が transcript の実在・非空・先頭 64KB に**パース可能な JSON 行が 1 本以上**を確認)。
証明できない場合は**必ず新規セッションに落として起動する** — 2026-07-12 以前と同じ挙動に戻るだけで、
**デスクは常に立ち上がる**。

| `reason` | 意味 | 典型 |
|---|---|---|
| `none` | 何も永続化されていない | そのプロジェクト×役割の**初回起動** |
| `moved` | 記録された `cwd` と今の cwd が違う | プロジェクトを移動/relocate した(transcript が旧ディレクトリ名の下に在る) |
| `live` | その id を**生きた PTY が既に掴んでいる** | 司令官を二重に開いた。2 プロセスが 1 transcript に追記すると壊れるので、2 枚目は別会話にする |
| `missing` | claude 側に読める transcript が無い | `~/.claude` を消した / 別マシン / 古い session が pruned / 空・破損 |
| `store` | 永続化層自体が失敗 | 未登録パス等の**バグ**。それでも起動は止めない |

**見分け方**: `POST /api/swarm/{supply,manager}` の応答 **`resumed`**(true=会話復元 / false=新規)と、
サーバログの `[swarmSessions]` 行。`fresh:true` を渡すと**記録を無視して新規会話**にし、記録も
上書きする(復元した文脈が壊れているときの脱出ハッチ — 上書きするからこそ「脱出」になる)。

### 10.4 検証(そのまま打つ)

```bash
UUID=$(jq -r --arg p "$P" '.projects[] | select(.path==$p) | .id' ~/.openground/settings.json)

# 永続化されている会話(無ければ初回 = 次回から resume される)
jq . ~/.openground/projects/$UUID/swarm-sessions.json

# その id を claude 側が読めるか = 次回 resume されるか(空/不在なら missing で新規に落ちる)
SID=$(jq -r '.manager.sessionId' ~/.openground/projects/$UUID/swarm-sessions.json)
DIR=$(printf '%s' "$(cd "$P" && pwd -P)" | sed 's/[/. ]/-/g')
wc -l ~/.claude/projects/$DIR/$SID.jsonl

# 起動が resume だったか(応答で判る)。fresh:true で新規会話に逃がす
curl -s -X POST "$API/api/swarm/manager" -H 'content-type: application/json' \
  -d "{\"path\":\"$P\"}" | jq '{terminalId, agentSessionId, resumed}'
```

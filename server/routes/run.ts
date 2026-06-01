// server/routes/run.ts — Hono sub-router for the C-run group.
// Declares FULL /api/... paths (mount prefix in app.ts is empty: app.route('/', runRoutes)).
// Handlers are THIN ADAPTERS over src/lib/server/* — no business logic is moved
// or rewritten here. The only changes vs the Next route handlers:
//   NextResponse.json(x[,status]) -> c.json(x[,status])
//   (await req.json())            -> (await c.req.json())
//   safeParseBody(req, schema)    -> zValidator('json', schema)
// Routes ported:
//   src/app/api/run/route.ts                 -> POST /api/run
//   src/app/api/run/cancel/route.ts          -> POST /api/run/cancel
//   src/app/api/run/dismiss/route.ts         -> POST /api/run/dismiss
//   src/app/api/run/dismiss-conflict/route.ts-> POST /api/run/dismiss-conflict
//   src/app/api/run/list/route.ts            -> GET  /api/run/list
//   src/app/api/run/resolve-conflict/route.ts-> POST /api/run/resolve-conflict

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { randomUUID } from 'crypto'
import {
  cancelSession,
  clearFinishedSessions,
  dismissConflict,
  ensureSessionResumable,
  listSessions,
  purgeArchivedRuns,
  removeSession,
  resolveConflict,
  startRun,
} from '@/lib/server/runner'
import { readProjectData, validateProjectPath } from '@/lib/server/projectData'
import { probeClaudeCli } from '@/lib/server/claudeCli'
import { getSettings } from '@/lib/server/store'
import { buildRepoDigest } from '@/lib/server/repoDigest'
import { readCanvasFile } from '@/lib/server/canvasData'
import { readTranscript, TranscriptNotFound } from '@/lib/server/observer'
import {
  RunCancelApiBodySchema,
  RunDismissApiBodySchema,
  RunPurgeApiBodySchema,
  RunTranscriptQuerySchema,
} from '@/lib/schemas'
import type { CanvasFile, PermissionMode, ProjectData } from '@/lib/types'

// ---- POST /api/run --------------------------------------------------------
// One request runs one task. A fresh run starts a new Claude session; a resume
// run (`resumeFrom` set) continues that session with its full context intact.
interface RunRequest {
  project: { id: string; name: string; path: string }
  task: { id: string; title: string }
  /** Extra instruction — a comment for a fresh run, the prompt for a resume. */
  instruction?: string
  /** A Claude session id to resume; absent means a fresh run. */
  resumeFrom?: string
  /** Auto-continue round (1-based) when this run is part of an auto-loop. */
  autoRound?: number
  /** Permission mode for the spawned Claude (default: 'bypass'). */
  permissionMode?: PermissionMode
  /** Canvas picker: a Claude Code skill name to apply this round. The runner
   *  prepends a one-line directive telling Claude to use it. Skipped silently
   *  if empty — OPEN GROUND never makes claims about a skill that isn't selected. */
  skill?: string | null
  /** When the user kicked this run off from a Canvas chat (vs the plain
   *  Chats tab), this carries the Canvas id. The runner builds an extra
   *  prompt section telling Claude where it is and how to add elements
   *  to the Canvas (CANVAS_ADD: marker). Absent → Chats-tab behaviour
   *  with no Canvas plumbing. */
  canvasContext?: { canvasId: string }
}

// Render the "use skill X" directive that gets prepended to the prompt.
// Resumes and fresh runs both go through this so a single picker selection
// applies consistently regardless of round.
const skillDirective = (skill: string): string =>
  `このターンでは Claude Code のスキル \`${skill}\` を必ず使ってください。スキルの内容（指針・トーン・実装パターン）に従って成果物を作ってください。\n\n---\n\n`

const RESULT_INSTRUCTION = `

---
作業が終わったら、最後に次の1行を「そのまま」出力してください（コードブロックで囲んだりせず、行頭から OPENGROUND_RESULT: を書く）：
OPENGROUND_RESULT: {"topic":"このターンの主題ラベル","completed":["完了したタスクのタイトル",...],"skipped":["手をつけなかったタスクのタイトル",...],"summary":"ユーザーへの返事として、何を理解し何をしたか／何が分かったかを自分の言葉で説明する短い段落","decisions":["下した重要な判断とその理由を1項目1文で",...],"blockers":"作業を妨げた問題があれば","taskComplete":true}

各フィールドの意味：
- topic=このターンの主題を表す名詞句。OPEN GROUND のチャットサイドバーの行見出しに加え、**Home のプロジェクトカード hero にも表示される** — OPEN GROUND は CONCEPT.md の通り「カードの状態表示が俯瞰のすべてを背負う」ツールなので、topic は単なる話題ラベルではなく **「このプロジェクトが今どこにいるか」を一句で語る役目**を負う。例：「タブ命名の方針確認」「auth ミドルウェアの再実装」「LP hero の bento 化完了」「ScreenView sandbox の設計」。日本語で 8〜16 文字を厳守（半角英数のみで書くなら 24 字以内）、体言止め、句点・絵文字・括弧禁止、敬語禁止。ユーザーが今送ってきた発言（feedback）をそのまま貼るのではなく、その発言から「結局何の話か／プロジェクトが今どの段階にいるか」を抜き出すこと。話題が前ラウンドから移っていれば最新の話題に合わせて更新する。前のラウンドの topic を惰性で使い回さない。
- completed=実際に完了させたタスク
- skipped=手をつけなかったタスク
- summary=ユーザーへの「直接の返事」。OPEN GROUND というツールではなく、君（Claude Code）自身がユーザーと会話している前提で書くこと。何を理解し、どう考え、何をして、何が分かったか・何が次の判断ポイントかを、自分の口で説明する。数文〜短い段落（3〜6文程度）の自然な日本語の文章で、敬体（です・ます）。箇条書きや関数名・ファイル名・行数などの技術的な詳細は書かない。結果と判断の理由を中心に、ユーザーが「じゃあ次はこうしよう」と会話を続けられる土台になるように書く。**段落分け必須**：話題が切り替わる場所で空行を必ず入れて 2〜3 段落に分ける（JSON 文字列の中では \\n\\n を 2 つ続ける）。1 段落 = 1〜2 文を目安に。1 つの長い塊にはしないこと — OPEN GROUND のチャット欄では空行がそのまま段落の切れ目として表示されるので、改行を入れないと壁のような読みにくいテキストになる。例：「まず ◯◯ を理解しました。\\n\\n次に ◯◯ を実行しました。\\n\\nその結果 ◯◯ が分かったので、次は ◯◯ を判断する段階です。」のように、理解→実行→次の判断、で段落を切る。
- decisions=このターンで下した重要な判断とその理由を、1項目1文で。**diff からは読み取れない「なぜそうしたか／何を避けたか／どのトレードオフを取ったか」**を中心に書く（ここが構造化サマリで一番価値のある欄）。例：「freeze は state でなく ref でやった（再レンダで競合するため）」「小手先の transform: scale を避け composition イベントで根本対処した」「破壊的変更を避け既存マーカー方式を踏襲した」。自明な作業・些細な実装選択（変数名等）は入れない。判断らしい判断が無いターンは空配列 [] でよい。
- blockers=作業を妨げた問題（無ければ空文字 ""）
- taskComplete=指示されたタスクが「文字どおり完全に」終わったかの真偽値

JSON の注意：summary などの文字列の中で半角ダブルクオートを使うときは必ずバックスラッシュでエスケープしてください（例：「5つの \\"デザイン専門スキル\\" が並ぶ」のように書く）。エスケープを忘れると JSON.parse が落ちて、OPEN GROUND のチャットに「結果の読み取りに失敗しました」と表示されてしまいます。引用したいだけなら「」やかぎ括弧で代用するのが安全です。

**ユーザーへの質問が必要なとき — 絶対に勝手に進めないこと**

最重要ルール：もし自分の考えや出力の中で「？」で終わる文を**ユーザーに向けて**書きそうになったら、それは止まる合図です。OPEN GROUND のチャットは print mode で動いているので、君が途中で「Aと B どちらにしますか？」と書いても、ユーザーはその場で答えられず、君が勝手に決めて続けてしまえばユーザーは介入する機会を失います。これが現状一番の不満点なので、必ず以下の通りに振る舞ってください。

何が「ユーザーに聞くべき質問」か：
- 方針の二択以上（「A と B どちらでいきますか？」「全部消してから作り直すか、修正だけでいくか？」）
- 仕様の曖昧さ（「○○の意味、こういう理解で合ってますか？」「対象は X だけ？それとも Y も含む？」）
- 副作用が大きい操作の確認（「○○を削除していいですか？」「main に直接 push していいですか？」）
- 自分の推測の妥当性確認（「これは仮置きにしますが、後で本物に差し替えますか？」）

「自分で決めて構わない」もの — 質問にしない：
- 細かい実装の選択肢（変数名、インデント、コードの整理方法）
- 既存コード／ドキュメントを読めば判断できること
- やり方が一意に決まる作業

聞くと決めたら、その時点で**作業をやめる**。OPENGROUND_RESULT を次のように出してターンを終わらせてください：
- "topic": 質問の論点を表す 8〜16 字の名詞句（例：「タブ命名の方針確認」）。質問ターンでも必ず入れる。
- "question": "ユーザーへの質問文（複数の選択肢があれば箇条書きで明示）。これが UI に「返事待ち」バッジとして大きく表示される本文"
- "taskComplete": false
- "completed": [これまでに「完了した」と言える分があれば書く。なければ []]
- "blockers": "" （質問は blocker ではない）
- summary には「ここまで何を理解／作業してきたか」と「なぜ今ユーザーの判断が必要か」を短くまとめる。

ダメな例：
- summary 内に「A にしようか B にしようか迷いましたが、A で進めました」と書く → ユーザーは介入できない。聞くべきだった。
- ログの途中で「○○でいいですか？はい、進めます」と自問自答する → 同上。
- question を空にしたまま、summary 末尾に「？」付きの文を置く → UI に拾われない。質問は必ず question フィールドに入れる。

なおプロジェクト内の .openground/ ディレクトリは OPEN GROUND が管理しています。中のファイルは編集しないでください。`

const RESUME_DEFAULT =
  '前回の続きを進めてください。残っている次ステップやブロッカーがあれば対応してください。'

// Render the Canvas-aware briefing that gets appended when the run was
// started from a Canvas chat. Tells Claude where it is (which Canvas tab,
// what elements live there), what the Canvas is FOR (a design surface,
// not a code workspace), and how to put new elements onto it without
// breaking the CLAUDE.md rule that forbids touching .openground/.
const renderCanvasContext = (canvas: CanvasFile): string => {
  const summary = canvas.elements
    .slice(0, 12)
    .map((el) => {
      const label = el.name || (el.text ? el.text.slice(0, 40).replace(/\n/g, ' ') : el.type)
      return `  - ${el.type}${el.framework ? `(${el.framework})` : ''} id=${el.id} @(${Math.round(el.x)},${Math.round(el.y)})${el.width ? ` ${Math.round(el.width)}×${Math.round(el.height ?? 0)}` : ''}  "${label}"`
    })
    .join('\n')
  const more = canvas.elements.length > 12 ? `\n  …他 ${canvas.elements.length - 12} 要素` : ''
  const viewport = canvas.viewport
  const cx = Math.round(viewport.x)
  const cy = Math.round(viewport.y)
  const zoom = viewport.zoom.toFixed(2)
  return `

---

## あなたは今、OPEN GROUND の "Canvas" の中にいます

OPEN GROUND は複数プロジェクトを 1 枚の canvas で俯瞰する macOS デスクトップツール。各プロジェクトの中に「Canvas」というデザイン・ブレスト用の無限キャンバスがあり、その Canvas に紐づくチャットからこの会話は始まりました。

**Canvas が何のための場所か:**
- UI / ビジュアルデザインを **絵として並べる**ボード（紙のホワイトボードに近い）
- React や HTML の UI モックを **iframe でライブレンダリング**できる ("mock" 要素)
- sticky / テキスト / フレーム / コメントピン を自由に配置
- フォルダにある「ファイルとして開く」ではなく、**画面に出して並べる/比較する**ための場所

**この Canvas の現在の状態:**
- Canvas 名: ${canvas.name || '(無題)'}
- viewport: zoom ${zoom}, 中心 (${cx}, ${cy})
- 既存要素 (${canvas.elements.length} 個):
${summary || '  (まだ何も置かれていない)'}${more}

**Canvas に要素を追加する方法 — 必ずこれを使ってください:**

OPEN GROUND の \`.openground/\` 配下にあるファイル（Canvas データ含む）は、CLAUDE.md でユーザーから「編集禁止」と明記されています。**直接書き込もうとしないでください。** 代わりに、応答の中に以下のマーカー行を 1 行ずつ入れると、OPEN GROUND が検出してあなたに代わって Canvas に追加します:

\`\`\`
CANVAS_ADD: {"type":"mock","framework":"html","name":"色見本","text":"<!doctype html>...","x":120,"y":120,"width":640,"height":480}
CANVAS_ADD: {"type":"sticky","text":"このボタンは目立ちすぎる","color":"#ffd560","x":80,"y":80,"width":200,"height":120}
CANVAS_ADD: {"type":"text","text":"ヘッダー案 A","x":300,"y":50}
CANVAS_ADD: {"type":"frame","text":"ログイン画面 候補","x":100,"y":600,"width":900,"height":540}
\`\`\`

ルール:
- **マーカーは必ずあなたの応答本文（assistant メッセージ）に書く**。Bash の
  \`cat\` / \`echo\` 等の **tool 出力経由では検出されません**（tool 出力は 120 字に
  切り詰められるため）。ファイルに書いてから出力する、ではなく、**メッセージに直接書く**
- **JSON は 1 行に収める**（改行は \\n でエスケープ）。OPENGROUND_RESULT と同じ要領
- **座標** (x, y) と **サイズ** (width, height) は既存要素を避けて、見える範囲に配置する。zoom と中心は上記参照
- **mock** は \`framework: "html"\` か \`"react"\`、\`text\` には完結した HTML / JSX を入れる（依存パッケージは window.React / unpkg からのみ）
- **sticky** は 1 つの note。デフォルトサイズ 200×120
- **frame** は他要素を囲うためのラベル付き枠
- **text** は小さい見出し用、装飾なし
- **comment** は既存要素にピンを刺すので \`anchorId\` 必須、普通使わない
- **image** は既にアップロード済みの \`assetId\` を参照するときだけ使う（あなたから新規画像は追加不可）
- マーカーを出した直後、要約 (summary) で「何を、なぜ、どの位置に置いたか」を 1〜2 文で説明する

## "screen" 要素 — フルページのデザインを Canvas に並べる

mock は素の軽量プレビュー（CDN React のみ、Tailwind 不可）。**screen** も同じ
サンドボックス iframe でライブレンダリングしますが、OPEN GROUND の
**デザインシステムが丸ごと注入された**リッチ版です（実ファイルは不要 —
\`src/designs/\` への Write は廃止されました）:

- **Tailwind** がそのまま効く（Play CDN）。\`bg-bg-card\` / \`text-ink\` /
  \`text-ink-muted\` / \`border-line\` / \`bg-accent\` / \`text-moss\` /
  \`text-azure\` などの **project token** も解決される（tailwind.config.ts と同一）
- プロジェクトのフォント（\`font-display\`=Fraunces / \`font-body\`=Instrument
  Sans / \`font-mono\`=JetBrains Mono）と \`.label-cap\` 等のユーティリティが効く
- **\`import { X } from 'lucide-react'\`** が使える（アイコン）
- **TypeScript / TSX** をそのまま書ける（型・interface・generics OK）

\`text\` に **単一ファイルの React コンポーネント**を入れて \`type:"screen"\` で出す:

\`\`\`
CANVAS_ADD: {"type":"screen","framework":"react","label":"Home","x":120,"y":120,"width":1280,"height":800,"chrome":"browser","scrollable":true,"text":"export default function Home(){ return <div className=\\"min-h-full bg-bg p-10 font-body text-ink\\">…</div> }"}
\`\`\`

- \`text\`: \`export default function Name(){…}\` か \`function App(){…}\` を 1 つ
  含める（それがマウントされる）。\`import\` は \`react\` / \`react-dom\` /
  \`lucide-react\` のみ解決、他の bare import は無視
- \`framework\`: \`"react"\`（TSX）か \`"html"\`
- \`chrome\`: \`"none"\` / \`"browser"\` / \`"phone"\`、\`scrollable: true\` で内部スクロール許可

## 既存要素を**更新**する — CANVAS_UPDATE

既にある要素（mock / screen のコードを直す、sticky の文言を変える等）は、
**新規追加せず** \`CANVAS_UPDATE\` で id 指定して部分更新します:

\`\`\`
CANVAS_UPDATE: {"id":"<既存要素の id>","text":"…新しいソース全文…"}
CANVAS_UPDATE: {"id":"<既存要素の id>","label":"Home v2","width":1440}
\`\`\`

- \`id\` 必須（上の既存要素リストの \`id=…\` を使う）。\`type\` は変更不可
- 指定したフィールドだけ差し替わる（部分更新）。コード修正は \`text\` を全文で送る
- 更新も run 中**即時**に Canvas に反映される

---

Canvas への反映はすべて CANVAS_ADD / CANVAS_UPDATE のマーカーで完結します。
ファイル（\`src/designs/\` や \`design-system/foo.html\`）を書き出す必要はありません。`
}

export const renderPrompt = (
  template: string,
  data: ProjectData,
  projectName: string,
  taskLine: string,
  repoDigest: string,
) => {
  // Pass replacement VALUES via a function replacer, never as the string arg:
  // String.prototype.replace interprets `$&`/`$1`/`$\`` etc. in a string
  // replacement, so user content (notes, task titles, a repo digest containing
  // `$1` or `${FOO}`) would be mangled. A `() => value` replacer is taken
  // verbatim. (See run-prompt review — Pass 8.)
  // If the template doesn't reference {{repoDigest}} at all, prepend the digest
  // so users on older templates still get the savings without editing settings.
  const withDigest = template.includes('{{repoDigest}}')
    ? template.replace(/\{\{repoDigest\}\}/g, () => repoDigest)
    : repoDigest
      ? `${repoDigest}\n\n---\n\n${template}`
      : template
  return withDigest
    .replace(/\{\{tasks\}\}/g, () => taskLine)
    .replace(/\{\{notes\}\}/g, () => data.notes || '')
    .replace(/\{\{description\}\}/g, () => data.description || '')
    .replace(/\{\{name\}\}/g, () => projectName)
}

// ---- The chain ------------------------------------------------------------
// All six routes are method-chained off the router instance so hc<AppType> on
// the client recovers this group's route tree. Behaviour is identical to the
// prior statement style (path/handler/validation/status all unchanged).
export const runRoutes = new Hono()
  .post('/api/run', async (c) => {
  const body = (await c.req.json()) as RunRequest
  if (!body.project?.path || !body.task?.id) {
    return c.json({ error: 'project and task required' }, 400)
  }
  if (!(await validateProjectPath(body.project.path))) {
    return c.json({ error: `path not allowed: ${body.project.path}` }, 403)
  }

  // Pre-flight: OPEN GROUND spawns the local `claude` CLI (subscription-only).
  // If it isn't installed the PTY would just print "command not found" deep in
  // the scrollback — reject with a clear message instead so the UI can show a
  // helpful toast. 503 = "service prerequisite missing", distinct from the
  // 400/403 validation errors above. (Presence-only; auth is interactive.)
  const claude = await probeClaudeCli()
  if (!claude.installed) {
    return c.json({ error: claude.message, claudeMissing: true }, 503)
  }

  const settings = await getSettings()
  const data = await readProjectData(body.project.path)
  // The task may not be on disk yet (panel saves are debounced) — trust the
  // request's title; the stored task only enriches it with its milestone.
  const stored = data.tasks.find(t => t.id === body.task.id)
  const title = stored?.title ?? body.task.title
  const milestoneName = stored?.milestoneId
    ? data.milestones.find(m => m.id === stored.milestoneId)?.name ?? null
    : null
  const instruction = body.instruction?.trim()

  let prompt: string
  let agentSessionId: string
  let resume: boolean

  const skill = typeof body.skill === 'string' && body.skill.trim() ? body.skill.trim() : null
  const directive = skill ? skillDirective(skill) : ''

  // If the caller wants to resume, make sure the Claude session file is
  // actually reachable from the main project's cwd. Sessions that ran in a
  // worktree end up under that worktree's hyphenated path, and a resume from
  // the main project fails with "No conversation found". Relocate the file
  // silently when possible; otherwise drop the resume hint and rebuild a
  // fresh-run prompt so the user never sees the "[再開できません]" stderr.
  const wantsResume =
    typeof body.resumeFrom === 'string' && body.resumeFrom.length > 0
  const canResume =
    wantsResume && (await ensureSessionResumable(body.project.path, body.resumeFrom!))

  // If the run was started from a Canvas chat, surface that fact to Claude.
  // The section explains what the Canvas is for, lists the current elements,
  // and documents the CANVAS_ADD: marker as the way to add new elements
  // (since Claude can't write into .openground/ directly).
  let canvasSection = ''
  if (body.canvasContext?.canvasId) {
    try {
      const canvas = await readCanvasFile(body.project.path, body.canvasContext.canvasId)
      if (canvas) canvasSection = renderCanvasContext(canvas)
    } catch {}
  }

  if (canResume) {
    // Continue the existing Claude session — it still holds the task context.
    resume = true
    agentSessionId = body.resumeFrom!
    prompt = `${directive}${instruction || RESUME_DEFAULT}${canvasSection}${RESULT_INSTRUCTION}`
  } else {
    // Fresh run — assign a new session id and send the full task brief.
    resume = false
    agentSessionId = randomUUID()
    const taskLine = `- ${title}${milestoneName ? ` [${milestoneName}]` : ''}`
    // The digest is the same across consecutive runs in the same project, so
    // putting it before any task-specific text keeps the prompt cache warm.
    const repoDigest = await buildRepoDigest(body.project.path)
    const base = renderPrompt(settings.runPromptTemplate, data, body.project.name, taskLine, repoDigest)
    const extra = instruction ? `\n\n## 追加の指示\n${instruction}\n` : ''
    prompt = `${directive}${base}${extra}${canvasSection}${RESULT_INSTRUCTION}`
  }

  // The "what the user just said" message shown in the chat cockpit:
  //  • resume → exactly what they typed (or the default resume nudge)
  //  • fresh  → their extra instruction if any, otherwise the task title
  //    (treat firing a fresh task as the user saying "do this task").
  const feedback = resume
    ? instruction || RESUME_DEFAULT
    : instruction || title

  const permissionMode: PermissionMode =
    body.permissionMode === 'plan' ? 'plan' : 'bypass'

  const session = startRun({
    items: [
      {
        projectId: body.project.id,
        projectName: body.project.name,
        projectPath: body.project.path,
        prompt,
        targetedTasks: [{ id: body.task.id, title, milestoneName }],
        agentSessionId,
        resume,
        autoRound: body.autoRound,
        feedback,
        permissionMode,
        canvasContext: body.canvasContext?.canvasId
          ? { canvasId: body.canvasContext.canvasId }
          : undefined,
        // Surface the silent fresh-fallback on the entry so the UI can tell
        // the user "the continue didn't actually continue" instead of
        // pretending nothing happened.
        resumeFallback: wantsResume && !canResume,
      },
    ],
    concurrency: 1,
  })
  return c.json(session)
})
  // ---- POST /api/run/cancel ------------------------------------------------
  // safeParseBody returned a NextResponse, which is foreign to Hono; swap it for
  // zValidator over the same RunCancelApiBodySchema. zValidator emits a 400 on
  // invalid input, matching the old safeParseBody behaviour.
  .post('/api/run/cancel', zValidator('json', RunCancelApiBodySchema), (c) => {
    const { id } = c.req.valid('json')
    cancelSession(id)
    return c.json({ ok: true })
  })

  // ---- POST /api/run/dismiss -----------------------------------------------
  // Drop a finished run from the runner's memory so it does not reappear on the
  // next page reload. `{ all: true }` clears every finished run.
  //
  // Dismiss is NON-destructive: the run's JSON is *moved* to runs-archive/,
  // not deleted (a misfired "dismiss all" once wiped a user's whole run
  // history). Irreversible deletion lives behind POST /api/run/purge.
  //
  // An empty body or `{ id: null, all: false }` used to fall through both
  // branches and silently return ok:true — a no-op that masks a malformed
  // client. Require that at least one of `id` / `all` is meaningful and 400
  // otherwise (RunDismissApiBodySchema documents the same contract).
  .post('/api/run/dismiss', async (c) => {
    const raw = await c.req.json().catch(() => null)
    const parsed = RunDismissApiBodySchema.safeParse(raw)
    if (!parsed.success) {
      return c.json({ error: 'id or all required' }, 400)
    }
    const { id, all } = parsed.data
    if (all) await clearFinishedSessions()
    else if (id) await removeSession(id)
    return c.json({ ok: true })
  })
  // ---- POST /api/run/purge -------------------------------------------------
  // Irreversibly delete archived run JSON. This is the ONLY route that unlinks
  // run files; dismiss merely archives. `{ ids: [...] }` purges those archive
  // entries; an empty/absent `ids` prunes archive entries past the 30-day
  // retention window. A confirmation modal in the UI gates this — provided in
  // a later PR — so the API stays deliberately explicit.
  .post('/api/run/purge', async (c) => {
    const raw = await c.req.json().catch(() => null)
    const parsed = RunPurgeApiBodySchema.safeParse(raw ?? {})
    if (!parsed.success) {
      return c.json({ error: 'invalid purge body' }, 400)
    }
    await purgeArchivedRuns(parsed.data.ids)
    return c.json({ ok: true })
  })
  // ---- POST /api/run/dismiss-conflict --------------------------------------
  .post('/api/run/dismiss-conflict', async (c) => {
    const { sessionId, projectId } = await c.req.json()
    if (!sessionId || !projectId) {
      return c.json({ error: 'sessionId and projectId required' }, 400)
    }
    const session = await dismissConflict(sessionId, projectId)
    if (!session) {
      return c.json({ error: 'Session not found' }, 404)
    }
    return c.json({ ok: true })
  })
  // ---- GET /api/run/list ---------------------------------------------------
  // Every run still held in memory — the client fetches this on load to
  // rehydrate the cockpit after a page reload.
  .get('/api/run/list', async (c) => {
    return c.json({ sessions: await listSessions() })
  })
  // ---- GET /api/run/transcript ---------------------------------------------
  // Read a FINISHED session's Claude JSONL back from disk, paged. This is the
  // "過去ログを見る" (re-open past log) path: runner sessions are flushed to
  // ~/.openground/runs/<id>.json with a SUMMARY, but the full turn-by-turn
  // transcript lives only in Claude's own ~/.claude/projects/<dir>/<sid>.jsonl.
  // This route slurps that file and renders each event through the same
  // `formatEvent` the live observer uses, so a re-opened transcript reads like
  // the chat did while it ran.
  //
  // Boundaries:
  //  - `path` is the project root, run through validateProjectPath (must sit
  //    under projectsRoot, the §3.3 security boundary).
  //  - `cwd` (optional, defaults to `path`) is where Claude was launched — for
  //    worktree runs this is the worktree path under <project>/.openground/.
  //    It must ALSO pass validateProjectPath (worktrees live under projectsRoot
  //    so they pass; an arbitrary cwd cannot escape the boundary).
  //  - `sessionId` is regex-constrained (UUID-ish) by the schema so it can't
  //    smuggle a "../" into sessionJsonlPath.
  //  - Missing JSONL (worktree pruned, never ran) → 404, not 500.
  .get('/api/run/transcript', zValidator('query', RunTranscriptQuerySchema), async (c) => {
    const { sessionId, path, cwd, offset, limit } = c.req.valid('query')
    if (!(await validateProjectPath(path))) {
      return c.json({ error: `path not allowed: ${path}` }, 403)
    }
    const effectiveCwd = cwd ?? path
    // A caller-supplied cwd is an independent path arg — guard it too. When it
    // defaults to `path` this is redundant but harmless.
    if (cwd && !(await validateProjectPath(cwd))) {
      return c.json({ error: `cwd not allowed: ${cwd}` }, 403)
    }
    try {
      const page = await readTranscript(effectiveCwd, sessionId, offset ?? 0, limit ?? 500)
      return c.json(page)
    } catch (e) {
      if (e instanceof TranscriptNotFound) {
        return c.json({ error: 'transcript not found' }, 404)
      }
      throw e
    }
  })
  // ---- POST /api/run/resolve-conflict --------------------------------------
  .post('/api/run/resolve-conflict', async (c) => {
    const { sessionId, projectId } = await c.req.json()
    if (!sessionId || !projectId) {
      return c.json({ error: 'sessionId and projectId required' }, 400)
    }
    const session = await resolveConflict(sessionId, projectId)
    if (!session) {
      return c.json(
        { error: 'Session not found or entry not in conflict state' },
        404,
      )
    }
    return c.json({ ok: true, sessionId: session.id })
  })

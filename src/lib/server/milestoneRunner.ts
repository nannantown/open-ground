import { randomUUID } from 'crypto'
import { basename } from 'path'
import { startRun } from './runner'
import type { Goal, ProjectMilestone, RunSession } from '@/lib/types'

// Shared helper used by both the single-milestone API
// (`/api/project/milestones/run`) and the server-side run queue
// (`/api/project/goals/run-queue` + the runner's auto-advance hook),
// so the prompt and the startRun shape stay in lockstep.

export const buildMilestonePrompt = (
  goal: Goal | null,
  milestone: ProjectMilestone,
): string => {
  const cmds = (milestone.verifyCommands ?? []).filter(
    c => typeof c === 'string' && c.trim(),
  )
  const verifyBlock =
    cmds.length > 0
      ? cmds.map(c => `  $ ${c}`).join('\n')
      : '  (verify commands が定義されていません。完了条件はあなたの自己判断のみです — 可能なら verify を増やしてください)'
  // NOTE: do NOT start the prompt with `---` (or any `-`-prefixed token).
  // claude's CLI argv parser treats a leading `-`-token as an option flag
  // even when it's the positional initialPrompt arg, so a `---` opener
  // exits the process with `unknown option '---...'` before the run can
  // start. Always lead with plain text.
  return `## このランの達成目標 (Milestone)

${goal ? `これは Goal「${goal.title}」の一部です。\nGoal の完了条件:\n${goal.completionCriteria || '(未設定)'}\n` : ''}
このランで完了させる Milestone:
- name: ${milestone.name}
- description: ${milestone.description || '(なし)'}

### 完了の客観的定義 — 厳格に守ること

このランの「タスク完了」は **次の shell command が全て exit 0 で終わる** ことです:
${verifyBlock}

- 作業の終わりに、必ず上のコマンドを **自分でも実行して確認**してください (Bash tool)。
- 全部 pass しなかった場合、OPENGROUND_RESULT.taskComplete は **必ず false** にして、blockers にエラー内容を書く。
- 全部 pass した場合のみ taskComplete=true。
- verifyCommands を勝手に削る／別のコマンドに置き換える行為は禁止 — commands は契約です。
- OPEN GROUND は run 完了後にあなたとは独立に上のコマンドを再実行して結果を検証します。

---

## 追加の作業ガイダンス

- 余計な範囲には手を出さず、verify commands を pass させるための最小変更に集中
- ファイル探索が必要なら Glob / Grep / Read を使う
- 既存のコード規約 / 命名に従う
- テストや lint の出力に "warning" がある程度残るのは OK、目標は exit 0

---

## ターン終了マーカー — 必ず最後に出すこと

作業が終わったら、**必ず**次の 1 行を assistant メッセージの末尾にそのまま出力してください
（コードブロックで囲まない、行頭から開始）。この行が出ないと OPEN GROUND 側が
セッション完了を検知できず、UI で「running…」のままハングします。

OPENGROUND_RESULT: {"topic":"このターンの主題","completed":["..."],"skipped":[],"summary":"何をしたか／verify は通ったかを 2〜3 文で。段落を切る場合は \\n\\n を使う。","blockers":"","taskComplete":true}

- taskComplete は verify が **全部 exit 0 だった場合のみ** true。1 つでも fail なら false。
- summary はユーザーへの直接の返事として、敬体（です・ます）で 2〜3 文。
- JSON 内のダブルクオートは \\" でエスケープ。
- topic は 8〜16 文字の名詞句（例：「タスク UX 監査メモ作成」）。
`
}

export interface KickMilestoneOpts {
  projectPath: string
  milestone: ProjectMilestone
  goal: Goal | null
  projectName?: string
  projectId?: string
}

/** Spawn a single milestone-bound Claude run. Returns the RunSession
 *  immediately; the runner's auto-verify + run-queue advance happens
 *  asynchronously after the PTY exits. Pure helper — no API parsing,
 *  no validation; callers (route handler, run-queue advancer) should
 *  have already resolved the milestone + goal from disk. */
export const kickMilestoneRun = (opts: KickMilestoneOpts): RunSession => {
  const { projectPath, milestone, goal } = opts
  const prompt = buildMilestonePrompt(goal, milestone)
  return startRun({
    items: [
      {
        projectId: opts.projectId ?? projectPath,
        projectName: opts.projectName ?? (basename(projectPath) || projectPath),
        projectPath,
        prompt,
        targetedTasks: [
          {
            id: `milestone-${milestone.id}`,
            title: milestone.name,
            milestoneName: goal?.title ?? null,
          },
        ],
        agentSessionId: randomUUID(),
        resume: false,
        feedback: `Milestone「${milestone.name}」を進める`,
        permissionMode: 'bypass',
        milestoneId: milestone.id,
      },
    ],
    concurrency: 1,
  })
}

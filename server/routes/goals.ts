// server/routes/goals.ts — Hono sub-router for the B-goals group (Goals +
// Milestones REST endpoints behind the Tasks tab). Mounted by the Integration
// phase via `app.route('/', goalRoutes)`; this router declares FULL /api/...
// paths because the mount prefix is empty.
//
// These are THIN ADAPTERS over the existing Next.js route handlers
// (src/app/api/project/{goals,milestones}/**). Every line of business logic is
// copied verbatim — the ONLY transformations are:
//   NextResponse.json(x[,{status}])  ->  c.json(x[,status])
//   req: NextRequest                 ->  c (Hono Context)
//   safeParseBody(req, schema)       ->  safeParseBody(c.req.raw, schema)
//        (safeParseBody reads a plain Request and returns a NextResponse, which
//         extends the WHATWG Response — so on the !ok branch we can return
//         `parsed.res` directly; Hono accepts any Response. This preserves the
//         exact 400 "invalid body: <field> — <why>" shape, no zValidator needed.)
// All src/lib/server/* calls are identical to the originals, so the
// CONTRACT §3.8 "src/lib/server is the source of truth" rule holds.
//
// CONTRACT §3.3 (validateProjectPath security boundary) is preserved per route,
// exactly where the Next handlers placed it — after body parse, before any
// filesystem read/write.

import { Hono } from 'hono'
import { randomUUID } from 'crypto'
import {
  readProjectData,
  writeProjectData,
  validateProjectPath,
} from '@/lib/server/projectData'
import { startRun, cancelSession } from '@/lib/server/runner'
import { kickMilestoneRun } from '@/lib/server/milestoneRunner'
import { runVerifyCommands } from '@/lib/server/verifier'
import { safeParseBody } from '@/lib/server/apiBody'
import {
  GoalsApiBodySchema,
  GoalsPlanApiBodySchema,
  RunQueueApiBodySchema,
  MilestonesApiBodySchema,
  MilestoneRunApiBodySchema,
  MilestoneVerifyApiBodySchema,
} from '@/lib/schemas'
import type { Goal, ProjectMilestone, GoalRunQueue } from '@/lib/types'

// ── Module-level helpers (hoisted above the chain) ───────────────────────────
// In the prior statement style these constants sat interleaved between route
// registrations. Method-chaining needs one uninterrupted expression, so every
// handler-dependency is declared up front here.

const PROMPT_INSTRUCTION = `
あなたは OPEN GROUND の Tasks タブで指定された Goal を、達成可能な小さな
Milestone に分解する役割を負っています。各 Milestone には「完了したことを
shell の exit code で観測できる」verify command を 1〜3 個ずつ提案してください。

## Goal
{{GOAL}}

## あなたの仕事

1. Goal を **3〜8 個の Milestone** に分解する。
   - 各 Milestone は 1 つの観測可能な成果を表す
   - 順序立てて積み上げ可能であること（途中まで進めて止められる）
   - 「実装する」「書く」など曖昧な動詞ではなく、何が観測できれば終わりかを書く
   - **acceptance criteria の各項目は 1 つ以上の Milestone でカバーされること**
   - **out of scope のものは含めない** — 範囲外には手を出さない

2. 各 Milestone に **verify command を 1〜3 個**提案する。
   - shell command が **exit 0 で終わる** ことで「完了」と言える形に
   - **既存の package.json scripts を最優先**で使う:
     - \`npm run build\` (Next.js production build)
     - \`npm run lint\` (next lint)
     - \`npm run check:screens\` (screen module の 'use client' lint)
   - Goal 固有の検証が必要なら以下も使う:
     - \`test -f path/to/file\` でファイル存在
     - \`grep -q "pattern" path/to/file\` で内容確認
     - \`node -e "..."\` で軽い JS スクリプト
     - \`curl -fsS http://localhost:3000/...\` でローカル URL チェック (dev server 前提)

3. \`order\` を 0 から振る（先に進めるべき順）。

## 出力フォーマット — 厳格に守ること

応答は 2 つのマーカー行で締めくくります。**両方とも必須**、両方とも**行頭から**書く（コードブロックで囲まない）:

**1 行目 (マイルストーン本体):**

OPENGROUND_MILESTONES_PLAN: {"milestones":[{"name":"...","description":"...","verifyCommands":["npm run lint","npm run build"],"order":0}, ...]}

ルール:
- JSON は **1 行に収める**（改行は \\n でエスケープ）
- name は短い名詞句（例: "tasks.json に goals 配列を追加"）
- description は 1〜2 文の補足（なければ省略可）
- verifyCommands は string[]、各文字列がそのまま \`/bin/sh -c\` に渡される
- 「マイルストーンが浮かばない」場合でも 3 個以上は出す（やや細かく刻む）

**2 行目 (ターン終了マーカー):**

続けて次の行を出して、このターンを終了してください:

OPENGROUND_RESULT: {"topic":"マイルストーン提案","completed":["Goal を Milestone に分解"],"skipped":[],"summary":"マイルストーン提案を OPENGROUND_MILESTONES_PLAN として返しました。","blockers":"","taskComplete":true}

これがないと OPEN GROUND 側のセッション完了検知が動かず、ユーザー画面で「生成中…」が止まりません。**必ず出してください。**

それ以外のコマンドは実行しないでください。これは plan モード（読み取り＆思考のみ）です。
`

const nowIso = () => new Date().toISOString()

const findActiveSessionId = (
  queue: GoalRunQueue | undefined,
): string | null => {
  if (!queue || !queue.sessions || queue.sessions.length === 0) return null
  // sessions[] is append-only and the last one belongs to the milestone at
  // currentIndex (until that milestone settles). When the queue is
  // running, the last session is the one we'd cancel on a pause/cancel.
  return queue.sessions[queue.sessions.length - 1].sessionId
}

const STATUS_OK = new Set<NonNullable<ProjectMilestone['status']>>([
  'pending',
  'in_progress',
  'verifying',
  'verified',
  'failed',
  'blocked',
])

// ── The chain ────────────────────────────────────────────────────────────────
// All six routes are method-chained off the router instance so hc<AppType> on
// the client recovers this group's route tree. Behaviour is identical to the
// prior statement style.

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/project/goals — Goal CRUD (add / update / delete / reorder).
// Port of src/app/api/project/goals/route.ts.
// ─────────────────────────────────────────────────────────────────────────────
export const goalRoutes = new Hono()
  .post('/api/project/goals', async (c) => {
  const parsed = await safeParseBody(c.req.raw, GoalsApiBodySchema)
  if (!parsed.ok) return parsed.res
  const body = parsed.data
  if (!(await validateProjectPath(body.path))) {
    return c.json({ error: 'path not allowed' }, 403)
  }

  const data = await readProjectData(body.path)
  // `goals` is optional in the type — initialise lazily so older saved
  // tasks.json files don't need a migration step.
  if (!data.goals) data.goals = []
  const now = new Date().toISOString()

  if (body.op === 'add') {
    // Empty title is intentional for new Goals — the user types a one-liner
    // ("やりたいことを一言で") into the focused title input. List / hero
    // fall back to "(無題)" so a blank title never breaks rendering.
    const goal: Goal = {
      id: randomUUID(),
      title: body.title.trim(),
      description: body.description ?? '',
      completionCriteria: body.completionCriteria ?? '',
      // New SMART/OKR-style fields are intentionally added to the type
      // but the initial Goal is left blank — the UI's placeholders guide
      // the user.
      outcome: '',
      acceptanceCriteria: [],
      outOfScope: [],
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    }
    // Newest first: a freshly-created Goal lands at the top of the rail so
    // the user sees it immediately (matches Linear / Notion "new at top").
    data.goals.unshift(goal)
  } else if (body.op === 'update') {
    const id = body.goalId
    if (!id) {
      return c.json({ error: 'goalId required' }, 400)
    }
    const idx = data.goals.findIndex(g => g.id === id)
    if (idx < 0) {
      return c.json({ error: 'goal not found' }, 404)
    }
    // Only allow the editable subset through — explicit allowlist so the
    // client can't poison `createdAt` or rewrite `id`.
    const p = body.patch ?? {}
    const next: Goal = {
      ...data.goals[idx],
      ...(typeof p.title === 'string' ? { title: p.title } : {}),
      ...(typeof p.description === 'string' ? { description: p.description } : {}),
      ...(typeof p.completionCriteria === 'string'
        ? { completionCriteria: p.completionCriteria }
        : {}),
      ...(typeof p.outcome === 'string' ? { outcome: p.outcome } : {}),
      ...(Array.isArray(p.acceptanceCriteria)
        ? {
            acceptanceCriteria: p.acceptanceCriteria.filter(
              (s): s is string => typeof s === 'string',
            ),
          }
        : {}),
      ...(Array.isArray(p.outOfScope)
        ? {
            outOfScope: p.outOfScope.filter(
              (s): s is string => typeof s === 'string',
            ),
          }
        : {}),
      ...(typeof p.status === 'string' &&
      ['draft', 'planning', 'running', 'blocked', 'done'].includes(p.status)
        ? { status: p.status as Goal['status'] }
        : {}),
      updatedAt: now,
    }
    data.goals[idx] = next
  } else if (body.op === 'delete') {
    const id = body.goalId
    if (!id) {
      return c.json({ error: 'goalId required' }, 400)
    }
    data.goals = data.goals.filter(g => g.id !== id)
    // Unlink milestones owned by the deleted goal — leave them in the list
    // (legacy free-floating mode) rather than cascading the delete. Less
    // surprising for users who built up verify work on those milestones.
    data.milestones = data.milestones.map(m =>
      m.goalId === id ? { ...m, goalId: null } : m,
    )
  } else if (body.op === 'reorder') {
    const order = body.order ?? []
    const byId = new Map(data.goals.map(g => [g.id, g]))
    const reordered: Goal[] = []
    for (const id of order) {
      const g = byId.get(id)
      if (g) {
        reordered.push(g)
        byId.delete(id)
      }
    }
    // Append anything the client didn't mention (defensive: never drop).
    for (const g of Array.from(byId.values())) reordered.push(g)
    data.goals = reordered
  }
  // No `else` branch — body.op is exhaustively covered by the
  // GoalsApiBodySchema discriminated union, so zod has already rejected
  // anything else at the parse step with a 400.

  const saved = await writeProjectData(body.path, data)
  return c.json(saved)
})
  // ───────────────────────────────────────────────────────────────────────────
  // POST /api/project/goals/plan — kick Claude (plan-mode) to break a Goal into
  // Milestones. Port of src/app/api/project/goals/plan/route.ts.
  // ───────────────────────────────────────────────────────────────────────────
  .post('/api/project/goals/plan', async (c) => {
  const parsed = await safeParseBody(c.req.raw, GoalsPlanApiBodySchema)
  if (!parsed.ok) return parsed.res
  const body = parsed.data
  if (!(await validateProjectPath(body.path))) {
    return c.json({ error: 'path not allowed' }, 403)
  }
  const data = await readProjectData(body.path)
  const goals = data.goals ?? []
  const goal = goals.find(g => g.id === body.goalId)
  if (!goal) {
    return c.json({ error: 'goal not found' }, 404)
  }

  // Structured Goal fields → prompt body. Falls back to the legacy
  // `completionCriteria` text when the new sections are empty (preserves
  // behaviour for Goals authored before the SMART/OKR restructure).
  const ac = (goal.acceptanceCriteria ?? []).filter(s => s && s.trim())
  const oos = (goal.outOfScope ?? []).filter(s => s && s.trim())
  const goalText = [
    `- title: ${goal.title}`,
    `- why (背景): ${goal.description || '(なし)'}`,
    `- outcome (達成された世界): ${goal.outcome || '(なし)'}`,
    ac.length > 0
      ? `- acceptance criteria (観測可能な受入基準):\n${ac.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`
      : goal.completionCriteria
        ? `- completion criteria (旧フォーマット): ${goal.completionCriteria}`
        : `- acceptance criteria: (未定義)`,
    oos.length > 0
      ? `- out of scope (やらないこと):\n${oos.map(s => `  - ${s}`).join('\n')}`
      : `- out of scope: (未定義)`,
  ].join('\n')

  const prompt = PROMPT_INSTRUCTION.replace('{{GOAL}}', goalText)

  // Reuse the existing runner. A virtual task wraps the goal so the chat
  // cockpit pipeline (TaskThread / overview / status badge) renders this
  // plan-mode run alongside normal runs.
  const session = startRun({
    items: [
      {
        projectId: body.projectId ?? body.path,
        projectName: body.projectName ?? body.path.split('/').pop() ?? body.path,
        projectPath: body.path,
        prompt,
        targetedTasks: [
          {
            id: `goal-plan-${goal.id}`,
            title: `Plan: ${goal.title}`,
            milestoneName: null,
          },
        ],
        agentSessionId: randomUUID(),
        resume: false,
        feedback: `Goal「${goal.title}」のマイルストーン提案を依頼`,
        permissionMode: 'plan',
      },
    ],
    concurrency: 1,
  })
  return c.json({ session })
})
  // ───────────────────────────────────────────────────────────────────────────
  // POST /api/project/goals/run-queue — server-side sequential run queue for a
  // Goal. Port of src/app/api/project/goals/run-queue/route.ts.
  // ───────────────────────────────────────────────────────────────────────────
  .post('/api/project/goals/run-queue', async (c) => {
  const parsed = await safeParseBody(c.req.raw, RunQueueApiBodySchema)
  if (!parsed.ok) return parsed.res
  const body = parsed.data
  if (!(await validateProjectPath(body.path))) {
    return c.json({ error: 'path not allowed' }, 403)
  }

  const data = await readProjectData(body.path)
  const goals = data.goals ?? []
  const goal = goals.find(g => g.id === body.goalId)
  if (!goal) {
    return c.json({ error: 'goal not found' }, 404)
  }
  const goalMilestones = data.milestones
    .filter(m => m.goalId === goal.id)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))

  if (body.op === 'start') {
    // Build queue from the milestones that still need work — verified ones
    // are skipped, blocked/pending/failed all get queued in order so the
    // user can recover from a previously-stopped Goal too.
    const pendingIds = goalMilestones
      .filter(m => (m.status ?? 'pending') !== 'verified')
      .map(m => m.id)
    if (pendingIds.length === 0) {
      return c.json({ error: 'no milestones to run — all verified' }, 400)
    }
    const firstMilestone = data.milestones.find(m => m.id === pendingIds[0])!
    const session = kickMilestoneRun({
      projectPath: body.path,
      milestone: firstMilestone,
      goal,
      projectName: body.projectName,
      projectId: body.projectId,
    })
    goal.runQueue = {
      milestoneIds: pendingIds,
      currentIndex: 0,
      status: 'running',
      startedAt: nowIso(),
      lastActivityAt: nowIso(),
      sessions: [
        { milestoneId: firstMilestone.id, sessionId: session.id, result: 'cancelled', finishedAt: '' },
      ],
    }
    // result:'cancelled' is a placeholder for the in-flight slot — the
    // runner overwrites it when the run actually settles. We can't omit it
    // because the TS type makes result required; finishedAt:'' marks "still
    // running" so the startup sweep / UI can distinguish.
    goal.updatedAt = nowIso()
    await writeProjectData(body.path, data)
    return c.json({ ok: true, runQueue: goal.runQueue, session })
  }

  const queue = goal.runQueue
  if (!queue) {
    return c.json(
      { error: 'no run queue on this goal yet — start one first' },
      400,
    )
  }

  if (body.op === 'pause') {
    // Soft pause: don't interrupt the current run, just stop the runner
    // from auto-advancing when it settles. UI shows "Pausing — finishes
    // current milestone" until the in-flight session resolves.
    if (queue.status === 'running') {
      queue.status = 'paused'
      queue.lastActivityAt = nowIso()
      goal.updatedAt = nowIso()
      await writeProjectData(body.path, data)
    }
    return c.json({ ok: true, runQueue: queue })
  }

  if (body.op === 'resume') {
    if (queue.status !== 'paused' && queue.status !== 'failed') {
      return c.json({ error: `cannot resume from status=${queue.status}` }, 400)
    }
    if (queue.currentIndex >= queue.milestoneIds.length) {
      queue.status = 'completed'
      goal.updatedAt = nowIso()
      await writeProjectData(body.path, data)
      return c.json({ ok: true, runQueue: queue })
    }
    const nextMid = queue.milestoneIds[queue.currentIndex]
    const nextMilestone = data.milestones.find(m => m.id === nextMid)
    if (!nextMilestone) {
      return c.json(
        { error: 'queued milestone no longer exists; cancel and re-start' },
        409,
      )
    }
    const session = kickMilestoneRun({
      projectPath: body.path,
      milestone: nextMilestone,
      goal,
      projectName: body.projectName,
      projectId: body.projectId,
    })
    queue.status = 'running'
    queue.lastActivityAt = nowIso()
    queue.sessions = queue.sessions ?? []
    queue.sessions.push({
      milestoneId: nextMilestone.id,
      sessionId: session.id,
      result: 'cancelled',
      finishedAt: '',
    })
    goal.updatedAt = nowIso()
    await writeProjectData(body.path, data)
    return c.json({ ok: true, runQueue: queue, session })
  }

  if (body.op === 'cancel') {
    // Hard cancel: kill the in-flight session (if any) AND mark queue idle.
    const liveSid = queue.status === 'running' ? findActiveSessionId(queue) : null
    if (liveSid) {
      try { cancelSession(liveSid) } catch {}
    }
    queue.status = 'idle'
    queue.lastActivityAt = nowIso()
    goal.updatedAt = nowIso()
    await writeProjectData(body.path, data)
    return c.json({ ok: true, runQueue: queue })
  }

  return c.json({ error: `unknown op: ${body.op}` }, 400)
})
  // ───────────────────────────────────────────────────────────────────────────
  // POST /api/project/milestones — Milestone CRUD (add / update / delete /
  // reorder). Port of src/app/api/project/milestones/route.ts.
  // ───────────────────────────────────────────────────────────────────────────
  .post('/api/project/milestones', async (c) => {
  const parsed = await safeParseBody(c.req.raw, MilestonesApiBodySchema)
  if (!parsed.ok) return parsed.res
  const body = parsed.data
  if (!(await validateProjectPath(body.path))) {
    return c.json({ error: 'path not allowed' }, 403)
  }

  const data = await readProjectData(body.path)
  const now = new Date().toISOString()

  if (body.op === 'add') {
    const inputs = body.milestones.filter(m => m.name.trim())
    if (inputs.length === 0) {
      return c.json({ error: 'no milestones to add' }, 400)
    }
    for (const m of inputs) {
      const milestone: ProjectMilestone = {
        id: randomUUID(),
        name: m.name.trim(),
        dueDate: m.dueDate ?? null,
        createdAt: now,
        goalId: m.goalId ?? null,
        description: m.description ?? '',
        order: typeof m.order === 'number' ? m.order : data.milestones.length,
        verifyCommands: Array.isArray(m.verifyCommands)
          ? m.verifyCommands.filter(cmd => typeof cmd === 'string' && cmd.trim())
          : [],
        status: 'pending',
      }
      data.milestones.push(milestone)
    }
  } else if (body.op === 'update') {
    const id = body.milestoneId
    const idx = data.milestones.findIndex(m => m.id === id)
    if (idx < 0) {
      return c.json({ error: 'milestone not found' }, 404)
    }
    // patch is z.record(string, unknown) — narrow to a structural type for
    // the per-field allowlisting below. This is the same pattern the goals
    // route uses; we keep the manual checks here because some fields are
    // server-managed (lastVerify, verifiedAt) and the allowlist is the
    // authoritative spec of what the client may overwrite.
    const p = body.patch as Partial<Omit<ProjectMilestone, 'id' | 'createdAt'>>
    const cur = data.milestones[idx]
    const next: ProjectMilestone = {
      ...cur,
      ...(typeof p.name === 'string' ? { name: p.name } : {}),
      ...(typeof p.description === 'string' ? { description: p.description } : {}),
      ...('goalId' in p ? { goalId: p.goalId ?? null } : {}),
      ...(typeof p.order === 'number' ? { order: p.order } : {}),
      ...(Array.isArray(p.verifyCommands)
        ? { verifyCommands: p.verifyCommands.filter(cmd => typeof cmd === 'string') }
        : {}),
      ...('dueDate' in p ? { dueDate: p.dueDate ?? null } : {}),
      ...(typeof p.status === 'string' && STATUS_OK.has(p.status as NonNullable<ProjectMilestone['status']>)
        ? { status: p.status as ProjectMilestone['status'] }
        : {}),
      // lastVerify / verifiedAt / lastRunSessionId are written by the server
      // (verifier + runner) and not normally touched here. Allow through if
      // the client explicitly sends them — useful for "reset" / "retry" ops.
      ...(p.lastVerify ? { lastVerify: p.lastVerify } : {}),
      ...('verifiedAt' in p ? { verifiedAt: p.verifiedAt } : {}),
      ...('lastRunSessionId' in p ? { lastRunSessionId: p.lastRunSessionId } : {}),
    }
    data.milestones[idx] = next
  } else if (body.op === 'delete') {
    const id = body.milestoneId
    data.milestones = data.milestones.filter(m => m.id !== id)
    // Unlink any task that pointed at this milestone (legacy tasks.json
    // tasks can carry a milestoneId — Phase 6 keeps that contract alive).
    data.tasks = data.tasks.map(t =>
      t.milestoneId === id ? { ...t, milestoneId: null } : t,
    )
  } else if (body.op === 'reorder') {
    const order = body.order
    const byId = new Map(data.milestones.map(m => [m.id, m]))
    const reordered: ProjectMilestone[] = []
    order.forEach((id, i) => {
      const m = byId.get(id)
      if (m) {
        reordered.push({ ...m, order: i })
        byId.delete(id)
      }
    })
    // Anything not in the order list is appended in original sequence,
    // their `order` field bumped past the explicit set so reorders are
    // additive (the Tasks tab only sends a partial list when reordering
    // a single goal's milestones).
    const base = reordered.length
    for (const m of Array.from(byId.values())) {
      reordered.push({ ...m, order: m.order ?? base })
    }
    data.milestones = reordered
  }
  // No `else` — zod's discriminatedUnion exhausts the op list.

  const saved = await writeProjectData(body.path, data)
  return c.json(saved)
})
  // ───────────────────────────────────────────────────────────────────────────
  // POST /api/project/milestones/run — kick a Claude run targeting a Milestone.
  // Port of src/app/api/project/milestones/run/route.ts.
  // ───────────────────────────────────────────────────────────────────────────
  .post('/api/project/milestones/run', async (c) => {
  const parsed = await safeParseBody(c.req.raw, MilestoneRunApiBodySchema)
  if (!parsed.ok) return parsed.res
  const body = parsed.data
  if (!(await validateProjectPath(body.path))) {
    return c.json({ error: 'path not allowed' }, 403)
  }
  const data = await readProjectData(body.path)
  const milestone = data.milestones.find(m => m.id === body.milestoneId)
  if (!milestone) {
    return c.json({ error: 'milestone not found' }, 404)
  }
  const goal = milestone.goalId
    ? (data.goals ?? []).find(g => g.id === milestone.goalId) ?? null
    : null

  const session = kickMilestoneRun({
    projectPath: body.path,
    milestone,
    goal,
    projectName: body.projectName,
    projectId: body.projectId,
  })
  return c.json({ session })
})
  // ───────────────────────────────────────────────────────────────────────────
  // POST /api/project/milestones/verify — run a Milestone's verifyCommands and
  // persist the outcome. Port of src/app/api/project/milestones/verify/route.ts.
  // ───────────────────────────────────────────────────────────────────────────
  .post('/api/project/milestones/verify', async (c) => {
  const parsed = await safeParseBody(c.req.raw, MilestoneVerifyApiBodySchema)
  if (!parsed.ok) return parsed.res
  const body = parsed.data
  if (!(await validateProjectPath(body.path))) {
    return c.json({ error: 'path not allowed' }, 403)
  }

  const data = await readProjectData(body.path)
  const idx = data.milestones.findIndex(m => m.id === body.milestoneId)
  if (idx < 0) {
    return c.json({ error: 'milestone not found' }, 404)
  }
  const milestone = data.milestones[idx]
  const commands = (milestone.verifyCommands ?? []).filter(
    cmd => typeof cmd === 'string' && cmd.trim(),
  )
  if (commands.length === 0) {
    return c.json({ error: 'milestone has no verify commands to run' }, 422)
  }

  const result = await runVerifyCommands(body.path, milestone.id, commands)

  // Re-read so a parallel goal/milestone update doesn't get clobbered by
  // our older `data` snapshot. `idx` may shift if another mutation
  // happened mid-verify, so look the milestone up by id again.
  const fresh = await readProjectData(body.path)
  const freshIdx = fresh.milestones.findIndex(m => m.id === body.milestoneId)
  if (freshIdx < 0) {
    return c.json({ error: 'milestone disappeared during verify' }, 404)
  }
  const cur = fresh.milestones[freshIdx]
  const next: ProjectMilestone = {
    ...cur,
    status: result.passed ? 'verified' : 'failed',
    ...(result.passed ? { verifiedAt: result.finishedAt } : {}),
    lastVerify: {
      passed: result.passed,
      commands: result.commands,
      outputs: result.outputs,
      finishedAt: result.finishedAt,
      // retryCount is 0 for a manual one-shot verify; the auto-loop
      // bumps this in Phase 6.D when it re-fires after a fail.
      retryCount: 0,
    },
  }
  fresh.milestones[freshIdx] = next

  const saved = await writeProjectData(body.path, fresh)
  return c.json({ data: saved, result })
})

// swarmWorker — the in-app, tmux-free replacement for the shell swarm's
// `swarm-new.sh` (worktree) + `swarm-dispatch.sh` (/order injection). It is the
// "worker spawn" primitive of the OPEN GROUND swarm port (docs / auto-memory
// project_inapp_swarm_port): given a registered project and a Board goal it
//   1. creates an ISOLATED git worktree under the project's CENTRAL worktrees
//      dir (~/.openground/projects/<uuid>/worktrees/ — already inside
//      validateProjectPath's boundary, NEVER a repo sibling), on a fresh
//      `swarm/*` branch off origin/main, with node_modules symlinked;
//   2. launches ONE Agent SDK `claude` session in that worktree (SDK-ONLY since
//      2026-08-13 — the PTY worker and its fallback were deleted by owner
//      decision; subscription-only still holds: the SDK drives the USER'S
//      installed CLI via pathToClaudeCodeExecutable, never a bundled binary);
//   3. hands it the `/order ゴール: …` goal as the session's first turn.
//
// Worktree REMOVAL (kill / completion) reuses the same central-only safety the
// worktree cleaner enforces — this module never removes anything outside the
// central worktrees dir, even with `force`. It is a CAPABILITY: callers invoke
// removeSwarmWorktree on kill/completion; nothing auto-sweeps on PTY exit yet
// (that belongs to the future in-app orchestrator, P2).
//
// All git calls are execFile with argv arrays (never a shell string).

import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { lstat, mkdir, stat, symlink, unlink } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { centralWorktreesDir } from './paths'
import { isGitRepoRoot } from './gitRepoGuard'
import { projectUUIDFromPath } from './projectDataPath'
import { canonicalize } from './canonicalize'
import { isUnderCentralDir } from './worktreeCleanup'
import { stopAllDesksInDirAndWait, liveDeskOccupies } from './liveDesks'
import { removeClaudeFolderTrust } from './claudeTrust'
import { isExperimentEnabled } from './experiments'
import { resolveSwarmModelEffortProbed } from './swarmLaunch'
import { NoAllowedModelTierError } from './swarmAllowedModels'
import { ensureGuardWiring } from './hooksInstall'
import { createSwarmFatalNotification } from './swarmNotifications'
import { snapshotWorktreeBranch, fireSelfUpdateIfIntegrated } from './selfUpdateOnIntegrate'
import { getExecutionMode, getAllowedModelTiers } from './store'
import { sdkWorkerLaunchPlan, sdkWorkerPreflight, SdkWorkerUnavailableError } from './swarmWorkerSdk'
import { spawnSdkSession, preloadSdk } from './sdkSession'
import { DECISION_ROUTING_RULES } from './swarmDecisionRouting'
import { SPECIALIST_REVIEW_RULES } from './swarmSpecialistReview'
import { getPromptLang, languageDirective, type PromptLang } from './promptLang'
import { researchWorkerEnv } from './researchAuth'
import type { RemoveSwarmWorktreeResponse, SpawnSwarmWorkerResponse } from '../types'

const execFile = promisify(execFileCb)

// House convention (mergedBranches / reviewWorktree): network git must never
// hang on a credential prompt, and gets a hard timeout.
const GIT_OPTS = {
  timeout: 30_000,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
}

/** Run git in `cwd`; null on any failure (no git, not a repo, …). */
const git = async (cwd: string, args: string[]): Promise<string | null> => {
  if (!isGitRepoRoot(cwd)) return null // gitRepoGuard: never spawn git in a non-repo/vanishing cwd
  try {
    const { stdout } = await execFile('git', args, { cwd, ...GIT_OPTS })
    return stdout
  } catch {
    return null
  }
}

// ── Branch + base-ref naming (pure, unit-tested) ────────────────────────────

/** Candidate base refs for a new worker worktree, most- to least-preferred.
 *  origin/main is the swarm convention (a clean trunk the manager merges back
 *  into); local `main` covers an offline repo; HEAD is the last-ditch fallback
 *  so a repo with neither still yields a worktree. */
export const SWARM_BASE_REF_PREFERENCE = ['origin/main', 'main', 'HEAD'] as const

/** Pick the most-preferred base ref that actually exists. Pure + exported so
 *  the precedence is unit-tested without a repo. */
export const pickBaseRef = (existing: ReadonlySet<string>): string =>
  SWARM_BASE_REF_PREFERENCE.find((r) => existing.has(r)) ?? 'HEAD'

/** Deterministic, argv-safe `swarm/*` branch name. `stamp` carries the
 *  uniqueness (caller passes a timestamp+random token); `hint` only decorates.
 *  Pure + exported so the charset/shape is unit-tested. Mirrors swarm-new.sh:
 *  identity is the `swarm/` prefix, never the dir name. */
export const swarmBranchName = (stamp: string, hint?: string): string => {
  const slug = (hint ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  const safeStamp = stamp.replace(/[^A-Za-z0-9-]+/g, '') || 'x'
  return slug ? `swarm/${slug}-${safeStamp}` : `swarm/${safeStamp}`
}

/** The worktree dir name for a branch — the segment after `swarm/`. Pure. */
export const swarmWorktreeDirName = (branch: string): string =>
  branch.replace(/^swarm\//, '').replace(/\//g, '-')

// ── /order injection text (pure, unit-tested) ───────────────────────────────

const ORDER_PREFIX = '/order ゴール: '

/** Flatten + sanitize a string for safe single-line use in the /order command:
 *  drop ESC / C0 control bytes (a title or note could otherwise smuggle a
 *  terminal control sequence — the same injection vector pastePrompt guards),
 *  collapse all whitespace (incl. newlines) to single spaces, trim. */
const flattenOneLine = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim()

/** Build the `/order ゴール: …` text handed to the worker as claude's positional
 *  prompt (see the delivery note below). Kept to ONE line on purpose: the whole
 *  goal must be a single slash-command argument, and a multi-line value risks
 *  being split or (if ever pasted instead) collapsed into a `[Pasted text]`
 *  chip, where `/order` is not parsed as a command. title + notes are joined
 *  (notes optional). Pure + exported for unit tests.
 *
 *  LEARNING LOOP (card fdf714ef): when this SAME card was previously sent back
 *  — a 差し戻し / rollback: a RED verify (which tsc/test failed) or an
 *  adversarial-review must-fix — and is being RE-DISPATCHED to a FRESH worker,
 *  `priorFailure` carries WHY it failed last time. It is appended as a clearly
 *  LABELLED clause so the new worker doesn't repeat the same mistake. Still ONE
 *  line (flattenOneLine strips control bytes + collapses newlines, so even a
 *  multi-line tsc tail stays a single slash-command argument); omitted entirely
 *  when there is no prior failure (a first dispatch is byte-for-byte unchanged). */
/** Worker discipline, burned into EVERY spawn prompt — defense-in-depth over
 *  the guard's exit-2 veto (which now blanket-denies `git push` for policed
 *  sessions). 2e7beb2 was a worker following the /order skill's §4 integration
 *  steps ("FF 可 → git push origin <branch>:main" — written for the COMMANDER)
 *  instead of §6's worker rules, with zero heartbeats — so the order itself
 *  now states the worker contract explicitly: no push of any shape, commit +
 *  beat ready + STOP, integration belongs to the commander, and heartbeats are
 *  mandatory (30 min of none is flagged as an anomaly). Single line, same
 *  slash-command-argument constraint as the goal text. Exported so tests pin
 *  the exact contract.
 *
 *  COMMIT EARLY (2026-07-12 全損): the rule used to read "実装→検証→git commit"
 *  — commit AFTER the completion gate. A worker followed it exactly: it finished
 *  the implementation, entered the gate, and was force-reclaimed at the execution
 *  ceiling with 15 files (47KB) never committed — the worktree was removed and the
 *  work ceased to exist. The order is now inverted: COMMIT AT EVERY PHASE
 *  BOUNDARY, and ALWAYS before the gate. The engine also salvages a dirty worktree
 *  on reclaim now (commitWipBeforeTeardown), but that is the NET — this is the
 *  discipline, and a worker whose own commits exist needs no net.
 *
 *  PLAIN-LANGUAGE QUESTIONS (2026-07-17 owner feedback「escalation の質問の意味が
 *  毎回わからない」): a worker's question travels VERBATIM into the owner's
 *  escalations inbox — via the heartbeat blockers field (S4) or the on-screen
 *  free-text question the engine scrapes — and the owner is a NON-PROGRAMMER.
 *  The overseer's own templates carry a plainQuestion rendering, but a
 *  worker-authored question has no template to render from: the worker itself
 *  is the only one who can say it plainly. Hence the 3-element rule burned in
 *  here (①何を決めてほしいか ②選択肢 ③各選択の影響), tech detail demoted to a
 *  trailing parenthesis.
 *
 *  WHO DECIDES (2026-07-18 owner instruction): asking PLAINLY is only half of it —
 *  the question must also be ADDRESSED right. The plain-language rule above made
 *  a technical trade-off readable to the owner; it did not stop it from being
 *  sent to them at all. {@link DECISION_ROUTING_RULES} (swarmDecisionRouting.ts)
 *  is appended for that: route by the owner's 「関与の観測地図」 before escalating,
 *  decide the delegated areas yourself, and ask ONE plain routing question when
 *  the area is not on the map. It is a DIGEST of the corpus map — a worker cannot
 *  read you-corpus itself (personal data + a worker is an egress path); see that
 *  module's header for the sync obligation.
 *
 *  HOW IT IS DECIDED (2026-07-18 owner instruction, same conversation): routing a
 *  technical call AWAY from the owner makes the worker its receiver — and the
 *  worker's knowledge has a training cutoff. {@link SPECIALIST_REVIEW_RULES}
 *  (swarmSpecialistReview.ts) is appended so the receiver reads the CURRENT
 *  primary source before deciding, and stamps 【資料取得できず】 rather than
 *  bluffing when it cannot reach one. The two rule-sets are halves of one
 *  instruction: routing without sourcing just relocates a stale answer.
 *
 *  WHY (a) WAS REWRITTEN (2026-07-22, daily fuel report): 束ね率 stalled at 1.12
 *  against the 1.3 floor even though the clause had shipped on 2026-07-18. The
 *  metric is `tool_use blocks ÷ responses containing ≥1 tool_use`, so the ONLY
 *  way to raise it is more tools per response — and the old wording ("独立した…は
 *  束ねて並列実行する") is a CONDITIONAL that fires only once the worker has already
 *  noticed the calls are independent. A worker reasoning step by step never
 *  reaches that noticing: it decides one call, sends it, then decides the next.
 *  So the clause now flips the DEFAULT (batch unless the next call depends on
 *  this result) and adds a pre-send self-check, which is what actually converts
 *  the same work into fewer round-trips. Nothing about the completion gate moves.
 *
 *  WHY (g) WAS ADDED (2026-07-28, from the daily fuel report's proposal card): a
 *  re-measure over the NEXT report's own window (same formula, read-only) showed
 *  BOTH flagged metrics still out of bounds after the (a) rewrite — 束ね率 1.185
 *  (floor 1.3) and 文脈max 39.2万 (ceiling 30万) — while 手数 median 87.5 was
 *  healthy. The decisive reading: all 8 cards in that window had
 *  `sidechainOutputTokens === 0`, i.e. not one worker had offloaded a single
 *  lookup. The meter SKIPS sidechain responses outright (swarmTokenAudit.ts —
 *  a sidechain response `continue`s before turns/toolTurns/toolUses/maxContext are
 *  touched). ⚠ WHAT THAT DOES TO EACH METRIC IS NOT ONE-DIRECTIONAL, and an earlier
 *  draft of this comment claimed the ratio "can only rise" — it does not:
 *    文脈max — falls under EVERY trigger (what the subagent read never lands in the
 *      parent's context). This is (g)'s unconditional win and the fuel card's
 *      「文脈」 item is answered here.
 *    束ね率 — MIXED. Trigger ② (an unfocused grep = genuinely sequential probing) is
 *      the UP direction: folding k single-tool research turns into ONE Task leaves
 *      the bundle SURPLUS (toolUses − toolTurns) unchanged while shrinking the
 *      denominator by k−1, so 1 + surplus/denominator rises — on the window's worst
 *      card that is 239/210 = 1.14 → 190/161 = 1.18 (⚠ ARITHMETIC ILLUSTRATION, not
 *      a measurement: it assumes 49 of that card's 210 turns were foldable singles).
 *      Trigger ① (3+ files crossed) is the DOWN direction. Its counterfactual is NOT
 *      b single turns — under (a) it is ONE response carrying b Reads (toolTurns +1,
 *      toolUses +b); routing that to a Task makes the same one response carry ONE
 *      tool (toolTurns +1, toolUses +1). The denominator does not move and the
 *      numerator loses b−1, so the ratio FALLS by n(b−1)/T — from 1.185, b=3 firing
 *      on 3% of tool turns lands at 1.125 (b=4 → 1.095). Worse than "mixed": ① is
 *      mandatory and more specific than (a), so at b≥3 it WINS — it caps exactly the
 *      high-bundle responses (a) exists to produce. The (a)-wiring sentence does not
 *      rescue it: that one covers SEVERAL independent lookups at once, while ① fires
 *      when ONE lookup spans 3+ files, so only a single Task goes out.
 *  That is why the clause now carries a PRECEDENCE sentence: when the worker can
 *  already name the lines (file:line known), (a)'s batched read wins and ① does NOT
 *  fire; ① is for "I must read because I do not know where to look". That narrows
 *  the DOWN path to genuinely exploratory reads — where the parent would have burned
 *  many single-tool turns anyway, i.e. the UP case — but does NOT delete it: a worker
 *  who would have batched b≥3 exploratory reads still loses b−1. THE NET SIGN IS NOT
 *  DERIVABLE from the definition; only the daily fuel report settles it, and until it
 *  does, (g) STAYS ON THE SUSPECT LIST for any 束ね率 drop.
 *  It is phrased as an EXPLICIT ORDER, not a permission, because the harness
 *  default is to hold subagents back unless the user asked for one — and the
 *  worker's "user" is this very order, so a soft 「使ってよい」 would keep firing at
 *  zero (it already did: the sourcing block's existing 「重い調査は sub-agent へ」
 *  produced 0 sidechain turns in 8 cards, because it is scoped to primary-source
 *  reading and leaves 「重い」 to the worker's judgment). Its triggers are therefore
 *  OBSERVABLE (3+ files / unfocused grep / reading logs) for exactly the reason (a)
 *  had to be rewritten: a rule that first asks the worker to judge a lookup "heavy"
 *  fires only once it has already noticed — the step that never happens. Nothing
 *  about the completion gate moves: offload the LOOKUP, never the judgment. */
export const WORKER_ORDER_RULES =
  ' 【worker規律・厳守】あなたは in-app swarm の worker。git push は全形態禁止(guard が exit 2 で機械 block する)— /order スキル §4 の統合手順(push/merge)は司令塔用なので実行しない。【コミットは早く・こまめに】フェーズの境目ごとに必ず git commit を打て。特に完了ゲート(npm test / tsc / lint)に入る前は必ず WIP コミットを打ってから回すこと — 実行時間上限を超えた worker は worktree ごと強制回収されるので、未コミットのまま長い検証に入ると作業が消える(2026-07-12 に実際に 47KB 全損した)。実装→WIPコミット→検証→git commit まで済ませたら §6 どおり心拍 done true で「停止」し、統合は司令塔に委ねる。心拍 bash ~/.claude/swarm-beat.sh はフェーズ境目ごとに必ず打つ(spawn 後 30 分無心拍は anomaly として司令塔に通報される)。【トークン規律・厳守】少ない手数・小さい文脈で進めろ(完了ゲートは緩めない): (a) 調べものはできるだけまとめて一度に — 独立したツール呼び出し(複数ファイルの読み・独立コマンド)は1応答に束ねて並列実行する。既定は「まとめて出す」側だと考えろ: 道具を1つだけ載せた応答が許されるのは、その結果を見ないと次に何をするか決まらない時だけ。1つだけ送りそうになったら、送信する前に「この後どうせ要る調べものは?」を先に洗い出して同じ応答に足せ(複数ファイルの Read・複数パターンの grep・互いに依存しない確認コマンドは、まとめて1応答で出す) (b) ファイルは範囲指定 Read か grep で当たりを付けてから読む — 大きいファイルの全文読みはしない (c) 同じファイルを読み直さない(必要な行は最初に控える) (d) 長い出力のコマンドは tail/要約で受ける(テストは失敗時のみ詳細) (e) テストは触った範囲を先に回し、フルスイート(npm test)は完了ゲートとして最後に1回 (f) カードに「当たり」(対象ファイル)があれば探索せず直行する。 (g) 長い調べものは自分で読まず subagent に投げる — これは「使ってもよい」ではなく明示指示だ(エージェント起動を控える既定より、このカードの指示が優先する)。次のどれかに当てはまったら、自分で読み始める前に Task ツールで subagent を1手起こせ: ①3ファイル以上を横断して読む必要がある ②grep の当たりが絞れず探索になる ③ログ・テスト出力・大きな生成物を読み解く。ただし①が (a) とぶつかったら (a) が勝つ — 読む場所が既に file:line で特定できているなら subagent に投げず (a) どおり1応答にまとめて読め。①が発火するのは「どこを読めばいいか分からないから読む」= 探索になる時だけだ。受け取るのは要点だけにしろ(file:line と結論 — 全文を戻させるな)。独立した調べものが複数あるなら Task も同じ応答にまとめて出す。投げるのは調査だけで、判断・実装・完了ゲートは自分でやる。完了ゲート(npx tsc --noEmit / npm test / lint の3点)と ready 前セルフコミットの規約は一切緩めない。【質問は平易文で・厳守】オーナーに判断を仰ぐ質問(心拍 blocker の文面・画面上での質問)は、そのまま質問インボックスに届く。読むのはプログラムを書いたことがない人 — 必ず次の3要素で書く: ①何を決めてほしいのか1〜2文 ②選択肢(A/B など) ③それぞれを選ぶと何がどうなるか(暮らしの言葉で)。file:line・branch名・エラーログなどの技術詳細は質問文の末尾に括弧で添える(先頭に置かない)。' +
  DECISION_ROUTING_RULES +
  SPECIALIST_REVIEW_RULES

/** `lang` is REQUIRED, deliberately — not defaulted, not optional. A caller
 *  that forgets to thread the resolved Settings.language through fails
 *  `tsc --noEmit`, not silently ships a worker whose replies ignore the
 *  setting (2026-08-13 rework: an adversarial mutation pass found that with
 *  `lang` merely optional, 3 of 5 spawn paths could have their `lang` wiring
 *  deleted and every test stayed green — the parameter's mere existence let
 *  the omission compile). `notes`/`priorFailure` stay positionally required
 *  too (pass `undefined` explicitly) so `lang` can occupy the 4th slot
 *  without TS's "required parameter after optional" rule forcing a reorder
 *  that would break every existing call site's argument order. */
export const buildOrderInjection = (
  title: string,
  notes: string | undefined,
  priorFailure: string | undefined,
  lang: PromptLang,
): string => {
  const t = flattenOneLine(title || '')
  const n = flattenOneLine(notes || '')
  const goal = t && n ? `${t} — ${n}` : t || n
  const pf = flattenOneLine(priorFailure || '')
  const learn = pf
    ? ` 【前回の差し戻し理由・同じ失敗を繰り返さないこと】${pf}`
    : ''
  return ORDER_PREFIX + goal + learn + WORKER_ORDER_RULES + languageDirective(lang)
}

// NOTE on delivery: the /order goal is handed to claude as its POSITIONAL
// argument (launchClaude's initialPrompt), NOT typed into the live TUI. That is
// deliberate — and it is the key correctness fix here:
//   - A slash command injected into the running TUI does NOT submit: typing
//     `/order …` opens claude's command-autocomplete, which swallows the Enter
//     (even repeated Enters), so the command lands in the input box unsent
//     (observed directly against claude 2.1.185).
//   - Passing it positionally (`claude "/order …"`) makes claude run the command
//     on startup — no Enter to send, so the tmux `send-keys … Enter` lag the
//     spec warns about simply does not exist in this path. This mirrors how the
//     Board "実行" launch hands a task prompt to claude.
// The goal text is still built single-line by buildOrderInjection (above) so the
// whole goal is one slash-command argument.

/** The positional prompt handed to a worker that is RESUMED across an app restart
 *  (card 4 — ENGINE_PERSISTENCE_PLAN §5). The sister of MANAGER_RESUME_INJECTION /
 *  SUPPLY_RESUME_INJECTION: same `/<skill> セッション再開: …` shape, ONE line (the
 *  buildOrderInjection delivery contract), and re-invokes `/order` so the worker
 *  re-orients on its own discipline.
 *
 *  The crucial difference from a fresh dispatch: a resumed worker's REAL goal is
 *  already in its restored conversation history (the original `/order ゴール: …`),
 *  so this text must NOT read as a new goal — it explicitly tells the worker to
 *  re-read its ORIGINAL goal + the (unchanged) completion conditions from history,
 *  re-read the Board (its card may have moved / been 差し戻し while the engine was
 *  down), re-beat, and only THEN continue the in-progress work. The resume DOES NOT
 *  cross goals (plan §3): the same goal survives the process restart in the same
 *  worktree — it never becomes a role desk that outlives goals. Code may have
 *  changed (a restart is usually a release), so it is told to re-verify before
 *  entering any uncommitted continuation. */
export const WORKER_RESUME_INJECTION =
  '/order セッション再開: アプリ再起動をまたいで(たいていリリース)前回の会話が復元された。端末(PTY)は一度死んだが、worktree の作業も会話履歴もそのまま残っている。あなたが今まで進めていた元の /order ゴールは履歴の中にある — この行を新しいゴールと取り違えるな。続行する前に必ず順に: ①履歴内の元の /order ゴールと完了条件を読み直す(完了条件は変わっていない)②自分のカードが Board のどの列にいるか・差し戻しが付いていないかを API と git で読み直す ③心拍を打ち直す(bash ~/.claude/swarm-beat.sh <phase> false "再開・現状確認中")。そのうえで中断した作業を続ける。再起動でコード自体が変わっている可能性があるので、未コミットの続きに入る前に git status と関連テストで worktree の現状を確かめること。git push は従来どおり全形態禁止・統合は司令塔に委ねる。'

// ── Worktree lifecycle ──────────────────────────────────────────────────────

export interface SwarmWorktree {
  /** Absolute path of the new worktree (under the central worktrees dir). */
  worktree: string
  /** The `swarm/*` branch checked out there. */
  branch: string
  /** Owning registry UUID. */
  uuid: string
}

/** Create an isolated `swarm/*` worktree for `projectPath` under its central
 *  worktrees dir, node_modules symlinked from the main checkout. Throws if the
 *  path isn't a registered project (projectUUIDFromPath) or `git worktree add`
 *  fails (after cleaning up a partial worktree + branch, so a lost race never
 *  orphans state). */
export const createSwarmWorktree = async (
  projectPath: string,
  opts: { hint?: string } = {},
): Promise<SwarmWorktree> => {
  const uuid = await projectUUIDFromPath(projectPath)
  const parent = centralWorktreesDir(uuid)
  await mkdir(parent, { recursive: true })

  // Freshen origin/main best-effort (offline / no remote still works via the
  // local fallbacks below) so workers branch off the latest trunk.
  await git(projectPath, ['fetch', 'origin', 'main'])

  // Which base refs actually exist → pick the most-preferred.
  const existing = new Set<string>()
  for (const ref of SWARM_BASE_REF_PREFERENCE) {
    if ((await git(projectPath, ['rev-parse', '--verify', '--quiet', ref])) !== null) {
      existing.add(ref)
    }
  }
  const base = pickBaseRef(existing)

  // Uniqueness: timestamp + a 48-bit random token (two same-second spawns won't
  // collide; the old 16-bit token had a 1/65536 collision that — because the
  // dir name is derived from the branch — could make a loser's failure-cleanup
  // --force-remove the WINNER's identical dir). The branch charset is
  // constrained by swarmBranchName.
  const stamp = `${tsStamp()}-${randomUUID().replace(/-/g, '').slice(0, 12)}`
  const branch = swarmBranchName(stamp, opts.hint)
  const dir = join(parent, swarmWorktreeDirName(branch))

  // Never touch a dir we didn't create: if the name somehow already exists
  // (collision / leftover), fail loudly BEFORE `worktree add` so the cleanup
  // below can only ever remove a dir THIS call made — a loser can't tear down a
  // concurrent winner's live worktree.
  if (await stat(dir).then(() => true).catch(() => false)) {
    throw new Error(`createSwarmWorktree: worktree dir already exists: ${dir}`)
  }

  // -c branch.autoSetupMerge=false: don't write upstream-tracking into the
  // SHARED .git/config, so concurrent `worktree add` (several workers at once)
  // don't contend on the config lock. Clean up on failure (the dir did not
  // pre-exist, so this only removes what we just created).
  const added = await git(projectPath, [
    '-c',
    'branch.autoSetupMerge=false',
    'worktree',
    'add',
    '-b',
    branch,
    dir,
    base,
  ])
  if (added === null) {
    await git(projectPath, ['worktree', 'remove', '--force', dir])
    await git(projectPath, ['branch', '-D', branch])
    throw new Error(`createSwarmWorktree: git worktree add failed for ${branch}`)
  }

  await linkWorktreeNodeModules(projectPath, dir)

  return { worktree: dir, branch, uuid }
}

/** Symlink the main checkout's node_modules into a worker worktree (no-op when
 *  the repo has none, or the worktree already has one). Best-effort — npm simply
 *  won't work there if it fails, which doesn't block claude itself.
 *
 *  ⚠ SHARED BY BOTH DOORS on purpose. `commitWipBeforeTeardown` UNLINKS this
 *  symlink before its `git add -A`, so any worktree that has been through a
 *  reclaim comes back without one. If only `createSwarmWorktree` linked it, a
 *  worker re-entering an existing branch would start fine, work fine, and fail
 *  ONLY at its completion gate (`npm test` / `tsc`) — the least diagnosable
 *  shape there is. */
export const linkWorktreeNodeModules = async (projectPath: string, dir: string): Promise<void> => {
  try {
    const repoNm = join(projectPath, 'node_modules')
    const wtNm = join(dir, 'node_modules')
    const hasRepoNm = await stat(repoNm).then(() => true).catch(() => false)
    const hasWtNm = await stat(wtNm).then(() => true).catch(() => false)
    if (hasRepoNm && !hasWtNm) await symlink(repoNm, wtNm)
  } catch {
    // ignore — node_modules is a convenience, not a correctness requirement
  }
}

/** A place where a card's work already lives — see {@link ensureSwarmWorktreeForBranch}. */
export interface ReusableWork {
  worktree: string
  branch: string
}

/**
 * Get a usable worktree for an EXISTING `swarm/*` branch, so a card that already
 * has work can be continued instead of started over.
 *
 * WHY THIS EXISTS. A worker reclaimed at a quota wall goes back to 'todo' with
 * its `card.branch` intact (the recover write only sets the column). The next
 * dispatch used to mint a FRESH branch and stamp it over `card.branch`, leaving
 * the commits reachable only through `git branch --list` — work paid for, then
 * orphaned, silently. Re-entering the same branch makes that stamp a write of
 * the value it already had.
 *
 * Returns null when there is nothing to reuse (no such branch, or git refuses) —
 * the caller then dispatches normally. Never throws.
 *
 * ⚠ NO `--force`, NO `--detach`. git's refusal to check one branch out twice
 * (exit 128) is the structural guard that keeps "one branch, one worktree" true;
 * forcing past it is how two workers end up writing in one place.
 * ⚠ NO `pull` / `rebase`. Nobody is watching this tree; catching up with the
 * trunk belongs to the commander's integration, not to a silent re-entry.
 */
export const ensureSwarmWorktreeForBranch = async (
  projectPath: string,
  branch: string,
): Promise<ReusableWork | null> => {
  const name = branch.trim()
  // The engine's ownership line: never take hold of a branch outside swarm/*.
  if (!name.startsWith('swarm/') || name.includes('..') || /[\s~^:?*[\\]/.test(name)) return null
  try {
    if ((await git(projectPath, ['rev-parse', '--verify', '--quiet', name])) === null) return null

    // Already checked out somewhere? Use THAT — re-adding would be refused, and
    // the existing dir is by definition the place this work lives.
    const listed = await git(projectPath, ['worktree', 'list', '--porcelain'])
    if (listed) {
      let dir: string | null = null
      for (const line of listed.split('\n')) {
        if (line.startsWith('worktree ')) dir = line.slice('worktree '.length).trim()
        else if (line.startsWith('branch ') && line.slice('branch '.length).trim() === `refs/heads/${name}`) {
          if (dir && (await stat(dir).then((st) => st.isDirectory()).catch(() => false))) {
            await linkWorktreeNodeModules(projectPath, dir)
            return { worktree: dir, branch: name }
          }
        }
      }
    }

    const uuid = await projectUUIDFromPath(projectPath)
    const dir = join(centralWorktreesDir(uuid), swarmWorktreeDirName(name))
    // A directory left behind by a removed worktree makes `git worktree add`
    // fail with a stale-administrative-file error; prune clears the record
    // first (measured: without it, exit 128).
    await git(projectPath, ['worktree', 'prune'])
    if ((await git(projectPath, ['worktree', 'add', dir, name])) === null) return null
    if (!(await stat(dir).then((st) => st.isDirectory()).catch(() => false))) return null
    await linkWorktreeNodeModules(projectPath, dir)
    return { worktree: dir, branch: name }
  } catch {
    return null
  }
}

/** Remove a worker worktree (kill / completion). Hard safety: the dir MUST sit
 *  under this project's central worktrees dir (canonicalized, sep-terminated),
 *  and the bare central root itself is refused — so a crafted path can never
 *  remove the main checkout or another project's data. Any live PTY in the
 *  worktree is killed first. `force` (the kill/abandon case) passes
 *  `--force` so a dirty mid-implementation tree can still be torn down; without
 *  it git refuses a dirty/locked worktree (the safe default).
 *
 *  On a CONFIRMED removal it also drops the worktree's ~/.claude.json folder-trust
 *  entry (ensureClaudeFolderTrusted seeded one on every launchClaude in this dir):
 *  without this, every ephemeral worker dir would pile up in claude's projects map
 *  forever, slowing every claude start's read/write of that file. Not dropped on a
 *  refused removal — the worktree is still live, and the next launch re-seeds it. */
export const removeSwarmWorktree = async (
  projectPath: string,
  worktree: string,
  opts: { force?: boolean } = {},
): Promise<RemoveSwarmWorktreeResponse> => {
  const central = await canonicalize(centralWorktreesDir(await projectUUIDFromPath(projectPath)))
  // Security guard FIRST (canonicalized, symlink-resolved): refuse anything that
  // isn't strictly under this project's central worktrees dir, and the bare
  // central root itself. canonicalize tolerates a not-yet/no-longer-existing
  // path (it resolves the existing ancestor + re-appends the tail), so an
  // out-of-central path is refused whether or not it currently exists on disk.
  const canon = await canonicalize(worktree)
  if (canon === central || !isUnderCentralDir(canon, central)) {
    return { removed: false, reason: 'not a central worktree' }
  }
  // Idempotent: already gone on disk → treat as removed (still prune stale
  // worktree bookkeeping in the project's repo + any lingering trust entry).
  if (!(await stat(worktree).then(() => true).catch(() => false))) {
    await git(projectPath, ['worktree', 'prune'])
    removeClaudeFolderTrust(worktree)
    return { removed: true }
  }
  // Snapshot the branch BEFORE the removal (unreadable after) — NON-FORCE only.
  // force:true is the kill/abandon lane (never an integration cleanup), while
  // the commander's post-merge sweep (og-manage §マージ step 7) is force:false;
  // the snapshot feeds the self-update trigger on the confirmed-removal path
  // below (selfUpdateOnIntegrate.ts).
  const integrationSnap = opts.force ? null : await snapshotWorktreeBranch(worktree)
  // Kill any live PTY in the worktree first, by the EXACT spawn-returned path —
  // that is the cwd recorded on the PTY (exact match), so the canonicalized form
  // would silently miss under a symlinked home.
  //
  // AND WAIT FOR IT TO ACTUALLY DIE (2026-07-29). This used to be the
  // fire-and-forget killTerminalsByCwd, whose signal is asynchronous: the very
  // next lines then removed the directory while `claude` was still running in it.
  // claude spawns `git` constantly (status/diff/log), so a delete landing mid-run
  // is the textbook way to wedge a process in uninterruptible sleep, where no
  // signal and no timeout can reach it again (07 章 §7) — our own teardown
  // manufacturing the un-killable orphans we spent 2026-07-28 rooting out.
  // A worker teardown is not urgent; five seconds of certainty is cheap.
  // ⚠ BOTH POOLS. This asked only the PTY pool until 2026-07-31, and
  // killTerminalsByCwdAndWait answers `true` ("nothing to wait for") when it
  // finds no sessions — which is EXACTLY what an SDK worker's worktree looks
  // like to it. So the refusal below never fired for one, and the removal below
  // ran under a live claude: the very accident the comment above describes,
  // reintroduced by a second runtime the check did not know about.
  const ptyGone = await stopAllDesksInDirAndWait(worktree)
  if (!ptyGone) {
    // Still occupied. Refusing is the safe answer: the caller retries (the
    // engine's next pass, the commander's next sweep) and the worktree stays
    // intact meanwhile. Deleting anyway is what created the wedge.
    return {
      removed: false,
      reason: 'a session is still running in this worktree',
      // The caller must be able to tell "still busy, ask again" from "removal
      // failed for some other reason" WITHOUT string-matching this sentence.
      // The engine now retries on this one instead of dropping the worker (see
      // recoverLost's retry budget) — a dropped worker is an orphaned claude in
      // a worktree nobody owns, holding an SDK slot for the life of the process.
      stillOccupied: true,
    }
  }
  // Drop the node_modules convenience symlink before removing: under a
  // `node_modules/` (trailing-slash) .gitignore — the dominant convention — the
  // SYMLINK reads as UNTRACKED (the pattern matches directories only), which
  // would block a non-force removal of an otherwise-clean tree AND make the
  // periodic worktree sweep skip it forever. Unlinking removes only the pointer,
  // never the real modules it targets. Real uncommitted work still (correctly)
  // blocks a non-force removal.
  try {
    const nm = join(worktree, 'node_modules')
    if ((await lstat(nm)).isSymbolicLink()) await unlink(nm)
  } catch {
    // ignore — best effort (no symlink, or already gone)
  }
  const removed = await git(projectPath, [
    'worktree',
    'remove',
    ...(opts.force ? ['--force'] : []),
    worktree,
  ])
  await git(projectPath, ['worktree', 'prune'])
  if (removed === null) {
    return { removed: false, reason: opts.force ? 'git refused' : 'worktree dirty or locked' }
  }
  // Confirmed gone — drop its ~/.claude.json trust entry so ephemeral worktree
  // paths don't accumulate in claude's projects map (see the doc note above).
  removeClaudeFolderTrust(worktree)
  // Commander-integration detection → engine self-update trigger. The manager-
  // only rework (2026-07-15) removed the engine's land path and with it the old
  // land-time trigger; the commander's confirmed post-merge sweep is the new
  // observable seam (docs/commander/TARGET-STATE.md §5). Fail-safe + git-read-
  // only inside; in unarmed runs it resolves to requested:false.
  if (integrationSnap) {
    return { removed: true, selfUpdate: await fireSelfUpdateIfIntegrated(projectPath, integrationSnap) }
  }
  return { removed: true }
}

/** Validate an EXISTING worktree for the RESTART path and read its branch. Same
 *  hard safety as removeSwarmWorktree: the dir MUST sit strictly under THIS
 *  project's central worktrees dir (canonicalized; the bare central root is
 *  refused), so an API-supplied path can never point relaunch at the main
 *  checkout or another project's tree. Returns the ORIGINAL (non-canonicalized)
 *  path so the relaunched PTY's cwd matches the first spawn's exactly (the
 *  killTerminalsByCwd / live-cwd bookkeeping is by exact path). Throws if the
 *  path escapes the central dir, no longer exists, or has no current branch. */
export const resolveExistingSwarmWorktree = async (
  projectPath: string,
  worktree: string,
): Promise<{ worktree: string; branch: string }> => {
  const central = await canonicalize(centralWorktreesDir(await projectUUIDFromPath(projectPath)))
  const canon = await canonicalize(worktree)
  if (canon === central || !isUnderCentralDir(canon, central)) {
    throw new Error('restart worktree is not under this project’s central worktrees dir')
  }
  if (!(await stat(worktree).then(() => true).catch(() => false))) {
    throw new Error('restart worktree no longer exists')
  }
  // The branch checked out there — the worker keeps working its same swarm/*
  // branch on relaunch (a detached HEAD has none, which we refuse).
  const branch = (await git(worktree, ['branch', '--show-current']))?.trim()
  if (!branch) throw new Error('restart worktree has no current branch')
  return { worktree, branch }
}

// ── Spawn orchestration ─────────────────────────────────────────────────────

export interface SpawnSwarmWorkerOpts {
  projectPath: string
  /** Board goal — typically a card's title (+ notes). Injected as the /order. */
  title: string
  notes?: string
  /* (liveWorkers / env / cols / rows were DELETED 2026-08-13 with the PTY
   * worker: the roster-assisted SDK slot count died with the cap, the env role
   * tag and the terminal dimensions were PTY launch inputs. An old client
   * still sending cols/rows in the POST body is simply ignored.) */
  /** Optional branch-name decoration (uniqueness comes from the timestamp). */
  hint?: string
  /** RESTART path: reuse this EXISTING central worktree instead of creating a
   *  fresh one, so a dead worker relaunches in place — same `swarm/*` branch +
   *  its in-progress work, no orphan tree / twin branch. Validated to sit under
   *  the project's central worktrees dir (resolveExistingSwarmWorktree); throws
   *  otherwise. Omitted (a fresh dispatch) = create a new worktree off the trunk. */
  worktree?: string
  /** CONVERSATION RESUME (card 4 — ENGINE_PERSISTENCE_PLAN §5): the worker's
   *  PERSISTED `--session-id` UUID (roster.sessionId, captured at the original
   *  spawn). Present ⇒ this is a boot re-hydration of an in-progress worker: reuse
   *  it as claude's session id and launch with `--resume <id>` + the
   *  {@link WORKER_RESUME_INJECTION} prompt, so the same conversation continues in
   *  the SAME worktree instead of starting fresh. ALWAYS paired with `worktree`
   *  (the restart path — you can only resume a conversation whose worktree is still
   *  on disk). Omitted ⇒ a fresh session id is minted (unchanged fresh-dispatch
   *  behaviour). The caller (resumeEngines) only sets it after PROVING the
   *  transcript is loadable (swarmTranscriptProof); this module still runs the same
   *  preflight + guard-wiring gates, so resume opens no new bypass. */
  resumeSessionId?: string
  /** LEARNING LOOP (card fdf714ef): the reason this SAME card was previously
   *  差し戻し / rolled back (RED verify / review must-fix). Appended to the /order
   *  so a RE-DISPATCHED card's fresh worker doesn't repeat the failure. Omitted on
   *  a first dispatch. See {@link buildOrderInjection}. */
  priorFailure?: string
}

/** Thrown when the L4 guard wiring cannot be VERIFIED at spawn time (GAP-2).
 *  A worker runs bypass, so the PreToolUse deny veto is its only deterministic
 *  block — and Claude Code fails a MISSING hook OPEN. Unverified wiring ⇒ no
 *  worker (fail-closed), the same shape as NoAllowedModelTierError above. */
export class GuardWiringError extends Error {
  readonly problems: readonly string[]
  constructor(problems: readonly string[]) {
    super(
      'L4 guard wiring failed verification — worker spawn refused (fail-closed): ' +
        (problems.length ? problems.join('; ') : 'unknown wiring problem'),
    )
    this.name = 'GuardWiringError'
    this.problems = problems
  }
}

/** Thrown when a RESTART would put a second desk into a worktree that a live one
 *  — on EITHER runtime — is still working in. Refusing is the whole point: two
 *  claudes sharing a worktree share its files and its `swarm/*` branch, and the
 *  loser's edits are simply overwritten. A caller that means to replace the
 *  incumbent stops it first (stopAllDesksInDirAndWait) and then retries. */
export class WorktreeOccupiedError extends Error {
  readonly worktree: string
  constructor(worktree: string) {
    super(
      'a desk is already live in this worktree — worker spawn refused so two ' +
        `claudes cannot share one working tree: ${worktree}`,
    )
    this.name = 'WorktreeOccupiedError'
    this.worktree = worktree
  }
}

// One bell/toast per THROTTLE window, not per refused spawn — the engine's
// dispatch tick retries a refused spawn every few seconds, and the refusal
// itself (the throw) already repeats; only the human-facing notification needs
// deduping. In-memory on purpose: a restart re-notifying once is fine.
const GUARD_UNWIRED_NOTIFY_THROTTLE_MS = 10 * 60_000
let lastGuardUnwiredNotifyAt = 0
export const __resetGuardUnwiredNotifyThrottleForTests = (): void => {
  lastGuardUnwiredNotifyAt = 0
}
const notifyGuardUnwired = async (
  projectPath: string,
  problems: readonly string[],
): Promise<void> => {
  const now = Date.now()
  if (now - lastGuardUnwiredNotifyAt < GUARD_UNWIRED_NOTIFY_THROTTLE_MS) return
  lastGuardUnwiredNotifyAt = now
  // Awaited (persist BEFORE the refusal throws — a fire-and-forget write could
  // be lost with the process), but its own failure is swallowed: the
  // notification must never decide the refusal, which happens regardless.
  await createSwarmFatalNotification({
    event: 'guard-unwired',
    detail:
      'L4ガード(PreToolUse veto)の配線検証に失敗したため、worker の起動を拒否しました(fail-closed)。' +
      `詳細: ${problems.join(' / ')}`,
    projectPath,
    logHint:
      '~/.claude/settings.json と ~/.openground/guard/ を確認してください(OPEN GROUND 再起動で再インストールが走ります)。',
  }).catch(() => {})
}

/** Create the worktree and launch ONE Agent SDK claude session in it, handing
 *  the `/order ゴール: …` goal as the first turn. SDK-ONLY (2026-08-13): a
 *  failed SDK launch is a failed dispatch (typed SdkWorkerUnavailableError the
 *  engine's backoff keys on) — never a PTY degrade. Subscription-only still
 *  holds: the session drives the USER'S installed claude CLI. */
export const spawnSwarmWorker = async (
  opts: SpawnSwarmWorkerOpts,
): Promise<SpawnSwarmWorkerResponse> => {
  // Token budget (card 68d8e00f): the mode (+ this card's weight, in optimize) picks
  // the worker's model/effort. economy ⇒ sonnet/low, max ⇒ fable/max, optimize ⇒ heavy
  // cards fable, chores sonnet. A per-card explicit override still wins via the Board
  // 実行 button's task.run; unattended orchestrator dispatch has none, so it rides the mode.
  //
  // Resolved BEFORE the worktree is created: with every tier switched OFF there is
  // no model to launch on, and failing here leaves no orphan worktree/branch behind
  // (fail-CLOSED — the hard mask must never be worked around by "just spawn anyway").
  // PROBED (2026-07-13): when the resolved tier is UNKNOWN (no cooling mark, no
  // usage veto) one collapsed headless probe confirms it can actually launch —
  // the only pre-launch signal that sees a tier-local wall /usage cannot express
  // (swarmTierProbe). Wall ⇒ the tier cools (disk-mirrored) and the ladder walk
  // drops a rung, so a dry fable seats this worker on opus instead of burning it.
  const me = await resolveSwarmModelEffortProbed(
    await getExecutionMode(),
    'worker',
    { title: opts.title, notes: opts.notes },
    Date.now(),
    await getAllowedModelTiers(),
  )
  if (!me) throw new NoAllowedModelTierError()
  // L4 WIRING GATE (GAP-2) — fail-closed, and like the model mask above it runs
  // BEFORE the worktree exists so a refusal leaves no orphan worktree/branch.
  // A worker runs bypass inside a worktree that SHARES the main repo's .git,
  // and Claude Code fails a MISSING PreToolUse hook OPEN — so boot-time
  // installHooks() being fire-and-forget (server/index.ts) used to mean a
  // failed install still let unguarded workers spawn. Here the wiring is
  // verified on every spawn (settings.json entries + installed guard body
  // byte-identical to the expected version), self-healing once through the
  // idempotent installHooks(); when it STILL doesn't verify, the spawn is
  // refused and the refusal is surfaced to the UI (bell + OS toast, throttled).
  // Covers every worker path — engine dispatch, POST /api/swarm/worker, RESTART.
  const wiring = await ensureGuardWiring()
  if (!wiring.ok) {
    await notifyGuardUnwired(opts.projectPath, wiring.problems)
    throw new GuardWiringError(wiring.problems)
  }
  // RESTART (opts.worktree) relaunches IN the existing worktree — same swarm/*
  // branch + work preserved; a fresh dispatch creates a new isolated worktree.
  const { worktree, branch } = opts.worktree
    ? await resolveExistingSwarmWorktree(opts.projectPath, opts.worktree)
    : await createSwarmWorktree(opts.projectPath, { hint: opts.hint })
  // ── ONE DESK PER WORKTREE (2026-08-03) ──────────────────────────────────────
  // The fresh path is protected by construction — createSwarmWorktree throws if
  // the directory already exists. The RESTART path deliberately reuses one, and
  // had NO occupancy check, so "relaunch the worker for this card" would seat a
  // second claude beside a first that was still working.
  //
  // MEASURED, not imagined. A card was sent back review→doing while its SDK
  // worker was still alive; a restart came in; the SDK slot was full (1/1 — held
  // by the very worker nobody had looked for), so the newcomer degraded to PTY
  // and started editing the same files on the same `swarm/*` branch. The engine
  // log carried no `dispatch:` line because the engine had not dispatched it.
  //
  // ⚠ ASK BOTH POOLS. A PTY-shaped check ("is a terminal live in this cwd?") is
  // exactly what was already available and exactly what would have missed this:
  // an SDK worker holds no terminalId, so to that question it does not exist.
  // liveDeskOccupies is the seam that cannot forget a pool.
  //
  // Refusing (rather than adopting, or killing the incumbent) is deliberate: the
  // incumbent holds uncommitted work, and this call cannot know whether the
  // caller wants it dead. A restart that really must replace a live desk stops it
  // first — stopAllDesksInDirAndWait — and then calls here.
  //
  // A canonicalize failure throws out of here rather than resolving to "free":
  // "cannot prove the directory is empty" must not authorise a spawn into it.
  if (opts.worktree && (await liveDeskOccupies(worktree))) {
    throw new WorktreeOccupiedError(worktree)
  }
  // RESUME (card 4): reuse the PERSISTED session id so `--resume <id>` reattaches
  // the same conversation; else mint a fresh one (unchanged). resumeSessionId only
  // arrives on the restart path (always paired with opts.worktree above), and only
  // after resumeEngines PROVED the transcript is loadable.
  const agentSessionId = opts.resumeSessionId ?? randomUUID()
  // Owner-only sandbox gate, resolved SERVER-side (owner role && the toggle) —
  // never from the dispatch request. When open, the worker's already-bypass run
  // is wrapped in a Seatbelt sandbox confined to its worktree; the repo's shared
  // `.git` is granted write so `git commit`/`push` still works (a worktree's
  // objects/refs live in the main checkout, outside the worktree cwd). macOS-only
  // (launchClaude no-ops it elsewhere); the worker's symlinked node_modules is left
  // fully READ-only — NO carve-out (a writable node_modules would let a sandboxed
  // worker poison code, e.g. `.vite/deps`, the owner later runs UN-sandboxed).
  const sandbox = await isExperimentEnabled('sandbox')
  // Settings.language ⇒ the worker's user-facing replies (chat, blocker
  // questions, PR/commit text) follow it — resolved once here and threaded
  // into the SDK launch plan below (languageDirective).
  const lang = await getPromptLang()
  // Research cookies (Settings → Research channels) ride into the worker's env
  // so its LOCAL twitter-cli invocations are signed in — {} when unconfigured,
  // leaving the spawn env byte-identical to before. Same exposure class as the
  // PTY era's `zsh -l` desks (which inherited whatever the owner exported);
  // the values still never leave the machine (researchAuth.ts contract).
  const researchEnv = await researchWorkerEnv()
  // SPAWN FAILURE MUST NOT LEAK THE WORKTREE (2026-07-29).
  //
  // Everything ABOVE the worktree creation fails closed, and two comments in this
  // file say so — but launchClaude sits BELOW it and was outside that invariant.
  // When it throws (claude missing from PATH, a PTY that will not open, a
  // sandbox profile rejected) the worktree AND its `swarm/*` branch were already
  // on disk and nothing removed them. runDispatchPass has no backoff — it catches
  // and continues on a 3s tick — so ONE persistent failure minted a fresh
  // worktree + branch EVERY THREE SECONDS, and nothing collects them
  // automatically (cleanProjectWorktrees is a manual HTTP route). A repo could
  // accumulate hundreds of them overnight.
  //
  // On the RESTART path (opts.worktree) the worktree pre-existed this call and
  // holds the worker's real work — it is never ours to remove.
  const freshlyCreated = !opts.worktree

  // ── SDK-ONLY LAUNCH (2026-08-13 owner decision — the PTY worker is gone) ───
  // Workers run on the Agent SDK runtime, full stop: no dial, no slot cap, no
  // PTY fallback. Every reason the SDK cannot be established is a SPAWN FAILURE
  // the engine answers with "card stays in todo + loud notification + retry
  // with backoff" (fail-fast) — never a silent degrade. The old fallback
  // absorbed real breakage, which is exactly why the migration could never
  // finish behind it (measured 2026-08-13: DEFAULT_SDK_MAX_WORKERS=1 quietly
  // sent every extra worker to a PTY and the owner read it as a bug). A
  // fell-back worker no longer exists, so neither does fellBackBecause here.
  //
  // The preload stays AHEAD of the preflight for the old reason: nothing may
  // await between the guard-proof and the spawn. Never rejects.
  const sdkReady = await preloadSdk()

  // Everything that must be true before an SDK worker may start (the USER'S own
  // claude, new enough; the A3/L4 veto provably armed — sdkWorkerPreflight).
  // Fail-CLOSED: with no PTY to degrade to, a failed preflight is a failed
  // dispatch — roll back what THIS call created and throw the typed error the
  // engine's spawn-failure backoff keys on.
  const pre = sdkWorkerPreflight({ writeRoots: [worktree] })
  if (!pre.ok || !pre.claudeBin) {
    if (freshlyCreated) {
      await removeSwarmWorktree(opts.projectPath, worktree, { force: true }).catch(() => {})
      await git(opts.projectPath, ['branch', '-D', branch])
    }
    throw new SdkWorkerUnavailableError(
      pre.problems.length ? pre.problems : ['no claude binary resolved for an SDK worker'],
    )
  }

  const built = sdkWorkerLaunchPlan({
    worktree,
    agentSessionId,
    title: opts.title,
    notes: opts.notes,
    priorFailure: opts.priorFailure,
    resume: !!opts.resumeSessionId,
    me,
    claudeBin: pre.claudeBin,
    env: { ...process.env, ...researchEnv },
    // The sandbox experiment is not supported on the SDK runtime; passing the
    // flag through makes the plan SAY so (a warning) instead of silently
    // dropping the containment the owner asked for.
    sandbox,
    lang,
  })
  for (const w of built.warnings) console.warn(`[swarm] ${w}`)
  let session: ReturnType<typeof spawnSdkSession>
  try {
    session = spawnSdkSession({
      cwd: worktree,
      role: 'worker',
      agentSessionId,
      options: built.options,
      initialPrompt: built.initialPrompt,
      // Carried down from before the preflight — the type demands it, which is
      // what stops the next spawn site from forgetting to preload.
      sdk: sdkReady,
    })
  } catch (e) {
    if (freshlyCreated) {
      // Best-effort teardown of what THIS call made. force:true because there is
      // nothing to preserve — no session ever started. Failures are swallowed:
      // the spawn error is the one worth propagating.
      await removeSwarmWorktree(opts.projectPath, worktree, { force: true }).catch(() => {})
      await git(opts.projectPath, ['branch', '-D', branch])
    }
    // TYPED, so the engine's backoff gate catches it (adversarial review
    // 2026-08-13): a raw rethrow here fell through `e instanceof
    // SdkWorkerUnavailableError` in runDispatchPass to the fast-retry arm — a
    // persistent SDK-module blow-up churned a worktree rollback every 3s tick
    // with no hold and no bell, the exact shape the ladder exists to stop.
    // (swarmManager.launchSdkDesk wraps the same throw for the same reason.)
    if (e instanceof SdkWorkerUnavailableError) throw e
    throw new SdkWorkerUnavailableError([
      `SDK spawn failed (${String((e as Error)?.message ?? e).slice(0, 200)})`,
    ])
  }
  // A session that died INSIDE spawnSdkSession reports 'failed' SYNCHRONOUSLY
  // rather than throwing (the pool catches the sync throw and records the entry
  // as failed). Returning it as a live worker is how a dead session becomes a
  // roster entry the engine monitors forever — so it is a spawn FAILURE like
  // any other: roll back the fresh worktree, throw, and let the engine's
  // backoff + notification carry it. (A REUSED worktree — the resume path — is
  // the worker's real work and is never ours to remove.)
  if (session.status === 'failed') {
    if (freshlyCreated) {
      await removeSwarmWorktree(opts.projectPath, worktree, { force: true }).catch(() => {})
      await git(opts.projectPath, ['branch', '-D', branch])
    }
    throw new SdkWorkerUnavailableError([
      `SDK worker died at start (${session.exitReason ?? 'unknown'})`,
    ])
  }
  // terminalId is EMPTY for an SDK worker: the identity invariant is
  // pty ⇔ terminalId / sdk ⇔ sdkSessionId (workerRuntime.ts), never both.
  // `model` rides back so the orchestrator can attribute a later rate-limit
  // sighting on this worker to the RIGHT quota tier (swarmQuota cooling table).
  return {
    terminalId: '',
    runtime: 'sdk',
    sdkSessionId: session.id,
    agentSessionId,
    worktree,
    branch,
    model: me.model,
    ...(me.effort ? { effort: me.effort } : {}),
  }
}

/** Wall-clock stamp `MMDD-HHMMSS` for branch uniqueness. Isolated in one helper
 *  so the rest of the module stays clock-free + unit-testable. */
const tsStamp = (): string => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  )
}

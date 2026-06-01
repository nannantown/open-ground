export interface OpenApp {
  name: string
  /** Bundle path (e.g. /Applications/Cursor.app) — needed for cwd-mode launch. */
  path?: string
  /** `open`: `open -a name folder` (editors, Terminal.app, iTerm, Warp…).
   *  `cwd`: spawn the .app's binary with cwd set to the folder (Alacritty,
   *  kitty, alacritty-style pure terminals that won't accept a folder doc). */
  mode?: 'open' | 'cwd'
}

export interface Settings {
  projectsRoot: string | null
  archiveDirName: string
  excludePatterns: string[]
  runPromptTemplate: string
  /** Apps registered by the user for the project panel's "Open in" menu.
   *  The first item is the default (one-click Open). Stored as objects so a
   *  pure terminal (Alacritty etc., mode: 'cwd') and a folder-accepting GUI
   *  app (mode: 'open') can be launched the right way. Strings from older
   *  saves are normalised on read. */
  openApps?: OpenApp[]
  /** Browser notification when a task run finishes (and the user isn't watching it). */
  notifyOnRunComplete?: boolean
  /** Soft Web Audio "pop" alongside the notification. */
  notifySound?: boolean
  /** Claude Code subscription plan — drives the % shown in the usage HUD.
   *  Unset means the HUD shows raw token counts instead of a percentage. */
  claudePlan?: 'pro' | 'max5x' | 'max20x' | null
  /** Bounded same-project parallelism (Approach A, slice 2). Every non-resume
   *  chat run executes in its own worktree, so same-project chats run
   *  concurrently; this caps how many run at once per project. Runs beyond the
   *  cap queue (FIFO) and start as slots free. Resume / in-tree / plan runs are
   *  unaffected. Unset → DEFAULT_MAX_CONCURRENT_RUNS_PER_PROJECT (3). */
  maxConcurrentRunsPerProject?: number
}

/** Aggregated usage over the rolling 5-hour rate-limit window, scraped from
 *  ~/.claude/projects/**\/*.jsonl. The window starts at the oldest assistant
 *  message still within 5h of now; nextResetAt = windowStart + 5h. */
export interface ClaudeUsage {
  windowHours: number
  windowStart: string | null
  nextResetAt: string | null
  tokens: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
  messageCount: number
  byModel: Record<string, number>
  /** Model of the most recent assistant message — what the HUD labels the gauge with. */
  currentModel: string | null
  /** Authoritative numbers parsed from `claude /usage`. Matches what the user
   *  sees in the CLI's settings dialog and on claude.ai. Null when the CLI
   *  scrape hasn't succeeded yet; the HUD falls back to the local-jsonl
   *  estimate above when so. */
  cli?: {
    session: { pct: number; resetsAt: string } | null
    weekAll: { pct: number; resetsAt: string } | null
    weekSonnet: { pct: number; resetsAt: string } | null
    capturedAt: string
  } | null
}

export interface ProjectMeta {
  id: string
  name: string
  path: string
  relativePath: string
  description: string
  lastModified: string
  archived: boolean
  hasGit: boolean
  openTaskCount: number
  totalTaskCount: number
  /** Phase 5.A: the narrative of this project's most-recently-finished task
   *  run, derived server-side from the newest `task.latestRun` across the
   *  project's tasks. Feeds the card hero as a fallback when the live/disk
   *  run-session list (runSummaryByProject) has no entry for this project —
   *  so a card still narrates "where this project stands" after the in-memory
   *  sessions have aged out. Absent when no task has a persisted latestRun. */
  latestRunSummary?: RunSummaryInfo
}

export interface CanvasPosition {
  x: number
  y: number
}

// Free-form items placed on the canvas (annotations and grouping frames),
// distinct from the project cards which are backed by real folders.
//
// Implementation note: this is a single optional-fields interface, not a
// discriminated union, to keep Phase 2's diff contained. Each field is
// `type`-scoped in its doc comment — only consume the fields valid for the
// current element type. A future phase may refactor this into a proper union.
export interface CanvasElement {
  id: string
  type: 'text' | 'sticky' | 'frame' | 'mock' | 'comment' | 'image' | 'screen' | 'shape'
  x: number
  y: number
  width?: number // frames, stickies, mocks, images, and screens carry a size
  height?: number
  text: string // frame label / mock source / sticky body / image alt / screen source
  color?: string // sticky note colour
  /** Text-only typography (Selection Inspector, round 1). All OPTIONAL and
   *  backward-compatible: older saved canvases omit them and the text view
   *  falls back to the built-in defaults (18px Fraunces display serif, ink),
   *  so previously-saved Canvases load and render exactly as before.
   *  - `fontSize`   — px, clamped to a sane range by the inspector.
   *  - `fontFamily` — a CSS font-family stack chosen from a safe/web-font set.
   *  - `textColor`  — CSS colour string for the glyphs (named `textColor`, not
   *    `color`, because `color` is already taken by the sticky background).
   *  - `fontWeight` — CSS font-weight (e.g. 400 normal / 700 bold), set by the
   *    inspector's Bold toggle + weight select. Omitted = 400 (round 2).
   *  - `textAlign`  — horizontal alignment of the glyphs within the box
   *    ('left' | 'center' | 'right'). Omitted = 'left' (round 2).
   *  - `lineHeight` — unitless line-height multiplier (e.g. 1.2), clamped to a
   *    sane band by the inspector. Omitted = the built-in default (round 2). */
  fontSize?: number
  fontFamily?: string
  textColor?: string
  fontWeight?: number
  textAlign?: 'left' | 'center' | 'right'
  lineHeight?: number
  /** Fill + stroke for NON-text elements (Selection Inspector, round 3). All
   *  OPTIONAL and backward-compatible: older saved canvases omit them and the
   *  views fall back to the built-in defaults (see `canvasFillStyle.ts`), so
   *  previously-saved Canvases render exactly as before.
   *  - `fill`        — CSS colour for a FRAME's body (and any future filled
   *    non-text type). STICKY fill is NOT here: it reuses the existing `color`
   *    field above, so the inspector's sticky Fill control writes `color` and
   *    no legacy sticky changes meaning.
   *  - `strokeColor` — CSS colour for a frame's border. Omitted = the legacy
   *    `line-strong` token.
   *  - `strokeWidth` — border width in px, clamped to a sane band by the
   *    inspector. Omitted = 1px (the legacy border). */
  fill?: string
  strokeColor?: string
  strokeWidth?: number
  /** Shape-only: which primitive a `shape` element draws (round 5). A shape is
   *  a plain axis-aligned rectangle or ellipse that CONSUMES the same optional
   *  `fill` / `strokeColor` / `strokeWidth` fields above, plus `cornerRadius`
   *  (rect only) and `opacity` below — no new geometry beyond `width`/`height`.
   *  OPTIONAL and backward-compatible: omitted = 'rect', so a shape saved
   *  without the field renders as a rectangle (the default primitive). An
   *  ellipse just rounds its corners to 50% at render time; it ignores
   *  `cornerRadius`. */
  shapeKind?: 'rect' | 'ellipse'
  /** Transform for canvas elements (Selection Inspector + on-canvas handle,
   *  round 4). All OPTIONAL and backward-compatible: older saved canvases omit
   *  them and the views fall back to the built-in defaults (see
   *  `canvasTransform.ts`), so previously-saved Canvases render exactly as
   *  before.
   *  - `opacity`      — 0..1 multiplier applied to the element's rendered
   *    container. Omitted = 1 (fully opaque) = the legacy look. Surfaced in the
   *    inspector as a 0..100% slider/number.
   *  - `cornerRadius` — px radius for a FRAME's body corners (and any future
   *    rounded-rect type). Omitted = the legacy 4px (the old `rounded-[4px]`),
   *    so saved frames look identical. Clamped to a sane band by the inspector
   *    and additionally capped at half the smaller side at render time.
   *  (Per-object W/H size reuses the existing `width` / `height` fields above;
   *  round 4 only adds inspector inputs + proportional Shift-drag for them.) */
  opacity?: number
  cornerRadius?: number
  /** Layers panel: the user hid this element from the canvas (eye toggle). A
   *  hidden element is not painted and not hit-testable, but stays in the
   *  elements array so it keeps its z-order and can be un-hidden. OPTIONAL and
   *  backward-compatible: omitted / false = visible = the legacy behaviour, so
   *  previously-saved Canvases render exactly as before. */
  hidden?: boolean
  /** Mock- and Screen-only: which sandboxed renderer to use for `text`.
   *  'react'  → JSX/TSX, transformed in-browser, a default-export / `App`
   *             component is mounted.
   *  'html'   → plain HTML/CSS/JS, rendered as-is. */
  framework?: 'react' | 'html'
  /** Mock- and Screen-only: iframe 背景テーマ。'dark' で body 背景を暗色に切替。
   *  欠落 = 'light' = 従来挙動。 */
  theme?: 'light' | 'dark' | 'auto'
  /** Mock-only: short label shown in the element's chrome. */
  name?: string
  /** Containment / nesting: id of the *container* element this element is
   *  *inside* of (Figma-style membership). Set when the element's rect is
   *  dropped fully within a container's rect; cleared when dragged out of every
   *  container. Drives "moving a container moves its children" off persisted
   *  state instead of runtime centre-point detection, so membership survives a
   *  reload. OPTIONAL and backward-compatible: older saved canvases have no
   *  `parentId` and behave exactly as before (no membership).
   *
   *  Two container kinds (see `canContain` in canvasContainment.ts):
   *  - a `frame` may own any non-frame child (Slice 1); a frame never sets its
   *    own `parentId` (no self / nested-frame parenting in this slice);
   *  - a `mock` / `screen` ("a design") may own a `text` child — an annotation
   *    label placed on top of the rendered design that travels with it. */
  parentId?: string
  /** Comment-only: id of the canvas element this comment was dropped on top
   *  of. Used so the Run prompt can tell Claude exactly which element the
   *  comment refers to (e.g. a specific mockup). */
  anchorId?: string
  /** Comment-only: the user marked this comment as handled; rendered dim
   *  so the canvas isn't cluttered with stale pins. */
  resolved?: boolean
  /** Comment-only: id of the Canvas chat thread this comment's Run spawned.
   *  Links the pin to its conversation so the pin can show live run status +
   *  the latest reply, and the user can jump to that thread. Cleared if the
   *  linked chat is deleted. */
  chatId?: string
  /** Image-only: UUID v4 of the asset stored under
   *  `<project>/.openground/canvases/<canvasId>-assets/<assetId>.<ext>`.
   *  Resolved at render time by `<img src="/api/canvas/asset?...">`. */
  assetId?: string
  /** Image-only: original filename — used for tooltip / download label. */
  filename?: string
  /** Image-only: accessibility alt text (also fed back to Claude as context
   *  when a comment is anchored to the image). */
  alt?: string
  /** Image-only: intrinsic resolution captured at upload time. Lets the UI
   *  offer "fit to 100%" later without re-decoding the file. */
  naturalWidth?: number
  naturalHeight?: number
  /** Screen-only, LEGACY: identifier of the on-disk module the old build-time
   *  renderer loaded (`src/designs/<projectSlug>/<moduleId>.tsx`). Screens now
   *  render `text` as inline source via a sandboxed iframe (see
   *  `buildScreenSrcdoc`), so new screens omit this. Kept optional so a
   *  pre-migration screen still round-trips. */
  moduleId?: string
  /** Screen-only: label shown in the iframe's chrome strip. Falls back to
   *  `moduleId` when absent. */
  label?: string
  /** Screen-only: which mock browser/phone frame to draw around the iframe.
   *  'none' = bare iframe. Defaults to 'none' when absent. */
  chrome?: 'none' | 'browser' | 'phone'
  /** Screen-only: when true, the iframe wrapper allows internal scrolling.
   *  Defaults to false (overflow hidden, like a fixed-size screenshot). */
  scrollable?: boolean
  /** Screen-only: JSON-serializable props forwarded to the loaded module via
   *  query string. Strings, numbers, booleans, plain objects and arrays only. */
  props?: Record<string, unknown>
}

export type Tool =
  | 'select'
  | 'text'
  | 'sticky'
  | 'frame'
  | 'comment'
  | 'image'
  // Shape tools (round 5): each draws a `shape` element via click-drag, mapping
  // 1:1 to the element's `shapeKind` ('rect' | 'ellipse').
  | 'rect'
  | 'ellipse'

export interface CanvasState {
  positions: Record<string, CanvasPosition>
  viewport: {
    x: number
    y: number
    zoom: number
  }
  elements: CanvasElement[]
}

// Legacy single-Canvas state — kept only so the canvas-migration code in
// src/lib/server/canvasData.ts can still read .hove/ground.json files from
// pre-multi-canvas installs (the prior codename) and promote them to the
// new layout.
export interface LegacyCanvasState {
  viewport: {
    x: number
    y: number
    zoom: number
  }
  elements: CanvasElement[]
}

// One self-contained Canvas (the project-detail design tab): its drawing
// surface, its sidebar chat threads, and the sidebar UI state. Each Canvas
// is one file on disk at `<project>/.hove/canvases/<id>.json` — Hove's unit
// of design / brainstorm work, complementary to the Chats tab's code-oriented
// `tasks.json`.
export interface CanvasFile {
  id: string
  name: string
  viewport: {
    x: number
    y: number
    zoom: number
  }
  elements: CanvasElement[]
  /** Chat threads attached to this Canvas. Same ProjectTask shape as Chats
   *  so TaskThread / NewTaskComposer can render either source. */
  chats: ProjectTask[]
  /** Last selected chat in the sidebar — restored when the Canvas is reopened. */
  activeChatId: string | null
  sidebarOpen: boolean
  sidebarWidth: number | null
  createdAt: string
  updatedAt: string
}

// Lightweight index of a project's Canvases. Holds tab order and which Canvas
// was active last so reopening the Canvas tab restores the user's place.
export interface CanvasesIndex {
  order: string[]
  activeId: string | null
}

// Summary row for the Canvas tab bar — avoids loading every Canvas's full
// drawing surface just to render the tabs.
export interface CanvasSummary {
  id: string
  name: string
  updatedAt: string
}

export interface ProjectsResponse {
  settings: Settings
  projects: ProjectMeta[]
  canvas: CanvasState
  error?: string
}

/** A clipboard-pasted reference image attached to a task. */
export interface TaskImage {
  /** Unique id; also the on-disk filename stem under .hove/task-images/. */
  id: string
  /** Display name — an original filename, or "Pasted image". */
  name: string
  /** image/png, image/jpeg, image/gif or image/webp. */
  mime: string
  addedAt: string
}

/** A lightweight, persisted snapshot of a task's most recent run — the
 *  narrative half only. Phase 2: we persist this on the task so the card hero
 *  survives without re-deriving from full run sessions, and never store the
 *  conversation body itself (the claude JSONL transcript is referenced via
 *  `TranscriptRef`, not copied). `kind` mirrors the settled subset of
 *  `RunKind` (runStatus.ts) — the transient `queued/running/merging/conflict`
 *  states never reach a persisted summary. */
export interface TaskRunSummary {
  kind: 'done' | 'review' | 'skipped' | 'error' | 'overloaded' | 'cancelled'
  /** parsedResult.topic — short subject line, if Claude emitted one. */
  topic?: string
  summary: string
  blockers: string
  /** parsedResult.decisions — the "why / trade-off" layer of the Recap,
   *  persisted so it survives a reopened chat. */
  decisions?: string[]
  followups?: string[]
  question?: string
  taskComplete?: boolean
  /** The Claude Code session id this summary came from. */
  sessionId: string
  finishedAt: string
}

/** A pointer to the on-disk claude JSONL transcript for a run — lets the UI
 *  open the full conversation on demand without OPEN GROUND ever copying the
 *  body into its own store. */
export interface TranscriptRef {
  sessionId: string
  cwd: string
  jsonlPath: string
}

export interface ProjectTask {
  id: string
  title: string
  done: boolean
  milestoneId: string | null
  createdAt: string
  /** Clipboard-pasted reference images, stored under .hove/task-images/. */
  images?: TaskImage[]
  /** Canvas-only: the Claude Code skill to apply on the next send. Sticky on
   *  the chat so the picker's selection survives a reload, but the user can
   *  flip it before every send to compare designs. Null/undefined = no skill. */
  activeSkill?: string | null
  /** Phase 2: persisted snapshot of this task's most recent run narrative.
   *  Lets the card hero render without re-deriving from full run sessions. */
  latestRun?: TaskRunSummary
  /** Phase 2: the Claude Code session id to resume this task in context. */
  agentSessionId?: string
  /** Phase 2: pointer to the claude JSONL transcript for the latest run. */
  transcriptRef?: TranscriptRef
  /** Board tab: which kanban column this task sits in. Undefined = treated as
   *  'todo' (back-compat for tasks created before the Board existed). The
   *  board-run loop and the run lifecycle move it doing→done/blocked; the user
   *  can also drag it anywhere. */
  boardColumn?: BoardColumn
  /** Board tab: sort key WITHIN a column (ascending = higher priority / top).
   *  Independent of the tasks[] array order so dragging on the board doesn't
   *  scramble the Chats list. Undefined sorts after ordered cards by createdAt. */
  boardOrder?: number
}

/** Kanban columns for the Board tab. 'todo'=未着手 / 'doing'=実行中 /
 *  'done'=完了 / 'blocked'=ブロック. */
export type BoardColumn = 'todo' | 'doing' | 'done' | 'blocked'

/** A Claude Code skill discovered on disk — feeds the Canvas chat's
 *  skill picker. Sources: `~/.claude/skills/<name>` (user) and
 *  `<project>/.claude/skills/<name>` (project). */
export interface SkillInfo {
  /** Folder name — the unique id used everywhere (prompt injection, picker state). */
  name: string
  /** Friendly Japanese display label for the picker. Falls back to `name`
   *  when missing (e.g. non-curated discovery). */
  label?: string
  /** Short Japanese one-liner shown in the picker card. Curated mode
   *  replaces this with editorial copy; otherwise it's the first non-empty
   *  line of the skill's frontmatter description. */
  description: string
  source: 'user' | 'project'
}

export interface ProjectMilestone {
  id: string
  name: string
  dueDate: string | null
  createdAt: string
  // ---- Phase 6 (Tasks tab) extensions — all optional for backward compat ----
  /** Parent Goal id. Null/absent for legacy free-floating milestones. */
  goalId?: string | null
  /** Free-form expanded description. */
  description?: string
  /** Position within the parent Goal (0-based). */
  order?: number
  /** Shell commands that determine completion. All must exit 0 to "pass".
   *  Run via `/bin/sh -c <cmd>` with cwd = project root (or worktree path
   *  when triggered from a milestone run). */
  verifyCommands?: string[]
  /** Lifecycle state. Driven by run + verify outcomes. */
  status?:
    | 'pending'
    | 'in_progress'
    | 'verifying'
    | 'verified'
    | 'failed'
    | 'blocked'
  /** Set when status transitions to 'verified'. */
  verifiedAt?: string
  /** Result of the most recent verify pass. */
  lastVerify?: {
    passed: boolean
    commands: string[]
    /** stdout+stderr tails (≤ 4 KB) per command. Full log lives at
     *  `.openground/verify-logs/<milestoneId>-<timestamp>.txt`. */
    outputs: string[]
    finishedAt: string
    retryCount: number
  }
  /** The Claude session id that last ran this milestone — lets the UI link
   *  back to the chat round that produced the current state. */
  lastRunSessionId?: string
}

/** A user-defined Goal — the container for a set of Milestones that
 *  collectively reach a single observable completion condition.
 *
 *  Goal fields follow an industry-standard composition:
 *    - title              :  short noun phrase, "what" (SMART: Specific)
 *    - description (Why)  :  motivation / context (OKR: Objective rationale)
 *    - outcome            :  the state of the world when achieved (SMART: Relevant)
 *    - completionCriteria :  legacy free-form text (kept for back-compat;
 *                            new Goals should prefer `acceptanceCriteria`)
 *    - acceptanceCriteria :  observable checks, each one independently
 *                            verifiable (INVEST: Testable, agile AC pattern)
 *    - outOfScope         :  things deliberately NOT done — scope-creep guard
 *
 *  Phase 6 (Tasks tab) uses this structure both in the UI (sectioned editor)
 *  and in the milestone plan prompt (Claude reads `acceptanceCriteria` /
 *  `outOfScope` to suggest sharper milestones + verify commands). */
export interface Goal {
  id: string
  title: string
  /** Legacy "description" — now used as the **Why / Context** section
   *  (kept named `description` for backward compatibility with existing
   *  tasks.json files written by 6.A). */
  description: string
  /** SMART-style completion narrative — kept for back-compat. Newer Goals
   *  break this down into `acceptanceCriteria` line items instead. */
  completionCriteria: string
  /** What is true about the world when this Goal is done. One or two
   *  sentences. "ユーザーが email/password でログインでき、画面遷移を跨いで
   *  ログイン状態が維持される" のように、出来上がった状態を書く。 */
  outcome?: string
  /** Observable acceptance criteria — each line is independently testable.
   *  Encouraged form: "Given <state>, When <action>, Then <observable>".
   *  The milestone plan prompt asks Claude to map these to concrete
   *  verifyCommands (shell exit-code checks). */
  acceptanceCriteria?: string[]
  /** Explicitly excluded scope. Things that look related but the Goal
   *  does NOT include — defending against scope creep and giving Claude
   *  a clearer boundary. */
  outOfScope?: string[]
  status: 'draft' | 'planning' | 'running' | 'blocked' | 'done'
  createdAt: string
  updatedAt: string
  /** Server-side sequential run queue for this Goal. Populated when the
   *  user hits "Run All" — the runner uses it to auto-kick the next
   *  milestone after each auto-verify, so progress survives dev-server
   *  restarts and frontend disconnects. Optional: Goals authored before
   *  Phase 7 don't have it, and Goals that have never been queued won't
   *  either (we don't fabricate an empty queue at write time). */
  runQueue?: GoalRunQueue
}

/** Sequential milestone runner state, persisted on the Goal so the UI can
 *  resume after a crash. `idle` = no queue active; `running` = a milestone
 *  is in flight (or about to be kicked); `paused` = user hit pause or
 *  startup sweep found a stranded queue; `failed` = a verify came back
 *  false and the queue stopped waiting for the user to fix things;
 *  `completed` = every milestone in the list verified. */
export interface GoalRunQueue {
  milestoneIds: string[]
  /** Index into milestoneIds of the *current* milestone — the one being
   *  worked on (or about to be kicked). When all milestones are done this
   *  equals milestoneIds.length. */
  currentIndex: number
  status: 'idle' | 'running' | 'paused' | 'completed' | 'failed'
  startedAt?: string
  lastActivityAt?: string
  /** Recorded outcome per milestone — populated as each run settles.
   *  Aligned with milestoneIds by `milestoneId`. `result: 'verified'` is
   *  the only one that advances currentIndex; the others halt the queue. */
  sessions?: Array<{
    milestoneId: string
    sessionId: string
    result: 'verified' | 'failed' | 'cancelled'
    finishedAt: string
  }>
}

export interface ProjectData {
  description: string
  tasks: ProjectTask[]
  milestones: ProjectMilestone[]
  /** Phase 6: user-defined Goals that own Milestones. Optional so legacy
   *  tasks.json files without this field continue to load. */
  goals?: Goal[]
  notes: string
  updatedAt: string
}

export interface ParsedRunResult {
  completed: string[]
  skipped: string[]
  summary: string
  blockers: string
  /** Key decisions made this turn and *why* — the "judgment / trade-off" layer
   *  of the structured Recap that a diff can't convey (e.g. "froze the value via
   *  a ref, not state, to avoid a re-render race"). One sentence per item; empty
   *  for trivial turns. Optional — older runs lack it. */
  decisions?: string[]
  /** Concrete next-step work the run recommends. Optional — older runs lack it. */
  followups?: string[]
  /** Whether the task itself is fully done — drives the auto-continue loop. */
  taskComplete?: boolean
  /** Claude wants the user to answer before proceeding. When set, the UI shows
   *  the question and the auto-loop pauses — the run is "awaiting reply." */
  question?: string
  /** Short headline (~15-25 全角 chars, no trailing punctuation) for THIS round
   *  of the conversation. Used as the chat sidebar row label — the most recent
   *  run's topic represents what the thread is currently about. */
  topic?: string
}

export interface RunGitInfo {
  headBefore: string | null
  headAfter: string | null
  changedFiles: string[]
  diffStat: string
  commits: string[]
}

export interface TargetedTask {
  id: string
  title: string
  milestoneName: string | null
}

/** Which Claude Code permission mode this run used.
 *  - `bypass`: --dangerously-skip-permissions (the default — same as before).
 *  - `plan`:   --permission-mode plan; Claude can read but won't edit. */
export type PermissionMode = 'bypass' | 'plan'

/** Threaded into a Run when the user kicked it off from a Canvas chat
 *  (vs the plain Chats tab). Tells the runner / prompt builder which
 *  Canvas to surface to Claude, and lets the observer route Claude's
 *  `CANVAS_ADD: {...}` markers into that exact Canvas file. Absent for
 *  ordinary Chats-tab runs — that path stays untouched. */
export interface CanvasContext {
  /** The Canvas the chat lives in. Maps to .openground/canvases/<id>.json. */
  canvasId: string
  /** Optional name (e.g. "Ground", "ハフィング") for the prompt to mention. */
  canvasName?: string
}

export interface RunEntry {
  projectId: string
  projectName: string
  projectPath: string
  status: 'pending' | 'running' | 'done' | 'error' | 'cancelled'
  exitCode?: number
  startedAt?: string
  finishedAt?: string
  log: string
  targetedTasks: TargetedTask[]
  git?: RunGitInfo
  parsedResult?: ParsedRunResult | null
  feedback?: string
  /** The Claude Code session id — resume it to continue this task in context. */
  agentSessionId?: string
  /** Auto-continue round (1-based) when this run is part of an auto-loop. */
  autoRound?: number
  /** Set when this entry ran in a git worktree for parallel isolation. */
  worktreePath?: string
  /** Lifecycle of the post-run worktree merge back to the main branch. */
  /** Lifecycle of the post-run worktree merge back to the main branch.
   *  - `merging`     — `git merge` running
   *  - `merged`      — clean merge, worktree removed
   *  - `conflict`    — merge stopped on conflicts; resolveConflict / dismissConflict can clear it
   *  - `failed-fatal`— both `merge` and `merge --abort` failed (e.g. git index lock).
   *    Manual intervention required: the user opens the worktree in their editor.
   *    Plan v2.3 §5 / SHOULD #2. */
  mergeStatus?: 'merging' | 'merged' | 'conflict' | 'failed-fatal'
  /** Permission mode this run was spawned with — defaults to bypass. */
  permissionMode?: PermissionMode
  /** Anthropic API returned 529 Overloaded — surfaces as its own UI state so
   *  the user can tell this is a server-side congestion issue, not an
   *  OPEN GROUND or prompt bug. Set in the stderr handler. */
  overloaded?: boolean
  /** True when the run was started as `resumeFrom: <id>` but the Claude
   *  session file wasn't reachable (e.g. it lived in a worktree that's gone),
   *  so OPEN GROUND silently fell back to a fresh run. UI surfaces this so
   *  the user sees "the continue didn't actually continue" instead of
   *  thinking Claude lost context. */
  resumeFallback?: boolean
  /** Phase 6: when this run was kicked off to advance a specific Milestone
   *  (via /api/project/milestones/run), this carries that milestone's id so
   *  the runner can fire its verify pass on completion and the auto-loop can
   *  switch to "verify-based" completion judging. */
  milestoneId?: string
  /** Phase 6: outcome of the external shell verify pass that runs at the end
   *  of a milestone-bound entry. When `passed: true`, the auto-loop treats
   *  the milestone as truly complete regardless of Claude's self-reported
   *  `taskComplete`. When false, auto-loop retries (up to AUTO_MAX_ROUNDS)
   *  feeding the failure output back to Claude. */
  verifiedTaskComplete?: {
    passed: boolean
    commands: string[]
    /** stdout+stderr tails (≤ 4 KB each) per verify command. */
    outputs: string[]
    finishedAt: string
    retryCount: number
  }
  /** Claude's narrative stream — assistant text + thinking blocks, oldest
   *  first. Tool calls, tool results and system lines are NOT included; those
   *  stay in `log`. Lets the live UI surface what Claude is *thinking* without
   *  the user having to open the full log. */
  thoughts?: Array<{ at: string; text: string }>
  /** Claude's action stream — one entry per tool_use the assistant made,
   *  oldest first. Lets the live UI surface what Claude is *doing*
   *  ("Editing src/auth.ts") alongside what it's thinking, so the user
   *  can follow a run without opening the raw terminal. */
  actions?: Array<{ at: string; tool: string; detail: string }>

  /** PTY id hosting the interactive `claude` session for this run.
   *  Populated when the run is launched; lets the UI mount an xterm.js view
   *  on the same PTY and the cancel path send Ctrl-C to it. */
  terminalId?: string
}

export interface RunSession {
  id: string
  startedAt: string
  finishedAt?: string
  entries: RunEntry[]
}

// ---- Auth (optional Google/GitHub login via Supabase Auth) ----------------
// These describe the APP's OWN account — NOT the Claude CLI subscription. The
// login is entirely optional and gates nothing today; it exists as the single
// seam a future billing / entitlement check will read (see docs/BILLING_PLAN.md
// and src/lib/auth/AuthContext.tsx). Tokens never cross the wire to the client:
// the loopback Hono server persists them to ~/.openground/auth.json and the SPA
// only ever sees the public AuthUser fields below.

/** OAuth provider we support. Mirrors the providers enabled in the Supabase
 *  dashboard (see docs/AUTH_SETUP.md). */
export type AuthProvider = 'google' | 'github'

/** The public, client-safe shape of a signed-in app account. Derived
 *  server-side from the Supabase user object; never carries any token. */
export interface AuthUser {
  id: string
  email?: string
  name?: string
  avatarUrl?: string
  provider: AuthProvider
}

/** A persisted session (server-side-only contract for auth.json). `expiresAt`
 *  is an epoch-ms timestamp the server uses to decide when to refresh. */
export interface Session {
  user: AuthUser
  expiresAt: number
}

/** GET /api/auth/config — gates the UI exactly like /api/feedback/config:
 *  reports only a boolean, never the URL or key. */
export interface AuthConfigResponse {
  enabled: boolean
}

/** GET /api/auth/session — the only auth payload the SPA reads. `user` is null
 *  when signed out (or the env is unconfigured); tokens are never returned. */
export interface AuthSessionResponse {
  user: AuthUser | null
}

/** Slim per-project run status, for the canvas card indicators. */
export interface RunStatusInfo {
  status: RunEntry['status']
  startedAt?: string
  finishedAt?: string
}

/** The narrative half of a project's most recent finished run — what the card
 *  shows when the user flips the hero from description to run summary. */
export interface RunSummaryInfo {
  /** Display classifier — drives colour, glyph and the "done/review/error" label. */
  kind: 'done' | 'review' | 'skipped' | 'error' | 'overloaded' | 'cancelled'
  taskTitle: string
  /** parsedResult.summary — may be empty if the run produced no summary line. */
  summary: string
  /** parsedResult.blockers — non-empty means the run hit a wall worth surfacing. */
  blockers: string
  /** Follow-up suggestions the run captured. */
  followups: string[]
  /** Claude is asking the user to decide before continuing. Non-empty wins
   *  over blockers/summary on the card hero so the question gets seen. */
  question?: string
  finishedAt?: string
}

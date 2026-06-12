export interface OpenApp {
  name: string
  /** Bundle path (e.g. /Applications/Cursor.app) — needed for cwd-mode launch. */
  path?: string
  /** `open`: `open -a name folder` (editors, Terminal.app, iTerm, Warp…).
   *  `cwd`: spawn the .app's binary with cwd set to the folder (Alacritty,
   *  kitty, alacritty-style pure terminals that won't accept a folder doc). */
  mode?: 'open' | 'cwd'
}

/** One registered project. The registry (`Settings.projects`) is a
 *  user-curated allowlist of arbitrary folder paths — projects are added one at
 *  a time via "Create new" or "Import existing folder", NOT discovered by
 *  scanning a single root. `id` is a stable UUID assigned at registration so a
 *  card's identity (and its canvas position) survives rename/move. `path` is
 *  stored canonicalized (symlinks resolved) so the security-boundary comparison
 *  in validateProjectPath is symmetric. */
export interface ProjectEntry {
  id: string
  path: string
  addedAt: string
  description?: string
}

export interface Settings {
  /** The project registry — see {@link ProjectEntry}. Optional for back-compat
   *  parse of pre-registry settings.json; populated (possibly empty) once
   *  `ensureProjectsMigrated` has run. */
  projects?: ProjectEntry[]
  /** Parent directory new "Create new project" folders are created under.
   *  Chosen once via the native picker on first create, then remembered. */
  defaultWorkspace?: string | null
  /** Sentinel: set once the one-shot migration from the legacy single-root
   *  model has run. Idempotency keys off THIS (not `projects.length`), so a user
   *  who later removes every project is never re-scanned from the old root. */
  projectsMigratedAt?: string
  /** @deprecated Legacy single-root model. Kept only so back-compat parse +
   *  the one-shot migration scan can still read it. No longer auto-scanned. */
  projectsRoot: string | null
  /** @deprecated Archive feature removed; kept for back-compat parse + the
   *  migration scan's `_archive/*` enumeration. */
  archiveDirName: string
  /** @deprecated Only the one-shot migration scan still applies these. */
  excludePatterns: string[]
  /** Apps registered by the user for the project panel's "Open in" menu.
   *  The first item is the default (one-click Open). Stored as objects so a
   *  pure terminal (Alacritty etc., mode: 'cwd') and a folder-accepting GUI
   *  app (mode: 'open') can be launched the right way. Strings from older
   *  saves are normalised on read. */
  openApps?: OpenApp[]
  /** The user's display name, used as the default assignee identity on shared
   *  boards ("my cards" filter). Default suggestion: `git config user.name`. */
  displayName?: string
  /** UI + prompt language. OPEN GROUND is English-first: unset means English.
   *  'ja' switches the UI strings AND the prompts sent to the spawned Claude
   *  (so its summaries/replies come back in Japanese). Persisted from the UI
   *  language toggle so the server can pick the matching prompt language. */
  language?: 'en' | 'ja'
}

/** GET /api/settings response: the persisted {@link Settings} plus a
 *  NON-persisted display-name suggestion (`git config --global user.name`,
 *  null when git is missing or user.name is unset). The client shows it only
 *  as the input placeholder — it is never written into settings.json. */
export type SettingsResponse = Settings & { suggestedDisplayName: string | null }

/** One published release of the distribution repo (GET /api/release-notes).
 *  `body` is the release's markdown notes, written with `### English` /
 *  `### 日本語` sections — the client shows the section matching the UI
 *  language (src/lib/releaseNotesLang.ts). */
export interface ReleaseNote {
  version: string
  url: string
  publishedAt: string
  body: string
}

/** GET /api/release-notes response: published (non-draft) releases, newest
 *  first, plus the running app's own version so the client can mark it. */
export interface ReleaseNotesResponse {
  current: string
  releases: ReleaseNote[]
  error?: string
}

/** POST /api/canvas/generate-elements — the "design as elements" path: claude
 *  authors NATIVE canvas elements (frame/shape/text/sticky), not code, so the
 *  result is hand-tweakable piece by piece (Figma-lite). Positions in the
 *  returned elements are relative to (0,0); the client offsets them to the
 *  current viewport center before inserting. */
export interface GenerateElementsRequest {
  path: string
  prompt: string
}
export interface GenerateElementsResponse {
  elements: CanvasElement[]
}

/** POST /api/canvas/tweak-screen — patch ONE screen/mock's source per an
 *  instruction aimed at a picked element inside its rendered iframe (the
 *  canvasInspect postMessage bridge supplies `element`). Returns the FULL
 *  rewritten source; the client swaps element.text and the iframe re-renders. */
export interface TweakScreenRequest {
  path: string
  source: string
  framework: 'react' | 'html'
  instruction: string
  /** The picked element, as the bridge reported it. `html` is a truncated
   *  outerHTML snippet — enough for claude to locate the node in source. */
  element: { tag: string; classes: string; text: string; html: string }
}
export interface TweakScreenResponse {
  source: string
  /** True when claude judged the instruction already satisfied — the source
   *  is returned verbatim and the client shows "no change was needed". */
  unchanged?: boolean
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
  description: string
  lastModified: string
  /** The registered folder no longer exists on disk (moved/deleted out of
   *  band). The card renders in a degraded state and offers "Remove from
   *  canvas"; Run / Open-in-editor are disabled. */
  missing?: boolean
  hasGit: boolean
  openTaskCount: number
  totalTaskCount: number
}

export interface CanvasPosition {
  x: number
  y: number
}

/** Frame auto layout settings (Figma-style). Lives on a `frame` element's
 *  optional `layout` field; the actual stacking is computed by the pure engine
 *  in `src/lib/canvasAutoLayout.ts`.
 *  - `mode`    — main axis: 'row' stacks the children left→right, 'column'
 *    top→bottom.
 *  - `gap`     — px between consecutive children along the main axis.
 *  - `padding` — px inset from the frame's edges (all four sides).
 *  - `align`   — cross-axis placement of each child inside the padded box
 *    ('start' | 'center' | 'end'). */
export interface FrameLayout {
  mode: 'row' | 'column'
  gap: number
  padding: number
  align: 'start' | 'center' | 'end'
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
  type: 'text' | 'sticky' | 'frame' | 'mock' | 'comment' | 'image' | 'screen' | 'shape' | 'group'
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
  // ── Figma-parity layer transforms — ALL OPTIONAL, backward-compatible ──
  /** Rotation in degrees, clockwise, about the element's centre. Applied as a
   *  CSS `rotate()` at render time; geometry (x/y/width/height) stays the
   *  axis-aligned local box, exactly like Figma. Omitted/0 = the legacy look. */
  rotation?: number
  /** CSS mix-blend-mode for the element's container (Figma-style blending with
   *  what's behind it). Omitted/'normal' = the legacy opaque compositing. */
  blendMode?:
    | 'normal'
    | 'multiply'
    | 'screen'
    | 'overlay'
    | 'darken'
    | 'lighten'
    | 'color-dodge'
    | 'color-burn'
    | 'hard-light'
    | 'soft-light'
    | 'difference'
    | 'exclusion'
    | 'hue'
    | 'saturation'
    | 'color'
    | 'luminosity'
  /** Layers panel: the element is LOCKED — still painted, but not selectable,
   *  draggable, or resizable on the canvas (clicks fall through to whatever is
   *  behind it). Toggle via the Layers panel / inspector lock icon. Omitted/
   *  false = unlocked = the legacy behaviour. */
  locked?: boolean
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
   *  - a `frame` may own ANY child, including another `frame` (Figma-style
   *    nesting); a frame can itself carry a `parentId` pointing at the frame it
   *    nests inside. Cycles are prevented by excluding a frame's own descendants
   *    as candidate parents (see `descendantIds`);
   *  - a `mock` / `screen` ("a design") may own a `text` child — an annotation
   *    label placed on top of the rendered design that travels with it. */
  parentId?: string
  /** Frame-only: auto layout (Figma-style). When set, the frame's direct
   *  children (parentId === this frame's id) are stacked automatically by
   *  src/lib/canvasAutoLayout.ts — manual child positions are overridden on
   *  every elements mutation. Absent = free-form frame (default). */
  layout?: FrameLayout
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

// One self-contained Canvas (the project-detail design tab): its drawing
// surface, its sidebar chat threads, and the sidebar UI state. Each Canvas is
// one file in the project's central data dir at
// `~/.openground/projects/<uuid>/canvases/<id>.json` — OPEN GROUND's unit of
// design / brainstorm work, complementary to the Chats tab's code-oriented
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
}

/** Response of GET /api/project/branches — the project's LOCAL git branches,
 *  current first then alphabetical. Feeds the Settings "Target branch" select;
 *  a non-repo (or any git failure) yields { branches: [], current: null }. */
export interface ProjectBranchesResponse {
  branches: string[]
  /** Checked-out branch, or null (detached HEAD / not a git repo). */
  current: string | null
}

/** Verdict of POST /api/project/merged-branches for one branch (B018/F065):
 *  - 'merged'  — the branch tip is an ancestor of the target branch.
 *  - 'open'    — the tip exists but is NOT merged into the target yet.
 *  - 'unknown' — no judgment possible (tip/target ref not found, invalid
 *    name, not a git repo) — the UI shows nothing rather than guessing. */
export type MergedBranchStatus = 'merged' | 'open' | 'unknown'

/** POST /api/project/merged-branches request. `branches` is capped at 50 per
 *  call (a Review column never legitimately holds more). `targetBranch`
 *  (the project's shared config) overrides the origin/HEAD → 'main' default. */
export interface MergedBranchesRequest {
  path: string
  branches: string[]
  targetBranch?: string
}

/** POST /api/project/merged-branches response: a verdict per REQUESTED branch
 *  name (every input key is present; unjudgeable ones are 'unknown'). */
export type MergedBranchesResponse = Record<string, MergedBranchStatus>

/** GitHub PR lifecycle state as `gh pr view --json state` reports it. */
export type PrState = 'OPEN' | 'MERGED' | 'CLOSED'

/** POST /api/project/pr-info { path, prUrl } → PR state + diff stats for the
 *  drawer's status strip (B023, F058/F085). `available: false` covers EVERY
 *  failure mode — gh missing/unauthenticated, malformed prUrl, network, 404 —
 *  so a gh-less environment shows nothing instead of an error. */
export type PrInfoResponse =
  | { available: false }
  | {
      available: true
      state: PrState
      title: string
      additions: number
      deletions: number
      isDraft: boolean
    }

/** One worktree under the project's CENTRAL worktrees dir
 *  (~/.openground/projects/<uuid>/worktrees/) — task/* and review-* checkouts.
 *  GET /api/project/worktrees → { worktrees: ProjectWorktreeInfo[] }. */
export interface ProjectWorktreeInfo {
  /** Canonical absolute path of the worktree dir. */
  dir: string
  /** Short branch name, or null (detached HEAD). */
  branch: string | null
  /** Uncommitted changes present (staged/unstaged/untracked) — never removed
   *  by the cleaner. */
  dirty: boolean
}

/** POST /api/project/worktrees/clean — which central worktrees were removed
 *  and which were kept because they hold uncommitted work. */
export interface CleanWorktreesResult {
  removed: string[]
  skippedDirty: string[]
}

/** An image attached to a Board card (B022 — bug screenshots etc). No path is
 *  stored: `id` is the content-addressed file name (`<sha1>.<ext>`) inside the
 *  project's task-asset store (central task-assets/ or, git-shared,
 *  .openground/board/assets/) — see src/lib/server/taskAssets.ts. */
export interface TaskAttachment {
  /** Asset id = file name: 40 hex sha1 of the bytes + image extension. */
  id: string
  /** Original file name, display-only (tooltip); never used as a path. */
  name: string
  mime: string
}

/** A task is a Board card — the only task kind that exists. (The old
 *  'chat'/'assistant' kinds are gone; legacy items of those kinds are silently
 *  dropped on read — see readProjectData.) */
export interface ProjectTask {
  id: string
  title: string
  /** Board plan notes — free text for the card, independent of the chat thread.
   *  Editable in the Board's in-tab detail drawer. */
  notes?: string
  done: boolean
  createdAt: string
  /** Board tab: which kanban column this task sits in. Undefined = treated as
   *  'todo' (back-compat for tasks created before the Board existed). The user
   *  moves it by dragging the card. */
  boardColumn?: BoardColumn
  /** Display name of whoever owns this card (free string; teams pick their own
   *  names — the default suggestion is `git config user.name`). Shared data. */
  assignee?: string
  /** Board tab: sort key WITHIN a column (ascending = higher priority / top).
   *  Independent of the tasks[] array order so dragging on the board doesn't
   *  scramble the Chats list. Undefined sorts after ordered cards by createdAt. */
  boardOrder?: number
  /** The pull request opened for this task (completionFlow 'pr'): claude
   *  records it via POST /api/project/tasks {setPrUrl} when it opens the PR.
   *  Rendered as a link on the card and in the detail drawer. Shared data. */
  prUrl?: string
  /** The task branch claude created for this card: recorded via POST
   *  /api/project/tasks {setBranch} right after `git worktree add`. Shown in
   *  the drawer's session status strip. Shared data. */
  branch?: string
  /** Display name of the teammate who marked this card reviewed (review
   *  column). Cleared automatically when the card moves back to an active
   *  column (todo/doing/blocked) — a rework round invalidates the stamp.
   *  Shared data. */
  reviewedBy?: string
  /** True while the title is machine-derived (first line of the content, then
   *  the haiku summary) and the user hasn't edited it. A manual title edit
   *  clears it, which also stops any in-flight auto-title from landing. */
  titleAuto?: boolean
  /** Image attachments (screenshots) — see {@link TaskAttachment}. Shared
   *  data: the ids travel with the card, the bytes via the asset store. */
  attachments?: TaskAttachment[]
  /** Ids of cards that should land before this one (B025). Pure information —
   *  nothing blocks on it. Ids pointing at deleted cards are skipped at
   *  render time but kept in the data. Shared data. */
  dependsOn?: string[]
  /** Soft deadline, 'YYYY-MM-DD' in the user's local time (B026). Rendered as
   *  a small chip on the card — today or earlier shows in the accent color.
   *  No sorting, no notifications. Shared data. */
  dueDate?: string
  /** Per-card run settings — see {@link TaskRunSettings}. Every key is an
   *  optional override of the board's defaults; an absent key inherits live
   *  (resolved at 実行 time, not frozen at edit time). Shared data. */
  run?: TaskRunSettings
}

/** Claude CLI effort levels (`claude --effort <level>`). */
export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const CLAUDE_EFFORTS: readonly ClaudeEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

/** Per-card overrides for the drawer's 実行 button. Each key falls back to
 *  the board defaults when absent: flow → config.completionFlow,
 *  model/effort → launch.model/effort. Travels with the card (shared data)
 *  so a teammate sees how a card is meant to run. */
export interface TaskRunSettings {
  /** Completion flow override for THIS card ('merge' | 'pr'). */
  flow?: 'merge' | 'pr'
  /** Model alias override for THIS card (e.g. 'fable', 'opus'). */
  model?: string
  /** Effort override for THIS card. */
  effort?: ClaudeEffort
}

/** Kanban columns for the Board tab. 'todo'=未着手 / 'doing'=実行中 /
 *  'done'=完了 / 'blocked'=ブロック. */
/** 'review' is the optional fifth column (PR-waiting) — rendered only when
 *  the project's config.reviewColumn is on; cards parked there while hidden
 *  are treated as 'doing' by the UI. */
export type BoardColumn = 'todo' | 'doing' | 'review' | 'done' | 'blocked'

/** Shared per-project policy (travels with the board: marker in git-shared
 *  mode, tasks.json centrally) — both collaborators see the same values. */
export interface ProjectConfig {
  /** What a finished task does: merge straight into targetBranch, or open a
   *  PR with `gh pr create`. Injected into the task launch prompt. */
  completionFlow?: 'merge' | 'pr'
  /** Merge/PR base. Empty = the branch checked out at launch time. */
  targetBranch?: string
  /** "Definition of done" — commands claude must run and pass before
   *  declaring a task complete (one per entry, e.g. "npm test"). */
  verifyCommands?: string[]
  /** Show the レビュー待ち column (between doing and done). */
  reviewColumn?: boolean
  /** Registered member names for the assignee picker — register once in
   *  project settings instead of retyping names on every card. Shared, so
   *  the whole team sees the same list. */
  members?: string[]
}

/** PERSONAL launch preferences (my trust level / model budget ≠ my
 *  teammate's) — stored centrally in both modes, never in the repo. */
export interface ProjectLaunchPrefs {
  /** Claude permission mode for task launches (default: 'default'). */
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypass'
  /** Model alias passed to `claude --model` (empty = CLI default). */
  model?: string
  /** Effort level passed to `claude --effort` (empty = CLI default). */
  effort?: ClaudeEffort
  /** Auto-sync the shared Board/Canvas data in the background (adaptive
   *  fetch + debounced push). Default ON for shared projects; personal —
   *  one teammate opting out never affects the others. */
  autoSync?: boolean
}

export interface ProjectData {
  /** Active-language copy, kept for back-compat (legacy data, share marker,
   *  anything that only knows one string). When the language-specific pair
   *  below exists, display code prefers it via descriptionForLang(). */
  description: string
  /** Generated language pair — one claude run produces both, the UI shows the
   *  one matching the user's language setting. Optional: hand-written or
   *  legacy descriptions live only in `description`. */
  descriptionJa?: string
  descriptionEn?: string
  tasks: ProjectTask[]
  /** Per-project tab ("Ground") order — the user's drag-to-reorder result,
   *  left-to-right. A list of ModuleId strings. Optional so legacy files load;
   *  normalised against the live module registry on read (unknown ids dropped,
   *  missing enabled modules appended) — see effectiveTabOrder. */
  tabOrder?: string[]
  /** Shared project policy — see {@link ProjectConfig}. */
  config?: ProjectConfig
  /** Personal launch preferences — see {@link ProjectLaunchPrefs}. Central
   *  in both modes (composed like tabOrder). */
  launch?: ProjectLaunchPrefs
  notes: string
  updatedAt: string
}

/** Response of POST /api/project/describe — the auto-generated, NOT-yet-saved
 *  one-liner. The UI prefills `description` into the editor for review. On
 *  failure the route returns `{ error }` (500) or `{ error, claudeMissing }`
 *  (503 when the local `claude` CLI is absent). */
export interface DescribeProjectResponse {
  /** Active-language copy (matches the current language setting). */
  description: string
  descriptionJa?: string
  descriptionEn?: string
}

/** Optional body extension of POST /api/project/share/enable: seeds the
 *  shared policy (a subset of {@link ProjectConfig}) before the migration
 *  carries it into the marker — the ShareStartDialog sends the user-confirmed
 *  workflow + members with the enable itself. Server-validated: exactly these
 *  keys, 400 on anything else. Omitted body.config = legacy behaviour. */
export interface ShareEnableConfig {
  completionFlow?: 'merge' | 'pr'
  /** Empty string = explicitly clear any saved target branch (the route
   *  drops the key from the merged config); absent = leave it untouched. */
  targetBranch?: string
  members?: string[]
}

/** GET /api/project/share/status — where a project's Board/Canvas data lives
 *  and whether the repo copy has unsynced local changes. See
 *  docs/SHARED_DATA_PLAN.md. */
export interface ShareStatus {
  /** `.openground/openground.json` marker present → data lives in the repo. */
  shared: boolean
  /** The project folder is inside a git work tree (precondition for enable). */
  gitRepo: boolean
  /** `git remote get-url origin`, or null when no remote is configured. */
  remoteUrl: string | null
  /** `git status --porcelain -- .openground/` is non-empty (always false when
   *  not shared). Drives the dot on the Sync button. */
  dirty: boolean
  /** Commits touching .openground/ that exist locally but not upstream
   *  (unpushed syncs). 0 when not shared / no upstream. */
  ahead: number
  /** Commits touching .openground/ that exist upstream but not locally —
   *  a teammate pushed; Sync will pull them. Backed by a throttled
   *  `git fetch` inside the status call. 0 when not shared / no upstream. */
  behind: number
  /** An upstream tracking branch is configured for the checked-out branch.
   *  False until the first successful publish (`push -u`): without it the
   *  ahead/behind counts degrade to 0, so "published" decisions must check
   *  this flag, never just `ahead === 0`. */
  upstream: boolean
  /** The last fetch saw the upstream rewritten ("(forced update)") — someone
   *  force-pushed. Present only when true; cleared by the next clean fetch. */
  forcedUpdate?: boolean
  /** Checked-out branch name (shared data follows the branch — S27). Absent
   *  when not a git repo or on a detached HEAD. */
  branch?: string
  /** Auto-sync engine snapshot (present when the project is shared). The
   *  status route composes it from shareAutoSync — gitShare stays pure. */
  auto?: ShareAutoStatus
}

/** Live state of the per-project auto-sync engine ("Notion-feel on git
 *  bones"): adaptive background fetch, apply-on-behind, debounced push of
 *  shared-data edits — with code as sacred ground (any non-.openground
 *  commit ahead suspends ALL automatic git operations).
 *  - 'live'         idle and in sync; background fetch is watching
 *  - 'syncing'      a sync round is running right now
 *  - 'paused-code'  the user's own code commits are ahead — nothing moves
 *                   automatically until THEY push (manual Sync still works)
 *  - 'conflict'     the last auto sync hit a shared-data conflict; waiting
 *                   for the user to resolve (dialog via the Sync button)
 *  - 'offline'      the remote is unreachable; retrying on the backoff
 *  - 'blocked'      repo busy (user's rebase/merge/detached HEAD)
 *  - 'error'        a loud failure (e.g. autostash restore conflict)
 *  - 'disabled'     the personal autoSync pref is off */
export interface ShareAutoStatus {
  enabled: boolean
  mode:
    | 'live'
    | 'syncing'
    | 'paused-code'
    | 'conflict'
    | 'offline'
    | 'blocked'
    | 'error'
    | 'disabled'
  /** Last successful auto/manual sync (ms epoch), null before the first. */
  lastSyncAt: number | null
  /** A shared-data edit is waiting for the debounced auto push. */
  pendingPush: boolean
  /** Current adaptive fetch interval (ms) — surfaced for transparency/tests. */
  intervalMs: number
  /** Human detail for error-ish modes (raw English; UI maps known shapes). */
  message?: string
}

/** POST /api/project/share/sync — commit (scoped to .openground/ only) →
 *  pull --rebase --autostash → push. Never touches paths outside
 *  .openground/ and never disturbs the user's staged code changes. */
/** One conflicted file in a Sync rebase, described for the resolution dialog.
 *  Sides are named from the USER's point of view: `mine` = the local commit
 *  being replayed, `theirs` = the teammate's upstream version. (Inside a git
 *  rebase the index stages are inverted — stage 2 "ours" is upstream — the
 *  engine owns that mapping; this type never exposes it.) */
export interface ShareConflict {
  /** Repo-relative path (always under .openground/). */
  file: string
  /** Display label: `card "Title"` / `notes` / .openground-relative path. */
  label: string
  /** What kind of shared file this is — drives the dialog's wording. */
  kind: 'card' | 'notes' | 'other'
  mine: { exists: boolean; title?: string }
  theirs: { exists: boolean; title?: string }
}

export interface ShareSyncResult {
  ok: boolean
  /** A commit was created (there were local .openground/ changes). */
  committed: boolean
  pulled: boolean
  pushed: boolean
  /** The pull hit a rebase conflict; the rebase was aborted and the user
   *  should pull/resolve manually. */
  conflict?: boolean
  /** Human-readable labels of WHAT conflicted (collected before the abort):
   *  `card "Title"` for board cards, `notes`, else the .openground-relative
   *  path. Capped — the point is orientation, not a full listing (S15–S20). */
  conflictFiles?: string[]
  /** Structured conflict descriptions feeding the in-app resolution dialog
   *  ("keep mine" / "take theirs" per file). `mine` = the local version,
   *  `theirs` = the teammate's (upstream) version; `exists:false` marks the
   *  delete side of a delete/modify conflict. Titles are extracted from the
   *  card JSON on each side when parseable. Uncapped but bounded by how many
   *  files one rebase step can conflict. */
  conflicts?: ShareConflict[]
  /** Machine-readable cause for ok:false / degraded outcomes — the client
   *  maps these to localized, actionable notices (the `message` is the raw
   *  English fallback).
   *  - 'rebase-in-progress' / 'merge-in-progress': the repo was already mid
   *    rebase/merge when Sync was pressed; nothing was touched (S29).
   *  - 'detached-head': not on a branch; a sync commit would float (S26).
   *  - 'autostash-conflict': the pull succeeded but restoring the user's
   *    uncommitted CODE changes conflicted — they are also kept in the stash;
   *    loud, persistent warning instead of a silent "Synced" (S22). */
  reason?:
    | 'rebase-in-progress'
    | 'merge-in-progress'
    | 'detached-head'
    | 'autostash-conflict'
    | 'no-identity'
  /** The remote could not be reached (DNS / connection / timeout) — the
   *  commit is safely local; the next sync retries (S23). */
  offline?: boolean
  /** No git remote is configured — committed locally only (S3). */
  noRemote?: boolean
  /** The pull observed a rewritten upstream ("forced update") — the board
   *  after this sync deserves a review (S25). */
  forcedUpdate?: boolean
  /** Human-readable detail for toasts (push skipped, auth failure, …). */
  message?: string
}

/** Which Claude Code permission mode a spawned `claude` uses.
 *  - `bypass`: --dangerously-skip-permissions (the default — same as before).
 *  - `plan`:   --permission-mode plan; Claude can read but won't edit. */
export type PermissionMode = 'bypass' | 'plan'

// ---- Ground card terminal beacon -------------------------------------------

/** Activity of a `claude` PTY, derived server-side per session:
 *  - `working`: claude is actively emitting output (its TUI repaints
 *    continuously — a spinner — while it thinks/edits).
 *  - `waiting`: claude is sitting on a human — either its screen has gone
 *    silent past the working threshold (response finished, prompt idle) or a
 *    selection menu (permission prompt etc.) is detected on the settled
 *    screen. */
export type ClaudeBeaconStatus = 'working' | 'waiting'

/** One live claude-tagged PTY: its pool id, cwd and working/waiting verdict.
 *  NOT deduped — every live claude pane is listed, so per-task UIs (Board
 *  cards keyed by their slot's PTY id) can read their own pane's status.
 *  Per-project consumers (the Ground beacon) aggregate client-side with
 *  `working` winning over `waiting`. */
export interface ClaudeActivity {
  /** Terminal pool id (TerminalInfo.id) — the key Board task slots hold. */
  id: string
  cwd: string
  status: ClaudeBeaconStatus
}

/** Response of GET /api/terminal/active. `cwds` keeps the original "any PTY
 *  alive here" contract (shell panes included — drives the plain `Terminal`
 *  beacon); `claude` refines claude-tagged sessions into working/waiting. A
 *  cwd present in `cwds` but absent from `claude` only hosts free shells. */
export interface ActiveTerminalsResponse {
  cwds: string[]
  claude: ClaudeActivity[]
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

/** GET /api/feedback/config — gates the in-app feedback surface.
 *  - `enabled`: anon key configured, so the "Send feedback" entry shows.
 *  - `canRead`: the server also has a SERVICE-ROLE key, so the owner-only
 *    "Incoming feedback" inbox in Settings can read submissions. This is
 *    false on the public build (no service key shipped) — never echoes keys. */
export interface FeedbackConfigResponse {
  enabled: boolean
  canRead: boolean
  /** Stable, non-secret id (one-way hash of the Supabase url+table) emitted only
   *  when canRead, so the client can scope its "last seen" marker per data source
   *  — switching projects/tables won't carry a stale marker. Never the url/key. */
  sourceId?: string
}

/** GET /api/feedback/list — owner inbox payload. `truncated` is true when more
 *  than the returned cap (200) of rows exist, so the UI can say "newest 200". */
export interface FeedbackListResponse {
  items: FeedbackItem[]
  truncated: boolean
}

/** One row of submitted feedback, read back via the server's service-role key
 *  (GET /api/feedback/list). Owner-only: the service key never reaches the
 *  client, and the public build reports canRead:false so this never loads. */
export interface FeedbackItem {
  id: string
  created_at: string
  message: string
  email: string | null
  app_version: string | null
  os: string | null
  project_count: number | null
}

/** GET /api/auth/session — the only auth payload the SPA reads. `user` is null
 *  when signed out (or the env is unconfigured); tokens are never returned. */
export interface AuthSessionResponse {
  user: AuthUser | null
}

// ─── Custom modules (user-built tabs) ────────────────────────────────────────
// Contract for the custom-tab feature (docs/CUSTOM_TABS_PLAN.md): modules live
// globally under ~/.openground/custom-modules/ and surface as `custom:<id>`
// tabs in every project. Role gating is decided SERVER-side from the stored
// app-login session; the client only mirrors it.

export type CustomModuleFramework = 'react' | 'html'

/** Where a local module came from: authored here vs installed from the
 *  marketplace. Deletion rights differ (testers may remove `installed` only). */
export type CustomModuleOrigin = 'local' | 'installed'

export type CustomTabRole = 'owner' | 'tester' | 'none'

/** One entry of ~/.openground/custom-modules/index.json. The component source
 *  itself stays in the module dir (source.tsx / source.html) so the sidebar
 *  claude session can edit it as a plain file. */
export interface CustomModuleDef {
  id: string
  label: string
  description: string
  framework: CustomModuleFramework
  origin: CustomModuleOrigin
  createdAt: string
  updatedAt: string
  /** Marketplace row id — set after first publish (local) or on install. */
  remoteId?: string
  publishedAt?: string
  /** Published version counter (bumped on each re-publish). */
  version?: number
}

/** GET /api/custom-modules */
export interface CustomModulesResponse {
  role: CustomTabRole
  modules: CustomModuleDef[]
}

/** GET /api/custom-modules/:id/source — feeds the sandboxed iframe and the
 *  hot-reload poll (re-render when mtimeMs changes). */
export interface CustomModuleSourceResponse {
  source: string
  mtimeMs: number
}

/** One published row as listed by GET /api/marketplace (anon read). */
export interface MarketplaceModule {
  remoteId: string
  name: string
  description: string
  framework: CustomModuleFramework
  version: number
  publishedAt: string
}

/** GET /api/marketplace */
export interface MarketplaceListResponse {
  items: MarketplaceModule[]
}

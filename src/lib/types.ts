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
}

/** POST /api/project/share/sync — commit (scoped to .openground/ only) →
 *  pull --rebase --autostash → push. Never touches paths outside
 *  .openground/ and never disturbs the user's staged code changes. */
export interface ShareSyncResult {
  ok: boolean
  /** A commit was created (there were local .openground/ changes). */
  committed: boolean
  pulled: boolean
  pushed: boolean
  /** The pull hit a rebase conflict; the rebase was aborted and the user
   *  should pull/resolve manually. */
  conflict?: boolean
  /** Human-readable detail for toasts (push skipped, auth failure, …). */
  message?: string
}

/** Which Claude Code permission mode a spawned `claude` uses.
 *  - `bypass`: --dangerously-skip-permissions (the default — same as before).
 *  - `plan`:   --permission-mode plan; Claude can read but won't edit. */
export type PermissionMode = 'bypass' | 'plan'

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

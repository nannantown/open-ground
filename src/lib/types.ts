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
  /** Optional owner-chosen project name, shown on the Ground card and the
   *  project header in place of the folder's basename. Empty/unset → fall back
   *  to the folder name (the default). Purely cosmetic: it is NEVER used as a
   *  path (the path is always {@link path}), so it may contain spaces/dots/etc.
   *  When the project is shared via realtime collab, renaming it syncs to the
   *  member-visible shared name (og_projects.label). */
  displayName?: string
  /** Set ONLY on a registry entry created to back a folder-less shared project a
   *  member JOINED by invite: it links the member's OWN local folder (their own
   *  clone — never the owner's code) to that collab room (og_projects.id). The
   *  entry exists so the local folder lands on the validateProjectPath allowlist
   *  (Terminal/Claude can spawn there) AND carries the back-reference so the
   *  member's shared panel can surface a Terminal once linked. Such entries are
   *  NOT rendered as standalone Ground cards (scan.ts skips them) — the shared
   *  card already represents the project, so showing both would duplicate it.
   *  Created via {@link registry.linkSharedProjectToFolder}; absent on every
   *  normal Create-new / Import-existing project. */
  collabProjectId?: string
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
  /** Sentinel: set once the one-shot "Share via Git" evacuation has run —
   *  legacy in-repo `.openground/` data is copied back to the central store, so
   *  the (now-removed) feature never reads the repo again. */
  shareEvacuatedAt?: string
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
  /** The editor the project panel's "Open in editor" (`<>`) button launches in
   *  one click. null/undefined → no default yet, so clicking the button opens
   *  the editor picker instead of auto-launching one. Set by choosing an editor
   *  (and starring it) in that menu, or by Finder-picking a .app. Stored as an
   *  {name, path, mode:'open'} OpenApp and launched with `open -a`. */
  defaultEditor?: OpenApp | null
  /** The user's display name, used as the default assignee identity on shared
   *  boards ("my cards" filter). Default suggestion: `git config user.name`. */
  displayName?: string
  /** UI + prompt language. OPEN GROUND is English-first: unset means English.
   *  'ja' switches the UI strings AND the prompts sent to the spawned Claude
   *  (so its summaries/replies come back in Japanese). Persisted from the UI
   *  language toggle so the server can pick the matching prompt language. */
  language?: 'en' | 'ja'
  /** Owner-only experiment toggles (hidden, default off). The RAW stored
   *  switches — the resolved gate ANDs each with the owner role server-side
   *  (see {@link ExperimentsResponse} / resolveExperiments), so a non-owner who
   *  forges a `true` here never actually opens the gate. Absent ⇒ all off. */
  experiments?: Partial<ExperimentFlags>
}

/** Owner-only experiment ids — hidden features gated behind the owner role AND
 *  a per-experiment settings toggle (default off). They never ship in release
 *  notes or the in-app manual; the registry hides their modules entirely until
 *  the gate is open. `swarm` = the in-app swarm orchestration surface. */
export type ExperimentId = 'swarm'

/** Resolved open/closed state for every experiment, keyed by id. TRUE only when
 *  the user is the owner AND has turned that experiment on. */
export type ExperimentFlags = Record<ExperimentId, boolean>

/** GET /api/experiments. `eligible` = this user may toggle experiments at all
 *  (owner). `flags` = the RESOLVED per-experiment gate (owner && the settings
 *  toggle). A non-owner / signed-out user always gets `eligible: false` and
 *  all-false flags, so every experimental surface stays invisible regardless of
 *  any settings they forge. */
export interface ExperimentsResponse {
  eligible: boolean
  flags: ExperimentFlags
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

/** ── Canvas AI: server-side JOBS ──────────────────────────────────────────
 *  A Canvas AI run (generate native elements, or tweak a screen/mock's source)
 *  is a whole claude PTY session — 30s–3min — and MUST survive the client
 *  navigating away: switching tab / project / returning to Ground unmounts the
 *  canvas, and the OLD design (a fetch held for the whole run, aborted on
 *  unmount) killed claude mid-flight. So a run is now a SERVER-SIDE JOB: the
 *  POST returns a {jobId} immediately and the work keeps running even if the
 *  request connection drops; only an EXPLICIT cancel kills it. The result is
 *  persisted to the target canvas server-side on completion (so it's there
 *  whether or not anyone is watching), and the client polls the job for
 *  progress + result. Engine: src/lib/server/canvasAi.ts. */
export type CanvasAiJobKind = 'generate' | 'tweak'
export type CanvasAiJobStatus = 'running' | 'done' | 'error'

/** POST /api/canvas/ai/generate — start a "design as elements" job: claude
 *  authors NATIVE canvas elements (frame/shape/text/sticky), not code, so the
 *  result is hand-tweakable piece by piece (Figma-lite). On completion the
 *  elements are appended to `canvasId` at a position that doesn't overlap its
 *  existing content, server-side. */
export interface GenerateCanvasAiRequest {
  path: string
  canvasId: string
  prompt: string
}
/** POST /api/canvas/ai/tweak — start a screen/mock tweak job: claude rewrites
 *  the picked element's source per an instruction aimed at a node inside its
 *  rendered iframe (the canvasInspect postMessage bridge supplies `element`).
 *  On completion the rewritten source is written onto `elementId` in
 *  `canvasId`, server-side. */
export interface TweakCanvasAiRequest {
  path: string
  canvasId: string
  /** The screen/mock element whose `text` (source) the tweak rewrites. */
  elementId: string
  source: string
  framework: 'react' | 'html'
  instruction: string
  /** The picked element, as the bridge reported it. `html` is a truncated
   *  outerHTML snippet — enough for claude to locate the node in source. */
  element: { tag: string; classes: string; text: string; html: string }
}
/** Both POSTs answer with the new job's id — OR a 503 with the same
 *  `claudeMissing` / `claudeLoggedOut` preflight body the old endpoints used,
 *  so the "sign in to Claude" CTA in the client is unchanged. */
export interface CanvasAiStartResponse {
  jobId: string
}
/** One RUNNING job, as GET /api/canvas/ai/active lists them — feeds the global
 *  "Claude is designing" beacon (App polls it like the terminal beacon). Done /
 *  errored jobs are excluded. */
export interface CanvasAiActiveJob {
  id: string
  kind: CanvasAiJobKind
  projectPath: string
  canvasId: string
  /** Present for tweak jobs (the target element); absent for generate. */
  elementId?: string
  elapsedMs: number
}
export interface CanvasAiActiveResponse {
  jobs: CanvasAiActiveJob[]
}
/** GET /api/canvas/ai/job/:id — the full state the STARTING client polls. On
 *  `done`: a generate job carries `elements` (the appended elements, with their
 *  final server-assigned ids + positions); a tweak job carries `source` (+
 *  `unchanged` when claude judged the instruction already satisfied). On
 *  `error`: `error` is the message. `elapsedMs` is derived from the job's
 *  server-side startedAt, so the progress counter shows the TRUE elapsed time
 *  even after the canvas remounts and re-attaches to a still-running job. */
export interface CanvasAiJobState {
  id: string
  kind: CanvasAiJobKind
  canvasId: string
  elementId?: string
  status: CanvasAiJobStatus
  startedAt: string
  elapsedMs: number
  error?: string
  /** generate, done: the elements appended to the canvas. */
  elements?: CanvasElement[]
  /** tweak, done: the rewritten source. */
  source?: string
  /** tweak, done: true when the instruction was already satisfied (no rewrite). */
  unchanged?: boolean
}

// ── Project description jobs ──────────────────────────────────────────────────
//
// The card auto-description is ALSO a server-side job, for the SAME reason as
// Canvas AI: generating it is a whole claude PTY session (up to ~2min) that must
// survive the user navigating away (switching tab / project / back to Ground all
// unmount or re-key the panel). POST /api/project/describe returns a { jobId }
// immediately; the run completes on its OWN AbortController (only an EXPLICIT
// cancel kills it) and PERSISTS the result (description, descriptionJa,
// descriptionEn) into the project's central tasks.json server-side — so it's
// there whether or not anyone is watching, and re-opening the project shows it.
// The client polls the job for progress + result. Engine + registry:
// src/lib/server/generateDescription.ts.
export type DescribeJobStatus = 'running' | 'done' | 'error'

/** GET /api/project/describe/job/:id — the full state the STARTING client polls.
 *  On `done` the description fields carry the generated language pair (already
 *  persisted to projectData server-side). On `error`, `error` is the message
 *  ('cancelled' for an explicit cancel). `elapsedMs` is derived from the job's
 *  server-side startedAt, so the progress spinner shows the TRUE elapsed time
 *  even after the panel re-attaches to a still-running job. */
export interface DescribeJobState {
  id: string
  /** The project this run describes — the client matches it against the open
   *  project so a stale return never lands in the wrong project. */
  projectPath: string
  status: DescribeJobStatus
  startedAt: string
  elapsedMs: number
  error?: string
  /** done: the active-language one-liner (also written to projectData). */
  description?: string
  /** done: the Japanese half of the generated pair, when it landed. */
  descriptionJa?: string
  /** done: the English half of the generated pair, when it landed. */
  descriptionEn?: string
}
/** One RUNNING describe job, as GET /api/project/describe/active lists them —
 *  the panel re-attaches to its own project's run after a navigation. */
export interface DescribeActiveJob {
  id: string
  projectPath: string
  elapsedMs: number
}
export interface DescribeActiveResponse {
  jobs: DescribeActiveJob[]
}
/** POST /api/project/describe answers with the new job's id — OR a 503 with the
 *  same `claudeMissing` / `claudeLoggedOut` preflight body the other run
 *  endpoints use, so the "sign in to Claude" CTA is unchanged. */
export interface DescribeStartResponse {
  jobId: string
}

/** Internal prompt-builder input for tweakScreenSource / buildTweakScreenPrompt
 *  (src/lib/server/canvasAi.ts). The HTTP layer (TweakCanvasAiRequest) adds the
 *  canvasId + elementId needed to persist the result; this is just the slice
 *  the prompt needs. */
export interface TweakScreenRequest {
  path: string
  source: string
  framework: 'react' | 'html'
  instruction: string
  /** The picked element, as the bridge reported it. `html` is a truncated
   *  outerHTML snippet — enough for claude to locate the node in source. */
  element: { tag: string; classes: string; text: string; html: string }
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

/** One Claude Code skill — either defined INSIDE a project
 *  (`<project>/.claude/skills/<id>/SKILL.md`, GET /api/project/skills) or one of
 *  the user's OWN global skills (`~/.claude/skills/<id>/SKILL.md`,
 *  GET /api/skills/global). Parsed from the file's YAML frontmatter. Display-only
 *  — OPEN GROUND never executes a skill; the user's own `claude` CLI does. */
export interface ProjectSkill {
  /** The skill's directory name under `.claude/skills/` (filesystem-stable). */
  id: string
  /** Display name: frontmatter `name`, falling back to the directory name. */
  name: string
  /** Frontmatter `description` ('' when absent). */
  description: string
  /** Path to the SKILL.md for display: project-relative (`.claude/skills/…`) or
   *  `~/.claude/skills/…` for a global skill. */
  file: string
}

export interface ProjectSkillsResponse {
  skills: ProjectSkill[]
}

/** POST /api/skills/global/create response: the skill the one-off `claude`
 *  session authored under ~/.claude/skills (re-read from disk). */
export interface CreateSkillResponse {
  skill: ProjectSkill
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
 *  - `gap`     — px between consecutive children along the main axis. Ignored
 *    by the engine while `justify === 'space-between'` (the leftover space IS
 *    the gap then).
 *  - `padding` — px inset from the frame's edges — the legacy all-four-sides
 *    value, used as the fallback for any per-side field left unset.
 *  - `align`   — cross-axis placement of each child inside the padded box
 *    ('start' | 'center' | 'end').
 *  All v2 fields below are OPTIONAL and backward-compatible: older saved
 *  canvases omit them and the engine falls back to the legacy behaviour
 *  (justify 'start', uniform `padding`, both axes 'fixed').
 *  - `justify`      — main-axis distribution of the children. Omitted =
 *    'start'. 'space-between' spreads the leftover space evenly between
 *    consecutive children (a single child centres).
 *  - `paddingTop` / `paddingRight` / `paddingBottom` / `paddingLeft` —
 *    per-side padding px; each side omitted falls back to `padding`.
 *  - `primarySizing` — the frame's own MAIN-axis sizing: 'hug' shrinks/grows
 *    the frame to its content (children + gaps + padding), 'fixed' keeps the
 *    stored width/height. Omitted = 'fixed'.
 *  - `counterSizing` — same for the frame's CROSS axis (max child + padding).
 *    Omitted = 'fixed'. */
export interface FrameLayout {
  mode: 'row' | 'column'
  gap: number
  padding: number
  align: 'start' | 'center' | 'end'
  justify?: 'start' | 'center' | 'end' | 'space-between'
  paddingTop?: number
  paddingRight?: number
  paddingBottom?: number
  paddingLeft?: number
  primarySizing?: 'fixed' | 'hug'
  counterSizing?: 'fixed' | 'hug'
}

// A single shadow effect (Figma drop / inner shadow), rendered as one CSS
// box-shadow layer. `type:'inner'` becomes an `inset` shadow.
export interface CanvasShadow {
  type: 'drop' | 'inner'
  x: number
  y: number
  blur: number
  spread: number
  color: string
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
  /** Text resize mode (Figma parity — see `canvasTextSizing.ts` + docs/
   *  CANVAS_TEXT_SIZING_PLAN.md). Applies to `text` only. Undefined = the
   *  default `'auto-width'`, so every previously-saved text loads unchanged.
   *  - `'auto-width'` — the box hugs its content on BOTH axes; no wrapping;
   *    typing widens it, an explicit newline adds height. `width`/`height` are
   *    the MEASURED footprint (persisted, quantised), never authoritative.
   *  - `'auto-height'` — `width` is AUTHORITATIVE (user-dragged); the text
   *    wraps within it; `height` is the measured wrapped height.
   *  - `'fixed'` — `width` AND `height` are authoritative; the text wraps and
   *    overflow is clipped; `textVerticalAlign` positions it in the box. */
  textSizing?: 'auto-width' | 'auto-height' | 'fixed'
  /** Vertical alignment inside a `'fixed'`-size text box. Undefined = `'top'`.
   *  Ignored by the two auto modes (their height always hugs the content). */
  textVerticalAlign?: 'top' | 'middle' | 'bottom'
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
  /** Stroke line style (Figma: solid / dashed / dotted). OPTIONAL +
   *  backward-compatible: omitted = 'solid' (the legacy hard-coded border). */
  strokeStyle?: 'solid' | 'dashed' | 'dotted'
  /** Stroke alignment relative to the geometry rect (Figma: inside / center /
   *  outside). OPTIONAL + backward-compatible: omitted = 'inside', which is the
   *  legacy `box-sizing:border-box` border (drawn inside the rect) — so existing
   *  frames/shapes render byte-identically. center / outside are painted by a
   *  stroke overlay grown half / a full stroke-width outward. */
  strokeAlign?: 'inside' | 'center' | 'outside'
  /** Shadow effects (Figma's drop / inner shadow), rendered as a CSS box-shadow.
   *  OPTIONAL + backward-compatible: omitted / empty = no shadow (the legacy
   *  look). Multiple stack, painted in order. Frame + shape only. */
  shadows?: CanvasShadow[]
  /** Image FILL (Figma's image paint): a per-canvas asset id painted as the
   *  frame/shape background. When set it WINS over the colour/gradient `fill`.
   *  `fillImageMode` is the CSS sizing (default 'cover'). OPTIONAL — omitted =
   *  no image fill. (Distinct from an `image` ELEMENT, which uses `assetId`.) */
  fillImageId?: string
  fillImageMode?: 'cover' | 'contain' | 'fill' | 'tile'
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
  /** Per-corner radius overrides (Figma's independent corners). Each OPTIONAL +
   *  backward-compatible: an unset corner falls back to `cornerRadius`, then the
   *  default — so a frame/rect with none set stays uniform exactly as before.
   *  Order mirrors CSS border-radius (TL, TR, BR, BL); rect/frame only (an
   *  ellipse ignores them). */
  cornerRadiusTopLeft?: number
  cornerRadiusTopRight?: number
  cornerRadiusBottomRight?: number
  cornerRadiusBottomLeft?: number
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
  /** Layout-child only (Figma "Fill container", main axis): meaningful only
   *  while this element is a direct child of a layout frame. When the frame's
   *  MAIN axis is 'fixed', the engine stretches this child to an equal share
   *  of the leftover main-axis space (writing its width/height); while the
   *  frame hugs that axis the child keeps its natural size (Figma does the
   *  same). OPTIONAL and backward-compatible: omitted = natural size. */
  fillMain?: boolean
  /** Layout-child only (Figma "Fill container", cross axis): as `fillMain`,
   *  but stretching to the frame's padded CROSS-axis interior when the frame's
   *  cross axis is 'fixed'. OPTIONAL and backward-compatible: omitted =
   *  natural size. */
  fillCross?: boolean
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
  /** Image-only (collab, u14b). Object key for the image bytes in shared object
   *  storage — **Cloudflare R2** on the owner's CF account (migration 0005
   *  dropped the v1 Supabase Storage bucket — R2 is egress-free). Key shape
   *  `<projectUuid>/<canvasId>/<assetId>`. The owner's ProjectCanvas sweep
   *  uploads the local `assetId` bytes and writes this onto the element; the
   *  Y.Doc carries THIS reference, never the bytes. ImageView prefers the local
   *  `assetId` file (owner, fast) and uses this only for folder-less members, so
   *  collab-OFF / git-shared installs render unchanged. Members with no
   *  storageKey yet see the "not synced" placeholder (u14a).
   *  INVARIANT: clear `storageKey` whenever `assetId` changes — a new asset means
   *  a new upload, or members would fetch stale bytes at the old key. (Today the
   *  only image-insert path creates a fresh element, so this holds; preserve it
   *  if you ever add a replace-in-place edit.) */
  storageKey?: string
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
  /** Monotonic per-canvas revision for optimistic concurrency control. Every
   *  server write (client save, AI append, AI tweak, rename) bumps it. The
   *  client loads it and echoes it back on save; a save whose rev is behind the
   *  server's (an AI job landed since the load) is rejected with 409 so the
   *  client can refetch + 3-way-merge + retry instead of silently clobbering
   *  the AI's additions (see canvasData.saveCanvasFile + canvasMerge.ts).
   *  Legacy files written before rev existed read back as 0. */
  rev: number
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

/** One uncommitted entry from `git status --porcelain` for the branch-changes
 *  view: `status` is the two-letter XY code trimmed ('M', 'A', 'D', '??', …);
 *  renames render as "old → new" in `path`. */
export interface BranchWorkingChange {
  status: string
  path: string
}

/** One committed-on-this-branch file from `git diff --numstat target...HEAD`.
 *  Binary files (numstat '-') report 0/0. */
export interface BranchCommittedChange {
  path: string
  additions: number
  deletions: number
}

/** GET /api/project/branch-changes?path= — the ProjectPanel header chip +
 *  "Branch changes" modal payload. Non-repo dirs answer { isGit: false } (the
 *  chip simply doesn't render). `target` resolves config.targetBranch first,
 *  then main / master; null = nothing to compare against (committed list
 *  empty). `sameBranch` = HEAD is the target itself — committed/ahead/behind
 *  are intentionally zeroed rather than self-compared. */
export type BranchChangesResponse =
  | { isGit: false }
  | {
      isGit: true
      /** Checked-out branch, or null (detached HEAD). */
      branch: string | null
      target: string | null
      sameBranch: boolean
      /** Commits on HEAD that target doesn't have. */
      ahead: number
      /** Commits on target that HEAD doesn't have. */
      behind: number
      working: BranchWorkingChange[]
      committed: BranchCommittedChange[]
    }

/** One row of GET /api/project/active-branches: a LOCAL branch plus the
 *  worktree it's currently checked out in. `worktreePath` is null when the
 *  branch has no worktree (a plain head you could switch to). */
export interface ActiveBranch {
  name: string
  /** True for the branch checked out in the panel's own project path. */
  current: boolean
  /** Absolute path of the worktree this branch is checked out in, or null. */
  worktreePath: string | null
}

/** GET /api/project/active-branches?path= — the ProjectPanel header branch
 *  dropdown. Lists every local head (current first, then alphabetical),
 *  annotated with the worktree each is checked out in. A non-repo (or any git
 *  failure) yields { isGit: false, branches: [] } and the chip won't render. */
export interface ActiveBranchesResponse {
  isGit: boolean
  branches: ActiveBranch[]
}

/** Which diff GET /api/project/file-diff returns: 'working' = uncommitted
 *  changes vs HEAD (untracked → full content), 'branch' = target...HEAD. */
export type FileDiffScope = 'working' | 'branch'

/** GET /api/project/file-diff?path=&file=&scope= — unified diff text, cut at
 *  ~200KB on a line boundary (`truncated` says so). */
export interface FileDiffResponse {
  diff: string
  truncated: boolean
}

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

/** POST /api/swarm/worker — a freshly spawned in-app swarm worker: the claude
 *  PTY id + minted session id, and the isolated `swarm/*` worktree/branch it
 *  runs in (under the project's CENTRAL worktrees dir). The /order goal is
 *  typed into the PTY asynchronously once its TUI is ready, so this returns
 *  before the goal lands — the heartbeat / session JSONL is the arrival proof. */
export interface SpawnSwarmWorkerResponse {
  terminalId: string
  agentSessionId: string
  worktree: string
  branch: string
}

/** POST /api/swarm/worktree/remove — whether the worktree was torn down, with
 *  a `reason` when it was kept (dirty/locked without force, or not a central
 *  worktree). */
export interface RemoveSwarmWorktreeResponse {
  removed: boolean
  reason?: string
}

/** POST /api/swarm/supply — a freshly spawned in-app SUPPLY (補給官) session:
 *  the claude PTY id + minted session id. Unlike a worker it has NO worktree —
 *  it runs in the project's PRIMARY checkout cwd, running the /supply skill to
 *  turn the user's vague requests into observable Board:todo cards. It only
 *  talks to the user + writes the Board; it never edits code or pushes (so no
 *  worktree to return, and stopping it is a plain PTY kill). */
export interface SpawnSwarmSupplyResponse {
  terminalId: string
  agentSessionId: string
}

/** POST /api/swarm/manager — a freshly spawned in-app COMMANDER (司令官)
 *  CONVERSATION session: the claude PTY id + minted session id. Like the supply
 *  officer (and unlike a worker) it has NO worktree — it runs in the project's
 *  PRIMARY checkout cwd, running the /manage skill so the owner can talk to the
 *  commander (status / merge / advise) interactively. It complements the
 *  AUTONOMOUS engine (the orchestrator behind /api/swarm/orchestrator): the
 *  engine is the unattended drain+integrate loop, this is the human-in-the-loop
 *  conversational counterpart. Stopping it is a plain PTY kill (no worktree). */
export interface SpawnSwarmManagerResponse {
  terminalId: string
  agentSessionId: string
}

/** The coarse lifecycle stage the COMMANDER engine reports for one of its
 *  workers (Card②'s monitoring): 'starting' = PTY spawned, claude still booting;
 *  'running' = actively working (heartbeat/commit seen, or past the boot window);
 *  'done' = the worker finished — its branch carries integrable commits and it
 *  signalled completion, so the engine moved its card doing→review. */
export type OrchestratorWorkerStage = 'starting' | 'running' | 'done'

/** A worker the COMMANDER engine (swarmOrchestrator) dispatched and still counts
 *  against the concurrency cap — a live `claude` PTY in an isolated `swarm/*`
 *  worktree, born from a Board:todo card. The engine prunes one from its set
 *  when the PTY exits (the slot frees). Card② adds continuous MONITORING: each
 *  pass re-probes the worker (PTY liveness + branch commits + the heartbeat
 *  completion sign) to advance `stage` and, when it conservatively judges the
 *  worker done, moves its card doing→review (recording the branch as the
 *  integration handle the next stage reads). */
export interface OrchestratorWorker {
  /** The worker's `claude` PTY id (liveness key — getTerminal). */
  terminalId: string
  /** The `swarm/*` branch the worker checked out (recorded on the card too, as
   *  the durable handle the integration stage merges). */
  branch: string
  /** Absolute path of the worker's isolated worktree (under the central
   *  worktrees dir) — the integration stage tears it down. */
  worktree: string
  /** The Board card this worker drains. */
  taskId: string
  /** The card title at dispatch time (display-only). */
  taskTitle: string
  /** ISO timestamp the engine dispatched it. */
  startedAt: string
  /** Coarse lifecycle stage, recomputed every monitor pass — see
   *  {@link OrchestratorWorkerStage}. The state API surfaces it; the Swarm
   *  commander pane renders a per-worker dot from it. */
  stage: OrchestratorWorkerStage
  /** The worker's self-reported phase from its heartbeat (`swarm-beat.sh`'s
   *  first arg — e.g. 'audit' / 'implement' / 'verify' / 'blocked'), or absent
   *  when it has not written one yet. Display-only: the commander pane shows it
   *  so each worker's CURRENT phase is legible at a glance (finer than `stage`,
   *  which only coarsens to starting/running/done). Never affects the engine's
   *  (commit-gated) DONE judgement. */
  phase?: string
  /** The worker's one-line heartbeat summary (`swarm-beat.sh`'s task arg) —
   *  what it says it is doing right now. Display-only; absent until it beats. */
  note?: string
  /** ISO timestamp of the worker's latest heartbeat (`updatedAt`), or absent
   *  when it never beat. Display-only — the pane uses it to show staleness. */
  heartbeatAt?: string
  /** ISO timestamp the engine LAST sent this worker's card review→doing on a 差し戻し
   *  (rework). The monitor suppresses re-promoting the card until the worker emits a
   *  FRESH completion sign (a heartbeat strictly newer than this) — so a just-reworked
   *  worker gets time to actually fix the issue instead of being instantly re-promoted
   *  on its stale pre-rework readyToMerge:true (which would burn the rework budget by
   *  wall-clock). Cleared on a fresh-heartbeat promote. In-memory only; absent for a
   *  never-reworked worker. */
  reworkAt?: string
}

/** One human-readable line of the commander engine's drain/dispatch journal —
 *  rendered by the (separate) Swarm UI card so the owner can watch the engine
 *  reason about the queue. A ring buffer capped server-side. */
export interface OrchestratorLogLine {
  /** ISO timestamp the line was emitted. */
  at: string
  level: 'info' | 'warn' | 'error'
  message: string
  /** Structured event class for the commander dashboard's log filter + per-event
   *  styling. A PURE display hint — it never changes what the engine does.
   *   - 'routine'   — per-pass bookkeeping (a slot freeing on a NORMAL exit, a
   *                   card gone, a column move reconciled); hidden by default so
   *                   the meaningful events below aren't buried.
   *   - 'dispatch'  — a worker was launched for a card (or the launch failed:
   *                   read `level` for success vs failure).
   *   - 'promote'   — a worker was judged done; its card moved doing→review.
   *   - 'integrate' — a review branch landed on the trunk (review→done).
   *   - 'conflict'  — an auto-integration hit a rebase conflict; needs a human.
   *   - 'cleanup'   — a landed worker's worktree/branch teardown was KEPT (a
   *                   potential zombie the owner should clear).
   *   - 'crash'     — a worker's PTY died WITHOUT integrable work (no commits, or
   *                   it reported a blocker) — recovered (worktree+PTY torn down,
   *                   card re-homed). The abnormal counterpart of a 'routine'
   *                   slot-free.
   *   - 'stall'     — a worker is ALIVE but went silent (no heartbeat AND no PTY
   *                   output for minutes): the engine nudged it (Enter) to try to
   *                   un-stick it, or — when nudges failed — reclaimed it like a
   *                   crash (torn down + re-homed).
   *  Absent ⇒ an uncategorized meaningful event (always shown). The dashboard's
   *  "Key" filter hides only 'routine'; every other kind is a shown event. */
  kind?: 'routine' | 'dispatch' | 'promote' | 'integrate' | 'conflict' | 'cleanup' | 'crash' | 'stall'
}

/** Read-only integration readiness of ONE review-column card whose branch the
 *  commander engine could land (Card③). Computed each pass WITHOUT mutating git
 *  so the dashboard can show "統合可" while auto-integrate is OFF (the default).
 *   - 'ff'       → a clean fast-forward (or already merged) — finalizable now.
 *   - 'rebase'   → diverged from the trunk; needs a rebase (which MAY conflict).
 *   - 'conflict' → an actual auto-integration attempt hit a rebase conflict and
 *                  was aborted; needs manual integration (mirrors the card's
 *                  integrationConflict stamp).
 *   - 'unknown'  → not judgeable (no remote trunk, tip missing, git error). */
export type OrchestratorReviewStatus = 'ff' | 'rebase' | 'conflict' | 'unknown'

export interface OrchestratorReview {
  /** The Board card sitting in review. */
  taskId: string
  /** Its `swarm/*` branch (the integration subject). */
  branch: string
  /** Card title at classify time (display-only). */
  taskTitle: string
  /** How it relates to the trunk — see {@link OrchestratorReviewStatus}. */
  status: OrchestratorReviewStatus
}

/** A STATE INCONSISTENCY the commander engine detected between its own worker
 *  set, the Board, and the on-disk worktrees — surfaced so the owner notices a
 *  drift the autonomy loop can't silently self-heal (the残課題 from the QA
 *  report: "状態が食い違った時に気づけない"). Detection is READ-ONLY (it never
 *  moves a card or kills a PTY); it only reports. The kinds:
 *   - 'orphan-doing'    — a card sits in 'doing' with a `swarm/*` branch, yet no
 *                         counted worker drains it AND its worktree is gone: the
 *                         worker that owned it vanished, but the card never left
 *                         'doing' (it will never advance on its own).
 *   - 'worktree-missing'— a worker the engine still counts has lost its isolated
 *                         worktree directory (deleted out from under it): its PTY
 *                         may run but its work tree is gone.
 *   - 'worker-stale'    — a counted, still-alive worker has not beat its
 *                         heartbeat for a long time (likely stuck / hung).
 *   - 'move-stuck'      — a Board COLUMN MOVE kept failing (the write was rejected
 *                         / errored) past the retry budget, so the work happened
 *                         but the card couldn't follow it: a worker finished but
 *                         its card is stuck in 'doing' (`intent:'review'`), a
 *                         branch LANDED on the trunk but its card is stuck in
 *                         'review' (`intent:'done'` — "done なのに review"), or a
 *                         lost worker's card couldn't be re-homed out of 'doing'
 *                         (`intent:'recover'` — "dead なのに doing"). The engine
 *                         keeps retrying (and escalates a recoverable case to
 *                         'blocked'); this surfaces the ones a human must move. */
export type OrchestratorAnomalyKind =
  | 'orphan-doing'
  | 'worktree-missing'
  | 'worker-stale'
  | 'move-stuck'
  | 'rework-exhausted'

export interface OrchestratorAnomaly {
  /** Which inconsistency — see {@link OrchestratorAnomalyKind}. */
  kind: OrchestratorAnomalyKind
  /** Stable identity for dedup + the UI React key: the taskId for a card-rooted
   *  anomaly (orphan-doing / move-stuck), else the branch for a worker-rooted one. */
  ref: string
  /** The `swarm/*` branch involved, when known (display-only). */
  branch?: string
  /** The card title involved, when known (display-only). */
  taskTitle?: string
  /** For 'worker-stale': minutes since the last heartbeat (display-only, so the
   *  pane can say "no heartbeat for N min" without a second clock). */
  staleMinutes?: number
  /** For 'move-stuck': WHICH column move is stuck, so the pane can say exactly
   *  what zombied ('review' = stuck in doing, 'done' = stuck in review, 'recover'
   *  = a lost worker stuck in doing). */
  intent?: 'review' | 'done' | 'recover'
  /** For 'move-stuck': how many consecutive writes were kept (display-only).
   *  For 'rework-exhausted': how many times the card bounced review→doing before
   *  the loop guard parked it in 'blocked' (display-only). */
  attempts?: number
}

/** GET/POST /api/swarm/orchestrator{,/start,/stop,/automerge} — the commander
 *  engine's state for ONE project: whether the autonomous drain loop is running,
 *  whether auto-integration is armed, the workers it counts against the cap, the
 *  review cards it could land, the recent journal, and the concurrency ceiling.
 *  Owner-only (same gate as the rest of /api/swarm/*). */
export interface SwarmOrchestratorState {
  /** True while the autonomous drain+dispatch loop is scheduled. OFF ⇒ the
   *  engine never dispatches (manual POST /api/swarm/worker is untouched) AND
   *  never integrates — the global stop. */
  running: boolean
  /** True while auto-integration (Card③) is armed: a SEPARATE switch from
   *  `running`, default OFF. When OFF the engine only CLASSIFIES review cards
   *  (the `reviews` readiness below) and shows "統合可"; when ON it lands the
   *  fast-forwardable / cleanly-rebasable ones on the trunk and moves them to
   *  done. Only ever acts while `running` — turning the engine off stops
   *  integration too. */
  autoMerge: boolean
  /** Workers the engine dispatched and still counts as live (≤ maxWorkers). */
  workers: OrchestratorWorker[]
  /** Review-column swarm cards and their integration readiness (read-only,
   *  recomputed each pass while running). Empty until the engine has run an
   *  integration pass. */
  reviews: OrchestratorReview[]
  /** Recent drain/dispatch/integrate journal, oldest-first (ring buffer). */
  log: OrchestratorLogLine[]
  /** State inconsistencies the engine detected this pass (worker set ↔ Board ↔
   *  worktrees) — empty when everything is coherent. The commander pane renders
   *  these as warnings so a drift can't go unnoticed. Recomputed each pass. */
  anomalies: OrchestratorAnomaly[]
  /** The concurrency ceiling — the engine never has more live workers than this. */
  maxWorkers: number
}

// ── swarm janitor (residual-cleanup) ─────────────────────────────────────────
// The janitor sweeps the leftovers the worktree/PTY-body cleaner does NOT own:
// (1) stale `swarm/*` branches, (2) orphaned heartbeat files, (3) dead
// terminal-pool entries. Every verdict is observable (a typed report) and SAFE:
// unmerged/dirty/active work is KEPT and surfaced, never deleted. Pure git
// (`branch -d` + non-force `push --delete swarm/*`); no force-delete, no
// force-push.

/** Why a `swarm/*` branch was KEPT instead of swept. `unmerged` = open vs trunk
 *  (would lose commits); `unknown` = ancestry unjudgeable (tip missing / no
 *  trunk / git error — never guessed); `checked-out` = a live worktree still has
 *  it (an active worker, or a worktree the body-cleaner hasn't removed yet). */
export type SwarmBranchKeepReason = 'unmerged' | 'unknown' | 'checked-out'

/** A `swarm/*` branch the janitor left in place, with the reason it was spared. */
export interface SwarmBranchKept {
  branch: string
  reason: SwarmBranchKeepReason
  /** True when `reason: 'checked-out'` and that worktree has uncommitted changes
   *  (dirty) — the most important class to never touch. */
  dirty?: boolean
}

/** Result of the local+remote `swarm/*` branch sweep. */
export interface SwarmBranchSweepResult {
  /** Local `swarm/*` branches deleted (merged into the trunk, or empty). */
  deletedLocal: string[]
  /** Remote `origin/swarm/*` branches deleted (merged; non-force `--delete`).
   *  Always empty unless the caller opted into `deleteRemote`. */
  deletedRemote: string[]
  /** Branches deliberately NOT deleted, each with its keep reason (the warning
   *  list). */
  kept: SwarmBranchKept[]
}

/** Result of the heartbeat-file sweep under `~/.openground/swarm/<key>/`. */
export interface SwarmHeartbeatSweepResult {
  /** Heartbeat files removed — stale AND their worker is provably gone (branch
   *  or worktree missing), or unparseable + stale. */
  swept: string[]
  /** Heartbeat files kept — fresh (a live worker is still writing it) or its
   *  branch+worktree both still exist. */
  kept: string[]
}

/** Result of the in-memory terminal-pool sweep (terminal.ts). */
export interface TerminalPoolSweepResult {
  /** PTY session ids dropped from the pool — exited past the linger window
   *  (a delete-timer lost across a server reload), or their process is gone. */
  swept: string[]
  /** Number of live sessions left untouched. */
  kept: number
}

/** Combined janitor report — the three residual-cleanup sweeps, each observable
 *  and independently safe. */
export interface SwarmJanitorReport {
  branches: SwarmBranchSweepResult
  heartbeats: SwarmHeartbeatSweepResult
  terminals: TerminalPoolSweepResult
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
  /** Set by the commander engine's auto-integration stage (Card③) when this
   *  review card's branch could NOT be landed automatically because rebasing it
   *  onto the trunk hit a conflict — a human must integrate it by hand. The
   *  engine never auto-resolves a conflict; it stamps this, leaves the card in
   *  review, and surfaces it on the Board. Cleared whenever the card moves out
   *  of the review column (a rework / completion invalidates the stamp). Shared
   *  data. */
  integrationConflict?: boolean
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
 *  'review'=レビュー待ち (PR-waiting, between doing and done, always shown) /
 *  'done'=完了 / 'blocked'=ブロック. */
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
  /** Custom tabs ATTACHED to this project — bare custom-module uuids. The
   *  module library (~/.openground/custom-modules/) is user-level; a module
   *  surfaces in a project's tab row only when its id is listed here (chosen
   *  via the "+" picker). PERSONAL state like tabOrder: stays central in
   *  git-shared mode. Unknown/deleted ids are ignored on read. */
  customTabs?: string[]
  /** Built-in (native) modules HIDDEN from this project's tab row — bare
   *  ModuleId strings. The defaults (Terminal / Canvas / Board) ship
   *  pre-installed and can't be uninstalled, but a project may drop one from
   *  its row. PERSONAL state like tabOrder / customTabs: central in git-shared
   *  mode, unknown ids ignored on read. The last remaining tab can't be hidden
   *  (enforced in the UI). */
  disabledModules?: string[]
  /** Shared project policy — see {@link ProjectConfig}. */
  config?: ProjectConfig
  /** Personal launch preferences — see {@link ProjectLaunchPrefs}. Central
   *  in both modes (composed like tabOrder). */
  launch?: ProjectLaunchPrefs
  notes: string
  updatedAt: string
  /** SHARED canvas index for realtime collab — the list of canvases a folder-less
   *  member can discover + open (published into the board collab doc by the
   *  owner's Canvas tab; read by the member's SharedProjectBody). NOT a local
   *  source of truth — canvases-index.json remains authoritative on the owner's
   *  disk; this is the cross-user mirror. Absent for non-collab/local use. */
  canvasIndex?: { id: string; name: string }[]
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

/** An image attached to a feedback submission, stored INLINE (base64, no
 *  data-URL prefix) in the feedback row's `images` jsonb column. The client
 *  downscales + re-encodes to WebP before upload (see src/lib/feedbackImages.ts)
 *  so a multi-MB screenshot becomes a few hundred KB. Inline blob chosen over
 *  Supabase Storage deliberately: feedback is low-volume + owner-only, so this
 *  avoids a bucket + signed-URL round-trip. Render via `data:${mime};base64,…`.
 *  3点セット: this type / FeedbackImageApiSchema (schemas.ts) / the row build in
 *  server/routes/feedback.ts — a field missing from one is dropped silently. */
export interface FeedbackImage {
  /** Original file name, display-only (tooltip / download); never used as a path. */
  name?: string
  /** MIME of the stored bytes — the re-encoded type (image/webp). */
  mime: string
  /** Base64 of the compressed bytes, WITHOUT the "data:<mime>;base64," prefix. */
  data: string
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
  /** Inline image attachments (base64). Absent on rows created before this
   *  feature shipped, and `[]` when the submitter attached none. */
  images?: FeedbackImage[]
}

/** GET /api/auth/session — the only auth payload the SPA reads. `user` is null
 *  when signed out (or the env is unconfigured); tokens are never returned. */
export interface AuthSessionResponse {
  user: AuthUser | null
}

// ─── Realtime collab (CRDT over a Cloudflare Durable Object) ─────────────────
// Optional, feature-flagged layer (server env OPENGROUND_REALTIME). When OFF,
// every endpoint below reports {enabled:false} and the SPA never loads the
// y-partyserver / yjs bundle, so the single-user fetch/POST path is unchanged.
// The claude PTY is NEVER part of this — only Board ProjectData.tasks/notes and
// Canvas CanvasFile.elements document state sync.
//
// collabProjectId = og_projects.id (owner-managed; migration 0005), NOT the
// git-share marker. Transport = a Cloudflare Durable Object room keyed
// `<collabProjectId>:<scope>` (y-partyserver), authorized by a short-lived HMAC
// ticket; Supabase only stores membership. See docs/COLLAB_CF_DO_PLAN.md.

/** Which document a Y.Doc represents: the board, or one specific canvas. The
 *  Durable-Object room is `<collabProjectId>:<DocScope>`. */
export type DocScope = 'board' | `canvas:${string}`

/** Where a collab room comes from. OWNER flow: a local project `path` (resolved
 *  + membership-seeded server-side). MEMBER flow: a cross-user `collabProjectId`
 *  for a project the caller was invited to but has NO local folder for — the
 *  server gates it on membership, no path required. */
export type CollabSource = { path: string } | { collabProjectId: string }

/** A remote collaborator currently present in a room (via the DO awareness
 *  channel, u15). `clientId` is the Yjs awareness client id (stable per live
 *  connection); name/color are the peer's self-reported identity. `email` is the
 *  peer's full address when published — the avatar tooltip prefers it, falling
 *  back to `name` (the email local-part) for older peers that omit it. */
export interface PresencePeer {
  clientId: number
  name: string
  color: string
  email?: string
}

/** GET /api/collab/config — the client gate. `enabled` is true only when the
 *  server has OPENGROUND_REALTIME set AND Supabase is configured AND a session
 *  exists. Mirrors the auth/feedback graceful-degrade contract. */
export interface CollabConfigResponse {
  enabled: boolean
}

/** GET /api/collab/project — per-project resolution: the cross-user collab id
 *  (collabProjectId = og_projects.id, owner-managed; resolved-or-created for the
 *  signed-in OWNER from the canonical local path) + whether the caller is a
 *  member. `collabProjectId` is null when signed out / unconfigured / the resolve
 *  fails. An optional `collabProjectId` query param lets a MEMBER (who has no
 *  local folder) resolve membership by id instead of by path. */
export interface CollabProjectResponse {
  collabProjectId: string | null
  member: boolean
  /** The owner-set, member-visible SHARED NAME (og_projects.label), if any. NOT
   *  the local path (that stays private as an opaque hash). Used to pre-fill the
   *  owner's invite dialog and to label a member's shared project. */
  label?: string
}

/** One project the signed-in user can READ (owner OR member), as returned by
 *  GET /api/collab/projects — the "shared with me" feed. */
export interface CollabProjectListItem {
  /** collabProjectId (og_projects.id) — the room key + the data-dir key for a
   *  folder-less shared project. */
  id: string
  /** Owner-set, member-visible SHARED NAME — what the shared card shows. The
   *  owner's opaque path-hash is never sent to the client. */
  label?: string
  /** True when the caller OWNS this project (owner_id == their uid). The Ground
   *  shows only `owned:false` rows as SHARED cards — owned projects already
   *  appear as local cards via the registry. */
  owned: boolean
}

/** GET /api/collab/projects — every project the caller can read (owner OR
 *  member). Member-flow groundwork: lets a future "shared with me" UI enumerate
 *  collabProjectIds an invited member can open even without a local folder. */
export interface CollabProjectsListResponse {
  projects: CollabProjectListItem[]
}

/** GET/POST /api/collab/link — a member's LOCAL FOLDER link for a folder-less
 *  shared project. GET resolves the currently-linked folder (null when the member
 *  hasn't linked one yet); POST links the folder the member picked. `localPath` is
 *  the member's OWN canonical folder path (their clone) — safe to return to their
 *  own client; the owner's path is never involved. Once linked the folder is on
 *  the registry allowlist, so the shared project's Terminal can spawn Claude in
 *  it while Board/Canvas keep syncing in realtime. */
export interface CollabLinkResponse {
  /** The member's linked local folder (canonical), or null when not yet linked. */
  localPath: string | null
}

/** One pending in-app collab INVITE addressed to the SIGNED-IN user: a project
 *  shared WITH them that they do NOT own. Built server-side (GET
 *  /api/collab/invites) from og_project_members read under the user's OWN JWT —
 *  RLS ("og members read roster": private.og_is_member) returns only the rosters
 *  of projects the caller belongs to (matched by uid OR JWT email), so a caller
 *  can never see an invite addressed to someone else; "for me" is enforced by the
 *  database, not a query param. The first NOTIFICATION source (the Ground お知らせ
 *  bell — see {@link AppNotification}). */
export interface CollabInviteForMe {
  /** collabProjectId (og_projects.id) — the room key; the "open" action hands it
   *  to the member open-flow (setOpenShared) to view the shared project. */
  collabProjectId: string
  /** Owner-set, member-visible SHARED NAME (og_projects.label); null if unset. */
  label: string | null
  /** Email of the owner who invited them (the roster's owner row); null when it
   *  can't be resolved. */
  inviterEmail: string | null
  /** Epoch ms the invite (their og_project_members row) was created — for newest-
   *  first ordering. Absent if the row had no/invalid timestamp. */
  invitedAt?: number
}

/** GET /api/collab/invites — every pending collab invite for the signed-in user
 *  (projects shared WITH them they don't own). Empty when signed out /
 *  unconfigured / they have none — never an error. */
export interface CollabInvitesResponse {
  invites: CollabInviteForMe[]
}

/** POST /api/collab/accept {collabProjectId} — the invitee promotes their OWN
 *  pending email invite to accepted (the お知らせ "Join" action), via the
 *  accept_invite SECURITY DEFINER RPC. `ok:false` only on a transport/RPC error;
 *  a caller with no pending invite for the id is a no-op SUCCESS (`accepted:0`)
 *  — the RPC can only ever touch the caller's own row. */
export interface CollabAcceptResponse {
  ok: boolean
  /** Number of pending rows flipped to accepted (0 = already accepted / none). */
  accepted?: number
}

/** The kind discriminator for an in-app notification (Ground お知らせ). Only
 *  'collab-invite' exists today; the bell is built so more kinds can be added. */
export type NotificationKind = 'collab-invite'

/** One in-app notification shown in the Ground お知らせ bell/panel. Composed on
 *  the CLIENT from a notification source (today: {@link CollabInviteForMe}) so the
 *  panel can render a kind-specific row + action. `id` is the STABLE read-state
 *  key (persisted server-side via /api/notifications) — e.g.
 *  `collab-invite:<collabProjectId>` — so opening the panel marks it read and a
 *  re-login doesn't resurface it as unread. */
export interface AppNotification {
  id: string
  kind: NotificationKind
  /** Epoch ms for newest-first ordering (absent → sorts last). */
  createdAt?: number
  /** Present when kind === 'collab-invite'. */
  collabInvite?: CollabInviteForMe
}

/** GET /api/notifications — the persisted set of notification ids the user has
 *  already SEEN (home-cache: ~/.openground/notifications.json), so unread state
 *  survives a re-login (NOT localStorage). POST /api/notifications/read {ids}
 *  merges ids in (marking read is MONOTONIC — you never un-read). */
export interface NotificationStateResponse {
  readIds: string[]
}

/** GET /api/collab/ticket?path=&scope= — the short-lived, signed credential the
 *  client hands the Cloudflare Durable-Object Worker to open a collab WebSocket.
 *  ZERO-CONFIG: the loopback Hono no longer mints it — the Hono RELAYS the
 *  signed-in user's server-held Supabase access token to the operator Worker
 *  (server-to-server, never to the browser), and the Worker verifies membership
 *  and mints the ticket (the HMAC secret lives only on the Worker). The Worker's
 *  WS/asset gates then recompute the HMAC, check `expiresAt`, and check the
 *  embedded pid+scope match the requested room. Replaces the old supabase-js
 *  realtime config/token pair (the WS no longer goes through Supabase Realtime).
 *  - `wsUrl`     — the Worker's WS endpoint (env OPENGROUND_COLLAB_WS_URL); a
 *    full `wss://host[:port]` URL or a bare `host:port`.
 *  - `room`      — `<collabProjectId>:<scope>` (scope = 'board' | 'canvas:<id>').
 *  - `token`     — `base64url(JSON) + "." + base64url(HMAC_SHA256)` ticket.
 *  - `expiresAt` — epoch ms the ticket stops verifying (~60s TTL); partysocket
 *    re-runs the params callback on every reconnect so a fresh ticket is minted
 *    automatically (no manual refresh timer). */
export interface CollabTicketResponse {
  wsUrl: string
  room: string
  token: string
  expiresAt: number
}

/** A row of og_project_members — who may join a project's collab channel. The
 *  RLS allowlist; resolved server-side with the caller's own JWT. */
export interface ProjectMember {
  projectId: string
  userId?: string
  email?: string
  role: 'owner' | 'member'
  /** Acceptance state (og_project_members.status, migration 0013):
   *  - `accepted` — a full collaborator with collab access (owner seed, link
   *    self-join, owner-approved request, and every pre-0013 row).
   *  - `pending`  — an EMAIL invite the named person hasn't accepted yet:
   *    pre-confirmed identity, but ZERO collab access until they accept the
   *    in-app お知らせ. The owner's roster shows these as "invited"; access gates
   *    (getMyMembership / the Worker / the ticket route) treat them as non-members.
   *  Absent on legacy payloads → treat as `accepted` (backward compatible). */
  status: 'pending' | 'accepted'
}

/** GET /api/collab/members?path= — the project's full roster for the owner's
 *  "Collaborators" UI (read under the caller's JWT; RLS lets any member read it). */
export interface CollabMembersResponse {
  members: ProjectMember[]
}

/** A link invite's PERMISSION MODE (docs/COLLAB_ZEROCONFIG_PLAN.md §3.1):
 *  - `open`     — anyone signed-in who opens the link joins immediately (default).
 *  - `approval` — opening the link files a PENDING request the owner must approve;
 *    nobody gains access until approved. */
export type CollabInviteMode = 'open' | 'approval'

/** POST /api/collab/invite-link {path, mode?, maxUses?, memberCap?} — the owner
 *  mints a secret, time-limited invite CODE (a row in og_project_invites, 7-day
 *  expiry; migration 0007/0010). Any LOGGED-IN user who later presents the code
 *  self-joins (open) or requests to join (approval) as a member. The code IS the
 *  secret — only the project owner can mint/read it (owner-JWT RLS write).
 *  - `ok`        — false when the caller is not the owner / unconfigured / signed
 *    out / the insert failed (the client shows "try again").
 *  - `code`      — the opaque invite secret to share. Carried in an
 *    `openground://join?code=…` deep link (Track C) or pasted into "Shared with me".
 *  - `id`        — the og_project_invites row id, so the UI can revoke THIS link.
 *  - `mode`      — the permission mode the owner chose for this link.
 *  - `maxUses`   — redemption cap for this link (null/absent = unlimited).
 *  - `expiresAt` — epoch ms the code stops working (~7 days), read back from the
 *    row so the UI can show "expires in N days". */
export interface CollabInviteLinkResponse {
  ok: boolean
  code?: string
  id?: string
  mode?: CollabInviteMode
  maxUses?: number | null
  expiresAt?: number
}

/** One row of og_project_invites as the OWNER's roster lists it (the raw token is
 *  NEVER returned — only metadata + the id needed to revoke it). */
export interface CollabInviteLinkItem {
  id: string
  mode: CollabInviteMode
  /** Redemption cap (null = unlimited). */
  maxUses: number | null
  /** Redemptions so far (members joined for `open`, requests filed for `approval`). */
  useCount: number
  /** Epoch ms the link expires (absent if the row had no/invalid expiry). */
  expiresAt?: number
  /** Epoch ms the link was created (for ordering / "newest" identification). */
  createdAt?: number
}

/** GET /api/collab/invite-links?path= — the owner's live links + the project-level
 *  collaborator cap, for the manage-links roster. */
export interface CollabInviteLinksResponse {
  links: CollabInviteLinkItem[]
  /** og_projects.member_cap — max collaborators (null = unlimited). */
  memberCap: number | null
}

/** POST /api/collab/join {code} — a logged-in user redeems an invite code to
 *  join a shared project as a MEMBER (self-join via the join_with_invite SECURITY
 *  DEFINER RPC, migration 0007 — it inserts ONLY the caller, identified by their
 *  JWT uid/email). Login-required: a signed-out call enrolls no one. Returns the
 *  joined collabProjectId so the client can open the shared room immediately
 *  (the invitee has no local folder for it — this is the member-flow entry point).
 *  - `ok`              — false for an invalid/expired code, signed out, or
 *    unconfigured.
 *  - `collabProjectId` — the project just joined OR requested (present when ok).
 *  - `status`          — `joined` (open mode: now a member, open the room) or
 *    `pending` (approval mode: a request was filed, awaiting the owner). Absent on
 *    legacy/ambiguous responses → the client treats it as `joined`.
 *  - `error`           — a short, user-safe reason when not ok. */
export interface CollabJoinResponse {
  ok: boolean
  collabProjectId?: string
  status?: 'joined' | 'pending'
  error?: string
}

/** One pending entry in a project's approval queue, as the owner sees it
 *  (GET /api/collab/join-requests). The token/invite id stay server-side; the
 *  owner approves/denies by request id. */
export interface CollabJoinRequestItem {
  id: string
  /** The requester's email (lowercased identity, same as the roster). */
  email: string
  /** Epoch ms the request was filed (absent if the row had no/invalid timestamp). */
  createdAt?: number
}

/** GET /api/collab/join-requests?path= — the owner's pending approval queue. */
export interface CollabJoinRequestsResponse {
  requests: CollabJoinRequestItem[]
}

/** POST /api/collab/label {path, label} — the owner sets the member-visible
 *  SHARED NAME for a project (og_projects.label, owner-JWT RLS write). `ok` is
 *  false when not the owner / unconfigured / signed out / the update failed.
 *  `label` echoes the saved (trimmed) value; absent when cleared. */
export interface CollabLabelResponse {
  ok: boolean
  label?: string
}

/** GET /api/collab/shared-data?collabProjectId= — the member's LOCAL board cache
 *  for a FOLDER-LESS shared project (option A: ~/.openground/shared/<id>/). The
 *  authoritative source is the Y.Doc; this cache just makes the panel open
 *  instantly / offline. `data` is null when nothing is cached yet. Membership-
 *  gated. POST /api/collab/shared-data {collabProjectId, data} mirrors the
 *  doc-derived board back ({ ok }). */
export interface CollabSharedDataResponse {
  data: ProjectData | null
}

/** GET /api/collab/shared-canvas?collabProjectId=&canvasId= — a member's LOCAL
 *  cache of ONE shared canvas (cv4; ~/.openground/shared/<id>/canvas/<cid>.json).
 *  Like the board cache: the Y.Doc is authoritative, this just opens the canvas
 *  instantly/offline. Membership-gated. POST {collabProjectId, canvasId, data}
 *  mirrors the doc-derived canvas back ({ ok }). */
export interface CollabSharedCanvasResponse {
  data: CanvasFile | null
}

/** POST /api/collab/asset?path=&canvasId=&assetId= — the OWNER uploads a local
 *  canvas image's bytes to shared object storage (R2, via the Worker) and gets
 *  back the object key to write into the element's `storageKey` (u14b). The
 *  matching GET (?collabProjectId=&canvasId=&assetId=) streams the bytes back to
 *  a folder-less member. */
export interface CollabAssetUploadResponse {
  ok: boolean
  /** `<collabProjectId>/<canvasId>/<assetId>` — store on CanvasElement.storageKey. */
  storageKey: string
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

// ─── Module submissions (tester → owner review queue) ────────────────────────
// docs/CUSTOM_TABS_PLAN.md (submit → review → publish). A tester builds a custom
// tab locally and SUBMITS its source to the owner; the owner reads this PRIVATE
// queue (service-role) and approve copies the source into og_custom_modules (the
// PUBLIC marketplace) or reject drops it. Mirrors the feedback inbox: anon may
// INSERT a pending row only, the owner reads with the service-role key.

/** POST /api/module-submissions — a tester's submission of a built tab. */
export interface SubmitModuleRequest {
  name: string
  description: string
  framework: CustomModuleFramework
  source: string
}

/** GET /api/module-submissions/config — gates the submit + review surfaces.
 *  - `enabled`: anon key configured, so a tester can submit.
 *  - `canReview`: the server also has a SERVICE-ROLE key AND the signed-in
 *    account is an admin (MODULE_ADMIN_EMAILS, falling back to
 *    FEEDBACK_ADMIN_EMAILS) — the owner review inbox shows. False on the public
 *    build (no service key shipped); never echoes keys. */
export interface ModuleSubmissionsConfigResponse {
  enabled: boolean
  canReview: boolean
  /** Stable, non-secret id (hash of the Supabase url+table), emitted only when
   *  canReview, so the client scopes its "last seen" unread marker per source. */
  sourceId?: string
}

/** One row of the review queue, read back via the service-role key (owner only,
 *  GET /api/module-submissions). `source` is present on the single-row fetch
 *  (the review preview/diff) and omitted from the list payload to keep it light. */
export interface ModuleSubmissionItem {
  id: string
  created_at: string
  /** Display-only (client-supplied at submit, like feedback.email); not trusted. */
  submitter_email: string | null
  name: string
  description: string
  framework: CustomModuleFramework
  status: 'pending' | 'approved' | 'rejected'
  /** The published og_custom_modules row id, set when approved. */
  published_remote_id: string | null
  /** The submitted component source — included only on the single-row fetch. */
  source?: string
}

/** GET /api/module-submissions — owner inbox payload (newest first). `truncated`
 *  is true when more than the cap (200) of rows exist. */
export interface ModuleSubmissionsResponse {
  items: ModuleSubmissionItem[]
  truncated: boolean
}

/** POST /api/module-submissions/:id/approve — the new published marketplace id. */
export interface ApproveSubmissionResponse {
  remoteId: string
}

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
  /** Sentinel: set once the "Compact Instructions" section has been added to
   *  `~/.claude/CLAUDE.md` (compactInstructionsInstall.ts). Its ABSENCE is the
   *  only thing that licenses adding the block; once set, a missing block means
   *  the user deleted it and OPEN GROUND stays out permanently. (A lost or
   *  corrupted settings.json therefore costs one re-add — chosen over the
   *  alternative of never installing on a fresh machine.) Server-owned, and
   *  deliberately NOT in USER_SETTINGS_KEYS. */
  compactInstructionsInstalledAt?: string
  /** Sentinel: set once the one-shot "Share via Git" evacuation has run —
   *  legacy in-repo `.openground/` data is copied back to the central store, so
   *  the (now-removed) feature never reads the repo again. */
  shareEvacuatedAt?: string
  /** Canonicalized project paths whose owner turned Swarm **Autonomy ON** and
   *  never turned it OFF. This is the ONLY autonomy state that survives a
   *  restart — and it is a REMINDER, not an auto-resume: the engine itself is
   *  in-memory and always relaunches OFF (fail-safe, so a crash / auto-update /
   *  reboot never silently re-spawns workers). On the next launch the Swarm tab
   *  reads this to show a passive "autonomy was on — resume?" prompt; nothing
   *  runs until the owner clicks it. Server-owned (added by `startOrchestrator`,
   *  cleared by `stopOrchestrator`) — deliberately NOT in USER_SETTINGS_KEYS, so
   *  the untrusted POST /api/settings route can never write it. */
  swarmAutonomyOn?: string[]
  /** Canonicalized project paths whose owner EXPLICITLY paused the Swarm engine
   *  (Autonomy OFF) and never turned it back ON. The persisted half of the
   *  engine's in-memory `manualStop` flag, so "the owner stopped this by hand"
   *  survives a server restart and stays OBSERVABLE from outside (the 0707
   *  twin-dispatch root cause was exactly this state being invisible). It is a
   *  RECORD, never an auto-resume — and its effect is only ever MORE stopping:
   *  the opt-in auto-drain sweep (OPENGROUND_SWARM_AUTODRAIN=1) skips a listed
   *  project even after a restart wipes the in-memory flag. Server-owned (added
   *  by `stopOrchestrator`, cleared by `startOrchestrator`) — deliberately NOT
   *  in USER_SETTINGS_KEYS, so the untrusted POST /api/settings route can never
   *  write it. */
  swarmManualStop?: string[]
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
  /** Swarm execution mode (token budget) — see {@link ExecutionMode}. Unset ⇒
   *  {@link DEFAULT_EXECUTION_MODE} ('optimize'). Sets the model/effort/parallelism
   *  every in-app swarm role launches at, with one toggle. User-settable. */
  executionMode?: ExecutionMode
  /** Which model tiers the swarm may launch on at all ("使用可能モデル") — the
   *  owner's PERMANENT hard mask, sitting beside {@link executionMode} because it
   *  bounds what every mode can pick. Absent / partial ⇒ the missing tiers are
   *  usable ({@link DEFAULT_SWARM_ALLOWED_MODELS}). Unlike the in-memory cooling
   *  table (swarmQuota) this survives a restart / self-update, so "fable is spent
   *  for the week" stays told. At least one tier must stay ON — `setUserSettings`
   *  refuses an all-OFF patch (a swarm with no model can only park). User-settable. */
  swarmAllowedModels?: Partial<SwarmAllowedModels>
  /* NOTE (2026-08-13): `swarmWorkerRuntime` — the worker runtime dial + its
   * `sdkMaxWorkers` slot cap — was DELETED from this type. Workers are
   * SDK-only: the PTY worker runtime is gone, so there is nothing for a dial
   * to switch to and nothing for a cap to budget (a spawn that cannot
   * establish the SDK runtime fails fast instead of degrading). A stale
   * `swarmWorkerRuntime` key in an existing settings.json is IGNORED, never an
   * error: settings.json has no schema validation, readJson is tolerant, and
   * POST /api/settings silently drops the key (it left USER_SETTINGS_KEYS). */
  /** WHICH RUNTIME the COMMANDER desk (司令官) launches on — dialled because it
   *  spends something a worker never did: the owner's phone window.
   *
   *  `'pty'` (and any unrecognised value) ⇒ the commander is an interactive
   *  `claude` PTY, exactly as before, reachable from a phone through
   *  `--remote-control`. ABSENT ⇒ `'sdk'` since 2026-08-02. `'sdk'` ⇒ it
   *  runs on the Agent SDK: structured transcript, liveness that is a fact
   *  rather than an inference, and notices that no longer have to ERASE the
   *  owner's half-typed input to be delivered — but NO Remote Control, because
   *  the flag does nothing outside an interactive REPL.
   *
   *  That is why this is its own switch, and why its default moved LAST (a day
   *  after the worker's): defaulting to SDK is only safe once the SUPPLY desk
   *  (which stays on a PTY) can answer 「状況」 as well as take orders, since the
   *  commander then stops being the owner's phone window. That window was moved
   *  first, which is what the ordering of stage 3 was for.
   *  See docs/SDK_CLIENT_INVESTIGATION.md §13 and skills/supply/SKILL.md.
   *
   *  Flipping it back does not disturb a desk already running; it decides what
   *  the NEXT spawn builds, and the one-desk-per-project guard spans both pools
   *  so a project can never end up with one of each. */
  swarmManagerRuntime?: {
    mode: 'pty' | 'sdk'
  }
  /** The owner's chosen left-to-right order of the Swarm tab's sub-view strip
   *  ({@link SWARM_PANE_IDS} — 補給官 / 司令官 / ワーカー / 監督). PERSONAL UI
   *  state, kept central in `~/.openground/settings.json` (never the user's
   *  repo), exactly like the per-project `ProjectData.tabOrder` but GLOBAL: the
   *  four roles are identical across every project, so one order serves them all
   *  — hence it sits beside {@link executionMode} / {@link swarmAllowedModels},
   *  the sibling swarm settings edited from the SAME header row over
   *  POST /api/settings. Absent / partial ⇒ the shipped order (supply first);
   *  unknown/duplicate ids are reconciled away on read (`effectiveTabOrder`), so
   *  a stale value can never strand a pane. The FIRST id opens by default.
   *  User-settable (narrowed to the known pane ids by `setUserSettings`). */
  swarmPaneOrder?: SwarmPaneId[]
  /** UI + prompt language. OPEN GROUND is English-first: unset means English.
   *  'ja' switches the UI strings AND the prompts sent to the spawned Claude
   *  (so its summaries/replies come back in Japanese). Persisted from the UI
   *  language toggle so the server can pick the matching prompt language. */
  language?: 'en' | 'ja'
  /** Colour theme (第三弾「計器盤」2026-08-03). Unset means 'light' (the
   *  original paper palette); 'dark' is the night instrument palette. Applied
   *  client-side as html[data-theme] (src/lib/theme.ts) and mirrored to
   *  localStorage('og-theme') for a flash-free first paint. User-settable;
   *  setUserSettings narrows to the two literals and DROPS anything else. */
  theme?: 'light' | 'dark'
  /** Completion chime (2026-08-03): ring when a claude turn finishes on an
   *  ATTENDED desk (Terminal panes, board runs — never swarm machinery, which
   *  launches with OPENGROUND_UNATTENDED=1). Played by the managed Stop hook
   *  (scripts/openground-hook.js), which re-reads settings.json per turn — so
   *  the toggle applies to the next chime with no reinstall. Default OFF;
   *  hooksInstall's one-shot migration seeds it ON for users whose settings
   *  carried the old hand-added `afplay Glass.aiff` Stop hook. */
  soundOnDone?: boolean
  /** Chime volume, 0–100 (afplay -v). Unset ⇒ 100 (the legacy hook's loudness).
   *  Narrowed to a clamped integer by setUserSettings. */
  soundOnDoneVolume?: number
  /** Hands-free updates (2026-08-03, owner request "毎回するのが面倒"). DEFAULT ON
   *  as of 2026-08-15 — unset means ON, and only an explicit `false` turns it
   *  off. (The owner asked a second time: 「こっちで命令するんじゃなくて」. The
   *  first ask produced this feature, defaulted OFF, and it consequently never
   *  ran for them.) Off = the conservative flow: auto-download + an explicit
   *  restart dialog. On removes the dialog: the update downloads silently
   *  and is APPLIED automatically, but only at a provably safe moment — the
   *  window has been unfocused ≥30min AND the server's restart-safety probe
   *  (GET /api/update/restart-safety) reports no claude generating and no open
   *  user terminal panes. Any app quit also applies it (autoInstallOnAppQuit).
   *  Read by the Electron MAIN process straight from settings.json per tick
   *  (electron/autoUpdatePolicy.js — the lockdown.js pattern), so toggling
   *  takes effect without a restart. Stored as a REAL boolean (narrowed). */
  autoUpdate?: boolean
  /** Owner-only experiment toggles (hidden, default off). The RAW stored
   *  switches — the resolved gate ANDs each with the owner role server-side
   *  (see {@link ExperimentsResponse} / resolveExperiments), so a non-owner who
   *  forges a `true` here never actually opens the gate. Absent ⇒ all off. */
  experiments?: Partial<ExperimentFlags>
  /** LOCAL owner unlock for the SWARM control plane only (hidden, default off;
   *  no UI — see docs/SECURITY.md). `true` opens every /api/swarm route and the
   *  Swarm tab WITHOUT an app login, for machines that run login-disabled
   *  (業務モード). Deliberately NOT in USER_SETTINGS_KEYS (store.ts), so
   *  POST /api/settings can never set it — enabling means hand-editing
   *  ~/.openground/settings.json (or env OPENGROUND_LOCAL_OWNER=1). Safe
   *  because the swarm owner gate is a feature-visibility flag, not a security
   *  boundary (POST /api/terminal is already ungated locally — swarmGate.ts).
   *  Scope: swarm only — marketplace/custom-tab roles ignore it. */
  swarmLocalOwner?: boolean
  /** User opt-in for the SWARM control plane, for ALL users (not just the
   *  owner) — the public "turn it on if you want it" switch (default off).
   *  Distinct from `swarmLocalOwner` (hand-edit-only, login-free) and from the
   *  owner `experiments.swarm` toggle: this one is user-settable via
   *  POST /api/settings and resolves the swarm gate for anyone. RESOLVED
   *  server-side to macOS ONLY (isSwarmOptInEnabled — swarmGate.ts): the
   *  deterministic PreToolUse guard is unmeasured on Windows and there is no OS
   *  sandbox layer there, so a non-macOS opt-in stays closed. Narrowed to a
   *  literal boolean on save (store.ts). Safe to expose because the swarm gate
   *  is a feature-visibility flag, not a security boundary (POST /api/terminal
   *  is already ungated locally — swarmGate.ts / docs/SECURITY.md); the
   *  in-app warning discloses subscription cost + permission-bypass claude. */
  swarmOptIn?: boolean
  /** The PUBLIC persona opt-in (all users, not just the owner). Like
   *  {@link swarmOptIn} but for the Persona surface — user-settable via
   *  POST /api/settings, narrowed to a literal boolean on save (store.ts).
   *  ALL PLATFORMS (unlike swarmOptIn's macOS gate): a persona turn is a
   *  single marker-scraped `claude` run with a deny-list (no Bash/Task/writes
   *  outside a scratch dir — personaChat.ts), NOT an unattended worker, so it
   *  carries no PreToolUse-guard / OS-sandbox dependency. Safe to expose:
   *  loopback-only routes over the user's OWN corpus in ~/.openground/ (no
   *  cross-user data); the in-app warning discloses subscription cost +
   *  that a persona turn runs claude with permission prompts skipped. */
  /** WordPress publishing target for research reports (blogPublish.ts) — the
   *  owner's own self-hosted WP site. Configuring it IS the opt-in: absent ⇒
   *  the publish sweep does nothing. `appPassword` is a WordPress APPLICATION
   *  password (Users → Profile → Application Passwords), never the login
   *  password — revocable on the WP side at any time. Stored plaintext in
   *  settings.json: same trust model as the rest of ~/.openground on this
   *  local single-user machine.
   *
   *  `null` exists ONLY on the wire: POSTing `wordpress: null` clears the
   *  target (setUserSettings turns it into a dropped key), and the persisted
   *  file never holds null — readers therefore see an object or undefined,
   *  and `settings.wordpress?.baseUrl` handles the whole union. */
  wordpress?: WordPressSettings | null
  personaOptIn?: boolean
  /** Work mode (lockdown) — the one-toggle kill switch for every NON-Anthropic
   *  external egress, for running OPEN GROUND on a confidential work machine.
   *  ON ⇒ auto-update checks, the in-app release check, feedback, marketplace,
   *  Supabase login/refresh, and collab are all disabled server-side (each
   *  surface reports itself unavailable), and the server process refuses any
   *  other external fetch (src/lib/server/lockdown.ts). The claude CLI —
   *  the user's Anthropic subscription — is deliberately NOT touched. Absent ⇒
   *  off (existing behaviour, nothing changes). User-settable. */
  lockdownMode?: boolean
}

/** Owner-only experiment ids — hidden features gated behind the owner role AND
 *  a per-experiment settings toggle (default off). They never ship in release
 *  notes or the in-app manual; the registry hides their modules entirely until
 *  the gate is open. `swarm` = the in-app swarm orchestration surface;
 *  `sandbox` = wrap OPEN GROUND-launched `claude` in a macOS Seatbelt sandbox
 *  (cwd-confined writes + credential read-denies) and run it prompt-free
 *  (permission bypass) — the OS sandbox is the safety net (macOS only; see
 *  src/lib/server/sandbox.ts + docs/SANDBOX_EXPERIMENT.md);
 *  `persona` = the Persona tab, where the owner reads and corrects the
 *  you-corpus that the overseer runs on (src/components/canvas/modules/
 *  PersonaModule.tsx + src/lib/server/youCorpus.ts). */
export type ExperimentId = 'swarm' | 'sandbox' | 'persona'

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
  /** The PUBLIC swarm opt-in (all users, not just the owner — Settings.swarmOptIn).
   *  `available` = this machine can opt in at all (macOS only; the guard is
   *  unmeasured on Windows). `enabled` = the user has opted in AND it is
   *  effective. When `available` is false the Settings toggle is hidden; the
   *  owner path (eligible + experiments.swarm) is unaffected. */
  swarmOptIn: { available: boolean; enabled: boolean }
  /** The PUBLIC persona opt-in (all users — Settings.personaOptIn). `available`
   *  is true on every platform (persona has no unattended-worker guard, unlike
   *  swarm); `enabled` = the user opted in. The owner path (eligible +
   *  experiments.persona) is unaffected. */
  personaOptIn: { available: boolean; enabled: boolean }
}

/** The runtime the commander dial RESOLVES TO on this machine right now,
 *  computed by the server and served read-only on {@link SettingsResponse}.
 *
 *  ⚠ THE PANEL MUST DRAW THIS, NOT DERIVE ITS OWN. The Swarm tab used to read
 *  the raw dial keys off the same response and re-implement the server's rule
 *  client-side. That copy produced TWO display-vs-truth defects on 2026-08-02
 *  alone — an absent dial drawn ON while dispatch ran PTY, and a broken
 *  settings.json drawn ON while the commander fell to the kill switch —
 *  because a raw key cannot distinguish "never written" from "the file is
 *  unreadable", and a copied rule does not move when the rule does. This field
 *  comes from the very reader desk launch consults
 *  (`store.getManagerRuntimeDial`), so the toggle and the server cannot
 *  disagree by construction.
 *
 *  NOT a settings key: it is computed per request and must never appear in
 *  `USER_SETTINGS_KEYS`.
 *
 *  (Until 2026-08-13 this also carried `worker` + `workerCap` for the worker
 *  dial. Workers are SDK-only now — the worker dial and its slot cap were
 *  deleted, so the shape narrowed to the one surviving switch. Client and
 *  server ship as one Electron bundle, so the break lands in a single release.) */
export type RuntimeDialsEffective = {
  manager: 'pty' | 'sdk'
}

/** GET /api/settings response: the persisted {@link Settings} plus a
 *  NON-persisted display-name suggestion (`git config --global user.name`,
 *  null when git is missing or user.name is unset) and the server's own
 *  {@link RuntimeDialsEffective}. The client shows the suggestion only as the
 *  input placeholder — neither field is ever written into settings.json. */
export type SettingsResponse = Settings & {
  suggestedDisplayName: string | null
  runtimeDialsEffective: RuntimeDialsEffective
}

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
  /** True when work mode (lockdown) suppressed the GitHub fetch — the client
   *  renders "disabled by work mode" instead of an empty/error list. */
  lockdown?: boolean
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
/** A Canvas AI job's lifecycle. 'queued' = accepted but waiting its turn behind
 *  another run in the SAME project (no claude session yet, so it's OFF the global
 *  beacon and still cancellable); 'running' = a claude session is live; then a
 *  terminal 'done' / 'error'. Runs in DIFFERENT projects never queue behind each
 *  other (the engine serializes per project). */
export type CanvasAiJobStatus = 'queued' | 'running' | 'done' | 'error'

/** POST /api/canvas/ai/generate — start a "design as elements" job: claude
 *  authors NATIVE canvas elements (frame/shape/text/sticky), not code, so the
 *  result is hand-tweakable piece by piece (Figma-lite). On completion the
 *  elements are appended to `canvasId` at a position that doesn't overlap its
 *  existing content, server-side. */
export interface GenerateCanvasAiRequest {
  path: string
  canvasId: string
  prompt: string
  /** CLI model alias (a SWARM_MODEL_TIERS member). Absent/unknown/mask-denied
   *  ⇒ the server's canvas default (sonnet) — narrowed server-side. */
  model?: string
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
 *  "Claude is designing" beacon (App polls it like the terminal beacon). Queued
 *  (waiting their turn), done, and errored jobs are excluded — only a live claude
 *  session lights the beacon. */
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
   *  sees in the CLI's settings dialog and on claude.ai. This is the ONLY
   *  source of the gauge's displayed % (the local `tokens` above are absolute
   *  counts — there's no public cap to turn them into a cap-relative %). When
   *  `session` is null, `status` says WHY (signed out / not installed / scrape
   *  failed) so the HUD shows an explicit reason + the local estimate instead
   *  of a silent "—". `null`/absent only before the first fetch resolves. */
  cli?: {
    session: { pct: number; resetsAt: string } | null
    weekAll: { pct: number; resetsAt: string } | null
    /** The `Current week (<Model> only)` rows — a weekly cap owned by ONE model
     *  rather than the account-wide pool, so a dry flagship is visible even
     *  while `session` / `weekAll` still look healthy. `model` is the TUI's own
     *  label ("Sonnet", "Fable 5"): which model has its own row is a property of
     *  the account's plan, never a fixed list. Optional — absent from payloads
     *  produced before this field existed. */
    weekModels?: { model: string; pct: number; resetsAt: string }[]
    capturedAt: string
    status: 'ok' | 'signed-out' | 'not-installed' | 'scrape-failed'
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

/** POST /api/project/git-init request — one-click "set up git here" for a
 *  registered project folder that has no repo yet (the Swarm tab's env-preflight
 *  banner offers it on the `notAGitRepo` issue). */
export interface GitInitRequest {
  path: string
}

/** POST /api/project/git-init response. The route runs `git init` + `git add
 *  -A` + an initial commit (`--allow-empty`, so HEAD exists even in an empty
 *  folder — a swarm worktree needs a HEAD to branch from; creating that HEAD is
 *  the whole point of committing here). Already-a-repo answers 409, any git
 *  failure 500 `{ error }` — this shape is the success case only. */
export interface GitInitResponse {
  ok: true
  /** Always true on success — the initial commit (HEAD) is the deliverable. */
  committed: true
  /** The commit fell back to the built-in identity ("OPEN GROUND"
   *  <openground@localhost>) because git has no user.name/user.email
   *  configured on this machine. Absent when the user's own identity worked. */
  fallbackIdentity?: boolean
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
  /** Always `''` since 2026-08-13: a worker is an Agent SDK session, which has
   *  no PTY. The field survives so every consumer of the identity invariant
   *  (pty ⇔ terminalId / sdk ⇔ sdkSessionId — workerRuntime.ts) keeps reading
   *  the same shape while legacy PTY roster ROWS still exist on disk. */
  terminalId: string
  agentSessionId: string
  worktree: string
  branch: string
  /** HOW this worker was launched. SDK-ONLY since 2026-08-13 (owner decision —
   *  the PTY worker and its fallback were deleted): a spawn either returns
   *  `'sdk'` or THROWS (SdkWorkerUnavailableError → the engine's spawn-failure
   *  backoff). Optional purely so pre-SDK fakes keep compiling; absence on a
   *  persisted ROSTER row still reads as the legacy `'pty'` (workerRuntime.ts). */
  runtime?: 'sdk'
  /** The Agent SDK session id (the worker's one live handle). */
  sdkSessionId?: string
  /** The CLI `--model` alias this worker's `claude` was actually launched with
   *  (mode-resolved THROUGH the quota fallback — see resolveSwarmModelEffort).
   *  The engine records it on its {@link OrchestratorWorker} so a later
   *  rate-limit sighting can mark the RIGHT tier cooling (swarmQuota). Optional:
   *  older callers/fakes without it simply leave the sighting unattributed. */
  model?: string
  /** The `--effort` the worker launched at, beside {@link model}. Display-only
   *  (the cooling table keys off the model alone) — it exists so the Board can
   *  say `opus/high` instead of a private weight word (owner, 2026-08-26). */
  effort?: ClaudeEffort
}

/** POST /api/swarm/worktree/remove — whether the worktree was torn down, with
 *  a `reason` when it was kept (dirty/locked without force, or not a central
 *  worktree). */
export interface RemoveSwarmWorktreeResponse {
  removed: boolean
  reason?: string
  /** The removal was REFUSED because a desk is still live in that directory —
   *  "ask again", not "it failed". Distinct from every other `removed:false` so a
   *  caller can honour the retry contract the refusal promises without matching on
   *  `reason` text. The engine keeps such a worker in its roster and retries on a
   *  later pass; dropping it strands a live claude in a worktree nobody owns (and,
   *  on the SDK pool, holds its slot for the life of the process). */
  stillOccupied?: boolean
  /** Present on a CONFIRMED non-force removal (the commander's post-merge sweep
   *  lane — og-manage §マージ step 7): the commander-integration detection that
   *  reconnects the engine self-update trigger (selfUpdateOnIntegrate.ts). */
  selfUpdate?: SelfUpdateFireResult
}

/** Result of the commander-integration detection that runs after a confirmed
 *  non-force worker-worktree removal (selfUpdateOnIntegrate.ts): did the removed
 *  worker's branch turn out to be integrated, and did the self-update trigger
 *  actually fire. */
export interface SelfUpdateFireResult {
  /** The removed worker's branch tip was reachable from the trunk (origin/main,
   *  else local main) — i.e. the commander integrated it before cleaning up. */
  detected: boolean
  /** The engine self-update IPC trigger actually fired — requires the armed
   *  own-source run (selfUpdateSignal.ts gates); false in every other context. */
  requested: boolean
}

/** POST /api/swarm/supply — a spawned in-app SUPPLY (補給官) session: the claude
 *  PTY id + its session id. Unlike a worker it has NO worktree — it runs in the
 *  project's PRIMARY checkout cwd, running the /supply skill to turn the user's
 *  vague requests into observable Board:todo cards. It only talks to the user +
 *  writes the Board; it never edits code or pushes (so no worktree to return, and
 *  stopping it is a plain PTY kill). */
export interface SpawnSwarmSupplyResponse {
  terminalId: string
  agentSessionId: string
  /** true ⇒ this is the project's PREVIOUS supply conversation, resumed
   *  (`claude --resume`): its session id was persisted centrally and claude still
   *  had the transcript, so the desk kept its memory across the app restart. false
   *  ⇒ a brand-new conversation — nothing persisted yet, the stored session was
   *  gone/corrupt/still open, or `fresh` was requested (swarmSessions.ts). */
  resumed: boolean
  /** true ⇒ NOTHING was spawned: a supply desk was already live in this project,
   *  so `terminalId` names THAT desk. The one-desk-per-project invariant
   *  (swarmSupply.spawnSwarmSupply) — two 補給官 desks means the second spawn
   *  mints a fresh session id and OVERWRITES the project's single stored slot,
   *  so the first desk's days-long conversation is not skipped but FORGOTTEN
   *  while its PTY keeps running. Absent/false ⇒ a desk was launched. An older
   *  server never sends it; a client must read absent as false. */
  reused?: boolean
}

/** POST /api/swarm/manager — a spawned in-app COMMANDER (司令官) CONVERSATION
 *  session: the claude PTY id + its session id. Like the supply officer (and
 *  unlike a worker) it has NO worktree — it runs in the project's PRIMARY checkout
 *  cwd, running the /og-manage skill so the owner can talk to the commander
 *  (status / merge / advise) interactively. It complements the AUTONOMOUS engine
 *  (the orchestrator behind /api/swarm/orchestrator): the engine is the unattended
 *  drain+integrate loop, this is the human-in-the-loop conversational counterpart.
 *  Stopping it is a plain PTY kill (no worktree). */
export interface SpawnSwarmManagerResponse {
  /** PTY commander ⇒ its terminal id. SDK commander ⇒ EMPTY — the identity
   *  invariant is pty ⇔ terminalId, sdk ⇔ sdkSessionId, never both (the same
   *  rule workerRuntime.ts keeps for workers). Branch on `runtime`, never on
   *  whether one of the two ids happens to be truthy. */
  terminalId: string
  /** Which runtime carries this desk. Absent ⇒ 'pty' (every response predating
   *  the commander dial). */
  runtime?: 'pty' | 'sdk'
  /** Present only for an SDK commander: its {@link SdkSessionInfo} id, the
   *  handle /api/sdk-session/* is addressed by. */
  sdkSessionId?: string
  /* NOTE (2026-08-13): `fellBackBecause` was DELETED from this response with
   * the runtime auto-fallback. An SDK dial now either seats an SDK desk or the
   * POST fails with the reason in the error body — a desk can no longer come
   * back on a different runtime than the dial chose, so there is nothing to
   * explain on the success path. */
  agentSessionId: string
  /** true ⇒ this is the project's PREVIOUS commander conversation, resumed
   *  (`claude --resume`) — see SpawnSwarmSupplyResponse.resumed. NOTE the asymmetry
   *  a resumed commander must respect: its CONVERSATION survived the restart, but
   *  the ENGINE's in-memory state (worker roster / reviews / quota cooling) did
   *  NOT. That is why a resumed commander is ordered to re-read the Board and the
   *  worker list before it says anything (swarmManager.MANAGER_RESUME_INJECTION). */
  resumed: boolean
  /** true ⇒ NOTHING was spawned: a commander desk was already live in this
   *  project, so `terminalId` names THAT desk. The one-desk-per-project invariant
   *  (swarmManager.spawnSwarmManager) — a project may never hold two commanders,
   *  because two desks integrating one trunk is the 2026-07-15
   *  concurrent-integration hazard, and eleven of them accumulated on 2026-07-19.
   *  Absent/false ⇒ a desk was launched. */
  reused?: boolean
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
  /** HOW this worker's `claude` is running. ABSENT ⇒ `'pty'` — every worker
   *  written before this field existed is a PTY one, and the resolver
   *  (`workerRuntime.workerRuntimeKind`) treats absence as such. See
   *  docs/SDK_WORKER_MIGRATION_PLAN.md. */
  runtime?: 'pty' | 'sdk'
  /** The Agent SDK session id, present ONLY for `runtime: 'sdk'`. The identity
   *  invariant (workerRuntime.ts) is: pty ⇔ terminalId, sdk ⇔ sdkSessionId —
   *  never both, never a prefix-encoded single field. */
  sdkSessionId?: string
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
  /** The CLI `--model` alias the worker launched with (from
   *  {@link SpawnSwarmWorkerResponse.model}) — the tier a rate-limit sighting
   *  on this worker attributes to the quota cooling table (swarmQuota). Absent
   *  on workers spawned before this was recorded; such a sighting still HOLDS
   *  the worker, it just can't mark a tier. */
  model?: string
  /** The `--effort` this worker launched at — carried beside {@link model} so
   *  the Board card can name the actual run, not a weight bucket. */
  effort?: ClaudeEffort
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
  /** ISO timestamp of the LAST 差し戻し (rework) that sent this worker's card
   *  review→doing — set by the engine's own integrate rework, OR stamped by the
   *  monitor when it OBSERVES an external 差し戻し (Board API {rework} / a UI drag,
   *  which bypass this in-memory roster; the monitor detects stage:'done' with the
   *  card back in 'doing' and re-arms the worker). The monitor suppresses
   *  re-promoting the card until the worker emits a FRESH completion sign (a
   *  heartbeat strictly newer than this) — so a just-reworked worker gets time to
   *  actually fix the issue instead of being instantly re-promoted on its stale
   *  pre-rework readyToMerge:true (which would burn the rework budget by
   *  wall-clock). Cleared on a fresh-heartbeat promote. In-memory only; absent for a
   *  never-reworked worker. */
  reworkAt?: string
  /** ISO timestamp this worker FIRST reached ready — the pass its card was first
   *  OBSERVED sitting in 'review'/'done'. Bound to WHERE THE CARD IS, not to whose
   *  write moved it there: the engine's own promote and a commander hand-move
   *  (`move <id> review`, og-manage's documented first move on READY, which usually
   *  beats the promote tick) both stamp it. Set once and never cleared (a 差し戻し
   *  sends the card back, but the fact that this worker already produced integrable,
   *  committed work stands). The engine's "has this worker ever delivered?" flag: a
   *  worker
   *  carrying it is NEVER labelled a 暴走 (runaway) and its card is never parked in
   *  the owner's 'blocked' column by the execution-ceiling path — see
   *  swarmOrchestrator's `integration-wait` recovery reason (2026-07-18: a ready
   *  worker was torn down as "runaway 91m" because its 28 minutes of 統合待ち
   *  counted as work, and its card landed in blocked). In-memory only; absent for
   *  a worker that has not finished anything yet. */
  readyAt?: string
  /** The worker's `claude --session-id` UUID (swarmWorker's agentSessionId),
   *  captured at spawn. Card 3 (docs/ENGINE_PERSISTENCE_PLAN.md §3) persists it in
   *  the roster so a restart's card-4 `claude --resume` can reattach the same
   *  conversation; the engine itself never reads it back. Absent on workers spawned
   *  before this was recorded (older fakes/callers). In-memory + roster only. */
  sessionId?: string
  /** How many 差し戻し (rework) rounds this worker's card has taken — snapshotted
   *  from the card's `reworkCount` when the Board is in hand, else the last cached
   *  value. Card 3 persists it in the roster (plan §3). Display/accounting only;
   *  never gates the engine. Absent until first observed. In-memory + roster only. */
  reworkCount?: number
}

/** One row of GET /api/swarm/workers — the SERVER-TRUTH worker list. Built by
 *  cross-referencing three sources the server itself owns (live PTYs in the
 *  terminal pool, the commander engine's own dispatch records, and the
 *  heartbeat files `swarm-beat.sh` writes) so a worker started ANY way —
 *  engine dispatch, the Board 実行 button, or a direct
 *  `POST /api/swarm/worker` (curl / an external caller) — shows up the same
 *  way. Identity is the worktree path (one worker per isolated worktree);
 *  `terminalId` is present only while its `claude` PTY is still alive, so its
 *  absence is exactly the "dead worker" case the restart affordance targets. */
export interface SwarmWorkerRecord {
  /** Absolute path of the worker's isolated worktree — the stable identity. */
  worktree: string
  /** The `swarm/*` branch checked out there. */
  branch: string
  /** The worker's `claude` PTY id, present only while that PTY is alive. */
  terminalId?: string
  /** HOW this worker's `claude` is running. ABSENT ⇒ `'pty'`, so a roster.json
   *  written before this field existed keeps meaning what it meant. */
  runtime?: 'pty' | 'sdk'
  /** The Agent SDK session id, present ONLY for `runtime: 'sdk'`. */
  sdkSessionId?: string
  /** The Board card this worker drains, when known (engine-dispatched, or a
   *  curl caller that passed `taskId`). */
  taskId?: string
  /** The card title at dispatch time, when known — display-only. */
  taskTitle?: string
  /** ISO timestamp the engine dispatched it — absent for a worker the engine
   *  never tracked in memory (a curl-direct spawn). */
  startedAt?: string
  /** Coarse lifecycle stage — present ONLY for a worker the commander engine
   *  is actively tracking; its absence marks a worker outside engine
   *  ownership (curl-direct or a UI restart), which is what makes it
   *  terminable/restartable from the Swarm worker tab. */
  stage?: OrchestratorWorkerStage
  /** The worker's self-reported heartbeat phase (swarm-beat.sh), display-only. */
  phase?: string
  /** The worker's one-line heartbeat summary, display-only. */
  note?: string
  /** ISO timestamp of the worker's latest heartbeat, display-only. */
  heartbeatAt?: string
  /** It declared itself integration-ready (heartbeat readyToMerge). */
  ready?: boolean
  /** It explicitly reported a blocker / a blocked phase. */
  blocked?: boolean
  /** The raw blockers text, when non-empty. */
  blockers?: string
  /** The `--model` alias this worker is actually running on, when the engine
   *  tracked the dispatch. ABSENT for a worker outside engine ownership (a
   *  curl-direct spawn) and for pre-2026-08-26 roster rows — the Board simply
   *  says nothing rather than guessing a tier. */
  model?: string
  /** The `--effort` beside {@link model}, same provenance and same absence rule. */
  effort?: ClaudeEffort
}

export interface SwarmWorkersResponse {
  workers: SwarmWorkerRecord[]
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
 *  commander could land (Card③). Computed each pass WITHOUT mutating git so
 *  the dashboard can show "統合可" while the engine itself never lands anything
 *  (integration is the commander's — the engine only wakes it; the old
 *  auto-integrate toggle was retired 2026-07-16).
 *   - 'ff'       → a clean fast-forward (or already merged) — finalizable now.
 *   - 'rebase'   → diverged from the trunk; needs a rebase (which MAY conflict).
 *   - 'conflict' → an integration attempt hit a rebase conflict and was
 *                  aborted; needs manual integration (mirrors the card's
 *                  persisted integrationConflict stamp).
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
  /** Set when the adversarial-review panel froze this card to needs-human after
   *  consecutive no-majority passes: the streak's accumulated abstention tallies
   *  (`lens(cause)×N, …` — e.g. `correctness(timeout)×3, regression(timeout)×3`),
   *  so the human resolving the freeze sees WHICH lens abstained WHY how often
   *  instead of a bare 「多数決つかず」. In-memory (engine) state — resets with
   *  the defer streak (a new commit) and on engine restart. */
  abstainSummary?: string
  /** Set when the HIGH-RISK FORCE-HOLD gate withheld auto-integration because the
   *  branch's diff touches release/CI/signing/dependency/secrets-grade paths
   *  (HIGH_RISK_PATHS — the same set as the commander's manual-merge rule): the
   *  matched repo-relative paths. Lets the API/dashboard distinguish this hold
   *  from the other 'conflict'-status causes without reading the engine log.
   *  In-memory (engine) state — cleared when a new commit stops touching the
   *  set, and on engine restart. */
  highRiskFiles?: string[]
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
 *   - 'unowned-doing'   — the SIBLING of the above, and the one that used to be
 *                         silent: same card, same missing worker, but its
 *                         worktree is STILL ON DISK. Measured 2026-08-27 —
 *                         workers dispatched before an app restart finished
 *                         afterwards, boot adoption had declined them, and
 *                         nothing owned the cards: `GET /api/swarm/workers`
 *                         listed them ready while `GET /api/swarm/orchestrator`
 *                         showed `workers:[]`, for hours, with no row anywhere.
 *                         The DELIVERED ones are now recovered automatically
 *                         (promoted to review, which wakes the commander), so
 *                         this row is the ambiguous remainder — no hand-over
 *                         sign, or a card already sent back once — which needs a
 *                         human.
 *   - 'worktree-missing'— a worker the engine still counts has lost its isolated
 *                         worktree directory (deleted out from under it): its PTY
 *                         may run but its work tree is gone.
 *   - 'worker-stale'    — a counted, still-alive worker has not beat its
 *                         heartbeat for a long time (likely stuck / hung).
 *   - 'no-heartbeat'    — a counted, alive worker STREAMING output (so never
 *                         'worker-stale', which respects PTY activity) that has
 *                         NEVER beaten a heartbeat since dispatch. Not hung — a
 *                         PROTOCOL violation: running full speed while invisible
 *                         to the commander's heartbeat view. The 2e7beb2 bypass
 *                         ran exactly like this (zero beats, then pushed main);
 *                         the guard's push ban is the hard stop, this is the
 *                         observability that a worker went dark-but-active.
 *   - 'move-stuck'      — a Board COLUMN MOVE kept failing (the write was rejected
 *                         / errored) past the retry budget, so the work happened
 *                         but the card couldn't follow it: a worker finished but
 *                         its card is stuck in 'doing' (`intent:'review'`), a
 *                         branch LANDED on the trunk but its card is stuck in
 *                         'review' (`intent:'done'` — "done なのに review"), or a
 *                         lost worker's card couldn't be re-homed out of 'doing'
 *                         (`intent:'recover'` — "dead なのに doing"), or a worker
 *                         that had ALREADY reached ready hit the execution ceiling
 *                         and its card couldn't be returned to 'review'
 *                         (`intent:'recover-review'`). The engine keeps retrying
 *                         (and escalates a recoverable case to 'blocked' — never
 *                         the 'recover-review' one, whose whole point is that a
 *                         ready worker's card must not land in the owner's column);
 *                         this surfaces the ones a human must move.
 *   - 'review-panel-failed' — the adversarial review panel could not produce a
 *                         decisive verdict (zero must-fix/clean votes, or no
 *                         majority) even after its retry budget, so the card is
 *                         FROZEN in 'review' un-merged (fail-closed: "could not
 *                         review" is never "clean") and the panel is no longer
 *                         re-spawned. The worker is NOT at fault (no rework
 *                         burned); a human must look, or a new commit re-arms
 *                         the panel.
 *   - 'high-risk-hold'  — the branch's diff touches release/CI/signing/
 *                         dependency/secrets-grade paths (HIGH_RISK_PATHS — the
 *                         same set as the commander's manual-merge rule), so
 *                         auto-merge is withheld BY DESIGN: the card stays in
 *                         'review' and ONLY a human's manual merge can land it.
 *                         Not a fault — a structural approval gate; `files`
 *                         carries the matched paths. */
export type OrchestratorAnomalyKind =
  | 'orphan-doing'
  | 'unowned-doing'
  | 'worktree-missing'
  | 'worker-stale'
  | 'no-heartbeat'
  | 'move-stuck'
  | 'rework-exhausted'
  | 'review-panel-failed'
  | 'high-risk-hold'
  // The two LEVEL-TRIGGERED failures, mirrored here from the notification lane
  // (2026-08-04). Both fire as ONE-SHOT notifications that will not be minted
  // again until the condition clears, so once the owner could dismiss a row from
  // the needs-attention feed, a STANDING failure could be hidden forever with one
  // click. As anomalies they are re-derived from live state every pass: a
  // dismissal cannot silence them, and they vanish on their own when the
  // condition ends.
  //   - 'all-workers-down' — the engine is running, NO worker is alive, and swarm
  //                          cards are still sitting in 'doing' (work hanging).
  //                          `attempts` carries how many cards are hanging.
  //   - 'manager-unrevivable' — the commander desk failed to come back the
  //                          maximum number of times in a row, so integration is
  //                          stopped until a human looks. `attempts` carries the
  //                          consecutive failure count.
  | 'all-workers-down'
  | 'manager-unrevivable'

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
  /** For 'worker-stale': minutes since the last heartbeat; for 'no-heartbeat':
   *  minutes since dispatch with zero beats (display-only, so the pane can say
   *  "no heartbeat for N min" without a second clock). */
  staleMinutes?: number
  /** For 'move-stuck': WHICH column move is stuck, so the pane can say exactly
   *  what zombied ('review' = stuck in doing, 'done' = stuck in review,
   *  'recover-review' = a READY worker's card stuck in doing, 'recover'
   *  = a lost worker stuck in doing). */
  intent?: 'review' | 'done' | 'recover' | 'recover-review'
  /** For 'move-stuck': how many consecutive writes were kept (display-only).
   *  For 'rework-exhausted': how many times the card bounced review→doing before
   *  the loop guard parked it in 'blocked' (display-only).
   *  For 'review-panel-failed': how many consecutive panels ended indecisive
   *  before re-spawning stopped (display-only). */
  attempts?: number
  /** For 'high-risk-hold': the repo-relative changed paths that matched
   *  HIGH_RISK_PATHS — WHAT made the branch high-risk (display-only). */
  files?: string[]
}

/** KPI roll-up the commander dashboard renders (the ANALYTICS layer, distinct
 *  from the live observability of `workers`/`reviews`/`log`/`anomalies` above):
 *  the data foundation for "is the swarm getting better?". Rates are derived from
 *  the engine's NON-LOSSY lifetime event counters (since this engine session
 *  started — in-memory, so a restart resets them); the lead time is paired from
 *  recent journal completions, so it reflects the journal window. A `null` rate /
 *  median means "no data yet" (the UI shows a dash, never 0%/0). */
export interface SwarmKpis {
  /** Completed-card lead time todo→done: median over recently-completed cards
   *  (a `done` card paired to its `integrate` journal event), in milliseconds,
   *  plus how many cards were paired. `medianMs` is null until at least one
   *  completion is pairable. Window-limited to the journal's retained events. */
  leadTime: { medianMs: number | null; count: number }
  /** Of resolved auto-integration attempts (landed + conflicted), the fraction
   *  that hit a rebase conflict needing a human. null until the first attempt. */
  conflictRate: number | null
  /** Of review outcomes (landed + sent back), the fraction sent back for rework
   *  (差し戻し). null until the first review outcome. */
  reworkRate: number | null
  /** Of dispatched workers, the fraction whose work landed on the trunk
   *  (integrated). null until the first dispatch. */
  workerSuccessRate: number | null
  /** Raw lifetime counters (the rate denominators, also shown so "2/3" reads
   *  plainly). Since this engine session started. */
  counts: {
    dispatched: number
    integrated: number
    conflicted: number
    reworked: number
    crashed: number
    stalled: number
  }
}

/** One weekly bucket of GET /api/swarm/kpi/landed — landed swarm cards in the
 *  Monday-start UTC week beginning `weekStart` ('YYYY-MM-DD'), split self
 *  (a checkout of OG itself, by package.json name) vs external (外向き —
 *  every other registered project). */
export interface SwarmLandedWeek {
  weekStart: string
  self: number
  external: number
}

/** GET /api/swarm/kpi/landed — the DURABLE landed KPI, aggregated across every
 *  registered project (the whole registry — no path param). Fed by the on-disk
 *  ledger `~/.openground/projects/<uuid>/swarm-landed.json` the engine writes at
 *  promote + land (swarmLandedLedger.ts), so unlike {@link SwarmKpis} (in-memory
 *  counters + the journal ring) it SURVIVES restarts and can be charted over
 *  time. `weeks` is fixed-length, oldest→newest, empty weeks zero. This is the
 *  「外向き着地/週」dial: the one line that answers whether the swarm produces
 *  anything beyond its own repairs. */
export interface SwarmLandedKpi {
  weeks: SwarmLandedWeek[]
  /** Busiest-first. `recent` = lands in the last 28 days. */
  perProject: {
    id: string
    name: string
    path: string
    self: boolean
    total: number
    recent: number
  }[]
  totals: { self: number; external: number }
}

/** Consumption snapshot of the UNATTENDED loop (the BUDGET layer, distinct from
 *  the KPI analytics above): "how much is the loop SPENDING right now, and has it
 *  crossed a ceiling I should look at?". READ-ONLY of state the engine already
 *  maintains — it adds no new event hooks. The commander dashboard renders it in
 *  its own section and warns the owner when `overLimit`. */
export interface SwarmConsumption {
  /** Live workers the engine is driving this instant (稼働 worker 数) — the same
   *  set as {@link SwarmOrchestratorState.workers}, counted. */
  activeWorkers: number
  /** Combined wall-clock run time of those live workers right now: Σ(now −
   *  startedAt) in ms (累積実行時間 — the in-flight worker-time). Clock skew /
   *  unparseable stamps contribute 0, never a negative. */
  activeRunMs: number
  /** Workers the loop has dispatched this engine SESSION (read off the non-lossy
   *  lifetime counter) — the cumulative consumption proxy (概算消費): each is one
   *  `claude` session against the subscription. Per-worker time is already bounded
   *  by the runaway ceiling, so the spawned-worker count is the honest stand-in
   *  for total session spend. Resets when the engine process restarts. */
  dispatched: number
  /** The configurable per-session dispatch ceiling (上限) the warning compares
   *  against — operator-tunable via env (OPENGROUND_SWARM_DISPATCH_BUDGET). */
  limit: number
  /** `dispatched >= limit` (with a positive limit) — the loop has crossed the
   *  consumption ceiling; the UI warns the owner to check it. A soft nudge, never
   *  a hard stop (the engine keeps running). */
  overLimit: boolean
}

/** The commander desk's own heartbeat, as GET /api/swarm/orchestrator surfaces it
 *  (the `manager` field) — a read-only snapshot of the FIXED per-repo file
 *  `~/.openground/swarm/<repoKey>/manager.json` the commander beats into while it
 *  inspects/integrates (the SAME file the resurrection reflex reads). Exists so the
 *  Swarm tab can EXPLAIN the quiet minutes after a worker finishes ("the commander
 *  is inspecting") instead of looking dead — the 2026-07-17 misread. DISPLAY-ONLY:
 *  this never feeds the resurrection reflex's own health judgement
 *  (defaultManagerPresence / isManagerHeartbeatFresh — untouched). Note the reflex no
 *  longer treats a stale beat as death on its own (2026-07-18): the commander beats only
 *  while integrating, so silence here means "not integrating", NOT "hung". */
export interface SwarmManagerHeartbeat {
  /** The commander's self-reported phase (`status` / `merge` / …) — free-form,
   *  display-only. Absent when the beat carried none. */
  phase?: string
  /** The commander's one-line "what I'm doing now" note — free-form, display-only.
   *  Absent when the beat carried none. */
  note?: string
  /** When it last beat (ISO 8601, as written in the file). */
  updatedAt: string
  /** How long ago that was, measured on the SERVER clock (now − updatedAt, clamped
   *  ≥ 0) — so the client never mixes its own clock into the freshness read. */
  ageMs: number
  /** `ageMs < MANAGER_HEARTBEAT_STALE_MS` (10 min — the same window the
   *  resurrection reflex uses to call a desk hung), computed server-side: true ⇒
   *  the commander is actively working right now. */
  fresh: boolean
}

/** GET/POST /api/swarm/orchestrator{,/start,/stop} — the commander
 *  engine's state for ONE project: whether the autonomous drain loop is running,
 *  the workers it counts against the cap, the review cards awaiting the
 *  commander, the recent journal, and the concurrency ceiling.
 *  Owner-only (same gate as the rest of /api/swarm/*). */
/** What the Swarm pane says about the commander desk. Display-only — see
 *  {@link SwarmOrchestratorState.managerPresence}.
 *   • 'missing' — no live commander desk in either pool.
 *   • 'quiet'   — a desk is up; it is not reporting integration work right now.
 *   • 'working' — a desk is up AND its heartbeat is fresh.
 *  (A fourth display state, "unknown", exists only on the client: it means the
 *  server did not say, which must never be shown as 'missing'.) */
export type SwarmManagerPresence = 'missing' | 'quiet' | 'working'

export interface SwarmOrchestratorState {
  /** True while the autonomous drain+dispatch loop is scheduled. OFF ⇒ the
   *  engine never dispatches (manual POST /api/swarm/worker is untouched) AND
   *  never integrates — the global stop. */
  running: boolean
  /** The commander desk ACTUALLY live right now, from the both-pools desk read
   *  (listManagerDesks[0]) — the handle the pane needs to ADOPT an engine-woken
   *  desk instead of pinning to a dead pre-restart id forever (the 0803
   *  「再起動のたびに死画面」 report). Additive + optional: an old server omits
   *  it (client keeps its old behaviour); null = no live commander desk. */
  managerDesk?: { runtime: 'pty' | 'sdk'; handleId: string; agentSessionId: string | null } | null
  /** DISPLAY-ONLY commander status — what the pane tells the owner.
   *
   *  ⚠ NOT {@link ManagerPresence} (absent/idle/active), which is the engine's
   *  REFLEX judgement: it stats transcripts, discounts its own keystroke echo,
   *  and falls to 'absent' on any exception. That direction is right for
   *  "should I wake the desk?" and wrong for "what do I tell the owner?", where
   *  one transient read failure would announce that the commander is gone.
   *
   *  Derived server-side from facts the state read ANYWAY (a live desk in either
   *  pool + the heartbeat's freshness), so this costs no extra I/O.
   *
   *  WHY IT EXISTS: the pane used to derive "動いています" from the heartbeat's
   *  10-minute freshness ALONE. A commander that beat once and then died kept
   *  saying it was working — for ten minutes, unattended, on the one screen that
   *  is supposed to tell the owner whether to look.
   *
   *  Additive + optional: an old server omits it, and the client must read the
   *  absence as UNKNOWN — never as 'missing'. */
  managerPresence?: SwarmManagerPresence
  /** Same, for the supply desk (PTY-only by design — Remote Control lives there). */
  supplyDesk?: { runtime: 'pty'; handleId: string; agentSessionId: string | null } | null
  /** True while the owner has EXPLICITLY paused the engine (Autonomy OFF) and
   *  not turned it back ON — the machine-readable "stopped by hand" signal a
   *  commander / another session reads to tell a DELIBERATE stop from a
   *  never-started engine (the 0707 twin-dispatch root cause was this state
   *  being invisible from outside). The OR of the engine's in-memory flag and
   *  the persisted record below, so it stays true across a server restart
   *  (when the in-memory engine — and its flag — is gone). While set, the
   *  opt-in auto-drain sweep never restarts the engine; an explicit Autonomy
   *  ON always clears it. */
  manualStop: boolean
  /** The PERSISTED half of `manualStop` (`Settings.swarmManualStop`) — the
   *  on-disk fact "the owner stopped this project by hand", written by
   *  `stopOrchestrator`, cleared by `startOrchestrator`, surviving restarts.
   *  Surfaced separately so a caller can tell a this-session pause
   *  (`manualStop` true via the in-memory flag) from the durable record. A
   *  record only — it never auto-resumes (or auto-stops) anything by itself. */
  manualStopPersisted: boolean
  /** True while SELF-SUPPLY (card b3fbbfba) is armed: the engine proposes its own
   *  improvement cards (discovered from tsc/lint/test/anomalies/TODOs) into todo.
   *  A SEPARATE switch from `running`, default OFF (in-memory, so a
   *  restart re-arms OFF — fail-safe). Even when ON, a proposed card is
   *  approval-gated: it never dispatches until the owner approves it.
   *  (The old `autoMerge` field — the separate auto-wake-the-commander toggle —
   *  was RETIRED 2026-07-16: the wake reflex is always armed while `running`.) */
  selfSupply: boolean
  /** True while the OVERSEER (EPIC C / C-core) is armed: the autonomous proxy-you
   *  brainstem watches the swarm and, on judgment edges, wakes a one-off brain or
   *  raises to the human inbox. The THIRD toggle, default OFF, in-memory (a restart
   *  re-arms OFF). ASYMMETRIC to selfSupply: an explicit autonomy OFF
   *  CLEARS it (the owner re-arms it every session — no persisted reminder). */
  overseer: boolean
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
  /** KPI roll-up (the analytics layer) — lead time, rework / conflict /
   *  worker-success rates + their raw counters. See {@link SwarmKpis}. */
  kpis: SwarmKpis
  /** Consumption snapshot of the unattended loop (the BUDGET layer) — live worker
   *  count, in-flight run time, session dispatch total + its ceiling/over-limit
   *  flag. A SEPARATE section from `kpis` in the dashboard. See
   *  {@link SwarmConsumption}. */
  consumption: SwarmConsumption
  /** True when the owner turned Autonomy ON for this project in a PRIOR session
   *  and never turned it OFF (persisted in `Settings.swarmAutonomyOn`). The
   *  engine is NEVER auto-resumed on restart — it always relaunches `running:false`
   *  (fail-safe) — so the Swarm UI reads this to show a passive "autonomy was on
   *  last session — resume?" reminder. Surfaced even before an engine exists this
   *  session (right after a restart). Cleared by an explicit OFF (resume or
   *  dismiss). Independent of `running`; the reminder shows only while
   *  `!running && autonomyRemembered`. */
  autonomyRemembered: boolean
  /** True when THIS session's engine was brought back by the boot resume
   *  (`resumeEngines` — the persisted `desiredRunning:true`), not by an owner
   *  action in this session. In-memory only, cleared the moment the owner
   *  touches the power switch either way (start / stop), so it never outlives
   *  the fact it reports.
   *
   *  WHY IT EXISTS (card 2b): once card 2 made a restart RESUME the drain, the
   *  restart reminder — gated on `!running` — stopped rendering for exactly the
   *  case it was written for, and the "your last session's autonomy is back"
   *  fact went silent. `autonomyRemembered && running` cannot substitute: it is
   *  equally true after a plain manual ON, which restored nothing. This flag
   *  distinguishes the two, so the UI can say "restored" only when it is. */
  autonomyResumed: boolean
  /** The RAW `overseer` value persisted in this project's `engine.json`
   *  (`EngineIntent.overseer`) — i.e. "the overseer was armed when this project's
   *  engine last wrote its intent". A REMINDER, never an auto-arm: `resumeEngines`
   *  deliberately never reads this field back to arm the overseer (its outward
   *  effects — waking a one-off brain, typing into a running worker's session,
   *  deleting branches / heartbeats — make a restart the one kill switch with no
   *  substitute layer; OVERSEER_DESIGN.md K2 / L9-③). The Swarm UI reads it to
   *  offer a ONE-CLICK restore banner while `overseerRemembered && !overseer`
   *  (card 2b), which is the surface OVERSEER_DESIGN.md:161 asks for.
   *
   *  Surfaced even before an engine exists this session (read straight off disk).
   *  Cleared by the dedicated dismiss action (see `dismissOverseerReminder`) and
   *  by an explicit autonomy OFF; re-set whenever the overseer is armed.
   *  The remaining action endpoints report `false` (their ack is superseded by
   *  the next 5s poll) — exactly like {@link autonomyRemembered}. */
  overseerRemembered: boolean
  /** QUOTA PARK (card 0add9d30) — epoch ms of the earliest model-tier reset while
   *  EVERY tier is cooling (swarmQuota.allCoolingUntil), or absent when at least
   *  one tier has headroom. While set, the engine holds ALL new dispatch (no
   *  worker spawn) and the integrate pass defers its reviewer panel, instead of
   *  churning into the same exhausted wall — already-running workers are
   *  unaffected. Today the park is visible through the engine JOURNAL (`log`
   *  carries a warn line on park enter and an info line on lift) and through
   *  this field on the status API; no dedicated UI renders it yet. */
  parkUntil?: number
  /** The commander desk's own heartbeat — see {@link SwarmManagerHeartbeat}. The
   *  Swarm tab renders it as the "inspection" presence line (稼働中/待機中), so the
   *  post-worker quiet minutes read as the commander inspecting, not a dead swarm.
   *  `null` / absent = no heartbeat to show (never written, unreadable, or a
   *  non-repo path) — the UI degrades to the standby wording (fail-safe). Carried
   *  by the GET poll (getOrchestratorState); the action endpoints' ack responses
   *  may omit it (optional), and the next poll refills it. Whether the desk is a
   *  human-opened conversation or the engine-woken integrator is NOT distinguished
   *  — the file is shared, so this is "the last active commander desk" on purpose. */
  manager?: SwarmManagerHeartbeat | null
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
  /** In-app swarm DISPATCH priority (selectDispatch → sortTodos): the engine
   *  pulls 'urgent' before 'high' before 'normal' (the default when absent)
   *  before 'low'. A card lingering in the todo column ALSO climbs over time
   *  (AGING — see src/lib/boardPriority.ts) so nothing starves. Set + shown in
   *  the Board drawer + a card chip. Shared data.
   *  (Schema 3-point set: this field (types.ts) + ProjectTaskSchema (schemas.ts).
   *  Omit it from the zod schema and it is silently stripped on the tasks.json
   *  read→write round-trip — the collab layer (ydoc.ts) is field-agnostic, so it
   *  needs no change.) */
  priority?: TaskPriority
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
  /** The owner answered 「B: この作業は見送る（できあがった分も取り込みません）」 to
   *  an escalation about this card. It is a STANDING instruction, not a log line:
   *  while it is set, the engine must never publish this card as ready to
   *  integrate — no `engine.reviews` row, no 「統合してください」 notice to the
   *  commander desk, no wake.
   *
   *  ⚠ WHY A CARD FLAG AND NOT JUST AN ANSWER. Answering used to record the text
   *  and stop there: the card stayed in `review`, so the engine kept telling the
   *  commander to integrate it and the commander did. Integration onto the trunk
   *  is irreversible, so "I chose B" has to survive as STATE that the publish
   *  path reads, not as prose in a journal nobody consults.
   *
   *  CLEARED whenever the card leaves 'blocked' by a human's hand (a column move
   *  or a 差し戻し) — moving it back into play IS the owner changing their mind,
   *  and the work on its branch is still there to pick up.
   *  Shared data. (3点セット: types.ts / schemas.ts ProjectTaskSchema / the
   *  server's setter in server/routes/project.ts.) */
  abandoned?: boolean
  /** Set by the commander engine's SELF-SUPPLY stage (card b3fbbfba) when the
   *  engine proposed this card on its own (a discovered improvement point — a
   *  type/lint error, a failed test, a state anomaly, a TODO). Its presence both
   *  marks provenance AND carries the STABLE dedup key (so the engine never
   *  re-proposes the same finding while an open card for it exists). A card with
   *  this set is GATED: selectDispatch skips it until `selfSupplyApproved` is
   *  true. Shared data. (3点セット: types.ts / schemas.ts ProjectTaskSchema /
   *  here.) */
  selfSupplyKey?: string
  /** Owner approval for a self-supplied card (the per-card dispatch gate, the
   *  primary runaway defense): false/absent ⇒ selectDispatch holds it as an inert
   *  proposal; true ⇒ the engine may dispatch it like any todo card. Set only by
   *  the owner-gated POST /api/swarm/orchestrator/selfsupply/approve. Meaningless
   *  without `selfSupplyKey`. Shared data. */
  selfSupplyApproved?: boolean
  /** 差し戻し(review→doing)ループガードのカウンタ — POST /api/project/tasks
   *  {rework:[{id}]} が review→doing に移す度+1し、maxReworks(既定3)を超えたら
   *  moveをdoingでなくblockedへ差し替える。~/.claude/swarm-board.sh reworkと同一
   *  セマンティクス(そちらは独自の心拍ディレクトリ内カウンタファイルを使うため、
   *  このフィールドとは別管理・干渉しない)。done/todo着地で自動リセット(このカードが
   *  再利用されても差し戻し回数が持ち越されないように — 3点セット: types.ts /
   *  ProjectTaskSchema / server/routes/project.ts rework loop + setColumn done/todo)。 */
  reworkCount?: number
  /** Set by the DAILY FUEL REPORT (`dailyFuelReport.ts`) on the improvement
   *  proposal it files into `blocked` on a degraded day. Its presence marks
   *  provenance AND is the dedup key: the report scans the target Board for an
   *  OPEN (non-done) card carrying it and files nothing when one exists — the
   *  same Board-truth dedup `openSelfSupplyKeys` does for self-supply, and the
   *  reason a lost/unwritable sentinel can no longer pile duplicate proposals
   *  into blocked.
   *
   *  Deliberately NOT `selfSupplyKey`: that field ALSO gates dispatch
   *  (selectDispatch holds the card until `selfSupplyApproved`), which would
   *  break this lane's approval contract — here the owner's MOVE to todo *is*
   *  the approval, so a card sitting in todo must be dispatchable. Shared data.
   *  (3点セット: types.ts / schemas.ts ProjectTaskSchema / the report's scan.) */
  fuelProposalKey?: string
}

/** Board card dispatch priority (in-app swarm). Absent ⇒ treated as 'normal'.
 *  Listed most-urgent-first — the order the UI priority picker renders. */
export type TaskPriority = 'urgent' | 'high' | 'normal' | 'low'

export const TASK_PRIORITIES: readonly TaskPriority[] = ['urgent', 'high', 'normal', 'low']

/** Claude CLI effort levels (`claude --effort <level>`). */
export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const CLAUDE_EFFORTS: readonly ClaudeEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

/** Swarm execution mode — one toggle that trades capability ↔ weekly budget
 *  (card 68d8e00f). `max` = every role opus/max (peak quality, peak spend);
 *  `economy` = sonnet + low/medium effort + fewer parallel workers (minimise the
 *  subscription burn); `optimize` = per-card weight decides (heavy → opus, chores
 *  → sonnet) — the smart default. The model/effort/parallelism resolution lives in
 *  `swarmLaunch.ts`; this is the shared contract the client toggle + settings use. */
export type ExecutionMode = 'max' | 'economy' | 'optimize'
export const EXECUTION_MODES: readonly ExecutionMode[] = ['max', 'economy', 'optimize']
export const DEFAULT_EXECUTION_MODE: ExecutionMode = 'optimize'

/** The four faces of the Swarm tab's sub-view strip — 補給官 (supply) / 司令官
 *  (manager) / ワーカー (workers) / 監督 (overseer) — as reorderable pane ids.
 *  The ARRAY ORDER is the shipped default left-to-right order (supply first, the
 *  conversational entry point) AND the canonical id set the UI reconciles a
 *  saved {@link Settings.swarmPaneOrder} against (via `effectiveTabOrder`, shared
 *  with the per-project tab row: it drops unknown/retired/duplicate ids and
 *  appends any missing pane in this order). The FIRST id of the reconciled order
 *  is the tab that opens by default. Keep in sync with SwarmModule's `MainView`. */
export type SwarmPaneId = 'supply' | 'manager' | 'workers' | 'overseer'
export const SWARM_PANE_IDS: readonly SwarmPaneId[] = [
  'supply',
  'manager',
  'workers',
  'overseer',
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
 *  - `waiting`: claude is sitting on A HUMAN — a selection menu (permission
 *    prompt etc.) is open on the settled screen, or it stopped working only
 *    moments ago and has just handed the turn back.
 *  - `idle`: LIVE but not working and not blocked on anyone — a session parked
 *    at its prompt with nothing pending.
 *
 *  ⚠ `idle` exists because the two-value version LIED (fixed 2026-08-15). It
 *  had no third answer, so "not working" collapsed into `waiting`, and every
 *  long-parked desk — a commander between passes, a supply seat that has said
 *  「積みたい要望をどうぞ」, a terminal someone left open — reported that it was
 *  sitting on the human. The owner saw three Ground cards stamped WAITING with
 *  every task done. An amber "your turn" that is usually wrong is worse than no
 *  stamp: it trains the reader to ignore the one that is right. */
export type ClaudeBeaconStatus = 'working' | 'waiting' | 'idle'

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
  /** This PTY is a SWARM DESK (commander / supply), not a session the owner
   *  opened. Set from `TerminalInfo.deskLabel`, which only a desk launcher
   *  writes — a hand-started `claude` in the same repo never carries one.
   *
   *  ⚠ WHY THE GROUND BEACON NEEDS THIS (2026-08-15). A desk is machinery. It
   *  sits at its prompt between passes, and it is never waiting on the OWNER —
   *  when it does need them it raises an escalation, which has its own surface.
   *  Counting desks as ordinary panes lit every project with a swarm amber
   *  「あなたの番」 forever, with nothing left to do. Absent on a server
   *  predating this field, which then behaves as before. */
  desk?: boolean
  /** Registry UUID of the project that OWNS this cwd, resolved server-side.
   *  A swarm worker's cwd is its isolated worktree under
   *  ~/.openground/projects/<uuid>/worktrees/ — OUTSIDE the project folder — so
   *  a client that only compares cwd against the project path cannot attribute
   *  it. Absent when no registered project owns the cwd (a free shell in ~/),
   *  and on a server predating this field. */
  projectId?: string
  /** How much of this session's context window is still FREE, as a 0–100 percent
   *  (100 = empty, small = near auto-compact). Resolved server-side per pane: the
   *  always-on source is the session's JSONL usage sum
   *  (`input + cache_read + cache_creation ÷ 200k`, the card-1 spike's main
   *  source), and the on-screen `Context left until auto-compact: N%` footnote
   *  overrides it when present (it only appears near the limit — a sharper alarm).
   *  This is a SIGNAL for the gauge (card 5) and task-boundary hint (card 3), NOT
   *  a compaction trigger — native auto-compact still owns that. `null` when no
   *  transcript line is found yet; absent on a server predating this field. */
  contextLeftPct?: number | null
  /** WHICH reading produced `contextLeftPct` — the two have different
   *  denominators, so a gauge cannot colour or label the number without it:
   *  `'jsonl'` = free space in the 200k window (the always-on source),
   *  `'footnote'` = distance to the AUTO-COMPACT threshold, which claude only
   *  paints near that threshold (so even a comfortable-looking N is an alarm).
   *  `null` alongside a null reading; absent on a server predating this field. */
  contextLeftSource?: 'jsonl' | 'footnote' | null
}

/** Response of GET /api/terminal/active. `cwds` keeps the original "any PTY
 *  alive here" contract (shell panes included — drives the plain `Terminal`
 *  beacon); `claude` refines claude-tagged sessions into working/waiting. A
 *  cwd present in `cwds` but absent from `claude` only hosts free shells. */
export interface ActiveTerminalsResponse {
  cwds: string[]
  claude: ClaudeActivity[]
}

/** One project's inputs for the Ground card lamp (GET /api/ground/lamps).
 *
 *  The lamp itself is decided by the pure `groundLamp()` in src/lib/groundLamp.ts
 *  — the owner's four cases — and this is only what that function needs. TWO of
 *  the three fields are OPTIONAL, and both for the same reason: an unreadable
 *  source is not an empty one, and a 0 on this wire becomes a card that says
 *  「もう何もありません」 about work nobody managed to look at. */
export interface GroundLampRow {
  /** Registry UUID. */
  projectId: string
  /** Cards in doing / review / blocked that are not done (see
   *  `startedTaskCount`). ABSENT ⇒ the board could not be read. */
  started?: number
  /** Open escalations naming this project. ABSENT ⇒ the inbox could not be
   *  read — which contributes nothing to the verdict, rather than "no
   *  questions". */
  openQuestions?: number
  /** Is anything ACTUALLY running for this project — a swarm worker on either
   *  runtime, or a `claude` pane mid-generation. Not optional: false here means
   *  "we looked and found nothing moving", and a project with nothing started
   *  is never asked in the first place. */
  liveWork: boolean
}

export interface GroundLampsResponse {
  lamps: GroundLampRow[]
}

/** Response of GET /api/update/restart-safety — the server's answer to "may the
 *  Electron shell restart the app RIGHT NOW to apply a downloaded update
 *  without destroying anything that can't come back?". Computed across BOTH
 *  desk pools (liveDesks.updateRestartSafety). `safe` is the verdict; the
 *  counts are the explanation (surfaced in main-process logs).
 *  - `generating`: claude sessions mid-generation (either pool) — cutting one
 *    loses the in-flight turn, so any > 0 blocks.
 *  - `userPtys`: visible non-desk, non-engine PTY panes (user terminals,
 *    including plain shells) — user state with no resume machinery, blocks.
 *  Resting desks (補給官/司令官) and swarm workers do NOT block: they resume by
 *  design (conversation --resume + roster recovery). */
export interface UpdateRestartSafetyResponse {
  safe: boolean
  generating: number
  userPtys: number
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

/** The kind discriminator for an in-app notification (Ground お知らせ).
 *  'collab-invite' is an account/collab notification; 'swarm-fatal' is the
 *  escalation safety valve — a FATAL event of the in-app swarm's unmanned loop
 *  the engine surfaced so a human watching nothing still gets woken;
 *  'swarm-info' is the INFO-grade sibling (the overseer/escalation lane —
 *  see {@link SwarmInfoNotification}). The bell is built so more kinds can be
 *  added. */
export type NotificationKind = 'collab-invite' | 'swarm-fatal' | 'swarm-info'

/** Which FATAL event of the unmanned swarm/self-improvement loop fired. These are
 *  the cases the autonomy loop CANNOT self-heal — the ones worth waking a human:
 *   • 'rework-exhausted'  — a card bounced review→doing past its budget and was
 *                            parked in 'blocked' (the loop gave up auto-fixing it).
 *   • 'all-workers-down'  — the engine is running with work in flight ('doing')
 *                            but ZERO live workers (every worker crashed/stalled).
 *   • 'exec-timeout'      — a worker overran the execution-time ceiling
 *                            (MAX_EXEC_MS) and was force-reclaimed/parked.
 *   • 'guard-unwired'     — the L4 PreToolUse guard wiring failed spawn-time
 *                            verification, so a worker spawn was REFUSED
 *                            (fail-closed — GAP-2; spawnSwarmWorker).
 *   • 'rollback'          — a broken self-update build was auto-rolled back.
 *   • 'canary-failed'     — the self-update canary failed to promote repeatedly.
 *   • 'review-panel-failed' — the adversarial review panel stayed indecisive
 *                            (0 votes / no majority) past its retry budget; the
 *                            card is frozen in 'review' un-merged awaiting a
 *                            human (fail-closed review, 2026-07-14).
 *   • 'high-risk-hold'    — the branch touches release/CI/signing/dependency/
 *                            secrets-grade paths (HIGH_RISK_PATHS), so auto-merge
 *                            is withheld BY DESIGN; the card waits in 'review'
 *                            for a human's manual merge (force-hold, 2026-07-15).
 *                            Not a fault — but without a notification the card
 *                            would sit silently forever.
 *   • 'manager-unrevivable' — the engine tried to RESUSCITATE a stopped commander
 *                            (dead PTY / hung — no manager heartbeat) but it kept
 *                            dying: after MAX_MANAGER_RESUME_ATTEMPTS consecutive
 *                            resurrections the reflex GIVES UP (so a permanent
 *                            quota wall / boot-crash can't burn tokens in an
 *                            infinite detect→spawn→die loop) and escalates —
 *                            integration is stalled until a human checks the desk
 *                            (manager heartbeat card, 2026-07-15).
 *  ('rework-exhausted' | 'all-workers-down' | 'exec-timeout' |
 *  'review-panel-failed' | 'high-risk-hold' | 'manager-unrevivable' come from the
 *  swarm engine; 'guard-unwired' from the worker spawn path (swarmWorker.ts);
 *  'rollback' | 'canary-failed' come from the Electron self-update cycle.) */
export type SwarmFatalEvent =
  | 'rework-exhausted'
  | 'all-workers-down'
  | 'exec-timeout'
  | 'guard-unwired'
  | 'rollback'
  | 'canary-failed'
  | 'review-panel-failed'
  | 'high-risk-hold'
  | 'manager-unrevivable'
  // 'worker-spawn-failed' (2026-08-13, SDK-only workers): deps.spawnWorker threw
  // SdkWorkerUnavailableError — the SDK runtime cannot start on this machine
  // (signed-out / missing / too-old CLI, unarmed guard). The engine holds new
  // dispatch on a backoff ladder and recovers by itself on the first successful
  // spawn; this bell is the owner's ONE loud pointer at the cause (the old PTY
  // fallback used to absorb exactly this, silently).
  | 'worker-spawn-failed'
  // 'manager-unresponsive' (2026-08-14): the commander desk EXISTS and is not
  // integrating — presence reads 'idle', or 'active' with the queue provably
  // stalled — the engine has spent its whole nudge budget (or could not address
  // the desk at all, three pokes running), and the review work has been waiting
  // past MANAGER_INTEGRATION_STALL_MS. Distinct from 'manager-unrevivable',
  // which means "no desk can be RAISED": here a desk is up, so that event would
  // be a lie (03章 §2.3 完了条件3). Both dead ends used to end in a single engine
  // log line and permanent silence — the field bug of 2026-08-14 (two cards sat
  // in review, the desk was alive and idle, and nobody was told).
  | 'manager-unresponsive'
  // 'engine-resume-suppressed' (docs/ENGINE_PERSISTENCE_PLAN.md §4-2, card 2): the
  // boot-time crash-loop breaker tripped — this build restarted
  // BREAKER_THRESHOLD+ times inside the trailing window, so resumeEngines()
  // refused to auto-resume ANY project's engine this boot (fail-safe: a
  // newly-shipped build looping is exactly when unattended auto-resume is most
  // dangerous). The owner can still turn autonomy back on by hand from the Swarm
  // pane; nothing is lost, only deferred. Fires from swarmOrchestrator.ts
  // (resumeEngines), never per-project (projectPath/taskId/branch absent).
  | 'engine-resume-suppressed'
  // 'data-integrity' is NOT a swarm event: it is the boot-time home-data damage
  // check (src/lib/server/homeIntegrity.ts) reporting that settings.json /
  // canvas.json lost entries, became unreadable, or picked up a test fixture
  // value. It sits on the FATAL channel deliberately:
  //   - the fatal row renders with a warning triangle and accent colour, while
  //     the info row is a muted "nothing broke, someone should look" inbox
  //     item — the owner's project registry vanishing must not look like a
  //     pending question (it did, before);
  //   - `logHint` gives it somewhere to print WHERE the backups are, which is
  //     the whole point of telling them at all.
  // A dedicated NotificationKind would be more honest still, but an unknown kind
  // renders as an INVISIBLE row that nonetheless bumps the unread badge
  // (NotificationPanel returns null in its default branch) — a phantom unread
  // nobody can clear. Precedent for non-swarm events here: 'rollback' and
  // 'canary-failed' are Electron self-update events.
  | 'data-integrity'

/** The payload of a 'swarm-fatal' notification — carries WHAT happened, WHICH
 *  card/branch it concerns, and a POINTER to the engine log so the notification
 *  leads somewhere actionable (the three things the escalation must contain). */
export interface SwarmFatalNotification {
  /** Which fatal event — see {@link SwarmFatalEvent}. */
  event: SwarmFatalEvent
  /** Human-readable one-line summary of WHAT happened. */
  detail: string
  /** The project whose unmanned loop fired this (canonical path), when known —
   *  lets the bell row open the right project's commander/Board. */
  projectPath?: string
  /** The Board card involved, when card-rooted (display + open-target). */
  taskId?: string
  /** The `swarm/*` branch involved, when known (display-only). */
  branch?: string
  /** The card title involved, when known (display-only). */
  taskTitle?: string
  /** Where to dig in — a one-line pointer to the engine log / commander pane, so
   *  the notification is a 導線 (not a dead end). */
  logHint?: string
  /** For 'exec-timeout' ONLY — WHICH flavor of ceiling stop this was, because the
   *  two need OPPOSITE owner-facing questions and one event carries both:
   *   • 'runaway'          — never reached ready. Re-running it whole would just
   *                          overrun again, so "split it up and retry, or drop it"
   *                          is the right ask.
   *   • 'integration-wait' — HAD reached ready, was 差し戻し'd, and blew the budget
   *                          re-working. Its branch holds integrable work and the
   *                          card is back in 'review', so the judgement belongs to
   *                          the commander (verify the diff → land or 差し戻し),
   *                          NOT the owner. Asking the owner to "split it up and
   *                          retry" here is actively wrong: an answered escalation
   *                          whose worker is gone rides into the card's NEXT
   *                          dispatch as a directive (swarmEscalations'
   *                          deliverAnswer → recordEscalationAnswerForNextDispatch),
   *                          so that answer would order a fresh worker to redo work
   *                          that is already delivered. 2026-07-18 harm (c) — a
   *                          judgement-free card piled into the owner's queue.
   *  Absent on every other event (and on older persisted notifications). */
  execTimeoutKind?: 'runaway' | 'integration-wait'
  /** For `execTimeoutKind: 'integration-wait'` ONLY — WHY the ceiling was reached.
   *  `readyAt` cannot answer this on its own (it only means "delivered once"), and
   *  neither can a boolean: there are THREE causes, and every one of them reads as
   *  a lie when told as another.
   *   • 'rework'      — 差し戻し'd and actually burned the budget re-working. Its
   *                     tip is UNVERIFIED (the re-work was cut off mid-flight).
   *   • 'capped-wait' — the card queued longer than {@link WAIT_CREDIT_CAP_MS}
   *                     forgives (a careful 63-hour weekend review is enough), so
   *                     uncredited WAITING put it over. It re-worked nothing; its
   *                     tip is what it was at ready.
   *   • 'work'        — the wait was fully credited (or there was none at all, as
   *                     on the kept-promote route where the card never left
   *                     'doing') and nothing was re-worked: the ceiling came from
   *                     REAL WORK. Saying 「順番待ちが長引いた」 here is false —
   *                     this worker worked the entire time.
   *  Absent on every other event, and on notifications persisted before this
   *  field existed. */
  execTimeoutShape?: 'rework' | 'capped-wait' | 'work'
}

/** Which INFO-grade (non-fatal) swarm event fired. Unlike {@link SwarmFatalEvent}
 *  these never mean the unmanned loop broke — they are the overseer/escalation
 *  lane's "a human should look" channel (docs/OVERSEER_DESIGN.md §6/§8):
 *   • 'escalation-open'     — a question landed in the Escalations inbox and
 *                              waits for the owner's answer (C1).
 *   • 'escalation-reminder' — an open escalation sat unanswered; re-notify ONLY
 *                              (S11 — it never auto-progresses, fail-closed).
 *   • 'review-idle'         — mergeable review cards are piling up (S7).
 *   • 'overseer-throttled'  — the overseer degraded on the usage cap (S9/T3').
 *   • 'manager-woke'        — a worker became ready and the engine WOKE the
 *                              commander desk to decide the integration
 *                              (2026-07-15 manager-only integration; the engine no
 *                              longer merges — swarmOrchestrator runIntegratePass).
 *   • 'self-update-requested' — the commander's post-merge worktree sweep was
 *                              detected as an integration landing on the trunk,
 *                              and the engine self-update cycle (rebuild→canary→
 *                              switch) was actually requested — the app is about
 *                              to replace itself (selfUpdateOnIntegrate.ts; only
 *                              fires in armed own-source runs).
 *   • 'daily-fuel-report'   — the once-a-day swarm fuel report (card
 *                              swarm-token-blocked): a DETERMINISTIC (zero-LLM)
 *                              summary of the sessions that finished since the
 *                              last report — cards / median turns / bundle rate /
 *                              max context / total output + the 前回比 line. On a
 *                              degraded day the detail also notes the improvement
 *                              proposal card auto-filed into the Board's blocked
 *                              column (owner approval = moving it to todo).
 *   • 'session-limit'       — one of the OWNER'S OWN conversation desks (a
 *                              Terminal-tab pane, Board 実行, the commander /
 *                              supply desks) stopped because its model's usage
 *                              limit was reached. Nothing is broken and nothing
 *                              auto-recovers: that conversation simply waits until
 *                              the owner switches models. Raised by
 *                              ownerDeskLimit.ts — the gap the 2026-07-18 event
 *                              exposed, where the engine rescued its own workers
 *                              (hold → requeue → tier demotion) while the owner's
 *                              desk sat dead until they happened to look at it.
 *  ('escalation-open' fires from swarmEscalations.ts, 'manager-woke' from the
 *  engine's integrate pass, 'self-update-requested' from the worktree-remove
 *  path, 'daily-fuel-report' from dailyFuelReport.ts's app-uptime loop,
 *  'session-limit' from the owner-desk model-limit watch; the other three are
 *  reserved for the overseer brainstem (C-core) so this union is additive.)
 *   • 'engine-resumed'      — docs/ENGINE_PERSISTENCE_PLAN.md §4 (card 2): boot's
 *                              resumeEngines() found ≥1 project whose engine was
 *                              explicitly running before this restart
 *                              (`desiredRunning` in that project's engine.json,
 *                              manual-stop not set, crash-loop breaker not
 *                              tripped) and resumed it with NO owner action —
 *                              the "re-hydrated across a restart" fact the plan
 *                              says must always be visible (§4-4 "再起動を跨いだ
 *                              事実をオーナーが必ず視認できる"), fired ONCE per
 *                              boot summarizing every project resumed. */
export type SwarmInfoEvent =
  | 'escalation-open'
  | 'escalation-reminder'
  | 'review-idle'
  | 'overseer-throttled'
  | 'manager-woke'
  | 'self-update-requested'
  | 'daily-fuel-report'
  | 'session-limit'
  | 'engine-resumed'
  /** Not a swarm event either (cf. 'session-limit'): the MACHINE has accumulated
   *  orphaned, un-killable processes. See stuckProcessWatch.ts + 07 章 §7. */
  | 'stuck-processes'

/** The payload of a 'swarm-info' notification — the info-grade sibling of
 *  {@link SwarmFatalNotification}: same persisted-bell + OS-toast plumbing,
 *  calmer tone (nothing broke; someone just needs to look). */
export interface SwarmInfoNotification {
  /** Which info event — see {@link SwarmInfoEvent}. */
  event: SwarmInfoEvent
  /** Human-readable one-line summary of WHAT wants attention. */
  detail: string
  /** The project it concerns (canonical path), when known. */
  projectPath?: string
  /** The Board card involved, when card-rooted (display + open-target). */
  taskId?: string
  /** The `swarm/*` branch involved, when known (display-only). */
  branch?: string
  /** The card title involved, when known (display-only). */
  taskTitle?: string
  /** The Escalations-inbox record this points at (escalation-open/-reminder) —
   *  the 導線 to the SwarmModule inbox panel. */
  escalationId?: string
}

/** One in-app notification shown in the Ground お知らせ bell/panel. Composed on
 *  the CLIENT from a notification source (today: {@link CollabInviteForMe} via
 *  polling, or a server-persisted {@link SwarmFatalNotification} /
 *  {@link SwarmInfoNotification}) so the panel can render a kind-specific row +
 *  action. `id` is the STABLE read-state key (persisted server-side via
 *  /api/notifications) — e.g. `collab-invite:<collabProjectId>` or
 *  `swarm-fatal:<event>:<ref>:<createdAt>` — so opening the panel marks it read
 *  and a re-login doesn't resurface it. */
export interface AppNotification {
  id: string
  kind: NotificationKind
  /** Epoch ms for newest-first ordering (absent → sorts last). */
  createdAt?: number
  /** Epoch ms when the owner marked this row HANDLED from the Swarm tab's
   *  needs-attention feed (POST /api/swarm/notifications/handled). Deliberately
   *  NOT the bell's read-state: "I glanced at the bell" must not empty a work
   *  list. The feed hides handled rows — the only way it can return to its quiet
   *  state, since notifications never expire (they leave only by falling out of
   *  the per-kind cap). The bell still shows them; nothing is deleted. */
  handledAt?: number
  /** Present when kind === 'collab-invite'. */
  collabInvite?: CollabInviteForMe
  /** Present when kind === 'swarm-fatal'. */
  swarmFatal?: SwarmFatalNotification
  /** Present when kind === 'swarm-info'. */
  swarmInfo?: SwarmInfoNotification
}

/** GET /api/swarm/notifications — the server-persisted FATAL swarm notifications
 *  (newest-first), the in-app half of the escalation safety valve. Owner-only
 *  (same gate as the rest of /api/swarm/*); a non-owner gets 403 and the bell
 *  simply shows none. */
export interface AppNotificationsResponse {
  notifications: AppNotification[]
}

// ─── Escalations inbox (C1 — docs/OVERSEER_DESIGN.md §8) ────────────────────

/** Why an escalation was raised to the REAL user instead of being auto-answered
 *  by the proxy (the K6/K7 valves):
 *   • 'irreversible'      — the act can't be undone (billing / publish / delete /
 *                            deploy / credentials), so it goes up REGARDLESS of
 *                            the proxy's confidence.
 *   • 'insufficient-info' — the proxy's corpus is too thin to answer (calibrated
 *                            abstention — declared up front, never confabulated).
 *   • 'policy'            — an explicit rule says a human decides this. */
export type EscalationWhy = 'irreversible' | 'insufficient-info' | 'policy'

/** Escalation lifecycle. 'open' → (owner answers) → 'answered' → (the answer is
 *  delivered into the blocked worker's PTY) → 'injected'; or 'open' →
 *  'dismissed' (the owner closes it without answering — nothing is injected,
 *  nothing is written to memory). There is NO transition out of 'open' the
 *  system takes on its own: an unanswered escalation stays open forever
 *  (fail-closed — the whole point of the inbox). */
export type EscalationStatus = 'open' | 'answered' | 'injected' | 'dismissed'

/** The proxy's provisional answer (C2), shown next to the question so the owner
 *  confirms-or-corrects instead of composing from scratch. Absent when the
 *  proxy was skipped (e.g. the overseer's THROTTLED direct-to-inbox path). */
export interface EscalationProxyDraft {
  answer: string
  confidence: 'high' | 'medium' | 'low'
  /** The proxy declared "the corpus is too thin here" UP FRONT (calibrated
   *  abstention, K7) rather than guessing. */
  isAbstention: boolean
}

/** One record of the Escalations inbox (~/.openground/escalations.json —
 *  machine-wide; the project rides in `projectPath`): a question the swarm could
 *  not (or must not) answer for the user, waiting for the REAL user's answer.
 *  Persisted UNCAPPED — an unanswered irreversible decision must never scroll
 *  off; resolved records are pruned by the boot retention sweep instead. */
export interface Escalation {
  id: string
  /** Idempotency key: while an 'open' record with this key exists, re-raising
   *  the same question is a no-op returning the existing record — so an
   *  overseer restart (edge-dedup reset) can never grow the inbox. */
  receiptKey: string
  /** ISO timestamp the question was raised. */
  createdAt: string
  /** The project it belongs to (canonical path). */
  projectPath: string
  /** Coordinates of the BLOCKED worker awaiting this answer, when worker-rooted:
   *  the Board card, its swarm branch, and its live DESK (the delivery target —
   *  `runtime` + the one handle that runtime is addressed by, below). */
  taskId?: string
  branch?: string
  terminalId?: string
  /** WHICH RUNTIME carries the blocked worker — the other half of its address,
   *  without which the handle fields cannot name it. ABSENT ⇒ `'pty'`, so every
   *  record persisted before this field existed keeps meaning exactly what it
   *  meant (the same absent-means-pty rule workerRuntime.ts applies to the
   *  roster; nothing re-reads or migrates escalations.json).
   *
   *  ⚠ WHY THIS IS PERSISTED AND NOT DERIVED AT DELIVERY TIME. An SDK worker's
   *  `terminalId` is EMPTY by the identity invariant (pty ⇔ terminalId,
   *  sdk ⇔ sdkSessionId), so a record carrying only `terminalId` cannot address
   *  one AT ALL: the answer the owner typed had no target, silently fell through
   *  to the next-dispatch queue on every attempt, and the blocked worker waited
   *  for a reply that could not reach it. Rebuilding the handle branches on THIS
   *  field — never on which of the two ids happens to be truthy, which is how a
   *  stale id from an earlier incarnation wins over the live one. */
  runtime?: 'pty' | 'sdk'
  /** The blocked worker's Agent SDK session id. Present only with
   *  `runtime: 'sdk'` — where `terminalId` is empty, and vice versa. */
  sdkSessionId?: string
  /** The question shown to the user — one screen, decidable at a glance. */
  question: string
  /** Why this is being asked + what is at stake (the decision's context). */
  context: string
  /** 平易文 — the same question rendered for a NON-PROGRAMMER owner (direct
   *  owner feedback 2026-07-17: 「escalation の質問の意味が毎回わからない」).
   *  Three mandatory elements when authored: ① what needs deciding, in 1–2
   *  sentences ② the options (A/B…) ③ what each choice leads to, in everyday
   *  language. Technical detail (file:line / branch / logs) stays in
   *  `question`/`context`, which the UI folds behind this text. Optional for
   *  backward compat — records predating this field (and worker-authored
   *  raises, whose question text is itself written plainly per the /order
   *  worker rules) fall back to `question` in the UI. */
  plainQuestion?: string
  /** Path to the EVIDENCE TAIL captured when the escalation was raised — what the
   *  worker was doing right before it stopped. A small text file under
   *  ~/.openground/escalation-shots/, unlinked when the record is pruned.
   *  Runtime-shaped, because the two runtimes have different evidence: a PTY
   *  worker contributes its rendered screen, an SDK worker its recent distilled
   *  event transcript (tool calls / API errors / text). Historically PTY-only,
   *  which left every SDK escalation with no evidence at all — the field name is
   *  kept for the records already on disk. */
  screenshotRef?: string
  /** The proxy's provisional answer + confidence (C2), when it ran. */
  proxyDraft?: EscalationProxyDraft
  /** Which valve raised this — see {@link EscalationWhy}. */
  whyEscalated: EscalationWhy
  /** WHAT THE DECLINE OPTION MEANS, declared by whoever raised the question.
   *   • absent / 'park' — 「このまま保留にしておく」: leave the card where it is.
   *   • 'drop-integration' — 「この作業は見送る（できあがった分も取り込みません）」:
   *     the work must not be integrated. Answering B EXECUTES that.
   *
   *  ⚠ The effect is DECLARED, never inferred from the answer text. 「保留」 and
   *  「見送る」 both read as "hold" to a phrase parser, and they are not the same
   *  act: one leaves a card alone, the other cancels an irreversible merge. The
   *  raiser knows which question it asked; the reader must not guess. */
  declineEffect?: 'park' | 'drop-integration'
  status: EscalationStatus
  /** The owner's actual answer (set on 'answered'; the ONLY text that is ever
   *  written back to you-corpus memory). */
  answer?: string
  answeredAt?: string
  /** Set when the answer was successfully delivered into the worker's PTY. */
  injectedAt?: string
  /** Set when the owner dismissed the question unanswered. */
  dismissedAt?: string
}

/** One inbox row as served by GET /api/swarm/escalations: the record plus the
 *  PTY-tail capture text expanded server-side (so the client needs no extra
 *  asset route). */
export interface EscalationView extends Escalation {
  /** Contents of {@link Escalation.screenshotRef}, when present and readable. */
  screenshot?: string
}

/** GET /api/swarm/escalations[?path=…] — the inbox, newest-first. Owner-only. */
export interface EscalationsResponse {
  escalations: EscalationView[]
}

/** POST /api/swarm/escalations/open — raise a question to the user. `deduped`
 *  is true when an 'open' record with the same receiptKey already existed (the
 *  existing record is returned; nothing was appended, no notification fired). */
export interface EscalationOpenResponse {
  escalation: Escalation
  deduped: boolean
}

/** How the owner's answer reached the blocked worker:
 *   • 'injected' — delivered into the LIVE worker on its own runtime: a
 *                  bracketed paste + Enter for a PTY, one queued turn for an
 *                  SDK session (swarmEscalations' `deliverAnswerToWorker`).
 *   • 'queued'   — the worker is gone; the answer is queued for the card's NEXT
 *                  dispatch (rides the same learning-loop slot as rework
 *                  reasons, so the fresh worker's /order carries it).
 *   • 'skipped'  — nothing to deliver to (no live PTY and no card), or this
 *                  call changed nothing (idempotent re-answer). The record —
 *                  and the memory write-back — still stand. */
export type EscalationDelivery = 'injected' | 'queued' | 'skipped'

/** POST /api/swarm/escalations/answer {id, answer}. `memoryWritten` reports the
 *  you-corpus write-back (owner Q→A only) — best-effort: a memory failure never
 *  blocks unblocking the worker. */
export interface EscalationAnswerResponse {
  escalation: Escalation
  delivery: EscalationDelivery
  memoryWritten: boolean
}

/** POST /api/swarm/escalations/dismiss {id}. */
export interface EscalationDismissResponse {
  escalation: Escalation
}

// ─── Model-quota control plane (swarmQuota's cooling table) ─────────────────

/** The model tiers the swarm may launch on, by CLI `--model` alias, ordered
 *  best→cheapest. The single definition shared by the server's cooling ladder
 *  (`swarmQuota.MODEL_TIER_LADDER`), the quota route's payload, and the client's
 *  "usable models" toggles — so none of them can drift apart. */
export const SWARM_MODEL_TIERS = ['fable', 'opus', 'sonnet', 'haiku'] as const

/** A model tier the swarm launches on, by CLI `--model` alias — best→cheapest.
 *  The single definition: `swarmQuota.ModelTier` aliases this, so the cooling
 *  table's keys and the quota route's payload cannot drift. */
export type SwarmModelTier = (typeof SWARM_MODEL_TIERS)[number]

/** The owner's PERMANENT per-tier allow switch ("使用可能モデル"): `false` means
 *  no swarm `claude` may ever spawn on that tier. A different layer from the
 *  cooling table (swarmQuota): cooling is a SENSOR reading — temporary, expires
 *  on its own — while this is an operating POLICY the owner sets by hand and
 *  that survives restarts / self-updates. They are independent: either one alone
 *  forbids a tier, and lifting a cool never re-enables a disallowed tier. */
export type SwarmAllowedModels = Record<SwarmModelTier, boolean>

/** Default: every tier usable. An absent / hand-corrupted settings field reads
 *  as this (a missing switch must never silently retire a model). */
export const DEFAULT_SWARM_ALLOWED_MODELS: SwarmAllowedModels = {
  fable: true,
  opus: true,
  sonnet: true,
  haiku: true,
}

/** The tier a `desired` tier degrades to under the owner's mask ALONE — cooling
 *  ignored. Walks the ladder down from `desired`, then (if everything below is
 *  off) up to the best enabled tier; null iff every tier is off.
 *
 *  This is the COPY-facing half of the server's launch resolver: the Settings UI
 *  needs to say which model a mode will actually use ("最大出力 = opus" once fable
 *  is switched off) without leaking the transient cooling state into a permanent
 *  policy screen. `swarmLaunch.resolveAvailableTier` is the SAME walk with
 *  "not cooling" ANDed into the predicate — a test pins the two together with an
 *  empty cooling table, so they cannot drift. */
export const effectiveAllowedTier = (
  desired: SwarmModelTier,
  allowed: SwarmAllowedModels,
): SwarmModelTier | null => {
  const from = Math.max(0, SWARM_MODEL_TIERS.indexOf(desired))
  for (let i = from; i < SWARM_MODEL_TIERS.length; i++) {
    if (allowed[SWARM_MODEL_TIERS[i]]) return SWARM_MODEL_TIERS[i]
  }
  return SWARM_MODEL_TIERS.find((t) => allowed[t]) ?? null
}

/** One ladder row of the cooling table. `until` is the epoch ms the tier frees
 *  up, and is non-null EXACTLY when `cooling` (an elapsed mark reads as
 *  available — the table expires lazily). */
export interface SwarmQuotaTier {
  tier: SwarmModelTier
  cooling: boolean
  until: number | null
}

/** GET /api/swarm/quota, and the echo of POST /api/swarm/quota/cool|uncool. */
export interface SwarmQuotaResponse {
  /** Server clock the snapshot was taken at (the cooling flags are relative to it). */
  now: number
  tiers: SwarmQuotaTier[]
  /** The tier the NEXT top-tier launch resolves to: the highest tier that is both
   *  ENABLED ({@link Settings.swarmAllowedModels}) and has headroom. Null when
   *  nothing is spawnable — every enabled tier cooling (the engine parks until
   *  {@link SwarmQuotaResponse.allCoolingUntil}) or every tier switched off (no
   *  reset exists; the engine escalates). The only field here that honors the
   *  mask — `tiers` / `allCoolingUntil` report the raw cooling table. */
  launchTier: SwarmModelTier | null
  /** Earliest reset among the tiers iff ALL are cooling; null otherwise. Pure
   *  cooling — a switched-OFF tier still counts as "not cooling" here, because
   *  this is the cooling table's own answer (the engine's park gate is the mask-
   *  aware one). */
  allCoolingUntil: number | null
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
  /** False while work mode (lockdown) is on — the marketplace routes 503, so
   *  the client hides its "Browse marketplace" entries. Local module CRUD is
   *  unaffected (it never leaves the machine). */
  marketAvailable: boolean
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

// ─── Proxy judgment corpus ("you-corpus") ────────────────────────────────────
// The autonomous-overseer proxy's externalised JUDGMENT AXIS (Phase 0). A single
// injectable file assembled from CONCEPT.md + the OPEN GROUND auto-memory +
// hand-added judgments. PERSONAL data — lives only under ~/.openground, never
// git-shared. Engine: src/lib/server/youCorpus.ts; routes: server/routes/youCorpus.ts.

/** One hand-added judgment — the growing, "new decision" source of the corpus.
 *  Stored as a JSON array in ~/.openground/you-corpus-additions.json and rendered
 *  into the single you-corpus.md. */
export interface ManualJudgment {
  id: string
  text: string
  tags?: string[]
  context?: string
  addedAt: string
  /** Set when this judgment CORRECTS an earlier one: that judgment's `id`.
   *  `context` carries a human-readable quote of the corrected note (what the
   *  owner and the overseer actually read), but a quote is capped and can
   *  repeat — this is the exact link, so the chain stays followable no matter
   *  how the prose is worded. Absent on a plain note, and on every correction
   *  written before this field existed. */
  correctsId?: string
  /** ⚠ THE OWNER'S OWN WORDS THIS LINE WAS DISTILLED FROM, verbatim.
   *
   *  Most lines in this file were not typed by him: a model read what he wrote
   *  and produced a sentence ABOUT him. That sentence is the useful form and the
   *  unfalsifiable one — 「説明が要る画面は、画面のほうが悪い」 is either a fair
   *  reading of what he said or a small invention, and until now there was no
   *  way to tell which. `source` is what makes it checkable.
   *
   *  ⚠ NOT `context`. That field says WHERE a line came from (「この会話 ・ 08月16
   *  日」) — a label. This is the material itself.
   *
   *  Absent on everything written before this field existed, and on lines whose
   *  origin genuinely was not recorded. Absent is NOT empty: the screen says
   *  「元の言葉は残っていません」 rather than showing a blank quote. */
  source?: string
  /** ⚠ A TOMBSTONE, NOT A BELIEF. Set on a record whose only job is to say
   *  「これは取り消した」 about another one: that judgment's `id`. The retired line
   *  itself is NEVER touched — this file is append-only, and a record the owner
   *  took back is still a record of what he once said. Readers drop both (the
   *  target and this marker); the list screen shows the target in its own
   *  greyed group, dated by this record's `addedAt`.
   *
   *  A record carrying this (or `restoredId`) is bookkeeping and must never be
   *  rendered as something the owner believes. */
  retiredId?: string
  /** The opposite marker: 「やっぱり戻す」. Same target id, appended later.
   *
   *  ⚠ TWO FIELDS RATHER THAN ONE TOGGLE, and that is the whole design. A single
   *  field flipped on each append would make a double-click (or two windows)
   *  cancel itself out and RESURRECT a line the owner deliberately took back.
   *  Two self-describing events are idempotent: retire twice is retired, restore
   *  twice is live, and the log still reads in order. */
  restoredId?: string
}

/** Lightweight result of assembling/appending (POST /api/you-corpus/rebuild and
 *  the meta half of POST /api/you-corpus/append). */
export interface YouCorpusMeta {
  /** Absolute path of the assembled file (~/.openground/you-corpus.md). */
  path: string
  assembledAt: string
  sizeBytes: number
  /** Count of auto-memory notes ingested (excludes the MEMORY.md index). */
  memoryCount: number
  manualCount: number
  conceptIncluded: boolean
  businessVisionIncluded: boolean
  /** true when assembly REFUSED to overwrite the existing corpus because no
   *  mechanical source (auto-memory / CONCEPT.md) resolved while the existing
   *  file was built with them — a source-resolution failure, not real emptiness.
   *  The on-disk corpus is untouched; the other fields describe it. */
  skipped?: boolean
  /** Human-readable reason accompanying `skipped` (also logged server-side). */
  warning?: string
}

/** GET /api/you-corpus — status of the assembled corpus + which sources are
 *  currently available (so the UI/CLI can show what would feed a rebuild). */
export interface YouCorpusStatus {
  path: string
  exists: boolean
  sizeBytes: number
  /** mtime of the assembled file, or null when it has never been assembled. */
  assembledAt: string | null
  manualCount: number
  /** Resolved auto-memory dir (null when it could not be resolved). */
  memoryDir: string | null
  memoryDirExists: boolean
  memoryCount: number
  conceptPath: string | null
  conceptExists: boolean
  businessVisionExists: boolean
}

/** POST /api/you-corpus/append — the stored judgment + the refreshed meta. */
export interface YouCorpusAppendResponse {
  judgment: ManualJudgment
  meta: YouCorpusMeta
}

/** GET /api/you-corpus/judgments — the hand-added judgments as STRUCTURED
 *  records, newest first. The assembled you-corpus.md renders the same set as
 *  prose for the proxy to read; this is the shape a UI needs to show them one
 *  per card (date, tags, and the note a correction carries) and is why the
 *  Persona tab does not have to parse the rendered markdown back apart. */
export interface YouCorpusJudgmentsResponse {
  judgments: ManualJudgment[]
  /** ⚠ NEVER MERGED INTO `judgments`. These are the lines the owner TOOK BACK:
   *  the stand-in does not read them, they are not counted as 「わかっていること」,
   *  and they do not sit on the body. They are returned because a record you
   *  cannot see is a record you cannot get back — the list screen shows them in
   *  their own greyed group, and pressing one offers 「戻す」. */
  retired: RetiredJudgment[]
}

/** One line the owner took back, paired with WHEN he took it back. The pair is
 *  built server-side because only the reader can see the tombstone that carries
 *  the date; the client is handed the fact, never the bookkeeping. */
export interface RetiredJudgment {
  judgment: ManualJudgment
  retiredAt: string
}

// ─── The interview loop (ペルソナタブの「今日の1問」) ─────────────────────────
// One question a day, generated FROM the owner's own recorded work — never a
// personality quiz. Engine: src/lib/server/personaInterview.ts.

/** Which observation produced a question. Every kind names a concrete, DURABLE
 *  fact (an escalation's timestamps, a card's column/rework counter) — there is
 *  no generic/"about you" kind, and adding one would defeat the point of the
 *  loop. Recorded on the question so an answer lands in the corpus tagged with
 *  what prompted it. */
export type PersonaQuestionKind =
  | 'decision-speed-contrast'
  | 'escalation-answer-rule'
  | 'escalation-dismissed'
  | 'escalation-long-open'
  | 'corpus-gap'
  | 'card-rework'
  | 'card-approved'
  | 'card-stale-blocked'
  | 'todo-passed-over'

/** The question asked on one local day.
 *
 *  The rendered TEXT is stored, not an i18n key plus slots: this is an artifact
 *  with a lifetime (asked → answered → written into the corpus), so its wording
 *  must be frozen at generation time. Re-rendering later through a since-edited
 *  template would misquote what the owner was actually asked — the same reason
 *  `Escalation.question` is a stored string. */
export interface PersonaQuestion {
  id: string
  /** Local 'YYYY-MM-DD' this question belongs to (the once-a-day key). */
  date: string
  kind: PersonaQuestionKind
  /** Stable key for the OBSERVATION behind the question (not the wording), so
   *  the same situation is never asked about twice even across restarts. */
  subjectKey: string
  /** THE SETTING, one sentence, shown ABOVE the question (2026-08-15). Says
   *  when it happened and what kind of moment it was, so the quoted fragments
   *  in `text*` land in a scene instead of arriving naked. Frozen at generation
   *  for the same reason the question is. Optional ONLY so questions written by
   *  an older build stay renderable — every new one carries it. */
  contextJa?: string
  contextEn?: string
  /** The question, frozen at generation. JA is what reaches the corpus — the
   *  corpus is the owner's own, and the escalation write-back is Japanese too. */
  textJa: string
  textEn: string
  createdAt: string
  status: 'open' | 'answered' | 'skipped'
  /** Set when answered or skipped. The ANSWER TEXT is deliberately not stored
   *  here — it goes to the corpus via appendJudgment, which stays its one home. */
  resolvedAt?: string
}

/** 「どれが自分ではないか」 — three lines, one of which is not his.
 *
 *  ⚠ THE ANSWER IS NOT IN THIS SHAPE, and that is deliberate: sending it to the
 *  browser would put the answer in the page the question is asked on. This is a
 *  tool for finding out something true about yourself, so the one reader who
 *  must not be able to peek is the owner. */
export interface PersonaTellApartCheck {
  id: string
  options: { id: string; text: string }[]
}

/** What answering it was. ⚠ NO SCORE, EVER. Getting one wrong does not make a
 *  line false — it means the line reads like something anyone would say, which
 *  is a fact about the sentence and fixable by rewriting or withdrawing it. */
export interface PersonaTellApartResult {
  correct: boolean
  /** The line he mistook for a stranger's, when he did. */
  mistookText?: string
  /** The stranger's own words, so a wrong answer ends by showing what a
   *  fits-anyone sentence looks like beside his own. */
  strangerText: string
}

/** POST /api/you-corpus/tell-apart — the open check, or null when none is due.
 *  Null is the ordinary answer: the check is offered once the record has grown
 *  by ten lines, not on a schedule. */
export interface PersonaTellApartResponse {
  check: PersonaTellApartCheck | null
}

/** POST /api/you-corpus/tell-apart/answer. */
export type PersonaTellApartAnswerResponse = PersonaTellApartResult

/** ~/.openground/persona-interview.json — the persisted once-a-day state. */
export interface PersonaInterviewState {
  version: 1
  /** Local 'YYYY-MM-DD' of the last day a question was generated. Bumped even
   *  when generation found NO material, so a barren day is not retried all day. */
  lastAskedDate: string
  /** The question for `lastAskedDate`, or null when that day yielded none. */
  today: PersonaQuestion | null
  /** subjectKeys already asked about, newest last, capped. The dedup memory. */
  askedSubjects: string[]
}

/** GET/POST /api/you-corpus/interview — today's question, if there is one.
 *
 *  `reason` explains a null question so the tab can say something true instead
 *  of implying the loop is broken:
 *  - 'no-material' — the day WAS swept and the owner's records held nothing to
 *    ask about (the honest empty state).
 *  - 'not-generated' — the day has not been swept yet. Only the read-only GET
 *    can report this; the POST sweeps before answering. The two must stay
 *    distinct: reporting "nothing to ask" for a day nobody looked at is the
 *    same false claim `questionLoaded` and `showNotes` exist to prevent. */
export interface PersonaInterviewResponse {
  question: PersonaQuestion | null
  reason?: 'no-material' | 'not-generated'
  /** Set on the ANSWER path when the judgment was saved but the file the
   *  stand-in actually reads could not be rebuilt (YouCorpusMeta.skipped). The
   *  tab must not say "your stand-in has this now" in that case — the note form
   *  already tells the truth here (persona.meta.stale) and this carries the same
   *  signal for the question. */
  corpusStale?: boolean
}

// ── Research channels (Settings → Research channels; docs/RESEARCH_REACH_NOTES.md) ──

/** The seven research channels the checker knows. Fixed vocabulary — the UI
 *  maps ids to localized names, so adding one means adding copy in BOTH
 *  locales (src/i18n/messages/settings.ts). */
export type ResearchChannelId =
  | 'web'
  | 'websearch'
  | 'twitter'
  | 'reddit'
  | 'youtube'
  | 'github'
  | 'rss'

/** ok = usable now / part = usable with limits (detail says which) / miss =
 *  not usable until set up. */
export type ResearchChannelStatus = 'ok' | 'part' | 'miss'

/** One channel's verdict from GET /api/research/channels. `detail` is an
 *  enumerable per-channel variant key (e.g. github: 'cli' | 'baseline' |
 *  'unreachable') the i18n layer turns into copy; `unlockCommand` is the
 *  copyable one-liner when a single honest install command exists. */
export interface ResearchChannelState {
  id: ResearchChannelId
  status: ResearchChannelStatus
  detail: string
  unlockCommand?: string
}

export interface ResearchChannelsResponse {
  channels: ResearchChannelState[]
}

/** GET /api/research/auth — booleans ONLY, never the stored values (the
 *  local-only promise; see researchAuth.ts). */
export interface ResearchAuthStatusResponse {
  twitterConfigured: boolean
}

/** POST /api/research/auth. Both values non-empty ⇒ save; both empty strings
 *  ⇒ clear; anything else is a 400 (one cookie without the other can't work). */
export interface SetResearchAuthRequest {
  twitterAuthToken: string
  twitterCt0: string
}

/** One row of the per-project research library (GET /api/research/reports —
 *  docs/research/*.md, newest first). */
export interface WordPressSettings {
  /** Site root, e.g. https://eigotrip.com — https required (Basic auth rides
   *  every request; loopback http is allowed for local testing only). */
  baseUrl: string
  username: string
  appPassword: string
}

/** Where a research report stands on the owner's blog (the publish ledger's
 *  public face — blogPublish.ts).
 *   - 'draft'         — a WP draft exists and mirrors the report.
 *   - 'edited-on-wp'  — the owner touched the draft on the WP side (edited or
 *                       published); the sweep will never overwrite it again.
 *   - 'deleted-on-wp' — the owner deleted the draft; not re-created unless the
 *                       REPORT itself is rewritten (a redo earns a new draft).
 *   - 'failed'        — the last attempt failed; `error` says why (scrubbed). */
export type ResearchBlogState = 'draft' | 'edited-on-wp' | 'deleted-on-wp' | 'failed'

export interface ResearchReportBlogInfo {
  state: ResearchBlogState
  /** WP edit-screen URL for the post, when known (display-only). */
  link?: string
  /** For 'failed': the scrubbed reason (never contains credentials). */
  error?: string
}

export interface ResearchReportMeta {
  file: string
  title: string
  mtime: number
  size: number
  /** Present when a WordPress target is configured and this report has a
   *  publish-ledger entry (additive — old clients ignore it). */
  blog?: ResearchReportBlogInfo
}

export interface ResearchReportsResponse {
  reports: ResearchReportMeta[]
}

/** GET /api/research/report — one report's raw markdown. */
export interface ResearchReportResponse {
  file: string
  content: string
}

// ─── Research knowledge (docs/RESEARCH_KNOWLEDGE_PITCH.md) ──────────────────
// The knowledge layer over ONE report: a distilled digest + a Q&A history,
// produced by the owner's own `claude` (explicit button, never automatic) and
// stored CENTRALLY (~/.openground/projects/<uuid>/research-knowledge/) — the
// repo itself is never written.

/** The distilled essence of one report, in ONE language (the prompt language
 *  at generation time — regenerating is the language switch, and any stored
 *  text always beats a blank; see descriptionForLang's lesson). */
export interface ResearchDigest {
  /** One sentence naming what the report found. */
  tldr: string
  /** 3..6 one-sentence key points, in the model's order. */
  points: string[]
  lang: 'en' | 'ja'
  /** sha1 of the report text this digest was distilled from — the UI compares
   *  it against the live file to say 「前の版から作られました」 instead of
   *  silently serving stale essence. */
  contentSha: string
  generatedAt: string
}

/** One question asked of one report, with its answer. Append-only history. */
export interface ResearchQaEntry {
  q: string
  a: string
  at: string
}

/** The sidecar file, as stored. `digest` absent = never generated. */
export interface ResearchKnowledgeFile {
  file: string
  digest?: ResearchDigest
  qa: ResearchQaEntry[]
}

/** GET /api/research/knowledge — the sidecar plus the ONE derived fact the
 *  client cannot compute (whether the live report still matches the digest). */
export interface ResearchKnowledgeResponse {
  file: string
  digest?: ResearchDigest
  qa: ResearchQaEntry[]
  /** true = the report's current text differs from digest.contentSha. Absent
   *  when there is no digest to be stale. */
  digestStale?: boolean
}

/** POST /api/research/digest | /api/research/ask → 202 with the job to poll.
 *  503 carries claudeMissing | claudeLoggedOut (the shared preflight). */
export interface ResearchJobStartResponse {
  jobId: string
}

/** GET /api/research/job/:id — poll shape. On 'done' the result is already
 *  PERSISTED server-side; the client re-reads /api/research/knowledge. */
export interface ResearchJobStateResponse {
  id: string
  kind: 'digest' | 'ask'
  file: string
  status: 'running' | 'done' | 'error'
  startedAt: string
  error?: string
}

// ─── Persona regions (the five parts of the figure) ─────────────────────────
// The figure is an armature: four BODY regions plus one halo around it. This
// union lives here rather than beside the drawing code because it crosses the
// wire (PersonaCoursesResponse below) and rides in corpus tags (`region:<id>`,
// src/lib/persona/regions.ts REGION_TAG).
//
// It is deliberately a NARROW union rather than a string: every runtime record
// keyed by it (labels, course seating, question seating) is an exhaustive
// `Record<PersonaRegion, …>`, so adding or removing a region fails the BUILD
// instead of quietly seating a note nowhere. The predecessor of this type was a
// wire-level `zone: string` with a silent `asZone()` fallback to 'mind' — a
// dropped region produced a wrong-but-plausible figure and never an error.
//
//   head   — how you think          chest  — what you hold to
//   arms   — how you work           legs   — how you keep going
//   people — the people around you (the HALO, off the body: see
//            PERSONA_BODY_REGIONS for why nothing lands there without evidence)
export type PersonaRegion = 'head' | 'chest' | 'arms' | 'legs' | 'people'

// ─── Persona courses (Persona tab の診断コース) ──────────────────────────────
// Items + scoring live in src/lib/persona/instruments.ts (pure); the store and
// routes in src/lib/server/personaCourses.ts + server/routes/persona.ts.

export type PersonaCourseId = 'big5' | 'type' | 'values' | 'work'

/** One line of a result sheet. `bars` rows carry pct/note; `rank` rows carry
 *  rank/score. Both shapes ride in one type so the sheet renders from one list. */
export interface PersonaResultRow {
  key: string
  name: string
  desc: string
  /** bars only: 0..100 fill. For a BIPOLAR axis the fill is toward the second
   *  pole, so 50 reads as "half and half" against the mid-line. */
  pct?: number
  /** bars only: 高め / ほぼ半々 … — the honest confidence word. */
  note?: string
  bipolar?: boolean
  /** rank only. */
  rank?: number
  score?: string
}

/** What a finished course contributes to the corpus: one node each. */
export interface PersonaFinding {
  text: string
  /** Provenance shown under the node — instrument + the number it came from. */
  detail: string
}

export interface PersonaResult {
  courseId: PersonaCourseId
  courseName: string
  /** Printed verbatim on the sheet (licensing/provenance promise). */
  source: string
  itemCount: number
  kind: 'bars' | 'rank'
  rows: PersonaResultRow[]
  findings: PersonaFinding[]
  headline: string
  /** type course only: the four letters. */
  badge?: string
}

/** A stored, dated result. */
export interface PersonaCourseRecord {
  result: PersonaResult
  takenAt: string
  /** Raw answers, kept so a re-scoring after an instrument fix is possible. */
  answers: number[]
}

/** GET /api/persona/courses — every course's catalogue entry + last result. */
export interface PersonaCoursesResponse {
  courses: {
    id: PersonaCourseId
    name: string
    sub: string
    /** Which region of the figure this course grows. NARROW on purpose — the
     *  client seats the course's findings by it, and a plain string let an
     *  unknown value fall through a silent default. */
    region: PersonaRegion
    itemCount: number
    source: string
    lastTakenAt: string | null
    headline: string | null
    /** The result's short name, when the instrument produces one — the 16-type
     *  course's four letters (ENTP). null for the courses whose result is a
     *  profile rather than a label (big5 / values / work), and null for a course
     *  never taken. On the LIST payload, not just the sheet, because the panel
     *  shows a taken course's result inline (owner, 2026-08-16: 「NBTIだったら、
     *  ENTPとかあるじゃん。そういうの」). */
    badge: string | null
  }[]
}

/** POST /api/persona/courses/:id/submit — body: the full answer vector. */
export interface SubmitPersonaCourseRequest {
  answers: number[]
}

/** POST result: the scored sheet + how many corpus nodes it minted. */
export interface SubmitPersonaCourseResponse {
  record: PersonaCourseRecord
  minted: number
}

/** One composed line of the persona portrait — a glance-level statement that
 *  always carries the instrument and number it came from. */
export interface PersonaPortraitLine {
  text: string
  detail: string
  courseId: PersonaCourseId
  takenAt: string
  /** Age of the evidence in days (absent when the stamp is unparseable). */
  ageDays?: number
}

/** GET /api/persona/portrait — the "who am I, roughly" digest + the counts the
 *  screen shows beside it. `lines` is EMPTY when nothing is evidenced yet. */
export interface PersonaPortrait {
  lines: PersonaPortraitLine[]
  /** How much the stand-in holds. ⚠ OPTIONAL, and the option is the point:
   *  `undefined` means THE CORPUS COULD NOT BE READ, which is not the same
   *  claim as 0. The corpus reader fails CLOSED on EACCES/EIO (an append must
   *  never overwrite judgments it merely failed to see), so a read failure is a
   *  real and recurring state — and a screen that renders it as `0 known` tells
   *  the owner their record is empty when it may be entirely intact. Same
   *  three-valued rule the ledger and the escalation counts follow: absent is
   *  not zero, and only a read that landed may print a number. */
  nodeCount?: number
  /** …and how many of those arrived in the last 7 days. Absent for the same
   *  reason, plus one more: a server too old to count is not a quiet week. */
  recentCount?: number
  takenCount: number
  courseCount: number
}

/** GET /api/persona/courses/:id/history — every stored take of one course,
 *  NEWEST FIRST (the last result is the first entry). */
export interface PersonaCourseHistoryResponse {
  courseId: PersonaCourseId
  takes: PersonaCourseRecord[]
}

// ─── Persona DECISION LEDGER (what the stand-in actually did) ────────────────
//
// The courses above are SELF-REPORT; this is the record of the proxy acting
// against real work. Store + writer: src/lib/server/personaLedger.ts.

/** What the stand-in did with one question.
 *  - `answered`  — it answered AS the owner (the proxy spoke for them).
 *  - `asked`     — it refused to speak and handed the question to the owner
 *                  (irreversible, or an area the owner decides).
 *  - `abstained` — it declared it could not faithfully answer (thin corpus, or a
 *                  brain that never produced a usable verdict). */
export type PersonaLedgerVerdict = 'answered' | 'asked' | 'abstained'

/** WHY the stand-in declined to speak — the reason CLASS, never the free text.
 *  Mirrors `OwnerAnswer`'s escalate `why` (swarmOverseerBrain.ts), which is where
 *  every value comes from.
 *
 *  A UNION, not `string`, ON PURPOSE. The screen turns each member into words; a
 *  member with no wording renders as nothing, which is a SILENT gap — the failure
 *  mode this repo's canon says to convert into a loud one. As a union, adding a
 *  fourth class upstream fails the build at the exhaustive `Record<PersonaLedgerWhy,
 *  …>` in PersonaLedgerBlock instead of quietly dropping the reason on screen.
 *  ⚠ Narrowing the TYPE is only honest because the READER narrows too: the ledger's
 *  sanitizer drops a `why` it does not recognise (a hand-edited or newer-build file
 *  can hold anything), so what the type promises is what reaches the wire. */
export type PersonaLedgerWhy = 'irreversible' | 'insufficient-info' | 'policy'

/** ONE proxy-you decision. Free text (`question`) is TRUNCATED at the store's
 *  cap — this is a record of decisions, not a transcript. */
export interface PersonaLedgerEntry {
  id: string
  /** ISO timestamp the decision SETTLED. */
  at: string
  projectPath: string
  verdict: PersonaLedgerVerdict
  /** The escalate `why` / abstain reason CLASS — never the free-text reason.
   *  Absent on a plain answer. */
  why?: PersonaLedgerWhy
  /** The question the stand-in faced, truncated (see MAX_LEDGER_QUESTION). */
  question: string
  /** How well the corpus grounded the answer. Present only on `answered`. */
  confidence?: 'high' | 'medium' | 'low'
  /** Correlation key (project + normalized question prefix) used to stamp
   *  `answered` when the owner later answers the escalation this entry raised.
   *  Opaque — never rendered. */
  key?: string
  /** Stamped when the OWNER themselves answered the escalation this decision
   *  raised: the proxy asked, the human decided. The highest-value signal here —
   *  it is the correction the stand-in can be measured against. */
  answered?: { at: string; byOwner: true }
}

/** Verdict tallies over one window. */
export interface PersonaLedgerCounts {
  answered: number
  asked: number
  abstained: number
}

/** The counts the Persona screen reads ("this week it answered 3 and asked you 2").
 *  `week` is the trailing 7 days; `total` is everything the (capped) ledger holds. */
export interface PersonaLedgerSummary {
  week: PersonaLedgerCounts
  total: PersonaLedgerCounts
  /** ISO stamp of the most recent decision, or null when nothing is recorded. */
  lastAt: string | null
}

/** GET /api/persona/ledger — the counts plus the newest entries. LOOPBACK-ONLY:
 *  `recent` carries free text from the owner's own local work. */
export interface PersonaLedgerResponse {
  summary: PersonaLedgerSummary
  /** Newest first, capped (see LEDGER_RECENT_LIMIT). */
  recent: PersonaLedgerEntry[]
}

// ─── Persona conversation (話しかけると溜まる) ───────────────────────────────
// Talking to the persona IS how the corpus grows: one turn = one `claude` run
// that both REPLIES and distils what the owner said into kept lines. Engine:
// src/lib/server/personaChat.ts (+ personaImport.ts for a claude.ai export);
// routes: server/routes/personaChat.ts.
//
// TWO INVARIANTS RIDE IN THESE TYPES, so read them before changing a field:
//  1. ONLY THE OWNER'S WORDS ARE EVER LEARNED. `reply` and `kept` are separate
//     fields for a reason — the writer that appends to the corpus takes the kept
//     lines and NOTHING else (personaChat.ts appendKeptLines). Merging them into
//     one "turn text" would put the stand-in's own sentences into the axis it is
//     supposed to be judged against.
//  2. NOTHING IS WRITTEN INVISIBLY. Every write comes BACK as a full
//     PersonaKeptWrite carrying the stored judgment, so the screen can show each
//     kept line under the message it came from and open a correction on it with
//     no second round-trip. An absent chip must never mean "we saved something
//     you cannot see".

/** One line the distiller decided to keep — AS IT WAS ACTUALLY WRITTEN.
 *
 *  The FULL `judgment` (not just its id) rides back so the chip under the reply
 *  is pressable immediately: the correction composer needs the stored text, the
 *  stamp and the id, and re-fetching /judgments to find a row we just wrote is a
 *  race against the corpus reassembly. */
export interface PersonaKeptWrite {
  judgment: ManualJudgment
  /** Where it was seated on the figure. Written as an explicit `region:<id>`
   *  tag (regions.ts REGION_TAG) so the seating rule's tier 1 reads it back. */
  region: PersonaRegion
  /** The judgment WAS saved, but you-corpus.md could not be rebuilt — so the
   *  file the stand-in actually reads is stale (YouCorpusMeta.skipped). Same
   *  signal, same wording family as PersonaInterviewResponse.corpusStale. */
  corpusStale?: true
}

export type PersonaChatTurnState = 'running' | 'done' | 'failed'

/** One exchange. `text` is the owner's words EXACTLY as typed — a failed turn
 *  keeps them so the screen can re-offer them rather than swallowing what they
 *  wrote (a React value reset is not undoable). */
export interface PersonaChatTurn {
  id: string
  askedAt: string
  text: string
  state: PersonaChatTurnState
  /** Set on 'done'. The stand-in's answer — NEVER learned (invariant 1). */
  reply?: string
  /** Set on 'done'. What reached the corpus, in the order it was written. An
   *  EMPTY array is a real answer ("nothing was kept this time") and must be
   *  rendered as one; `undefined` only means the turn has not finished. */
  kept?: PersonaKeptWrite[]
  /** Kept lines the distiller emitted that could not be READ (no region token,
   *  or one that is not a region we know). Dropped rather than guessed at — but
   *  reported, because a count that hides its own losses is the failure this
   *  screen keeps re-hitting. */
  keptUnreadable?: number
  /** Set on 'failed'. */
  error?: string
}

/** GET /api/persona/chat — the thread so far, so re-opening the panel does not
 *  lose it. IN-MEMORY on the server: a restart empties this (the kept lines
 *  themselves are in the corpus and survive). `live` = a turn is in flight. */
export interface PersonaChatStateResponse {
  turns: PersonaChatTurn[]
  live: boolean
}

/** POST /api/persona/chat → 202. The turn runs as a JOB, not on this
 *  connection: closing the panel mid-turn must not orphan a `claude`. */
export interface PersonaChatStartResponse {
  turnId: string
}

/** GET /api/persona/chat/turn/:id — polled at ~500ms while `state` is running.
 *  `elapsedMs` is REAL elapsed time: a turn is a whole cold `claude` start
 *  (tens of seconds), and a fake typing animation over that is a lie. */
export interface PersonaChatTurnResponse {
  state: PersonaChatTurnState
  elapsedMs: number
  reply?: string
  kept?: PersonaKeptWrite[]
  keptUnreadable?: number
  error?: string
}

export interface PersonaChatCancelResponse {
  cancelled: boolean
}

/** What PARSING a claude.ai export found, before anything is distilled. Every
 *  field is reported — including the ones that are losses — because the numbers
 *  have to add up on screen: `ownerMessages = considered + notConsidered`, and
 *  `droppedNonOwner` is the stand-in's half that rule 1 of claudeExport.ts drops. */
export interface PersonaImportCounts {
  conversations: number
  ownerMessages: number
  /** Rows that could not be read as a conversation or a message. */
  unreadable: number
  droppedNonOwner: number
  /** How many of the owner's messages the distiller actually SAW (capped). */
  considered: number
  /** ownerMessages - considered. MANDATORY, even at 0. */
  notConsidered: number
}

export interface PersonaImportResult extends PersonaImportCounts {
  kept: PersonaKeptWrite[]
  /** Kept lines that already existed word-for-word in the corpus and were NOT
   *  written a second time. */
  duplicatesSkipped: number
  keptUnreadable: number
}

/** POST /api/persona/import → 202, or 409 when this exact file was imported
 *  before (ManualJudgment has no idempotency key, so a second run of the same
 *  bytes would double both the node count and the lit points). */
export interface PersonaImportStartResponse {
  importId: string
}

/** GET /api/persona/import/:id. `counts` lands as soon as PARSING finishes —
 *  before the distillation does — so the screen can show what arrived while it
 *  is still reading. `result` only exists on 'done'. */
export interface PersonaImportJobResponse {
  state: PersonaChatTurnState
  elapsedMs: number
  counts?: PersonaImportCounts
  result?: PersonaImportResult
  error?: string
}

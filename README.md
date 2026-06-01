# OPEN GROUND

**Mission control for everything you build with Claude Code** — one canvas for
all your projects, so you stop juggling terminal windows.

OPEN GROUND renders every folder in your projects directory as a tile on a
pannable, zoomable canvas. From that single surface you launch Claude Code in
any project, track its tasks, and read at a glance "where each project stands
now" — the summary of its last run. It's a multiplexer for the
`cd → claude → repeat → juggle tabs` workflow, not a single-project IDE plugin.

---

## Prerequisites

- **macOS on Apple Silicon (arm64)** or **Windows (x64)**. Both download from
  the same [Releases](https://github.com/nannantown/open-ground/releases) page:
  a signed + notarized macOS `.dmg`, and a Windows NSIS `.exe` (unsigned — see
  the SmartScreen note under **Install** / **Platform support**).
- **The `claude` CLI (Claude Code), installed and signed in.** OPEN GROUND
  drives your *local* `claude` CLI as a child process — it does **not** use an
  Anthropic API key.
- **An active Claude subscription** (Pro / Max). OPEN GROUND is
  **subscription-only**: every run bills against your normal Claude Code usage,
  exactly as if you'd run `claude` in a terminal yourself.

If you can run `claude` in a terminal and it works, OPEN GROUND will work.

> Don't have the CLI yet? Install **Claude Code** from Anthropic, run `claude`
> once to sign in, then launch OPEN GROUND. Settings shows a green "claude CLI
> detected" check when you're ready.

---

## Install

Grab the latest build for your platform from the
[Releases](https://github.com/nannantown/open-ground/releases) page.

### macOS (Apple Silicon)

1. Download `OPEN GROUND-*.dmg`.
2. Open the `.dmg` and drag **OPEN GROUND** into **Applications**.
3. Launch it from Applications (or Spotlight).

The macOS build is signed and notarized, so Gatekeeper opens it without the
"unidentified developer" warning.

### Windows (x64)

1. Download `OPEN GROUND-*-Setup.exe` (NSIS installer).
2. Run it. Because the Windows build is **unsigned**, Windows SmartScreen
   shows a blue *"Windows protected your PC"* dialog. Click **More info**,
   then **Run anyway** to continue. (This is a one-time bypass per download.)
3. Finish the installer (you can choose the install location), then launch
   OPEN GROUND from the Start menu.

> Windows support is newer and not yet validated on every machine — if
> something misbehaves, please [file an issue](https://github.com/nannantown/open-ground/issues).

---

## First launch

1. **Pick your projects folder.** On first run, OPEN GROUND asks for a
   *projects root* — the folder that contains your project subfolders (e.g.
   `~/projects`). Each subfolder becomes a tile on the canvas. You can change
   this any time in **Settings → Projects folder**.
2. **Confirm Claude Code is ready.** Open **Settings**; the *Claude Code CLI*
   section shows a green check when `claude` is detected. If it's missing,
   you'll see a hint to install it and sign in. (Trying to run a project
   without the CLI shows a clear message instead of failing silently.)
3. **Run a project.** Open a tile, add or pick a task, and launch it through
   Claude Code. The tile's hero text becomes the summary of that last run.

---

## FAQ

**Does this need an API key?**
No. OPEN GROUND is subscription-only — it runs your local `claude` CLI, which
uses your Claude subscription. There is nowhere to paste an API key.

**Where does my data live?**
App-level config (your projects-folder choice, canvas layout, run history) is in
`~/.openground/`. Per-project data (tasks, canvases) is in a `.openground/`
folder *inside each project*. OPEN GROUND owns that folder; Claude is told not
to touch it. Your code and git history are never modified except by the runs you
explicitly launch.

**Is it safe to point it at my real projects?**
Yes — it only reads/writes inside your chosen projects root, and runs Claude
Code in the project's own directory just like you would by hand. Runs can be
isolated in git worktrees so parallel work doesn't collide.

**Which platforms are supported?**
macOS on Apple Silicon (signed + notarized `.dmg`) and Windows x64 (NSIS
`.exe`). The Windows build is **unsigned**, so first launch needs the
SmartScreen *More info → Run anyway* bypass, and it hasn't been validated on
every Windows machine yet. Linux and Intel Mac aren't built. See
[`docs/DISTRIBUTION.md`](docs/DISTRIBUTION.md) §6 for the Windows details.

**How do updates work?**
OPEN GROUND checks GitHub Releases on launch and shows a non-blocking banner
when a newer version is out; packaged builds also auto-download it in the
background and offer a "Restart now / Later" prompt (never mid-run).

---

## Feedback & support

Found a bug or have an idea? Please
[open an issue](https://github.com/nannantown/open-ground/issues) with your
macOS version, what you did, and what happened. For anything sensitive, see the
contact details on the project site.

---

OPEN GROUND is a **local, single-user tool** — it reads your filesystem and
spawns `claude` locally, so it runs entirely on your machine and isn't a hosted
service. Now go chart your atlas. ☕ (And take a coffee break.)

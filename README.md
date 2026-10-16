# OPEN GROUND

A local desktop workspace for multiple projects, Board tasks and terminal panes.
Use your own installed Claude Code and your own AI subscription.

This branch is preparing a macOS beta followed by Free/Pro general availability.
Implementation and release acceptance are tracked separately:
[feature inventory](docs/PRODUCT_FEATURE_AUDIT.md),
[current progress](docs/PRODUCTIZATION_PROGRESS.md),
[launch plan](docs/PUBLIC_LAUNCH_PLAN.md).

## Plans

| Plan | Monthly price | Current scope |
| --- | --- | --- |
| Free | JPY 0 | Multiple projects and terminal panes, manual Board tasks, ordinary Claude Code operation |
| Pro | JPY 2,980 | Free plus automatic Worker dispatch, monitoring, recovery and independent commander review |
| Owner | Existing role | All existing advanced features, including project Canvas, Research, Songs, local custom tabs, WordPress and experiments |

The core workspace is available in Free. New paid workspace features are deferred
while existing-feature quality is completed. There is no new project or terminal
paywall in this change. Technical resource limits still apply.

Pro purchase availability is shown in Settings → Plan. Hosted authentication,
payment configuration and real-service acceptance must be completed before public
sales. Pro automation initially targets macOS. An OPEN GROUND Pro subscription
does not include a Claude subscription or increase the AI provider's usage limits.
Codex integration is not implemented in this branch.

## Requirements and installation

- macOS is the first beta platform. Build targets include Apple Silicon and Intel;
  supported OS versions and architectures must pass the release acceptance checklist.
- Install Claude Code separately and sign in with your own supported subscription.
  OPEN GROUND does not provide an AI API-key setup or a shared provider account.
- Board and automatic work may require a Git repository; optional GitHub PR status
  also needs your own `gh` installation and login. Ordinary shell panes remain useful
  without a GitHub account.
- Windows packaging exists, but Windows Pro remains closed until real Windows
  acceptance and signing. Linux is not a supported release target.

For a verified release, download the appropriate macOS `.dmg` from
[GitHub Releases](https://github.com/nannantown/open-ground/releases), open it,
and drag OPEN GROUND into Applications. Development builds and draft PRs are not
proof that a new signed, notarized release is available. Do not bypass an OS warning
for an unknown or unverified build.

## First launch

1. Continue through the welcome screen. Free local use does not require an
   OPEN GROUND account; app login and Claude login are separate.
2. Choose **Import folder** to register an existing project, or **New project**
   to create one. There is no automatic projects-root scan on current installs.
3. Open a project. Use **Terminal** for a shell (type `claude` to launch Claude),
   or add a Board card and start a manual task. Add and name more terminal panes
   when you need parallel work.
4. Settings → Advanced → Claude connection reflects the local CLI's installation
   and login. Check the actual error if a task cannot start.
5. Sign in to OPEN GROUND only when using account features, then check Plan for
   billing availability. Payment management and cancellation open in your browser.

Settings save as you edit. A failed save is marked as unsaved and can be retried;
check that it succeeds before quitting. Changes to settings do not erase Owner data.

## Data and recovery

App data is centralized under `~/.openground/` (or `OPENGROUND_HOME` when explicitly
configured). Project registration is in `settings.json`; Board cards, canvases and
assets live under `projects/<uuid>/`; custom module sources live in `custom-modules/`.
The app no longer stores its current Board/Canvas data in each repository's
`.openground/` directory. Existing legacy data is not a reason to delete anything.

Some information lives elsewhere: research reports and code are in registered
project folders; Songs data belongs to the separate NENE project; Claude owns its
configuration and transcripts; Electron keeps UI state such as terminal slots in
its application profile. Saving pane names does not mean arbitrary running shell
processes survive an application quit.

Automatic generations cover **settings.json and the Ground layout canvas.json**.
They are not a complete backup of all Board, Canvas, Research, blog or Assistant
data. See [backup and recovery](docs/DATA_BACKUP_RECOVERY.md) for a complete copy
and restore checklist. Backups may contain passwords; disconnecting WordPress does
not erase old backup generations.

## Connections and safety

Model requests are made by your local Claude installation/SDK using your account;
prompts, files it reads and tool requests may be sent to the AI provider. Optional
app login, billing, feedback, sharing, updates, Owner WordPress/Phone and external
content use additional connections. See the [privacy page](landing/privacy.html).
There is no promise that using an AI terminal keeps its conversations off-network.

Work mode blocks app-managed non-Anthropic connections, including billing checks.
A billing outage or work mode **does not cancel a subscription**. Turn work mode off
to manage billing/cancel; entitlement checks remain conservative while unavailable.
Work mode is not an OS sandbox for every command you run in a shell.

Owner's OS sandbox experiment does not contain Agent SDK Workers. Their separate
command guards remain; review and stop controls still matter. Use a copy of data
for acceptance tests and inspect changes before merging them into important work.

WordPress creates **drafts**, not public posts. New ledgers are bound to a site;
changing sites preserves the old records. Legacy records ask you to confirm their
destination. If delivery is uncertain, check WordPress before an explicit retry.

## Updates and support

Automatic update application defaults to **on**. A downloaded update can restart
an inactive app even while resumable Claude work is running; user-opened busy
terminals delay it for a bounded grace period. Turning automatic application off
uses the manual restart flow. Verify resume/restore behavior on the release
candidate; a generic shell process has no universal resume guarantee.

Use the in-app feedback form when configured, or
[GitHub Issues](https://github.com/nannantown/open-ground/issues).
Do not include tokens, passwords, private conversations or unredacted backups.
Operator sales disclosures, final support policy and live billing acceptance remain
release prerequisites; this document does not invent them.

## Development

Use Node.js 22.12 or newer for the build tools (CI uses Node 22). Run `npm ci`,
`npm run dev:alt` for an isolated second instance, `npm run typecheck`, `npm run lint`,
`npm test`, and `npm run build`. Keep Vitest separate from build/Playwright output
regeneration. `npm run test:e2e` uses isolated fixtures.

See [CLAUDE.md](CLAUDE.md), [MAP](docs/MAP.md) and
[verification requirements](docs/VERIFICATION.md) before changing runtime behavior.
Do not push a release tag while testing; the release workflow may publish it.

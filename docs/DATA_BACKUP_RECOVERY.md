# Data backup and recovery

Current productization procedure, 2026-10-15. No real-user backup, migration or
restore is performed merely by adding this document. Test with copied data first.

## What is saved where

| Location | Contents | Included in automatic generations? |
| --- | --- | --- |
| `~/.openground/settings.json` | Project registry, preferences, Owner WordPress target/credentials, migration state | Yes |
| `~/.openground/canvas.json` | Ground card layout and drawing | Yes |
| `~/.openground/projects/<uuid>/` | Board tasks, Canvas files/assets, task images, research sidecars, blog ledgers/archives and worktrees | No |
| `~/.openground/custom-modules/` | Custom tab index and sources | No |
| Other `~/.openground/` files/directories | App auth, notifications, Assistant memory/photos, Phone configuration, runtime records | No |
| Registered project folders | Source, git history, `docs/research/` reports and project-owned files | No |
| Separate NENE project/data | Songs, recordings and other NENE-managed files | No |
| Claude configuration/transcripts | Claude-owned files, typically under `~/.claude/` or its configured directory | No |
| Electron application profile | UI localStorage such as terminal slot names and selected views | No |

`OPENGROUND_HOME` overrides the central data root. Use its actual value if configured.
Electron uses `app.getPath('userData')`; on this app's default macOS configuration
the profile is normally `~/Library/Application Support/openground`. Do not rename
the application package name or assume a display-name directory is the profile.

Automatic generations protect two files, not the whole workspace. A terminal
layout is also different from a recoverable running shell process. Only explicit
resume machinery can resume supported Claude/Worker conversations after a restart.

## Make a complete backup

1. Finish or safely pause work, then quit OPEN GROUND. Also stop any separate app
   whose files you will copy (including NENE). A live multi-file copy is not a
   guaranteed consistent snapshot.
2. Copy the entire actual central data directory to a new, dated backup location.
   Keep the original. Include hidden files and all subdirectories; do not copy
   only `settings.json` and `canvas.json`.
3. Copy the Electron profile if UI state matters. Record the app version, platform
   and original locations. Do not overwrite a profile belonging to another app.
4. Back up registered project folders and NENE-owned data separately, including
   uncommitted and untracked work you need. A git remote alone does not include it.
5. Back up Claude-owned configuration/transcripts separately if needed. Treat any
   credentials there as secrets; OPEN GROUND does not export or migrate them for you.
6. Verify the copy: compare file counts and selected hashes, and perform a restore
   using a disposable home before relying on it. Keep more than one dated copy.

Backups can include WordPress passwords, login tokens, private code, Phone keys,
photos and conversations. Use private permissions and appropriate encrypted
storage. Do not attach a full backup to feedback or a public issue.

Current settings and new generations use mode 0600. Startup restricts existing
settings generations without erasing their content. Disconnecting WordPress clears
the active setting; retained generations can still hold the old value. Revoke the
application password at WordPress if it should no longer be usable. Do not purge
backup history automatically as part of an unrelated settings change.

## Restore without losing the current state

1. Quit the app and save a separate dated copy of the current central directory,
   profile and project files, even if they seem damaged. Do not delete them.
2. Restore into a disposable `OPENGROUND_HOME` and isolated Electron profile first.
   Use matching project fixtures, not the live directories from the original registry.
3. Confirm registry paths and project UUIDs before opening projects. Those UUIDs
   connect registry entries to central Board, Canvas and asset directories.
4. Read back Board cards, images, all Canvas pages, Research reports/sidecars,
   custom module sources and blog records. Check Assistant/Phone and NENE in their
   own acceptance lanes if those features are used.
5. Only after the disposable restore passes, copy into the intended locations
   while the relevant applications are stopped. Keep the pre-restore copy.
6. Reauthenticate if old tokens no longer work. Billing and Owner permissions are
   resolved separately; restoring a local file does not create a paid subscription
   or grant the App Owner role. Device-specific Phone setup may need relinking.
7. Open the app, verify settings, and confirm that no unintended automated work
   starts. Enable only the work you intend to resume.

An unreadable settings file is not an empty new install. Preserve the damaged
bytes and use the integrity report/available generations for diagnosis. Do not
blindly remove it to make a save succeed.

## Blog-specific recovery

- The active ledger is `blog-publish.json`; prior destination records are retained
  in `blog-publish-<site hash>.json` within the project's central data directory.
- Old ledgers without a site binding remain intact and require explicit destination
  confirmation. Inspect the recorded draft link before confirming.
- A failed or uncertain post does not authorize deleting WordPress drafts. A
  `needs-check` result may already have created a remote draft; check WordPress
  before explicitly retrying. Automatic resend stops to avoid duplicates.
- A corrupt/unwritable ledger stops synchronization. Repair storage or restore a
  known-good copy; do not empty the ledger just to dismiss the error.

## Release acceptance evidence

Use a fixture inventory with hashes/counts before and after:

| Transition | Required observation |
| --- | --- |
| Owner → Free → Owner | Hidden Owner values/files survive; Free API access is denied; Owner can read the same data again |
| Save failure → retry → restart | No unrelated preference reverts; failed data is not described as saved |
| Site A → site B → site A | Existing drafts and both ledgers survive; no old post ID is sent to the new site |
| Export/copy → isolated restore | Central files, project data, assets and required external stores read back |
| App update → restart | Same data remains and only supported conversations resume; ordinary shell loss is not masked |

Record what actually ran. Fake CLI/service tests and a server process under Electron
do not replace real-service tests or a new signed packaged-GUI acceptance run.

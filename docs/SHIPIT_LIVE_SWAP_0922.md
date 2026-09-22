# ShipIt replaced /Applications while the app was running (2026-09-22 10:25 JST)

Investigation report. Evidence is field logs from the owner's Mac plus the
Squirrel.Mac source. No behaviour was changed by this card except two wrong
sentences in `docs/MAP.md` §8 (see §6).

> **⚠ The two logs use different timezones — mixing them was the first draft's
> central error.**
> `~/Library/Caches/local.openground.app.ShipIt/ShipIt_stderr.log` is **local
> time (JST)**: its last line reads `2026-09-22 10:25:31.700` and its mtime is
> `Sep 22 10:25:31`. `~/.openground/updater.log` is **UTC** (`…Z` suffix): its
> last line reads `2026-09-22T11:46:04.721Z` and its mtime is `Sep 22 20:46:04`
> — nine hours later. The incident is **JST 10:25:27 = UTC 01:25:27Z**. Every
> row below carries both.

## 1. What happened

`/Applications/OPEN GROUND.app` was swapped out **while the app process was
alive**, with no quit and no relaunch.

| UTC | JST | fact | source |
|---|---|---|---|
| 01:14:13.370Z | 10:14:13 | `update downloaded: 0.11.117` | `updater.log:1540` |
| 01:14:16.748Z | 10:14:16 | `the OS installer staged the update` — **this staging is the submit that armed ShipIt** | `updater.log:1546` |
| 01:19:13.368Z | 10:19:13 | `auto-apply deferred: server reports busy` — app alive | `updater.log:1547` |
| 01:24:13.452Z | 10:24:13 | `auto-apply deferred: window in use (unfocused 0min)` — **app alive 74 s before the swap** | `updater.log:1548` |
| 01:25:27.449Z | 10:25:27.449 | ShipIt `Detected this as an install request` | `ShipIt_stderr.log:2476` |
| 01:25:27.467Z | 10:25:27.467 | `Beginning installation` — **+18 ms, i.e. it did not wait** | `ShipIt_stderr.log:2477` |
| 01:25:31.700Z | 10:25:31.700 | `Installation completed successfully` → `ShipIt quitting`, **no relaunch** | `ShipIt_stderr.log:2491-2492` |
| 01:26:01.260Z | 10:26:01 | `ShipIt (boot): … runs=1, last exit=0` — **the job ran exactly once and exited cleanly**, 34 s after the swap | `updater.log:1551` |

The `Detected → Beginning` gap **is** the termination wait. Contrast, same
machine, same log:

- **4 h 02 m** — `ShipIt_stderr.log:2233` pid 33399 detects at `2026-08-27
  13:14:20.072`, `:2234` begins at `17:16:19.035`. The wait works, and works for
  hours.
- Several sibling runs that day (`:2228-2232`, hourly, pids 17762 / 80952 /
  44127 / 7228 / 70063) log `Detected this as an install request` and **never**
  log `Beginning installation` — they never proceeded to install. (Why not is
  not recorded: a run that parks in `waitForTermination` and is then killed
  writes nothing either way. Do not read these as cancellations — see §4 for
  what a real cancellation looks like.)
- 15 ms at `2026-09-21 23:56:03` — legitimate, the app had already terminated
  via `quitAndInstall`.

18 ms with the app demonstrably alive (74 s before, 34 s after) is the anomaly.

## 2. Who started the install (question 1)

**launchd did, servicing the demand queued by Squirrel's own staging 11 minutes
and 11 seconds earlier.** Not the app, not our code, and not a kickstart.

- Staging — not `quitAndInstall` — is what submits and launches ShipIt:
  `SQRLUpdater.m:1070-1086` `prepareUpdateForInstallation:` writes the request
  then `then:^{ return self.shipItLauncher; }`. So the arming event is
  `01:14:16.748Z`, and ShipIt ran at `01:25:27.449Z` — **11 m 11 s later**.
- The job dict (`SQRLShipItLauncher.m:46-72`) has **no `RunAtLoad`**;
  `KeepAlive={SuccessfulExit:NO}` and `MachServices={jobLabel:YES}`. A
  non-privileged submit is kicked by an XPC message to that Mach service
  (`:164-173`), which launchd services **when it chooses** — the trap already
  recorded in `docs/MAP.md` §8 ("ジョブは disabled でなくても走らない ことがある").
  An 11-minute deferral is the same trap seen from the other side.
- The job ran exactly once and exited 0 (`updater.log:1551`, 34 s after) — so
  this was a single clean launchd-driven run, not a crash-respawn loop.
- **Not our `launchctl kickstart`**: `kickstartShipItBeforeExit()` runs only
  from `app.on('will-quit')` (`electron/main.js:479`) and only when armed
  (`:2521`). The app did not quit, and `grep -c kickstart ~/.openground/updater.log`
  is **0** for the whole file — we have never kickstarted on this machine.
- `launchAfterInstallation` was `false` — the staging default
  (`SQRLUpdater.m:1082`); only `relaunchToInstallUpdate` flips it to `YES`
  (`:1096`). That matches the missing `Successfully launched application` line
  and is the signature of "this install was not requested by a quitting app".

## 3. Why the wait did not wait (question 2)

`waitForTerminationIfNecessary()` (`ShipIt-main.m:92-101`) builds
`SQRLTerminationListener initWithURL:request.targetBundleURL
bundleIdentifier:request.bundleIdentifier`. The listener
(`SQRLTerminationListener.m:52-59`):

1. calls `runningApplicationsWithBundleIdentifier:` **once**,
2. filters to apps whose `bundleURL.URLByStandardizingPath` equals the target
   URL,
3. arms a `DISPATCH_SOURCE_TYPE_PROC` / `DISPATCH_PROC_EXIT` source per match
   (`:71`).

**There is no polling and no re-check.** Zero matches at that single instant ⇒
`waitForTermination` completes immediately ⇒ install proceeds. Its only safety
net, `SQRLInstaller.m:364-374` (`SQRLInstallerErrorAppStillRunning`), re-runs
**the same predicate** — so a miss in step 1/2 is a miss in the net too, which is
exactly what the 18 ms gap plus the successful install shows: both checks were
blind at 01:25:27.449Z.

The `bundleIdentifier == nil` early-out (`ShipIt-main.m:95`) is ruled out by
`SQRLUpdater.m:1082`, which always sets it from
`currentApplication.bundleIdentifier`. (It cannot be ruled out from the
`ShipItState.plist` on disk today — that file was rewritten by a later
re-staging at 19:37 JST and is not the request ShipIt read at 10:25.)

**The predicate is not broken in general — it is not guaranteed.** Measured on
this machine while writing this report, reproducing
`SQRLTerminationListener.m:52-59` exactly against the live app:

```
runningApplications(withBundleIdentifier: local.openground.app).count = 1
  pid=36354 bundleURL=file:///Applications/OPEN%20GROUND.app/
    standardizingPath = file:///Applications/OPEN%20GROUND.app/
    == target (isEqual) : true
```

So the identifier and the URL comparison match under normal conditions, and §1's
contrast cases show the wait parking for hours. What made the live process
unmatchable at that one instant is **not** provable from the logs on hand.
Leading hypothesis, stated as a hypothesis: ShipIt was started by launchd on its
own, eleven minutes after submission, in a spawn context whose `NSWorkspace`
running-application list was empty — the job dict sets no
`LimitLoadToSessionType`, and `runningApplicationsWithBundleIdentifier:` needs a
session-attached context to be populated. Falsifiable prediction: an
attached-session ShipIt sees the app and waits; a detached one returns an empty
list. See §4.

**The defect does not depend on which branch fired.** The structural fact is
sufficient and is primary-source confirmed: *Squirrel asks "is the app still
running?" exactly once, through one predicate, at an instant Squirrel does not
control — and if it answers "no", a live app's bundle is replaced under it.*
That is the thing to defend against. Read with the corrected clock it is worse
than the first draft claimed: the swap landed **11 minutes** after an ordinary
background update finished downloading, with no user action of any kind.

## 4. Reproduction (question 3)

Not reproduced on the owner's machine — doing so means deliberately swapping
`/Applications/OPEN GROUND.app` under a live app, which is the damage itself.
The procedure, for a scratch machine / VM:

```sh
# ⚠ SCRATCH MACHINE / VM ONLY — NEVER on the owner's Mac.
# This swaps /Applications/OPEN GROUND.app under whatever is running.
# The owner's Mac still has a staged `launchAfterInstallation:false` request
# sitting in ~/Library/Caches/local.openground.app.ShipIt/ShipItState.plist,
# so running step 3 there would re-fire the exact incident.

# 1. Install a packaged build into /Applications, launch it, and let a
#    background check stage an update — wait for this line in
#    ~/.openground/updater.log (UTC):
#       "the OS installer staged the update"
#    ShipIt is now submitted with launchAfterInstallation=false.

# 2. Confirm it has not run yet (log is LOCAL time):
tail -3 ~/Library/Caches/local.openground.app.ShipIt/ShipIt_stderr.log

# 3. Start the job out-of-band, the way launchd did:
launchctl kickstart "gui/$(id -u)/local.openground.app.ShipIt"
```

Two distinct expected-good outcomes — tell them apart, they look nothing alike
in the log:

- **Parked.** `Detected this as an install request` and then **silence**. ShipIt
  is sitting in `waitForTermination`. (`ShipIt_stderr.log:2233-2234` is this
  outcome resolving after 4 h 02 m.)
- **Cancelled by the safety net.** Three lines, and note the ordering — the net
  fires *after* `Beginning installation`, never instead of it:
  `Beginning installation` → `Aborting update attempt because there are N
  running instances of the target app` → `Installation cancelled: … Code=-9
  "App Still Running Error"` → `ShipIt quitting`. Observed exactly twice on this
  machine: `ShipIt_stderr.log:757-761` (2026-07-23) and `:1464-1468`
  (2026-08-04).

Expected-bad (the incident): `Beginning installation` within ~20 ms of
`Detected`, **no** `Aborting update attempt` line, and a completed swap under
the running app.

To test the §3 hypothesis specifically, run step 3 twice: once via `launchctl
kickstart` (detached context) and once by letting the queued Mach demand fire
naturally. Different verdicts confirm it; identical verdicts refute it and point
back at the bundle-URL comparison.

## 5. Proposed handling (question 4 — implementation belongs on its own card)

Prevention inside Squirrel is not available to us. Two cheap moves, in order of
value:

**(a) Detect and tell the owner — smallest useful change.** The app already has
`bundleVersionAt()` (defined `electron/main.js:2419`), used at `will-quit`
(`:2529`) to notice "the app on disk is no longer the version this process is
running". Run the same comparison periodically — the existing hourly
update-check tick is a free hook — and on mismatch log it and show the owner one
plain-language notice: the app on disk was replaced, please restart. Today that
situation is completely silent; the 10:25 swap left no owner-visible trace at
all. One guard test: point `bundleVersionAt` at a differing version and assert
the notice fires.

**(b) Do not leave a staged request parked.** Every hourly check re-stages, and a
parked ShipIt job with `launchAfterInstallation=false` is the loaded gun; it only
has to go off once, and here it went off 11 minutes after staging. Options, needs
an owner call because it trades update freshness for safety: stage only when the
owner is about to apply the update, or stop re-staging while a request is already
pending. Not decided here.

Explicitly **not** proposed: kickstarting or disabling the ShipIt job from a
running app. `docs/MAP.md` §8 already forbids the first; this incident shows the
second would only move the failure.

## 6. Corrections landed by this card

`docs/MAP.md` §8 asserted that kickstarting ShipIt while the app runs makes
ShipIt *wait*. This incident is a measured counter-example to the guarantee — the
wait is a single-instant check that can miss — so the line now says the wait is
**not guaranteed** rather than that it never happens (the 10:25 run was *not* a
kickstart, and §1 shows waits of up to 4 hours working). The concrete danger the
old line named — an older staged build overwriting a newer manually-installed one
— is real and is kept.

## Primary sources

- Squirrel.Mac, `master` @ `5c9e2133c09d6f8e2e3c5a45c5b0ffc00448c58a` (2026-09-18):
  `Squirrel/ShipIt-main.m`, `SQRLTerminationListener.m`, `SQRLShipItLauncher.m`,
  `SQRLUpdater.m`, `SQRLInstaller.m`, `SQRLShipItRequest.h`.
  <https://github.com/Squirrel/Squirrel.Mac>
- Field logs (owner's Mac, 2026-08-27 and 2026-09-22):
  `~/Library/Caches/local.openground.app.ShipIt/ShipIt_stderr.log` (**JST**),
  `~/.openground/updater.log` (**UTC**).

# `experiments.sandbox` — owner-only Seatbelt sandbox for launched Claude (macOS)

**Status:** owner-only experiment · default **OFF** · **macOS only** · not in release
notes / the in-app manual until graduated.

When the owner turns this on, every `claude` OPEN GROUND launches on the two
sandboxed paths runs inside a macOS **Seatbelt** sandbox (`/usr/bin/sandbox-exec`)
**confined to its project `cwd`**, and runs **prompt-free** (permission `bypass`).
The OS sandbox is the safety net that makes prompt-free safe — that pairing is
the whole point: the permission menu goes to zero, and an action that would have
been blocked by the (now-absent) menu is blocked by the **kernel** instead.

This is the third route in the sandbox lineage (see the auto-memory
`reference-claude-sandbox-in-og`): not claude's built-in `settings.json` sandbox
(Route A, Bash-only) and not the `srt` runtime (Route B, beta), but the native
`sandbox-exec` wrapping the whole `claude` process tree.

---

## How to turn it on

Settings → **Advanced** → **Experiments** → **Sandbox Claude (macOS)** → On.
(The Experiments section is invisible to non-owners — see *Gating* below.)

Off-darwin the toggle still persists but `launchClaude` no-ops it, so nothing
changes — **on Windows there is no L3 at all**, by decision (2026-07-27), and
containment falls to the single L4 layer. See *[Windows — there is no L3
here](#windows--there-is-no-l3-here-accepted-single-layer-l4-2026-07-27)* below;
that section is the honest accounting of what a Windows install does not get.

---

## Gating — owner only, server-authoritative (Done #1)

The gate is the **same machinery as the `swarm` experiment** (`experiments.ts` /
`roles.ts`), so the guarantees are identical and already covered by tests:

- The server resolves `experiments.sandbox` as **`owner role` AND `the settings
  toggle`** (`computeExperiments`). The owner role comes from the Supabase
  `og_roles` table via the signed-in session — **never** from a request body.
- A **non-owner can never open the gate**, even by forging
  `experiments.sandbox: true` in their own `settings.json`: `computeExperiments`
  ANDs the owner check in, so it still resolves `false`
  (`experiments.test.ts`).
- **UI invisibility:** `GET /api/experiments` returns `eligible: false` for
  non-owners, and the Settings panel only renders the Experiments section when
  `experimentsEligible` — so the toggle never betrays the feature's existence.
- **403:** the swarm spawn routes return `403 forbidden` before any spawn to
  callers who pass neither the owner login nor the swarm-scoped local unlock
  (`server/routes/swarm.ts` / `swarmGate.ts` — the unlock opens swarm spawns
  but deliberately NOT this experiment), and the interactive
  `/api/terminal/claude` path only sandboxes when the server-resolved
  `flags.sandbox` is true (false for everyone but the owner-with-toggle,
  including locally-unlocked signed-out machines). There is no path by which a
  non-owner gets a sandboxed — or differently-behaving — launch.

Net: feature is invisible + inert for non-owners; only the signed-in owner with
the toggle on ever sees it or gets a sandboxed launch.

---

## What gets sandboxed

| Launch path | Sandboxed? | Why |
|---|---|---|
| **Swarm worker** (`spawnSwarmWorker` → `workerLaunchOpts`) | yes, when gate open | The prime case: a worker is unattended + already `bypass`, so it ran with **full** filesystem access. The sandbox adds the missing OS containment to that already-prompt-free run. |
| **Interactive `POST /api/terminal/claude`** | yes, when gate open | The owner's own project terminal — the surface where the *prompt reduction* (below) is felt. |
| Utility sessions (auto-title / auto-description / canvas-AI / generate-skill) | **no** | They legitimately write outside `cwd` (e.g. `generateSkill` writes `~/.claude/skills`); sandboxing them is a separate, later decision. |

For the worker, the worktree's `.git` and `node_modules` live in the **main
checkout** (outside the worktree `cwd`). `spawnSwarmWorker` passes the repo's
shared `.git` as an explicit write carve-out (so `git commit`/`push` land — with
`.git/hooks`/`.git/config` re-denied within it). The symlinked **`node_modules` is
left fully READ-only** — NO carve-out, not even build caches: `npm run build` and
`npm test` both pass with it read-only. (Precisely: vitest *does* attempt one
write into `<main>/node_modules` — `node_modules/.vite/vitest/<hash>/results.json`,
its previous-run cache — and the kernel denies it; the run is unaffected only
because vitest wraps that write in a bare `try/catch`. So the gate survives on
vitest's tolerance, not because nothing writes there. An earlier version of this
note claimed the write never happens, which is wrong.) This
is deliberate and load-bearing: the main checkout is run **un-sandboxed** by the
owner (`npm run dev`/`electron:dev` in main), so making **anything** under its
`node_modules` writable — package code, `.bin` shims, OR the `.vite/deps` slices
the dev server serves to the browser — would let a sandboxed worker poison code
that then executes with full privileges in the dev/Electron origin. (The
interactive case, where `node_modules` is a real dir inside `cwd`, stays writable
via the cwd carve-out.)

---

## Permission menu: before → after (Done #3)

The worker was **already** `bypass` (no prompts, but no containment). The dramatic
before/after is on the **interactive** path, which runs in `default` mode today.
Turning the sandbox on flips that launch to `bypass` **and** wraps it in Seatbelt.

| Claude permission prompt (interactive `default` mode) | Before (no sandbox) | After (sandbox on) | What replaces the prompt's safety |
|---|---|---|---|
| **Bash** — "Claude wants to run `<cmd>`" (Yes / Yes-don't-ask / No) | on every non-allowlisted command | **gone** | OS: the command runs, but writes are confined to `cwd`; no credential read; no listener |
| **Edit / Write / NotebookEdit** — "make this edit to `<file>`?" | on every file not yet session-approved | **gone** | OS: writes outside `cwd` are **denied by the kernel** |
| **Read outside the project** — allow reading `<path>`? | on reads outside `cwd`/`--add-dir` | **gone** | OS: broad read is allowed *except* `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.netrc`, `~/.git-credentials`, and the browser credential stores (Chromium `Login Data`/`Cookies`/`Web Data`, Firefox `key4.db`/`logins.json`/`cookies.sqlite`, `~/Library/Cookies`) — all kernel-denied. The login keychain is deliberately **not** in that list — see *Keychain* below. |
| **WebFetch / WebSearch** — allow fetching `<url>`? | on every fetch | **gone** | (no OS substitute — outbound is host-blind; see *Honest limits*) |
| **MCP tool** — allow `<server>/<tool>`? | per tool, per session | **gone** | bypass skips it; the OS still confines any file/network side-effects |
| **Folder-trust** — "Do you trust the files in this folder?" | first entry into a dir | **gone** | bypass + pre-seeded trust (`ensureClaudeFolderTrusted`) |

**Result:** the interactive session goes from *a prompt on essentially every tool
use* to **zero prompts**, with filesystem + listener containment now enforced by
the kernel instead of by a human answering the menu. That is the "権限プロンプトを
激減させる" goal, made safe by the sandbox. (sandbox-on flips `default` /
`acceptEdits` / `auto` to `bypass`; an explicit `plan` mode is preserved — see
*Security model* for the residuals this trade against.)

---

## Containment proof (Done #2) — real macOS Seatbelt

`scripts/sandbox-probe.ts` builds the **exact** profile the app uses
(`buildSandboxProfile`) and runs the battery through `sandbox-exec`:

```
npx tsx scripts/sandbox-probe.ts
```

Verified on macOS 26.5.1 — throwaway home + cwd, so the real
`~/.ssh`/`~/.claude`/`~/.openground` are never touched. (The one exception is the
KEYCHAIN read row, which *must* use the real home to be meaningful — it runs
`security find-generic-password` **without `-w`**, so it reads attributes only,
never a secret, and writes nothing.) An excerpt of the matched rows — the full
battery, including the BRAIN egress rows further below, is **86 passed · 0 failed
· 0 skipped** as of 2026-07-19:

```
  ✓  want=allow got=allow WRITE inside cwd
  ✓  want=deny  got=deny  WRITE outside cwd (~/…)
  ✓  want=deny  got=deny  WRITE outside cwd (~/Documents/x)
  ✓  want=deny  got=deny  READ ~/.ssh/id_rsa
  ✓  want=allow got=allow READ normal file (/etc/hosts)
  ✓  want=allow got=allow SPAWN node + write cwd (build proxy)
  ✓  want=allow got=allow git commit (writes .git in cwd)
  ✓  want=allow got=allow git push → in-cwd bare remote
  ✓  want=deny  got=deny  WRITE ~/.claude/settings.json (hook persist)
  ✓  want=deny  got=deny  WRITE ~/.claude/hooks/evil.sh
  ✓  want=deny  got=deny  WRITE ~/.openground/settings.json (allowlist)
  ✓  want=deny  got=deny  WRITE cwd/.git/hooks/pre-commit
  ✓  want=deny  got=deny  WRITE cwd/.git/config
  ✓  want=deny  got=deny  WRITE cwd/.git/modules/m/config (submodule)
  ✓  want=deny  got=deny  WRITE cwd/.claude/settings.json (project hook)
  ✓  want=deny  got=deny  WRITE cwd/.mcp.json (project MCP server)
  ✓  want=deny  got=deny  WRITE cwd/.claude/hooks/evil.sh (project hook)
  ✓  want=allow got=allow WRITE cwd/CLAUDE.md (legit project content)
  ✓  want=deny  got=deny  WRITE ~/.claude.jsonEVIL (regex over-match)
  ✓  want=allow got=allow WRITE ~/.claude/projects/x.jsonl (session)
  ✓  want=allow got=allow WRITE ~/.claude.json (claude rewrites it)
  ✓  want=allow got=allow WRITE ~/.cache/x (toolchain cache)
  ✓  want=allow got=allow OUTBOUND → 127.0.0.1 (app-context curl)
  ✓  want=deny  got=deny  BIND 0.0.0.0 (public listener)
  ✓  want=deny  got=deny  BIND 127.0.0.1 (loopback listener — also denied)
  ✓  want=allow got=allow claude --version (startup smoke)
  ✓  want=allow got=allow KEYCHAIN: read claude's credential (Not-logged-in regression)
  ✓  want=allow got=allow KEYCHAIN: add item (OAuth token-refresh write path)
  ✓  want=deny  got=deny  KEYCHAIN: write a NON-login keychain path (dir is NOT wide open)
  ✓  want=deny  got=deny  KEYCHAIN: read a per-UUID data-protection keychain (co-resident secrets)
  ✓  want=deny  got=deny  KEYCHAIN: read its keybag (user.kb)
  ✓  want=allow got=allow KEYCHAIN: read the login keychain itself (depth-1, must stay readable)
  … (72 rows total — see the BRAIN battery below)
```

So, against the goal's matrix:

- **cwd file edit · `npm run build` · `git push`** → **allowed** (write-in-cwd,
  node-spawn-and-write, a real `git commit`, and a real `git push` to an in-`cwd`
  bare remote all pass; the worker's cross-tree `.git` carve-out is covered by
  `sandbox.test.ts`).
- **write outside cwd (`~/Documents/x`) · read `~/.ssh/id_rsa` · public/loopback
  listener** → **denied**.
- **out-of-sandbox persistence** (the planted-payload escape) → **denied**,
  GLOBAL and PROJECT-LOCAL: writing `<cwd>/.claude/settings.json`, `<cwd>/.mcp.json`,
  `<cwd>/.claude/hooks/*`, any `.git/hooks`/`.git/config` (incl. submodule), and
  OG's `~/.openground/settings.json` allowlist all fail — so a contained claude
  cannot leave a hook/MCP/config that executes outside the sandbox later (e.g. via
  OG's own non-sandboxed auto-description session on the same project). A project's
  own `CLAUDE.md` stays writable (content, not auto-executing code).

`sandbox.test.ts` pins the profile *text* (deny-default, cwd write, the credential
read-denies, the execution-config write-denies, last-match-wins ordering,
outbound-only network) so the contract is guarded in CI where there is no kernel.

---

## Security model & honest limits

This is **strong confinement, NOT a complete escape-proof jail.** Be precise
about both halves (an adversarial review pass — see commit history — drove this
list; under-claiming here is the point).

**What it DOES enforce (kernel, verified by the probe):**

- **Filesystem write confinement.** Writes are confined to `cwd` (+ `~/.claude`,
  `~/.openground`, tool caches `~/.npm`/`~/.cache`/`~/Library/Caches`, temp, the
  worker `.git` carve-out, and the `~/Library/Keychains/login.keychain*` family —
  see *Keychain*). Everything else (`~/Documents`, the
  rest of `$HOME`, the system) is **write-denied**.
- **Credential read-denial.** Reads are broad (so the toolchain works) EXCEPT the
  secret stores, re-denied last (last-match-wins): SSH/GPG keys (`~/.ssh`,
  `~/.gnupg`); cloud / cluster / container creds (`~/.aws`, `~/.config/gcloud`,
  `~/.azure`, `~/.kube`, `~/.docker`, wrangler `~/.wrangler` + `~/.config/.wrangler`);
  and the package / git / IaC
  token files (`~/.netrc`, `~/.git-credentials` + the XDG `~/.config/git/credentials`,
  `~/.npmrc`, `~/.yarnrc.yml`, `~/.pypirc`, `~/.cargo/credentials[.toml]`,
  `~/.gem/credentials`, `~/.terraform.d/credentials.tfrc.json`, `~/.vault-token`,
  `~/.gradle/gradle.properties`, `~/.m2/settings.xml`). The common injection
  payload (`cat ~/.ssh/id_rsa`, or reading `~/.npmrc`'s token) fails. Credential FILES are denied
  by literal where the parent dir holds read-needed build data (cargo/gem/terraform
  registries), so builds still resolve deps. (npm falls back to the public registry
  when `~/.npmrc` is unreadable — `npm run build` verified to still pass.)
- **No out-of-sandbox persistence.** WRITE is re-denied (last) to the
  AUTO-EXECUTING config that would run OUTSIDE the sandbox on a later launch —
  **path-agnostic**, so it covers the GLOBAL `~/.claude` *and* any PROJECT-LOCAL
  `<cwd>/.claude` (the latter sits inside the writable cwd and is auto-triggered
  by OG's own non-sandboxed sessions — `generateDescription`/`generateTaskTitle`/
  `canvasAi` run `cwd=projectPath`, bypass, no sandbox): `.claude/settings.json`
  (+`.local`), `.claude/hooks/*`, `.claude/plugins/*`, **`.claude/skills/*`**
  (skill scripts), **`.mcp.json`** (project MCP servers), git hooks + config at
  **any** gitdir level (top `.git/hooks`+`.git/config`, submodule
  `.git/modules/<name>/{hooks,config}`, per-worktree
  `.git/worktrees/<name>/config.worktree`) **and the intermediate gitdir entries
  `.git/modules` / `.git/worktrees` (+ each `<name>`)** so they can't be swapped to
  redirect what's below, plus the global `~/.claude/CLAUDE.md`, OG's
  `~/.openground/settings.json` (its `projects` allowlist), and
  `~/.openground/custom-modules/*` (custom-tab module code). Every one is anchored
  at the **ENTRY** (`…(/.*)?$`), and the `.git` / `.claude` / `.openground` dir
  entries themselves are denied too — so a worker can't
  `mv X X.bak && ln -s /evil X` to **symlink-swap** the dir and have a child write
  land outside the deny (a real-kernel escape a child-only `…/X/.*` deny would
  miss; children — incl. the worker's `~/.openground/swarm/…` heartbeat — stay
  writable via the subpath allows). Existing hooks/skills
  still *run* (read+exec stay allowed) — they just can't be planted/altered. Pure
  INSTRUCTION content (a project's own `CLAUDE.md`, `.claude/commands`,
  `.claude/agents` — markdown, no embedded
  scripts) stays writable — editable project content, not auto-executing code.
- **No network listener.** Outbound is allowed; bind/inbound (public AND loopback)
  are denied — no backdoor, no dev server.

**What it does NOT protect against (inherent Seatbelt / mechanism limits):**

- **`~/.claude.json` `mcpServers` persistence (OG auto-trigger CLOSED; manual
  residual).** claude legitimately rewrites `~/.claude.json`, so it stays writable
  and Seatbelt can't filter by JSON key — a sandboxed claude could add a user-scope
  MCP server. The dangerous part was that OG's own **non-sandboxed, auto-triggered**
  utility sessions (`generateDescription`/`generateTaskTitle`/`canvasAi`/
  `generateSkill`, which run bypass) would auto-spawn it outside the sandbox. That
  trigger is now **closed**: those sessions pass **`--strict-mcp-config`**, so they
  load only explicit MCP config and ignore `~/.claude.json` mcpServers + project
  `.mcp.json`. The residual is narrower — a user *manually* opening a
  non-sandboxed `claude` (their own terminal, or OG's interactive terminal with
  the experiment off) could still load a planted server; that path is the same as
  the experiment being off, and full closure needs content-aware filtering (the
  proxy/`srt` follow-up).
- **Keychain-mediated secrets.** The login keychain is deliberately **readable**
  (see *Keychain* — denying it is a 100% launch failure, not a secrecy trim), and
  `mach-lookup` is allowed besides (claude/node need it, and it's how https
  `git push` reaches securityd). So a payload can `git credential fill` /
  `security` **any item in it** — which on a normal machine includes
  `Chrome Safe Storage`, the browser password vault's master key, not just
  claude's own token. Accepted, documented trade-off — not a closed hole. The
  vault's *file* half **is** closed (see *Browser credential stores*), so the key
  no longer unlocks anything locally; the items stay readable. Full closure is the
  egress proxy (`network:'loopback'`, where there is no exfil destination), never
  a file rule: the file rule only ever broke login.
- **Outbound is host-blind** (under the default `network:'all'` profile).
  Seatbelt can't allow-list domains; once a secret is obtained,
  `(allow network-outbound)` permits exfil. Domain egress filtering needs a
  local proxy — which is exactly what the **overseer-brain egress close**
  (below) now implements for the ONE launch path that holds the private
  you-corpus; the worker/interactive paths remain host-blind (their claude needs
  git/npm/arbitrary-host reachability).
- **HOME tool-cache poisoning.** The writable HOME caches `~/.npm`/`~/.cache`/
  `~/Library/Caches` are needed for `npm install` + non-node toolchains. A payload
  could overwrite a cached executable there (e.g. a `~/Library/Caches/ms-playwright`
  browser binary) that later runs un-sandboxed. Indirect (requires the owner to run
  that exact tool later); denying these breaks legitimate caching, so it's an
  accepted trade-off. NOTE: the main checkout's `node_modules` (incl. `.vite`,
  `.cache`, `.bin`) is **NOT** in this set — it is read-only, precisely because
  `node_modules/.vite/deps/*.js` are executed un-sandboxed by the dev server and
  vite does **not** re-verify each cached slice's bytes on a metadata-hash match
  (an in-place overwrite would run as-is), so that poisoning class is closed, not
  accepted.
- **Instruction-content prompt-injection persistence.** A project's own
  `CLAUDE.md` / `.claude/commands` / `.claude/agents` stay **writable** (they are
  editable project content, not auto-executing code). A contained claude could
  plant malicious *instructions* there that a later claude session loads. This is
  strictly lower-risk than a hook (it depends on the model following the injected
  text / the command being invoked, not deterministic code execution), and
  denying it would break legitimate "edit the project's CLAUDE.md" work — so it is
  an intentional line: deny auto-executing config, allow editable content.
- **The deny list is enumerated, so a NEW claude config surface could leak.** The
  out-of-sandbox-persistence denies name today's auto-executing config
  (settings/hooks/plugins/mcp/git, incl. submodule + per-worktree config). A
  future claude feature that auto-runs code from a new path would need a new
  deny — re-audit on claude upgrades.
- **Interactive regression to be aware of:** on the interactive path, sandbox-on
  flips `default`/`acceptEdits`/`auto` to `bypass` (an explicit `plan` is
  preserved). Operations the permission menu used to gate (config writes, the
  keychain/outbound paths above) now run unprompted — contained by the kernel
  where a deny exists, but the two residuals above are real. The owner opts into
  this knowingly; it is why the feature is owner-only + default-off.

**Functionality limits (not security):**

- **ssh git remotes don't work in the sandbox** (`~/.ssh` is read-denied) — use
  **https** remotes (keychain). Build/test/local-commit/https-push all work.
- **`sandbox-exec` is deprecated** by Apple (stderr warning from Sequoia on) but
  works on every current macOS; removal is unannounced — another reason this is a
  default-off experiment.
- **Do not App-Sandbox OPEN GROUND.** OG ships with App Sandbox deliberately OFF
  + hardened-runtime ON; that's exactly what lets a child Seatbelt profile compose
  cleanly. Turning on `com.apple.security.app-sandbox` would force the child to
  inherit the parent sandbox and break this. Keep `entitlements.mac.plist` as-is.

---

## Overseer-brain egress close (`network:'loopback'` + allowlist proxy)

The one launch path with the private **you-corpus in context** — the overseer
brain (`swarmOverseerBrain.makeOverseerBrain`) — is now sandboxed
**unconditionally on macOS** (NOT gated on this experiment; the experiment still
gates the worker/interactive paths) with a **tighter network line**:

- `buildSandboxProfile({ network: 'loopback' })` allows outbound ONLY to
  loopback + local unix sockets; every off-machine destination falls to
  `(deny default)` and is **kernel-refused** (EPERM). DNS still resolves
  (libinfo rides mach IPC), but nothing off-machine connects.
- The brain's claude reaches Anthropic exclusively through a host-side
  **allowlist CONNECT proxy** on 127.0.0.1 (`egressProxy.ts`, `HTTPS_PROXY`
  injected into the launch): `anthropic.com` / `claude.ai` (suffix-matched,
  port 443) pass; everything else — telemetry (datadoghq), content bridges,
  any exfil target — gets a logged 403. The DOMAIN decision happens OUTSIDE
  the sandbox.
- The `--disallowed-tools` deny list (WebFetch/WebSearch/Bash/Task) stays armed
  as defense-in-depth; off-darwin (or if Apple removes sandbox-exec —
  `brainSandboxAvailable`) it degrades gracefully back to that stop-gap alone.
- **Keychain carve-in:** claude's subscription credential lives in the login
  keychain, and Security.framework does that db's file I/O **from the client
  process** — so a Seatbelt deny is an auth outage, not a secrecy trim. This
  landed loopback-only first and was generalised to **both** profiles on
  2026-07-19; see *Keychain* below for the measurements.

Verified on the real kernel (`scripts/sandbox-probe.ts`, BRAIN battery — 72/72
with the main battery, re-run 2026-07-19):

```
  ✓  want=deny  got=deny  BRAIN: OUTBOUND → 1.1.1.1:443 (external, direct)
  ✓  want=allow got=allow BRAIN: DNS lookup api.anthropic.com (resolution path open)
  ✓  want=allow got=allow BRAIN: OUTBOUND → 127.0.0.1 (the egress proxy)
  ✓  want=allow got=allow BRAIN: https api.anthropic.com via allowlist proxy
  ✓  want=deny  got=deny  BRAIN: https example.com via proxy (403 — not allowlisted)
  ✓  want=deny  got=deny  BRAIN: BIND 127.0.0.1 (listener still denied)
  ✓  want=allow got=allow BRAIN: claude --version (startup smoke, loopback profile)
```

And live (`scripts/overseer-brain-smoke.ts` — one real haiku-tier PTY,
2026-07-08): the sandboxed+proxied brain answered a corpus-grounded question in
11s (`ANSWER HIGH`), while its Datadog/content-bridge CONNECTs were 403'd —
the closed egress demonstrably does not break the one legitimate path.

---

## Remaining manual QA

The probe battery proves the *profile* (incl. a no-bill `claude --version`
startup smoke under the sandbox). The one thing not auto-verified is a **full
interactive claude PTY turn under the sandbox** (a real session editing files /
running a build via the TUI) — worth a one-off owner smoke before graduating the
experiment, since PTY tty ioctls under Seatbelt are the least-certain corner
(the profile allows `file-ioctl` on `/dev`, but only a live session confirms the
TUI is happy).

(The keychain blocker that would have stopped this QA outright is **fixed** —
see *Keychain* immediately below.)

---

## Keychain — why it is read+write ALLOWED in both profiles

**The bug (2026-07-08 suspected → 2026-07-19 confirmed and fixed).** Turning the
experiment on made a swarm worker **100% unable to launch**. The `'all'`
(worker/interactive) profile read-denied `~/Library/Keychains`, and that is where
claude's subscription credential lives (`login.keychain-db`, generic-password
service `Claude Code-credentials`). Security.framework does that db's file I/O
**from the CLIENT process** — the securityd mach IPC is not the whole path — so
the deny did not trim an exfil surface, it cut authentication:

```
# the profile a sandboxed worker actually got, real kernel, 2026-07-19
CURRENT (deny present)  → claude -p …  ⇒  Not logged in · Please run /login
FIXED   (carve-in)      → claude -p …  ⇒  OK
```

The deny had been dropped for `network:'loopback'` (the overseer brain) on
2026-07-08, which is why the brain worked while every worker/interactive launch
stayed broken. It is now dropped for **both** profiles.

**READ is not enough — WRITE is required too.** claude persists its **refreshed
OAuth token** back into the keychain item (measured: the item's `cdat` is the
original login months earlier, its `mdat` tracks the most recent refresh, hours
apart). With read-only, the write EPERMs —
`SecKeychainItemCreateFromContent: UNIX[Operation not permitted]` — so a worker
would launch cleanly and then fail *hours in*, which is harder to diagnose than
the failure it replaced. Both read and write are therefore granted.

**The directory is shared, so both rules are scoped.** `~/Library/Keychains` holds
claude's login keychain *and* the user's other credential stores: the **per-UUID
data-protection keychains** (`keychain-2.db` + its `user.kb` / `stash.kb` keybags
— Safari / iCloud / app secrets) and Octagon device-trust state, all one level
deeper, plus the DP metadata store alongside them. claude touches none of them.

- **Write** — `(regex #"^<home>/Library/Keychains/login\.keychain.*$")`. The prefix
  covers modern `login.keychain-db`, legacy `login.keychain`, and the SQLite
  atomic siblings (`-journal` / `-wal` / `-shm`, `.tmp`). A write to any other
  keychain path in the dir is denied — including `TrustSettings.plist`, and
  including anything reached by `..` out of a `login.keychain…`-prefixed
  directory, since the kernel matches the **resolved** path (both pinned by probe
  rows rather than argued).
- **Read** — the co-resident stores are denied **by depth**:
  `(deny file-read* (regex #"^<home>/Library/Keychains/.+/.+"))` plus literal
  denies for **both spellings** of the DP metadata store, `metadata.keychain-db`
  **and** the legacy `metadata.keychain`. The dir's own direct entries — the login
  keychain among them — stay readable.

> **Correction (2026-07-19, adversarial review round 2).** Only the `-db` spelling
> was denied at first. The legacy `metadata.keychain` is not hypothetical — it is
> present on the dev machine (0600, 23 KB, 2016) and was **measured read-allowed**
> under the shipping profile. The depth regex starts at depth 2, so a depth-1 file
> needs its own literal; the write side had *already* covered its legacy twin
> (`login.keychain`), which is what makes this an oversight rather than a decision.
> Both spellings now have a literal deny and a probe row. The dev machine's
> keychain dir was enumerated to confirm no third spelling or sidecar exists at
> that depth.

### Browser credential stores — the other half of the blast radius

The carve-in makes **every login-keychain item** reachable, not just claude's. On
a normal machine that set includes **`Chrome Safe Storage`** — the master key to
Chromium's saved-password vault (measured: present on the dev machine). The vault
*files* were reachable all along via the broad read, so before this change the
two halves were separated only by the keychain deny that also broke login.
Removing that deny put both halves in reach of a contained worker whose outbound
is open.

The keychain half **cannot** be closed — denying it is the 100 % launch failure
this whole change exists to fix. The file half can, and is:

- Chromium family — `(Login Data|Cookies|Web Data)` plus any suffix, covering
  `Login Data For Account` and the SQLite `-journal` / `-wal` / `-shm` sidecars.
- Firefox family — `logins.json`, `key3.db`, `key4.db`, `cert9.db`,
  `cookies.sqlite*`.
- Safari / `NSHTTPCookieStorage` — `~/Library/Cookies` (subpath). A live session
  cookie is a bearer credential.

Both regexes are anchored at `<home>/Library/Application Support/` and match by
**filename at any depth** (`.` matches `/` in POSIX ERE). Depth-agnostic because
the profile directory level differs per browser *and* per user-created profile —
`Google/Chrome/Default`, `Google/Chrome/Profile 1`, `Microsoft Edge/Default`,
`BraveSoftware/Brave-Browser/Default`, `Firefox/Profiles/<rand>.default`. All five
shapes are denied on the real kernel; a literal per path could not keep up with
profile names the user invents, which is why these are regexes.

Deliberately **not** a subpath deny of the browser directories: a Chrome
extension's source legitimately lives under Application Support and claude may be
asked to work on it. `Google/Chrome/Local State` and an extension source are
pinned **readable** by negative-control probe rows — without them the rule could
quietly widen to the whole directory and every deny row would still be green.

**Measured coverage on a real machine (2026-07-19).** A sweep of every
credential-named file actually present under `~/Library/Application Support`
found **329 files, 0 still readable** under the shipped profile. The set is much
wider than the five browsers above, which is the argument for depth-agnostic
regexes in one number:

- A full Chromium profile at
  `com.openai.atlas/browser-data/host/user-<random>/Login Data` — a vendor and a
  per-user directory name that no literal list would have contained.
- The cookie jars of every Chromium-based **Electron app** on the machine
  (Discord, Obsidian, Termius, Splice, … and OPEN GROUND itself). Collateral, but
  harmless: claude has no reason to read another app's session cookies, and
  `Local State` / app source files in the same directories stay readable.

That sweep is the standing check on the docs, not just the rules: this section
claims the credential DBs are unreachable, so anything it finds open is a false
claim here, not merely a gap in the profile.

This narrows residual 1 rather than closing it: the keychain items themselves
stay readable, so the master key is still reachable — it just no longer unlocks
anything locally.

**Why depth and not the whole directory.** The obvious shape —
`(deny file-read* (subpath …/Library/Keychains))` with the login family re-allowed
after it — was measured and **rejected**: it authenticates fine but **kills the
keychain WRITE** (`SecKeychainItemCreateFromContent: UNIX[Operation not
permitted]`), because mutating an item needs read access to the directory's own
entries. Explicitly re-allowing the dir *entry* does not restore it. That shape
would trade this bug's launch failure for a refresh failure hours in.

Four conditions hold simultaneously under the shipped rule (real kernel):
claude authenticates · the login-keychain write lands · `claude -p` answers ·
`keychain-2.db` and `user.kb` are kernel-denied.

> **Correction (2026-07-19).** The first cut of this fix dropped the keychain
> read-deny **entirely**, which exposed those co-resident stores to a contained
> worker with open outbound. It shipped on a bad measurement of mine — a probe
> `cat`-ed a *directory* inside the keychain folder, and I read the resulting
> "Is a directory" failure as a kernel denial, concluding those files were
> already unreachable. They were not. Caught by adversarial review. The lesson is
> the same one that bit the probe's skip logic: **never infer "the kernel denied
> it" from "the command failed"** — check *why* it failed.

**Why this is an acceptable trade.** A keychain item is **data, never code**, so
it is outside the class every write-deny in this profile exists to close —
planting config that RUNS un-sandboxed on a later launch. Denying the files never
bought secrecy either: a payload can still reach a stored token through
`security find-generic-password` / `git credential fill` over securityd. What the
deny actually did was break login.

Two residuals it leaves, stated rather than waved past:

1. **Read of any login-keychain item** by a contained agent whose outbound is
   open — *not* merely "a stored token", and not merely claude's own. Named
   concretely because the vague phrasing hid the sharpest case: the login keychain
   holds **`Chrome Safe Storage`, the master key to the browser password vault**,
   alongside whatever else the user has saved there over the years. The vault's
   *file* half is now denied (see *Browser credential stores* above), so the key
   no longer opens anything reachable — but the items remain readable, and that is
   what stays open. Closed **structurally**, not by a file rule: `network:'loopback'`
   + the allowlist egress proxy leaves no destination to exfil to. The brain
   already runs that way; extending it to workers is the documented follow-up and
   is the real fix for keychain secrecy.
2. **Mutation of claude's own credential store** — tamper with, or outright
   delete, `login.keychain-db` **and its legacy twin `login.keychain`** (both sit
   in the write-allowed family, and the legacy file is real on the dev machine —
   265 KB, 2016 — so destroying it is just as irreversible). Worth naming what
   else that file holds on a
   release machine: the **Developer ID signing key** and the `openground-notary`
   profile (`docs/DISTRIBUTION.md`). Deletion is not re-downloadable from Apple,
   and `network:'loopback'` does **not** mitigate it — that closes exfil, not
   destruction. Unavoidable given the fix, since the same file must be writable
   for the token refresh; listed so it is known rather than discovered.
   Certificate **trust settings** — the sharper worry, since a planted root is
   policy an un-sandboxed process honours — turn out **not** to live in the
   keychain db but at `~/Library/Keychains/TrustSettings.plist`, which the
   write-family regex does not match, so it remains write-denied.

**Open question that could retire residual 2.** The write grant exists only to
serve the token refresh. What is *measured* is that the refresh write EPERMs
without it; what is **not** measured is what claude does next — hard-fail the
session, or keep the refreshed token in memory and merely fail to persist it (in
which case the next launch simply refreshes again). If it soft-continues, the
write grant can be dropped and residual 2 with it. Deciding that needs a session
observed across a real token expiry, which is why it was not settled here: the
conservative choice was the one that cannot strand an unattended worker hours
into a run.

**Regression guards** (both have been teeth-tested — the deny was re-introduced
and each fails loudly):

- `sandbox.test.ts` — pins that **neither** profile emits the read-deny and that
  **both** emit the write-allow. The keychain and browser rules are checked
  **behaviourally**: a helper re-runs the profile's emitted `subpath` / `literal` /
  `regex` read-denies against concrete paths, instead of transcribing the rule
  text. A transcribing test passes for any rewrite that keeps the spelling and
  fails for every rewrite that changes it — exactly backwards. Teeth-checked
  against the pre-fix profile: **9 of 10** pinned paths were open before the fix.
- `scripts/sandbox-probe.ts` — the real-kernel proof (86 rows). Beyond the two
  original keychain rows (reading claude's actual credential under a real-home
  profile, and an item write against a throwaway keychain): both `metadata`
  spellings, the `..`-out-of-a-prefixed-dir realpath escape, `TrustSettings.plist`
  write-deny / read-allow, and one row per browser profile *shape* — plus the
  negative controls that keep the browser rules narrow. The keychain read row
  skips **only** when claude was never logged in on the machine, decided by an
  *unsandboxed* precondition check: a kernel deny makes the item invisible and
  reports the same "could not be found" as a machine that never logged in, so a
  skip-on-message rule would have swallowed the very regression it guards (it did,
  until fixed).

Two probe-design rules earned the hard way and applied to the new rows: a
`mkdir && write` one-liner exits non-zero whether the *kernel* denied the write or
the mkdir merely failed, so preconditions are built **unsandboxed** (as the gitdir
rows already did); and `TrustSettings.plist` is **absent** on the dev machine, so
it can only be exercised against a fake-home stand-in — the same blind spot that
let the legacy-`metadata.keychain` gap through in the first place.

---

## Windows — there is no L3 here (accepted: single-layer L4, 2026-07-27)

**Decision (2026-07-27): do not build a Windows L3. Accept that Windows
containment is single-layer L4, and say so out loud.** This is GAP-7 in
[RELEASE_READINESS_GOALS.md §5](RELEASE_READINESS_GOALS.md), and it is an
*accepted* gap, not a fixed one — it is disclosed (GAP-10) and it must be
re-decided if swarm is ever opened past the owner (GAP-1).

Everything else in this document is macOS-only. On Windows the `claude` OPEN
GROUND launches — an interactive swarm worker, or the overseer brain — gets
**no OS-level confinement whatsoever**. What is left:

- **L4, the deterministic PreToolUse guard** (`scripts/openground-guard.js`,
  [invariant E](SWARM_SAFETY_INVARIANTS.md)) — installed on Windows too
  (`hooksInstall.ts` handles the win32 quoting) and there the *only* mechanical
  stop. Installed, not proven: see the unmeasured-lexer note below.
- Structural constraints that are not a sandbox: the engine has no trunk push
  path at all, the brain gets no repo (fresh empty scratch cwd, READ-ONLY
  prompt, `--disallowed-tools`), worktree teardown cannot cross the central
  dir.

**What "single-layer" means, concretely.** The guard's own header is honest
about the holes it cannot see — a `git` alias already sitting in the user's
`~/.gitconfig`, a command reached from a live process the hook never observes.
On macOS such a hole *can* still land on the kernel: for a worker whenever this
experiment is on, and for the overseer brain regardless of the owner experiment
(`brainSandboxAvailable()` — darwin **and** `/usr/bin/sandbox-exec` present;
Apple removing it is the one future that probe guards, and arming the overseer
without it surfaces `sandboxWarning`). Then the write outside `cwd` is denied,
`~/.ssh` is unreadable, and the brain reaches the network only through the
loopback allowlist proxy.

Be exact about the size of that delta, in both directions — L3 is **not** a
read-jail even on macOS (reads stay broad except the re-denied secret stores,
and the login keychain is *deliberately* reachable — see *Security model &
honest limits* above). What a Windows install loses is precisely: **write
confinement, the secret-store read denials, and the brain's egress close.** What
it does *not* lose, because macOS never had it either, is protection of ordinary
files from being read. **On Windows that same guard hole is the end of the line,
and there is no toggle that would change it.** A runaway worker there
can read the whole user profile (`%USERPROFILE%\.ssh`, cloud credential files,
the browser credential stores — see *Browser credential stores* above) and write
anywhere the user can; the brain gets no structural egress close, so only its
prompt, its tool mask, and L4 sit between it and the network. The one existing
in-product signal for this: arming the overseer on a host where
`brainSandboxAvailable()` is false returns `sandboxWarning:true`
(`server/routes/swarm.ts`) — the reduced containment is surfaced, not hidden.

Worse, that single layer is **itself unmeasured on Windows**. Per
[SWARM_GA_AUDIT.md](SWARM_GA_AUDIT.md) NEW-3 / P-3 (which grepped the 2055-line
guard and found **zero** win32/PowerShell branches), it is a POSIX lexer, so
under a PowerShell worker it either fail-closed-blocks everything (worker cannot
progress) or parses PowerShell as something else and lets constructs through
(invariant E silently holed) — and which of the two has never been observed on
real hardware. So the honest statement is not "one layer instead of two" but
**"one layer instead of two, and that one is unverified on this OS."** Measuring
it is [RELEASE_READINESS_GOALS §4.3](RELEASE_READINESS_GOALS.md)'s Windows QA
job, not this card's.

**Why we are not implementing it.** A cost judgement — not a claim that Windows
lacks isolation primitives:

- Windows **does** have **AppContainer isolation** (credential / device / file /
  network / process / window isolation, least-privilege by default). But it is
  an **API, not a wrapper command**: you create a per-user, per-app profile with
  capability SIDs via `CreateAppContainerProfile` (`userenv.h` / `Userenv.dll`,
  Windows 8+ desktop apps) and then launch into the returned AppContainer SID.
  There is no documented `sandbox-exec` equivalent — nothing to prepend to an
  argv. macOS L3 is *exactly* one prepended argv (`wrapWithSandboxExec` →
  `/usr/bin/sandbox-exec -f <profile>`, `sandbox.ts`); the Windows equivalent
  means new native machinery on the spawn path (node-pty / ConPTY), a
  hand-authored capability set, and a second profile language to keep in sync
  with the SBPL one — new mechanism, from design.
- **Job objects are not a sandbox either** — the other primitive GAP-7 named. A
  job object groups processes and enforces *resource* limits (working set,
  priority, CPU rate, end-of-job time), UI restrictions, accounting, and
  `TerminateJobObject`. It carries **no filesystem / registry access confinement
  and no credential isolation**, and since Vista security limits must be set
  per-process rather than job-wide. It would help *kill* a runaway process tree
  — it would not stop that tree from reading `~/.ssh`, which is the L3 job.
- **Windows Sandbox is not a substitute.** It is a Hyper-V–based disposable VM:
  Pro / Enterprise / Education editions only (**not Home**), one instance at a
  time, host-installed software is absent inside it, and all state is discarded
  on close. N parallel workers, each needing the user's actual repo and the
  user's own `claude` install, do not fit that shape.
- The population being protected is **one machine**. Everything that would be
  confined (swarm workers, overseer brain) is reachable only through the
  owner-only hidden `swarm` experiment (+ the explicit, UI-less local unlock in
  `swarmGate.ts`). General users have no path to it, so the real exposure today
  is the owner's own host, with the owner watching. New native machinery for
  that population does not earn its cost.

**Re-evaluation trigger (do not lose this).** The acceptance rests entirely on
"nobody but the owner can reach it". When GAP-1 — the gate model that opens
swarm to general users — is designed, this decision is one of its inputs and
**must be decided again**: a general Windows user running unattended workers
would have one (unverified) layer where a macOS user has two. Opening swarm on
Windows without either implementing L3 or measuring L4 there would ship the
weaker half silently.

【一次資料】 Microsoft Learn: *AppContainer isolation*
(`learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation`,
ms.date 2025-07-08) · *CreateAppContainerProfile function (userenv.h)*
(`learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-createappcontainerprofile`,
ms.date 2024-11-26) · *Job Objects*
(`learn.microsoft.com/en-us/windows/win32/procthread/job-objects`,
ms.date 2025-07-14) · *Windows Sandbox*
(`learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/`,
ms.date 2026-03-29). Retrieved 2026-07-28.

---

## Files

- `src/lib/server/sandbox.ts` — `buildSandboxProfile` (pure SBPL builder, incl.
  the `network:'loopback'` egress-close mode) + `wrapWithSandboxExec`.
- `src/lib/server/egressProxy.ts` — the loopback allowlist CONNECT proxy the
  brain's claude rides (`ensureBrainEgressProxy`); `egressProxy.test.ts`.
- `src/lib/server/swarmOverseerBrain.ts` — `makeOverseerBrain` wires the brain
  launch: always-sandboxed on macOS, `sandboxNetwork:'loopback'`, `HTTPS_PROXY`;
  `scripts/overseer-brain-smoke.ts` is its live smoke.
- `src/lib/server/claudeTerminal.ts` — `launchClaude` applies it: writes the
  profile to a temp file, wraps the argv, forces `bypass`.
- `src/lib/server/experiments.ts` · `useExperiments.ts` · `types.ts` — the
  `sandbox` flag wired into the existing owner-gated experiment machinery.
- `src/lib/server/swarmWorker.ts` · `server/routes/terminal.ts` — resolve the
  gate server-side and pass `sandbox` into the two launch paths.
- `src/components/canvas/SettingsPanel.tsx` · `src/i18n/messages/settings.ts` —
  the owner-only toggle.
- `scripts/sandbox-probe.ts` — the kernel-level containment battery.
- `src/lib/server/sandbox.test.ts` · `experiments.test.ts` — the contract tests.

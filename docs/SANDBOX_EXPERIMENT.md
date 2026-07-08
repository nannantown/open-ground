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
changes.

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
- **403:** the only places a worker is sandboxed are owner-gated already — the
  swarm spawn routes return `403 forbidden` to non-owners *before* any spawn
  (`server/routes/swarm.ts`), and the interactive `/api/terminal/claude` path
  only sandboxes when the server-resolved `flags.sandbox` is true (false for
  everyone but the owner-with-toggle). There is no path by which a non-owner gets
  a sandboxed — or differently-behaving — launch.

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
`npm test` both pass with it read-only (verified — they read the existing cache
and write transient cache to TMPDIR/cwd, never into `<main>/node_modules`). This
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
| **Read outside the project** — allow reading `<path>`? | on reads outside `cwd`/`--add-dir` | **gone** | OS: broad read is allowed *except* `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/Library/Keychains`, `~/.netrc`, `~/.git-credentials` (kernel-denied) |
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

Verified output on macOS 26.5.1 — throwaway home + cwd, so the real
`~/.ssh`/`~/.claude`/`~/.openground` are never touched (every row matched):

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
  26 passed · 0 failed · 0 skipped
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
  worker `.git` carve-out). Everything else (`~/Documents`, the
  rest of `$HOME`, the system) is **write-denied**.
- **Credential read-denial.** Reads are broad (so the toolchain works) EXCEPT the
  secret stores, re-denied last (last-match-wins): SSH/GPG keys (`~/.ssh`,
  `~/.gnupg`); cloud / cluster / container creds (`~/.aws`, `~/.config/gcloud`,
  `~/.azure`, `~/.kube`, `~/.docker`, wrangler `~/.wrangler` + `~/.config/.wrangler`);
  the login keychain *files* (`~/Library/Keychains`); and the package / git / IaC
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
- **Keychain-mediated secrets.** `mach-lookup` is allowed (claude/node need it,
  and it's how https `git push` reaches the keychain via securityd). So a payload
  could `git credential fill`/`security` a stored token even though the keychain
  *files* are read-denied. Denying securityd would also break https push, so this
  is an accepted trade-off, not a closed hole.
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
- **Keychain carve-in (loopback-only):** claude's subscription credential lives
  in the login keychain, and Security.framework **reads the keychain db files
  from the client process** — with the `~/Library/Keychains` read-deny the
  confined claude is "Not logged in" (real-kernel verified: a sandboxed
  `security find-generic-password` fails with the deny, succeeds without).
  Under `network:'loopback'` that deny is dropped: the db is encrypted at rest
  and every off-machine byte still has to pass the allowlist proxy — there is
  no exfil destination. The `'all'` (worker/interactive) profile keeps the deny.

Verified on the real kernel (`scripts/sandbox-probe.ts`, BRAIN battery — 66/66
with the main battery, 2026-07-08):

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

**Known blocker for that QA, discovered via the brain smoke (2026-07-08):** the
worker/interactive (`network:'all'`) profile still read-denies
`~/Library/Keychains`, and claude reads its subscription credential through
those files — so a sandboxed worker/interactive claude will likely start **"Not
logged in"**. The brain path fixed this for itself (loopback profiles drop that
deny — see above); whether to carve the keychain into the `'all'` profile too is
a separate owner decision with a different trade-off (its outbound is open, so
the file-deny still trims a real exfil surface).

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

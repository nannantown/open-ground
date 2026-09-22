# GitHub Trending intake — what is worth adopting into OPEN GROUND

> **HAND-WRITTEN. Not generated** — `scripts/trending-intake.ts` never touches this
> file. The generated companions are [INDEX.md](./INDEX.md) (all 298 repositories,
> one line each, with licence + free-only columns), [DETAILS.md](./DETAILS.md) (the
> full Japanese gloss, appearance dates and quoted cost evidence) and
> [signals.json](./signals.json) (the licence / cost cache).
>
> Written 2026-09-22, then revised the same day under the owner's **free-only**
> rule (below). 25 repositories were read in full; the other 273 were not, and
> the doc says which is which everywhere.
>
> **A verdict here is a proposal; a verdict in [TRIALS.md](./TRIALS.md) is a
> measurement.** Two candidates have now been run — codebase-memory-mcp passed,
> open-code-review did not — and their entries below carry the numbers.

## Scoreboard — what actually came out of this, 2026-09-22

The owner asked the fair question: after all that, does anything from the
trending feed actually get used? Three things do. The pattern in which three is
the useful part.

| From the feed | Where it ended up |
|---|---|
| **tt-a1i/archify** — diagram skill | **IN USE.** Its output renders in a Canvas `mock` element as-is, measured (470,885 px², 0 errors). **Zero OG code changed.** |
| **caveman**'s brevity idea | **IN THE CODE**, behind `Settings.workerTrials.brevity`, off. One clause in the worker's order text. No dependency. |
| **context-mode**'s "think in code" idea | **IN THE CODE**, behind `Settings.workerTrials.thinkInCode`, off. Same shape. |
| codebase-memory-mcp — code graph | Goal kept, implementation rejected: a 30 ms `grep` index answered the same question in fewer bytes than its 286 MB binary. |
| open-code-review — AI review | Rejected. Its review spec is a generic JS/TS checklist; OG's invariants are not in it and cannot be added. |
| claude-context · claude-mem | Rejected on cost (API keys / a paid hosted default). |
| graphify · likec4 | Rejected as product features (writes into the repo / a second source of truth). Graphify stays a possible dev-time tool. |
| Orca · T3 Code | Not adoptable — they ARE OG's category. Kept as competitive intel; both MIT and free to try. |
| last30days-skill | Not for OG. Aimed at the owner's `sns-hub` topic selection instead. |
| loopx · superpowers · ECC · no-mistakes · dcg | Read for design. Nothing installed. |

**The rule this produced, and it earned its place the hard way: what survives is
TEXT — a skill, a clause, an idea. What fails is a PRODUCT that wants to install
itself.** Every rejection above traces to the same root: a program that needs a
key, a subscription, a folder inside the repo, a hook in `~/.claude`, or 286 MB
of disk is competing with something OG can already do, or with a rule OG already
decided. A file of words has no such surface.

That is also why the intake list misleads by construction: it is a list of
PRODUCTS, so every answer it offers is a product. Read it for ideas, and expect
to build the idea yourself.

## How to read this

| Marker | Meaning |
|---|---|
| **READ** | Its README was fetched and read on 2026-09-22. Statements come from that text. |
| **UNREAD** | Named from the post copy or the scan only. Nothing here should be acted on before reading it. |
| *(their figure)* | A number the project claims about itself. Nobody here re-measured it. |
| **Cost:** | Licence and runtime cost, both verified against the repository's own LICENSE and README. |

| Verdict | Meaning |
|---|---|
| **試す** | Worth a bounded, measured trial. The trial is named and scoped. |
| **参考にする** | Do not adopt. Read the design; the idea transfers, the dependency does not. |
| **採らない** | Rejected, with the reason — a cost, or a standing owner decision it collides with. |

## The standing decisions every candidate is checked against

1. **Free only (owner decision, 2026-09-22).** Only tools usable for free are
   candidates. That is two questions with two sources: *may we use it* (the
   LICENSE) and *does using it cost* (the README — a paid tier, or a required
   API key). Both are recorded per entry and, for all 298, scanned into
   `signals.json` by `scripts/trending-cost-scan.ts`.
2. **Subscription-only.** OG drives the user's `claude` CLI and never an
   Anthropic API key (`CLAUDE.md`, Terminal execution). This and rule 1 reject
   the same things for different reasons, which is why an API key counts twice.
3. **No files written into the user's project folders** (`CLAUDE.md`, Legacy
   migration). A tool that drops an output directory into the repo cannot ship
   inside OG.
4. **Compression is native Claude Code's job.** `docs/CONTEXT_MANAGEMENT_PLAN.md`
   §0: OG does **not** build its own "full → /compact" trigger; it adds only
   task-boundary `/clear` and the remaining-quota gauge.
5. **Research tab non-goals.** `docs/RESEARCH_KNOWLEDGE_PITCH.md`: no
   cross-report RAG, no conversational audio programs. Shipped as 0.11.92 with
   those refusals on purpose.
6. **One canvas.** OG folds N terminal windows onto one surface. A candidate
   whose answer is "314 MCP tools" is a warning, not a model.

---

## 1. Token cost — the owner's stated pain

### 1a. The code-graph shoot-out, and the one to trial first

Four free tools do the same thing: index the repository once so the agent stops
reading the tree to find a seam. They are listed together because picking one is
the decision — running four is the failure mode.

| | Days | Licence | Cost | Measured by whom |
|---|---:|---|---|---|
| **DeusData/codebase-memory-mcp** | 3 | MIT | no key, no runtime, no service | arXiv preprint, 31 repositories |
| colbymchenry/codegraph | 4 | MIT | no key, 100% local (opt-out telemetry) | own benchmark table |
| Graphify-Labs/graphify | 2 | Apache-2.0 | runs on your Claude Code session | own figure |
| Lum1104/Understand-Anything | 5 | MIT | no key after generation | own demo |

**→ DeusData/codebase-memory-mcp — 採らない (TRIED, then RE-MEASURED 2026-09-22).**
**READ.** ★9,269 · <https://github.com/DeusData/codebase-memory-mcp>
**Cost:** MIT. "No language runtime, hosted service, or API key." Ships as a
native executable for macOS/Linux/Windows.

tree-sitter AST parsing across 162 languages, with Hybrid LSP type resolution for
13 of them, producing a persistent knowledge graph of functions, classes, call
chains, HTTP routes and cross-service links, exposed as **17 MCP tools**. Full-
indexes an average repository in milliseconds and the Linux kernel in 3 minutes
*(their figures)*.

It is first because it is the only entry here whose numbers were measured outside
the project: the preprint [arXiv:2603.27277] reports, across 31 real repositories,
**83% answer quality, 10× fewer tokens and 2.1× fewer tool calls** than file-by-
file exploration *(their paper's figures — not re-measured here)*. Everything else
in this section cites itself.

**⚠ OG-specific risk, from its own README:** "This tool reads your codebase and
**writes to your agent configuration files**." OG also owns files under
`~/.claude` — `hooksInstall.ts` writes the PreToolUse guard into
`~/.claude/settings.json` and `ogManageSkill.ts` installs a skill — with an
explicit "never touch user-authored" ownership contract. Two installers editing
the same settings file is exactly the collision that contract exists to survive,
and it has not been tested against this one.

> **Tried, and it passes — see [TRIALS.md §Trial 2](./TRIALS.md) for the
> measurement.** Run WITHOUT `install` (release tarball + `CBM_CACHE_DIR`), so
> nothing touched `~/.claude`. Indexed this repository in **11 seconds** (13,227
> nodes / 47,690 edges, no LLM, no key, no network). The swarm-shaped question
> was answered from three `cli` queries in **3,191 bytes** against **9,768** for
> the grep-and-read path — **3.06× less**, past the 2× threshold, and that ratio
> is a floor because the unaided arm was handed the answer in advance. Next card:
> the worker-facing clause behind a flag, which needs the binary on the owner's
> Mac — and still never via `install`.
>
> **Then reversed.** The owner asked why a binary is needed at all, which exposed
> two faults: the 3.06x was measured against blind grep, not against the
> `docs/MAP.md` path `CLAUDE.md` actually prescribes, and "we need an index" had
> been read as "we need theirs". Re-measured: MAP.md-first costs 9,653 bytes (no
> better than blind grep — it names files, not symbols), and a symbol index built
> by **one grep in 30 ms** answers the same question in **2,261 bytes**, beating
> the 286 MB binary'"'"'s 3,191. **Do not install it.** Its real edge is transitive
> call graphs and naming-free search, neither of which is OG'"'"'s common case.

**colbymchenry/codegraph** — **READ.** ★19,293 · **Cost:** MIT; "No data leaves
your machine. No API keys. No external services. SQLite database only." Has
anonymous telemetry, opt out with `codegraph telemetry off` / `DO_NOT_TRACK=1`.
A hosted product is announced as "coming", so expect the OSS piece to become a
funnel. The dollar figures in its README (`$0.54`, `$2.43` …) are the **agent's**
token costs in a benchmark, not a price. Second choice if the first one's
config-file writing proves hostile.

**Graphify-Labs/graphify** — **READ.** ★89,017 · **Cost:** Apache-2.0; a Claude
Code skill (`/graphify .`), so it runs on the subscription. Needs Python 3.10+.
*(The owner asked about this one by name.)* Reads a folder — code, PDFs, markdown,
screenshots, even whiteboard photos via Claude vision — and emits `graph.html`,
an Obsidian vault, `wiki/` articles written for *agent* navigation,
`GRAPH_REPORT.md`, a persistent `graph.json` and a SHA256 `cache/` so re-runs
only process changed files. Claims 71.5× fewer tokens per query *(their figure)*.

**Does it fix the two problems the owner named?** Half of each, and the split
matters:

- **"読み込みに token を使いすぎる"** — yes. The persistent graph plus incremental
  cache is the job `docs/MAP.md` does by hand, done mechanically.
- **"CLAUDE.md が現状に追いつかない"** — no. CLAUDE.md's value is *decisions and
  their reasons* (why `asar: false`; why the shell launcher was deleted the day
  its leftover bundle shadowed the real app). Those are not in the structure, so
  no structural tool can recover them. A graph keeps the *map* current, never the
  *rationale*.

**採らない as an OG feature** either way: it writes `graphify-out/` into the
scanned folder, which is what standing decision 3 forbids. Multimodal input is
its real edge over the other three — keep it in mind for PDFs and screenshots,
not for code.

**Lum1104/Understand-Anything** — **READ.** ★39,585 · **Cost:** MIT; generation
needs Claude Code (subscription), and once a graph is committed "anyone on the
team can open it — no Claude Code, no LLM, no API key. Only Node". A Claude Code
plugin: multi-agent pipeline builds a graph of every file, function, class and
dependency, plus a **domain view** mapping code to business processes, served as
a local dashboard on `127.0.0.1` behind a token. The committed-graph-anyone-can-
open property is the interesting one for a shared project; not needed for the
token problem.

### 1b. Brevity — 試す as our own directive, not the dependency

**JuliusBrussee/caveman** — **READ.** 3 days · ★83,896 ·
<https://github.com/JuliusBrussee/caveman>
**Cost:** the **skill** is MIT, "free forever", "One command, no account, no API
key". The optional **proxy runtime is BSL-1.1** — source-available, not free for
every use. The trial below uses neither, only the idea.

A skill that makes the agent write terse prose. Code, commands, file paths and
exact error messages are never compressed; security warnings and confirmations
come back as full sentences. Cited third-party measurements *(their citations)*:
JetBrains on 86 real coding tasks — "costs you nothing measurable in quality";
an Adobe Research paper (CAVEWOMAN) — 1.4–2.4×, up to 3× cost reduction.

**Counter-evidence from another repository in this same intake:** context-mode
refuses prose-style enforcement outright, citing benchmark degradation from
aggressive brevity prompts (Moonshot AI on `kimi-k2.5`). The evidence is split,
which is why the trial is bounded.

> **Trial:** add a brevity clause to the `touch` and `standard` tier directives
> only (never `design` / `ultra`, where review depth is the point), then compare
> fuel per card in the usage breakdown before and after. Revert if card quality
> moves at all.

### 1c. mksglu/context-mode — 参考にする (the idea, not the server)
**READ.** 1 day · ★20,783 · <https://github.com/mksglu/context-mode>
**Cost:** free to use, but **Elastic License 2.0 — source-available, not open
source**: use, fork, modify and distribute are allowed; offering it as a hosted
service, or stripping the notices, are not. Fully local, no account, no telemetry
by its own statement. An optional hosted Insight dashboard exists and is opt-in.

Four sides of context waste: sandbox tools that keep raw output out of the window
(315 KB → 5.4 KB); an SQLite event log indexed into FTS5 and retrieved by BM25 so
a compaction does not lose the thread; **"think in code"** — the agent writes a
script that prints only the answer instead of reading 50 files (`47 × Read() =
700 KB` → `1 × ctx_execute() = 3.6 KB`); and a refusal to enforce prose style
*(their figures)*.

The server collides with standing decision 4. **"Think in code" does not** — it is
a one-line worker directive, and it changes *how the worker gathers* rather than
*how it writes*, so it carries none of the brevity trial's quality risk.

> Fold into `WORKER_ORDER_RULES` as its own clause, separately from the caveman
> trial, so the two can be measured apart. The Elastic licence never enters the
> picture because no code is taken.

### 1d. chopratejas/headroom — 採らない (dependency) · 参考にする (the learn loop)
**READ.** 5 days · ★44,159 · **Cost:** Apache-2.0, free, runs locally.

Compresses everything an agent reads before it reaches the model; ships as a
library, a proxy, an MCP server and `headroom wrap claude`. **Why not:** that wrap
inserts an unvetted middlebox into the one execution path OG has, and standing
decision 4 already assigns compression to native Claude Code. The interesting
part is `headroom learn`, which mines failed sessions and writes corrections into
`CLAUDE.local.md` — OG already holds the raw material (journals, rework markers,
the `priorFailure` the `/order` injection carries), so read how it decides what
is worth writing down.

---

## 2. Swarm engine — read these, do not adopt them

OG's engine exists, is tested, and its contracts live in `docs/commander/`. These
four are the public state of the art in the same shape; the value is comparison.
All four are free; none is a dependency, so cost barely matters here.

**huangruiteng/loopx** — **READ.** 1 day · ★2,061 · Apache-2.0, free.
"The open, provider-neutral, **stateful control plane** for long-horizon agents",
running *on top of* Claude Code / Codex / Cursor: it "preserves objectives, gates,
todos, evidence, quota, and handoffs across turns; the harness executes bounded
work". That sentence is OG's `runDispatchPass` + heartbeats + stall ladder
described from outside by someone who had to name the parts. Read its state model
against `docs/commander/01-engine-core.md` and `02-worker-lifecycle.md` —
especially how it separates *evidence* from *gates*, which OG blends into the
completion gate.

**obra/superpowers** — **READ.** 16 days (the most-featured repository in the
intake) · ★284,670 · MIT, free. A complete SDLC methodology as auto-triggering
skills: refuse to code first, extract a spec conversationally, show it in chunks
short enough to read, get sign-off, then produce a plan "clear enough for an
enthusiastic junior engineer with poor taste, no judgement, no project context,
and an aversion to testing to follow", then subagent-driven development with
inspection between tasks. **That description of a plan is a better specification
of what a swarm card must carry than anything currently in
`skills/order/SKILL.md`.** Read the two side by side.

**affaan-m/ECC** — **READ.** 15 days · ★254,239 · **Cost:** the repository is MIT
and free; **ECC Pro is $19/seat/mo**, and buys only the hosted GitHub App for
private repos. Some adapters want provider keys, and one component
(`ito-compute-cli`) is an unpublished private package. "Plans before it builds,
verifies changes with tests, **reviews its own work from a fresh context**" — that
last clause is OG's adversarial-review requirement, named better than OG names it.

**ruvnet/ruflo** — **READ.** 4 days · ★43,481 · MIT, free; hosted demo needs no
account or key. `npx ruflo init` gives Claude Code "a nervous system": 98 agents,
60+ commands, 30 skills, hooks that auto-route tasks, swarms, self-learning
memory, cross-machine federation. Its own quick-start admits the surface-area
problem ("You don't need to learn 314 MCP tools or 26 CLI commands"). Read the
hook-based routing; treat the surface area as the counter-example to standing
decision 6.

---

## 3. Guards and review

### alibaba/open-code-review — 採らない (TRIED 2026-09-22; was 試す)
**READ.** 6 days · ★34,602 · <https://github.com/alibaba/open-code-review>
**Cost:** Apache-2.0. The blocker in the first draft of this file was "it says
*simply configure a model endpoint*, which probably means an API key". **It does
not have to.** Its own README: "**Delegation Mode** — your coding agent runs the
review using its own LLM; **no OCR API key required**." That runs on the
subscription OG already drives, so it satisfies rules 1 and 2 together.

An AI code-review CLI (`ocr`) that was Alibaba's internal reviewer for two years
before release: reads git diffs, runs an agent with tool use that can read whole
files and search the codebase, emits line-level structured comments; `ocr scan`
reviews entire files where there is no meaningful diff. Their benchmark
(AACR-Bench: 50 repos, 200 real PRs, 10 languages, 1,505 ground-truth issues
cross-validated by 80+ engineers) reports **higher precision and F1 than a
general-purpose agent (Claude Code) on the same model while using ~1/9 of the
tokens**, with deliberately lower recall *(their figures)*.

OG's swarm spends a full agent on adversarial review. One ninth of the tokens for
higher precision is the largest claimed saving in this intake.

> **Tried, and the answer is no — see [TRIALS.md §Trial 1](./TRIALS.md) for the
> measurement.** Delegation mode is real and free (v1.12.8, `ocr delegate`, no LLM,
> no key: 722 bytes of file set + 3,406 bytes of rules on a real OG commit). But
> the rules ARE the review, and they are a generic JS/TS/React checklist — `var`,
> `==`, `any`, React hooks, XSS, `innerHTML`. Not one of OG's invariants (guard
> measured red, completion gate intact, commit before ready, doc follows code),
> and no surface accepts a project rule set. It also excludes test files and
> markdown by default, which in this repository is where the guards and the canon
> live. Their 1/9 figure is for generic review of source files — a different job,
> so it does not transfer.

### NVIDIA/SkillSpector — 参考にする, defer (no longer for cost reasons)
**READ.** 1 day · ★2,588 · **Cost:** Apache-2.0. LLM-assisted scans can use
hosted providers with keys, **or** the local provider: "Local Claude CLI — no API
key; uses your existing `claude auth login` session". So the cost objection is
gone; the deferral is about OG, not money.

A security scanner for agent skills: 71 vulnerability patterns across 17
categories (prompt injection, data exfiltration, privilege escalation, supply
chain, excessive agency, memory poisoning, trigger abuse…). In their 31,132-skill
analysed subset, **26.1% contained vulnerabilities and 5.2% showed likely
malicious intent** *(their figures)*.

**Why still defer:** OG's skill surface is read-only. `projectSkills.ts` lists
skills ("a pure reader: it never executes a skill") and `ogManageSkill.ts`
installs only OG's *own* shipped skill. There is no third-party install gate to
put a scanner behind. It becomes relevant the day OG offers to install an outside
skill — and those two figures are the argument for doing so then.

### Dicklesworthstone/destructive_command_guard — 参考にする, and it names a real gap
**READ.** 3 days · ★4,743 · **Cost:** MIT, free, local hook. (Its many "API key"
mentions are deny-patterns that *protect* keys — "API key deletion", "rotating
API keys" — not a requirement. A word-counting cost filter gets this backwards;
see §7.)

A PreToolUse hook that blocks destructive commands before they execute, across
~15 agent CLIs, installed by one curl.

**The gap it names:** OG's own deny veto (`scripts/openground-guard.js`, wired by
`hooksInstall.ts`) is **worker-only by design** — it enforces when
`OPENGROUND_GUARD=1`, i.e. in unattended swarm worker / overseer sessions. The
owner's own interactive terminals, which OG launches all day, are deliberately
unguarded. dcg is built for exactly that session. Not an adoption: two PreToolUse
hooks on one event is a coexistence question this file has not verified (the hook
config is an array and `hooksInstall.ts` preserves user-authored entries, so it is
plausible, not proven). The cheap win is reading its deny-pattern list against
OG's.

### kunchenguid/no-mistakes — 参考にする
**READ.** 1 day · ★3,388 · **Cost:** MIT, free; agent-agnostic — it drives
whichever CLI you already have, so no key of its own.

A local git proxy in front of the real remote: push to `no-mistakes` instead of
`origin`, and it spins up a **disposable worktree**, runs an AI validation
pipeline, forwards the branch only after every check passes, and opens a clean PR.
OG solves the same risk from the other end — workers are *forbidden* to push. The
disposable-worktree validation pipeline is a close design match for the integrate
step removed in the 2026-09 simplification (`docs/commander/SIMPLIFICATION.md`);
if that ever returns, this is the shape.

---

## 4. Research tab and Canvas

### tt-a1i/archify — 採用 (TRIED 2026-09-22, renders as-is)
**READ.** 6 days · ★38,491 · <https://github.com/tt-a1i/archify>
**Cost:** "MIT — free to use, modify, and distribute." It may GET a version
manifest to show an optional update reminder, sending no project data, prompts or
device id; disable entirely with `ARCHIFY_UPDATE_CHECK_DISABLED=1`.

An agent skill (`npx skills add tt-a1i/archify -g`) that turns a description — or
a repository it reads — into **one interactive HTML diagram**, then lets you
iterate in prose: "add authentication", "highlight the cache-miss path".

**Why it is cheap:** OG's Canvas mock element already renders HTML in a sandboxed
iframe. Archify's output is a single HTML file. Format and surface already match,
so a trial needs no new rendering work.

> **Tried, and it renders — see [TRIALS.md §Trial 3](./TRIALS.md).** Archify's own
> shipped example (811 KB, complete html document) was seeded into a real OG
> Canvas as a `mock` element and painted **470,885 px² of svg with zero console
> errors**, identical standalone and in-app. Its full-document output needs no
> extraction despite the mock element expecting a body fragment. No OG change is
> needed. Still unjudged: whether a diagram of OUR engine beats the prose in
> `docs/commander/01-engine-core.md` — that needs one claude session and is a
> judgement, not a number.

### mvanhorn/last30days-skill — 参考にする for OG · 試す for the owner's SNS work
**READ.** 7 days · ★56,194 · <https://github.com/mvanhorn/last30days-skill>
**Cost:** MIT, free. Zero config for Reddit, Hacker News, Polymarket and GitHub
("free, no API key"); a setup wizard unlocks X, YouTube, TikTok, arXiv and
Techmeme. Installs as a Claude Code plugin (`/plugin marketplace add`) or
`npx skills add … -g`.

"An AI agent-led search engine scored by upvotes, likes, and real money — not
editors": searches those sources in parallel, scores by what people actually
engaged with, and an agent judge synthesises one brief.

For OG this is adjacent — the Research tab already has `/research` and channels.
**Where it is directly useful is the owner's other project:** `sns-hub`'s morning
routines pick daily topics for three accounts, and its own playbook
(`docs/pdca/playbook/discovery-methods.md`) is about exactly this problem. Worth
a trial there before it is ever considered here.

### lfnovo/open-notebook — 参考にする (the boundary marker)
**READ.** 2 days · ★27,182 · **Cost:** MIT, and **free only if you run local
models** — it supports 18+ providers including Ollama and LM Studio, and its own
comparison table lists its cost as "Pay only for AI usage". With a hosted
provider it is not free.

A self-hosted NotebookLM alternative: multi-modal sources (PDF, video, audio,
web), multi-speaker **podcast** generation, full-text **and vector search across
all content**, chat with context, Japanese UI included.

This is what the Research tab would be if its two refusals were lifted — and
`docs/RESEARCH_KNOWLEDGE_PITCH.md` refused both deliberately: no cross-report RAG
("今回の器は 1レポート=1ナレッジ"), no conversational audio (OS speech synthesis
only, zero network, zero cost). Keep it as the reference implementation for the
day the owner wants cross-report questioning; do not drift into it by accident.

### likec4/likec4 — 採らない
**READ.** 1 day · ★4,249 · MIT, free. Architecture-as-code: a C4-inspired DSL,
`npx likec4 start` for live diagrams, a VSCode extension. Real tool, wrong cost
here — not money, maintenance: a DSL is a second source of truth beside
`docs/commander/` and `docs/MAP.md`, and TARGET-STATE §6 already says the code is
canonical and the docs follow. `cathrynlavery/diagram-design` (6 days, ★34,665,
MIT, **UNREAD**) is the lighter alternative if diagram templates are ever wanted.

---

## 5. Competitive intel — products in OG's exact category

Not adoption candidates, and both are free, so the owner can try them.

**stablyai/orca** — **READ.** 1 day · ★43,793 · **Cost:** "Orca is free and open
source under the MIT License."
"The AI Orchestrator for 100x builders. Run Codex, ClaudeCode, OpenCode or Pi
side-by-side — each in its own worktree, tracked in one place." Shipping:
**parallel worktrees** (fan one prompt across five agents, compare, merge the
winner), Ghostty-class **terminal splits** with WebGL and scrollback that survives
restarts, a **mobile companion** (iOS + Android) that notifies when an agent
finishes and takes follow-ups, **design mode** (click any element in a real
Chromium window and send its HTML/CSS/screenshot into the prompt), native GitHub
and Linear browsing, **SSH worktrees**, diff annotation, an account switcher with
Claude/Codex usage and rate-limit tracking, and an `orca` CLI so agents drive Orca
itself.

**pingdotgg/t3code** — **READ.** 2 days · ★15,026 · **Cost:** MIT; "Works with
your subscriptions on Claude Code, Codex, Cursor, Grok Build, OpenCode, and Google
Antigravity", and the README's answer to "what are you selling me?" is "Nothing".
An "agent harness control surface": iOS, Android, web and **Electron desktop**,
explicitly open "so you have everything you need to fork it".

**What this means for OG's positioning.** Both lead with *per-agent worktrees +
mobile + review*, and both are multi-provider and free. OG leads with what neither
has: **every project as a card on one canvas**, a board per project, and an
autonomous swarm with an owner-facing escalation path. Keep that sharp. Terminal
splits are table stakes now.

Same category, **UNREAD**, listed so a later session does not rediscover them:
`lobehub/lobehub` (★80,146), `paperclipai/paperclip` (★76,429, scans free),
`lukilabs/craft-agents-oss` (★5,550, scans free), `chaitanyagiri/munder-difflin`
(★2,646), `multica-ai/multica`, `vastsa/PI-Desktop` (LGPL).

**anthropics/claude-plugins-official** — **READ.** 7 days · ★35,000 ·
Apache-2.0, free. The official plugin directory: fixed layout
(`.claude-plugin/plugin.json`, `commands/`, `agents/`, `skills/`, `.mcp.json`),
immutable plugin names, `/plugin install <name>@claude-plugins-official`, and a
submission form. Relevant because OG already ships skills (`skills/order`,
`skills/og-manage`): if they are ever distributed rather than server-installed,
this is the required shape.

---

## 6. Rejected under the free-only rule

### zilliztech/claude-context — 採らない (cost)
**READ.** 3 days · ★8,370 · MIT licence, but the tool needs a **Zilliz Cloud API
key** and an **OpenAI API key** for embeddings. Fails rules 1 and 2. Its own
README now points readers at the authors' newer `memsearch` instead.

### thedotmack/claude-mem — 採らない (paid by default)
**READ.** 5 days · ★59,996 · Apache-2.0 — and this one is the reason the
free-only rule needs a human reading the README. Its installer's **default is
"CMEM Pro, the hosted memory"**: sign in by magic link, "free for your first 30
days", and "when the free trial ends, memory automatically falls back to your
Anthropic plan **unless you subscribe**". A free local path exists
(`--provider host`, or `CLAUDE_MEM_ONLINE_OPTIN=false`), but it is opt-in, not
the default.

**It scans `free?`, not `cost?`** — a paid hosted default that names no price is
invisible to a README scan. That is the blind spot to remember when reading
INDEX.md.

### The eight repositories carrying a price string
From the 298-repository sweep: `affaan-m/ECC` ($19/seat/mo, OSS still free),
`Fincept-Corporation/FinceptTerminal`, `abhigyanpatwari/GitNexus` ($35/month),
`rohitg00/agentmemory` ($10/yr), `Anil-matcha/Open-Generative-AI`,
`wonderwhy-er/DesktopCommanderMCP` ($20/month), `Gitlawb/openclaude` ($10/mo) —
and one **false positive**: `ripienaar/free-for-dev` is a *catalogue of other
services' free tiers*, so every price in it belongs to somebody else. None was
read in full; the prices are quoted in `signals.json`.

---

## 7. What this does NOT tell us

- **The source is an Instagram/YouTube feed, not a technology radar.** Selection
  favours what makes a watchable 50-second video with a money angle. A tool that
  would help OG and makes bad video is simply absent.
- **Appearance count measures the poster's reuse, not quality.**
- **Star counts are the figure recorded on the day it was featured** and were not
  re-checked. Several look implausibly high. Ordering hints, not facts.
- **The free-only scan reads READMEs; it does not audit products.** Across 298:
  39 scan `free`, 230 `free?`, 27 `cost?`, 2 `unknown`; a licence was identified
  for 272. `free?` means "the README did not say", which is most of them.
  claude-mem above is the worked example of how that misses a paid default, and
  `free-for-dev` of how a price string can belong to someone else.
- **A word count is not a cost filter.** The first version of this pass grepped
  for "API key" and got two of twenty-two backwards in one sitting — caveman
  ("no account, no API key") and dcg (deny-patterns that *protect* keys) were both
  wrongly marked as needing one, and a `$` detector called codegraph's benchmark
  table a price. All three are pinned as cases in
  `server/__tests__/trendingCostScan.test.ts`.
- **273 of the 298 repositories are UNREAD.** Everything with a **READ** marker
  above was read in full; the rest is post copy plus a scan. `DETAILS.md` is the
  place to grep, and its answers are a starting point, never a citation.

## 8. Refreshing this

```bash
# the trending project must be checked out with history
git -C <github-trending-video> fetch --depth=1000 origin main

# 1. licences + cost signals (network; skips anything already cached)
npx tsx scripts/trending-cost-scan.ts <github-trending-video>
# 2. the two generated docs (offline; reads signals.json if present)
npx tsx scripts/trending-intake.ts <github-trending-video>
```

Add `--refresh` to the scan to re-fetch everything, or `--only owner/name` for
one repository. Both scripts regenerate only `INDEX.md`, `DETAILS.md` and
`signals.json`. **This file is updated by hand**, and a new entry needs the same
three things as the ones above: the README actually read, the licence and runtime
cost verified, and the standing decision it does or does not collide with.

Merge behaviour is pinned by `server/__tests__/trendingIntake.test.ts` (12 tests,
8 mutants measured red) and the cost classifier by
`server/__tests__/trendingCostScan.test.ts` (24 tests, 9 mutants measured red),
both on 2026-09-22. The git walk was verified outside the suite by slot-diffing
775 (date, repository) pairs against `git log` and re-deriving one repository's
16 appearance dates independently.

# YOU_CORPUS — the proxy's externalised judgment axis (Phase 0)

> Status: **Phase 0 shipped** (this doc + `src/lib/server/youCorpus.ts` +
> `server/routes/youCorpus.ts` + `scripts/you-corpus.ts`). The proxy that
> *consumes* the corpus is a later phase — see the auto-memory note
> `project-autonomous-overseer-design`.

## Why

The autonomous-overseer design treats the proxy as **"the user's faithful
function"**: its errors are not personality flaws but *missing information*. So
the investment is not a always-on smart runtime — it is **writing the judgment
axis out to a place the proxy can be injected with at startup**. Phase 0 builds
exactly that single artifact and the pipeline that keeps it current.

## What exists after Phase 0

1. **A single injectable file** — `~/.openground/you-corpus.md`. Self-describing:
   it opens by telling the reader it is the owner's proxy and how to behave
   (reproduce the owner's judgment; escalate *irreversible* actions —
   billing / publish / payment / deletion — to the real owner regardless of
   confidence). A proxy launcher prepends this file as context. Written `0600`.

2. **A mechanical ingestion pipeline** (`assembleYouCorpus`) that pulls three
   sources and rebuilds the file:
   - `CONCEPT.md` — the product soul (the tracked repo file).
   - `project_business_model_vision` — the business soul (pinned to its own
     section; an auto-memory note).
   - the rest of the OPEN GROUND **auto-memory** (`feedback` / `project` /
     `reference` / `user` notes), grouped by kind. The `MEMORY.md` index is a
     pointer list, not a judgment, and is never ingested.

3. **A "new decision" command/UI** to append a judgment that **survives every
   rebuild**:
   - CLI: `npm run you-corpus append "<判断>" [--tags a,b] [--context "…"]`
     (also `rebuild` / `status` / `print` / `path`). Works offline — usable at
     proxy bootstrap (`npm run you-corpus print | …`).
   - HTTP: `POST /api/you-corpus/append` (and `/rebuild`, `GET /api/you-corpus`
     for status, `GET /api/you-corpus/raw` for the injectable markdown).

## Privacy — load-bearing

The corpus is a pile of personal information. It is **never git-shared**:

- It lives only under `~/.openground/` (the central app home), never inside any
  scanned project's working tree. No code path writes it into a repo.
- Both files (`you-corpus.md`, `you-corpus-additions.json`) are written `0600`.
- The repo `.gitignore` defensively ignores `you-corpus.md` /
  `you-corpus-additions.json` (unanchored), so even a misconfigured CLI run
  inside a work tree can never commit one.

## Source layout

| Source | Default location | Override |
|---|---|---|
| auto-memory | `~/.claude/projects/<encoded-main-repo-path>/memory/` | `OPENGROUND_MEMORY_DIR` |
| CONCEPT.md | `<git worktree root>/CONCEPT.md` | `OPENGROUND_CONCEPT_PATH` |
| business_model_vision | the `project_business_model_vision.md` note in the memory dir | (follows memory dir) |
| hand-added judgments | `~/.openground/you-corpus-additions.json` (JSON array) | — |
| **assembled output** | `~/.openground/you-corpus.md` | `OPENGROUND_HOME` |

**Memory-dir resolution.** Claude Code keys per-repo memory under
`~/.claude/projects/<key>/`, where `<key>` is the **main checkout's** working
dir with every non-alphanumeric char replaced by `-` (no run-collapsing):
`/Users/k/projects/OPEN GROUND` → `-Users-k-projects-OPEN-GROUND`. From a linked
worktree we recover the main root with
`dirname(resolve(cwd, git rev-parse --git-common-dir))` (the shared `.git` is
absolute for a worktree, the literal `.git` for the main checkout — resolving
against cwd then taking the dirname yields the main working dir in both cases).
A missing/unresolvable dir contributes no memory rather than failing. The env
overrides exist for the test suite (so it never reads the real `~/.claude`) and
as an escape hatch.

## Design notes

- **Append never loses data.** Appends go through a single-flight chain (like
  `store.setSettings`) and are stored separately from the generated sections, so
  a rebuild re-ingests the mechanical sources *and* re-renders the persisted
  hand-added judgments. A corrupted additions file is treated as empty (never
  blocks assembly), mirroring the `readJson` guards in `store.ts`.
- **No auth gate** on the routes: this is local, personal, single-user machine
  state with no project-path input (mirrors `/api/settings`). The cross-origin /
  CSRF guard in `server/app.ts` already protects the mutating routes.

## The interview loop —「今日の1問」 (shipped)

Hand-written notes only capture what the owner thinks to write down. The
interview loop covers the rest: it notices something they actually **did** and
asks about the judgment behind it — one question, once a local day, answer
appended through the same `appendJudgment` path.

`src/lib/server/personaInterview.ts`, surfaced in the Persona tab.
State: `~/.openground/persona-interview.json` (`0600`).

**No model is spawned.** Generation is a deterministic template fill over the
owner's durable records. `claude -p` is forbidden repo-wide (subscription
billing), so an LLM question would cost a whole PTY session per day — but the
deciding reasons are correctness, not cost:

1. **The ban on generic questions becomes structural.** Every template needs a
   concrete observed fact to fill its slots; with no material the loop emits
   *no question at all* rather than falling back to a quiz item. "Are you a
   planner?" is not something the module can produce.
2. **A board card carries no move or approval TIMESTAMPS.** It has `createdAt`,
   its current column, and durable flags/counters (`reworkCount`,
   `selfSupplyApproved`, `reviewedBy`) — but nothing saying *when* any of it
   happened (see `ProjectTask`). A model handed a board digest will write "you
   moved X to done yesterday", which is unknowable. Every template asserts only
   what its source field proves: the board detectors ask about a durable **fact**
   ("you sent this back twice", "you approved this"), never about timing.

Decision *speed* is therefore asked about only from escalations, which do carry
four timestamps (`createdAt` / `answeredAt` / `injectedAt` / `dismissedAt`).

This distinction is not theoretical — an adversarial review caught two templates
violating it. Both rendered **card age** as time-in-column ("has sat on hold for
40 days", "has waited 30 days"), which the repo's own rework-overflow path
falsifies: it parks a long-lived card without touching `createdAt`. Both now say
"added N days ago", and a test asserts the fabricated phrasings never return.

### The sources it reads

| Signal | Field | Question it asks |
|---|---|---|
| unclassified area | `Escalation.proxyDraft.isAbstention` | the stand-in said it could not call this — what would you look at? |
| sent back | `ProjectTask.reworkCount` | what kept being missing? |
| a past answer | `Escalation.answer` | is that the rule, or was it just this once? |
| decision speed | escalation timestamps | one settled at once, one held for days — what differed? |
| parked | `boardColumn: 'blocked'` + age | what are you waiting for? |
| unanswered | `status: 'open'` + age | what makes it hard to call? |
| approved | `selfSupplyApproved` | what do you look at when letting something through? |
| passed over | oldest todo vs a newer started card, **same project** | what decides the order? |
| closed unanswered | `dismissedAt` | was it simply not yours to decide? |

`isAbstention` is the load-bearing one: it is the stand-in's own admission that
the corpus is too thin somewhere, which makes 「未分類の領域に出会ったら決めつけず
1問だけ聞く」 a detector rather than a hope.

| Concern | How |
|---|---|
| once a local day | disk sentinel + a `globalThis` memo (survives `tsx watch`); a barren day is marked too, so an empty sweep is not retried all day — but only when the sweep was **complete** (see below) |
| never re-ask | `askedSubjects` holds the subject key of every question asked (capped at 5000 ≈ 13 years at one a day — the cap is a growth bound, sized so the tab's「二度聞きません」never becomes false in practice); `kind` rotates by least-recently-used so ten parked cards ≠ ten identical days |
| one project = one UUID | `detectPassedOver` is the only detector that pairs two cards, and it pairs them **within a registry UUID**. Names are not identities: two folders can share a basename and `displayName` is owner-editable cosmetic text, so grouping by name paired unrelated repos and asked the owner what decided an order that was never contested. `BoardCard` carries no name at all — a field that must never be used as a key is how that bug happened |
| never go silent | detectors return **every** hit, ranked — not just their top one. A single-hit detector looked equivalent and was not: a parked card does not move, so once its top subject was asked the whole kind went quiet **permanently** while the runners-up sat unasked (measured: ten parked cards produced one question, ever) |
| atomic writes | all three mutators run through one single-flight chain. answer/skip straddle an `await` on the corpus write, so without it two overlapping answers both saw `open` and both wrote, and a day rollover mid-answer rolled `lastAskedDate` **backwards** — erasing the new day's question and un-burning its subject |
| honest failure | if **every** detector throws, the loop raises instead of reporting the empty state — a tolerant catch there would turn a broken build into a confident "nothing to ask today" and mark the day so it never retried |
| “nothing to ask” needs a complete read | the same rule, applied one layer earlier. `InterviewMaterial.complete` records whether every board **and** the escalation inbox was actually read; an incomplete sweep that yields no candidate **raises and leaves the day unmarked**, so the tab hides the section (route 500) instead of asserting「今は新しく聞くことがない」about records it could not open, and the owner's next visit sweeps again. An incomplete sweep that *did* find something still asks — a question quoting a real card is honest, and refusing would let one broken project silence the loop. Caveat, deliberately not papered over: the readers upstream are tolerant (a corrupt `tasks.json` or escalation store reads as **empty**, not as a failure), so `complete` sees only faults that actually throw |
| engine-independent | nothing is scheduled — the tab's `POST /api/you-corpus/interview` generates on the day's first ask. `GET` is a pure read (a read must never mutate) |
| answers | `Q: …\n→ オーナーの回答: …`, tagged `['interview', kind]` — byte-identical framing to the escalation write-back, so the corpus reads as one voice |
| skip | recorded, nothing written to the corpus, and it does **not** unlock a second question that day |

A corpus failure on answer **throws** (unlike the escalation write-back's
best-effort): no worker is waiting, and marking a question answered while losing
the owner's words would destroy the one thing they just typed.

## The proxy-injection seam (next phase)

`readYouCorpus()` (and `GET /api/you-corpus/raw`, and `npm run you-corpus print`)
return the injectable text, assembling on demand if the file is missing. A
future proxy launcher refreshes (`assembleYouCorpus()`) and prepends this text as
system context before spawning the supervisory `claude`. Wiring that launch —
plus the brain-stem monitoring loop and the escalation inbox — is out of Phase 0
scope (see `project-autonomous-overseer-design`).

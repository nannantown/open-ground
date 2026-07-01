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

## The proxy-injection seam (next phase)

`readYouCorpus()` (and `GET /api/you-corpus/raw`, and `npm run you-corpus print`)
return the injectable text, assembling on demand if the file is missing. A
future proxy launcher refreshes (`assembleYouCorpus()`) and prepends this text as
system context before spawning the supervisory `claude`. Wiring that launch —
plus the brain-stem monitoring loop and the escalation inbox — is out of Phase 0
scope (see `project-autonomous-overseer-design`).

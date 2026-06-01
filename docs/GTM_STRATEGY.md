# OPEN GROUND — Go-To-Market Strategy

A concise GTM for taking OPEN GROUND public. It encodes the strategic decisions
made during release prep; treat it as the source of truth for positioning,
audience, and channels.

---

## 1. Positioning

> **OPEN GROUND is mission control for everything you build with Claude Code.**

One pannable canvas where every project is a card, every card narrates "where it
stands now" (its last Claude Code run), and you launch / monitor Claude in any
of them without juggling terminal windows.

### The wedge: cross-project, not single-project

In 2026 **Anthropic shipped its own single-project Claude Code desktop app.**
That is a hard constraint on our positioning:

- **We do NOT compete as a single-project GUI for Claude Code.** A polished
  one-project IDE-like shell is exactly the lane the first party now owns, and
  we will lose a feature race against the people who make the model.
- **Our wedge is the CROSS-PROJECT layer** — the portfolio / multiplexer view
  that the first-party app, by design, doesn't address. Anthropic's app makes
  *one* project excellent; OPEN GROUND makes your *whole stack of half-built
  projects* legible and runnable from one surface.

Mental model to repeat everywhere: **first-party = the cockpit of one plane;
OPEN GROUND = the control tower over the whole fleet.** This is complementary,
not oppositional — a user can keep the first-party app for deep single-project
work and still live in OPEN GROUND for the overview.

### One-liners

- **Tagline:** Mission control for everything you build with Claude Code.
- **Sub:** Every project on one canvas. Run Claude Code anywhere, see where it
  all stands at a glance.
- **Anti-pitch (what we're not):** Not another single-project AI IDE. Not a
  hosted service. Not an API-key tool — it drives your own `claude` CLI on your
  own machine.

### Proof points (already true in the product)

- Subscription-only — drives the local `claude` CLI, no API key, your usage.
- Last-run summary as each card's hero → genuine portfolio overview.
- Runs isolate in git worktrees → parallel work without collisions.
- Per-project Canvas layer (sticky / text / frame / live mock) for design +
  brainstorm, so it's a workspace, not just a launcher.

---

## 2. Target audience

**Serial vibe-coders / indie makers with many half-built projects.** The person
with 15–40 repos under `~/projects`, three of which are "almost shipped," who
already pays for Claude and already runs Claude Code in a terminal.

- **Primary:** indie hackers, solo founders, prolific side-project builders,
  hackathon regulars — people whose pain is *breadth* (too many projects), not
  *depth* in one.
- **Secondary:** small dev teams / agencies juggling many client repos;
  technical content creators who build in public.
- **Disqualifier:** someone with exactly one project — the first-party app
  serves them better, and we shouldn't fight for them.

**Jobs to be done:** "stop drowning in terminal tabs and forgotten repos," "see
which of my projects moved and which are stuck," "fire Claude at any project in
two clicks," "remember what each project even was."

---

## 3. Brand, domains, and the coffee relationship

Shared root name **OPEN GROUND** spans two things the owner makes — this dev app
and a separate coffee project. The decision:

- **App domain: `open-ground.app`** — the canonical home for the OPEN GROUND app.
- **Coffee gets its own domain / site / story.** Same root name, **separate
  sites and separate narratives.** The two are siblings sharing a name, not one
  funnel.
- **The app leads.** `open-ground.app` is about the developer tool, full stop.
- **Coffee is a light footer wink only** — a "take a coffee break ☕" nod in the
  footer, NOT a sales channel, NOT a cross-sell, NOT a banner. It adds a touch
  of human warmth and explains the name; it never competes for attention with
  the product story or asks for a purchase.

Rationale: a dev-tool audience converts on clarity and credibility. Mixing a
coffee storefront into the pitch dilutes both. Keep them legibly separate; let
the shared name be a quiet bit of personality.

---

## 4. Internationalization

**JA + EN at minimum, from day one.** The owner and a meaningful slice of the
early audience are Japanese; the broader indie-maker / Claude-Code community is
English-first. Both the landing page and the in-app onboarding copy ship
bilingual (the marketing-page skill's JA/EN toggle pattern applies). Default
language follows the browser, with a manual toggle persisted in localStorage.

---

## 5. Channels

A lean, sequenced mix — no paid spend until the funnel converts organically.

1. **Landing page (`open-ground.app`).** Dark, editorial, bento-grid features;
   hero shows the canvas full of project cards (the "fleet view" that *is* the
   wedge). Clear prerequisites (macOS arm64, `claude` CLI + subscription,
   subscription-only). Single CTA: download the `.dmg`. JA + EN.
2. **Content / build-in-public.** Short demo clips (the multiplexer firing
   Claude at several projects at once), a "why cross-project, not
   single-project" post that names the first-party app honestly and stakes the
   complementary position, and a teardown of the terminal-tab pain.
3. **Developer communities.** Where serial builders already are: Claude Code /
   Anthropic community spaces, indie-hacker forums, relevant subreddits, HN
   (Show HN at a polished milestone), X/Bluesky dev circles, Japanese dev
   communities (Zenn / Qiita / X JP). Lead with the demo, not the manifesto.
4. **Targeted ads (later, gated on conversion).** Only once the LP converts
   organically: narrow targeting to Claude / AI-coding-tool interest +
   indie-maker segments, pointing at the LP. Treat as amplification of a proven
   message, not discovery.

---

## 6. Sequenced next-steps checklist

**Phase 0 — Ship-ready (release prep; mostly done in code)**
- [x] Parametrize update repo + default to public `open-ground`.
- [x] Remove hardcoded signing identity; document env-based signing.
- [x] Placeholder-ize Apple Team ID / Apple ID in docs + scripts.
- [x] End-user `README.md`.
- [x] Claude-CLI readiness probe + Settings/empty-state hints + run-failure msg.
- [ ] Publisher: create/rename public `open-ground` repo; cut `v0.1.0` Release.
- [ ] Publisher: set `APPLE_TEAM_ID` / `APPLE_ID` / `CSC` / `GH_TOKEN`; run
      `npm run dist -- --publish always`; verify Gatekeeper opens it clean.

**Phase 1 — Landing**
- [ ] Register `open-ground.app`; stand up the LP (JA + EN, dark editorial,
      bento features, canvas hero, `.dmg` CTA, coffee footer wink only).
- [ ] OGP + favicon + cover image; 30–60s demo clip of the multiplexer.
- [ ] Wire LP download to the GitHub Release; add an issues link for feedback.

**Phase 2 — Launch motion**
- [ ] Publish the "cross-project, not single-project" positioning post.
- [ ] Seed 3–5 demo clips; soft-launch to a small group; collect first feedback.
- [ ] Show HN / community posts at a polished milestone; engage replies fast.

**Phase 3 — Iterate + amplify**
- [ ] Instrument funnel (LP → download → first run → first multi-project run).
- [ ] Tighten onboarding where the funnel leaks (esp. CLI-missing drop-off).
- [ ] Only then: small targeted ad test against the proven LP.
- [ ] Stand up the separate coffee site under its own domain (decoupled track).

---

## 7. One-paragraph summary

OPEN GROUND is mission control for everything you build with Claude Code. Its
defensible wedge is the cross-project portfolio / multiplexer view — explicitly
*not* a single-project GUI, because Anthropic's own 2026 single-project Claude
Code desktop app owns that lane; we are the control tower over the whole fleet,
complementary to it. We target serial vibe-coders and indie makers buried in
half-built projects, lead with `open-ground.app` (JA + EN), keep the owner's
coffee project as a separate site with only a light "coffee break" footer wink,
and grow through an LP + build-in-public content + developer communities, adding
targeted ads only after the funnel converts on its own.

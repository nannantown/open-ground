# The floating assistant — design (Mac screen + iPhone)

> Owner decision 2026-10-03: one personal assistant, floating over every OPEN
> GROUND screen, "like ChatGPT's Dots", with a name and a look the owner picks.
> The character is the app icon's shape — a thick ring cut by 8 large
> notches, drawn as 4 pieces — with a quiet sense of life (the pieces
> breathe, blink, light up in turn) — never showy. No explanatory text on screen; the
> fewest elements that still explain themselves. No emoji; direction marks are
> chevrons only (CLAUDE.md "UI design principles").
>
> This page is the **whole spec for the iPhone app's new assistant screen**
> (`openground-ios`): a card there should be buildable from this page alone.
> Talk data and wire frames: `docs/PHONE_LINK.md` ("The assistant", "What the
> assistant remembers"). Proposals and the owner's choice: OPEN GROUND project Canvas
> 「浮いているアシスタント(案)」 (案A 輪 / 案B 灯 / 案C 粒 — not chosen; 案D かけら — chosen).

**Chosen look (owner, 2026-10-03): none of the three proposals — the real
logo.** "The proposals are roundish; the real OPEN GROUND logo is angular
shards. Use the actual logo and be more faithful to it." So the character is
the logo's own 20 shards, drawn as they are, and its life comes from moving
the shards themselves (§5). Recorded on the Canvas as 案D かけら; the three
earlier proposals stay there as history.

**Revised the same day (owner, 2026-10-03): the app icon's shape.** The 20
fine shards were too busy at button size; the owner asked for the desktop
app icon instead — "fewer pieces, easier to see". So the character is now
the icon's carved ring (a thick ring with 8 large notches), split into its 8
pieces, and the same motions move those pieces (§4, §5).

## 1. What the owner gets

- A small character floating in a corner of every screen (Ground, every
  project tab, Settings). Click it — a talk window opens next to it. Click it
  again, or Esc, and the window closes; the talk is still there next time.
- It can be dragged anywhere and stays where it was put.
- It is the same assistant, with the same talk, as the iPhone: the record is
  kept on the Mac only (`~/.openground/assistant/`, see PHONE_LINK.md).
- An answer that arrives while the window is closed lights a small dot on
  the character.
- Name and colour: the character inside the open window is a button; it
  shows a name field and four colour dots. Both are saved on the Mac and
  reach the phone.
- Owner only (the `/api/phone-link/*` routes are `ownerOnly`; elsewhere — and
  in the owner's public-view preview — the character is simply absent; it
  asks again when the signed-in user or work mode changes). Work mode closes
  the window; the character is faded and cannot be opened (or absent, where
  the owner check cannot run in work mode).
- Esc inside the window closes it and nothing underneath reacts; an Esc that
  only cancels a Japanese conversion does not close it.
- A line refused before it reached the assistant (busy, too long, work mode)
  goes back into the input with a plain reason; a line that failed after it
  was logged is not given back (it is already in the talk).
- The window is small by default (owner 2026-10-04): the character button,
  the input and a "show the conversation" toggle. An empty input shows one
  faint line, 「話しかける…」 / "Say something…" — no greeting, no example
  buttons. Folded, it shows only the exchange made in this opening (the line
  and its answer); closing clears it unless the answer is still coming. The
  toggle unfolds the whole talk as a light chat and folds it again; the
  choice is remembered (`localStorage` `og.assistant.expanded`).
- Two modes, kept apart (owner 2026-10-06, replacing the 2026-10-04
  "voice on / mute" mic), both only where the Mac can listen:
  - **Chat — typing by voice.** The mic in the input is a toggle: pressed =
    on (the button fills and pulses), what is said goes INTO the input as
    text (the words being heard show live; finished ones stay), pressed
    again or sending = off. It never sends by itself and nothing is read
    aloud. Typing while it listens takes over the words heard so far. (The
    iPhone's chat mic is hold-to-talk; the Mac's is press-on / press-off, as
    the owner asked.)
  - **Call — talking by voice** (iPhone `CallView.swift`). While the input is
    empty and no photo is picked, the key where send sits is a call key
    (`Phone`, the assistant's colour). The window becomes the call screen:
    name, the character (thinking while an answer is made), one state line —
    発信中 / 聞いています / 考えています / 話しています / 消音中 /
    少しお待ちください (Calling… / Listening / Thinking / Speaking / Muted /
    One moment — the mic is shut for a moment: reopening after a reply, or
    other app speech playing; 聞いています only once the mic says it is ready) — the call's time (m:ss), and
    three round keys with tooltips only: speaker (`Volume2`, lit = answers
    read aloud; off mid-answer stops the reading), end (`PhoneOff`, accent),
    mute (`MicOff`, lit = the mic is shut). Each finished utterance is sent;
    while an answer is made or read the mic is shut (it would hear the
    reading). A refused mic shows why, with a retry key (`Phone`) in place
    of speaker/mute; it never redials by itself. End, Esc or closing the
    window ends the call. Other app speech (a Research digest read aloud)
    is never cut or queued behind: while it plays the call's mic stays shut,
    and an answer that could not be read (that, or speaker off) is shown on
    the call screen instead. Signing out (the routes refuse) ends the call and
    its reading; signing back in returns to the chat with the mic off.
  Ears = macOS's own speech recognizer (`native/og-listen`, on-device where
  the language allows); no paid voice API. The mic is on only while one of
  the two modes really listens.

## 2. The data both screens read

| What | Where | Values |
|---|---|---|
| name | `~/.openground/assistant/config.json` `name` | one line, ≤ 24 characters, `''` = not named yet (show `Assistant` / `アシスタント` by the Mac's language) |
| look (colour) | same file, `look` | `verm` (default) / `moss` / `ochre` / `ink` |
| talk | `log/YYYY-MM-DD.jsonl` | entries `{ id, at, who: owner\|assistant, text, via, card? }` |

- Mac screen: `GET /api/phone-link/assistant/log` → `{ entries, memory, logDays, memoryChars, name, look }`;
  `POST /api/phone-link/assistant/say { text }` → `{ reply, card? }` (one line
  at a time; 429 `busy`, 409 `work-mode`, 502 with a plain `detail`);
  `POST /api/phone-link/assistant/config { name?, look? }`.
- iPhone: the `projects` frame's first entry carries `name` and `look`; the
  newest `assistant-history` page carries them too (PHONE_LINK.md).

## 3. Colours (both themes)

The screen follows the system light/dark setting. Text and surfaces use the
app palette (`src/app/globals.css`); the character uses ink plus the owner's
colour.

| token | light | dark | use |
|---|---|---|---|
| bg | `#F2EDDE` | `#2A1F1A` | screen |
| card | `#F8F4E8` | `#362A22` | floating button, talk window, input |
| elevated | `#EDE6D2` | `#33281F` | hover surface |
| plane | `#E8E1D0` | `#413631` | owner's bubble |
| ink | `#2A1F1A` | `#F8F4E8` | text, character body, send button |
| muted | `#4C3D30` | `#DDD8CC` | mic icon |
| line | `#D6C9AC` | `#4A3A2E` | 1 px borders |
| line-strong | `#B8A988` | `#5F4C3C` | input border |
| accent-soft | `#E8D5CE` | `#40251F` | "open" (selected) surface |
| shadow | `rgb(42,31,26)` | `rgb(0,0,0)` | every shadow, at the alpha given |

Look colours (the character's coloured part and the four colour dots):

| look | light | dark | name (ja / en) |
|---|---|---|---|
| `verm` | `#B23A2C` | `#F29580` | 朱 / Vermilion |
| `moss` | `#5C6B3D` | `#9DB36B` | 苔 / Moss |
| `ochre` | `#9A6E20` | `#DDAE58` | 黄土 / Ochre |
| `ink` | `#2A1F1A` | `#F8F4E8` | 墨 / Ink |

Font: system (SF Pro / Hiragino Sans). Talk text 15 pt on iPhone (Mac:
the app's `text-ui`), name 13 pt semibold.

## 4. States and motion

All motion is slow and small, and it is the ring's 4 pieces that move (§5 gives the
geometry). With the system's "reduce motion" on, every loop stops and the
character is drawn still.

On the Mac the character is also drawn still — exactly as under reduce
motion — while nobody is looking at the window (it is not in front, or there
has been no mouse / key input for 2 minutes), and moves again on return
(`src/lib/presence.ts`, 2026-10-06). A
loop nobody sees still makes the renderer and GPU draw every refresh: measured,
the breathing alone kept OPEN GROUND at ~20% CPU with nothing else running.

| state | how it looks |
|---|---|
| idle — breathing | every piece drifts out along its own radius by 4 units (of the 170-unit box) and back: 4.2 s, ease-in-out, forever. Each piece starts 0.24 s after the one before it in ring order, so the ring opens and closes like a breath, not as one block. |
| idle — blink | once every 7 s the whole ring closes in for a moment: scale 1 → 0.93 → 1 about the centre, between 93 % and 100 % of the cycle (about 0.5 s). |
| thinking (an answer is being made) | breathing goes on; a light in the owner's colour runs round the pieces in ring order, one lap per 1.2 s: each piece flashes to the look colour at full opacity and fades back to ink at 45 % opacity over the next 35 % of the lap, the next piece 0.3 s later (the dimming keeps the light visible when the look is ink). Reduced motion: no light — every piece but the coloured one held at 45 % opacity. |
| listening (iPhone, while the talk button is held) | the pieces open further — drift 8 units out and stay there — and the breathing quickens to 1.6 s per cycle (drift 6 ↔ 8 units). Released: back to idle over 300 ms. |
| hover (Mac) / touch-down (iPhone) | the button surface lifts: elevated surface, line-strong border, scale 1.05, 150 ms. |
| pressed | scale 0.95, 150 ms. |
| open (selected) | button surface accent-soft with an accent border; the character keeps breathing. |
| focus (keyboard) | 2 px outline in the accent colour, 2 px away. |
| off (work mode / not connected) | 40 % opacity, every animation stopped, not tappable. |
| unread | a 10 px accent (vermilion) dot at the button's top-right — not green, which app-wide means done and comes with a check — with a 2 px card-coloured ring. Cleared when the talk is opened. |

## 5. The character — the app icon's carved ring, in 4 pieces

- **Shape:** the app icon (`build/icon.icns`): a thick ring cut by 8 large
  grain-shaped notches — the same carved ring `OpenGroundMark` draws below
  48 px (`CarvedRingMask` in `src/components/canvas/OpenGroundMark.tsx`).
  In the viewBox `60 -5 170 170` (`OG_VIEWBOX`): a disc of radius 82 at
  (145, 80), minus a centre hole of radius 48, minus 8 notches. Each notch is
  one of the logo's shards (`OG_SHARDS` in `openGroundShards.ts`), scaled
  ×1.7 about its own centre (`OG_SHARD_CENTROIDS`); the 8 are every
  2.5th shard of `OG_RING_ORDER` starting at 12 o'clock: shards
  0, 3, 10, 19, 5, 9, 15, 13. On iOS, draw the same: an even-odd path or a
  mask from those 8 shard paths, or one vector asset per piece.
- **The 4 pieces:** only 4 of the 8 notches run from the rim all the way
  into the centre hole (shards 3, 19, 9, 13); the other 4 (0, 10, 5, 15)
  stop short of it, leaving the ring solid at their inner end — as on the
  icon. So the ring is split only through the 4 through-notches, along
  radial lines at −137.5°, −46.5°, 43.5°, 132.5° (clockwise from 3 o'clock,
  y down — `RING_CUTS` in `AssistantMark.tsx`), just past each one's
  leading edge. A cut anywhere else would cross ring material: a hairline
  seam at rest, and the ring splitting open where the icon is solid when it
  breathes. `ringGeometry.test.ts` checks every cut runs through hole or
  notch only. Piece k is the ring clipped to the wedge from cut k to cut
  k+1; k is its ring order (delays in §4), k = 0 the top piece (10:30 to
  1:30).
- **Breathing direction** of each piece: the unit vector at its wedge's
  middle angle (straight up for the top piece, then 3, 6, 9 o'clock).
- **Colour:** every piece ink; piece 0 (the top one) in the owner's look
  colour (§3).
- **Sizes:** Mac floating button 50 px with the character at 40 px; talk
  window head 24 px; "thinking" mark in the talk 20 px. iPhone: head 64 pt,
  thinking mark 20 pt. The notches stay clearly visible at 20 px in both
  themes (checked 2026-10-03).

## 6. The iPhone screen (rebuild of the talk screen)

Top to bottom, edge to edge on `bg`:

1. **Head** — the character (64 pt, §5) and its name (13 pt semibold). Nothing else; the
   settings gear stays at the top-right as today (`gearshape`, muted), and
   the project menu stays at the top-left (the assistant first).
2. **Talk** — oldest at the top, newest at the bottom, scrolls itself to the
   newest line.
   - Owner: right-aligned, max 78 % width, `plane` bubble, corners
     12/12/4/12 (the small corner bottom-right), padding 6 × 9 pt × 2.
   - Assistant: left-aligned, max 86 %, plain text, no bubble.
   - While an answer is being made: the character at 20 pt in the thinking
     state, left-aligned under the owner's line.
3. **Input** — one pill (1 px line-strong, full radius, `card`): the mic first
   (hold to talk — the head character switches to listening while held), the
   text field (no placeholder), the send button (24 pt circle, ink, a
   chevron-up drawn in `bg`, stroke 3). The send button is 40 % opacity and
   not tappable while the field is empty or an answer is being made.
4. Off (no link / work mode): the character is drawn off (§4); the input is
   40 % opacity and not tappable.

The motion between states is a plain cross-fade (200 ms); no screen
transitions beyond the system's own.

## 7. Where the Mac code is

- `src/components/assistant/FloatingAssistant.tsx` — the floating button,
  dragging (position in `localStorage` `og.assistant.pos`), the talk window
  (opens on the side with more room — `panelPlacement`), name and colour.
- `src/components/assistant/useAssistant.ts` — the talk state, kept in the
  always-mounted button so closing never drops a line being answered; reads
  the log every 5 s while open (the phone talks into the same log).
- `src/components/assistant/useVoice.ts` — `useListen` (the listen stream
  `GET /api/phone-link/assistant/listen` → `src/lib/server/assistantListen.ts`
  → `bin/og-listen`, built by `scripts/build-listen.mjs`) and `useSpeech`
  (reading answers aloud, cancelling only its own). Which mode the ears serve
  is decided in `FloatingAssistant.tsx`; the call screen is
  `src/components/assistant/AssistantCall.tsx`. macOS asks the app itself for the mic and speech-recognition
  permissions, so both usage strings sit in `package.json` `mac.extendInfo`.
- `src/components/assistant/AssistantMark.tsx` — the character: the app icon's
  carved ring (`CarvedRingMask` from `OpenGroundMark.tsx`) split into 4
  pieces, each with its breathing direction and ring place as CSS variables.
- `src/components/assistant/assistantWindow.ts` — the one "this key came from
  inside the talk window" test (`isInAssistantWindow`). Every capture-phase Esc
  handler underneath (Board drawer, Canvas, placement ghost) uses it, so one
  Esc in the window never also acts on the screen below
  (`assistantWindow.esc.test.tsx`). CSS loops: `.og-ast*` in `globals.css`.
- Mounted once in `src/App.tsx`, above every view, at `z-overlay-float` (48:
  over the project panel and hosted frames, under app modals — tailwind.config.ts).
- Tests: `src/components/assistant/FloatingAssistant.test.tsx`,
  `AssistantMark.test.tsx` (the character is the icon's carved ring in 4 pieces, cut exactly like the small app mark; `ringGeometry.test.ts`: every split line runs through hole or notch only);
  name/look on the server: `assistantMemory.test.ts`; on the phone wire:
  `phoneLink.test.ts`.

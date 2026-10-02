# Phone link — talk to the president from the iPhone

Owner request, 2026-10-01: with earphones in and the Mac out of reach, hear what
reaches the president desk (progress, questions for the owner, deliveries) and
the president's replies as they happen, and talk back (push-to-talk) — plus, since
2026-10-02, an **assistant** that looks across all projects (see "The assistant"). This page
is the **whole contract for the iPhone app** — build against it alone.

Free to run: a Cloudflare Workers free-plan relay, the owner's Claude
subscription (the president is an ordinary OPEN GROUND desk), and the iPhone's
built-in speech recognition / text-to-speech. No API keys anywhere.

## Shape

```
iPhone app ──wss──▶ Cloudflare relay room ◀──wss── OPEN GROUND on the Mac
            (dials in)   og-phone-relay      (dials OUT — nothing on the Mac
                                               is reachable from the internet)
```

- Relay: `worker/src/phoneRelay.ts` (+ `phoneRelayAuth.ts`), config
  `worker/wrangler.phone.jsonc`, deployed at
  `https://og-phone-relay.mindbrew.workers.dev`. A SEPARATE Worker from
  og-collab. Deploy: `cd worker && npx wrangler deploy -c wrangler.phone.jsonc`.
- Mac end: `src/lib/server/phoneLink.ts` (started at boot when paired),
  routes `server/routes/phoneLink.ts`, Settings section `PhoneLinkSetting.tsx`;
  the APNs push that wakes a locked phone: `src/lib/server/phonePush.ts`
  (see "Waking the phone").
- The Mac must be running OPEN GROUND. When it is not, the phone still connects
  and hears `mac: false`; anything it says is refused with `mac-offline`.

## Pairing (once)

On the Mac: Settings → **iPhone** → 「iPhone とつなぐ」. A **pairing code** is
copied to the clipboard (Universal Clipboard puts it on the iPhone). 「コードを
コピー」 copies the same code again; 「解除」 unpairs. Pairing and unpairing need the
relay: when it cannot be reached (or work mode is on) they are refused and NOTHING
changes — the old phone is not cut off until an unlink actually reached the relay.
The code is handed out only after the new room has registered this Mac.

The code is base64url (no padding) of this JSON:

```json
{ "v": 1, "url": "wss://og-phone-relay.mindbrew.workers.dev/v1/<room>/phone", "key": "<phone key>" }
```

Store `url` and `key` in the **Keychain** (the key is the only thing that opens
the room). Do not log the key.

## Connecting

Open a WebSocket to `url` with the header **`X-OG-Token: <key>`**
(`URLSessionWebSocketTask` from a `URLRequest`; not `Authorization` — Apple
lists it as a reserved header that may be dropped). To catch up after being out
of signal, append `?after=<last seq you have>`.

| Reply | Meaning |
|---|---|
| `101` | open |
| `401` | wrong / missing key, or this pairing was unlinked on the Mac → ask the owner to pair again |
| `426` | not a WebSocket upgrade |

Keepalive: send the text frame `ping` every ~30 s (answered `pong` by the relay
without waking it). Reconnect with backoff on close. Close code `4003` = the
pairing was unlinked (the old key will only get 401 from now on).

All other frames are JSON text, one object per frame, with a `type`.

## Frames the phone receives

**`hello`** — first frame on every connect:
```json
{ "type": "hello", "v": 1, "mac": true, "head": 42, "projects": { "type": "projects", "selected": "<id>", "projects": [ ... ] }, "pushToken": true }
```
`head` = newest event `seq` the relay holds. `projects` = last list the Mac sent
(or `null`). `pushToken` = the Mac (as it last said) can wake this phone: send
your `push-token` now — even with `mac: false` (absent or `false` = do not send
one; see "Waking the phone").

**`event`** — something to read aloud, in order:
```json
{ "type": "event", "seq": 43, "at": 1790846484310, "projectId": "<id>", "kind": "president", "text": "了解しました" }
```

| `kind` | What it is | Read aloud? |
|---|---|---|
| `president` | the president's own words (each text block of a reply) | yes |
| `notice` | an app notice that reached the desk (progress, a question for the owner, a delivery) — plain words, prefix stripped | yes (the president usually retells it right after; the app may choose to read only `president`) |
| `commander` | the commander's reply that reached the desk | same as `notice` |
| `owner` | the owner's own words as the desk received them (from the phone OR typed at the Mac) | no — use it to confirm "heard" |
| `assistant` | the assistant's answer (`projectId: "assistant"`, see "The assistant") | yes |

`seq` is strictly increasing per pairing; remember the last one and reconnect
with `?after=`. The relay keeps the last 200 events: if the first event after a
reconnect has a `seq` above `after + 1`, some were missed (say so rather than
pretend). Nothing said while the Mac's OPEN GROUND was not running is ever sent.
Nothing is lost when the Mac's connection silently dies (Wi-Fi / network change,
sleep) either: on reconnect the relay tells the Mac the transcript position of
the newest event it stored (`resume`), the Mac sends again from there, and the
relay drops what it already has — the phone sees each event once. Text can contain Markdown
(lists, `**bold**`) — strip it before speech. Max 8000 characters.

**`projects`**:
```json
{ "type": "projects", "selected": "<id or null>", "projects": [ { "id": "<uuid>", "name": "OPEN GROUND", "desk": true } ] }
```
`desk` = that project's president desk is running now. Events only come from
the `selected` project — and from the assistant, which is always the first
entry (`"assistant": true`, never `selected`; see "The assistant").

**`ack`** — what happened to a `say`:
```json
{ "type": "ack", "id": "<your id>", "state": "queued", "projectId": "<id>", "desk": "starting" }
{ "type": "ack", "id": "<your id>", "state": "delivered", "projectId": "<id>", "heard": true }
{ "type": "ack", "id": "<your id>", "state": "rejected", "reason": "no-project" }
```
`queued` comes at once. `delivered` comes when the words actually landed in the
president's input — this can take a while: the desk is never typed into while
the president is still writing, while the owner has half-typed something at the
Mac, or while a menu is open (it waits, it does not interrupt). `desk:
"starting"` = no president desk was running, so it was started first.
`reason`: `empty`, `too-long` (+`max`: over 473 characters after newlines are
folded — longer would wedge the desk; ask the owner to say it in parts),
`no-project`, `forbidden` (the Mac is not signed in as the owner), `desk-failed`
(+`detail`), `assistant-failed` (+`detail`) / `busy` (assistant only). A `delivered` from the
assistant may carry `card` (see "The assistant").

`delivered` lives in the Mac's memory: if OPEN GROUND restarts (you see `mac`
online:false then true) while a `say` is still `queued`, that line is gone and no
`delivered` will come — tell the owner it may not have landed and offer to say it
again. Do not resend automatically (it may have landed just before the restart).
An `ack` is never sent twice: if the Mac's connection silently died, a
`delivered` can be missing even though the line landed — the `owner` event with
your words (which IS sent again) is the proof that it was heard.

**`mac`** — `{ "type": "mac", "online": false }` when the Mac drops / comes back.

**`error`** — `{ "type": "error", "code": "mac-offline", "id": "<your id>" }` or
`{ "type": "error", "code": "bad-frame" }`.

## Frames the phone sends

```json
{ "type": "say", "id": "<unique per message>", "text": "今どうなってる?", "projectId": "<optional>" }
{ "type": "select", "projectId": "<id>" }
{ "type": "projects" }
{ "type": "push-token", "token": "<hex>", "env": "production", "topic": "<bundle id>.voip-ptt" }
{ "type": "push-token", "token": null }
```

- `say` — the owner's words. Typed into the president desk as the **owner
  speaking** (no prefix), on one line (newlines become spaces), up to **473
  characters** (longer is refused with `too-long`, see `ack`). Counted as a
  JavaScript string length — UTF-16 code units, i.e. Swift's `text.utf16.count`,
  not `text.count`: an emoji counts 2 or more, so check `utf16.count <= 473`. A leading `!`, `/`
  or `#` and a trailing `\` are dropped (those switch Claude Code into shell /
  command / memory mode, or turn Enter into a newline — a phone message is always
  something to say, never a command); a `say` that is empty after that is
  refused with `empty`. Without `projectId` it goes to the selected project.
  A `say` with a `projectId` other than the selected one also SELECTS it (its
  answer is then what you hear; answered with `projects`).
  "社長に頼んで…" needs nothing special: the president takes orders and writes
  the card the same way it does at the Mac.
- `say` with `"projectId": "assistant"` — to the assistant instead (2000
  characters, newlines kept, no selection change; see "The assistant").
- `select` — hear this project from now on (no replay of its past). Answered
  with `projects`.
- `projects` — ask for the list again.
- `push-token` — only after a `hello` with `"pushToken": true`. The Push to Talk
  ephemeral token (hex), which APNs host it belongs to (`env`: `development` for
  a debug build, `production` for TestFlight / App Store) and the `apns-topic`
  (bundle id + `.voip-ptt`). `token: null` = forget it. Anything else
  (non-hex token, other `env`, a topic not ending in `.voip-ptt`) is refused
  with `bad-frame`. No reply on success. With the Mac offline the relay holds the
  newest one and hands it to the Mac when it is back (no `mac-offline`).

Frames over 16,384 characters or of any other `type` are refused (`bad-frame`), never
forwarded to the Mac.

## The assistant (talk partner across all projects, 2026-10-02)

Owner request, 2026-10-02: one partner who looks across EVERY project, answers
short, and — when asked — puts a work card on a project's Board. Its talk stays
on the phone: it never reaches a president desk, the president's chat, the
Board's notes or any screen on the Mac. Only the card it writes appears (on that
project's Board, as an ordinary `todo` card).

**On the wire** — the same frames, with `projectId: "assistant"`:
- `projects` always lists it FIRST: `{ "id": "assistant", "name": "アシスタント", "desk": false, "assistant": true }`
  (`desk` means nothing for it — always `false`, so an app that picks the first
  live desk never lands on it)
  (`name` follows the Mac's language: `Assistant` in English). It is never
  `selected`; `select` with it changes nothing (answered with `projects`).
- `say` with `"projectId": "assistant"` goes to it (the selection does not
  change). Up to **2000** characters (`text.utf16.count`), newlines kept — it is
  not typed into a desk, so the 473 limit and the dropped `!` `/` `#` do not
  apply. `empty` / `too-long` (+`max: 2000`) as for a desk.
- Then: `ack queued` at once and an `event` `kind: "owner"` with the words; the
  answer comes as `ack delivered` (`heard: true`, plus `card` when it wrote one:
  `{ "projectId", "taskId", "title" }`) followed by ONE `event` with
  `kind: "assistant"` — read it aloud. Or `ack rejected` `reason:
  "assistant-failed"` (+`detail`: one short plain sentence in the Mac's language,
  e.g. 「アシスタントが時間内に答えられませんでした。」 / "The assistant did not answer
  in time." — never an internal error) when it could not answer (Claude not
  signed in, no answer in 3 min, work mode switched on meanwhile). An answer
  takes roughly 5–40 s (a Claude session starts per line); lines wait their
  turn, one at a time. With one line being answered and one waiting, a further
  line gets ONLY `ack rejected` `reason: "busy"` (no `queued`, no `owner` event,
  no `detail`) — say it again later.
- Its events come **whatever project is selected**. Show them in the
  assistant's conversation, not the president's (tell them apart by
  `projectId`). They are replayed with `?after=` like any other event, but a
  Mac connection that dies silently can lose one (they carry no transcript
  position) — the missing `ack delivered` / `event` then shows it; offer to ask again
  (asking again does not make a second card: an open card of the same title in
  that project is reported as already there, never as newly written). When the
  Mac's socket to the relay is closed at the moment an answer is ready, the Mac
  keeps it (the newest 20 frames) and sends it, in order, once the socket is
  back — always before anything newer, so an older answer never follows a newer
  one. Work mode drops what was kept: it is never sent, not even after work mode
  is switched off (as for the president's words).
- The push rules are the president's: one push when the answer went out, none
  while a line waits for its answer — for at most 2 min, as for a desk.

**What it does** (`src/lib/server/phoneAssistant.ts`):
- Each line is one Claude Code session on the owner's subscription (no API key,
  no cost), through canvasAi's file-handoff runner: a hidden PTY in a fresh temp
  dir started with `--tools Write --restricted --permission-mode acceptEdits`
  (`ASSISTANT_LAUNCH`): its only tool is Write, and `--restricted` confines it to
  that dir — a write anywhere else is refused and creates nothing (measured
  2026-10-02 on claude 2.1.287). MCP tools are kept out twice
  (`--strict-mcp-config` and `--disallowed-tools mcp__*`; `--tools` covers only
  built-in tools). It cannot read, run or change anything else; the card is
  written by the Mac, not by the model. Guard: `phoneAssistantLaunch.test.ts`
  (the argv of the claude a real line starts).
- The Mac hands it the state of every registered project (Board counts, what is
  being worked on, open questions for the owner) and the last few lines of this
  conversation (kept in memory only, forgotten after 30 min of quiet or a
  restart). The transcript Claude Code keeps for the temp dir is deleted with it.
  The state handed over includes text others wrote (card titles, workers'
  questions); it is quoted as data, and with no tools beyond its answer file an
  injected line cannot act on the Mac — but it CAN shape the answer, including a
  card: that card lands in `todo` and is dispatched like any other. The same
  checks hold for it (a registered project, every field present, one card), and
  it shows on the Board like any card. Whether the prompt holds the runner's
  completion marker is decided by the runner's OWN detector (`containsDoneMarker`),
  never by a pattern of ours, and on the prompt AS CLAUDE'S SCREEN SHOWS IT: the
  TUI drops every invisible format character (zero-width spaces and joiners,
  soft hyphens, variation selectors, tag and bidi characters, Hangul fillers) and
  the C1 control characters U+0080–009F, so those are removed before the check. When it fires, that turn is built again
  with every `_` in ALL of its data (every project's titles and questions, the
  owner's words, the style, the whole history) as a full-width `＿` — the marker
  needs two ASCII `_` and the template has none — and a prompt the detector still
  fires on is never started (the phone gets the plain "could not answer" failure).
  So no text, however split by spaces, escape codes, invisible characters or
  nesting, can end a line early. The price: while marker text sits in the status
  or the history (until the idle reset), the model sees `snake＿case` instead of
  `snake_case` in that turn's data, and a card it writes may carry the `＿`
  (seen: a card asked to be titled with the marker itself). A turn without
  marker text keeps every `_` as written.
- It answers as JSON `{reply, card}`. When the owner asks for work and both the
  project and the request are clear, `card` = `{projectId, title, goal, judge,
  done[], placement, tier}`; the Mac checks every field is there and the project
  is registered, then writes ONE `todo` card whose notes carry Goal / How the
  owner judges it / Done when / Final placement (headings follow the Mac's
  language). An incomplete card is not written and the reply says so instead of
  claiming it was. When either is unclear it asks one short question back.
  It never dispatches, moves, merges or answers anything.
- How it talks is the owner's free text: Settings → **iPhone** →
  「アシスタントの話し方」, stored as `~/.openground/assistant-style.md`
  (editable by hand too; empty = the default below). Read fresh on every line,
  so a change applies to the next answer. Default (owner decision 2026-10-02):
  friend's tone, conclusion first, 1–2 sentences, stuck things / questions
  waiting for the owner before progress.
- Owner only and work mode as for the rest of the link: under work mode it is
  never asked.

## Waking the phone (Push to Talk)

iOS suspends the app soon after the screen locks, and the socket dies with it.
The Mac then wakes the phone with an Apple **Push to Talk** push: the system makes
"社長" the active speaker, the app redials with `?after=` and reads what came.
Free: APNs costs nothing; the key is the owner's own (Apple Developer membership).

**Relay.** Passes `push-token` on to the Mac. Only while the Mac is away does it
keep one — the newest — and hands it over (once) when the Mac connects: a token
that changed while the Mac slept would otherwise never arrive, the Mac would push
to the dead one, and a locked phone would not be woken again. `reset` erases it.
The Mac sends `{ "type": "push-ready", "on": true|false }` on every connect and
when the owner enters the key (on = it holds an APNs key); the room remembers the
last value, and `hello` carries it as `pushToken`. A phone already connected when
the key was first entered hands its token over on its next connect.

**Mac** (`phoneLink.ts` + `phonePush.ts`):
- Keeps only the newest token, in `~/.openground/phone-link.json` (0600) next to
  the pairing keys. `token: null`, unlinking, and pairing again drop it.
- When an event the phone reads aloud (`president`, `notice`, `commander` — not
  `owner`) has gone to the relay, it owes the phone one push. Pushes go at most
  once per **5 s**: more events inside that gap are covered by one push at its end.
  What a Mac reconnect re-sends (the relay already has it — see `resume`) owes
  no push.
- **No push while a `say` from the phone has no final ack** (`delivered` or
  `rejected`) — the owner has just spoken and a push would cut in with the
  president's voice. The owed push goes once that ack is out. A `say` holds
  pushes for at most **2 min** (a desk that never frees up must not silence the
  phone for good).
- The request: `POST https://api.push.apple.com/3/device/<token>` (or
  `api.sandbox.push.apple.com` for `env: development`) over **HTTP/2**
  (`node:http2`; APNs speaks nothing else, and a Worker's subrequests are
  HTTP/1.1 — that is why the Mac sends it). Headers `apns-push-type: pushtotalk`,
  `apns-topic: <topic>`, `apns-priority: 10`, `apns-expiration: 0`,
  `authorization: bearer <JWT>`. Body `{"aps":{}}` — nothing readable goes
  through Apple; the phone fetches the words over the relay. (docs/PUSH.md in the
  iPhone repo proposed a `seq` in the body; the Mac does not know the relay's
  `seq`, and the app does not read the payload, so it is left out.)
- JWT: ES256, header `{alg, kid: <Key ID>}`, claims `{iss: <Team ID>, iat}`,
  made again every 30 min (Apple: not more often than every 20, not less often
  than every 60), or at once when the owner enters a different key.
- Apple's answer decides what happens next (only the status and Apple's reason
  are ever logged — never the token or the key):
  - `410` (any reason) or `400 BadDeviceToken` → the token is dropped (the
    phone sends a new one when it joins its channel again).
  - **Refused for good** — any other `403` (`InvalidProviderToken`,
    `BadEnvironmentKeyIdInToken`, …) or `400` `DeviceTokenNotForTopic` /
    `TopicDisallowed` / `BadTopic`: the token is kept, the refusal is saved
    with it in `phone-link.json` (with the token and a fingerprint of the key
    it was refused for), and nothing more is pushed until the phone sends
    another token, the owner enters a key again (even the same one — saving
    the key always clears a stored refusal), or — for `DeviceTokenNotForTopic`
    / `BadTopic` — the app hands its token over again.
    `GET /api/phone-link` reports it as `pushRefused: "<reason>"` and
    `pushRefusedBy: "key" | "app"` (`403` and `TopicDisallowed` — a
    topic-specific key that does not cover the app — are the key;
    `DeviceTokenNotForTopic` / `BadTopic` are the iPhone app), and Settings → iPhone says the wake has stopped — "Apple refused the
    key" or "reopen the iPhone app" — instead of saying it works.
  - **Our JWT too old** — `403 ExpiredProviderToken` (Apple: "a new token
    should be generated"): the push is retried like a lost one below and is
    never saved as a refusal. The cached JWT is dropped first if it is at least
    20 min old (Apple allows a new one no more often); a younger one coming back
    expired means the Mac's clock is off, so it is not re-signed.
  - **Lost on the way** — no answer (network error, 10 s timeout), `429` or a
    `5xx`: owed again and sent once the 5 s gap is over, at most **3** times in
    a row; after that it waits for the next event. Any final answer (sent,
    token dropped, refused) starts the count afresh.
- Work mode is checked again right before the HTTP/2 connect (work mode's
  egress guard wraps `fetch`, which `node:http2` does not use).
- Nothing is pushed under work mode, without owner access, without a token or
  without a key.

**Owner, once:** create an APNs key on developer.apple.com and enter it in
Settings → **iPhone** (「Apple の鍵を入れる」: the `.p8` file, Key ID, Team ID).
Plain-language steps: `docs/IPHONE_PUSH_KEY_SETUP.md`. The key is stored in
`~/.openground/phone-push-key.json` (0600), survives unlink / re-pair, and is
never returned by any route or logged — Settings shows only its Key ID.
The Mac holds ONE key. A key made for Sandbox only cannot push to a TestFlight
build (and the reverse): APNs answers `403 BadEnvironmentKeyIdInToken`, the
token is kept, and Settings shows the wake as stopped until a key for the right
environment is entered. TestFlight / App Store builds need a Production key; a
debug build from Xcode needs a Sandbox key in its place (or one key made for
both environments, where the developer site still offers that).

## Security model

- The room is named by `sha256(phone key)`. The phone proves itself with the key
  whose hash is the room — nothing about the phone is stored on the relay.
- The Mac has its own, different key; the room remembers the hash of the first
  Mac key it sees (the Mac connects right after creating the pair, when only it
  knows the room) and refuses any other. The phone key can never open the Mac
  end.
- The relay must be `https` (the keys travel in a header); plain `http` is
  accepted only for a relay on this machine.
- Keys are 32 random bytes each, stored on the Mac in
  `~/.openground/phone-link.json` (mode 0600), never in the repo.
- Unlinking (or linking again) sends `reset`: the room erases everything it
  held and refuses BOTH old keys forever. A lost phone is cut off this way.
- Owner only: the routes and the link answer only the app owner
  (`swarmLocalOwner` or the owner role) — not the public Agent Team opt-in.
- Work mode (lockdown) refuses this egress: switching it on closes an open link,
  and the link stays down (and pair / unpair are refused) while it is on. What
  the president said under work mode is never sent, not even after it is
  switched off — the link picks up from that moment. This holds across an app
  restart too (the saved read position is dropped when work mode cuts the link),
  and an app that starts with work mode already on never dials the relay at all,
  not even for a moment before its settings are read.
- The pairing code is a write credential, so `/api/phone-link/*` answers only a
  loopback `Host`/`Origin` on EVERY method (a DNS-rebinding page cannot read it),
  and the code is fetched with POST.
- The APNs key and the phone's push token are stored 0600 and never logged or
  returned; the token is checked as hex before it goes into the request path.
- One Mac end per room: only the primary OPEN GROUND (port 47776) holds the link.
  A room taken over by another Mac end (close `4001`) waits 60 s before retrying.

**App Store, later (per user):** every pairing is already its own room, so users
never share anything. What is missing is a gate on who may *create* rooms on the
operator's relay (e.g. a subscription check in front of `fetch` in
`phoneRelay.ts`) — today anyone can make their own pair of keys and use the
relay as a pipe of their own. Add that gate before the app is public. The push
must move too: each user's Mac would need the operator's APNs key, which cannot
live on users' Macs — so the relay sends it, and the Mac only says "something new".

## Verifying

- Relay, against a local workerd or the deployed one:
  `cd worker && node test/phoneRelay.local.mjs` /
  `RELAY=https://og-phone-relay.mindbrew.workers.dev node test/phoneRelay.local.mjs`
  (33 checks: missing / wrong / swapped keys refused, frames pass, catch-up,
  resume, push-ready / push-token, unlink retires both keys).
- End to end, a stand-in for the phone:
  `node scripts/phone-link-say.mjs <pairing code> "text"` — prints every frame
  and exits 0 once the president answered after the line landed. `--key x`
  shows a wrong key is refused; no text = listen only.
- The assistant: `node scripts/phone-link-say.mjs <code> "全体どう?" --project assistant`
  (exits 0 once its `assistant` event came after the `delivered`).
- Unit guards: `src/lib/server/phoneLink.test.ts`, `src/lib/server/phoneAssistant.test.ts`
  (style change reaches the next prompt; a card lands complete in another project), `src/lib/server/phonePush.test.ts`
  (the APNs request as a real HTTP/2 server receives it, JWT, 410),
  `src/lib/server/phoneRelayAuth.test.ts`,
  `src/lib/server/supplyNoticeOwnerSay.test.ts`.
- ⚠ A test server started from inside a Claude Code session inherits
  `CLAUDE_CODE_CHILD_SESSION` and its desks save NO transcript — the feed then
  stays silent although the desk answered. Strip `CLAUDE*` env first.

## Not built (yet)

A paid voice model; a QR code for pairing. (The lock-screen wake is built; its
check on a real locked iPhone waits until the owner has entered the key.)

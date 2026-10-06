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
{ "v": 2, "url": "wss://og-phone-relay.mindbrew.workers.dev/v1/<room>/phone", "key": "<phone key>", "e2e": "<end-to-end key>" }
```

Store `url`, `key` and `e2e` in the **Keychain** (`key` opens the room; `e2e`
seals and opens every word — it is never sent anywhere). Log neither.
`e2e` is 32 random bytes in base64url (43 characters). Every frame that carries
words is sealed with it — see **Sealed frames**. A `"v": 1` code (no `e2e`) is
the old plaintext pairing; see "Moving from v1" there.

## Connecting

Open a WebSocket to `url` with the header **`X-OG-Token: <key>`**
(`URLSessionWebSocketTask` from a `URLRequest`; not `Authorization` — Apple
lists it as a reserved header that may be dropped). To catch up after being out
of signal, append `?after=<last seq you have>`. Add `&heard=<seq>` (the newest
`seq` actually read aloud — never one you might rewind below) and the relay
erases every event up to it: it holds only what you have not heard yet.

| Reply | Meaning |
|---|---|
| `101` | open |
| `401` | wrong / missing key, or this pairing was unlinked on the Mac → ask the owner to pair again |
| `404` | no Mac has made this room yet (pairing makes it before handing out the code, so normally never seen) → retry with backoff (do NOT treat it as unlinked) |
| `426` | not a WebSocket upgrade |
| `429` | this room already has 5 phone connections, or more than 60 connections this minute → back off and retry |

Keepalive: send the text frame `ping` every ~30 s (answered `pong` by the relay
without waking it; a phone socket silent for 90 s is taken as dead and closed
`4000` to make room). Reconnect with backoff on close. Close code `4003` = the
pairing was unlinked (the old key will only get 401 from now on); `4029` = more
than 120 phone frames this minute in the room — reconnect with backoff.

All other frames are JSON text, one object per frame, with a `type`. On a v2
pairing the frames below that carry words — `say`, `select`, `projects`,
`event`, `ack`, `assistant`, `assistant-history`, `call-note` — travel **sealed**: the JSON shown in the next two sections is
what is INSIDE the seal (see **Sealed frames** for the outside).

## Frames the phone receives

**`hello`** — first frame on every connect:
```json
{ "type": "hello", "v": 1, "mac": true, "head": 42, "projects": { "type": "projects", "selected": "<id>", "projects": [ ... ] }, "pushToken": true }
```
`head` = newest event `seq` the relay holds. `projects` = last list the Mac sent
(or `null`) — on v2 the SEALED frame `{ "type": "projects", "box": "…" }`: open it. `pushToken` = the Mac (as it last said) can wake this phone: send
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

Once the phone has fetched the assistant's records, its talk comes as
`assistant` frames instead of these events, and the Mac answers
`assistant-history` with an `assistant-history` frame — see "What the assistant remembers".

**`id` on an `owner` event** (since 2026-10-03) — when the words came from a
phone `say`, the event carries that say's `id` (the same string you sent, cut to
100 characters — exactly what its `ack`s carry):
```json
{ "type": "event", "seq": 44, "projectId": "<id>", "kind": "owner", "text": "今どうなってる?", "id": "<your say id>" }
```
Match the echo to your say BY `id`, never by comparing the words (the desk drops
`!` `/` `#` and folds newlines, so the text can differ from what you sent). Both
the president's desk and the assistant (`projectId: "assistant"`) do this. A
resend after a reconnect carries the same `id`. Older apps that ignore `id` keep
working.

No `id` on an `owner` event = any of:
- words typed at the Mac;
- a say from before the Mac's OPEN GROUND last restarted (it remembers the last
  20 says, in memory only);
- a say whose final ack was `delivered` with `heard: false` (the Mac found the
  box emptied — the owner may have sent it or cleared it; if it was sent after
  all, its echo comes without `id`);
- a say to a project you then switched away from (`select`, or a say to another
  project) before its echo was read;
- a say whose echo had not been read when work mode went on at the Mac (nothing
  said in work mode is sent, and afterwards the Mac reads from the end).

So when no echo carries your say's `id`, rely on its final `ack` (`delivered`)
as the proof it reached the Mac — never wait for an echo.

`seq` is strictly increasing per pairing; remember the last one and reconnect
with `?after=`. The relay keeps the last 200 events, none longer than 7 days
(and none you said you `heard`): if the first event after a
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
`reason`: `stale` (v2: the say's `ts` is more than 5 min from the Mac's clock —
check the phone's clock, then say it again with a new `id`), `empty`, `too-long` (+`max`: over 473 characters after newlines are
folded — longer would wedge the desk; ask the owner to say it in parts),
`no-project`, `mac-error` (v2: the Mac could not save that it accepted the say — say it again with a new `id`), `forbidden` (the Mac is not signed in as the owner), `desk-failed`
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

On a v2 pairing `say` / `select` / `projects` are sealed, and inside the seal
each also carries `id` + `ts`; a `say` MUST carry `projectId` (see **Sealed
frames** — "goes to the selected project" below is v1 only).

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
- `assistant-history` — fetch the assistant's records from the Mac (v2 only, see
  "What the assistant remembers").
- `push-token` — only after a `hello` with `"pushToken": true`. The Push to Talk
  ephemeral token (hex), which APNs host it belongs to (`env`: `development` for
  a debug build, `production` for TestFlight / App Store) and the `apns-topic`
  (bundle id + `.voip-ptt`). `token: null` = forget it. Anything else
  (non-hex token, other `env`, a topic not ending in `.voip-ptt`) is refused
  with `bad-frame`. No reply on success. With the Mac offline the relay holds the
  newest one and hands it to the Mac when it is back (no `mac-offline`).

Frames over 16,384 characters or of any other `type` are refused (`bad-frame`), never
forwarded to the Mac.

## Call records (2026-10-04)

Delivery: Mac release 0.11.171 was published and installed on 2026-10-04.
The relay's `call-note` forwarding deployment is
`2f298447-cde5-4e29-b061-1e588cfee38e`; room creation remains app-key gated.
The installed Mac remained paired, online and sealed. The physical iPhone
end-of-call shared-record acceptance remains pending; credential and packaged
runtime checks do not stand in for it. See `RELEASE_REPORT.md` for delivery
and verification evidence.

The Mac advertises `callNote: true` inside its **sealed `projects`** frame.
Do not trust a capability in the relay's plain `hello`: the relay cannot
promise that the connected Mac can save a record. A phone paired to an older
Mac keeps a pending record until this capability arrives.

At the end of a hands-free call, send a sealed phone frame:

```json
{ "type": "call-note", "id": "<stable uuid>", "ts": 1790000000000, "endedAt": 1789999990000, "projectId": "assistant", "seconds": 102 }
```

`projectId` is `assistant` or a registered project's id (the call participant,
not whatever project happened to be selected when reconnecting). `seconds` is
an integer from 0 through 86,400. `endedAt` is the original end time in ms;
`ts` is a fresh authentication timestamp on every retry, subject to the same
five-minute window as other sealed phone frames. `endedAt` must be a safe
integer, no more than five minutes in the future or 365 days in the past.
Omitting it uses the Mac's current time. The phone durably queues the stable
`id`, participant, duration and end time until the Mac confirms it.

The Mac sends a sealed `ack` with that `id`, `projectId` and `state: delivered`
**after the metadata was written**, plus `entry` (the saved record). A retry of
the same id and duration/participant/end time returns the original receipt without
appending again, including after restarting the Mac. No assistant/model turn
runs and no words are typed into a president's desk. Invalid metadata is
`rejected` with `bad-note`, an unregistered participant with `no-project`, and
a failed write (or a reused id with different duration/participant/end time) with
`mac-error`. The existing owner, work-mode, sealed-direction and timestamp
gates apply. A plaintext v1 pairing cannot save a call record.

Records share the Mac's existing log retention rules. Clearing or deleting
assistant conversation affects only assistant entries, preserving president
records from other projects. A president's notes are scoped by registry id. An entry has
`kind: "call"`, `seconds`, `projectId`, `who: "owner"`, `via: "phone"` and
localized `text` such as `Call 1:42` / `通話 1:42`; its `at` is `endedAt`.
These metadata entries are excluded from model history and memory folding.
Assistant owner lines from a phone `say` also carry optional `clientId` (the
original say id) in Mac history. Reconcile pending lines by this identity, never
by matching their text: two identical utterances are separate owner turns.
Legacy lines without `clientId` cannot identify a pending phone say.
The assistant's Mac conversation shows its own notes. A president's terminal
shows its project-scoped call metadata beside the real transcript; OPEN
GROUND owns that adjunct record and never edits Claude's own JSONL.

Fetch through sealed `assistant-history` with optional `projectId`. Absent or
`assistant` returns assistant conversation and assistant call notes only;
a registered president id returns its call notes only, without assistant talk,
memo or style. The response names `projectId`, and normal history paging
applies. On the Mac, `/api/phone-link/call-notes?path=<registered project>`
reads that president's notes under the same owner/loopback and project-path
gates as other local app data; `DELETE` on the same URL clears that
president's notes only (assistant talk and other projects' notes stay), under
the same gates. The president seat clears them with a two-press trash button.
It renders each note from `seconds` in the CURRENT language (`Call 1:42` /
`通話 1:42`; the stored `text` is used only when `seconds` is missing) and
stamps notes from another day with month/day as well as the time. Call records stay on the Mac: the relay forwards
sealed requests/acks/history and stores no new call data.

## Sealed frames (v2, 2026-10-03)

Owner decision 2026-10-03: the relay (Cloudflare) must not be able to read what
passes, nor slip in words of its own. So the phone and the Mac seal every frame
that carries words with the pairing's `e2e` key; the relay only routes and stores
ciphertext. Free: nothing changes on the relay (it was already type-agnostic —
no redeploy), and the crypto is the OS's own (CryptoKit / Node `crypto`).

**Cipher.** AES-256-GCM, key = the 32 bytes of `e2e`, a fresh random 12-byte
nonce per frame, 16-byte tag. Additional authenticated data (AAD) = the UTF-8
bytes of
- `og-phone-link/v2 p2m` — phone → Mac,
- `og-phone-link/v2 m2p` — Mac → phone.

The direction in the AAD means a frame the Mac sent never opens as one from the
phone (the relay cannot bounce the Mac's words back at it), and vice versa.

**`box`** = **standard** base64 (with `=` padding — what `Data(base64Encoded:)`
reads; not base64url) of `nonce(12) ‖ ciphertext ‖ tag(16)` — exactly CryptoKit's
`AES.GCM.SealedBox.combined` ("nonce, ciphertext, then tag", available with the
default 12-byte nonce). The plaintext is the UTF-8 JSON of the inner frame.

```swift
import CryptoKit
// `e2e` in the code is base64url WITHOUT padding: Data(base64Encoded:) alone returns nil.
func dataFromBase64URL(_ s: String) -> Data? {
  var b = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
  b += String(repeating: "=", count: (4 - b.count % 4) % 4)
  return Data(base64Encoded: b)
}
let key = SymmetricKey(data: dataFromBase64URL(code.e2e)!)    // 32 bytes
func aad(_ dir: String) -> Data { Data("og-phone-link/v2 \(dir)".utf8) }
// send
let box = try AES.GCM.seal(json, using: key, authenticating: aad("p2m")).combined!.base64EncodedString()
// receive
let sealed = try AES.GCM.SealedBox(combined: Data(base64Encoded: box)!)
let json = try AES.GCM.open(sealed, using: key, authenticating: aad("m2p"))  // throws = drop the frame
```

**Outside of the seal** (what the relay sees):

| Direction | Frame on the wire |
|---|---|
| phone → | `{ "type": "say", "id": "<same id as inside>", "box": "…" }` — the outer `id` is only for the relay's `mac-offline` error; the Mac uses the inner one |
| phone → | `{ "type": "select", "box": "…" }`, `{ "type": "projects", "box": "…" }` |
| → phone | `{ "type": "event", "seq": 43, "at": <relay ms>, "box": "…" }` — `seq` (for `?after=`) and `at` are the relay's; the event's own `at`, `projectId`, `kind`, `text`, `id`, `eid`, `sent` are inside |
| → phone | `{ "type": "ack", "box": "…" }`, `{ "type": "projects", "box": "…" }` (also as `hello.projects`) |
| phone → | `{ "type": "assistant-history", "box": "…" }` (inner: `id`, `ts` as for every phone frame, optional `before`) |
| → phone | `{ "type": "assistant", "box": "…" }`, `{ "type": "assistant-history", "box": "…" }` — passed on, never stored by the relay, no `seq` (see "What the assistant remembers") |

Plain (no words in them, the relay must read them): `hello`, `mac`, `error`,
`push-token` (the relay holds it while the Mac is away; a push carries nothing
readable), `ping`/`pong`, and the Mac's `resume` / `push-ready` / `reset`.
The Mac → relay event also carries its transcript position `cur` outside
(`{ f, o, i }`: file, byte offset, index in line — needed for the relay's resend
dedupe). On v2 `f` is a keyed tag (HMAC-SHA256 under a tag key derived from
`e2e` with HKDF-SHA256 — empty salt, info `og-phone-link/v2 tag`, 32 bytes — so
the AES-GCM key is never used as an HMAC key too), not the project id and session
file name it stands for; the relay never hands `cur` to the phone. Only the Mac
computes these tags (also `eid`); the phone never needs the tag key.
What the relay does see: the offsets, so roughly how much was said.

**Inside the seal, phone → Mac**: EVERY frame carries a fresh `id` (unique per
frame, 1–100 characters — a UUID string is fine; never re-used) and `ts` = the
phone's clock in ms (`Int64(Date().timeIntervalSince1970 * 1000)`). A `say`
MUST name its project (on v2 `projectId` is required — the one the owner is
looking at, `"assistant"` for the assistant):
```json
{ "type": "say", "id": "<uuid>", "ts": 1790000000000, "text": "今どうなってる?", "projectId": "<id>" }
{ "type": "select", "id": "<uuid>", "ts": 1790000000000, "projectId": "<id>" }
{ "type": "projects", "id": "<uuid>", "ts": 1790000000000 }
```
The Mac drops (silently, no reply — it cannot know who sent it):
a frame that does not open (forged, altered, another key, the wrong direction), one that opens but is not a `say` / `select` / `projects` / `assistant-history` / `call-note`,
plain JSON in place of `box`, a frame without an `id`, and a frame whose `id`
it has already accepted (kept for 5 min, across a Mac restart: the first one was
answered). A frame whose `ts` is more than **5 min** from the Mac's clock is
refused: a `say` gets `ack rejected` `reason: "stale"`, a `select` / `projects`
is dropped. A `say` without `projectId` gets `ack rejected` `reason: "no-project"`
(otherwise a `select` the relay withheld could send the owner's words to the
wrong president). A frame the Mac could not record as accepted (its disk write
failed) is not acted on: a `say` gets `ack rejected` `reason: "mac-error"` (send
it again as a new say), a `select` / `projects` is dropped. A say the owner
repeats is a NEW say (new `id`, new `ts`).

**Inside the seal, Mac → phone**: exactly the `event` (without `seq`), `ack` and
`projects` JSON of "Frames the phone receives", plus:
- `sent` on every frame — strictly increasing within one run of the Mac's OPEN
  GROUND (the Mac's clock in ms, bumped by 1 when two frames share a ms); after
  the Mac restarts it starts again from its clock, which can be LOWER than the
  last `sent` you saw. So reset your highest `sent` on every new connection
  (`hello`), and compare only within one connection;
- `eid` on every `event` and `assistant` frame — that frame's own mark (a short base64url string). It
  is NOT the `id`: an `owner` echo of a phone `say` keeps carrying that say's `id`
  (see "`id` on an `owner` event"). A Mac resend of the same transcript line
  carries the same `eid`.

The phone:
- drops a frame that does not open, and on v2 any `event` / `ack` / `projects` /
  `assistant` / `assistant-history` (also `hello.projects`) without a `box`;
- skips an `event` or `assistant` frame whose `eid` it already read (the relay can re-send a stored
  event under a new `seq`; `?after=` catch-up re-sends ones you have too);
- keeps the `projects` with the highest `sent` (since this connection) and drops an older one (the relay
  can play an old list again, also as `hello.projects`); its OWN choice of
  project is what counts — every `say` names it in `projectId`, never "whatever
  `selected` says";
- ignores an `ack` for an `id` that already had its final ack (`delivered` /
  `rejected`) — e.g. a `stale` provoked by the relay playing an old say again.

**What this does not cover.** The relay can still see who talks when and how
long a frame is, drop or delay frames, and re-send a Mac → phone frame it stored
(the rules above make that harmless). It cannot read or write words. The room
keys (`X-OG-Token`) are unchanged and still gate the room. `push-token` stays
plain: a relay could point the wake push elsewhere or drop it — the push carries
nothing readable.

**Test vectors** (the Mac's unit test checks it seals exactly these:
`src/lib/server/phoneLinkSealed.test.ts`):
- `e2e` = bytes `00 01 … 1f` = `AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8`
- nonces are fixed only for the vectors — in use always fresh and random (a
  nonce must never be used twice under one key)
- phone → Mac, plaintext `{"type":"say","id":"vec-1","ts":1790000000000,"text":"今どうなってる?"}`
  (a byte-exact vector, not a full say — a real one also carries `projectId`),
  nonce = bytes `a0 a1 … ab`, AAD `og-phone-link/v2 p2m`, box:
  `oKGio6SlpqeoqaqrnToIVDWuIIVAFuaqJVbitxSOYzLk0iFBrSwKpAvYVzvjQX7PnxJjDW+sNPg5VqGNImMyaljy/sXLvYr3R/EDUzUWZu6TRmVGF2B0J62zcTsid6CGROXtZM/4Z0XKQw==`
- Mac → phone, plaintext `{"type":"event","projectId":"p1","kind":"president","text":"了解しました","at":1790000000123}`
  (a real event also carries `eid` and `sent`),
  nonce = bytes `b0 b1 … bb`, AAD `og-phone-link/v2 m2p`, box:
  `sLGys7S1tre4ubq74ncu0pyomWVlneHHoymq7qZMO71/S+xBF6qgy37ywzQpaUhTDbqEgocr0i9P0ObQQxk16zlPJ4g5qFYS4CGmFxVL3TWdX+dk+l01vR+ZwB1k8b2QkklC5MXLSKAbaT+OUZMD39ZHqORZKUS8RDFOsuy7pg==`
- Opening either with the other direction's AAD must fail. Both were opened by
  CryptoKit (`AES.GCM.open`, Swift 6.4 on macOS 27, 2026-10-03), and a box CryptoKit
  sealed opens on the Mac (in the same test).

**Moving from v1** (company decision). Pairing always makes v2 from now on. A v1
(plaintext) pairing keeps working as before so the phone is not cut off before
its app update — until **2026-11-30 (UTC)**; from then the Mac no longer dials
with it. Settings → iPhone shows 「暗号化されていません。iPhone のアプリを更新してから、解除してつなぎ直してください」
on a v1 pairing. A v2 pairing accepts nothing plain: a `say` without `box` is
dropped. Re-pairing (once, after both the Mac and the iPhone app are updated)
erases the old room — with the plaintext it held — as unlinking always did.

## The assistant (talk partner across all projects, 2026-10-02)

Owner request, 2026-10-02: one partner who looks across EVERY project, answers
short, and — when asked — proposes a work card for a project's Board (put there
only by the owner's button since 2026-10-06, see "Assistant proposals"). Its talk stays
on the phone: it never reaches a president desk, the president's chat, the
Board's notes or any screen on the Mac. Only the card it writes appears (on that
project's Board, as an ordinary `todo` card).

On the Mac the same partner lives in the floating window, with the phone app's
two modes since 2026-10-06 — chat (its mic only types by voice) and call
(speaker / mute / end, the same states as `CallView.swift`). That is Mac-local:
nothing on the wire changes. Spec: docs/ASSISTANT_DESIGN.md §1.

**On the wire** — the same frames, with `projectId: "assistant"`:
- `projects` always lists it FIRST: `{ "id": "assistant", "name": "アシスタント", "look": "verm", "desk": false, "assistant": true }`
  (`desk` means nothing for it — always `false`, so an app that picks the first
  live desk never lands on it)
  (`name` is the name the owner gave it on the Mac — the floating assistant,
  2026-10-03 — and until then follows the Mac's language: `Assistant` in English;
  `look` is its colour, `verm` | `moss` | `ochre` | `ink` — draw the character per
  docs/ASSISTANT_DESIGN.md. A renamed assistant reaches the phone with the next
  periodic `projects`, or at once on `projects` / the history page). It is never
  `selected`; `select` with it changes nothing (answered with `projects`).
- `say` with `"projectId": "assistant"` goes to it (the selection does not
  change). Up to **2000** characters (`text.utf16.count`), newlines kept — it is
  not typed into a desk, so the 473 limit and the dropped `!` `/` `#` do not
  apply. `empty` / `too-long` (+`max: 2000`) as for a desk.
- Then: `ack queued` at once and an `event` `kind: "owner"` with the words and your `id`; the
  answer comes as `ack delivered` (`heard: true`) followed by ONE `event` with
  `kind: "assistant"` — read its `speak` aloud when it has one (the answer's first
  paragraph, at most two sentences — since 2026-10-06 `text` can carry details
  after it that are for reading, not hearing; an app that predates `speak` reads
  `text`). A line that put up proposals has the app's own line as `speak`; the
  proposals themselves come apart, as `assistant-proposals` (see "Assistant
  proposals"). Or `ack rejected` `reason:
  "assistant-failed"` (+`detail`: one short plain sentence in the Mac's language,
  e.g. 「アシスタントが時間内に答えられませんでした。」 / "The assistant did not answer
  in time." — never an internal error) when it could not answer (Claude not
  signed in, no answer in 2 min, work mode switched on meanwhile). Since
  2026-10-06 one Claude session stays up between lines: small talk answers in
  about 1 s, a look-up in a few seconds (a fresh session after 15 quiet minutes
  adds its start-up once); lines wait their turn, one at a time. The short
  "let me look" it says before a look-up goes to the Mac's window only (the
  phone gets the answer) — a phone-side follow-up. With one line being answered and one waiting, a further
  line gets ONLY `ack rejected` `reason: "busy"` (no `queued`, no `owner` event,
  no `detail`) — say it again later.
- Its events come **whatever project is selected**. Show them in the
  assistant's conversation, not the president's (tell them apart by
  `projectId`). They are replayed with `?after=` like any other event, but a
  Mac connection that dies silently can lose one (they carry no transcript
  position) — the missing `ack delivered` / `event` then shows it; offer to ask again
  (asking again makes no card: only a button does). When the
  Mac's socket to the relay is closed at the moment an answer is ready, the Mac
  keeps it (the newest 20 frames) and sends it, in order, once the socket is
  back — always before anything newer, so an older answer never follows a newer
  one. Work mode drops what was kept: it is never sent, not even after work mode
  is switched off (as for the president's words).
- The push rules are the president's: one push when the answer went out, none
  while a line waits for its answer — for at most 2 min, as for a desk.

**What it does** (`src/lib/server/phoneAssistant.ts`, owner request 2026-10-06:
"全部調べられるアシスタントと喋るだけで全ての作業を終わらせたい", "人と会話してるぐらいの速さで"):
- **One live session, a fast model** (`assistantSession.ts`). The talk is ONE
  Claude Code session on the owner's subscription (no API key), driven through
  the Agent SDK with streaming input, on `haiku`, thinking off. It stays up
  between lines, so a line costs one model reply instead of a claude start-up;
  the floating window warms it when it opens (`POST …/assistant/warm`). It
  restarts after 15 quiet minutes, 40 lines, ~120k tokens of context, a failed
  line, or when what it was started with changes (the style, its name, the
  memo size, the language, or a delete of the log / memo). The system prompt —
  style, where things live, a status snapshot, the memo and the talk not yet
  folded into it — is built only at a (re)start; the owner's lines go in as
  messages `[YYYY-MM-DD Tue HH:MM] words` (the weekday too — given the date alone it named the wrong day). No transcript is written
  (`persistSession: false`) and `~/.claude/history.jsonl` gets nothing
  (checked by `scripts/verify-assistant-live.mts`).
- **What it can touch** — none of Claude Code's own tools (`tools: []`: no
  Read, Bash, Write, Edit, web), no settings / hooks / MCP from disk
  (`settingSources: []`, `strictMcpConfig`), `permissionMode: dontAsk`, and a
  PreToolUse gate that allows only its own tools (`mcp__og__*`, in process) and
  denies anything else — also when the gate itself errors. Guard:
  `assistantSession.test.ts`. Its tools (`assistantTools.ts`):
  - `read_file` / `list_dir` / `search` — READ ONLY, and only inside the
    registered projects and OPEN GROUND's data (`~/.openground`), decided on the
    real path (a symlink cannot lead out; search never follows one). Everything
    else in the home (`~/.ssh`, other folders) is refused, and a registered
    project at or above the home folder is not read at all (it would open the
    whole home). `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`,
    `~/.config/gh`, `~/Library/Keychains`, Claude's credentials … are refused
    even inside a root. Inside the area the secrets are refused too (names
    compared case-insensitively, as APFS does): OPEN GROUND's `auth.json`,
    `research-auth.json`, `phone-link.json`, `phone-push-key.json`,
    `chrome-profile/`, `backups/settings/`, and anywhere `.env*` (not
    `.env.example`), `.envrc`, `.dev.vars`, private keys / certificates
    (`id_*`, `*deploy_key*`, `.pem` `.key` `.p8` …), `*.tfstate`, `.netrc` /
    `.npmrc` / `.git-credentials`, `credentials*`. Values under secret-looking
    keys (password, token, secret, api key, `*_KEY`, cookie…) and the password in
    a `user:password@` URL show as `[hidden]` — hidden before line numbers go
    on, and search matches the hidden text (a match on a secret would tell it a
    guess at a time). Search takes words literally (`a|b` = either; no regular
    expressions, which could freeze the server), skips `node_modules`, `.git`,
    build output and worktree copies; a read looks at most 200 KB into a file,
    hands back at most 40 KB of it (one long line — a card's notes are one line
    of `tasks.json` — is read whole up to that) and never reads a pipe or device.
    The search `glob` (`*` / `?`) is matched by a plain two-pointer wildcard
    match, never a regular expression (as one, `*a*a*a*a*a*a*a*b` took 18 s on a
    64-character name). Well-known token shapes (`sk-ant-…`, `ghp_…`, `AKIA…`,
    `xoxb-…`, `sk_live_…`, `AIza…`, `glpat-…`; JWTs found by a scan without a
    backtracking regex — as one, 512 KB of `eyJ-` took 0.7 s), a value of 8+
    token characters after `Basic` / `Bearer` unless it is one all-lowercase word
    (「basic configuration」 stays, `Basic dXNlcjpwYXNz` is hidden),
    `Authorization` / `extraheader` values, `…KeyValue` / `…KeyPem`
    names, PGP private-key blocks and `const API_KEY = …` lines are hidden too.
    A photo over 1 MB goes as a JPEG of at most 2000 px
    (macOS `sips`; the session resends it with every later line and one request
    is at most 32 MB). Not covered: a hard link to a secret under another name.
    Guard: `assistantTools.test.ts`.
  - `status` — every project's state at that moment (the digest below), so
    「状況どう?」 is never answered from the snapshot the session started with.
  - `make_card` / `tell_commander` only **PROPOSE**, and `withdraw` drops what
    waits (「やめて」). There is no `remember` tool. See "Assistant proposals"
    below: a proposal is shown in its own frame and carried out ONLY by the
    owner's button on it — nothing said or typed to the assistant carries one
    out, 「うん」 included (owner decision 2026-10-06, the parked voice-yes design
    was reworked 4 times and dropped). A line made while proposals wait tells the
    model so (an "App note"), and it answers a spoken yes with 「画面のボタンで決めてね」.
  What was done is said by the app, never taken from the model's words: after a
  line that put up proposals, `speak` is the app's fixed line (「カード案を出したよ。
  よければ「出す」を押してね。」); after a button, the app's own outcome line goes into
  the talk (「kiwiに「…」を積んだよ。」 / 「…の司令官に伝えたよ。」) and the model is
  told before the owner's next line. The model's own words are kept as text.
  It never changes code or files itself, and never dispatches, moves, merges or
  answers anything on the owner's behalf. Text from files, cards and workers is
  data to it — and since a line in a file could still steer it, nothing it
  proposes happens without the owner pressing the button on what the frame shows.
  Deleting talk (Settings → iPhone) ends the live session at once and drops the
  proposals waiting; the line running then is not written back to the log and
  not retried.
- **Like talking on the phone.** Small talk is answered at once without tools.
  When a look-up starts (`read_file` / `list_dir` / `search` / `status`), the
  APP says a short wait-line — 「ちょっと待ってね。」「見てみるね。」「調べてみるね。」
  in turn (English: One moment. / Let me check. / Let me look.) — the moment the
  first look-up of the line starts, once per line; the model never writes one
  (haiku wrote them into answers it gave without looking, and once said 「カード
  作ったよ」 before making it). The window's `POST …/assistant/say` with
  `stream: true` answers one JSON per line: `{interim}` then the answer —
  and, on a line that calls no tool, `{say}` pieces before it (2026-10-07,
  below). Only
  the answer's first paragraph, at most two sentences, no paths or markup, is
  read aloud (`speak`, `spokenPart`); the details follow as text in the window,
  and the answer waits for the wait-line to finish (`speakAfter`) instead of
  cutting it. Lines carry the weekday (given the date alone it named the wrong day).
  Measured 2026-10-06 on the shipped app's Electron runtime (0.11.173's binary
  running this build's server, `ELECTRON_RUN_AS_NODE`, docs/VERIFICATION.md
  §4.1), sending to the answer:

  | line | before (0.11.173) | after |
  |---|---|---|
  | やあ、元気? | 6.1 s | 1.0 s (0.6–1.1 s over three runs) |
  | アシスタントの記録ってどこにある? | 5.3 s — "it is not in what I have" | 2.5 / 2.7 s, answered (spoken: 「アシスタント用のフォルダ内だね。」, the path as text) |
  | OPEN GROUND の今のバージョンっていくつ? (a look-up) | — | 「ちょっと待ってね。」 at 1.7 s, 「0.11.173 だね。」 at 3.7 s |
  | 今日は何曜日だっけ? | — | 0.7 s |

  Time to the first word as heard adds the same speech recognition and system
  voice start-up before and after. (`node scripts/measure-assistant-latency.mjs
  [baseUrl] "line" …`.)
- **Read as it is written; stop to listen (2026-10-07, the redesign's 2nd
  release).** The session asks the SDK for the words as they are written
  (`includePartialMessages`); `spokenSoFar` sends a `{say}` piece for each
  sentence of the read-aloud part once more words follow it, and the answer
  then carries `said: true` (the pieces joined = `speak`; the window does not
  read it again). A tool call stops the pieces for the rest of the line
  (`{hush}` if some already went out); such a line reads its finished answer
  as before. The known edge (adversarial review 2026-10-07): a sentence goes
  out once more words follow it, so a model that writes TWO sentences or more
  before a tool call — against its prompt — has the first read before the call
  is known. Contained, not closed: the pieces are hushed the moment the call
  starts, and after a proposal what is read is the app's own line; the only
  other way to close it is to read nothing until the answer is complete. The call's stop key / Space cuts the reading; the window then
  posts `POST …/assistant/hush {heard}` and the model's next line carries an
  app note with what was heard — accepted only when `heard` is how the last
  answer's read-aloud part begins (409 otherwise), so it can only shorten what
  the model believes was said. The ears end an utterance by how the words end
  (og-listen `pauseFor`, `og-listen --pause <words>`) and hand the heard words
  on at once. The phone still gets the whole answer in one frame, and the
  iPhone app's own pause (`Endpoint.quiet`, 1.2 s) is the phone app's to change.
  Measured 2026-10-07 on this Mac, the shipped app's runtime (0.11.174's
  Electron as Node running the base and this build's server, throwaway homes,
  the same lines alternating; the ears fed a Kyoko recording at real time with
  `og-listen --feed` — this Mac's speakers go to an audio interface its mic
  cannot hear, -47 dB, so no acoustic loop):

  | part | before | after |
  |---|---|---|
  | end of speech → words handed on (`scripts/measure-voice-latency.mjs`) | 1.60–1.83 s | 0.84–1.37 s |
  | words sent → first thing that can be read (median of 3) | 0.67–1.07 s | 0.70–0.83 s |
  | 今日の予定を教えてください (sum) | 1.60 + 0.90 = 2.5 s | 0.84 + 0.72 = 1.6 s |
  | やあ、元気? (sum) | 1.83 + 0.67 = 2.5 s | 1.37 + 0.70 = 2.1 s |

  The system voice's own start (AVSpeechSynthesizer, what Chromium's
  speechSynthesis calls on macOS) is the same before and after and not in the sums.
- **Folding the memo is a separate run**, never on a line's clock: after a line
  that left talk due for folding, and hourly, `foldIdleAssistantTalk` runs the
  old file-handoff runner (a hidden PTY, `--tools Write --restricted
  --permission-mode acceptEdits`, `ASSISTANT_LAUNCH`, sonnet) in its own queue.
  Its prompt carries only the talk and the memo, as the system prompt; the typed
  prompt is the fixed `ASSISTANT_KICKOFF` (nothing of the talk in
  `~/.claude/history.jsonl`), and the completion-marker defences below apply to
  it. It is given the OWNER's lines only — never the assistant's words, a file it
  read or a worker's text (owner decision 2026-10-06: the memo is written from
  the owner's own words). A memo changed while it ran is not overwritten. Guard:
  `phoneAssistantLaunch.test.ts`.
- Before 2026-10-06 every line started its own claude in a hidden PTY with
  only Write and the status in its prompt (5–40 s a line, nothing to look
  things up with); the fold run below is what remains of that runner.
- Completion marker (fold runs): whether the prompt holds the runner's
  completion marker is decided by the runner's OWN detector (`containsDoneMarker`),
  never by a pattern of ours, and on the prompt AS CLAUDE'S SCREEN SHOWS IT: the
  TUI drops every invisible format character and the C1 control characters
  U+0080–009F, so those are removed before the check. When it fires, the run is
  built again with every `_` in ALL of its data as a full-width `＿` — the
  marker needs two ASCII `_` and the template has none — and a prompt the
  detector still fires on is never started.
- How it talks is the owner's free text: Settings → **iPhone** →
  「アシスタントの話し方」, stored as `~/.openground/assistant-style.md`
  (editable by hand too; empty = the default below). Read fresh on every line,
  so a change applies to the next answer. Default (owner decision 2026-10-02):
  friend's tone, conclusion first, 1–2 sentences, stuck things / questions
  waiting for the owner before progress.
- Owner only and work mode as for the rest of the link: under work mode it is
  never asked.

## Assistant proposals (2026-10-06)

Owner decision, 2026-10-06 (「全部Aで進めて」, docs/research/voice-assistant-2026-10.md):
the assistant only PROPOSES a card or a message for a commander; the owner's
**button** on the proposal's frame is the only way one is carried out —
「出す」 for a card, 「送る」 for a message, 「やめる」 to drop it. Nothing anyone says or
types does (「うん」「出して」 included), on the Mac or the iPhone. The Mac and the
iPhone use the same one door (`approveProposal` in `src/lib/server/assistantProposals.ts`).

**A proposal** (kept in the Mac's memory only — never on a Board, never in the talk log):
```json
{ "id": "…", "kind": "card" | "commander", "projectId": "…", "project": "kiwi-shop",
  "title": "送料を500円にする", "body": "やること: 送料を500円にする\n完了の条件:\n- テストが緑",
  "at": 1790846484310, "expiresAt": 1790847084310, "state": "open" | "done" | "dropped" | "expired",
  "closedAt": 1790846501234, "via": "phone" | "screen" }
```
- `project` is the project's name, `title` the card's title (`""` for a
  message), `body` the card's notes **exactly as they will be written**, or the
  line **exactly as the commander will get it** (prefixed 「アシスタント経由(オーナーの
  言葉の要約):」 — the model wrote it, so it is never labelled as the owner's own
  words). Show all three whole, as plain text (`body` has `\n`s), never cut,
  shortened or scrolled — a frame that does not fit whole must not be
  pressable (the Mac says 「長いので社長に頼んでね」 instead).
- Small on purpose: at most **10 lines as the Mac's window draws them**
  (project, title and body together; a line holds 21 full-width characters —
  `frameLines`, counted on the wide side) and 400 characters, so a frame is seen
  whole in the window's call view (262 px left for frames) as in chat (356 px) —
  measured in Chromium on the real CSS, 2026-10-06. Title, goal and every done
  condition one line; at most 3 open at once. While one waits, the Mac's call
  view leaves out its big character so the frame gets the room. A proposal holding any character
  that can be neither seen nor heard (zero-width, direction, BOM, Unicode TAG,
  variation selectors, controls) is refused when it is made.
- Open for 10 minutes (`expiresAt`); then `expired` — draw it faded, without
  buttons, as for `done` / `dropped`. A closed one stays listed (faded) for 30
  minutes after it was made. `closedAt` = when it closed (absent while open;
  `expiresAt` for an expired one). The list is in the order made, so pick "the
  one that closed last" by `closedAt` — the Mac shows only that one, as a single
  faded line (a `done` one with the green check), and gives the talk the room.
- The Mac's floating window shows every proposal; the iPhone gets the ones made
  from the iPhone (`via: "phone"`). Whichever button is pressed first wins; the
  other end then sees it closed.

**The check (`hash`)** — the phone computes it FROM THE TEXT ITS FRAME SHOWS and
sends it with 「出す」/「送る」: SHA-256, lowercase hex, of the UTF-8 of
`kind + "\n" + projectId + "\n" + project + "\n" + title + "\n" + body`.
Use the strings **exactly as received** — no Unicode normalization (NFC/NFKC),
no trimming, no line-ending changes (Swift: `Data(s.utf8)` of the joined
`String`, never a normalized form) — and draw exactly those strings.
A press whose hash does not match what the Mac holds does nothing (`mismatch`).
Test vector: kind `card`, projectId `8f0c2b1e-0000-4000-8000-000000000001`,
project `kiwi-shop`, title `送料を500円にする`, body
`やること: 送料を500円にする\n完了の条件:\n- テストが緑` →
`55ae649371d4e0c8d07e3698f42b328d226d12f2628642ed9061cfd4d1b8c444`.

**Frames (v2 pairings only; both sealed like every content frame):**
- Mac → phone `{ "type": "assistant-proposals", "proposals": [ … ] }` — the whole
  list of the phone's proposals, sent whenever it changes (made, pressed on
  either end, dropped). Not kept anywhere: the first page of `assistant-history`
  also carries `proposals`, so a phone that was offline catches up there.
- phone → Mac `{ "type": "assistant-proposal", "id": "<frame id>", "proposalId": "…", "action": "approve", "hash": "…" }`
  or `"action": "drop"` (no hash). Answered with `ack` (`projectId: "assistant"`):
  `delivered` (`card: { projectId, taskId, title }` when a card was written), or
  `rejected` with `reason`: `mismatch` | `closed` | `expired` | `not-found` |
  `pair-again` (v1) | `bad-frame` | `mac-error`. After a carried-out press the Mac
  also sends ONE `assistant` line with the app's own words in `text` and
  `speak` (「kiwi-shopに「…」を積んだよ。」 / 「…の司令官に伝えたよ。」 / 「…まだ届いてない。
  少ししてからもう一回押して。」 — a message the commander did not take stays open).
- After a `say` that put up proposals, the answer's `speak` is the app's line
  (「カード案を出したよ。よければ「出す」を押してね。」); read `speak` aloud, never `text`
  whole.
- **Relay redeploy needed** for both frame types (its frame-type allowlist):
  `cd worker && npx wrangler deploy -c wrangler.phone.jsonc` — before the iPhone
  build that uses them ships. Until then the old relay answers the phone's
  `assistant-proposal` with `bad-frame` and drops `assistant-proposals`; the
  proposals still show (and can be pressed) in the Mac's window.

**On the Mac** — the floating window's frames (`ProposalFrames.tsx`) sit right
above the input (in a call, above its keys), outside the talk. 「出す」/「送る」 send
`POST /api/phone-link/assistant/proposals/:id/approve {hash}`, with the hash
computed from the frame elements' own text (`textContent`); 「やめる」 sends
`…/drop`. `GET …/assistant/proposals` (and `GET …/assistant/log` →
`proposals`) list them. A frame not whole inside its box — or a box whose height
cannot be measured — cannot be pressed. Guards: `assistantProposals.test.ts`,
`phoneAssistant.test.ts`, `phoneLink.test.ts`, `FloatingAssistant.test.tsx`
(each measured red with the production check removed, 2026-10-06).
Checked on the shipped app's runtime (0.11.174's Electron running this build's
server, isolated data, real claude; `node scripts/verify-assistant-proposals.mjs
<baseUrl> <project> "<request>"`): a card request put up its frame in 2.8–2.9 s
with nothing on the Board; 「うん」 / 「うん、出して」 left the Board empty and the
proposal open; a press with a check one character off was refused (409); the
press with the shown text's check wrote ONE todo card with exactly the frame's
title and notes. Small talk answered in 0.64–1.1 s; a README look-up said
「ちょっと待ってね。」 at 2.2 s and answered at 3.2 s.

## What the assistant remembers (2026-10-03)

Owner decision, 2026-10-03: "delete the talk after some days, but remember roughly
what we talked about — inherited like compacting, at a fixed size", kept as text
on the Mac (no database, not on Cloudflare). The Mac, the iPhone and the OPEN
GROUND screen talk to the SAME assistant and land in the SAME record — and the
record lives on the Mac only.

**On the Mac** (`src/lib/server/assistantMemory.ts`), `~/.openground/assistant/`
(folder 0700, files 0600):
- `log/YYYY-MM-DD.jsonl` — every line said (owner and assistant), one JSON per
  line: `{ "id", "at", "who": "owner"|"assistant", "text", "via": "phone"|"screen", "card"? }`.
  Kept **30 days** by default (Settings, 1–365): a line older than that is never
  read or sent again, and its day file is deleted once the whole UTC day is past
  — at boot, every hour, and whenever the log is read or the setting changes.
- `memory.md` — the ONE long-term memo, **at most 4000 characters** by default
  (Settings, 500–8000; characters as the owner counts them — an emoji is one).
  Never longer: the model is asked for 90% of the size, a memo it returns longer
  than the size set at that moment is thrown away whole (not cut — a cut drops
  its end, where the newly folded lines went; the memo stays as it was and the
  same lines are folded again next run), and a smaller size cuts the stored memo
  at once (Settings asks first: lowering either number deletes / cuts without
  folding). An EMPTY memo from the model is ignored too, unless it also says
  `"forgetAll": true` — offered only when the owner's line itself asks to forget
  something and the memo then comes out empty ("forget it" about the memo's only
  fact included), so a placeholder `""` or a fold turn never wipes the memory
  and a real "forget" always can. A fold-only run (nobody talking) gets no such
  flag and never empties a memo that holds something.
- `state.json` — the last log line already folded into the memo, and the last fold-only run (`idleTried`: its first line and time). `config.json` — the two numbers.

**What each answer reads** — the memo + the talk not yet folded into it, never
the whole log (since 2026-10-06: what a session starts with; the session then
carries the talk itself, and a fold run does the folding below in the background
— "the turn" / "next line" below = the fold run after a line). Once that unfolded talk passes 30 lines or 16,000 characters —
or a line of it is more than a day old (half the kept days if that is shorter),
so recent talk does not expire unfolded after a quiet spell —
the turn shows the older part as "leaving your view" and the model MUST return
the memo rewritten with what still matters (decisions, preferences, ongoing
threads, promises, what it was asked to remember; small talk and finished
things dropped); the newest 20 lines / 8000 characters stay verbatim. At most
16,000 characters are folded per turn, oldest first (only what was shown is
marked folded; the rest goes next turn), and a fold the model skips is asked
again after 12 hours (each try is a claude run). A memo the model returns in a wrong shape is ignored. While nobody talks, the Mac folds talk that is old
enough on its own (`foldIdleAssistantTalk`, at boot and every hour — ONE run per
tick — before the old days are deleted; a claude run only when there is something
to fold, never under work mode, primary instance only; a run that saved nothing —
claude failed, or the memo was left out / thrown away — is not repeated on the
same lines for 12 hours, kept in `state.json` so a restart does not reset it: a
stuck fold costs at most ~2 runs a day; a fold-only run never empties a memo that
holds something), so a silence longer than the kept days
does not delete talk unfolded — as long as the Mac is on and Claude is signed
in. If folding keeps failing (Claude signed out, the memo always coming back too
long), the lines still expire after the kept days, unfolded and without a notice. A line that got no answer is logged too (the owner's words only), so the
next answer sees it. So the prompt stays bounded (memo + at most
~30 lines) however long the owner keeps talking, and the memo stays one fixed size.
"覚えておいて" / "忘れて" — the owner's line goes into the memo at the next fold (the
fold reads the owner's lines only; there is no tool with which the live
assistant could write the memo — 2026-10-06). The log itself is only deleted by
age (or by the owner) — folding does not delete it.

**Seen and deleted by the owner** — Settings → **iPhone**, under 「アシスタントの話し方」:
the two numbers, the memo (delete), and the log newest first (delete one line /
delete all). Deleting a log line does not take back what the memo already took
from it — delete the memo, or say 「忘れて」. A delete made while a line is being
answered is not undone by that line (it does not write its memo back).

**The screen's API** (owner-only, loopback, like the rest of `/api/phone-link/*`):
`GET /api/phone-link/assistant/log` → `{ entries, memory, logDays, memoryChars }`;
`DELETE …/assistant/log` (all) and `…/assistant/log/<id>` (one); `DELETE …/assistant/memory`;
`POST …/assistant/config` `{ logDays?, memoryChars? }` (out of range → 400, nothing changed);
`POST …/assistant/say` `{ text, photo?, stream? }` → `{ reply, speak, card? }` (or, with `stream: true`, `{interim}` / `{say}` / `{hush}` lines first, then the answer with `said` when the pieces were its reading) — talk from the screen; `POST …/assistant/hush` `{ heard }` → `{ ok }` / 409 — the call's stop key: the model hears what of the last answer was heard; `POST …/assistant/warm` starts the session ahead of the first line,
same assistant, same log (`via: "screen"`). The screen's one line for it sits
above the talk log in Settings → iPhone (Enter or 送る; the answer shows in the
log). The phone sees screen talk in its next `assistant-history`.

### Fetching the records from the phone

The relay never keeps the assistant's records (`assistant-history` pages) and never sees them in plain text:
they cross only as **sealed frames of a v2 pairing** — the same seal as every
other content frame (see "Sealed frames"; no second cipher). The phone fetches
them from the Mac (inner frame, sealed `p2m` like a `say`):

```json
{ "type": "assistant-history", "id": "<uuid>", "ts": 1790000000000, "before": 1790846484310 }
```
`before` (optional) = the `at` of the oldest entry the phone already has; leave
it out for the newest page. The Mac answers (only while it is online; work mode =
no answer) with one sealed `assistant-history` frame whose inner JSON is
```json
{ "type": "assistant-history", "id": "<same>", "sent": 1790000000001,
  "entries": [ { "id", "at", "who", "text", "via", "card"? } ], "more": false,
  "memory": "…", "logDays": 30, "memoryChars": 4000, "name": "ノノ", "look": "verm" }
```
`entries` oldest first; `memory` / `logDays` / `memoryChars` / `name` / `look` only on the page
without `before`. `more: true` = ask again with `before` = the first entry's `at`.
A page fits one relay frame (≤ 40 KB before sealing). Fetch on every connect (and
after `mac` online:true): the Mac is the record; the phone keeps a copy only to show it.
REPLACE the shown list with what the pages bring — never merge live `assistant`
frames into it by `at`: a live frame's `at` is when it was sent, not the log
entry's, and a line that failed (ack `assistant-failed`) is logged with the
owner's words only (no answer) — the shown list follows the Mac's.
Page with `before` taken only from fetched entries, and take only the
`assistant-history` whose `id` is the one you asked with (an old page the relay
plays again, or one meant for another request, is dropped).

**A v1 (plaintext) pairing never gets the records**: its `assistant-history` is
answered `{ "type": "assistant-history", "id": "<same>", "error": "pair-again" }`
(no entries, no memo) — ask the owner to link the iPhone again (v2). Since
2026-10-06 a v1 pairing cannot talk to the assistant either: a `say` with
`projectId: "assistant"` is acked `rejected` with `reason: "pair-again"` (the
assistant reads files; v1 frames are plain and replayable). Its proposal buttons
(`assistant-proposal`) are refused the same way. Its president-desk talk is unchanged until `LEGACY_V1_UNTIL`.

**After the first `assistant-history` (v2), for good** (until linked again), the
assistant's lines come as sealed `assistant` frames instead of `event`s. Inner:
```json
{ "type": "assistant", "kind": "owner", "text": "…", "at": 1790846484310, "id": "<your say id>", "sent": … }
{ "type": "assistant", "kind": "assistant", "text": "…", "at": 1790846490000, "sent": … }
```
The relay passes them on and stores nothing (no `seq`, no `?after=` replay) —
what the phone missed it gets from `assistant-history`. Each carries its own
`eid` (inside the seal): skip one you already read. Read `kind: "assistant"`
aloud as before (`speak` when there is one). Before that first fetch a v2
pairing gets the assistant as sealed `event`s (`projectId: "assistant"`), which
the relay keeps as ciphertext like any event (the newest 200 at most, erased once the phone has heard it or after 7 days). A `say` to the
assistant is an ordinary sealed `say` with `projectId: "assistant"`.

**Relay redeploy needed** for `assistant-history` / `assistant` (its frame-type
allowlist): `cd worker && npx wrangler deploy -c wrangler.phone.jsonc`. Until then
the old relay refuses the phone's `assistant-history` (`bad-frame`), so the Mac
never switches and the assistant keeps talking in sealed `event`s — nothing breaks.

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

- What passes and what the relay stores is sealed end to end (v2, see **Sealed
  frames**): the `e2e` key is only in the pairing code and on the two devices.
  Neither key nor plaintext is ever logged: the Mac logs only that a phone frame
  did not open, or opened but was of an unexpected type.
- The room is named by `sha256(phone key)`. The phone proves itself with the key
  whose hash is the room — nothing about the phone is stored on the relay.
- The Mac has its own, different key; the room remembers the hash of the first
  Mac key it sees (the Mac connects right after creating the pair, when only it
  knows the room) and refuses any other. The phone key can never open the Mac
  end.
- The relay must be `https` (the keys travel in a header); plain `http` is
  accepted only for a relay on this machine.
- The assistant's records (log and memo) stay on the Mac (`~/.openground/assistant/`,
  0600) and are never written to a log. They cross the relay only sealed on a v2
  pairing (never to a v1 one). Once the phone fetches them, the assistant's talk is
  no longer stored on the relay; what it said BEFORE that first fetch stays there
  as sealed `event`s (ciphertext) like any event — erased once heard, after 7 days at the latest —
  see "What the assistant remembers".
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

- **Only an OPEN GROUND Mac creates a room** (since 2026-10-03). A room exists
  once a Mac registered its key, and the relay registers one only when the Mac
  also sends the **app key** (`X-OG-App-Key`). The relay holds it as the Worker
  secret `ROOM_CREATE_KEY`; release builds carry the same value, baked from the
  open-ground repo secret `OPENGROUND_PHONE_RELAY_APP_KEY` (`release.yml` →
  `electron/runtime-config.json` → the server's env). A phone can never create
  a room (it gets `404`), so a stranger's key makes the relay store nothing. The app key is an
  install pass, not a secret (anyone can dig it out of the app): it stops casual
  use of the relay as a free pipe, while each pairing's own keys stay the real
  boundary. No app key on the relay = no room can be created (fail closed).
  A room that already exists is entered with its keys alone, so **pairings made
  before the gate keep working — no re-pairing**. A build without the app key
  (a source checkout without the env var, an old release) cannot pair a new
  phone (it reports the relay as unreachable, and the pairing it had stays as
  it was); set `OPENGROUND_PHONE_RELAY_APP_KEY` in its env to pair from it.
  **How that looks:** Settings says only "Could not reach the relay (or work
  mode is on)" — the same words as for a network failure. The server log tells
  them apart: only when the relay answered the NEW room with `401` and the build
  has no app key does it log
  `[phone-link] pairing failed: the relay refused the new room (401) and this build has no OPENGROUND_PHONE_RELAY_APP_KEY …`.
  Seeing it, the relay was reached: the missing app key is the cause. A network
  failure, DNS error, timeout or a failed reset of the old room does not log
  it (`pairPhone` in `src/lib/server/phoneLink.ts`).
  **Rollout gate deployed (2026-10-04):** the owner's installed release 0.11.170
  carries the app key and the Worker has `ROOM_CREATE_KEY`. The temporary
  `ROOM_CREATE: "open"` bypass has been removed from `wrangler.phone.jsonc`;
  relay version `be33d2e9-7336-4230-b1e8-b65359f72084` runs with the gate on.
  Deployed probes confirmed a fresh Mac without the app key gets `401`, the
  installed release's app key creates a room (`101`), and the existing owner's
  phone credential reconnects (`101`). Existing pairings do not require
  re-pairing. The Mac remained paired, online and sealed; acceptance on the
  owner's physical iPhone remains pending (the probe was a stand-in client).
- **Nothing is kept for long.** An event is erased when the phone says it heard
  it (`?heard=`) and after **7 days** at the latest; a room nobody connected to
  for **30 days** is emptied (events, project list, held push token — the
  room's alarm). Only the hash of its Mac's key and the position of the newest
  event it stored (`cur`, what `resume` reports) stay, so the pairing itself
  survives: its Mac (even a build without the app key) comes back to it, the
  phone is never told "unlinked", and it follows the restarted `seq` — and the
  Mac, told where it had got to, does not send its old talk again as new (up to
  4 MB of it, waking the phone to read it out).
  **Honestly, today:** "erased once heard" works only once the iOS app sends
  `heard` — it does not yet, so in practice an event goes after 7 days, or
  earlier when it falls out of the newest 200.
  A room with a connection open is in use.
- **Bounded per room:** at most **5** phone sockets (one that has not pinged for
  90 s is closed first; then `429`), **60** connections a minute (`429`; counted
  only once the keys passed, so a stranger cannot lock the owner out of a
  room), **120** phone frames and **120** storing Mac frames (event / projects /
  push-ready) a minute, counted apart (over it the sender is closed `4029` after
  that frame and resumes on redial — the Mac waits 60 s, then resumes from the
  newest stored event, so nothing is lost). Frames over 16 KB (phone) / 64 KB
  (Mac) are dropped, as before.
- **All the numbers live in one place**: `RELAY_LIMITS` in
  `worker/src/phoneRelayAuth.ts`. The Worker var `RELAY_LIMITS` can override
  them; only the local test does (short expiries).
- **Cost stays at zero**: the operator's Cloudflare account is on the free plan
  (no bill; over a daily limit the relay simply errors until 00:00 UTC). A
  room's sweep is at most one alarm (one request + one row write) an hour —
  events due within the hour are erased together, early rather than late — not
  one per frame; the last-use time is written at most once a day per room.
- **What the caps do NOT stop (accepted until launch):** the free plan's daily
  limits (100k requests, 100k rows written) are per ACCOUNT. Someone who digs
  the app key out of the app can create rooms and, at the per-room write cap
  (~480 rows a minute per room), use up the day's writes; the relay is then down
  for everyone until 00:00 UTC — an outage, never a bill. The subscription
  check at the swap point below is what closes this; a per-IP limit was weighed
  and not added (the Workers rate-limiting binding counts per Cloudflare
  location, so a spread-out caller is barely slowed).
- **Rooms that existed before 2026-10-03** have no sweep yet; the first
  connection to one sweeps it at once (old events go), then it runs as above.

**App Store, later (per user):** every pairing is already its own room, so users
never share anything. **The swap point** is `mayCreateRoom` in
`worker/src/phoneRelay.ts`: today it compares the app key; at launch, replace
its body with a subscription check (e.g. a signed entitlement the Mac sends in a
header) — nothing else changes, and existing rooms keep working. The push
must move too: each user's Mac would need the operator's APNs key, which cannot
live on users' Macs — so the relay sends it, and the Mac only says "something new".

**Rotating the app key** (it leaked, or on a schedule): put a new value in BOTH
places — `cd worker && npx wrangler secret put ROOM_CREATE_KEY -c
wrangler.phone.jsonc` and `gh secret set OPENGROUND_PHONE_RELAY_APP_KEY -R
nannantown/open-ground` — then release. Existing pairings are unaffected;
releases older than the rotation can no longer pair a NEW phone.

## Verifying

- Relay, against a local workerd or the deployed one:
  `cd worker && node test/phoneRelay.local.mjs` /
  `RELAY=https://og-phone-relay.mindbrew.workers.dev node test/phoneRelay.local.mjs`
  (59 checks: missing / wrong / swapped keys refused, a room only with the app
  key (and none at all on a relay without one), frames pass, the phone frame cap,
  catch-up, resume, sealed assistant frames passed on and never
  kept, push-ready / push-token, `heard` erases,
  unlink retires both keys; locally also expiry by its own alarm, idle erase
  (an emptied room still knows its resume position), phone cap and the
  per-minute limits on a second relay with short limits). Against the deployed
  relay, pass its app key: `APP_KEY=<value> RELAY=… node test/phoneRelay.local.mjs`.
- End to end, a stand-in for the phone:
  `node scripts/phone-link-say.mjs <pairing code> "text"` — prints every frame
  and exits 0 once the president answered after the line landed. `--key x`
  shows a wrong key is refused; no text = listen only.
- The assistant: `node scripts/phone-link-say.mjs <code> "全体どう?" --project assistant`
  (exits 0 once its `assistant` event came after the `delivered`).
- The assistant's memory with the REAL claude: `npx tsx scripts/verify-assistant-memory.mts`
  (throwaway `OPENGROUND_HOME`, the signed-in claude, four short sonnet turns; exits 0
  only when every `~/.claude/history.jsonl` line those turns added is the fixed
  kickoff, none carries the talk or the memo, and step 4 leaves the memo empty).
  Last run 2026-10-03, claude 2.1.288:
  1. the screen route `POST /api/phone-link/assistant/say` 「うちの猫の名前はミケ。覚えておいて」
     → 200 `{"reply":"了解、猫の名前はミケね。覚えたよ。"}`, memo `オーナーの猫の名前はミケ。`
  2. after 32 lines from two days before, 「最近どう?」 (a turn the fold makes REQUIRED —
     the memo must not come back empty) → 200, memo kept its line and gained
     `コーヒーは浅煎りが好き。` and `来週の金曜15時に歯医者を予約している(2026-10-01に聞いた)。`
     (small talk dropped), `state.json` folded pointer set
  3. nobody talking, lines 1.5 days old → `foldIdleAssistantTalk()` true, memo gained
     `妹の誕生日は12月3日。プレゼントは本がいい。`
  4. log and memo emptied, memo set to its one fact 「オーナーは朝はコーヒー派。」, then
     「朝はコーヒーのこと、忘れて」 → 200 `{"reply":"了解、コーヒーのことは忘れたよ。"}`, memo `""`
  5. `history.jsonl`: 4 lines added by that run (one per claude run), all `Answer the
     owner's latest line exactly as your system prompt says.` + the done-marker line;
     0 carry the talk or the memo. (The script ran six times that day while it was
     being written and reworked: 2 + 3 + 4 + 4 + 3 + 4 = 20 lines in all, every one
     the fixed kickoff. The fifth run's step 4 timed out before claude took its
     prompt — 「アシスタントが時間内に答えられませんでした。」, memo untouched, no
     history line — and the sixth, run right after, passed as above.)
- Sealing: `src/lib/server/phoneLinkSealed.test.ts` runs the REAL relay room
  (`phoneRelay.ts`, in-memory storage) on what the real Mac end sends — the
  relay holds and passes no word in plain; a relay-made say (plain, other key,
  bounced, altered) is dropped; the same say twice (also after a restart) and a
  stale one are refused; a replayed `select` is dropped and a say without its
  project refused; a v1 pairing stops dialing at its date; the test vectors above.
  `node scripts/phone-link-say.mjs` speaks v2 when given a v2 code.
- The assistant's memory: `src/lib/server/assistantMemory.test.ts` (a 31-day-old
  line is gone, the memo never passes its size, a freshly loaded assistant three
  days later still has the memo and the talk, folding, deletes, 0600). Its records
  and talk on the wire: the "the assistant and its records (v2)" block of
  `src/lib/server/phoneLinkSealed.test.ts` (through the real relay room: sealed,
  nothing kept, paging under the frame limit, v1 refused).
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

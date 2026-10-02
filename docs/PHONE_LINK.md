# Phone link — talk to the president from the iPhone

Owner request, 2026-10-01: with earphones in and the Mac out of reach, hear what
reaches the president desk (progress, questions for the owner, deliveries) and
the president's replies as they happen, and talk back (push-to-talk). This page
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
  routes `server/routes/phoneLink.ts`, Settings section `PhoneLinkSetting.tsx`.
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
{ "type": "hello", "v": 1, "mac": true, "head": 42, "projects": { "type": "projects", "selected": "<id>", "projects": [ ... ] } }
```
`head` = newest event `seq` the relay holds. `projects` = last list the Mac sent
(or `null`).

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
the `selected` project.

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
(+`detail`).

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
- `select` — hear this project from now on (no replay of its past). Answered
  with `projects`.
- `projects` — ask for the list again.

Frames over 16,384 characters or of any other `type` are refused (`bad-frame`), never
forwarded to the Mac.

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
- One Mac end per room: only the primary OPEN GROUND (port 47776) holds the link.
  A room taken over by another Mac end (close `4001`) waits 60 s before retrying.

**App Store, later (per user):** every pairing is already its own room, so users
never share anything. What is missing is a gate on who may *create* rooms on the
operator's relay (e.g. a subscription check in front of `fetch` in
`phoneRelay.ts`) — today anyone can make their own pair of keys and use the
relay as a pipe of their own. Add that gate before the app is public.

## Verifying

- Relay, against a local workerd or the deployed one:
  `cd worker && node test/phoneRelay.local.mjs` /
  `RELAY=https://og-phone-relay.mindbrew.workers.dev node test/phoneRelay.local.mjs`
  (16 checks: missing / wrong / swapped keys refused, frames pass, catch-up,
  unlink retires both keys).
- End to end, a stand-in for the phone:
  `node scripts/phone-link-say.mjs <pairing code> "text"` — prints every frame
  and exits 0 once the president answered after the line landed. `--key x`
  shows a wrong key is refused; no text = listen only.
- Unit guards: `src/lib/server/phoneLink.test.ts`,
  `src/lib/server/phoneRelayAuth.test.ts`,
  `src/lib/server/supplyNoticeOwnerSay.test.ts`.
- ⚠ A test server started from inside a Claude Code session inherits
  `CLAUDE_CODE_CHILD_SESSION` and its desks save NO transcript — the feed then
  stays silent although the desk answered. Strip `CLAUDE*` env first.

## Not built (yet)

Push notifications when the app is closed (APNs) — today the phone hears only
while its socket is open; a paid voice model; a QR code for pairing.

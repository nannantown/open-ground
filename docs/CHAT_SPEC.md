# Chat spec — the assistant chat on the iPhone and the Mac

> **The rule (owner decision 2026-10-27).** The chat is ONE product on two
> screens, and the iPhone's is the reference: "keep the desktop chat always the
> same as the iOS spec; the desktop chat's design and features may change"
> (owner, 2026-10-27). Any change to how the chat looks or behaves goes in this
> order:
>
> 1. **Edit this document first** (and the shared file, §12, when a colour, size
>    or word changes). Bump `version` in the shared file.
> 2. **Then file a PAIR of cards**: one for the iPhone app (`openground-ios`),
>    one for the desktop app (this repo), each citing the same spec version.
>    A chat card without its twin is incomplete. When one side needs no change,
>    its card is "check the screen against the spec". The only exception is a
>    row in §10 "Allowed differences", and the card must name that row.
> 3. A difference found later is fixed in this document first, then in code.
>    The document is the spec: when code and document disagree, the owner's
>    last decision recorded here wins, and the stray side gets a card.
>
> Not adopted: turning the iPhone chat into a web view to share the code. The
> microphone, the call and the keyboard would stop being native and the call
> would become unstable (owner, 2026-10-27).

## 0. What this document is, and what it is not

| Document | Owns |
|---|---|
| **docs/CHAT_SPEC.md** (this) | How the chat **looks and is operated** on both screens: parts, order, controls and what pressing them does, words, colours, type, sizes, empty and error states, read-aloud rules |
| [docs/PHONE_LINK.md](PHONE_LINK.md) | The **wire contract** between the iPhone and the Mac: pairing, frames, seals, proposal hashes, photo parts, call records, history paging |
| [docs/ASSISTANT_DESIGN.md](ASSISTANT_DESIGN.md) | The **character** (the 4-piece ring, its motion) and the Mac's floating button. Its chat-window and colour parts (§1, §3, §6) are superseded by this document |
| `openground-ios/docs/REDESIGN.md` 「文字と言葉の決まり」 | Absorbed into §6 and §8 here (2026-10-27). That section stays as history |

When a chat change needs a new frame or field, PHONE_LINK.md gets that part and
links back here. Targets below that need such a change are marked
**(wire)**.

**Status: version 0 (first edition, 2026-10-27).** It records today's state of
both screens and the target for each difference. Today's state was measured:
the iPhone at `openground-ios` origin/main 078f1e2, built and shot in the
Simulator; the Mac from this repo, the floating window shot in Chromium with
the built CSS. Six differences wait for the owner's choice on the OPEN GROUND
Canvas 「チャットの違い」. They are marked **[C1]…[C6]** below, and any text
that depends on a choice is tagged with it. Nothing tagged may be built until
the owner has chosen.

## 1. Scope

| Surface | Where | In scope |
|---|---|---|
| iPhone talk screen | `App/ContentView.swift` (talk, header, partner sheet, composer, bubbles, empty state) | yes |
| iPhone call screen | `App/CallView.swift` | yes |
| iPhone proposal frames | `App/ProposalFrames.swift` | yes |
| Mac floating assistant window | `src/components/assistant/FloatingAssistant.tsx`, `AssistantCall.tsx`, `ProposalFrames.tsx` | yes |
| Mac president seat (agent-team bar) | `SwarmSupplyPane.tsx` + `ClaudeTerminalPane` | **no.** It is Claude Code's own terminal, a work surface rather than a chat (§10 A1). Whether the Mac also talks to presidents as a chat is [C3] |
| iPhone pairing, settings | `PairView`, `SettingsView` | words only (§8) |

## 2. Words used in this document

- **Partner**: who the owner is talking to. The assistant, or one project's president.
- **Own line**: what the owner sent. **Reply**: what the partner said.
- **Composer**: the input row at the bottom.
- **Proposal frame**: a card proposal (`make_card`) or a message to the commander (`tell_commander`). It runs only when its button is pressed (PHONE_LINK.md "Assistant proposals").
- **Call**: a voice conversation. Listen, think, read aloud, listen again.
- **Mark**: the 4-piece ring character (ASSISTANT_DESIGN.md §5).

## 3. Layout, top to bottom

Both screens show the same parts in the same order. The Mac window is small
and floats over work, so it may fold (§10 A3).

1. **Header**: today the iPhone shows `[partner menu] [Mark + partner name + link status] [call]`; the Mac shows the name only. Target: the iPhone layout **[C2]**. The partner menu exists on the Mac only if **[C3]** = A.
2. **Ongoing-call bar**, only while a call continues behind the chat: waveform, 「通話中」, timer, 「終了」. Mac today: none (closing the window ends the call). Target: both.
3. **Conversation**: newest at the bottom; opens at the newest line; short talks sit at the top; older pages load at the top. Thinking = the Mark in thinking mode as the last row, plus the interim line (§9.6).
4. **Proposal frames**, between the conversation and the composer (§9.5).
5. **Composer**: today the iPhone shows `[+ photo] [text field] [mic ⇄ send]`; the Mac shows `[name/colour] [field, photo, mic, call ⇄ send] [fold]`. Target **[C2]**: A = the iPhone's; B = the call key stays in the composer (`call ⇄ send`) on both.

Empty conversation: the iPhone shows 「何から始めますか？」 with three shortcuts;
the Mac shows the composer only (§10 A4).

## 4. Controls

Icons: SF Symbols on the iPhone, lucide on the Mac. Direction marks are
chevrons only, and there is no emoji (CLAUDE.md "UI design principles"). The
one shafted arrow allowed is lucide `ArrowUp` for the assistant's send button
(owner 2026-10-04, allow-listed per file in `src/noEmojiGuard.test.ts`). Labels
in this table are the accessibility label / tooltip. Whether any are printed
on screen is [C4].

| Control | SF Symbol / lucide | Label (ja / en) | Press | Disabled when |
|---|---|---|---|---|
| Partner menu **[C3]** | `line.3.horizontal` / `Menu` | メニュー / Menu | opens 「話す相手」 | never (rows disabled during a call) |
| Call (header **[C2]**) | `phone` / `Phone` | 通話 / Call · 通話に戻る / Back to the call | starts a call, or reopens it | offline and not in a call |
| Add photo | `plus` / `Plus` | 写真を添付 / Add a photo | menu: 写真を選ぶ / Choose a photo · 画像をペースト / Paste an image | offline. **Hidden** (not disabled) when the partner is a president or the pairing is v1 |
| Remove photo | `xmark` / `X` | 写真を外す / Remove the photo | drops the attached photo | — |
| Mic (dictation) | `mic` ⇄ `mic.fill` / `Mic` | 話す / Talk | tap starts listening; tap again puts the words into the field (never sends) | offline, in a call |
| Send | `arrow.up` / `ArrowUp` | 送信 / Send | sends text and/or photo | empty, offline, waiting for a reply |
| Call: talk | `mic` ⇄ `arrow.up` / `Mic` ⇄ `ArrowUp` | 話す / Talk · 送信 / Send | first tap opens a turn (and stops the reading); second sends | dialing, muted, ending, earphones just pulled out. Mac: the `ArrowUp` here needs the owner's OK to extend the allow-list to `AssistantCall.tsx` |
| Call: end | `phone.down.fill` / `PhoneOff` | 終了 / End | ends at once | never |
| Call: mute | `mic.slash` / `MicOff` | 消音 / Mute | toggle | until connected |
| Call: speaker | `speaker.wave.2` / `Volume2` | スピーカー / Speaker | sends the voice to the built-in speaker | shown only when the output can be chosen (earphones in), disabled while dialing. Never on the Mac (§9.3) |
| Call: back to chat | `chevron.down` / `ChevronDown` | 会話に戻る / Back to chat | shows the chat; the call goes on | — |
| Call: retry / close | text | 再試行 / Try again · 閉じる / Close | failure state only | — |
| Proposal: drop / run | text | やめる / Drop · 出す / Add (card) · 送信 / Send (commander) | §9.5 | a press is pending, or offline |

Keyboard (the Mac, and an iPhone with a hardware keyboard):
- Enter sends. While the IME is composing, Enter never sends. Shift+Enter starts a new line (the field grows to 5 lines, §7).
- Esc closes the Mac window (ignored during IME). Esc in the name editor reverts.
- Space outside the text field acts as the 「話す」 key: in the chat it toggles dictation; in a call it opens a turn and stops the reading.

## 5. States

| State | Shows | Words |
|---|---|---|
| Thinking | Mark (thinking) as the last row, plus the interim line in muted text. Shown while a line is **replying** (§5b), for the assistant AND for a president | VoiceOver 「考えています」 |
| Own line's state | small note under the own line (§5b) | 送信中 · 届きました · 未送信 · 返事なし |
| Refused | §5b "Failed": a line that resending can fix stays in the talk with 再送 / 削除 (its note says it; a reason line only when it tells the owner what to do — busy, work mode; a call has no lines, so it says every reason); a line that resending cannot fix (too long, photo type / size) goes back into the field with the reason | §8 errors |
| Offline (iPhone) | link status under the name; send, call, mic and + disabled; typing allowed | 確認中 · 接続中 · 再接続中 · 起動中 · Macが停止中 |
| Work mode (Mac) | character greyed; the window cannot open | 業務モード中は使えません |
| Not paired (iPhone) | pairing screen | Macとつなぐ |
| Call | §9.3 | 発信中 · 聞いています · 考えています · 話しています · 消音中 · 返事がまだ来ていません · 再接続中 · 接続できません · Macが停止中 · イヤホンが外れました |

## 5b. Message states (メッセージの状態, 2026-10-30)

Owner request, 2026-10-30: 「社長とかに送っても『今応答中ですよ』のアニメーションとか出ない…動いてるか
動いてないのかわかんない。うまく送信できなかったメッセージとかがずっと下に溜まっていってるから、それは再送信できたり
消せるようにしたいな」. Both screens, both partners (the assistant and every
president), same states, same words, same clocks. Written by the desktop card
first; the iPhone card follows it. The wire is PHONE_LINK.md "Message states".

**The five states of an own line**

| State | Means | Shows (note under the own line, `note` role, muted) |
|---|---|---|
| **sending** | the line left this screen; the Mac has not said it took it | 「送信中」 |
| **delivered** | the Mac took it and will hand it to the partner (the assistant: in its queue; a president: being typed into the desk, which waits while the president is writing) | 「届きました」 |
| **replying** | the partner is working on it | no note. The thinking row (§5 Thinking: the Mark animating as the last row of the talk). A president only: after **30 min** with no words, the thinking row goes and the note reads 「返事がまだ来ていません」 (muted, not the danger colour, no keys — it is not failed) |
| **replied** | the partner's reply came | nothing (the reply is the proof) |
| **failed** | it did not reach the partner, or reached it and got no reply | 「未送信」 (did not reach) or 「返事なし」 (reached, no reply), in the danger colour, then two text keys: 「再送」 「削除」 |

Only the newest own line of a conversation shows sending / delivered (an
older one that is still in flight shows them too; a replied line never does).
Failed lines keep their note and keys wherever they are.

**How a line moves** (never backwards; `failed` and `replied` end it, except
that later proof lifts a `failed`, below):

```
sending ──Mac took it──▶ delivered ──partner starts──▶ replying ──reply──▶ replied
   │                         │                            │
   └────────── failed ◀──────┴────────────────────────────┘
```

| From | To | When (iPhone: PHONE_LINK `ack`; Mac window: the say stream) |
|---|---|---|
| sending | delivered | `ack queued` · the Mac window's say request accepted (HTTP 200 stream opened) |
| delivered | replying | `ack replying` · the stream's `{state:"replying"}` (the assistant's turn for this line started; a president's desk received the words) |
| replying | replied | `ack replied` or the reply itself (an `assistant` answer for this line; a president's first words after the line) · the stream's answer |
| replying (president) | replying, note 「返事がまだ来ていません」 | 30 min after `ack replying` with no `replied` and no words from that president (iPhone; the Mac has no president chat, [C3]) |
| replying, note 「返事がまだ来ていません」 | replied | `ack replied` or the president's words: the note goes |
| sending | failed 「未送信」 | no `ack` within **15 s** on a live link, the link dropped before any `ack`, `error mac-offline`, or `ack rejected` with a reason resending can fix (below) · the request failed (network, 5xx before the stream, 429 busy) |
| delivered / replying | failed 「返事なし」 | `ack rejected` (`assistant-failed`, `desk-failed`, a passed-on message's `no-reply`; its `not-landed` is 「未送信」), the assistant gave no answer within **200 s of `replying`** (the clock starts at its turn, never at a wait in the queue: a waiting line may sit behind one other turn of up to 2 min), or the Mac restarted (`mac` offline→online) before a reply · the stream ended with an error, or no answer 200 s after `{state:"replying"}` |
| failed | delivered / replying / replied | later proof: an `owner` echo carrying the line's `id`, or a reply to it, or the record (startup check, below) shows it landed |

A president has no failure clock: delivered may last while the desk is busy, and
replying may last long (it works on the order). After **30 min** of replying
with no words, the thinking row goes and the note under the line reads
「返事がまだ来ていません」 / "No reply yet" (the word `call.noReply`, §8). It is not
failed: muted note colour, no 再送 / 削除. When the president's reply comes, the
note goes and the line is replied (owner, 2026-10-30, with the iPhone card).

**Refusals resending cannot fix** do not leave a failed line: `too-long`,
`empty`, `photo-type`, `photo-too-large`, and on the iPhone `photo-bad`,
`photo-assistant-only`, `pair-again`. The words (and photo) go back into
the field with the reason line (§8 errors), exactly as before; nothing was
sent. Every other refusal (`busy`, `mac-offline`, `mac-error`, `stale`,
`work-mode`, `desk-failed`, `assistant-failed`, a network error) leaves the line
in the talk as failed.

**再送 (Resend)** sends the same words (and the same photo, when the line had
one) again as a **new** line with a new `id` (the Mac drops an `id` it already
took, PHONE_LINK "Sealed frames"). The failed line goes away and the new line
appears at the bottom as sending. Disabled while another line from this screen
to the same partner is still sending / delivered / replying, or offline. A line
whose photo can no longer be fetched is not resent (never the words without
it): its 再送 shows disabled once the Mac answers 404 for the photo (削除 still
works). A photo that fails to load for another reason (the Mac restarting, no
connection) leaves 再送 as it is.
On the Mac window, resend deletes the old line from the record first
(`DELETE …/assistant/failed/:id`) and sends only when that succeeded — never the
same words twice. 409 means the line got its answer meanwhile (or is gone): the
reloaded record shows it answered, nothing is sent. No connection: nothing is
sent, the line stays failed, and the general failure line says so.

**削除 (Delete)** removes the failed line at once. A line that never reached
the Mac lives only on that screen and just goes. A line in the assistant's
record (it reached the assistant and got no answer) is deleted from the record
on the Mac window — that line only (`DELETE …/assistant/failed/:id`, refused
unless the line is an owner line with no answer after it): unlike the whole-talk
delete it leaves a turn running now, the live session and the proposals alone.
The iPhone hides it on the phone only (a phone frame that deletes from the
record does not exist; the 24 h rule below ends its keys anyway).

**Does not pile up.**
- A failed line sits at its own time in the talk, never pinned to the bottom (a
  line without the Mac's time sorts by its own send time).
- At most **5** failed lines per conversation: a sixth pushes the oldest out.
- After **24 h** a failed line's note and keys go. A line that never reached
  the Mac goes with them; a line in the record stays as a plain own line.

**Startup check (起動時の突き合わせ).** On launch, and on every reconnect:
- A line left sending / delivered / replying from before becomes failed unless
  the record proves otherwise.
- Proof for the assistant: its record (iPhone `assistant-history`, Mac window
  `GET …/assistant/log`) holds an owner entry whose `clientId` is the line's
  `id`. Followed by an assistant entry ⇒ replied. Not followed by one (the next
  entry is another owner line, or none) ⇒ failed 「返事なし」, kept under the 24 h
  rule. The app's own line after a proposal button (`app: true`, 「出しました」)
  is not an answer and is skipped, like call records. So is the assistant's
  line retelling a president's answer to a passed-on message (it carries
  `president: { projectId, project }` live and in the record, PHONE_LINK "Assistant → president
  messages"): it answers that message, not the owner line before it.
- Proof for a president: an `owner` event carrying the line's `id` (⇒
  delivered) and a `president` event after it (⇒ replied).
- **Coming back to a president** (owner, 2026-10-30): switching to a
  president's conversation (and every reconnect while it is open) fetches that
  president's recent talk from the Mac (PHONE_LINK "A president's talk"). What
  the president said while another conversation was open shows in the talk at
  its own time, and the proof above applies to it: the reply that came meanwhile
  is there and the line is replied — no thinking row, no 「返事がまだ来ていません」.
  Same on both screens: the Mac's president seat shows the desk itself.
- An owner entry in the record without a following reply (an answer failed) is
  failed 「返事なし」 on BOTH screens, whoever sent it, for 24 h. Call records
  (`kind: "call"`) are not lines and never count.
- The line being answered right now is not in the record yet (an answer is
  written together with its line), so it is never mistaken for failed.

The Mac window keeps a line that never reached the Mac in memory only: a reload
of the app forgets it (it was never sent). The iPhone keeps them in its saved
talk, under the 5-line / 24 h rules.

## 6. Type (both screens follow the same roles)

Japanese text rules, from REDESIGN.md 「文字と言葉の決まり」 (2026-10-04; sources in §13):
- Sizes come from each platform's own scale. The iPhone uses Dynamic Type text styles only (never fixed sizes for text) and nothing under 11 pt. The Mac uses the app's steps (`tailwind.config.ts`), where 13 px (`text-meta`) is the floor for Japanese prose.
- Two weights only: regular (W3) and semibold (W6).
- Line height: Japanese text that can wrap uses **1.5×**. One-line names, buttons and notes use 1.3×. Letter spacing 0.
- Line breaking: strict kinsoku (no 、。」ー or small kana at a line start). Do not leave 1–2 characters alone on the last line (Mac: `line-break: strict; word-break: auto-phrase`).
- Spacing between Japanese and Latin letters or digits: **none in the shared words** (Apple's current Japanese style). JLREQ prefers a ¼ em gap, which CSS `text-autospace` would draw. That property is Baseline 2025 (MDN), newer than the Chromium in the app's Electron 31, so the Mac shows no gap for now. The chat words therefore differ from the rest of the Mac app, which writes an ASCII space. Accepted until Electron is updated; then the Mac adds `text-autospace: normal` to the chat.
- Digits and Latin letters are half-width; punctuation is full-width (？！「」).

| Role | iPhone text style (default size) | Mac step | Weight | Line height | Used for |
|---|---|---|---|---|---|
| title | Title 3 (20) | `text-title` 20 px | semibold | 1.3 | empty-state heading, call state |
| name | Body (17) | `text-ui` 14 px | semibold | 1.3 | partner name, proposal title |
| body | Body (17) | `text-ui` 14 px | regular | 1.5 | bubbles, composer |
| sub | Subheadline (15) | `text-meta` 13 px | regular | 1.5 | call receipts, proposal body |
| note | Caption 1 (12) | `text-meta` 13 px | regular | 1.3 | link status, delivery note, proposal kind and project, key labels (if [C4] = A) |

The absolute sizes differ on purpose (§10 A5). Line heights today: the Mac
body uses `leading-relaxed` (1.625); iPhone bubbles add 4 pt (about 1.5).
Target: 1.5 on both.

## 7. Sizes

| Item | iPhone | Mac | Note |
|---|---|---|---|
| Smallest press target | 44 pt | 32 px | finger vs pointer (§10 A6) |
| Bubble corner radius | 23 | 18 (own bubble today 12/12/4/12) | about 1.35 × body size |
| Bubble padding | 13 × 16 | 8 × 12 | |
| Bubble max width | own 84 %, reply 92 % of the list width | same percentages | Mac today: own 80 %, reply 88 %. A reply bubble on the Mac exists only if **[C6]** = A |
| Composer | min height 56, radius 28, grows to 5 lines | min height 40, radius 20, grows to 5 lines | Mac today: one line. Its keys depend on **[C2]** |
| Proposal frame radius | 20 | 12 | |
| Call keys | 64, symbol 23 | 48, icon 20 | |
| Mark | header 48 · thinking 20 · call 88 | header 24 · thinking 20 · call 64 | |
| Photo preview in the composer | 72, radius 14 | 64, radius 10 | |

## 7b. Colour roles

Colours are named by role; the values live in the shared file (§12). Which
palette both screens use is **[C1]**: A = neutral white / black with a blue
accent (today's iPhone); B = warm paper / ink with vermilion (today's Mac).

| Role | Used for |
|---|---|
| `bg` | screen / window background; symbol on filled keys |
| `card` | composer, round keys, proposal frames, partner rows |
| `elevated` | pressed / hover, selected row |
| `plane` | reply bubble (**[C6]** = A; with B, the reply has no surface) |
| `ownBubble` | own bubble and call receipts (iPhone `accentSoft`) |
| `ink` | text, send key, mic-on fill, Mark |
| `muted` | secondary text, placeholder |
| `line` / `lineStrong` | 1 px borders / the やめる border and the listening composer |
| `accent` | proposal kind label, the default identity colour |
| `danger` | 終了 key, errors |

Identity colours (the owner picks one, PHONE_LINK `look`): `verm` / `moss` /
`ochre` / `ink`. Target: they only light the call key while a call is on
(today's iPhone). The Mac today also fills the call / send key with it.

## 8. Words (screen text)

Rules: buttons are short action words, with Sino-Japanese verbs dropping
「する」 (送信・終了・消音・再試行). System states end in 「〜中」 with no 「…」. The
partner's state is a human action, 「〜ています」. Notices use です・ます, with no
「。」 on headings, buttons and one-line notices, and with 「。」 on bubbles and
on 2+ sentences. Words follow the iPhone's own apps (消音・スピーカー・終了・ペースト).
No explanatory text.

Target words (ja / en). **Bold** in "Today" = differs on that screen today.

| Key | ja | en | Today |
|---|---|---|---|
| composer.placeholder | メッセージ | Message | Mac 「**話しかける…**」 |
| composer.send | 送信 | Send | Mac 「**送る**」 |
| composer.mic | 話す | Talk | Mac 「**声で入力**」 |
| composer.micOn | 入力欄へ | To the field | Mac 「**声の入力を止める**」. iPhone also prints 「タップで入力欄へ」 above the composer while listening ([C4]) |
| composer.attach | 写真を添付 | Add a photo | Mac 「**写真を添える**」 |
| composer.pickPhoto / pastePhoto | 写真を選ぶ / 画像をペースト | Choose a photo / Paste an image | Mac: none |
| composer.removePhoto | 写真を外す | Remove the photo | Mac 「**写真を取り消す**」 |
| header.menu **[C3]** | メニュー | Menu | Mac: none |
| partners.title / search / none / close **[C3]** | 話す相手 / 検索 / 見つかりません / 閉じる | Talk to / Search / No match / Close | Mac: none |
| partners.inCall **[C3]** | 通話を終えると、相手を切り替えられます | End the call to switch | Mac: none |
| empty.title | 何から始めますか？ | Where shall we start? | iPhone only (§10 A4) |
| empty.type / talk / call | 文字入力 / タップで話す / 通話 | Type / Tap to talk / Call | iPhone only |
| call.start / call.back / call.ongoing | 通話 / 通話に戻る / 通話中 | Call / Back to the call / In a call | Mac: only 通話 |
| call.end | 終了 | End | |
| call.mute / call.muted | 消音 / 消音中 | Mute / Muted | |
| call.speaker | スピーカー | Speaker | Mac: **different meaning** (§9.3) |
| call.talk / call.send | 話す / 送信 | Talk / Send | iPhone key 「**送る**」; Mac: none |
| call.toChat | 会話に戻る | Back to chat | Mac: none |
| call.dialing | 発信中 | Calling | |
| call.listening | 聞いています | Listening | Mac shows 「**少しお待ちください**」 while the mic reopens (the iPhone shows 聞いています then); target: 聞いています |
| call.thinking / call.speaking | 考えています / 話しています | Thinking / Speaking | |
| call.noReply | 返事がまだ来ていません | No reply yet | Mac: **none** (new on the Mac). Also §5b: a president's line 30 min into replying with no words (iPhone; the Mac has no president chat) |
| call.cannotConnect | 接続できません | Can't connect | |
| call.retry / call.close | 再試行 / 閉じる | Try again / Close | Mac: retry is an **icon key**, no close |
| call.earphonesOut | イヤホンが外れました | Earphones out | iPhone only |
| call.stopReading | 止める | Stop | Mac only today |
| call.receipt | 通話 {m:ss} | Call {m:ss} | Mac: a **plain own bubble** with the stored text (no phone mark, not redrawn in the current language) |
| proposal.card / proposal.commander | カード案 / 司令官へ | Card / To the commander | Mac: **not shown** (aria-label 「カード案」 / 「伝言の案」) |
| proposal.drop / add / send | やめる / 出す / 送信 | Drop / Add / Send | both 「**送る**」 today |
| proposal.added / sent / dropped / expired | 出しました / 送りました / やめました / 時間切れ | Added / Sent / Dropped / Expired | Mac: **done = check + project · title; dropped / expired = project · title only** |
| delivery.sending / delivery.delivered | 送信中 / 届きました | Sending / Delivered | §5b. Mac: none; iPhone has no 届きました |
| delivery.failed / delivery.noReply | 未送信 / 返事なし | Not sent / No reply | §5b. Mac: none; iPhone has no 返事なし |
| delivery.resend / delivery.delete | 再送 / 削除 | Resend / Delete | §5b. New on both |
| error.failed | アシスタントが答えられませんでした。もう一度送ってください | The assistant couldn't answer. Send it again | Mac 「**…もう一度どうぞ。**」, iPhone 「**アシスタントが答えられませんでした**」 |
| error.busy | まだ前の話に答えています。少し待ってから送ってください | Still answering the last one. Send again in a moment | Mac 「**…少し待ってからもう一度どうぞ。**」, iPhone 「**アシスタントが手一杯です。少しあとでもう一度言ってください**」 |
| error.tooLong | 長すぎます。2000字までにしてください | Too long. Keep it under 2000 characters | Mac 「**1回に送れるのは2000字までです。**」, iPhone 「**長すぎます。分けて話してください**」 |
| error.photoType | この写真は送れません。JPEG・PNG・GIF・WebPを選んでください | This file can't be sent. Choose a JPEG, PNG, GIF or WebP | Mac 「**このファイルは送れません。JPEG・PNG・GIF・WebP の写真を選んでください。**」 (iPhone shrinks any picked image to a JPEG, so it has no such error) |
| error.photoTooLarge | 写真が大きすぎます | The photo is too large | Mac adds 「**5MB 以下…**」, iPhone 「**写真が大きすぎて送れませんでした**」 |
| error.workMode | 業務モード中は使えません | Off in work mode | |
| link.* | 確認中 / 接続中 / 再接続中 / 起動中 / Macが停止中 | Checking / Connecting / Reconnecting / Starting / Mac is off | iPhone only (§10 A7) |

Spoken lines (iPhone `Core/Sources/PhoneLinkCore/Lines.swift`) follow the same
rules but stay in Swift for version 0; they move into the shared file later.

## 9. Behaviour

### 9.1 Partners (who you talk to)
- iPhone: the menu opens 「話す相手」. The assistant comes first, then the projects' presidents. Each partner has its own conversation. Switching is disabled during a call. In flight on the iOS branch `swarm/1027-104512-…`: names only (no 「の社長」), a registered list with + to add, and swipe 「外す」 to remove. This spec adopts that design if it lands.
- Mac: the window talks to the assistant only. Target **[C3]**.

### 9.2 Microphone in the chat (dictation)
- Today, on both: tap to start, tap again to put the words in the field. It never sends.
- iPhone only: says 「聞き取れませんでした」 aloud when nothing was heard; stops after 90 s (`Phone.listenLimit`); appends the words at the end of the field.
- Mac only: typing while listening takes over (the heard words are absorbed, not appended).
- Target: both stop after 90 s; both say 「話す」; both show a ring while really listening. Nothing heard: one line under the composer on the Mac; spoken aloud on the iPhone (§10 A9). Typing during listening: the Mac's behaviour on both.

### 9.3 Call
- Loop: listen, a pause ends the turn, send, 「考えています」, the reply is read aloud, listen. Talking over the reading stops it (barge-in). Short backchannels (うん, なるほど) do not.
- **The end of a turn exists on both, by different rules (D27).**
  - iPhone: a fixed pause of 1.2 s, timed on the voice (`Core/Sources/PhoneLinkCore/Call.swift` `Endpoint.quiet`; 2026-10-08 moved from the words to the voice).
  - Mac: the pause depends on how the words end (`native/og-listen/main.swift` `pauseFor`, owner-tuned 2026-10-07, ASSISTANT_DESIGN.md §1): 0.5 s after a finished sentence, 1.4 s after a dangling particle or conjunction (「〜で」「〜けど」), 0.8 s otherwise. It is timed from the last new word the recognizer reported.
  - Target (proposal, Mac): the iPhone takes the Mac's ending-aware rule, so a finished sentence is answered sooner and a mid-thought pause is waited out. The Mac's tuned rule is not replaced. The two clocks start at different points (voice vs last word), so the implementing card measures the felt delay on the device rather than copying the numbers.
- Hang-up after 5 minutes with nothing said either way: iPhone only today; **target for the Mac**.
- Keys (target, left to right): 話す, 終了, 消音, plus スピーカー only where the output can be chosen. The Mac has no earpiece, so its 「スピーカー」 key goes. On the Mac today that key means "read aloud on / off": same word, different meaning. Removing it also removes "keep the whole call silent"; the reading is stopped per line instead (the 「話す」 key, Space, or talking over it). The Canvas states this.
- 「会話に戻る」 keeps the call and shows the chat with the ongoing-call bar. Target on the Mac too; today closing the Mac window ends the call.
- Labels printed under the keys: **[C4]**.

### 9.4 Photos
- Assistant only, one photo per line, text optional (PHONE_LINK.md "Photos").
- Target on both: + opens 写真を選ぶ / 画像をペースト. The Mac also takes ⌘V and a drop onto the window. The iPhone shrinks to a JPEG of at most 384 KB; the Mac keeps its 5 MB limit (§10 A8).
- In the conversation, the own line shows the photo as a thumbnail (max height 160) above the words. Today the iPhone shows only the word 「写真」 because it keeps no copy, and the Mac never sends an image back (PHONE_LINK.md "Photos"). **(wire)**: the history must carry a small copy.

### 9.5 Proposal frames
- Shown only with the assistant. A frame holds: the kind label (カード案 / 司令官へ, accent, note size) and the project (muted); the title (name); the body (sub, verbatim); and the buttons, right-aligned: やめる (outline) and 出す / 送信 (filled ink).
- Pressing is the only way a proposal runs (PHONE_LINK.md "Assistant proposals").
- Frames that do not fit scroll together and keep their buttons (iPhone, 2026-10-16). The Mac's cut frame and 「長いので社長に頼んでね」 go. **(wire)**: PHONE_LINK.md "Assistant proposals" still prescribes the Mac's cut frame and measures the `frameLines` cap (10 lines / 21 characters) on the Mac's current frame. Both change with this target.
- Closed: one faded line, 出しました / 送りました (with the done check), やめました or 時間切れ. Open frames expire after 10 minutes.

### 9.6 Read aloud and the interim line
- A call's replies are always read. Typed lines are never read while the chat is on screen.
- The iPhone also reads when locked or in the background (§10 A9).
- The voice: **[C5]** — built 2026-10-27: both pick Nemo (default) / 冥鳴ひまり / the device's own voice, each device its own pick (docs/ASSISTANT_DESIGN.md §1 "Voice").
- Interim line (「ちょっと待ってね」 before a tool runs): today it is shown on the Mac only, because it travels only on the Mac screen's own stream. Target: shown in the chat on both and read in a call on both. **(wire)**: a frame that carries it to the phone.

### 9.7 Name and colour
Set once and shown on both (PHONE_LINK `look`). Target: edited in Settings on
the Mac (設定 → iPhone, next to the assistant's memory), not from the
composer. The iPhone only shows them.

### 9.8 The conversation's fold (Mac)
The Mac window can fold to the last exchange (§10 A3).

### 9.9 Messages to a president through the assistant (2026-10-30)
The owner asks the assistant 「〇〇の社長に△△と伝えて」 or 「〇〇の進み具合を聞いてきて」. The
same on both screens (the wire: PHONE_LINK.md "Assistant → president messages").
- **A frame first.** The assistant puts up one proposal frame (§9.5) of the kind
  `president`: the project (muted), the title **社長へ** (name), the message (body,
  verbatim), and やめる / 送る. As with every frame, only 送る sends it; a 「うん」 does
  nothing.
- **After 送る**, one assistant line in the app's own words says what happened:
  - passed on: 「〇〇の社長に伝えたよ。返事が来たら教えるね。」
  - the president's window was closed and was opened: 「〇〇の社長の窓口が閉じてたから開いたよ。開いたらすぐ渡して、返事が来たら教えるね。」
  - the president is busy: 「〇〇の社長は今手が離せないから、空いたらすぐ渡すね。返事が来たら教えるよ。」
  - the window could not be opened: 「〇〇の社長の窓口を開けなくて、伝えられなかった。」 — the frame stays open, to be pressed again.
- **The answer** comes back as ONE more assistant line, read aloud like any answer:
  the assistant's retelling of what the president wrote (「〇〇の社長から返事: …」).
  When the assistant cannot retell it, the app shows the president's own words
  after 「〇〇の社長から返事:」. When nothing comes within 10 minutes, the app says so
  (「〇〇の社長から10分たっても返事がないよ。社長の会話を直接見てみて。」), and when the
  message could not even be handed over in that time, it says that instead. The
  assistant is never silent about a message it passed on.
- **The president's conversation keeps it** (the iPhone's partner list, §9.1, and
  the Mac's president seat): the passed-on line shows on the owner's side,
  beginning with 【アシスタントからの伝言】, followed by the president's answer.
- **States of the message** (sending → delivered → replying → replied, or refused)
  use the shapes of §5b "Message states" (not repeated here; PHONE_LINK "Message
  states" lists the message's reasons). On the iPhone they belong to the frame's
  message, not to the owner's own line. The Mac's window shows the frame's closed
  line and then the answer; it has no waiting caption on the frame yet (§5b's
  notes are on own lines only — a follow-up card).
- **What the president does with it is the president's to decide.** It is the
  assistant's summary of the owner's words, never the owner's OK; a decision only
  the owner can make comes back as the president's question, which the assistant
  retells — the owner answers it in the president's conversation.

## 10. Allowed differences (each with its reason)

| # | Difference | Why it may differ |
|---|---|---|
| A1 | The Mac president seat is a terminal, not this chat | It is where Claude Code works. Talking to presidents as a chat on the Mac is [C3] |
| A2 | Window size: the iPhone is full screen; the Mac is a floating window 340 × ≤ 460 | screen size; the Mac window sits over work |
| A3 | The Mac window can fold to the last exchange; an unread dot on the Mac character | a small window over work must get out of the way |
| A4 | Empty conversation: the iPhone shows 「何から始めますか？」 and 3 shortcuts; the Mac shows only the composer | the iPhone keyboard is hidden until asked for; the Mac's field is ready to type (owner chose the iPhone's empty screen, 2026-10-04) |
| A5 | Absolute text sizes (iPhone Body 17 pt / Mac 14 px) | each platform's reading distance and standard; the roles and line heights are shared |
| A6 | Press targets 44 pt / 32 px | finger vs pointer |
| A7 | Link status (接続中 etc.) only on the iPhone | the Mac app is the other end itself |
| A8 | Photo limits (the iPhone shrinks to 384 KB; the Mac allows 5 MB) | the relay carries the iPhone's photo in 8 KB parts; the Mac sends locally |
| A9 | The iPhone reads aloud when locked or in the background and speaks some notices (聞き取れませんでした); haptics; Action button and lock-screen talk | phone-only abilities |
| A10 | Keyboard shortcuts (Esc closes the Mac window) | the Mac has a hardware keyboard |

## 11. Differences today and what to do

Measured 2026-10-27; screenshots are on the Canvas 「チャットの違い」. Action:
**iOS** = make the Mac like the iPhone; **Mac** = make the iPhone like the Mac;
**新** = new on both; **可** = may differ (§10); **C** = owner's choice.

| # | Item | iPhone now | Mac now | Action |
|---|---|---|---|---|
| D01 | Colours | white / black, blue accent | warm paper / ink, vermilion accent | C1 |
| D02 | Bubbles | own pale blue, reply pale grey, radius 23 | own bubble (radius 12/12/4/12), reply plain text | C6 |
| D03 | Text size / line height | Body 17 pt, about 1.5 | 14 px, 1.625 | 可 (size) + 新 (1.5 on both) |
| D04 | Header | menu · Mark + name · call | name only | C2 |
| D05 | Call key position | header right | composer right (when empty) | C2 |
| D06 | Composer | 「メッセージ」, +, mic ⇄ send, grows to 5 lines | 「話しかける…」, photo · mic · call ⇄ send in a row, 1 line | iOS for the words, + and 5 lines; the keys follow C2 |
| D07 | Talking to presidents | partner sheet, one conversation each | assistant only (president = terminal seat) | C3 |
| D08 | Name and colour editing | none (shows the Mac's) | Mark button left of the composer | iOS (moves to Settings) |
| D09 | Dictation | tap / tap, 90 s limit, 「話す」, says 聞き取れませんでした | tap / tap, no limit, 「声で入力」, typing takes over | 新 (§9.2) |
| D10 | Photos | + → choose / paste; shows only 「写真」 in the talk | button → file; shows the photo | 新 (wire) |
| D11 | Call screen | full screen; 話す · 終了 · 消音; 会話に戻る; ongoing bar; 5-min hang-up | inside the window; スピーカー · 終了 · 消音; closing ends the call | iOS |
| D12 | 「スピーカー」 | output route, only with earphones | read aloud on / off for the call | iOS (the Mac key goes; per-line stop instead) |
| D13 | Words printed on controls | names under the call keys; 「タップで入力欄へ」 while listening | tooltip only (owner rule, CLAUDE.md) | C4 |
| D14 | Voice | VOICEVOX Nemo / 冥鳴ひまり / iPhone | VOICEVOX Nemo / 冥鳴ひまり / Mac (2026-10-27; English lines in the system voice) | C5 (built 2026-10-27) |
| D15 | When it reads aloud | call, locked, background | call only | 可 (A9) |
| D16 | Proposal frames | kind label; scrolls when long; 4 closed words | no kind label; cut with 「長いので社長に頼んでね」; closed = check + project · title, no word | iOS (wire) |
| D17 | Thinking | Mark only | Mark + interim line | Mac (wire) |
| D18 | A line that did not go | 「未送信」 under the bubble; the field is already cleared; the reason is spoken; failed lines pile up at the bottom, no resend / delete | red reason line; the text goes back into the field | 新 (§5b, 2026-10-30) |
| D28 | Thinking for a president | none (only the assistant) | no president chat ([C3]) | 新 (§5b: replying shows the thinking row for every partner) |
| D19 | Empty conversation | heading + 3 shortcuts | composer only | 可 (A4) |
| D20 | Link status | under the name | none | 可 (A7) |
| D21 | Fold | none | folds to the last exchange | 可 (A3) |
| D22 | Call receipts in the talk | 「通話 1:42」 with a phone mark | a plain own bubble with the stored text | iOS |
| D23 | Words | §8 | §8 | 新 (shared file) |
| D24 | Keyboard | return sends, Space = mic | Enter sends (IME-safe), Esc closes, Space stops the reading in a call | 新 (§4) |
| D25 | Where the identity colour is used | lights the call key only during a call | fills the call / send key | iOS |
| D26 | Window / screen size, press targets | | | 可 (A2, A6) |
| D27 | End of a turn in a call | fixed 1.2 s pause after the voice stops | by how the words end: 0.5 s / 1.4 s / 0.8 s after the last word (owner-tuned 2026-10-07) | Mac (§9.3) |

Owner's choices (on the Canvas): **C1** palette · **C2** where the call key
lives, and with it the header and the composer's keys · **C3** presidents as a
chat on the Mac · **C4** words printed on controls (names under the call keys,
「タップで入力欄へ」) against the owner's rule "tooltip only" · **C5** the voice (built 2026-10-27, docs/ASSISTANT_DESIGN.md §1 "Voice") ·
**C6** whether replies get a bubble on both.

## 12. The shared file (design; built by the next card)

Goal: colours, sizes and words live in ONE file, each app's constants are
generated from it, and drift is caught by checks that have been seen to go red.

### 12.1 The file

`spec/chat/chat-spec.json` **in this repo**. This repo already holds the
contracts the iPhone builds against (this document and PHONE_LINK.md).

```json
{
  "version": 1,
  "colors":  { "plane": { "light": "#F1F1F1", "dark": "#232323" } },
  "type":    { "body": { "ios": { "style": "body", "weight": "regular" },
                         "mac": { "step": "ui", "weight": 400 }, "lineHeight": 1.5 } },
  "size":    { "bubbleRadius": { "ios": 23, "mac": 18 } },
  "icons":   { "send": { "sf": "arrow.up", "lucide": "ArrowUp" } },
  "strings": { "composer.placeholder": { "ja": "メッセージ", "en": "Message" } }
}
```

- `version` goes up by one on every change; the pair cards cite it.
- Keys are the role names of §6, §7 and §7b and the word keys of §8.
- Only what both screens share goes here. Platform-only values (window size, haptics) stay in each app.
- Mac type uses the app's step names (`ui`, `meta`, `title`), never raw pixels.

### 12.2 Generators (one script, two outputs)

`scripts/chat-spec/gen.mjs` (Node, no dependencies), in this repo:

| Target | Output | Consumed by |
|---|---|---|
| `--target web` | `src/generated/chatSpec.css`: `:root { --chat-plane: 241 241 241; … }` and `html[data-theme='dark'] { … }`. Values are **space-separated RGB channels**, as every app token is (globals.css), so Tailwind's `rgb(var(--chat-plane) / <alpha-value>)` and opacity modifiers work; the generator converts the JSON's hex. `src/generated/chatSpec.ts`: type roles, sizes, icon names, and `chatWords.ja` / `chatWords.en`, spread into the i18n `misc.assistant` namespace (`src/i18n/messages/misc.ts`) | Tailwind `chat-*` colours, the assistant components |
| `--target ios --out <dir>` | `ChatSpec.swift`: `enum ChatColor` (dynamic `UIColor` light/dark, replacing `App/Palette.swift`), `enum ChatType` (text styles + line spacing), `enum ChatSize`, `enum ChatIcon`, and `enum ChatWord` keys. `ChatSpec.xcstrings`: a **dedicated** String Catalog table (not `Localizable`), every entry `"extractionState": "manual"`, `ja` as the source language (`project.yml` sets `developmentLanguage: ja`) and `en`. Views read `Text(LocalizedStringKey(ChatWord.send), tableName: "ChatSpec")`. A separate table keeps Xcode's build-time string extraction from writing the app's other literals into the generated file | the iPhone app |

Colours and contrast: the chat tokens join `src/themePalette.test.ts`, so the
text / surface pairs in §7b are held to the same contrast floor as the app's
own tokens. If [C1] = B (the Mac palette), the JSON repeats values that also
live in globals.css as `--og-*`; a test pins each chat value to its `--og-*`
twin, so a change in one place without the other goes red.

Every generated file starts with a header: `generated from chat-spec.json
v<version> spec-sha256:<hash of the JSON> body-sha256:<hash of this file below
the header> — do not edit`.

The iPhone repo keeps a copy: `Spec/chat-spec.json` + `App/Generated/` (both
committed, so the iPhone builds without this repo). It refreshes them with
`scripts/chat-spec-sync.sh`, which copies the JSON and runs
`node "$OG_REPO/scripts/chat-spec/gen.mjs" --target ios --out App/Generated`
(`OG_REPO` defaults to the sibling checkout).

### 12.3 Catching drift

Each check's implementing card measures its red before it counts
(docs/VERIFICATION.md: break the thing on purpose, see red, restore, see green).

1. **Stale or hand-edited generation, this repo**: `src/generated/chatSpec.test.ts` regenerates in memory and compares byte for byte with the committed files. Red when the JSON changed without regenerating, or when a generated file was edited by hand.
2. **Hard-coded values, this repo**: a guard test asserts that the assistant components hold no hex colour and no Japanese literal, so their words come from the generated table. Red is measured by planting one literal.
3. **Stale or hand-edited generation, iPhone repo**: an XCTest in `Core/Tests` reads `Spec/chat-spec.json` and the files in `App/Generated/` **by path** (Core is a SwiftPM package and cannot import the app target), and checks both header hashes: the JSON's hash, and the hash of each file's own body. A hand edit to `ChatSpec.swift` or `ChatSpec.xcstrings` changes the body hash and goes red.
4. **The two repos apart**: `scripts/chat-spec/check-ios.mjs <ios checkout>` here first runs `git fetch origin main` in the iPhone checkout (a stale ref would say "nothing differs"), then compares this repo's JSON with the iPhone's `Spec/chat-spec.json` at `origin/main` and prints the keys that differ, with a non-zero exit. The commander runs it when integrating either card of a chat pair; the pair is done only when it exits 0. A CI job in the iPhone repo that fetches this repo's JSON needs a read token for a private repo; that is left for later, and the local check needs no secret.

Not adopted: generating one side from the other's code (parsing Swift into CSS
or back) is brittle; a web view for the iPhone chat (owner, above).

## 13. Sources

- Apple HIG Typography (Dynamic Type sizes; body 17 pt, minimum 11 pt), Buttons (44 × 44 pt), Writing and Alerts: https://developer.apple.com/design/human-interface-guidelines/typography . WWDC23 10058 (language-aware line height, Japanese line breaking). Both as collected in `openground-ios/docs/REDESIGN.md` 「下調べ(出典)」 (2026-10-04).
- W3C JLREQ (kinsoku 3.1.7–3.1.8; line gap ½–1 em; about 40 characters per line; ¼ em between Japanese and Latin): https://www.w3.org/TR/jlreq/ . Also CSS Text 3 `line-break` and Chrome `word-break: auto-phrase`.
- CSS `text-autospace`, Baseline 2025: https://developer.mozilla.org/en-US/docs/Web/CSS/text-autospace (fetched 2026-10-27; the page gave no Chrome version number). Electron 31 per `package.json`.
- Words: Apple Support ja-jp (iPhone Phone: 消音・スピーカー・終了・ペースト), LINE guide (再試行), SmartHR writing guide (buttons without 「する」, errors say how to fix). All from the same REDESIGN.md section.
- String Catalog (`.xcstrings`, Xcode 15+, JSON; `tableName`, `extractionState`): https://developer.apple.com/documentation/xcode/localizing-and-varying-text-with-a-string-catalog 【資料取得できず: the page body did not load on 2026-10-27. These format facts come from prior knowledge, and the implementing card must check them】.
- Today's state: iPhone `openground-ios` origin/main 078f1e2 (`App/ContentView.swift`, `CallView.swift`, `ProposalFrames.swift`, `Palette.swift`, `Core/Sources/PhoneLinkCore/Lines.swift`); Mac this repo (`src/components/assistant/*`, `src/i18n/messages/misc.ts` `misc.assistant.*`, `src/app/globals.css`, `tailwind.config.ts`).

// deskDeliverable — MAY a line be typed into this desk right now?
//
// The load-bearing safety property of every engine→desk write channel, kept in a
// LEAF module (its only imports are the two pure screen readers) for two reasons:
//
//   1. PURITY. It is assertable against a frame literal — no PTY pool, no
//      registered project, no engine. Every test of every channel that uses it
//      gets to be a string test.
//   2. NO CYCLE. Three channels now need it — the commander's notice
//      (swarmOrchestrator), the supply desk's early compaction
//      (supplyContextCap) and the supply desk's notice channel (supplyNotice) —
//      and the last of those is called FROM swarmNotifications, which
//      swarmOrchestrator imports. Left in swarmOrchestrator the predicate would
//      force supplyNotice → swarmOrchestrator → swarmNotifications →
//      supplyNotice. Extracting it is what keeps the one safety rule in ONE
//      place instead of being re-typed per channel, which is how two channels
//      end up disagreeing about when a desk is safe to write to.
//
// (Moved out of swarmOrchestrator.ts on 2026-09-22 with the supply notice
// channel. swarmOrchestrator still re-exports it, so every existing import site
// and test is untouched.)

import { isGenerating, readInputBoxText } from '@/lib/claudeScreen'
import { detectMenu } from '@/lib/claudeMenu'

/** MAY a notice be typed into this screen right now?
 *
 *  Three refusals, and together they are what stands in for a nudge's ESC:
 *
 *    1. NOT GENERATING — {@link isGenerating}, the same probe the ctx gauge's manual
 *       compact button already gates on in production (claudeSlash.ts). A pure
 *       negative: an unreadable or unfamiliar footer degrades to "not busy", so the
 *       worst case is the keystroke the owner would have typed themselves, never a
 *       sensor that goes quiet. Verified against a LIVE commander desk before this was
 *       written (2026-07-27): waiting ⇒ false, mid-turn ⇒ true, Japanese sitting unsent
 *       in the box ⇒ false — including when the box wraps to three rows, and when the
 *       literal footer phrase is typed into the box.
 *    2. INPUT BOX EMPTY — and empty as a POSITIVE reading, `=== ''`, never `null`.
 *       A desk holding half-typed text would otherwise have our line CONCATENATED onto
 *       it and the two submitted together — exactly the damage a nudge's ESC exists
 *       to pre-empt, and exactly what these channels promise not to do. `null` means no
 *       input box could be found on the frame at all (a desk still booting, or one
 *       caught mid-repaint), and writing into that lands the text in a shell prompt or
 *       in claude's own launch line. No box read ⇒ no evidence ⇒ do not write.
 *    3. NO MENU OPEN — {@link detectMenu}, the same numbered-option detector the pool
 *       already runs to drive a pane's `menuOpen` status (terminal.ts). While a chooser
 *       is up (`/model`, a theme picker, a trust dialog) the TUI reads keystrokes as
 *       SELECTION, so our line-plus-CR would not be a message at all — it would pick
 *       whatever option the cursor sits on and confirm it. That is the one way these
 *       channels could still do damage while satisfying (1) and (2), and it is not
 *       hypothetical: a menu frame has no reason to also lack an input box.
 *
 *  All three refusals mean the SAME thing to the caller — "not now" — and none loses the
 *  notice: it stays queued and the next pass asks again. */
export const noticeDeliverable = (screen: string | null | undefined): boolean =>
  !isGenerating(screen) && readInputBoxText(screen ?? '') === '' && detectMenu(screen ?? '') === null

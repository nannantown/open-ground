// The floating assistant's window owns the keys typed inside it. The app's own
// CAPTURE-phase Esc handlers (Board drawer, Canvas tool/selection, placement
// ghost) run before the window's listener — it subscribes only once the window
// opens, i.e. later — so each of them must step aside for a key that comes
// from inside the window. One test, here, so they cannot drift apart (and so
// none of them has to import the whole FloatingAssistant for an attribute).

/** Marks the assistant's talk window (FloatingAssistant). */
export const ASSISTANT_WINDOW_ATTR = 'data-og-assistant'

/** True when a key/pointer target sits inside the assistant's window. */
export const isInAssistantWindow = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest(`[${ASSISTANT_WINDOW_ATTR}]`) !== null

/** CSS variable (on <html>) the agent-team bar pads its right edge by while the
 *  assistant's character sits at its default bottom-right spot — set and
 *  cleared by FloatingAssistant, read by SwarmBottomBar. Here so the bar does
 *  not import the whole FloatingAssistant for a name. */
export const ASSISTANT_RESERVE_VAR = '--og-assistant-reserve'
/** Its height counterpart: how far up from the window's bottom edge the
 *  character (plus a gap) reaches. A project screen keeps a floor that tall
 *  free under its tab content (the team bar counts towards it), so no tab's
 *  bottom-right control (the Board drawer's Run, Canvas undo/redo) sits
 *  under the character. */
export const ASSISTANT_RESERVE_Y_VAR = '--og-assistant-reserve-y'

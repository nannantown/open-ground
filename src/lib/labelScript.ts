/**
 * Which tracking a caption should carry, decided by the STRING rather than by
 * the UI language.
 *
 * `.label-cap` / `.coord-label` are the mock's Latin small-caps plates: 10px,
 * uppercase, 0.18em. That tracking is what makes them read as engraved labels —
 * and it is also what breaks Japanese, which has no word boundaries, so a
 * caption widened by a third simply folds character by character (owner report
 * 2026-08-04: 「業 務 モ ー ド」, 「オ / フ」).
 *
 * For captions that come from `t()`, `html:lang(ja)` in globals.css settles it:
 * when the UI is Japanese the caption is Japanese. But a slot showing a name the
 * USER typed — a custom tab, a project, a canvas page — carries whatever script
 * they used, in either UI. Language is the wrong axis there; script is the right
 * one. Hence this: ask the text.
 */

// Kana, CJK ideographs (incl. Ext-A), and full/half-width forms. Deliberately
// broader than "Japanese": any of these widen under Latin tracking.
// Written as escapes, not literals: the range opens on U+3000 IDEOGRAPHIC
// SPACE, which eslint cannot tell from a stray one (no-irregular-whitespace).
const CJK =
  /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/

/**
 * Returns the class that pins tracking for a `.label-cap` / `.coord-label` slot
 * whose content is not known at build time. Always returns one or the other —
 * never an empty string — so the slot never falls through to the `:lang()` rule
 * and start behaving differently because the user switched UI language.
 */
export const capTrackingClass = (text: string): string =>
  CJK.test(text) ? 'label-cap-flat' : 'label-cap-latin'

# Canvas Text Sizing — Figma-parity resize modes (Design & Contract)

Status: CONTRACT. This doc + the same commit's `types.ts`,
`canvasTextSizing.ts` (+ test), and `canvasBounds.ts` fix are the shared seam
between the two implementation tracks. Implement against THIS; don't re-derive
the mode logic.

## The bug we're fixing

Selecting a short text shows a wide ~300×44 box detached from the glyphs. Cause:
the text RENDERS content-sized (`ElementView` `inline-block`) but every
bounds consumer special-cased `text` to a hardcoded **300×44**:

- `canvasBounds.ts` `elementSize` (now fixed in this commit → `el.width ?? TEXT_W`)
- `InfiniteCanvas.tsx` `fullBounds` (line ~2696), an inner bounds fn (~1322),
  the marquee hit-test (~2458/2466) — **Track B fixes these**
- `canvasAutoLayout.ts` already reads `el.width ?? TEXT_W` (correct; leave)

Only **layout-frame** texts ever measured their real size
(`isLayoutManagedText`); free texts never did, so they stayed at 300×44
everywhere. The fix: **every text persists its measured footprint**, and the
bounds consumers read it.

## The three modes (Figma's textAutoResize)

| mode | width | height | wrap | overflow |
|---|---|---|---|---|
| `auto-width` (default) | measured | measured | none (`pre`) | n/a (hugs) |
| `auto-height` | **authoritative** (drag) | measured | wraps (`pre-wrap`) | n/a (grows) |
| `fixed` | authoritative | authoritative | wraps | **clipped** + vertical align |

`undefined` sizing = `auto-width` (legacy + new default). The pure module
`src/lib/canvasTextSizing.ts` is the SINGLE source of truth:

- `textSizingOf(el)` / `textVAlignOf(el)` — resolve with defaults
- `measuresWidth(mode)` / `measuresHeight(mode)` — which axes are measured
- `textBox(el)` → `{w,h}` — the box for bounds/selection/hit-test (`el.width ?? TEXT_W`…)
- `textMeasurePatch(el, w, h)` — the width/height patch a measurement may
  persist (only the measured axes for the mode; quantised to 2px; null when
  fixed / zero / no-op). **Supersedes `textFootprintPatch`.**
- `convertSizing(el, to, measured)` — inspector mode-switch fields (keeps the
  box put)
- `resizeOutcome(mode, handle, w, h)` — resize-drag → mode transition

## Track ownership (disjoint files — worktree isolated)

**Contract (this commit):** `types.ts`, `canvasTextSizing.ts` (+test),
`canvasBounds.ts`, this doc.

### Track A — rendering + measurement (`src/components/canvas/ElementView.tsx` ONLY)

The text branch renders all three modes and reports the real box for EVERY text
(today it only renders auto-width and the parent gates measurement to layout
texts):

1. **auto-width** (current behaviour): `inline-block`, `whitespace: pre`, hugs
   content. Keep.
2. **auto-height**: outer box `width: el.width`, `whitespace: pre-wrap` (wrap),
   height auto (content). The editing `textarea` uses `wrap="soft"` and the
   invisible sizer wraps at the same width.
3. **fixed**: `width: el.width; height: el.height; overflow: hidden`,
   `whitespace: pre-wrap`; a flex column applies `textVAlignOf(el)`
   (top/middle/bottom). The editing textarea fills the box (`wrap="soft"`,
   `overflow:hidden`).
4. **Measurement for ALL texts**: the `measureRef` must wrap the box whose
   `offsetWidth/Height` equals the real footprint for the mode (auto-width:
   content box; auto-height: the `width:el.width` wrapping box so height is the
   wrapped height; fixed: no measurement needed — fine to still observe, the
   patch returns null). The component already reports via `onMeasure` when the
   prop is set; Track A's job is to make the observed node correct per mode.
   Track A does NOT change who receives `onMeasure` (that's the parent / Track
   B), but MUST keep calling `onMeasure(offsetW, offsetH)`.
5. Editing parity: the invisible sizer + textarea must match the idle render's
   wrap/width per mode so the box doesn't jump when entering/leaving edit. IME:
   keep the existing textarea behaviour (no value round-trip that interrupts
   composition); Cmd/Ctrl+Enter ends edit, Enter inserts newline.

Track A imports `canvasTextSizing.ts` + `canvasTextStyle.ts`. It must not touch
InfiniteCanvas/Inspector. Tests: a jsdom ElementView spec per mode (render
shape: wrap, width application, vertical align) — ResizeObserver is stubbed.

### Track B — interaction + inspector (`InfiniteCanvas.tsx` + `SelectionInspector.tsx`)

1. **Bounds read real size**: replace every text `→ 300×44` site (fullBounds
   ~2696, inner bounds ~1322, marquee hit-test ~2458/2466) with `textBox(el)`.
   The creation hit-test at ~1397 may keep TEXT_W/TEXT_H as the pre-measure
   probe.
2. **Measurement persistence**: today `measuredTextIds` gates to layout texts
   and the flush uses `textFootprintPatch` + `isLayoutManagedText`. Change so
   `onMeasure` is passed for EVERY text, and the flush uses
   `textMeasurePatch(el, w, h)` (per-mode axes) for every text. Keep the
   microtask batching + the "derived write, no undo step" via
   `onImplicitElementsChange`. A layout-frame text still reflows siblings
   (`applyAutoLayout`) — that path stays.
3. **Creation gestures** (text tool):
   - **click** → auto-width text at the point, enter edit (current behaviour;
     `textSizing` left undefined = auto-width).
   - **drag a box** → `auto-height` text with `width` = the drag width (min
     ~24px), at the drag's top-left, enter edit. (Figma: drag-create = fixed
     width, grows down.) A tiny drag under the min collapses to a click
     (auto-width).
4. **Resize handles for text**: text is currently excluded from `resizeTarget`.
   Include text and present handles per mode:
   - auto-width: side (E/W) handles only;
   - auto-height: side handles + corner;
   - fixed: full corner + side handles.
   On drag end, apply `resizeOutcome(mode, handle, w, h)` (horizontal→auto-height,
   vertical/corner→fixed). Clamp to a sane min (≥ ~24×line-height). A
   **double-click on a resize handle** collapses back toward auto (fixed→
   auto-height via width keep, auto-height→auto-width) using `convertSizing`.
   While editing, no handles (matches other types).
5. **Inspector** (`SelectionInspector.tsx`): when a lone `text` is selected, add
   a **segmented control** Auto width / Auto height / Fixed
   (`TEXT_SIZING_MODES`), switching via `convertSizing(el, to, measuredBox)`;
   and a **vertical-align** row (top/middle/bottom) shown only for `fixed`.
   Reuse the existing typography-control styling. The measured box for
   `convertSizing` is `textBox(el)`.
6. i18n for any new inspector labels in the existing canvas message namespace
   (en/ja identical keys).

Track B imports `canvasTextSizing.ts`. Tests: pure-logic unit tests for the new
creation/resize wiring where extractable; the heavy lifting is covered by the
contract module's tests + the real-machine verification.

## Invariants (review checklist)

- A measurement never overwrites a user-set width (auto-height) or width+height
  (fixed) — enforced by `textMeasurePatch` returning only measured axes.
- No 300×44 special-case remains in any bounds/hit-test path (grep `TEXT_W`/
  `TEXT_H` in InfiniteCanvas after — only the creation probe + the const decl
  may remain).
- Selecting any text shows a box hugging the glyphs (auto modes) or the
  user box (fixed) — never a detached 300-wide rectangle.
- Legacy canvases (no `textSizing`) render identical to before: auto-width,
  content-hugging, and now with a correct selection box.
- Layout-frame text reflow still works (siblings move when text grows).
- IME composition is not interrupted; Enter = newline, Cmd/Ctrl+Enter = done.
- Quantise-to-2px keeps git-shared canvases from width/height churn.

## Out of scope

Rich text (per-span styling), max-width on auto-width, list/markdown, RTL,
truncation ellipsis (fixed just clips).

# Overlay shell — full-screen panels & modals

Every full-screen panel and modal surface in OPEN GROUND shares ONE shell so the
"chrome" (Back / Close / header / backdrop / z-index / position / Esc / scroll)
is defined in a single place and can't drift per-surface again.

**New full-screen or modal surface? Use these — never hand-roll `fixed inset-0
z-[n] bg-…` + a one-off header again.**

## The pieces

| component      | role                                                                 |
|----------------|----------------------------------------------------------------------|
| `Overlay`      | the root: position (`fixed`/`absolute`), z-layer, backdrop, the       |
|                | `data-esc-overlay` contract, Escape→close, backdrop-click-to-close    |
| `DialogCard`   | the centred modal "card" (paper bg, border, shadow, stops click bubbling) |
| `DialogHeader` | Back (left) · eyebrow + title · actions · Close ✕ (right), one separator + padding |
| `DialogBody`   | the scrolling content region (`min-h-0 flex-1 overflow-y-auto`)       |
| `CloseButton`  | the shared ✕ (on the `Btn variant="icon"` base)                       |
| `BackLink`     | the shared ‹ Back (re-exported; lives in `../BackLink`)               |

The z-index / backdrop / position tokens live in [`layers.ts`](./layers.ts) —
read its doc-comment for the layer scale (`hint`/`local`/`panel`/`modal`/`top`),
the `fixed` vs `absolute` rule, and the backdrop tones.

## Recipes

### Centred modal

```tsx
<Overlay onClose={onClose} aria-label={t('…')}>
  <DialogCard className="w-[560px] max-w-[94vw] max-h-[82vh]" ariaLabel={t('…')}>
    <DialogHeader
      eyebrow={t('thing.label')}
      title={projectName}
      onClose={onClose}
      closeLabel={t('common.close')}
    />
    <DialogBody className="px-6 py-4">…</DialogBody>
  </DialogCard>
</Overlay>
```

`Overlay` defaults to `layer="modal"`, `position="fixed"`, `backdrop="scrim"`,
`placement="center"`. Escape and a press on the backdrop both close it; the root
carries `data-esc-overlay` automatically.

### Full-screen panel

```tsx
<Overlay
  placement="fill"
  backdrop="surface"     // opaque bg-bg-card; use "paper" for bg-bg
  layer="panel"          // or "local" when rendered inside the project module
  position="fixed"       // or "absolute" for an in-module panel
  onClose={onClose}
>
  <DialogHeader
    density="panel"
    onBack={onClose}
    backLabel={t('common.back')}
    onClose={onClose}            // full-screen panels may show BOTH back + ✕
    closeLabel={t('common.close')}
  />
  <DialogBody className="px-6 py-10">…</DialogBody>
</Overlay>
```

### Destructive confirm

Use `backdrop="scrimStrong"` (heavier `bg-black/60`) to set it apart from a
routine modal.

## The three rules you must not break

0. **A press on the backdrop closes — on EVERY surface** (owner, 2026-08-17:
   「モーダル系はモーダル外をタップすると閉じる仕様にしてね。全部」). `Overlay` does this
   for you, and two details are load-bearing: it fires on **mousedown**, not
   click (a click fires on the common ancestor of press and release, so a text
   selection dragged out of a card would dismiss it mid-drag), and it fires only
   when the press **landed on the root itself**, so no child has to stop
   propagation and no placement is exempt. `Overlay.test.tsx` guards all three.
   If a new surface needs to opt out, `closeOnBackdrop={false}` is the only way —
   don't hand-roll a scrim.

1. **`data-esc-overlay`.** App's global Escape handler (`src/App.tsx`) clears the
   Ground selection — which *is* how the project panel closes. So when ANY overlay
   is open it must claim the Escape, or pressing Esc inside it would also close the
   panel beneath. `Overlay` sets `data-esc-overlay` for you. The one exception is
   the **main `ProjectPanel`**, whose own close path *is* that selection-clear — it
   passes `escOverlay={false}` so it does NOT claim the Escape.

2. **`min-h-0` on scroll bodies.** Inside a flex column, a scroll region needs
   `min-h-0` or it grows to fit its content and shoves the fixed header off-screen.
   `DialogBody` bakes this in; don't reintroduce a raw `overflow-y-auto` div.

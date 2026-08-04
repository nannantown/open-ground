import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { capTrackingClass } from './lib/labelScript'

// ─── THE LATIN SMALL-CAPS PLATES vs 和文 (2026-08-04) ────────────────────────
//
// 案C's captions are engraved plates: 10px, uppercase, 0.18em. The tracking is
// the whole look — and it is also why Japanese folded. 和文 has no word
// boundaries, so a caption widened by a third does not wrap at a space, it
// stacks character by character: 「業 務 モ ー ド」, 「オ / フ」, 「判断 / 待ち」.
//
// Three things went wrong, and only the first was visible in a screenshot:
//   1. 和文 under Latin tracking folds.
//   2. `.coord-label` got no override when `.label-cap` got one — the same bug
//      surviving in the class next door.
//   3. Four call sites declared `tracking-[0.16em]` on a `.coord-label` element
//      and NONE of it applied. Tailwind utilities are emitted at `@tailwind
//      utilities` (globals.css line 5); `.coord-label` is declared at line ~292.
//      Equal specificity (0,1,0) → the later rule wins → the utility was dead.
//      Nothing failed. The declared value and the rendered value simply differed.
//
// (3) is the dangerous one, because it is invisible in review AND in the browser
// (the text looks fine — just not the way the code says). So this file checks
// the CASCADE, not the appearance: a rule that cannot win is a rule that lies.

const cssPath = resolve(__dirname, 'app/globals.css')
const css = readFileSync(cssPath, 'utf8')

/** The named steps of the type scale (tailwind.config.ts → theme.extend.fontSize). */
const SIZE_TOKEN = /\btext-(plate|micro|meta|ui|read|title|head|hero)\b/

/** The Latin small-caps plate classes — anything with `letter-spacing` meant for Latin. */
const PLATES = ['label-cap', 'coord-label'] as const

/** (id, class, element) — enough to compare the selectors in this file. */
const specificity = (selector: string): [number, number, number] => [
  (selector.match(/#[\w-]+/g) ?? []).length,
  (selector.match(/\.[\w-]+/g) ?? []).length + (selector.match(/:lang\([^)]*\)/g) ?? []).length,
  (selector.match(/(^|[\s>+~])[a-z]+/gi) ?? []).length,
]

const gt = (a: [number, number, number], b: [number, number, number]) =>
  a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2]

const ruleFor = (selectorNeedle: string): { selector: string; body: string } | null => {
  const i = css.indexOf(selectorNeedle)
  if (i === -1) return null
  const open = css.indexOf('{', i)
  return { selector: css.slice(i, open).trim(), body: css.slice(open, css.indexOf('}', open)) }
}

describe('Latin small-caps plates do not fold 和文', () => {
  it.each(PLATES)('.%s has a :lang(ja) override that drops the tracking', (plate) => {
    // Over-approximate on purpose: a plate is DEFINED with Latin tracking, so
    // the override must exist. Adding a third plate class without one is the
    // exact shape of the `.coord-label` miss — this fails the day it appears,
    // rather than the day someone screenshots it.
    const base = ruleFor(`.${plate} {`)
    expect(base, `.${plate} is declared in globals.css`).not.toBeNull()
    expect(base!.body, `.${plate} sets letter-spacing`).toMatch(/letter-spacing:/)

    const override = ruleFor(`:lang(ja) .${plate} {`)
    expect(override, `:lang(ja) .${plate} exists`).not.toBeNull()
    expect(override!.body).toMatch(/letter-spacing:\s*0\.0\d+em/)
  })

  it.each(PLATES)('the per-string override outranks the :lang rule for .%s', (plate) => {
    // `capTrackingClass()` decides tracking by SCRIPT for slots carrying user
    // text. If its rule does not outrank `:lang(ja) .plate`, a Latin tab
    // name in a Japanese UI stays flat and the plate is silently lost — the
    // failure is invisible, so it is pinned by computation here.
    const lang = ruleFor(`:lang(ja) .${plate} {`)
    expect(lang).not.toBeNull()
    for (const variant of ['label-cap-latin', 'label-cap-flat']) {
      const i = css.indexOf(`html .${plate}.${variant}`)
      expect(i, `html .${plate}.${variant} exists`).toBeGreaterThan(-1)
      const sel = `html .${plate}.${variant}`
      expect(
        gt(specificity(sel), specificity(lang!.selector)),
        `${sel} (${specificity(sel)}) must outrank ${lang!.selector} (${specificity(lang!.selector)})`,
      ).toBe(true)
    }
  })

  it.each(PLATES)('.%s-latin restores THAT plate\'s own tracking, not a shared one', (plate) => {
    // The two plates are engraved at different depths — .label-cap 0.18em at
    // 10px, .coord-label 0.08em at 9px. Giving both `-latin` variants one shared
    // value silently re-cuts one of them: measured 2026-08-04, the Ground card's
    // map coord came back at 1.62px against its designed 0.72px. "Opt back in to
    // the plate" has to mean THIS plate.
    const base = ruleFor(`.${plate} {`)!
    const latin = ruleFor(`html .${plate}.label-cap-latin {`)
    expect(latin, `html .${plate}.label-cap-latin exists as its own rule`).not.toBeNull()
    const ls = (body: string) => body.match(/letter-spacing:\s*([\d.]+em)/)?.[1]
    expect(ls(latin!.body), `matches .${plate}'s declared letter-spacing`).toBe(ls(base.body))
  })
})

// ─── DEAD TRACKING UTILITIES ────────────────────────────────────────────────

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.tsx')) out.push(p)
  }
  return out
}

describe('no call site declares a tracking that the cascade throws away', () => {
  it('never puts a `tracking-*` utility on a plate class', () => {
    // Tailwind utilities and the plate classes both land at specificity (0,1,0),
    // and the plates are declared AFTER `@tailwind utilities` in the same file —
    // so on a plate element the utility always loses. Writing one is therefore
    // never a change; it is a note to the reader that is false. Ban the shape.
    const offenders: string[] = []
    for (const file of walk(resolve(__dirname, 'components'))) {
      const src = readFileSync(file, 'utf8')
      src.split('\n').forEach((line, i) => {
        if (!/\btracking-\[/.test(line)) return
        if (!PLATES.some((p) => new RegExp(`\\b${p}\\b`).test(line))) return
        offenders.push(`${file.slice(file.indexOf('/src/') + 1)}:${i + 1}  ${line.trim().slice(0, 90)}`)
      })
    }
    expect(offenders, `these tracking utilities never applied:\n${offenders.join('\n')}`).toEqual([])
  })
})

describe('capTrackingClass decides by script, not by UI language', () => {
  it('flattens anything carrying kana or kanji', () => {
    for (const s of ['ペルソナ', 'メモ帳', '業務モード', 'Board（旧）', '設計', 'ＡＢＣ'])
      expect(capTrackingClass(s), s).toBe('label-cap-flat')
  })

  it('keeps the plate for Latin', () => {
    for (const s of ['BOARD', 'Canvas', 'Terminal', 'swarm', 'v0.11.65', 'A/B'])
      expect(capTrackingClass(s), s).toBe('label-cap-latin')
  })

  it('always returns one of the two — never falls through to :lang()', () => {
    // An empty string is a real case (a tab renamed to nothing). Returning ''
    // would hand the slot back to the language rule, which is the bug this
    // function exists to remove.
    for (const s of ['', ' ', '—'])
      expect(['label-cap-latin', 'label-cap-flat']).toContain(capTrackingClass(s))
  })
})

// ─── FIXED-FLOOR PILLS ──────────────────────────────────────────────────────

describe('a pill with a min-width floor never folds its own label', () => {
  it('every `min-w-[Npx]` text control also declares `whitespace-nowrap`', () => {
    // THE SHAPE THAT KEPT COMING BACK. Six segmented controls carried the same
    // defect (SettingsPanel ×2, SwarmManagerPane, SwarmPowerBar, CanvasWorkspace,
    // ProjectConfigFields) and only the one in the owner's screenshot was
    // noticed. The mechanism is always identical:
    //   `min-w-[44px]` reads like "this box is at least 44px", so nobody checks
    //   the label against it. But 44px minus `px-3` and a border is 18px of
    //   INNER width, and 「オフ」 is 24px. `min-w` is a floor on the BOX, not on
    //   the content — and Japanese, having no word boundaries, folds between any
    //   two characters rather than overflowing. English never does, so the bug is
    //   invisible in the language the CSS was written in.
    // Over-approximate deliberately: a `min-w-[Npx]` on anything that also sets
    // a font size is a pill, and a pill must pin its line. This is a lint the
    // cheap way — the alternative (measure every label in every locale against
    // every floor) is the thing that never gets done.
    //
    // ⚠ RE-AIMED 2026-08-04. This originally looked for `text-[Npx]`. The type
    // scale replaced all 678 of those with named steps, at which point the
    // pattern matched NOTHING and the test went permanently, silently green —
    // while the shape it guards was still present at 5 sites. A detector that
    // names the thing it hunts must be re-aimed in the same change that renames
    // it, and re-measured red. (Verified: reverting the nowrap on those 5 sites
    // fails this test.)
    const offenders: string[] = []
    for (const file of walk(resolve(__dirname, 'components'))) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (!/min-w-\[\d+px\]/.test(line)) return
          if (!SIZE_TOKEN.test(line)) return
          if (/whitespace-nowrap/.test(line)) return
          offenders.push(`${file.slice(file.indexOf('/src/') + 1)}:${i + 1}  ${line.trim().slice(0, 90)}`)
        })
    }
    expect(offenders, `pills that can fold their label:\n${offenders.join('\n')}`).toEqual([])
  })
})

// ─── HARDCODED LATIN UNDER A LANGUAGE RULE ──────────────────────────────────

describe('a plate whose text is hardcoded Latin keeps its plate in every UI', () => {
  it('every `.label-cap` / `.coord-label` with a literal Latin child opts out of :lang(ja)', () => {
    // MEASURED 2026-08-04, on the running app, in the default Japanese UI:
    //   Ground card 「Waiting」  letter-spacing 0.2px   (declared 1.8px)
    //   Ground card coord「J·34」letter-spacing 0.18px  (declared 0.72px)
    // `:lang(ja) .label-cap` is right for captions that come from t() — when the
    // UI is Japanese, so is the caption. It is WRONG for a slot whose text is an
    // English string literal in the source: Running / Waiting / Playing /
    // missing / esc / Comment / OPEN GROUND / the map coords. Those are Latin in
    // every UI, and flattening them deleted 案C's engraved plate from the
    // product's front page — silently, because no test looks at letter-spacing
    // and the text still fits.
    //
    // The rule can only be as good as its detection, so detect the SHAPE rather
    // than the meaning: a plate element with a bare `>Latin<` child must say
    // which script it is (`label-cap-latin`) instead of inheriting the language
    // rule. Slots whose child is an expression are out of scope here — those get
    // `capTrackingClass()` where the value can be either script.
    const LITERAL_CHILD = />\s*[A-Za-z][A-Za-z0-9 ·./+-]{0,24}\s*</
    const offenders: string[] = []
    for (const file of walk(resolve(__dirname, 'components'))) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!PLATES.some((p) => new RegExp(`\\b${p}\\b`).test(line))) return
        if (/label-cap-latin|label-cap-flat|capTrackingClass/.test(line)) return
        // the child may sit on this line or on one of the next few
        const window = lines.slice(i, i + 4).join('\n')
        if (!LITERAL_CHILD.test(window)) return
        offenders.push(`${file.slice(file.indexOf('/src/') + 1)}:${i + 1}  ${line.trim().slice(0, 90)}`)
      })
    }
    expect(
      offenders,
      `these Latin plates get flattened in the Japanese UI:\n${offenders.join('\n')}`,
    ).toEqual([])
  })
})

// ─── THE SCALE IS THE ONLY WAY TO NAME A SIZE ───────────────────────────────

describe('no component names a font size outside the scale', () => {
  it('never writes a raw `text-[Npx]`', () => {
    // How the 25 sizes happened: every one of them was one reasonable-looking
    // line. `text-[11.5px]` next to `text-[12px]` next to `text-[12.5px]` — each
    // defensible alone, collectively the reason the UI read as "not quite lined
    // up" (owner, 2026-08-04). The scale only stays a scale if nothing can be
    // added beside it, so the arbitrary form is banned outright rather than
    // discouraged in a doc nobody reads at the moment they need it.
    //
    // If a genuinely new step is needed, add it to tailwind.config.ts —
    // that is a decision worth making once and naming, which is the point.
    const offenders: string[] = []
    for (const file of walk(resolve(__dirname, 'components'))) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const m = line.match(/text-\[[\d.]+px\]/)
          if (!m) return
          offenders.push(`${file.slice(file.indexOf('/src/') + 1)}:${i + 1}  ${m[0]}`)
        })
    }
    expect(
      offenders,
      `sizes written outside the scale:\n${offenders.join('\n')}`,
    ).toEqual([])
  })

  it('the scale itself stays a ladder — every step strictly larger', () => {
    // A scale with a step out of order, or two steps at the same size, is an
    // accumulation wearing a scale's names. Read the real config.
    const cfg = readFileSync(resolve(__dirname, '../tailwind.config.ts'), 'utf8')
    const block = cfg.slice(cfg.indexOf('fontSize: {'))
    const steps = Array.from(block.matchAll(/(\w+):\s*\['(\d+)px'/g)).map((m) => ({
      name: m[1],
      px: Number(m[2]),
    }))
    expect(steps.length, 'the scale has steps').toBeGreaterThanOrEqual(6)
    for (let i = 1; i < steps.length; i++) {
      expect(
        steps[i].px,
        `${steps[i].name} (${steps[i].px}px) must exceed ${steps[i - 1].name} (${steps[i - 1].px}px)`,
      ).toBeGreaterThan(steps[i - 1].px)
    }
    // …and the floor holds. 13px is where 和文 stops being decoration and starts
    // being prose; `plate` and `micro` sit below it on purpose and carry only
    // Latin captions and numerals.
    expect(steps.find((s) => s.name === 'meta')?.px, 'meta is the prose floor').toBe(13)
  })
})

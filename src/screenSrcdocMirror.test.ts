import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ─── THE HAND-WRITTEN MIRROR (2026-08-04) ───────────────────────────────────
//
// `src/lib/screenSrcdoc.ts` builds the sandboxed iframe that renders generated
// UIs. It cannot import the app's Tailwind config or globals.css — the iframe is
// null-origin and gets its whole world in a string — so it carries a HAND COPY
// of both, under a comment that says "Kept in sync by hand".
//
// Kept in sync by hand is a promise, and it was already broken. 0.11.66 added
// the `:lang(ja)` rules that stop Japanese captions folding one character per
// line; measured on 2026-08-04, this file contained ZERO of them, and zero
// `label-cap-latin`. Generated UIs had been folding Japanese for as long as the
// app had stopped, with no error, no warning, and nothing that could notice.
//
// So: stop asking people to remember. Both sides are parsed here and compared.
// The check is deliberately an OVER-APPROXIMATION — it does not try to prove the
// two produce identical rendering, only that every value it can see agrees. A
// drift it cannot judge is reported as a drift.
//
// ⚠ AND THE FIRST VERSION OF THIS FILE GOT THAT WRONG. It asserted
// `mirror.includes(':lang(ja) .label-cap')` — the string is present, therefore
// the rule works. It did not work: the srcdoc templates emitted a bare `<html>`
// with no `lang`, so `:lang(ja)` matched nothing and 和文 kept its Latin
// tracking. Measured in a real frame: 1.76px, exactly as before the "fix".
// A test that greps for its own remedy will certify a broken product forever —
// which is the repo's own rule (「呼べる」ではなく「効く」を見る), violated by
// the very file written to enforce it. The rules below now check REACHABILITY:
// the language has to be declared, or the override cannot fire.

const src = (p: string) => readFileSync(resolve(__dirname, p), 'utf8')
const css = src('app/globals.css')
const mirror = src('lib/screenSrcdoc.ts')
const twConfig = readFileSync(resolve(__dirname, '../tailwind.config.ts'), 'utf8')

/**
 * Pull `name: ['11px', { lineHeight: '14px', letterSpacing: '0.16em' }],` rows.
 *
 * ⚠ `letterSpacing` is OPTIONAL, and that is load-bearing. It was mandatory in
 * the first version, so the hour the `plate` step dropped its tracking (a fix in
 * its own right — a size token must not carry a Latin-only style), `plate` fell
 * out of this regex on BOTH sides at once. The two objects still compared equal,
 * the `>= 6` floor was still satisfied by the seven survivors, and the suite went
 * green: the ONE step that commit edited became the one step this guard could not
 * see. A drift on it would have shipped silently.
 *
 * Two changes, because either alone is a coin-flip: the shape is now tolerant,
 * AND `declaredSteps()` reads the step NAMES structurally so the caller can
 * assert that everything declared was actually captured. A parser that quietly
 * skips what it cannot match is the same failure as a test that greps for its
 * own remedy — it reports on what it happened to see.
 */
const parseFontSizes = (text: string): Record<string, string> => {
  const start = text.indexOf('fontSize: {')
  if (start === -1) return {}
  const block = text.slice(start, text.indexOf('\n      },', start))
  const out: Record<string, string> = {}
  for (const m of Array.from(block.matchAll(
    /(\w+):\s*\['(\d+px)',\s*\{\s*lineHeight:\s*'(\d+px)'(?:,\s*letterSpacing:\s*'(-?[\d.]+em|0)')?\s*\}\]/g,
  ))) {
    out[m[1]] = `${m[2]}/${m[3]}/${m[4] ?? 'none'}`
  }
  return out
}

/** Every step NAME the file declares, read without caring about its shape. */
const declaredSteps = (text: string): string[] => {
  const start = text.indexOf('fontSize: {')
  if (start === -1) return []
  const block = text.slice(start, text.indexOf('\n      },', start))
  return Array.from(block.matchAll(/^\s*(\w+):\s*\[/gm)).map((m) => m[1])
}

/** Pull the declared size + tracking of a plate class from either file. */
const plateOf = (text: string, cls: string): { size?: string; tracking?: string } => {
  const i = text.indexOf(`.${cls} {`)
  if (i === -1) return {}
  const block = text.slice(i, text.indexOf('}', i))
  return {
    size: block.match(/font-size:\s*(\d+px)/)?.[1],
    tracking: block.match(/letter-spacing:\s*([\d.]+em)/)?.[1],
  }
}

describe('screenSrcdoc mirrors the real design tokens', () => {
  it('carries the SAME type scale as tailwind.config.ts', () => {
    const real = parseFontSizes(twConfig)
    const copy = parseFontSizes(mirror)
    expect(Object.keys(real).length, 'tailwind.config.ts declares a fontSize scale').toBeGreaterThanOrEqual(6)
    // FIRST: everything declared must have been captured. Without this, a step
    // whose shape drifts out of the parser's reach simply stops being compared,
    // and the comparison below passes on a subset while looking total.
    for (const file of [
      ['tailwind.config.ts', twConfig, real],
      ['screenSrcdoc.ts', mirror, copy],
    ] as const) {
      const [name, text, parsed] = file
      expect(Object.keys(parsed).sort(), `${name}: every declared step was parsed`).toEqual(
        declaredSteps(text).sort(),
      )
    }
    // THEN: same steps, same values. A step added to one side only is the exact
    // shape of the bug this file exists to catch, so compare the whole object.
    expect(copy).toEqual(real)
  })

  it.each(['label-cap', 'coord-label'])('copies .%s exactly from globals.css', (cls) => {
    const real = plateOf(css, cls)
    const copy = plateOf(mirror, cls)
    expect(real.size, `.${cls} declares a size in globals.css`).toBeDefined()
    expect(copy, `.${cls} in the mirror`).toEqual(real)
  })

  it.each(['label-cap', 'coord-label'])(
    'copies the :lang(ja) override for .%s — the half that went missing',
    (cls) => {
      // globals.css drops the Latin tracking for Japanese. Without the same rule
      // here, a generated UI folds 和文 exactly the way the app did before
      // 0.11.66 — and nothing anywhere would say so.
      const realHas = css.includes(`:lang(ja) .${cls}`)
      expect(realHas, `globals.css has :lang(ja) .${cls}`).toBe(true)
      expect(mirror.includes(`:lang(ja) .${cls}`), `mirror has :lang(ja) .${cls}`).toBe(true)
    },
  )

  it('declares a language on the frame, so those overrides can fire at all', () => {
    // THE HALF THAT WAS STILL MISSING after the copy above. A `:lang(ja)` rule
    // selects on the document's declared language; a srcdoc iframe is a separate,
    // null-origin document, so it inherits nothing from the app around it. With
    // `<html>` bare, every rule above is dead CSS that reads as a fix.
    const templates = Array.from(mirror.matchAll(/<!doctype html>\n<html([^>]*)>/gi)).map(
      (m) => m[1],
    )
    expect(templates.length, 'the file emits srcdoc templates').toBeGreaterThanOrEqual(1)
    for (const attrs of templates) {
      expect(attrs, `<html${attrs}> must declare a language`).toMatch(/\blang=/)
    }
  })

  it('copies the per-string opt-outs (label-cap-latin / -flat)', () => {
    for (const variant of ['label-cap-latin', 'label-cap-flat']) {
      expect(css.includes(variant), `globals.css declares ${variant}`).toBe(true)
      expect(mirror.includes(variant), `mirror declares ${variant}`).toBe(true)
    }
  })

  it('names no raw px size of its own', () => {
    // The starter template inside this file used to hand-write text-[34px] and
    // friends. Those bypass the scale entirely and cannot be found by the
    // sweep that rewrote the app, so they rot in place.
    const raw = Array.from(mirror.matchAll(/text-\[[\d.]+px\]/g)).map((m) => m[0])
    expect(raw, `raw sizes in the mirror: ${raw.join(', ')}`).toEqual([])
  })
})

// ─── A SIZE TOKEN IS NOT A STYLE ────────────────────────────────────────────

describe('the type scale carries no script-specific typography', () => {
  it('no step bakes in Latin small-caps tracking', () => {
    // `plate` shipped as ['11px', { …, letterSpacing: '0.16em' }] for about an
    // hour. 0.16em is not an optical correction, it is the engraved-caption LOOK
    // — and a size token applies to whatever text uses it, including Japanese,
    // which has no word boundaries and simply widens by a sixth. The classes
    // that own that look (.label-cap / .coord-label) can carry a `:lang(ja)`
    // escape; a generated utility cannot, because there is no selector for it.
    //
    // Optical corrections are fine and stay: the negative tracking large text
    // wants, and the hair of positive tracking small numerals want, are true of
    // both scripts. The line is drawn at 0.05em — above that it is a style.
    const LIMIT = 0.05
    for (const file of ['../tailwind.config.ts', 'lib/screenSrcdoc.ts']) {
      const text = readFileSync(resolve(__dirname, file), 'utf8')
      const block = text.slice(text.indexOf('fontSize: {'))
      for (const m of Array.from(
        block.matchAll(/(\w+):\s*\['(\d+)px'[^\]]*letterSpacing:\s*'(-?[\d.]+)em'/g),
      )) {
        expect(
          Math.abs(Number(m[3])),
          `${file} → ${m[1]} carries ${m[3]}em, which is a style, not an optical correction`,
        ).toBeLessThan(LIMIT)
      }
    }
  })
})

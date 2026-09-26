// Guard: no emoji / emoji-like pictographs in anything the app shows
// (owner decision 2026-09-26, CLAUDE.md "UI design principles": "Never emoji").
// Marks are lucide icons (or a custom SVG matching their stroke) — never a glyph.
//
// Over-approximating on purpose: every non-test source file under src/ is
// scanned with comments stripped, so a new screen / notification / manual
// string is covered without registering it anywhere. The only exemptions are
// files that must MATCH glyphs Claude Code itself prints (screen scrapers) or
// that only talk to the model — never to the owner.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO = join(__dirname, '..')
const SCAN_DIRS = ['src', 'server'] // server/dist is a build artefact — skipped in walk

// Whole-file exemptions: ONLY files whose every glyph is a claude-TUI parse
// target or model-only prompt text. Anything that also builds owner-facing
// strings must go in ALLOWED_CHARS instead, so its other strings stay checked.
const EXEMPT = new Set([
  'src/lib/claudeScreen.ts', // parses claude's TUI (❯ ⏺ ⚠ ✻ …)
  'src/lib/claudeMenu.ts', // parses claude's option menus (❯)
  'src/lib/server/swarmSpecialistReview.ts', // prompt text sent to the model
  'src/lib/server/transcript.ts', // readTranscript: model-facing digest, no UI caller
])

// Per-file allowance: these glyphs are removed before matching, nothing else is.
const ALLOWED_CHARS: Record<string, string> = {
  'src/lib/server/swarmEscalations.ts': '❯', // matches claude's prompt row; plainQuestion text is still checked
  'src/lib/server/terminal.ts': '❯', // detects claude's prompt row
}

// Emoji (Extended_Pictographic) + the dingbat / misc-symbol blocks that hold
// the text-style look-alikes (✓ ✕ ✦ ⛓ ⚠) + the emoji variation selector.
const EMOJI = new RegExp('[\\p{Extended_Pictographic}\\u2600-\\u27BF]|\\uFE0F', 'u')

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')

const walk = (dir: string, out: string[] = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name !== '__tests__' && name !== 'node_modules' && name !== 'dist') walk(p, out)
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(p)
    }
  }
  return out
}

export const emojiHits = (src: string, allowed = ''): string[] =>
  Array.from(allowed)
    .reduce((s, ch) => s.split(ch).join(''), stripComments(src))
    .split('\n')
    .filter(line => EMOJI.test(line))

describe('no emoji on screen', () => {
  it('detects the glyphs it exists to catch', () => {
    for (const g of ['🔧', '✓', '✕', '✦', '⛓︎', '⚠', '↗']) {
      expect(emojiHits(`const a = '${g} x'`)).toHaveLength(1)
    }
    // Keyboard glyphs and plain arrows are typography, not emoji.
    expect(emojiHits(`const a = '⌘K ⇧ → ←'`)).toHaveLength(0)
    expect(emojiHits(`// 🔧 in a comment\nconst a = 1 /* ⚠ */`)).toHaveLength(0)
    // A per-file allowance removes only its own glyph.
    expect(emojiHits(`const r = /^❯/`, '❯')).toHaveLength(0)
    expect(emojiHits(`const q = '❯ ⚠ x'`, '❯')).toHaveLength(1)
  })

  it('no source file under src/ or server/ renders an emoji', () => {
    const offenders: string[] = []
    for (const file of SCAN_DIRS.flatMap(d => walk(join(REPO, d)))) {
      const rel = relative(REPO, file).split('\\').join('/')
      if (EXEMPT.has(rel)) continue
      for (const line of emojiHits(readFileSync(file, 'utf8'), ALLOWED_CHARS[rel])) {
        offenders.push(`${rel}: ${line.trim().slice(0, 120)}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

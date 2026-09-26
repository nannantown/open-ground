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
import ts from 'typescript'
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

  // The shipped skills are the president's / commander's instructions, and
  // their report samples are copied into what the owner reads (a 🔴 from the
  // supply skill's sample reached the owner, 2026-09-26). Every line counts:
  // markdown has no "comment only" part the model would skip.
  it('no shipped skill under skills/ contains an emoji', () => {
    const offenders: string[] = []
    const md = (dir: string): string[] =>
      readdirSync(dir).flatMap(n => {
        const p = join(dir, n)
        return statSync(p).isDirectory() ? md(p) : /\.md$/.test(n) ? [p] : []
      })
    const files = md(join(REPO, 'skills'))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (EMOJI.test(line)) offenders.push(`${relative(REPO, file)}:${i + 1}: ${line.trim().slice(0, 120)}`)
      })
    }
    expect(offenders).toEqual([])
  })
})

// Guard: direction marks are chevrons only (owner decision 2026-09-26, CLAUDE.md
// "UI design principles"): no shafted-arrow lucide icon and no arrow glyph in any
// string that can reach a screen — UI, notification detail / logHint, native
// dialogs, Board card text. Over-approximating like the emoji guard: EVERY
// non-test .ts/.tsx under src/ and server/ plus electron/*.js is parsed, and a
// glyph is flagged per string literal. What never reaches a screen is exempt by
// its SHAPE, not by file: comments and regex literals (not string nodes), string
// arguments of a log call (LOG_CALL), and the exact model-/protocol-facing
// strings in ALLOWED_ARROW_TEXT — so a new arrow anywhere else in those files
// still fails. `e.key === 'ArrowLeft'` is a key name, not a glyph or an import.
const ARROW_ICON = /^((Arrow|Move|Corner|SquareArrow|CircleArrow)[A-Z]|(Shrink|Expand|Maximize2|Minimize2)(Icon)?$)/
// ⇧ (U+21E7) is the Shift key glyph in shortcut labels, not a direction mark.
const ARROW_GLYPH = new RegExp('[\\u2190-\\u21E6\\u21E8-\\u21FF\\u2794-\\u27BF\\u27F0-\\u27FF\\u2900-\\u297F\\u2B00-\\u2B2F\\u2B4E-\\u2B5F]', 'u')
// Callee of a call whose string arguments go to a log file, never to a screen.
const LOG_CALL = /^(logLine|logAwaited|selfUpdateLog|log|console\.\w+|ulog\.\w+)$/

// Exact text (a fragment of one string literal) that carries an arrow but never
// reaches a screen. Each entry: why it is not on screen.
const ALLOWED_ARROW_TEXT: Record<string, string[]> = {
  'src/lib/screenSrcdoc.ts': [
    'Unknown module → inert', // JS comment inside the iframe bootstrap source
    '→ strip the `export ` keyword', // same
  ],
  'src/lib/server/generateTaskTitle.ts': ['description → Japanese'], // model prompt
  'src/lib/server/swarmEscalations.ts': ['} → 司令官の回答', '} → オーナーの回答'], // answer relayed to the worker model
  'src/lib/server/swarmOrchestrator.ts': [
    "'差し戻し review→'", // REWORK_LOG_MARKER — frozen protocol constant
    'review→doing に戻されました', // rework order sent to the worker model
    "'card → blocked'", // engine-log note
  ],
  'src/lib/server/swarmSpecialistReview.ts': ["' → '"], // model prompt
  'src/lib/server/swarmWorker.ts': ['実装→WIPコミット→検証→git commit'], // worker prompt
  'src/lib/server/testHomeGuard.ts': ['} → homedir()'], // test-harness abort message
  'src/lib/server/transcript.ts': ['   ↳ ${'], // model-facing transcript digest
  'src/test/setup-home.ts': ['45 projects → 3'], // test-harness abort message
}

type Hit = string
export const arrowHits = (src: string, fileName = 'x.tsx', allowed: string[] = []): Hit[] => {
  const kind = /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, kind)
  const hits: Hit[] = []
  const inLogCall = (n: ts.Node) => {
    for (let p = n.parent; p; p = p.parent) {
      if (ts.isCallExpression(p) && LOG_CALL.test(p.expression.getText(sf))) return true
    }
    return false
  }
  const visit = (n: ts.Node) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text === 'lucide-react') {
      const named = n.importClause?.namedBindings
      if (named && ts.isNamedImports(named)) {
        for (const el of named.elements) {
          const name = (el.propertyName ?? el.name).text
          if (ARROW_ICON.test(name)) hits.push(`icon ${name}`)
        }
      }
      return
    }
    if (
      ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isJsxText(n)
    ) {
      const text = allowed.reduce((s, a) => s.split(a).join(''), n.getText(sf))
      if (ARROW_GLYPH.test(text) && !inLogCall(n)) {
        hits.push(`${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}: ${n.getText(sf).trim()}`)
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return hits
}

const arrowFiles = () => [
  ...SCAN_DIRS.flatMap(d => walk(join(REPO, d))),
  ...readdirSync(join(REPO, 'electron'))
    .filter(n => /\.c?js$/.test(n) && !/\.test\.c?js$/.test(n))
    .map(n => join(REPO, 'electron', n)),
]

describe('no shafted arrows on screen', () => {
  it('detects the icons and glyphs it exists to catch', () => {
    for (const g of ['←', '→', '↑', '↓', '↳', '⇐', '⇒', '➔', '⟳', '⟶']) {
      expect(arrowHits(`const a = '${g} x'`)).toHaveLength(1)
    }
    expect(arrowHits('const a = <b>↓ {x}</b>')).toHaveLength(1) // JSX text
    expect(arrowHits('const a = `${x} → ${y}`')).toHaveLength(1) // template span
    expect(arrowHits(`notify({ detail: '設定 → 更新' })`)).toHaveLength(1) // not a log call
    expect(arrowHits(`import { X, ArrowLeft } from 'lucide-react'`)).toEqual(['icon ArrowLeft'])
    expect(arrowHits(`import {\n  MoveRight as M,\n} from 'lucide-react'`)).toEqual(['icon MoveRight'])
    expect(arrowHits(`import { CornerDownLeft } from 'lucide-react'`)).toEqual(['icon CornerDownLeft'])
    expect(arrowHits(`import { Shrink, Expand, Minimize } from 'lucide-react'`)).toEqual(['icon Shrink', 'icon Expand'])
    // Not on screen: chevrons, key names, the Shift glyph, comments, regexes, log calls.
    expect(arrowHits(`import { ChevronLeft } from 'lucide-react'\nif (e.key === 'ArrowLeft') {}`)).toEqual([])
    expect(arrowHits(`const a = '⌘⇧Z › next'\n// ← comment\nconst r = /↑↓ to select/`)).toEqual([])
    expect(arrowHits('logLine(engine, \'warn\', `a → ${b}`)\nselfUpdateLog(\'info\', `x → y`)')).toEqual([])
    // An allowance removes only its own text; another arrow in the same string still fails.
    expect(arrowHits(`const m = 'review→'`, 'x.ts', ['review→'])).toEqual([])
    expect(arrowHits(`const m = 'review→ ← x'`, 'x.ts', ['review→'])).toHaveLength(1)
  })

  it('no screen-reachable string or icon in src/, server/ or electron/ is a shafted arrow', () => {
    const offenders: string[] = []
    for (const file of arrowFiles()) {
      const rel = relative(REPO, file).split('\\').join('/')
      for (const hit of arrowHits(readFileSync(file, 'utf8'), rel, ALLOWED_ARROW_TEXT[rel])) {
        offenders.push(`${rel}:${hit.slice(0, 140)}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

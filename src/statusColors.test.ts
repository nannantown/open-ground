import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// THE STATE VOCABULARY (owner decision 2026-09-27): 完了 = green + a check,
// 動作中 = blue, 指示待ち = yellow — the status-run / -done / -ask tokens in
// globals.css. Before this, the same states were moss / ochre / an eye / a
// grey icon depending on which surface you looked at, and the owner read them
// as different things.
//
// Every surface that draws one of the three states is listed here, and none of
// them may reach for the retired state colours. moss / ochre stay in the
// palette for non-state uses (usage gauges, warnings, diff tints), which is
// exactly why this check is per-file: a state surface that picks moss up again
// is repainting "running" green, silently.
const STATE_SURFACES = [
  'components/canvas/ProjectCard.tsx',
  'components/canvas/ProjectJumpPalette.tsx',
  'components/canvas/BoardCard.tsx',
  'components/canvas/BoardTab.tsx',
  'components/canvas/modules/SwarmSeatStrip.tsx',
  'components/canvas/modules/SwarmSeatHeader.tsx',
  'components/canvas/modules/SwarmWorkerSeat.tsx',
  'components/canvas/modules/SwarmManagerPane.tsx',
  'components/canvas/modules/SwarmSupplyPane.tsx',
  'components/canvas/modules/SwarmPowerBar.tsx',
]

const RETIRED = [
  /\b(?:bg|text|border|ring|shadow|from|via|to|fill|stroke)-(?:moss|ochre)\b/, // old running / waiting lamps
  /lamp-(?:moss|ochre)/,
  /beacon-waiting/,
  /\bEye\b/, // the review mark the owner found odd
]

describe('state surfaces speak only the three state colours', () => {
  it.each(STATE_SURFACES)('%s uses no retired state colour or mark', (file) => {
    const src = readFileSync(resolve(__dirname, file), 'utf8')
    // Comments may tell the history; only code is held to the rule.
    // An AlertTriangle is a caution mark (e.g. a retained worktree), not one of
    // the three states, and keeps its ochre.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/<AlertTriangle\b[^>]*>/g, '')
    for (const re of RETIRED) expect(code, `${file} matches ${re}`).not.toMatch(re)
  })

  // Absence alone passes an empty implementation (a lamp repainted grey would
  // be "no retired colour" too), so each surface must also SAY its states.
  // These files may keep ochre for cautions, so only the positive half applies.
  const MUST_SAY: Record<string, string[]> = {
    'components/canvas/BoardTab.tsx': ['bg-status-run shadow-lamp-run', 'bg-status-done shadow-lamp-done', 'bg-status-ask shadow-lamp-ask'],
    'components/canvas/BoardCard.tsx': ["working: 'bg-status-run", "done: 'bg-status-done", "claudeStatus === 'working' ? 'bg-status-run' : 'bg-status-ask'"],
    'components/canvas/modules/SwarmSeatStrip.tsx': ['bg-status-run ring-2', 'bg-status-ask ring-2'],
    'components/canvas/modules/SwarmSeatHeader.tsx': ["tone === 'run' ? 'text-status-run'", "tone === 'ask' ? 'text-status-ask'"],
    'components/canvas/modules/SwarmModule.tsx': ['<Hand size={12} strokeWidth={2} className="shrink-0 text-status-ask"', '<CircleCheck size={12} strokeWidth={2} className="shrink-0 text-status-done"'],
    'components/canvas/modules/SdkWorkerPane.tsx': ['bg-status-ask/10', 'text-status-ask'],
    'components/canvas/ProjectPanel.tsx': ['border-status-done/60', 'text-status-done'],
    'components/canvas/modules/SwarmPowerBar.tsx': ['border-status-run bg-status-run'],
  }
  it.each(Object.entries(MUST_SAY))('%s draws its states in the status colours', (file, needles) => {
    const src = readFileSync(resolve(__dirname, file), 'utf8')
    for (const n of needles) expect(src, `${file} lacks ${n}`).toContain(n)
  })

  it('the Ground card and the search list draw review as the green check', () => {
    for (const file of STATE_SURFACES.slice(0, 2)) {
      const src = readFileSync(resolve(__dirname, file), 'utf8')
      expect(src, file).toMatch(/CircleCheck[\s\S]{0,400}text-status-done|text-status-done[\s\S]{0,400}CircleCheck/)
      expect(src, file).toContain('bg-status-run')
      expect(src, file).toContain('text-status-ask')
    }
  })
})

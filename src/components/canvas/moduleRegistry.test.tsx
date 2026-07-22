import { describe, it, expect } from 'vitest'
import {
  MODULES,
  enabledModules,
  nativeDescriptors,
  isModuleEnabled,
  gateFromFlags,
  tabLabel,
} from '@/components/canvas/moduleRegistry'
import type { ExperimentFlags } from '@/lib/types'

// The experiment gate is the single visibility funnel: every surface (tab row,
// "+" picker, Ctrl+Tab) derives from enabledModules()/nativeDescriptors(), so
// gating there hides an experimental module everywhere. These pin that a gated
// module is INVISIBLE by default (the shipped / non-owner state) and appears
// ONLY when its experiment flag is open.

const ids = (mods: ReadonlyArray<{ id: string }>) => mods.map((m) => m.id)

// The all-closed gate, written once. Spread-and-override in each case so adding
// a future ExperimentId doesn't mean editing every literal in this file (and so
// a new flag defaults to CLOSED here, matching the shipped state).
const ALL_CLOSED: ExperimentFlags = { swarm: false, sandbox: false, persona: false }
const flags = (open: Partial<ExperimentFlags> = {}): ExperimentFlags => ({
  ...ALL_CLOSED,
  ...open,
})

describe('moduleRegistry experiment gate', () => {
  it('registers swarm as an experiment-gated module', () => {
    const swarm = MODULES.find((m) => m.id === 'swarm')
    expect(swarm).toBeTruthy()
    expect(swarm?.experiment).toBe('swarm')
  })

  it('registers persona as an experiment-gated module', () => {
    const persona = MODULES.find((m) => m.id === 'persona')
    expect(persona).toBeTruthy()
    expect(persona?.experiment).toBe('persona')
  })

  it('hides gated modules by default (no gate) — the shipped/non-owner state', () => {
    expect(ids(enabledModules())).toEqual(['board', 'canvas', 'terminal'])
    // The "+" picker draws from the same gated source — no leak there either.
    expect(ids(nativeDescriptors())).toEqual(['board', 'canvas', 'terminal'])
  })

  it('reveals a gated module only when its experiment is open', () => {
    const gate = gateFromFlags(flags({ swarm: true }))
    expect(ids(enabledModules(gate))).toContain('swarm')
    expect(ids(nativeDescriptors(gate))).toContain('swarm')
    // Always-on defaults are unaffected by the gate; persona stays hidden
    // because ITS flag is closed — one open experiment never opens another.
    expect(ids(enabledModules(gate))).toEqual(['board', 'canvas', 'terminal', 'swarm'])
  })

  it('opens persona independently of swarm', () => {
    const gate = gateFromFlags(flags({ persona: true }))
    expect(ids(enabledModules(gate))).toEqual(['board', 'canvas', 'terminal', 'persona'])
    expect(ids(nativeDescriptors(gate))).toContain('persona')
  })

  it('a closed flag keeps the module hidden', () => {
    expect(ids(enabledModules(gateFromFlags(ALL_CLOSED)))).not.toContain('swarm')
    expect(ids(enabledModules(gateFromFlags(ALL_CLOSED)))).not.toContain('persona')
  })

  it('the sandbox experiment gates NO tab module (it only changes how claude spawns)', () => {
    // Turning sandbox on must not reveal a tab — it is a launch-time wrapper, not
    // a module — so the enabled set is identical to the all-off default.
    expect(ids(enabledModules(gateFromFlags(flags({ sandbox: true }))))).toEqual([
      'board',
      'canvas',
      'terminal',
    ])
  })

  it('isModuleEnabled: always-on modules ignore the gate, gated ones require it', () => {
    const board = MODULES.find((m) => m.id === 'board')!
    const swarm = MODULES.find((m) => m.id === 'swarm')!
    const persona = MODULES.find((m) => m.id === 'persona')!
    expect(isModuleEnabled(board)).toBe(true)
    expect(isModuleEnabled(swarm)).toBe(false) // default gate is closed
    expect(isModuleEnabled(persona)).toBe(false)
    expect(isModuleEnabled(swarm, gateFromFlags(flags({ swarm: true })))).toBe(true)
    expect(isModuleEnabled(persona, gateFromFlags(flags({ persona: true })))).toBe(true)
    // Cross-check: persona's flag must not be satisfied by swarm's.
    expect(isModuleEnabled(persona, gateFromFlags(flags({ swarm: true })))).toBe(false)
  })
})

// The tab NAME resolution. A built-in with a `labelKey` is named from i18n in
// exactly one place (the tab row and the "+" picker both call tabLabel), so
// renaming it is a one-key edit — and a missing translation degrades to the
// built-in English label rather than showing a raw dotted key to the user.
describe('tabLabel', () => {
  const echoKey = (k: string) => k // what `t` does for an unknown key
  const translate = (map: Record<string, string>) => (k: string) => map[k] ?? k

  it('uses the plain label when the module has no labelKey', () => {
    expect(tabLabel({ label: 'Board' }, translate({ 'x.y': 'nope' }))).toBe('Board')
  })

  it('uses the translated string when the key resolves', () => {
    expect(
      tabLabel(
        { label: 'Persona', labelKey: 'persona.tabLabel' },
        translate({ 'persona.tabLabel': 'ペルソナ' }),
      ),
    ).toBe('ペルソナ')
  })

  it('falls back to the built-in label when the key is missing entirely', () => {
    expect(tabLabel({ label: 'Persona', labelKey: 'persona.tabLabel' }, echoKey)).toBe('Persona')
  })

  it('the persona module carries a labelKey (its name is a one-key edit)', () => {
    const persona = MODULES.find((m) => m.id === 'persona')!
    expect(persona.labelKey).toBe('persona.tabLabel')
    // …and it survives into the "+" picker's descriptor, so both surfaces show
    // the SAME name.
    const descriptor = nativeDescriptors(gateFromFlags(flags({ persona: true }))).find(
      (d) => d.id === 'persona',
    )!
    expect(descriptor.labelKey).toBe('persona.tabLabel')
  })
})

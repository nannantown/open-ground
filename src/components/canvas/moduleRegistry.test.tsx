import { describe, it, expect } from 'vitest'
import {
  MODULES,
  enabledModules,
  nativeDescriptors,
  isModuleEnabled,
  gateFromFlags,
} from '@/components/canvas/moduleRegistry'

// The experiment gate is the single visibility funnel: every surface (tab row,
// "+" picker, Ctrl+Tab) derives from enabledModules()/nativeDescriptors(), so
// gating there hides an experimental module everywhere. These pin that a gated
// module is INVISIBLE by default (the shipped / non-owner state) and appears
// ONLY when its experiment flag is open.

const ids = (mods: ReadonlyArray<{ id: string }>) => mods.map((m) => m.id)

describe('moduleRegistry experiment gate', () => {
  it('registers swarm as an experiment-gated module', () => {
    const swarm = MODULES.find((m) => m.id === 'swarm')
    expect(swarm).toBeTruthy()
    expect(swarm?.experiment).toBe('swarm')
  })

  it('hides gated modules by default (no gate) — the shipped/non-owner state', () => {
    expect(ids(enabledModules())).toEqual(['board', 'canvas', 'terminal'])
    // The "+" picker draws from the same gated source — no leak there either.
    expect(ids(nativeDescriptors())).toEqual(['board', 'canvas', 'terminal'])
  })

  it('reveals a gated module only when its experiment is open', () => {
    const gate = gateFromFlags({ swarm: true, sandbox: false })
    expect(ids(enabledModules(gate))).toContain('swarm')
    expect(ids(nativeDescriptors(gate))).toContain('swarm')
    // Always-on defaults are unaffected by the gate.
    expect(ids(enabledModules(gate))).toEqual(['board', 'canvas', 'terminal', 'swarm'])
  })

  it('a closed flag keeps the module hidden', () => {
    expect(ids(enabledModules(gateFromFlags({ swarm: false, sandbox: false })))).not.toContain('swarm')
  })

  it('the sandbox experiment gates NO tab module (it only changes how claude spawns)', () => {
    // Turning sandbox on must not reveal a tab — it is a launch-time wrapper, not
    // a module — so the enabled set is identical to the all-off default.
    expect(ids(enabledModules(gateFromFlags({ swarm: false, sandbox: true })))).toEqual([
      'board',
      'canvas',
      'terminal',
    ])
  })

  it('isModuleEnabled: always-on modules ignore the gate, gated ones require it', () => {
    const board = MODULES.find((m) => m.id === 'board')!
    const swarm = MODULES.find((m) => m.id === 'swarm')!
    expect(isModuleEnabled(board)).toBe(true)
    expect(isModuleEnabled(swarm)).toBe(false) // default gate is closed
    expect(isModuleEnabled(swarm, gateFromFlags({ swarm: true, sandbox: false }))).toBe(true)
  })
})

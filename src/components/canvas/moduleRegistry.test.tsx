import { describe, it, expect } from 'vitest'
import {
  MODULES,
  enabledModules,
  nativeDescriptors,
  isModuleEnabled,
  isModuleIdVisible,
  gateFromFlags,
  tabLabel,
  type ModuleDef,
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
    expect(swarm?.experiments).toEqual(['swarm'])
  })

  // Persona is NOT a module any more (2026-08-14): the surface describes the
  // OWNER rather than a project, so it opens from the Ground toolbar
  // (PersonaPanel + src/lib/persona/gate.ts). Registering it here again would
  // put the owner's stand-in back behind a per-project address — and, worse,
  // re-admit 'persona' to MODULE_IDS, which is what persistView validates a
  // saved tab against. This is the guard that keeps it out of every tab surface
  // even with BOTH flags open.
  it('does NOT register persona as a module — it lives on Ground now', () => {
    // Widened to `string` on purpose: `ModuleId` no longer contains 'persona',
    // so the compiler rejects the comparison outright — re-adding the entry is
    // a BUILD error before it is a test failure, and this case is the runtime
    // half (the registry-derived surfaces below take plain strings).
    expect(ids(MODULES).includes('persona')).toBe(false)
    const bothOpen = gateFromFlags(flags({ persona: true, swarm: true }))
    expect(ids(enabledModules(bothOpen))).not.toContain('persona')
    expect(ids(nativeDescriptors(bothOpen))).not.toContain('persona')
    expect(isModuleIdVisible('persona', bothOpen)).toBe(false)
  })

  it('hides gated modules by default (no gate) — the shipped/non-owner state', () => {
    expect(ids(enabledModules())).toEqual(['board', 'canvas', 'terminal', 'research'])
    // The "+" picker draws from the same gated source — no leak there either.
    expect(ids(nativeDescriptors())).toEqual(['board', 'canvas', 'terminal', 'research'])
  })

  it('reveals a gated module only when one of its experiments is open', () => {
    const gate = gateFromFlags(flags({ swarm: true }))
    expect(ids(enabledModules(gate))).toContain('swarm')
    expect(ids(nativeDescriptors(gate))).toContain('swarm')
    expect(ids(enabledModules(gate))).toEqual([
      'board',
      'canvas',
      'terminal',
      'research',
      'swarm',
    ])
  })

  it('an unrelated open flag reveals nothing', () => {
    // The persona experiment still exists (it opens the GROUND entry), but it
    // must not drag a tab back into the row on its way past.
    const gate = gateFromFlags(flags({ persona: true }))
    expect(ids(enabledModules(gate))).toEqual(['board', 'canvas', 'terminal', 'research'])
  })

  it('a closed flag keeps the module hidden', () => {
    expect(ids(enabledModules(gateFromFlags(ALL_CLOSED)))).not.toContain('swarm')
  })

  it('the sandbox experiment gates NO tab module (it only changes how claude spawns)', () => {
    // Turning sandbox on must not reveal a tab — it is a launch-time wrapper, not
    // a module — so the enabled set is identical to the all-off default.
    expect(ids(enabledModules(gateFromFlags(flags({ sandbox: true }))))).toEqual([
      'board',
      'canvas',
      'terminal',
      'research',
    ])
  })

  it('isModuleEnabled: always-on modules ignore the gate, gated ones require it', () => {
    const board = MODULES.find((m) => m.id === 'board')!
    const swarm = MODULES.find((m) => m.id === 'swarm')!
    expect(isModuleEnabled(board)).toBe(true)
    expect(isModuleEnabled(swarm)).toBe(false) // default gate is closed
    expect(isModuleEnabled(swarm, gateFromFlags(flags({ swarm: true })))).toBe(true)
    // A module only opens on an experiment it actually LISTS — an unrelated open
    // flag is not a way in.
    expect(isModuleEnabled(swarm, gateFromFlags(flags({ persona: true })))).toBe(false)
  })

  // `experiments` is an ARRAY with any-of semantics, and that is live machinery
  // even though today's only gated module lists a single flag (Persona was the
  // two-flag case; it now opens from the Ground toolbar instead — see
  // src/lib/persona/gate.ts, which kept the same rule). Covered with a fixture
  // rather than a second production module, so a `some()` → `every()` slip is
  // caught here instead of by whichever module next needs two ways in.
  it('isModuleEnabled: ANY of the listed experiments opens a module (not all of them)', () => {
    const twoWaysIn: ModuleDef = {
      ...MODULES.find((m) => m.id === 'swarm')!,
      experiments: ['persona', 'swarm'],
    }
    expect(isModuleEnabled(twoWaysIn, gateFromFlags(ALL_CLOSED))).toBe(false)
    expect(isModuleEnabled(twoWaysIn, gateFromFlags(flags({ persona: true })))).toBe(true)
    expect(isModuleEnabled(twoWaysIn, gateFromFlags(flags({ swarm: true })))).toBe(true)
  })

  // ONE predicate, two call sites: the tab row filters with enabledModules, and
  // ProjectPanel's render branch re-checks with isModuleIdVisible before it
  // mounts an experimental surface. Asking the registry both times is what
  // stops a hand-written `experiments?.swarm` in the panel from disagreeing
  // with the tab row (which would show the tab and then mount nothing).
  describe('isModuleIdVisible — what a render branch may mount', () => {
    it('mirrors the tab row for every module, gate by gate', () => {
      for (const gate of [
        gateFromFlags(ALL_CLOSED),
        gateFromFlags(flags({ swarm: true })),
        gateFromFlags(flags({ persona: true })),
        gateFromFlags(flags({ swarm: true, persona: true })),
      ]) {
        const shown = new Set(ids(enabledModules(gate)))
        for (const m of MODULES) {
          expect(isModuleIdVisible(m.id, gate)).toBe(shown.has(m.id))
        }
      }
    })

    it('fails closed: no gate hides the experiments, an unknown id is never visible', () => {
      expect(isModuleIdVisible('swarm')).toBe(false)
      expect(isModuleIdVisible('board')).toBe(true)
      expect(isModuleIdVisible('nope', gateFromFlags(flags({ swarm: true, persona: true })))).toBe(
        false,
      )
      // A RETIRED id is just an unknown one here — the registry is the only
      // thing that decides what a render branch may mount, so 'persona' cannot
      // come back as a tab body by way of a stale localStorage view.
      expect(isModuleIdVisible('persona', gateFromFlags(flags({ swarm: true, persona: true })))).toBe(
        false,
      )
    })
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
        { label: 'Research', labelKey: 'research.tabLabel' },
        translate({ 'research.tabLabel': '調査' }),
      ),
    ).toBe('調査')
  })

  it('falls back to the built-in label when the key is missing entirely', () => {
    expect(tabLabel({ label: 'Research', labelKey: 'research.tabLabel' }, echoKey)).toBe('Research')
  })

  it('a labelKey-carrying module keeps its key into the "+" picker (one-key rename)', () => {
    const research = MODULES.find((m) => m.id === 'research')!
    expect(research.labelKey).toBe('research.tabLabel')
    // …and it survives into the "+" picker's descriptor, so both surfaces show
    // the SAME name.
    const descriptor = nativeDescriptors(gateFromFlags(flags())).find((d) => d.id === 'research')!
    expect(descriptor.labelKey).toBe('research.tabLabel')
  })
})

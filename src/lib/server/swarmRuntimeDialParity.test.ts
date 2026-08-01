// THE KILL SWITCH MUST DRAW WHAT THE SERVER IS DOING.
//
// The two Swarm-tab toggles ARE the safety story of the SDK runtime: "if
// anything goes wrong, turn it off — no release needed." A toggle that reads OFF
// while the server is running SDK workers is not a switch the owner can trust,
// and they would be reading it at exactly the moment something had gone wrong.
//
// Measured 2026-08-02, minutes before shipping: the server's default flipped to
// SDK and the client's derivation did not. For the SHIPPED state (nothing
// written to settings yet) the server ran SDK and the panel drew "off" — the
// same reader-did-not-move-with-the-rule shape as the ten display-vs-truth
// defects the migration had already produced, this time on the one control that
// exists to be believed under pressure.
//
// So the two are pinned against EACH OTHER here, over every input either can
// see. Neither may move alone.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { chooseWorkerRuntime } from './swarmWorkerRuntimeDial'

/** The client's derivation, lifted verbatim from SwarmModule's `dialOf`. Kept as
 *  a copy on purpose: the panel cannot import server code, so the guarantee has
 *  to be "these two agree", not "these two are the same function". The source
 *  pin at the bottom is what stops the copy from silently drifting. */
const clientDial = (m: unknown): 'pty' | 'sdk' =>
  m === 'pty' ? 'pty' : m === 'sdk' || m === undefined ? 'sdk' : 'pty'

/** The server's answer for the WORKER dial, through the real decision. The
 *  preflight is stubbed to pass so the runtime reflects the DIAL and not this
 *  machine's claude. */
const serverWorkerDial = (mode: unknown): 'pty' | 'sdk' =>
  chooseWorkerRuntime({
    settings: (mode === undefined
      ? {}
      : { swarmWorkerRuntime: { mode } }) as never,
    workers: [],
    worktree: '/tmp/wt',
    poolSessions: () => [],
    preflight: () => ({ ok: true, claudeBin: '/bin/claude', cliVersion: '9.9.9', problems: [] }),
  }).runtime

/** Every value the field can actually hold: absent, the two real ones, and the
 *  shapes a hand-edited or half-migrated settings.json produces. */
const INPUTS: unknown[] = [undefined, 'sdk', 'pty', '', 'SDK', 'Pty', null, 0, 1, {}, [], 'garbage']

describe('the runtime toggles draw what the server does', () => {
  it('client and server agree on EVERY input, including absent', () => {
    const disagreements = INPUTS.filter((m) => clientDial(m) !== serverWorkerDial(m)).map(
      (m) => `${JSON.stringify(m)}: panel=${clientDial(m)} server=${serverWorkerDial(m)}`,
    )
    expect(
      disagreements,
      'The Swarm panel would draw a different runtime than the one the server ' +
        'runs. That is the kill switch lying, on the inputs below:\n  ' +
        disagreements.join('\n  '),
    ).toEqual([])
  })

  it('the SHIPPED state — nothing written yet — is SDK on both sides', () => {
    // Called out separately because it is the case that broke: every explicit
    // value agreed, and the one nobody writes did not.
    expect(serverWorkerDial(undefined)).toBe('sdk')
    expect(clientDial(undefined)).toBe('sdk')
  })

  it('OFF means OFF on both sides — the switch does what it says', () => {
    expect(serverWorkerDial('pty')).toBe('pty')
    expect(clientDial('pty')).toBe('pty')
  })

  it('an unrecognised value is conservative on both sides', () => {
    // A settings file we cannot parse is not evidence that the experiment is
    // wanted — and the panel must not claim it is on.
    expect(serverWorkerDial('garbage')).toBe('pty')
    expect(clientDial('garbage')).toBe('pty')
  })

  it('the panel still carries the copy this file compares against', () => {
    // The copy above is only meaningful while the panel really contains it.
    // Deleting or rewriting `dialOf` in SwarmModule without touching this file
    // would leave the parity test comparing itself to nothing.
    const src = readFileSync(
      join(__dirname, '..', '..', 'components', 'canvas', 'modules', 'SwarmModule.tsx'),
      'utf8',
    ).replace(/\/\/.*$/gm, '')
    expect(src, 'SwarmModule must derive both toggles through one `dialOf`').toMatch(
      /const dialOf = \(m: unknown\): 'pty' \| 'sdk' =>/,
    )
    expect(src).toMatch(/worker: dialOf\(/)
    expect(src).toMatch(/manager: dialOf\(/)
    // …and it must not have quietly gone back to the old one-sided test.
    expect(src, 'a bare `=== \'sdk\'` test is the shape that lied').not.toMatch(
      /(?:swarmWorkerRuntime|swarmManagerRuntime)\?\.mode === 'sdk' \? 'sdk' : 'pty'/,
    )
  })
})

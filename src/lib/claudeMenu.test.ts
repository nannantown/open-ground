import { describe, it, expect } from 'vitest'
import { detectMenu } from './claudeMenu'

// The real permission prompt, as reconstructed off the headless screen
// (verified against a captured claude v2.1.168 session — see the feature work).
const PERMISSION_SCREEN = `⏺Write(__probe.txt)
  ⎿  Create file __probe.txt

 Do you want to create __probe.txt?
 ❯ 1. Yes
   2. Yes, allow all edits during this session (shift+tab)
   3. No
 Esc to cancel · Tab to amend`

describe('detectMenu', () => {
  it('detects a permission prompt and its options', () => {
    const m = detectMenu(PERMISSION_SCREEN)
    expect(m).not.toBeNull()
    expect(m!.question).toBe('Do you want to create __probe.txt?')
    expect(m!.options.map((o) => o.n)).toEqual([1, 2, 3])
    expect(m!.options[0]).toMatchObject({ n: 1, label: 'Yes', selected: true })
    expect(m!.options[1].allowAll).toBe(true)
    expect(m!.canCancel).toBe(true)
  })

  it('marks only the ❯-highlighted option as selected', () => {
    const m = detectMenu(PERMISSION_SCREEN)!
    expect(m.options.filter((o) => o.selected).map((o) => o.n)).toEqual([1])
  })

  it('emits a stable signature that changes with the options', () => {
    const a = detectMenu(PERMISSION_SCREEN)!
    const b = detectMenu(PERMISSION_SCREEN)!
    expect(a.signature).toBe(b.signature)
    const diff = detectMenu(PERMISSION_SCREEN.replace('3. No', '3. Nope'))!
    expect(diff.signature).not.toBe(a.signature)
  })

  it('returns null for ordinary numbered prose (no footer, no question)', () => {
    expect(
      detectMenu('Here are the steps:\n1. Read the file\n2. Edit it\n3. Save'),
    ).toBeNull()
  })

  it('returns null when there is no menu at all', () => {
    expect(detectMenu('just some\noutput\nlines')).toBeNull()
    expect(detectMenu('')).toBeNull()
  })

  it('ignores a lone numbered line', () => {
    expect(detectMenu('1. only one option\nEsc to cancel')).toBeNull()
  })

  it('requires the options to start at 1 and be consecutive', () => {
    // 2,3 without a 1 is not a menu.
    expect(detectMenu('Pick?\n 2. b\n 3. c\nEsc to cancel')).toBeNull()
  })

  it('detects an arrow-style menu via its footer even without a ? question', () => {
    const screen = `Would you like to proceed
 ❯ 1. Approve and start
   2. Keep planning
 ↑↓ to select · Enter to confirm`
    const m = detectMenu(screen)
    expect(m).not.toBeNull()
    expect(m!.options.map((o) => o.n)).toEqual([1, 2])
  })
})

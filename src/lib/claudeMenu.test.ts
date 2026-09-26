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

  it('detects an arrow-style menu (cursor, no ? question)', () => {
    const screen = `Would you like to proceed
 ❯ 1. Approve and start
   2. Keep planning
 ↑↓ to select · Enter to confirm`
    const m = detectMenu(screen)
    expect(m).not.toBeNull()
    expect(m!.options.map((o) => o.n)).toEqual([1, 2])
  })

  it('a ">" prefix is not a cursor', () => {
    expect(detectMenu('Pick?\n > 1. a\n   2. b\nEsc to cancel')).toBeNull()
  })

  it('a cursored run with the input box below it is history, not a menu', () => {
    expect(detectMenu('❯ 1. a\n  2. b\n\n⏺ ok\n────────\n❯ \n────────')).toBeNull()
  })

  it('picks the bottom cursored run', () => {
    const m = detectMenu('Old?\n❯ 1. x\n  2. y\nNew?\n❯ 1. p\n  2. q\nEsc to cancel')
    expect(m!.question).toBe('New?')
  })

  // Commander review 2026-09-26 — both were menus before the cursor gate and
  // null after its first version (a live chooser read as idle).
  it('a numbered row inside an option description does not split the menu', () => {
    const m = detectMenu('色は?\n❯ 1. 赤\n     1. 明るい\n  2. 青\n  3. Type something.\n\nEnter to select · Esc to cancel')
    expect(m?.options.map((o) => o.label)).toEqual(['赤', '青', 'Type something.'])
  })

  it('a bare ❯ row under a chooser (a status line) does not hide it', () => {
    expect(detectMenu('Do you want to proceed?\n❯ 1. Yes\n  2. No\n\n❯ status line')).not.toBeNull()
  })

  // Commander rework 2 — REAL claude 2.1.283 frame (158x22, bypass + Remote
  // Control): a multiSelect AskUserQuestion after ↓×3, the cursor on the
  // un-numbered Submit row. Captured with scripts/probe-desk-choosers.mts multi.
  const RULE158 = '─'.repeat(158)
  const MULTI_ROWS = [
    RULE158,
    '←  ☐ 色  ✔ Submit  →',
    '好きな色は?(複数可)',
    '  1. [ ] 赤',
    '         赤',
    '  2. [ ] 青',
    '         青',
    '  3. [ ] Type something',
    '❯    Submit',
    RULE158,
    '  4. Chat about this',
    'Enter to select · ↑/↓ to navigate · ctrl+g to edit in Micro · Esc to cancel',
  ]
  it('multiSelect: the cursor on the un-numbered Submit row is still a menu', () => {
    expect(detectMenu(MULTI_ROWS.join('\n'))).not.toBeNull()
  })

  it('multiSelect: the cursor on each numbered row is a menu too', () => {
    const bare = MULTI_ROWS.map((r) => r.replace(/^❯ {3}Submit$/, '     Submit'))
    for (const n of [1, 2, 3, 4]) {
      const f = bare.map((r) => r.replace(new RegExp(`^  ${n}\\. `), `❯ ${n}. `)).join('\n')
      expect(f).toContain(`❯ ${n}. `)
      expect(detectMenu(f)?.options.map((o) => o.n)).toEqual([1, 2, 3, 4])
    }
  })

  it('an owner turn under a numbered list is not a menu, even with a chooser hint in prose', () => {
    const f = ['  1. a', '  2. b', '', '❯ 了解', '', '⏺ Esc to cancel で止められます', '', RULE158, '❯ ', RULE158].join('\n')
    expect(detectMenu(f)).toBeNull()
  })

  it('an un-numbered ❯ row under a numbered list needs the chooser hint below it', () => {
    // A frame with no input box on it (mid-repaint): the owner turn is the last ❯.
    expect(detectMenu(['  1. a', '  2. b', '', '❯ 了解', '', '⏺ ok'].join('\n'))).toBeNull()
  })
})

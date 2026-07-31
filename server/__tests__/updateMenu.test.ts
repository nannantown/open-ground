import { describe, it, expect } from 'vitest'
import {
  RELEASE_NOTES_URL,
  MENU_ID_CHECK_FOR_UPDATES,
  MENU_ID_RELEASE_NOTES,
  languageFromSettingsRaw,
  buildAppMenuTemplate,
  manualCheckPrecondition,
  manualCheckOutcome,
  updateDialogText,
  type MenuTemplateEntry,
} from '../../electron/updateMenu'

// The application menu + the manual "Check for Updates…" decision
// (electron/updateMenu.js). These assertions exist because all three failure
// modes here are SILENT in a packaged app:
//
//   • Replacing Electron's default menu can quietly drop Edit/View/Window — and
//     a missing Edit menu means no Cmd+C / Cmd+V, which nobody notices until a
//     user tries to copy out of a terminal pane.
//   • A manual check that returns without a dialog is indistinguishable from a
//     broken one (the background checks are deliberately silent).
//   • Misreading electron-updater's result as "up to date" when an update EXISTS
//     is the one wrong answer that actively harms: the user stays on an old build
//     believing they checked.

const mac = (over: Partial<Parameters<typeof buildAppMenuTemplate>[0]> = {}) =>
  buildAppMenuTemplate({
    appName: 'OPEN GROUND',
    isMac: true,
    onCheckForUpdates: () => {},
    onOpenReleaseNotes: () => {},
    ...over,
  })

const findById = (t: MenuTemplateEntry[], id: string): MenuTemplateEntry | undefined => {
  for (const entry of t) {
    if (entry.id === id) return entry
    const hit = entry.submenu && findById(entry.submenu, id)
    if (hit) return hit
  }
  return undefined
}

describe('buildAppMenuTemplate', () => {
  it('macOS: "Check for Updates…" sits in the APP submenu (the platform convention)', () => {
    const t = mac()
    const appMenu = t[0]
    expect(appMenu.label).toBe('OPEN GROUND')
    const ids = (appMenu.submenu ?? []).map((i) => i.id)
    expect(ids).toContain(MENU_ID_CHECK_FOR_UPDATES)
    // Right under About — where a Mac user looks for it.
    const idx = (appMenu.submenu ?? []).findIndex((i) => i.id === MENU_ID_CHECK_FOR_UPDATES)
    const aboutIdx = (appMenu.submenu ?? []).findIndex((i) => i.role === 'about')
    expect(aboutIdx).toBeGreaterThanOrEqual(0)
    expect(idx).toBeGreaterThan(aboutIdx)
  })

  it('Windows/Linux: no app submenu exists, so the item moves to the top of Help', () => {
    const t = buildAppMenuTemplate({
      appName: 'OPEN GROUND',
      isMac: false,
      onCheckForUpdates: () => {},
      onOpenReleaseNotes: () => {},
    })
    expect(t.some((e) => e.label === 'OPEN GROUND')).toBe(false)
    const help = t.find((e) => e.role === 'help')
    expect(help?.submenu?.[0]?.id).toBe(MENU_ID_CHECK_FOR_UPDATES)
    // Still reachable on every platform — that is the point of one builder.
    expect(findById(t, MENU_ID_CHECK_FOR_UPDATES)).toBeTruthy()
  })

  it('keeps Electron’s standard menus — dropping editMenu would kill Cmd+C/Cmd+V', () => {
    for (const isMac of [true, false]) {
      const t = buildAppMenuTemplate({
        appName: 'OPEN GROUND',
        isMac,
        onCheckForUpdates: () => {},
        onOpenReleaseNotes: () => {},
      })
      const roles = t.map((e) => e.role)
      expect(roles).toContain('fileMenu')
      expect(roles).toContain('editMenu')
      expect(roles).toContain('viewMenu')
      expect(roles).toContain('windowMenu')
      expect(roles).toContain('help')
    }
  })

  it('the click handlers are the ones passed in (menu → checkForUpdatesInteractive)', () => {
    const calls: string[] = []
    const t = mac({
      onCheckForUpdates: () => calls.push('check'),
      onOpenReleaseNotes: () => calls.push('notes'),
    })
    findById(t, MENU_ID_CHECK_FOR_UPDATES)?.click?.()
    findById(t, MENU_ID_RELEASE_NOTES)?.click?.()
    expect(calls).toEqual(['check', 'notes'])
  })

  it('About/Hide/Quit are labelled with the product name, not app.name', () => {
    // app.name is the lowercase package name ("openground") and CANNOT be renamed:
    // userData's path is derived from it. So the labels are spelled explicitly.
    const submenu = mac()[0].submenu ?? []
    expect(submenu.find((i) => i.role === 'about')?.label).toBe('About OPEN GROUND')
    expect(submenu.find((i) => i.role === 'hide')?.label).toBe('Hide OPEN GROUND')
    expect(submenu.find((i) => i.role === 'quit')?.label).toBe('Quit OPEN GROUND')
  })

  it('Release Notes points at the public distribution repo (the same feed we install from)', () => {
    expect(RELEASE_NOTES_URL).toBe('https://github.com/nannantown/open-ground/releases')
  })
})

describe('manualCheckPrecondition', () => {
  const base = { packaged: true, lockdown: false, updateDownloaded: false, inFlight: false }

  it('a normal packaged app with nothing pending actually checks', () => {
    expect(manualCheckPrecondition(base)).toBe('check')
  })

  it('unpackaged (dev) never checks — electron-updater is not even loaded there', () => {
    expect(manualCheckPrecondition({ ...base, packaged: false })).toBe('dev')
    // dev outranks everything: there is no updater to consult regardless of state.
    expect(
      manualCheckPrecondition({ ...base, packaged: false, updateDownloaded: true, lockdown: true }),
    ).toBe('dev')
  })

  it('an already-downloaded update offers the restart INSTEAD of re-checking', () => {
    expect(manualCheckPrecondition({ ...base, updateDownloaded: true })).toBe('restart')
  })

  it('restart outranks lockdown — applying a downloaded update needs no network', () => {
    expect(manualCheckPrecondition({ ...base, updateDownloaded: true, lockdown: true })).toBe(
      'restart',
    )
  })

  it('work mode suppresses the check and SAYS so (silence would read as up-to-date)', () => {
    expect(manualCheckPrecondition({ ...base, lockdown: true })).toBe('lockdown')
  })

  it('a second click while a check is running does not race a second dialog', () => {
    expect(manualCheckPrecondition({ ...base, inFlight: true })).toBe('busy')
  })
})

describe('manualCheckOutcome', () => {
  const current = '0.11.43'

  it('isUpdateAvailable:false → up to date', () => {
    expect(
      manualCheckOutcome({ result: { isUpdateAvailable: false, updateInfo: { version: current } }, currentVersion: current }),
    ).toEqual({ kind: 'up-to-date', version: current })
  })

  it('isUpdateAvailable:true → downloading, named with the NEW version', () => {
    expect(
      manualCheckOutcome({ result: { isUpdateAvailable: true, updateInfo: { version: '0.12.0' } }, currentVersion: current }),
    ).toEqual({ kind: 'downloading', version: '0.12.0' })
  })

  it('null (the updater declined to check) is "unavailable" — NEVER a false all-clear', () => {
    expect(manualCheckOutcome({ result: null, currentVersion: current })).toEqual({
      kind: 'unavailable',
      version: current,
    })
    expect(manualCheckOutcome({ result: undefined, currentVersion: current }).kind).toBe('unavailable')
  })

  it('an unknown result shape degrades toward "there is an update", not toward up-to-date', () => {
    // No isUpdateAvailable field (a future/older electron-updater): a live
    // downloadPromise is proof enough that something is coming down.
    expect(
      manualCheckOutcome({ result: { downloadPromise: Promise.resolve([]), updateInfo: { version: '0.12.0' } }, currentVersion: current }).kind,
    ).toBe('downloading')
    // Last resort: a version that differs from ours.
    expect(
      manualCheckOutcome({ result: { updateInfo: { version: '0.12.0' } }, currentVersion: current }).kind,
    ).toBe('downloading')
    // Same version and no other signal → genuinely up to date.
    expect(
      manualCheckOutcome({ result: { updateInfo: { version: current } }, currentVersion: current }).kind,
    ).toBe('up-to-date')
  })

  it('falls back to the running version when the feed omits one', () => {
    expect(manualCheckOutcome({ result: { isUpdateAvailable: false, updateInfo: {} }, currentVersion: current })).toEqual({
      kind: 'up-to-date',
      version: current,
    })
  })
})

describe('languageFromSettingsRaw', () => {
  it("only a literal 'ja' selects Japanese — OPEN GROUND is English-first", () => {
    expect(languageFromSettingsRaw('{"language":"ja"}')).toBe('ja')
    expect(languageFromSettingsRaw('{"language":"en"}')).toBe('en')
    expect(languageFromSettingsRaw('{}')).toBe('en')
  })

  it('a missing / corrupt / non-object settings.json reads as English, never throws', () => {
    expect(languageFromSettingsRaw(null)).toBe('en')
    expect(languageFromSettingsRaw(undefined)).toBe('en')
    expect(languageFromSettingsRaw('')).toBe('en')
    expect(languageFromSettingsRaw('{ not json')).toBe('en')
    expect(languageFromSettingsRaw('[1,2,3]')).toBe('en')
    expect(languageFromSettingsRaw('null')).toBe('en')
  })
})

describe('updateDialogText', () => {
  const KINDS = [
    'dev',
    'lockdown',
    'busy',
    'unavailable',
    'up-to-date',
    'downloading',
    'error',
    'downloaded',
  ] as const

  it('every kind has non-empty copy in BOTH languages', () => {
    for (const lang of ['en', 'ja'] as const) {
      for (const kind of KINDS) {
        const t = updateDialogText(lang, kind, { version: '0.12.0', error: 'ENOTFOUND' })
        expect(t.message.length, `${lang}/${kind} message`).toBeGreaterThan(0)
        expect(t.detail.length, `${lang}/${kind} detail`).toBeGreaterThan(0)
      }
    }
  })

  it('only the "downloaded" prompt offers buttons, and "Later" is the default', () => {
    for (const lang of ['en', 'ja'] as const) {
      const downloaded = updateDialogText(lang, 'downloaded', { version: '0.12.0' })
      expect(downloaded.buttons).toHaveLength(2)
      // Restart is index 0 (main.js branches on response === 0); the DEFAULT and the
      // cancel action are both "Later" — never restart out from under a running task.
      expect(downloaded.defaultId).toBe(1)
      expect(downloaded.cancelId).toBe(1)
      for (const kind of KINDS.filter((k) => k !== 'downloaded')) {
        expect(updateDialogText(lang, kind).buttons, `${lang}/${kind}`).toBeUndefined()
      }
    }
  })

  it('names the version when it has one, and stays grammatical when it does not', () => {
    expect(updateDialogText('en', 'up-to-date', { version: '0.11.43' }).message).toContain('0.11.43')
    expect(updateDialogText('ja', 'up-to-date', { version: '0.11.43' }).message).toContain('0.11.43')
    // Missing version: no dangling "OPEN GROUND  is up to date."
    expect(updateDialogText('en', 'downloaded', {}).message).not.toMatch(/OPEN GROUND\s{2,}/)
    expect(updateDialogText('en', 'downloaded', {}).message).toContain('A new version')
    expect(updateDialogText('ja', 'downloaded', {}).message).toContain('新しいバージョン')
  })

  it('surfaces the real error text, and still says what to do when there is none', () => {
    expect(updateDialogText('en', 'error', { error: 'ENOTFOUND api.github.com' }).detail).toContain(
      'ENOTFOUND api.github.com',
    )
    expect(updateDialogText('ja', 'error', {}).detail.length).toBeGreaterThan(0)
  })

  it('an unexpected kind degrades to the honest generic answer instead of crashing', () => {
    // The click handler reads .message unconditionally; undefined here would take
    // the menu item down.
    const t = updateDialogText('en', 'nonsense' as never)
    expect(t.message).toBe(updateDialogText('en', 'unavailable').message)
  })
})

// electron/updateMenu.js — the application menu (with "Check for Updates…") and
// the MANUAL update-check decision, factored out of the 78 KB electron/main.js so
// both are unit-testable WITHOUT an Electron runtime
// (server/__tests__/updateMenu.test.ts) — the same plain-CJS split as
// electron/autoUpdate.js / lockdown.js / forkEnv.js / startup.js.
//
// WHY A MENU ITEM AT ALL. Auto-update already works (electron-updater: check at
// boot, then every 4h, auto-download, dialog on 'update-downloaded'), but every
// one of those paths is something the app decides to do TO the user. There was no
// way for the user to ASK. Worse, the honest answers were invisible: "you are on
// the latest version" and "work mode is suppressing checks" were console.log
// lines in a packaged app nobody reads. The menu item makes the update state
// interrogable — which is the whole point of a manual check.
//
// WHY THE WHOLE MENU IS BUILT HERE AND NOT PATCHED IN. Electron installs a
// default application menu, and the tempting shortcut is to grab it with
// Menu.getApplicationMenu() and splice one item into submenu[0]. That is a
// mutation of an object Electron owns, positional (index 1 today, who knows
// tomorrow), and silently no-ops if the default ever changes shape. Building the
// full template from roles is the supported path: `fileMenu` / `editMenu` /
// `viewMenu` / `windowMenu` reproduce Electron's defaults exactly — so Cmd+C /
// Cmd+V / DevTools / Minimize all keep working — while the app submenu is ours to
// compose. A pure builder means a test asserts both halves: our item is present
// AND the standard roles survived.
//
// WHY THE MENU LABELS STAY ENGLISH WHILE THE DIALOGS FOLLOW settings.language.
// The macOS menu bar is a SYSTEM surface: "About …", "Services", "Hide …",
// "Edit", "Window" are rendered by macOS/Electron in the SYSTEM's language, which
// this app cannot set. Dropping one Japanese item into an otherwise-English menu
// reads as a rendering bug, so the item matches its neighbours ("Check for
// Updates…" is standard macOS phrasing). The DIALOGS, by contrast, are entirely
// ours and are read as prose — those follow the user's OPEN GROUND language
// setting, like the rest of the app's own copy.

'use strict'

/** Where "Release Notes" goes. The public distribution repo — the same feed
 *  electron-updater reads (package.json build.publish), so the notes the user
 *  sees are the notes attached to the release they would install. */
const RELEASE_NOTES_URL = 'https://github.com/nannantown/open-ground/releases'

/** Menu item ids, so main.js (and a test) can refer to items without matching on
 *  a display label that is free to change. */
const MENU_ID_CHECK_FOR_UPDATES = 'check-for-updates'
const MENU_ID_RELEASE_NOTES = 'release-notes'

/**
 * The app's UI language as this settings.json CONTENT declares it.
 *
 * English-first, exactly like src/lib/types.ts's `language?: 'en' | 'ja'`: unset
 * means English, and only a literal `'ja'` selects Japanese. A missing /
 * unreadable / hand-corrupted file therefore reads as English rather than
 * throwing — a broken settings file must never cost the user their menu.
 *
 * @param {string | null | undefined} raw settings.json content
 * @returns {'en' | 'ja'}
 */
function languageFromSettingsRaw(raw) {
  if (typeof raw !== 'string' || raw === '') return 'en'
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'en'
    return parsed.language === 'ja' ? 'ja' : 'en'
  } catch {
    return 'en'
  }
}

/**
 * The full application menu template.
 *
 * macOS puts "Check for Updates…" in the app submenu, right under About (the
 * platform convention every Mac user already knows where to look for). Windows
 * and Linux have no app submenu, so it goes at the top of Help — their
 * convention. One builder, both placements, so neither can silently lose the item.
 *
 * Everything else is `role:`-driven on purpose: the roles ARE Electron's default
 * menus, so replacing the default menu costs the user nothing.
 *
 * @param {{
 *   appName: string,
 *   isMac: boolean,
 *   onCheckForUpdates: () => void,
 *   onOpenReleaseNotes: () => void,
 * }} opts
 * @returns {Array<Record<string, unknown>>}
 */
function buildAppMenuTemplate(opts) {
  const { appName, isMac, onCheckForUpdates, onOpenReleaseNotes } = opts
  const checkForUpdates = {
    id: MENU_ID_CHECK_FOR_UPDATES,
    label: 'Check for Updates…',
    click: onCheckForUpdates,
  }
  const releaseNotes = {
    id: MENU_ID_RELEASE_NOTES,
    label: 'Release Notes',
    click: onOpenReleaseNotes,
  }

  const appSubmenu = [
    { role: 'about', label: `About ${appName}` },
    { type: 'separator' },
    checkForUpdates,
    { type: 'separator' },
    { role: 'services' },
    { type: 'separator' },
    { role: 'hide', label: `Hide ${appName}` },
    { role: 'hideOthers' },
    { role: 'unhide' },
    { type: 'separator' },
    { role: 'quit', label: `Quit ${appName}` },
  ]

  return [
    ...(isMac ? [{ label: appName, submenu: appSubmenu }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: isMac
        ? [releaseNotes]
        : [checkForUpdates, { type: 'separator' }, releaseNotes],
    },
  ]
}

/**
 * What a manual "Check for Updates…" click should actually DO, before any network
 * is touched. Pure, so every branch is asserted instead of being discovered in the
 * field.
 *
 * The order encodes real precedence, not taste:
 *   1. `dev` — an unpackaged build has no app-update.yml and no real version.
 *      electron-updater is never even loaded there (initAutoUpdater bails on
 *      !app.isPackaged), so there is nothing to check; say so instead of failing.
 *   2. `restart` — an update ALREADY downloaded and the user chose "Later" earlier.
 *      Re-checking would just rediscover it. Offering the restart is both the
 *      useful answer and the only one that needs no network — so it deliberately
 *      outranks the lockdown gate below.
 *   3. `lockdown` — work mode suppresses the periodic checks (electron/lockdown.js);
 *      a manual check must obey the same switch, and TELL the user, because a
 *      silently-skipped check is indistinguishable from "you're up to date".
 *   4. `busy` — a check is already in flight; a second one would race two dialogs.
 *   5. `check` — go ask GitHub.
 *
 * @param {{
 *   packaged: boolean,
 *   lockdown: boolean,
 *   updateDownloaded?: boolean,
 *   inFlight?: boolean,
 * }} state
 * @returns {'dev' | 'restart' | 'lockdown' | 'busy' | 'check'}
 */
function manualCheckPrecondition(state) {
  const s = state || {}
  if (!s.packaged) return 'dev'
  // A boolean, NOT the version string: electron-updater has been seen to omit the
  // version, and "we have an update on disk" must not hinge on whether we managed
  // to name it.
  if (s.updateDownloaded) return 'restart'
  if (s.lockdown) return 'lockdown'
  if (s.inFlight) return 'busy'
  return 'check'
}

/**
 * How to read what electron-updater's `checkForUpdates()` resolved to.
 *
 * electron-updater 6.x always sets `isUpdateAvailable`, so that is the primary
 * signal. The fallbacks below exist because this is the ONE place a wrong answer
 * is actively harmful: telling a user "you're up to date" when they are not is
 * worse than any error. So an unknown result shape degrades toward "there is an
 * update" (via `downloadPromise`, then a version mismatch) rather than toward a
 * false all-clear. `null` — which the updater returns when it declines to check
 * at all — is reported as `unavailable`, never as up-to-date.
 *
 * @param {{ result: unknown, currentVersion: string }} args
 * @returns {{ kind: 'up-to-date' | 'downloading' | 'unavailable', version: string }}
 */
function manualCheckOutcome(args) {
  const { result, currentVersion } = args || {}
  const current = currentVersion || ''
  if (!result || typeof result !== 'object') return { kind: 'unavailable', version: current }
  const r = /** @type {Record<string, any>} */ (result)
  const info = r.updateInfo && typeof r.updateInfo === 'object' ? r.updateInfo : null
  const version = (info && typeof info.version === 'string' && info.version) || ''

  if (r.isUpdateAvailable === true) return { kind: 'downloading', version: version || current }
  if (r.isUpdateAvailable === false) return { kind: 'up-to-date', version: version || current }
  // Unknown shape — lean toward "there IS an update" rather than a false all-clear.
  if (r.downloadPromise) return { kind: 'downloading', version: version || current }
  if (version && version !== current) return { kind: 'downloading', version }
  return { kind: 'up-to-date', version: version || current }
}

/**
 * The user-facing copy for every update dialog, in the app's language.
 *
 * Plain language on purpose: the reader is the person deciding whether to
 * restart, not the person who wrote the updater. Every message answers "what is
 * true right now" and every detail answers "so what do I do".
 *
 * @param {'en' | 'ja'} lang
 * @param {'dev' | 'lockdown' | 'busy' | 'unavailable' | 'up-to-date' | 'downloading' | 'error' | 'downloaded'} kind
 * @param {{ version?: string | null, error?: string | null }} [opts]
 * @returns {{ message: string, detail: string, buttons?: string[], defaultId?: number, cancelId?: number }}
 */
function updateDialogText(lang, kind, opts) {
  const ja = lang === 'ja'
  const v = (opts && opts.version) || ''
  const err = (opts && opts.error) || ''
  const named = v ? `OPEN GROUND ${v}` : ja ? '新しいバージョン' : 'A new version of OPEN GROUND'

  switch (kind) {
    case 'dev':
      return ja
        ? {
            message: '開発ビルドです。',
            detail:
              '自動アップデートは配布版のアプリだけで動きます(npm run dist で作ったもの)。' +
              'このウィンドウは手元のコードをそのまま動かしているので、確認するものがありません。',
          }
        : {
            message: 'This is a development build.',
            detail:
              'Auto-update only runs in the packaged app (built with npm run dist). ' +
              'This window runs your working copy directly, so there is nothing to check.',
          }
    case 'lockdown':
      return ja
        ? {
            message: '業務モードがオンです。',
            detail:
              '業務モードの間は、アプリが外部と通信しないようアップデートの確認を止めています。' +
              '設定で業務モードをオフにすると確認できます。',
          }
        : {
            message: 'Work mode is on.',
            detail:
              'Update checks are paused while work mode is on, so the app stays off the network. ' +
              'Turn work mode off in Settings to check for updates.',
          }
    case 'busy':
      return ja
        ? { message: '確認中です。', detail: 'すでにアップデートを確認しています。少し待ってください。' }
        : { message: 'Already checking.', detail: 'An update check is already running. Give it a moment.' }
    case 'unavailable':
      return ja
        ? {
            message: 'アップデートを確認できませんでした。',
            detail: 'このビルドにはアップデート機能が入っていません。最新版は Help → Release Notes から確認できます。',
          }
        : {
            message: 'Could not check for updates.',
            detail: 'This build has no updater attached. You can check the latest version under Help → Release Notes.',
          }
    case 'up-to-date':
      return ja
        ? { message: `${named} は最新です。`, detail: '新しいバージョンはありません。' }
        : { message: `${named} is up to date.`, detail: 'You are on the latest version.' }
    case 'downloading':
      return ja
        ? {
            message: `${named} があります。`,
            detail: 'バックグラウンドでダウンロードしています。準備ができたら、再起動するか聞きます。',
          }
        : {
            message: `${named} is available.`,
            detail: 'It is downloading in the background. You will be asked to restart once it is ready.',
          }
    case 'error':
      return ja
        ? {
            message: 'アップデートの確認に失敗しました。',
            detail: `${err || '原因は分かりませんでした。'}\n\nネットワークにつながっているか確認して、もう一度試してください。`,
          }
        : {
            message: 'The update check failed.',
            detail: `${err || 'No reason was reported.'}\n\nCheck your network connection and try again.`,
          }
    case 'downloaded':
      return ja
        ? {
            message: `${named} をダウンロードしました。`,
            detail:
              '再起動すると新しいバージョンになります。作業中なら「あとで」を選んで、区切りがついてから再起動してください。',
            buttons: ['今すぐ再起動', 'あとで'],
            defaultId: 1,
            cancelId: 1,
          }
        : {
            message: `${named} has been downloaded.`,
            detail:
              'Restart to apply the update. If something is running, choose "Later" and restart once it finishes.',
            buttons: ['Restart now', 'Later'],
            defaultId: 1,
            cancelId: 1,
          }
    default:
      // Unreachable for the documented kinds — but a dialog is a UI surface, and
      // returning undefined here would crash the click handler on a typo. Degrade
      // to the honest generic answer instead.
      return updateDialogText(lang, 'unavailable', opts)
  }
}

module.exports = {
  RELEASE_NOTES_URL,
  MENU_ID_CHECK_FOR_UPDATES,
  MENU_ID_RELEASE_NOTES,
  languageFromSettingsRaw,
  buildAppMenuTemplate,
  manualCheckPrecondition,
  manualCheckOutcome,
  updateDialogText,
}

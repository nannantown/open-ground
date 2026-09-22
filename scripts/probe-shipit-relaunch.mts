// Real-machine probe for the will-quit relaunch fix: run the PRODUCTION writer
// against a COPY of this Mac's actual ShipItState.plist, then check that
//   (1) the app's own reader now sees a relaunch, and
//   (2) Foundation still reads the file we wrote (`plutil -p`) — it is named
//       .plist but holds JSON, which is also how ShipIt reads it.
// The live file is never touched: everything happens on a copy in a temp dir.
//
//   npx tsx scripts/probe-shipit-relaunch.mts \
//     "$HOME/Library/Caches/local.openground.app.ShipIt/ShipItState.plist"
//
// The path is an ARGUMENT on purpose: this repo allows exactly one home-derived
// resolver (src/testHomeEnvGuard.test.ts), and a probe script is not it.
import { execFileSync } from 'child_process'
import { copyFileSync, mkdtempSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ensureRelaunchAfterInstall, parseShipItRequest, shipItRequestIO } from '../electron/shipIt.js'

const live = process.argv[2]
if (!live || !existsSync(live)) {
  console.error('usage: npx tsx scripts/probe-shipit-relaunch.mts <path to ShipItState.plist>')
  console.error('  (normally ~/Library/Caches/local.openground.app.ShipIt/ShipItState.plist,')
  console.error('   and it only exists while an update is staged)')
  process.exit(2)
}
const copy = join(mkdtempSync(join(tmpdir(), 'og-shipit-probe-')), 'ShipItState.plist')
copyFileSync(live, copy)

const before = parseShipItRequest(readFileSync(copy, 'utf8'))
// The PRODUCTION io pair (tmp file + rename), not a stand-in: the point of a
// real-machine probe is to run what the app runs.
const outcome = ensureRelaunchAfterInstall(shipItRequestIO(copy))
const after = parseShipItRequest(readFileSync(copy, 'utf8'))
// A throw would hide the very failure this exists to catch (a rewrite Foundation
// can no longer read), so a non-zero plutil exit becomes ''.
const readsBack = (p: string) => {
  try {
    return execFileSync('plutil', ['-p', p], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}
const readable =
  readsBack(live) && readsBack(copy)
    ? 'Foundation reads both the original and the rewritten request: OK'
    : 'UNREADABLE — Foundation could not parse one of them'

console.log(`source      : ${live}`)
console.log(`before      : launchAfterInstallation=${before?.relaunchesAfterInstall}`)
console.log(`outcome     : ${outcome}`)
console.log(`after       : launchAfterInstallation=${after?.relaunchesAfterInstall}`)
console.log(`bundle      : ${after?.bundlePath}`)
console.log(`plutil      : ${readable}`)
console.log(`written     : ${readFileSync(copy, 'utf8')}`)
// A leftover tmp file would mean the writer littered ShipIt's own directory.
console.log(`tmp left    : ${existsSync(`${copy}.og-tmp`)}`)
process.exit(after?.relaunchesAfterInstall && readable.endsWith('OK') ? 0 : 1)

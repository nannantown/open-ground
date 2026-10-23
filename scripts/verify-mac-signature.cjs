// Runs after electron-builder's branding, copying and final signing, before
// DMG/ZIP creation. Verification is read-only: never rewrite Info.plist here.
const { spawnSync } = require('node:child_process')
const path = require('node:path')

function verifySignedMacApp(context, run = spawnSync) {
  if (context.electronPlatformName !== 'darwin') return
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const options = { encoding: 'utf8', windowsHide: true }
  const verified = run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], options)
  if (verified.error || verified.status !== 0) {
    throw new Error('Final Mac signature verification failed; installer generation stopped. Preserve the bundle for diagnosis.')
  }
  const displayed = run('/usr/bin/codesign', ['--display', '--verbose=4', app], options)
  const metadata = `${displayed.stdout || ''}\n${displayed.stderr || ''}`
  if (displayed.error || displayed.status !== 0 ||
      /^Signature=adhoc\s*$/m.test(metadata) ||
      !/^Authority=Developer ID Application:/m.test(metadata)) {
    throw new Error('Final Mac bundle has no verified Developer ID Application identity; installer generation stopped.')
  }
}

module.exports = context => verifySignedMacApp(context)
module.exports.verifySignedMacApp = verifySignedMacApp

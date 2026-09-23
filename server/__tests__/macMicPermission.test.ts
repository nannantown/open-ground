import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// The Songs tab records through getUserMedia. Under the hardened runtime a
// signed build WITHOUT the audio-input entitlement gets its mic request refused
// by tccd ("Policy disallows prompt") — silent recordings, no dialog. And with
// no NSMicrophoneUsageDescription macOS never shows the consent dialog at all.
// Both must be in the electron-builder inputs (main + inherited helpers).

const root = join(__dirname, '..', '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')
const pkg = JSON.parse(read('package.json'))

describe('macOS microphone permission is part of the signed build', () => {
  const mac = pkg.build.mac
  const plists = [mac.entitlements, mac.entitlementsInherit] as string[]

  it.each(plists)('%s grants com.apple.security.device.audio-input', (p) => {
    expect(read(p)).toMatch(/<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/)
  })

  it('Info.plist carries a non-empty NSMicrophoneUsageDescription', () => {
    expect(mac.extendInfo.NSMicrophoneUsageDescription).toMatch(/\S/)
  })
})

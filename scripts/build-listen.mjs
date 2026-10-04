// Builds bin/og-listen — the floating assistant's ears (native/og-listen,
// src/lib/server/assistantListen.ts) — as one arm64 + x86_64 binary with its
// Info.plist embedded (the speech framework refuses a helper without one).
// macOS only; elsewhere, or without swiftc on a dev machine, voice input simply
// stays off. In CI a failed build fails the release instead of shipping deaf.
// electron-builder signs it with the rest of the app (hardened runtime).
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'

if (process.platform !== 'darwin') {
  console.log('[og-listen] skipped (not macOS)')
  process.exit(0)
}
const src = 'native/og-listen/main.swift'
const plist = 'native/og-listen/Info.plist'
mkdirSync('bin', { recursive: true })
try {
  // macOS 12: the oldest whose system carries the Swift runtime this links to.
  const slices = ['arm64', 'x86_64'].map((arch) => {
    const out = `bin/.og-listen-${arch}`
    execFileSync(
      'swiftc',
      ['-O', '-swift-version', '5', '-target', `${arch}-apple-macos12`, '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', plist, src, '-o', out],
      { stdio: 'inherit' },
    )
    return out
  })
  execFileSync('lipo', ['-create', ...slices, '-output', 'bin/og-listen'], { stdio: 'inherit' })
  for (const s of slices) rmSync(s)
  console.log('[og-listen] built bin/og-listen')
} catch (e) {
  if (process.env.CI) throw e
  console.warn(`[og-listen] not built, voice input stays off: ${e instanceof Error ? e.message : e}`)
}

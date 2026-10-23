import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
type Options = { forceCodeSigning?: boolean; type?: string; strictVerify?: boolean; identity?: string | null }
type Context = { electronPlatformName: string; appOutDir: string; packager: { platformSpecificBuildOptions: Options; appInfo: { productFilename: string } } }
const { validateMacSigningPolicy } = require('../../scripts/check-mac-signing.cjs') as {
  validateMacSigningPolicy: (context: Context, env?: Record<string, string>) => void
}
type Result = { status: number | null; stdout?: string; stderr?: string; error?: Error }
type Run = (program: string, args: string[], options: { encoding: string }) => Result
const { verifySignedMacApp } = require('../../scripts/verify-mac-signature.cjs') as {
  verifySignedMacApp: (context: Context, run: Run) => void
}
const context = (options: Options = {}): Context => ({
  electronPlatformName: 'darwin', appOutDir: '<OWN_OUTPUT>',
  packager: { platformSpecificBuildOptions: { forceCodeSigning: true, type: 'distribution', ...options }, appInfo: { productFilename: 'OPEN GROUND' } },
})

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

describe('macOS distribution signing policy', () => {
  it('requires final distribution signing and verification without changing the unsigned Windows policy', () => {
    expect(pkg.build.mac.forceCodeSigning).toBe(true)
    expect(pkg.build.mac.type).toBe('distribution')
    expect(pkg.build.mac.strictVerify).toBeUndefined()
    expect(pkg.build.beforePack).toBe('scripts/check-mac-signing.cjs')
    expect(pkg.build.afterSign).toBe('scripts/verify-mac-signature.cjs')
    expect(pkg.build.forceCodeSigning).toBeUndefined()
    expect(pkg.build.win.forceCodeSigning).toBeUndefined()
    expect(pkg.build.files).toContain('!node_modules/node-pty/build/node_gyp_bins/**')
  })

  it('local candidate packaging does not disable signing or submit/publish the app', () => {
    expect(pkg.scripts['dist:local']).not.toMatch(/identity=null|CSC_IDENTITY_AUTO_DISCOVERY=false/)
    expect(pkg.scripts['dist:local']).toContain('--publish never')
    expect(pkg.scripts['dist:local']).toContain('--config.mac.notarize=false')
  })

  it.each([{ forceCodeSigning: false }, { type: 'development' }, { identity: null }, { identity: '-' }, { strictVerify: false }, { strictVerify: true }])('refuses unsafe signing configuration %j before packaging', options => {
    expect(() => validateMacSigningPolicy(context(options), {})).toThrow()
  })

  it('refuses environment-based signing disable and permits the ordinary distribution policy', () => {
    expect(() => validateMacSigningPolicy(context(), { CSC_IDENTITY_AUTO_DISCOVERY: 'false' })).toThrow(/disabled/)
    expect(() => validateMacSigningPolicy(context(), {})).not.toThrow()
  })

  it('rejects a changed or incomplete signature before checking identity metadata', () => {
    const calls: string[][] = []
    expect(() => verifySignedMacApp(context(), (_program, args) => {
      calls.push(args)
      return { status: 1, stderr: 'code has no resources but signature indicates they must be present' }
    })).toThrow(/verification failed/)
    expect(calls).toEqual([['--verify', '--deep', '--strict', '--verbose=2', join('<OWN_OUTPUT>', 'OPEN GROUND.app')]])
  })

  it.each(['Signature=adhoc', 'Authority=(unavailable)', 'Authority=Mac Developer: Test Developer'])('rejects unverified or non-distribution identity %s', metadata => {
    expect(() => verifySignedMacApp(context(), (_program, args) => args[0] === '--verify'
      ? { status: 0 } : { status: 0, stderr: metadata })).toThrow(/Developer ID Application/)
  })

  it('requires successful verification and Developer ID metadata, without launching the app', () => {
    const calls: { program: string; args: string[] }[] = []
    expect(() => verifySignedMacApp(context(), (program, args) => {
      calls.push({ program, args })
      return args[0] === '--verify' ? { status: 0 } : { status: 0, stderr: 'Authority=Developer ID Application: Test Developer\nAuthority=Developer ID Certification Authority' }
    })).not.toThrow()
    expect(calls.map(x => x.program)).toEqual(['/usr/bin/codesign', '/usr/bin/codesign'])
    expect(calls.map(x => x.args[0])).toEqual(['--verify', '--display'])
  })

  it('fails closed when the verifier cannot start or its metadata command fails', () => {
    expect(() => verifySignedMacApp(context(), () => ({ status: null, error: new Error('unavailable') }))).toThrow(/verification failed/)
    expect(() => verifySignedMacApp(context(), (_program, args) => args[0] === '--verify'
      ? { status: 0 } : { status: 1 })).toThrow(/Developer ID Application/)
  })

  it('does not require Mac signing or execute codesign for the Windows target', () => {
    const win = { ...context({ forceCodeSigning: false }), electronPlatformName: 'win32' }
    expect(() => validateMacSigningPolicy(win, {})).not.toThrow()
    verifySignedMacApp(win, () => { throw new Error('must not execute') })
  })
})

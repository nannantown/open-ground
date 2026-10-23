import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir as systemTmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { createCandidateConfig } = require('../../scripts/candidate-build-config.cjs') as {
  createCandidateConfig: (base: Build, context: Context) => Build
}
type Build = { publish?: unknown; beforePack?: string; afterSign?: string; directories?: { output?: string }; mac: { forceCodeSigning?: boolean; type?: string; identity?: string | null; strictVerify?: boolean; notarize?: boolean } }
type Context = { runnerTemp: string; output: string; sha: string; runId: string }
const base = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).build as Build
const context: Context = { runnerTemp: systemTmpdir(), output: join(systemTmpdir(), 'candidate-output'), sha: '1'.repeat(40), runId: '123' }

describe('candidate publishing boundary', () => {
  it('removes the release publisher without mutating production configuration and requires notarization', () => {
    const before = JSON.stringify(base)
    const config = createCandidateConfig(base, context)
    expect(config.publish).toBeNull()
    expect(config.mac.notarize).toBe(true)
    expect(config.mac.forceCodeSigning).toBe(true)
    expect(config.afterSign).toBe('scripts/verify-mac-signature.cjs')
    expect(config.directories?.output).toBe(context.output)
    expect(JSON.stringify(base)).toBe(before)
  })
  it.each([{ forceCodeSigning: false }, { identity: null }, { identity: '-' }, { type: 'development' }, { strictVerify: false }])('refuses signing bypass %j', (mac) => {
    expect(() => createCandidateConfig({ ...base, mac: { ...base.mac, ...mac } }, context)).toThrow(/signing/)
  })
  it('refuses missing verification, unpinned source and output outside the runner directory', () => {
    expect(() => createCandidateConfig({ ...base, afterSign: undefined }, context)).toThrow(/verifier/)
    expect(() => createCandidateConfig(base, { ...context, sha: 'main' })).toThrow(/SHA/)
    expect(() => createCandidateConfig(base, { ...context, runId: 'latest' })).toThrow(/run ID/)
    expect(() => createCandidateConfig(base, { ...context, output: context.runnerTemp })).toThrow(/temporary/)
  })
})

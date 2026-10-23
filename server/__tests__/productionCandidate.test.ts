import { afterEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { createProductionCandidateConfig, assertProductionRuntimeConfig } = require('../../scripts/production-candidate-config.cjs')
const { verifyPackagedConfig, inspectUpdateFeed } = require('../../scripts/verify-production-candidate.cjs')
const yaml = require('js-yaml')
const crypto = require('node:crypto')
const base = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).build
const context = { runnerTemp: tmpdir(), output: join(tmpdir(), 'production-candidate'), sha: '1'.repeat(40), runId: '123' }
const token = (role: string) => `header.${Buffer.from(JSON.stringify({ role, ref: 'example' })).toString('base64url')}.signature`
const runtime = () => ({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: token('anon'), OPENGROUND_PHONE_RELAY_APP_KEY: 'fixture-install-pass' })
const dirs: string[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'og-production-candidate-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('production-equivalent candidate boundary', () => {
  it('retains only the established installed-client update metadata and all signing guards', () => {
    const before = JSON.stringify(base)
    const config = createProductionCandidateConfig(base, context)
    expect(config.publish).toEqual({ provider: 'github', owner: 'nannantown', repo: 'open-ground' })
    expect(config.mac.forceCodeSigning).toBe(true)
    expect(config.mac.notarize).toBe(true)
    expect(config.afterSign).toBe('scripts/verify-mac-signature.cjs')
    expect(JSON.stringify(base)).toBe(before)
    expect(() => createProductionCandidateConfig({ ...base, publish: { ...base.publish, repo: 'other' } }, context)).toThrow(/repository/)
    expect(() => createProductionCandidateConfig({ ...base, publish: { ...base.publish, token: 'not-allowed' } }, context)).toThrow(/repository/)
    expect(() => createProductionCandidateConfig({ ...base, mac: { ...base.mac, identity: null } }, context)).toThrow(/signing/)
  })
  it('requires public login material and refuses privileged values without reflecting them', () => {
    expect(assertProductionRuntimeConfig(runtime()).loginConfigured).toBe(true)
    expect(assertProductionRuntimeConfig({ ...runtime(), SUPABASE_ANON_KEY: 'sb_publishable_fixture' }).loginConfigured).toBe(true)
    for (const key of [token('service_role'), 'sb_secret_do-not-print', 'invalid-do-not-print', '']) {
      expect(() => assertProductionRuntimeConfig({ ...runtime(), SUPABASE_ANON_KEY: key })).toThrow(/public publishable\/anon/)
      try { assertProductionRuntimeConfig({ ...runtime(), SUPABASE_ANON_KEY: key }) } catch (error) {
        if (key) expect(String(error)).not.toContain(key)
      }
    }
    expect(() => assertProductionRuntimeConfig({ ...runtime(), SUPABASE_SERVICE_ROLE_KEY: 'forbidden' })).toThrow(/Unexpected runtime/)
    expect(() => assertProductionRuntimeConfig({ ...runtime(), OPENGROUND_PHONE_RELAY_APP_KEY: '' })).toThrow(/install pass/)
    expect(() => assertProductionRuntimeConfig({ ...runtime(), SUPABASE_URL: 'https://example.supabase.co@other.invalid' })).toThrow(/hosted-project/)
  })
  it('keeps realtime off unless explicitly configured and pins its established destination', () => {
    expect(assertProductionRuntimeConfig(runtime()).realtimeEnabled).toBe(false)
    expect(() => assertProductionRuntimeConfig({ ...runtime(), OPENGROUND_REALTIME: '1' })).toThrow(/destination/)
    expect(() => assertProductionRuntimeConfig({ ...runtime(), OPENGROUND_REALTIME: '1', OPENGROUND_COLLAB_WS_URL: 'wss://other.invalid' })).toThrow(/destination/)
    expect(assertProductionRuntimeConfig({ ...runtime(), OPENGROUND_REALTIME: '1', OPENGROUND_COLLAB_WS_URL: 'wss://og-collab.mindbrew.workers.dev' }).realtimeEnabled).toBe(true)
  })
  it('reads actual packaged configuration, catches missing/changed metadata and never executes the app', () => {
    const resources = temp()
    mkdirSync(join(resources, 'app/electron'), { recursive: true })
    writeFileSync(join(resources, 'app/electron/runtime-config.json'), JSON.stringify(runtime()))
    const update = { provider: 'github', owner: 'nannantown', repo: 'open-ground' }
    writeFileSync(join(resources, 'app-update.yml'), yaml.dump(update))
    expect(verifyPackagedConfig(resources, runtime()).phoneCreationPassIncluded).toBe(true)
    expect(() => verifyPackagedConfig(resources, { ...runtime(), OPENGROUND_PHONE_RELAY_APP_KEY: 'different-fixture' })).toThrow(/differs/)
    writeFileSync(join(resources, 'app-update.yml'), yaml.dump({ ...update, owner: 'other' }))
    expect(() => verifyPackagedConfig(resources, runtime())).toThrow(/destination/)
    writeFileSync(join(resources, 'app/electron/runtime-config.json'), '{"fixture-value-not-for-error-output"')
    expect(() => verifyPackagedConfig(resources, runtime())).toThrow('Packaged runtime configuration is missing or invalid; contents withheld.')
  })
  it('checks generated feed hashes against all actual installers, including tampering', () => {
    const dir = temp()
    const files = ['arm64', 'x64'].flatMap(arch => ['zip', 'dmg'].map(ext => {
      const name = `OPEN GROUND-0.11.182-${arch}.${ext}`
      const bytes = Buffer.from(name)
      writeFileSync(join(dir, name), bytes)
      return { url: name.replace(/ /g, '-'), size: bytes.length, sha512: crypto.createHash('sha512').update(bytes).digest('base64') }
    }))
    writeFileSync(join(dir, 'latest-mac.yml'), yaml.dump({ version: '0.11.182', files, path: files[0].url, sha512: files[0].sha512 }))
    expect(inspectUpdateFeed(dir, '0.11.182')).toHaveLength(4)
    writeFileSync(join(dir, 'OPEN GROUND-0.11.182-arm64.zip'), 'modified')
    expect(() => inspectUpdateFeed(dir, '0.11.182')).toThrow(/SHA-512/)
  })
  it('keeps the production-configured workflow branch-only, read-only and Actions-only', () => {
    const text = readFileSync(new URL('../../.github/workflows/production-candidate.yml', import.meta.url), 'utf8')
    const workflow = yaml.load(text)
    expect(workflow.on).toEqual({ push: { branches: ['codex/production-candidate-0.11.182-20261023'] } })
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.concurrency['cancel-in-progress']).toBe(false)
    const jobs = Object.values(workflow.jobs) as { if: string; permissions?: unknown; steps: { uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> }[] }[]
    for (const job of jobs) {
      expect(job.if).toContain("github.ref == 'refs/heads/codex/production-candidate-0.11.182-20261023'")
      expect(job.permissions).toBeUndefined()
      for (const step of job.steps) {
        if (step.uses === 'actions/checkout@v4') expect(step.with?.['persist-credentials']).toBe(false)
        expect(Object.keys(step.env || {})).not.toContain('GH_TOKEN')
        expect(Object.keys(step.env || {})).not.toContain('GITHUB_TOKEN')
      }
    }
    const commands = jobs.flatMap(job => job.steps.map(step => step.run || '')).join('\n')
    expect(commands).toContain('electron-builder --mac --arm64 --x64 --publish never')
    expect(commands).not.toMatch(/--publish\s+(always|onTag)|gh\s+release|git\s+(push|tag)|upload-release|api\.github\.com/)
    expect(text).not.toContain('contents: write')
    const build = workflow.jobs.notarize.steps.find((step: { name?: string }) => step.name === 'Build with existing distribution configuration')
    expect(Object.keys(build.env).sort()).toEqual(['OPENGROUND_COLLAB_WS_URL', 'OPENGROUND_PHONE_RELAY_APP_KEY', 'OPENGROUND_REALTIME', 'SUPABASE_ANON_KEY', 'SUPABASE_URL'])
    expect(build.env.OPENGROUND_REALTIME).toBe('${{ vars.OPENGROUND_REALTIME }}')
    expect(build.env.OPENGROUND_COLLAB_WS_URL).toBe('${{ vars.OPENGROUND_COLLAB_WS_URL }}')
    expect(text).not.toMatch(/\|\|\s*['"](?:1|wss:)/)
  })
})

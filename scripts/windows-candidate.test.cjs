const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')
const { createRequire } = require('node:module')
const candidate = require('./windows-candidate.cjs')
const source = path.resolve(process.env.APP_SOURCE_DIR || path.join(__dirname, '..'))
const req = createRequire(path.join(source, 'package.json'))
const yaml = req('js-yaml')
const { createDiagnostics } = require('./windows-smoke-diagnostics.cjs')

test('smoke assertions use the real Playwright test entry point and enforce mismatch failures', () => {
  const tools = candidate.smokeTools(source)
  assert.equal(tools._electron, req('playwright')._electron)
  tools.expect({ ready: true }).toEqual({ ready: true })
  assert.throws(() => tools.expect({ ready: false }).toEqual({ ready: true }))
})

function diagnosticsFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-windows-diagnostics-'))
  const output = path.join(dir, 'progress.txt')
  const fd = fs.openSync(output, 'w')
  t.after(() => { fs.closeSync(fd); fs.rmSync(dir, { recursive: true, force: true }) })
  return { dir, output, probe: createDiagnostics(dir, candidate.SOURCE_SHA, fd) }
}

test('stalled stage fails by its deadline and immediately retains progress/failure evidence', async t => {
  const { dir, output, probe } = diagnosticsFixture(t)
  let cancelled = false
  const started = Date.now()
  const pending = probe.stage('stalled', 30, () => new Promise(() => {}), () => { cancelled = true })
  assert.match(fs.readFileSync(output, 'utf8'), /stalled-start/)
  await assert.rejects(pending, { code: 'STAGE_TIMEOUT' })
  assert.ok(Date.now() - started < 1000, 'The short stalled-stage deadline must actually bound the wait.')
  assert.equal(cancelled, true)
  const events = fs.readFileSync(path.join(dir, 'phases.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.deepEqual(events.map(e => e.phase), ['stalled-start', 'stalled-deadline', 'stalled-failed'])
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'stalled-failure.json'))).code, 'STAGE_TIMEOUT')
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'phase.json'))).phase, 'stalled-failed')
})

test('real child success requires exit zero and retains its output and result', async t => {
  const { dir, probe } = diagnosticsFixture(t)
  const result = await probe.child('passing-child', process.execPath, ['-e', 'console.log("completed child")'], {}, 10000)
  assert.equal(result.code, 0)
  assert.match(fs.readFileSync(path.join(dir, 'passing-child-stdout.txt'), 'utf8'), /completed child/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'phase.json'))).phase, 'passing-child-finished')
  assert.equal(fs.existsSync(path.join(dir, 'passing-child-failure.json')), false)
})

test('real child failure retains exit code and output rather than reporting stage success', async t => {
  const { dir, probe } = diagnosticsFixture(t)
  await assert.rejects(probe.child('failing-child', process.execPath, ['-e', 'console.log("before failure"); process.exit(7)'], {}, 10000), { code: 'CHILD_FAILED' })
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'failing-child-result.json'))).code, 7)
  assert.match(fs.readFileSync(path.join(dir, 'failing-child-stdout.txt'), 'utf8'), /before failure/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'phase.json'))).phase, 'failing-child-failed')
})

test('a hanging owned child has a parent deadline and its partial output survives', async t => {
  const { dir, probe } = diagnosticsFixture(t)
  await assert.rejects(probe.child('hanging-child', process.execPath, ['-e', 'console.log("before hang"); setInterval(() => {}, 1000)'], {}, 1500), { code: 'STAGE_TIMEOUT' })
  assert.match(fs.readFileSync(path.join(dir, 'hanging-child-stdout.txt'), 'utf8'), /before hang/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'hanging-child-failure.json'))).code, 'STAGE_TIMEOUT')
  // The child kill is asynchronous. Await its recorded exit before removing its fixture.
  const until = Date.now() + 5000
  while (!fs.existsSync(path.join(dir, 'hanging-child-result.json')) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(fs.existsSync(path.join(dir, 'hanging-child-result.json')), true)
  assert.notEqual(JSON.parse(fs.readFileSync(path.join(dir, 'hanging-child-result.json'))).code, 0)
})

test('NSIS retains its runner OS profile while the app alone gets isolated credentials-free state', () => {
  const base = { USERPROFILE: 'runner-os-profile', APPDATA: 'runner-roaming', LOCALAPPDATA: 'runner-local', SystemDrive: 'system-drive',
    ComSpec: 'system-cmd', PATH: 'system-path', GITHUB_TOKEN: 'must-not-forward', SUPABASE_ANON_KEY: 'must-not-forward', APPLE_ID: 'must-not-forward' }
  const { installerEnv, env } = candidate.smokeEnvironments(base, path.join(os.tmpdir(), 'owned-smoke'))
  assert.equal(installerEnv.USERPROFILE, base.USERPROFILE)
  assert.equal(installerEnv.APPDATA, base.APPDATA)
  assert.equal(installerEnv.LOCALAPPDATA, base.LOCALAPPDATA)
  assert.equal(installerEnv.SystemDrive, base.SystemDrive)
  assert.notEqual(env.USERPROFILE, base.USERPROFILE)
  assert.equal(env.OPENGROUND_SELF_UPDATE, '0')
  for (const value of [installerEnv, env]) for (const key of ['GITHUB_TOKEN', 'SUPABASE_ANON_KEY', 'APPLE_ID']) assert.equal(value[key], undefined)
})

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-windows-feed-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const bytes = Buffer.alloc(256)
  bytes.writeUInt16LE(0x5a4d)
  bytes.writeUInt32LE(128, 0x3c)
  bytes.write('PE\0\0', 128, 'binary')
  bytes.writeUInt16LE(0x14c, 132)
  const name = `OPEN GROUND Setup ${candidate.VERSION}.exe`
  const entry = { url: candidate.PUBLIC_EXE, size: bytes.length, sha512: candidate.hash(bytes, 'sha512', 'base64') }
  const feed = { version: candidate.VERSION, files: [entry], path: entry.url, sha512: entry.sha512 }
  const saveFeed = () => fs.writeFileSync(path.join(dir, 'latest.yml'), yaml.dump(feed))
  fs.writeFileSync(path.join(dir, name), bytes)
  fs.writeFileSync(path.join(dir, name + '.blockmap'), zlib.gzipSync(JSON.stringify({ version: '2', files: [{ name: 'file', offset: 0, sizes: [bytes.length], checksums: ['fixture-checksum'] }] })))
  saveFeed()
  return { dir, name, bytes, feed, saveFeed }
}

test('Windows config keeps normal NSIS identity and Mac guards without a publisher credential', () => {
  const env = { RUNNER_TEMP: os.tmpdir(), GITHUB_RUN_ID: '123' }
  const config = candidate.candidateConfig(source, path.join(os.tmpdir(), 'windows-candidate'), env)
  assert.deepEqual(config.win.target, [{ target: 'nsis', arch: ['x64'] }])
  assert.equal(config.appId, 'local.openground.app')
  assert.deepEqual(config.publish, { provider: 'github', owner: 'nannantown', repo: 'open-ground' })
  assert.equal(config.mac.forceCodeSigning, true)
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_APP_SPECIFIC_PASSWORD']) {
    assert.throws(() => candidate.candidateConfig(source, path.join(os.tmpdir(), 'windows-candidate'), { ...env, [key]: 'do-not-reflect' }), /credentials/)
  }
  assert.throws(() => candidate.candidateConfig(source, path.dirname(os.tmpdir()), env), /runner temp/)
})

test('workflow rejects publisher mode, source drift, wrong runner, credential persistence and tags', () => {
  const text = fs.readFileSync(path.join(__dirname, '../.github/workflows/win-build-check.yml'), 'utf8')
  assert.equal(candidate.assertWorkflow(yaml.load(text)), true)
  const mutations = [
    x => { x.env.APP_SOURCE_SHA = '0'.repeat(40) },
    x => { x.permissions.contents = 'write' },
    x => { x.on.push.tags = ['v*'] },
    x => { x.jobs.windows['runs-on'] = 'windows-latest' },
    x => { x.jobs.windows['continue-on-error'] = true },
    x => { delete x.jobs.windows.steps.find(s => (s.run || '').includes('windows-candidate-smoke.cjs'))['timeout-minutes'] },
    x => { x.jobs.windows.steps.find(s => s.with?.name?.startsWith('windows-candidate-diagnostics-')).if = 'failure()' },
    x => { x.jobs.windows.steps.find(s => s.with?.name?.startsWith('windows-candidate-diagnostics-')).with.path = 'source/**' },
    x => { x.jobs.windows.steps.find(s => s.with?.name?.startsWith('windows-candidate-0.11.182-'))['timeout-minutes'] = 40 },
    x => { x.jobs.windows.steps.find(s => (s.run || '').includes('windows-candidate-smoke.cjs'))['continue-on-error'] = true },
    x => { x.jobs.windows.steps[0].with['persist-credentials'] = true },
    x => { x.jobs.windows.steps.find(s => /electron-builder/.test(s.run || '')).run = 'npx electron-builder --win --publish always' },
    x => { x.jobs.windows.steps.push({ run: 'gh release create v0.11.182' }) },
    x => { x.jobs.windows.steps[0].env = { GITHUB_TOKEN: 'fixture' } },
  ]
  for (const mutate of mutations) { const value = yaml.load(text); mutate(value); assert.throws(() => candidate.assertWorkflow(value)) }
})

test('actual updater resolves stable180 to exact182 Windows asset and refuses downgrade', async t => {
  const f = fixture(t)
  const result = candidate.inspectWindowsFeed(source, f.dir)
  assert.equal(result.files.length, 3)
  assert.equal(result.installerBootstrapMachine, 0x14c)
  assert.equal(result.files[0].sha256, candidate.hash(f.bytes))
  const updater = await candidate.verifyUpdater(source, result.feed)
  assert.equal(updater.assetUrl, `https://github.com/nannantown/open-ground/releases/download/v${candidate.VERSION}/${candidate.PUBLIC_EXE}`)
})

test('feed verification rejects changed installer bytes, legacy checksum, version and foreign URL', t => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.dir, f.name), Buffer.alloc(256))
  assert.throws(() => candidate.inspectWindowsFeed(source, f.dir), /SHA-512/)
  fs.writeFileSync(path.join(f.dir, f.name), f.bytes)
  f.feed.sha512 = 'wrong'; f.saveFeed()
  assert.throws(() => candidate.inspectWindowsFeed(source, f.dir), /Legacy/)
  f.feed.sha512 = f.feed.files[0].sha512
  f.feed.version = '0.11.180'; f.saveFeed()
  assert.throws(() => candidate.inspectWindowsFeed(source, f.dir), /version-pinned/)
  f.feed.version = candidate.VERSION
  f.feed.files[0].url = 'https://foreign.invalid/download.exe'; f.saveFeed()
  assert.throws(() => candidate.inspectWindowsFeed(source, f.dir), /asset path/)
})

test('blockmap must cover the actual installer and payload architecture must be a valid PE', t => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.dir, f.name + '.blockmap'), zlib.gzipSync(JSON.stringify({ version: '2', files: [{ offset: 0, sizes: [1], checksums: ['wrong'] }] })))
  assert.throws(() => candidate.inspectWindowsFeed(source, f.dir), /coverage/)
  assert.throws(() => candidate.peMachine(Buffer.alloc(10)), /PE/)
  const x64 = Buffer.from(f.bytes); x64.writeUInt16LE(0x8664, 132)
  assert.equal(candidate.peMachine(x64), 0x8664)
})

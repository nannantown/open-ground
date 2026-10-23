// Release orchestration only; the packaged application stays at SOURCE_SHA.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const zlib = require('node:zlib')
const { createRequire } = require('node:module')
const { execFileSync } = require('node:child_process')

const SOURCE_SHA = '7651991cc6a320beb4e4af903f17828046dc9f36'
const VERSION = '0.11.182'
const BRANCH = 'codex/windows-candidate-0.11.182-20261023'
const PUBLIC_EXE = `OPEN-GROUND-Setup-${VERSION}.exe`
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => crypto.createHash(algorithm).update(bytes).digest(encoding)
const sourceRequire = source => createRequire(path.join(path.resolve(source), 'package.json'))
const inside = (root, target) => path.resolve(target).startsWith(path.resolve(root) + path.sep)

function smokeEnvironments(base, profile) {
  // NSIS uses the real Windows shell-folder/registry context of this disposable
  // runner account. Only the application receives a new isolated profile.
  const installerEnv = Object.fromEntries(Object.entries(base).filter(([key]) =>
    /^(Path|SystemRoot|SystemDrive|WINDIR|COMSPEC|TEMP|TMP|PATHEXT|PROCESSOR_.*|NUMBER_OF_PROCESSORS|OS|USERPROFILE|USERNAME|USERDOMAIN|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|ALLUSERSPROFILE|PROGRAMDATA|PROGRAMFILES(?:\(X86\))?|PROGRAMW6432|COMMONPROGRAMFILES(?:\(X86\))?|COMMONPROGRAMW6432|PUBLIC)$/i.test(key)))
  const home = path.join(profile, 'home')
  const env = { ...installerEnv, HOME: home, USERPROFILE: home,
    APPDATA: path.join(profile, 'roaming'), LOCALAPPDATA: path.join(profile, 'local'),
    OPENGROUND_HOME: path.join(home, '.openground'), OPENGROUND_SELF_UPDATE: '0',
    OPENGROUND_SWARM_AUTODRAIN: '0', OPENGROUND_CLAUDE_BIN: path.join(profile, 'no-real-claude.exe') }
  return { installerEnv, env }
}

function assertSource(source) {
  const sha = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (sha !== SOURCE_SHA || sourceRequire(source)('./package.json').version !== VERSION) throw new Error('Unexpected application source/version.')
  return sha
}

function candidateConfig(source, root, env = process.env) {
  if (!env.RUNNER_TEMP || !inside(env.RUNNER_TEMP, root)) throw new Error('Output must stay inside runner temp.')
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_APP_SPECIFIC_PASSWORD']) {
    if (env[key]) throw new Error('Publisher/signing credentials must not reach Windows packaging.')
  }
  const req = sourceRequire(source)
  const base = req('./package.json').build
  const config = req('./scripts/production-candidate-config.cjs').createProductionCandidateConfig(base, {
    runnerTemp: env.RUNNER_TEMP, output: path.join(root, 'build'), sha: SOURCE_SHA, runId: env.GITHUB_RUN_ID,
  })
  return { ...config, win: { ...config.win, target: [{ target: 'nsis', arch: ['x64'] }] } }
}

function assertWorkflow(workflow) {
  const expected = { workflow_dispatch: null, push: { branches: [BRANCH] } }
  if (JSON.stringify(workflow.on) !== JSON.stringify(expected) ||
      JSON.stringify(workflow.permissions) !== JSON.stringify({ contents: 'read' }) ||
      workflow.env.APP_SOURCE_SHA !== SOURCE_SHA || workflow.concurrency['cancel-in-progress'] !== false) throw new Error('Unsafe Windows workflow boundary.')
  const jobs = Object.values(workflow.jobs)
  if (jobs.length !== 1 || jobs[0]['runs-on'] !== 'windows-2022' || jobs[0].permissions ||
      !jobs[0].if.includes("github.repository == 'nannantown/open-ground'") ||
      !jobs[0].if.includes(`github.ref == 'refs/heads/${BRANCH}'`)) throw new Error('Unexpected Windows runner/ref.')
  const steps = jobs[0].steps
  const native = steps.find(step => (step.run || '').includes('windows-candidate-smoke.cjs'))
  if (native?.['timeout-minutes'] !== 8) throw new Error('Native acceptance must have its own bounded deadline.')
  const source = steps.find(step => step.uses === 'actions/checkout@v4' && step.with.path === 'source')
  if (source?.with.ref !== '${{ env.APP_SOURCE_SHA }}') throw new Error('Application checkout must pin the verified SHA.')
  for (const step of steps) {
    if (step.uses === 'actions/checkout@v4' && step.with['persist-credentials'] !== false) throw new Error('Checkout credentials must not persist.')
    if (Object.keys(step.env || {}).some(k => /^(GH_TOKEN|GITHUB_TOKEN|CSC_|APPLE_)/.test(k))) throw new Error('Unexpected publisher/signing environment.')
    if (step.permissions || /upload-release|release-action/.test(step.uses || '')) throw new Error('Unexpected publication action.')
  }
  const commands = steps.map(step => step.run || '').join('\n')
  if (!commands.includes('electron-builder --win --x64 --publish never --config') ||
      /--publish\s+(?!never\b)|gh\s+(release|api)|git\s+(push|tag)|--mac|notari[sz]/.test(commands)) throw new Error('Unsafe packaging/promotion command.')
  return true
}

function peMachine(bytes) {
  if (bytes.length < 128 || bytes.readUInt16LE(0) !== 0x5a4d) throw new Error('Invalid PE DOS header.')
  const offset = bytes.readUInt32LE(0x3c)
  if (offset + 6 > bytes.length || bytes.toString('binary', offset, offset + 4) !== 'PE\0\0') throw new Error('Invalid PE header.')
  return bytes.readUInt16LE(offset + 4)
}

function inspectWindowsFeed(source, build) {
  const yaml = sourceRequire(source)('js-yaml')
  const feed = yaml.load(fs.readFileSync(path.join(build, 'latest.yml'), 'utf8'))
  if (feed.version !== VERSION || !Array.isArray(feed.files) || feed.files.length !== 1) throw new Error('Expected version-pinned single-installer Windows feed.')
  const archives = fs.readdirSync(build).filter(name => name.endsWith('.exe'))
  if (archives.length !== 1) throw new Error('Expected exactly one NSIS installer.')
  const name = archives[0]
  const item = feed.files[0]
  if (name.replace(/ /g, '-') !== PUBLIC_EXE || item.url !== PUBLIC_EXE || /[\\/]/.test(item.url)) throw new Error('Unexpected Windows asset path.')
  const bytes = fs.readFileSync(path.join(build, name))
  if (item.size !== bytes.length || item.sha512 !== hash(bytes, 'sha512', 'base64')) throw new Error('Installer size/SHA-512 mismatch.')
  if (feed.path !== item.url || feed.sha512 !== item.sha512) throw new Error('Legacy updater path/checksum mismatch.')
  const machine = peMachine(bytes)
  if (![0x14c, 0x8664].includes(machine)) throw new Error('Unexpected NSIS bootstrap architecture.')
  const blockmapName = name + '.blockmap'
  const encoded = fs.readFileSync(path.join(build, blockmapName))
  const blockmap = JSON.parse(zlib.gunzipSync(encoded).toString())
  if (blockmap.version !== '2' || blockmap.files.length !== 1) throw new Error('Unexpected Windows blockmap format.')
  const chunks = blockmap.files[0]
  if (chunks.offset !== 0 || chunks.sizes.length === 0 || chunks.sizes.length !== chunks.checksums.length ||
      chunks.sizes.some(n => !Number.isSafeInteger(n) || n <= 0) || chunks.checksums.some(x => typeof x !== 'string' || !x) ||
      chunks.sizes.reduce((a, b) => a + b, 0) !== bytes.length) throw new Error('Blockmap coverage does not match installer.')
  const files = [name, blockmapName, 'latest.yml'].map(file => {
    const data = fs.readFileSync(path.join(build, file))
    return { name: file, releaseAssetName: file.replace(/ /g, '-'), bytes: data.length, sha256: hash(data) }
  })
  return { feed, files, installerBootstrapMachine: machine, blockmapChunks: chunks.sizes.length }
}

async function verifyUpdater(source, feed) {
  const req = sourceRequire(source)
  const { GitHubProvider } = req('electron-updater/out/providers/GitHubProvider')
  const { AppUpdater } = req('electron-updater/out/AppUpdater')
  const semver = req('semver')
  const updater = { currentVersion: semver.parse('0.11.180'), allowPrerelease: false, allowDowngrade: false,
    isUpdateSupported: () => true, isUserWithinRollout: () => true }
  const provider = new GitHubProvider({ provider: 'github', owner: 'nannantown', repo: 'open-ground' }, updater, { platform: 'win32', executor: null })
  if (provider.channel !== 'latest' || !await AppUpdater.prototype.isUpdateAvailable.call(updater, feed) ||
      await AppUpdater.prototype.isUpdateAvailable.call(updater, { ...feed, version: '0.11.180' }) ||
      await AppUpdater.prototype.isUpdateAvailable.call(updater, { ...feed, version: '0.11.179' })) throw new Error('Stable updater version/channel regression.')
  const resolved = provider.resolveFiles({ ...feed, tag: `v${VERSION}` })
  if (resolved.length !== 1 || resolved[0].url.href !== `https://github.com/nannantown/open-ground/releases/download/v${VERSION}/${PUBLIC_EXE}`) throw new Error('Updater resolved a foreign/missing asset.')
  return { fromVersion: '0.11.180', toVersion: VERSION, channel: 'latest.yml', downgradeAllowed: false, assetUrl: resolved[0].url.href }
}

async function cli() {
  const [command, sourceArg, rootArg] = process.argv.slice(2)
  const source = path.resolve(sourceArg || '')
  const root = path.resolve(rootArg || '')
  assertSource(source)
  const req = sourceRequire(source)
  if (command === 'validate-env') {
    const { BAKED_KEYS } = req('./electron/runtimeConfig')
    req('./scripts/production-candidate-config.cjs').assertProductionRuntimeConfig(Object.fromEntries(BAKED_KEYS.map(k => [k, (process.env[k] || '').trim()]).filter(([, v]) => v)))
    console.log('Existing production configuration accepted; values withheld.')
  } else if (command === 'prepare') {
    const config = candidateConfig(source, root)
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, 'builder.json'), JSON.stringify(config, null, 2), { flag: 'wx' })
  } else if (command === 'verify') {
    const build = path.join(root, 'build')
    const resources = path.join(build, 'win-unpacked/resources')
    const exe = path.join(build, 'win-unpacked/OPEN GROUND.exe')
    if (peMachine(fs.readFileSync(exe)) !== 0x8664) throw new Error('Packaged app must be Windows x64.')
    if (req(path.join(resources, 'app/package.json')).version !== VERSION) throw new Error('Packaged version mismatch.')
    const { BAKED_KEYS } = req('./electron/runtimeConfig')
    const expected = Object.fromEntries(BAKED_KEYS.map(k => [k, (process.env[k] || '').trim()]).filter(([, v]) => v))
    const runtime = req('./scripts/verify-production-candidate.cjs').verifyPackagedConfig(resources, expected)
    const inspected = inspectWindowsFeed(source, build)
    const updater = await verifyUpdater(source, inspected.feed)
    const verified = path.join(root, 'verified')
    fs.mkdirSync(verified, { recursive: true })
    for (const file of inspected.files) fs.copyFileSync(path.join(build, file.name), path.join(verified, file.name), fs.constants.COPYFILE_EXCL)
    fs.writeFileSync(path.join(verified, 'manifest.json'), JSON.stringify({ sourceSha: SOURCE_SHA, workflowSha: process.env.GITHUB_SHA,
      runId: process.env.GITHUB_RUN_ID, version: VERSION, platform: 'win32', architecture: 'x64',
      signed: false, signaturePolicy: 'Existing unsigned Windows NSIS distribution; no signing credential introduced.',
      published: false, nativeSmokeVerified: false, runtime, updater, files: inspected.files, installerBootstrapMachine: inspected.installerBootstrapMachine,
      blockmapChunks: inspected.blockmapChunks }, null, 2), { flag: 'wx' })
    console.log('Windows payload/config/feed/blockmap/updater contract verified; no configuration values printed.')
  } else throw new Error('Unknown candidate operation.')
}
module.exports = { SOURCE_SHA, VERSION, BRANCH, PUBLIC_EXE, hash, candidateConfig, assertWorkflow, peMachine, inspectWindowsFeed, verifyUpdater, smokeEnvironments }
if (require.main === module) cli().catch(error => { console.error(error.message); process.exitCode = 1 })

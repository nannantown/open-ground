// Inspect files only: never load or execute the packaged application.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const yaml = require('js-yaml')
const { assertProductionRuntimeConfig, UPDATE_SOURCE } = require('./production-candidate-config.cjs')

function verifyPackagedConfig(resources, expected) {
  let config
  try { config = JSON.parse(fs.readFileSync(path.join(resources, 'app/electron/runtime-config.json'), 'utf8')) }
  catch { throw new Error('Packaged runtime configuration is missing or invalid; contents withheld.') }
  const summary = assertProductionRuntimeConfig(config)
  if (expected && (Object.keys(expected).length !== Object.keys(config).length ||
      Object.keys(expected).some(key => expected[key] !== config[key]))) throw new Error('Packaged runtime configuration differs from the existing CI inputs.')
  const update = yaml.load(fs.readFileSync(path.join(resources, 'app-update.yml'), 'utf8'))
  for (const [key, value] of Object.entries(UPDATE_SOURCE)) {
    if (update[key] !== value) throw new Error('Packaged updater destination differs from the established repository.')
  }
  if (Object.keys(update).some(key => !['provider', 'owner', 'repo', 'updaterCacheDirName'].includes(key))) throw new Error('Unexpected embedded updater option.')
  return { ...summary, updateSource: UPDATE_SOURCE }
}

function inspectUpdateFeed(build, version) {
  const feed = yaml.load(fs.readFileSync(path.join(build, 'latest-mac.yml'), 'utf8'))
  if (feed.version !== version || !Array.isArray(feed.files) || feed.files.length !== 4) throw new Error('Expected version-pinned Mac feed with four installer entries.')
  const archives = fs.readdirSync(build).filter(name => /\.(zip|dmg)$/.test(name))
  if (archives.length !== 4) throw new Error('Expected four Mac installers.')
  const used = new Set()
  const artifacts = []
  for (const item of feed.files) {
    // electron-builder's GitHub feed uses its safe asset name; preserve the map.
    if (typeof item.url !== 'string' || /[\\/]/.test(item.url)) throw new Error('Feed must contain local asset names only.')
    const matches = archives.filter(name => name.replace(/ /g, '-') === decodeURIComponent(item.url) || name === decodeURIComponent(item.url))
    if (matches.length !== 1 || used.has(matches[0])) throw new Error('Feed asset has no unique local installer.')
    const name = matches[0]
    used.add(name)
    const bytes = fs.readFileSync(path.join(build, name))
    if (item.size !== bytes.length || item.sha512 !== crypto.createHash('sha512').update(bytes).digest('base64')) throw new Error('Feed size or SHA-512 does not match its installer.')
    artifacts.push({ name, releaseAssetName: item.url, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') })
  }
  if (feed.path && !feed.files.some(item => item.url === feed.path && item.sha512 === feed.sha512)) throw new Error('Legacy feed path/hash does not match an installer entry.')
  return artifacts
}

module.exports = { verifyPackagedConfig, inspectUpdateFeed }
if (require.main === module) {
  const root = process.env.CANDIDATE_ROOT
  if (!root) throw new Error('Expected CANDIDATE_ROOT.')
  const build = path.join(root, 'build')
  const verified = path.join(root, 'verified')
  const { BAKED_KEYS } = require('../electron/runtimeConfig')
  const expected = Object.fromEntries(BAKED_KEYS.map(key => [key, (process.env[key] || '').trim()]).filter(([, value]) => value))
  const runtime = ['mac', 'mac-arm64'].map(folder => verifyPackagedConfig(path.join(build, folder, 'OPEN GROUND.app/Contents/Resources'), expected))
  const version = require('../package.json').version
  const artifacts = inspectUpdateFeed(build, version)
  for (const arch of ['arm64', 'x64']) {
    if (artifacts.filter(item => item.name.includes(`-${arch}.`)).length !== 2) throw new Error('Expected one ZIP and DMG per architecture.')
  }
  const extras = fs.readdirSync(build).filter(name => /\.(dmg|zip)\.blockmap$/.test(name) || name === 'latest-mac.yml')
  if (extras.filter(name => name.endsWith('.blockmap')).length !== 4) throw new Error('Expected four update blockmaps.')
  const approved = [...artifacts.map(item => item.name), ...extras]
  for (const name of approved) fs.copyFileSync(path.join(build, name), path.join(verified, name), fs.constants.COPYFILE_EXCL)
  const files = approved.map(name => {
    const bytes = fs.readFileSync(path.join(verified, name))
    return { name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }
  })
  fs.writeFileSync(path.join(verified, 'manifest.json'), JSON.stringify({ sourceSha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID,
    version, signaturesVerified: true, stapledTicketsValidated: true, appExecuted: false, published: false,
    runtime, feedVerified: true, installerAssetMap: artifacts, files }, null, 2) + '\n', { flag: 'wx' })
  console.log('Both packaged runtime configs, established updater destination, feed hashes and artifact inventory verified. No configuration values printed.')
}

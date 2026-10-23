// Retain the installed client's update metadata without granting a publisher.
const fs = require('node:fs')
const path = require('node:path')
const { createCandidateConfig } = require('./candidate-build-config.cjs')

const UPDATE_SOURCE = Object.freeze({ provider: 'github', owner: 'nannantown', repo: 'open-ground' })
const COLLAB_URL = 'wss://og-collab.mindbrew.workers.dev'
const { BAKED_KEYS } = require('../electron/runtimeConfig')

function assertProductionRuntimeConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      Object.keys(config).some(key => !BAKED_KEYS.includes(key))) throw new Error('Unexpected runtime configuration key.')
  let url
  try { url = new URL(config.SUPABASE_URL) } catch { throw new Error('Missing or invalid public Supabase URL.') }
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) ||
      url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Public Supabase URL must use the existing hosted-project format.')
  }
  const key = config.SUPABASE_ANON_KEY
  let publicKey = typeof key === 'string' && /^sb_publishable_[A-Za-z0-9_-]+$/.test(key)
  if (!publicKey && typeof key === 'string' && key.split('.').length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8'))
      publicKey = payload.role === 'anon' && (!payload.ref || payload.ref === url.hostname.split('.')[0])
    } catch { /* Fixed error below never includes a supplied credential. */ }
  }
  if (!publicKey) throw new Error('SUPABASE_ANON_KEY must be a public publishable/anon key; refusing privileged or unknown keys.')
  if (typeof config.OPENGROUND_PHONE_RELAY_APP_KEY !== 'string' || !config.OPENGROUND_PHONE_RELAY_APP_KEY.trim()) {
    throw new Error('Existing phone room-creation install pass is missing.')
  }
  // Preserve the release workflow's explicit opt-in. No default enables collab.
  if (config.OPENGROUND_REALTIME !== undefined && !['0', '1'].includes(config.OPENGROUND_REALTIME)) {
    throw new Error('Unexpected realtime opt-in flag.')
  }
  if (config.OPENGROUND_COLLAB_WS_URL !== undefined && config.OPENGROUND_COLLAB_WS_URL !== COLLAB_URL) {
    throw new Error('Unexpected public collaboration destination.')
  }
  if (config.OPENGROUND_REALTIME === '1' && config.OPENGROUND_COLLAB_WS_URL !== COLLAB_URL) {
    throw new Error('Realtime opt-in requires the established collaboration destination.')
  }
  return { runtimeConfigKeys: Object.keys(config).sort(), loginConfigured: true,
    phoneCreationPassIncluded: true, realtimeEnabled: config.OPENGROUND_REALTIME === '1' }
}

function createProductionCandidateConfig(base, context) {
  const config = createCandidateConfig(base, context)
  if (JSON.stringify(base.publish) !== JSON.stringify(UPDATE_SOURCE)) throw new Error('Unexpected update repository or publisher options.')
  // The CLI still MUST use --publish never; CI has contents:read and no GH_TOKEN.
  return { ...config, publish: { ...UPDATE_SOURCE } }
}

module.exports = { createProductionCandidateConfig, assertProductionRuntimeConfig, UPDATE_SOURCE }
if (require.main === module) {
  const [file, output] = process.argv.slice(2)
  if (!file || !output || !process.env.RUNNER_TEMP) throw new Error('Expected config/output paths and RUNNER_TEMP.')
  const config = createProductionCandidateConfig(require('../package.json').build, {
    runnerTemp: process.env.RUNNER_TEMP, output, sha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID,
  })
  if (!path.resolve(file).startsWith(path.resolve(process.env.RUNNER_TEMP) + path.sep)) throw new Error('Config must stay in RUNNER_TEMP.')
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' })
}

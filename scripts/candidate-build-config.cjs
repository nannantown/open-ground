// Candidate builds must not inherit the release publisher or update feed.
const fs = require('node:fs')
const path = require('node:path')

function createCandidateConfig(base, { runnerTemp, output, sha, runId }) {
  if (!/^[0-9a-f]{40}$/.test(sha) || !/^\d+$/.test(runId)) throw new Error('Expected an exact source SHA and Actions run ID.')
  const temp = path.resolve(runnerTemp)
  const target = path.resolve(output)
  if (!target.startsWith(temp + path.sep)) throw new Error('Candidate output must be inside the runner temporary directory.')
  if (base.mac.forceCodeSigning !== true || base.mac.type !== 'distribution' ||
      base.mac.identity === null || base.mac.identity === '-' || base.mac.strictVerify !== undefined ||
      base.beforePack !== 'scripts/check-mac-signing.cjs' || base.afterSign !== 'scripts/verify-mac-signature.cjs') {
    throw new Error('Required Mac signing policy or final verifier is missing.')
  }
  return { ...base, publish: null, directories: { ...base.directories, output: target },
    mac: { ...base.mac, notarize: true } }
}

module.exports.createCandidateConfig = createCandidateConfig
if (require.main === module) {
  const [configFile, output] = process.argv.slice(2)
  if (!configFile || !output || !process.env.RUNNER_TEMP) throw new Error('Expected config/output paths and RUNNER_TEMP.')
  const config = createCandidateConfig(require('../package.json').build, {
    runnerTemp: process.env.RUNNER_TEMP, output, sha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID,
  })
  if (!path.resolve(configFile).startsWith(path.resolve(process.env.RUNNER_TEMP) + path.sep)) throw new Error('Config must stay in RUNNER_TEMP.')
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' })
}

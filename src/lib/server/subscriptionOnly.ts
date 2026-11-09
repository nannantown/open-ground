import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { absoluteClaudeOnPath, resolvedClaudeBin } from './claudeConnection'

const execFile = promisify(execFileCallback)
const metered = /^(?:ANTHROPIC_(?:API_KEY|AUTH_TOKEN|BASE_URL|CUSTOM_HEADERS)|OPENAI_(?:API_KEY|BASE_URL|API_BASE)|CLAUDE_CODE_(?:API_KEY_HELPER|OAUTH_TOKEN|USE_BEDROCK|USE_VERTEX|USE_FOUNDRY)|AWS_BEARER_TOKEN_BEDROCK|ANTHROPIC_FOUNDRY_.*|ANTHROPIC_VERTEX_.*)$/
export const METERED_CLAUDE_ENV_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_BASE', 'CLAUDE_CODE_API_KEY_HELPER', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_RESOURCE', 'ANTHROPIC_VERTEX_PROJECT_ID'] as const
/** Child-only boundary. An ambient key cannot silently become a paid fallback. */
export const subscriptionOnlyEnvironment = (source: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const result = { ...source }
  // SDKs commonly overlay env on process.env. Explicit undefined shadows a
  // parent key and Node omits it from the child's actual environment.
  for (const key of [...METERED_CLAUDE_ENV_KEYS, ...Object.keys(source).filter((key) => metered.test(key))]) result[key] = undefined
  return result
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const SIGN_IN_REQUIRED = 'Sign in to a Claude subscription. API-key and alternative-provider execution are disabled.'
const AUTH_UNVERIFIED = 'Claude subscription authentication could not be verified. Check the Claude CLI and sign in again before switching.'
const parseStatus = (stdout: unknown): unknown => {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > 64 * 1024) throw new Error(AUTH_UNVERIFIED)
  try { return JSON.parse(stdout) } catch { throw new Error(AUTH_UNVERIFIED) }
}
export const assertSubscriptionSettings = (value: unknown): void => {
  if (!object(value)) throw new Error('Claude settings could not be verified for subscription-only use.')
  if (value.apiKeyHelper !== undefined || value.awsAuthRefresh !== undefined || value.awsCredentialExport !== undefined) throw new Error('Claude has an API credential helper configured. Subscription-only execution is paused.')
  if (object(value.env) && Object.entries(value.env).some(([key, v]) => metered.test(key) && v !== undefined && v !== null && v !== '')) throw new Error('Claude settings select an API credential or alternative provider. Subscription-only execution is paused.')
}
export const assertClaudeSubscriptionStatus = (value: unknown): void => {
  if (!object(value) || value.loggedIn !== true || value.authMethod !== 'claude.ai' || value.apiProvider !== 'firstParty' || value.apiKeySource) throw new Error(SIGN_IN_REQUIRED)
}
const verifySettingsFiles = async (cwd: string, env: NodeJS.ProcessEnv): Promise<void> => {
  const config = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  const paths = new Set([join(config, 'settings.json'), join(config, 'settings.local.json')])
  if (process.platform === 'darwin') paths.add('/Library/Application Support/ClaudeCode/managed-settings.json')
  else if (process.platform === 'win32') paths.add(join(env.ProgramFiles || 'C:\\Program Files', 'ClaudeCode', 'managed-settings.json'))
  else paths.add('/etc/claude-code/managed-settings.json')
  let cursor = resolve(cwd)
  for (;;) {
    paths.add(join(cursor, '.claude', 'settings.json')); paths.add(join(cursor, '.claude', 'settings.local.json'))
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent
  }
  for (const path of Array.from(paths)) {
    try {
      const text = await readFile(path, 'utf8')
      if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Claude settings exceed their verification limit.')
      assertSubscriptionSettings(JSON.parse(text))
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
}
/** Read-only auth verification of the exact child environment and cwd. This
 * never logs credentials, starts a model, purchases credits or edits settings. */
export const assertClaudeSubscriptionLaunch = async (cwd: string, source: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> => {
  const env = subscriptionOnlyEnvironment(source)
  await verifySettingsFiles(cwd, env)
  const binary = source.OPENGROUND_CLAUDE_BIN || resolvedClaudeBin() || absoluteClaudeOnPath() || 'claude'
  let stdout: string
  try {
    const result = await execFile(binary, ['auth', 'status'], { cwd, env, timeout: 6000, maxBuffer: 64 * 1024, shell: process.platform === 'win32' })
    stdout = result.stdout
  } catch (error) {
    // The official CLI uses exit 1 for a normal signed-out status. Only that
    // exact negative proof is classified; never accept positive auth from a
    // failed, killed or timed-out command. Raw command/stdout/stderr stay private.
    if (object(error) && error.code === 1 && error.killed !== true && !error.signal) {
      const status = parseStatus(error.stdout)
      if (object(status) && status.loggedIn === false && status.authMethod === 'none' && status.apiProvider === 'firstParty' && !status.apiKeySource)
        throw new Error(SIGN_IN_REQUIRED)
    }
    throw new Error(AUTH_UNVERIFIED)
  }
  assertClaudeSubscriptionStatus(parseStatus(stdout))
  return env
}

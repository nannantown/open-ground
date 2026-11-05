import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
const execFile = promisify(execFileCallback)
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`
const probe = async (mode: 'subscription' | 'signedout' | 'api-key') => {
  const root = await mkdtemp(join(tmpdir(), 'og-tier-subscription-')); roots.push(root)
  const home = join(root, 'home'), config = join(home, '.claude'), neutral = join(root, 'neutral')
  await mkdir(config, { recursive: true }); await mkdir(neutral)
  const audit = join(root, 'calls.jsonl'), fake = join(root, 'fake-claude.mjs'), runner = join(root, 'runner.mts')
  const binary = join(root, process.platform === 'win32' ? 'fake-claude.cmd' : 'fake-claude')
  await writeFile(fake, [
    "import { appendFileSync } from 'node:fs';",
    'const argv = process.argv.slice(2);',
    "const dirty = Object.keys(process.env).filter(key => /^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL|CUSTOM_HEADERS)|OPENAI_(API_KEY|BASE_URL|API_BASE)|CLAUDE_CODE_(API_KEY_HELPER|OAUTH_TOKEN|USE_BEDROCK|USE_VERTEX|USE_FOUNDRY)|AWS_BEARER_TOKEN_BEDROCK)$/.test(key));",
    "const kind = argv[0] === 'auth' && argv[1] === 'status' ? 'auth' : 'inference';",
    `appendFileSync(${JSON.stringify(audit)}, JSON.stringify({kind,argv,dirty,cwd:process.cwd(),binary:process.execPath})+'\\n');`,
    `if(kind==='auth') console.log(JSON.stringify(${JSON.stringify(mode === 'subscription' ? { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' } : mode === 'signedout' ? { loggedIn: false } : { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty', apiKeySource: 'environment' })}));`,
    "else console.log('PROBE_OK');",
  ].join('\n'))
  await writeFile(binary, process.platform === 'win32'
    ? `@"${process.execPath}" "${fake}" %*\r\n`
    : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fake)} "$@"\n`)
  if (process.platform !== 'win32') await chmod(binary, 0o700)
  await writeFile(runner, [
    `import {ensureTierProbed} from ${JSON.stringify(resolve('src/lib/server/swarmTierProbe.ts'))};`,
    `const verdict = await ensureTierProbed('sonnet',{bin:${JSON.stringify(binary)},launchWaitMs:Number.POSITIVE_INFINITY,timeoutMs:5000});`,
    'console.log(JSON.stringify({verdict}));',
  ].join('\n'))
  // No inherited vendor credentials/config. Deliberately dirty synthetic values
  // test the production filter; the executable itself only records argv/env and
  // prints fixture JSON. There is no CLI/model/network implementation here.
  const env: NodeJS.ProcessEnv = { PATH: `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`, HOME: home,
    USERPROFILE: home, CLAUDE_CONFIG_DIR: config, OPENGROUND_HOME: join(root, 'og-data'), TMPDIR: neutral, TEMP: neutral, TMP: neutral,
    OPENGROUND_CLAUDE_BIN: join(root, 'wrong-binary-must-not-run'), ELECTRON_RUN_AS_NODE: '1',
    ANTHROPIC_API_KEY: 'synthetic-never-used', ANTHROPIC_AUTH_TOKEN: 'synthetic-never-used', ANTHROPIC_BASE_URL: 'https://invalid.example',
    OPENAI_API_KEY: 'synthetic-never-used', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-never-used' }
  const { stdout } = await execFile(process.execPath, ['--import', 'tsx', runner], { cwd: process.cwd(), env, timeout: 15000, maxBuffer: 64 * 1024 })
  const calls = (await readFile(audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { kind: string; argv: string[]; dirty: string[]; cwd: string; binary: string })
  return { result: JSON.parse(stdout.trim()) as { verdict: string }, calls, neutral: await realpath(neutral) }
}
describe('production tier probe subscription boundary with fake child executables', () => {
  it.each(['signedout', 'api-key'] as const)('never reaches inference after %s auth, despite ambient API credentials', async mode => {
    const f = await probe(mode)
    expect(f.result.verdict).toBe('unknown')
    expect(f.calls.map(call => call.kind)).toEqual(['auth'])
    expect(f.calls[0]).toMatchObject({ argv: ['auth', 'status'], dirty: [] })
  })
  it('verifies the exact binary and sends only the filtered environment into the actual probe child', async () => {
    const f = await probe('subscription')
    expect(f.result.verdict).toBe('ok')
    expect(f.calls.map(call => call.kind)).toEqual(['auth', 'inference'])
    expect(f.calls.every(call => call.dirty.length === 0)).toBe(true)
    expect(f.calls[1].argv).toEqual(['--model', 'sonnet', '-p', 'reply with exactly: PROBE_OK', '--strict-mcp-config'])
    expect(f.calls[0].cwd).toBe(f.calls[1].cwd)
    expect(f.calls[1].cwd).toBe(f.neutral)
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { chatGptShellPreflight, createChatGptHostTools, runChatGptCommand } from './chatgptTools'
import { makeSdkGuardHook } from './sdkGuardHook'
import { REPO_PROBE_PREFIX } from '../../test/repoRootFence'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const temp = async () => { const root = await mkdtemp(join(tmpdir(), 'og-chatgpt-tools-')); roots.push(root); return root }
// The real guard intentionally permits system scratch directories. Place the
// outside-root fixture in this test checkout so it exercises a real denial.
const outsideTemp = async () => { const root = await mkdtemp(join(process.cwd(), `${REPO_PROBE_PREFIX}chatgpt-tools-`)); roots.push(root); return root }
const signal = () => new AbortController().signal
const toolsIn = (cwd: string) => createChatGptHostTools({ cwd, guard: makeSdkGuardHook({ writeRoots: [cwd], home: '/Users/test', guardPath: resolve('scripts/openground-guard.js') }) })
const macIt = it.runIf(process.platform === 'darwin')

describe('ChatGPT host tools keep the worker veto at execution', () => {
  macIt('writes/reads/edits an ordinary worktree file through the real credential sandbox', async () => {
    const cwd = await temp()
    const tools = toolsIn(cwd)
    const named = (name: string) => tools.find((tool) => tool.name === name)!
    await named('Write').invoke({ file_path: 'greeting.txt', content: 'hello friend' }, signal())
    expect(await readFile(join(cwd, 'greeting.txt'), 'utf8')).toBe('hello friend')
    await named('Edit').invoke({ file_path: 'greeting.txt', old_string: 'friend', new_string: 'world' }, signal())
    expect(await named('Read').invoke({ file_path: 'greeting.txt' }, signal())).toMatchObject({ text: '1: hello world' })
  })

  it('denies a normal outside write and git push before attempting host execution', async () => {
    const cwd = await temp()
    const outside = await outsideTemp()
    const tools = toolsIn(cwd)
    const named = (name: string) => tools.find((tool) => tool.name === name)!
    await expect(named('Write').invoke({ file_path: join(outside, 'denied.txt'), content: 'ordinary file' }, signal())).rejects.toThrow(/BLOCKED|denied|outside/i)
    await expect(access(join(outside, 'denied.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(named('Bash').invoke({ command: 'git push origin HEAD:main' }, signal())).rejects.toThrow(/BLOCKED|denied|push/i)
  })

  it('checks canonical targets so a worktree symlink cannot rename an outside write', async () => {
    const cwd = await temp()
    const outside = await outsideTemp()
    await symlink(outside, join(cwd, 'alias'))
    const write = toolsIn(cwd).find((tool) => tool.name === 'Write')!
    await expect(write.invoke({ file_path: 'alias/new.txt', content: 'no' }, signal())).rejects.toThrow(/BLOCKED|denied|outside/i)
    await expect(access(join(outside, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed for missing, throwing, or malformed guard and validates arguments before execution', async () => {
    const cwd = await temp()
    expect(() => createChatGptHostTools({ cwd })).toThrow(/guard/)
    for (const guard of [async () => { throw new Error('broken hook') }, async () => undefined, async () => ({ hookSpecificOutput: { permissionDecision: 'maybe' } })]) {
      const write = createChatGptHostTools({ cwd, guard }).find((tool) => tool.name === 'Write')!
      await expect(write.invoke({ file_path: 'blocked.txt', content: 'no' }, signal())).rejects.toThrow(/guard|denied/)
      await expect(access(join(cwd, 'blocked.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    const guard = vi.fn(async () => ({ hookSpecificOutput: { permissionDecision: 'allow' } }))
    const write = createChatGptHostTools({ cwd, guard }).find((tool) => tool.name === 'Write')!
    await expect(write.invoke({ file_path: 'bad.txt', content: 'no', ignored: 'not accepted' }, signal())).rejects.toThrow()
    expect(guard).not.toHaveBeenCalled()
  })

  macIt('passes one guard decision per action and has no persistent shell/background channel', async () => {
    const cwd = await temp()
    const guard = vi.fn(async () => ({ hookSpecificOutput: { permissionDecision: 'allow' } }))
    const tools = createChatGptHostTools({ cwd, guard })
    const bash = tools.find((tool) => tool.name === 'Bash')!
    expect(await bash.invoke({ command: 'printf hello' }, signal())).toMatchObject({ stdout: 'hello', exitCode: 0 })
    expect(await bash.invoke({ command: "printf 'a&b'" }, signal())).toMatchObject({ stdout: 'a&b', exitCode: 0 })
    expect(await bash.invoke({ command: 'sleep 30 >/dev/null 2>&1 & echo $! > background.pid' }, signal())).toMatchObject({ exitCode: 0, remainingProcessesStopped: true })
    const background = Number(await readFile(join(cwd, 'background.pid'), 'utf8'))
    expect(() => process.kill(background, 0)).toThrow()
    expect(guard).toHaveBeenCalledTimes(3)
    expect(tools.map((tool) => tool.name)).toEqual(['Bash', 'Read', 'Write', 'Edit'])
  })

  macIt('aborts a real foreground command and kills its process group before returning', async () => {
    const cwd = await temp()
    const controller = new AbortController()
    const running = runChatGptCommand({ cwd, command: 'echo $$ > command.pid; sleep 30', signal: controller.signal, timeoutMs: 2000 })
    // Keep a rejection handler attached while waiting for the file evidence.
    const observed = running.then(() => null, (error: unknown) => error)
    let pid = 0
    for (let i = 0; i < 100 && !pid; i++) {
      try { pid = Number(await readFile(join(cwd, 'command.pid'), 'utf8')) } catch { await new Promise((resolveWait) => setTimeout(resolveWait, 10)) }
    }
    expect(pid).toBeGreaterThan(0)
    controller.abort()
    expect(await observed).toMatchObject({ name: 'AbortError' })
    expect(() => process.kill(-pid, 0)).toThrow()
  })

  macIt('enforces the command deadline and removes API credentials from its child environment', async () => {
    const cwd = await temp()
    await expect(runChatGptCommand({ cwd, command: 'sleep 30', signal: signal(), timeoutMs: 20 })).rejects.toThrow(/deadline/)
    const result = await runChatGptCommand({ cwd, command: 'env', env: { PATH: process.env.PATH, OPENAI_API_KEY: 'private-key', CLAUDECODE: 'parent', NORMAL_BUILD_FLAG: 'present' }, signal: signal(), timeoutMs: 1000 })
    expect(result.stdout).toContain('NORMAL_BUILD_FLAG=present')
    expect(result.stdout).not.toMatch(/private-key|OPENAI_API_KEY|CLAUDECODE/)
  })

  it('refuses credential files at the host tool boundary before any protected helper starts', async () => {
    const cwd = await temp()
    const secrets = join(cwd, 'secrets')
    await mkdir(secrets)
    const file = join(secrets, 'chatgpt.json')
    await writeFile(file, 'private-credential-fixture')
    const trusted = createChatGptHostTools({ cwd, trusted: true, protectedRoots: [secrets] })
    for (const [name, args] of [
      ['Read', { file_path: file }],
      ['Write', { file_path: file, content: 'overwrite' }],
      ['Edit', { file_path: file, old_string: 'private', new_string: 'changed' }],
    ] as const) await expect(trusted.find((tool) => tool.name === name)!.invoke(args, signal())).rejects.toThrow(/credential files/)
    expect(await readFile(file, 'utf8')).toBe('private-credential-fixture')
  })

  macIt('protects credentials from a real script descendant while allowing ordinary worktree writes', async () => {
    const cwd = await temp()
    const secrets = join(cwd, 'secrets')
    await mkdir(secrets)
    const file = join(secrets, 'chatgpt.json')
    await writeFile(file, 'private-credential-fixture')
    const script = join(cwd, 'read-credential.cjs')
    await writeFile(script, "const fs=require('node:fs');fs.writeFileSync('ordinary.txt','worktree write worked');try{process.stdout.write(fs.readFileSync(process.argv[2],'utf8'))}catch(error){process.stdout.write(error.code);process.exitCode=23}")
    const quote = (path: string) => "'" + path.replace(/'/g, "'\\''") + "'"
    const result = await runChatGptCommand({ cwd, command: `${quote(process.execPath)} ${quote(script)} ${quote(file)}`, signal: signal(), timeoutMs: 2000, protectedRoots: [secrets] })
    expect(result.exitCode).toBe(23)
    expect(result.stdout).toMatch(/EPERM|EACCES/)
    expect(result.stdout).not.toContain('private-credential-fixture')
    expect(await readFile(join(cwd, 'ordinary.txt'), 'utf8')).toBe('worktree write worked')
    expect(await readFile(file, 'utf8')).toBe('private-credential-fixture')
  })

  macIt('refuses mutable protected-root links and prevents a script from renaming a credential ancestor', async () => {
    const cwd = await temp()
    const secrets = join(cwd, 'secrets')
    await mkdir(secrets)
    await symlink(secrets, join(cwd, 'alias'))
    await expect(chatGptShellPreflight([join(cwd, 'alias')])).rejects.toThrow(/symlink/)
    const script = join(cwd, 'rename-parent.cjs')
    await writeFile(script, "try{require('node:fs').renameSync(process.argv[2],process.argv[2]+'-moved')}catch(error){process.stdout.write(error.code);process.exitCode=23}")
    const quote = (path: string) => "'" + path.replace(/'/g, "'\\''") + "'"
    const result = await runChatGptCommand({ cwd, command: `${quote(process.execPath)} ${quote(script)} ${quote(cwd)}`, signal: signal(), timeoutMs: 2000, protectedRoots: [secrets] })
    expect(result.exitCode).toBe(23)
    expect(result.stdout).toMatch(/EPERM|EACCES/)
    await expect(access(secrets)).resolves.toBeUndefined()
  })

  macIt('reaps remaining foreground-group children even when the parent script exits successfully', async () => {
    const cwd = await temp()
    const script = join(cwd, 'leave-child.cjs')
    await writeFile(script, "const fs=require('node:fs');const child=require('node:child_process').spawn('/bin/sleep',['30'],{stdio:'ignore'});fs.writeFileSync('child.pid',String(child.pid));child.unref();process.stdout.write('parent done')")
    const quote = (path: string) => "'" + path.replace(/'/g, "'\\''") + "'"
    const result = await runChatGptCommand({ cwd, command: `${quote(process.execPath)} ${quote(script)}`, signal: signal(), timeoutMs: 2000 })
    expect(result).toMatchObject({ stdout: 'parent done', exitCode: 0 })
    const pid = Number(await readFile(join(cwd, 'child.pid'), 'utf8'))
    expect(pid).toBeGreaterThan(0)
    expect(() => process.kill(pid, 0)).toThrow()
  })

  macIt.each(['Read', 'Write', 'Edit'] as const)('keeps the credential boundary when a parent symlink changes after %s authorization', async (operation) => {
    const cwd = await temp()
    const secretRoot = join(cwd, 'secrets')
    const publicRoot = join(cwd, 'public')
    await mkdir(secretRoot)
    await mkdir(publicRoot)
    const secretFile = join(secretRoot, 'chatgpt.json')
    await writeFile(secretFile, 'credential-race-fixture')
    await writeFile(join(publicRoot, 'chatgpt.json'), 'ordinary public file')
    const guard = async () => {
      // Model a change after canonical resolution and before the actual I/O.
      await rm(publicRoot, { recursive: true })
      await symlink(secretRoot, publicRoot)
      return { hookSpecificOutput: { permissionDecision: 'allow' } }
    }
    const tools = createChatGptHostTools({ cwd, guard, protectedRoots: [secretRoot] })
    const tool = tools.find((item) => item.name === operation)!
    const args = { file_path: join(publicRoot, 'chatgpt.json'), ...(operation === 'Write' ? { content: 'overwritten' } : operation === 'Edit' ? { old_string: 'credential', new_string: 'changed' } : {}) }
    await expect(tool.invoke(args, signal())).rejects.toThrow(/EPERM|EACCES/)
    expect(await readFile(secretFile, 'utf8')).toBe('credential-race-fixture')
  })

  macIt('handles Unicode, line ranges, and literal replacement text in the fixed file helper', async () => {
    const cwd = await temp()
    const tools = createChatGptHostTools({ cwd, trusted: true })
    const named = (name: string) => tools.find((item) => item.name === name)!
    await named('Write').invoke({ file_path: 'unicode.txt', content: '一行目\n二行目\n三行目' }, signal())
    expect(await named('Read').invoke({ file_path: 'unicode.txt', offset: 2, limit: 1 }, signal())).toMatchObject({ text: '2: 二行目', totalLines: 3, truncated: true })
    await named('Edit').invoke({ file_path: 'unicode.txt', old_string: '二行目', new_string: '$& changed' }, signal())
    expect(await readFile(join(cwd, 'unicode.txt'), 'utf8')).toBe('一行目\n$& changed\n三行目')
  })

  it.each(['linux', 'win32'])('fails closed before shell or file helper execution on %s', async (platform) => {
    const cwd = await temp()
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    try {
      Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
      await expect(chatGptShellPreflight()).rejects.toThrow(/require the macOS credential sandbox/)
      await expect(runChatGptCommand({ cwd, command: 'printf should-not-run', signal: signal(), timeoutMs: 1000 })).rejects.toThrow(/require the macOS credential sandbox/)
      const write = createChatGptHostTools({ cwd, trusted: true }).find((tool) => tool.name === 'Write')!
      await expect(write.invoke({ file_path: 'denied.txt', content: 'should-not-be-written' }, signal())).rejects.toThrow(/require the macOS credential sandbox/)
      await expect(access(join(cwd, 'denied.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { Object.defineProperty(process, 'platform', descriptor) }
  })
})

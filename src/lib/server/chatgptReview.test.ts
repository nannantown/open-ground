import { execFile } from 'child_process'
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// The scope/authorization/transport cases can test their boundary on any OS.
// Only those cases replace the file-I/O edge on non-macOS; all macOS cases
// retain the real protected helper, and kernel controls below remain mac-only.
vi.mock('./chatgptTools', async (original) => {
  const actual = await original<typeof import('./chatgptTools')>()
  return { ...actual, runChatGptFileOperation: vi.fn(actual.runChatGptFileOperation) }
})
import { runChatGptFileOperation } from './chatgptTools'
import { chatGptReviewSandbox, createChatGptReviewTool, createChatGptReviewTools } from './chatgptReview'

const exec = promisify(execFile)
const roots: string[] = []
const macIt = it.runIf(process.platform === 'darwin')
beforeEach(async () => {
  const actual = await vi.importActual<typeof import('./chatgptTools')>('./chatgptTools')
  vi.mocked(runChatGptFileOperation).mockReset().mockImplementation(actual.runChatGptFileOperation)
})
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const temp = async () => { const path = await mkdtemp(join(tmpdir(), 'og-chatgpt-review-')); roots.push(path); return path }
const signal = () => new AbortController().signal
const git = async (cwd: string, ...args: string[]) => (await exec('/usr/bin/git', ['-C', cwd, ...args])).stdout
const repo = async () => {
  const cwd = await temp()
  await git(cwd, 'init', '-b', 'main')
  await git(cwd, 'config', 'user.name', 'Review Test')
  await git(cwd, 'config', 'user.email', 'review@example.test')
  await writeFile(join(cwd, 'code.txt'), 'before\n')
  await writeFile(join(cwd, '.env'), 'UNRECOGNIZABLE=secret-fixture-before\n')
  await git(cwd, 'add', '--', 'code.txt', '.env')
  await git(cwd, 'commit', '-m', 'baseline')
  await git(cwd, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  await writeFile(join(cwd, 'code.txt'), 'after\n')
  await writeFile(join(cwd, '.env'), 'UNRECOGNIZABLE=secret-fixture-after\n')
  await git(cwd, 'add', '--', 'code.txt', '.env')
  await git(cwd, 'commit', '-m', 'change')
  return cwd
}
const frame = (output: Record<string, unknown>[]) => new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', model: 'chosen-model', output, usage: { input_tokens: 3, output_tokens: 2 } } })}\n\n`)
const answer = (text = 'No findings after independent inspection.') => frame([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }])
const call = (name: string, args: unknown) => frame([{ type: 'function_call', namespace: 'openground', name, call_id: 'review-call-1', arguments: JSON.stringify(args) }])
const options = (cwd: string) => ({ cwd, model: 'chosen-model', effort: 'high', accessToken: async () => 'plan-oauth-fixture', accountKey: async () => 'account-one', authorize: async () => {} })

describe('independent ChatGPT review boundary', () => {
  it('offers only project-scoped Read and fixed Git, refuses secrets and escaping symlinks, and redacts values', async () => {
    const cwd = await temp()
    const outside = await temp()
    await writeFile(join(outside, 'outside.txt'), 'outside evidence')
    await symlink(outside, join(cwd, 'escape'))
    await writeFile(join(cwd, 'code.txt'), 'const API_KEY = "private-value"\nordinary code')
    await writeFile(join(cwd, '.env'), 'unstructured-secret')
    await writeFile(join(cwd, 'server.pem.bak'), 'unstructured-secret')
    const credentialRoot = join(cwd, 'credential-zone')
    await mkdir(credentialRoot)
    await writeFile(join(credentialRoot, 'chatgpt.json'), 'plan-token')
    const authorize = vi.fn(async () => {})
    if (process.platform !== 'darwin') vi.mocked(runChatGptFileOperation).mockResolvedValue({ text: '1: const API_KEY = "private-value"\n2: ordinary code', totalLines: 2, truncated: false })
    const tools = createChatGptReviewTools({ cwd, authorize, protectedRoots: [credentialRoot] })
    expect(tools.map((tool) => tool.name)).toEqual(['Read', 'Git'])
    const read = tools[0]
    expect(await read.invoke({ file_path: 'code.txt' }, signal())).toMatchObject({ text: '1: const API_KEY = [hidden]\n2: ordinary code' })
    for (const file_path of ['escape/outside.txt', '.env', 'server.pem.bak', 'credential-zone/chatgpt.json']) await expect(read.invoke({ file_path }, signal())).rejects.toThrow(/confined|secret/)
    await expect(read.invoke({ file_path: 'code.txt', command: 'touch changed' }, signal())).rejects.toThrow()
    expect(authorize).toHaveBeenCalledTimes(2)
    expect(runChatGptFileOperation).toHaveBeenCalledOnce()
    expect(runChatGptFileOperation).toHaveBeenCalledWith(expect.objectContaining({ operation: 'Read', input: expect.objectContaining({ file_path: await realpath(join(cwd, 'code.txt')) }) }))
    expect(await readFile(join(cwd, 'code.txt'), 'utf8')).toContain('private-value')
  })

  macIt('keeps credentials denied when a checked parent directory becomes a symlink after the guard', async () => {
    const cwd = await temp()
    const publicDirectory = join(cwd, 'public')
    const credentialDirectory = join(cwd, 'credentials')
    await mkdir(publicDirectory)
    await mkdir(credentialDirectory)
    await writeFile(join(publicDirectory, 'code.txt'), 'ordinary evidence')
    await writeFile(join(credentialDirectory, 'code.txt'), 'must-never-reach-the-model')
    const guard = vi.fn(async () => {
      await rename(publicDirectory, join(cwd, 'public-before'))
      await symlink(credentialDirectory, publicDirectory)
      return { hookSpecificOutput: { permissionDecision: 'allow' } }
    })
    const read = createChatGptReviewTools({ cwd, authorize: async () => {}, guard, protectedRoots: [credentialDirectory] })[0]
    await expect(read.invoke({ file_path: 'public/code.txt' }, signal())).rejects.toThrow(/EACCES|EPERM|credential|secret/)
    expect(guard).toHaveBeenCalledOnce()
    expect(await readFile(join(credentialDirectory, 'code.txt'), 'utf8')).toBe('must-never-reach-the-model')
  })

  it('fails closed when a worker guard throws, denies, or returns a malformed decision', async () => {
    const cwd = await temp()
    await writeFile(join(cwd, 'code.txt'), 'read me')
    for (const guard of [async () => { throw new Error('broken') }, async () => undefined, async () => ({ hookSpecificOutput: { permissionDecision: 'deny' } })]) {
      const read = createChatGptReviewTools({ cwd, authorize: async () => {}, guard })[0]
      await expect(read.invoke({ file_path: 'code.txt' }, signal())).rejects.toThrow(/guard.*denied|guard failed/)
    }
  })

  macIt('gets real sandboxed Git diff/show/status without external diff, textconv, fsmonitor, hooks, or secret files', async () => {
    const cwd = await repo()
    const marker = join(cwd, 'helper-ran')
    const script = join(cwd, 'malicious-helper')
    await writeFile(script, '#!/bin/sh\nprintf executed > "$PWD/helper-ran"\nprintf private-helper-output\n')
    await chmod(script, 0o700)
    await writeFile(join(cwd, '.gitattributes'), 'code.txt diff=evil\n')
    await git(cwd, 'config', 'diff.external', script)
    await git(cwd, 'config', 'diff.evil.command', script)
    await git(cwd, 'config', 'diff.evil.textconv', script)
    await git(cwd, 'config', 'core.fsmonitor', script)
    await git(cwd, 'config', 'core.hooksPath', cwd)
    const inspect = createChatGptReviewTools({ cwd, authorize: async () => {} })[1]
    for (const action of ['diff', 'show'] as const) {
      const result = await inspect.invoke({ action }, signal()) as { text: string }
      expect(result.text).toContain('-before')
      expect(result.text).toContain('+after')
      expect(result.text).not.toMatch(/secret-fixture|UNRECOGNIZABLE|private-helper-output/)
    }
    expect(await inspect.invoke({ action: 'status' }, signal())).toMatchObject({ text: expect.stringContaining('.gitattributes') })
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(cwd, '.env'), 'utf8')).toContain('secret-fixture-after')
  })

  it('rejects Git option injection, secret targets and escaping paths before host execution', async () => {
    const cwd = await temp()
    const inspect = createChatGptReviewTools({ cwd, authorize: async () => {} })[1]
    for (const raw of [{ action: 'diff', base: '--output=changed' }, { action: 'show', ref: 'HEAD:.env' }, { action: 'diff', file_path: '../outside.txt' }, { action: 'show', file_path: '.env' }, { action: 'status', command: 'touch changed' }]) await expect(inspect.invoke(raw, signal())).rejects.toThrow()
    expect(await readdir(cwd)).toEqual([])
  })

  macIt('the exact OS policy denies worktree writes, credential reads, and network even for a spawned program', async () => {
    const cwd = await temp()
    const protectedRoot = join(cwd, 'credentials')
    await mkdir(protectedRoot)
    await writeFile(join(protectedRoot, 'token.json'), 'protected-plan-fixture')
    const sandbox = await chatGptReviewSandbox([protectedRoot])
    const script = "const fs=require('node:fs');for(const [name,op]of[['write',()=>fs.writeFileSync('changed','no')],['read',()=>fs.readFileSync(process.argv[1],'utf8')]]){try{op();console.log(name+':ALLOWED')}catch(e){console.log(name+':'+e.code)}};require('node:net').connect({host:'127.0.0.1',port:9}).on('error',e=>console.log('network:'+e.code))"
    const result = await exec(sandbox.executable, ['-p', sandbox.profile, process.execPath, '-e', script, join(protectedRoot, 'token.json')], { cwd, timeout: 4000, env: { PATH: '/usr/bin:/bin' } })
    expect(result.stdout).toMatch(/write:(EPERM|EACCES)/)
    expect(result.stdout).toMatch(/read:(EPERM|EACCES)/)
    expect(result.stdout).toMatch(/network:(EPERM|EACCES)/)
    expect(result.stdout).not.toMatch(/ALLOWED|protected-plan-fixture/)
    await expect(access(join(cwd, 'changed'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('runs a fresh nonpersistent context on the chosen plan/model with no recursive or write capabilities', async () => {
    const cwd = await temp()
    await writeFile(join(cwd, 'code.txt'), 'independent evidence')
    if (process.platform !== 'darwin') vi.mocked(runChatGptFileOperation).mockResolvedValue({ text: '1: independent evidence', totalLines: 1, truncated: false })
    vi.stubEnv('OPENAI_API_KEY', 'must-never-be-used')
    const requests: Record<string, unknown>[] = []
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer plan-oauth-fixture')
      const body = JSON.parse(init!.body as string)
      requests.push(body)
      return requests.length === 1 ? call('Read', { file_path: 'code.txt' }) : answer()
    })
    const review = createChatGptReviewTool({ ...options(cwd), fetch: fetcher as unknown as typeof fetch })
    expect(await review.invoke({ prompt: 'Inspect this code independently.' }, signal())).toMatchObject({ independent: true, readOnly: true, model: 'chosen-model', text: 'No findings after independent inspection.' })
    expect(requests).toHaveLength(2)
    expect(requests[0]).toMatchObject({ model: 'chosen-model', reasoning: { effort: 'high' }, store: false, input: [{ role: 'user', content: 'Inspect this code independently.' }] })
    const tools = (requests[0].tools as { tools: { name: string }[] }[])[0].tools.map((tool) => tool.name)
    expect(tools).toEqual(['Read', 'Git'])
    expect(JSON.stringify(requests[1].input)).toContain('independent evidence')
    expect(await readdir(cwd)).toEqual(['code.txt'])
  })

  it('rejects native write and recursive Agent requests rather than executing or claiming success', async () => {
    const cwd = await temp()
    for (const tool of ['Write', 'Agent', 'Bash']) {
      const fetcher = vi.fn(async () => call(tool, { file_path: 'changed', content: 'no', prompt: 'recurse' }))
      await expect(createChatGptReviewTool({ ...options(cwd), fetch: fetcher as unknown as typeof fetch }).invoke({ prompt: 'Review' }, signal())).rejects.toThrow(/unadvertised/)
      expect(fetcher).toHaveBeenCalledOnce()
    }
    expect(await readdir(cwd)).toEqual([])
  })

  macIt('allows another worktree of the same repository and refuses another project before inference', async () => {
    const cwd = await repo()
    const target = join(await temp(), 'review-worktree')
    await git(cwd, 'worktree', 'add', '-b', 'review-seat', target)
    const fetcher = vi.fn(async () => answer())
    const review = createChatGptReviewTool({ ...options(cwd), fetch: fetcher as unknown as typeof fetch })
    await expect(review.invoke({ prompt: 'Review the worker diff', cwd: target }, signal())).resolves.toMatchObject({ independent: true })
    const other = await repo()
    await expect(review.invoke({ prompt: 'Review another project', cwd: other }, signal())).rejects.toThrow(/only this project/)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('propagates parent interruption and enforces the total review deadline', async () => {
    const cwd = await temp()
    for (const timedOut of [false, true]) {
      const controller = new AbortController()
      let entered!: () => void
      const started = new Promise<void>((done) => { entered = done })
      const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError')), { once: true })
        entered()
      }))
      const running = createChatGptReviewTool({ ...options(cwd), fetch: fetcher as unknown as typeof fetch, maxDurationMs: timedOut ? 30 : 1000 }).invoke({ prompt: 'Review' }, controller.signal)
      const observed = running.then(() => null, (error: unknown) => error)
      await started
      if (!timedOut) controller.abort()
      expect(await observed).toMatchObject({ name: 'AbortError' })
      expect(fetcher).toHaveBeenCalledOnce()
    }
  })

  it('rechecks authorization and the captured account before child tools and later network requests', async () => {
    const cwd = await temp()
    await writeFile(join(cwd, 'code.txt'), 'must not be read by a changed account')
    let account = 'account-one'
    const fetcher = vi.fn(async () => { account = 'account-two'; return call('Read', { file_path: 'code.txt' }) })
    const review = createChatGptReviewTool({ ...options(cwd), accountKey: async () => account, fetch: fetcher as unknown as typeof fetch })
    await expect(review.invoke({ prompt: 'Review' }, signal())).rejects.toThrow(/connection changed/)
    expect(fetcher).toHaveBeenCalledOnce()
    const stopped = createChatGptReviewTool({ ...options(cwd), authorize: async () => { throw new Error('Lockdown is active') }, fetch: fetcher as unknown as typeof fetch })
    await expect(stopped.invoke({ prompt: 'Review' }, signal())).rejects.toThrow(/Lockdown/)
    expect(fetcher).toHaveBeenCalledOnce()
  })
})

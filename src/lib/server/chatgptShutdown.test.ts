import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { spawn } from 'child_process'
import { reapAllChatGptHostGroups, runChatGptCommand } from './chatgptTools'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const temp = async () => { const root = await mkdtemp(join(tmpdir(), 'og-chatgpt-shutdown-')); roots.push(root); return root }

// Automatic host tools deliberately fail closed outside macOS.
describe.skipIf(process.platform !== 'darwin')('ChatGPT host process shutdown', () => {
  it('unregisters normal and aborted groups before a later shutdown sweep', async () => {
    const cwd = await temp()
    const secrets = join(cwd, 'secrets')
    await mkdir(secrets)
    const options = { cwd, protectedRoots: [secrets], timeoutMs: 15_000 }
    await expect(runChatGptCommand({ ...options, command: 'printf done', signal: new AbortController().signal })).resolves.toMatchObject({ stdout: 'done', exitCode: 0 })
    expect(reapAllChatGptHostGroups()).toBe(0)
    const controller = new AbortController()
    const observed = runChatGptCommand({ ...options, command: 'echo $$ > host.pid; exec /bin/sleep 30', signal: controller.signal }).then(() => null, (error: unknown) => error)
    let hostPid = 0
    try {
      for (let attempt = 0; attempt < 1000 && !hostPid; attempt++) {
        try { hostPid = Number(await readFile(join(cwd, 'host.pid'), 'utf8')) } catch { /* wait for the child */ }
        if (!hostPid) await new Promise((resolveWait) => setTimeout(resolveWait, 10))
      }
      expect(hostPid).toBeGreaterThan(0)
      controller.abort()
      expect(await observed).toMatchObject({ name: 'AbortError' })
      expect(() => process.kill(-hostPid, 0)).toThrow()
      expect(reapAllChatGptHostGroups()).toBe(0)
    } finally {
      controller.abort()
      await observed
    }
  })

  it.each(['SIGTERM', 'SIGINT', 'exit'] as const)('reaps active host groups on server %s alongside the gate reaper', async (ending) => {
    const cwd = await temp()
    const secrets = join(cwd, 'secrets')
    await mkdir(secrets)
    const marker = join(cwd, 'host.pid')
    const program = join(cwd, 'server.mts')
    await writeFile(program, [
      `import { runChatGptCommand, installChatGptHostReaper } from ${JSON.stringify(resolve('src/lib/server/chatgptTools.ts'))};`,
      `import { installGateGroupReaper } from ${JSON.stringify(resolve('src/lib/server/gateProcess.ts'))};`,
      // The real entry installs the gate reaper first. Its SIGTERM listener
      // exits immediately, so the host's exit listener is essential.
      'installGateGroupReaper(); installChatGptHostReaper(); installChatGptHostReaper();',
      "process.on('message', () => process.exit(0));",
      `await runChatGptCommand({ cwd: ${JSON.stringify(cwd)}, command: ${JSON.stringify(`echo $$ > '${marker}'; exec /bin/sleep 30`)}, env: { PATH: '/usr/bin:/bin' }, protectedRoots: [${JSON.stringify(secrets)}], signal: new AbortController().signal, timeoutMs: 35000 });`,
    ].join('\n'))
    const child = spawn(process.execPath, ['--import', 'tsx', program], { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: cwd, TMPDIR: tmpdir() }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    let diagnostics = ''
    child.stderr!.on('data', (chunk: Buffer) => { diagnostics += chunk.toString() })
    const exited = new Promise<number | null>((resolveExit, reject) => {
      child.once('exit', (code) => resolveExit(code))
      child.once('error', reject)
    })
    let hostPid = 0
    try {
      for (let attempt = 0; attempt < 1000 && !hostPid; attempt++) {
        try { hostPid = Number(await readFile(marker, 'utf8')) } catch { /* wait for the actual detached process */ }
        if (child.exitCode !== null) throw new Error(`Probe exited before its host command: ${diagnostics}`)
        if (!hostPid) await new Promise((resolveWait) => setTimeout(resolveWait, 10))
      }
      expect(hostPid, diagnostics).toBeGreaterThan(0)
      expect(() => process.kill(-hostPid, 0)).not.toThrow()
      if (ending === 'exit') child.send('exit')
      else child.kill(ending)
      expect(await exited).toBe(ending === 'SIGTERM' ? 143 : ending === 'SIGINT' ? 130 : 0)
      // The server's exit handler signals synchronously; allow the kernel to
      // finish reaping that group before checking liveness.
      for (let attempt = 0; attempt < 100; attempt++) {
        try { process.kill(-hostPid, 0) } catch { break }
        await new Promise((resolveWait) => setTimeout(resolveWait, 10))
      }
      expect(() => process.kill(-hostPid, 0)).toThrow()
    } finally {
      if (hostPid) { try { process.kill(-hostPid, 'SIGKILL') } catch { /* already reaped */ } }
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited
    }
  })

})

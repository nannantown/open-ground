// One process owns the receipts journal at a time (runtimeJournalOwner.ts).
//
// The incident these pin (2026-11-20): a worker started `npm run dev:alt`, a
// second server on the SAME ~/.openground. The journal used to treat every
// 'executing' receipt claimed by another boot id as "cut off by a restart", on
// every open — so the second server marked the live app's in-flight tool calls
// 'uncertain' within 100 ms of its first read. One such mark denies every tool
// in that project, ends each new worker before `claude` starts and keeps the
// commander from launching: two projects stood still for three days.
//
// Real OS processes on purpose. "Another process is alive" is the whole
// question, and a mocked answer would only prove the mock.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openGroundHome } from './paths'
import { acceptConversationReceipt, listAllConversationReceipts, type ConversationReceipt } from './conversationReceipts'
import { assertRuntimeJournalOwner, RuntimeJournalOwnedElsewhere } from './runtimeJournalOwner'

// Opens the windows a compare-and-swap exists for: a listing taken before
// another process published its claim, and work done by others between our
// judging and our publishing.
const fsState = vi.hoisted(() => ({
  staleOwnerListings: 0,
  beforeOwnerLink: undefined as undefined | (() => Promise<void>),
  // Fails one read of an owner record named `name`, after `after` reads pass.
  failOwnerRead: undefined as undefined | { name: string; after: number },
}))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  const readdir = ((...args: Parameters<typeof actual.readdir>) => {
    if (fsState.staleOwnerListings > 0 && String(args[0]).endsWith('journal-owner')) { fsState.staleOwnerListings--; return Promise.resolve([]) }
    return actual.readdir(...args)
  }) as typeof actual.readdir
  const link = (async (...args: Parameters<typeof actual.link>) => {
    const hook = fsState.beforeOwnerLink
    if (hook && String(args[1]).includes('journal-owner')) { fsState.beforeOwnerLink = undefined; await hook() }
    return actual.link(...args)
  }) as typeof actual.link
  const readFile = (async (...args: Parameters<typeof actual.readFile>) => {
    const failing = fsState.failOwnerRead, path = String(args[0])
    if (failing && path.includes('journal-owner') && path.endsWith(failing.name)) {
      if (failing.after > 0) failing.after--
      else { fsState.failOwnerRead = undefined; throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' }) }
    }
    return actual.readFile(...args)
  }) as typeof actual.readFile
  return { ...actual, readdir, link, readFile }
})
// Fails the next `failListens` listens, as a missing loopback or a full port range would.
const netState = vi.hoisted(() => ({ failListens: 0 }))
vi.mock('node:net', async (original) => {
  const actual = await original<typeof import('node:net')>()
  const createServer = ((...args: Parameters<typeof actual.createServer>) => {
    const server = actual.createServer(...args)
    if (netState.failListens > 0) {
      netState.failListens--
      server.listen = (() => {
        process.nextTick(() => server.emit('error', Object.assign(new Error('listen EADDRNOTAVAIL 127.0.0.1'), { code: 'EADDRNOTAVAIL' })))
        return server
      }) as typeof server.listen
    }
    return server
  }) as typeof actual.createServer
  return { ...actual, createServer }
})
const ownerDir = () => join(openGroundHome(), 'runtime', 'journal-owner')
const ownerRecords = async (): Promise<Record<string, { bootId: string; pid: number; port?: number }>> =>
  Object.fromEntries(await Promise.all((await readdir(ownerDir())).filter((name) => name.endsWith('.json'))
    .map(async (name) => [name, JSON.parse(await readFile(join(ownerDir(), name), 'utf8'))])))
const writeOwner = async (generation: number | string, record: unknown) => {
  await mkdir(ownerDir(), { recursive: true })
  await writeFile(join(ownerDir(), `${generation}.json`), typeof record === 'string' ? record : JSON.stringify(record))
}
const refusal = (promise: Promise<unknown>) => promise.then(() => 'owner', (error: Error) => error.name)
const servers: Server[] = []
/** A loopback listener in this process: some other program on a port. */
const listening = (onConnection: (socket: Socket) => void): Promise<number> => new Promise((done) => {
  // A probe resets a connection it gave up on: not a failure of the program it probed.
  const server = createServer((socket) => { socket.on('error', () => {}); onConnection(socket) })
  servers.push(server)
  server.listen(0, '127.0.0.1', () => done((server.address() as AddressInfo).port))
})
/** A port nothing listens on: one that was just given back. */
const closedPort = async (): Promise<number> => {
  const port = await listening(() => {})
  await new Promise((done) => servers.pop()!.close(done))
  return port
}

const journal = () => join(openGroundHome(), 'runtime', 'receipts-v2.json')
/** The path every build from before the owner lock reads and replaces. */
const legacyJournal = () => join(openGroundHome(), 'runtime', 'receipts.json')
const savedStates = async (): Promise<Record<string, string>> =>
  Object.fromEntries(Object.values((JSON.parse(await readFile(journal(), 'utf8')) as { receipts: Record<string, ConversationReceipt> }).receipts).map((r) => [r.id, r.state]))
const source = (file: string) => JSON.stringify(pathToFileURL(resolve('src/lib/server', file)).href)
const forbidNetwork = `globalThis.fetch = async () => { throw new Error('Network forbidden in receipt process fixture'); };`

interface Running { line(): Promise<string>; send(text: string): void; stop(): Promise<void>; pid: number }
const running: Running[] = []
/** A real child process that imports the production module through tsx. */
const start = (program: string): Running => {
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP, VITEST: 'true',
      OPENGROUND_HOME: openGroundHome(), OPENGROUND_OWNER_EMAILS: 'fixture-owner@example.test', OPENGROUND_TESTER_EMAILS: '' },
  })
  let buffered = '', stderr = '', exited: string | undefined
  const ready: string[] = [], waiting: { resolve(line: string): void; reject(error: Error): void }[] = []
  child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
    buffered += chunk
    for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
      const line = buffered.slice(0, at); buffered = buffered.slice(at + 1)
      const next = waiting.shift()
      if (next) next.resolve(line); else ready.push(line)
    }
  })
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  const gone = new Promise<void>((done) => child.once('exit', (code, signal) => {
    exited = `child exited (code=${code} signal=${signal}) before answering: ${stderr.slice(-2000)}`
    for (const next of waiting.splice(0)) next.reject(new Error(exited))
    done()
  }))
  const handle: Running = {
    pid: child.pid!,
    line: () => new Promise<string>((done, fail) => {
      const line = ready.shift()
      if (line !== undefined) done(line)
      else if (exited) fail(new Error(exited))
      else waiting.push({ resolve: done, reject: fail })
    }),
    send: (text) => { child.stdin!.write(`${text}\n`) },
    stop: async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await gone },
  }
  running.push(handle)
  return handle
}
/** Run a child to completion and parse the one JSON line it prints. */
const runOnce = async (program: string): Promise<unknown> => {
  const child = start(program)
  try { return JSON.parse(await child.line()) } finally { await child.stop() }
}

// "The real app": claims two tool calls and stays alive. On any stdin line it
// settles the first one, as a returning tool does.
const liveApp = `
  ${forbidNetwork}
  const loaded = await import(${source('conversationReceipts.ts')});
  const receipts = loaded.default ?? loaded;
  for (const id of ['live-action', 'cut-off-action']) {
    await receipts.acceptConversationReceipt('process-project', id, { kind: 'runtime-tool', sessionId: 'synthetic' });
    if (!await receipts.claimConversationReceipt('process-project', id)) throw new Error('claim failed');
  }
  process.stdout.write('ready\\n');
  process.stdin.setEncoding('utf8').on('data', async () => {
    const finished = await receipts.finishConversationReceipt('process-project', 'live-action', 'delivered', { confirmed: true });
    process.stdout.write(JSON.stringify({ state: finished.state }) + '\\n');
  });
`
// "The second copy": what a dev server's first journal read is.
const secondCopy = `
  ${forbidNetwork}
  const loaded = await import(${source('conversationReceipts.ts')});
  const receipts = loaded.default ?? loaded;
  const outcome = await receipts.listAllConversationReceipts().then(() => 'opened', (error) => error.name);
  process.stdout.write(JSON.stringify({ outcome }) + '\\n');
`

// A process that claims the journal through the production module and keeps it.
// On any stdin line it checks again, as the owner does before each transaction.
const holder = (bootId: string) => `
  ${forbidNetwork}
  const loaded = await import(${source('runtimeJournalOwner.ts')});
  const owner = loaded.default ?? loaded;
  const check = async () => {
    const outcome = await owner.assertRuntimeJournalOwner(${JSON.stringify(openGroundHome())}, ${JSON.stringify(bootId)}).then(() => 'owner', (error) => error.name);
    process.stdout.write(JSON.stringify({ outcome }) + '\\n');
  };
  await check();
  process.stdin.setEncoding('utf8').on('data', check);
`
/** The pid of a process that has exited. */
const exitedPid = async (): Promise<number> => {
  const child = start('process.stdin.resume()')
  await child.stop()
  return child.pid
}
const keyFor = (owner: string, scope: string, id: string) => createHash('sha256').update(JSON.stringify([owner, scope, id])).digest('hex')

beforeEach(async () => {
  fsState.staleOwnerListings = 0
  fsState.beforeOwnerLink = undefined
  fsState.failOwnerRead = undefined
  netState.failListens = 0
  // This process also writes as the signed-in owner, offline like the children.
  vi.stubEnv('OPENGROUND_OWNER_EMAILS', 'fixture-owner@example.test')
  vi.stubEnv('OPENGROUND_TESTER_EMAILS', '')
  vi.stubGlobal('fetch', async () => { throw new Error('Network forbidden in receipt process test') })
  await rm(join(openGroundHome(), 'runtime'), { recursive: true, force: true })
  await mkdir(openGroundHome(), { recursive: true })
  await writeFile(join(openGroundHome(), 'auth.json'), JSON.stringify({ user: { id: 'synthetic-process-owner', email: 'fixture-owner@example.test' },
    accessToken: 'synthetic-local-test-only', refreshToken: 'synthetic-local-test-only', expiresAt: 0 }), { mode: 0o600 })
})
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  for (const child of running.splice(0)) await child.stop()
  for (const server of servers.splice(0)) server.close()
})

describe('a second copy of the app next to a live one', () => {
  it('leaves the live app\'s in-flight tool calls alone, and a real restart still holds them', async () => {
    const app = start(liveApp)
    expect(await app.line()).toBe('ready')
    const before = await readFile(journal(), 'utf8')

    // This test process is a second OS process with its own boot id: the dev server.
    const opened = await listAllConversationReceipts().then(() => 'opened', (error: Error) => error.name)
    expect(await savedStates()).toEqual({ 'live-action': 'executing', 'cut-off-action': 'executing' })
    expect(await readFile(journal(), 'utf8')).toBe(before)
    // And once more from a separate process that only ever reads.
    const second = await runOnce(secondCopy)
    expect(await savedStates()).toEqual({ 'live-action': 'executing', 'cut-off-action': 'executing' })
    expect(await readFile(journal(), 'utf8')).toBe(before)

    // The live app's work goes on: its tool returns and is recorded as confirmed.
    app.send('finish')
    expect(JSON.parse(await app.line())).toEqual({ state: 'delivered' })
    // The second copy was told why, rather than handed a journal it may not judge.
    expect(opened).toBe('RuntimeJournalOwnedElsewhere')
    expect(second).toEqual({ outcome: 'RuntimeJournalOwnedElsewhere' })

    // A real restart: the app is gone, so the call it never finished is unconfirmed.
    await app.stop()
    const after = await listAllConversationReceipts()
    expect(Object.fromEntries(after.map((r) => [r.id, r.state]))).toEqual({ 'live-action': 'delivered', 'cut-off-action': 'uncertain' })
    expect(after.find((r) => r.id === 'cut-off-action')?.error).toMatch(/app restarted/)
  })

  it('stays refused on every later read and write while the owner lives', async () => {
    const app = start(liveApp)
    expect(await app.line()).toBe('ready')
    const before = await readFile(journal(), 'utf8')
    // A dev server keeps calling: boot resume, then the inbox tick every 2 s.
    for (let call = 0; call < 3; call++) {
      expect(await refusal(listAllConversationReceipts())).toBe('RuntimeJournalOwnedElsewhere')
      expect(await refusal(acceptConversationReceipt('process-project', `second-copy-${call}`, { kind: 'runtime-tool', sessionId: 'second' }))).toBe('RuntimeJournalOwnedElsewhere')
    }
    expect(await readFile(journal(), 'utf8')).toBe(before)
  })

  it('never holds a live process\'s call, even as owner after the lock folder was deleted from outside', async () => {
    const app = start(liveApp)
    expect(await app.line()).toBe('ready')
    const before = await readFile(journal(), 'utf8')
    // Someone "clears a stale lock" while the app works.
    await rm(ownerDir(), { recursive: true, force: true })
    expect(await refusal(listAllConversationReceipts())).toBe('owner')
    expect(await savedStates()).toEqual({ 'live-action': 'executing', 'cut-off-action': 'executing' })
    expect(await readFile(journal(), 'utf8')).toBe(before)
    // Once that process is gone, its calls are held as before.
    await app.stop()
    expect(Object.fromEntries((await listAllConversationReceipts()).map((r) => [r.id, r.state]))).toEqual({ 'live-action': 'uncertain', 'cut-off-action': 'uncertain' })
  })

  it('is refused before it can compact a full journal', async () => {
    const app = start(liveApp)
    expect(await app.line()).toBe('ready')
    // 3072 settled calls make the next opener archive them and rewrite the journal.
    const saved = JSON.parse(await readFile(journal(), 'utf8')) as { receipts: Record<string, unknown> }
    const at = '2026-11-20T00:00:00.000Z'
    for (let i = 0; i < 3072; i++) {
      saved.receipts[keyFor('filler-owner', 'process-project', `t-${i}`)] = { id: `t-${i}`, scope: 'process-project', owner: 'filler-owner',
        hash: 'a'.repeat(64), body: { i }, state: 'delivered', acceptedAt: at, updatedAt: at }
    }
    await writeFile(journal(), JSON.stringify(saved))
    const before = await readFile(journal(), 'utf8')
    expect(await refusal(listAllConversationReceipts())).toBe('RuntimeJournalOwnedElsewhere')
    expect(await readFile(journal(), 'utf8')).toBe(before)
    expect(await readdir(join(openGroundHome(), 'runtime', 'receipt-archive')).catch(() => 'absent')).toBe('absent')
  })
})

describe('builds from before the owner lock', () => {
  // They know no lock: they read and replace runtime/receipts.json, and a
  // write they began before the app's lands after it.
  it('can neither read nor replace the journal of a live app: their path is a folder', async () => {
    const app = start(liveApp)
    expect(await app.line()).toBe('ready')
    expect(await readFile(legacyJournal(), 'utf8').catch((error: NodeJS.ErrnoException) => error.code)).toBe('EISDIR')
    const stale = join(openGroundHome(), 'runtime', 'stale-write.tmp')
    await writeFile(stale, '{"version":1,"receipts":{}}')
    expect(await rename(stale, legacyJournal()).then(() => 'replaced', (error: NodeJS.ErrnoException) => error.code)).not.toBe('replaced')
    expect(JSON.parse(await readFile(journal(), 'utf8')).version).toBe(2)
    expect(await savedStates()).toEqual({ 'live-action': 'executing', 'cut-off-action': 'executing' })
  })

  it('left a journal: it moves in once, its cut-off call is held, and its path becomes a folder', async () => {
    const at = '2026-11-20T09:03:37.972Z'
    await mkdir(dirname(legacyJournal()), { recursive: true })
    await writeFile(legacyJournal(), JSON.stringify({ version: 1, contexts: {}, acceptedDrafts: {}, receipts: {
      [keyFor('pre-fix-owner', 'process-project', 'pre-fix-call')]: { id: 'pre-fix-call', scope: 'process-project', owner: 'pre-fix-owner',
        hash: 'b'.repeat(64), body: { kind: 'runtime-tool', sessionId: 'synthetic' }, state: 'executing', acceptedAt: at, updatedAt: at, attemptBoot: 'pre-fix-boot' },
    } }))
    expect((await listAllConversationReceipts()).map((r) => [r.id, r.state])).toEqual([['pre-fix-call', 'uncertain']])
    expect(JSON.parse(await readFile(journal(), 'utf8')).version).toBe(2)
    expect((await stat(legacyJournal())).isDirectory()).toBe(true)
    expect(JSON.parse(await readFile(`${legacyJournal()}.retired`, 'utf8')).receipts).toHaveProperty([keyFor('pre-fix-owner', 'process-project', 'pre-fix-call')])
  })

  // What a real pre-lock journal holds: earlier marks the owner has not cleared,
  // settled history (it stops an owner input from running twice), owner inputs
  // with their draft revisions, conversation contexts.
  const fixtureOwner = 'pre-fix-owner', at = '2026-11-20T09:03:37.972Z'
  const restarted = 'The app restarted after this operation began. Inspect its result before continuing.'
  const record = (scope: string, id: string, state: ConversationReceipt['state'], extra: Partial<ConversationReceipt> = {}): ConversationReceipt => ({
    id, scope, owner: fixtureOwner, hash: 'c'.repeat(64), body: { kind: 'runtime-tool', sessionId: 'synthetic', toolId: id },
    state, acceptedAt: at, updatedAt: at, conversationId: 'conversation-a', epoch: 2, ...extra })
  const input = (scope: string, id: string, state: ConversationReceipt['state'], draft: Record<string, unknown> = {}, extra: Partial<ConversationReceipt> = {}): ConversationReceipt =>
    ({ ...record(scope, id, state, extra), body: { kind: 'president-input', path: `/projects/${scope}`, text: `words of ${id}`, ...draft } })
  const k = (scope: string, id: string) => keyFor(fixtureOwner, scope, id)
  const legacyDocument = (receipts: ConversationReceipt[], contexts: Record<string, unknown>, acceptedDrafts: Record<string, number>) =>
    ({ version: 1, receipts: Object.fromEntries(receipts.map((r) => [k(r.scope, r.id), r])), contexts, acceptedDrafts })
  const populatedLegacy = () => legacyDocument([
    record('project-a', 'mark-1109', 'uncertain', { attemptBoot: 'boot-1109', error: restarted, execution: { sessionId: 's1', handleId: 'h1', runtime: 'sdk' } }),
    record('project-b', 'mark-1115', 'uncertain', { attemptBoot: 'boot-1115', error: restarted }),
    record('project-a', 'done-call', 'delivered', { attemptBoot: 'boot-1118', result: { confirmed: true } }),
    record('project-a', 'failed-call', 'rejected', { attemptBoot: 'boot-1118', result: { failed: true } }),
    input('project-a', 'old-input', 'cancelled'),
    input('project-a', 'owner-input', 'queued', { draftClientId: 'device-a', draftRevision: 3 }),
    record('project-a', 'cut-off-call', 'executing', { attemptBoot: 'pre-fix-boot' }),
  ], { [k('project-a', 'context')]: { conversationId: 'conversation-a', epoch: 2 }, [k('project-b', 'context')]: { conversationId: 'conversation-b', epoch: 0 } },
  { [k('project-a', 'device-a')]: 3, [k('project-b', 'device-b')]: 7 })

  // Commander rework 2026-11-26 (1). It runs once on every machine, the owner's
  // holding real marks (11-09, 11-15, 11-20) that only the owner may clear.
  it('moves a populated pre-lock journal in whole: only its cut-off call turns uncertain', async () => {
    const seed = populatedLegacy(), raw = JSON.stringify(seed, null, 2)
    await mkdir(dirname(legacyJournal()), { recursive: true })
    await writeFile(legacyJournal(), raw)
    expect((await listAllConversationReceipts()).length).toBe(7)
    const cutOff = k('project-a', 'cut-off-call')
    expect(JSON.parse(await readFile(journal(), 'utf8'))).toEqual({ ...seed, version: 2,
      receipts: { ...seed.receipts, [cutOff]: { ...seed.receipts[cutOff], state: 'uncertain', error: restarted } } })
    expect(await readFile(`${legacyJournal()}.retired`, 'utf8')).toBe(raw)
    const settled = await readFile(journal(), 'utf8')
    await listAllConversationReceipts()
    expect(await readFile(journal(), 'utf8')).toBe(settled)
  })

  // Commander rework 2026-11-26 (2). A file there again: a downgraded app whose
  // folder was removed by hand (above), or an old build's write landing between
  // the move and the folder.
  it('merges a pre-lock journal that reappears after the move: its marks and inputs kept, ours kept, no copy overwritten', async () => {
    const first = JSON.stringify(populatedLegacy(), null, 2)
    await mkdir(dirname(legacyJournal()), { recursive: true })
    await writeFile(legacyJournal(), first)
    await listAllConversationReceipts()
    const ours = JSON.parse(await readFile(journal(), 'utf8'))
    // A final the app already moved to its archive is ours too.
    const archived = record('project-c', 'archived-call', 'delivered', { attemptBoot: 'boot-1118', result: { confirmed: true } })
    const shard = k('project-c', 'archived-call').slice(0, 3)
    await mkdir(join(openGroundHome(), 'runtime', 'receipt-archive'), { recursive: true })
    await writeFile(join(openGroundHome(), 'runtime', 'receipt-archive', `${shard}.json`),
      JSON.stringify({ version: 1, prefix: shard, receipts: { [k('project-c', 'archived-call')]: archived } }))

    await rm(legacyJournal(), { recursive: true })
    const downgraded = legacyDocument([
      record('project-c', 'mark-downgraded', 'uncertain', { attemptBoot: 'old-build', error: restarted }),
      input('project-c', 'input-downgraded', 'delivered', { draftClientId: 'device-c', draftRevision: 5 }, { attemptBoot: 'old-build' }),
      record('project-c', 'cut-off-downgraded', 'executing', { attemptBoot: 'old-build' }),
      record('project-a', 'done-call', 'executing', { attemptBoot: 'old-build' }),
      record('project-c', 'archived-call', 'executing', { attemptBoot: 'old-build' }),
    ], { [k('project-a', 'context')]: { conversationId: 'conversation-downgraded', epoch: 0 }, [k('project-c', 'context')]: { conversationId: 'conversation-c', epoch: 1 } },
    // device-b has no receipt left to recount it from: only the merge keeps its 7.
    { [k('project-a', 'device-a')]: 9, [k('project-b', 'device-b')]: 2 })
    const second = JSON.stringify(downgraded, null, 2)
    await writeFile(legacyJournal(), second)
    await listAllConversationReceipts()

    const merged = JSON.parse(await readFile(journal(), 'utf8'))
    expect(merged.receipts[k('project-c', 'mark-downgraded')]).toEqual(downgraded.receipts[k('project-c', 'mark-downgraded')])
    expect(merged.receipts[k('project-c', 'input-downgraded')]).toEqual(downgraded.receipts[k('project-c', 'input-downgraded')])
    expect(merged.receipts[k('project-c', 'cut-off-downgraded')]).toMatchObject({ state: 'uncertain', error: restarted })
    for (const [key, receipt] of Object.entries(ours.receipts)) expect([key, merged.receipts[key]]).toEqual([key, receipt])
    expect(['archived', merged.receipts[k('project-c', 'archived-call')]]).toEqual(['archived', undefined])
    expect(merged.contexts).toEqual({ ...downgraded.contexts, ...ours.contexts })
    expect(merged.acceptedDrafts).toEqual({ ...ours.acceptedDrafts, [k('project-a', 'device-a')]: 9, [k('project-c', 'device-c')]: 5 })
    expect(await readFile(`${legacyJournal()}.retired`, 'utf8')).toBe(first)
    expect(await readFile(`${legacyJournal()}.retired.2`, 'utf8')).toBe(second)
    expect((await stat(legacyJournal())).isDirectory()).toBe(true)
  })
})

describe('who owns the journal', () => {
  it('refuses while the owner lives, stopped too (a sleeping Mac): there is no lease to run out', async () => {
    const owner = start(holder('live-owner'))
    expect(JSON.parse(await owner.line())).toEqual({ outcome: 'owner' })
    expect((await ownerRecords())['1.json']).toEqual({ bootId: 'live-owner', pid: owner.pid, port: expect.any(Number) })
    const refused = await assertRuntimeJournalOwner(openGroundHome(), 'second-copy').catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(RuntimeJournalOwnedElsewhere)
    expect((refused as RuntimeJournalOwnedElsewhere).pid).toBe(owner.pid)

    process.kill(owner.pid, 'SIGSTOP')
    try { expect(await refusal(assertRuntimeJournalOwner(openGroundHome(), 'second-copy'))).toBe('RuntimeJournalOwnedElsewhere') }
    finally { process.kill(owner.pid, 'SIGCONT') }
  })

  it('counts every "cannot tell" as alive, each judged on its own', async () => {
    const live = start('process.stdin.resume()')
    const cases: [string, unknown][] = [
      ['no listener to ask', { bootId: 'no-listener', pid: live.pid }],
      // A process out of file descriptors accepts and hangs up without a word (libuv sheds load that way).
      ['a hang-up without a word', { bootId: 'out-of-descriptors', pid: live.pid, port: await listening((socket) => socket.end()) }],
      ['a reset connection', { bootId: 'reset', pid: live.pid, port: await listening((socket) => socket.resetAndDestroy()) }],
      // pid 1 belongs to root: kill(1, 0) answers EPERM, not ESRCH.
      ['a pid of another user', { bootId: 'other-user', pid: 1 }],
    ]
    for (const [name, record] of cases) {
      await rm(ownerDir(), { recursive: true, force: true })
      await writeOwner(1, record)
      expect([name, await refusal(assertRuntimeJournalOwner(openGroundHome(), 'second-copy'))]).toEqual([name, 'RuntimeJournalOwnedElsewhere'])
      expect([name, Object.keys(await ownerRecords())]).toEqual([name, ['1.json']])
    }
  })

  it('probes a silent holder at most once a minute: each probe stays queued at a stopped owner', async () => {
    const live = start('process.stdin.resume()')
    let probes = 0
    await writeOwner(1, { bootId: 'silent-owner', pid: live.pid, port: await listening(() => { probes++ }) })
    expect(await refusal(assertRuntimeJournalOwner(openGroundHome(), 'second-copy'))).toBe('RuntimeJournalOwnedElsewhere')
    expect(await refusal(assertRuntimeJournalOwner(openGroundHome(), 'second-copy'))).toBe('RuntimeJournalOwnedElsewhere')
    expect(probes).toBe(1)
  })

  it('takes over from a gone owner: an exited process, a pid and a port that went to others, an unreadable record', async () => {
    const exited = start(holder('exited-owner'))
    expect(JSON.parse(await exited.line())).toEqual({ outcome: 'owner' })
    await exited.stop()
    await assertRuntimeJournalOwner(openGroundHome(), 'after-exit')
    expect(await ownerRecords()).toEqual({ '2.json': { bootId: 'after-exit', pid: process.pid, port: expect.any(Number) } })

    // After a reboot the old pid is soon another program's. Nothing listens on the old port.
    const stranger = start('process.stdin.resume()')
    await writeOwner(3, { bootId: 'before-reboot', pid: stranger.pid, port: await closedPort() })
    await assertRuntimeJournalOwner(openGroundHome(), 'after-reboot')
    expect((await ownerRecords())['4.json']).toMatchObject({ bootId: 'after-reboot', pid: process.pid })
    // Or the port number went to another program too: it says something else.
    await writeOwner(5, { bootId: 'before-reboot', pid: stranger.pid, port: await listening((socket) => socket.end('220 some other service\r\n')) })
    await assertRuntimeJournalOwner(openGroundHome(), 'after-another-reboot')
    expect((await ownerRecords())['6.json']).toMatchObject({ bootId: 'after-another-reboot', pid: process.pid })
    // Or to one that waits for the client to speak, as HTTP servers do: the probe's line makes it answer.
    await writeOwner(7, { bootId: 'before-reboot', pid: stranger.pid,
      port: await listening((socket) => socket.once('data', () => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'))) })
    await assertRuntimeJournalOwner(openGroundHome(), 'after-a-third-reboot')
    expect((await ownerRecords())['8.json']).toMatchObject({ bootId: 'after-a-third-reboot', pid: process.pid })

    // A name that is no generation (it would be read back as "5.json") is left alone.
    await writeOwner('05', { bootId: 'padded', pid: stranger.pid })
    await writeOwner(9, '')
    await assertRuntimeJournalOwner(openGroundHome(), 'after-crash')
    expect(await ownerRecords()).toEqual({ '05.json': { bootId: 'padded', pid: stranger.pid }, '10.json': expect.objectContaining({ bootId: 'after-crash' }) })
  })

  it('never overwrites a claim published after its listing (compare-and-swap)', async () => {
    const owner = start(holder('first-claim'))
    expect(JSON.parse(await owner.line())).toEqual({ outcome: 'owner' })
    const published = await readFile(join(ownerDir(), '1.json'), 'utf8')
    // We list the folder as empty, as if the other process claimed a moment later.
    fsState.staleOwnerListings = 1
    expect(await refusal(assertRuntimeJournalOwner(openGroundHome(), 'late-claim'))).toBe('RuntimeJournalOwnedElsewhere')
    expect(await readFile(join(ownerDir(), '1.json'), 'utf8')).toBe(published)
    expect(Object.keys(await ownerRecords())).toEqual(['1.json'])
  })

  it('withdraws a claim that lands under a newer live owner (a listing from before two takeovers)', async () => {
    // Generation 1 was a gone owner; the live owner took over as generation 2 and removed it.
    await writeOwner(1, { bootId: 'long-gone', pid: await exitedPid() })
    const owner = start(holder('live-owner'))
    expect(JSON.parse(await owner.line())).toEqual({ outcome: 'owner' })
    expect(Object.keys(await ownerRecords())).toEqual(['2.json'])
    const published = await readFile(join(ownerDir(), '2.json'), 'utf8')
    // We decided on a listing from before either existed, so the name "1.json" is free again.
    fsState.staleOwnerListings = 1
    expect(await refusal(assertRuntimeJournalOwner(openGroundHome(), 'late-claim'))).toBe('RuntimeJournalOwnedElsewhere')
    expect(Object.keys(await ownerRecords())).toEqual(['2.json'])
    expect(await readFile(join(ownerDir(), '2.json'), 'utf8')).toBe(published)
  })

  it('withdraws when a name it judged gone holds a fresh record by the time it checks (the folder was emptied meanwhile)', async () => {
    await writeOwner(1, { bootId: 'long-gone', pid: await exitedPid() })
    // We judge 1.json gone. Before we publish 2.json, someone empties the folder
    // and the app claims 1.json afresh.
    let owner: Running | undefined
    fsState.beforeOwnerLink = async () => {
      for (const name of await readdir(ownerDir())) if (name.endsWith('.json')) await rm(join(ownerDir(), name))
      owner = start(holder('fresh-owner'))
      expect(JSON.parse(await owner.line())).toEqual({ outcome: 'owner' })
    }
    expect(await refusal(assertRuntimeJournalOwner(openGroundHome(), 'stalled-claim'))).toBe('RuntimeJournalOwnedElsewhere')
    expect(await ownerRecords()).toEqual({ '1.json': { bootId: 'fresh-owner', pid: owner!.pid, port: expect.any(Number) } })
  })

  it('withdraws its claim when the check after publishing fails', async () => {
    await writeOwner(1, { bootId: 'long-gone', pid: await exitedPid() })
    // The judging read passes; the check after publishing hits a full descriptor table.
    fsState.failOwnerRead = { name: '1.json', after: 1 }
    expect(await assertRuntimeJournalOwner(openGroundHome(), 'unlucky-claim').then(() => 'owner', (error: NodeJS.ErrnoException) => error.code)).toBe('EMFILE')
    // Left behind, our record would be the newest: the next call would read it as ownership.
    expect(Object.keys(await ownerRecords())).toEqual(['1.json'])
  })

  it('keeps the live owner when a gone process left a newer record behind', async () => {
    const owner = start(holder('live-owner'))
    expect(JSON.parse(await owner.line())).toEqual({ outcome: 'owner' })
    // A process that published a claim and died before it could withdraw it.
    await writeOwner(2, { bootId: 'died-mid-claim', pid: await exitedPid() })
    const refused = await assertRuntimeJournalOwner(openGroundHome(), 'second-copy').catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(RuntimeJournalOwnedElsewhere)
    expect((refused as RuntimeJournalOwnedElsewhere).pid).toBe(owner.pid)
    // The owner carries on: it publishes itself again above the stray record.
    owner.send('check')
    expect(JSON.parse(await owner.line())).toEqual({ outcome: 'owner' })
    expect(Object.values(await ownerRecords()).map((record) => record.bootId)).toEqual(['live-owner'])
    expect(await refusal(assertRuntimeJournalOwner(openGroundHome(), 'second-copy'))).toBe('RuntimeJournalOwnedElsewhere')
  })

  // Commander rework (2), 2026-11-24: a record only a pid speaks for can never be
  // proven gone. After a restart that pid soon belongs to another live program,
  // and the real app would be refused its own journal for as long as that runs.
  it('never publishes a record without its loopback port: no listener, no claim', async () => {
    netState.failListens = 1
    expect(await refusal(assertRuntimeJournalOwner(openGroundHome(), 'listener-failed'))).toBe('Error')
    expect(await readdir(ownerDir()).then((names) => names.filter((name) => name.endsWith('.json')), () => [])).toEqual([])
    // The next call opens the listener and claims with its port.
    expect(await refusal(assertRuntimeJournalOwner(openGroundHome(), 'listener-failed'))).toBe('owner')
    expect(await ownerRecords()).toEqual({ '1.json': { bootId: 'listener-failed', pid: process.pid, port: expect.any(Number) } })
  })

  // Commander rework (3), and 2026-11-26: agents read this. In the incident the
  // owner was the live app; when the app was down and a stray process asked
  // first, the refused one is the app itself, and moving it gives an empty app.
  // Deleting the lock folder hands the journal to whoever asks next.
  it('tells the refused process what to check and what to do either way, never to delete the lock', async () => {
    const owner = start(holder('live-owner'))
    expect(JSON.parse(await owner.line())).toEqual({ outcome: 'owner' })
    const refused = await assertRuntimeJournalOwner(openGroundHome(), 'second-copy').then(() => undefined, (error: Error) => error)
    expect(refused).toBeInstanceOf(RuntimeJournalOwnedElsewhere)
    const message = String(refused?.message)
    expect(message).toContain(`pid ${owner.pid}`)
    expect(message).toMatch(/if it is the live app, give this copy its own OPENGROUND_HOME/i)
    expect(message).toMatch(new RegExp(`stop pid ${owner.pid} only once it is confirmed`, 'i'))
    expect(message).toMatch(/never move the app to another OPENGROUND_HOME/i)
    expect(message).toMatch(/never delete runtime\/journal-owner/i)
    expect(message).not.toMatch(/\bstop it\b/i)
  })

  it('lets exactly one of two simultaneous starters own the journal', async () => {
    const racers = [start(holder('racer-a')), start(holder('racer-b'))]
    const outcomes = (await Promise.all(racers.map(async (racer) => JSON.parse(await racer.line()).outcome))).sort()
    expect(outcomes).toEqual(['RuntimeJournalOwnedElsewhere', 'owner'])
  })
})

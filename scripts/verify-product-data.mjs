// Real bundled-server acceptance under Electron's Node runtime. No live services.
// Run after npm run build: node scripts/verify-product-data.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, readFile, cp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { createServer } from 'node:net'
import { once } from 'node:events'
const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..')
const sandbox = await realpath(await mkdtemp(join(tmpdir(), 'og-product-restore-')))
const rel = relative(await realpath(tmpdir()), sandbox)
assert(rel && !rel.startsWith('..') && !isAbsolute(rel), 'Acceptance requires an isolated temp directory')
const original = join(sandbox, 'original')
const restored = join(sandbox, 'restored')
const home = join(sandbox, 'os-home')
const project = join(sandbox, 'fixture-project')
let child
let output = ''
let base
async function stop() {
  if (!child || child.exitCode !== null) return
  const ended = once(child, 'exit')
  child.kill('SIGTERM')
  const timer = setTimeout(() => child?.kill('SIGKILL'), 5000)
  await ended
  clearTimeout(timer)
}
async function start(dataHome, isOwner) {
  const probe = createServer().listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  base = `http://127.0.0.1:${port}`
  output = ''
  child = spawn(require('electron'), [join(root, 'server/dist/index.cjs')], {
    cwd: root,
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'),
      ELECTRON_RUN_AS_NODE: '1', OPENGROUND_HOME: dataHome,
      OPENGROUND_OWNER_EMAILS: isOwner ? 'restore-owner@example.invalid' : 'other@example.invalid',
      OPENGROUND_TESTER_EMAILS: '', OPENGROUND_BILLING_URL: '',
      OPENGROUND_CLAUDE_BIN: join(root, 'e2e/fixtures/fake-claude.sh'),
      OPENGROUND_TERMINAL_SHELL: '/bin/sh', OPENGROUND_FUEL_REPORT: '0',
      OPENGROUND_WORKER_REAP: '0', OPENGROUND_BOOT_ID: 'isolated-restore',
      OPENGROUND_WEB_ROOT: join(root, 'dist-web'), PORT: String(port), HOSTNAME: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', b => { output += b })
  child.stderr.on('data', b => { output += b })
  for (let n = 0; n < 160; n++) {
    assert(child.exitCode === null, `Fixture server exited: ${output.slice(-2000)}`)
    try { if ((await fetch(`${base}/api/health`)).ok) return } catch {}
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`Fixture boot timed out: ${output.slice(-2000)}`)
}
async function api(path, method = 'GET', body, status = 200) {
  const res = await fetch(base + path, { method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
  assert.equal(res.status, status, `${method} ${path}`)
  return res.json()
}
async function hashes(dir) {
  const result = {}
  async function walk(path, prefix = '') {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = join(prefix, entry.name)
      if (entry.isDirectory()) await walk(join(path, entry.name), name)
      else if (entry.isFile()) result[name] = createHash('sha256').update(await readFile(join(path, entry.name))).digest('hex')
      else throw new Error('Unexpected non-regular fixture file')
    }
  }
  await walk(dir)
  return result
}
try {
  await Promise.all([mkdir(original), mkdir(join(home, '.claude'), { recursive: true }), mkdir(join(project, 'docs/research'), { recursive: true })])
  await writeFile(join(original, 'settings.json'), JSON.stringify({ projects: [], projectsMigratedAt: new Date().toISOString(),
    lockdownMode: true, autoUpdate: false, swarmOptIn: false, language: 'en' }), { mode: 0o600 })
  await writeFile(join(original, 'auth.json'), JSON.stringify({ user: { id: 'restore-fixture', email: 'restore-owner@example.invalid', provider: 'google' },
    accessToken: 'dummy', refreshToken: 'dummy', expiresAt: Date.now() + 3600000 }), { mode: 0o600 })
  const report = '# Restore fixture\n\nPrivate local report.\n'
  await writeFile(join(project, 'docs/research/restore.md'), report)
  await start(original, true)
  const entry = await api('/api/projects/import', 'POST', { path: project })
  const query = `?path=${encodeURIComponent(entry.path)}`
  const boardUrl = `/api/project${query}`
  const initial = await api(boardUrl)
  const module = await api('/api/custom-modules', 'POST', { label: 'Saved Owner tab', description: 'Restore fixture', framework: 'html' })
  const saved = await api(boardUrl, 'PUT', { ...initial, notes: 'Saved notes', customTabs: [module.id], tabOrder: ['canvas', 'board', 'terminal'],
    tasks: [{ id: 'saved-task', title: 'Preserve this task', done: false, boardColumn: 'todo', createdAt: new Date().toISOString() }] })
  const canvas = await api('/api/project/canvases?action=create', 'POST', { path: entry.path, name: 'Saved design' })
  const canvasUrl = `/api/project/canvases${query}&id=${canvas.canvas.id}`
  const savedCanvas = await api(canvasUrl)
  const wordpress = { baseUrl: 'https://restore.example.invalid', username: 'fixture', appPassword: 'dummy-not-a-password' }
  await api('/api/settings', 'POST', { wordpress, workerTrials: { thinkInCode: true } })
  const source = await api(`/api/custom-modules/${module.id}/source`)
  await stop()
  const central = join(original, 'projects', entry.id)
  await mkdir(join(central, 'assets'), { recursive: true })
  await writeFile(join(central, 'assets/fixture.txt'), 'asset bytes survive\n')
  await writeFile(join(central, 'blog-publish.json'), JSON.stringify({ site: wordpress.baseUrl, entries: {}, wanted: { 'restore.md': true } }))
  const before = await hashes(original)
  await cp(original, restored, { recursive: true, preserveTimestamps: true })
  assert.deepEqual(await hashes(restored), before, 'Complete stopped-home copy must preserve every file')
  await start(restored, false)
  assert.deepEqual(await api(boardUrl), saved, 'Copied Board survives process restart')
  const listing = await api('/api/projects')
  assert.equal(listing.settings.wordpress, undefined)
  assert.equal(listing.settings.workerTrials, undefined)
  await api(canvasUrl, 'GET', undefined, 403)
  await api('/api/custom-modules', 'GET', undefined, 403)
  await api(`/api/research/report${query}&file=restore.md`, 'GET', undefined, 403)
  const receipt = await api('/api/settings', 'POST', { displayName: 'Free user', wordpress: null, workerTrials: {} })
  assert.deepEqual(receipt.applied, ['displayName'])
  await stop()
  await start(restored, true)
  assert.deepEqual(await api(boardUrl), saved)
  assert.deepEqual(await api(canvasUrl), savedCanvas)
  // Copying can round sub-millisecond mtimes; content and SHA-256 are authoritative.
  assert.equal((await api(`/api/custom-modules/${module.id}/source`)).source, source.source)
  assert.equal((await api(`/api/research/report${query}&file=restore.md`)).content, report)
  assert.deepEqual((await api('/api/settings')).wordpress, wordpress)
  assert.deepEqual((await api('/api/settings')).workerTrials, { thinkInCode: true })
  // Exercise the shipped native node-pty binding under Electron's Node runtime.
  const term = await api('/api/terminal', 'POST', { cwd: entry.path, cols: 80, rows: 24 })
  assert(term.id, 'Electron native terminal must launch')
  await api(`/api/terminal/${term.id}`, 'DELETE')
  await stop()
  const after = await hashes(restored)
  const protectedNames = Object.keys(before).filter(name => name.startsWith('projects/') || name.startsWith('custom-modules/'))
  for (const name of protectedNames) assert.equal(after[name], before[name], `Protected bytes changed: ${name}`)
  assert.deepEqual(await hashes(original), before, 'Original backup must remain unchanged')
  console.log(`PASS: ${Object.keys(before).length} copied files; ${protectedNames.length} protected files unchanged; Owner → Free → Owner across three Electron server boots; native PTY launched.`)
  console.log('No real Claude, Stripe, Supabase, WordPress, NENE, signed app or installed-app update was tested.')
} finally {
  await stop()
  await rm(sandbox, { recursive: true, force: true })
}

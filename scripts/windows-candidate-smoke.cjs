// Runs only on the ephemeral Windows runner. Never use the owner's profile.
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { SOURCE_SHA, VERSION, peMachine, hash, smokeEnvironments, smokeTools } = require('./windows-candidate.cjs')
const { LIMITS, createDiagnostics } = require('./windows-smoke-diagnostics.cjs')

async function portFree() {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: 47776 })
    socket.once('connect', () => { socket.destroy(); reject(new Error('Port47776 is occupied; refusing to share a service.')) })
    socket.once('error', error => error.code === 'ECONNREFUSED' ? resolve() : reject(error))
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('Port probe timed out.')) })
  })
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Native smoke requires the owned Windows runner; no substitute pass.')
  const [sourceArg, rootArg] = process.argv.slice(2)
  const source = path.resolve(sourceArg), root = path.resolve(rootArg)
  if (!process.env.RUNNER_TEMP || !root.startsWith(path.resolve(process.env.RUNNER_TEMP) + path.sep)) throw new Error('Smoke must stay in runner temp.')
  const req = createRequire(path.join(source, 'package.json'))
  const { _electron, expect } = smokeTools(source)
  const verified = path.join(root, 'verified'), diagnostics = path.join(root, 'diagnostics')
  fs.mkdirSync(diagnostics, { recursive: true })
  const probe = createDiagnostics(diagnostics, SOURCE_SHA)
  const checkpoint = probe.record
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      checkpoint('native-acceptance-cancelled', { signal })
      // Exit only this disposable runner harness, so upload steps can proceed.
      process.exit(signal === 'SIGINT' ? 130 : 143)
    })
  }
  checkpoint('native-acceptance-start')
  const manifest = JSON.parse(fs.readFileSync(path.join(verified, 'manifest.json')))
  assert.equal(manifest.sourceSha, SOURCE_SHA)
  const installer = manifest.files.find(file => file.name.endsWith('.exe'))
  const installerPath = path.join(verified, installer.name)
  assert.equal(hash(fs.readFileSync(installerPath)), installer.sha256)
  const profile = path.join(root, 'isolated-profile'), home = path.join(profile, 'home'), appHome = path.join(home, '.openground')
  fs.mkdirSync(appHome, { recursive: true })
  const userData = path.join(profile, 'electron-user-data')
  fs.writeFileSync(path.join(appHome, 'settings.json'), JSON.stringify({ projects: [], projectsMigratedAt: new Date().toISOString(), lockdownMode: true, autoUpdate: false, language: 'en' }))
  const { installerEnv, env } = smokeEnvironments(process.env, profile)
  for (const dir of [env.APPDATA, env.LOCALAPPDATA, userData]) fs.mkdirSync(dir, { recursive: true })
  await portFree()
  const install = path.join(root, 'installed')
  checkpoint('installer-context', { perUser: true, profileOverridesForInstaller: false })
  // Assisted NSIS /S does not launch unless --force-run is explicitly supplied.
  try {
    await probe.child('installer', installerPath, ['/S', `/D=${install}`], { env: installerEnv }, LIMITS.installer)
  } catch (error) {
    const failure = { phase: 'installer-failed', status: error.status, signal: error.signal,
      code: error.code, stdout: error.stdout?.toString(), stderr: error.stderr?.toString(),
      installedExeExists: fs.existsSync(path.join(install, 'OPEN GROUND.exe')) }
    fs.writeFileSync(path.join(diagnostics, 'installer-failure.json'), JSON.stringify(failure, null, 2))
    console.error(JSON.stringify({ phase: failure.phase, status: failure.status, signal: failure.signal, code: failure.code }))
    throw error
  }
  await portFree()
  const exe = path.join(install, 'OPEN GROUND.exe')
  assert.equal(peMachine(fs.readFileSync(exe)), 0x8664)
  assert.equal(hash(fs.readFileSync(exe)), hash(fs.readFileSync(path.join(root, 'build/win-unpacked/OPEN GROUND.exe'))))
  const resources = path.join(install, 'resources')
  await probe.child('signature', 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$s=Get-AuthenticodeSignature -LiteralPath $env:OG_CHECK_EXE; @{status=[string]$s.Status; productVersion=(Get-Item -LiteralPath $env:OG_CHECK_EXE).VersionInfo.ProductVersion} | ConvertTo-Json -Compress'],
  { env: { ...env, OG_CHECK_EXE: exe } }, LIMITS.signature)
  const signature = JSON.parse(fs.readFileSync(path.join(diagnostics, 'signature-stdout.txt'), 'utf8').trim())
  assert.equal(signature.status, 'NotSigned')
  assert.ok(signature.productVersion.startsWith(VERSION))
  const ptyProbe = path.join(root, 'pty-probe.cjs')
  fs.writeFileSync(ptyProbe, `const fs=require('fs'),path=require('path'); const checkpoint=p=>fs.writeSync(1,'PTY probe: '+p+'\\n'); checkpoint('node-entry');
const pty=require(process.env.OG_PTY_MODULE); checkpoint('native-module-ready'); let out=''; checkpoint('spawn-start');
const term=pty.spawn(process.env.ComSpec||process.env.COMSPEC||'cmd.exe',['/d','/s','/c','echo OPENGROUND_WINDOWS_PTY_OK'],{cols:80,rows:24,cwd:process.env.HOME,env:process.env});
checkpoint('spawn-returned');
const timeout=setTimeout(()=>{term.kill();console.error('PTY timed out');process.exitCode=1},15000);
term.onData(x=>out+=x); term.onExit(({exitCode})=>{checkpoint('exit-'+exitCode);clearTimeout(timeout);if(exitCode!==0||!out.includes('OPENGROUND_WINDOWS_PTY_OK')){console.error('PTY echo failed');process.exitCode=1}else{fs.writeFileSync(process.env.OG_PTY_RESULT,JSON.stringify({electron:process.versions.electron,modules:process.versions.modules,arch:process.arch,nativeModules:Object.keys(require.cache).filter(x=>x.endsWith('.node')).map(x=>path.relative(process.env.OG_RESOURCES,x)),echo:true,exitCode}))}});
`)
  const ptyResult = path.join(diagnostics, 'native-pty.json')
  await probe.child('native-pty', exe, [ptyProbe], { env: { ...env, ELECTRON_RUN_AS_NODE: '1', OG_PTY_MODULE: path.join(resources, 'app/node_modules/node-pty'), OG_PTY_RESULT: ptyResult, OG_RESOURCES: resources } }, LIMITS.pty)
  const native = JSON.parse(fs.readFileSync(ptyResult))
  checkpoint('native-pty-process-exited')
  assert.equal(native.electron, req('electron/package.json').version)
  assert.equal(native.arch, 'x64'); assert.ok(native.nativeModules.length > 0)
  for (const file of native.nativeModules) assert.equal(peMachine(fs.readFileSync(path.join(resources, file))), 0x8664)
  const gui = []
  for (let round = 1; round <= 2; round++) {
    await portFree()
    const app = await probe.stage(`gui-${round}-launch`, LIMITS.guiLaunch, () => _electron.launch({ executablePath: exe, args: [`--user-data-dir=${userData}`], env, timeout: 60000, chromiumSandbox: true }))
    let failure
    try {
      await probe.stage(`gui-${round}-checks`, LIMITS.guiChecks, async () => {
        const identity = await app.evaluate(({ app }) => ({ version: app.getVersion(), packaged: app.isPackaged, userData: app.getPath('userData') }))
        assert.equal(identity.version, VERSION); assert.equal(identity.packaged, true)
        assert.equal(path.resolve(identity.userData).toLowerCase(), userData.toLowerCase())
        const page = await app.firstWindow({ timeout: 60000 })
        const runtimeErrors = [], consoleErrors = [], external = []
        page.on('pageerror', error => runtimeErrors.push(error.message))
        page.on('console', message => { if (message.type() === 'error') consoleErrors.push({ text: message.text(), url: message.location().url }) })
        await page.context().route('**/*', route => {
          const url = new URL(route.request().url())
          if (['http:', 'https:'].includes(url.protocol) && !['127.0.0.1', 'localhost'].includes(url.hostname)) { external.push(url.origin); return route.abort() }
          return route.continue()
        })
        await page.goto('http://127.0.0.1:47776/', { waitUntil: 'domcontentloaded' })
        const start = page.getByRole('button', { name: /^(Get started|はじめる|始める)$/ })
        if (round === 1) { await expect(start).toBeVisible({ timeout: 30000 }); await start.click() }
        await expect(page.getByText('MyProjects', { exact: true })).toBeVisible({ timeout: 30000 })
        if (round === 2) await expect(start).toHaveCount(0)
        const response = await page.request.get('http://127.0.0.1:47776/api/phone-link/assistant/log')
        assert.equal(response.status(), 403); assert.deepEqual(await response.json(), { error: 'forbidden' })
        await expect(page.locator('[data-og-assistant]')).toHaveCount(0)
        await page.getByRole('button', { name: 'Settings', exact: true }).click()
        const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
        await expect(settings).toBeVisible()
        await settings.getByRole('button', { name: 'Close', exact: true }).click()
        await page.screenshot({ path: path.join(diagnostics, `native-home-${round}.png`) })
        const url = 'http://127.0.0.1:47776/api/phone-link/assistant/log'
        const unexpected = consoleErrors.filter(e => e.url !== url || e.text !== 'Failed to load resource: the server responded with a status of 403 (Forbidden)')
        assert.deepEqual(runtimeErrors, []); assert.deepEqual(unexpected, []); assert.deepEqual(external, [])
        gui.push({ round, version: identity.version, packaged: true, emptyHomeVisible: true, settingsOpenedAndClosed: true, ownerOnlyApiRefused: true })
      })
    } catch (error) { failure = error }
    try {
      await probe.stage(`gui-${round}-quit`, LIMITS.guiQuit, () => app.close())
    } catch (error) {
      if (!failure) failure = error
      else checkpoint(`gui-${round}-quit-secondary-failure`, { message: error.message })
    }
    if (failure) throw failure
    assert.equal(app.process().exitCode, 0)
    await portFree()
  }
  const saved = JSON.parse(fs.readFileSync(path.join(appHome, 'settings.json')))
  assert.deepEqual(saved.projects, []); assert.equal(saved.autoUpdate, false); assert.equal(saved.lockdownMode, true)
  const result = { sourceSha: SOURCE_SHA, version: VERSION, signature, native, gui, installedPerUser: true,
    normalQuitAndRelaunch: true, realClaudeUsed: false, profileIsolated: true,
    limitation: 'CI Windows native/installer smoke, not physical-device SmartScreen or a real user update transaction.' }
  fs.writeFileSync(path.join(verified, 'windows-smoke.json'), JSON.stringify(result, null, 2))
  manifest.nativeSmokeVerified = true
  manifest.nativeSmokeResultSha256 = hash(fs.readFileSync(path.join(verified, 'windows-smoke.json')))
  fs.writeFileSync(path.join(verified, 'manifest.json'), JSON.stringify(manifest, null, 2))
  checkpoint('native-acceptance-passed')
  console.log('Unsigned NSIS install, packaged Electron ABI/native PTY, native UI and normal relaunch passed.')
}
main().catch(error => {
  fs.writeSync(2, `${error.message}\n`)
  // A timed-out child/Playwright connection must not keep the failed harness
  // alive until the whole job deadline. Runner cleanup owns any remaining test children.
  process.exit(1)
})

// Electron main — spike skeleton
const { app, BrowserWindow, ipcMain } = require('electron')
const { fork } = require('child_process')
const path = require('path')

let childPid = null
let mainWindow = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    title: 'OPEN GROUND Spike',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  })
  mainWindow.loadFile(path.join(__dirname, 'index.html'))
}

function spawnChild() {
  // Resolve child script in packaged vs dev.
  // In packaged: __dirname is .app/Contents/Resources/app.asar/src
  // In dev: __dirname is /spike/electron-skeleton/src
  const childPath = path.join(__dirname, 'child-test.js')
  console.log('[main] forking child:', childPath)
  const child = fork(childPath, [], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      OPENGROUND_SPIKE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  child.stdout?.on('data', (d) => {
    const text = d.toString()
    console.log('[child stdout]', text.trim())
    mainWindow?.webContents.send('child-log', text)
  })
  child.stderr?.on('data', (d) => {
    const text = d.toString()
    console.error('[child stderr]', text.trim())
    mainWindow?.webContents.send('child-log', '[stderr] ' + text)
  })
  child.on('message', (msg) => {
    console.log('[main] child message:', msg)
    mainWindow?.webContents.send('child-event', msg)
  })
  child.on('exit', (code) => {
    console.log('[main] child exited code=', code)
    mainWindow?.webContents.send('child-log', `[child exited code=${code}]\n`)
  })
  childPid = child.pid
  return child
}

ipcMain.handle('run-pty-test', async () => {
  // The renderer can trigger this to ask child to do pty.spawn.
  return new Promise((resolve) => {
    const child = spawnChild()
    let out = ''
    child.stdout?.on('data', (d) => { out += d.toString() })
    child.stderr?.on('data', (d) => { out += '[err] ' + d.toString() })
    child.on('exit', (code) => resolve({ code, out: out.slice(-4000) }))
  })
})

app.whenReady().then(() => {
  createWindow()
  // Run the spike test automatically on launch so we get output.
  setTimeout(() => spawnChild(), 1500)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

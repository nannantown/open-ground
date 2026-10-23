// Test-runner diagnostics only; never imported by the packaged application.
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const LIMITS = Object.freeze({ installer: 120000, signature: 30000, pty: 45000, guiLaunch: 60000, guiChecks: 90000, guiQuit: 30000 })

function createDiagnostics(directory, sourceSha, outputFd = 1) {
  fs.mkdirSync(directory, { recursive: true })
  const save = (name, value, append = false) => {
    const fd = fs.openSync(path.join(directory, name), append ? 'a' : 'w')
    try { fs.writeSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  }
  const record = (phase, details = {}) => {
    const value = { ...details, phase, atUtc: new Date().toISOString(), sourceSha }
    save('phase.json', value); save('phases.jsonl', value, true)
    // Do not buffer progress behind a child process or an asynchronous logger.
    fs.writeSync(outputFd, `Windows candidate phase: ${phase}\n`)
    return value
  }
  const stage = async (name, milliseconds, operation, onTimeout) => {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) throw new Error('A stage needs a finite positive deadline.')
    const started = Date.now()
    record(`${name}-start`, { timeoutMs: milliseconds })
    let timer
    try {
      const result = await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => { timer = setTimeout(() => {
          const error = Object.assign(new Error(`${name} exceeded ${milliseconds}ms.`), { code: 'STAGE_TIMEOUT' })
          record(`${name}-deadline`, { elapsedMs: Date.now() - started, code: error.code })
          try { onTimeout?.() } catch (cleanup) { record(`${name}-cleanup-failed`, { message: cleanup.message }) }
          reject(error)
        }, milliseconds) }),
      ])
      record(`${name}-finished`, { elapsedMs: Date.now() - started })
      return result
    } catch (error) {
      save(`${name}-failure.json`, { stage: name, elapsedMs: Date.now() - started, code: error.code, message: error.message })
      record(`${name}-failed`, { elapsedMs: Date.now() - started, code: error.code, message: error.message })
      throw error
    } finally { clearTimeout(timer) }
  }
  const child = async (name, command, args, options, milliseconds) => {
    const stdout = fs.openSync(path.join(directory, `${name}-stdout.txt`), 'w')
    const stderr = fs.openSync(path.join(directory, `${name}-stderr.txt`), 'w')
    let ownedChild
    try {
      return await stage(name, milliseconds, () => new Promise((resolve, reject) => {
        // Files avoid waiting on a pipe kept open by an installer descendant.
        ownedChild = spawn(command, args, { ...options, stdio: ['ignore', stdout, stderr] })
        ownedChild.once('spawn', () => record(`${name}-spawned`, { pid: ownedChild.pid }))
        ownedChild.once('error', reject)
        ownedChild.once('exit', (code, signal) => {
          const result = { code, signal, pid: ownedChild.pid }
          save(`${name}-result.json`, result)
          record(`${name}-exited`, result)
          if (code === 0) resolve(result)
          else reject(Object.assign(new Error(`${name} exited with code ${code}, signal ${signal}.`), { code: 'CHILD_FAILED' }))
        })
      }), () => {
        // Only the child started by this disposable-runner probe is targeted.
        if (ownedChild && ownedChild.exitCode === null) ownedChild.kill()
      })
    } finally { fs.closeSync(stdout); fs.closeSync(stderr) }
  }
  return { record, stage, child }
}

module.exports = { LIMITS, createDiagnostics }

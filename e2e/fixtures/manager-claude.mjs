#!/usr/bin/env node
// Offline CLI stand-in for SDK manager acceptance tests. No auth or network.
import { appendFileSync, mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { join, isAbsolute, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'

const args = process.argv.slice(2)
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n')
if (args.includes('--version') || args.includes('-v')) {
  console.log('2.1.220 (offline fixture)')
  process.exit(0)
}
if (args[0] === 'auth') {
  send({ loggedIn: true })
  process.exit(0)
}
const capture = process.env.OPENGROUND_TEST_LAUNCH_DIR
if (!capture || !process.env.HOME) throw new Error('An isolated HOME and launch directory are required')
const home = realpathSync(process.env.HOME)
const temporaryRoots = [realpathSync(tmpdir()), realpathSync('/tmp')]
for (const path of [home, realpathSync(capture)]) {
  if (!temporaryRoots.some(root => {
    const child = relative(root, path)
    return child !== '' && child !== '..' && !child.startsWith('../') && !isAbsolute(child)
  })) throw new Error('Fixture writes require a temporary HOME and launch directory')
}
appendFileSync(join(capture, 'protocol.jsonl'), JSON.stringify({ argv: args }) + '\n')
const { values } = parseArgs({ args, strict: false, allowPositionals: true, options: {
  resume: { type: 'string' }, 'session-id': { type: 'string' },
} })
const sessionId = values.resume ?? values['session-id']
if (!sessionId) {
  send({ type: 'result', subtype: 'success', result: 'OK', is_error: false })
  process.exit(0)
}
if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error('Invalid fixture session ID')
const dir = join(home, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'))
mkdirSync(dir, { recursive: true })
let captured = false

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  appendFileSync(join(capture, 'protocol.jsonl'), line + '\n')
  if (message.type === 'control_request') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } })
    return
  }
  if (message.type !== 'user') return
  const content = message.message.content
  const prompt = typeof content === 'string' ? content : content.map((part) => part.text ?? '').join('')
  appendFileSync(join(dir, `${sessionId}.jsonl`), JSON.stringify({ type: 'user', sessionId, message: message.message }) + '\n')
  if (!captured) {
    // Publish only after the resumable transcript exists; claim numbers atomically.
    let n = 0
    for (;;) {
      try { mkdirSync(join(capture, `claim.${n}`)); break } catch (error) {
        if (error.code !== 'EEXIST') throw error
        n++
      }
    }
    const temp = join(capture, `tmp.${process.pid}`)
    writeFileSync(temp, JSON.stringify({ argv: args, prompt }))
    renameSync(temp, join(capture, `launch.${n}`))
    captured = true
  }
  send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Offline manager received: ${prompt}` }] }, parent_tool_use_id: null, session_id: sessionId })
  send({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', result: 'done', session_id: sessionId })
}).on('close', () => process.exit(0))

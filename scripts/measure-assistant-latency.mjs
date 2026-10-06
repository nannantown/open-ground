// How fast the assistant answers, as the floating window sees it: per line, the
// seconds from sending to the first thing it says (a "let me look" or the
// answer) and to the answer, and what is read aloud.
//
//   node scripts/measure-assistant-latency.mjs [baseUrl] "line" ["line" ...]
//
// baseUrl defaults to http://127.0.0.1:47776 (the running app). It asks the
// window's own route (`stream: true`); an older app that does not stream
// answers once, so its first = its answer. Each line is a real assistant turn
// on the owner's subscription and goes into that app's assistant log.
// (Speech recognition and the system voice add the same time before and after.)
const args = process.argv.slice(2)
const base = /^https?:/.test(args[0] ?? '') ? args.shift() : 'http://127.0.0.1:47776'
const lines = args.length ? args : ['やあ、元気?', 'アシスタントの記録ってどこにある?']

await fetch(`${base}/api/phone-link/assistant/warm`, { method: 'POST' }).catch(() => {})
for (const text of lines) {
  const t0 = performance.now()
  const r = await fetch(`${base}/api/phone-link/assistant/say`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, stream: true }),
  })
  let first = 0
  let buf = ''
  const dec = new TextDecoder()
  for await (const chunk of r.body) {
    if (!first) first = performance.now()
    buf += dec.decode(chunk, { stream: true })
  }
  const end = performance.now()
  const out = buf.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const s = (t) => ((t - t0) / 1000).toFixed(1)
  const answer = out.at(-1) ?? {}
  console.log(`\n> ${text}\n  status ${r.status} · first ${s(first)}s · answer ${s(end)}s`)
  for (const o of out.slice(0, -1)) console.log(`  interim: ${o.interim}`)
  console.log(`  spoken: ${answer.speak ?? answer.reply ?? JSON.stringify(answer)}`)
  if (answer.reply && answer.reply !== answer.speak) console.log(`  text: ${answer.reply.replace(/\n/g, ' / ')}`)
}

// What the assistant can read (assistantTools.ts). Asserts what comes BACK to
// the model (the text it would read). What it may only propose is
// assistantProposals.test.ts. HOME for
// OPEN GROUND is tmpdir-isolated by setup-home.ts.
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdir, mkdtemp, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { registerTestProject } from '../../test/registerProject'
import { openGroundHome } from './paths'
import { setLockdownCache } from './lockdown'
import { listForAssistant, readForAssistant, searchForAssistant } from './assistantTools'

const text = (r: Awaited<ReturnType<typeof readForAssistant>>) => ('text' in r ? r.text : '(image)')

let proj: string
let outside: string
beforeEach(async () => {
  setLockdownCache(false)
  proj = await mkdtemp(join(tmpdir(), 'og-asst-proj-'))
  await registerTestProject(proj)
  await mkdir(join(proj, 'src'))
  await writeFile(join(proj, 'src', 'checkout.ts'), 'export const SHIPPING_FEE = 480\n')
  await writeFile(join(proj, '.env'), 'STRIPE_KEY=sk_live_TOPSECRET\n')
  await writeFile(join(proj, 'config.json'), JSON.stringify({ site: 'kiwi', apiToken: 'tok_TOPSECRET' }, null, 2))
  // Somewhere in the home that is not a project: what ~/.ssh stands for.
  outside = await mkdtemp(join(tmpdir(), 'og-asst-outside-'))
  await mkdir(join(outside, '.ssh'))
  await writeFile(join(outside, '.ssh', 'config'), 'Host TOPSECRET\n')
})

describe('reading: the registered projects and OPEN GROUND data only, never a secret', () => {
  it('reads a project file and OPEN GROUND data, with line numbers', async () => {
    expect(text(await readForAssistant(join(proj, 'src', 'checkout.ts')))).toBe('1\texport const SHIPPING_FEE = 480\n2\t')
    await mkdir(join(openGroundHome(), 'assistant'), { recursive: true })
    await writeFile(join(openGroundHome(), 'assistant', 'memory.md'), 'ねこはミケ\n')
    expect(text(await readForAssistant(join(openGroundHome(), 'assistant', 'memory.md')))).toContain('ねこはミケ')
  })

  it('refuses anything outside them — a folder that is not a project, and ~/.ssh', async () => {
    for (const p of [join(outside, '.ssh', 'config'), join(outside, '.ssh'), '~/.ssh', '~/.ssh/id_ed25519']) {
      for (const r of [await readForAssistant(p), await listForAssistant(p), await searchForAssistant(p, 'Host')]) {
        expect(text(r)).not.toContain('TOPSECRET')
        expect(text(r)).toMatch(/Outside what you may read|Not found/)
      }
    }
    expect(text(await readForAssistant(join(outside, '.ssh', 'config')))).toMatch(/Outside what you may read/)
  })

  it("the home's secret places stay refused even inside a project registered at the home folder", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), 'og-asst-home-'))
    await mkdir(join(fakeHome, '.ssh'))
    await writeFile(join(fakeHome, '.ssh', 'id_rsa_backup'), 'TOPSECRET')
    await mkdir(join(fakeHome, '.aws'))
    await writeFile(join(fakeHome, '.aws', 'config'), 'TOPSECRET')
    await writeFile(join(fakeHome, 'notes.md'), 'hello')
    // The registry refuses the home folder itself today; an older entry (or one
    // above the home) can still hold it — registered first, then made "the home".
    await registerTestProject(fakeHome)
    const prev = process.env.HOME
    process.env.HOME = fakeHome
    try {
      // A root at the home would open all of it (other repos, shell history): not read at all.
      expect(text(await readForAssistant(join(fakeHome, 'notes.md')))).toMatch(/Outside what you may read/)
      for (const p of ['~/.ssh/id_rsa_backup', '~/.ssh', '~/.aws/config', '~/.SSH/id_rsa_backup']) expect(text(await readForAssistant(p))).not.toContain('TOPSECRET')
      expect(text(await searchForAssistant(fakeHome, 'TOPSECRET'))).not.toContain('TOPSECRET')
    } finally {
      process.env.HOME = prev
    }
  })

  it('a secret name in another case is the same file on the Mac, and still refused', async () => {
    await writeFile(join(openGroundHome(), 'Auth.JSON'), '{"k":"TOPSECRET"}')
    expect(text(await readForAssistant(join(openGroundHome(), 'Auth.JSON')))).toMatch(/holds secrets/)
  })

  it('a symlink inside a project cannot lead out of it', async () => {
    await symlink(join(outside, '.ssh'), join(proj, 'keys'))
    expect(text(await readForAssistant(join(proj, 'keys', 'config')))).toMatch(/Outside what you may read/)
    // Search never follows it either.
    expect(text(await searchForAssistant(proj, 'TOPSECRET'))).toBe('No match.')
  })

  it("refuses secret files inside the area (a project's .env, OPEN GROUND's logins and keys) and hides secret values", async () => {
    expect(text(await readForAssistant(join(proj, '.env')))).toMatch(/holds secrets/)
    for (const name of ['auth.json', 'phone-push-key.json', 'phone-link.json', 'research-auth.json']) {
      await writeFile(join(openGroundHome(), name), '{"k":"TOPSECRET"}')
      expect(text(await readForAssistant(join(openGroundHome(), name)))).toMatch(/holds secrets/)
    }
    const cfg = text(await readForAssistant(join(proj, 'config.json')))
    expect(cfg).toContain('"site": "kiwi"')
    expect(cfg).toContain('"apiToken": "[hidden]"')
    // A search over the whole project or OPEN GROUND's data never shows one either.
    expect(text(await searchForAssistant(proj, 'TOPSECRET'))).toBe('No match.')
    expect(text(await searchForAssistant(openGroundHome(), 'TOPSECRET'))).toBe('No match.')
    // ...and the listing does not name them.
    expect(text(await listForAssistant(proj))).not.toContain('.env')
  })

  it('secret values in env / YAML / URL form are hidden when read, and the usual secret files are refused', async () => {
    await writeFile(join(proj, 'deploy.yml'), 'site: kiwi\n  password: hunter2\n')
    await writeFile(join(proj, 'run.sh'), 'export API_KEY=sk-live-xyz\nSERVICE_ROLE_KEY=eyJTOPSECRET\nMODE=prod\n')
    await writeFile(join(proj, 'remote.txt'), 'url = https://kiwi:ghp_TOPSECRET@github.com/kiwi/shop.git\n')
    const yml = text(await readForAssistant(join(proj, 'deploy.yml')))
    expect(yml).toContain('password: [hidden]')
    expect(yml).not.toContain('hunter2')
    const sh = text(await readForAssistant(join(proj, 'run.sh')))
    expect(sh).not.toMatch(/sk-live|TOPSECRET/)
    expect(sh).toContain('MODE=prod')
    expect(text(await readForAssistant(join(proj, 'remote.txt')))).not.toContain('TOPSECRET')
    for (const name of ['.dev.vars', '.envrc', '.git-credentials', 'id_ed25519_github', 'deploy_key', 'prod.tfstate']) {
      await writeFile(join(proj, name), 'TOPSECRET')
      expect([name, text(await readForAssistant(join(proj, name)))]).toEqual([name, expect.stringMatching(/holds secrets/)])
    }
    expect(text(await searchForAssistant(proj, 'TOPSECRET|hunter2|sk-live'))).toBe('No match.')
  })

  it("OPEN GROUND's own home is an allow-list: its Board, canvases and the assistant's records yes — logins, keys and their leftover copies no", async () => {
    const og = openGroundHome()
    const pid = join(og, 'projects', 'p1')
    await mkdir(join(og, 'assistant'), { recursive: true })
    await mkdir(pid, { recursive: true })
    await writeFile(join(pid, 'tasks.json'), '{"tasks":[{"title":"Board card"}]}')
    await writeFile(join(og, 'assistant', 'memory.md'), 'ねこはミケ')
    expect(text(await readForAssistant(join(pid, 'tasks.json')))).toContain('Board card')
    expect(text(await readForAssistant(join(og, 'assistant', 'memory.md')))).toContain('ねこはミケ')
    // Interrupted atomic writes and backups are the file they copy.
    const refused = ['.phone-link.json.tmp-123-0', '.phone-push-key.json.tmp-1-0', '.auth.json.tmp-9-1', 'phone-link.json.bak', 'you-corpus.md', 'some-new-file.json']
    for (const name of refused) {
      await writeFile(join(og, name), '{"x":"TOPSECRET"}')
      expect([name, text(await readForAssistant(join(og, name)))]).toEqual([name, expect.stringMatching(/holds secrets/)])
    }
    // A copy of settings.json is settings.json: readable, its password hidden.
    await writeFile(join(og, 'settings.json.damaged-1.bak'), '{"wordpress":{"appPassword":"TOPSECRET"}}')
    expect(text(await readForAssistant(join(og, 'settings.json.damaged-1.bak')))).toContain('"appPassword":"[hidden]"')
    await mkdir(join(og, 'backups', 'settings'), { recursive: true })
    await writeFile(join(og, 'backups', 'settings', 'settings-1.json'), '{"x":"TOPSECRET"}')
    expect(text(await readForAssistant(join(og, 'backups', 'settings', 'settings-1.json')))).toMatch(/holds secrets/)
    expect(text(await searchForAssistant(og, 'TOPSECRET'))).toBe('No match.')
    const listed = text(await listForAssistant(og))
    for (const name of [...refused, 'backups/']) expect(listed).not.toContain(name)
    expect(listed).toContain('projects/')
  })

  it('hides camelCase keys, short key names and private-key blocks (raw or escaped in JSON)', async () => {
    const { hideSecrets } = await import('./assistantTools')
    const json = JSON.stringify({ e2eKey: 'AAA1', macKey: 'BBB2', p8: '-----BEGIN PRIVATE KEY-----\nMIIsecret3\n-----END PRIVATE KEY-----\n', ct0: 'CCC4', supabaseAnonKey: 'DDD5', accessToken: 'EEE6', site: 'kiwi', keyboard: 'jis' })
    const out = hideSecrets(json)
    for (const v of ['AAA1', 'BBB2', 'MIIsecret3', 'CCC4', 'DDD5', 'EEE6']) expect(out).not.toContain(v)
    expect(out).toContain('"site":"kiwi"')
    expect(out).toContain('"keyboard":"jis"')
    const raw = hideSecrets('before\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\nAAAAsecret\n-----END OPENSSH PRIVATE KEY-----\nafter')
    expect(raw).toBe('before\n[hidden]\n[hidden]\n[hidden]\n[hidden]\nafter')
  })

  it('hiding takes linear time: a crafted 512 KB file is done in well under 100 ms (the server has one thread)', async () => {
    const { hideSecrets } = await import('./assistantTools')
    const N = 512 * 1024
    const crafted = [
      'token'.repeat(N / 5), // a long run of key-like characters (was 4.6 s per 200 KB)
      ('"' + 'secret'.repeat(20)).repeat(N / 121), // quotes opening key-like names that never close
      '"apiToken": "'.repeat(N / 13), // keys whose values never end
      ('x'.repeat(60) + 'token=').repeat(N / 66), // NAME= almost everywhere
      '//a:'.repeat(N / 4), // URL passwords that never reach @
      '-----BEGIN RSA KEY-----'.repeat(N / 23),
      'eyJ-'.repeat(N / 4), // JWT-shaped runs (0.7 s as a regex branch, review 2026-10-06)
      '-eyJ'.repeat(N / 4),
      'eyJa-'.repeat(N / 5),
      ('eyJ' + 'a'.repeat(20) + '.').repeat(N / 24),
    ]
    for (const c of crafted) {
      const t0 = performance.now()
      hideSecrets(c)
      expect(performance.now() - t0).toBeLessThan(100)
    }
  })

  it('hides auth headers, secrets set in code and well-known token shapes anywhere', async () => {
    const { hideSecrets } = await import('./assistantTools')
    const out = hideSecrets(
      [
        JSON.stringify({ headers: { Authorization: 'Bearer AUTH1' }, author: 'kiwi' }),
        'const API_KEY = "CODE2"',
        'export const supabaseServiceRoleKey: string = "CODE3"',
        `fetch(url, { key: x }) // sk-ant-api03-${'a'.repeat(30)} ghp_${'b'.repeat(36)} AKIA${'C'.repeat(16)} xoxb-${'1'.repeat(20)}`,
      ].join('\n'),
    )
    for (const v of ['AUTH1', 'CODE2', 'CODE3', 'aaaaaaaaaa', 'bbbbbbbbbb', 'CCCCCCCCCC', '1111111111']) expect(out).not.toContain(v)
    expect(out).toContain('"author":"kiwi"')
    const more = hideSecrets(
      [
        JSON.stringify({ apiKeyValue: 'MORE1', privateKeyPem: 'MORE2', keyboard: 'jis', keyId: 'ABC123' }),
        `stripe sk_live_${'D'.repeat(24)} google AIza${'E'.repeat(35)} jwt eyJ${'f'.repeat(20)}.eyJ${'g'.repeat(20)}.${'h'.repeat(20)}`,
        `url = https://glpat-${'I'.repeat(20)}@gitlab.example/x.git`,
        '\textraheader = AUTHORIZATION: basic MORE3SECRETVALUE',
        '-----BEGIN PGP PRIVATE KEY BLOCK-----',
        'lQOYBGMORE4',
        '-----END PGP PRIVATE KEY BLOCK-----',
      ].join('\n'),
    )
    for (const v of ['MORE1', 'MORE2', 'DDDDDDDDDD', 'EEEEEEEEEE', 'ffffffffff', 'IIIIIIIIII', 'MORE3', 'MORE4']) expect(more).not.toContain(v)
    expect(more).toContain('"keyboard":"jis"')
    // Only a value's shape is hidden after Basic / Bearer — plain words stay.
    expect(hideSecrets('uses basic configuration and Bearer tokens in general')).toBe('uses basic configuration and Bearer tokens in general')
    // …but a short or digit-free credential is (base64 of user:pass, a letters-only token).
    for (const v of ['dXNlcjpwYXNz', 'abcdefgh_ijklmnop-qrstuvwxyz', 'AbcdefghIjklmnop']) expect(hideSecrets(`curl -H "Authorization: Basic ${v}" x`)).not.toContain(v)
  })

  it.runIf(process.platform === 'darwin')('a big photo goes smaller (it is resent with every later line of the session)', async () => {
    // A 1600×1600 noise bitmap (~7.7 MB, no compression) under a photo name.
    const w = 1600
    const row = w * 3
    const head = Buffer.alloc(54)
    head.write('BM')
    head.writeUInt32LE(54 + row * w, 2)
    head.writeUInt32LE(54, 10)
    head.writeUInt32LE(40, 14)
    head.writeInt32LE(w, 18)
    head.writeInt32LE(w, 22)
    head.writeUInt16LE(1, 26)
    head.writeUInt16LE(24, 28)
    const { randomBytes } = await import('crypto')
    await writeFile(join(proj, 'photo.png'), Buffer.concat([head, randomBytes(row * w)]).subarray(0, 4_500_000))
    const r = await readForAssistant(join(proj, 'photo.png'))
    if (!('image' in r)) throw new Error(JSON.stringify(r))
    expect(r.image.mimeType).toBe('image/jpeg')
    expect(Buffer.from(r.image.data, 'base64').length).toBeLessThan(4_500_000)
  })

  it('reads at most a bounded slice of a big file — however long its lines — and never a pipe', async () => {
    await writeFile(join(proj, 'big.log'), 'x'.repeat(5_000_000))
    const big = text(await readForAssistant(join(proj, 'big.log')))
    expect(big).toMatch(/more below/)
    expect(big.length).toBeLessThan(41_000) // one 5 MB line: cut at the per-read cap, not handed over whole
    await writeFile(join(proj, 'wide.txt'), Array.from({ length: 300 }, () => 'y'.repeat(1500)).join('\n'))
    const wide = text(await readForAssistant(join(proj, 'wide.txt')))
    expect(wide.length).toBeLessThanOrEqual(41_000)
    expect(wide).toMatch(/more below — read again with offset 2\d\n?$|offset 2\d\)$/)
    const { execFileSync } = await import('child_process')
    execFileSync('mkfifo', [join(proj, 'pipe')])
    expect(text(await readForAssistant(join(proj, 'pipe')))).toBe('Not a regular file.')
  })

  it('search takes words literally (a pattern cannot freeze the server)', async () => {
    expect(text(await searchForAssistant(proj, '(a+)+' + '$'))).toBe('No match.')
    // "." is a dot here, not "any character": the file has "SHIPPING_FEE " but no "SHIPPING_FEE.".
    expect(text(await searchForAssistant(proj, 'SHIPPING_FEE.'))).toBe('No match.')
    expect(text(await searchForAssistant(proj, 'nothing|shipping_fee'))).toContain('SHIPPING_FEE = 480')
  })

  it('a glob is matched without a regular expression: the worst shape is done at once (as a RegExp it froze the server 18 s+)', async () => {
    const { globMatch } = await import('./assistantTools')
    const name = 'a'.repeat(63) + 'c'
    for (const g of ['*a*a*a*a*a*a*a*b', '*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b', '*' + 'a*'.repeat(60) + 'b']) {
      const t0 = performance.now()
      expect(globMatch(g, name)).toBe(false)
      expect(performance.now() - t0).toBeLessThan(100)
    }
    for (const [g, n, ok] of [['*.ts', 'checkout.TS', true], ['*.ts', 'checkout.tsx', false], ['check?ut.*', 'checkout.ts', true], ['*', '', true], ['a*b*c', 'axxbyyc', true], ['a*b*c', 'axxbyy', false]] as const)
      expect([g, n, globMatch(g, n)]).toEqual([g, n, ok])
  })

  it('a long line (a card\'s notes are one line of tasks.json) is read whole up to the per-read cap', async () => {
    await writeFile(join(proj, 'one-line.json'), `{"notes": "${'n'.repeat(22_000)}END"}\n{"next": 1}`)
    const t = text(await readForAssistant(join(proj, 'one-line.json')))
    expect(t).toContain('nEND')
  })

  it('search finds the line, with its file and line number', async () => {
    expect(text(await searchForAssistant(proj, 'shipping|送料', '*.ts'))).toBe(`${await import('fs/promises').then((f) => f.realpath(join(proj, 'src', 'checkout.ts')))}:1: export const SHIPPING_FEE = 480`)
  })
})


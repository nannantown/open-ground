// assistantTools — what the owner's assistant (phoneAssistant.ts) can do besides
// talking (owner request 2026-10-06: "全部調べられるアシスタントと喋るだけで全ての
// 作業を終わらせたい"). Plain async functions, so the tests drive exactly what
// the live model reaches through assistantSession.ts.
//
// READ-ONLY, AND ONLY HERE: every registered project and OPEN GROUND's own data
// dir (~/.openground). Nothing else in the home (~/.ssh, ~/.aws, other repos) —
// decided on the REAL path, so a symlink inside a project cannot lead out. Inside
// that area the secrets OPEN GROUND itself keeps (login, phone pairing, push key,
// research cookies, the Chrome profile) and the usual secret files of a project
// (.env, private keys) are refused too, and values under secret-looking keys
// (password, token, …) are hidden from anything read or searched.
//
// These are the assistant's own tools, not Claude Code's Read/Grep/Glob: a
// content search over a directory must skip the secret files, and Claude Code's
// Grep cannot be told to (a PreToolUse hook sees the call, never the matches).
//
// Nothing here changes anything: a card or a message for a commander is only
// ever proposed (assistantProposals.ts), carried out by the owner's button.
import { execFile } from 'child_process'
import { lstat, mkdtemp, open, readdir, readFile, realpath, rm, stat } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { promisify } from 'util'
import { basename, extname, isAbsolute, join, relative, sep } from 'path'
import { openGroundHome } from './paths'
import { getSettings } from './store'
const execFileP = promisify(execFile)
import { ASSISTANT_PHOTO_TYPES, type AssistantPhotoExt } from './assistantMemory'

// ── where it may read ───────────────────────────────────────────────────────

/** What it may read in OPEN GROUND's own home, by first path segment — an
 *  ALLOW-list, so a file OPEN GROUND adds later (a key, a login, a cookie jar)
 *  stays closed until someone decides otherwise. Everything else there (auth.json,
 *  phone-link.json, phone-push-key.json, research-auth.json, chrome-profile/,
 *  backups/, sessions/ …) is refused. */
const OG_READABLE = new Set([
  'assistant', // its own records: log/, memory.md, photos/, state, config
  'assistant-style.md',
  'settings.json', // values under secret-looking keys are hidden
  'projects', // each project's Board (tasks.json) and canvases
  'swarm', // the agent team's heartbeats
  'escalations.json', // questions for the owner
  'notifications.json',
  'swarm-notifications.json',
  'swarm-desks.json',
  'swarm-quota.json',
  'canvas.json',
  'daily-fuel-report.json',
])
/** A copy of a file is the file: `.x.json.tmp-12-0` (an interrupted atomic
 *  write), `x.json.bak`, `x.json.damaged-…` are judged as `x.json`. */
const original = (name: string): string => {
  for (let n = name; ; ) {
    const m = n.replace(/\.(?:tmp|damaged)-[^/]*$/i, '').replace(/\.(?:bak|orig|old|backup|swp)$/i, '').replace(/~$/, '')
    if (m === n) return n
    n = m
  }
}
/** A project's usual secret files, by name, anywhere. */
const SECRET_NAME = /^(\.env(\..+)?|\.envrc|\.dev\.vars|id_(rsa|dsa|ecdsa|ed25519).*|.*deploy_?key.*|.+\.(pem|key|p8|p12|pfx|keystore|jks|tfstate|tfstate\.backup)|\.netrc|\.npmrc|\.pypirc|\.git-credentials|credentials(\.json)?|.+\.mobileprovision)$/i
/** Template env files hold no secrets and say what a project needs. */
const SECRET_OK = /^\.env\.(example|sample|template)$/i
/** The home's own secret places — refused even when a registered project
 *  contains them (a project registered at the home folder, or above it). */
const HOME_SECRETS = ['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.azure', '.netrc', '.claude.json', join('.claude', '.credentials.json'), join('.config', 'gh'), join('.config', 'gcloud'), join('Library', 'Keychains'), join('Library', 'Cookies')]
/** Not searched (generated, huge, or a whole copy of a repo). Reading a file in one by path still works. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-web', 'dist-electron', 'build', '.next', 'coverage', 'worktrees', '.venv', 'Pods', 'DerivedData'])

const real = (p: string) => realpath(p).catch(() => null)
const inside = (p: string, root: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep)

/** The real paths it may read under: every registered project + OPEN GROUND's home. */
export const assistantReadRoots = async (): Promise<string[]> => {
  const paths = [openGroundHome(), ...((await getSettings()).projects ?? []).map((p) => p.path)]
  const home = (await real(homedir())) ?? homedir()
  // A project at or above the home folder would open the whole home (other
  // repos, shell history, Claude's transcripts): such a root is not read at all.
  return (await Promise.all(paths.map(real))).filter((p): p is string => !!p && !inside(home, p))
}

/** A secret by its real path — even inside the area it may read. */
export const isSecretPath = (p: string, ogHome: string, realHome: string): boolean => {
  const name = original(basename(p))
  if (SECRET_NAME.test(name) && !SECRET_OK.test(name)) return true
  // Compared lower-case: APFS is case-insensitive (Auth.json is auth.json).
  const lower = p.toLowerCase()
  const home = realHome.toLowerCase()
  if (HOME_SECRETS.some((s) => inside(lower, join(home, s.toLowerCase())))) return true
  if (!inside(lower, ogHome.toLowerCase())) return false
  if (lower === ogHome.toLowerCase()) return false
  const first = original(relative(ogHome.toLowerCase(), lower).split(sep)[0]).replace(/^\./, '')
  return !OG_READABLE.has(first)
}

/** A secret-looking key name: …password / …secret / …token / …cookie / …credential
 *  (anything may follow), or a name ENDING in key / keys (apiKey, e2eKey,
 *  SERVICE_ROLE_KEY, private_key), or the bare p8 / ct0 OPEN GROUND keeps.
 *
 *  ⚠ Every repeat is BOUNDED ({0,64}). The first version had `*` on both sides;
 *  run over a long line of key-like characters it backtracked quadratically —
 *  200 KB took 4.6 s, on the server's one thread, freezing every API, terminal
 *  stream and the engine (review 2026-10-06). Keep every quantifier here bounded. */
const NAME = '[A-Za-z0-9_.-]{0,64}(?:(?:password|passwd|secret|token|cookie|credential|session|authorization|bearer|extraheader|otpseed)[A-Za-z0-9_.-]{0,64}|keys?(?:value|pem|data|material|b64|base64)?|p8|ct0)'
/** `"name": "` — the value after it is found by a plain scan, not by the regex. */
const JSON_KEY = new RegExp(`"${NAME}"\\s{0,8}:\\s{0,8}"`, 'gi')
/** `NAME=value` / `NAME: value` at the start of a line (env, YAML, `const API_KEY = …`). */
const LINE_KEY = new RegExp(`^(\\s{0,64}(?:(?:export|const|let|var|readonly)\\s{1,8}){0,2}${NAME}\\s{0,8}[:=]\\s{0,8})\\S`, 'i')
/** user:password@ in a URL (a git remote with a token in it). */
const URL_SECRET = /(\/\/[^/\s:@]{1,128}:)[^/\s@]{1,512}@/g
/** Well-known token shapes wherever they stand (Anthropic / OpenAI / GitHub / GitLab / AWS / Slack / Stripe / Google / JWT), and what follows Basic / Bearer. */
const RAW_TOKEN = /\b(?:sk-ant-[A-Za-z0-9_-]{8,256}|sk-[A-Za-z0-9_-]{20,256}|gh[pousr]_[A-Za-z0-9]{20,256}|github_pat_[A-Za-z0-9_]{20,256}|AKIA[0-9A-Z]{16}|xox[abposr]-[A-Za-z0-9-]{10,256}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,256}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20,256}|(?<=\b(?:[Bb]asic|[Bb]earer|BASIC|BEARER) )(?![a-z-]{1,1024}\b)[A-Za-z0-9+/=._~-]{8,1024})/g
/** A JWT (`eyJ….eyJ….…`), found WITHOUT a backtracking regex: as one, a crafted
 *  512 KB of `eyJ-` took 0.7 s (review 2026-10-06). A run of token characters
 *  (each character is taken once) is split at its dots and three neighbouring
 *  parts are checked, each by an anchored one-class pattern. */
const TOKEN_RUN = /[A-Za-z0-9_.-]{27,}/g
const JWT_PART = /^eyJ[A-Za-z0-9_-]{8,}$/
const JWT_SIG = /^[A-Za-z0-9_-]{8,}$/
const hideJwt = (run: string): string => {
  const p = run.split('.')
  for (let i = 0; i + 2 < p.length; i++) if (JWT_PART.test(p[i]) && JWT_PART.test(p[i + 1]) && JWT_SIG.test(p[i + 2])) return '[hidden]'
  return run
}
const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]{0,40}KEY(?: BLOCK)?-----/
const PEM_END = /-----END [A-Z0-9 ]{0,40}KEY(?: BLOCK)?-----/

/** One line: JSON values under secret keys, then a NAME=value line, then URL passwords. */
const hideLine = (line: string): string => {
  let out = ''
  let at = 0
  JSON_KEY.lastIndex = 0
  for (let m = JSON_KEY.exec(line); m; m = JSON_KEY.exec(line)) {
    const from = m.index + m[0].length
    let end = from
    while (end < line.length && line[end] !== '"') end += line[end] === '\\' ? 2 : 1
    out += line.slice(at, from) + '[hidden]'
    // An unterminated value: hidden to the end of the line.
    at = Math.min(end, line.length)
    if (end >= line.length) break
    JSON_KEY.lastIndex = end + 1
  }
  out += line.slice(at)
  const k = LINE_KEY.exec(out)
  if (k) out = k[1] + '[hidden]'
  return out.replace(URL_SECRET, '$1[hidden]@').replace(RAW_TOKEN, '[hidden]').replace(TOKEN_RUN, hideJwt)
}

/** Values under secret-looking keys (JSON / env / YAML), the password in a
 *  user:password@ URL, and private-key PEM blocks (raw or \n-escaped in JSON)
 *  become [hidden]. Linear in the text: no unbounded repeat anywhere. */
export const hideSecrets = (text: string): string => {
  let inPem = false
  return text
    .split('\n')
    .map((line) => {
      if (inPem) {
        if (PEM_END.test(line)) inPem = false
        return '[hidden]'
      }
      const b = line.search(PEM_BEGIN)
      if (b >= 0) {
        const rest = line.slice(b)
        const e = rest.search(PEM_END)
        // The whole block on one line (escaped in JSON): just that part goes.
        if (e >= 0) return hideLine(line.slice(0, b)) + '[hidden]' + hideLine(rest.slice(rest.indexOf('-----', e + 5) + 5))
        inPem = true
        return hideLine(line.slice(0, b)) + '[hidden]'
      }
      return hideLine(line)
    })
    .join('\n')
}

/** Real paths, so they compare with a real path (/var is /private/var on the Mac). */
export type Resolved = { ok: true; path: string; ogHome: string; home: string } | { ok: false; why: string }

/** The real path behind `p` when the assistant may read it; why not otherwise. */
export const resolveReadable = async (p: string): Promise<Resolved> => {
  const given = p.trim().replace(/^~(?=$|\/)/, homedir())
  if (!isAbsolute(given)) return { ok: false, why: 'Give an absolute path (from "Where things live").' }
  const path = await real(given)
  if (!path) return { ok: false, why: `Not found: ${given}` }
  const ogHome = (await real(openGroundHome())) ?? openGroundHome()
  const home = (await real(homedir())) ?? homedir()
  if (!(await assistantReadRoots()).some((r) => inside(path, r)))
    return { ok: false, why: 'Outside what you may read (the registered projects and OPEN GROUND data only). Tell the owner you cannot look there.' }
  if (isSecretPath(path, ogHome, home)) return { ok: false, why: 'That holds secrets (keys, passwords, logins). It is never read.' }
  return { ok: true, path, ogHome, home }
}

// ── reading ─────────────────────────────────────────────────────────────────

const READ_LINES = 400
const READ_BYTES = 200_000
const IMAGE_BYTES = 5 * 1024 * 1024
const IMAGE_EXT: Record<string, AssistantPhotoExt> = { '.png': 'png', '.jpg': 'jpg', '.jpeg': 'jpg', '.gif': 'gif', '.webp': 'webp' }

export type ToolResult = { text: string } | { image: { data: string; mimeType: string } }

export const readForAssistant = async (p: string, offset = 1, limit = READ_LINES): Promise<ToolResult> => {
  const r = await resolveReadable(p)
  if (!r.ok) return { text: r.why }
  const st = await stat(r.path)
  if (st.isDirectory()) return listForAssistant(r.path)
  // Not a pipe or a device: reading one could hang for good.
  if (!st.isFile()) return { text: 'Not a regular file.' }
  const img = IMAGE_EXT[extname(r.path).toLowerCase()]
  if (img) {
    if (st.size > IMAGE_BYTES) return { text: 'That image is too large to look at.' }
    return { image: (await smaller(r.path, st.size)) ?? { data: (await readFile(r.path)).toString('base64'), mimeType: ASSISTANT_PHOTO_TYPES[img] } }
  }
  // At most READ_BYTES are read, however large the file.
  const fh = await open(r.path, 'r')
  const buf = Buffer.alloc(Math.min(st.size, READ_BYTES))
  try {
    await fh.read(buf, 0, buf.length, 0)
  } finally {
    await fh.close()
  }
  if (buf.subarray(0, 8000).includes(0)) return { text: `A binary file (${st.size} bytes) — not text.` }
  // Hidden before the line numbers go on (the line rule anchors at the line start).
  const lines = hideSecrets(buf.toString('utf8')).split('\n')
  const from = Math.max(1, Math.floor(offset))
  const shown = lines.slice(from - 1, from - 1 + Math.min(Math.max(1, Math.floor(limit)), READ_LINES))
  // At most READ_TEXT characters back per read (a minified one-line file is not
  // held by the line count) — a few big reads would otherwise fill the session.
  let text = ''
  let n = 0
  for (const l of shown) {
    const s = `${from + n}\t${l.length > LINE_CHARS ? l.slice(0, LINE_CHARS) + '…' : l}\n`
    if (n && text.length + s.length > READ_TEXT) break
    text += s
    n++
  }
  const more = from - 1 + n < lines.length || st.size > READ_BYTES
  return { text: text.slice(0, -1) + (more ? `\n(more below — read again with offset ${from + n})` : '') }
}

const READ_TEXT = 40_000
const LINE_CHARS = 40_000
/** Photos are resent with every later line of the live session (one request is
 *  at most 32 MB), and the model sees at most ~2576 px on the long edge anyway:
 *  a big one goes as a JPEG of at most 2000 px. macOS `sips`; elsewhere, or if
 *  it fails, the original goes (≤ IMAGE_BYTES, under the API's 10 MB base64 per image). */
const SHRINK_OVER = 1_000_000
const smaller = async (path: string, size: number): Promise<{ data: string; mimeType: string } | null> => {
  if (size <= SHRINK_OVER || process.platform !== 'darwin') return null
  const dir = await mkdtemp(join(tmpdir(), 'og-assistant-img-'))
  try {
    const out = join(dir, 'small.jpg')
    await execFileP('/usr/bin/sips', ['-Z', '2000', '-s', 'format', 'jpeg', path, '--out', out], { timeout: 10_000 })
    return { data: (await readFile(out)).toString('base64'), mimeType: 'image/jpeg' }
  } catch {
    return null
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

const LIST_MAX = 300
export const listForAssistant = async (p: string): Promise<ToolResult> => {
  const r = await resolveReadable(p)
  if (!r.ok) return { text: r.why }
  const ents = await readdir(r.path, { withFileTypes: true })
  const names = ents
    .filter((e) => !isSecretPath(join(r.path, e.name), r.ogHome, r.home))
    .map((e) => e.name + (e.isDirectory() ? '/' : ''))
    .sort()
  return { text: `${r.path}\n` + (names.slice(0, LIST_MAX).join('\n') || '(empty)') + (names.length > LIST_MAX ? `\n(+${names.length - LIST_MAX} more)` : '') }
}

const SEARCH_HITS = 60
const SEARCH_FILES = 5000
const SEARCH_FILE_BYTES = 512_000
const SEARCH_MS = 4000
/** `*` / `?` wildcards, case-insensitive — WITHOUT a regular expression: the
 *  model writes the glob, and as a RegExp `*a*a*a*a*a*a*a*b` took 18 s on one
 *  64-character name with the server's one thread blocked (review 2026-10-06).
 *  The two-pointer match backtracks only to the last `*`: O(name × glob). */
export const globMatch = (glob: string, name: string): boolean => {
  const g = glob.toLowerCase()
  const s = name.toLowerCase()
  let i = 0
  let j = 0
  let star = -1
  let from = 0
  while (j < s.length) {
    if (i < g.length && (g[i] === '?' || g[i] === s[j])) {
      i++
      j++
    } else if (i < g.length && g[i] === '*') {
      star = i++
      from = j
    } else if (star >= 0) {
      i = star + 1
      j = ++from
    } else return false
  }
  while (i < g.length && g[i] === '*') i++
  return i === g.length
}

/** Lines holding `pattern` — words taken literally, case-insensitive, `a|b` for
 *  either (no regular expressions: one the model writes could freeze the
 *  server) — in the files under `p`, never following a symlink, never in a
 *  secret file, never in SKIP_DIRS. */
export const searchForAssistant = async (p: string, pattern: string, glob?: string): Promise<ToolResult> => {
  const r = await resolveReadable(p)
  if (!r.ok) return { text: r.why }
  const words = pattern.toLowerCase().split('|').map((w) => w.trim()).filter(Boolean)
  if (!words.length) return { text: 'Give words to search for.' }
  const holds = (l: string) => {
    const low = l.toLowerCase()
    return words.some((w) => low.includes(w))
  }
  const only = glob ? (name: string) => globMatch(glob, name) : null
  const hits: string[] = []
  const until = Date.now() + SEARCH_MS
  let files = 0
  const visit = async (path: string): Promise<void> => {
    if (hits.length >= SEARCH_HITS || files >= SEARCH_FILES || Date.now() > until) return
    if (isSecretPath(path, r.ogHome, r.home)) return
    const st = await lstat(path).catch(() => null)
    if (!st || st.isSymbolicLink()) return
    if (st.isDirectory()) {
      if (path !== r.path && SKIP_DIRS.has(basename(path))) return
      for (const e of (await readdir(path).catch(() => [] as string[])).sort()) await visit(join(path, e))
      return
    }
    if (!st.isFile() || st.size > SEARCH_FILE_BYTES || (only && !only(basename(path)))) return
    files++
    const buf = await readFile(path).catch(() => null)
    if (!buf || buf.subarray(0, 8000).includes(0)) return
    // Matched on the hidden text: a match on a secret value would tell it, a guess at a time.
    const lines = hideSecrets(buf.toString('utf8')).split('\n')
    for (let i = 0; i < lines.length && hits.length < SEARCH_HITS; i++)
      if (holds(lines[i])) hits.push(`${path}:${i + 1}: ${lines[i].trim().slice(0, 200)}`)
  }
  await visit(r.path)
  const cut = hits.length >= SEARCH_HITS || files >= SEARCH_FILES || Date.now() > until
  return { text: (hits.join('\n') || 'No match.') + (cut ? '\n(stopped early — search a narrower folder for more)' : '') }
}

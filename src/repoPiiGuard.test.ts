import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Repo-wide PII guard — 実個人情報(実在プロバイダのメール・実名トークン・
// 実ホームパスのユーザー名)が tracked ファイルへ再導入されたら fail する
// 回帰ガード。2026-07 の個人情報スクラブ(公開 repo への漏出対応)の再発防止。
//
// 設計原則: ガード自体が新たな漏出源にならないこと。
//  - 実名系トークンは平文でなく sha256 で照合する(このファイルに実名を書かない)。
//  - 違反レポートは値をマスクし、file:line で特定させる。
//
// fixture の作法(fail したらこう直す):
//  - メールは user@example.com / alice@example.org など example.* を使う。
//  - ホームパスは /Users/me/… /Users/dev/… /home/u/… 等のプレースホルダを使う。
//    新しい中立名を使うときは HOME_SEG_ALLOW に足す(実名は足さない)。

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

// 過去に漏出した実個人情報トークン(小文字)の sha256。平文はここに書かない。
const BANNED_TOKEN_HASHES = new Set([
  '783fa80732e55de75d9109e66201a9c2d32a994742dfea62dd18e39e7c698a8b',
  'bd0f92ebb04349a4dd6915aa128f2e80903163c883892a952c2ffeba4f722fc5',
  '707c403908e826807640df1bea0ad7674d40b25de50c190bd8aeb5ef00d08055',
  '8ef025eed5bb647be9e8d4245eec9b0d290cbe3ac91a4e9f66210aeb876de4ac',
  '36d4662b3a68b360a5456cd5c0a2381d431aa9688d07fde6f2366a3571599814',
])

// 署名者名の歴史記録だけトークン照合を免除する。Developer ID 署名済み配布物の
// codesign 情報として誰でも取得できる公開情報で、docs/DISTRIBUTION_AUDIT.md
// §1.2/§2.4 が「意図的に残す」と判断済みのもの。メール/ホームパス検査は免除しない。
const TOKEN_EXEMPT_FILES = new Set([
  'docs/DISTRIBUTION_AUDIT.md',
  'spike/electron-skeleton/SPIKE.md',
  'spike/electron-skeleton/package.json',
])

// 実在メールプロバイダ宛のアドレスは fixture に使わない(example.* を使う)。
const REAL_PROVIDER_EMAIL =
  /[a-z0-9._%+-]+@(?:icloud|gmail|googlemail|yahoo|hotmail|outlook|protonmail|proton|aol|docomo|ezweb|softbank)\.(?:com|co\.jp|ne\.jp|jp|net|org|me|ch)/i

// ホームパスのユーザー名セグメントはこの中立プレースホルダのみ許可。
const HOME_SEG_ALLOW = new Set([
  'me',
  'you',
  'x',
  'k',
  'u',
  'dev',
  'test',
  'tester',
  'someone',
  'alice',
  'bob',
  'foo',
  'bar',
  'user',
  'name',
  'runner',
  'yourname',
])
// 先頭ドットのセグメント(/home/.openground 等の隠し dir fixture)はユーザー名でない
// ためマッチさせない — ユーザー名は英数/アンダースコア始まりが前提。
const HOME_PATH = /\/(?:Users|home)\/([A-Za-z0-9_][A-Za-z0-9_.-]*)/g
// claude セッションキーの符号化形(-Users-<seg>-…)も同じ扱い(youCorpus 等の fixture)。
const HOME_PATH_ENCODED = /-(?:Users|home)-([A-Za-z0-9_][A-Za-z0-9_.]*)/g

// バイナリと巨大ファイルは走査対象外(テキスト前提の検査)。
const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|ico|icns|woff2?|ttf|otf|eot|p12|zip|dmg|exe|bin|node|wasm|pdf|mp[34]|mov|asar)$/i
const MAX_BYTES = 5 * 1024 * 1024

interface Violation {
  file: string
  line: number
  kind: string
  hint: string
}

const mask = (s: string) =>
  s.length <= 1 ? '*' : `${s[0]}${'*'.repeat(Math.min(s.length - 1, 8))}`

interface ScanResult {
  emails: Violation[]
  homes: Violation[]
  tokens: Violation[]
  scanned: number
}

const scanRepo = (): ScanResult => {
  const out: ScanResult = { emails: [], homes: [], tokens: [], scanned: 0 }
  const files = execFileSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    maxBuffer: 64 * 1024 * 1024,
  })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
  const tokenVerdict = new Map<string, boolean>() // token → banned? (sha256 は unique token ごとに1回)
  for (const rel of files) {
    if (BINARY_EXT.test(rel)) continue
    const buf = readFileSync(join(ROOT, rel))
    if (buf.length > MAX_BYTES || buf.includes(0)) continue
    out.scanned++
    const exemptTokens = TOKEN_EXEMPT_FILES.has(rel)
    buf
      .toString('utf8')
      .split('\n')
      .forEach((line, i) => {
        const email = line.match(REAL_PROVIDER_EMAIL)
        if (email)
          out.emails.push({
            file: rel,
            line: i + 1,
            kind: 'real-provider email (use example.*)',
            hint: mask(email[0]),
          })
        for (const re of [HOME_PATH, HOME_PATH_ENCODED]) {
          for (const m of Array.from(line.matchAll(re))) {
            if (!HOME_SEG_ALLOW.has(m[1]))
              out.homes.push({
                file: rel,
                line: i + 1,
                kind: 'home-path user segment (use a placeholder from HOME_SEG_ALLOW)',
                hint: mask(m[1]),
              })
          }
        }
        if (!exemptTokens) {
          for (const tok of line.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []) {
            let banned = tokenVerdict.get(tok)
            if (banned === undefined) {
              banned = BANNED_TOKEN_HASHES.has(sha256(tok))
              tokenVerdict.set(tok, banned)
            }
            if (banned)
              out.tokens.push({
                file: rel,
                line: i + 1,
                kind: 'banned personal token (sha256 match)',
                hint: mask(tok),
              })
          }
        }
      })
  }
  return out
}

const fmt = (head: string, v: Violation[]) =>
  `${head}\n${v.map((x) => `  ${x.file}:${x.line} — ${x.kind} [${x.hint}]`).join('\n')}`

describe('repo PII guard (personal-info scrub regression)', () => {
  let result: ScanResult
  beforeAll(() => {
    result = scanRepo()
  }, 30_000)

  it('scans a sane number of tracked files (guard is not silently skipping)', () => {
    // tracked テキストファイルがゼロ/激減 = 走査自体が壊れている(fail-closed)。
    expect(result.scanned).toBeGreaterThan(300)
  })

  it('contains no real-provider email addresses (fixtures must use example.*)', () => {
    expect(result.emails, fmt('real-provider emails found:', result.emails)).toEqual([])
  })

  it('contains no non-placeholder home-path user segments', () => {
    expect(result.homes, fmt('non-placeholder home paths found:', result.homes)).toEqual([])
  })

  it('contains no banned personal tokens (hash-matched)', () => {
    expect(result.tokens, fmt('banned tokens found:', result.tokens)).toEqual([])
  })
})

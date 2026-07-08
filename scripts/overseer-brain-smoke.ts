/**
 * overseer-brain-smoke.ts — REAL-MACHINE smoke of the overseer brain's egress
 * close (macOS): spawns ONE real `claude` PTY through makeOverseerBrain — i.e.
 * sandboxed with network:'loopback' + the allowlist egress proxy (HTTPS_PROXY)
 * — and asserts a verdict comes back. This is the live counterpart of
 * scripts/sandbox-probe.ts's BRAIN battery (which proves the kernel denies) and
 * of the hermetic C-core E2E (which stubs the PTY): it proves the confined
 * claude still REACHES Anthropic through the one allowed hole and answers.
 *
 *   npx tsx scripts/overseer-brain-smoke.ts
 *
 * COSTS ONE SUBSCRIPTION CALL (haiku tier, one short verdict) — run manually,
 * never in CI. Uses a FAKE corpus written to a temp dir; the real you-corpus is
 * never read. Requires a logged-in `claude` on PATH.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { answerAsOwner, makeOverseerBrain, brainSandboxAvailable } from '../src/lib/server/swarmOverseerBrain'

if (process.platform !== 'darwin') {
  console.error('overseer-brain-smoke: macOS only (the egress close is darwin-only); skipping.')
  process.exit(0)
}
if (!brainSandboxAvailable()) {
  console.error('overseer-brain-smoke: /usr/bin/sandbox-exec missing — nothing to smoke.')
  process.exit(2)
}

const dir = mkdtempSync(join(tmpdir(), 'og-brain-smoke-'))
const corpusPath = join(dir, 'fake-corpus.md')
writeFileSync(
  corpusPath,
  [
    '# コウキの判断軸(スモーク用フェイクコーパス — 本物の you-corpus は使わない)',
    '',
    '## UI・デザイン',
    '- UI は常にミニマル。装飾・グラデーション・派手なエフェクトは足さない。',
    '- 迷ったら「削る」。要素を増やす提案には基本 No。',
    '',
    '## 進め方',
    '- 破壊的・不可逆な操作(公開 / 課金 / 削除 / デプロイ)は必ず本人に確認する。',
    '',
  ].join('\n'),
)

const main = async (): Promise<void> => {
  const t0 = Date.now()
  const answer = await answerAsOwner(
    {
      question:
        '新しいボタンをカラフルなグラデーションで装飾すべきですか、それともミニマルに保つべきですか？',
      context: 'UI 実装中の worker がスタイル判断で blocked(実機スモーク)。',
      projectPath: process.cwd(),
    },
    {
      // The REAL runner — default seams: brainSandboxAvailable() → sandbox ON,
      // ensureBrainEgressProxy() → the real allowlist proxy. haiku = cheap.
      runBrain: makeOverseerBrain({ model: 'haiku', timeoutMs: 240_000 }),
      corpusPath,
    },
  )
  console.log(`elapsed: ${Math.round((Date.now() - t0) / 1000)}s`)
  console.log('verdict: ' + JSON.stringify(answer, null, 2))
  rmSync(dir, { recursive: true, force: true })
  // Success = the brain ANSWERED (the fake corpus clearly grounds "minimal").
  // An `escalate: proxy brain failed / no parseable verdict` means the sandbox
  // or the proxy broke the launch.
  process.exit(answer.kind === 'answer' ? 0 : 1)
}

main().catch((e) => {
  rmSync(dir, { recursive: true, force: true })
  console.error('overseer-brain-smoke: unexpected error', e)
  process.exit(2)
})

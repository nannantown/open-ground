import { describe, it, expect, vi, afterEach } from 'vitest'
import { jobLostToRestart, readBootSignature } from '@/lib/canvasAiRestart'

// These guard the seam that lets the Canvas AI poll loop tell a NORMAL swept
// 404 (job completed, result already persisted — finish silently) from a 404
// caused by a FULL server restart that wiped the in-memory job registry mid-run
// (the result was never produced — surface "interrupted" so it isn't silent).
// Pure logic + a mocked fetch: no filesystem, so the shared `~/.openground`
// home is never touched (setup-home still isolates HOME for the whole run).

describe('jobLostToRestart — restart-loss vs normal-sweep', () => {
  it('flags a restart when the boot signature CHANGED across the 404 (launched app)', () => {
    // bootId flipped AND the frozen boot timestamp moved — a new process.
    expect(
      jobLostToRestart(
        'boot-1|2026-01-01T00:00:00.000Z',
        'boot-2|2026-01-01T00:05:00.000Z',
      ),
    ).toBe(true)
  })

  it('does NOT flag a restart when the signature is UNCHANGED (normal sweep)', () => {
    // Same live process: the job just aged out of the registry after completing.
    const sig = 'boot-1|2026-01-01T00:00:00.000Z'
    expect(jobLostToRestart(sig, sig)).toBe(false)
  })

  it('flags a restart for a hand-launched dev server (bootId null, startedAt moved)', () => {
    // bootId is null in dev, but `startedAt` still changes on a fresh process,
    // so a real kill+respawn is caught where a bootId-only check would miss it.
    expect(
      jobLostToRestart('|2026-01-01T00:00:00.000Z', '|2026-01-01T00:09:00.000Z'),
    ).toBe(true)
  })

  it('does NOT flag a restart for a stable dev server (null bootId, same startedAt)', () => {
    expect(jobLostToRestart('|2026-01-01T00:00:00.000Z', '|2026-01-01T00:00:00.000Z')).toBe(
      false,
    )
  })

  it('does NOT false-alarm when the post-404 read failed (current is null)', () => {
    // Server momentarily unreachable right after the 404 — can't prove a restart.
    expect(jobLostToRestart('boot-1|2026-01-01T00:00:00.000Z', null)).toBe(false)
  })

  it('does NOT false-alarm when no baseline was captured (baseline is null)', () => {
    // The very first poll 404'd before the baseline fetch resolved.
    expect(jobLostToRestart(null, 'boot-2|2026-01-01T00:05:00.000Z')).toBe(false)
  })

  it('does NOT false-alarm when both reads failed (both null)', () => {
    expect(jobLostToRestart(null, null)).toBe(false)
  })
})

describe('readBootSignature — fingerprint from /api/health', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const ok = (body: unknown) =>
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(body),
    } as unknown as Response)

  it('combines bootId and startedAt into one signature', async () => {
    vi.stubGlobal(
      'fetch',
      ok({
        app: 'openground',
        projectDir: '/tmp',
        bootId: 'boot-abc',
        port: 47776,
        startedAt: '2026-01-01T00:00:00.000Z',
        version: '0.11.8',
      }),
    )
    expect(await readBootSignature()).toBe('boot-abc|2026-01-01T00:00:00.000Z')
  })

  it('still produces a signature when bootId is null (dev server)', async () => {
    vi.stubGlobal(
      'fetch',
      ok({
        app: 'openground',
        projectDir: '/tmp',
        bootId: null,
        port: 47776,
        startedAt: '2026-01-01T00:00:00.000Z',
        version: '0.11.8',
      }),
    )
    // No bootId, but startedAt alone still fingerprints the process.
    expect(await readBootSignature()).toBe('|2026-01-01T00:00:00.000Z')
  })

  it('returns null on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve({}) } as unknown as Response),
    )
    expect(await readBootSignature()).toBeNull()
  })

  it('returns null when fetch throws (offline / mid-restart)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    expect(await readBootSignature()).toBeNull()
  })

  it('returns null when the body is not a valid health payload', async () => {
    // Something else listening on the port, or a malformed answer.
    vi.stubGlobal('fetch', ok({ app: 'someone-else', startedAt: 5 }))
    expect(await readBootSignature()).toBeNull()
  })
})

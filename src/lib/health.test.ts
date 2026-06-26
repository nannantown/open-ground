import { describe, it, expect } from 'vitest'
import { HealthSchema } from '@/lib/healthSchema'

// HealthSchema is the contract the launcher relies on to distinguish "our
// server" from "something else listening on :47776." These tests pin down
// the shape so a sloppy refactor of /api/health can't silently break the
// launcher's identity probe.

describe('HealthSchema — shape', () => {
  it('accepts a fully-populated valid payload', () => {
    const r = HealthSchema.safeParse({
      app: 'openground',
      projectDir: '/Users/me/projects/OPEN GROUND',
      bootId: 'boot-abc123',
      port: 47776,
      startedAt: '2026-05-29T12:00:00.000Z',
      version: '0.11.8',
    })
    expect(r.success).toBe(true)
  })

  it('rejects a payload where app is not the literal "openground"', () => {
    // The whole point of HealthSchema is that anyone-else's server on
    // :47776 must fail this check — if app drifts (typo, fork rename),
    // the launcher MUST reject it rather than reuse a foreign process.
    const r = HealthSchema.safeParse({
      app: 'pmmap',
      projectDir: '/tmp',
      bootId: null,
      port: 47776,
      startedAt: '2026-05-29T12:00:00.000Z',
      version: '0.11.8',
    })
    expect(r.success).toBe(false)
  })

  it('accepts a payload where bootId is null (hand-launched dev server)', () => {
    // Manual `npm run dev` runs without the launcher setting OPENGROUND_BOOT_ID;
    // the route returns null in that case and the schema must accept it.
    const r = HealthSchema.safeParse({
      app: 'openground',
      projectDir: '/Users/me/projects/OPEN GROUND',
      bootId: null,
      port: 47776,
      startedAt: '2026-05-29T12:00:00.000Z',
      version: '0.11.8',
    })
    expect(r.success).toBe(true)
  })

  it('requires projectDir to be a string', () => {
    const r = HealthSchema.safeParse({
      app: 'openground',
      projectDir: 12345,
      bootId: null,
      port: 47776,
      startedAt: '2026-05-29T12:00:00.000Z',
      version: '0.11.8',
    })
    expect(r.success).toBe(false)
  })

  it('requires projectDir to be present', () => {
    const r = HealthSchema.safeParse({
      app: 'openground',
      // projectDir omitted
      bootId: null,
      port: 47776,
      startedAt: '2026-05-29T12:00:00.000Z',
      version: '0.11.8',
    })
    expect(r.success).toBe(false)
  })

  it('accepts port as null (pre-bind / unknown)', () => {
    const r = HealthSchema.safeParse({
      app: 'openground',
      projectDir: '/tmp',
      bootId: 'boot-1',
      port: null,
      startedAt: '2026-05-29T12:00:00.000Z',
      version: '0.11.8',
    })
    expect(r.success).toBe(true)
  })

  it('requires version to be present (the UI always shows a build number)', () => {
    // version is what lets a user confirm an update took effect; the schema must
    // reject a payload missing it so a regression can't silently drop the field.
    const r = HealthSchema.safeParse({
      app: 'openground',
      projectDir: '/tmp',
      bootId: 'boot-1',
      port: 47776,
      startedAt: '2026-05-29T12:00:00.000Z',
      // version omitted
    })
    expect(r.success).toBe(false)
  })
})

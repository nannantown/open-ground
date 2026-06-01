import { describe, it, expect } from 'vitest'
import { parseMilestonesPlan } from './milestonesPlan'

describe('parseMilestonesPlan', () => {
  it('returns null for empty input', () => {
    expect(parseMilestonesPlan('')).toBeNull()
  })

  it('returns null when the marker is missing', () => {
    expect(parseMilestonesPlan('just some claude prose\nno marker here')).toBeNull()
  })

  it('parses a single-line marker with one milestone', () => {
    const log = `Some narrative text from Claude
OPENGROUND_MILESTONES_PLAN: {"milestones":[{"name":"do thing","verifyCommands":["test -f x"],"order":0}]}`
    const out = parseMilestonesPlan(log)
    expect(out).toEqual([
      { name: 'do thing', verifyCommands: ['test -f x'], order: 0 },
    ])
  })

  it('parses multiple milestones in order', () => {
    const log = `OPENGROUND_MILESTONES_PLAN: {"milestones":[{"name":"a","order":0},{"name":"b","order":1},{"name":"c","order":2}]}`
    const out = parseMilestonesPlan(log)
    expect(out?.map(m => m.name)).toEqual(['a', 'b', 'c'])
    expect(out?.map(m => m.order)).toEqual([0, 1, 2])
  })

  it('picks the LAST marker when Claude emits multiple', () => {
    const log = `OPENGROUND_MILESTONES_PLAN: {"milestones":[{"name":"old"}]}
more text
OPENGROUND_MILESTONES_PLAN: {"milestones":[{"name":"new"}]}`
    expect(parseMilestonesPlan(log)?.[0]?.name).toBe('new')
  })

  it('drops items missing a name', () => {
    const log = `OPENGROUND_MILESTONES_PLAN: {"milestones":[{"name":"keep"},{"description":"no name"},{"name":"   "},{"name":"also keep"}]}`
    const out = parseMilestonesPlan(log)
    expect(out?.map(m => m.name)).toEqual(['keep', 'also keep'])
  })

  it('filters non-string entries from verifyCommands', () => {
    const log = `OPENGROUND_MILESTONES_PLAN: {"milestones":[{"name":"x","verifyCommands":["good", null, 42, "   ", "also good"]}]}`
    const out = parseMilestonesPlan(log)
    expect(out?.[0]?.verifyCommands).toEqual(['good', 'also good'])
  })

  it('returns null on invalid JSON after the marker', () => {
    const log = `OPENGROUND_MILESTONES_PLAN: {not valid json`
    expect(parseMilestonesPlan(log)).toBeNull()
  })

  it('returns null when the JSON does not contain a milestones array', () => {
    const log = `OPENGROUND_MILESTONES_PLAN: {"foo":"bar"}`
    expect(parseMilestonesPlan(log)).toBeNull()
  })

  it('returns null when milestones is empty after filtering', () => {
    const log = `OPENGROUND_MILESTONES_PLAN: {"milestones":[{"description":"orphan"}]}`
    expect(parseMilestonesPlan(log)).toBeNull()
  })

  it('strips leading/trailing whitespace from names', () => {
    const log = `OPENGROUND_MILESTONES_PLAN: {"milestones":[{"name":"  spaced  "}]}`
    expect(parseMilestonesPlan(log)?.[0]?.name).toBe('spaced')
  })

  it('preserves description when present', () => {
    const log = `OPENGROUND_MILESTONES_PLAN: {"milestones":[{"name":"x","description":"why"}]}`
    expect(parseMilestonesPlan(log)?.[0]?.description).toBe('why')
  })

  it('omits description / verifyCommands / order when absent', () => {
    const log = `OPENGROUND_MILESTONES_PLAN: {"milestones":[{"name":"x"}]}`
    const item = parseMilestonesPlan(log)?.[0]
    expect(item).toEqual({ name: 'x' })
    expect(item).not.toHaveProperty('description')
    expect(item).not.toHaveProperty('order')
  })
})

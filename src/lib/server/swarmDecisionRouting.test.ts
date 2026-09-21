import { describe, expect, it } from 'vitest'
import { DECISION_ROUTING_RULES, PERMANENT_OWNER_BOUNDARIES } from './swarmDecisionRouting'
import { WORKER_ORDER_RULES } from './swarmWorker'

describe('explicit approval boundaries', () => {
  it('carries every approval boundary into the actual worker instructions', () => {
    for (const boundary of PERMANENT_OWNER_BOUNDARIES) expect(WORKER_ORDER_RULES).toContain(boundary)
    expect(WORKER_ORDER_RULES).toContain(DECISION_ROUTING_RULES)
    expect(DECISION_ROUTING_RULES).not.toMatch(/[\n\r\t]/)
    expect(DECISION_ROUTING_RULES).toContain('Obtain explicit owner approval')
  })
})

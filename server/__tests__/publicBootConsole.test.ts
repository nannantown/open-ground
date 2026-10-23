import { describe, expect, it } from 'vitest'
import { unexpectedBootConsoleErrors } from '../../e2e/fixtures/publicBootConsole'

const owner = 'http://127.0.0.1:47876/api/phone-link/assistant/log'
const refusal = 'Failed to load resource: the server responded with a status of 403 (Forbidden)'

describe('public boot console boundary', () => {
  it('recognizes only the exact previously verified owner-log refusal', () => {
    expect(unexpectedBootConsoleErrors([{ text: refusal, url: owner }], owner)).toEqual([])
  })
  it.each([
    { text: refusal, url: 'http://127.0.0.1:47876/api/projects' },
    { text: refusal, url: 'https://example.test/api/phone-link/assistant/log' },
    { text: refusal, url: '' },
    { text: 'Failed to load resource: the server responded with a status of 500 (Internal Server Error)', url: owner },
    { text: 'Unexpected JavaScript error', url: owner },
  ])('retains unexpected failure %j', (error) => {
    expect(unexpectedBootConsoleErrors([error], owner)).toEqual([error])
  })
  it('retains an additional failure even beside the expected refusal', () => {
    const failure = { text: refusal, url: 'http://127.0.0.1:47876/api/settings' }
    expect(unexpectedBootConsoleErrors([{ text: refusal, url: owner }, failure], owner)).toEqual([failure])
  })
})

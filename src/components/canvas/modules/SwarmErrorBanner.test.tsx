// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { SwarmErrorBanner } from './SwarmErrorBanner'

afterEach(cleanup)

describe('SwarmErrorBanner — neither failure may hide the other', () => {
  it('shows BOTH when both are set (the masking bug)', () => {
    // The defect: `error ?? supplyError` rendered only the first non-null, so a
    // stale worker failure silently swallowed every supply failure after it.
    render(<SwarmErrorBanner error="worker restart failed" supplyError="supply launch failed" />)
    expect(screen.getByText('worker restart failed')).toBeTruthy()
    expect(screen.getByText('supply launch failed')).toBeTruthy()
  })

  it('shows either one alone', () => {
    const { unmount } = render(<SwarmErrorBanner error={null} supplyError="supply launch failed" />)
    expect(screen.getByText('supply launch failed')).toBeTruthy()
    unmount()
    render(<SwarmErrorBanner error="worker restart failed" supplyError={null} />)
    expect(screen.getByText('worker restart failed')).toBeTruthy()
  })

  it('renders NOTHING when there is no failure — an empty bar is not a message', () => {
    const { container } = render(<SwarmErrorBanner error={null} supplyError={null} />)
    expect(container.firstChild).toBeNull()
  })
})

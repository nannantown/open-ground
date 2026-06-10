// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/react'

// Mock the i18n hook (identity translator) and the api-client (so importing the
// modal never constructs a real network client). We only exercise the local
// validation/keyboard behaviour, which needs no server.
vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (k: string) => k }) }))
vi.mock('@/lib/api-client', () => ({ api: { api: {} } }))

import { NewProjectModal } from './NewProjectModal'

const noop = () => {}

describe('NewProjectModal', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <NewProjectModal open={false} defaultWorkspace={null} onClose={noop} onCreated={noop} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('disables Create until a non-blank name is entered', () => {
    render(
      <NewProjectModal open defaultWorkspace="/tmp/ws" onClose={noop} onCreated={noop} />,
    )
    const create = screen.getByRole('button', { name: /newProject\.create/ })
    expect(create).toBeDisabled()

    // Whitespace-only stays disabled (name.trim() is empty).
    const input = screen.getByPlaceholderText('my-new-project')
    fireEvent.change(input, { target: { value: '   ' } })
    expect(create).toBeDisabled()

    fireEvent.change(input, { target: { value: 'my-app' } })
    expect(create).toBeEnabled()
  })

  it('Escape closes the modal', () => {
    const onClose = vi.fn()
    render(
      <NewProjectModal open defaultWorkspace="/tmp/ws" onClose={onClose} onCreated={noop} />,
    )
    fireEvent.keyDown(screen.getByPlaceholderText('my-new-project'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

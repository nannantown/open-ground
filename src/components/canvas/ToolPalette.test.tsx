// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Tool } from '@/lib/types'
import { ToolPalette } from './ToolPalette'

vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (key: string) => key }) }))

describe('Ground drawing tools', () => {
  it('starts collapsed, opens for drawing, and closes back to selection', () => {
    function Harness() {
      const [tool, setTool] = useState<Tool>('select')
      return <><output>{tool}</output><ToolPalette tool={tool} onToolChange={setTool} /></>
    }
    render(<Harness />)
    expect(screen.queryByRole('button', { name: 'Text (T)' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'toolbar.editLayout' }))
    fireEvent.click(screen.getByTitle('Text (T)'))
    expect(screen.getByRole('status').textContent).toBe('text')
    fireEvent.click(screen.getByRole('button', { name: 'toolbar.finishLayout' }))
    expect(screen.getByRole('status').textContent).toBe('select')
    expect(screen.queryByRole('button', { name: 'Text (T)' })).toBeNull()
  })

  it('folds away on a press outside while the select tool is active', () => {
    function Harness() {
      const [tool, setTool] = useState<Tool>('select')
      return <><output>{tool}</output><ToolPalette tool={tool} onToolChange={setTool} /></>
    }
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'toolbar.editLayout' }))
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Text (T)' }))
    expect(screen.getByRole('button', { name: 'Text (T)' })).toBeTruthy()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('button', { name: 'Text (T)' })).toBeNull()
    // With a drawing tool armed, a canvas press is the tool being used, not a dismissal.
    fireEvent.click(screen.getByRole('button', { name: 'toolbar.editLayout' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sticky note (S)' }))
    fireEvent.pointerDown(document.body)
    expect(screen.getByRole('button', { name: 'Text (T)' })).toBeTruthy()
  })

  it('exposes a tool selected by a keyboard shortcut and leaves embedded tools visible', () => {
    const view = render(<ToolPalette tool="select" onToolChange={() => {}} />)
    view.rerender(<ToolPalette tool="frame" onToolChange={() => {}} />)
    expect(screen.getByTitle('Text (T)')).toBeTruthy()
    view.rerender(<ToolPalette tool="select" onToolChange={() => {}} variant="embedded" />)
    expect(screen.getByTitle('Text (T)')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'toolbar.finishLayout' })).toBeNull()
  })
})

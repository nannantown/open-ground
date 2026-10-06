// @vitest-environment jsdom
// A photo in the floating assistant's input: picked, previewed, removable,
// refused in plain words when it is not a photo we take or too large, sent with
// or without words, and shown in the talk.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'

vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (k: string) => k, lang: 'ja' }) }))

import { FloatingAssistant } from './FloatingAssistant'
import { PHOTO_MAX_BYTES } from './useAssistant'

interface Line { id: string; at: number; who: 'owner' | 'assistant'; text: string; photo?: string }
let log: Line[]
let sent: { text: string; photo?: string }[]
let sayStatus: number

const json = (body: unknown, s = 200) => ({ ok: s < 400, status: s, json: async () => body }) as Response
Element.prototype.setPointerCapture ??= () => {}
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

beforeEach(() => {
  log = []
  sent = []
  sayStatus = 200
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/log')) return json({ entries: log, name: 'ノノ', look: 'moss' })
    if (url.endsWith('/say')) {
      const body = JSON.parse(String(init?.body)) as { text: string; photo?: string }
      sent.push(body)
      if (sayStatus !== 200) return json({ error: 'photo-type' }, sayStatus)
      log = [...log, { id: 'o', at: 2, who: 'owner', text: body.text, ...(body.photo ? { photo: '2026-10-06-abc.png' } : {}) }, { id: 'r', at: 3, who: 'assistant', text: '見たよ' }]
      return json({ reply: '見たよ' })
    }
    return json({}, 404)
  }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const open = async () => {
  render(<FloatingAssistant disabled={false} />)
  fireEvent.click(await screen.findByRole('button', { name: 'ノノ' }))
}
const pick = (file: File) => fireEvent.change(screen.getByTestId('assistant-photo-input'), { target: { files: [file] } })
const preview = () => screen.queryByTestId('assistant-photo-preview')
const send = () => screen.getByRole('button', { name: 'misc.assistant.send' })

describe('a photo in the assistant input', () => {
  it('the add button opens the picker; a picked photo is previewed and can be removed', async () => {
    await open()
    const input = screen.getByTestId('assistant-photo-input') as HTMLInputElement
    const clicked = vi.spyOn(input, 'click')
    fireEvent.click(screen.getByRole('button', { name: 'misc.assistant.photoAdd' }))
    expect(clicked).toHaveBeenCalled()
    expect(input.accept).toBe('image/png,image/jpeg,image/gif,image/webp')
    pick(new File([PNG], 'a.png', { type: 'image/png' }))
    await waitFor(() => expect(preview()).not.toBeNull())
    expect(preview()!.querySelector('img')!.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
    expect((send() as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'misc.assistant.photoRemove' }))
    expect(preview()).toBeNull()
    expect((send() as HTMLButtonElement).disabled).toBe(true)
  })

  it('a file that is not a photo we take, or too large, is refused in plain words and not previewed', async () => {
    await open()
    pick(new File(['<svg/>'], 'a.svg', { type: 'image/svg+xml' }))
    expect(await screen.findByText('misc.assistant.photoType')).toBeTruthy()
    expect(preview()).toBeNull()
    const big = new File([PNG], 'big.png', { type: 'image/png' })
    Object.defineProperty(big, 'size', { value: PHOTO_MAX_BYTES + 1 })
    pick(big)
    expect(await screen.findByText('misc.assistant.photoTooLarge')).toBeTruthy()
    expect(preview()).toBeNull()
  })

  it('a photo alone is sent (base64 of its bytes) and shows in the talk', async () => {
    await open()
    pick(new File([PNG], 'a.png', { type: 'image/png' }))
    await waitFor(() => expect(preview()).not.toBeNull())
    fireEvent.click(send())
    expect(await screen.findByText('見たよ')).toBeTruthy()
    expect(sent).toEqual([{ text: '', photo: Buffer.from(PNG).toString('base64') }])
    expect(preview()).toBeNull()
    expect(screen.getByTestId('assistant-talk').querySelector('img')).not.toBeNull()
    // The kept log shows it from the server once the talk is unfolded.
    fireEvent.click(screen.getByRole('button', { name: 'misc.assistant.showTalk' }))
    await waitFor(() =>
      expect(screen.getByTestId('assistant-talk').querySelector('img')!.getAttribute('src')).toBe('/api/phone-link/assistant/photo/2026-10-06-abc.png'),
    )
  })

  it('words with a photo go together; a refused send gives both back', async () => {
    sayStatus = 415
    await open()
    const text = screen.getByRole('textbox', { name: 'misc.assistant.message' })
    fireEvent.change(text, { target: { value: 'これ何?' } })
    pick(new File([PNG], 'a.png', { type: 'image/png' }))
    await waitFor(() => expect(preview()).not.toBeNull())
    fireEvent.click(send())
    expect(await screen.findByText('misc.assistant.photoType')).toBeTruthy()
    expect(sent[0].text).toBe('これ何?')
    expect(sent[0].photo).toBe(Buffer.from(PNG).toString('base64'))
    await waitFor(() => expect(preview()).not.toBeNull())
    expect((text as HTMLInputElement).value).toBe('これ何?')
  })

  it('words alone are sent as before, with no photo field', async () => {
    await open()
    const text = screen.getByRole('textbox', { name: 'misc.assistant.message' })
    fireEvent.change(text, { target: { value: 'やあ' } })
    fireEvent.click(send())
    expect(await screen.findByText('見たよ')).toBeTruthy()
    expect(sent).toEqual([{ text: 'やあ' }])
  })
})

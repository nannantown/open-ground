// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { renderMarkdown } from './ResearchModule'

// The report reader's markdown. The owner's actual complaint (2026-08-17,
// screenshot of an MCP research report): the tab showed the report, but
// 「| 観測項目 | 値 |」「|---|---|」 printed as literal paragraphs, and **bold** /
// `code` kept their asterisks and backticks. Every test here asserts on the
// RENDERED result — what elements exist and what raw markup does NOT survive as
// text — because "renderMarkdown was called" says nothing about the screen.

const draw = (md: string) => render(<article>{renderMarkdown(md)}</article>)

describe('renderMarkdown — tables', () => {
  // The exact shape from the owner's report.
  const table = [
    '| 観測項目 | 値 |',
    '|---|---|',
    '| リポジトリ | `modelcontextprotocol/servers` |',
    '| star 数 | **89,606**(2026-08-16 取得) |',
  ].join('\n')

  it('a pipe table becomes a real <table> — and the raw pipes are GONE', () => {
    const { container } = draw(table)
    expect(container.querySelector('table')).toBeTruthy()
    const ths = Array.from(container.querySelectorAll('th')).map((e) => e.textContent)
    expect(ths).toEqual(['観測項目', '値'])
    expect(container.querySelectorAll('tbody tr').length).toBe(2)
    // ⚠ THE COMPLAINT ITSELF: no separator row, no pipes, anywhere as text.
    expect(container.textContent).not.toContain('---')
    expect(container.textContent).not.toContain('|')
  })

  it('inline markup works INSIDE cells — bold is bold, code is code, no sigils', () => {
    const { container } = draw(table)
    const strongs = Array.from(container.querySelectorAll('strong')).map((e) => e.textContent)
    expect(strongs).toContain('89,606')
    const codes = Array.from(container.querySelectorAll('code')).map((e) => e.textContent)
    expect(codes).toContain('modelcontextprotocol/servers')
    expect(container.textContent).not.toContain('**')
    expect(container.textContent).not.toContain('`')
  })

  it('column alignment follows the separator colons', () => {
    const { container } = draw('| a | b |\n|:---|---:|\n| 1 | 2 |')
    const ths = container.querySelectorAll('th')
    expect(ths[0].className).toContain('text-left')
    expect(ths[1].className).toContain('text-right')
  })

  it('a ragged row is padded to the header width, never shifting the grid', () => {
    const { container } = draw('| a | b |\n|---|---|\n| only |')
    expect(container.querySelectorAll('tbody td').length).toBe(2)
  })

  it('a bare --- is a rule, not a one-column table separator', () => {
    const { container } = draw('前段\n\n---\n\n後段')
    expect(container.querySelector('hr')).toBeTruthy()
    expect(container.querySelector('table')).toBeNull()
    expect(container.textContent).not.toContain('---')
  })
})

describe('renderMarkdown — inline', () => {
  it('**bold**, *italic*, `code`, and links render as themselves', () => {
    const { container } = draw(
      '`servers` と **太字** と *斜体* と [公式](https://example.com/x) を見る',
    )
    expect(container.querySelector('strong')?.textContent).toBe('太字')
    expect(container.querySelector('em')?.textContent).toBe('斜体')
    expect(container.querySelector('code')?.textContent).toBe('servers')
    const a = container.querySelector('a')
    expect(a?.getAttribute('href')).toBe('https://example.com/x')
    expect(a?.textContent).toBe('公式')
    for (const sigil of ['**', '`', '[', '](']) {
      expect(container.textContent).not.toContain(sigil)
    }
  })

  it('⚠ a `code` span is armour: nothing inside it becomes bold or a link', () => {
    const { container } = draw('この行の `**not bold**` はそのまま')
    expect(container.querySelector('strong')).toBeNull()
    expect(container.querySelector('code')?.textContent).toBe('**not bold**')
  })

  it('a bare URL still autolinks', () => {
    const { container } = draw('see https://example.com/y for detail')
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com/y')
  })

  it('⚠ SAFETY UNCHANGED: javascript: stays text, HTML stays text', () => {
    const { container } = draw('[x](javascript:alert(1)) and <img src=x onerror=alert(1)>')
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('javascript:alert(1)')
  })
})

describe('renderMarkdown — blocks', () => {
  it('numbered lists are an <ol>', () => {
    const { container } = draw('1. 一つ目\n2. 二つ目')
    expect(container.querySelectorAll('ol > li').length).toBe(2)
    // The numbers come from the list, not the text — no doubled 「1. 1.」.
    expect(container.querySelector('li')?.textContent).toBe('一つ目')
  })

  it('> quotes are a <blockquote>', () => {
    const { container } = draw('> 引用の一行目\n> 二行目')
    const q = container.querySelector('blockquote')
    expect(q?.textContent).toContain('引用の一行目')
    expect(q?.textContent).toContain('二行目')
    expect(container.textContent).not.toContain('>')
  })

  it('#### is a heading too, not a paragraph starting with hashes', () => {
    const { container } = draw('#### 小見出し')
    expect(container.querySelector('h4')?.textContent).toBe('小見出し')
    expect(container.textContent).not.toContain('#')
  })

  it('a bullet run after a quote closes the quote first — order is preserved', () => {
    const { container } = draw('> 引用\n- 箇条書き')
    const kids = Array.from(container.querySelector('article')!.children).map((e) => e.tagName)
    expect(kids).toEqual(['BLOCKQUOTE', 'UL'])
  })
})

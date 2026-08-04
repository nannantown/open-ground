import React from 'react'

// Minimal, dependency-free markdown renderer — enough for the AI-compiled Doc:
// #/##/### headings, - / * bullet lists, **bold**, `code`, and blank-line
// paragraphs. Not a full CommonMark implementation; the compile prompt asks for
// exactly these constructs. Styled to match the app's editorial light theme.

const renderInline = (text: string): React.ReactNode[] => {
  const nodes: React.ReactNode[] = []
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`)/g
  let last = 0
  let key = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    if (m[2] != null) nodes.push(<strong key={key++} className="font-semibold text-ink">{m[2]}</strong>)
    else if (m[3] != null)
      nodes.push(
        <code key={key++} className="rounded-[3px] bg-bg-inset px-1 py-0.5 font-mono text-[0.85em] text-ink">
          {m[3]}
        </code>,
      )
    last = re.lastIndex
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

export const Markdown = ({ source }: { source: string }) => {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const blocks: React.ReactNode[] = []
  let para: string[] = []
  let list: string[] = []
  let key = 0

  const flushPara = () => {
    if (para.length === 0) return
    blocks.push(
      <p key={key++} className="text-ui leading-relaxed text-ink-muted">
        {renderInline(para.join(' '))}
      </p>,
    )
    para = []
  }
  const flushList = () => {
    if (list.length === 0) return
    blocks.push(
      <ul key={key++} className="space-y-1 pl-1">
        {list.map((item, i) => (
          <li key={i} className="flex items-start gap-2 text-ui leading-relaxed text-ink-muted">
            <span className="mt-[8px] h-[4px] w-[4px] shrink-0 rounded-full bg-accent/60" />
            <span>{renderInline(item)}</span>
          </li>
        ))}
      </ul>,
    )
    list = []
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    if (h) {
      flushPara()
      flushList()
      const level = h[1].length
      const cls =
        level === 1
          ? 'mt-1 text-title font-display text-ink'
          : level === 2
            ? 'mt-4 text-read font-semibold text-ink'
            : 'mt-3 text-ui font-semibold text-ink'
      blocks.push(
        <div key={key++} className={cls}>
          {renderInline(h[2])}
        </div>,
      )
    } else if (bullet) {
      flushPara()
      list.push(bullet[1])
    } else if (line.trim() === '') {
      flushPara()
      flushList()
    } else {
      flushList()
      para.push(line)
    }
  }
  flushPara()
  flushList()

  return <div className="space-y-2.5">{blocks}</div>
}

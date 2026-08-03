// sdkTranscript — the PURE half of the SDK worker pane's readable-transcript
// rendering (2026-08-03, owner-directed research pass over Claude Code's own
// VS Code extension + Cline/Cursor/Windsurf transcript UIs).
//
// Two jobs, both pure so the teeth can bite without a DOM:
//
//  • groupSdkFrames — the research's single strongest pattern: a tool call is
//    ONE collapsed row (`Read src/file.ts`), its result attached as the elbow
//    preview, expandable on click. The distiller hands us tool_use and
//    tool_result as separate events; this pairs each result with the nearest
//    preceding unpaired call (same sub-agent side), so the pane renders cards,
//    not an interleaved wall (the top complaint in claude-code#49646/#57060).
//
//  • parseMarkdownBlocks — the worker's words are markdown; rendering them as
//    plain text is why the feed read like a terminal dump. Deliberately a
//    MINIMAL block parser for the subset workers actually emit (fences,
//    headings, bullet/numbered lists, paragraphs) — no dependency, no HTML
//    injection surface (the renderer maps blocks to React elements; nothing is
//    ever fed to innerHTML).

import type { SdkEvent } from './server/sdkEvents'

export interface SdkFrame {
  seq: number
  ev: SdkEvent
}

/** A render item: either a lone event, or a tool call with its paired result. */
export type SdkRenderItem =
  | { kind: 'event'; seq: number; ev: SdkEvent }
  | {
      kind: 'tool'
      seq: number
      use: Extract<SdkEvent, { kind: 'tool_use' }>
      result: Extract<SdkEvent, { kind: 'tool_result' }> | null
    }

/** Pair tool calls with their results, in order. A result attaches to the
 *  NEAREST preceding unpaired call on the same sub-agent side; an orphan result
 *  (its call scrolled out of the ring buffer) stays a lone event rather than
 *  attaching to the wrong call. */
export const groupSdkFrames = (frames: readonly SdkFrame[]): SdkRenderItem[] => {
  const items: SdkRenderItem[] = []
  // Open (unpaired) tool cards by sub-agent side, newest last.
  const open: { main: number[]; sub: number[] } = { main: [], sub: [] }
  for (const f of frames) {
    if (f.ev.kind === 'tool_use') {
      const item: SdkRenderItem = { kind: 'tool', seq: f.seq, use: f.ev, result: null }
      items.push(item)
      ;(f.ev.fromSubagent ? open.sub : open.main).push(items.length - 1)
      continue
    }
    if (f.ev.kind === 'tool_result') {
      const lane = f.ev.fromSubagent ? open.sub : open.main
      const idx = lane.pop()
      if (idx !== undefined) {
        const card = items[idx]
        if (card.kind === 'tool') {
          card.result = f.ev
          continue
        }
      }
      // Orphan result — render it alone (never attach across lanes/cards).
      items.push({ kind: 'event', seq: f.seq, ev: f.ev })
      continue
    }
    items.push({ kind: 'event', seq: f.seq, ev: f.ev })
  }
  return items
}

// ── Minimal markdown blocks ──────────────────────────────────────────────────

export type MarkdownBlock =
  | { kind: 'para'; text: string }
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }

/** Split worker prose into renderable blocks. Inline styling (bold / `code`)
 *  is left IN the text — the renderer handles it per-line; this only decides
 *  block structure. Unclosed fences swallow to the end (the streaming case:
 *  a fence mid-arrival must render as code, not as a paragraph of backticks). */
export const parseMarkdownBlocks = (text: string): MarkdownBlock[] => {
  const blocks: MarkdownBlock[] = []
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const fence = /^```(\w*)\s*$/.exec(line)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        body.push(lines[i])
        i++
      }
      i++ // past the closing fence (or EOF)
      blocks.push({ kind: 'code', lang: fence[1] ?? '', text: body.join('\n') })
      continue
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length as 1 | 2 | 3, text: heading[2] })
      i++
      continue
    }
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line)
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (bullet || numbered) {
      const ordered = !!numbered
      const items: string[] = []
      while (i < lines.length) {
        const b = /^\s*[-*•]\s+(.*)$/.exec(lines[i])
        const n = /^\s*\d+[.)]\s+(.*)$/.exec(lines[i])
        const m = ordered ? n : b
        if (!m) break
        items.push(m[1])
        i++
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }
    if (!line.trim()) {
      i++
      continue
    }
    // Paragraph: greedy until a blank line or a structural line.
    const para: string[] = [line]
    i++
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^```/.test(lines[i]) &&
      !/^#{1,3}\s/.test(lines[i]) &&
      !/^\s*[-*•]\s/.test(lines[i]) &&
      !/^\s*\d+[.)]\s/.test(lines[i])
    ) {
      para.push(lines[i])
      i++
    }
    blocks.push({ kind: 'para', text: para.join('\n') })
  }
  return blocks
}

/** One-line summary for a collapsed tool card — the research's `Read(src/x.ts)`
 *  shape, detail clamped so a huge argument can't stretch the row. */
export const toolCardSummary = (use: { name: string; detail: string }): string =>
  use.detail ? `${use.name} ${use.detail.slice(0, 80)}${use.detail.length > 80 ? '…' : ''}` : use.name

// Release-note bodies are authored bilingually with `### English` and
// `### 日本語` headings (docs/DISTRIBUTION.md §0). The Settings drawer shows
// only the section matching the UI language; a body without BOTH headings
// (hand-written, third-party fork, plain text) is shown whole. Pure function,
// unit-tested in isolation.

const SECTION_RE = /^###\s+(English|日本語)\s*$/gm

export function pickReleaseNotesLang(body: string, lang: 'en' | 'ja'): string {
  const wanted = lang === 'ja' ? '日本語' : 'English'
  const marks: { name: string; start: number; bodyStart: number }[] = []
  SECTION_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SECTION_RE.exec(body))) {
    marks.push({ name: m[1], start: m.index, bodyStart: m.index + m[0].length })
  }
  const names = new Set(marks.map((s) => s.name))
  if (!names.has('English') || !names.has('日本語')) return body.trim()
  const i = marks.findIndex((s) => s.name === wanted)
  const end = i + 1 < marks.length ? marks[i + 1].start : body.length
  return body.slice(marks[i].bodyStart, end).trim()
}

// Parse `CANVAS_ADD:` / `CANVAS_UPDATE:` markers out of Claude's assistant
// text. Kept separate from the (stateful) observer so the brace-balancing is
// unit-testable in isolation.

// Pull every `<label> {…}` JSON object out of a chunk. The object is brace-
// balanced — so it may span multiple lines (a pretty-printed marker still
// parses) — and string contents (with `\"` escapes) are respected so a `}`
// inside a string doesn't close it early. Returns the raw JSON substrings in
// source order; malformed occurrences are skipped without abandoning the rest.
export const extractMarkerObjects = (chunk: string, label: string): string[] => {
  const out: string[] = []
  let i = 0
  for (;;) {
    const at = chunk.indexOf(label, i)
    if (at < 0) break
    let j = at + label.length
    while (j < chunk.length && /\s/.test(chunk[j])) j++
    if (chunk[j] !== '{') {
      i = at + label.length
      continue
    }
    let depth = 0
    let inStr = false
    let esc = false
    let end = -1
    for (let k = j; k < chunk.length; k++) {
      const c = chunk[k]
      if (inStr) {
        if (esc) esc = false
        else if (c === '\\') esc = true
        else if (c === '"') inStr = false
      } else if (c === '"') inStr = true
      else if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) {
          end = k
          break
        }
      }
    }
    if (end < 0) {
      // Unbalanced / malformed — skip this occurrence, keep scanning for later
      // valid markers rather than abandoning the whole chunk.
      i = at + label.length
      continue
    }
    out.push(chunk.slice(j, end + 1))
    i = end + 1
  }
  return out
}

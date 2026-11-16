// An image a president puts in its reply (docs/PHONE_LINK.md "Agent images",
// docs/CHAT_SPEC.md §9.4): a line that is ONLY `![what it is](/absolute/path.png)`
// — or `~/…`, or `<…>` around a path with spaces. Shared by the Mac chat (the
// president's prose, sdkTranscript.ts) and the phone link (phoneLink.ts), so
// both read the same lines as images. Not inside a code fence; at most
// AGENT_IMAGES_MAX per reply (the rest stay words).

const LINE = /^!\[([^\]\n]*)\]\((?:<([^>\n]+)>|([^\s)]+))\)$/

/** Images one reply may carry. */
export const AGENT_IMAGES_MAX = 4

/** The image this line names, or null (a relative path or a URL is not one). */
export const imageRefOf = (line: string): { alt: string; path: string } | null => {
  const m = LINE.exec(line.trim())
  const path = m?.[2] ?? m?.[3]
  return m && path && (path.startsWith('/') || path.startsWith('~/')) ? { alt: m[1], path } : null
}

/** The reply's words without its image lines, and the images' paths in order. */
export const splitImageRefs = (text: string): { text: string; paths: string[] } => {
  const paths: string[] = []
  const kept: string[] = []
  let fenced = false
  for (const line of text.split('\n')) {
    // A fence opens and closes as parseMarkdownBlocks reads one (sdkTranscript.ts).
    if (fenced ? /^```\s*$/.test(line) : /^```(\w*)\s*$/.test(line)) fenced = !fenced
    const ref = fenced || paths.length >= AGENT_IMAGES_MAX ? null : imageRefOf(line)
    if (ref) paths.push(ref.path)
    else kept.push(line)
  }
  // Words without an image line are left exactly as written.
  return paths.length ? { text: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(), paths } : { text, paths }
}

/** Where the Mac chat loads such an image from (server/routes/misc.ts). With
 *  `kept` (the project and a key naming the line: the conversation, the
 *  reply's place in it and the image's place in the reply), the server shows
 *  the copy that line got the first time, as the phone does — not whatever
 *  lies at the path now. */
export const agentImageUrl = (path: string, kept?: { project: string; key: string }): string =>
  `/api/agent-image?path=${encodeURIComponent(path)}` + (kept ? `&project=${encodeURIComponent(kept.project)}&key=${encodeURIComponent(kept.key)}` : '')

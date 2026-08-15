// claudeExport — read the owner's claude.ai data export and keep only the part
// the Persona is allowed to learn from: THEIR OWN WORDS.
//
// WHERE THE FILE COMES FROM. claude.ai → Settings → Privacy → Export data mails
// a zip; inside it is `conversations.json`. Nothing here fetches anything — the
// owner hands over a file they already have, and it never leaves the machine.
//
// TWO RULES, both load-bearing, both pinned by tests:
//
//  1. ONLY THE HUMAN'S MESSAGES SURVIVE. The assistant's half is dropped before
//     anything downstream can see it. The Persona's premise is that it holds
//     what the OWNER thinks — the same §8 invariant that lets only an owner's
//     escalation answer reach the corpus. Learning from the model's replies
//     would make the stand-in a copy of a copy, and it would read as the
//     owner's own view forever after, with no way to tell them apart.
//
//  2. TOLERANT, NEVER GUESSING. An export is a big file written by someone
//     else's schema across several years of format changes. A row this cannot
//     read is SKIPPED AND COUNTED — never repaired, never inferred. The count
//     is returned so the screen can say "3,412 read, 8 unreadable" instead of
//     quietly showing a smaller number, which is the failure mode this repo has
//     hit repeatedly.
//
// PURE. No fs, no network, no clock — the parser is the part that must be
// exactly right, so it is testable without any of them.

/** One message the owner wrote. */
export interface ExportedOwnerMessage {
  /** Conversation uuid — provenance, so a distilled finding can be traced. */
  conversationId: string
  /** Conversation title as claude.ai stored it ('' when absent). */
  conversationName: string
  /** ISO timestamp, or '' when the export did not carry a usable one. */
  at: string
  /** The owner's text, trimmed. Never empty (empties are skipped). */
  text: string
}

export interface ClaudeExportParse {
  messages: ExportedOwnerMessage[]
  /** How many conversations the file held (including ones with nothing usable). */
  conversations: number
  /** Rows that could not be read as a conversation or a message. NOT an error —
   *  but never hidden either. */
  skipped: number
  /** Assistant/system messages dropped by rule 1. Reported so the numbers add
   *  up for anyone checking that the owner's half is what was kept. */
  droppedNonOwner: number
}

/** Hard ceiling per message. An export can contain pasted files megabytes long;
 *  nothing downstream needs more than this to tell what the owner was after,
 *  and an unbounded string here becomes an unbounded prompt later. */
export const MAX_MESSAGE_CHARS = 4000

/** Below this a message says nothing about anyone ("ok", "thanks", "続けて"). */
export const MIN_MESSAGE_CHARS = 12

/** Largest export the app will take in, in bytes — zipped or not.
 *
 *  ⚠ THIS IS A SERVER CEILING NOW, and the history is the point. The first
 *  version was a MAIN-THREAD limit of 64 MB, because the drop handler used to
 *  read the whole file in the renderer: ArrayBuffer → hash → decoded string →
 *  JSON.parse → JSON.stringify into a request body, five live copies on the
 *  thread that draws the screen. Dropping a big export froze the window.
 *
 *  Then the owner's own export arrived: 23 MB zipped, 98 MB raw. The cap would
 *  have refused the exact file it was built to serve — the guard working
 *  perfectly and stopping the feature. So the work moved to the server (the
 *  client streams the file and touches none of it) and the number became what
 *  one request may make the SERVER hold, which is a much larger and much less
 *  interesting question.
 *
 *  Lives HERE rather than beside the unzip code because the drop handler needs
 *  it to fail fast with a number the owner can act on, and a client must never
 *  import a module that pulls in zlib. */
export const MAX_EXPORT_UPLOAD_BYTES = 256 * 1024 * 1024

/** Bytes as whole megabytes, for the copy that reports a too-large file. */
export const megabytes = (bytes: number): number => Math.round(bytes / (1024 * 1024))

const asString = (v: unknown): string => (typeof v === 'string' ? v : '')

/** claude.ai has written the body two ways over the years: a flat `text`, and a
 *  `content` array of typed blocks. Read both; anything else yields ''. */
const bodyOf = (m: Record<string, unknown>): string => {
  const flat = asString(m.text).trim()
  if (flat) return flat
  const content = m.content
  if (!Array.isArray(content)) return ''
  return content
    .map((b) =>
      b && typeof b === 'object' && (b as Record<string, unknown>).type === 'text'
        ? asString((b as Record<string, unknown>).text)
        : '',
    )
    .filter(Boolean)
    .join('\n')
    .trim()
}

/** Is this the OWNER speaking? Only an explicit human sender counts — an absent
 *  or unfamiliar `sender` is NOT assumed to be them (rule 1 fails closed, so an
 *  unreadable row can never be attributed to the owner). */
const isOwner = (m: Record<string, unknown>): boolean => {
  const s = asString(m.sender).toLowerCase()
  return s === 'human' || s === 'user'
}

const isoOf = (v: unknown): string => {
  const s = asString(v)
  return s && Number.isFinite(Date.parse(s)) ? s : ''
}

/**
 * Parse a claude.ai `conversations.json`. Never throws on a malformed row —
 * only on being handed something that is not an array at all, which is the one
 * case where continuing would mean inventing a result.
 */
export const parseClaudeExport = (parsed: unknown): ClaudeExportParse => {
  if (!Array.isArray(parsed)) {
    throw new Error('not a claude.ai conversations export (expected a top-level array)')
  }
  const messages: ExportedOwnerMessage[] = []
  let conversations = 0
  let skipped = 0
  let droppedNonOwner = 0

  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      skipped++
      continue
    }
    const conv = raw as Record<string, unknown>
    const list = conv.chat_messages
    if (!Array.isArray(list)) {
      // A conversation row we cannot read the messages of. Counted as skipped
      // rather than as an empty conversation: "we could not read this" and
      // "this one was empty" are different facts.
      skipped++
      continue
    }
    conversations++
    const conversationId = asString(conv.uuid) || asString(conv.id)
    const conversationName = asString(conv.name)

    for (const rawMsg of list) {
      if (!rawMsg || typeof rawMsg !== 'object' || Array.isArray(rawMsg)) {
        skipped++
        continue
      }
      const m = rawMsg as Record<string, unknown>
      if (!isOwner(m)) {
        droppedNonOwner++
        continue
      }
      const body = bodyOf(m)
      if (body.length < MIN_MESSAGE_CHARS) continue
      messages.push({
        conversationId,
        conversationName,
        at: isoOf(m.created_at),
        text: body.slice(0, MAX_MESSAGE_CHARS),
      })
    }
  }

  return { messages, conversations, skipped, droppedNonOwner }
}

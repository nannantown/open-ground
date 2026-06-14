// First-line title derivation for the Board's content-first card drawer: the
// user writes WHAT THE TASK IS in the content textarea (there is no title
// field). On Run, `provisionalTitle` takes the first line as a stopgap title
// WITHOUT consuming the content, satisfying the server's title-required prompt
// contract; a haiku auto-title then refines it server-side. `deriveCardFields`
// (first line → title, rest → notes) survives only as the `wantsAutoTitle`
// input — does the content warrant that haiku pass. Both stay titleAuto until
// the user edits the title by hand.

export const MAX_DERIVED_TITLE = 60

export interface DerivedCardFields {
  title: string
  notes?: string
}

/** Split free text into { title, notes }. A short first line titles the card
 *  and the remainder becomes notes; an over-long first line is clipped for the
 *  title while the FULL text is kept as notes so nothing the user wrote is
 *  lost. Empty input derives an empty title (caller skips persisting). */
export const deriveCardFields = (raw: string): DerivedCardFields => {
  const text = raw.replace(/\r\n/g, '\n').trim()
  if (!text) return { title: '' }
  const nl = text.indexOf('\n')
  const first = (nl === -1 ? text : text.slice(0, nl)).trim()
  if (first.length <= MAX_DERIVED_TITLE) {
    const rest = nl === -1 ? '' : text.slice(nl + 1).trim()
    return { title: first, ...(rest ? { notes: rest } : {}) }
  }
  return { title: first.slice(0, MAX_DERIVED_TITLE), notes: text }
}

/** Whether the derived fields warrant a haiku summary pass: multi-line content
 *  or a clipped first line — a short single line IS already its own title. */
export const wantsAutoTitle = (fields: DerivedCardFields): boolean =>
  fields.notes !== undefined

/** A provisional title from free content WITHOUT consuming it — the content
 *  stays whole (unlike {@link deriveCardFields}, which splits the first line
 *  off into the title and keeps only the rest as notes). The content-first
 *  drawer has no title field, so Run derives this stopgap heading from the
 *  first non-empty line (clipped to {@link MAX_DERIVED_TITLE}) to satisfy the
 *  server's title-required prompt contract; the haiku pass refines it after
 *  launch (both stay `titleAuto` until the user edits by hand). Empty content
 *  yields an empty string (the caller blocks the launch / skips persisting). */
export const provisionalTitle = (content: string): string => {
  const text = content.replace(/\r\n/g, '\n').trim()
  if (!text) return ''
  const nl = text.indexOf('\n')
  const first = (nl === -1 ? text : text.slice(0, nl)).trim()
  return first.length <= MAX_DERIVED_TITLE ? first : first.slice(0, MAX_DERIVED_TITLE)
}

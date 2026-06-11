// First-line title derivation for the Board's single-box card capture: the
// user writes WHAT THE TASK IS in one textarea; the first line becomes the
// provisional title (commit-message convention) and the rest the content. A
// haiku auto-title may later replace the provisional title server-side — both
// carry titleAuto until the user edits the title by hand.

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

/** A unique id — `crypto.randomUUID` with a fallback for old environments. */
export const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'id-' + Math.random().toString(36).slice(2, 12)

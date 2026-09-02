// blogError.ts — turn a blog-publish failure reason (blogPublish.ts writes
// scrubbed, self-made strings such as "POST /wp/v2/posts: HTTP 401" or
// "fetch failed (ENOTFOUND)") into the ONE thing the owner can act on.
//
// The reason string is kept verbatim in the ledger and shown as detail; this
// classification only picks the plain-language line above it. Pure, so it can
// be pinned by a table test and reused by the list chip and the reader header.

export type BlogErrorKind = 'auth' | 'forbidden' | 'notFound' | 'network' | 'server' | 'other'

export const classifyBlogError = (reason: string | undefined | null): BlogErrorKind => {
  const r = (reason ?? '').toLowerCase()
  if (!r) return 'other'
  if (/\b401\b/.test(r)) return 'auth'
  if (/\b403\b/.test(r)) return 'forbidden'
  if (/\b404\b/.test(r)) return 'notFound'
  if (/\b5\d\d\b/.test(r)) return 'server'
  if (/fetch failed|enotfound|econnrefused|econnreset|etimedout|timeout|abort|certificate|tls|ssl/.test(r))
    return 'network'
  return 'other'
}

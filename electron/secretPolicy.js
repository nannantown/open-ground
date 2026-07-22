// electron/secretPolicy.js — the ONE definition of "what may never reach
// untrusted code" and "what may be baked into a shipped build".
//
// WHY IT IS ITS OWN MODULE (review round 4). Two guards depend on the same
// policy and must not be able to drift apart:
//
//   • electron/gateEnv.js  — strips these from a child that runs post-merge code
//   • electron/runtimeConfig.js — refuses to BAKE them into the shipped app
//
// gateEnv.js already requires runtimeConfig.js (for BAKED_KEYS), so putting the
// lists in gateEnv.js and reading them from runtimeConfig.js would close a
// require cycle. A leaf module both can require keeps the graph acyclic.
//
// THE COUPLING THAT MAKES THIS LOAD-BEARING. `buildProducerEnv` exempts all of
// BAKED_KEYS from stripping, so **anything the bake guard admits is something
// handed to untrusted post-merge code**. The two guards are therefore one
// argument, and the bake guard must be at least as strict as the strip policy.
// It twice was not:
//   round 3 — the bake guard's pattern lacked TOKEN while the strip pattern had
//             it, so a `*_TOKEN` key could pass the guard and defeat the strip.
//   round 4 — the bake guard checked only the PATTERN while stripping was
//             pattern ∪ LIST, so a listed-but-not-secret-named key
//             (FEEDBACK_ADMIN_EMAILS, OPENGROUND_OWNER_EMAILS, the *_TABLE
//             names, OPENGROUND_LOCAL_OWNER) could pass the guard and defeat the
//             strip in exactly the same shape.
//
// WHY THE STRIP LIST IS SPLIT IN TWO. It used to be one list, which is what let
// round 4's hole hide: it conflated two unrelated reasons for stripping.
//   FORBIDDEN — secrets and AUTHORITY. Must never reach untrusted code, and must
//               never be baked. This is the set the bake guard enforces.
//   HERMETIC  — PUBLIC values stripped only so a test suite gets a clean
//               baseline (src/test/setup-home.ts deletes exactly these). They are
//               legitimately BAKED into the shipped app, and `buildProducerEnv`
//               deliberately hands them back to the build. Stripping them is
//               hygiene, not security.
// Collapsing the two again would either re-open round 4's hole or break the
// build (round 1's must-fix: a stripped BAKED_KEY makes runtime-config.json `{}`).

'use strict'

/**
 * Secret-SHAPED env var names — the catch-all for secrets nobody enumerated.
 * A hand list is always behind; this is what covers the gap. Substring + /i, so
 * camelCase is covered too (`supabaseAuthToken` → match).
 *
 * KEY / CREDENTIAL / PASSWD were added in review round 4: the pattern was sold
 * as a catch-all yet let through the names most likely to exist on a developer
 * machine — ANTHROPIC_API_KEY, OPENAI_API_KEY, AWS_ACCESS_KEY_ID, GH_PAT-style
 * `api_key`, MY_CREDENTIALS, DB_PASSWD, SIGNING_KEY. False positives (MONKEY,
 * KEYBOARD…) cost a verifier nothing — it only ever loses an env var it had no
 * business reading — and producers are protected by the BAKED_KEYS exemption.
 * @type {RegExp}
 */
const SECRET_NAME_RE = /SERVICE_ROLE|SECRET|PASSWORD|PASSWD|PRIVATE|TOKEN|KEY|CREDENTIAL/i

/**
 * Secrets + AUTHORITY. Never handed to untrusted code, never bakeable — not even
 * for a producer step. Names that the pattern does not catch on its own.
 * @type {readonly string[]}
 */
const GATE_ENV_FORBIDDEN = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_FEEDBACK_TABLE',
  'SUPABASE_MODULES_TABLE',
  'SUPABASE_ROLES_TABLE',
  'SUPABASE_SUBMISSIONS_TABLE',
  'FEEDBACK_ADMIN_EMAILS',
  'MODULE_ADMIN_EMAILS',
  'OPENGROUND_OWNER_EMAILS',
  'OPENGROUND_TESTER_EMAILS',
  // The local-owner bypass that unlocks every owner-gated route (swarmGate.ts).
  'OPENGROUND_LOCAL_OWNER',
]

/**
 * PUBLIC values stripped from VERIFIERS for test hermeticity only (the same set
 * src/test/setup-home.ts deletes at the top of every suite). They are baked into
 * the shipped app and handed back to PRODUCER steps on purpose.
 * @type {readonly string[]}
 */
const GATE_ENV_HERMETIC = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'OPENGROUND_REALTIME',
  'OPENGROUND_COLLAB_WS_URL',
]

/**
 * Names that LOOK secret to the pattern but are public by design and reviewed as
 * such. Kept deliberately tiny — each entry is a human decision, not a default.
 * SUPABASE_ANON_KEY: public by design; Row Level Security is the boundary
 * (electron/runtimeConfig.js header, audited in REPORT.md).
 * @type {readonly string[]}
 */
const BAKE_PUBLIC_EXCEPTIONS = ['SUPABASE_ANON_KEY']

/**
 * Everything a VERIFIER child has stripped: both lists plus the pattern.
 * @param {string} key
 * @returns {boolean}
 */
function isStrippedKey(key) {
  return (
    GATE_ENV_FORBIDDEN.indexOf(key) !== -1 ||
    GATE_ENV_HERMETIC.indexOf(key) !== -1 ||
    SECRET_NAME_RE.test(key)
  )
}

/**
 * May this key be baked into a shipped build — and therefore handed to untrusted
 * post-merge code by buildProducerEnv? Forbidden names never; secret-shaped names
 * only via an explicit reviewed exception.
 * @param {string} key
 * @returns {boolean}
 */
function isBakeable(key) {
  if (GATE_ENV_FORBIDDEN.indexOf(key) !== -1) return false
  if (BAKE_PUBLIC_EXCEPTIONS.indexOf(key) !== -1) return true
  return !SECRET_NAME_RE.test(key)
}

/**
 * Hard guard: throws if any key must never be baked. Called at module load with
 * BAKED_KEYS, and exported so the guard itself is testable.
 * @param {readonly string[]} keys
 */
function assertBakeable(keys) {
  for (const k of keys) {
    if (!isBakeable(k)) throw new Error(`runtimeConfig: refusing to bake secret-named key "${k}"`)
  }
}

module.exports = {
  SECRET_NAME_RE,
  GATE_ENV_FORBIDDEN,
  GATE_ENV_HERMETIC,
  BAKE_PUBLIC_EXCEPTIONS,
  isStrippedKey,
  isBakeable,
  assertBakeable,
}

// compactInstructionsInstall — put a "Compact Instructions" section into the
// user's CLAUDE.md so that when Claude Code compacts a long session, the
// summary still carries the changed files, the open work, the decisions and the
// last test result.
//
// THE WHOLE FEATURE IS NATIVE. Claude Code's own compactor reads this section;
// OPEN GROUND writes no compression logic of its own (docs/CONTEXT_MANAGEMENT_PLAN.md
// §2-A2 / §4). All this module does is deploy the text, idempotently.
//
// 【一次資料】 code.claude.com/docs/en/how-claude-code-works.md (fetched 2026-07-24):
//   "To control what's preserved during compaction, add a "Compact Instructions"
//    section to CLAUDE.md or run /compact with a focus"
//   → the heading is **Compact Instructions**. The spike card's original
//     `# Summary instructions` was stale knowledge and is wrong (PLAN §3-A2).
//
// WHY ~/.claude/CLAUDE.md AND NOT THE PROJECT'S CLAUDE.md
//   1. OPEN GROUND writes no files into the user's project folders — the
//      repo-wide rule in CLAUDE.md ("No files are written into the user's
//      project folders"). A project CLAUDE.md is git-tracked, so deploying
//      there would show up as an unexplained diff in the user's own commits.
//   2. `~/.claude/CLAUDE.md` is the documented **User instructions** scope:
//      "Personal preferences for all projects … Just you (all projects)"
//      (code.claude.com/docs/en/memory.md, fetched 2026-07-24). It loads into
//      EVERY session in every project — "All discovered files are concatenated
//      into context" — so one deploy covers every project on the canvas, which
//      is what the owner's "全自動でおまかせ" policy asks for (PLAN §0).
//   3. It is the scope OPEN GROUND already owns and installs into at boot
//      (hooksInstall / ogManageSkill / swarmToolingInstall all write ~/.claude).
//
// OWNERSHIP — the user also writes this file, so we own a marked BLOCK, never
// the file: see installManagedSection in managedFileInstall.ts. Everything
// outside our delimiters is preserved byte-for-byte, a user's own "Compact
// Instructions" heading wins ('kept-user'), and deleting our block is a
// permanent opt-out (the one-shot sentinel below stops us re-adding it).

import { join } from 'path'
import { homedir } from 'os'
import { assertTestHomeIsolated } from './testHomeGuard'
import { getSettings, setSettings } from './store'
import { installManagedSection, type ManagedSectionResult } from './managedFileInstall'

/** The ownership marker, matching the `managed-by: openground` convention the
 *  whole-file installs use. Both delimiters are block-level HTML comments so
 *  they cost the user ZERO context tokens: "Block-level HTML comments in
 *  CLAUDE.md files are stripped before the content is injected into Claude's
 *  context" (memory.md, fetched 2026-07-24) — which also makes the BEGIN
 *  delimiter a free place to explain the block to the human reading their own
 *  file. The body between them is NOT inside a comment, so it survives. */
export const COMPACT_SECTION_BEGIN =
  '<!-- managed-by: openground — OPEN GROUND が入れた「圧縮のときに何を残すか」の指示です。' +
  ' この行から end 行までは自動更新されます。編集したい場合はこの2行ごと削除してください（以後 OPEN GROUND は触りません）。 -->'
export const COMPACT_SECTION_END = '<!-- managed-by: openground — end -->'

/** A user-authored section of the same kind, outside our block. If this matches,
 *  we install nothing: two "Compact Instructions" headings are contradicting
 *  instructions, and per memory.md "If two rules contradict each other, Claude
 *  may pick one arbitrarily". Their file, their call. */
export const COMPACT_HEADING_RE = /^#{1,6}[ \t]*compact\s+instructions[ \t]*$/im

/** The section itself. Deliberately short and concrete — memory.md's guidance is
 *  that specific, concise instructions are followed more reliably, and this text
 *  is paid for in every session's context window. */
export const COMPACT_INSTRUCTIONS_BODY = `# Compact Instructions

When compacting or summarizing this conversation, always preserve:

1. **Files changed** — every file path created, edited, or deleted so far in this session, each with a one-line note of what changed in it.
2. **Open work** — steps not yet finished, unresolved TODOs, and anything explicitly deferred, so the next turn knows what is left.
3. **Decisions and their reasons** — choices already made (approach, naming, trade-offs) and why, so they are not re-litigated or silently reversed.
4. **Latest verification result** — the most recent build / test / lint / type-check run: which command, and whether it passed or failed.
5. **The user's explicit instructions and constraints** — what they asked for, corrected, or forbade, in their own words.

Drop instead: superseded intermediate reasoning, file contents already summarized above, and tool output that has been acted on.`

/** Where the section goes, relative to the home dir. Exported so a test can pin
 *  that we never target a file inside a user's project. */
export const COMPACT_TARGET_REL = ['.claude', 'CLAUDE.md'] as const

export interface CompactInstructionsInstallResult {
  result: ManagedSectionResult
  /** True when this run set the one-shot sentinel (first successful install). */
  sentinelWritten: boolean
}

/** Idempotently deploy (or version-follow) the Compact Instructions section in
 *  `~/.claude/CLAUDE.md`.
 *
 *  Runs on every boot, but only ever ADDS the block once: `compactInstructionsInstalledAt`
 *  in settings.json records that first install, and from then on an absent block
 *  means the user removed it — `createIfAbsent:false` keeps us out for good.
 *  (Same one-shot-sentinel shape as `projectsMigratedAt`.) While the block IS
 *  present we keep following the shipped text, so a wording fix in an app update
 *  reaches existing installs.
 *
 *  Never throws — a boot-time install must not take the server down. (The
 *  exception is `assertTestHomeIsolated`, which throws by design inside a test
 *  process aimed at the real home; production never reaches that path.)
 *  `opts.homeDir` is for tests only. */
export const installCompactInstructions = async (
  opts: { homeDir?: string } = {},
): Promise<CompactInstructionsInstallResult> => {
  const home = opts.homeDir ?? homedir()
  if (opts.homeDir === undefined) assertTestHomeIsolated(home, 'compactInstructionsInstall (homedir()/.claude/CLAUDE.md)')
  const target = join(home, ...COMPACT_TARGET_REL)

  let installedAt: string | undefined
  try {
    installedAt = (await getSettings()).compactInstructionsInstalledAt
  } catch (e) {
    // Settings unreadable → we cannot tell "never installed" from "user deleted
    // it". Adding the block back would be the harmful guess, so make the safe
    // one: refresh an existing block, add nothing new.
    return {
      result: { outcome: 'error', path: target, error: `settings unreadable (cannot check the one-shot sentinel): ${e instanceof Error ? e.message : String(e)}` },
      sentinelWritten: false,
    }
  }

  const result = await installManagedSection({
    target,
    beginMarker: COMPACT_SECTION_BEGIN,
    endMarker: COMPACT_SECTION_END,
    body: COMPACT_INSTRUCTIONS_BODY,
    createIfAbsent: installedAt === undefined,
    headingRe: COMPACT_HEADING_RE,
  })

  // Write the sentinel only once the block is actually on disk. Setting it on a
  // failed write would make the failure permanent (next boot: "already
  // installed once" → never retried).
  //
  // 'refreshed'/'unchanged' BACKFILL it: the block being there proves we
  // installed at some point, so a settings.json that was lost or reset should
  // not license a second install. Without this, `getSettings`'s tolerant read
  // (a corrupt file returns DEFAULT_SETTINGS rather than throwing) would report
  // "never installed" and we would re-add a block the user had deleted — the
  // fail-closed-guard-defeated-by-a-tolerant-reader shape.
  let sentinelWritten = false
  if (
    (result.outcome === 'installed' || result.outcome === 'refreshed' || result.outcome === 'unchanged') &&
    installedAt === undefined
  ) {
    try {
      await setSettings({ compactInstructionsInstalledAt: new Date().toISOString() })
      sentinelWritten = true
    } catch {
      // The block is installed and carries its marker, so the next boot finds it
      // and refreshes rather than duplicating. Only the opt-out record is lost;
      // that boot retries this write.
    }
  }

  return { result, sentinelWritten }
}

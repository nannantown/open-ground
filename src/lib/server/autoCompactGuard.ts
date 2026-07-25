// Native auto-compact non-interference check.
//
// The context design delegates compression ENTIRELY to Claude Code's own
// auto-compact (default ON — docs/CONTEXT_MANAGEMENT_PLAN.md §2-A1). OG adds only
// the task-boundary clear (boundaryClear.ts). That delegation has one prerequisite
// worth stating out loud: native auto-compact must actually be running.
//
// ─── Why this READS and never WRITES ────────────────────────────────────────
// The card asked OG to notice a disabled auto-compact and "restore or report".
// This module reports. It does not restore, on purpose, for two reasons:
//
//  1. The knobs are UNCONFIRMED. `settings.json: autoCompactEnabled` and
//     `DISABLE_AUTO_COMPACT` could not be found in current official Claude Code
//     documentation (§2-A1, confidence LOW). Writing an undocumented key into a
//     user's global settings.json to "fix" something is how you leave dead config
//     behind that no upstream version ever reads.
//  2. Even if they were real, that file is the USER's. Auto-compact is ON by
//     default, so a `false` there is a deliberate act by someone. OG silently
//     flipping a setting back — and doing it on every boot, so it can never stick —
//     is exactly the kind of fight the whole design is built to avoid.
//
// So: the durable guarantee is that OG NEVER DISABLES auto-compact (fixed by the
// source-scan teeth in autoCompactGuard.test.ts, which fail if any OG module grows
// a write to either knob). This check is the observability half — if a user has
// turned it off somewhere, OG can say so instead of silently degrading.
import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { assertTestHomeIsolated } from './testHomeGuard'

/** The settings key that (per the card's premise) would turn native auto-compact
 *  off. Kept as a constant so the teeth can scan for writes to it by name. */
export const AUTO_COMPACT_SETTING = 'autoCompactEnabled'

/** The env var counterpart. */
export const AUTO_COMPACT_ENV = 'DISABLE_AUTO_COMPACT'

// ─── The homedir() anchor, fenced ────────────────────────────────────────────
// Read-only, but fenced anyway and for the same reason hooksInstall.ts is: this
// resolves the user's REAL global Claude config, which no OPENGROUND_HOME
// override moves. A test that forgot to pin HOME would read the developer's own
// settings.json and quietly assert against personal config. Inert in production.
const guardedHomedir = (): string => {
  const h = homedir()
  assertTestHomeIsolated(h, 'autoCompactGuard (homedir-anchored)')
  return h
}

const settingsPath = (): string => join(guardedHomedir(), '.claude', 'settings.json')

/** Where a disable was found. */
export type AutoCompactDisabledBy = 'settings' | 'env'

export interface AutoCompactStatus {
  /** True when nothing OG can see is disabling native auto-compact. */
  ok: boolean
  /** Every place a disable was detected (both can be set at once). */
  disabledBy: AutoCompactDisabledBy[]
  /** Plain-language summary, safe to show the owner as-is. */
  detail: string
}

const OK_DETAIL = '自動圧縮(native)は有効です。OPEN GROUND は圧縮に介入しません。'

/** Read the user's global Claude settings + env and report whether anything is
 *  disabling native auto-compact.
 *
 *  Deliberately TOLERANT of a missing/!unreadable/!malformed settings.json: no file
 *  means the default (ON) applies, and an unparseable one is not evidence of a
 *  disable. This check exists to notice an explicit `false`, so anything short of
 *  that reads as `ok` rather than manufacturing an alarm from a read error. */
export const checkAutoCompact = async (): Promise<AutoCompactStatus> => {
  const disabledBy: AutoCompactDisabledBy[] = []

  let raw: string | undefined
  try {
    raw = await readFile(settingsPath(), 'utf8')
  } catch {
    raw = undefined
  }
  if (raw !== undefined) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown> | null
      if (parsed && typeof parsed === 'object' && parsed[AUTO_COMPACT_SETTING] === false) {
        disabledBy.push('settings')
      }
    } catch {
      // Malformed settings.json — claude itself would fall back to defaults here.
    }
  }

  // Any non-empty value other than an explicit "0"/"false" counts as set: this is
  // the usual shell convention for a DISABLE_* flag.
  const env = process.env[AUTO_COMPACT_ENV]
  if (env !== undefined && env !== '' && env !== '0' && env.toLowerCase() !== 'false') {
    disabledBy.push('env')
  }

  if (disabledBy.length === 0) {
    return { ok: true, disabledBy, detail: OK_DETAIL }
  }

  const where =
    disabledBy.length === 2
      ? `設定ファイル(${AUTO_COMPACT_SETTING})と環境変数(${AUTO_COMPACT_ENV})の両方`
      : disabledBy[0] === 'settings'
        ? `設定ファイル(~/.claude/settings.json の ${AUTO_COMPACT_SETTING})`
        : `環境変数(${AUTO_COMPACT_ENV})`

  return {
    ok: false,
    disabledBy,
    detail:
      `${where}で Claude Code の自動圧縮が切られています。` +
      'この状態だと会話が長くなったときの自動圧縮が働きません' +
      '(OPEN GROUND は圧縮を代行しません — タスクの区切りで文脈を新しくするだけです)。',
  }
}

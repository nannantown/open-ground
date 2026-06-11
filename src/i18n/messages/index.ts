// Merges every namespace dictionary into one flat lookup table per locale.
// COMPLETE as written — translation tracks fill their own namespace file and
// MUST NOT edit this file (keeps parallel work conflict-free).
import { common } from './common'
import { projectPanel } from './projectPanel'
import { board } from './board'
import { modals } from './modals'
import { canvas } from './canvas'
import { canvasElements } from './canvasElements'
import { misc } from './misc'
import { toolbar } from './toolbar'
import { auth } from './auth'
import { screen } from './screen'
import { onboarding } from './onboarding'
import { settings } from './settings'

export type Lang = 'en' | 'ja'

const groups = [common, projectPanel, board, modals, canvas, canvasElements, misc, toolbar, auth, screen, onboarding, settings]

export const messages: Record<Lang, Record<string, string>> = {
  en: Object.assign({}, ...groups.map(g => g.en)),
  ja: Object.assign({}, ...groups.map(g => g.ja)),
}

// Keys are plain strings (the dictionary is merged at runtime from independently
// owned namespace files), so MessageKey is `string`. Unknown keys fall back to
// English, then to the key itself — a missing translation is visible, not fatal.
export type MessageKey = string

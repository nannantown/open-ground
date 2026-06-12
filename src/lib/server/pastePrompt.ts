// Bracketed-paste wrapping for text injected into a live PTY.
//
// POST /api/terminal/:id/paste-task INSERTS a task prompt into a running
// claude session's input box WITHOUT sending it: the text is wrapped in the
// xterm bracketed-paste markers (ESC [200~ … ESC [201~), which claude's TUI —
// like any readline-style input — treats as a single literal paste (newlines
// inside don't submit). Crucially the wrapped string carries NO trailing
// newline / carriage return, so the prompt lands in the input box and the
// USER decides when to hit Enter. Pure + exported so the exact byte contract
// is unit-testable without a PTY.

export const BRACKETED_PASTE_START = '\x1b[200~'
export const BRACKETED_PASTE_END = '\x1b[201~'

// Strip every paste marker (and any other bare ESC) from the payload BEFORE
// wrapping. Without this, a task whose title/notes embed `ESC[201~` would close
// the bracketed-paste span early — the bytes after it (e.g. a `\r`) would reach
// the TUI as RAW keystrokes and submit the prompt, breaking the "nothing is
// sent until the user hits Enter" guarantee. That payload is attacker-reachable
// in git-shared mode (a teammate writes the card JSON), so this is a real
// injection vector, not a theoretical one. We drop all C0/C1 ESC bytes: real
// pastes are text, never terminal control sequences.
// eslint-disable-next-line no-control-regex
const ESC_BYTES = /\x1b/g

export const bracketedPaste = (text: string): string =>
  BRACKETED_PASTE_START + text.replace(ESC_BYTES, '') + BRACKETED_PASTE_END

// The brush-up prompt POST /api/terminal/:id/paste-custom-module injects
// (UNSENT, via bracketedPaste above) into the custom-tab sidebar's claude
// session, whose cwd is the module dir. Pure + exported so the text contract is
// unit-testable; the route wraps it in the same ESC-stripped bracketed paste as
// paste-task. See docs/CUSTOM_TABS_PLAN.md (Terminal seam).
export const buildCustomModulePrompt = (def: {
  label: string
  description: string
  framework: 'react' | 'html'
}): string => {
  const sourceFile = def.framework === 'html' ? 'source.html' : 'source.tsx'
  const renderNote =
    def.framework === 'html'
      ? 'It is rendered as a standalone HTML document inside a sandboxed iframe.'
      : 'It is rendered as a React default-export component inside a sandboxed ' +
        "iframe with Tailwind classes, the app's design tokens and `lucide-react` " +
        'available; no other imports.'
  return [
    `# Custom tab: ${def.label}`,
    '',
    '## Description',
    def.description || '(none)',
    '',
    '## Instructions',
    `Edit \`${sourceFile}\` in the current directory to build this tab's UI. ` +
      renderNote +
      ' The preview hot-reloads on every save.',
  ].join('\n')
}

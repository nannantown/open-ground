// Drag & drop files onto a terminal pane → the absolute path(s) are pasted at
// the cursor, shell-quoted, iTerm-style. Two ways to learn a dropped file's
// absolute path:
//
//  1. Electron: the preload bridge exposes `getPathForFile` (webUtils) — the
//     real on-disk path of the dragged file, zero copying.
//  2. Plain browser (vite dev): the DOM never reveals absolute paths, so the
//     bytes are uploaded to POST /api/paste-file (saved under
//     ~/.openground/paste/, same place clipboard images go) and THAT path is
//     pasted — the terminal's claude can Read it all the same.
//
// term.paste() runs the text through bracketed paste, so shells (and claude)
// treat the inserted path as pasted input, not keystrokes.

interface FilePathBridge {
  getPathForFile?: (file: File) => string
}

const bridge = (): FilePathBridge | undefined =>
  (window as unknown as { openground?: FilePathBridge }).openground

/** Quote a path for the shell iff it needs it (spaces, quotes, anything
 *  outside the boring-safe set). Single-quote style: ' → '\'' */
export const shellQuotePath = (p: string): string =>
  /^[A-Za-z0-9_\-./~]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`

// Mirrors the /api/paste-file cap (and /api/paste-image's MAX_BYTES).
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

const uploadFallback = async (file: File): Promise<string | null> => {
  if (file.size === 0 || file.size > MAX_UPLOAD_BYTES) return null
  try {
    const buf = await file.arrayBuffer()
    let binary = ''
    const bytes = new Uint8Array(buf)
    const CHUNK = 0x8000
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(
        null,
        Array.from(bytes.subarray(i, i + CHUNK)),
      )
    }
    const res = await fetch('/api/paste-file', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: file.name, dataBase64: btoa(binary) }),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { path?: string }
    return typeof body.path === 'string' ? body.path : null
  } catch {
    return null
  }
}

const resolveDroppedPath = async (file: File): Promise<string | null> => {
  try {
    const p = bridge()?.getPathForFile?.(file)
    if (typeof p === 'string' && p.length > 0) return p
  } catch {
    /* bridge absent or refused — fall through to upload */
  }
  return uploadFallback(file)
}

/** Wire dragover/drop on a terminal pane's host element. Returns the cleanup.
 *  `term` is the live xterm instance (paste + focus are all we need). */
export const wireTerminalFileDrop = (
  host: HTMLElement,
  term: { paste: (text: string) => void; focus: () => void },
): (() => void) => {
  const hasFiles = (e: DragEvent): boolean =>
    Array.from(e.dataTransfer?.types ?? []).includes('Files')

  const setHighlight = (on: boolean) => {
    // Subtle affordance only — same accent family as the focus outlines.
    host.style.outline = on ? '2px dashed rgba(255,255,255,0.45)' : ''
    host.style.outlineOffset = on ? '-2px' : ''
  }

  const onDragOver = (e: DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    setHighlight(true)
  }
  const onDragLeave = () => setHighlight(false)
  const onDrop = (e: DragEvent) => {
    setHighlight(false)
    if (!hasFiles(e)) return
    e.preventDefault()
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (files.length === 0) return
    void (async () => {
      const paths: string[] = []
      for (const f of files) {
        const p = await resolveDroppedPath(f)
        if (p) paths.push(p)
      }
      if (paths.length === 0) return
      term.paste(paths.map(shellQuotePath).join(' ') + ' ')
      term.focus()
    })()
  }

  host.addEventListener('dragover', onDragOver)
  host.addEventListener('dragleave', onDragLeave)
  host.addEventListener('drop', onDrop)
  return () => {
    host.removeEventListener('dragover', onDragOver)
    host.removeEventListener('dragleave', onDragLeave)
    host.removeEventListener('drop', onDrop)
  }
}

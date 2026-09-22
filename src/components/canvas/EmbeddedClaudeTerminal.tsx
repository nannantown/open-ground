// Legacy dock bindings are retained only for explicit surface-deletion cleanup.
// Opening a tab never revives or kills these previously saved sessions.

/** Best-effort kill of every embedded PTY bound under a storage identity, plus
 *  its dock open/tabs state. Used when the surface itself is deleted (e.g. a
 *  custom module): its docks never mount again, so no later sweep could reach
 *  these bindings. The server side may also kill by cwd — this is the client
 *  half of that teardown. */
export const killEmbeddedTerminals = (storageId: string) => {
  try {
    const doomed: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k) continue
      if (
        k.startsWith(`openground.embterm.${storageId}:`) ||
        k.startsWith(`openground.dockterm.${storageId}:`)
      ) {
        doomed.push(k)
      }
    }
    for (const k of doomed) {
      if (k.startsWith('openground.embterm.')) {
        const tid = localStorage.getItem(k)
        if (tid) void fetch(`/api/terminal/${tid}`, { method: 'DELETE' }).catch(() => {})
      }
      localStorage.removeItem(k)
    }
  } catch {}
}

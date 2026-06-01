// One-shot client-side migration of a localStorage key from the previous
// codename's namespace (`hove.*`) to the current one (`openground.*`).
// Safe to call on every read: if the new key is already populated, the old
// key (if any) is just cleaned up.
export function migrateLs(oldKey: string, newKey: string): void {
  if (typeof window === 'undefined') return
  try {
    const newVal = localStorage.getItem(newKey)
    const oldVal = localStorage.getItem(oldKey)
    if (newVal == null && oldVal != null) {
      localStorage.setItem(newKey, oldVal)
    }
    if (oldVal != null) localStorage.removeItem(oldKey)
  } catch {
    // localStorage can throw in private-mode or quota-exhausted contexts —
    // not worth surfacing, the user just keeps the old key for now.
  }
}

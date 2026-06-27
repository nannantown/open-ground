import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '@/lib/auth/AuthContext'
import type { PresencePeer } from '@/lib/types'

// Presence avatars (u15) — "who else is here right now", via the DO awareness
// channel. T-agnostic: it only needs the binding's presence methods, so it takes
// a narrow PresenceChannel (any CollabBinding<T> satisfies it structurally).
// Renders the OTHER present peers (self excluded by the binding); null when alone
// or when collab isn't bound, so the default build shows nothing.

export interface PresenceChannel {
  setPresence: (state: { name: string; color: string; email?: string } | null) => void
  onPresence: (cb: (peers: PresencePeer[]) => void) => () => void
}

// Deterministic color from a string so a given person is the same hue everywhere.
const colorFor = (s: string): string => {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return `hsl(${h % 360} 55% 45%)`
}

const initialsOf = (name: string): string => name.trim().slice(0, 2).toUpperCase() || '?'

/** Publish THIS client's presence into the channel while bound + identified —
 *  no UI. Owner surfaces (BoardModule on the Board tab, ProjectCanvas on the
 *  Canvas tab) call this so a member sees the owner is here, even where there's
 *  no avatar strip yet. Identity = the email's local part as the compact `name`
 *  (drives the avatar initials + color), plus the full `email` so a peer's
 *  tooltip can show the complete address. Broadcasting the address is
 *  acceptable: only collaborators the owner invited share a room. */
export const usePublishPresence = (channel: PresenceChannel | null): void => {
  const { user } = useAuth()
  const me = useMemo(() => {
    const email = user?.email ?? ''
    const name = email.includes('@') ? email.slice(0, email.indexOf('@')) : email
    return name ? { name, color: colorFor(email), email } : null
  }, [user?.email])
  useEffect(() => {
    if (!channel || !me) return
    channel.setPresence(me)
    return () => channel.setPresence(null)
  }, [channel, me])
}

export const CollabPresence = ({
  channel,
  publish = true,
}: {
  channel: PresenceChannel | null
  /** When false, this is a DISPLAY-ONLY strip — it shows peers but does NOT
   *  publish. Use it where another always-mounted surface already publishes for
   *  the same channel (e.g. the Canvas tab: ProjectCanvas publishes via
   *  usePublishPresence so presence survives ⌘\ focus mode, while this strip
   *  lives in the collapsible Pages sidebar). Prevents a second publisher whose
   *  unmount would clear the shared local state. */
  publish?: boolean
}) => {
  const [peers, setPeers] = useState<PresencePeer[]>([])

  // Publish our own presence (unless display-only — then pass null = no-op)…
  usePublishPresence(publish ? channel : null)

  // …and subscribe to the other present peers.
  useEffect(() => {
    if (!channel) {
      setPeers([])
      return
    }
    return channel.onPresence(setPeers)
  }, [channel])

  if (!channel || peers.length === 0) return null
  const shown = peers.slice(0, 5)
  const extra = peers.length - shown.length
  return (
    <div
      className="flex items-center -space-x-1.5"
      title={peers.map((p) => p.email || p.name).join(', ')}
      aria-label={`${peers.length} other${peers.length === 1 ? '' : 's'} here`}
    >
      {shown.map((p) => (
        <span
          key={p.clientId}
          className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-bg-card text-[9px] font-semibold text-white shadow-card"
          style={{ backgroundColor: p.color }}
          title={p.email || p.name}
        >
          {initialsOf(p.name)}
        </span>
      ))}
      {extra > 0 && (
        <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-bg-card bg-bg-inset px-1 text-[9px] font-semibold text-ink-muted">
          +{extra}
        </span>
      )}
    </div>
  )
}

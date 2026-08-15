// SwarmErrorBanner — the Swarm tab's transient-failure line(s).
//
// WHY IT IS ITS OWN COMPONENT. It used to be `{(error ?? supplyError) && …}`
// inline. When the supply actions moved into useSupplyDesk with their OWN error
// state — and stopped clearing the module's `error` — that first-non-null read
// quietly became a mask: one stale worker/commander failure hid every supply
// launch/stop/restart failure after it, for as long as the older message stayed
// on screen. The owner would press 起動 and see nothing change.
//
// Two independent sources of truth need two lines, or one of them is
// decoration. Extracted so that claim is testable without mounting the whole
// Swarm tab and driving two unrelated failures through it.

interface SwarmErrorBannerProps {
  /** Worker terminate/restart, commander launch — the module's own actions. */
  error: string | null
  /** The supply desk hook's own failures. NEVER folded into `error`. */
  supplyError: string | null
}

export const SwarmErrorBanner = ({ error, supplyError }: SwarmErrorBannerProps) => {
  if (!error && !supplyError) return null
  return (
    <div className="shrink-0 border-b border-line-soft bg-bg px-3 py-2">
      {error && <p className="text-meta leading-relaxed text-accent">{error}</p>}
      {supplyError && <p className="text-meta leading-relaxed text-accent">{supplyError}</p>}
    </div>
  )
}

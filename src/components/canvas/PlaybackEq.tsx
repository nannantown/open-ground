// Tiny 3-bar equalizer pictogram — the "audio is playing here" signal shared
// by the tab row (ViewTabs) and the Ground card's Playing stamp. Bars inherit
// currentColor; animation lives in globals.css (.eq-bars) and freezes at a
// static mid-height under prefers-reduced-motion, so colour alone still says
// "playing" (the surrounding stamp/label carries the meaning too).
export const PlaybackEq = ({ size = 10 }: { size?: number }) => (
  <span aria-hidden className="eq-bars" style={{ height: size }}>
    <span />
    <span />
    <span />
  </span>
)

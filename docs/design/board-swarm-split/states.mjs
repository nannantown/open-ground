// Per-state configs for prototype.html — shared by build.mjs (Canvas) and shoot.mjs (screenshots).
export const STATES = {
  hidden: { cfg: { state: 'hidden', theme: 'light', ratio: 0.42, hint: true, label: '① Swarm を出していないとき' }, w: 1280, h: 800 },
  split: { cfg: { state: 'split', theme: 'dark', ratio: 0.42, label: '② 上下に分けたとき' }, w: 1280, h: 800 },
  large: { cfg: { state: 'split', theme: 'light', ratio: 0.72, w1open: true, label: '③ 境目を上げて Swarm を大きく' }, w: 1280, h: 800 },
  off: { cfg: { state: 'off', theme: 'dark', ratio: 0.42, label: '④ Swarm がまだオフのとき' }, w: 1280, h: 800 },
  narrow: { cfg: { state: 'split', theme: 'light', ratio: 0.5, label: '⑤ 狭い画面' }, w: 720, h: 900 },
}
export function render(tpl, cfg) {
  return tpl.replace(/\/\*CFG\*\/.*\/\*CFG\*\//, '/*CFG*/' + JSON.stringify(cfg) + '/*CFG*/')
}

# OPEN GROUND render load investigation (2026-09-25) — measurement memo

Status: **DONE (pass 3 on 0.11.146).** Earlier passes kept for history (machine was busy
in passes 1-2); only pass 3 backs the conclusion.
No code change. Card deliverable = the card's notes; this file is the working memo.

## Method (as run in pass 3)

1. **Real app, as-is (the owner's number).** `top -l 13 -s 5 -stats pid,cpu,command`
   over the OPEN GROUND processes (main / GPU helper / Renderer / the forked
   server `Helper .../server/dist/index.cjs`) + WindowServer; report average %.
   `sample` on the Renderer is blocked (hardened runtime), so attribution
   is done by step 2.
2. **Attribution — same built SPA, same live data.** Headless Chromium
   (Playwright) against the running prod server `http://127.0.0.1:47776`,
   viewport 1512x900 @2x (owner's Retina), `localStorage['openground:onboarded']='1'`.
   ⚠ MUST launch with `--use-angle=metal --enable-gpu --ignore-gpu-blocklist`:
   the default headless GPU is **SwiftShader (software)** and inflates GPU cost
   ~3x (first pass read 74% vs 25% on Metal — discarded).
   Per scenario: 3s settle, then 20s window; CPU% per process type from CDP
   `SystemInfo.getProcessInfo` (renderer / GPU / browser), main-thread
   breakdown from `Performance.getMetrics`, running animations from
   `document.getAnimations()`.
   Toggles (one at a time, each against its own baseline, baseline repeated):
   pause all animations / hide grain overlay (`body::before`) /
   `backdrop-filter:none` / continuous pan.
3. **Scenarios:** Ground idle · project open + agent-team bar folded ·
   bar opened (seats with sprites) · Board tab with working cards. NOT run:
   the Terminal tab (would attach extra clients to live claude PTYs) and a
   hidden window (see 4).
4. **Hidden window / WindowServer share — NOT measured.** Headless cannot
   reproduce it (tabs stay `visible`, and a headless copy never goes through
   WindowServer), and OG stayed frontmost for every real-app reading. What is
   known comes from the Electron docs (section below): with
   `backgroundThrottling:false` the real window keeps drawing and swapping frames
   when covered. OG's share of WindowServer (105%) is therefore open; the
   deciding check is ⌘H on OPEN GROUND and watching whether WindowServer drops.

## Suspects (from code read; file:line)

- Running-card animations: `.run-scan` (globals.css:438, translateX 1.7s) +
  `.run-pulse` (:447) on Ground cards (ProjectCard.tsx:112,133) and Board cards
  (BoardCard.tsx:399,411,484) while a card is "working".
- SwarmSprite 60fps rAF canvas loop per sprite, running in every state except
  `still` (reduced motion) — idle-looking ones included: the waiting president
  (sprites.ts:140), the commander on review cards (BoardCard.tsx:74), asking
  workers (SwarmSprite.tsx:139-149); Board cards + opened agent-team bar.
- Small always-visible `backdrop-blur` panels over the canvas (Toolbar.tsx:97,145,151 etc.).
- Full-screen grain overlay `body::before` (globals.css:258) with blend mode.
- xterm WebGL panes: one WebGL context per pane, all live side by side in the
  Terminal tab; cursor blink on focused pane.
- Polling: 5s polls stack while a project is open (ProjectPanel.tsx:1850,
  SwarmModule.tsx:543 even when bar folded, useSwarmEngine.ts:1078, BoardModule 5s x3).
- `backgroundThrottling:false` (electron/main.js:660) → the ~15 `document.hidden`
  guards may never fire; hidden window may keep animating/polling.
- Forked server process itself: 27.8% in the clean pass-3 reading — not
  rendering. It hosts 8 claude SDK sessions (the likely main cost), but also
  answers the 3s engine tick and the UI's 5s polls; the breakdown is NOT measured.

## Discarded dirty readings (machine busy, load avg 9-11) — direction only
- Real app: GPU helper ~24%, Renderer ~19%, server ~19%, main ~0.4%, WindowServer ~54% (11 cores).
- Headless Metal, Ground with 2 working cards: GPU ~20-25% → 0% with animations
  paused; grain overlay off: no change; blur off: ~13%; panning: renderer ~22%.

## Primary source check — hidden window (done, no measurement needed)
【一次資料】 Electron docs, fetched 2026-09-25:
- web-preferences `backgroundThrottling` (default `true`): "Whether to throttle
  animations and timers when the page becomes background. This also affects the
  Page Visibility API." and "when at least one webContents with backgroundThrottling
  disabled is displayed in a browserWindow, frames will be drawn and swapped for
  the entire window".
- browser-window §Page visibility: "If `backgroundThrottling` is disabled, the
  visibility state will remain `visible` even if the window is minimized,
  occluded, or hidden." (macOS occlusion tracking applies only when enabled.)
→ OPEN GROUND sets it to `false` (electron/main.js:660, for xterm flow-control
ACKs), so a covered/minimized OPEN GROUND keeps animating, polling and swapping
frames. (A front-vs-behind real-app comparison was planned but never happened:
`lsappinfo front` showed OG frontmost in every reading.)

## Project-view scenario prep
Ground card open = click on a card (InfiniteCanvas pointer-up path); agent-team
bar = `[data-testid="swarm-bottom-bar"]`, click to unfold.

## Probe ready (dry-run 2026-09-25 11:40 — navigation only, numbers discarded)
- The probe scripts lived in the worker worktree's `.perf-probe/` and were
  deliberately NOT committed (card: no code change), so they are gone with the
  worktree. To reproduce, rebuild from the Method section: a Playwright harness
  (probe) + a Ground toggle scenario + a project scenario (project → Board →
  agent bar open → blur off).
- **Read-only fence**: the probe aborts every non-GET `/api/**` request. Needed
  because mounting a terminal pane POSTs `/api/terminal/:id/resize` — without the
  fence, the headless 1512x900 window would resize the owner's live PTYs.
- Terminal tab is deliberately NOT driven headless (would attach extra clients to
  live claude PTYs); the President seat in the opened bar already exercises one
  live xterm pane.

## Pass 2 (11:59-12:10, v0.11.145, no tests running at start) — PRE-UPDATE, not for conclusions
Commander: 0.11.146 auto-update + restart began during this pass (load avg hit 276
at the end) → re-measure on 0.11.146. Recorded for comparison only.
- Real app 60s, OG frontmost, no tests: GPU helper 21.4% · Renderer 18.2% ·
  server 21.5% · main 0.4% · WindowServer 90.8% (whole-system) → OG ≈ 61% of one
  core ≈ 5.6% of the 11-core machine.
- Ground (headless Metal): baseline GPU 22-24% / renderer 4% · all anims paused
  GPU 0% / renderer 0.1% · pause scan band only: no change · pause pulse dot only:
  no change (either one alone keeps the cost) · will-change on scan: no change ·
  grain off: no change · blur off: GPU 16% · continuous pan: renderer 25%.
- Project: folded bar r8/g28 · Board tab r16/g33 · Board anims paused r10/g27 ·
  Board + bar open r21/g39 · + blur off r21/g29.

## Pass 3 (0.11.146, quiet — the numbers the conclusion rests on)
See the card notes for the owner-facing report; the same text + raw numbers:



---
【調査結果 2026-09-25・0.11.146 で測定(作業係のテストが止まっている時間)・差し戻し1回目で訂正済み】

■ 一言で
OPEN GROUND 自身の処理は、パソコン全体の約6%です。そのうち画面を描く分は約3%です。残りの約3%は裏側のサーバーの分で、係8人とのやりとりの中継が主だと推定しています(サーバーは定期的な確認や画面からの問い合わせにも答えているので、内訳は測っていません)。

■ 結論
- OPEN GROUND 自身の処理(約6%)に限って言えば、直しても体感はほぼ変わりません。効果の大きい改善案はありません。
- ただし、一番動いていた WindowServer(約105%。全部のアプリの画面をまとめて映す macOS の仕組み)のうち、OPEN GROUND の分はまだ測れていません。OPEN GROUND は裏に回っていても描き続ける設定なので、その分が WindowServer に乗っている可能性はあります。
- なので「画面の重さ全体のうち OPEN GROUND がどれだけか」は、まだ分かりません。確かめ方は簡単で、⌘H で OPEN GROUND を隠して、アクティビティモニタの WindowServer が大きく下がるか見るだけです。大きく下がれば OPEN GROUND が主因、下がらなければ主因は他のアプリです。

■ OPEN GROUND の描画の中身
- 作業中カードの流れる帯と点滅する印:作業中のカードが見えている間だけ動きます。描画の負荷のいちばん大きい部分です。
- 席のキャラクター:待機中・質問中も含めて、ずっと描き直し続けています。エージェントチームのバーを開いている間と、Board に席のキャラクターが出ている間は、この分(小さい)が残ります。
- すりガラスのぼかしは少しだけ、紙のざらざらした質感は無関係でした。
- キャンバスを動かしている最中だけは重くなりますが、手を止めれば元に戻ります。
- ウィンドウを裏に回しても、アニメーションも描画も続きます。ターミナルの流れを止めないための意図的な設定です。OPEN GROUND 自身の処理としては小さいですが、WindowServer への影響は上のとおり未測定です。

---
【測定の手順と生の数字】(詳細は docs/research/20260925-render-load-investigation.md)
1) 実物(0.11.146, OG 前面, テスト0本, 60秒平均, top): GPU helper 21.1% / Renderer 16.7% / サーバ(forked index.cjs) 27.8% / 本体 0.5% / WindowServer 105%。OG合計 ≈ 1コアの66% ≈ 11コア機の6%。サーバの子は claude SDK セッション8本(サーバ負荷の主因と推定・内訳は未測定。3秒ごとのエンジン tick と画面の5秒ポーリングにも応答している)。GPU 全体の使用率(ioreg Device Utilization)は48〜57%。
2) 切り分け: 同じビルド・同じ実データを headless Chromium(Metal GPU、1512x900@2x、書き込み系 API は全遮断)で開き、20秒ずつ CDP の SystemInfo.getProcessInfo で CPU を測定(単位: 1コアに対する%)。
   - Ground(作業中カード2枚): renderer 4 / GPU処理 26 → アニメ全停止で 0.1 / 0。帯だけ・点だけ止めても下がらず(両方止めて初めて0)。質感を消しても 26 のまま。ぼかしを消すと 16。パン操作中は renderer 24。
   - Board: renderer 13 / GPU 31 → キャラクター(rAF)停止で 6 / 26 → さらにCSSアニメ停止で 0.7 / 0。
   - Board+エージェントチームのバーを開く: renderer 16 / GPU 31。ぼかしを消すと GPU 23。
   - GPU 本体への寄与: Board 再現中に ioreg で「アニメあり 56.8/52.4%」と「アニメ停止 56.2/55.1%」→ 差なし(ただし headless のコピーは WindowServer を通らないので、実物ウィンドウの WindowServer 寄与は未測定)。
3) 裏にあるとき: electron/main.js:660 backgroundThrottling:false。Electron 公式ドキュメント(web-preferences / browser-window#page-visibility)によると、この設定では最小化・隠れていても visible 扱いで、描画・タイマーが続く。
4) 注意: 最初の数回は SwiftShader(ソフト描画)で約3倍に膨らんで見えたので捨てました。0.11.145 での測定値も 0.11.146 とほぼ同じでした(メモに記録)。
5) 訂正メモ: SwarmSprite.tsx:139-149 の rAF ループは still(reduced-motion)以外の全状態で毎秒60回描き直す(待機中の社長 sprites.ts:140、review カードの司令官 BoardCard.tsx:74、asking の係も)。ioreg のオンオフ比較は headless のコピーで WindowServer を通らないため、WindowServer への OG の寄与の根拠にはならない。

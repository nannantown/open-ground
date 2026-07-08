# NENE 再生状態ブリッジ パッチ（Songs タブ連携の相方）

`nene-playback-bridge.patch` は **NENE リポジトリ（`/Users/kokinaniwa/projects/NENE`）用**の
パッチ。OPEN GROUND 側の「Songs タブ再生継続＋再生中インジケーター」実装
（`CustomFrameHost` / `playbackStore`）の**相方**で、NENE のプレイヤー
（`index.html` の `<audio id="audio">`）から再生状態を `window.top` へ
`postMessage`（`type: 'og-playback'`、targetOrigin `'*'`——sandbox 入れ子で
opaque origin のため）で通知する。

このパッチが当たっていなくても OPEN GROUND 側は安全に無反応なだけ
（インジケーターが出ず、keep-alive も発動しない = 従来挙動）。

## 適用手順（統合者向け）

worker セッションは書き込み先が worktree に限定されるため（guard 強制）、
NENE への適用は統合側で行う:

```bash
cd /Users/kokinaniwa/projects/NENE
git apply /path/to/this/repo/docs/patches/nene-playback-bridge.patch
git add index.html
git commit -m "Announce playback state to OPEN GROUND host (og-playback postMessage bridge)"
```

パッチ作成時点の NENE HEAD は `e111ee1`。`git apply --check` でクリーンに
当たることを検証済み。適用後は serve.js の再起動不要（静的配信・リロードで反映）。

⚠️ **NENE は並行開発中**（chord 編集などが活発に入る）。適用前に必ず
`git apply --check` し、万一 reject されたらこのパッチを当て直さず、
パッチ内容（`audio.addEventListener('seeked', …)` 直後への追記のみ・
削除行ゼロ）を手で移植すること。パッチに削除行が混ざっていたら、それは
古いスナップショットとの diff 事故なので使わないこと。

## プロトコル（OPEN GROUND 側の受け口: `src/lib/playback/playbackStore.ts`）

```js
window.top.postMessage({
  type: 'og-playback',
  app: 'nene-songs',        // 送信元タグ（情報のみ）
  projectName: 'NENE',      // ground カードとの対応付け（名前 or フォルダ名一致）
  playing: true | false,
  title: '曲名' | null,
}, '*')
```

- 発火タイミング: `audio` の `play` / `pause` / `ended` ＋ **再生中 5 秒ごとの心拍**。
- OPEN GROUND 側は無心拍 15 秒で自動消灯（サーバ落ち・iframe 死亡で
  インジケーターが残留しない）。
- 受信側は `e.source` の parent チェーンをホスト中の iframe と照合してから
  採用するため、他の iframe（Canvas mock 等）からの偽装は無視される。

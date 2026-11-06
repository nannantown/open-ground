# Ground の自動運用フレーム

Ground の「自動運用」ボタンは、専用フレームを空いた位置に作成する。既存のカードや描画は移動しない。フレームが既に有効なら、その位置を表示する。

設定は `CanvasState.automation` の `version / revision / enabled / frameId` と、対応する frame の `groundRole: automation` に保存する。表示名では判定しない。名前の変更は役割に影響せず、複製したフレームは役割を継承しない。

設定がない環境は既存の手動運用を継続する。明示的に作成した時から、専用フレーム内を自動運用の対象とし、外では新しい自動作業を受け付けない。アップデートだけで全利用者の自動運用を変更しない。専用フレームの削除・非表示・不正な重複は対象を空にし、手動運用へ暗黙には戻さない。

所属は保存済み位置を基準に、Ground が使うカードの中心（256 × 140）で判定する。フレームの回転も表示と同じ座標変換で扱う。移動・サイズ変更・再読み込み・HTTP 保存に同じ純粋関数を使う。入れ子の通常フレームや同名のフレームは自動運用の権限を持たない。

専用フレームまたは所属を変更する保存には、サインイン済み owner と現行の revision が必要。古い保存内容は 409 で拒否し、読み込み直す操作を表示する。保存失敗中の配置は自動作業へ反映しない。Canvas の通常保存、登録解除、削除、旧データの移行は共通の read/modify/write ロックを使い、専用フレームを古い snapshot で上書きしない。

未保存の配置は編集時のアカウントと世代へ固定する。アカウント切り替え後は自動送信せず、古い ACK で新しい配置を消さない。元のアカウントへ戻って明示的に再試行するか、保存済みの配置を読み込む。読み込み待ち中の新しい編集も、古い読み込み操作では捨てない。

保存完了後、サーバーが既存の権限・作業モード・認証・利用枠・安全確認を通して自動運用を適用する。画面を開くこと自体を起動の契機にしない。対象外へ移しても受理済みの actor、成果、worktree、branch は削除せず、既存の監視を残す。新しい dispatch、統合指示、自動 wake は停止する。手動の社長会話は利用できる。フレームが制御している間、従来の自動運用スイッチは理由を表示して無効になる。

画面の手動操作は `/api/swarm/supply/open`、`/api/swarm/manager/open`、`/api/swarm/manager/input` を使う。役割間の自動プロトコルは従来の `/supply`、`/manager`、`/manager/say` を使い、フレームの対象外なら保留する。リクエスト本文で起動元を選ぶことはできない。

検証は一時 home、fake actor、ブラウザ内の API fixture のみで行う。通常アプリ、実プロジェクト、モデル、認証情報、課金 AI API は使用しない。

```sh
npx vitest run src/lib/automationFrame.test.ts src/lib/server/groundCanvas.test.ts src/lib/server/groundCanvasMutation.test.ts server/routes/__tests__/groundAutomation.test.ts
npx playwright test e2e/automation-frame.spec.ts
```

UI のブラウザテストは全 `/api` を遮断してメモリ内 fixture に置き換え、ライト・ダークで作成、カード移動、サイズ変更、再読み込みを確認する。エンジンの新規 admission と受理済み作業の監視はサーバーの専用回帰で確認する。

配布版 Electron 31.7.7 / Node 20.18.0 でも、実際の store・atomicWrite・
幾何判定・policy・orchestrator を一時環境に束ねて互換性を確認した。
認証と起動前検査は runtimeOwner / chatgptAccess / chatgptRuntime の3つだけを
明示的な fixture に置き換え、engine の actor 依存も fake とした。
ネットワークとユーザーディレクトリを OS 境界で拒否し、内 ON、外の新規配車ゼロ、
受理済み監視の継続、古い revision の拒否、削除・不正 policy の停止を確認した。
実ファイル・ディレクトリの fsync と 0600 を検証し、一時データは削除した。
これは実行環境と制御の検証であり、ベンダーへの実推論ではない。

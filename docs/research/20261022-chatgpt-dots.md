# ChatGPT「dots」調査メモ(確認日 2026-10-22)

正式名: **dots**(OpenAI は小文字 "dots" / 単数 "your dot" と表記。報道では "Dots")。ChatGPT Pulse / ChatGPT Agent とは別機能で、Work(委任タスク)や Codex にも仕事を回せる上位の常駐エージェント。モデルは GPT-6 Astra。
発表日: **2026-09-29(DevDay 2026)**。[出典: https://siliconangle.com/2026/09/29/openai-launches-dots-always-on-ai-agents-in-chatgpt-with-their-own-cloud-computers/, 確認日 2026-10-22] / 公式発表 [出典: https://openai.com/index/introducing-dots/, 確認日 2026-10-22](取得した本文に日付表記なし)

主な一次資料: 公式発表 openai.com/index/introducing-dots、安全性ブログ openai.com/index/how-we-build-safety-security-and-privacy-into-dots、Help Center 20001530 / 20001529、learn.chatgpt.com/docs/dots 配下。※ openai.com / help.openai.com は WebFetch では弾かれたため r.jina.ai 経由で本文を取得した。

## 1. 何ができるか・発表日・対象プラン・対応端末
- 「always-on agent」。目標と境界を渡すと、会話と会話の間も作業を続ける。専用のクラウドPC(Linux + Chrome)、4,000超のアプリ連携(plugins)を持ち、フィードバックから学ぶ。[出典: https://openai.com/index/introducing-dots/, 確認日 2026-10-22]
- 対象: Pro(100/200/500)は18歳以上、EEA・スイス・英国を除く。Business Premium は対応地域。Enterprise(Edu/Healthcare含む)は管理者が有効にしたときだけ使えるベータで、初期状態はオフ。段階的に配布。[出典: https://learn.chatgpt.com/docs/dots.md, 確認日 2026-10-22]
- 料金: 最初の dot はプランに含まれ追加料金なし。dot との会話は ChatGPT の利用上限に数えない(dot が Work/Codex で起こしたタスクは数える)。将来は dot の追加や速度・作業量の増量を予定。[出典: https://openai.com/index/introducing-dots/, 確認日 2026-10-22]
- 端末: ChatGPT のデスクトップアプリ(Mac/Windows)、デスクトップブラウザ、iOS/Android アプリ。モバイルWebは非対応。Slack / Teams からも話せる。SMS は「近日」(Help には米国Pro限定の限定ベータとの記載あり)。[出典: https://help.openai.com/en/articles/20001530-getting-started-with-your-dot, 確認日 2026-10-22]
- 10/9 の更新でスマホから dot を作れるようになり、Codex への作業委任と Scheduled Tasks の編集が加わった。[出典: https://learn.chatgpt.com/docs/whats-new/dots-october-9-2026.md, 確認日 2026-10-22]

## 2. 会話中も裏で作業を続ける仕組み(並行タスク)
- 「話しかけている間も作業を続け、結果や判断が必要な事項を自分から持ってくる」。手元のPCを閉じていてもクラウド側で作業は続く。[出典: https://learn.chatgpt.com/docs/dots.md, 確認日 2026-10-22]
- 作業を background agents に分けて並行で走らせ、結果は dot に戻る。その間もユーザーは dot と会話を続けられる。見える形で別スレッドを作り、追加の指示も送れる。[出典: https://learn.chatgpt.com/docs/dots/tasks-and-memory.md, 確認日 2026-10-22]
- いつ休んでいつ再開するかは dot 自身が決めるので、追いかけ確認のたびに固定の予定を組む必要はない。時刻や「対応イベント」をきっかけにして動かすこともできる。[出典: https://learn.chatgpt.com/docs/dots/tasks-and-memory.md, 確認日 2026-10-22]
- 「複数の別プロジェクトを抱えたまま新しい仕事を渡せる。スレッドを使い分けたり、手順を逐一指示したりしなくてよい」。[出典: https://openai.com/index/introducing-dots/, 確認日 2026-10-22]
- 指示がないときは「proactive research」(読み取り専用の裏調査)で手伝えることを探し、自分用の非公開メモに残す。[出典: https://openai.com/index/how-we-build-safety-security-and-privacy-into-dots/, 確認日 2026-10-22]
- 現時点で使える dot は1人1体。複数の dot がチームで動く形は「将来の構想」とされている。[出典: https://openai.com/index/introducing-dots/, 確認日 2026-10-22]

## 3. 「今何をしているか」を覗くUI
- デスクトップアプリで dot のプロフィールを開くと **Activity**(Activity View)があり、作業は In progress / Scheduled / Completed に分かれて並ぶ。タスクを開くと、進み具合・ファイル・結果・入力待ちの依頼が見られる。[出典: https://help.openai.com/en/articles/20001530-getting-started-with-your-dot, 確認日 2026-10-22]
- Activity View には、進行中のタスクと委任したタスクが説明文と状態つきで並び、dot がたどった手順も確認できる。[出典: https://help.openai.com/en/articles/20001529-dots-privacy-security-and-safety-faqs, 確認日 2026-10-22]
- 「{name}’s Computer」で dot のクラウドブラウザを生で見られる。状態は「{name} has control」と表示され、**Take over** を押すと自分が操作し、**Return control** で dot に返す。モバイルでは開いた時点で自分に操作が移る。[出典: https://learn.chatgpt.com/docs/dots.md, 確認日 2026-10-22]
- 会話画面の横に Activity と Outputs が並び、会話の中にはタスクへのリンクが出る(公式イラストの説明)。dot が管理するスレッドは、作業内容が変わると名前を自分で付け直す。[出典: https://learn.chatgpt.com/docs/dots/tasks-and-memory.md, 確認日 2026-10-22] [出典: https://learn.chatgpt.com/docs/whats-new/dots-october-9-2026.md, 確認日 2026-10-22]
- 通知: dot は進捗・質問・判断の依頼を自分からメッセージで送ってくる。どの種類の更新をどこに届けるか(例: 日常の進捗は ChatGPT、判断が必要なものは Slack)を言葉で指示できる。完了通知の有無はスケジュール済みタスクごとに設定できる。[出典: https://learn.chatgpt.com/docs/dots/channels.md, 確認日 2026-10-22] [出典: https://help.openai.com/en/articles/20001530-getting-started-with-your-dot, 確認日 2026-10-22]
- 10/9 の修正で「ChatGPT を使っている最中に余計なスマホ通知が来る」問題と「“created task” メッセージの重複」が減った(裏を返すと、出始めは通知が多すぎた)。[出典: https://learn.chatgpt.com/docs/whats-new/dots-october-9-2026.md, 確認日 2026-10-22]

## 4. 話す・電話するだけで頼める(音声)
- 会話画面の電話ボタン(デスクトップではプロフィールの **Call** も)で通話を始める。通話中も文字で送れ、dot からも進捗や質問をメッセージで送ってくる。電話を切っても、頼んだ作業は続く。[出典: https://learn.chatgpt.com/docs/dots/channels.md, 確認日 2026-10-22]
- dot から電話をかけてくる機能は発表時点ではない(「after launch」に予定)。[出典: https://help.openai.com/en/articles/20001530-getting-started-with-your-dot, 確認日 2026-10-22]
- iOS: ホーム画面ウィジェット「Your dot」(メッセージ/通話ボタンも出せる)と、ショートカット「Open your dot」がある。後者は Messaging / Dictation / Call の3モードで、アクションボタンにも割り当てられる。[出典: https://learn.chatgpt.com/docs/dots/channels.md, 確認日 2026-10-22]
- 通話で使われるのは選び出した会話文脈だけで、裏で動くタスクが持つ情報とは違うことがある。[出典: https://learn.chatgpt.com/docs/dots/tasks-and-memory.md, 確認日 2026-10-22]
- ユーザー報告: 長時間の通話で「preview limit」に達した(4時間以上話せた後)。[出典: https://community.openai.com/t/don-t-stay-on-calls-with-chatgpt-dots-for-long-periods-you-can-hit-the-limit-on-pro-5x/1402443, 確認日 2026-10-22]

## 5. 自分で動く範囲と確認を取る範囲
- 3段階になっている。①最も機微な操作(パスワード変更・送金)は必ずユーザーに渡し、本人がやる。②データの完全削除・出所不明ソフトの導入・新たな機密アクセスの付与は毎回承認が要る。③定期送信のように、事前承認で済ませられるものもある。[出典: https://help.openai.com/en/articles/20001529-dots-privacy-security-and-safety-faqs, 確認日 2026-10-22]
- Auto-review: メール送信やファイル変更の前に、独立したチェック機構が指示・Custom Rules・安全要件と照らし合わせる(例: 宛先と本文を見て誤送信を防ぐ)。止めた場合は理由を dot に返し、dot は追加の確認や承認を求めるか、別の許された方法に切り替えるか、ユーザーに渡すか、中止する。ユーザーの承認でも安全要件は覆せない。[出典: https://openai.com/index/how-we-build-safety-security-and-privacy-into-dots/, 確認日 2026-10-22]
- Custom Rules は「操作の説明」+4つの扱いから選ぶ: Take action without asking / Take action when you say so(pre-approved)/ Ask before taking action / Hand off to you。設定場所は「設定 > パーソナライズ > 権限 > Custom rules」、モバイルは「Customize > Custom rules」。[出典: https://learn.chatgpt.com/docs/dots/controls.md, 確認日 2026-10-22]
- 承認は範囲に縛られる: 「下書きを頼んだ」ことは送信の許可にならない。1通を承認しても、その後ずっと連絡してよいという許可にはならない。共有の許可は情報の機微さに応じて宛先の具体性が必要(健康情報は相手の名前を指定)。[出典: https://openai.com/index/how-we-build-safety-security-and-privacy-into-dots/, 確認日 2026-10-22]
- 確認UIの具体: 会話内の「承認ボタン」(Gmail のプレビューが大きいとボタンが隠れる不具合が 10/9 に修正された)、安全バナー(監視が懸念を見つけると作業を止めて警告を出す)、サインイン依頼カード(非公開フォーム / Take over to sign in / Not now / Save to Passwords)。[出典: https://learn.chatgpt.com/docs/whats-new/dots-october-9-2026.md, 確認日 2026-10-22] [出典: https://learn.chatgpt.com/docs/dots.md, 確認日 2026-10-22]
- 取り消し: 実行済みの操作を戻せるかは、操作の種類と相手のアプリ次第。dot に直させることはでき、編集を戻したりメールを取り消したりできる場合もある。止めても、完了した操作は元に戻らない。[出典: https://help.openai.com/en/articles/20001529-dots-privacy-security-and-safety-faqs, 確認日 2026-10-22]

## 6. 複数の作業をまとめて見る画面・記憶
- プロフィールの Activity(In progress / Scheduled / Completed)と、Scheduled セクション(有効・一時停止・完了の定期タスク)で全体を見る。「今何をしていて、何に私の判断が要るか」と dot に聞くのも公式に推奨されている。[出典: https://learn.chatgpt.com/docs/dots.md, 確認日 2026-10-22]
- 委任したタスクはそれぞれ自分の会話を持ち、dot とのやり取りを全部引き継ぐわけではない(必要な指示と文脈だけ渡される)。[出典: https://learn.chatgpt.com/docs/dots/tasks-and-memory.md, 確認日 2026-10-22]
- 記憶は3層: その会話の文脈、ChatGPT memory、dot 自身のメモ(好み・決定・進行中の仕事)。過去の ChatGPT の会話も検索して使える。[出典: https://learn.chatgpt.com/docs/dots/tasks-and-memory.md, 確認日 2026-10-22]
- ChatGPT / Slack / Teams / 通話のどこから話しても同じ dot で、記憶は引き継がれる。ただし画面上の会話は窓口ごとに分かれ、情報を別の相手に出すには許可が要る。[出典: https://learn.chatgpt.com/docs/dots/channels.md, 確認日 2026-10-22]
- 個々の記憶を見る・消す・直すことは今はできない。消すには dot ごと Reset/Delete するしかない。[出典: https://help.openai.com/en/articles/20001529-dots-privacy-security-and-safety-faqs, 確認日 2026-10-22]

## 7. 途中で割り込む・方針を変える・止める
- 同じ会話の中で、仕事の切り替え・詳細の追加・優先度の変更ができ、作業をやり直さずに新しい情報を足せる。[出典: https://learn.chatgpt.com/docs/dots/tasks-and-memory.md, 確認日 2026-10-22]
- Activity からタスクを開き、直接指示を書き込んで軌道修正できる(文脈を足す・誤解を正す・方向を変える・止める)。[出典: https://openai.com/index/how-we-build-safety-security-and-privacy-into-dots/, 確認日 2026-10-22]
- 止め方は3種類で、効き方が違う: **Pause**(プロフィールの ••• メニュー)は今のメインタスクだけを止め、委任タスクや今後の予定は止めない。委任タスクは Activity で個別に止める。定期タスクは Scheduled で無効化または削除する。再開は「Paused • Tap to resume」。[出典: https://learn.chatgpt.com/docs/dots/controls.md, 確認日 2026-10-22]
- 電話を切っても、頼んだ作業は止まるとは限らない。[出典: https://learn.chatgpt.com/docs/dots.md, 確認日 2026-10-22]
- クラウドPCでは Take over で自分が手を入れ、Return control で返す。[出典: https://help.openai.com/en/articles/20001530-getting-started-with-your-dot, 確認日 2026-10-22]

## 8. 写真・画面共有・ファイルの渡し方
- 会話の **+** からファイルや写真を添付する。[出典: https://help.openai.com/en/articles/20001530-getting-started-with-your-dot, 確認日 2026-10-22]
- 自分のPCを1台だけ接続すると(デスクトップアプリで Allow access。初期状態はオフ。Revoke access で解除)、ローカルのファイル・コード・アプリを使える。PCはオンラインで ChatGPT を開いておく必要がある。[出典: https://learn.chatgpt.com/docs/dots.md, 確認日 2026-10-22]
- カメラ・マイク・画面を使わせるには、PCの接続に加えて OS 側で ChatGPT に権限を与える必要がある。[出典: https://help.openai.com/en/articles/20001529-dots-privacy-security-and-safety-faqs, 確認日 2026-10-22]
- 連携アプリ(Gmail / Drive / GitHub など)経由で資料を読ませる方法もある。メッセージ窓口をつないでも、アプリやPCへのアクセス権は付かない。[出典: https://learn.chatgpt.com/docs/dots.md, 確認日 2026-10-22]
- 写真・スクリーンショット・文書を扱える(レビュー記事)。dot の記憶には認証情報・画像・スクリーンショットは残らない(公式)。[出典: https://zapier.com/blog/chatgpt-dots.md, 確認日 2026-10-22] [出典: https://help.openai.com/en/articles/20001529-dots-privacy-security-and-safety-faqs, 確認日 2026-10-22]
- 通話中のライブ画面共有について、dot 固有の説明は【資料取得できず】。

## 9. 公式の制限・既知の弱点・レビューでの不満
- 公式: 「dots can still make mistakes」。重要な成果物は必ず確認すること。「完了」と表示されたランでも、結果が達成・配達されたことの保証にはならない。プロンプトインジェクション対策は「リスクを減らすが、なくしはしない」。[出典: https://learn.chatgpt.com/docs/dots/tasks-and-memory.md, 確認日 2026-10-22] [出典: https://help.openai.com/en/articles/20001529-dots-privacy-security-and-safety-faqs, 確認日 2026-10-22]
- 公式: 一部のサイトはクラウドブラウザを弾く(接続したPCで試す手はある)。dot から電話はかけられない。専用のメールアドレスは持てない。dot は1体のみ。記憶を個別に消せない。アプリを切断しても、既に取り込んだ情報は消えない。[出典: https://help.openai.com/en/articles/20001530-getting-started-with-your-dot, 確認日 2026-10-22]
- ユーザー報告: 説明のない利用上限に当たり、「Your Dot is resting… usage limit」と表示されて数時間止まる。使用量メーターもリセット時刻も出ない。[出典: https://community.openai.com/t/don-t-stay-on-calls-with-chatgpt-dots-for-long-periods-you-can-hit-the-limit-on-pro-5x/1402443, 確認日 2026-10-22]
- Zapier のレビュー: 定型的な通知(支払い・配送)ばかり拾い、判断が要る重要メール(編集者からの「着手を待って」)を見逃した。「鳴らない=何もない」と思い込んでしまう怖さがある。前のメール送信を承認した後、同じスレッドの次の送信は確認なしで送られた。[出典: https://zapier.com/blog/chatgpt-dots.md, 確認日 2026-10-22]
- 初期の不具合(公式の修正履歴から): 承認ボタンが隠れる、安全バナーが不安定、通知が多すぎる、Activity の読み込みに失敗する、Outlook の設定で止まる。[出典: https://learn.chatgpt.com/docs/whats-new/dots-october-9-2026.md, 確認日 2026-10-22]
- The Verge / TechCrunch のレビュー本文は【資料取得できず】(今回は取得を試していない。主要メディアでは Tom's Guide と SiliconANGLE の紹介記事のみ確認)。

## OPEN GROUND の右下アシスタントに取り入れられそうな工夫
- 止め方を3つに分ける(本体を一時停止 / 子タスクを個別に停止 / 予定を取り消し)。電話を切るなど「会話を閉じても作業は止まらない」ことを明示する。
- 依頼ごとの Activity を In progress / Scheduled / Completed で並べる。各タスクを開くと、手順・成果物・「あなた待ち」の依頼カードが一目で分かるようにする。
- 承認は4択の規則(黙って実行 / 言われたら実行 / 事前に確認 / あなたに渡す)にする。「下書きの依頼は送信の許可ではない」という範囲の縛りをそのまま取り入れる。
- 届け先を言葉で振り分けられるようにする(日常の進捗は静かに、判断が必要なものだけ通知)。「通知が多すぎる」「重要なものを見逃す」の両方が実際の不満として出ている。
- 作業画面を覗く、Take over で代わる、Return control で返す の「操作権の受け渡し」と、通話中にも文字を打てる二重の入力経路。

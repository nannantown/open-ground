# GitHub Trending intake — index

> **GENERATED FILE — do not hand-edit.** Regenerate with
> `npx tsx scripts/trending-intake.ts <github-trending-video checkout>`
> (the checkout needs history: `git -C <repo> fetch --depth=1000 origin main`).
> Judgement calls belong in the hand-written [OG-CANDIDATES.md](./OG-CANDIDATES.md).

Every repository featured in the daily "GitHub Trending TOP5" short posted to
@ai_trend_daily_ (`nannantown/github-trending-video`), recovered from the git
history of that project's `data/enriched-trending.json`.

| | |
|---|---|
| Days covered | 155 (2026-04-12 → 2026-09-22) |
| Unique repositories | 298 |
| Featured more than once | 171 |

⚠ **The Japanese one-liner is post copy, not a verified claim.** It was written
to narrate a 50-second video for a general audience, with a business angle
imposed on top. Treat it as an index entry; check the repository itself before
acting on anything. `stars` is the highest figure recorded on any appearance day.

## Free-only filter (owner decision 2026-09-22) — scanned 2026-09-22

Only tools usable for free are candidates. `Free?` reads the repository's
README and LICENSE (`scripts/trending-cost-scan.ts`):

| Value | Meaning |
|---|---|
| `free` | Licence identified AND the README explicitly needs no key or account. |
| `free?` | Licence identified but the README says nothing either way — or the licence could not be read. |
| `cost?` | A recurring price, or a required API key, was quoted from the README. |
| `unknown` | No README could be fetched. |

⚠ **It is a reading of the README, not a verdict on the product.** A paid
hosted default that names no price is invisible to it — `thedotmack/claude-mem`
scans `free?` while its installer defaults to a hosted paid tier after a 30-day
trial. Read the evidence in `signals.json` and the README before deciding.

| # | Repository | Days | First → Last | Stars | Lang | Licence | Free? | 一言(投稿文・未検証) |
|---:|---|---:|---|---:|---|---|---|---|
| 1 | [mattpocock/skills](https://github.com/mattpocock/skills) | 21 | 2026-04-26 → 2026-09-07 | 254434 | Shell | MIT | free? | Matt Pocock発のskills配布集 |
| 2 | [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) | 17 | 2026-05-07 → 2026-09-19 | 95803 | JavaScript | MIT | free? | Addy Osmani製のAgent用スキル集 |
| 3 | [obra/superpowers](https://github.com/obra/superpowers) | 16 | 2026-05-01 → 2026-09-11 | 284670 | Shell | MIT | free? | AI開発のSDLC標準化framework |
| 4 | [affaan-m/ECC](https://github.com/affaan-m/ECC) | 15 | 2026-05-26 → 2026-09-09 | 254239 | JavaScript | MIT | cost? | 7harness横断のagent OS |
| 5 | [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | 11 | 2026-04-12 → 2026-09-07 | 242511 | Python | MIT | free? | Nous Research製の自己成長agent |
| 6 | [microsoft/markitdown](https://github.com/microsoft/markitdown) | 10 | 2026-04-12 → 2026-09-08 | 180101 | Python | MIT | free? | 全形式ファイルをMarkdown化 |
| 7 | [harry0703/MoneyPrinterTurbo](https://github.com/harry0703/MoneyPrinterTurbo) | 10 | 2026-05-28 → 2026-08-22 | 113850 | Python | MIT | free? | AIショート動画自動化のOSSハブ |
| 8 | [ruvnet/RuView](https://github.com/ruvnet/RuView) | 10 | 2026-04-21 → 2026-07-23 | 83702 | Rust | MIT | free? | 9ドルでWiFiから人流と呼吸検知 |
| 9 | [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents) | 9 | 2026-06-30 → 2026-08-13 | 144525 | Shell | MIT | free? | 230種類のエージェントペルソナ集 |
| 10 | [rohitg00/ai-engineering-from-scratch](https://github.com/rohitg00/ai-engineering-from-scratch) | 9 | 2026-05-21 → 2026-07-21 | 40477 | Python | MIT | free? | AI開発者を育てる503レッスン |
| 11 | [K-Dense-AI/scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills) | 8 | 2026-05-15 → 2026-09-01 | 40676 | Python | MIT | free? | AI研究員化する163のskill集 |
| 12 | [bilawalsidhu/gods-eye-view](https://github.com/bilawalsidhu/gods-eye-view) | 8 | 2026-08-28 → 2026-09-14 | 31769 | JavaScript | MIT | cost? | OSINT向けブラウザ3D地球儀 |
| 13 | [mvanhorn/last30days-skill](https://github.com/mvanhorn/last30days-skill) | 7 | 2026-06-07 → 2026-08-01 | 56194 | Python | MIT | free | 8ソース横断の情報収集skill |
| 14 | [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | 7 | 2026-05-20 → 2026-08-29 | 35000 | Python | Apache-2.0 | free? | Claude公式のplugin directory |
| 15 | [mukul975/Anthropic-Cybersecurity-Skills](https://github.com/mukul975/Anthropic-Cybersecurity-Skills) | 7 | 2026-05-26 → 2026-08-20 | 29792 | Python | Apache-2.0 | free? | 817手順のセキュリティスキル集 |
| 16 | [tinyhumansai/openhuman](https://github.com/tinyhumansai/openhuman) | 7 | 2026-05-14 → 2026-05-21 | 23536 | Rust | GPL | free | 118 SaaS統合の個人AIハブ |
| 17 | [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents) | 6 | 2026-05-01 → 2026-08-26 | 100178 | Python | Apache-2.0 | free | マルチエージェント金融取引フレーム |
| 18 | [koala73/worldmonitor](https://github.com/koala73/worldmonitor) | 6 | 2026-04-23 → 2026-07-25 | 73195 | TypeScript | AGPL | free | 地政学と経済の統合監視ダッシュボード |
| 19 | [jamiepine/voicebox](https://github.com/jamiepine/voicebox) | 6 | 2026-04-14 → 2026-09-17 | 54333 | TypeScript | MIT | free? | ElevenLabs代替のローカル音声OSS |
| 20 | [usestrix/strix](https://github.com/usestrix/strix) | 6 | 2026-07-01 → 2026-08-18 | 54089 | Python | Apache-2.0 | cost? | AIエージェント群で自律ペンテスト |
| 21 | [forrestchang/andrej-karpathy-skills](https://github.com/forrestchang/andrej-karpathy-skills) | 6 | 2026-04-12 → 2026-04-17 | 50439 | - | ? | free? | Claude Codeを賢くする一枚の設定ファイル |
| 22 | [ayghri/i-have-adhd](https://github.com/ayghri/i-have-adhd) | 6 | 2026-07-22 → 2026-09-12 | 41600 | Python | MIT | free? | Skills標準化の一枚SKILL.md |
| 23 | [tt-a1i/archify](https://github.com/tt-a1i/archify) | 6 | 2026-08-27 → 2026-09-01 | 38491 | JavaScript | MIT | free? | AIが1枚のHTMLアーキ図を吐く |
| 24 | [cathrynlavery/diagram-design](https://github.com/cathrynlavery/diagram-design) | 6 | 2026-08-13 → 2026-09-09 | 34665 | HTML | MIT | free? | Mermaid捨てる39図テンプレ集 |
| 25 | [alibaba/open-code-review](https://github.com/alibaba/open-code-review) | 6 | 2026-07-26 → 2026-09-19 | 34602 | Go | Apache-2.0 | free | Alibaba製のAIコード監査ツール |
| 26 | [soxoj/maigret](https://github.com/soxoj/maigret) | 6 | 2026-05-02 → 2026-06-30 | 34334 | Python | MIT | free | ユーザー名で3000サイトを横断調査 |
| 27 | [calesthio/OpenMontage](https://github.com/calesthio/OpenMontage) | 6 | 2026-06-21 → 2026-06-26 | 19163 | Python | AGPL | free | 番組を丸ごと自動で組むAI動画OSS |
| 28 | [iptv-org/iptv](https://github.com/iptv-org/iptv) | 5 | 2026-06-13 → 2026-06-17 | 123970 | TypeScript | Unlicense | free? | VLCで即試せる世界のIPTV集 |
| 29 | [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem) | 5 | 2026-04-13 → 2026-04-17 | 59996 | TypeScript | Apache-2.0 | free? | Claude Codeに長期記憶を持たせるプラグイン |
| 30 | [Alishahryar1/free-claude-code](https://github.com/Alishahryar1/free-claude-code) | 5 | 2026-04-26 → 2026-08-27 | 50339 | Python | MIT | free? | Claude Code無料アクセス配布ツール |
| 31 | [chopratejas/headroom](https://github.com/chopratejas/headroom) | 5 | 2026-06-03 → 2026-06-22 | 44159 | Python | Apache-2.0 | free | LLMLinguaと並ぶ文脈圧縮層 |
| 32 | [apple/container](https://github.com/apple/container) | 5 | 2026-06-12 → 2026-06-26 | 42121 | Swift | Apache-2.0 | free? | Apple純正のMacコンテナ実行基盤 |
| 33 | [Lum1104/Understand-Anything](https://github.com/Lum1104/Understand-Anything) | 5 | 2026-05-24 → 2026-05-28 | 39585 | TypeScript | MIT | free | コードを対話可能な知識グラフへ |
| 34 | [Fincept-Corporation/FinceptTerminal](https://github.com/Fincept-Corporation/FinceptTerminal) | 5 | 2026-04-20 → 2026-05-24 | 23097 | Python | AGPL | cost? | OSS版Bloomberg Terminal |
| 35 | [Hmbown/DeepSeek-TUI](https://github.com/Hmbown/DeepSeek-TUI) | 5 | 2026-05-04 → 2026-05-08 | 18576 | Rust | MIT | free? | DeepSeek専用のターミナル開発エージェント |
| 36 | [TencentCloud/TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) | 5 | 2026-07-09 → 2026-08-07 | 16276 | TypeScript | MIT | free | AIエージェントの企業向け記憶ハブ |
| 37 | [codecrafters-io/build-your-own-x](https://github.com/codecrafters-io/build-your-own-x) | 4 | 2026-04-27 → 2026-08-03 | 534782 | Markdown | ? | free? | 500超の自作系OSS学習索引 |
| 38 | [multica-ai/andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills) | 4 | 2026-05-21 → 2026-08-25 | 206453 | Markdown | ? | free? | Karpathy流CLAUDE.md一枚設定 |
| 39 | [OpenCut-app/OpenCut](https://github.com/OpenCut-app/OpenCut) | 4 | 2026-07-14 → 2026-08-17 | 83844 | TypeScript | MIT | free? | CapCut代替のOSS動画エディタ |
| 40 | [Panniantong/Agent-Reach](https://github.com/Panniantong/Agent-Reach) | 4 | 2026-06-09 → 2026-09-15 | 81174 | Python | MIT | free? | AIエージェントにSNS横断の目 |
| 41 | [asgeirtj/system_prompts_leaks](https://github.com/asgeirtj/system_prompts_leaks) | 4 | 2026-07-06 → 2026-09-13 | 65360 | JavaScript | CC | free? | AI企業秘密を晒す透明化アーカイブ |
| 42 | [ZhuLinsen/daily_stock_analysis](https://github.com/ZhuLinsen/daily_stock_analysis) | 4 | 2026-06-24 → 2026-08-12 | 62087 | Python | MIT | free? | LLM駆動の日次株式分析OSS |
| 43 | [microsoft/AI-For-Beginners](https://github.com/microsoft/AI-For-Beginners) | 4 | 2026-07-31 → 2026-08-03 | 58932 | Jupyter Notebook | MIT | free? | Microsoft入門教材群の中核 |
| 44 | [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill) | 4 | 2026-05-29 → 2026-07-07 | 58844 | JavaScript | MIT | free? | AI UIに品位を与えるskill集 |
| 45 | [abhigyanpatwari/GitNexus](https://github.com/abhigyanpatwari/GitNexus) | 4 | 2026-04-27 → 2026-08-29 | 46145 | TypeScript | ? | cost? | コード知識グラフをブラウザで生成 |
| 46 | [moeru-ai/airi](https://github.com/moeru-ai/airi) | 4 | 2026-07-16 → 2026-07-30 | 45349 | TypeScript | MIT | free? | 有償キャラAIを自宅化するOSS |
| 47 | [Imbad0202/academic-research-skills](https://github.com/Imbad0202/academic-research-skills) | 4 | 2026-05-19 → 2026-09-02 | 44842 | Python | CC | free? | 査読まで通せる研究skill集 |
| 48 | [ruvnet/ruflo](https://github.com/ruvnet/ruflo) | 4 | 2026-05-03 → 2026-05-06 | 43481 | TypeScript | MIT | free | Claude向け100超エージェント司令塔 |
| 49 | [PostHog/posthog](https://github.com/PostHog/posthog) | 4 | 2026-04-26 → 2026-08-22 | 38274 | Python | MIT | free? | OSS版の統合プロダクト分析基盤 |
| 50 | [MadsLorentzen/ai-job-search](https://github.com/MadsLorentzen/ai-job-search) | 4 | 2026-07-08 → 2026-08-27 | 36409 | Python | MIT | free | Claude Code版の求職オートメーション |
| 51 | [JustVugg/colibri](https://github.com/JustVugg/colibri) | 4 | 2026-09-14 → 2026-09-17 | 34973 | C | Apache-2.0 | free? | SSD階層化で走るMoE推論C実装 |
| 52 | [shiyu-coder/Kronos](https://github.com/shiyu-coder/Kronos) | 4 | 2026-04-12 → 2026-07-25 | 33466 | Python | MIT | free? | 金融K線のFoundation Model |
| 53 | [debpalash/VoiceStudio](https://github.com/debpalash/VoiceStudio) | 4 | 2026-09-03 → 2026-09-16 | 30855 | Python | AGPL | free? | ローカルで動くElevenLabs代替 |
| 54 | [THU-MAIC/OpenMAIC](https://github.com/THU-MAIC/OpenMAIC) | 4 | 2026-08-30 → 2026-09-02 | 29402 | TypeScript | MIT | free | 多エージェントが授業を丸ごと運営 |
| 55 | [freestylefly/awesome-gpt-image-2](https://github.com/freestylefly/awesome-gpt-image-2) | 4 | 2026-08-24 → 2026-08-28 | 22954 | JavaScript | MIT | cost? | GPT-Image-2の実戦プロンプト集 |
| 56 | [pascalorg/editor](https://github.com/pascalorg/editor) | 4 | 2026-04-14 → 2026-09-10 | 22873 | TypeScript | MIT | free | AIと編める3D建築editor |
| 57 | [colbymchenry/codegraph](https://github.com/colbymchenry/codegraph) | 4 | 2026-05-21 → 2026-05-24 | 19293 | TypeScript | MIT | free | Claude Code用ローカル索引DB |
| 58 | [zhaoxuya520/reverse-skill](https://github.com/zhaoxuya520/reverse-skill) | 4 | 2026-08-01 → 2026-08-05 | 17780 | PowerShell | MIT | free? | 赤チーム向けセキュリティスキル集 |
| 59 | [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) | 4 | 2026-05-25 → 2026-05-28 | 17221 | Python | Apache-2.0 | free? | 11職種向けClaude公式プラグイン |
| 60 | [simplex-chat/simplex-chat](https://github.com/simplex-chat/simplex-chat) | 4 | 2026-06-27 → 2026-06-30 | 16504 | Haskell | AGPL | free? | IDを持たない暗号化メッセンジャー |
| 61 | [block/buzz](https://github.com/block/buzz) | 4 | 2026-07-24 → 2026-07-27 | 13138 | Rust | Apache-2.0 | free? | Block製Nostr型ワークスペース |
| 62 | [palmier-io/palmier-pro](https://github.com/palmier-io/palmier-pro) | 4 | 2026-06-20 → 2026-06-23 | 7239 | Swift | GPL | free? | Macで触れるAI動画エディタ |
| 63 | [semantica-agi/semantica](https://github.com/semantica-agi/semantica) | 4 | 2026-08-11 → 2026-08-14 | 6576 | Python | MIT | free? | 監査対応の知識グラフAI基盤 |
| 64 | [thunderbird/thunderbolt](https://github.com/thunderbird/thunderbolt) | 4 | 2026-04-19 → 2026-04-22 | 3426 | TypeScript | GPL | free? | ChatGPT代替のOSSクライアント |
| 65 | [freeCodeCamp/freeCodeCamp](https://github.com/freeCodeCamp/freeCodeCamp) | 3 | 2026-06-15 → 2026-06-19 | 449519 | TypeScript | BSD-3 | free? | 完全無料の実装系学習カリキュラム |
| 66 | [anthropics/skills](https://github.com/anthropics/skills) | 3 | 2026-08-14 → 2026-09-06 | 174537 | Python | ? | free? | Anthropic公式Agent Skills集 |
| 67 | [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) | 3 | 2026-09-03 → 2026-09-05 | 125818 | JavaScript | MIT | free? | 生成前にまず書かないメタツール |
| 68 | [Shubhamsaboo/awesome-llm-apps](https://github.com/Shubhamsaboo/awesome-llm-apps) | 3 | 2026-07-13 → 2026-07-15 | 120717 | Python | Apache-2.0 | free | 100超のAgent&RAG実装カタログ |
| 69 | [openai/codex](https://github.com/openai/codex) | 3 | 2026-08-23 → 2026-08-25 | 116989 | Rust | Apache-2.0 | free? | OpenAI公式ターミナルエージェント |
| 70 | [oven-sh/bun](https://github.com/oven-sh/bun) | 3 | 2026-05-17 → 2026-07-11 | 94178 | Rust | MIT | free? | Node.js置換の統合ランタイム |
| 71 | [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) | 3 | 2026-07-03 → 2026-07-05 | 83896 | JavaScript | MIT | free | 月額APIを65%削減するskill |
| 72 | [Z4nzu/hackingtool](https://github.com/Z4nzu/hackingtool) | 3 | 2026-04-24 → 2026-04-27 | 65357 | Python | MIT | free? | ペンテスト185ツール一括導入 |
| 73 | [commaai/openpilot](https://github.com/commaai/openpilot) | 3 | 2026-06-27 → 2026-06-29 | 62350 | Python | MIT | free? | 300車種で動くOSS運転支援システム |
| 74 | [D4Vinci/Scrapling](https://github.com/D4Vinci/Scrapling) | 3 | 2026-06-01 → 2026-06-03 | 59098 | Python | BSD-3 | free? | サイト崩れに強い適応スクレイパー |
| 75 | [penpot/penpot](https://github.com/penpot/penpot) | 3 | 2026-06-21 → 2026-06-23 | 52823 | Clojure | GPL | free? | Docker一発で立つOSS設計ツール |
| 76 | [HKUDS/CLI-Anything](https://github.com/HKUDS/CLI-Anything) | 3 | 2026-05-18 → 2026-05-20 | 37651 | Python | Apache-2.0 | free? | 18種GUIソフトのCLI自動生成 |
| 77 | [chatwoot/chatwoot](https://github.com/chatwoot/chatwoot) | 3 | 2026-06-14 → 2026-06-16 | 31639 | Ruby | MIT | free? | Intercom代替のOSSカスタマーサポート |
| 78 | [google-research/timesfm](https://github.com/google-research/timesfm) | 3 | 2026-06-19 → 2026-09-03 | 29683 | Python | Apache-2.0 | free? | Google発の時系列基盤モデル |
| 79 | [davila7/claude-code-templates](https://github.com/davila7/claude-code-templates) | 3 | 2026-04-26 → 2026-07-12 | 29001 | Python | MIT | free? | Claude Code設定を配布するCLI |
| 80 | [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) | 3 | 2026-07-04 → 2026-07-06 | 25402 | JavaScript | Apache-2.0 | free? | Claude CodeとCodexを繋ぐ公式拡張 |
| 81 | [tirth8205/code-review-graph](https://github.com/tirth8205/code-review-graph) | 3 | 2026-07-20 → 2026-07-22 | 24486 | Python | MIT | cost? | 14種AIエディタ共通のコード地図MCP |
| 82 | [HKUDS/Vibe-Trading](https://github.com/HKUDS/Vibe-Trading) | 3 | 2026-07-02 → 2026-07-14 | 21676 | Python | MIT | free | AIが戦略を書き検証する取引基盤 |
| 83 | [Zackriya-Solutions/meetily](https://github.com/Zackriya-Solutions/meetily) | 3 | 2026-07-06 → 2026-07-08 | 20633 | Rust | MIT | free? | 商談機密を守るローカル会議AI |
| 84 | [AprilNEA/OpenLogi](https://github.com/AprilNEA/OpenLogi) | 3 | 2026-08-21 → 2026-08-24 | 14872 | Rust | ? | free? | Logitech公式ツールのOSS代替 |
| 85 | [refactoringhq/tolaria](https://github.com/refactoringhq/tolaria) | 3 | 2026-06-09 → 2026-06-11 | 14858 | TypeScript | AGPL | free? | Markdown中心のKBデスクトップ |
| 86 | [1jehuang/jcode](https://github.com/1jehuang/jcode) | 3 | 2026-05-02 → 2026-07-30 | 13410 | Rust | MIT | cost? | Claude Code比RAM 1/6のRust |
| 87 | [nesquena/hermes-webui](https://github.com/nesquena/hermes-webui) | 3 | 2026-06-01 → 2026-06-03 | 12499 | Python | MIT | free? | 自己学習エージェントのWeb UI |
| 88 | [paperswithbacktest/awesome-systematic-trading](https://github.com/paperswithbacktest/awesome-systematic-trading) | 3 | 2026-07-31 → 2026-08-02 | 12216 | Python | ? | free? | 量的トレードOSSの内製化リスト |
| 89 | [firecrawl/pdf-inspector](https://github.com/firecrawl/pdf-inspector) | 3 | 2026-08-04 → 2026-08-06 | 11365 | Rust | MIT | free? | RAG前段のPDF高速判定Rust |
| 90 | [PrimeIntellect-ai/prime-agent](https://github.com/PrimeIntellect-ai/prime-agent) | 3 | 2026-08-08 → 2026-08-10 | 10910 | TypeScript | MIT | free? | 長時間タスク対応のエージェント基盤 |
| 91 | [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill) | 3 | 2026-09-17 → 2026-09-19 | 10463 | JavaScript | MIT | free? | Cloudflare製の監査Skillパック |
| 92 | [altic-dev/FluidVoice](https://github.com/altic-dev/FluidVoice) | 3 | 2026-06-30 → 2026-08-14 | 9828 | Swift | GPL | free | GPLv3の音声入力アプリ |
| 93 | [DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) | 3 | 2026-06-18 → 2026-06-21 | 9269 | C | MIT | free | コード理解に特化した知識グラフMCP |
| 94 | [hasaneyldrm/exercises-dataset](https://github.com/hasaneyldrm/exercises-dataset) | 3 | 2026-07-01 → 2026-07-03 | 9216 | HTML | MIT | free? | 1,324種類の運動データJSON |
| 95 | [rohitg00/agentmemory](https://github.com/rohitg00/agentmemory) | 3 | 2026-05-10 → 2026-05-15 | 8926 | TypeScript | Apache-2.0 | cost? | AIエージェントの長期記憶OSS |
| 96 | [zilliztech/claude-context](https://github.com/zilliztech/claude-context) | 3 | 2026-04-22 → 2026-04-24 | 8370 | TypeScript | MIT | cost? | AST×密ベクトルの巨大リポ検索MCP |
| 97 | [akitaonrails/ai-memory](https://github.com/akitaonrails/ai-memory) | 3 | 2026-08-18 → 2026-09-22 | 7637 | Rust | MIT | cost? | AIエージェント間長期記憶OSS |
| 98 | [cactus-compute/needle](https://github.com/cactus-compute/needle) | 3 | 2026-08-14 → 2026-08-16 | 6040 | Python | Apache-2.0 | cost? | 14MBで動く端末側LLM基盤 |
| 99 | [cloudflare/computer](https://github.com/cloudflare/computer) | 3 | 2026-08-06 → 2026-08-08 | 5615 | TypeScript | MIT | free? | Cloudflare製エージェント計算基盤 |
| 100 | [Dicklesworthstone/destructive_command_guard](https://github.com/Dicklesworthstone/destructive_command_guard) | 3 | 2026-07-13 → 2026-07-16 | 4743 | Rust | MIT | free? | Rust製AIエージェント安全弁 |
| 101 | [citrolabs/ego-lite](https://github.com/citrolabs/ego-lite) | 3 | 2026-07-24 → 2026-07-27 | 4409 | JavaScript | MIT | free? | Agentと共有するChromeブラウザ |
| 102 | [cursor/plugins](https://github.com/cursor/plugins) | 3 | 2026-05-31 → 2026-08-21 | 4052 | TypeScript | ? | free? | Cursor公式プラグイン基盤 |
| 103 | [melgarafael/DeskcommCRM](https://github.com/melgarafael/DeskcommCRM) | 3 | 2026-09-12 → 2026-09-14 | 2154 | TypeScript | MIT | free? | WhatsApp商流の自己ホストCRM |
| 104 | [anthropics/claude-code](https://github.com/anthropics/claude-code) | 2 | 2026-05-30 → 2026-05-31 | 128374 | Python | ? | free? | Anthropic公式のagentic CLI |
| 105 | [ripienaar/free-for-dev](https://github.com/ripienaar/free-for-dev) | 2 | 2026-06-28 → 2026-06-29 | 125111 | HTML | ? | cost? | 開発者向け無料枠SaaSの大全集 |
| 106 | [github/spec-kit](https://github.com/github/spec-kit) | 2 | 2026-06-05 → 2026-07-14 | 120554 | Python | MIT | free? | GitHub製のSpec-Driven開発CLI |
| 107 | [Graphify-Labs/graphify](https://github.com/Graphify-Labs/graphify) | 2 | 2026-07-14 → 2026-07-17 | 89017 | Python | Apache-2.0 | free? | コードをナレッジグラフに変換するツール |
| 108 | [opencv/opencv](https://github.com/opencv/opencv) | 2 | 2026-06-08 → 2026-06-10 | 88600 | C++ | Apache-2.0 | free? | VLM API代替のedge CV基盤 |
| 109 | [unslothai/unsloth](https://github.com/unslothai/unsloth) | 2 | 2026-08-16 → 2026-08-17 | 72527 | Python | Apache-2.0 | free? | 70%省VRAMのLLM学習フレーム |
| 110 | [ComposioHQ/awesome-claude-skills](https://github.com/ComposioHQ/awesome-claude-skills) | 2 | 2026-07-25 → 2026-07-26 | 70546 | Python | ? | free? | 1000超のClaude Skillsカタログ |
| 111 | [virattt/ai-hedge-fund](https://github.com/virattt/ai-hedge-fund) | 2 | 2026-04-15 → 2026-07-15 | 61840 | Python | MIT | free? | 投資家人格を持つ19エージェント |
| 112 | [warpdotdev/warp](https://github.com/warpdotdev/warp) | 2 | 2026-05-01 → 2026-05-02 | 51366 | Rust | ? | free? | ターミナル作業者をAI化する環境 |
| 113 | [twentyhq/twenty](https://github.com/twentyhq/twenty) | 2 | 2026-05-29 → 2026-05-30 | 48376 | TypeScript | AGPL | free? | Salesforce代替のAI内蔵CRM |
| 114 | [heygen-com/hyperframes](https://github.com/heygen-com/hyperframes) | 2 | 2026-09-08 → 2026-09-09 | 47698 | TypeScript | Apache-2.0 | free? | Remotion対抗のHTML動画基盤 |
| 115 | [ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) | 2 | 2026-05-23 → 2026-07-05 | 45749 | TypeScript | Apache-2.0 | free? | 手動QAを減らすDevTools MCP |
| 116 | [swc-project/swc](https://github.com/swc-project/swc) | 2 | 2026-06-15 → 2026-06-17 | 33957 | Rust | Apache-2.0 | free? | Babel差し替えで体感する高速変換 |
| 117 | [Flowseal/zapret-discord-youtube](https://github.com/Flowseal/zapret-discord-youtube) | 2 | 2026-05-03 → 2026-09-13 | 33201 | Batchfile | LGPL | free? | 国家検閲DPIを抜けるWin層 |
| 118 | [CopilotKit/CopilotKit](https://github.com/CopilotKit/CopilotKit) | 2 | 2026-06-06 → 2026-06-07 | 33173 | TypeScript | MIT | free? | AIエージェントUIを作るReact SDK |
| 119 | [permissionlesstech/bitchat](https://github.com/permissionlesstech/bitchat) | 2 | 2026-07-27 → 2026-07-28 | 32178 | Swift | Unlicense | free? | 圏外で動くBluetoothメッシュchat |
| 120 | [volcengine/OpenViking](https://github.com/volcengine/OpenViking) | 2 | 2026-08-19 → 2026-08-20 | 30123 | Python | AGPL | free? | 仮想FS型のエンタープライズ記憶 |
| 121 | [basecamp/omarchy](https://github.com/basecamp/omarchy) | 2 | 2026-08-17 → 2026-08-24 | 29063 | Shell | MIT | free? | DHH監修モダンLinuxディストロ |
| 122 | [lfnovo/open-notebook](https://github.com/lfnovo/open-notebook) | 2 | 2026-06-06 → 2026-06-08 | 27182 | TypeScript | MIT | free? | Google NotebookLMのOSS自社ホスト版 |
| 123 | [lyogavin/airllm](https://github.com/lyogavin/airllm) | 2 | 2026-08-03 → 2026-08-04 | 26988 | Jupyter Notebook | Apache-2.0 | free? | 4GB GPUで70Bを動かすLLM |
| 124 | [openai/skills](https://github.com/openai/skills) | 2 | 2026-09-07 → 2026-09-09 | 26481 | Python | ? | free? | OpenAI公式skills集の跡地 |
| 125 | [nautechsystems/nautilus_trader](https://github.com/nautechsystems/nautilus_trader) | 2 | 2026-08-18 → 2026-08-20 | 26426 | Rust | LGPL | free? | 個人クオンツ向けRust取引エンジン |
| 126 | [fmtlib/fmt](https://github.com/fmtlib/fmt) | 2 | 2026-09-03 → 2026-09-04 | 25037 | C++ | MIT | free? | C++の高速書式整形ライブラリ |
| 127 | [iv-org/invidious](https://github.com/iv-org/invidious) | 2 | 2026-08-03 → 2026-09-02 | 23748 | Crystal | AGPL | free? | 自前サーバで動くYouTube代替 |
| 128 | [openai/openai-agents-python](https://github.com/openai/openai-agents-python) | 2 | 2026-04-19 → 2026-04-20 | 23116 | Python | MIT | free? | OpenAI公式マルチエージェントSDK |
| 129 | [diegosouzapw/OmniRoute](https://github.com/diegosouzapw/OmniRoute) | 2 | 2026-07-01 → 2026-07-21 | 21678 | TypeScript | MIT | cost? | 271社のAIをまとめる無料ゲートウェイ |
| 130 | [tursodatabase/turso](https://github.com/tursodatabase/turso) | 2 | 2026-06-21 → 2026-06-22 | 20761 | Rust | MIT | free? | libSQLを継ぐRust製の組み込みDB |
| 131 | [different-ai/openwork](https://github.com/different-ai/openwork) | 2 | 2026-07-31 → 2026-08-01 | 19461 | TypeScript | MIT | free? | MCP経由のAI skill配布基盤 |
| 132 | [JCodesMore/ai-website-cloner-template](https://github.com/JCodesMore/ai-website-cloner-template) | 2 | 2026-06-25 → 2026-06-26 | 19247 | TypeScript | MIT | free? | サイトをNext.jsに再構築するOSS |
| 133 | [EveryInc/compound-engineering-plugin](https://github.com/EveryInc/compound-engineering-plugin) | 2 | 2026-05-30 → 2026-06-01 | 18684 | TypeScript | MIT | free? | 外注コンサルの設計工数を内製化する |
| 134 | [abseil/abseil-cpp](https://github.com/abseil/abseil-cpp) | 2 | 2026-07-11 → 2026-07-12 | 17778 | C++ | Apache-2.0 | free? | Google謹製C++標準拡張ライブラリ |
| 135 | [anthropics/financial-services](https://github.com/anthropics/financial-services) | 2 | 2026-05-08 → 2026-05-10 | 17293 | Python | Apache-2.0 | cost? | Anthropic公式の金融エージェント集 |
| 136 | [google/skills](https://github.com/google/skills) | 2 | 2026-06-09 → 2026-08-09 | 16694 | Python | Apache-2.0 | free? | Google公式のエージェントSkillsパック |
| 137 | [phuryn/pm-skills](https://github.com/phuryn/pm-skills) | 2 | 2026-06-11 → 2026-06-12 | 16157 | - | MIT | free? | PM業務の68 skillマーケット |
| 138 | [Anil-matcha/Open-Generative-AI](https://github.com/Anil-matcha/Open-Generative-AI) | 2 | 2026-05-17 → 2026-05-18 | 15043 | JavaScript | MIT | cost? | 200種のAI生成モデルを統合 |
| 139 | [pingdotgg/t3code](https://github.com/pingdotgg/t3code) | 2 | 2026-04-20 → 2026-07-27 | 15026 | TypeScript | MIT | free | 複数AI Agentを束ねるGUI |
| 140 | [earthtojake/text-to-cad](https://github.com/earthtojake/text-to-cad) | 2 | 2026-07-22 → 2026-09-10 | 15010 | Python | MIT | free? | AIでSTEPを吐くCAD skill群 |
| 141 | [docusealco/docuseal](https://github.com/docusealco/docuseal) | 2 | 2026-05-06 → 2026-05-07 | 14816 | Ruby | AGPL | free? | DocuSign代替の電子署名OSS |
| 142 | [bojieli/ai-agent-book](https://github.com/bojieli/ai-agent-book) | 2 | 2026-07-20 → 2026-07-22 | 14276 | Python | Apache-2.0 | free? | AI Agent実装を1冊で学ぶ教科書 |
| 143 | [Robbyant/lingbot-map](https://github.com/Robbyant/lingbot-map) | 2 | 2026-06-29 → 2026-07-19 | 12876 | Python | Apache-2.0 | free? | 3Dシーンを組み立てる基盤モデル |
| 144 | [Nutlope/hallmark](https://github.com/Nutlope/hallmark) | 2 | 2026-07-16 → 2026-07-18 | 11958 | CSS | MIT | free? | デザイン外注月20万を削るスキル |
| 145 | [meshery/meshery](https://github.com/meshery/meshery) | 2 | 2026-06-16 → 2026-06-18 | 11002 | TypeScript | Apache-2.0 | free? | CNCFのK8s統合管理プラットフォーム |
| 146 | [RyanCodrai/turbovec](https://github.com/RyanCodrai/turbovec) | 2 | 2026-06-09 → 2026-06-10 | 10105 | Python | MIT | free? | Rust製vector indexで月額削減 |
| 147 | [n0-computer/iroh](https://github.com/n0-computer/iroh) | 2 | 2026-06-18 → 2026-06-19 | 9992 | Rust | ? | free? | 公開鍵で繋ぐRust製P2P基盤 |
| 148 | [Pumpkin-MC/Pumpkin](https://github.com/Pumpkin-MC/Pumpkin) | 2 | 2026-07-24 → 2026-07-25 | 9308 | Rust | GPL | free? | Rust製の高速Minecraftサーバー |
| 149 | [huggingface/speech-to-speech](https://github.com/huggingface/speech-to-speech) | 2 | 2026-07-30 → 2026-07-31 | 8693 | Python | Apache-2.0 | free | 音声Agent、SaaSかOSSかの分岐点 |
| 150 | [teslamate-org/teslamate](https://github.com/teslamate-org/teslamate) | 2 | 2026-06-16 → 2026-06-17 | 8392 | Elixir | AGPL | free? | 実車なしでも触れる車データ基盤 |
| 151 | [supertone-inc/supertonic](https://github.com/supertone-inc/supertonic) | 2 | 2026-05-17 → 2026-05-19 | 8293 | Swift | MIT | free? | 31言語の軽量オンデバイスTTS |
| 152 | [wonderwhy-er/DesktopCommanderMCP](https://github.com/wonderwhy-er/DesktopCommanderMCP) | 2 | 2026-07-11 → 2026-07-13 | 7965 | TypeScript | MIT | cost? | Claude Desktop用のフル制御MCP |
| 153 | [ever-co/ever-gauzy](https://github.com/ever-co/ever-gauzy) | 2 | 2026-09-14 → 2026-09-16 | 6586 | TypeScript | AGPL | free? | ERP+CRM+HRMの統合基盤 |
| 154 | [hardikpandya/stop-slop](https://github.com/hardikpandya/stop-slop) | 2 | 2026-05-28 → 2026-05-29 | 6372 | - | MIT | free? | AI文体のクセを削るskill |
| 155 | [LearningCircuit/local-deep-research](https://github.com/LearningCircuit/local-deep-research) | 2 | 2026-05-07 → 2026-05-08 | 6203 | Python | MIT | cost? | ローカル完結の深掘り調査エージェント |
| 156 | [usekaneo/kaneo](https://github.com/usekaneo/kaneo) | 2 | 2026-08-02 → 2026-08-03 | 6103 | TypeScript | MIT | free? | Jira代替PM OSS群の軽量派 |
| 157 | [xbtlin/ai-berkshire](https://github.com/xbtlin/ai-berkshire) | 2 | 2026-06-28 → 2026-06-29 | 5238 | Python | MIT | free? | バフェット流のAIエージェント株分析 |
| 158 | [alphaXiv/OpenResearch](https://github.com/alphaXiv/OpenResearch) | 2 | 2026-09-18 → 2026-09-19 | 4912 | Rust | MIT | free? | 研究員AIエージェント化のRust製基盤 |
| 159 | [cordiverse/cordis](https://github.com/cordiverse/cordis) | 2 | 2026-08-16 → 2026-08-17 | 4682 | TypeScript | MIT | free? | プラグイン合成のメタ基盤フレーム |
| 160 | [Tencent/BrowserSkill](https://github.com/Tencent/BrowserSkill) | 2 | 2026-09-18 → 2026-09-19 | 4065 | TypeScript | MIT | free? | Tencent製の認証ブラウザ操作Skill |
| 161 | [opengeos/GeoLibre](https://github.com/opengeos/GeoLibre) | 2 | 2026-07-28 → 2026-07-30 | 3994 | TypeScript | MIT | free | 自前GISでSaaS料金を削る |
| 162 | [ComposioHQ/awesome-codex-skills](https://github.com/ComposioHQ/awesome-codex-skills) | 2 | 2026-04-28 → 2026-04-29 | 3939 | Python | ? | free? | Codex CLI用の業務自動化スキル50種超 |
| 163 | [Tencent/teamai-cli](https://github.com/Tencent/teamai-cli) | 2 | 2026-09-10 → 2026-09-11 | 3742 | TypeScript | MIT | free? | チームAI設定を配るTencent製CLI |
| 164 | [tailscale/tailcat](https://github.com/tailscale/tailcat) | 2 | 2026-08-30 → 2026-08-31 | 3449 | Go | BSD-3 | free? | Tailscale上の軽量netcat |
| 165 | [vercel-labs/open-agents](https://github.com/vercel-labs/open-agents) | 2 | 2026-04-16 → 2026-04-17 | 3257 | TypeScript | MIT | cost? | クラウドで動くAIエージェントの公式テンプレート |
| 166 | [nab138/iloader](https://github.com/nab138/iloader) | 2 | 2026-09-12 → 2026-09-13 | 3066 | TypeScript | MIT | free? | Apple配布権を分散するiOS層 |
| 167 | [macro-inc/macro](https://github.com/macro-inc/macro) | 2 | 2026-08-13 → 2026-08-15 | 3007 | Rust | AGPL | free? | メールもタスクも束ねる統合OSS |
| 168 | [lsdefine/GenericAgent](https://github.com/lsdefine/GenericAgent) | 2 | 2026-04-16 → 2026-04-17 | 2879 | Python | MIT | free? | 自分でスキルを増やしていくAIエージェント |
| 169 | [chaitanyagiri/munder-difflin](https://github.com/chaitanyagiri/munder-difflin) | 2 | 2026-08-19 → 2026-08-20 | 2646 | TypeScript | MIT | free? | 複数AI CLIを束ねる開発者GUI |
| 170 | [browserbase/skills](https://github.com/browserbase/skills) | 2 | 2026-05-03 → 2026-05-05 | 2092 | JavaScript | ? | free? | Claude Code向けブラウザ操作10種 |
| 171 | [tractorjuice/arc-kit](https://github.com/tractorjuice/arc-kit) | 2 | 2026-04-20 → 2026-04-21 | 1310 | HTML | MIT | free | AIで進める調達と統治の自動化 |
| 172 | [public-apis/public-apis](https://github.com/public-apis/public-apis) | 1 | 2026-08-17 | 461644 | Python | MIT | free | 無料APIを網羅した巨大カタログ |
| 173 | [donnemartin/system-design-primer](https://github.com/donnemartin/system-design-primer) | 1 | 2026-08-06 | 361477 | Python | CC | free? | 大規模システム設計の定番学習教材 |
| 174 | [ossu/computer-science](https://github.com/ossu/computer-science) | 1 | 2026-07-17 | 206500 | HTML | MIT | free? | 独学CS学部の決定版カリキュラム |
| 175 | [anomalyco/opencode](https://github.com/anomalyco/opencode) | 1 | 2026-09-06 | 204650 | TypeScript | MIT | free? | OSSで動くCLIコーディングagent |
| 176 | [microsoft/generative-ai-for-beginners](https://github.com/microsoft/generative-ai-for-beginners) | 1 | 2026-08-02 | 114170 | Jupyter Notebook | MIT | free? | Gen AI研修を丸ごと内製化 |
| 177 | [garrytan/gstack](https://github.com/garrytan/gstack) | 1 | 2026-06-24 | 114008 | TypeScript | MIT | free? | Garry Tan流Claude Code環境一式 |
| 178 | [VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md) | 1 | 2026-07-10 | 99576 | - | MIT | free? | 73ブランドのDESIGN.md集 |
| 179 | [puppeteer/puppeteer](https://github.com/puppeteer/puppeteer) | 1 | 2026-06-17 | 94862 | TypeScript | Apache-2.0 | free? | 10行でPDF化できる自動化基盤 |
| 180 | [nvm-sh/nvm](https://github.com/nvm-sh/nvm) | 1 | 2026-08-12 | 94471 | Shell | MIT | free? | Nodeバージョン管理の古典ツール |
| 181 | [lobehub/lobehub](https://github.com/lobehub/lobehub) | 1 | 2026-07-17 | 80146 | TypeScript | Apache-2.0 | free? | 複数エージェント24時間運用OS |
| 182 | [PaddlePaddle/PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) | 1 | 2026-06-05 | 79820 | Python | Apache-2.0 | free? | PDFを構造化するVLM OCR |
| 183 | [TapXWorld/ChinaTextbook](https://github.com/TapXWorld/ChinaTextbook) | 1 | 2026-08-09 | 77891 | Roff | ? | free? | 教科書PDFを集約する共有OSS |
| 184 | [elastic/elasticsearch](https://github.com/elastic/elasticsearch) | 1 | 2026-07-04 | 77326 | Java | AGPL | unknown | 全文とベクターを統合する老舗検索 |
| 185 | [paperclipai/paperclip](https://github.com/paperclipai/paperclip) | 1 | 2026-08-11 | 76429 | TypeScript | MIT | free | AIエージェントの運営プラットフォーム |
| 186 | [grafana/grafana](https://github.com/grafana/grafana) | 1 | 2026-06-27 | 74872 | TypeScript | AGPL | free? | Datadog代替の可観測OSS定番 |
| 187 | [bytedance/deer-flow](https://github.com/bytedance/deer-flow) | 1 | 2026-06-24 | 73867 | Python | MIT | free | ByteDance製の長尺エージェント |
| 188 | [666ghj/MiroFish](https://github.com/666ghj/MiroFish) | 1 | 2026-09-15 | 73094 | Python | AGPL | cost? | 汎用の群体知能予測エンジンOSS |
| 189 | [NanmiCoder/MediaCrawler](https://github.com/NanmiCoder/MediaCrawler) | 1 | 2026-08-11 | 60964 | Python | ? | free? | 中国SNS 7社の学習用クローラー |
| 190 | [makeplane/plane](https://github.com/makeplane/plane) | 1 | 2026-08-25 | 57892 | TypeScript | AGPL | free? | Jira代替のOSSプロジェクト管理 |
| 191 | [santifer/career-ops](https://github.com/santifer/career-ops) | 1 | 2026-07-03 | 57752 | JavaScript | MIT | cost? | AI CLI連携の求職支援14モード |
| 192 | [microsoft/ai-agents-for-beginners](https://github.com/microsoft/ai-agents-for-beginners) | 1 | 2026-04-22 | 57587 | Jupyter Notebook | MIT | free? | 有料講座を置き換えるAI教材集 |
| 193 | [jingyaogong/minimind](https://github.com/jingyaogong/minimind) | 1 | 2026-09-02 | 57006 | Python | Apache-2.0 | free? | 2時間で64M LLMを1から学習 |
| 194 | [MemPalace/mempalace](https://github.com/MemPalace/mempalace) | 1 | 2026-06-07 | 54247 | Python | MIT | free | OSSのClaude Code向け長期記憶 |
| 195 | [anthropics/claude-cookbooks](https://github.com/anthropics/claude-cookbooks) | 1 | 2026-07-26 | 49854 | Jupyter Notebook | MIT | free? | Anthropic公式Claudeレシピ集 |
| 196 | [hashicorp/terraform](https://github.com/hashicorp/terraform) | 1 | 2026-07-12 | 49350 | Go | BSL-1.1 | free? | インフラをコードで管理する定番 |
| 197 | [prisma/prisma](https://github.com/prisma/prisma) | 1 | 2026-07-09 | 46528 | TypeScript | Apache-2.0 | free? | Node.js向けの型安全ORM老舗 |
| 198 | [datawhalechina/hello-agents](https://github.com/datawhalechina/hello-agents) | 1 | 2026-05-10 | 45640 | Python | CC | free? | 16章で体系化する自作エージェント教材 |
| 199 | [microsoft/VibeVoice](https://github.com/microsoft/VibeVoice) | 1 | 2026-04-29 | 44703 | Python | MIT | free? | MIT発のオープン音声AIスタック |
| 200 | [stablyai/orca](https://github.com/stablyai/orca) | 1 | 2026-08-13 | 43793 | TypeScript | MIT | free? | 5並列エージェント制御ADE |
| 201 | [danny-avila/LibreChat](https://github.com/danny-avila/LibreChat) | 1 | 2026-09-16 | 43785 | TypeScript | MIT | free? | マルチAI対応のChatGPT代替 |
| 202 | [calcom/cal.diy](https://github.com/calcom/cal.diy) | 1 | 2026-05-18 | 43228 | TypeScript | MIT | free? | Cal.comの完全MITフォーク |
| 203 | [roboflow/supervision](https://github.com/roboflow/supervision) | 1 | 2026-06-10 | 42944 | Python | MIT | free? | 受託CV案件の立ち上げ工数を圧縮 |
| 204 | [blader/humanizer](https://github.com/blader/humanizer) | 1 | 2026-09-05 | 42646 | Python | MIT | free? | AI 生成の痕跡を消して量産へ |
| 205 | [KeygraphHQ/shannon](https://github.com/KeygraphHQ/shannon) | 1 | 2026-04-23 | 39525 | TypeScript | AGPL | free? | AI実証型のWeb自動ペンテスト |
| 206 | [paperless-ngx/paperless-ngx](https://github.com/paperless-ngx/paperless-ngx) | 1 | 2026-04-21 | 39383 | Python | GPL | free? | 紙をゼロにする文書管理サーバー |
| 207 | [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api) | 1 | 2026-08-23 | 38773 | Go | LGPL | free | AIサブスクを1本のAPIに束ねる中継 |
| 208 | [mattermost/mattermost](https://github.com/mattermost/mattermost) | 1 | 2026-06-13 | 37608 | TypeScript | Apache-2.0 | free? | 自前で建てるSlack代替の会話層 |
| 209 | [schollz/croc](https://github.com/schollz/croc) | 1 | 2026-07-23 | 37529 | Go | MIT | free? | 自社ホスト可の暗号化転送CLI |
| 210 | [IceWhaleTech/CasaOS](https://github.com/IceWhaleTech/CasaOS) | 1 | 2026-06-28 | 35760 | Go | Apache-2.0 | free? | 1クリック導入の自宅クラウドOS |
| 211 | [aquasecurity/trivy](https://github.com/aquasecurity/trivy) | 1 | 2026-06-04 | 35373 | Go | Apache-2.0 | free? | コンテナを検査するセキュリティ層 |
| 212 | [bytedance/UI-TARS-desktop](https://github.com/bytedance/UI-TARS-desktop) | 1 | 2026-05-10 | 31353 | TypeScript | Apache-2.0 | free? | ローカル動作のGUI操作エージェント |
| 213 | [Gitlawb/openclaude](https://github.com/Gitlawb/openclaude) | 1 | 2026-09-02 | 31243 | TypeScript | MIT | cost? | マルチLLM対応のClaude Code代替 |
| 214 | [esengine/DeepSeek-Reasonix](https://github.com/esengine/DeepSeek-Reasonix) | 1 | 2026-08-04 | 29868 | Go | MIT | free? | DeepSeek特化のCLIエージェント |
| 215 | [modular/modular](https://github.com/modular/modular) | 1 | 2026-08-21 | 27887 | Mojo | Apache-2.0 | free? | Python感覚で書けるMojo+MAX |
| 216 | [aishwaryanr/awesome-generative-ai-guide](https://github.com/aishwaryanr/awesome-generative-ai-guide) | 1 | 2026-06-20 | 27592 | HTML | MIT | free? | 面接対策まで揃う生成AI教材集 |
| 217 | [jenkinsci/jenkins](https://github.com/jenkinsci/jenkins) | 1 | 2026-07-29 | 26059 | Java | MIT | free? | 自前運用CI/CDの定番Jenkins |
| 218 | [trycua/cua](https://github.com/trycua/cua) | 1 | 2026-09-22 | 25667 | HTML | MIT | free? | computer-useの自前運用OSS |
| 219 | [langfuse/langfuse](https://github.com/langfuse/langfuse) | 1 | 2026-04-23 | 25568 | TypeScript | MIT | free? | LLMアプリの観測と評価の基盤 |
| 220 | [supermemoryai/supermemory](https://github.com/supermemoryai/supermemory) | 1 | 2026-06-02 | 23922 | TypeScript | MIT | free | AI記憶ベンチで3冠の共通API |
| 221 | [virattt/dexter](https://github.com/virattt/dexter) | 1 | 2026-05-06 | 23720 | TypeScript | ? | cost? | Bloomberg代替の財務AIエージェント |
| 222 | [k1tbyte/Wand-Enhancer](https://github.com/k1tbyte/Wand-Enhancer) | 1 | 2026-09-01 | 23339 | C# | Apache-2.0 | free | WeMod用UX拡張とリモート操作パネル |
| 223 | [PrefectHQ/prefect](https://github.com/PrefectHQ/prefect) | 1 | 2026-07-13 | 23123 | Python | Apache-2.0 | free? | Python向けワークフローOSS基盤 |
| 224 | [goauthentik/authentik](https://github.com/goauthentik/authentik) | 1 | 2026-08-07 | 23066 | Python | MIT | free? | Okta代替の自ホスト型SSO基盤 |
| 225 | [alibaba/page-agent](https://github.com/alibaba/page-agent) | 1 | 2026-07-05 | 23064 | TypeScript | MIT | free? | RPAを置き換える自然言語UI |
| 226 | [gastownhall/beads](https://github.com/gastownhall/beads) | 1 | 2026-04-28 | 22158 | Go | MIT | free? | AIエージェント用の永続メモリ層 |
| 227 | [google-labs-code/design.md](https://github.com/google-labs-code/design.md) | 1 | 2026-06-27 | 21142 | TypeScript | Apache-2.0 | free? | AI生成UIに使う設計仕様書OSS |
| 228 | [catchorg/Catch2](https://github.com/catchorg/Catch2) | 1 | 2026-07-12 | 21002 | C++ | MIT | free? | C++向けの現代的テストフレーム |
| 229 | [smicallef/spiderfoot](https://github.com/smicallef/spiderfoot) | 1 | 2026-08-15 | 20918 | Python | MIT | free? | 200種の攻撃面マッピングOSS |
| 230 | [yorukot/superfile](https://github.com/yorukot/superfile) | 1 | 2026-07-28 | 20841 | Go | MIT | free? | GoでカラフルなTUIファイラー |
| 231 | [mksglu/context-mode](https://github.com/mksglu/context-mode) | 1 | 2026-09-08 | 20783 | TypeScript | Elastic-2.0 | free | Context代を圧縮するMCP |
| 232 | [pranshuparmar/witr](https://github.com/pranshuparmar/witr) | 1 | 2026-08-10 | 20587 | Go | Apache-2.0 | free? | プロセス起源を辿るGo製CLI |
| 233 | [alirezarezvani/claude-skills](https://github.com/alirezarezvani/claude-skills) | 1 | 2026-07-06 | 20510 | Python | MIT | free? | 13エディタ対応のskill 354本 |
| 234 | [kvcache-ai/ktransformers](https://github.com/kvcache-ai/ktransformers) | 1 | 2026-07-20 | 18322 | Python | Apache-2.0 | free? | MoEを24GBで動かす枠組み |
| 235 | [HKUDS/RAG-Anything](https://github.com/HKUDS/RAG-Anything) | 1 | 2026-04-24 | 18108 | Python | MIT | free | 文書・図表・数式のマルチモーダルRAG |
| 236 | [Open-Dev-Society/OpenStock](https://github.com/Open-Dev-Society/OpenStock) | 1 | 2026-09-22 | 17660 | TypeScript | AGPL | cost? | Bloombergの無料代替株式OSS |
| 237 | [influxdata/telegraf](https://github.com/influxdata/telegraf) | 1 | 2026-05-14 | 16980 | Go | MIT | free? | 監視SaaSを置き換えるOSS収集器 |
| 238 | [coder/coder](https://github.com/coder/coder) | 1 | 2026-09-22 | 16395 | Go | AGPL | free | 自社にCodespacesを持つGo基盤 |
| 239 | [andrewyng/aisuite](https://github.com/andrewyng/aisuite) | 1 | 2026-07-29 | 15662 | Python | MIT | free? | Andrew Ng発のLLM抽象化層 |
| 240 | [danielmiessler/Personal_AI_Infrastructure](https://github.com/danielmiessler/Personal_AI_Infrastructure) | 1 | 2026-06-07 | 14929 | TypeScript | MIT | free? | セキュリティ専門家のAI個人OS |
| 241 | [pytest-dev/pytest](https://github.com/pytest-dev/pytest) | 1 | 2026-06-15 | 14016 | Python | MIT | unknown | Python案件の保守費を下げる定番テスト |
| 242 | [zedeus/nitter](https://github.com/zedeus/nitter) | 1 | 2026-08-28 | 13843 | Nim | AGPL | free | Twitter代替フロントエンド |
| 243 | [amnezia-vpn/amnezia-client](https://github.com/amnezia-vpn/amnezia-client) | 1 | 2026-07-28 | 13775 | C++ | GPL | free? | 自前サーバーで建てる検閲耐性VPN |
| 244 | [iOfficeAI/OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) | 1 | 2026-07-10 | 13353 | C# | Apache-2.0 | free? | Office文書を操るMCPサーバ |
| 245 | [yikart/AiToEarn](https://github.com/yikart/AiToEarn) | 1 | 2026-05-14 | 12862 | TypeScript | MIT | free? | 13 SNSへ自動投稿する運用基盤 |
| 246 | [megadose/holehe](https://github.com/megadose/holehe) | 1 | 2026-08-15 | 12820 | Python | GPL | free? | メール調査OSINT用CLIツール |
| 247 | [AgriciDaniel/claude-obsidian](https://github.com/AgriciDaniel/claude-obsidian) | 1 | 2026-08-26 | 12669 | Python | MIT | free? | Obsidian連携のナレッジ整理AI |
| 248 | [cupy/cupy](https://github.com/cupy/cupy) | 1 | 2026-06-30 | 11802 | Python | MIT | free? | NumPyとSciPyのGPU版ライブラリ |
| 249 | [BasedHardware/omi](https://github.com/BasedHardware/omi) | 1 | 2026-04-19 | 10516 | Dart | MIT | free? | 画面と会話を全部覚えるAIアシスタント |
| 250 | [majd/ipatool](https://github.com/majd/ipatool) | 1 | 2026-09-01 | 10512 | Go | MIT | free? | App StoreからipaをCLI取得 |
| 251 | [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys) | 1 | 2026-07-31 | 10419 | JavaScript | MIT | free? | WhatsApp公式APIの代替ライブラリ |
| 252 | [AIDC-AI/Pixelle-Video](https://github.com/AIDC-AI/Pixelle-Video) | 1 | 2026-05-04 | 9873 | Python | Apache-2.0 | free? | テーマ入力で動画まで一気通貫生成 |
| 253 | [github/copilot-sdk](https://github.com/github/copilot-sdk) | 1 | 2026-07-18 | 9784 | Java | MIT | free? | AI組込を1週間で構造化する公式SDK |
| 254 | [MoonTechLab/LunaTV](https://github.com/MoonTechLab/LunaTV) | 1 | 2026-09-08 | 9685 | TypeScript | CC | free? | 多源検索のセルフホスト動画UI |
| 255 | [jo-inc/camofox-browser](https://github.com/jo-inc/camofox-browser) | 1 | 2026-09-08 | 9631 | JavaScript | MIT | free | 検知を抜けるStealth Browser |
| 256 | [InsForge/InsForge](https://github.com/InsForge/InsForge) | 1 | 2026-05-08 | 8826 | TypeScript | Apache-2.0 | free? | AI向けPostgresバックエンド |
| 257 | [datawhalechina/easy-vibe](https://github.com/datawhalechina/easy-vibe) | 1 | 2026-05-10 | 8489 | JavaScript | ? | free? | vibe coding時代の初学者向け教材 |
| 258 | [actions/checkout](https://github.com/actions/checkout) | 1 | 2026-07-04 | 8257 | TypeScript | MIT | free? | GitHub Actionsの基盤アクション |
| 259 | [bwya77/vscode-dark-islands](https://github.com/bwya77/vscode-dark-islands) | 1 | 2026-05-06 | 7820 | PowerShell | ? | free? | JetBrains風のVSCodeテーマ |
| 260 | [google-deepmind/weathernext](https://github.com/google-deepmind/weathernext) | 1 | 2026-08-10 | 7055 | Python | Apache-2.0 | free? | DeepMindの気象予測AI後継版 |
| 261 | [google-labs-code/stitch-skills](https://github.com/google-labs-code/stitch-skills) | 1 | 2026-07-12 | 7038 | TypeScript | Apache-2.0 | free? | Stitch用Agent Skillsライブラリ |
| 262 | [HenryNdubuaku/maths-cs-ai-compendium](https://github.com/HenryNdubuaku/maths-cs-ai-compendium) | 1 | 2026-07-18 | 6588 | TypeScript | Apache-2.0 | free? | AI人材育成費を消す無料の教科書 |
| 263 | [PriorLabs/TabPFN](https://github.com/PriorLabs/TabPFN) | 1 | 2026-05-07 | 6557 | Python | Apache-2.0 | free? | 表データ向けの基盤モデルOSS |
| 264 | [deepseek-ai/DeepGEMM](https://github.com/deepseek-ai/DeepGEMM) | 1 | 2026-04-19 | 6556 | Cuda | MIT | free? | LLM向けFP8行列演算カーネル |
| 265 | [jbeder/yaml-cpp](https://github.com/jbeder/yaml-cpp) | 1 | 2026-07-11 | 6072 | C++ | MIT | free? | C++で定番のYAMLパーサ実装 |
| 266 | [sngyai/Sequoia-X](https://github.com/sngyai/Sequoia-X) | 1 | 2026-09-03 | 6019 | Python | ? | free? | 中国A株を自動選別する軽量ボット |
| 267 | [BuilderIO/agent-native](https://github.com/BuilderIO/agent-native) | 1 | 2026-09-22 | 5851 | TypeScript | ? | free? | エージェントとUIを一体化するTS基盤 |
| 268 | [CoreBunch/Instatic](https://github.com/CoreBunch/Instatic) | 1 | 2026-07-27 | 5622 | TypeScript | MIT | free? | Webflow置換のOSS CMS |
| 269 | [tech-leads-club/agent-skills](https://github.com/tech-leads-club/agent-skills) | 1 | 2026-09-14 | 5609 | TypeScript | MIT | free? | AI開発者の共通スキルレジストリ |
| 270 | [lukilabs/craft-agents-oss](https://github.com/lukilabs/craft-agents-oss) | 1 | 2026-05-01 | 5550 | TypeScript | Apache-2.0 | free | 文書中心のエージェントデスクトップ |
| 271 | [abue-ammar/tinycast](https://github.com/abue-ammar/tinycast) | 1 | 2026-09-17 | 5546 | Swift | AGPL | free? | Electron無しmacOSランチャー |
| 272 | [EvoMap/evolver](https://github.com/EvoMap/evolver) | 1 | 2026-04-19 | 5055 | JavaScript | GPL | free? | AIエージェントのプロンプト進化エンジン |
| 273 | [ibelick/ui-skills](https://github.com/ibelick/ui-skills) | 1 | 2026-07-19 | 4969 | TypeScript | MIT | free? | デザインエンジニア向けのUIスキル集 |
| 274 | [likec4/likec4](https://github.com/likec4/likec4) | 1 | 2026-07-23 | 4249 | TypeScript | MIT | free? | DSLで書く生きたC4アーキ図 |
| 275 | [revfactory/harness](https://github.com/revfactory/harness) | 1 | 2026-05-31 | 4232 | HTML | Apache-2.0 | free? | AIエージェント設計のmeta-skill |
| 276 | [zai-org/GLM-5](https://github.com/zai-org/GLM-5) | 1 | 2026-06-19 | 4087 | - | Apache-2.0 | free? | 中国製のコーディング特化LLM |
| 277 | [z-lab/dflash](https://github.com/z-lab/dflash) | 1 | 2026-05-08 | 3454 | Python | MIT | free? | 並列下書きでLLMを高速化するOSS |
| 278 | [kunchenguid/no-mistakes](https://github.com/kunchenguid/no-mistakes) | 1 | 2026-06-27 | 3388 | Go | MIT | free? | git push前にAI検査するOSS |
| 279 | [apache/maka](https://github.com/apache/maka) | 1 | 2026-08-26 | 3296 | TypeScript | Apache-2.0 | free? | ローカル完結AIエージェント基盤 |
| 280 | [huggingface/ml-intern](https://github.com/huggingface/ml-intern) | 1 | 2026-04-24 | 3096 | Python | Apache-2.0 | cost? | HF製・自律型ML研究エージェント |
| 281 | [vitali87/code-graph-rag](https://github.com/vitali87/code-graph-rag) | 1 | 2026-08-10 | 2950 | Python | MIT | free? | monorepo全体をAIで問えるRAG |
| 282 | [vastsa/PI-Desktop](https://github.com/vastsa/PI-Desktop) | 1 | 2026-09-12 | 2759 | TypeScript | LGPL | free? | AI IDE群と並ぶ中立ホスト |
| 283 | [maziyarpanahi/openmed](https://github.com/maziyarpanahi/openmed) | 1 | 2026-06-12 | 2721 | Python | Apache-2.0 | free? | オンデバイス完結のオープン医療AI |
| 284 | [NVIDIA/SkillSpector](https://github.com/NVIDIA/SkillSpector) | 1 | 2026-06-12 | 2588 | Python | Apache-2.0 | free | NVIDIA製のskill用脆弱性scanner |
| 285 | [facebook/astryx](https://github.com/facebook/astryx) | 1 | 2026-07-02 | 2540 | TypeScript | MIT | free? | Meta由来のReact設計システム |
| 286 | [mahlernim/google-timeline-visualizer](https://github.com/mahlernim/google-timeline-visualizer) | 1 | 2026-08-22 | 2194 | Kotlin | MIT | cost? | 移動履歴を動画化するローカルアプリ |
| 287 | [dotnet/skills](https://github.com/dotnet/skills) | 1 | 2026-05-22 | 2161 | C# | MIT | free? | Microsoft公式の.NET用スキル集 |
| 288 | [huangruiteng/loopx](https://github.com/huangruiteng/loopx) | 1 | 2026-08-06 | 2061 | Python | Apache-2.0 | free? | AIエージェント長期作業の状態管理層 |
| 289 | [JetBrains/go-modern-guidelines](https://github.com/JetBrains/go-modern-guidelines) | 1 | 2026-08-28 | 2050 | Go | Apache-2.0 | free? | AI向けGo作法をJetBrainsが公開 |
| 290 | [SmartlyDressedGames/U3-SDK](https://github.com/SmartlyDressedGames/U3-SDK) | 1 | 2026-07-10 | 1983 | C# | ? | free? | Unturnedのフルソース公開 |
| 291 | [music-assistant/server](https://github.com/music-assistant/server) | 1 | 2026-06-13 | 1759 | Python | Apache-2.0 | free? | 家の音楽を束ねるメディアサーバ |
| 292 | [openai/plugins](https://github.com/openai/plugins) | 1 | 2026-06-07 | 1751 | JavaScript | ? | free? | OpenAI公式のCodexプラグイン集 |
| 293 | [anthropics/claude-plugins-community](https://github.com/anthropics/claude-plugins-community) | 1 | 2026-08-26 | 1714 | Python | Apache-2.0 | free? | Claude公式プラグインマーケット |
| 294 | [alsk1992/CloddsBot](https://github.com/alsk1992/CloddsBot) | 1 | 2026-09-11 | 1598 | TypeScript | MIT | free | 1000市場を回すClaude製bot |
| 295 | [apache/ossie](https://github.com/apache/ossie) | 1 | 2026-07-19 | 1260 | Python | Apache-2.0 | free? | KPI定義を統一するセマンティック仕様 |
| 296 | [uber/ADR](https://github.com/uber/ADR) | 1 | 2026-08-05 | 657 | Python | Apache-2.0 | cost? | 大企業向けAIエージェント監視基盤 |
| 297 | [Lordog/dive-into-llms](https://github.com/Lordog/dive-into-llms) | 1 | 2026-04-15 | - | - | ? | free? | 手を動かして学ぶ大規模言語モデル入門教材 |
| 298 | [multica-ai/multica](https://github.com/multica-ai/multica) | 1 | 2026-04-12 | - | - | Apache-2.0 | free? | AIエージェントをチームメイトとして管理するプラットフォーム |

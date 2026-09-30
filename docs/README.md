# weaponx ドキュメント

資料の管理をアプリが引き受け、案件・参考資料・版を作った時点で記録する。資料が増えても「どれが最新で、何を参考にしたか」が一覧で分かる資料管理ツール。

## 読み順

初めて読む人は次の順に読む。

1. `design-spec.md` — 何を作るか(画面・振る舞い・用語)
2. `01_prd.md` — なぜ作るか、誰のどんな課題か、何を作らないか
3. `02-01_system-design-doc.md` — どう作るか(技術スタックの判断、API、データモデル、セキュリティ)
4. `03_dev-setup.md` — 手元で動かす
5. 運用する人は `04_deployment-procedure.md` → `05_operation-runbook.md`

## ドキュメント一覧

| ファイル | 内容 |
|----------|------|
| [design-spec.md](design-spec.md) | 設計仕様書。画面一覧・ロール・画面ごとの振る舞いと文言・デザインの方針・デモデータ |
| [screen_flow.mermaid](screen_flow.mermaid) | 画面遷移図(design-spec の画面一覧と対応) |
| [01_prd.md](01_prd.md) | PRD。背景と目的、ターゲットと課題、ユーザーストーリー、KPI、スコープ外 |
| [02-01_system-design-doc.md](02-01_system-design-doc.md) | System Design Doc。アーキテクチャ、ADR、ルーティング、API、データモデル、権限マトリクス、エラー、i18n、テスト、監視 |
| [02-02_feature-design-doc.md](02-02_feature-design-doc.md) | 変更サイクル用の Feature Design Doc のテンプレート(記入しない) |
| [03_dev-setup.md](03_dev-setup.md) | 開発環境(Docker Compose)、環境変数、make のターゲット、ブランチ戦略・リリースフロー |
| [04_deployment-procedure.md](04_deployment-procedure.md) | 初回のクラウド設定、CI/CD、リリース前チェック、ロールバック |
| [05_operation-runbook.md](05_operation-runbook.md) | ログ・アラート、よくある障害と対処、定期メンテナンス、KPI の測り方 |
| [06_design-tokens.json](06_design-tokens.json) | デザイントークン(DTCG 形式。色はライト・ダークの2組) |
| [concept.md](concept.md) | Phase 0 のコンセプトメモ(経緯の記録) |
| [brainstorm-notes.md](brainstorm-notes.md) | Phase 1 の壁打ちメモ(経緯の記録。冒頭に Phase 2 での見直し) |

## ドキュメント体系

### 3つの層

| 層 | ファイル | 扱い |
|----|---------|------|
| ソース(正) | `design-spec.md`、`screen_flow.mermaid`、`01_prd.md`、`02-01_system-design-doc.md`、`03_dev-setup.md`、`04_deployment-procedure.md`、`05_operation-runbook.md`、`06_design-tokens.json` | 事実を持つ。変更はここを直す |
| 派生 | `CLAUDE.md`、`docs/claude-code-prompts.md`(Phase 4 で作る)、`apps/web/src/styles/tokens.css`(`make tokens` で生成) | ソースから作る。直接直さず、ソースを直して作り直す |
| アーカイブ | `concept.md`、`brainstorm-notes.md`、実装済みの `features/` の Feature Design Doc | 経緯の記録。後から書き換えない。食い違ったらソースが正 |

### 事実の所有権

同じ事実は1か所にだけ書き、他のドキュメントは参照する。

| 事実 | 所有するドキュメント |
|------|---------------------|
| 画面の存在・目的・レイアウト・認証要否、振る舞い、文言、用語 | `design-spec.md` |
| 画面遷移 | `screen_flow.mermaid` |
| デザインの方針(トーン・色の方向性・モード対応・密度) | `design-spec.md` 4.4 |
| デザイントークンの具体値(色コード・フォントサイズ・余白 等) | `06_design-tokens.json` |
| 背景・目的・ユーザーストーリー・KPI・スコープ外 | `01_prd.md`(スコープ外の詳細は `design-spec.md` 9章) |
| 技術スタックと判断理由(ADR)、ルーティング、API、データモデル、権限マトリクス、エラーコード、i18n の仕組み | `02-01_system-design-doc.md` |
| 実行するコマンド | `Makefile`(ドキュメントはターゲット名だけを書く) |
| 環境変数、開発環境、ブランチ戦略・コミットの規約 | `03_dev-setup.md` |
| インフラの構成(リソースの実体) | `infra/`(Terraform) |
| デプロイ・ロールバックの手順 | `04_deployment-procedure.md` |
| 監視・アラート・障害対応の手順 | `05_operation-runbook.md` |

## features/

機能の追加・変更・修正の Feature Design Doc は、`docs/features/YYYYMMDD-HHMM_{機能名}.md` として時系列で溜まる(`/draft:feature` で作る)。テンプレートは `02-02_feature-design-doc.md`。実装が終わった FDD はアーカイブで、変更の結果はソースのドキュメントに反映する。

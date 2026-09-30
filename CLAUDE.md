# weaponx

案件ごとに増えるスライドとドキュメントを、作った時点で「どの案件か・何を参考にしたか・どれの新しい版か」を記録して管理するツール。資料の実体は Google ドライブなど元の場所に置いたまま、アプリは管理に徹する。

## Tech Stack

- Frontend: React + Vite / TypeScript / TanStack Router・TanStack Query / Tailwind CSS v4 + Radix UI / react-i18next(日本語・英語)
- Backend: Elysia.js(Bun)/ TypeScript / 入力検証は TypeBox / Drizzle ORM(postgres.js)/ 画面からは Eden Treaty で型付きに呼ぶ
- DB: PostgreSQL 16(本番は Cloud SQL、ローカルは Docker Compose)
- Auth: Google OAuth 2.0 / OIDC を Arctic で扱い、セッションは DB に持つ(Cookie `wx_session`)。ドライブの許可は `drive.file` だけで、アプリがまだ使えないファイルは Google Picker で選んでもらう。ローカルとテストは開発用ログインとドライブの模擬で Google なしに動く
- Infra: GCP asia-northeast1。外部アプリケーション LB + Cloud Armor から Cloud Run(API)と Cloud Storage + CDN(画面)へ振り分ける。Cloud SQL、Secret Manager
- IaC: Terraform(state は GCS)
- CI/CD: GitHub Actions + Workload Identity 連携。リリースは `deploy/production/version` を更新する promotion PR のマージで行う
- Monorepo: Bun workspaces
- Local: Docker Compose に閉じる。手元に要るのは Docker・make・git だけ
- Test: bun test(画面の部品は Testing Library + happy-dom)、Playwright
- Lint/Format: Biome

## Structure

- apps/api: API(Elysia)。`src/routes`・`src/domain`(業務ルール)・`src/db`(schema.ts)・`src/drive`(本物と模擬)・`src/auth`・`src/lib`、`drizzle/`(マイグレーション)、`scripts/`(migrate・seed・bootstrap-admin)、`test/`(結合テスト)
- apps/web: 画面(React SPA)。`src/routes`・`src/features`・`src/components`・`src/lib`(Eden・i18n・Picker)・`src/locales`(ja/en)・`src/styles`(`tokens.css` は生成物)
- packages/shared: 画面と API で共有する規則(入力の上限、正規化、リンクの判定、エラーコード)
- e2e/: Playwright
- infra/: Terraform
- deploy/production/version: 本番で動くべきバージョン
- docker/、compose.yaml: 開発環境(サービスは db・api・web・tools・e2e・ops)
- scripts/: gen-tokens.ts、doc-lint.sh
- 全体のツリーは docs/03_dev-setup.md 2章

## Key Design Decisions

- 記録した事実だけを扱う。関連は推測せず、本文は保存しない。元の場所のファイルは消さない・書き換えない(利用者の操作でドライブに新しく作る・コピーするのだけが例外)。Google の資料の名前は元の場所が正で、アプリでは書き換えない
- 正しさは DB で守る(ADR-013)。版番号の採番・リンクの重複・オーナーと管理者が1人以上・件数の上限は、保存と同じトランザクションの中で行ロック・部分一意インデックス・advisory lock を使って守る。アプリのメモリに正しさに関わる状態を持たない(例外は Google のアクセストークンのキャッシュと、開発用のドライブの模擬)
- 認可の照合先は `docs/02-01_system-design-doc.md` 7章の権限マトリクス。不参加・削除済みの案件は 404 `PROJECT_NOT_FOUND` にして存在を漏らさない。管理者であることは案件の権限を足さない。見る権限のない・削除された関連資料は名前も ID も返さない
- API は文言を返さず、エラーコードを返す(02-01 8章)。画面は code を design-spec 6.0.2 の5分類に当てはめて振る舞い、文言は翻訳ファイルから選ぶ。入力の上限・正規化・リンクの判定は `packages/shared` に置き、画面と API で同じ規則を使う
- 資料名とリンクは業務上の秘密として扱う。アプリのログに資料名・リンク・メール・トークン・Cookie・リクエスト本文を出さない(02-01 7章「ログ」)

## Commands

<!-- Makefileが実コマンドの唯一の真実源。ここには標準ターゲット名だけを書き、生コマンド（bun等）を複製しない。 -->

どれも Docker Compose のコンテナの中で動く。全ターゲットは docs/03_dev-setup.md 8章。

- `make setup`: 初回セットアップ(.env、イメージ、依存、DB のマイグレーションとデモデータ、tokens.css、git フック)
- `make dev` / `make stop`: 開発環境(DB・API・画面)の起動 / 停止。画面は http://localhost:5173
- `make build`: 画面の静的ファイルと API のイメージのビルド
- `make test`: 単体・結合テスト(テスト用 DB を作り直してから流す)
- `make e2e` / `make e2e-report`: E2E(Playwright)/ 直前のレポートの表示
- `make lint` / `make format` / `make typecheck`: Biome の Lint / Biome の整形 / 型チェック
- `make tokens`: `docs/06_design-tokens.json` から `apps/web/src/styles/tokens.css` を生成する
- `make db-generate`: スキーマの変更からマイグレーション(SQL)を生成する(拡張の作成など手書きが要るときは `CUSTOM=1`)
- `make db-migrate` / `make db-push`: マイグレーションの適用 / スキーマの直接反映(試行錯誤用)
- `make db-seed` / `make db-reset`: デモデータの投入 / 開発用 DB の作り直し(どちらも既存のデータを消す)
- `make db-studio` / `make db-psql`: Drizzle Studio / psql
- `make shell`: tools のコンテナのシェル
- `make doc-lint`: ドキュメントと実体の整合検査(コミット前の検査は pre-commit フックが `scripts/doc-lint.sh --staged` で行う)

## Docs

Detailed specifications are in `docs/`. This file and `docs/claude-code-prompts.md` are derived from `docs/`; if they disagree, `docs/` is the source of truth. どの事実をどのドキュメントが持つかは `docs/README.md` の「事実の所有権」にある:

- docs/design-spec.md: 画面・ロール・振る舞い・文言・用語・デザインの方針・デモデータ
- docs/screen_flow.mermaid: 画面遷移
- docs/01_prd.md: 背景と目的、ユーザーストーリー、KPI、スコープ外
- docs/02-01_system-design-doc.md: アーキテクチャ、ADR、ルーティング、API、データモデル、権限マトリクス、エラーコード、i18n、テスト戦略
- docs/02-02_feature-design-doc.md: 変更サイクルの Feature Design Doc のテンプレート
- docs/03_dev-setup.md: 開発環境、環境変数、make のターゲット、ブランチ戦略、コミットと PR の規約
- docs/04_deployment-procedure.md: 初回のクラウド設定、CI/CD、リリース前チェック、ロールバック
- docs/05_operation-runbook.md: ログ、アラート、障害対応、KPI の測り方
- docs/06_design-tokens.json: Design tokens (DTCG形式。色・タイポグラフィ・余白などスタイリング値の正。実装のCSS変数・テーマ設定はここから派生させ、セマンティック層のみ参照する)
- docs/claude-code-prompts.md: 実装のステップ(進捗は各 Step の `Status:` 行)

## Implementation Rules

- **先送りしない。完了とは残作業がゼロの状態。** TODO/FIXMEコメント、固定値やモックを返す仮実装、握りつぶした例外、通していない経路、完了報告の「今後の課題」節は、すべて先送りの言い換えでしかない。禁止しているのは形ではなく先送りそのもの。残したくなったら設計に曖昧さがあるサインなので、実装を止めて確認し、設計ドキュメントに反映してから実装する。設計で決めたドライブの模擬と開発用ログイン(design-spec 8章、02-01 5.10)は仮実装ではなく、本物と同じインターフェースの正式な部品として作る
- **設計の不備を実装で回避しない。** 「設計ドキュメントの記述では要件が満たせない・記述同士が矛盾している・必要な決定が欠けている」と気づいたら、実装側の回避策で辻褄を合わせて進まない。手を止めて不備の内容・影響・直し方を提示し、合意の上で設計ドキュメントを直してから、直った設計を入力に実装を再開する
- **スコープを黙って縮めない。** 縮める判断はユーザーのもの。合意を取り、残りをドキュメントに書き出してから完了とする
- **合意を求めることを完了の代わりにしない。** 合意が要るのはユーザーのスコープを縮めるときだけ。自分の変更が作った穴・自分で見つけた欠陥は、「これも直しますか」と聞かずにその場で閉じる。それは縮小ではなく完了条件
- **残すときは、閉じられない理由を具体的に挙げる。** 「後で」ではなく何がブロックしているか(ユーザーの決定が要る/認証情報や外部リソースが無い/別の作業に依存する)を、先送りするその時点で述べる。理由を具体的に挙げられないなら閉じられるということなので閉じる。残す先はリポジトリ内のファイルだけ。ファイルに書かれていないものは残っておらず、消えている(チャットや完了報告での言及は記録ではない)
- **場当たり的な修正をしない。** エラーやバグは症状を抑えるパッチではなく、根本原因を特定し、原因と修正方針を提示してから直す。症状だけ抑えるパッチは原因の解決を後ろに送る先送りの一形態。設計に関わる修正はユーザーの合意を得てから行う
- **コマンドは make 経由で動かす。** 手元(ホスト)で bun・node・drizzle-kit・terraform・gcloud を直接実行しない(`make shell`・`make ops-shell` で入ったコンテナの中は可)。`node_modules` はコンテナ(Linux)用なので、手元で依存をインストールすると壊れる。コマンドを足す・変えるときは Makefile と docs/03_dev-setup.md 8章を一緒に直す
- **スキーマはマイグレーションで変える。** `make db-generate` で生成した SQL を確かめてからコミットする。マイグレーションは1つ前の版の API でも動く追加的な変更に限る(docs/04_deployment-procedure.md 5章)
- **コメントはコードから読み取れないことだけを書く。** 処理の言い換え(`// ユーザーを取得する` の直後に `getUser()`)は書かない。書くのは「なぜこの実装なのか」「不変条件」「外部制約」「呼び出し側の契約」。密度と体裁は周囲の既存コードに合わせる
- **不要になった `.gitkeep` は削除する。** ディレクトリに実ファイルを追加したら、その中の `.gitkeep` を消す
- **自動メモリに docs/ が所有する事実を転記しない。** MEMORY.md等、ツールがセッション外に蓄積するメモが対象。食い違ったらソースDocが正
- **実装セッションに本番環境の資格情報を渡さない。** 本番への操作は `docs/04_deployment-procedure.md` の手順で行う(セッションが本番リソースへ直接触れる構成にしない)
- **破壊的操作は実行前に明示して確認を取る。** `make clean`、`rm -rf`、本番リソースの変更は、対象と影響を提示してユーザーの確認を得てから実行する。ローカルの開発用 DB とテスト用 DB はデモデータから作り直せる使い捨てとして扱い、`make db-seed`・`make db-reset`・`make test` は確認なしで実行してよい

## Code Style

- Conventional Commits: feat:, fix:, refactor:, docs:, chore:
- コミットメッセージの言語: 英語(サブジェクト・本文とも)
- コミットのトレーラーは付けない(`Co-Authored-By`、セッションURL等)。ツールや実行環境が既定で付けようとする場合も、この規約が優先する
- コミットのサブジェクトは50字を目安に、72字を超えない。本文は空行を挟んで表示幅72カラムで折り返す(全角は2カラム)
- **コミット本文はdiffから読み取れないことだけを書く。** 書くのは「なぜ変えたか」「採らなかった案」「どこまで検証したか」。変更ファイルの一覧やバージョン番号の更新は `git show --stat` の仕事。長さを既存の履歴に合わせない(直前のコミットを基準にすると単調に膨らむ)
- PR は `.github/PULL_REQUEST_TEMPLATE.md` に従って書き、main へは squash マージする(docs/03_dev-setup.md 9章)
- Biome(Lint + 整形): インデント2スペース、行幅100、ダブルクオート、import の並べ替え。TypeScript は `strict` と `noUncheckedIndexedAccess`。型の問題は `make typecheck` で拾う
- コメントは日本語で書く(02-01 6章のスキーマのコメントに合わせる)。公開する関数・型の契約は TSDoc(`/** */`)で書く。`NOTE:` などのプレフィックスは使わない
- コード上の名前は design-spec 1.4 の英語の用語に合わせる(案件 project、資料 document、版 version、系列 series、参考資料 reference、変更メモ change note、タグ tag)。DB のカラムは snake_case、TypeScript は camelCase(02-01 6章のスキーマのとおり)
- 画面の文言はコードに直書きしない。`apps/web/src/locales/ja.json` と `en.json` の両方に同じキーで置く(キーは画面・部品ごとに入れ子、API のエラーの文言は `errors.{code}`。02-01 9章)

## Docs Style

<!-- ドキュメントを書くときの規約。決定論的な違反（本文のem dash・表1列目の太字・長すぎる太字）は `make doc-lint` が検出する。 -->

- **テクニカルドキュメントとして書く。** 読んだ人が作業できることだけが目的。装飾・誇張・前置き・総括は情報を足さないので書かない
- **和文の本文でem dashを使わない。** 挿入句の区切りは読点・括弧・文の分割に置き換える。項目と説明を並べるリストは `ラベル: 説明` の形にする
- **太字は段落の頭の短いラベルとUI要素にだけ使う。** 文や表の1列目を太字で覆うと、強調された語が消える
- **対句（「AではなくB」）は意味を運ぶときだけ残す。** リズムのために置くと、対比の無い所に対比があるように読める
- **無生物主語と名詞止めは動詞で言い切る。** 「データは〜を示している」「〜の実施が重要である」は英語構文の残骸
- **概念の名前に英語の直訳をあてない。** 「人手を挟まず」(without human intervention) のような句は、日本語の用法から意味を確定できない。日常の会話にある言い回しから選び、無ければ用語として定義する

<!-- DRAFT: v0.43.0 -->

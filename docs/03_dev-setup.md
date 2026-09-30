# Dev Setup — weaponx

ローカル開発は Docker Compose に閉じる(`docs/02-01_system-design-doc.md` ADR-021)。手元に入れるのは Docker・make・git だけ。Bun・Node.js・PostgreSQL・Terraform・gcloud はコンテナの中にある。

---

## 1. 必要なツール・アカウント

### ツール

| ツール | バージョン | 用途 |
|--------|-----------|------|
| Docker(Docker Desktop または Docker Engine + Compose v2) | Compose v2.24 以上 | すべての開発環境を動かす |
| make | macOS / Linux に標準のもの(Windows は WSL2 の中で使う) | コマンドの入口(8章) |
| git | 2.40 以上 | ソース管理 |
| VS Code + Dev Containers 拡張(任意) | 最新 | コンテナの中の依存でエディタの型チェック・Biome を動かす(`.devcontainer/`) |

コンテナの中にあるもの(版はイメージで固定する。手元には入れない):

| ツール | 固定する場所 | 用途 |
|--------|-------------|------|
| Bun | `docker/dev.Dockerfile` と `package.json` の `packageManager` | API・画面・テスト・drizzle-kit |
| Node.js | `compose.yaml` の `e2e` のイメージ(`mcr.microsoft.com/playwright`) | Playwright |
| PostgreSQL 16 | `compose.yaml` の `db` | 開発用・テスト用 DB |
| Terraform・gcloud | `docker/ops.Dockerfile` | インフラ(5章)・初回のクラウド設定 |

### アカウント(デプロイ時に必要。ローカル開発は不要)

| サービス | 用途 |
|----------|------|
| Google Cloud(課金を有効にしたプロジェクト) | 本番環境、OAuth クライアント、Picker の API キー |
| GitHub | リポジトリ、GitHub Actions |
| ドメイン(DNS を編集できるもの) | 本番の URL と Google マネージド証明書 |
| Google アカウント | 本物の Google でログインを試すとき(任意。6章) |

---

## 2. リポジトリ構成

```
weaponx/
├── apps/
│   ├── api/                  # Elysia(Bun)
│   │   ├── src/
│   │   │   ├── index.ts      # 起動
│   │   │   ├── app.ts        # Elysia アプリ(型 App を export。画面の Eden が使う)
│   │   │   ├── routes/       # auth, me, projects, series, documents, drive, members, admin, dev
│   │   │   ├── domain/       # 業務ルール(採番、参考資料の検証、関連の表示区分、タグ)
│   │   │   ├── db/           # schema.ts, client.ts
│   │   │   ├── drive/        # google.ts(本物)、mock.ts(模擬)、index.ts(DRIVE_MODE で切り替え)
│   │   │   ├── auth/         # OAuth(Arctic)、セッション、トークンの暗号化
│   │   │   └── lib/          # 設定、ログ、エラー
│   │   ├── drizzle/          # マイグレーション(SQL)
│   │   ├── scripts/          # migrate.ts, seed.ts, bootstrap-admin.ts
│   │   ├── test/             # 結合テスト
│   │   └── Dockerfile        # 本番のイメージ
│   └── web/                  # React(Vite)
│       ├── src/
│       │   ├── routes/       # TanStack Router のルート
│       │   ├── features/     # home, project, members, admin, login
│       │   ├── components/   # ダイアログ、表、通知、タグ入力、参考資料の選択
│       │   ├── lib/          # api.ts(Eden)、i18n.ts、picker.ts、format.ts
│       │   ├── locales/      # ja.json, en.json
│       │   └── styles/       # tokens.css(生成物)、index.css
│       └── index.html
├── packages/
│   └── shared/               # 画面と API で共有する規則(入力の上限、正規化、リンクの判定、エラーコード)
├── e2e/                      # Playwright
├── infra/                    # Terraform
├── deploy/
│   └── production/version    # 本番で動くべきバージョン(9章)
├── docker/
│   ├── dev.Dockerfile        # api / web / tools 用
│   └── ops.Dockerfile        # Terraform + gcloud
├── .devcontainer/            # VS Code の Dev Container
├── .githooks/                # pre-commit
├── .github/                  # workflows、PULL_REQUEST_TEMPLATE.md
├── scripts/                  # gen-tokens.ts, doc-lint.sh
├── docs/
├── compose.yaml
├── Makefile
├── biome.json
├── package.json              # Bun のワークスペース
└── .env.example
```

---

## 3. 環境構築手順(30分以内)

```bash
# 1. 取得
git clone git@github.com:eastasann/weaponx.git
cd weaponx

# 2. 初回セットアップ(.env の作成、イメージのビルド、依存のインストール、
#    DB の起動・マイグレーション・デモデータ投入、トークンの CSS 生成、git フックの設定)
make setup

# 3. 起動(DB・API・画面)
make dev
```

4. ブラウザで http://localhost:5173 を開く
5. ログイン画面の「開発用ログイン」から利用者を選ぶ(例: 山田 太郎。design-spec 8章のデモデータ)。Google には行かない
6. ホームに「A社 DX提案」などの案件が並べば完了

止めるときは `make stop`。

### 環境変数

`make setup` が `.env.example` から `.env` を作る(`TOKEN_ENCRYPTION_KEYS` は乱数で埋める)。`.env` は Git に入れない。

| 変数 | ローカルの値 | 説明 |
|------|-------------|------|
| `NODE_ENV` | `development` | `production` のときは開発用ログインを拒否する |
| `APP_ORIGIN` | `http://localhost:5173` | 画面のオリジン。CSRF の確認と OAuth の戻り先に使う |
| `PORT` | `3000` | API の待ち受け |
| `LOG_LEVEL` | `debug` | `debug` / `info` / `warn` / `error` |
| `APP_VERSION` | `dev` | `/api/healthz` と `/api/config` が返す版 |
| `DATABASE_URL` | `postgres://weaponx:weaponx@db:5432/weaponx` | 開発用 DB |
| `TEST_DATABASE_URL` | `postgres://weaponx:weaponx@db:5432/weaponx_test` | 結合テスト用 DB(テストのたびに作り直す) |
| `DEV_LOGIN_ENABLED` | `true` | 開発用ログイン(Google を通さない) |
| `DRIVE_MODE` | `mock` | `mock`(ドライブの模擬)/ `google`(本物) |
| `GOOGLE_CLIENT_ID` | 空 | 本物の Google を使うとき(6章) |
| `GOOGLE_CLIENT_SECRET` | 空 | 同上 |
| `GOOGLE_PICKER_API_KEY` | 空 | 同上。Picker 用の API キー |
| `GOOGLE_PROJECT_NUMBER` | 空 | 同上。Picker の App ID(GCP のプロジェクト番号) |
| `TOKEN_ENCRYPTION_KEYS` | `local:{32バイトの base64}` | Google のリフレッシュトークンの暗号化鍵(ADR-012) |

本番の値の入れ方は `docs/04_deployment-procedure.md` 3章。

---

## 4. PostgreSQL(Drizzle)コマンド一覧

| コマンド | 内容 |
|---------|------|
| `make db-up` | DB のコンテナだけを起動する |
| `make db-generate` | `apps/api/src/db/schema.ts` の変更からマイグレーション(SQL)を生成する(`drizzle-kit generate`) |
| `make db-migrate` | マイグレーションを開発用 DB に適用する |
| `make db-push` | スキーマを開発用 DB に直接反映する(試行錯誤用。マイグレーションは作られないので、確定したら `make db-generate` する) |
| `make db-seed` | デモデータ(design-spec 8章)を入れる。既存のデータは消す |
| `make db-reset` | 開発用 DB を作り直し、マイグレーションとデモデータを入れ直す |
| `make db-studio` | Drizzle Studio を起動する(http://local.drizzle.studio、DB は :4983 で公開) |
| `make db-psql` | 開発用 DB に psql でつなぐ |

- スキーマを変えたら、`make db-generate` で生成した SQL を確かめてからコミットする。拡張の作成など手書きが要るときは `make db-generate CUSTOM=1`
- マイグレーションは、1つ前の版のアプリでも動く追加的な変更に限る(`docs/04_deployment-procedure.md` 5章)

---

## 5. IaC(Terraform)

Terraform と gcloud は `ops` のコンテナで動かす。通常のインフラ変更は GitHub Actions の `infra.yml` が適用するので、手元で使うのは初回のセットアップと、確認のための `plan` だけ。

### ローカルでの使用

```bash
# gcloud にログインする(認証情報はコンテナの名前付きボリュームに残る)
make ops-login

# 初期化・差分確認・適用
make tf-init
make tf-plan
make tf-apply      # 初回だけ。以降は infra.yml に任せる

# ops のコンテナのシェル(gcloud を直接使うとき)
make ops-shell
```

- 変数は `infra/environments/production.tfvars`(プロジェクト ID、リージョン、ドメインなど。秘密は含めない)
- 作るリソースの一覧は `docs/04_deployment-procedure.md` 3章

### CI/CD連携

GitHub Actions の `infra.yml`:

- `infra/` を変える PR: `terraform plan` を実行し、差分を PR にコメントする
- `main` へのマージ: `terraform apply` を実行する

### tfstateの管理

```hcl
# infra/backend.tf
terraform {
  backend "gcs" {
    bucket = "{PROJECT_ID}-tfstate"
    prefix = "weaponx/production"
  }
}
```

tfstate のバケットは Terraform の外で1回だけ作る(`docs/04_deployment-procedure.md` 3章 Step 1)。

---

## 6. OAuth開発用セットアップ

ふだんの開発は、開発用ログイン(`DEV_LOGIN_ENABLED=true`)とドライブの模擬(`DRIVE_MODE=mock`)で行い、Google の設定は要らない。本物の Google でログイン・Picker・コピーを試すときだけ、次の設定をする。

### Google OAuth(本物を試すとき)

1. 本番と同じ GCP プロジェクトで、[Google Cloud Console](https://console.cloud.google.com/) → 「API とサービス」→「認証情報」→「OAuth クライアント ID を作成」。種類は「ウェブ アプリケーション」、名前は `weaponx-local`(本番のクライアントとは分ける)
2. 承認済みの JavaScript 生成元: `http://localhost:5173`
3. 承認済みのリダイレクト URI: `http://localhost:5173/api/auth/google/callback`
4. 「認証情報」→「API キーを作成」。名前は `weaponx-picker-local`。アプリケーションの制限は「ウェブサイト」で `http://localhost:5173/*`、API の制限は「Google Picker API」
5. `.env` を次のように変え、`make dev` をやり直す

```bash
DEV_LOGIN_ENABLED=false
DRIVE_MODE=google
GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=xxxxxxxx
GOOGLE_PICKER_API_KEY=AIzaxxxxxxxx
GOOGLE_PROJECT_NUMBER=123456789012
```

6. 自分のメールを利用者として登録する: `make bootstrap-admin EMAIL=you@example.com`(管理者が1人もいないときだけ登録できる。いるときは開発用ログインで管理者として入り、利用者管理から追加する)

OAuth 同意画面・Drive API・Picker API の有効化は、本番の設定(`docs/04_deployment-procedure.md` 3章 Step 2)と共通。

---

## 7. テスト実行

```bash
# 単体・結合テスト(テスト用 DB を作り直してから、全ワークスペースの bun test)
make test

# 特定のファイルだけ
make test ARGS="apps/api/test/documents.test.ts"

# E2E(Playwright。DB・API・画面をテスト用の設定で起動して流す)
make e2e

# E2E を画面付きで確かめる(レポートを http://localhost:9323 で開く)
make e2e ARGS="--ui-port=9323"
```

テストの方針とカバレッジの目標は `docs/02-01_system-design-doc.md` 10章。

---

## 8. 主要コマンド(Makefile)

**Makefileが実コマンドの唯一の真実源。** docs・CLAUDE.md・実装プロンプトは以下の標準ターゲット名だけを参照し、スタック固有の実コマンド(`docker compose` / `bun` / `drizzle-kit` / `terraform` 等)はMakefileの中にだけ書く。コマンドを変えるときはMakefileだけを直す。

| ターゲット | 説明 |
|-----------|------|
| `make setup` | 初回セットアップ(.env作成、イメージのビルド、依存インストール、DB起動・マイグレーション・デモデータ、トークンの CSS 生成、gitフック設定) |
| `make dev` | 開発環境の起動(DB・API・画面) |
| `make stop` | 開発環境の停止 |
| `make build` | 全パッケージビルド(画面の静的ファイルと API のイメージ) |
| `make test` | 単体・結合テスト実行 |
| `make e2e` | E2E テスト実行 |
| `make lint` | Linter実行(Biome) |
| `make format` | Formatter実行(Biome) |
| `make typecheck` | 型チェック(`tsc --noEmit`、全ワークスペース) |
| `make tokens` | `docs/06_design-tokens.json` から `apps/web/src/styles/tokens.css` を生成 |
| `make db-up` | DB のコンテナだけ起動 |
| `make db-push` | スキーマ反映(開発用) |
| `make db-generate` | マイグレーション生成 |
| `make db-migrate` | マイグレーション適用 |
| `make db-seed` | デモデータ投入 |
| `make db-reset` | 開発用 DB の作り直し |
| `make db-studio` | DB GUI起動(Drizzle Studio) |
| `make db-psql` | psql で開発用 DB につなぐ |
| `make bootstrap-admin EMAIL=...` | 管理者が1人もいないときに、最初の管理者を登録する |
| `make ops-login` / `make ops-shell` | gcloud のログイン / ops のコンテナのシェル |
| `make tf-init` / `make tf-plan` / `make tf-apply` | Terraform |
| `make doc-lint` | ドキュメントと実体の整合検査(`scripts/doc-lint.sh --docs`) |
| `make clean` | コンテナ・ボリューム・`node_modules`・ビルド成果物を消す |

```makefile
# 例: 各ターゲットは docker compose の実コマンドへ委譲する薄いラッパー
.PHONY: setup dev stop build test e2e lint format typecheck tokens db-up db-push db-generate db-migrate db-seed db-reset db-studio db-psql bootstrap-admin ops-login ops-shell tf-init tf-plan tf-apply doc-lint clean

RUN := docker compose run --rm tools

dev:
	docker compose up api web

test:
	$(RUN) bun run test $(ARGS)

lint:
	$(RUN) bunx biome check .
```

※ makeはmacOS/Linuxに標準搭載。Windowsで開発する場合はWSLを使う。存在する操作は必ずこの標準名で提供する。

---

## 9. ブランチ戦略・リリースフロー

GitHub Flow + GitOps環境プロモーション方式。長命ブランチは `main` のみで、リリースはブランチではなく本番のバージョン宣言ファイルで管理する。ステージングは持たない(`docs/02-01_system-design-doc.md` ADR-016)。

```
feature/xxx ──squash──▶ main ──CI自動──▶ アーティファクトのビルド(バージョン = コミットSHAの先頭12文字)
fix/xxx    ──squash──▶   │
                         └─ promotion PR(deploy/production/version を更新)──▶ production
```

| ブランチ | 用途 |
|----------|------|
| `main` | 唯一の長命ブランチ。直接pushしない。マージ = 本番に出せるアーティファクトのビルド |
| `feature/xxx` | 新機能開発。例: `feature/add-search` |
| `fix/xxx` | バグ修正。例: `fix/login-error` |

### マージ方式

- コードPR(feature/fix → main)は**常にsquashマージ**。1 PR = 1コミット = 1つの意図となり、mainの履歴がPR単位で読める
- 環境ブランチ(develop等)は使わない。環境間の差分がマージ履歴に埋もれ、cherry-pickが増えるため(environment branchesアンチパターン)

### リリースフロー(環境プロモーション)

`deploy/production/version` が「本番で動くべきバージョン」の唯一の真実。

1. mainへのsquashマージ → CI(`build.yml`)が API のイメージと画面の静的ファイルをビルドし、バージョン(コミット SHA の先頭12文字)を付けて保存する。git タグ `build-{バージョン}` も付ける
2. ローカルで E2E が通っていることと、リリース前チェックリスト(`docs/04_deployment-procedure.md` 4章)を確かめ、`deploy/production/version` をそのバージョンに更新する **promotion PR** を作成・マージ → 本番へデプロイ
3. ロールバック = promotion PR をrevert

パイプラインの詳細は `docs/04_deployment-procedure.md` を参照。

### PRルール

- `main` へのマージはPR必須(squash)
- CIが通ること(lint + typecheck + test + e2e + build)
- セルフレビュー可(1人開発のため)
- コミットメッセージ: Conventional Commits(`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`)
- コミットメッセージの言語: 英語(サブジェクト・ボディとも)
- コミットのトレーラーは付けない(`Co-Authored-By`、セッションURL等)。ツールや実行環境が既定で付けようとする場合も、この規約が優先する。必要なプロジェクトはこの行を書き換えて明示する
- コミットのサブジェクトは50字を目安に、72字を超えない。本文はサブジェクトとの間に空行を置き、表示幅72カラムで折り返す(全角は2カラム)
- コミット本文にはdiffから復元できないこと(なぜ変えたか・採らなかった案・検証範囲)だけを書く。変更ファイルの一覧やバージョン番号の更新は `git show --stat` が持っているので書かない。長さの基準に既存の履歴を使わない(直前のコミットに合わせると単調に膨らむ)
- PRは `.github/PULL_REQUEST_TEMPLATE.md` に従って書く。promotion PRには対象バージョン・リリース前の確認結果・ロールバック手順を記載する

---

## 10. Linter / Formatter

| ツール | 設定 |
|--------|------|
| Biome(Lint + 整形) | `biome.json`。インデント2スペース、行幅100、ダブルクオート、`import` の並べ替えを有効。`apps/web/src/styles/tokens.css` と `apps/api/drizzle/` は対象外 |
| TypeScript(型チェック) | 各ワークスペースの `tsconfig.json`。`strict: true`、`noUncheckedIndexedAccess: true` |
| git フック | `.githooks/pre-commit` で `make lint` を実行(`make setup` が `core.hooksPath` を設定) |

---

## 11. よくあるトラブルシューティング

| 問題 | 解決策 |
|------|--------|
| `make dev` でポートが使用中(5432 / 3000 / 5173 / 4983) | 手元で動いている PostgreSQL や別の開発サーバーを止める。どうしても変えるときは `compose.yaml` の公開ポートを変える |
| Mac で保存しても画面・API が再読み込みされない | Docker Desktop の設定でファイル共有を VirtioFS にする。それでも検知しないときは `.env` に `WATCH_POLLING=true` を足して `make dev` をやり直す(Vite と `bun --watch` がポーリングに切り替わる) |
| 依存が壊れた・手元で `bun install` を実行してしまった | `make clean` のあと `make setup`。`node_modules` はコンテナ(Linux)用なので、手元では依存をインストールしない |
| Linux で、コンテナが作ったファイルの持ち主が root になる | `.env` に `UID` と `GID`(`id -u` / `id -g` の値)を入れる。`compose.yaml` はこれでコンテナの利用者を合わせる |
| ログイン画面に「開発用ログイン」が出ない | `.env` の `DEV_LOGIN_ENABLED=true` と `NODE_ENV=development` を確かめる |
| マイグレーションが失敗する・DB の状態がおかしい | `make db-reset`(開発用 DB のデータは消える) |
| 本物の Google で `redirect_uri_mismatch` | OAuth クライアントのリダイレクト URI が `http://localhost:5173/api/auth/google/callback` と完全に一致しているか確かめる(6章) |
| 本物の Google で Picker が開かない・API キーのエラー | API キーのウェブサイト制限に `http://localhost:5173/*` があるか、Google Picker API が有効か確かめる |
| CI で `tokens.css` の差分エラー | `docs/06_design-tokens.json` を直した後に `make tokens` を実行してコミットする |
| E2E がローカルで失敗し、原因が分からない | `make e2e` の後、`e2e/playwright-report/` のトレースを開く |

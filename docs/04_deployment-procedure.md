# Deployment Procedure — weaponx

構成の全体は `docs/02-01_system-design-doc.md` 2章、ブランチ戦略とリリースの考え方は `docs/03_dev-setup.md` 9章。このドキュメントは手順を持つ。コマンドの `{PROJECT_ID}`・`{DOMAIN}` などは本番の値に置き換える。`gcloud`・`terraform`・`openssl` は `make ops-shell` のコンテナの中で実行する(`docs/03_dev-setup.md` 5章)。手元に入れるのは Docker・make・git だけ。

## 1. 環境一覧

| 環境 | URL | サービス | DB | デプロイ方法 |
|------|-----|----------|-----|-------------|
| ローカル | http://localhost:5173 | Docker Compose(`api`・`web`) | Docker Compose の `db`(PostgreSQL 16) | `make dev` |
| 本番 | https://{DOMAIN} | LB `weaponx-lb` → Cloud Run `weaponx-api`(asia-northeast1)と Cloud Storage `{PROJECT_ID}-weaponx-web` | Cloud SQL `weaponx-db`(PostgreSQL 16、データベース `weaponx`) | `deploy/production/version` を更新する promotion PR のマージ |

ステージングは持たない(ADR-016)。

## 2. CI/CD パイプライン

リリースはブランチではなく、`deploy/production/version` の更新をトリガーにする(GitOps環境プロモーション)。GitHub Actions から GCP へは Workload Identity 連携で認証し、鍵ファイルは使わない。

```
[feature/fix PR]
    │
    ├── ci.yml(lint + typecheck + test + e2e + build check + tokens.css の差分確認)
    └── infra.yml(infra/ の変更時: terraform plan → PR にコメント)

[main へ squash マージ]
    │
    ├── ci.yml
    ├── build.yml: API のイメージ → Artifact Registry(タグ = バージョン)
    │              画面の静的ファイル → gs://{PROJECT_ID}-weaponx-releases/web/{バージョン}/
    │              git タグ build-{バージョン}
    └── infra.yml(infra/ の変更時: terraform apply)

[promotion PR(deploy/production/version を更新)をマージ]
    │
    └── deploy.yml: 宣言されたバージョンを本番へ
        (ロールバック = promotion PR を revert)
```

バージョンは main のコミット SHA の先頭12文字(例: `3f9c2a1b7d4e`)。`deploy/production/version` にはこの文字列だけを1行で書く。

### CI/CD ワークフロー

テストとビルドは `docs/03_dev-setup.md` 8章の make のターゲットで行う(ランナーの上で Docker Compose を使う)。配布(イメージの push、バケットへのコピー、Cloud Run の更新、ジョブの実行)は、ワークフローから gcloud を直接呼ぶ。

**ci.yml**: 全PRと main への push:
```
make setup → make lint → make typecheck → make test → make e2e → make build → make tokens して差分が無いこと → make tf-validate
```

**build.yml**: mainマージ時:
```
make build APP_VERSION={バージョン} → API のイメージを asia-northeast1-docker.pkg.dev/{PROJECT_ID}/weaponx/api:{バージョン} に push
→ 画面の dist/ を gs://{PROJECT_ID}-weaponx-releases/web/{バージョン}/ にアップロード → git タグ build-{バージョン}
```

保管期間を過ぎて消えたバージョンは、main のこのワークフローを `version` 入力つきで手動実行し、タグ `build-{バージョン}` のコミットから作り直す(`weaponx-deployer` は main のワークフローからしか使えない)。`APP_VERSION` の焼き込みを入れる前のタグから作り直したイメージは、版が `dev` になる。

**deploy.yml**: `deploy/production/version` の変更時:
```
1. バージョンのイメージと画面の静的ファイルがそろっているか確かめる(無ければ止める)
2. マイグレーション: Cloud Run ジョブ weaponx-migrate のイメージをそのバージョンに更新して実行し、終わるまで待つ
3. API: Cloud Run weaponx-api にそのバージョンのイメージで新しいリビジョンを出し、トラフィックを 100% 移す(版は `APP_VERSION` としてイメージのビルド時に焼き込んであり、デプロイでは更新しない)
4. 画面: gs://{PROJECT_ID}-weaponx-releases/web/{バージョン}/assets/ を gs://{PROJECT_ID}-weaponx-web/assets/ にコピー(古いファイルは消さない)
   → 最後に index.html をコピー(どちらも Cache-Control は 02-01 7章「パフォーマンス」のとおりに付ける)
5. 確認: /api/healthz の version がそのバージョン、/api/readyz が 200、/ が 200
6. 保管: イメージに prod-{バージョン} のタグを付け、画面のビルドを gs://{PROJECT_ID}-weaponx-releases/deployed/{バージョン}/ にも写す(本番に出したバージョンは自動の削除の対象外にする。5章)
7. 整理: Cloud Run の古いリビジョンを消す(直近10とトラフィックのあるものを残す)
```

順番の理由: DB → API → 画面の順に新しくする。マイグレーションは1つ前の版の API でも動く追加的な変更に限り(5章)、新しい API は1つ前の画面からの呼び出しも受け付ける。途中で止まっても、動いている組み合わせが壊れない。

**infra.yml**: `infra/` 配下に変更がある場合:
```
PR時: terraform plan → PRにコメント
main merge時: terraform apply
```

## 3. 初回クラウドセットアップ(IaC)

### Step 1: 手動で最低限の準備

`make` のターゲットは手元(ホスト)で実行する。`make ops-shell` で入ったコンテナの中では `gcloud`・`terraform`・`openssl` を直接使い、`make` は使わない。

```bash
# ホストで
make ops-login        # gcloud auth login と application-default login
make ops-shell        # ops のコンテナのシェルに入る。以降 Step 1 はコンテナの中

# プロジェクト作成と課金の紐付け(課金アカウント ID はコンソールで確認)
gcloud projects create {PROJECT_ID}
gcloud config set project {PROJECT_ID}
gcloud billing projects link {PROJECT_ID} --billing-account={BILLING_ACCOUNT_ID}

# 必要な API の有効化
gcloud services enable \
  compute.googleapis.com \
  run.googleapis.com \
  sqladmin.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  cloudresourcemanager.googleapis.com \
  cloudtrace.googleapis.com \
  monitoring.googleapis.com \
  logging.googleapis.com \
  billingbudgets.googleapis.com \
  drive.googleapis.com
# Google Picker API はコンソールの「API とサービス」→「ライブラリ」で「Google Picker API」を有効にする

# Terraform state 用バケット
gcloud storage buckets create gs://{PROJECT_ID}-tfstate \
  --location=asia-northeast1 --uniform-bucket-level-access
gcloud storage buckets update gs://{PROJECT_ID}-tfstate --versioning

# Picker の App ID に使うプロジェクト番号
gcloud projects describe {PROJECT_ID} --format='value(projectNumber)'
```

### Step 2: Google ログインと Picker の設定(コンソール)

1. 「Google Auth Platform」(OAuth 同意画面)
   - ユーザーの種類: **外部**
   - アプリ名 `weaponx`、サポートメール、承認済みドメイン(`{DOMAIN}` の親ドメイン)
   - データアクセス(範囲): `openid`、`.../auth/userinfo.email`、`.../auth/userinfo.profile`、`.../auth/drive.file`
   - 公開ステータス: **本番環境**にする(理由は `docs/02-01_system-design-doc.md` ADR-011)
2. 「認証情報」→ OAuth クライアント ID(ウェブ アプリケーション)、名前 `weaponx-production`
   - 承認済みの JavaScript 生成元: `https://{DOMAIN}`
   - 承認済みのリダイレクト URI: `https://{DOMAIN}/api/auth/google/callback`
3. 「認証情報」→ API キー、名前 `weaponx-picker`
   - アプリケーションの制限: ウェブサイト `https://{DOMAIN}/*`
   - API の制限: Google Picker API

### Step 3: Terraformで残りを構築(1回目: アプリ以外)

Cloud Run はシークレットの値が無いと起動できないので、Terraform は2回に分けて適用する。1回目はアプリ(Cloud Run のサービスとジョブ)を作らない。

```bash
# ホストで
cp infra/environments/production.tfvars.example infra/environments/production.tfvars
# production.tfvars を編集: project_id, project_number, region(asia-northeast1), domain,
#   google_client_id, google_picker_api_key, github_repository(eastasann/weaponx),
#   alert_email, billing_account_id, app_enabled = false
# このファイルは秘密を含まないので、コミットする(infra.yml と deploy.yml が読む)
make tf-init
make tf-plan
make tf-apply
```

Terraformが作成するリソース(名前と役割。設定値の正は `infra/`):

| リソース | 名前 | 役割 |
|---------|------|------|
| グローバル IP・Google マネージド証明書 | `weaponx-ip`、`weaponx-cert` | `{DOMAIN}` の入口 |
| URL マップ・HTTPS プロキシ・転送ルール | `weaponx-url-map` ほか | `/api/*` → `weaponx-api-backend`、`/assets/*` → `weaponx-web-backend`、それ以外 → `weaponx-web-backend`(バケットに無いパスの 404 は `/index.html` の 200 に置き換える)。HTTP は HTTPS へ転送 |
| バックエンドサービス | `weaponx-api-backend` | サーバーレス NEG `weaponx-api-neg` 経由で Cloud Run へ。Cloud Armor のポリシー `weaponx-api-policy` を付ける |
| バックエンドバケット | `weaponx-web-backend` | `{PROJECT_ID}-weaponx-web` を Cloud CDN 付きで配る |
| Cloud Storage | `{PROJECT_ID}-weaponx-web`、`{PROJECT_ID}-weaponx-releases` | 配信する画面 / バージョンごとの画面のビルドの保管 |
| Cloud SQL | インスタンス `weaponx-db`、データベース `weaponx` | 本番の DB(構成は 02-01 ADR-008) |
| Artifact Registry | `weaponx` | API のイメージ |
| Secret Manager(入れ物だけ) | `weaponx-database-url`、`weaponx-google-client-secret`、`weaponx-token-encryption-keys` | 値は Step 4 で入れる |
| サービスアカウント | `weaponx-api`、`weaponx-deployer`、`weaponx-tf-apply`、`weaponx-tf-plan` | 実行用(Cloud SQL クライアント、シークレットの読み取り、ログ・トレースの書き込み)/ `build.yml`・`deploy.yml` 用(Cloud Run とジョブの更新・実行、イメージの push、バケットへの書き込み)/ `infra.yml` の apply 用(プロジェクトのオーナーと、請求先アカウントの予算の管理)/ `infra.yml` の plan 用(読み取りだけ。state には書かないので plan は `-lock=false`) |
| Workload Identity | プール `github` とプロバイダー | `eastasann/weaponx` のリポジトリだけを許可。`weaponx-deployer` と `weaponx-tf-apply` は main のブランチのワークフローだけが使える(PR のワークフローは `weaponx-tf-plan` だけ) |
| Cloud Monitoring・予算 | — | アップタイムチェック、アラートポリシー、ログベースの指標、メールの通知チャネル、予算アラート(`docs/05_operation-runbook.md` 2章) |
| Cloud Run(2回目で作る) | サービス `weaponx-api`、ジョブ `weaponx-migrate` | API / マイグレーションと初期管理者の登録。ジョブは API と同じイメージで、作業ディレクトリは `apps/api` |

DNS を先に向けておくと、証明書の発行を待つ時間を後の手順と重ねられる。

```bash
# ホストで(ops のコンテナの中なら terraform -chdir=infra output lb_ip_address)
make tf-output NAME=lb_ip_address
```

`{DOMAIN}` の A レコードをこの IP に向ける。Google マネージド証明書が `ACTIVE` になるまで15〜60分かかる(ops のコンテナで `gcloud compute ssl-certificates describe weaponx-cert --global --format='value(managed.status)'`)。

### Step 4: シークレットの値と DB 利用者

```bash
# ops のコンテナの中で
# DB の利用者(パスワードは記号を含まない16進にし、URL に入れやすくする)
DB_PASSWORD=$(openssl rand -hex 24)
gcloud sql users create weaponx_app --instance=weaponx-db --password="$DB_PASSWORD"

printf 'postgres://weaponx_app:%s@/weaponx?host=/cloudsql/%s:asia-northeast1:weaponx-db' \
  "$DB_PASSWORD" "{PROJECT_ID}" | gcloud secrets versions add weaponx-database-url --data-file=-

# OAuth クライアントシークレット(Step 2 の weaponx-production)
printf '%s' '{CLIENT_SECRET}' | gcloud secrets versions add weaponx-google-client-secret --data-file=-

# リフレッシュトークンの暗号化鍵(ADR-012。鍵 ID は k1 から始める)
printf 'k1:%s' "$(openssl rand -base64 32)" | gcloud secrets versions add weaponx-token-encryption-keys --data-file=-
unset DB_PASSWORD
```

### Step 5: Terraformで残りを構築(2回目: アプリ)

`production.tfvars` の `app_enabled` を `true` にして、ホストで `make tf-plan` → `make tf-apply`。Cloud Run のサービスとジョブができる(イメージは Google のサンプル。以降は `deploy.yml` が更新し、Terraform はイメージの変更を無視する)。

本番の環境変数(Terraform が Cloud Run に設定する):

| 変数 | 本番の値 | 入れ場所 |
|------|---------|---------|
| `NODE_ENV` | `production` | Terraform(固定) |
| `APP_ORIGIN` | `https://{DOMAIN}` | Terraform(`domain` から) |
| `PORT` | Cloud Run が入れる(8080) | Cloud Run |
| `LOG_LEVEL` | `info` | Terraform(固定) |
| `APP_VERSION` | そのイメージのバージョン | イメージのビルド時に焼き込む(`build.yml` が `make build APP_VERSION=...` で渡す。Terraform には書かない) |
| `GCP_PROJECT_ID` | `{PROJECT_ID}` | Terraform(`project_id` から) |
| `DRIVE_MODE` | `google` | Terraform(固定。`mock` だと API は起動しない。02-01 5.10) |
| `DEV_LOGIN_ENABLED` | `false` | Terraform(固定。`true` だと API は起動しない。02-01 5.10) |
| `GOOGLE_CLIENT_ID` | Step 2 の `weaponx-production` | `production.tfvars` |
| `GOOGLE_PICKER_API_KEY` | Step 2 の `weaponx-picker` | `production.tfvars` |
| `GOOGLE_PROJECT_NUMBER` | Step 1 で確かめたプロジェクト番号 | `production.tfvars` |
| `DATABASE_URL` | Step 4 | Secret Manager `weaponx-database-url` |
| `GOOGLE_CLIENT_SECRET` | Step 4 | Secret Manager `weaponx-google-client-secret` |
| `TOKEN_ENCRYPTION_KEYS` | Step 4 | Secret Manager `weaponx-token-encryption-keys` |

### Step 6: GitHub の設定

リポジトリの Settings → Secrets and variables → Actions の **Variables**(鍵ファイルは使わないので Secrets は不要):

| Variable名 | 内容 |
|------------|------|
| `GCP_PROJECT_ID` | `{PROJECT_ID}` |
| `GCP_REGION` | `asia-northeast1` |
| `GCP_WIF_PROVIDER` | `make tf-output NAME=wif_provider` の値 |
| `GCP_DEPLOY_SA` | `make tf-output NAME=deployer_service_account` の値 |
| `GCP_TF_APPLY_SA` | `make tf-output NAME=terraform_service_account` の値 |
| `GCP_TF_PLAN_SA` | `make tf-output NAME=terraform_plan_service_account` の値 |

ブランチ保護(`main`): PR 必須、`ci.yml` の成功必須、squash マージだけを許可。

### Step 7: 最初のリリースと最初の管理者

1. main に何かをマージして `build.yml` を走らせ、バージョンを得る(Actions のログ、または git タグ `build-*`)
2. `deploy/production/version` をそのバージョンにする promotion PR をマージ → `deploy.yml` が本番に出す(マイグレーションもここで走る)
3. 最初の管理者を登録する(管理者が1人もいないときだけ登録できる):

```bash
# ops のコンテナの中で(ジョブの作業ディレクトリは apps/api)
gcloud run jobs execute weaponx-migrate --region=asia-northeast1 --wait \
  --command=bun --args="run,scripts/bootstrap-admin.ts,--email=you@example.com"
```

有効な管理者が既にいると何も登録せず、ジョブは失敗(終了コード1)として終わる。

4. https://{DOMAIN} を開き、そのメールの Google アカウントでログインする。以降の利用者は利用者管理(A1)から追加する

### 初回セットアップで確かめること

実装のときは GCP のプロジェクトも本物の PR も無く、次の項目を確かめていない。初回のセットアップの中で確かめ、通らなければ直してから先へ進む。

- [ ] Step 1: `make ops-login` で ops のイメージがビルドでき、gcloud にログインできる
- [ ] Step 3・Step 5: `make tf-init` と `make tf-plan` がエラーなく通り、plan の内容が「Terraform が作成するリソース」の表と合っている
- [ ] Step 6 の後: 最初の PR で `ci.yml` が緑になる
- [ ] Step 7 の後: `https://{DOMAIN}/projects/x` が 200 で画面を返し(SPA のフォールバック)、`https://{DOMAIN}/api/no-such-path` が JSON の 404 のまま返る(`index.html` に置き換わらない)
- [ ] Step 7 の後: 6章の手動の確認(本物の Google でのログイン・Picker・作成・コピー)

## 4. リリース前チェックリスト

- [ ] 全テスト通過(CI緑。E2E を含む)
- [ ] マイグレーションが必要な場合、マイグレーションファイル生成済み。1つ前の版の API でも動く追加的な変更になっている(5章)
- [ ] 新しい環境変数がある場合、Terraform(秘密でない値)と Secret Manager(秘密)に登録済み
- [ ] infra変更がある場合、IaC planの差分を確認済み(`infra.yml` のコメント)
- [ ] 本番でしか確かめられない変更(Google のログイン・Picker・Drive での作成とコピー、LB・CDN の設定)がある場合、6章の確認項目に書き足した
- [ ] promotion PRに対象バージョン・リリース前の確認結果・ロールバック手順を記載済み
- [ ] PRレビュー完了(セルフレビュー可)

## 5. ロールバック手順

### 通常のロールバック(環境プロモーション)

`deploy/production/version` を前のバージョンに戻すPR(promotion PRのrevert)をマージする。デプロイと同じパイプラインが走り、API と画面が前のバージョンに戻る(マイグレーションは戻らない。下の「DB」)。以下は緊急時にCLIで直接戻す手順。

本番に出したことのあるバージョンのイメージ(`prod-` のタグ付き)と画面のビルド(`deployed/`)は、自動の削除の対象外なので、いつでも戻せる。一度も本番に出していないバージョンが保管期間(30日。直近5つのイメージは日数によらず残る)を過ぎて消えていたら、main の `build.yml` を `version` 入力つきで手動実行して作り直す(git タグ `build-{バージョン}` のコミットをビルドする)。

### アプリケーションの緊急ロールバック

```bash
# API: 直前のリビジョンにトラフィックを戻す
gcloud run revisions list --service=weaponx-api --region=asia-northeast1
gcloud run services update-traffic weaponx-api --region=asia-northeast1 \
  --to-revisions={前のリビジョン}=100

# 画面: 前のバージョンの index.html を戻す(assets/ は消していないので残っている)
gcloud storage cp gs://{PROJECT_ID}-weaponx-releases/deployed/{前のバージョン}/index.html \
  gs://{PROJECT_ID}-weaponx-web/index.html --cache-control=no-cache
```

CLI で戻したら、あとで promotion PR の revert もマージして、`deploy/production/version` と実際をそろえる。

### インフラのロールバック

インフラを変えた PR を revert してマージする(`infra.yml` が `terraform apply` する)。急ぐときは:

```bash
git checkout {戻したいコミット} -- infra/
make tf-plan
make tf-apply
```

### DBマイグレーションのロールバック

- drizzle-kit は自動の巻き戻しを持たない。マイグレーションは追加的な変更(列・表・インデックスの追加、制約の緩和)に限り、アプリを前のバージョンに戻しても DB はそのままで動くようにする
- 列の削除・名前の変更・型の変更は2回のリリースに分ける(1回目: 新しい列を足して両方に書く。2回目: 古い列を使わなくなってから消す)
- データを壊した場合は、Cloud SQL のポイントインタイムリカバリで壊す前の時刻の複製を作り、確かめてから切り替える(`docs/05_operation-runbook.md` 3章)

## 6. デプロイ後確認

`deploy.yml` が自動で確かめるもの(2章の手順5): `/api/healthz` のバージョン、`/api/readyz`、`/` の表示。

手動で確かめるもの:

- [ ] アプリケーションログに `ERROR` が無いこと(`docs/05_operation-runbook.md` 4章)
- [ ] 本物の Google アカウントでログインでき、ホームに案件が並ぶこと
- [ ] 案件を開き、横パネルで版・参考資料が出ること
- [ ] (作成・コピー・Picker を変えたリリースのとき)資料を追加の「新しく作る」でドライブにファイルができ、編集画面が開くこと。「これを元に作る」でコピーができること。「ドライブから選ぶ」で Picker が開くこと
- [ ] ブラウザの開発者ツールで、CSP の違反が出ていないこと

## 7. 緊急時連絡先

| 役割 | 担当 | 連絡手段 |
|------|------|----------|
| 開発者・管理者(作者) | 作者 | Cloud Monitoring のアラートメール(`production.tfvars` の `alert_email`) |
| GCP の障害 | Google | https://status.cloud.google.com |
| Google Workspace(ログイン・Drive)の障害 | Google | https://www.google.com/appsstatus/dashboard/ |

※ 1人開発のため、アラートはメールで作者に届く。職場の利用者には、障害時にアプリ外(チャット等)で知らせる。

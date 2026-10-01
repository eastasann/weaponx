# Operation Runbook — weaponx

構成は `docs/02-01_system-design-doc.md` 2章、ログとアラートの設計の方針は同 11章。コマンドは `make ops-shell` のコンテナの中で実行する(`{PROJECT_ID}` は本番の値に置き換える)。

## 1. モニタリング・ログ設計

### ログ構成

| ソース | 出力先 | 保持期間 | 内容 |
|--------|--------|----------|------|
| API(Cloud Run `weaponx-api`) | Cloud Logging(`_Default`) | 30日 | 構造化 JSON。`severity`・`message`・`event`・`requestId`・`userId`・`route`・`status`・`durationMs`・`code`。例外はスタック付き |
| 画面の想定外のエラー | 同上(`POST /api/client-errors` 経由) | 30日 | `event: "client_error"`、`clientMessage`・`clientStack`・`path`。Error Reporting に拾われないよう、`message` にはエラーの文面を入れず `"client_error"` とし、スタックも `stack_trace` 以外の項目に入れる(ADR-019) |
| マイグレーション・初期管理者の登録(Cloud Run ジョブ `weaponx-migrate`) | Cloud Logging | 30日 | 適用したマイグレーション、登録結果 |
| ロードバランサー | Cloud Logging(`http_load_balancer`) | 30日 | すべてのリクエスト(検索パラメーターを含む URL、状態コード、遅延、Cloud Armor の判定)。`/api` と画面の両方 |
| Cloud Run の要求ログ(自動) | Cloud Logging(`run.googleapis.com/requests`) | 30日 | API へのリクエスト(検索パラメーターを含む URL、状態コード、遅延) |
| Cloud SQL | Cloud Logging(`cloudsql_database`) | 30日 | PostgreSQL のエラー、遅いクエリ(1秒以上)。バインド変数の値とエラーの DETAIL は出さない設定(`docs/02-01_system-design-doc.md` 7章「ログ」)。Query Insights |
| 監査ログ(管理アクティビティ) | Cloud Logging(`_Required`) | 400日 | GCP のリソースの変更(Terraform・gcloud の操作) |

ログに出すもの・出さないもの、例外として受け入れるものは `docs/02-01_system-design-doc.md` 7章「ログ」。`route` は `メソッド + ルートのテンプレート`(例: `GET /api/projects/:projectId/series`)で、ID や検索パラメーターを含めない。

アプリが出す主な `event`:

| event | レベル | 出る場面 |
|-------|--------|---------|
| `request` | INFO(4xx は WARN、5xx は ERROR) | すべての API リクエストの終わり |
| `login_succeeded` / `login_failed` | INFO / WARN | Google でのログインの結果(`failed` の理由は `code`)。開発用ログインでは出さない |
| `reconnect_failed` | WARN | 再連携の失敗(`code` は `failed` / `cancelled` / `wrong_account` / `scope_missing`) |
| `drive_reauth_required` | WARN | 利用者の連携が要再連携に切り替わった(連携中から切り替わったときの1回だけ) |
| `drive_api_error` | WARN | Drive API・トークン取得の失敗(再試行の前。`code` は Google の理由、`http_{状態}`、`network_error`、`token_network_error`。ファイル単位の 404・403 は出さない) |
| `token_rotate_failed` | WARN | 鍵の入れ替えの書き込みに失敗した(トークンは読めたのでドライブは使える。次にアクセストークンを取るときにやり直す) |
| `token_decrypt_failed` | ERROR | リフレッシュトークンを復号できない(鍵の設定を疑う。3章) |
| `client_error` | ERROR | 画面の想定外のエラー |
| `unhandled_error` | ERROR | 想定外の例外(5xx の応答になったもの、Google から戻った後の保存の失敗で `/login` や `returnTo` へ 302 で戻したもの)。`request` とは別に、スタック付きで `stack_trace` を出す。Error Reporting が拾うのはこれ |
| `startup` | INFO | API の起動(`port`) |
| `bootstrap_admin` | INFO | 最初の管理者の登録の結果(`detail` は `created` / `promoted` / `skipped`) |

### ログレベル

| レベル | 用途 | 本番で出力 |
|--------|------|-----------|
| ERROR | 5xx、想定外の例外、DBエラー、トークンの復号失敗、画面の想定外のエラー | ✅ |
| WARN | 4xx(`code` 付き)、要再連携への切り替え、Drive API の失敗、ログイン失敗 | ✅ |
| INFO | リクエスト概要、ログイン成功、マイグレーション、起動 | ✅ |
| DEBUG | 詳細なリクエスト/レスポンス(本文は出さない)、Drive API の呼び出し | ❌ |

## 2. 監視ポイントとアラート

Terraform(`infra/monitoring.tf`)で作る。通知はすべてメール(`alert_email`)。

| 監視対象 | メトリクス | 閾値 | アラート先 |
|----------|-----------|------|-----------|
| 稼働 | アップタイムチェック `https://{DOMAIN}/api/healthz`(5分ごと、3地域) | 2地域以上で2回続けて失敗(10分) | メール |
| API の失敗率 | LB のバックエンドサービス `weaponx-api-backend` の 5xx の割合 | 5分間で 5% 超 | メール |
| API の遅延 | LB のバックエンドの遅延 p95 | 10分間 2秒超 | メール |
| 例外(API) | `event="unhandled_error"` のログ(Error Reporting の「新しいエラーグループ」の通知は Terraform で作れないので、同じログを直接拾う) | 1件でも(1時間に1通まで) | メール |
| 画面のエラー | ログベースの指標 `event="client_error"` の件数 | 1時間に5件超 | メール(件数だけ。本文は載せない) |
| 要再連携の急増 | ログベースの指標 `event="drive_reauth_required"` の件数 | 1時間に5件超 | メール |
| ログイン失敗の急増 | ログベースの指標 `event="login_failed"` の件数 | 1時間に20件超 | メール |
| トークンの復号失敗 | ログベースの指標 `event="token_decrypt_failed"` の件数 | 1件でも | メール |
| DB の CPU | Cloud SQL `cpu/utilization` | 15分間 80% 超 | メール |
| DB のストレージ | Cloud SQL `disk/utilization` | 80% 超 | メール |
| DB の接続数 | Cloud SQL `postgresql/num_backends` | 10分間 20 超 | メール |
| 費用 | 予算アラート(月 $50) | 50%・90%・100% | メール |

## 3. よくある障害と対処法

### Cloud Run がコールドスタートで遅い

**症状:** しばらく使わなかった後の最初の操作が1〜2秒以上かかる

**対処:**
- 自分用の MVP なので基本は許容する(`docs/02-01_system-design-doc.md` 7章)
- 気になるなら最小インスタンスを1にする(月 数ドル増える)

```bash
# 恒久的に変える: infra/run.tf の min_instance_count を 1 にして PR(infra.yml が適用)
# 一時的に変える(Terraform との差分になるので、後で tf に反映するか戻す)
gcloud run services update weaponx-api --region=asia-northeast1 --min-instances=1
```

### 画面が 502 / 503 になる(ロードバランサー)

**症状:** `/api/*` が 502・503、または画面全体が開かない

**対処:**
1. `/api/healthz` だけ失敗するなら API の問題。Cloud Run のリビジョンが起動に失敗していないか見る(4章「API のログ」)。直前のデプロイが原因ならロールバック(`docs/04_deployment-procedure.md` 5章)
2. 画面も開かないなら LB・証明書・DNS の問題。証明書の状態と LB のログを見る

```bash
gcloud run services describe weaponx-api --region=asia-northeast1 \
  --format='value(status.conditions)'
gcloud compute ssl-certificates describe weaponx-cert --global --format='value(managed.status)'
```

3. Cloud Run の受信設定が「内部と Cloud Load Balancing」になっているか、サーバーレス NEG がサービスを指しているか確かめる(`make tf-plan` で差分が無いか)

### Cloud SQL 接続エラー

**症状:** `/api/readyz` が 503。ログに `ECONNREFUSED`、`too many clients`、`Connection terminated`

**対処:**
1. Cloud SQL インスタンスが起動しているか(メンテナンス中でないか)確認
2. 接続数が上限に近いなら、Cloud Run の最大インスタンス数と接続プールの掛け算が DB の上限を超えていないか確かめる(`docs/02-01_system-design-doc.md` 7章「パフォーマンス」)
3. `weaponx-database-url` のシークレットの値(接続名 `{PROJECT_ID}:asia-northeast1:weaponx-db`)と、Cloud Run の Cloud SQL 接続の設定を確かめる

```bash
gcloud sql instances describe weaponx-db --format="value(state)"
gcloud sql operations list --instance=weaponx-db --limit=5
```

### DBマイグレーションエラー

**症状:** `deploy.yml` の「マイグレーション」で止まる

**対処:**
1. `deploy.yml` はマイグレーションが失敗すると API と画面を更新しないので、本番は1つ前のバージョンのまま動いている
2. ジョブのログで失敗した SQL を確かめる(4章)
3. マイグレーションを直した PR をマージし、新しいバージョンで promotion PR を出し直す。途中まで適用された場合は、`drizzle.__drizzle_migrations` の記録と実際のスキーマを見比べ、必要なら手で直す(Cloud SQL Studio)

```bash
gcloud run jobs executions list --job=weaponx-migrate --region=asia-northeast1 --limit=5
```

### OAuth ログイン失敗(全員がログインできない)

**症状:** ログイン画面に「ログインできませんでした」。ログに `login_failed` が続く

**対処:**
1. ログの `code` を見る。Google の画面で `redirect_uri_mismatch` が出るなら、OAuth クライアントのリダイレクト URI が `https://{DOMAIN}/api/auth/google/callback` と一致しているか確認
2. `invalid_client` なら、`weaponx-google-client-secret` の値と OAuth クライアント(`weaponx-production`)のシークレットが一致しているか確認。シークレットを作り直したら新しいバージョンを追加し、Cloud Run の新しいリビジョンを出す

```bash
printf '%s' '{新しいシークレット}' | gcloud secrets versions add weaponx-google-client-secret --data-file=-
gcloud run services update weaponx-api --region=asia-northeast1 --update-labels=secret-rotated=$(date +%s)
```

### 多くの利用者が要再連携になる

**症状:** 要再連携の帯が多くの人に出る。`drive_reauth_required` のアラート

**対処:**
1. OAuth 同意画面の公開ステータスが「本番環境」か確認する。「テスト」だとリフレッシュトークンが7日で切れる(ADR-011)
2. OAuth クライアントを作り直した・削除した場合、古いクライアントで得たトークンは使えない。各自に「もう一度連携する」を押してもらう
3. `token_decrypt_failed` も出ているなら、下の「トークンを復号できない」へ

### トークンを復号できない

**症状:** `token_decrypt_failed` のアラート。ドライブの操作が全部失敗する

**対処:**
1. `weaponx-token-encryption-keys` の最新バージョンに、保存済みの暗号文の鍵 ID(`credentials` の先頭)の鍵が残っているか確認する。鍵を消した・書き間違えたときは、前のシークレットのバージョンの値を含めて新しいバージョンを追加し、Cloud Run の新しいリビジョンを出す
2. 鍵を失った場合は復号できないので、該当する `drive_connections` を `needs_reauth` にし、各自に再連携してもらう

```sql
-- Cloud SQL Studio で実行
update drive_connections set status = 'needs_reauth', updated_at = now()
where credentials like '{失った鍵ID}:%';
```

### Drive API のレート制限・一時的な失敗

**症状:** ドライブの操作が「保存できませんでした」になる。ログに `drive_api_error`(`rateLimitExceeded`・`userRateLimitExceeded`・5xx)

**対処:** 一時的なものは API が1回だけ再試行している。続くならコンソールの「API とサービス」→「Google Drive API」→「割り当て」で使用量を確認する。この規模で上限に当たるなら、メタデータの取り直しの呼び出しが多すぎないか(同じ版を10分以内に取り直していないか)を疑う

### ファイル選択画面(Picker)が開かない

**症状:** 「ドライブから選ぶ」「このファイルをアプリで使えるようにする」を押しても何も起きない、またはエラー

**対処:**
1. ブラウザの開発者ツールで、CSP の違反(`apis.google.com`・`docs.google.com`)が出ていないか確認する。出ていれば LB とバケットの応答ヘッダーの CSP を直す(`docs/02-01_system-design-doc.md` 7章)
2. API キー `weaponx-picker` のウェブサイト制限が `https://{DOMAIN}/*`、API の制限が Google Picker API になっているか、Google Picker API が有効か確認する
3. `/api/config` の `picker.appId` がプロジェクト番号と一致しているか確認する

### データを壊した(誤操作・不具合)

**症状:** 資料・案件の記録が大量に消えた・書き換わった

**対処:**
1. 壊れた時刻をログ(4章)で特定する
2. ポイントインタイムリカバリで、その直前の時刻のインスタンスを複製する(本番はそのまま)
3. 複製を Cloud SQL Studio で確かめ、必要な行だけを本番に戻す。全体を戻すなら、`weaponx-database-url` を複製先に向けて Cloud Run の新しいリビジョンを出す

```bash
gcloud sql instances clone weaponx-db weaponx-db-restore-$(date +%Y%m%d) \
  --point-in-time='2026-10-01T03:00:00Z'
```

## 4. ログ確認方法

```bash
# API のログ(直近1時間)
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="weaponx-api"' \
  --limit=50 --freshness=1h

# エラーのみ
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="weaponx-api" AND severity>=ERROR' \
  --limit=20 --freshness=1d

# リクエスト ID で追う(画面の失敗の通知の詳細に出る ID)
gcloud logging read 'jsonPayload.requestId="{リクエストID}"' --freshness=7d

# ロードバランサーの 5xx と Cloud Armor の拒否
gcloud logging read \
  'resource.type="http_load_balancer" AND httpRequest.status>=500' --limit=20 --freshness=1d
gcloud logging read \
  'resource.type="http_load_balancer" AND jsonPayload.enforcedSecurityPolicy.outcome="DENY"' --limit=20 --freshness=1d

# マイグレーション・初期管理者の登録のジョブ
gcloud logging read \
  'resource.type="cloud_run_job" AND resource.labels.job_name="weaponx-migrate"' --limit=50 --freshness=1d

# Cloud SQL のエラーと遅いクエリ
gcloud logging read \
  'resource.type="cloudsql_database" AND severity>=WARNING' --limit=20 --freshness=1d
```

コンソールでも確認できる: https://console.cloud.google.com/logs (ログ エクスプローラー)、Error Reporting、Cloud SQL の Query Insights。

## 5. エスカレーションフロー

1人開発のため、Cloud Monitoring のアラート → メールで作者が対応する。

1. アラートのメールから該当のログ・メトリクスを開き、3章の該当する障害を探す
2. 直前のリリースが原因なら、まずロールバック(`docs/04_deployment-procedure.md` 5章)してから原因を調べる
3. 職場の利用者には、アプリ外(チャット等)で状況を知らせる

重大障害(データ損失等)の場合:

1. Cloud Run のトラフィックを前のリビジョンに戻す(書き込みを止めたいときは、LB の URL マップで `/api/*` を一時的に止めることも検討する)
2. 3章「データを壊した」の手順で、ポイントインタイムリカバリの複製から戻す

## 6. 定期メンテナンス

| タスク | 頻度 | 手順 |
|--------|------|------|
| 依存パッケージ更新 | 月1回 | `make deps-update` → `make test` / `make e2e` → PR → リリース。Bun・PostgreSQL・Playwright・Terraform のイメージの版も見直す |
| DBバックアップ確認 | 月1回 | コンソールで自動バックアップの一覧を確認。3か月に1回、ポイントインタイムリカバリの複製を作って開けるか試し、複製は消す |
| エラーの棚卸し | 週1回 | Error Reporting の未解決のエラーを確認・対処 |
| セキュリティの見直し | 月1回 | Cloud Armor の拒否のログ、ログイン失敗の件数を確認 |
| 暗号化鍵の入れ替え | 年1回 | 下の「暗号化鍵の入れ替え」 |
| OAuth クライアントシークレットの入れ替え | 年1回 | 3章「OAuth ログイン失敗」の手順でシークレットを追加し、古いシークレットを OAuth クライアントから消す |
| IaC state確認 | 月1回 | ホストで `make tf-plan` を実行し、差分(手作業の変更)が無いか確認 |
| 費用の確認 | 月1回 | 請求レポートで LB・Cloud SQL・Cloud Armor が想定(`docs/02-01_system-design-doc.md` 2章の概算)に収まっているか |
| KPI の確認 | 月1回 | 下の「KPI の測り方」(`docs/01_prd.md` 5章) |

Artifact Registry のイメージ(直近5つは残す)と画面のビルドの保管は、自動で消える設定にしてある(30日。期間は `infra/`)。Cloud Run のリビジョンは、`deploy.yml` がデプロイのたびに直近10とトラフィックのあるもの以外を消す。本番に出したバージョンは消えない(`docs/04_deployment-procedure.md` 5章)。

### 暗号化鍵の入れ替え

1. 新しい鍵を先頭に足した値でシークレットの新しいバージョンを作る(古い鍵は残す)

```bash
printf 'k2:%s,k1:%s' "$(openssl rand -base64 32)" '{今の k1 の値}' \
  | gcloud secrets versions add weaponx-token-encryption-keys --data-file=-
```

2. Cloud Run の新しいリビジョンを出す(新しい暗号化は k2 で行われ、k1 の暗号文も読める)
3. API は、k1 で復号したトークンを k2 で暗号化し直して保存する(アクセストークンを取り直すたび、つまりおよそ1時間ごと・ログインと再連携のたび。ADR-012)。`select count(*) from drive_connections where credentials like 'k1:%'` を週に1回見る
4. 1か月たっても残る行(しばらく使っていない人)は、`update drive_connections set status = 'needs_reauth', updated_at = now() where credentials like 'k1:%';` で要再連携にする(次に使うとき再連携してもらう)。0件になったら、k1 を外したバージョンを作る

### KPI の測り方

DB の値は Cloud SQL Studio(コンソール)で読み取り専用のクエリとして実行する。

```sql
-- 直近28日に記録された版のうち、アプリから作ったものの割合
select round(100.0 * count(*) filter (where created_via in ('created', 'copied')) / nullif(count(*), 0), 1) as app_created_pct
from documents
where created_at >= now() - interval '28 days';

-- 直近28日の2版目以降のうち、変更メモがあるものの割合
select round(100.0 * count(*) filter (where change_note is not null) / nullif(count(*), 0), 1) as change_note_pct
from documents
where version_no >= 2 and created_at >= now() - interval '28 days';
```

利用の頻度と継続(誰が何日使ったか)はアプリのログで見る。ログ エクスプローラーで次の条件を入れ、`jsonPayload.userId` ごとのヒストグラム(1日単位)を見る(ログの保持は30日)。

```
resource.type="cloud_run_revision"
resource.labels.service_name="weaponx-api"
jsonPayload.event="request"
jsonPayload.route="GET /api/projects/:projectId/series"
```

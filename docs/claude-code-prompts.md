# weaponx — Claude Code プロンプト集

Claude Code のチャットに **1つずつ** コピペして使う。
前のステップが完了・動作確認できてから次を投げること。
このファイルは派生物。docs/ のソース層から再生成でき、docs/ と食い違ったら docs/ が正。

**チャット分割の目安:**
- Step 1〜2 → Chat 1(骨格とスキーマは依存が近いので、1チャットで続けてよい)
- Step 3〜12 → 1ステップ = 1チャット(Chat 2〜11)

ステップの並び: 骨格と DB(Step 1〜2)、API(Step 3〜5)、Google のログインと本物のドライブ(Step 6)、画面(Step 7〜10)、インフラと CI/CD(Step 11)、テストの仕上げ(Step 12)。API は開発用ログインとドライブの模擬(design-spec 8章、02-01 5.10)で Google なしに確かめられるので、Google の本物は API の後に入れる。画面は Step 8〜9 がコア画面(ホームと案件)、Step 10 が残りの画面。E2E の土台は画面の最初の Step 7 で作り、以降の画面のステップはそれぞれのフローの E2E で動作を確かめる。

---

各Stepの見出し直下の `Status:` 行が進捗の記録先。値は次の3つで、無人ループの停止判定にも使われる:

- 空欄: 未着手
- `done YYYY-MM-DD`: 動作確認まで完了
- `blocked YYYY-MM-DD`: 着手したが、人の判断なしには閉じられない。直後の1行に閉じられない理由を具体的に書く

/draft:prep を再実行して作り直すときは、この行(とブロッカーの理由行)と追記されたステップを新版へ移送する。

## Step 1: モノレポ骨格 + 開発環境

Status: done 2026-09-30

```
docs/03_dev-setup.md の 1章(ツールと Compose のサービス)・2章(リポジトリ構成)・3章(環境変数)・8章(Makefile)・10章(Linter)・11章(トラブルシューティング)と、
docs/02-01_system-design-doc.md の ADR-002・ADR-005・ADR-018・ADR-020・ADR-021 に従って、
モノレポの骨格と Docker Compose の開発環境をセットアップしてください。

やること:
1. `.git` が無ければ `git init` を実行する
2. Bun のワークスペース(apps/*・packages/*): ルートの package.json(packageManager で Bun の版を固定)、
   共通の tsconfig(strict、noUncheckedIndexedAccess)
3. apps/api: Elysia を初期化する。src/index.ts(起動)、src/app.ts(Elysia アプリ。型 App を export する)、
   src/lib/ の設定の読み込み(環境変数の検証)。エンドポイントは GET /api/healthz(02-01 5.10)だけを作る
4. apps/api/Dockerfile: 本番の API のイメージ。Cloud Run のサービスと、同じイメージで作業ディレクトリを apps/api にして
   scripts/ を動かすジョブ weaponx-migrate の両方で使う(04 3章)
5. apps/web: Vite + React + TypeScript を初期化し、Tailwind CSS v4・TanStack Router・TanStack Query・Radix UI・
   react-i18next を入れる。開発サーバーは :5173 で、/api を api:3000 へ転送する。画面はルート1つだけ
6. packages/shared: package.json と tsconfig(中身は Step 2 から)
7. docker/dev.Dockerfile、docker/ops.Dockerfile、compose.yaml(db・api・web・tools、プロファイル e2e の e2e、
   プロファイル ops の ops)。db は開発用の weaponx とテスト用の weaponx_test を作る。
   UID/GID・WATCH_POLLING・EXTRA_CA_CERT(コンテナとイメージのビルドに追加の証明書を渡す)に対応する(03 3章・11章)。ツールの版は 03 1章の場所で固定する
8. .env.example(03 3章の全変数)、.gitignore(.env、node_modules、ビルド成果物、Playwright のレポート)
9. biome.json(03 10章の設定。tokens.css と apps/api/drizzle/ は対象外)
10. scripts/gen-tokens.ts: docs/06_design-tokens.json から apps/web/src/styles/tokens.css を生成する(ADR-020 の書き出し方。
    ライトとダークは prefers-color-scheme で切り替える)。生成した tokens.css もコミットする
11. .devcontainer/(tools のコンテナにつなぐ)
12. Makefile: 03 8章の全ターゲットを、Compose のサービスで実コマンドを動かす薄いラッパーとして定義する。以後の操作は全て make 経由で行う。
    - doc-lint は scripts/doc-lint.sh --docs を呼び、setup は git config core.hooksPath .githooks を含める
      (scripts/doc-lint.sh と .githooks/pre-commit は Phase 4 で配置済み)
    - setup は .env が無ければ .env.example から作り、TOKEN_ENCRYPTION_KEYS を乱数で埋める(03 3章)
    - 実体が後のステップで入るターゲットも最終形のコマンドで定義する(echo だけのダミーにしない)。
      db-push・db-generate・db-migrate・db-seed・db-reset・db-studio・test と、setup のマイグレーションとデモデータの投入は Step 2、
      bootstrap-admin は Step 3、e2e・e2e-report は Step 7、tf-init・tf-plan・tf-apply・tf-output は Step 11 で通す
13. .githooks/pre-commit を、scripts/doc-lint.sh --staged が通ったら make lint を実行する形にする(03 10章)

まだやらないこと: DB スキーマ、healthz 以外の API、画面の中身。

ゴール:
- make setup が .env の作成・イメージのビルド・依存のインストール・tokens.css の生成・git フックの設定まで通る
- make dev で db・api・web が起動し、http://localhost:5173/api/healthz(Vite の転送経由)が 200 で {"status":"ok","version":"dev"} を返す
- make build、make lint、make typecheck、make doc-lint が通る。make tokens を実行しても差分が出ない
```

---

## Step 2: DB スキーマ + シード

Status: done 2026-10-01

```
docs/02-01_system-design-doc.md の6章「データモデル」のスキーマを実装し、
docs/design-spec.md 8章のデモデータを投入できるようにしてください。

やること:
1. apps/api/src/db/schema.ts: 02-01 6章のスキーマ。src/db/client.ts: postgres.js の接続(プールの上限は 02-01 7章「パフォーマンス」)
2. drizzle.config.ts と最初のマイグレーション: 手書きのマイグレーション(make db-generate CUSTOM=1)で pg_trgm の拡張を作ってから、
   スキーマの SQL を make db-generate で生成する(02-01 6章のスキーマの後の注記)
3. apps/api/scripts/migrate.ts: マイグレーションの適用(本番の Cloud Run ジョブ weaponx-migrate もこれを使う。ADR-009)
4. packages/shared: 名前の正規化(02-01 6章の name_key・label_key)と、リンクの判定(ドライブのファイル ID の取り出し、
   link_key、リンクからの種別の判定。02-01 5.1・6章、design-spec 6.2)。シードも Step 3 以降の API もこの関数を使う
5. apps/api/scripts/seed.ts: design-spec 8章のデモデータ(利用者・連携の状態・案件とメンバー・削除済みの案件・資料の系列と版・
   参考資料・タグ・変更メモ・削除済みの版・日付・created_via)。既存のデータは消してから入れる(03 4章)。
   案件の last_activity_at と系列の next_version_no を、入れたデータと整合させる
6. make test の実体: テスト用 DB を作り直してマイグレーションを適用し、全ワークスペースの bun test を流す(03 7章)
   (Step 1 で Makefile の test・db-reset は定義済み)
7. 単体テスト: 4の正規化とリンクの判定(02-01 10章の単体の対象のうち、ここで作ったもの)
8. Makefile の setup が持つ条件分岐(`if [ -f apps/api/scripts/migrate.ts ]`。Step 1 で migrate.ts が無い間だけ必要だった)を外し、db-migrate と db-seed を常に呼ぶ
9. apps/api/src/lib/config.ts に DATABASE_URL の検証を足す(Step 1 では使う変数だけを検証している。APP_ORIGIN と TOKEN_ENCRYPTION_KEYS は Step 3、GOOGLE_* は Step 6 で足す)

まだやらないこと: API のエンドポイント(Step 3〜5)。

ゴール:
- make clean の後の make setup が最後まで通る(Step 1 で残したマイグレーションとデモデータの投入を含む)
- make db-reset でテーブルができてデモデータが入り、make db-studio で design-spec 8章の表どおりのデータが見える
- make test が全パス
- Makefile の setup に migrate.ts の有無で分ける条件分岐が残っていない
```

---

## Step 3: API の土台 + 開発用ログイン + 利用者・案件・メンバーの API

Status:

```
docs/02-01_system-design-doc.md の ADR-010・ADR-013、5.1〜5.4・5.8〜5.10、7章(権限マトリクス・その他の設計判断)、8章、11章と、
docs/05_operation-runbook.md 1章(ログの項目とレベル)、docs/design-spec.md 2.1・6.0.3・6.0.6 に従って、
API の土台と、利用者・案件・メンバーの API を実装してください。

やること:
0. apps/api/src/lib/config.ts に APP_ORIGIN(URL の形式)と TOKEN_ENCRYPTION_KEYS(`{鍵ID}:{32バイトの base64}` をカンマ区切り。形式だけ検証し、値はエラーに出さない)の検証を足す
1. packages/shared: 入力の上限(design-spec 6.0.3 の値)と文字列の検証(前後の空白、改行、書記素で数える文字数)、
   エラーコードの一覧と design-spec 6.0.2 の分類(02-01 8章)
2. API の共通部品(apps/api/src/lib/):
   - エラー応答の形式(02-01 8章)。想定外の例外は INTERNAL
   - リクエスト ID と X-Request-Id(02-01 8章「ログとの対応」)
   - 構造化 JSON のログ(05 1章の項目・event・レベル。route はルートのテンプレート。出さないものは 02-01 7章「ログ」)
   - CSRF(状態を変えるメソッドの Origin の確認、本文は JSON だけ)、セキュリティヘッダー(02-01 7章)
   - 起動時の設定の検証: NODE_ENV=production で開発用ログインかドライブの模擬が有効なら起動しない(02-01 5.10)
3. セッション(ADR-010、02-01 7章): Cookie wx_session、有効期限と延長、期限切れの行の掃除、認証の要るルートの共通ガード
   (401 UNAUTHENTICATED、停止中は 401 ACCOUNT_SUSPENDED とセッションの削除と wx_login_notice。02-01 7章の権限マトリクスの注記)。
   POST /api/auth/logout
4. 開発用ログイン(02-01 5.10): GET /api/dev/users、POST /api/dev/login。DEV_LOGIN_ENABLED=true のときだけルートを登録する
5. エンドポイント:
   - GET /api/readyz、GET /api/config、POST /api/client-errors
   - GET /api/me、PATCH /api/me
   - GET /api/projects、POST /api/projects、GET・PATCH・DELETE /api/projects/:projectId
   - GET /api/projects/:projectId/members、GET /api/projects/:projectId/member-candidates、
     POST /api/projects/:projectId/members、PATCH・DELETE /api/projects/:projectId/members/:userId
   - GET /api/admin/users、POST /api/admin/users、PATCH /api/admin/users/:userId、GET /api/admin/users/:userId/sole-owner-count
6. 規則: オーナーが1人以上・管理者が1人以上(ADR-013 のロック)、同じ結果になる操作の成功(design-spec 6.0.6)、
   案件の last_activity_at(02-01 6章「テーブルごとの規則」)、不参加・削除済みの案件の 404 PROJECT_NOT_FOUND
7. apps/api/scripts/bootstrap-admin.ts(make bootstrap-admin。管理者が1人もいないときだけ登録する。03 6章、04 3章 Step 7)
8. テスト: 1の単体テスト。結合テスト(bun test + テスト用 DB)で、このステップのエンドポイントの正常系と主なエラー、
   権限マトリクスのうちこのステップのエンドポイントの行を役割ごとに叩いて期待の状態コードになること、
   最後のオーナー・最後の管理者を同時に外せないこと、停止された人の次のリクエストが 401 になりセッションが消えること

まだやらないこと: 資料(系列・版)・検索・ドライブの API(Step 4〜5)、Google の本物のログイン(Step 6)、画面(Step 7〜)。

ゴール:
- make test が全パス
- make dev で起動し、curl で http://localhost:5173/api/dev/login(Origin: http://localhost:5173 を付ける)に山田のメールを送ってセッションを得て、
  その Cookie で GET /api/me・/api/projects・/api/projects/:projectId/members・/api/admin/users が 200 を返す。
  Cookie 無しは 401、佐藤(A社 DX提案の編集者)の PATCH /api/projects/:projectId は 403、山田が参加していない D社 研修企画は 404 になる。
  停止中の鈴木の POST /api/dev/login は 401 ACCOUNT_SUSPENDED になる
```

---

## Step 4: 資料の API(閲覧・リンクでの登録・編集・削除・検索)+ ドライブの模擬

Status:

```
docs/02-01_system-design-doc.md の ADR-013、5.5(documents/new・versions/copy・copies・metadata-refresh を除く)・5.6・5.7(file-info)・5.10(ドライブの模擬)、
6章(テーブルごとの規則・導出する値)、7章(権限マトリクスの系列・版の判定の順)、8章(Drive の応答の分け方)と、
docs/design-spec.md 6.0.3・6.0.4・6.0.6・6.0.9・6.1(関連資料の表示規則・版を削除した後)・6.5.5・6.5.6 に従って、資料の API を実装してください。

やること:
1. packages/shared: URL の検証(http・https だけ)、タグの上限と重複の判定
2. ドライブのインターフェース(apps/api/src/drive/index.ts が DRIVE_MODE で切り替える)と模擬(mock.ts)のファイル情報の取得。
   模擬の「アプリが使えるファイル」の集合と、要再連携の利用者・使えないファイルへの応答は design-spec 8章と 02-01 5.10 のとおり。
   本物(google.ts)は Step 6 で作る
3. 業務ルール(apps/api/src/domain/):
   - 版番号の採番、リンクの重複(23505 を DUPLICATE_LINK へ)、参考資料の検証と件数の上限、タグの保存(ADR-013、02-01 6章)
   - 関連資料の表示区分と並び順の区分、表の行のタグ、旧版の件数、版の更新日時、この資料を参考にした資料(02-01 6章「導出する値」)
   - 案件の last_activity_at の更新
4. エンドポイント:
   - GET /api/projects/:projectId/series(N+1 を作らない。02-01 7章「パフォーマンス」)
   - GET /api/series/:seriesId
   - POST /api/projects/:projectId/documents(リンクで登録。ドライブの資料の取り直しと、取り直せないときの成功、driveStatus)
   - POST /api/series/:seriesId/versions(新しい版を登録)
   - PATCH /api/documents/:documentId、DELETE /api/documents/:documentId
   - GET /api/search、GET /api/reference-candidates、GET /api/projects/:projectId/tags
   - POST /api/drive/file-info
5. テスト: 3の単体テスト。結合テストで、このステップのエンドポイントの正常系と主なエラー、権限マトリクスの該当行、
   同じ系列への2つの版の同時登録で番号が重ならないこと、リンクの重複、no_access・deleted の行が名前と ID を返さないこと

まだやらないこと: ドライブでの作成とコピー(新しく作る・新しい版を作る・これを元に作る)、メタデータの取り直し、Picker 用トークン(Step 5)、
Google の本物(Step 6)、画面(Step 7〜)。

ゴール:
- make test が全パス
- make dev で起動し、開発用ログイン(山田)のセッションで curl を叩くと、A社 DX提案の GET .../series が design-spec 6.1 の画面例の5行にあたる値
  (提案書のタグが 確認済・提出 v2・ドラフト v1 の順、旧版 2件など)を返し、GET /api/series/:seriesId(提案書)が版3件・参考資料2件・参考にした資料2件を返す
- 業界ニュースまとめの参考資料が、山田では deleted、佐藤では no_access になる
```

---

## Step 5: ドライブでの作成とコピーの API + メタデータの取り直し

Status:

```
docs/02-01_system-design-doc.md の 5.5(documents/new・versions/copy・copies・metadata-refresh)・5.7(drive-access・picker-token)・5.10(dev/drive/grant)、8章と、
docs/design-spec.md 6.0.5・6.0.6・6.0.8・6.0.9・6.1「メタデータの取り直し」・6.3 に従って、ドライブでの作成を伴う API を実装してください。

やること:
1. ドライブのインターフェースと模擬に、空の資料の作成・コピー・使えるかの確認・Picker 用トークン・「使えるファイル」への追加を足す(design-spec 8章)
2. 作成系の共通の順(アプリの確認、Drive での作成、登録。design-spec 6.0.8)。要再連携なら Google を呼ばずに DRIVE_REAUTH_REQUIRED を返す。
   Drive には作れたが登録に失敗したら DRIVE_CREATED_NOT_REGISTERED(02-01 8章の details)を返し、作成したファイルは消さない
3. エンドポイント:
   - POST /api/projects/:projectId/documents/new
   - POST /api/series/:seriesId/versions/copy
   - POST /api/documents/:documentId/copies(追加先の権限と TARGET_PROJECT_UNAVAILABLE)
   - GET /api/documents/:documentId/drive-access、POST /api/drive/picker-token
   - POST /api/projects/:projectId/metadata-refresh
   - POST /api/dev/drive/grant(DRIVE_MODE=mock のときだけルートを登録する)
   作成・コピーした版の資料名・更新日時・metadata_fetched_at・created_via は 02-01 5.5 のとおり(created_via は 01_prd 5章の KPI に使う)
4. テスト: 結合テストで、各エンドポイントの正常系、要再連携の利用者(田中)で Drive を呼ばずに 409 になること、
   使えないファイルの 422 DRIVE_FILE_NOT_ACCESSIBLE と grant の後の成功、DRIVE_CREATED_NOT_REGISTERED、
   新しい版を作るの参考資料の引き継ぎとタグを引き継がないこと、同時に新しい版を作ったときの採番、権限マトリクスの該当行

まだやらないこと: Google の本物(OAuth と Drive の REST)は Step 6。画面(Step 7〜)。

ゴール:
- make test が全パス
- make dev で起動し、開発用ログイン(山田)のセッションで curl を叩くと、提案書の versions/copy で v4 ができ(参考資料は v3 と同じ、タグは空)、
  documents/new で A社 DX提案に新しい系列ができ、copies で B社 市場調査に系列ができる(参考資料にコピー元の版)
- 田中のセッションでは、作成系のエンドポイントが 409 DRIVE_REAUTH_REQUIRED を返す
```

---

## Step 6: Google のログイン + 本物のドライブ

Status:

```
docs/02-01_system-design-doc.md の ADR-010・ADR-011・ADR-012・ADR-013、5.2、5.7、7章(OAuth・Google のトークン)、8章(Drive の応答の分け方)と、
docs/design-spec.md 6.0.5・6.5.1、docs/05_operation-runbook.md 1章(event)に従って、Google のログインと本物のドライブを実装してください。

やること:
0. apps/api/src/lib/config.ts に GOOGLE_CLIENT_ID・GOOGLE_CLIENT_SECRET・GOOGLE_PICKER_API_KEY・GOOGLE_PROJECT_NUMBER の検証を足す(DRIVE_MODE=google のときだけ必須)
1. apps/api/src/auth/: Arctic で Google の OAuth(PKCE・state・一時 Cookie)。
   - GET /api/auth/google/login(returnTo の検証、locale、consent)
   - GET /api/auth/google/callback(mode: login の手順1〜7。判定の順、リフレッシュトークンが返らないときの送り直し、失敗時の wx_login_notice)
   - GET /api/auth/google/reconnect(mode: reconnect の結果と wx_drive_notice。DRIVE_MODE=mock のときの振る舞いは 02-01 5.10)
2. リフレッシュトークンの暗号化と鍵の入れ替え(ADR-012)。復号できなければ token_decrypt_failed のログ
3. apps/api/src/drive/google.ts: Step 4〜5 と同じインターフェースを Drive API v3 の REST(fetch)で実装する(googleapis は使わない。ADR-002)。
   アクセストークンはインスタンスのメモリにだけキャッシュする。Google の応答の分け方と、drive_reauth_required・drive_api_error のログは 02-01 8章・05 1章
4. テスト: 単体テストで、トークンの暗号化・復号と鍵の入れ替え、returnTo の検証、ID トークンのクレームの確認、ログインの判定の順、
   Drive の応答の分け方(fetch を差し替えて確かめる)。本物の Google のアカウントはテストに持ち込まない(ADR-017)

まだやらないこと: 画面(ログイン画面は Step 7)。

ゴール:
- make test が全パス
- GOOGLE_* が空の .env(開発の既定)でも make dev で API が起動し、開発用ログインがこれまでどおり使える
- DRIVE_MODE=mock のまま、田中のセッションで GET /api/auth/google/reconnect を curl で呼ぶと、連携が連携中に戻り、
  wx_drive_notice(reconnected)を付けて returnTo へ戻る
- 本物の Google での確認は、ローカルでは docs/03_dev-setup.md 6章、本番では docs/04_deployment-procedure.md 6章の手順が受け持つ(ADR-016・ADR-017)。
  03 6章の認証情報が .env に入っていれば、その手順でログインとドライブの許可を確かめる
```

---

## Step 7: 画面の土台(共通UI)+ ログイン・エラー画面

Status:

```
docs/design-spec.md の 1.2(言語と表示の規則)・1.3・3.5・4章・6.0・6.5.1・6.5.7 と、
docs/02-01_system-design-doc.md の ADR-005・ADR-014・ADR-017・ADR-020、4章・8章(フロントエンドでの表示方針)・9章・10章に従って、
画面の土台を実装してください。

やること:
1. スタイル: Tailwind の @theme から tokens.css の CSS 変数を参照する。スタイリングはセマンティック層の変数だけを使う
   (値の直書き・プリミティブの直参照はしない)。ライトとダークは OS の設定に従う
2. i18n: react-i18next と apps/web/src/locales/{ja,en}.json、表示言語の決め方、日時の書式、名前の並べ替え、英語の単数・複数(02-01 9章)
3. API クライアント: Eden Treaty(apps/web/src/lib/api.ts)と TanStack Query。エラーコードを design-spec 6.0.2 の5分類に当てはめる
   共通の処理(02-01 8章「フロントエンドでの表示方針」)
4. ルーティング(TanStack Router): 02-01 4章の全ルート。認証の要るルートの未ログイン時の /login?returnTo=。
   ホーム・案件・メンバー管理・利用者管理はルートの定義(認証の要否と returnTo の確認に使う)までにし、画面の中身は Step 8〜10 で作る
5. レイアウトの部品(design-spec 4.1・4.3): P1 中央集中、P2 一覧 + 横パネル、P3 一覧、D ダイアログ(Radix)。
   高密度の表(列見出しでの並べ替え、灰色の仮の行、行のホバーの「開く ↗」)、確認ダイアログ、通知(design-spec 3.5・6.0.1。失敗の詳細にリクエスト ID)
6. 全画面に共通の要素(design-spec 3.5): ヘッダー、ユーザーメニュー(表示言語・利用者管理・ログアウト)、要再連携の帯と「もう一度連携する」、
   戻ったときの wx_drive_notice の通知(design-spec 6.0.5)
7. ログイン画面(design-spec 6.5.1): Google でログイン、表示言語の切り替え、wx_login_notice の表示、
   開発用ログイン(/api/config の devLogin のときだけ。利用者を選んで入る)
8. エラー画面(design-spec 6.5.7)とエラー境界(想定外のエラーを POST /api/client-errors に送る)
9. E2E の土台: e2e/ に Playwright(Chromium。開発用ログインとドライブの模擬で DB・API・画面をテスト用の設定で起動する。03 7章)。
   E2E: 開発用ログインで入りヘッダーに利用者が出る、ログアウト、未ログインで案件の URL を開くとログインの後に元の URL へ戻る、
   停止中の鈴木はログイン画面に停止の表示が出る、存在しない URL のエラー画面、日英の切り替え、要再連携の帯ともう一度連携する(田中)
10. 部品の単体テスト(bun test + Testing Library + happy-dom): 日時の書式、エラーコードから表示への変換、日英の翻訳ファイルのキーの一致

まだやらないこと: ホーム・案件・メンバー管理・利用者管理の画面の中身(Step 8〜10)。

ゴール:
- make test と make e2e が全パス
- make dev で開いた http://localhost:5173 で、開発用ログインから入り、ヘッダー・ユーザーメニュー・日英の切り替え・ログアウトが動く。
  田中で入ると要再連携の帯が出て、「もう一度連携する」で帯が消え「ドライブに再連携しました」と通知される。ライトとダークの両方で崩れない
```

---

## Step 8: コア画面(探して開く): ホーム U1 + 案件 U2

Status:

```
docs/design-spec.md の 2.2(コアフロー)・6.4(ホーム)・6.1(案件)・6.6(モバイル)と、
docs/02-01_system-design-doc.md の 4章・5.4〜5.6 に従って、「探して開く」のコア画面を実装してください。

やること:
1. ホーム U1(design-spec 6.4):
   - 案件一覧(列・並び順・行を押すと案件へ)と状態ごとの表示
   - 「+ 案件を作る」と案件を作るダイアログ(作成するとその案件へ)
   - 横断検索(?q=、入力が止まってから検索、結果の列と旧版の添え書き、50件の打ち切り、行を押すとその系列と版を選んだ案件画面へ、開くアイコン)
2. 案件 U2 の閲覧(design-spec 6.1):
   - 案件ヘッダー(← ホーム、案件名と役割のバッジ、メンバー n人、⋯ メニューの案件名を変更・案件を削除)。
     「+ 資料を追加」は Step 9、メンバー管理の中身は Step 10 で作る
   - ツールバー(資料名の絞り込み、種別フィルタ、件数)と表(列、タグのバッジと「+n」のホバー、旧版 n件、並べ替え、行のホバーの「開く ↗」、幅が足りないときの省略)
   - 横パネル(見出し・開く・概要・版・参考資料・この資料を参考にした資料。関連資料の表示規則1〜4と押したときの移動、区分ごとの名前順、「×」と Esc)。
     横パネルが開いている間の表の2列表示
   - URL の ?series=&doc= と選択状態の同期(無い・削除済みの系列と版の扱い)
   - 開いたときのメタデータの取り直し(表を出した後に呼ぶ。連携中のときだけ)
   - 状態ごとの表示(読み込み中、0件、絞り込みで0件、読み込み失敗、見つからない、横パネルの読み込み中と失敗と「なし」)
3. モバイル(design-spec 6.6): ホームと案件の2列表示、案件の行を押すと全画面のシート(操作の欄なし)、変更系の操作を出さない
4. E2E(design-spec 2.2 のフロー): 探して開く(ホームから案件、資料を選んで横パネルで参考資料・版・参考にした資料をたどり、開くで別タブ)、
   横断検索(旧版の結果から、その版を表示した案件画面へ)、案件を作る、案件名の変更と案件の削除、関連資料の表示規則
   (山田で「削除された資料」、佐藤で「見る権限のない資料」)、URL での選択状態の復元、モバイルの幅での表示。
   コアフロー「探して開く」の E2E は受入スイートを兼ねるので、実装の内部でなく design-spec の振る舞いで書く

まだやらないこと: 資料を追加・作成ダイアログ・版の操作(Step 9)、新しい版を登録・登録内容を編集・メンバー管理・利用者管理(Step 10)。

ゴール:
- make test と make e2e が全パス
- make dev で山田でログインしたホームと A社 DX提案の案件画面が、design-spec 6.4・6.1 の画面例どおりに並ぶ(提案書 v3 の 確認済・提出 v2・+1、旧版 2件)
- 横パネルでコアフローが一通り動き、日英・ライトとダーク・デスクトップとタブレットとモバイルの幅で崩れない
```

---

## Step 9: コア画面(作る・記録する): 資料を追加・作成ダイアログ・版の削除

Status:

```
docs/design-spec.md の 6.0.3〜6.0.5・6.0.8・6.0.9・6.1(操作・版を削除した後)・6.2・6.3 と、
docs/02-01_system-design-doc.md の ADR-011、5.5・5.7、7章(Google のトークン・外部リンク)に従って、案件画面で資料を作る・記録する操作を実装してください。

やること:
1. 入力の共通部品: 1行入力と検証(packages/shared の上限と数え方。欄の下の理由と確定ボタンの無効化)、
   リンク欄(貼った時点の種別の判定、資料名と更新日時の自動取得、重複の表示とその資料を選ぶリンク)、
   参考資料の選択(候補の検索・チップ・関連資料の表示規則に従った表示・上限)、日付ピッカー(未来の日付は選べない)
2. ファイル選択画面(design-spec 6.0.9): Google Picker(POST /api/drive/picker-token と /api/config の picker。トークンはメモリにだけ持つ)と、
   DRIVE_MODE=mock のときの模擬のファイル選択画面(選ぶと POST /api/dev/drive/grant。02-01 5.10)。
   「ドライブから選ぶ」と「このファイルをアプリで使えるようにする」
3. 資料を追加ダイアログ(design-spec 6.2): 「新しく作る」(既定のタブ)と「リンクで登録」、状態ごとの表示、要再連携のときの扱い(6.0.5)、
   作成後の別タブと「編集画面を開く ↗」の通知、作成の失敗と「このリンクで登録」(6.0.8)
4. 作成ダイアログ(design-spec 6.3): これを元に作る(追加先の案件の選択、別の案件なら通知にリンク)と新しい版を作る(変更メモ)。
   開いた時点のコピー元の確認
5. 案件ヘッダーの「+ 資料を追加」と、横パネルの操作の欄の「新しい版を作る」「これを元に作る」「この版を削除」(出し分けと、版を削除した後の表示)。
   「新しい版を登録」「登録内容を編集」は Step 10 でダイアログと一緒に足す
6. E2E: 新しく作る、リンクで登録(自動取得・重複・参考資料)、これを元に作る(別の案件へ)、新しい版を作る(模擬のファイル選択画面での許可を含む)、
   版の削除、要再連携の田中での作成ダイアログの案内と「もう一度連携する」

まだやらないこと: 新しい版を登録・登録内容を編集(タグの入力を含む)・メンバー管理・利用者管理(Step 10)。

ゴール:
- make test と make e2e が全パス
- make dev で、山田が A社 DX提案で新しく作る・リンクで登録・これを元に作る・新しい版を作る・版の削除を行うと、表と横パネルが design-spec 6.1〜6.3 のとおりに変わる
- 田中で B社 市場調査の作成ダイアログを開くと、要再連携の案内が出て「作成」を押せない。資料を追加は「リンクで登録」タブで開く
```

---

## Step 10: 残り画面: 新しい版を登録・登録内容を編集・メンバー管理・利用者管理

Status:

```
docs/design-spec.md の 6.5.5・6.5.6・6.5.2・6.5.4・6.6 と docs/screen_flow.mermaid、
docs/02-01_system-design-doc.md の 5.5・5.8・5.9 に従って、残りの画面とダイアログを実装してください。

やること:
1. 新しい版を登録ダイアログ(design-spec 6.5.5): Step 9 のリンク欄と参考資料の部品を使う。初期値と、候補から同じ系列を除くこと
2. 登録内容を編集ダイアログ(design-spec 6.5.6): タグの入力(候補、確定のしかた、チップ、上限、重複、確定していない入力。6.0.3)、変更メモ、
   Google から取得済みの版の読み取り専用、リンクを変えたときの取り直し
3. 横パネルの操作の欄に「新しい版を登録」「登録内容を編集」を足す
4. メンバー管理 U3(design-spec 6.5.2): 表(並び順、停止中・未ログインの表示)、オーナーの操作(役割のプルダウン、外す、最後のオーナーの無効化と理由、
   自分の役割を下げる確認、自分を外したらホームへ)、オーナー以外の読み取り専用表示、メンバーを招待ダイアログ、状態ごとの表示
5. 利用者管理 A1(design-spec 6.5.4): 表(並び順、絞り込み)、⋯ メニュー(停止・再開、管理者にする・外す、自分の行の無効化)、
   利用者を追加ダイアログ、停止の確認(唯一のオーナーの案件数の警告)、管理者でない人の表示、状態ごとの表示
6. モバイル(design-spec 6.6): メンバー管理・利用者管理を URL で開いたときの表示
7. E2E: 新しい版を登録、タグと変更メモ(表のタグのバッジに反映される)、招待と役割の変更(最後のオーナーの無効化を含む)、
   利用者の停止(停止された側が次の操作でログイン画面の停止の表示になる)、管理者を外された人の利用者管理の表示

まだやらないこと: インフラと CI/CD(Step 11)。

ゴール:
- make test と make e2e が全パス
- make dev で design-spec 2.2 のフローがすべて画面から動き、docs/screen_flow.mermaid の全画面間の遷移がつながる
```

---

## Step 11: インフラ + CI/CD

Status:

```
docs/04_deployment-procedure.md の 2章・3章・5章、docs/02-01_system-design-doc.md の 2章・ADR-006〜ADR-009・ADR-015・ADR-019・ADR-022・
7章(セキュリティヘッダー・レート制限・ログ・DB への接続・パフォーマンス)、docs/05_operation-runbook.md 1章・2章・6章に従って、
インフラと CI/CD を実装してください。

やること:
1. infra/(Terraform。backend は GCS):
   - 04 3章「Terraform が作成するリソース」の表のすべて(LB と URL マップ、証明書、Cloud Armor、バックエンドバケットと CDN、
     バケット2つ、Cloud SQL、Artifact Registry、Secret Manager の入れ物、サービスアカウント2つと権限、Workload Identity、
     app_enabled で2回目に作る Cloud Run のサービスとジョブ)
   - Cloud Run の環境変数とシークレット(04 3章 Step 5 の表)、イメージの変更を無視する設定(ADR-015)、最大台数と接続プールの掛け算(02-01 7章)
   - Cloud SQL のデータベースフラグ(02-01 7章「ログ」)、応答のセキュリティヘッダーとキャッシュ(02-01 7章)
   - 古いリビジョン・イメージ・画面のビルドの自動の削除と、本番に出したバージョンの除外(04 5章、05 6章)
   - infra/monitoring.tf: 05 2章の監視とアラートのすべて(ログベースの指標、通知チャネル、予算アラート)
   - infra/environments/production.tfvars.example(04 3章 Step 3 の変数。秘密を含めない)、出力 lb_ip_address・wif_provider・deployer_service_account
2. .github/workflows/: ci.yml・build.yml・deploy.yml・infra.yml(04 2章の手順。テストとビルドは make のターゲット、配布は gcloud)。
   deploy/production/version は最初のリリースの promotion PR(04 3章 Step 7)で作るので、deploy.yml はこのファイルの追加と変更の両方で動かす

まだやらないこと: 本番への apply とリリース(04 3章の手順でユーザーが行う)。

ゴール:
- ops のコンテナの中で terraform の init(-backend=false)と validate が通る
- PR を作ると ci.yml が緑になる(GCP を使わないので、クラウドなしで確かめられる)
- GCP のプロジェクト(04 3章 Step 1〜2 の手作業)がある状態で、make tf-init と make tf-plan がエラーなく通る。
  プロジェクトや認証情報が無ければ、それを理由に blocked にする(用意するのはユーザー)
```

---

## Step 12: テスト + 仕上げ

Status:

```
docs/02-01_system-design-doc.md 10章のテスト戦略を満たし、コード品質を仕上げてください。

やること:
1. カバレッジ: 10章の目標(packages/shared と apps/api/src/domain の行 90%、apps/api の行 80%)を bun test のカバレッジで確かめ、足りない分のテストを足す
2. 結合テスト: 02-01 7章の権限マトリクスの全行を役割ごとに叩いて、期待の状態コードになること(Step 3〜5 で足した分と突き合わせて漏れを埋める)。
   10章の同時操作のテストがそろっていること
3. E2E: 10章の E2E の一覧と、Step 7〜10 で足した E2E を突き合わせ、無いものを足す。
   異常系の最低ライン(不正入力のエラー表示・未ログインでのログイン画面への誘導・空状態の表示)を含める
4. KPI の計測(01_prd 5章、05 6章「KPI の測り方」): アクセス解析は入れない。05 6章の2つの SQL がデモデータと E2E の後のデータで意図どおりの値を返すこと、
   request のログに userId と route(GET /api/projects/:projectId/series)が出ることを確かめる
5. README.md(ルート): アプリの一言説明と、docs/README.md・docs/03_dev-setup.md 3章への入口を足す(DRAFT のプラグインの説明は残す)

ゴール:
- make test と make e2e が全パスし、カバレッジが 10章の目標を満たす
- make lint と make typecheck がエラー0、make format の後に差分が無い、make doc-lint が通る
```

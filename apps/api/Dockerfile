# 本番の API のイメージ。Cloud Run のサービスと、作業ディレクトリを apps/api にして
# scripts/ を動かすジョブ weaponx-migrate の両方で使う(docs/04_deployment-procedure.md 3章)
FROM oven/bun:1.4.2 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
# 画面の依存は API のイメージに要らないので、workspace の宣言だけを合わせて API の分だけ入れる
COPY apps/web/package.json apps/web/package.json
# 通信を検査するネットワークでは証明書を BuildKit の secret で渡す(イメージには残さない。03 3章 EXTRA_CA_CERT)
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    bun install --frozen-lockfile --production --filter @weaponx/api --filter @weaponx/shared

FROM oven/bun:1.4.2
# 版はビルド時にイメージへ焼き込む。デプロイが環境変数で上書きしないので、Terraform の差分にならず、
# 前のバージョンに戻したときもイメージ自身の版を返す(04 2章)
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION}
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# 依存の実体は /app/node_modules/.bun にあり、apps/api/node_modules のリンクがそこを指す。両方そろえて初めて import が通る
COPY --from=deps /app/apps/api/node_modules apps/api/node_modules
COPY package.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
USER bun
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["bun", "src/index.ts"]

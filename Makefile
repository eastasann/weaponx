# 実コマンドの唯一の真実源(docs/03_dev-setup.md 8章)。どれも Docker Compose のコンテナの中で動かす
COMPOSE := docker compose
TOOLS := $(COMPOSE) run --rm tools
TOOLS_NODEPS := $(COMPOSE) run --rm --no-deps tools
OPS := $(COMPOSE) --profile ops run --rm ops
E2E := $(COMPOSE) --profile e2e run --rm e2e

.PHONY: setup dev stop build test e2e e2e-report lint format typecheck tokens \
	db-up db-push db-generate db-migrate db-seed db-reset db-studio db-psql bootstrap-admin \
	ops-login ops-shell tf-init tf-plan tf-apply tf-output doc-lint shell deps-update clean

setup:
	@if [ ! -f .env ]; then \
		cp .env.example .env; \
		chmod 600 .env; \
		key="local:$$(head -c 32 /dev/urandom | base64)"; \
		sed -i.bak "s|^TOKEN_ENCRYPTION_KEYS=.*|TOKEN_ENCRYPTION_KEYS=$$key|" .env && rm -f .env.bak; \
		echo ".env を作りました"; \
	fi
	$(COMPOSE) build
	$(TOOLS_NODEPS) bun install
	$(MAKE) tokens
	$(MAKE) db-migrate db-seed
	git config core.hooksPath .githooks

dev:
	$(COMPOSE) up db api web

stop:
	$(COMPOSE) down

build:
	$(TOOLS_NODEPS) bun run --cwd apps/web build
	@ca="$${EXTRA_CA_CERT:-$$(sed -n 's/^EXTRA_CA_CERT=//p' .env 2>/dev/null)}"; \
	if [ -n "$$ca" ]; then \
		docker build --secret "id=extra_ca,src=$$ca" -f apps/api/Dockerfile -t weaponx-api:local .; \
	else \
		docker build -f apps/api/Dockerfile -t weaponx-api:local .; \
	fi

test:
	$(COMPOSE) up -d --wait db
	$(COMPOSE) exec -T db psql -U weaponx -d postgres -v ON_ERROR_STOP=1 \
		-c "DROP DATABASE IF EXISTS weaponx_test WITH (FORCE)" -c "CREATE DATABASE weaponx_test OWNER weaponx"
	@# 画面の部品のテストは DOM を全体に登録するので、API・shared のテストとは別の実行にする(bunfig.toml)
	$(TOOLS) sh -c 'DATABASE_URL="$$TEST_DATABASE_URL" bun apps/api/scripts/migrate.ts && \
		if [ -z "$(ARGS)" ] || [ -n "$(filter-out apps/web/%,$(ARGS))" ]; then bun test $(filter-out apps/web/%,$(ARGS)); fi && \
		if [ -z "$(ARGS)" ] || [ -n "$(filter apps/web/%,$(ARGS))" ]; then cd apps/web && bun test $(patsubst apps/web/%,%,$(filter apps/web/%,$(ARGS))); fi'

e2e:
	$(COMPOSE) up -d --wait db
	$(COMPOSE) exec -T db psql -U weaponx -d postgres -v ON_ERROR_STOP=1 \
		-c "DROP DATABASE IF EXISTS weaponx_test WITH (FORCE)" -c "CREATE DATABASE weaponx_test OWNER weaponx"
	$(TOOLS) sh -c 'DATABASE_URL="$$TEST_DATABASE_URL" bun apps/api/scripts/migrate.ts && DATABASE_URL="$$TEST_DATABASE_URL" bun apps/api/scripts/seed.ts'
	$(COMPOSE) --profile e2e up -d --wait api-e2e web-e2e
	@$(E2E) npx playwright test $(ARGS); status=$$?; \
		$(COMPOSE) --profile e2e stop api-e2e web-e2e >/dev/null 2>&1; exit $$status

e2e-report:
	$(COMPOSE) --profile e2e run --rm --service-ports e2e npx playwright show-report --host 0.0.0.0

lint:
	$(TOOLS_NODEPS) bunx biome check .

format:
	$(TOOLS_NODEPS) bunx biome check --write .

typecheck:
	$(TOOLS_NODEPS) bun run typecheck

tokens:
	$(TOOLS_NODEPS) bun scripts/gen-tokens.ts

db-up:
	$(COMPOSE) up -d --wait db

db-push:
	$(TOOLS) sh -c 'cd apps/api && bunx drizzle-kit push'

db-generate:
	$(TOOLS) sh -c 'cd apps/api && bunx drizzle-kit generate $(if $(CUSTOM),--custom)'

db-migrate:
	$(TOOLS) bun apps/api/scripts/migrate.ts

db-seed:
	$(TOOLS) bun apps/api/scripts/seed.ts

db-reset:
	$(COMPOSE) up -d --wait db
	$(COMPOSE) exec -T db psql -U weaponx -d weaponx -v ON_ERROR_STOP=1 \
		-c "DROP SCHEMA public CASCADE" -c "DROP SCHEMA IF EXISTS drizzle CASCADE" -c "CREATE SCHEMA public"
	$(TOOLS) sh -c 'bun apps/api/scripts/migrate.ts && bun apps/api/scripts/seed.ts'

db-studio:
	$(COMPOSE) run --rm -p 127.0.0.1:4983:4983 tools sh -c 'cd apps/api && bunx drizzle-kit studio --host 0.0.0.0'

db-psql:
	$(COMPOSE) up -d --wait db
	$(COMPOSE) exec db psql -U weaponx -d weaponx

bootstrap-admin:
	@test -n "$(EMAIL)" || { echo "EMAIL=you@example.com を指定してください"; exit 1; }
	$(TOOLS) bun apps/api/scripts/bootstrap-admin.ts "$(EMAIL)"

ops-login:
	$(OPS) sh -c 'gcloud auth login --no-launch-browser && gcloud auth application-default login --no-launch-browser'

ops-shell:
	$(OPS) bash

tf-init:
	$(OPS) terraform -chdir=infra init

tf-plan:
	$(OPS) terraform -chdir=infra plan -var-file=environments/production.tfvars

tf-apply:
	$(OPS) terraform -chdir=infra apply -var-file=environments/production.tfvars

tf-output:
	@test -n "$(NAME)" || { echo "NAME=... を指定してください"; exit 1; }
	$(OPS) terraform -chdir=infra output -raw "$(NAME)"

doc-lint:
	scripts/doc-lint.sh --docs

shell:
	$(COMPOSE) run --rm tools bash

deps-update:
	$(TOOLS_NODEPS) bun update

clean:
	$(COMPOSE) --profile e2e --profile ops down -v --remove-orphans
	rm -rf node_modules apps/*/node_modules packages/*/node_modules apps/web/dist e2e/node_modules e2e/playwright-report e2e/test-results

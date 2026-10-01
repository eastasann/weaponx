locals {
  placeholder_image = "us-docker.pkg.dev/cloudrun/container/hello"
}

# 1回目の apply(app_enabled = false)では作らない。イメージは deploy.yml が更新し、Terraform は無視する(ADR-015)
resource "google_cloud_run_v2_service" "api" {
  count    = var.app_enabled ? 1 : 0
  name     = "weaponx-api"
  location = var.region

  # run.app の URL から直接は呼べない(ADR-007)
  ingress             = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  deletion_protection = false

  template {
    service_account = google_service_account.api.email

    # 最大台数 × 接続プール(apps/api/src/db/client.ts の MAX_POOL_CONNECTIONS)
    # < db-f1-micro の接続数の上限(約25)。どちらかを変えるときは掛け算を確かめる(02-01 7章)
    scaling {
      min_instance_count = 0
      max_instance_count = 3
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.weaponx.connection_name]
      }
    }

    containers {
      image = local.placeholder_image

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }

      startup_probe {
        http_get {
          path = "/api/healthz"
        }
        period_seconds    = 2
        failure_threshold = 15
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "APP_ORIGIN"
        value = "https://${var.domain}"
      }
      env {
        name  = "LOG_LEVEL"
        value = "info"
      }
      env {
        name  = "GCP_PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "DRIVE_MODE"
        value = "google"
      }
      env {
        name  = "DEV_LOGIN_ENABLED"
        value = "false"
      }
      env {
        name  = "GOOGLE_CLIENT_ID"
        value = var.google_client_id
      }
      env {
        name  = "GOOGLE_PICKER_API_KEY"
        value = var.google_picker_api_key
      }
      env {
        name  = "GOOGLE_PROJECT_NUMBER"
        value = var.project_number
      }
      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["database_url"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "GOOGLE_CLIENT_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["google_client_secret"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "TOKEN_ENCRYPTION_KEYS"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["token_encryption_keys"].secret_id
            version = "latest"
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      template[0].revision,
      template[0].labels,
      labels,
      client,
      client_version,
    ]
  }

  depends_on = [
    google_secret_manager_secret_iam_member.api_accessor,
    google_project_iam_member.api,
  ]
}

# LB の経由でしか届かない(ingress)ので、呼び出しの認可は開ける。認証はアプリのセッションで行う
resource "google_cloud_run_v2_service_iam_member" "api_invoker" {
  count    = var.app_enabled ? 1 : 0
  name     = google_cloud_run_v2_service.api[0].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# マイグレーションと初期管理者の登録。API と同じイメージで、作業ディレクトリは apps/api(Dockerfile)。
# bootstrap-admin は gcloud run jobs execute --command で上書きして流す(04 3章 Step 7)
resource "google_cloud_run_v2_job" "migrate" {
  count               = var.app_enabled ? 1 : 0
  name                = "weaponx-migrate"
  location            = var.region
  deletion_protection = false

  template {
    template {
      service_account = google_service_account.api.email
      max_retries     = 0
      timeout         = "600s"

      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [google_sql_database_instance.weaponx.connection_name]
        }
      }

      containers {
        image   = local.placeholder_image
        command = ["bun"]
        args    = ["scripts/migrate.ts"]

        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }

        env {
          name  = "NODE_ENV"
          value = "production"
        }
        env {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.app["database_url"].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].template[0].containers[0].image,
      labels,
      client,
      client_version,
    ]
  }

  depends_on = [
    google_secret_manager_secret_iam_member.api_accessor,
    google_project_iam_member.api,
  ]
}

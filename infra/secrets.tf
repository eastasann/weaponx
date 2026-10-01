# 入れ物だけを作る。値は gcloud で入れ、state に残さない(04 3章 Step 4)
locals {
  secrets = {
    database_url          = "weaponx-database-url"
    google_client_secret  = "weaponx-google-client-secret"
    token_encryption_keys = "weaponx-token-encryption-keys"
  }
}

resource "google_secret_manager_secret" "app" {
  for_each  = local.secrets
  secret_id = each.value

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
}

resource "google_secret_manager_secret_iam_member" "api_accessor" {
  for_each  = local.secrets
  secret_id = google_secret_manager_secret.app[each.key].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api.email}"
}

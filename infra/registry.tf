resource "google_artifact_registry_repository" "weaponx" {
  location      = var.region
  repository_id = "weaponx"
  format        = "DOCKER"
  description   = "weaponx API のイメージ(タグ = バージョン。本番に出したものは prod-{バージョン} も付く)"

  # KEEP が DELETE に優先する。本番に出したバージョンと直近5つは残し、残りは30日で消す(04 5章)
  cleanup_policy_dry_run = false

  cleanup_policies {
    id     = "keep-deployed"
    action = "KEEP"
    condition {
      tag_state    = "TAGGED"
      tag_prefixes = ["prod-"]
    }
  }

  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 5
    }
  }

  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition {
      older_than = "2592000s"
    }
  }
}

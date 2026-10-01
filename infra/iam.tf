resource "google_service_account" "api" {
  account_id   = "weaponx-api"
  display_name = "weaponx API の実行用"
}

resource "google_service_account" "deployer" {
  account_id   = "weaponx-deployer"
  display_name = "GitHub Actions のビルドとデプロイ用"
}

resource "google_service_account" "terraform_apply" {
  account_id   = "weaponx-tf-apply"
  display_name = "GitHub Actions の terraform apply 用(main だけ)"
}

resource "google_service_account" "terraform_plan" {
  account_id   = "weaponx-tf-plan"
  display_name = "GitHub Actions の terraform plan 用(読み取りのみ)"
}

# API の実行用: DB 接続とログ・トレースの書き込み。シークレットは secrets.tf で個別に許可する
resource "google_project_iam_member" "api" {
  for_each = toset([
    "roles/cloudsql.client",
    "roles/logging.logWriter",
    "roles/cloudtrace.agent",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.api.email}"
}

# デプロイ用: Cloud Run のサービスとジョブの更新・実行、イメージの push、バケットへの書き込み
resource "google_project_iam_member" "deployer_run" {
  project = var.project_id
  role    = "roles/run.developer"
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_service_account_iam_member" "deployer_acts_as_api" {
  service_account_id = google_service_account.api.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_artifact_registry_repository_iam_member" "deployer_push" {
  location   = google_artifact_registry_repository.weaponx.location
  repository = google_artifact_registry_repository.weaponx.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_storage_bucket_iam_member" "deployer_buckets" {
  for_each = {
    web      = google_storage_bucket.web.name
    releases = google_storage_bucket.releases.name
  }
  bucket = each.value
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.deployer.email}"
}

# infra.yml の apply は IAM も変えるので広い権限が要る。呼べるのを main のワークフローだけにして守る
resource "google_project_iam_member" "terraform_apply" {
  project = var.project_id
  role    = "roles/owner"
  member  = "serviceAccount:${google_service_account.terraform_apply.email}"
}

# PR の plan は読み取りだけ。PR のワークフローは PR の作者が書き換えられるので、state には書かせない
# (infra.yml は plan を -lock=false で流す)。serviceUsageConsumer は provider の billing_project に要る
resource "google_project_iam_member" "terraform_plan" {
  for_each = toset(["roles/viewer", "roles/iam.securityReviewer", "roles/serviceusage.serviceUsageConsumer"])
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.terraform_plan.email}"
}

resource "google_storage_bucket_iam_member" "terraform_plan_state" {
  bucket = local.tfstate_bucket
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.terraform_plan.email}"
}

# 予算(google_billing_budget)は請求先アカウントの権限で、プロジェクトの owner には含まれない
resource "google_billing_account_iam_member" "terraform_apply" {
  for_each           = toset(["roles/billing.costsManager", "roles/billing.viewer"])
  billing_account_id = var.billing_account_id
  role               = each.value
  member             = "serviceAccount:${google_service_account.terraform_apply.email}"
}

resource "google_billing_account_iam_member" "terraform_plan" {
  billing_account_id = var.billing_account_id
  role               = "roles/billing.viewer"
  member             = "serviceAccount:${google_service_account.terraform_plan.email}"
}

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github"
  display_name              = "GitHub Actions"
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub Actions"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }

  # このリポジトリ以外のワークフローは、どのサービスアカウントにもなれない
  attribute_condition = "assertion.repository == '${var.github_repository}'"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

locals {
  wif_pool = google_iam_workload_identity_pool.github.name
}

resource "google_service_account_iam_member" "wif_plan" {
  service_account_id = google_service_account.terraform_plan.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${local.wif_pool}/attribute.repository/${var.github_repository}"
}

resource "google_service_account_iam_member" "wif_apply" {
  service_account_id = google_service_account.terraform_apply.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${local.wif_pool}/attribute.ref/refs/heads/main"
}

resource "google_service_account_iam_member" "wif_deployer" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${local.wif_pool}/attribute.ref/refs/heads/main"
}

terraform {
  required_version = ">= 1.13"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }

  # バケット名は変数を使えないので、make tf-init と infra.yml が
  # -backend-config="bucket={PROJECT_ID}-tfstate" で渡す(ADR-015)
  backend "gcs" {
    prefix = "weaponx"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region

  # 予算アラート(billingbudgets)は呼び出し元のプロジェクトを課金先として要求する
  user_project_override = true
  billing_project       = var.project_id
}

locals {
  web_bucket      = "${var.project_id}-weaponx-web"
  releases_bucket = "${var.project_id}-weaponx-releases"
  tfstate_bucket  = "${var.project_id}-tfstate"
  api_image_base  = "${var.region}-docker.pkg.dev/${var.project_id}/weaponx/api"
}

output "lb_ip_address" {
  value       = google_compute_global_address.lb.address
  description = "{DOMAIN} の A レコードに設定する IP"
}

output "wif_provider" {
  value       = google_iam_workload_identity_pool_provider.github.name
  description = "GitHub Variables の GCP_WIF_PROVIDER"
}

output "deployer_service_account" {
  value       = google_service_account.deployer.email
  description = "GitHub Variables の GCP_DEPLOY_SA"
}

output "terraform_service_account" {
  value       = google_service_account.terraform_apply.email
  description = "GitHub Variables の GCP_TF_APPLY_SA"
}

output "terraform_plan_service_account" {
  value       = google_service_account.terraform_plan.email
  description = "GitHub Variables の GCP_TF_PLAN_SA"
}

variable "project_id" {
  type        = string
  description = "GCP のプロジェクト ID"
}

variable "project_number" {
  type        = string
  description = "プロジェクト番号。Picker の App ID に使う"
}

variable "region" {
  type    = string
  default = "asia-northeast1"
}

variable "domain" {
  type        = string
  description = "公開するドメイン(例: weaponx.example.com)"
}

variable "google_client_id" {
  type        = string
  description = "OAuth クライアント weaponx-production のクライアント ID"
}

variable "google_picker_api_key" {
  type        = string
  description = "Picker 用 API キー weaponx-picker(ウェブサイトと API で制限済みのキー)"
}

variable "github_repository" {
  type        = string
  description = "Workload Identity で許可する GitHub リポジトリ(owner/name)"
}

variable "alert_email" {
  type        = string
  description = "アラートの通知先メールアドレス"
}

variable "billing_account_id" {
  type        = string
  description = "予算アラートを作る請求先アカウントの ID"
}

variable "app_enabled" {
  type        = bool
  default     = false
  description = "Cloud Run のサービスとジョブを作るか。シークレットの値を入れる前は false(04 3章)"
}

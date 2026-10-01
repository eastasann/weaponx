locals {
  # 02-01 7章「セキュリティヘッダー」。API の応答は apps/api/src/lib/http.ts が同じ値を付ける
  security_headers = [
    "Strict-Transport-Security: max-age=31536000; includeSubDomains",
    "X-Content-Type-Options: nosniff",
    "Referrer-Policy: strict-origin",
    join("", [
      "Content-Security-Policy: default-src 'self'; ",
      "script-src 'self' https://apis.google.com; ",
      "frame-src https://docs.google.com https://drive.google.com https://accounts.google.com; ",
      "img-src 'self' data: https://*.googleusercontent.com; ",
      "frame-ancestors 'none'",
    ]),
  ]
}

# 配信する画面。Cache-Control は deploy.yml がファイルごとに付ける(assets/ は1年、index.html は no-cache)
resource "google_storage_bucket" "web" {
  name                        = local.web_bucket
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "inherited"
}

# 公開するのは画面の静的ファイルだけ。資料の情報は API の向こうにある
resource "google_storage_bucket_iam_member" "web_public" {
  bucket = google_storage_bucket.web.name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}

# web/{バージョン}/ は main のたびに増えるので、本番に出していないものは30日で消す。
# 本番に出したものは deploy.yml が deployed/{バージョン}/ に写すので、そちらは消さない(04 5章)
resource "google_storage_bucket" "releases" {
  name                        = local.releases_bucket
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      age            = 30
      matches_prefix = ["web/"]
    }
  }
}

# 05 2章「監視ポイントとアラート」。通知はすべてメール

locals {
  api_log_filter = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"weaponx-api\""
  api_backend    = "weaponx-api-backend"
  db_id          = "${var.project_id}:${google_sql_database_instance.weaponx.name}"

  # ログのイベントごとの件数のアラート。count は「これを超えたら」の値、period は集計の長さ(秒)
  event_alerts = {
    client_error = {
      title  = "画面の想定外のエラーが多い"
      count  = 5
      period = 3600
    }
    drive_reauth_required = {
      title  = "要再連携への切り替えが多い"
      count  = 5
      period = 3600
    }
    login_failed = {
      title  = "ログイン失敗が多い"
      count  = 20
      period = 3600
    }
    token_decrypt_failed = {
      title  = "リフレッシュトークンを復号できない"
      count  = 0
      period = 300
    }
  }
}

resource "google_monitoring_notification_channel" "email" {
  display_name = "weaponx アラートのメール"
  type         = "email"

  labels = {
    email_address = var.alert_email
  }
}

# ログ保持は30日(05 1章)
resource "google_logging_project_bucket_config" "default" {
  project        = var.project_id
  location       = "global"
  bucket_id      = "_Default"
  retention_days = 30
}

resource "google_monitoring_uptime_check_config" "healthz" {
  display_name = "weaponx /api/healthz"
  period       = "300s"
  timeout      = "10s"

  http_check {
    path           = "/api/healthz"
    port           = 443
    use_ssl        = true
    validate_ssl   = true
    request_method = "GET"
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = var.domain
    }
  }

  selected_regions = ["USA", "EUROPE", "ASIA_PACIFIC"]
}

resource "google_monitoring_alert_policy" "uptime" {
  display_name = "weaponx: 稼働(/api/healthz)"
  combiner     = "OR"

  # 2地域以上で、2回続けて(10分)失敗
  conditions {
    display_name = "アップタイムチェックの失敗"
    condition_threshold {
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.label.check_id=\"${google_monitoring_uptime_check_config.healthz.uptime_check_id}\" AND resource.type=\"uptime_url\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "600s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.project_id"]
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.id]
}

resource "google_monitoring_alert_policy" "api_5xx" {
  display_name = "weaponx: API の 5xx が多い"
  combiner     = "OR"

  conditions {
    display_name = "5分間の 5xx の割合が 5% 超"
    condition_threshold {
      filter             = "metric.type=\"loadbalancing.googleapis.com/https/request_count\" AND resource.type=\"https_lb_rule\" AND resource.label.backend_target_name=\"${local.api_backend}\" AND metric.label.response_code_class=500"
      denominator_filter = "metric.type=\"loadbalancing.googleapis.com/https/request_count\" AND resource.type=\"https_lb_rule\" AND resource.label.backend_target_name=\"${local.api_backend}\""
      comparison         = "COMPARISON_GT"
      threshold_value    = 0.05
      duration           = "0s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
      }
      denominator_aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.id]
}

resource "google_monitoring_alert_policy" "api_latency" {
  display_name = "weaponx: API の遅延(p95)"
  combiner     = "OR"

  conditions {
    display_name = "10分間 p95 が 2秒超"
    condition_threshold {
      filter          = "metric.type=\"loadbalancing.googleapis.com/https/total_latencies\" AND resource.type=\"https_lb_rule\" AND resource.label.backend_target_name=\"${local.api_backend}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 2000
      duration        = "600s"
      aggregations {
        alignment_period     = "600s"
        per_series_aligner   = "ALIGN_PERCENTILE_95"
        cross_series_reducer = "REDUCE_MAX"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.id]
}

# Error Reporting の「新しいエラーグループ」の通知は Terraform で作れない(コンソールの設定)。
# 同じ API の例外(event=unhandled_error)のログを1件でも拾い、1時間に1通までメールにする。
# 画面のエラー(client_error)は ERROR でも別の event なので入らない(ADR-019)
resource "google_monitoring_alert_policy" "unhandled_error" {
  display_name = "weaponx: API の例外"
  combiner     = "OR"

  conditions {
    display_name = "event=unhandled_error のログ"
    condition_matched_log {
      filter = "${local.api_log_filter} AND jsonPayload.event=\"unhandled_error\""
    }
  }

  alert_strategy {
    notification_rate_limit {
      period = "3600s"
    }
    auto_close = "86400s"
  }

  notification_channels = [google_monitoring_notification_channel.email.id]
}

# 件数だけを数える。本文は指標にもメールにも載せない(資料名が入りうる。02-01 7章「ログ」)
resource "google_logging_metric" "event" {
  for_each = local.event_alerts
  name     = "weaponx_${each.key}"
  filter   = "${local.api_log_filter} AND jsonPayload.event=\"${each.key}\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_monitoring_alert_policy" "event" {
  for_each     = local.event_alerts
  display_name = "weaponx: ${each.value.title}"
  combiner     = "OR"

  conditions {
    display_name = "${each.key} の件数"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.event[each.key].name}\" AND resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = each.value.count
      duration        = "0s"
      aggregations {
        alignment_period     = "${each.value.period}s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  alert_strategy {
    auto_close = "86400s"
  }

  notification_channels = [google_monitoring_notification_channel.email.id]
}

resource "google_monitoring_alert_policy" "db" {
  display_name = "weaponx: DB"
  combiner     = "OR"

  conditions {
    display_name = "CPU 使用率が 15分間 80% 超"
    condition_threshold {
      filter          = "metric.type=\"cloudsql.googleapis.com/database/cpu/utilization\" AND resource.type=\"cloudsql_database\" AND resource.label.database_id=\"${local.db_id}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0.8
      duration        = "900s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }

  conditions {
    display_name = "ストレージ使用率が 80% 超"
    condition_threshold {
      filter          = "metric.type=\"cloudsql.googleapis.com/database/disk/utilization\" AND resource.type=\"cloudsql_database\" AND resource.label.database_id=\"${local.db_id}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0.8
      duration        = "0s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }

  conditions {
    display_name = "接続数が 10分間 20 超"
    condition_threshold {
      filter          = "metric.type=\"cloudsql.googleapis.com/database/postgresql/num_backends\" AND resource.type=\"cloudsql_database\" AND resource.label.database_id=\"${local.db_id}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 20
      duration        = "600s"
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_MEAN"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.id]
}

resource "google_billing_budget" "monthly" {
  billing_account = var.billing_account_id
  display_name    = "weaponx 月 $50"

  budget_filter {
    projects = ["projects/${var.project_number}"]
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = "50"
    }
  }

  threshold_rules {
    threshold_percent = 0.5
  }
  threshold_rules {
    threshold_percent = 0.9
  }
  threshold_rules {
    threshold_percent = 1.0
  }

  all_updates_rule {
    monitoring_notification_channels = [google_monitoring_notification_channel.email.id]
    disable_default_iam_recipients   = true
  }
}

resource "google_compute_global_address" "lb" {
  name = "weaponx-ip"
}

resource "google_compute_managed_ssl_certificate" "lb" {
  name = "weaponx-cert"

  managed {
    domains = [var.domain]
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "google_compute_ssl_policy" "lb" {
  name            = "weaponx-ssl-policy"
  profile         = "MODERN"
  min_tls_version = "TLS_1_2"
}

# サーバーレス NEG はサービスができてから(app_enabled = true の2回目)
resource "google_compute_region_network_endpoint_group" "api" {
  count                 = var.app_enabled ? 1 : 0
  name                  = "weaponx-api-neg"
  region                = var.region
  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = google_cloud_run_v2_service.api[0].name
  }
}

# 02-01 7章「レート制限」。IP ごとに /api/auth/* は1分60回、それ以外の /api/* は1分600回
resource "google_compute_security_policy" "api" {
  name = "weaponx-api-policy"

  rule {
    action   = "throttle"
    priority = 1000
    match {
      expr {
        expression = "request.path.startsWith('/api/auth/')"
      }
    }
    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      enforce_on_key = "IP"
      rate_limit_threshold {
        count        = 60
        interval_sec = 60
      }
    }
  }

  rule {
    action   = "throttle"
    priority = 2000
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      enforce_on_key = "IP"
      rate_limit_threshold {
        count        = 600
        interval_sec = 60
      }
    }
  }

  rule {
    action   = "allow"
    priority = 2147483647
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
  }
}

resource "google_compute_backend_service" "api" {
  name                  = "weaponx-api-backend"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  security_policy       = google_compute_security_policy.api.id

  dynamic "backend" {
    for_each = google_compute_region_network_endpoint_group.api
    content {
      group = backend.value.id
    }
  }

  log_config {
    enable      = true
    sample_rate = 1
  }
}

resource "google_compute_backend_bucket" "web" {
  name                    = "weaponx-web-backend"
  bucket_name             = google_storage_bucket.web.name
  enable_cdn              = true
  custom_response_headers = local.security_headers

  # Cache-Control(assets/ は1年、index.html は no-cache)をオリジンのとおりに使う
  cdn_policy {
    cache_mode = "USE_ORIGIN_HEADERS"
  }
}

resource "google_compute_url_map" "lb" {
  name            = "weaponx-url-map"
  default_service = google_compute_backend_bucket.web.id

  host_rule {
    hosts        = [var.domain]
    path_matcher = "app"
  }

  path_matcher {
    name            = "app"
    default_service = google_compute_backend_bucket.web.id

    route_rules {
      priority = 1
      service  = google_compute_backend_service.api.id
      match_rules {
        prefix_match = "/api/"
      }
    }

    route_rules {
      priority = 2
      service  = google_compute_backend_service.api.id
      match_rules {
        full_path_match = "/api"
      }
    }

    route_rules {
      priority = 3
      service  = google_compute_backend_bucket.web.id
      match_rules {
        prefix_match = "/assets/"
      }
    }

    # SPA のフォールバック。バケットに無いパス(/projects/... など)の 404 を /index.html の 200 に置き換える。
    # URL の書き換えはバックエンドバケットに使えないので、エラー応答の置き換えで行う。
    # API の 404(PROJECT_NOT_FOUND など)を置き換えないよう、API のルートには付けない
    route_rules {
      priority = 4
      service  = google_compute_backend_bucket.web.id
      match_rules {
        prefix_match = "/"
      }
      custom_error_response_policy {
        error_service = google_compute_backend_bucket.web.id
        error_response_rule {
          match_response_codes   = ["404"]
          path                   = "/index.html"
          override_response_code = 200
        }
      }
    }
  }
}

resource "google_compute_target_https_proxy" "lb" {
  name             = "weaponx-https-proxy"
  url_map          = google_compute_url_map.lb.id
  ssl_certificates = [google_compute_managed_ssl_certificate.lb.id]
  ssl_policy       = google_compute_ssl_policy.lb.id
}

resource "google_compute_global_forwarding_rule" "https" {
  name                  = "weaponx-lb"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.lb.id
  port_range            = "443"
  target                = google_compute_target_https_proxy.lb.id
}

resource "google_compute_url_map" "http_redirect" {
  name = "weaponx-http-redirect"

  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
}

resource "google_compute_target_http_proxy" "redirect" {
  name    = "weaponx-http-proxy"
  url_map = google_compute_url_map.http_redirect.id
}

resource "google_compute_global_forwarding_rule" "http" {
  name                  = "weaponx-lb-http"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.lb.id
  port_range            = "80"
  target                = google_compute_target_http_proxy.redirect.id
}

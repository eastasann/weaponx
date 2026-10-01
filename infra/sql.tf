resource "google_sql_database_instance" "weaponx" {
  name             = "weaponx-db"
  region           = var.region
  database_version = "POSTGRES_16"

  # 誤って消すとデータを失うので、消すときは先にこの2つを外す
  deletion_protection = true

  settings {
    edition                     = "ENTERPRISE"
    tier                        = "db-f1-micro"
    disk_type                   = "PD_SSD"
    disk_size                   = 10
    availability_type           = "ZONAL"
    deletion_protection_enabled = true

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      backup_retention_settings {
        retained_backups = 7
      }
    }

    # 承認済みネットワークは空。接続は Cloud Run 組み込みの Cloud SQL 接続(ソケット)だけ(02-01 7章「DB への接続」)
    ip_configuration {
      ipv4_enabled = true
      ssl_mode     = "ENCRYPTED_ONLY"
    }

    # バインド変数の値と一意制約違反の DETAIL をログに残さない(02-01 7章「ログ」)
    database_flags {
      name  = "log_parameter_max_length"
      value = "0"
    }
    database_flags {
      name  = "log_parameter_max_length_on_error"
      value = "0"
    }
    database_flags {
      name  = "log_error_verbosity"
      value = "terse"
    }
    # 1秒以上かかったクエリをログに出す(05 1章)
    database_flags {
      name  = "log_min_duration_statement"
      value = "1000"
    }

    insights_config {
      query_insights_enabled = true
    }
  }
}

resource "google_sql_database" "weaponx" {
  name     = "weaponx"
  instance = google_sql_database_instance.weaponx.name
}

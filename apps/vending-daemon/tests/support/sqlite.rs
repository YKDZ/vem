use std::path::Path;

use sqlx::{sqlite::SqlitePoolOptions, SqlitePool};

pub async fn open_readonly(path: &Path) -> SqlitePool {
    let url = format!("sqlite://{}?mode=ro", path.display());
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .expect("open readonly sqlite")
}

pub async fn scalar_i64(pool: &SqlitePool, sql: &str) -> i64 {
    sqlx::query_scalar::<_, i64>(sql)
        .fetch_one(pool)
        .await
        .expect("scalar")
}

pub async fn table_text_dump(pool: &SqlitePool) -> String {
    let mut chunks = Vec::new();
    let queries = [
        "SELECT key || ':' || value_json FROM runtime_metadata",
        "SELECT config_json FROM machine_config",
        "SELECT command_no || ':' || order_no || ':' || command_payload_json || ':' || COALESCE(result_payload_json,'') || ':' || COALESCE(error_message,'') FROM command_log",
        "SELECT id || ':' || kind || ':' || payload_json || ':' || COALESCE(last_error,'') FROM outbox_events",
        "SELECT order_no || ':' || COALESCE(payment_attempt_json,'') || ':' || items_json || ':' || COALESCE(last_error,'') FROM order_sessions",
        "SELECT component || ':' || code || ':' || message || ':' || COALESCE(context_json,'') FROM health_events",
    ];

    for query in queries {
        let rows: Vec<(String,)> = sqlx::query_as(query)
            .fetch_all(pool)
            .await
            .unwrap_or_default();
        chunks.extend(rows.into_iter().map(|row| row.0));
    }

    chunks.join("\n")
}

pub const SCHEMA_VERSION: i64 = 1;

pub const MIGRATION_V1: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS runtime_metadata (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS machine_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  config_json TEXT NOT NULL,
  machine_secret_configured INTEGER NOT NULL,
  mqtt_signing_secret_configured INTEGER NOT NULL,
  mqtt_password_configured INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_locks (
  lock_name TEXT PRIMARY KEY,
  owner_pid INTEGER NOT NULL,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS command_log (
  command_no TEXT PRIMARY KEY,
  order_no TEXT NOT NULL,
  command_payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('received','acknowledged','dispensing','succeeded','failed')),
  ack_at TEXT,
  dispensing_started_at TEXT,
  result_payload_json TEXT,
  error_code TEXT,
  error_message TEXT,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('command_ack','dispense_result','heartbeat','remote_op_result','log_export')),
  transport TEXT NOT NULL CHECK (transport IN ('mqtt','http')),
  topic TEXT,
  target_url TEXT,
  method TEXT,
  payload_json TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL,
  next_attempt_at TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_sessions (
  order_no TEXT PRIMARY KEY,
  payment_method TEXT NOT NULL,
  payment_provider TEXT,
  payment_attempt_json TEXT,
  items_json TEXT NOT NULL,
  status TEXT NOT NULL,
  next_action TEXT NOT NULL,
  expires_at TEXT,
  last_backend_status_json TEXT,
  last_error TEXT,
  recovery_strategy TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS health_events (
  id TEXT PRIMARY KEY,
  component TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('ok','degraded','offline','error')),
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  context_json TEXT,
  occurred_at TEXT NOT NULL,
  recovered_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox_events(next_attempt_at, priority);
CREATE INDEX IF NOT EXISTS idx_command_log_expires ON command_log(expires_at);
CREATE INDEX IF NOT EXISTS idx_health_events_component_time ON health_events(component, occurred_at);
"#;

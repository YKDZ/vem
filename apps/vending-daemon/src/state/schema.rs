pub const SCHEMA_VERSION: i64 = 12;

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
  kind TEXT NOT NULL CHECK (kind IN ('command_ack','dispense_result','heartbeat','remote_op_result','log_export','stock_movement_upload')),
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

pub const MIGRATION_V2: &str = r#"
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS machine_planogram_versions (
  planogram_version TEXT PRIMARY KEY,
  active INTEGER NOT NULL CHECK (active IN (0,1)),
  source TEXT NOT NULL,
  applied_by TEXT,
  applied_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_machine_planogram_versions_active
  ON machine_planogram_versions(active)
  WHERE active = 1;

CREATE TABLE IF NOT EXISTS machine_planogram_slots (
  planogram_version TEXT NOT NULL,
  slot_id TEXT NOT NULL,
  slot_code TEXT NOT NULL,
  layer_no INTEGER NOT NULL,
  cell_no INTEGER NOT NULL,
  capacity INTEGER NOT NULL CHECK (capacity >= 0),
  par_level INTEGER NOT NULL CHECK (par_level >= 0),
  inventory_id TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  product_description TEXT,
  cover_image_url TEXT,
  category_id TEXT,
  category_name TEXT,
  sku TEXT NOT NULL,
  size TEXT,
  color TEXT,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  product_sort_order INTEGER NOT NULL,
  target_gender TEXT,
  PRIMARY KEY (planogram_version, slot_id),
  FOREIGN KEY (planogram_version) REFERENCES machine_planogram_versions(planogram_version)
);

CREATE TABLE IF NOT EXISTS stock_movements (
  movement_id TEXT PRIMARY KEY,
  planogram_version TEXT NOT NULL,
  slot_id TEXT NOT NULL,
  movement_type TEXT NOT NULL CHECK (movement_type IN ('planned_refill','stock_count_correction','dispense_succeeded')),
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  source TEXT NOT NULL,
  attributed_to TEXT,
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (planogram_version, slot_id) REFERENCES machine_planogram_slots(planogram_version, slot_id)
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_slot_time
  ON stock_movements(planogram_version, slot_id, occurred_at, movement_id);

CREATE TABLE IF NOT EXISTS current_stock_projection (
  planogram_version TEXT NOT NULL,
  slot_id TEXT PRIMARY KEY,
  physical_stock INTEGER NOT NULL CHECK (physical_stock >= 0),
  saleable_stock INTEGER NOT NULL CHECK (saleable_stock >= 0),
  slot_sales_state TEXT NOT NULL CHECK (slot_sales_state IN ('sale_ready','sold_out','suspect','frozen','needs_count','blocked_for_planogram_change')),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (planogram_version, slot_id) REFERENCES machine_planogram_slots(planogram_version, slot_id)
);

CREATE TABLE IF NOT EXISTS sale_view_projection (
  planogram_version TEXT NOT NULL,
  slot_id TEXT PRIMARY KEY,
  item_json TEXT NOT NULL,
  slot_sales_state TEXT NOT NULL CHECK (slot_sales_state IN ('sale_ready','sold_out','suspect','frozen','needs_count','blocked_for_planogram_change')),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (planogram_version, slot_id) REFERENCES machine_planogram_slots(planogram_version, slot_id)
);
"#;

pub const MIGRATION_V3: &str = r#"
PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS current_stock_projection_v3 (
  planogram_version TEXT NOT NULL,
  slot_id TEXT PRIMARY KEY,
  physical_stock INTEGER NOT NULL CHECK (physical_stock >= 0),
  saleable_stock INTEGER NOT NULL CHECK (saleable_stock >= 0),
  slot_sales_state TEXT NOT NULL CHECK (slot_sales_state IN ('sale_ready','sold_out','suspect','frozen','needs_count','blocked_for_planogram_change')),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (planogram_version, slot_id) REFERENCES machine_planogram_slots(planogram_version, slot_id)
);

INSERT OR REPLACE INTO current_stock_projection_v3(
  planogram_version,slot_id,physical_stock,saleable_stock,slot_sales_state,updated_at
)
SELECT
  planogram_version,
  slot_id,
  physical_stock,
  saleable_stock,
  CASE slot_sales_state
    WHEN 'saleable' THEN 'sale_ready'
    WHEN 'unavailable' THEN 'frozen'
    ELSE slot_sales_state
  END,
  updated_at
FROM current_stock_projection;

DROP TABLE current_stock_projection;
ALTER TABLE current_stock_projection_v3 RENAME TO current_stock_projection;

CREATE TABLE IF NOT EXISTS sale_view_projection_v3 (
  planogram_version TEXT NOT NULL,
  slot_id TEXT PRIMARY KEY,
  item_json TEXT NOT NULL,
  slot_sales_state TEXT NOT NULL CHECK (slot_sales_state IN ('sale_ready','sold_out','suspect','frozen','needs_count','blocked_for_planogram_change')),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (planogram_version, slot_id) REFERENCES machine_planogram_slots(planogram_version, slot_id)
);

INSERT OR REPLACE INTO sale_view_projection_v3(
  planogram_version,slot_id,item_json,slot_sales_state,updated_at
)
SELECT
  planogram_version,
  slot_id,
  json_set(
    item_json,
    '$.slotSalesState',
    CASE slot_sales_state
      WHEN 'saleable' THEN 'sale_ready'
      WHEN 'unavailable' THEN 'frozen'
      ELSE slot_sales_state
    END
  ),
  CASE slot_sales_state
    WHEN 'saleable' THEN 'sale_ready'
    WHEN 'unavailable' THEN 'frozen'
    ELSE slot_sales_state
  END,
  updated_at
FROM sale_view_projection;

DROP TABLE sale_view_projection;
ALTER TABLE sale_view_projection_v3 RENAME TO sale_view_projection;

PRAGMA foreign_keys = ON;
"#;

pub const MIGRATION_V10: &str = r#"
PRAGMA foreign_keys = OFF;

ALTER TABLE machine_planogram_slots ADD COLUMN try_on_silhouette_url TEXT;

PRAGMA foreign_keys = ON;
"#;

pub const MIGRATION_V11: &str = r#"
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS destructive_command_log (
  message_id TEXT PRIMARY KEY,
  command_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('received','succeeded','failed')),
  error_message TEXT,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_destructive_command_log_expires
  ON destructive_command_log(expires_at);
"#;

// A physical-stock attestation is staged in the durable HTTP outbox before
// Platform accepts it.  Those staged movement ids are deliberately not local
// stock facts yet, so the old foreign key to stock_movements would force an
// unacknowledged attestation into the local ledger.
pub const MIGRATION_V12: &str = r#"
PRAGMA foreign_keys = OFF;

ALTER TABLE stock_movement_sync RENAME TO stock_movement_sync_v11;

CREATE TABLE IF NOT EXISTS stock_movement_sync (
  movement_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending','failed','accepted','rejected','reconciliation')),
  outbox_event_id TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  accepted_at TEXT,
  platform_receipt_json TEXT,
  rejection_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO stock_movement_sync(
  movement_id,status,outbox_event_id,attempt_count,last_error,accepted_at,
  platform_receipt_json,rejection_json,created_at,updated_at
)
SELECT
  movement_id,status,outbox_event_id,attempt_count,last_error,accepted_at,
  platform_receipt_json,rejection_json,created_at,updated_at
FROM stock_movement_sync_v11;

DROP TABLE stock_movement_sync_v11;
CREATE INDEX IF NOT EXISTS idx_stock_movement_sync_status
  ON stock_movement_sync(status, updated_at);

PRAGMA foreign_keys = ON;
"#;

pub const MIGRATION_V4: &str = r#"
PRAGMA foreign_keys = OFF;

ALTER TABLE outbox_events RENAME TO outbox_events_v3;

CREATE TABLE IF NOT EXISTS outbox_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('command_ack','dispense_result','heartbeat','remote_op_result','log_export','stock_movement_upload')),
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

INSERT INTO outbox_events(
  id,kind,transport,topic,target_url,method,payload_json,priority,created_at,next_attempt_at,attempt_count,last_error,expires_at
)
SELECT id,kind,transport,topic,target_url,method,payload_json,priority,created_at,next_attempt_at,attempt_count,last_error,expires_at
FROM outbox_events_v3;

DROP TABLE outbox_events_v3;
CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox_events(next_attempt_at, priority);

CREATE TABLE IF NOT EXISTS stock_movement_sync (
  movement_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending','failed','accepted','rejected','reconciliation')),
  outbox_event_id TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  accepted_at TEXT,
  platform_receipt_json TEXT,
  rejection_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (movement_id) REFERENCES stock_movements(movement_id)
);

CREATE INDEX IF NOT EXISTS idx_stock_movement_sync_status
  ON stock_movement_sync(status, updated_at);

PRAGMA foreign_keys = ON;
"#;

pub const MIGRATION_V5: &str = r#"
PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS current_stock_projection_v5 (
  planogram_version TEXT NOT NULL,
  slot_id TEXT PRIMARY KEY,
  physical_stock INTEGER NOT NULL CHECK (physical_stock >= 0),
  saleable_stock INTEGER NOT NULL CHECK (saleable_stock >= 0),
  slot_sales_state TEXT NOT NULL CHECK (slot_sales_state IN ('sale_ready','sold_out','suspect','frozen','needs_count','blocked_for_planogram_change','movement_rejected','needs_platform_review')),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (planogram_version, slot_id) REFERENCES machine_planogram_slots(planogram_version, slot_id)
);

INSERT OR REPLACE INTO current_stock_projection_v5(
  planogram_version,slot_id,physical_stock,saleable_stock,slot_sales_state,updated_at
)
SELECT planogram_version,slot_id,physical_stock,saleable_stock,slot_sales_state,updated_at
FROM current_stock_projection;

DROP TABLE current_stock_projection;
ALTER TABLE current_stock_projection_v5 RENAME TO current_stock_projection;

CREATE TABLE IF NOT EXISTS sale_view_projection_v5 (
  planogram_version TEXT NOT NULL,
  slot_id TEXT PRIMARY KEY,
  item_json TEXT NOT NULL,
  slot_sales_state TEXT NOT NULL CHECK (slot_sales_state IN ('sale_ready','sold_out','suspect','frozen','needs_count','blocked_for_planogram_change','movement_rejected','needs_platform_review')),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (planogram_version, slot_id) REFERENCES machine_planogram_slots(planogram_version, slot_id)
);

INSERT OR REPLACE INTO sale_view_projection_v5(
  planogram_version,slot_id,item_json,slot_sales_state,updated_at
)
SELECT planogram_version,slot_id,item_json,slot_sales_state,updated_at
FROM sale_view_projection;

DROP TABLE sale_view_projection;
ALTER TABLE sale_view_projection_v5 RENAME TO sale_view_projection;

PRAGMA foreign_keys = ON;
"#;

pub const MIGRATION_V6: &str = r#"
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sale_safety_blockers (
  planogram_version TEXT NOT NULL,
  slot_id TEXT NOT NULL,
  slot_sales_state TEXT NOT NULL CHECK (slot_sales_state IN ('needs_count','blocked_for_planogram_change','movement_rejected','needs_platform_review')),
  reason TEXT,
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (planogram_version, slot_id),
  FOREIGN KEY (planogram_version, slot_id) REFERENCES machine_planogram_slots(planogram_version, slot_id)
);

CREATE INDEX IF NOT EXISTS idx_sale_safety_blockers_slot
  ON sale_safety_blockers(slot_id, updated_at);

INSERT OR IGNORE INTO sale_safety_blockers(
  planogram_version,slot_id,slot_sales_state,reason,source,updated_at
)
SELECT
  planogram_version,
  slot_id,
  slot_sales_state,
  'migrated_reconciliation_blocker',
  'migration',
  updated_at
FROM current_stock_projection
WHERE slot_sales_state IN ('needs_count','blocked_for_planogram_change','movement_rejected','needs_platform_review');
"#;

pub const MIGRATION_V7: &str = r#"
PRAGMA foreign_keys = ON;

ALTER TABLE stock_movements ADD COLUMN before_quantity INTEGER NOT NULL DEFAULT 0 CHECK (before_quantity >= 0);
ALTER TABLE stock_movements ADD COLUMN after_quantity INTEGER NOT NULL DEFAULT 0 CHECK (after_quantity >= 0);
ALTER TABLE stock_movements ADD COLUMN slot_mapping_snapshot_json TEXT;
"#;

pub const MIGRATION_V8: &str = r#"
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS whole_machine_lock_clear_audit_events (
  id TEXT PRIMARY KEY,
  operator_note TEXT NOT NULL,
  previous_lock_json TEXT NOT NULL,
  recovery_evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_whole_machine_lock_clear_audit_created
  ON whole_machine_lock_clear_audit_events(created_at);
"#;

pub const MIGRATION_V9: &str = r#"
PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS stock_movements_v9 (
  movement_id TEXT PRIMARY KEY,
  planogram_version TEXT NOT NULL,
  slot_id TEXT NOT NULL,
  movement_type TEXT NOT NULL CHECK (movement_type IN ('planned_refill','stock_count_correction','dispense_succeeded')),
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  source TEXT NOT NULL,
  attributed_to TEXT,
  occurred_at TEXT NOT NULL,
  before_quantity INTEGER NOT NULL DEFAULT 0 CHECK (before_quantity >= 0),
  after_quantity INTEGER NOT NULL DEFAULT 0 CHECK (after_quantity >= 0),
  slot_mapping_snapshot_json TEXT,
  FOREIGN KEY (planogram_version, slot_id) REFERENCES machine_planogram_slots(planogram_version, slot_id)
);

INSERT OR REPLACE INTO stock_movements_v9(
  movement_id,planogram_version,slot_id,movement_type,quantity,source,attributed_to,
  occurred_at,before_quantity,after_quantity,slot_mapping_snapshot_json
)
SELECT
  movement_id,planogram_version,slot_id,movement_type,quantity,source,attributed_to,
  occurred_at,before_quantity,after_quantity,slot_mapping_snapshot_json
FROM stock_movements;

DROP TABLE stock_movements;
ALTER TABLE stock_movements_v9 RENAME TO stock_movements;

CREATE INDEX IF NOT EXISTS idx_stock_movements_slot_time
  ON stock_movements(planogram_version, slot_id, occurred_at, movement_id);

PRAGMA foreign_keys = ON;
"#;

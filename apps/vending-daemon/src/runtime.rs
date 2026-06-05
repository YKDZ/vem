use std::path::PathBuf;
use std::sync::Arc;

use crate::{
    config::{ConfigStore, MachineRuntimeConfig},
    state::LocalStateStore,
};
use tokio_util::sync::CancellationToken;

pub struct RuntimeStartInput {
    pub state: LocalStateStore,
    pub config_store: Arc<ConfigStore>,
    pub data_dir: PathBuf,
}

#[derive(Clone)]
pub struct DaemonRuntime {
    state: LocalStateStore,
    pub config: MachineRuntimeConfig,
    shutdown: CancellationToken,
    data_dir: PathBuf,
}

impl DaemonRuntime {
    pub async fn start(input: RuntimeStartInput) -> Result<Arc<Self>, String> {
        let config = input.config_store.load_runtime_config().await?;
        let _ = input
            .state
            .put_metadata("last_started_at", &crate::state::store::now_iso())
            .await;

        let runtime = Arc::new(Self {
            state: input.state.clone(),
            config,
            shutdown: CancellationToken::new(),
            data_dir: input.data_dir,
        });
        runtime.recover_local_state().await?;

        Ok(runtime)
    }

    async fn recover_local_state(&self) -> Result<(), String> {
        self.state
            .prune_command_log()
            .await
            .map_err(|error| error.to_string())?;
        self.state
            .prune_outbox()
            .await
            .map_err(|error| error.to_string())?;
        self.state
            .prune_accepted_stock_movement_history(self.config.public.stock_movement_retention_days)
            .await
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn state(&self) -> LocalStateStore {
        self.state.clone()
    }

    pub fn data_dir(&self) -> &std::path::Path {
        &self.data_dir
    }

    pub fn shutdown_token(&self) -> CancellationToken {
        self.shutdown.clone()
    }

    pub async fn stop(&self) -> Result<(), String> {
        self.shutdown.cancel();
        self.state
            .put_metadata("last_clean_shutdown_at", &crate::state::store::now_iso())
            .await
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        backend::StockMovementUploadResponse,
        config::default_public_config,
        secret::{InMemorySecretStore, KeyringSecretStore},
        state::store::{MachinePlanogramInput, MachinePlanogramSlotInput, StockMovementInput},
    };

    #[tokio::test]
    async fn runtime_starts_when_stock_movement_retention_is_huge() {
        let temp = tempfile::tempdir().expect("tempdir");
        let state = crate::state::LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        let config_store = Arc::new(crate::config::ConfigStore::new(
            temp.path().to_path_buf(),
            state.clone(),
            Arc::new(InMemorySecretStore::default()),
        ));
        let public = crate::config::MachinePublicConfig {
            stock_movement_retention_days: i64::MAX,
            ..default_public_config()
        };
        config_store
            .save_public_config(public)
            .await
            .expect("save config");

        let runtime = DaemonRuntime::start(RuntimeStartInput {
            state,
            config_store,
            data_dir: temp.path().to_path_buf(),
        })
        .await
        .expect("runtime start");

        assert_eq!(
            runtime.config.public.stock_movement_retention_days,
            crate::config::STOCK_MOVEMENT_RETENTION_MAX_DAYS
        );
    }

    #[tokio::test]
    async fn runtime_uses_configured_stock_movement_retention_window() {
        let temp = tempfile::tempdir().expect("tempdir");
        let state = crate::state::LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        seed_accepted_stock_movement(&state, "MOVE-RUNTIME-PRUNE").await;
        let old_accepted_at = (chrono::Utc::now() - chrono::Duration::days(2))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        sqlx::query(
            "UPDATE stock_movement_sync SET accepted_at = ?2, updated_at = ?2 WHERE movement_id = ?1",
        )
        .bind("MOVE-RUNTIME-PRUNE")
        .bind(&old_accepted_at)
        .execute(state.pool())
        .await
        .expect("age accepted movement");

        let config_store = Arc::new(crate::config::ConfigStore::new(
            temp.path().to_path_buf(),
            state.clone(),
            Arc::new(InMemorySecretStore::default()),
        ));
        let public = crate::config::MachinePublicConfig {
            stock_movement_retention_days: 1,
            ..default_public_config()
        };
        config_store
            .save_public_config(public)
            .await
            .expect("save config");

        let runtime = DaemonRuntime::start(RuntimeStartInput {
            state: state.clone(),
            config_store,
            data_dir: temp.path().to_path_buf(),
        })
        .await
        .expect("runtime start");

        assert_eq!(runtime.config.public.stock_movement_retention_days, 1);
        assert!(state
            .stock_movement_sync_record("MOVE-RUNTIME-PRUNE")
            .await
            .expect("sync")
            .is_none());
        let movement_count: (i64,) =
            sqlx::query_as("SELECT COUNT(1) FROM stock_movements WHERE movement_id = ?1")
                .bind("MOVE-RUNTIME-PRUNE")
                .fetch_one(state.pool())
                .await
                .expect("movement count");
        assert_eq!(movement_count.0, 0);
    }

    async fn seed_accepted_stock_movement(
        state: &crate::state::LocalStateStore,
        movement_id: &str,
    ) {
        state
            .apply_planogram(MachinePlanogramInput {
                planogram_version: "PLAN-RUNTIME-RETENTION".to_string(),
                source: "test".to_string(),
                applied_by: None,
                slots: vec![MachinePlanogramSlotInput {
                    slot_id: "550e8400-e29b-41d4-a716-446655440101".to_string(),
                    slot_code: "A1".to_string(),
                    layer_no: 1,
                    cell_no: 1,
                    capacity: 8,
                    par_level: 6,
                    inventory_id: "550e8400-e29b-41d4-a716-446655440102".to_string(),
                    variant_id: "550e8400-e29b-41d4-a716-446655440103".to_string(),
                    product_id: "550e8400-e29b-41d4-a716-446655440104".to_string(),
                    product_name: "water".to_string(),
                    product_description: None,
                    cover_image_url: None,
                    category_id: None,
                    category_name: None,
                    sku: "WATER-001".to_string(),
                    size: Some("550ml".to_string()),
                    color: None,
                    price_cents: 200,
                    product_sort_order: 1,
                    target_gender: None,
                }],
            })
            .await
            .expect("planogram");
        state
            .record_stock_movement_with_upload(
                StockMovementInput {
                    movement_id: movement_id.to_string(),
                    planogram_version: "PLAN-RUNTIME-RETENTION".to_string(),
                    slot_id: "550e8400-e29b-41d4-a716-446655440101".to_string(),
                    movement_type: "planned_refill".to_string(),
                    quantity: 3,
                    source: "field_service".to_string(),
                    attributed_to: Some("operator-1".to_string()),
                },
                Some("MACHINE-1"),
                Some("https://platform.example/api"),
            )
            .await
            .expect("movement");
        let outbox = state
            .outbox_record(&format!("stock-movement:{movement_id}"))
            .await
            .expect("outbox")
            .expect("outbox exists");
        state
            .record_stock_movement_upload_response(
                &outbox,
                &StockMovementUploadResponse {
                    movement_id: movement_id.to_string(),
                    status: "accepted".to_string(),
                    accepted_at: Some(crate::state::store::now_iso()),
                    receipt: Some(serde_json::json!({"receiptId":"runtime-retention"})),
                    rejection: None,
                    reconciliation: None,
                },
            )
            .await
            .expect("accept movement");
    }

    #[tokio::test]
    async fn runtime_starts_with_missing_deployment_config() {
        let _ = KeyringSecretStore;
        let temp = tempfile::tempdir().expect("tempdir");
        let state = crate::state::LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        let config_store = Arc::new(crate::config::ConfigStore::new(
            temp.path().to_path_buf(),
            state.clone(),
            Arc::new(InMemorySecretStore::default()),
        ));

        let runtime = DaemonRuntime::start(RuntimeStartInput {
            state,
            config_store,
            data_dir: temp.path().to_path_buf(),
        })
        .await
        .expect("runtime start");

        let started: Option<String> = runtime
            .state()
            .get_metadata("last_started_at")
            .await
            .expect("metadata");
        assert!(started.is_some());
    }
}

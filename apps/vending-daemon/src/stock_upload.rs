use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use crate::{backend::BackendClient, state::LocalStateStore};

#[derive(Debug, Clone, Default)]
pub struct StockMovementUploadFlushResult {
    pub accepted: u64,
    pub failed: u64,
}

#[derive(Clone)]
pub struct StockMovementUploadRuntime {
    state: LocalStateStore,
    backend: Arc<BackendClient>,
    shutdown: CancellationToken,
}

impl StockMovementUploadRuntime {
    pub fn new(
        state: LocalStateStore,
        backend: Arc<BackendClient>,
        shutdown: CancellationToken,
    ) -> Self {
        Self {
            state,
            backend,
            shutdown,
        }
    }

    pub async fn flush_due_once(&self) -> Result<StockMovementUploadFlushResult, String> {
        let due = self
            .state
            .list_due_stock_movement_uploads(chrono::Utc::now())
            .await
            .map_err(|error| error.to_string())?;
        let mut result = StockMovementUploadFlushResult::default();

        for event in due {
            let movement_id = event
                .payload_json
                .get("movementId")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string();
            if movement_id.is_empty() {
                self.state
                    .mark_outbox_failed(&event.id, "stock movement upload missing movementId")
                    .await
                    .map_err(|error| error.to_string())?;
                result.failed += 1;
                continue;
            }

            match self
                .backend
                .submit_stock_movement_upload(&event.payload_json)
                .await
            {
                Ok(response) => {
                    if response.movement_id != movement_id {
                        let error = format!(
                            "stock movement upload response movementId mismatch: expected {movement_id}, received {}",
                            response.movement_id
                        );
                        self.state
                            .mark_stock_movement_upload_failed(&event.id, &movement_id, &error)
                            .await
                            .map_err(|error| error.to_string())?;
                        result.failed += 1;
                        continue;
                    }
                    self.state
                        .record_stock_movement_upload_response(&event, &response)
                        .await
                        .map_err(|error| error.to_string())?;
                    result.accepted += 1;
                }
                Err(error) => {
                    self.state
                        .mark_stock_movement_upload_failed(&event.id, &movement_id, &error)
                        .await
                        .map_err(|error| error.to_string())?;
                    result.failed += 1;
                }
            }
        }

        Ok(result)
    }

    pub async fn run(self) -> Result<(), String> {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
        loop {
            tokio::select! {
                _ = self.shutdown.cancelled() => return Ok(()),
                _ = interval.tick() => {
                    let _ = self.flush_due_once().await;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use tempfile::TempDir;
    use tokio_util::sync::CancellationToken;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use crate::backend::BackendClient;
    use crate::state::store::{
        MachinePlanogramInput, MachinePlanogramSlotInput, StockMovementInput,
    };
    use crate::state::LocalStateStore;

    use super::*;

    async fn test_backend_client(server: &MockServer) -> Arc<BackendClient> {
        let client = Arc::new(BackendClient::new(server.uri()));
        client
            .set_access_token_for_tests("test-backend-token")
            .await;
        client
    }

    async fn seed_stock_movement_upload(store: &LocalStateStore, movement_id: &str) {
        store
            .apply_planogram(MachinePlanogramInput {
                planogram_version: "PLAN-1".to_string(),
                source: "test".to_string(),
                applied_by: None,
                slots: vec![MachinePlanogramSlotInput {
                    slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                    slot_code: "A1".to_string(),
                    layer_no: 1,
                    cell_no: 1,
                    capacity: 8,
                    par_level: 6,
                    inventory_id: "550e8400-e29b-41d4-a716-446655440002".to_string(),
                    variant_id: "550e8400-e29b-41d4-a716-446655440003".to_string(),
                    product_id: "550e8400-e29b-41d4-a716-446655440004".to_string(),
                    product_name: "water".to_string(),
                    product_description: None,
                    cover_image_url: None,
                    category_id: None,
                    category_name: None,
                    sku: "WATER-001".to_string(),
                    size: None,
                    color: None,
                    price_cents: 200,
                    product_sort_order: 1,
                    target_gender: None,
                }],
            })
            .await
            .expect("planogram");
        store
            .record_stock_movement_with_upload(
                StockMovementInput {
                    movement_id: movement_id.to_string(),
                    planogram_version: "PLAN-1".to_string(),
                    slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                    movement_type: "planned_refill".to_string(),
                    quantity: 3,
                    source: "field_service".to_string(),
                    attributed_to: None,
                },
                Some("MACHINE-1"),
                Some("https://platform.example/api"),
            )
            .await
            .expect("movement");
    }

    #[tokio::test]
    async fn stock_movement_upload_mismatched_response_movement_id_keeps_outbox() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_stock_movement_upload(&store, "MOVE-EXPECTED").await;
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machine-stock-movements"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "movementId": "MOVE-OTHER",
                "status": "accepted",
                "acceptedAt": "2026-06-04T00:00:00.000Z",
                "receipt": {"rawMovementId":"raw-1"}
            })))
            .mount(&server)
            .await;
        let runtime = StockMovementUploadRuntime::new(
            store.clone(),
            test_backend_client(&server).await,
            CancellationToken::new(),
        );

        let result = runtime.flush_due_once().await.expect("flush");

        assert_eq!(result.accepted, 0);
        assert_eq!(result.failed, 1);
        let sync = store
            .stock_movement_sync_record("MOVE-EXPECTED")
            .await
            .expect("sync")
            .expect("sync exists");
        assert_eq!(sync.status, "failed");
        assert!(sync
            .last_error
            .as_deref()
            .expect("last error")
            .contains("movementId mismatch"));
        assert!(store
            .outbox_record("stock-movement:MOVE-EXPECTED")
            .await
            .expect("outbox")
            .is_some());
    }

    #[tokio::test]
    async fn reconciliation_upload_response_applies_local_sale_safety_blocker() {
        let temp = TempDir::new().expect("temp");
        let store = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("open");
        seed_stock_movement_upload(&store, "MOVE-BLOCKED").await;
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/machine-stock-movements"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "movementId": "MOVE-BLOCKED",
                "status": "reconciliation",
                "acceptedAt": null,
                "reconciliation": {
                    "reason": "unknown_slot",
                    "platformReview": {"required": true, "status": "open"},
                    "saleSafetyBlocker": {
                        "slotId": "550e8400-e29b-41d4-a716-446655440001",
                        "slotSalesState": "needs_platform_review",
                        "reason": "unknown_slot"
                    }
                }
            })))
            .mount(&server)
            .await;
        let runtime = StockMovementUploadRuntime::new(
            store.clone(),
            test_backend_client(&server).await,
            CancellationToken::new(),
        );

        let result = runtime.flush_due_once().await.expect("flush");

        assert_eq!(result.accepted, 1);
        let sale_view = store
            .sale_view(Some("MACHINE-1".to_string()))
            .await
            .expect("sale view");
        assert_eq!(sale_view.items[0].slot_sales_state, "needs_platform_review");
        assert_eq!(sale_view.items[0].physical_stock, 3);
        assert_eq!(sale_view.items[0].saleable_stock, 3);
        let sync = store
            .stock_movement_sync_record("MOVE-BLOCKED")
            .await
            .expect("sync")
            .expect("sync exists");
        assert_eq!(sync.status, "reconciliation");
    }
}

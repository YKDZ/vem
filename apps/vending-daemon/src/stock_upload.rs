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

use std::path::PathBuf;
use std::sync::Arc;

use crate::{runtime_configuration::RuntimeSources, state::LocalStateStore};
use tokio_util::sync::CancellationToken;

pub struct RuntimeStartInput {
    pub state: LocalStateStore,
    pub runtime_sources: Arc<RuntimeSources>,
    pub data_dir: PathBuf,
}

#[derive(Clone)]
pub struct DaemonRuntime {
    state: LocalStateStore,
    shutdown: CancellationToken,
    data_dir: PathBuf,
}

impl DaemonRuntime {
    pub async fn start(input: RuntimeStartInput) -> Result<Arc<Self>, String> {
        let _ = input
            .state
            .put_metadata("last_started_at", &crate::state::store::now_iso())
            .await;

        let runtime = Arc::new(Self {
            state: input.state.clone(),
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
            .prune_accepted_stock_movement_history(30)
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

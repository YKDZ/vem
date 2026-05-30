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
    use crate::secret::{InMemorySecretStore, KeyringSecretStore};

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

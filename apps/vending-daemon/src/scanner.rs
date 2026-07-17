use tokio::sync::{broadcast, mpsc};
use tokio_serial::SerialPortBuilderExt;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use vending_core::serial::SerialPortUsbIdentity;

use crate::config::{EffectiveRuntimeConfig, ScannerAdapterKind};
use crate::events::DaemonEvent;

#[derive(Debug, Clone)]
pub struct ScannerRuntimeConfig {
    pub port_path: Option<String>,
    pub usb_identity: Option<SerialPortUsbIdentity>,
    pub baud_rate: u32,
    pub source: String,
    pub frame_suffix: vending_core::scanner::ScannerFrameSuffix,
}

#[derive(Debug, Clone)]
pub struct ScannerRuntime {
    config: ScannerRuntimeConfig,
    shutdown: CancellationToken,
    tx_raw: mpsc::Sender<vending_core::scanner::RawPaymentCode>,
    tx_events: broadcast::Sender<DaemonEvent>,
}

#[derive(Clone)]
pub struct ScannerRuntimeController {
    tx_raw: mpsc::Sender<vending_core::scanner::RawPaymentCode>,
    tx_events: broadcast::Sender<DaemonEvent>,
    state: std::sync::Arc<tokio::sync::Mutex<Option<RunningScannerRuntime>>>,
}

struct RunningScannerRuntime {
    config: EffectiveRuntimeConfig,
    shutdown: CancellationToken,
    task: tokio::task::JoinHandle<Result<(), String>>,
}

impl ScannerRuntimeController {
    pub fn new(
        tx_raw: mpsc::Sender<vending_core::scanner::RawPaymentCode>,
        tx_events: broadcast::Sender<DaemonEvent>,
    ) -> Self {
        Self {
            tx_raw,
            tx_events,
            state: std::sync::Arc::new(tokio::sync::Mutex::new(None)),
        }
    }

    pub async fn reconfigure_from_config(
        &self,
        config: &EffectiveRuntimeConfig,
    ) -> Result<(), String> {
        let mut state = self.state.lock().await;
        let previous_config = state.as_ref().map(|running| running.config.clone());
        if let Some(running) = state.take() {
            running.shutdown.cancel();
            match running.task.await {
                Ok(result) => result?,
                Err(error) if error.is_cancelled() => {}
                Err(error) => return Err(format!("join scanner runtime failed: {error}")),
            }
        }
        match self.start_runtime(config).await {
            Ok(running) => {
                *state = Some(running);
                Ok(())
            }
            Err(error) => {
                if let Some(previous_config) = previous_config {
                    match self.start_runtime(&previous_config).await {
                        Ok(previous) => *state = Some(previous),
                        Err(rollback_error) => {
                            return Err(format!(
                                "{error}; restore previous scanner runtime failed: {rollback_error}"
                            ));
                        }
                    }
                }
                Err(error)
            }
        }
    }

    /// Starts the scanner as an independently degraded runtime. Unlike a
    /// maintenance binding activation, daemon startup must not fail merely
    /// because the optional scanner is unplugged or temporarily unavailable.
    pub async fn start_from_config(&self, config: &EffectiveRuntimeConfig) -> Result<(), String> {
        let mut state = self.state.lock().await;
        if let Some(running) = state.take() {
            running.shutdown.cancel();
            match running.task.await {
                Ok(result) => result?,
                Err(error) if error.is_cancelled() => {}
                Err(error) => return Err(format!("join scanner runtime failed: {error}")),
            }
        }
        let shutdown = CancellationToken::new();
        let runtime = ScannerRuntime::from_config(
            config,
            self.tx_raw.clone(),
            self.tx_events.clone(),
            shutdown.clone(),
        );
        *state = Some(RunningScannerRuntime {
            config: config.clone(),
            shutdown,
            task: tokio::spawn(runtime.run()),
        });
        Ok(())
    }

    async fn start_runtime(
        &self,
        config: &EffectiveRuntimeConfig,
    ) -> Result<RunningScannerRuntime, String> {
        let shutdown = CancellationToken::new();
        let mut health_events = self.tx_events.subscribe();
        let runtime = ScannerRuntime::from_config(
            config,
            self.tx_raw.clone(),
            self.tx_events.clone(),
            shutdown.clone(),
        );
        let task = tokio::spawn(runtime.run());
        let readiness = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                match health_events.recv().await {
                    Ok(DaemonEvent::ScannerHealthChanged { snapshot, .. }) => {
                        if snapshot.code == "SCANNER_READY" || snapshot.code == "SCANNER_DISABLED" {
                            return Ok(());
                        }
                        if matches!(
                            snapshot.code.as_str(),
                            "SCANNER_PORT_MISSING"
                                | "SCANNER_USB_NOT_FOUND"
                                | "SCANNER_OPEN_FAILED"
                        ) {
                            return Err(snapshot.message);
                        }
                    }
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => {
                        return Err("scanner health event channel closed".to_string());
                    }
                }
            }
        })
        .await
        .unwrap_or_else(|_| Err("scanner adapter readiness timed out".to_string()));
        if let Err(error) = readiness {
            shutdown.cancel();
            let _ = task.await;
            return Err(error);
        }
        Ok(RunningScannerRuntime {
            config: config.clone(),
            shutdown,
            task,
        })
    }

    pub async fn stop(&self) -> Result<(), String> {
        let mut state = self.state.lock().await;
        let Some(running) = state.take() else {
            return Ok(());
        };
        running.shutdown.cancel();
        match running.task.await {
            Ok(result) => result,
            Err(error) if error.is_cancelled() => Ok(()),
            Err(error) => Err(format!("join scanner runtime failed: {error}")),
        }
    }
}

impl ScannerRuntime {
    pub fn from_config(
        config: &EffectiveRuntimeConfig,
        tx_raw: mpsc::Sender<vending_core::scanner::RawPaymentCode>,
        tx_events: broadcast::Sender<DaemonEvent>,
        shutdown: CancellationToken,
    ) -> Self {
        let source = match config.scanner_adapter {
            ScannerAdapterKind::SerialText => {
                vending_core::scanner::PAYMENT_CODE_SOURCE_SERIAL_TEXT.to_string()
            }
            ScannerAdapterKind::Disabled => "disabled".to_string(),
        };

        let port_path = match config.scanner_adapter {
            ScannerAdapterKind::SerialText => config.scanner_serial_port_path.clone(),
            ScannerAdapterKind::Disabled => None,
        };

        let usb_identity = match config.scanner_adapter {
            ScannerAdapterKind::SerialText => config.scanner_usb_identity.clone(),
            ScannerAdapterKind::Disabled => None,
        };

        Self {
            config: ScannerRuntimeConfig {
                port_path,
                usb_identity,
                baud_rate: config.scanner_baud_rate,
                source,
                frame_suffix: config.scanner_frame_suffix,
            },
            shutdown,
            tx_raw,
            tx_events,
        }
    }

    pub async fn run(self) -> Result<(), String> {
        if self.config.source == "disabled" {
            self.emit_health(self.health_snapshot(
                false,
                vending_core::health::HealthLevel::Offline,
                "SCANNER_DISABLED",
                "scanner disabled",
            ));
            self.shutdown.cancelled().await;
            return Ok(());
        }

        let mut backoff_ms = 500_u64;
        loop {
            // 优先通过 USB identity 动态解析当前 COM 口，避免重启后端口号变化
            let resolved_port = if let Some(identity) = &self.config.usb_identity {
                match vending_core::serial::find_port_path_by_usb_identity(identity) {
                    Some(p) => Some(p),
                    None => {
                        self.emit_health(self.health_snapshot(
                            false,
                            vending_core::health::HealthLevel::Offline,
                            "SCANNER_USB_NOT_FOUND",
                            format!(
                                "scanner USB device not found (VID={} PID={}), will retry",
                                identity.vendor_id, identity.product_id
                            ),
                        ));
                        tokio::select! {
                            _ = self.shutdown.cancelled() => return Ok(()),
                            _ = tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)) => {
                                backoff_ms = (backoff_ms * 2).min(10_000);
                            }
                        }
                        continue;
                    }
                }
            } else {
                self.config.port_path.clone()
            };

            let Some(port_path) = resolved_port else {
                self.emit_health(self.health_snapshot(
                    false,
                    vending_core::health::HealthLevel::Offline,
                    "SCANNER_PORT_MISSING",
                    "scanner serial port is not configured",
                ));
                self.shutdown.cancelled().await;
                return Ok(());
            };

            match tokio_serial::new(&port_path, self.config.baud_rate).open_native_async() {
                Ok(port) => {
                    backoff_ms = 500;
                    self.emit_health(self.health_snapshot_with_port(
                        true,
                        vending_core::health::HealthLevel::Ok,
                        "SCANNER_READY",
                        "scanner ready",
                        &port_path,
                    ));
                    self.read_loop(port, &port_path).await?;
                }
                Err(error) => {
                    self.emit_health(self.health_snapshot_with_port(
                        false,
                        vending_core::health::HealthLevel::Offline,
                        "SCANNER_OPEN_FAILED",
                        format!("open scanner serial failed: {error}"),
                        &port_path,
                    ));
                }
            }

            tokio::select! {
                _ = self.shutdown.cancelled() => return Ok(()),
                _ = tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)) => {
                    backoff_ms = (backoff_ms * 2).min(10_000);
                }
            }
        }
    }

    fn health_snapshot(
        &self,
        online: bool,
        level: vending_core::health::HealthLevel,
        code: &str,
        message: impl Into<String>,
    ) -> vending_core::scanner::ScannerHealthSnapshot {
        self.health_snapshot_with_port(online, level, code, message, "")
    }

    fn health_snapshot_with_port(
        &self,
        online: bool,
        level: vending_core::health::HealthLevel,
        code: &str,
        message: impl Into<String>,
        port: &str,
    ) -> vending_core::scanner::ScannerHealthSnapshot {
        let resolved_port = if port.is_empty() {
            self.config.port_path.clone()
        } else {
            Some(port.to_string())
        };
        vending_core::scanner::ScannerHealthSnapshot {
            online,
            adapter: self.config.source.clone(),
            port: resolved_port,
            level,
            code: code.to_string(),
            message: message.into(),
            updated_at: crate::state::store::now_iso(),
        }
    }

    fn emit_health(&self, snapshot: vending_core::scanner::ScannerHealthSnapshot) {
        let _ = self.tx_events.send(DaemonEvent::ScannerHealthChanged {
            event_id: Uuid::new_v4().simple().to_string(),
            updated_at: snapshot.updated_at.clone(),
            snapshot: crate::events::scanner_runtime_status_contract(&snapshot),
        });
    }

    async fn read_loop(
        &self,
        mut port: tokio_serial::SerialStream,
        port_path: &str,
    ) -> Result<(), String> {
        let mut framer = vending_core::scanner::ScannerFramer::new(self.config.frame_suffix);
        let mut buffer = [0_u8; 1024];
        let heartbeat_period = std::time::Duration::from_secs(5);
        let mut heartbeat = tokio::time::interval_at(
            tokio::time::Instant::now() + heartbeat_period,
            heartbeat_period,
        );
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            tokio::select! {
                _ = self.shutdown.cancelled() => return Ok(()),
                _ = heartbeat.tick() => {
                    self.emit_health(self.health_snapshot_with_port(
                        true,
                        vending_core::health::HealthLevel::Ok,
                        "SCANNER_READY",
                        "scanner ready",
                        port_path,
                    ));
                }
                read = tokio::io::AsyncReadExt::read(&mut port, &mut buffer) => {
                    let read = match read {
                        Ok(read) => read,
                        Err(error) => {
                            self.emit_health(self.health_snapshot(
                                false,
                                vending_core::health::HealthLevel::Degraded,
                                "SCANNER_RECONNECTING",
                                format!("scanner read failed, reconnecting: {error}"),
                            ));
                            return Ok(());
                        }
                    };
                    if read == 0 {
                        self.emit_health(self.health_snapshot(
                            false,
                            vending_core::health::HealthLevel::Degraded,
                            "SCANNER_RECONNECTING",
                            "scanner disconnected, reconnecting",
                        ));
                        return Ok(());
                    }

                    let now_ms = crate::state::store::now_millis();
                    for raw in framer.push_bytes(&buffer[..read], now_ms) {
                        let _ = self.tx_events.send(DaemonEvent::ScannerCode {
                            event_id: Uuid::new_v4().simple().to_string(),
                            updated_at: crate::state::store::now_iso(),
                            masked_code: raw.masked_code.clone(),
                            source: self.config.source.clone(),
                            scanned_at_ms: raw.scanned_at_ms,
                        });
                        if let Err(error) = self.tx_raw.send(raw).await {
                            return Err(format!("submit scanner code failed: {error}"));
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::default_public_config;
    use tokio_util::sync::CancellationToken;

    #[tokio::test]
    async fn scanner_runtime_with_disabled_adapter_returns_ok() {
        let (raw_tx, mut raw_rx) = mpsc::channel(4);
        let (event_tx, mut event_rx) = broadcast::channel(4);
        let shutdown = CancellationToken::new();

        let config = crate::config::EffectiveRuntimeConfig {
            scanner_adapter: ScannerAdapterKind::Disabled,
            ..default_public_config()
        };
        let runtime = ScannerRuntime::from_config(&config, raw_tx, event_tx, shutdown.clone());
        let handle = tokio::spawn(runtime.run());

        let event = tokio::time::timeout(std::time::Duration::from_secs(2), event_rx.recv())
            .await
            .expect("health event")
            .expect("event");
        shutdown.cancel();
        assert!(handle.await.expect("join").is_ok());

        let payload = serde_json::to_value(event).expect("event json");
        assert_eq!(payload["type"], "scanner_health_changed");
        assert_eq!(payload["snapshot"]["code"], "SCANNER_DISABLED");
        assert!(raw_rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn scanner_runtime_reports_open_failed_without_raw_code() {
        let (raw_tx, mut raw_rx) = mpsc::channel(4);
        let (event_tx, mut event_rx) = broadcast::channel(8);
        let shutdown = CancellationToken::new();
        let config = crate::config::EffectiveRuntimeConfig {
            scanner_adapter: ScannerAdapterKind::SerialText,
            scanner_serial_port_path: Some("/dev/vem-missing-scanner".to_string()),
            ..default_public_config()
        };
        let runtime = ScannerRuntime::from_config(&config, raw_tx, event_tx, shutdown.clone());

        let handle = tokio::spawn(runtime.run());
        loop {
            let event = tokio::time::timeout(std::time::Duration::from_secs(2), event_rx.recv())
                .await
                .expect("health event")
                .expect("event");
            let payload = serde_json::to_value(event).expect("event json");
            if payload["type"] == "scanner_health_changed"
                && payload["snapshot"]["code"] == "SCANNER_OPEN_FAILED"
            {
                assert_eq!(payload["snapshot"]["online"], false);
                assert_eq!(payload["snapshot"]["adapter"], "serial_text");
                assert!(raw_rx.try_recv().is_err());
                shutdown.cancel();
                assert!(handle.await.expect("join").is_ok());
                break;
            }
        }
    }

    #[tokio::test]
    async fn scanner_controller_restores_previous_runtime_when_reconfigure_fails() {
        let (raw_tx, _raw_rx) = mpsc::channel(4);
        let (event_tx, mut event_rx) = broadcast::channel(16);
        let controller = ScannerRuntimeController::new(raw_tx, event_tx);
        let disabled = crate::config::EffectiveRuntimeConfig {
            scanner_adapter: ScannerAdapterKind::Disabled,
            ..default_public_config()
        };
        controller
            .reconfigure_from_config(&disabled)
            .await
            .expect("start previous disabled runtime");
        let _ = event_rx.recv().await.expect("initial disabled event");

        let missing = crate::config::EffectiveRuntimeConfig {
            scanner_adapter: ScannerAdapterKind::SerialText,
            scanner_serial_port_path: Some("/dev/vem-missing-scanner".to_string()),
            ..default_public_config()
        };
        let error = controller
            .reconfigure_from_config(&missing)
            .await
            .expect_err("missing replacement must fail");
        assert!(error.contains("open scanner serial failed"));

        let mut restored_disabled = false;
        while let Ok(event) =
            tokio::time::timeout(std::time::Duration::from_secs(2), event_rx.recv()).await
        {
            let event = event.expect("event");
            let payload = serde_json::to_value(event).expect("event json");
            if payload["type"] == "scanner_health_changed"
                && payload["snapshot"]["code"] == "SCANNER_DISABLED"
            {
                restored_disabled = true;
                break;
            }
        }
        assert!(
            restored_disabled,
            "previous scanner runtime must be restored"
        );
        controller.stop().await.expect("stop restored runtime");
    }
}

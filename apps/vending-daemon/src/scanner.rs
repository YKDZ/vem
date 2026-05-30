use tokio::sync::{broadcast, mpsc};
use tokio_serial::SerialPortBuilderExt;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::config::{MachinePublicConfig, ScannerAdapterKind};
use crate::events::DaemonEvent;

#[derive(Debug, Clone)]
pub struct ScannerRuntimeConfig {
    pub port_path: Option<String>,
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

impl ScannerRuntime {
    pub fn from_config(
        config: &MachinePublicConfig,
        tx_raw: mpsc::Sender<vending_core::scanner::RawPaymentCode>,
        tx_events: broadcast::Sender<DaemonEvent>,
        shutdown: CancellationToken,
    ) -> Self {
        let source = match config.scanner_adapter {
            ScannerAdapterKind::SerialText => "serial".to_string(),
            ScannerAdapterKind::KeyboardHid => "keyboard_hid".to_string(),
            ScannerAdapterKind::WebSerialDev => "web_serial_dev".to_string(),
            ScannerAdapterKind::Disabled => "disabled".to_string(),
        };

        let port_path = match config.scanner_adapter {
            ScannerAdapterKind::SerialText => config.scanner_serial_port_path.clone(),
            _ => config
                .serial_port_path
                .clone()
                .or_else(|| config.scanner_serial_port_path.clone()),
        };

        Self {
            config: ScannerRuntimeConfig {
                port_path,
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
        let Some(port_path) = self.config.port_path else {
            return Ok(());
        };

        let mut port = tokio_serial::new(port_path, self.config.baud_rate)
            .open_native_async()
            .map_err(|error| format!("open scanner serial failed: {error}"))?;
        let mut framer = vending_core::scanner::ScannerFramer::new(self.config.frame_suffix);
        let mut buffer = [0_u8; 1024];

        loop {
            tokio::select! {
                _ = self.shutdown.cancelled() => return Ok(()),
                read = tokio::io::AsyncReadExt::read(&mut port, &mut buffer) => {
                    let read = read.map_err(|error| format!("read scanner serial failed: {error}"))?;
                    if read == 0 {
                        continue;
                    }
                    let now_ms = crate::state::store::now_millis();
                    for raw in framer.push_bytes(&buffer[..read], now_ms) {
                        let _ = self.tx_events.send(DaemonEvent::ScannerCode {
                            event_id: Uuid::new_v4().simple().to_string(),
                            updated_at: crate::state::store::now_iso(),
                            masked_code: raw.masked_code.clone(),
                            scanned_at_ms: now_ms,
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

        let config = crate::config::MachinePublicConfig {
            scanner_adapter: ScannerAdapterKind::Disabled,
            ..default_public_config()
        };
        let no_op =
            ScannerRuntime::from_config(&config, raw_tx, event_tx, CancellationToken::new());
        assert!(no_op.run().await.is_ok());
        assert!(raw_rx.try_recv().is_err());
        assert!(event_rx.try_recv().is_err());

        let serial = ScannerRuntime::from_config(
            &crate::config::MachinePublicConfig {
                scanner_adapter: ScannerAdapterKind::KeyboardHid,
                ..default_public_config()
            },
            mpsc::channel(1).0,
            tokio::sync::broadcast::channel(1).0,
            CancellationToken::new(),
        );
        assert_eq!(serial.config.source, "keyboard_hid");
    }
}

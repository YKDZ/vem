use serde::Serialize;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_serial::SerialPortBuilderExt;

use vending_core::scanner::{mask_code, ScannerFramer};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannerSelfCheckResult {
    pub online: bool,
    pub adapter: String,
    pub port: Option<String>,
    pub message: String,
    pub checked_at_ms: u128,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentCodeScannedEvent {
    pub masked_code: String,
    pub source: String,
    pub scanned_at_ms: u128,
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::from_secs(0))
        .as_millis()
}

pub async fn self_check_serial(
    port_path: Option<String>,
    baud_rate: u32,
) -> ScannerSelfCheckResult {
    let checked_at_ms = now_ms();
    let Some(path) = port_path else {
        return ScannerSelfCheckResult {
            online: false,
            adapter: "serial_text".to_string(),
            port: None,
            message: "scannerSerialPortPath is not configured".to_string(),
            checked_at_ms,
        };
    };
    match tokio_serial::new(path.clone(), baud_rate).open_native_async() {
        Ok(mut port) => {
            let _ = port.flush().await;
            ScannerSelfCheckResult {
                online: true,
                adapter: "serial_text".to_string(),
                port: Some(path),
                message: "扫码串口可打开".to_string(),
                checked_at_ms,
            }
        }
        Err(error) => ScannerSelfCheckResult {
            online: false,
            adapter: "serial_text".to_string(),
            port: Some(path),
            message: format!("扫码串口打开失败: {error}"),
            checked_at_ms,
        },
    }
}

pub async fn read_loop(app: AppHandle, port_path: String, baud_rate: u32) -> Result<(), String> {
    let mut port = tokio_serial::new(port_path, baud_rate)
        .open_native_async()
        .map_err(|error| format!("open scanner serial failed: {error}"))?;
    let mut buf = [0_u8; 256];
    let mut framer = ScannerFramer::default();
    loop {
        let read = port
            .read(&mut buf)
            .await
            .map_err(|error| format!("read scanner serial failed: {error}"))?;
        let now = now_ms();
        for raw in framer.push_bytes(&buf[..read], now) {
            let _ = mask_code(&raw.auth_code);
            let event = PaymentCodeScannedEvent {
                masked_code: raw.masked_code,
                source: "tauri_scanner".to_string(),
                scanned_at_ms: now,
            };
            app.emit("payment-code-scanned", event)
                .map_err(|error| format!("emit scanner event failed: {error}"))?;
        }
    }
}

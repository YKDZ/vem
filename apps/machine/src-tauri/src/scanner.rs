use serde::Serialize;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_serial::SerialPortBuilderExt;

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
    pub auth_code: String,
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

fn mask_code(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return "****".to_string();
    }
    if trimmed.len() <= 8 {
        return format!("{}****", &trimmed[..trimmed.len().min(2)]);
    }
    format!("{}****{}", &trimmed[..4], &trimmed[trimmed.len() - 4..])
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
    let mut frame = Vec::<u8>::new();
    let mut last_code = String::new();
    let mut last_at = 0_u128;
    loop {
        let read = port
            .read(&mut buf)
            .await
            .map_err(|error| format!("read scanner serial failed: {error}"))?;
        for byte in &buf[..read] {
            if *byte == b'\r' || *byte == b'\n' {
                if frame.is_empty() {
                    continue;
                }
                let code = String::from_utf8_lossy(&frame).trim().to_string();
                frame.clear();
                let now = now_ms();
                if code == last_code && now.saturating_sub(last_at) < 1500 {
                    continue;
                }
                last_code = code.clone();
                last_at = now;
                let event = PaymentCodeScannedEvent {
                    auth_code: code.clone(),
                    masked_code: mask_code(&code),
                    source: "tauri_scanner".to_string(),
                    scanned_at_ms: now,
                };
                app.emit("payment-code-scanned", event)
                    .map_err(|error| format!("emit scanner event failed: {error}"))?;
            } else if !byte.is_ascii_control() {
                frame.push(*byte);
            }
        }
    }
}

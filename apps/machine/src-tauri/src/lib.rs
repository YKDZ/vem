use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum HardwareAdapterKind {
    Mock,
    Serial,
    Bluetooth,
    VendorSdk,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MachineConfig {
    machine_code: Option<String>,
    api_base_url: String,
    mqtt_url: String,
    hardware_adapter: HardwareAdapterKind,
    kiosk_mode: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
enum HardwareHealthStatus {
    Ok,
    Degraded,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HardwareSelfCheckResult {
    adapter: HardwareAdapterKind,
    status: HardwareHealthStatus,
    message: String,
    checked_at_ms: u128,
}

fn default_config() -> MachineConfig {
    MachineConfig {
        machine_code: None,
        api_base_url: "http://localhost:3000/api".to_string(),
        mqtt_url: "mqtt://localhost:1883".to_string(),
        hardware_adapter: HardwareAdapterKind::Mock,
        kiosk_mode: false,
    }
}

fn now_ms() -> Result<u128, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .map_err(|error| format!("system clock error: {error}"))
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("resolve app config dir failed: {error}"))?;
    fs::create_dir_all(&dir).map_err(|error| format!("create app config dir failed: {error}"))?;
    Ok(dir.join("machine-config.json"))
}

fn normalize_config(mut config: MachineConfig) -> Result<MachineConfig, String> {
    if let Some(machine_code) = config.machine_code.as_ref() {
        let trimmed = machine_code.trim();
        config.machine_code = if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        };
    }

    config.api_base_url = config.api_base_url.trim().trim_end_matches('/').to_string();
    config.mqtt_url = config.mqtt_url.trim().to_string();

    if config.api_base_url.is_empty() {
        return Err("apiBaseUrl is required".to_string());
    }
    if config.mqtt_url.is_empty() {
        return Err("mqttUrl is required".to_string());
    }

    Ok(config)
}

#[tauri::command]
fn get_machine_config(app: tauri::AppHandle) -> Result<MachineConfig, String> {
    let path = config_path(&app)?;
    if !path.exists() {
        return Ok(default_config());
    }

    let content = fs::read_to_string(&path)
        .map_err(|error| format!("read machine config failed: {error}"))?;
    let parsed: MachineConfig = serde_json::from_str(&content)
        .map_err(|error| format!("parse machine config failed: {error}"))?;
    normalize_config(parsed)
}

#[tauri::command]
fn save_machine_config(
    app: tauri::AppHandle,
    config: MachineConfig,
) -> Result<MachineConfig, String> {
    let normalized = normalize_config(config)?;
    let path = config_path(&app)?;
    let content = serde_json::to_string_pretty(&normalized)
        .map_err(|error| format!("serialize machine config failed: {error}"))?;
    fs::write(&path, content).map_err(|error| format!("write machine config failed: {error}"))?;
    Ok(normalized)
}

#[tauri::command]
fn hardware_self_check(app: tauri::AppHandle) -> Result<HardwareSelfCheckResult, String> {
    let config = get_machine_config(app)?;
    let checked_at_ms = now_ms()?;

    match config.hardware_adapter {
        HardwareAdapterKind::Mock => Ok(HardwareSelfCheckResult {
            adapter: HardwareAdapterKind::Mock,
            status: HardwareHealthStatus::Ok,
            message: "mock adapter ready".to_string(),
            checked_at_ms,
        }),
        adapter => Ok(HardwareSelfCheckResult {
            adapter,
            status: HardwareHealthStatus::Degraded,
            message: "第一阶段仅启用 mock adapter；真实硬件 adapter 在后续阶段接入".to_string(),
            checked_at_ms,
        }),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_machine_config,
            save_machine_config,
            hardware_self_check
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

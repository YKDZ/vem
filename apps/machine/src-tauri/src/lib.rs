mod hardware;
mod local_logs;
mod native_mqtt;

use std::{
    fs,
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use hardware::MockHardwareAdapter;
use native_mqtt::{NativeMqttRuntime, NativeMqttStatus};
use rumqttc::MqttOptions;
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

/// Persisted to disk – no secrets.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MachinePublicConfigFile {
    machine_code: Option<String>,
    api_base_url: String,
    mqtt_url: String,
    mqtt_username: Option<String>,
    hardware_adapter: HardwareAdapterKind,
    kiosk_mode: bool,
}

/// Returned to the TypeScript layer; secrets are either present (runtime) or omitted (public).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MachineConfig {
    machine_code: Option<String>,
    machine_secret: Option<String>,
    machine_secret_configured: bool,
    mqtt_signing_secret: Option<String>,
    mqtt_signing_secret_configured: bool,
    mqtt_username: Option<String>,
    mqtt_password: Option<String>,
    mqtt_password_configured: bool,
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

const KEYRING_SERVICE: &str = "com.vem.machine";
const MACHINE_SECRET_ACCOUNT: &str = "machine_secret";
const MQTT_SIGNING_SECRET_ACCOUNT: &str = "mqtt_signing_secret";
const MQTT_PASSWORD_ACCOUNT: &str = "mqtt_password";

fn now_ms() -> Result<u128, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .map_err(|error| format!("system clock error: {error}"))
}

fn public_config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("resolve app config dir failed: {error}"))?;
    fs::create_dir_all(&dir).map_err(|error| format!("create app config dir failed: {error}"))?;
    Ok(dir.join("machine-config.json"))
}

fn keyring_entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, account)
        .map_err(|error| format!("create keyring entry failed: {error}"))
}

fn read_secret(account: &str) -> Result<Option<String>, String> {
    match keyring_entry(account)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("read keyring secret failed: {error}")),
    }
}

fn write_secret_if_present(account: &str, value: Option<&String>) -> Result<(), String> {
    if let Some(secret) = value {
        let trimmed = secret.trim();
        if !trimmed.is_empty() {
            keyring_entry(account)?
                .set_password(trimmed)
                .map_err(|error| format!("write keyring secret failed: {error}"))?;
        }
    }
    Ok(())
}

fn default_public_config() -> MachinePublicConfigFile {
    MachinePublicConfigFile {
        machine_code: None,
        api_base_url: "http://localhost:3000/api".to_string(),
        mqtt_url: "mqtt://localhost:1883".to_string(),
        mqtt_username: None,
        hardware_adapter: HardwareAdapterKind::Mock,
        kiosk_mode: false,
    }
}

fn read_public_config(app: &tauri::AppHandle) -> Result<MachinePublicConfigFile, String> {
    let path = public_config_path(app)?;
    if !path.exists() {
        return Ok(default_public_config());
    }
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("read machine config failed: {error}"))?;
    let parsed: MachinePublicConfigFile = serde_json::from_str(&content)
        .map_err(|error| format!("parse machine config failed: {error}"))?;
    Ok(parsed)
}

fn attach_secret_state(
    public: MachinePublicConfigFile,
    include_secrets: bool,
) -> Result<MachineConfig, String> {
    let (machine_secret, machine_secret_configured) = if include_secrets {
        let secret = read_secret(MACHINE_SECRET_ACCOUNT)?;
        let configured = secret.is_some();
        (secret, configured)
    } else {
        let configured = read_secret(MACHINE_SECRET_ACCOUNT)?.is_some();
        (None, configured)
    };

    let (mqtt_signing_secret, mqtt_signing_secret_configured) = if include_secrets {
        let secret = read_secret(MQTT_SIGNING_SECRET_ACCOUNT)?;
        let configured = secret.is_some();
        (secret, configured)
    } else {
        let configured = read_secret(MQTT_SIGNING_SECRET_ACCOUNT)?.is_some();
        (None, configured)
    };

    let (mqtt_password, mqtt_password_configured) = if include_secrets {
        let secret = read_secret(MQTT_PASSWORD_ACCOUNT)?;
        let configured = secret.is_some();
        (secret, configured)
    } else {
        let configured = read_secret(MQTT_PASSWORD_ACCOUNT)?.is_some();
        (None, configured)
    };

    Ok(MachineConfig {
        machine_code: public.machine_code,
        machine_secret,
        machine_secret_configured,
        mqtt_signing_secret,
        mqtt_signing_secret_configured,
        mqtt_username: public.mqtt_username,
        mqtt_password,
        mqtt_password_configured,
        api_base_url: public.api_base_url,
        mqtt_url: public.mqtt_url,
        hardware_adapter: public.hardware_adapter,
        kiosk_mode: public.kiosk_mode,
    })
}

fn normalize_config(config: MachineConfig) -> Result<MachineConfig, String> {
    let machine_code = config
        .machine_code
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let machine_secret = config
        .machine_secret
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let mqtt_signing_secret = config
        .mqtt_signing_secret
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let mqtt_username = config
        .mqtt_username
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let mqtt_password = config
        .mqtt_password
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let api_base_url = config.api_base_url.trim().trim_end_matches('/').to_string();
    let mqtt_url = config.mqtt_url.trim().to_string();

    if api_base_url.is_empty() {
        return Err("apiBaseUrl is required".to_string());
    }
    if mqtt_url.is_empty() {
        return Err("mqttUrl is required".to_string());
    }

    Ok(MachineConfig {
        machine_code,
        machine_secret_configured: machine_secret.is_some() || config.machine_secret_configured,
        machine_secret,
        mqtt_signing_secret_configured: mqtt_signing_secret.is_some()
            || config.mqtt_signing_secret_configured,
        mqtt_signing_secret,
        mqtt_username,
        mqtt_password_configured: mqtt_password.is_some() || config.mqtt_password_configured,
        mqtt_password,
        api_base_url,
        mqtt_url,
        hardware_adapter: config.hardware_adapter,
        kiosk_mode: config.kiosk_mode,
    })
}

#[tauri::command]
fn get_machine_config(app: tauri::AppHandle) -> Result<MachineConfig, String> {
    let public = read_public_config(&app)?;
    attach_secret_state(public, false)
}

#[tauri::command]
fn get_machine_runtime_config(app: tauri::AppHandle) -> Result<MachineConfig, String> {
    let public = read_public_config(&app)?;
    attach_secret_state(public, true)
}

#[tauri::command]
fn save_machine_config(
    app: tauri::AppHandle,
    config: MachineConfig,
) -> Result<MachineConfig, String> {
    let normalized = normalize_config(config)?;
    write_secret_if_present(MACHINE_SECRET_ACCOUNT, normalized.machine_secret.as_ref())?;
    write_secret_if_present(
        MQTT_SIGNING_SECRET_ACCOUNT,
        normalized.mqtt_signing_secret.as_ref(),
    )?;
    write_secret_if_present(MQTT_PASSWORD_ACCOUNT, normalized.mqtt_password.as_ref())?;

    let public = MachinePublicConfigFile {
        machine_code: normalized.machine_code.clone(),
        api_base_url: normalized.api_base_url.clone(),
        mqtt_url: normalized.mqtt_url.clone(),
        mqtt_username: normalized.mqtt_username.clone(),
        hardware_adapter: normalized.hardware_adapter.clone(),
        kiosk_mode: normalized.kiosk_mode,
    };
    let content = serde_json::to_string_pretty(&public)
        .map_err(|error| format!("serialize machine config failed: {error}"))?;
    fs::write(public_config_path(&app)?, content)
        .map_err(|error| format!("write machine config failed: {error}"))?;
    get_machine_config(app)
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

// ─── Native MQTT runtime state ────────────────────────────────────────────────

struct MqttRuntimeState {
    runtime: Option<Arc<NativeMqttRuntime>>,
}

#[tauri::command]
async fn start_native_mqtt_runtime(
    app: tauri::AppHandle,
    state: tauri::State<'_, tokio::sync::Mutex<MqttRuntimeState>>,
) -> Result<NativeMqttStatus, String> {
    let mut guard = state.lock().await;
    if guard.runtime.is_some() {
        // Already running — return current status
        if let Some(rt) = &guard.runtime {
            return Ok(rt.status.read().await.clone());
        }
    }

    let config = get_machine_config(app)?;
    let machine_code = config.machine_code.ok_or("machine_code not configured")?;
    let signing_secret =
        read_secret(MQTT_SIGNING_SECRET_ACCOUNT)?.ok_or("mqtt_signing_secret not configured")?;
    let mqtt_url = config.mqtt_url;

    // Parse mqtt://host:port or mqtts://host:port
    let (scheme, rest) = mqtt_url
        .split_once("://")
        .ok_or("invalid mqtt_url format")?;
    let (host, port_str) = rest.rsplit_once(':').ok_or("mqtt_url missing port")?;
    let port: u16 = port_str
        .parse()
        .map_err(|_| "mqtt_url port is not a number")?;

    let client_id = format!("machine-{machine_code}");
    let mut mqtt_options = MqttOptions::new(client_id, host, port);
    mqtt_options.set_keep_alive(std::time::Duration::from_secs(30));
    if let Some(username) = config.mqtt_username.filter(|u| !u.is_empty()) {
        let password = read_secret(MQTT_PASSWORD_ACCOUNT)?.unwrap_or_default();
        mqtt_options.set_credentials(username, password);
    }
    if scheme == "mqtts" || scheme == "ssl" {
        return Err("mqtts TLS is not yet supported in native runtime; use mqtt://".to_string());
    }
    let _ = scheme;

    let hardware: Arc<dyn hardware::HardwareAdapter> = Arc::new(MockHardwareAdapter);
    let (runtime, event_loop) =
        NativeMqttRuntime::new(machine_code, signing_secret, hardware, mqtt_options);
    let runtime = Arc::new(runtime);
    guard.runtime = Some(runtime.clone());

    let rt_clone = runtime.clone();
    let status_arc = runtime.status.clone();
    tokio::spawn(async move {
        if let Err(err) = rt_clone.start(event_loop).await {
            let mut s = status_arc.write().await;
            s.last_error = Some(err);
            s.running = false;
        }
    });

    let status = runtime.status.read().await.clone();
    Ok(status)
}

#[tauri::command]
async fn stop_native_mqtt_runtime(
    state: tauri::State<'_, tokio::sync::Mutex<MqttRuntimeState>>,
) -> Result<(), String> {
    let mut guard = state.lock().await;
    if let Some(rt) = guard.runtime.take() {
        let mut s = rt.status.write().await;
        s.running = false;
        s.connected = false;
    }
    Ok(())
}

#[tauri::command]
async fn native_mqtt_status(
    state: tauri::State<'_, tokio::sync::Mutex<MqttRuntimeState>>,
) -> Result<NativeMqttStatus, String> {
    let guard = state.lock().await;
    if let Some(rt) = &guard.runtime {
        Ok(rt.status.read().await.clone())
    } else {
        Ok(NativeMqttStatus::default())
    }
}

// ─── Local logs commands ──────────────────────────────────────────────────────

fn log_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("resolve app log dir failed: {e}"))?;
    Ok(dir.join("machine-events.jsonl"))
}

#[tauri::command]
fn get_local_log_stats(app: tauri::AppHandle) -> Result<local_logs::LocalLogStats, String> {
    let path = log_path(&app)?;
    local_logs::read_local_log_stats(&path)
}

#[tauri::command]
fn export_local_logs_zip(app: tauri::AppHandle) -> Result<Vec<u8>, String> {
    let path = log_path(&app)?;
    local_logs::export_local_logs(&path, "machine-events.jsonl")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(tokio::sync::Mutex::new(MqttRuntimeState { runtime: None }))
        .invoke_handler(tauri::generate_handler![
            get_machine_config,
            get_machine_runtime_config,
            save_machine_config,
            hardware_self_check,
            start_native_mqtt_runtime,
            stop_native_mqtt_runtime,
            native_mqtt_status,
            get_local_log_stats,
            export_local_logs_zip,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

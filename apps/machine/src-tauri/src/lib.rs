mod hardware;
mod local_logs;
mod native_mqtt;
mod scanner;
mod serial_protocol;
mod vision;

use std::{
    fs,
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use hardware::{HardwareAdapter, MockHardwareAdapter};
use native_mqtt::{NativeMqttRuntime, NativeMqttStatus};
use rumqttc::MqttOptions;
use serde::{Deserialize, Serialize};
use serial_protocol::SerialHardwareAdapter;
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
#[serde(rename_all = "snake_case")]
enum ScannerAdapterKind {
    Disabled,
    SerialText,
    KeyboardHid,
    WebSerialDev,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ScannerFrameSuffix {
    Crlf,
    Lf,
    Cr,
    None,
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
    serial_port_path: Option<String>,
    scanner_adapter: ScannerAdapterKind,
    scanner_serial_port_path: Option<String>,
    scanner_baud_rate: u32,
    scanner_frame_suffix: ScannerFrameSuffix,
    #[serde(default = "default_vision_enabled")]
    vision_enabled: bool,
    #[serde(default = "default_vision_ws_url")]
    vision_ws_url: String,
    #[serde(default)]
    vision_auto_start: bool,
    #[serde(default)]
    vision_process_command: Option<String>,
    #[serde(default)]
    vision_process_args: Option<String>,
    #[serde(default = "default_vision_request_timeout_ms")]
    vision_request_timeout_ms: u64,
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
    serial_port_path: Option<String>,
    scanner_adapter: ScannerAdapterKind,
    scanner_serial_port_path: Option<String>,
    scanner_baud_rate: u32,
    scanner_frame_suffix: ScannerFrameSuffix,
    #[serde(default = "default_vision_enabled")]
    vision_enabled: bool,
    #[serde(default = "default_vision_ws_url")]
    vision_ws_url: String,
    #[serde(default)]
    vision_auto_start: bool,
    #[serde(default)]
    vision_process_command: Option<String>,
    #[serde(default)]
    vision_process_args: Option<String>,
    #[serde(default = "default_vision_request_timeout_ms")]
    vision_request_timeout_ms: u64,
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

fn default_vision_enabled() -> bool {
    true
}

fn default_vision_ws_url() -> String {
    vision::DEFAULT_VISION_WS_URL.to_string()
}

fn default_vision_request_timeout_ms() -> u64 {
    8_000
}

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
        serial_port_path: None,
        scanner_adapter: ScannerAdapterKind::Disabled,
        scanner_serial_port_path: None,
        scanner_baud_rate: 9600,
        scanner_frame_suffix: ScannerFrameSuffix::Crlf,
        vision_enabled: default_vision_enabled(),
        vision_ws_url: default_vision_ws_url(),
        vision_auto_start: false,
        vision_process_command: None,
        vision_process_args: None,
        vision_request_timeout_ms: default_vision_request_timeout_ms(),
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
        serial_port_path: public.serial_port_path,
        scanner_adapter: public.scanner_adapter,
        scanner_serial_port_path: public.scanner_serial_port_path,
        scanner_baud_rate: public.scanner_baud_rate,
        scanner_frame_suffix: public.scanner_frame_suffix,
        vision_enabled: public.vision_enabled,
        vision_ws_url: public.vision_ws_url,
        vision_auto_start: public.vision_auto_start,
        vision_process_command: public.vision_process_command,
        vision_process_args: public.vision_process_args,
        vision_request_timeout_ms: public.vision_request_timeout_ms,
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

    let serial_port_path = config
        .serial_port_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let scanner_serial_port_path = config
        .scanner_serial_port_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let vision_ws_url = config.vision_ws_url.trim().to_string();

    let vision_process_command = config
        .vision_process_command
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let vision_process_args = config
        .vision_process_args
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
    if matches!(&config.hardware_adapter, HardwareAdapterKind::Serial) && serial_port_path.is_none()
    {
        return Err("serialPortPath is required when hardwareAdapter=serial".to_string());
    }
    if matches!(&config.scanner_adapter, ScannerAdapterKind::SerialText)
        && scanner_serial_port_path.is_none()
    {
        return Err(
            "scannerSerialPortPath is required when scannerAdapter=serial_text".to_string(),
        );
    }
    if vision_ws_url.is_empty() {
        return Err("visionWsUrl is required".to_string());
    }
    if config.vision_enabled && config.vision_auto_start && vision_process_command.is_none() {
        return Err("visionProcessCommand is required when visionAutoStart=true".to_string());
    }
    if !(1_000..=30_000).contains(&config.vision_request_timeout_ms) {
        return Err("visionRequestTimeoutMs must be between 1000 and 30000".to_string());
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
        serial_port_path,
        scanner_adapter: config.scanner_adapter,
        scanner_serial_port_path,
        scanner_baud_rate: config.scanner_baud_rate,
        scanner_frame_suffix: config.scanner_frame_suffix,
        vision_enabled: config.vision_enabled,
        vision_ws_url,
        vision_auto_start: config.vision_auto_start,
        vision_process_command,
        vision_process_args,
        vision_request_timeout_ms: config.vision_request_timeout_ms,
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
        serial_port_path: normalized.serial_port_path.clone(),
        scanner_adapter: normalized.scanner_adapter.clone(),
        scanner_serial_port_path: normalized.scanner_serial_port_path.clone(),
        scanner_baud_rate: normalized.scanner_baud_rate,
        scanner_frame_suffix: normalized.scanner_frame_suffix.clone(),
        vision_enabled: normalized.vision_enabled,
        vision_ws_url: normalized.vision_ws_url.clone(),
        vision_auto_start: normalized.vision_auto_start,
        vision_process_command: normalized.vision_process_command.clone(),
        vision_process_args: normalized.vision_process_args.clone(),
        vision_request_timeout_ms: normalized.vision_request_timeout_ms,
        kiosk_mode: normalized.kiosk_mode,
    };
    let content = serde_json::to_string_pretty(&public)
        .map_err(|error| format!("serialize machine config failed: {error}"))?;
    fs::write(public_config_path(&app)?, content)
        .map_err(|error| format!("write machine config failed: {error}"))?;
    get_machine_config(app)
}

fn serial_port_path(config: &MachineConfig) -> Result<String, String> {
    config
        .serial_port_path
        .clone()
        .filter(|path| !path.trim().is_empty())
        .ok_or_else(|| "serialPortPath is required when hardwareAdapter=serial".to_string())
}

fn build_hardware_adapter(config: &MachineConfig) -> Result<Arc<dyn HardwareAdapter>, String> {
    match &config.hardware_adapter {
        HardwareAdapterKind::Mock => Ok(Arc::new(MockHardwareAdapter)),
        HardwareAdapterKind::Serial => Ok(Arc::new(SerialHardwareAdapter::new(serial_port_path(
            config,
        )?))),
        HardwareAdapterKind::Bluetooth => {
            Err("bluetooth hardware adapter is not implemented".to_string())
        }
        HardwareAdapterKind::VendorSdk => {
            Err("vendor_sdk hardware adapter is not implemented".to_string())
        }
    }
}

#[tauri::command]
async fn hardware_self_check(app: tauri::AppHandle) -> Result<HardwareSelfCheckResult, String> {
    let config = get_machine_config(app)?;
    let checked_at_ms = now_ms()?;

    match config.hardware_adapter.clone() {
        HardwareAdapterKind::Mock => {
            let adapter = MockHardwareAdapter;
            let status = adapter.self_check().await;
            Ok(HardwareSelfCheckResult {
                adapter: HardwareAdapterKind::Mock,
                status: if status.online {
                    HardwareHealthStatus::Ok
                } else {
                    HardwareHealthStatus::Degraded
                },
                message: status.message,
                checked_at_ms,
            })
        }
        HardwareAdapterKind::Serial => match serial_port_path(&config) {
            Ok(path) => {
                let adapter = SerialHardwareAdapter::new(path);
                let status = adapter.self_check().await;
                Ok(HardwareSelfCheckResult {
                    adapter: HardwareAdapterKind::Serial,
                    status: if status.online {
                        HardwareHealthStatus::Ok
                    } else {
                        HardwareHealthStatus::Degraded
                    },
                    message: status.message,
                    checked_at_ms,
                })
            }
            Err(error) => Ok(HardwareSelfCheckResult {
                adapter: HardwareAdapterKind::Serial,
                status: HardwareHealthStatus::Degraded,
                message: error,
                checked_at_ms,
            }),
        },
        adapter => Ok(HardwareSelfCheckResult {
            adapter,
            status: HardwareHealthStatus::Degraded,
            message: "该硬件 adapter 尚未实现；请选择 mock 或 serial".to_string(),
            checked_at_ms,
        }),
    }
}

// ─── Native MQTT runtime state ────────────────────────────────────────────────

struct MqttRuntimeState {
    runtime: Option<Arc<NativeMqttRuntime>>,
}

#[derive(Default)]
struct ScannerRuntimeState {
    running: AtomicBool,
}

#[derive(Default)]
struct VisionRuntimeState {
    child: Option<tokio::process::Child>,
}

fn split_vision_process_args(args: Option<&String>) -> Vec<String> {
    args.map(|value| {
        value
            .split_whitespace()
            .filter(|part| !part.is_empty())
            .map(str::to_string)
            .collect()
    })
    .unwrap_or_default()
}

#[tauri::command]
async fn scanner_self_check(
    app: tauri::AppHandle,
) -> Result<scanner::ScannerSelfCheckResult, String> {
    let config = get_machine_config(app)?;
    Ok(match config.scanner_adapter {
        ScannerAdapterKind::SerialText => {
            scanner::self_check_serial(config.scanner_serial_port_path, config.scanner_baud_rate)
                .await
        }
        ScannerAdapterKind::Disabled => scanner::ScannerSelfCheckResult {
            online: false,
            adapter: "disabled".to_string(),
            port: None,
            message: "扫码模块未启用".to_string(),
            checked_at_ms: now_ms()?,
        },
        ScannerAdapterKind::KeyboardHid => scanner::ScannerSelfCheckResult {
            online: false,
            adapter: "keyboard_hid".to_string(),
            port: None,
            message: "键盘 HID 扫码由浏览器 / 前端环境处理".to_string(),
            checked_at_ms: now_ms()?,
        },
        ScannerAdapterKind::WebSerialDev => scanner::ScannerSelfCheckResult {
            online: false,
            adapter: "web_serial_dev".to_string(),
            port: None,
            message: "Web Serial 调试模式仅在浏览器开发页可用".to_string(),
            checked_at_ms: now_ms()?,
        },
    })
}

#[tauri::command]
async fn start_scanner(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<ScannerRuntimeState>();
    if state.running.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let config = get_machine_config(app.clone())?;
    let Some(path) = config.scanner_serial_port_path else {
        state.running.store(false, Ordering::SeqCst);
        return Err("scannerSerialPortPath is required".to_string());
    };
    let baud_rate = config.scanner_baud_rate;
    tokio::spawn(async move {
        let _ = scanner::read_loop(app.clone(), path, baud_rate).await;
        app.state::<ScannerRuntimeState>()
            .running
            .store(false, Ordering::SeqCst);
    });
    Ok(())
}

#[tauri::command]
async fn start_vision_runtime(
    app: tauri::AppHandle,
    state: tauri::State<'_, tokio::sync::Mutex<VisionRuntimeState>>,
) -> Result<vision::VisionRuntimeStatus, String> {
    let config = get_machine_config(app)?;
    if !config.vision_enabled {
        return Ok(vision::VisionRuntimeStatus {
            running: false,
            pid: None,
            message: "视觉模块未启用".to_string(),
        });
    }

    let mut guard = state.lock().await;
    if let Some(child) = guard.child.as_mut() {
        match child
            .try_wait()
            .map_err(|error| format!("check vision process failed: {error}"))?
        {
            Some(_status) => {
                guard.child.take();
            }
            None => {
                return Ok(vision::VisionRuntimeStatus {
                    running: true,
                    pid: child.id(),
                    message: "视觉进程已在运行".to_string(),
                });
            }
        }
    }

    let command_path = config
        .vision_process_command
        .clone()
        .ok_or_else(|| "visionProcessCommand is required".to_string())?;
    let args = split_vision_process_args(config.vision_process_args.as_ref());
    let mut command = tokio::process::Command::new(command_path);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let child = command
        .spawn()
        .map_err(|error| format!("start vision process failed: {error}"))?;
    let pid = child.id();
    guard.child = Some(child);
    Ok(vision::VisionRuntimeStatus {
        running: true,
        pid,
        message: "视觉进程已启动".to_string(),
    })
}

#[tauri::command]
async fn stop_vision_runtime(
    state: tauri::State<'_, tokio::sync::Mutex<VisionRuntimeState>>,
) -> Result<vision::VisionRuntimeStatus, String> {
    let mut guard = state.lock().await;
    if let Some(mut child) = guard.child.take() {
        let pid = child.id();
        child
            .kill()
            .await
            .map_err(|error| format!("stop vision process failed: {error}"))?;
        return Ok(vision::VisionRuntimeStatus {
            running: false,
            pid,
            message: "视觉进程已停止".to_string(),
        });
    }
    Ok(vision::VisionRuntimeStatus {
        running: false,
        pid: None,
        message: "没有由上位机托管的视觉进程".to_string(),
    })
}

#[tauri::command]
async fn vision_runtime_status(
    state: tauri::State<'_, tokio::sync::Mutex<VisionRuntimeState>>,
) -> Result<vision::VisionRuntimeStatus, String> {
    let mut guard = state.lock().await;
    if let Some(child) = guard.child.as_mut() {
        match child
            .try_wait()
            .map_err(|error| format!("check vision process failed: {error}"))?
        {
            Some(status) => {
                guard.child.take();
                return Ok(vision::VisionRuntimeStatus {
                    running: false,
                    pid: None,
                    message: format!("视觉进程已退出：{status}"),
                });
            }
            None => {
                return Ok(vision::VisionRuntimeStatus {
                    running: true,
                    pid: child.id(),
                    message: "视觉进程运行中".to_string(),
                });
            }
        }
    }
    Ok(vision::VisionRuntimeStatus {
        running: false,
        pid: None,
        message: "没有由上位机托管的视觉进程".to_string(),
    })
}

#[tauri::command]
async fn vision_self_check(app: tauri::AppHandle) -> Result<vision::VisionSelfCheckResult, String> {
    let config = get_machine_config(app)?;
    let checked_at_ms = now_ms()?;
    if !config.vision_enabled {
        return Ok(vision::VisionSelfCheckResult {
            enabled: false,
            online: false,
            message: "视觉模块未启用".to_string(),
            checked_at_ms,
            ready: None,
        });
    }

    match vision::check_ready(
        &config.vision_ws_url,
        config.machine_code.clone(),
        config.vision_request_timeout_ms,
    )
    .await
    {
        Ok(ready) => Ok(vision::VisionSelfCheckResult {
            enabled: true,
            online: ready.camera_ready && ready.model_ready && !ready.busy,
            message: format!("{} {}", ready.server_name, ready.server_version),
            checked_at_ms,
            ready: Some(ready),
        }),
        Err(error) => Ok(vision::VisionSelfCheckResult {
            enabled: true,
            online: false,
            message: error,
            checked_at_ms,
            ready: None,
        }),
    }
}

#[tauri::command]
async fn request_vision_profile(
    app: tauri::AppHandle,
    input: vision::VisionProfileRequestInput,
) -> Result<vision::VisionProfileResultPayload, String> {
    let config = get_machine_config(app)?;
    if !config.vision_enabled {
        return Err("视觉模块未启用".to_string());
    }
    vision::request_profile(
        &config.vision_ws_url,
        config.machine_code.clone(),
        input,
        config.vision_request_timeout_ms,
    )
    .await
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
    let hardware = build_hardware_adapter(&config)?;
    let machine_code = config
        .machine_code
        .clone()
        .ok_or("machine_code not configured")?;
    let signing_secret =
        read_secret(MQTT_SIGNING_SECRET_ACCOUNT)?.ok_or("mqtt_signing_secret not configured")?;
    let mqtt_url = config.mqtt_url.clone();

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
    if let Some(username) = config.mqtt_username.as_deref().filter(|u| !u.is_empty()) {
        let password = read_secret(MQTT_PASSWORD_ACCOUNT)?.unwrap_or_default();
        mqtt_options.set_credentials(username, password);
    }
    if scheme == "mqtts" || scheme == "ssl" {
        return Err("mqtts TLS is not yet supported in native runtime; use mqtt://".to_string());
    }
    let _ = scheme;

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
        .manage(ScannerRuntimeState::default())
        .manage(tokio::sync::Mutex::new(VisionRuntimeState::default()))
        .invoke_handler(tauri::generate_handler![
            get_machine_config,
            get_machine_runtime_config,
            save_machine_config,
            hardware_self_check,
            scanner_self_check,
            start_scanner,
            start_vision_runtime,
            stop_vision_runtime,
            vision_runtime_status,
            vision_self_check,
            request_vision_profile,
            start_native_mqtt_runtime,
            stop_native_mqtt_runtime,
            native_mqtt_status,
            get_local_log_stats,
            export_local_logs_zip,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

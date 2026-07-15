use serde::{Deserialize, Serialize};
use std::path::Path;

mod native_audio;
use native_audio::{
    play_machine_audio, stop_machine_audio, test_machine_audio_output, MachineAudioState,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DaemonReadyFile {
    healthz_url: String,
    #[serde(rename = "readyzUrl")]
    _readyz_url: String,
    ipc_token: String,
    #[serde(default)]
    runtime_flags: MachineRuntimeFlags,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MachineRuntimeFlags {
    advanced_maintenance_config: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DaemonConnectionInfo {
    base_url: String,
    token: String,
    source: &'static str,
    mock: bool,
    runtime_flags: MachineRuntimeFlags,
}

fn daemon_ready_file_path() -> String {
    if let Ok(path) = std::env::var("VEM_DAEMON_READY_FILE") {
        return path;
    }
    if let Ok(data_dir) = std::env::var("VEM_DAEMON_DATA_DIR") {
        return Path::new(&data_dir)
            .join("daemon-ready.json")
            .to_string_lossy()
            .into_owned();
    }

    default_daemon_ready_file_path()
}

fn default_daemon_ready_file_path() -> String {
    #[cfg(windows)]
    {
        return std::env::var("ProgramData")
            .map(|dir| {
                Path::new(&dir)
                    .join("VEM")
                    .join("vending-daemon")
                    .join("daemon-ready.json")
                    .to_string_lossy()
                    .into_owned()
            })
            .unwrap_or_else(|_| "daemon-ready.json".to_string());
    }

    #[cfg(not(windows))]
    {
        "daemon-ready.json".to_string()
    }
}

#[tauri::command]
fn get_daemon_connection() -> Result<DaemonConnectionInfo, String> {
    let path = daemon_ready_file_path();
    let content = std::fs::read_to_string(&path)
        .map_err(|error| format!("read daemon ready file failed: {error}"))?;
    let ready: DaemonReadyFile = serde_json::from_str(&content)
        .map_err(|error| format!("parse daemon ready file failed: {error}"))?;

    Ok(DaemonConnectionInfo {
        base_url: ready.healthz_url.trim_end_matches("/healthz").to_string(),
        token: ready.ipc_token,
        source: "tauri_ready_file",
        mock: false,
        runtime_flags: ready.runtime_flags,
    })
}

#[tauri::command]
async fn return_to_desktop(session_id: String) -> Result<(), String> {
    let session_id = session_id.trim();
    if session_id.is_empty() || session_id.len() > 128 {
        return Err("protected desktop exit authorization is invalid".to_string());
    }
    let connection = get_daemon_connection()?;
    let url = format!("{}/v1/maintenance/desktop-exit", connection.base_url);
    let parsed = reqwest::Url::parse(&url)
        .map_err(|_| "protected desktop exit authorization is unavailable".to_string())?;
    if !matches!(
        parsed.host_str(),
        Some("127.0.0.1") | Some("localhost") | Some("::1")
    ) {
        return Err("protected desktop exit authorization is unavailable".to_string());
    }
    let response = reqwest::Client::new()
        .post(parsed)
        .bearer_auth(connection.token)
        .header("x-vem-maintenance-session", session_id)
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await
        .map_err(|_| "protected desktop exit authorization is unavailable".to_string())?;
    if !response.status().is_success() {
        return Err("protected desktop exit authorization was denied".to_string());
    }
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_millis(100));
        std::process::exit(0);
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(MachineAudioState::default())
        .invoke_handler(tauri::generate_handler![
            get_daemon_connection,
            play_machine_audio,
            test_machine_audio_output,
            stop_machine_audio,
            return_to_desktop
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

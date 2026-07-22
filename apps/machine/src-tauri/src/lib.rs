use serde::{Deserialize, Serialize};
use std::path::Path;
#[cfg(windows)]
use tauri::Manager;

mod native_audio;
use native_audio::{play_machine_audio, stop_machine_audio, MachineAudioState};
mod system_touch_keyboard;
use system_touch_keyboard::{
    hide_system_touch_keyboard, query_system_touch_keyboard_state, show_system_touch_keyboard,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DaemonReadyFile {
    healthz_url: String,
    #[serde(rename = "readyzUrl")]
    _readyz_url: String,
    ipc_token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DaemonConnectionInfo {
    base_url: String,
    token: String,
    source: &'static str,
    mock: bool,
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
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(MachineAudioState::default())
        .setup(|_app| {
            #[cfg(windows)]
            _app.get_webview_window("main")
                .ok_or("main kiosk window is missing")?
                .set_fullscreen(true)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_daemon_connection,
            play_machine_audio,
            stop_machine_audio,
            show_system_touch_keyboard,
            hide_system_touch_keyboard,
            query_system_touch_keyboard_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

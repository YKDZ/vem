use serde::{Deserialize, Serialize};

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

#[tauri::command]
fn get_daemon_connection() -> Result<DaemonConnectionInfo, String> {
    let path = std::env::var("VEM_DAEMON_READY_FILE").unwrap_or_else(|_| {
        std::env::var("VEM_DAEMON_DATA_DIR")
            .map(|dir| format!("{dir}/daemon-ready.json"))
            .unwrap_or_else(|_| "daemon-ready.json".to_string())
    });
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
        .invoke_handler(tauri::generate_handler![get_daemon_connection])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

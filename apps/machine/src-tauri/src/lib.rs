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

#[cfg(windows)]
fn enforce_kiosk_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowLongPtrW, SetWindowPos, GWL_STYLE, HWND_TOPMOST, SWP_FRAMECHANGED, SWP_SHOWWINDOW,
        WS_POPUP, WS_VISIBLE,
    };

    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if !unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
        return Err(windows::core::Error::from_win32().to_string());
    }
    let bounds = info.rcMonitor;
    unsafe {
        SetWindowLongPtrW(hwnd, GWL_STYLE, (WS_POPUP | WS_VISIBLE).0 as isize);
        SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            bounds.left,
            bounds.top,
            bounds.right - bounds.left,
            bounds.bottom - bounds.top,
            SWP_FRAMECHANGED | SWP_SHOWWINDOW,
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
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
            {
                let window = _app
                    .get_webview_window("main")
                    .ok_or("main kiosk window is missing")?;
                window.set_fullscreen(true)?;
                enforce_kiosk_window(&window)?;
            }
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

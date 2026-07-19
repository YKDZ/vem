#[cfg(windows)]
use std::process::Command;
#[cfg(windows)]
use std::{thread::sleep, time::Duration};

#[cfg(windows)]
#[link(name = "user32")]
unsafe extern "system" {
    fn FindWindowW(class_name: *const u16, window_name: *const u16) -> isize;
    fn IsWindowVisible(window: isize) -> i32;
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemTouchKeyboardState {
    pub visible: bool,
}

#[cfg(windows)]
fn touch_keyboard_path() -> String {
    let common_program_files = std::env::var("CommonProgramFiles")
        .unwrap_or_else(|_| r"C:\Program Files\Common Files".to_string());
    format!(r"{}\microsoft shared\ink\TabTip.exe", common_program_files)
}

#[cfg(windows)]
fn touch_keyboard_window_visible() -> bool {
    let class_name: Vec<u16> = "IPTip_Main_Window\0".encode_utf16().collect();
    // TabTip can retain a hidden window after it has been dismissed.
    unsafe {
        let window = FindWindowW(class_name.as_ptr(), std::ptr::null());
        window != 0 && IsWindowVisible(window) != 0
    }
}

#[cfg(windows)]
fn wait_for_touch_keyboard_visibility(visible: bool) -> bool {
    for _ in 0..12 {
        if touch_keyboard_window_visible() == visible {
            return true;
        }
        sleep(Duration::from_millis(100));
    }
    touch_keyboard_window_visible() == visible
}

#[tauri::command]
pub fn show_system_touch_keyboard() -> Result<SystemTouchKeyboardState, String> {
    #[cfg(windows)]
    {
        if touch_keyboard_window_visible() {
            return Ok(SystemTouchKeyboardState { visible: true });
        }
        Command::new(touch_keyboard_path())
            .spawn()
            .map_err(|error| format!("启动系统触摸键盘失败: {error}"))?;
        if wait_for_touch_keyboard_visibility(true) {
            Ok(SystemTouchKeyboardState { visible: true })
        } else {
            Err("已启动 TabTip，但未观察到 Windows 系统触摸键盘窗口".to_string())
        }
    }

    #[cfg(not(windows))]
    {
        Err("系统触摸键盘仅在 Windows 上可用".to_string())
    }
}

#[tauri::command]
pub fn hide_system_touch_keyboard() -> Result<SystemTouchKeyboardState, String> {
    #[cfg(windows)]
    {
        let result = Command::new("taskkill")
            .args(["/IM", "TabTip.exe", "/T"])
            .output()
            .map_err(|error| format!("结束系统触摸键盘失败: {error}"))?;
        if wait_for_touch_keyboard_visibility(false) {
            return Ok(SystemTouchKeyboardState { visible: false });
        }
        let stderr = String::from_utf8_lossy(&result.stderr).trim().to_string();
        let detail = if stderr.is_empty() {
            format!("taskkill exit status {}", result.status)
        } else {
            stderr
        };
        Err(format!("未能收起 Windows 系统触摸键盘窗口: {detail}"))
    }

    #[cfg(not(windows))]
    {
        Ok(SystemTouchKeyboardState { visible: false })
    }
}

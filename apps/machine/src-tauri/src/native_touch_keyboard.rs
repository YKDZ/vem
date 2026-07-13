#[cfg(windows)]
fn input_pane() -> Option<windows::UI::ViewManagement::InputPane> {
    windows::UI::ViewManagement::InputPane::GetForCurrentView().ok()
}

#[cfg(windows)]
fn tab_tip_path() -> std::path::PathBuf {
    let base = std::env::var_os("CommonProgramW6432")
        .or_else(|| std::env::var_os("CommonProgramFiles"))
        .unwrap_or_else(|| std::ffi::OsString::from(r"C:\Program Files\Common Files"));
    std::path::PathBuf::from(base)
        .join("microsoft shared")
        .join("ink")
        .join("TabTip.exe")
}

#[tauri::command]
pub fn show_touch_keyboard() -> Result<bool, String> {
    #[cfg(windows)]
    {
        if input_pane().and_then(|pane| pane.TryShow().ok()) == Some(true) {
            return Ok(true);
        }
        std::process::Command::new(tab_tip_path())
            .spawn()
            .map(|_| true)
            .map_err(|error| format!("启动 Windows 触摸键盘失败：{error}"))
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

#[tauri::command]
pub fn hide_touch_keyboard() -> Result<bool, String> {
    #[cfg(windows)]
    {
        use windows::{
            core::w,
            Win32::UI::WindowsAndMessaging::{FindWindowW, PostMessageW, WM_CLOSE},
        };

        let pane_hidden = input_pane().and_then(|pane| pane.TryHide().ok()) == Some(true);
        let window = unsafe { FindWindowW(w!("IPTip_Main_Window"), None) };
        let fallback_hidden = if let Ok(window) = window {
            unsafe {
                PostMessageW(
                    Some(window),
                    WM_CLOSE,
                    Default::default(),
                    Default::default(),
                )
            }
            .is_ok()
        } else {
            false
        };
        Ok(pane_hidden || fallback_hidden)
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

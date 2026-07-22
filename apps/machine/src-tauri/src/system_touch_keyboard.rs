#[cfg(windows)]
use windows::{
    core::factory, Win32::System::WinRT::IInputPaneInterop, UI::ViewManagement::InputPane,
};

#[cfg(windows)]
fn start_windows_touch_keyboard() -> Result<(), String> {
    let common_program_files = std::env::var_os("CommonProgramFiles")
        .unwrap_or_else(|| r"C:\Program Files\Common Files".into());
    let executable = std::path::PathBuf::from(common_program_files)
        .join("microsoft shared")
        .join("ink")
        .join("TabTip.exe");
    std::process::Command::new(&executable)
        .spawn()
        .map(|_| ())
        .map_err(|error| {
            format!(
                "启动 Windows 系统触摸键盘失败 ({}): {error}",
                executable.display()
            )
        })
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemTouchKeyboardState {
    pub visible: bool,
}

#[cfg(windows)]
fn input_pane_state(input_pane: &InputPane) -> Result<SystemTouchKeyboardState, String> {
    let occluded = input_pane
        .OccludedRect()
        .map_err(|error| format!("读取 Windows 输入面板状态失败: {error}"))?;
    Ok(SystemTouchKeyboardState {
        visible: occluded.Width > 0.0 && occluded.Height > 0.0,
    })
}

#[cfg(windows)]
fn input_pane_for_window(window: &tauri::WebviewWindow) -> Result<InputPane, String> {
    let hwnd = window
        .hwnd()
        .map_err(|error| format!("读取 Machine UI 窗口句柄失败: {error}"))?;
    let interop: IInputPaneInterop = factory::<InputPane, IInputPaneInterop>()
        .map_err(|error| format!("获取 Windows 输入面板失败: {error}"))?;
    unsafe { interop.GetForWindow(hwnd) }
        .map_err(|error| format!("关联 Windows 输入面板失败: {error}"))
}

#[tauri::command]
pub fn show_system_touch_keyboard(
    window: tauri::WebviewWindow,
) -> Result<SystemTouchKeyboardState, String> {
    #[cfg(windows)]
    {
        window
            .set_focus()
            .map_err(|error| format!("聚焦 Machine UI 窗口失败: {error}"))?;
        let input_pane_result = input_pane_for_window(&window).and_then(|input_pane| {
            input_pane
                .TryShow()
                .map_err(|error| format!("显示 Windows 输入面板失败: {error}"))
        });
        match input_pane_result {
            Ok(true) => Ok(SystemTouchKeyboardState { visible: true }),
            Ok(false) | Err(_) => {
                start_windows_touch_keyboard()?;
                Ok(SystemTouchKeyboardState { visible: true })
            }
        }
    }

    #[cfg(not(windows))]
    {
        let _ = window;
        Err("系统触摸键盘仅在 Windows 上可用".to_string())
    }
}

#[tauri::command]
pub fn hide_system_touch_keyboard(
    window: tauri::WebviewWindow,
) -> Result<SystemTouchKeyboardState, String> {
    #[cfg(windows)]
    {
        let _accepted = input_pane_for_window(&window).and_then(|input_pane| {
            input_pane
                .TryHide()
                .map_err(|error| format!("收起 Windows 输入面板失败: {error}"))
        })?;
        Ok(SystemTouchKeyboardState { visible: false })
    }

    #[cfg(not(windows))]
    {
        let _ = window;
        Ok(SystemTouchKeyboardState { visible: false })
    }
}

#[tauri::command]
pub fn query_system_touch_keyboard_state(
    window: tauri::WebviewWindow,
) -> Result<SystemTouchKeyboardState, String> {
    #[cfg(windows)]
    {
        let input_pane = input_pane_for_window(&window)?;
        input_pane_state(&input_pane)
    }

    #[cfg(not(windows))]
    {
        let _ = window;
        Ok(SystemTouchKeyboardState { visible: false })
    }
}

#[cfg(windows)]
use windows::{
    core::factory, Win32::System::WinRT::IInputPaneInterop, UI::ViewManagement::InputPane,
};

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemTouchKeyboardState {
    pub visible: bool,
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
        if input_pane_for_window(&window).and_then(|input_pane| {
            input_pane
                .TryShow()
                .map_err(|error| format!("显示 Windows 输入面板失败: {error}"))
        })? {
            Ok(SystemTouchKeyboardState { visible: true })
        } else {
            Err("Windows 输入面板未接受显示请求".to_string())
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

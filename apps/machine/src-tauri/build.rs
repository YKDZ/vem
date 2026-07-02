fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().windows_attributes(
            tauri_build::WindowsAttributes::new().window_icon_path("app-icon.ico"),
        ),
    )
    .expect("failed to build tauri application")
}

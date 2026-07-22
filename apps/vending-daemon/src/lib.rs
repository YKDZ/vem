pub mod audio_output;
pub mod automatic_vent;
pub mod backend;
pub mod device_binding;
pub mod events;
pub mod hardware;
pub mod health;
pub mod ipc;
pub mod local_runtime_settings;
pub mod logs;
pub mod mqtt;
pub mod natural_context;
pub mod network;
pub mod platform_fs;
pub mod provisioning;
pub mod runtime;
pub mod runtime_configuration;
pub mod scanner;
pub mod secret;
pub mod shutdown;
pub mod state;
pub mod stock_upload;
pub mod transaction;
pub mod vision;
pub mod vision_camera_maintenance;

#[cfg(windows)]
pub mod service_windows;

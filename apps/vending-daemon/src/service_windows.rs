use std::{
    net::{Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    time::Duration,
};

use tokio_util::sync::CancellationToken;

use windows_service::{
    define_windows_service,
    service::{
        ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus,
        ServiceType,
    },
    service_control_handler::{self, ServiceControlHandlerResult},
    service_dispatcher,
};

const SERVICE_NAME: &str = "VemVendingDaemon";
const SERVICE_TYPE: ServiceType = ServiceType::OWN_PROCESS;

#[cfg(windows)]
pub fn run_service() -> windows_service::Result<()> {
    service_dispatcher::start(SERVICE_NAME, ffi_service_main)
}

#[cfg(windows)]
define_windows_service!(ffi_service_main, service_main);

#[cfg(windows)]
fn service_main(_arguments: Vec<std::ffi::OsString>) {
    if let Err(error) = run_service_inner() {
        eprintln!("windows service failed: {error}");
    }
}

#[cfg(windows)]
fn run_service_inner() -> Result<(), String> {
    let stop_token = CancellationToken::new();
    let stop_for_handler = stop_token.clone();

    let status_handle =
        service_control_handler::register(SERVICE_NAME, move |control_event| match control_event {
            ServiceControl::Stop | ServiceControl::Shutdown => {
                stop_for_handler.cancel();
                ServiceControlHandlerResult::NoError
            }
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            _ => ServiceControlHandlerResult::NotImplemented,
        })
        .map_err(|error| format!("register service control handler failed: {error}"))?;

    let service_result = (|| -> Result<(), String> {
        status_handle
            .set_service_status(service_status(
                ServiceState::StartPending,
                ServiceControlAccept::empty(),
                1,
                Duration::from_secs(30),
                0,
            ))
            .map_err(|error| format!("set service start pending failed: {error}"))?;

        let runtime = tokio::runtime::Runtime::new()
            .map_err(|error| format!("start tokio runtime failed: {error}"))?;

        status_handle
            .set_service_status(service_status(
                ServiceState::Running,
                ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
                0,
                Duration::default(),
                0,
            ))
            .map_err(|error| format!("set service running failed: {error}"))?;

        runtime.block_on(async {
            let data_dir = crate::config::resolve_data_dir(None)
                .map_err(|error| format!("resolve data dir failed: {error}"))?;
            let ready_file = resolve_ready_file(&data_dir);
            let config = crate::shutdown::ConsoleRunConfig {
                data_dir: Some(data_dir),
                bind: SocketAddr::new(Ipv4Addr::LOCALHOST.into(), 7891),
                print_ready_file: Some(ready_file),
            };
            crate::shutdown::run_console_with_token(config, stop_token.clone())
                .await
                .map_err(|error| format!("daemon runtime failed: {error}"))
        })
    })();

    let exit_code = if service_result.is_ok() { 0 } else { 1 };
    let _ = status_handle.set_service_status(service_status(
        ServiceState::Stopped,
        ServiceControlAccept::empty(),
        0,
        Duration::default(),
        exit_code,
    ));

    service_result
}

#[cfg(windows)]
fn resolve_ready_file(data_dir: &Path) -> PathBuf {
    std::env::var("VEM_DAEMON_READY_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| crate::shutdown::default_ready_file_path(data_dir))
}

#[cfg(windows)]
fn service_status(
    current_state: ServiceState,
    controls_accepted: ServiceControlAccept,
    checkpoint: u32,
    wait_hint: Duration,
    exit_code: u32,
) -> ServiceStatus {
    ServiceStatus {
        service_type: SERVICE_TYPE,
        current_state,
        controls_accepted,
        exit_code: ServiceExitCode::Win32(exit_code),
        checkpoint,
        wait_hint,
        process_id: None,
    }
}

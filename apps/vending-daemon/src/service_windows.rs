use std::{
    net::{Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
    time::Duration,
};

use tokio_util::sync::CancellationToken;

use windows_service::{
    define_windows_service,
    service::{
        ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus,
        ServiceType,
    },
    service_control_handler::{self, ServiceControlHandlerResult, ServiceStatusHandle},
    service_dispatcher,
};

const SERVICE_NAME: &str = "VemVendingDaemon";
const SERVICE_TYPE: ServiceType = ServiceType::OWN_PROCESS;
const STOP_WAIT_HINT: Duration = Duration::from_secs(30);
const STOP_CHECKPOINT_INTERVAL: Duration = Duration::from_secs(1);

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
    let status_handle_slot = Arc::new(OnceLock::<ServiceStatusHandle>::new());
    let status_for_handler = status_handle_slot.clone();

    let status_handle =
        service_control_handler::register(SERVICE_NAME, move |control_event| match control_event {
            ServiceControl::Stop | ServiceControl::Shutdown => {
                if !stop_for_handler.is_cancelled() {
                    if let Some(status_handle) = status_for_handler.get() {
                        if let Err(error) = status_handle.set_service_status(stop_pending_status(1))
                        {
                            eprintln!("set initial service stop pending failed: {error}");
                        }
                    }
                    stop_for_handler.cancel();
                }
                ServiceControlHandlerResult::NoError
            }
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            _ => ServiceControlHandlerResult::NotImplemented,
        })
        .map_err(|error| format!("register service control handler failed: {error}"))?;
    status_handle_slot
        .set(status_handle)
        .map_err(|_| "publish service status handle failed".to_string())?;

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
            let stop_reporter =
                tokio::spawn(report_stop_pending(status_handle, stop_token.clone()));
            let runtime_result = run_runtime_until_stopped(stop_token.clone()).await;
            stop_reporter.abort();
            let _ = stop_reporter.await;
            runtime_result
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
async fn run_runtime_until_stopped(stop_token: CancellationToken) -> Result<(), String> {
    let data_dir = crate::provisioning::resolve_data_dir(None)
        .map_err(|error| format!("resolve data dir failed: {error}"))?;
    let ready_file = resolve_ready_file(&data_dir);
    let config = crate::shutdown::ConsoleRunConfig {
        data_dir: Some(data_dir),
        bind: SocketAddr::new(Ipv4Addr::LOCALHOST.into(), 7891),
        print_ready_file: Some(ready_file),
    };
    loop {
        match crate::shutdown::run_console_with_token(config.clone(), stop_token.clone()).await {
            Ok(()) if stop_token.is_cancelled() => return Ok(()),
            Ok(()) => {
                eprintln!("daemon runtime exited without service stop; restarting runtime");
            }
            Err(error) if stop_token.is_cancelled() => {
                return Err(format!("daemon runtime failed: {error}"));
            }
            Err(error) => {
                eprintln!("daemon runtime failed: {error}; restarting runtime");
            }
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

#[cfg(windows)]
async fn report_stop_pending(status_handle: ServiceStatusHandle, stop_token: CancellationToken) {
    stop_token.cancelled().await;
    let mut checkpoint = 2_u32;
    loop {
        tokio::time::sleep(STOP_CHECKPOINT_INTERVAL).await;
        if let Err(error) = status_handle.set_service_status(stop_pending_status(checkpoint)) {
            eprintln!("set service stop pending failed: {error}");
            return;
        }
        checkpoint = checkpoint.saturating_add(1);
    }
}

#[cfg(windows)]
fn stop_pending_status(checkpoint: u32) -> ServiceStatus {
    service_status(
        ServiceState::StopPending,
        ServiceControlAccept::empty(),
        checkpoint,
        STOP_WAIT_HINT,
        0,
    )
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

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn stop_pending_status_advances_scm_progress_without_accepting_controls() {
        let status = stop_pending_status(7);

        assert_eq!(status.current_state, ServiceState::StopPending);
        assert_eq!(status.controls_accepted, ServiceControlAccept::empty());
        assert_eq!(status.checkpoint, 7);
        assert_eq!(status.wait_hint, STOP_WAIT_HINT);
        assert_eq!(status.exit_code, ServiceExitCode::Win32(0));
    }
}

use std::net::Ipv4Addr;
use std::net::SocketAddr;
use tokio_util::sync::CancellationToken;

use windows_service::{
    define_windows_service,
    service::ServiceControl,
    service_control_handler::{self, ServiceControlHandlerResult},
    service_dispatcher,
};

#[cfg(windows)]
pub fn run_service() -> windows_service::Result<()> {
    service_dispatcher::start("VemVendingDaemon", ffi_service_main)
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

    let _handler = service_control_handler::register("VemVendingDaemon", move |control_event| {
        match control_event {
            ServiceControl::Stop | ServiceControl::Shutdown => {
                stop_for_handler.cancel();
                ServiceControlHandlerResult::NoError
            }
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            _ => ServiceControlHandlerResult::NotImplemented,
        }
    })
    .map_err(|error| format!("register service control handler failed: {error}"))?;

    let runtime = tokio::runtime::Runtime::new()
        .map_err(|error| format!("start tokio runtime failed: {error}"))?;
    runtime.block_on(async {
        let data_dir = crate::config::resolve_data_dir(None)
            .map_err(|error| format!("resolve data dir failed: {error}"))?;
        let config = vending_daemon::shutdown::ConsoleRunConfig {
            data_dir: Some(data_dir),
            bind: SocketAddr::new(Ipv4Addr::LOCALHOST.into(), 7891),
            print_ready_file: Some(vending_daemon::shutdown::default_ready_file_path(&data_dir)),
        };
        vending_daemon::shutdown::run_console_with_token(config, stop_token.clone())
            .await
            .map_err(|error| format!("daemon runtime failed: {error}"))
    })?;
    Ok(())
}

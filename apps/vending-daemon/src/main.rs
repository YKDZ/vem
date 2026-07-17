use std::{net::SocketAddr, path::PathBuf};

use clap::Parser;

#[derive(Debug, Parser)]
#[command(name = "vending-daemon")]
struct Cli {
    #[arg(long)]
    console: bool,

    #[arg(long, env = "VEM_DAEMON_DATA_DIR")]
    data_dir: Option<PathBuf>,

    #[arg(long, default_value = "127.0.0.1:0")]
    bind: SocketAddr,

    #[arg(long)]
    print_ready_file: Option<PathBuf>,
}

impl From<Cli> for vending_daemon::shutdown::ConsoleRunConfig {
    fn from(value: Cli) -> Self {
        Self {
            data_dir: value.data_dir,
            bind: value.bind,
            print_ready_file: value.print_ready_file,
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    if cli.console || !cfg!(windows) {
        vending_daemon::shutdown::run_console(cli.into())
            .await
            .map_err(std::io::Error::other)?;
        return Ok(());
    }

    #[cfg(windows)]
    {
        if let Some(data_dir) = cli.data_dir.as_ref() {
            std::env::set_var("VEM_DAEMON_DATA_DIR", data_dir.as_os_str());
        }
        if let Some(ready_file) = cli.print_ready_file.as_ref() {
            std::env::set_var("VEM_DAEMON_READY_FILE", ready_file.as_os_str());
        }
        vending_daemon::service_windows::run_service()?;
    }
    #[allow(unreachable_code)]
    Ok(())
}

use std::{net::SocketAddr, path::PathBuf};

use clap::{Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(name = "vending-daemon")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,

    #[arg(long)]
    console: bool,

    #[arg(long, env = "VEM_DAEMON_DATA_DIR")]
    data_dir: Option<PathBuf>,

    #[arg(long, default_value = "127.0.0.1:0")]
    bind: SocketAddr,

    #[arg(long)]
    print_ready_file: Option<PathBuf>,
}

#[derive(Debug, Subcommand)]
enum Command {
    PrepareFactoryRuntime {
        #[arg(long, env = "VEM_DAEMON_DATA_DIR")]
        data_dir: Option<PathBuf>,

        #[arg(long)]
        reset_local_runtime: bool,
    },
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
    if let Some(command) = cli.command {
        run_command(cli.data_dir, command).await?;
        return Ok(());
    }
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

async fn run_command(
    top_level_data_dir: Option<PathBuf>,
    command: Command,
) -> Result<(), Box<dyn std::error::Error>> {
    match command {
        Command::PrepareFactoryRuntime {
            data_dir,
            reset_local_runtime,
        } => {
            let data_dir = resolve_command_data_dir(top_level_data_dir, data_dir)
                .map_err(std::io::Error::other)?;
            let mode = if reset_local_runtime {
                vending_daemon::local_runtime_reset::FactoryPreparationMode::ResetLocalRuntime
            } else {
                vending_daemon::local_runtime_reset::FactoryPreparationMode::CheckCleanHost
            };
            match vending_daemon::local_runtime_reset::prepare_factory_runtime(&data_dir, mode)
                .await
            {
                Ok(evidence) => {
                    println!("{}", serde_json::to_string_pretty(&evidence)?);
                    Ok(())
                }
                Err(vending_daemon::local_runtime_reset::FactoryPreparationError::DirtyHost {
                    evidence,
                }) => {
                    println!("{}", serde_json::to_string_pretty(&evidence)?);
                    std::process::exit(2);
                }
                Err(error) => Err(std::io::Error::other(error).into()),
            }
        }
    }
}

fn resolve_command_data_dir(
    top_level_data_dir: Option<PathBuf>,
    command_data_dir: Option<PathBuf>,
) -> Result<PathBuf, String> {
    match (top_level_data_dir, command_data_dir) {
        (Some(top_level), Some(command)) if top_level != command => Err(format!(
            "ambiguous data dir: top-level --data-dir={} and prepare-factory-runtime --data-dir={} differ",
            top_level.display(),
            command.display()
        )),
        (Some(data_dir), _) | (_, Some(data_dir)) => Ok(data_dir),
        (None, None) => vending_daemon::config::resolve_data_dir(None),
    }
}

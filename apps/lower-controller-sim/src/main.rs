use std::{error::Error, time::Duration};

#[cfg(unix)]
use std::{
    os::fd::{FromRawFd, IntoRawFd},
    path::PathBuf,
};

use clap::{Parser, ValueEnum};
#[cfg(unix)]
use lower_controller_sim::run_lower_controller_simulator_with_halves;
use lower_controller_sim::{
    run_lower_controller_simulator, run_lower_controller_simulator_with_state, ControlCommand,
    DispenseScenario, SimulatorOptions, SimulatorState,
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    net::TcpListener,
    sync::{mpsc, watch},
};
use tokio_serial::{DataBits, FlowControl, Parity, SerialPortBuilderExt, StopBits};
use vending_core::serial::EnvironmentSample;

#[derive(Debug, Parser)]
#[command(version, about = "VEM lower-controller serial protocol simulator")]
struct Cli {
    /// Existing serial port to open as the lower-controller side, for example COM10.
    #[arg(long, env = "VEM_LOWER_CONTROLLER_SIM_PORT")]
    port: Option<String>,

    /// Listen as a TCP debug transport, for example 127.0.0.1:17991.
    #[arg(long, env = "VEM_LOWER_CONTROLLER_SIM_TCP_LISTEN")]
    tcp_listen: Option<String>,

    /// Create a pseudoterminal and print the slave path for daemon serialPortPath.
    #[arg(long, env = "VEM_LOWER_CONTROLLER_SIM_CREATE_PTY")]
    create_pty: bool,

    #[arg(long, value_enum, default_value_t = ScenarioArg::Normal, env = "VEM_LOWER_CONTROLLER_SIM_SCENARIO")]
    scenario: ScenarioArg,

    #[arg(
        long,
        default_value_t = 500,
        env = "VEM_LOWER_CONTROLLER_SIM_HEARTBEAT_MS"
    )]
    heartbeat_ms: u64,

    #[arg(
        long,
        default_value_t = 25,
        env = "VEM_LOWER_CONTROLLER_SIM_FRAME_GAP_MS"
    )]
    frame_gap_ms: u64,

    #[arg(
        long,
        default_value_t = 1500,
        env = "VEM_LOWER_CONTROLLER_SIM_DISPENSE_TO_OUTLET_MS"
    )]
    dispense_to_outlet_ms: u64,

    #[arg(
        long,
        default_value_t = 2000,
        env = "VEM_LOWER_CONTROLLER_SIM_PICKUP_COMPLETE_MS"
    )]
    pickup_complete_ms: u64,

    #[arg(
        long,
        default_value_t = 1000,
        env = "VEM_LOWER_CONTROLLER_SIM_RESET_MS"
    )]
    reset_ms: u64,

    #[arg(
        long,
        default_value_t = 15000,
        env = "VEM_LOWER_CONTROLLER_SIM_PICKUP_WARNING_1_MS"
    )]
    pickup_warning_1_ms: u64,

    #[arg(
        long,
        default_value_t = 25000,
        env = "VEM_LOWER_CONTROLLER_SIM_PICKUP_WARNING_2_MS"
    )]
    pickup_warning_2_ms: u64,

    #[arg(
        long,
        default_value_t = 30000,
        env = "VEM_LOWER_CONTROLLER_SIM_PICKUP_FINAL_TIMEOUT_MS"
    )]
    pickup_final_timeout_ms: u64,

    #[arg(
        long,
        default_value_t = 50,
        env = "VEM_LOWER_CONTROLLER_SIM_EVENT_REPEAT_MS"
    )]
    event_repeat_ms: u64,

    #[arg(
        long,
        default_value_t = 24,
        env = "VEM_LOWER_CONTROLLER_SIM_TEMPERATURE_C"
    )]
    temperature_celsius: i8,

    #[arg(long, default_value_t = 45, env = "VEM_LOWER_CONTROLLER_SIM_HUMIDITY")]
    humidity_percent: u8,

    /// Return E3 for environment queries to simulate a sensor fault.
    #[arg(long, env = "VEM_LOWER_CONTROLLER_SIM_NO_ENVIRONMENT_SAMPLE")]
    no_environment_sample: bool,

    /// Read operator commands from stdin: reset, e3, e6, quit.
    #[arg(long, env = "VEM_LOWER_CONTROLLER_SIM_STDIN_CONTROL")]
    stdin_control: bool,

    #[arg(long, env = "VEM_LOWER_CONTROLLER_SIM_TRACE")]
    trace: bool,

    /// Append bounded acceptance evidence for observed serial frames.
    #[arg(long, env = "VEM_LOWER_CONTROLLER_SIM_FRAME_JOURNAL")]
    frame_journal: Option<PathBuf>,

    /// Hold terminal F2 until this host-owned file exists.
    #[arg(long, env = "VEM_LOWER_CONTROLLER_SIM_F2_RELEASE_FILE")]
    f2_release_file: Option<PathBuf>,

    /// Hold initial F0 until this host-owned file exists.
    #[arg(long, env = "VEM_LOWER_CONTROLLER_SIM_F0_RELEASE_FILE")]
    f0_release_file: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum ScenarioArg {
    Normal,
    PickupTimeoutSuccess,
    PickupTimeoutBlocked,
    MechanicalFault,
}

impl From<ScenarioArg> for DispenseScenario {
    fn from(value: ScenarioArg) -> Self {
        match value {
            ScenarioArg::Normal => Self::Normal,
            ScenarioArg::PickupTimeoutSuccess => Self::PickupTimeoutSuccess,
            ScenarioArg::PickupTimeoutBlocked => Self::PickupTimeoutBlocked,
            ScenarioArg::MechanicalFault => Self::MechanicalFault,
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let cli = Cli::parse();
    if cli.tcp_listen.is_some() && (cli.port.is_some() || cli.create_pty) {
        return Err("--tcp-listen cannot be combined with --port or --create-pty".into());
    }
    if cli.port.is_some() && cli.create_pty {
        return Err("--port and --create-pty are mutually exclusive".into());
    }

    let options = SimulatorOptions {
        scenario: cli.scenario.into(),
        heartbeat_interval: Duration::from_millis(cli.heartbeat_ms),
        command_frame_gap: Duration::from_millis(cli.frame_gap_ms),
        dispense_to_outlet: Duration::from_millis(cli.dispense_to_outlet_ms),
        pickup_complete_after: Duration::from_millis(cli.pickup_complete_ms),
        reset_duration: Duration::from_millis(cli.reset_ms),
        pickup_warning_1_after: Duration::from_millis(cli.pickup_warning_1_ms),
        pickup_warning_2_after: Duration::from_millis(cli.pickup_warning_2_ms),
        pickup_final_timeout_after: Duration::from_millis(cli.pickup_final_timeout_ms),
        event_repeat_interval: Duration::from_millis(cli.event_repeat_ms),
        environment_sample: if cli.no_environment_sample {
            None
        } else {
            Some(EnvironmentSample {
                temperature_celsius: cli.temperature_celsius,
                relative_humidity_percent: cli.humidity_percent,
            })
        },
        trace: cli.trace,
        frame_journal_path: cli.frame_journal,
        f0_release_file: cli.f0_release_file,
        f2_release_file: cli.f2_release_file,
    };

    let (control_tx, control_rx) = mpsc::unbounded_channel();
    if cli.stdin_control {
        spawn_stdin_control(control_tx.clone());
        eprintln!("stdin controls: reset | e3 | e6 | quit");
    }

    match (cli.tcp_listen, cli.port) {
        (Some(address), None) => {
            let state = SimulatorState::default();
            let (shutdown_tx, shutdown_rx) = watch::channel(false);
            spawn_state_control_loop(control_rx, state.clone(), shutdown_tx.clone(), cli.trace);
            tokio::spawn(shutdown_signal(control_tx));
            run_tcp_listener(&address, options, state, shutdown_rx).await?;
        }
        (None, Some(port)) => {
            let stream = open_serial_port(&port)?;
            eprintln!("lower-controller-sim bound to serial port {port}");
            run_lower_controller_simulator(
                stream,
                options,
                control_rx,
                shutdown_signal(control_tx),
            )
            .await?;
        }
        (Some(_), Some(_)) => unreachable!("validated above"),
        (None, None) => {
            #[cfg(unix)]
            {
                if !cli.create_pty {
                    eprintln!("no --port provided; creating a PTY on this Unix host");
                }
                let mut pty = open_pty()?;
                eprintln!(
                    "lower-controller-sim PTY slave: {}",
                    pty.slave_path.display()
                );
                eprintln!(
                    "configure daemon serialPortPath to {}",
                    pty.slave_path.display()
                );
                run_lower_controller_simulator_with_halves(
                    &mut pty.master_reader,
                    pty.master_writer,
                    options,
                    control_rx,
                    shutdown_signal(control_tx),
                )
                .await?;
                drop(pty.slave_guard);
            }
            #[cfg(not(unix))]
            {
                let _ = cli.create_pty;
                return Err("Windows requires --port connected to a virtual COM pair".into());
            }
        }
    }

    Ok(())
}

async fn run_tcp_listener(
    address: &str,
    options: SimulatorOptions,
    state: SimulatorState,
    mut shutdown_rx: watch::Receiver<bool>,
) -> Result<(), Box<dyn Error>> {
    let listener = TcpListener::bind(address).await?;
    let local_addr = listener.local_addr()?;
    eprintln!("lower-controller-sim TCP listening on tcp://{local_addr}");
    eprintln!("configure daemon serialPortPath to tcp://{local_addr}");

    loop {
        tokio::select! {
            changed = shutdown_rx.changed() => {
                if changed.is_err() || *shutdown_rx.borrow() {
                    eprintln!("lower-controller-sim TCP listener shutting down");
                    break;
                }
            }
            accepted = listener.accept() => {
                let (stream, peer_addr) = accepted?;
                stream.set_nodelay(true)?;
                let connection_options = options.clone();
                let connection_state = state.clone();
                let connection_shutdown = shutdown_rx.clone();
                eprintln!("lower-controller-sim TCP client connected: {peer_addr}");
                tokio::spawn(async move {
                    if let Err(error) = run_lower_controller_simulator_with_state(
                        stream,
                        connection_options,
                        connection_state,
                        tcp_connection_shutdown(connection_shutdown),
                    )
                    .await
                    {
                        eprintln!("lower-controller-sim TCP client error: {error}");
                    }
                });
            }
        }
    }
    Ok(())
}

async fn tcp_connection_shutdown(mut shutdown_rx: watch::Receiver<bool>) {
    loop {
        if *shutdown_rx.borrow() {
            break;
        }
        if shutdown_rx.changed().await.is_err() {
            break;
        }
    }
}

fn spawn_state_control_loop(
    mut control_rx: mpsc::UnboundedReceiver<ControlCommand>,
    state: SimulatorState,
    shutdown_tx: watch::Sender<bool>,
    trace: bool,
) {
    tokio::spawn(async move {
        while let Some(command) = control_rx.recv().await {
            let keep_running = state.apply_control_command(command).await;
            if trace {
                let message = match command {
                    ControlCommand::Reset => "operator reset -> idle",
                    ControlCommand::MechanicalFault => "operator injected E3 mechanical fault",
                    ControlCommand::PickupPlatformBlocked => {
                        "operator injected E6 pickup platform blocked"
                    }
                    ControlCommand::Quit => "operator quit",
                };
                eprintln!("lower-controller-sim: {message}");
            }
            if !keep_running {
                let _ = shutdown_tx.send(true);
                break;
            }
        }
    });
}

fn open_serial_port(path: &str) -> Result<tokio_serial::SerialStream, Box<dyn Error>> {
    Ok(tokio_serial::new(path, 115_200)
        .data_bits(DataBits::Eight)
        .flow_control(FlowControl::None)
        .parity(Parity::None)
        .stop_bits(StopBits::One)
        .open_native_async()?)
}

async fn shutdown_signal(control_tx: mpsc::UnboundedSender<ControlCommand>) {
    if tokio::signal::ctrl_c().await.is_ok() {
        let _ = control_tx.send(ControlCommand::Quit);
    }
}

fn spawn_stdin_control(control_tx: mpsc::UnboundedSender<ControlCommand>) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(tokio::io::stdin()).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let command = match line.trim().to_ascii_lowercase().as_str() {
                "reset" => Some(ControlCommand::Reset),
                "e3" | "fault e3" | "mechanical" => Some(ControlCommand::MechanicalFault),
                "e6" | "fault e6" | "blocked" => Some(ControlCommand::PickupPlatformBlocked),
                "quit" | "exit" => Some(ControlCommand::Quit),
                "" => None,
                other => {
                    eprintln!("unknown stdin command: {other}");
                    None
                }
            };
            if let Some(command) = command {
                let quitting = command == ControlCommand::Quit;
                if control_tx.send(command).is_err() || quitting {
                    break;
                }
            }
        }
    });
}

#[cfg(unix)]
struct PtyRuntime {
    slave_path: PathBuf,
    master_reader: tokio::fs::File,
    master_writer: tokio::fs::File,
    slave_guard: std::fs::File,
}

#[cfg(unix)]
fn open_pty() -> Result<PtyRuntime, Box<dyn Error>> {
    use nix::{
        fcntl::OFlag,
        pty::{grantpt, posix_openpt, ptsname_r, unlockpt},
        sys::termios::{cfmakeraw, tcgetattr, tcsetattr, SetArg},
    };

    let master = posix_openpt(OFlag::O_RDWR | OFlag::O_NOCTTY)?;
    grantpt(&master)?;
    unlockpt(&master)?;
    let slave_path = PathBuf::from(ptsname_r(&master)?);
    let slave_guard = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&slave_path)?;
    let mut termios = tcgetattr(&slave_guard)?;
    cfmakeraw(&mut termios);
    tcsetattr(&slave_guard, SetArg::TCSANOW, &termios)?;
    let fd = master.into_raw_fd();
    // SAFETY: fd is freshly taken from `master` and handed to `File` exactly once.
    let master = unsafe { std::fs::File::from_raw_fd(fd) };
    let master_writer = master.try_clone()?;
    Ok(PtyRuntime {
        slave_path,
        master_reader: tokio::fs::File::from_std(master),
        master_writer: tokio::fs::File::from_std(master_writer),
        slave_guard,
    })
}

use std::{
    fmt,
    fs::OpenOptions,
    future::Future,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use tokio::{
    io::{split, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::{mpsc, Mutex},
    time::{interval, sleep, MissedTickBehavior},
};
use vending_core::serial::{
    crc8, validate_slot_bounds, AirConditionerMode, AirConditionerSwitchState, EnvironmentSample,
    LowerFrame, VentSpeed, FRAME_HEAD,
};

pub trait SimulatorIo: AsyncRead + AsyncWrite + Unpin + Send {}

impl<T> SimulatorIo for T where T: AsyncRead + AsyncWrite + Unpin + Send {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PickupOutcome {
    Completed,
    TimeoutThenCompleted,
    TimeoutThenBlocked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DispenseScenario {
    Normal,
    PickupTimeoutSuccess,
    PickupTimeoutBlocked,
    MechanicalFault,
}

#[derive(Debug, Clone)]
pub struct SimulatorOptions {
    pub scenario: DispenseScenario,
    pub heartbeat_interval: Duration,
    pub command_frame_gap: Duration,
    pub dispense_to_outlet: Duration,
    pub pickup_complete_after: Duration,
    pub reset_duration: Duration,
    pub pickup_warning_1_after: Duration,
    pub pickup_warning_2_after: Duration,
    pub pickup_final_timeout_after: Duration,
    pub event_repeat_interval: Duration,
    pub environment_sample: Option<EnvironmentSample>,
    pub trace: bool,
    pub frame_journal_path: Option<PathBuf>,
    pub f2_release_file: Option<PathBuf>,
}

impl Default for SimulatorOptions {
    fn default() -> Self {
        Self {
            scenario: DispenseScenario::Normal,
            heartbeat_interval: Duration::from_millis(500),
            command_frame_gap: Duration::from_millis(25),
            dispense_to_outlet: Duration::from_millis(1_500),
            pickup_complete_after: Duration::from_millis(2_000),
            reset_duration: Duration::from_millis(1_000),
            pickup_warning_1_after: Duration::from_secs(15),
            pickup_warning_2_after: Duration::from_secs(25),
            pickup_final_timeout_after: Duration::from_secs(30),
            event_repeat_interval: Duration::from_millis(50),
            environment_sample: Some(EnvironmentSample {
                temperature_celsius: 24,
                relative_humidity_percent: 45,
            }),
            trace: false,
            frame_journal_path: None,
            f2_release_file: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControllerState {
    Idle,
    Dispensing,
    Pickup,
    Resetting,
    MechanicalFault,
    PickupPlatformBlocked,
}

impl ControllerState {
    fn status_frame(self) -> LowerFrame {
        match self {
            Self::Idle => LowerFrame::IdleHeartbeat,
            Self::Dispensing => LowerFrame::DispensingHeartbeat,
            Self::Pickup => LowerFrame::PickupHeartbeat,
            Self::Resetting => LowerFrame::ResetHeartbeat,
            Self::MechanicalFault => LowerFrame::MechanicalError,
            Self::PickupPlatformBlocked => LowerFrame::PickupPlatformBlocked,
        }
    }

    fn accepts_dispense(self) -> bool {
        matches!(self, Self::Idle)
    }

    fn active_dispense(self) -> bool {
        matches!(self, Self::Dispensing | Self::Pickup | Self::Resetting)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlCommand {
    Reset,
    MechanicalFault,
    PickupPlatformBlocked,
    Quit,
}

#[derive(Debug)]
pub enum SimulatorError {
    Io(io::Error),
}

impl fmt::Display for SimulatorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for SimulatorError {}

impl From<io::Error> for SimulatorError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

type SharedState = Arc<Mutex<ControllerState>>;
type SharedWriter<W> = Arc<Mutex<W>>;

#[derive(Debug, Clone)]
pub struct SimulatorState {
    inner: SharedState,
}

impl Default for SimulatorState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(ControllerState::Idle)),
        }
    }
}

impl SimulatorState {
    pub async fn current(&self) -> ControllerState {
        current_state(&self.inner).await
    }

    pub async fn apply_control_command(&self, command: ControlCommand) -> bool {
        match command {
            ControlCommand::Reset => {
                set_state(&self.inner, ControllerState::Idle).await;
                true
            }
            ControlCommand::MechanicalFault => {
                set_state(&self.inner, ControllerState::MechanicalFault).await;
                true
            }
            ControlCommand::PickupPlatformBlocked => {
                set_state(&self.inner, ControllerState::PickupPlatformBlocked).await;
                true
            }
            ControlCommand::Quit => false,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum UpperFrame {
    BoundaryError,
    StatusQuery,
    EnvironmentQuery(u8),
    AirConditionerTargetQuery,
    AirConditionerTarget {
        mode: AirConditionerMode,
        temperature_celsius: i8,
    },
    AirConditionerSwitchQuery,
    AirConditionerSwitch(AirConditionerSwitchState),
    VentSpeedQuery,
    VentSpeed(VentSpeed),
    DebugDispenseFault,
    SingleDispense {
        layer_no: u8,
        cell_no: u8,
        crc: u8,
        raw: Vec<u8>,
    },
}

pub async fn run_lower_controller_simulator<S, F>(
    stream: S,
    options: SimulatorOptions,
    control_rx: mpsc::UnboundedReceiver<ControlCommand>,
    shutdown: F,
) -> Result<(), SimulatorError>
where
    S: SimulatorIo + 'static,
    F: Future<Output = ()> + Send,
{
    let (mut reader, writer) = split(stream);
    run_lower_controller_simulator_with_halves(&mut reader, writer, options, control_rx, shutdown)
        .await
}

pub async fn run_lower_controller_simulator_with_state<S, F>(
    stream: S,
    options: SimulatorOptions,
    state: SimulatorState,
    shutdown: F,
) -> Result<(), SimulatorError>
where
    S: SimulatorIo + 'static,
    F: Future<Output = ()> + Send,
{
    let (mut reader, writer) = split(stream);
    run_lower_controller_simulator_with_halves_inner(
        &mut reader,
        writer,
        options,
        state,
        None,
        shutdown,
    )
    .await
}

pub async fn run_lower_controller_simulator_with_halves<R, W, F>(
    reader: &mut R,
    writer: W,
    options: SimulatorOptions,
    control_rx: mpsc::UnboundedReceiver<ControlCommand>,
    shutdown: F,
) -> Result<(), SimulatorError>
where
    R: AsyncRead + Unpin + Send,
    W: AsyncWrite + Unpin + Send + 'static,
    F: Future<Output = ()> + Send,
{
    run_lower_controller_simulator_with_halves_inner(
        reader,
        writer,
        options,
        SimulatorState::default(),
        Some(control_rx),
        shutdown,
    )
    .await
}

async fn run_lower_controller_simulator_with_halves_inner<R, W, F>(
    reader: &mut R,
    writer: W,
    options: SimulatorOptions,
    state: SimulatorState,
    mut control_rx: Option<mpsc::UnboundedReceiver<ControlCommand>>,
    shutdown: F,
) -> Result<(), SimulatorError>
where
    R: AsyncRead + Unpin + Send,
    W: AsyncWrite + Unpin + Send + 'static,
    F: Future<Output = ()> + Send,
{
    let writer = Arc::new(Mutex::new(writer));
    trace(&options, "started");
    let heartbeat_task = tokio::spawn(heartbeat_loop(
        writer.clone(),
        state.inner.clone(),
        options.clone(),
    ));

    tokio::pin!(shutdown);
    loop {
        tokio::select! {
            _ = &mut shutdown => {
                trace(&options, "shutdown requested");
                break;
            }
            command = recv_control(&mut control_rx) => {
                match command {
                    Some(ControlCommand::Reset) => {
                        state.apply_control_command(ControlCommand::Reset).await;
                        send_frame(&writer, LowerFrame::IdleHeartbeat).await?;
                        trace(&options, "operator reset -> idle");
                    }
                    Some(ControlCommand::MechanicalFault) => {
                        state.apply_control_command(ControlCommand::MechanicalFault).await;
                        send_frame(&writer, LowerFrame::MechanicalError).await?;
                        trace(&options, "operator injected E3 mechanical fault");
                    }
                    Some(ControlCommand::PickupPlatformBlocked) => {
                        state.apply_control_command(ControlCommand::PickupPlatformBlocked).await;
                        send_frame(&writer, LowerFrame::PickupPlatformBlocked).await?;
                        trace(&options, "operator injected E6 pickup platform blocked");
                    }
                    Some(ControlCommand::Quit) | None => {
                        trace(&options, "operator quit");
                        break;
                    }
                }
            }
            frame = read_upper_frame(reader, options.command_frame_gap) => {
                match frame {
                    Ok(frame) => {
                        handle_upper_frame(frame, writer.clone(), state.inner.clone(), options.clone()).await?;
                    }
                    Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => {
                        trace(&options, "serial stream closed");
                        break;
                    }
                    Err(error) => {
                        trace(&options, &format!("read error: {error}"));
                        return Err(error.into());
                    }
                }
            }
        }
    }

    heartbeat_task.abort();
    Ok(())
}

async fn recv_control(
    control_rx: &mut Option<mpsc::UnboundedReceiver<ControlCommand>>,
) -> Option<ControlCommand> {
    match control_rx {
        Some(rx) => rx.recv().await,
        None => std::future::pending().await,
    }
}

async fn heartbeat_loop<W>(
    writer: SharedWriter<W>,
    state: SharedState,
    options: SimulatorOptions,
) -> Result<(), SimulatorError>
where
    W: AsyncWrite + Unpin + Send,
{
    let mut ticker = interval(options.heartbeat_interval);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        let frame = current_state(&state).await.status_frame();
        send_frame(&writer, frame).await?;
        if frame == LowerFrame::IdleHeartbeat {
            journal_initial_health(&options)?;
        }
    }
}

async fn handle_upper_frame<W>(
    frame: UpperFrame,
    writer: SharedWriter<W>,
    state: SharedState,
    options: SimulatorOptions,
) -> Result<(), SimulatorError>
where
    W: AsyncWrite + Unpin + Send + 'static,
{
    journal_upper_frame(&options, &frame)?;
    match frame {
        UpperFrame::BoundaryError => {
            trace(&options, "rx out-of-bound command");
            send_frame(&writer, LowerFrame::BoundaryError).await?;
        }
        UpperFrame::StatusQuery => {
            let status = current_state(&state).await.status_frame();
            trace(
                &options,
                &format!("rx status query -> {}", status.describe()),
            );
            send_frame(&writer, status).await?;
        }
        UpperFrame::EnvironmentQuery(location) => {
            let frame = options
                .environment_sample
                .map(LowerFrame::EnvironmentSample)
                .unwrap_or(LowerFrame::MechanicalError);
            trace(
                &options,
                &format!("rx environment query location 0x{location:02X}"),
            );
            send_frame(&writer, frame).await?;
        }
        UpperFrame::AirConditionerTargetQuery => {
            trace(&options, "rx air conditioner target query");
            send_frame(
                &writer,
                LowerFrame::AirConditionerTargetEcho {
                    mode: AirConditionerMode::Cooling,
                    temperature_celsius: 25,
                },
            )
            .await?;
        }
        UpperFrame::AirConditionerTarget {
            mode,
            temperature_celsius,
        } => {
            if !(18..=30).contains(&temperature_celsius) {
                send_frame(&writer, LowerFrame::BoundaryError).await?;
            } else {
                trace(
                    &options,
                    &format!("rx set air conditioner target {mode:?} {temperature_celsius}C"),
                );
                send_frame(
                    &writer,
                    LowerFrame::AirConditionerTargetEcho {
                        mode,
                        temperature_celsius,
                    },
                )
                .await?;
            }
        }
        UpperFrame::AirConditionerSwitchQuery => {
            trace(&options, "rx air conditioner switch query");
            send_frame(
                &writer,
                LowerFrame::AirConditionerSwitchEcho {
                    state: AirConditionerSwitchState::SoftOff,
                },
            )
            .await?;
        }
        UpperFrame::AirConditionerSwitch(state) => {
            trace(&options, &format!("rx air conditioner switch {state:?}"));
            send_frame(&writer, LowerFrame::AirConditionerSwitchEcho { state }).await?;
        }
        UpperFrame::VentSpeedQuery => {
            trace(&options, "rx vent speed query");
            send_frame(
                &writer,
                LowerFrame::VentSpeedEcho {
                    speed: VentSpeed::Closed,
                },
            )
            .await?;
        }
        UpperFrame::VentSpeed(speed) => {
            trace(&options, &format!("rx vent speed {speed:?}"));
            send_frame(&writer, LowerFrame::VentSpeedEcho { speed }).await?;
        }
        UpperFrame::DebugDispenseFault => {
            let current = current_state(&state).await;
            if current.active_dispense() {
                set_state(&state, ControllerState::MechanicalFault).await;
                trace(&options, "rx debug dispense fault -> E3");
                send_frame(&writer, LowerFrame::MechanicalError).await?;
            } else {
                trace(
                    &options,
                    "rx debug dispense fault outside active dispense; ignored",
                );
            }
        }
        UpperFrame::SingleDispense {
            layer_no,
            cell_no,
            crc,
            raw,
        } => {
            handle_single_dispense(layer_no, cell_no, crc, raw, writer, state, options).await?;
        }
    }
    Ok(())
}

async fn handle_single_dispense<W>(
    layer_no: u8,
    cell_no: u8,
    crc: u8,
    raw: Vec<u8>,
    writer: SharedWriter<W>,
    state: SharedState,
    options: SimulatorOptions,
) -> Result<(), SimulatorError>
where
    W: AsyncWrite + Unpin + Send + 'static,
{
    if validate_slot_bounds(layer_no as u32, cell_no as u32).is_err() {
        trace(
            &options,
            &format!("rx invalid single dispense {raw:02X?} -> E1"),
        );
        send_frame(&writer, LowerFrame::BoundaryError).await?;
        return Ok(());
    }
    let expected_crc = crc8(&[layer_no, cell_no]);
    if crc != expected_crc {
        trace(
            &options,
            &format!("rx bad crc single dispense {raw:02X?} -> E2"),
        );
        send_frame(&writer, LowerFrame::CrcError).await?;
        return Ok(());
    }
    start_dispense(vec![(layer_no, cell_no)], writer, state, options).await
}

async fn start_dispense<W>(
    slots: Vec<(u8, u8)>,
    writer: SharedWriter<W>,
    state: SharedState,
    options: SimulatorOptions,
) -> Result<(), SimulatorError>
where
    W: AsyncWrite + Unpin + Send + 'static,
{
    let current = current_state(&state).await;
    if !current.accepts_dispense() {
        trace(
            &options,
            &format!(
                "rx dispense while {:?} -> {}",
                current,
                current.status_frame().describe()
            ),
        );
        send_frame(&writer, current.status_frame()).await?;
        return Ok(());
    }

    set_state(&state, ControllerState::Dispensing).await;
    trace(&options, &format!("rx dispense {slots:?} -> ACK"));
    send_frame(&writer, LowerFrame::Ack).await?;
    tokio::spawn(run_dispense_sequence(writer, state, options));
    Ok(())
}

async fn run_dispense_sequence<W>(
    writer: SharedWriter<W>,
    state: SharedState,
    options: SimulatorOptions,
) -> Result<(), SimulatorError>
where
    W: AsyncWrite + Unpin + Send,
{
    sleep(options.dispense_to_outlet).await;
    if current_state(&state).await != ControllerState::Dispensing {
        return Ok(());
    }

    if options.scenario == DispenseScenario::MechanicalFault {
        set_state(&state, ControllerState::MechanicalFault).await;
        trace(&options, "scenario mechanical fault -> E3");
        send_frame(&writer, LowerFrame::MechanicalError).await?;
        return Ok(());
    }

    send_observed_repeated_frame(
        &writer,
        LowerFrame::ArrivalAtOutlet,
        3,
        options.event_repeat_interval,
        &options,
    )
    .await?;
    if current_state(&state).await != ControllerState::Dispensing {
        return Ok(());
    }
    set_state(&state, ControllerState::Pickup).await;

    match pickup_outcome(options.scenario) {
        PickupOutcome::Completed => {
            sleep(options.pickup_complete_after).await;
            if current_state(&state).await != ControllerState::Pickup {
                return Ok(());
            }
            finish_reset_successfully(writer, state, options).await?;
        }
        PickupOutcome::TimeoutThenCompleted | PickupOutcome::TimeoutThenBlocked => {
            sleep(options.pickup_warning_1_after).await;
            if current_state(&state).await != ControllerState::Pickup {
                return Ok(());
            }
            trace(&options, "pickup timeout warning 1 -> E5");
            send_frame(&writer, LowerFrame::PickupTimeout).await?;

            sleep_after_delta(
                options.pickup_warning_1_after,
                options.pickup_warning_2_after,
            )
            .await;
            if current_state(&state).await != ControllerState::Pickup {
                return Ok(());
            }
            trace(&options, "pickup timeout warning 2 -> E5");
            send_frame(&writer, LowerFrame::PickupTimeout).await?;

            sleep_after_delta(
                options.pickup_warning_2_after,
                options.pickup_final_timeout_after,
            )
            .await;
            if current_state(&state).await != ControllerState::Pickup {
                return Ok(());
            }
            match pickup_outcome(options.scenario) {
                PickupOutcome::TimeoutThenCompleted => {
                    finish_reset_successfully(writer, state, options).await?;
                }
                PickupOutcome::TimeoutThenBlocked => {
                    send_repeated_frame(
                        &writer,
                        LowerFrame::PickupCompleted,
                        3,
                        options.event_repeat_interval,
                    )
                    .await?;
                    set_state(&state, ControllerState::Resetting).await;
                    sleep(options.reset_duration).await;
                    set_state(&state, ControllerState::PickupPlatformBlocked).await;
                    trace(&options, "pickup platform remains blocked -> E6");
                    send_frame(&writer, LowerFrame::PickupPlatformBlocked).await?;
                }
                PickupOutcome::Completed => unreachable!("handled above"),
            }
        }
    }

    Ok(())
}

async fn finish_reset_successfully<W>(
    writer: SharedWriter<W>,
    state: SharedState,
    options: SimulatorOptions,
) -> Result<(), SimulatorError>
where
    W: AsyncWrite + Unpin + Send,
{
    trace(&options, "pickup completed -> F1");
    send_observed_repeated_frame(
        &writer,
        LowerFrame::PickupCompleted,
        3,
        options.event_repeat_interval,
        &options,
    )
    .await?;
    set_state(&state, ControllerState::Resetting).await;
    sleep(options.reset_duration).await;
    if current_state(&state).await != ControllerState::Resetting {
        return Ok(());
    }
    wait_for_f2_release(options.f2_release_file.as_deref()).await;
    trace(&options, "reset completed -> F2");
    send_observed_repeated_frame(
        &writer,
        LowerFrame::ResetCompletedFrame,
        3,
        options.event_repeat_interval,
        &options,
    )
    .await?;
    set_state(&state, ControllerState::Idle).await;
    Ok(())
}

fn pickup_outcome(scenario: DispenseScenario) -> PickupOutcome {
    match scenario {
        DispenseScenario::Normal => PickupOutcome::Completed,
        DispenseScenario::PickupTimeoutSuccess => PickupOutcome::TimeoutThenCompleted,
        DispenseScenario::PickupTimeoutBlocked => PickupOutcome::TimeoutThenBlocked,
        DispenseScenario::MechanicalFault => PickupOutcome::Completed,
    }
}

async fn read_upper_frame<R>(reader: &mut R, command_frame_gap: Duration) -> io::Result<UpperFrame>
where
    R: AsyncRead + Unpin,
{
    loop {
        loop {
            let head = reader.read_u8().await?;
            if head == FRAME_HEAD {
                break;
            }
        }

        let code = reader.read_u8().await?;
        if is_lower_echo_code(code) {
            continue;
        }
        return match code {
            0xA0 => Ok(UpperFrame::StatusQuery),
            0xB0 => read_environment_query(reader).await,
            0xB1 => read_air_conditioner_target(reader, command_frame_gap).await,
            0xB2 => read_air_conditioner_switch(reader, command_frame_gap).await,
            0xB3 => read_vent_speed(reader, command_frame_gap).await,
            0xFF => read_debug_or_single_dispense(reader, code).await,
            layer_no => read_dispense_after_layer(reader, layer_no, command_frame_gap).await,
        };
    }
}

fn is_lower_echo_code(code: u8) -> bool {
    matches!(
        code,
        0x00 | 0xE1..=0xE6 | 0xF0..=0xF2 | 0xAA | 0xAB | 0xAC | 0xAF
    )
}

async fn read_optional_byte<R>(
    reader: &mut R,
    command_frame_gap: Duration,
) -> io::Result<Option<u8>>
where
    R: AsyncRead + Unpin,
{
    match tokio::time::timeout(command_frame_gap, reader.read_u8()).await {
        Ok(result) => result.map(Some),
        Err(_) => Ok(None),
    }
}

async fn read_environment_query<R>(reader: &mut R) -> io::Result<UpperFrame>
where
    R: AsyncRead + Unpin,
{
    match reader.read_u8().await? {
        location @ (0x01 | 0x02) => Ok(UpperFrame::EnvironmentQuery(location)),
        _ => Ok(UpperFrame::BoundaryError),
    }
}

async fn read_air_conditioner_target<R>(
    reader: &mut R,
    command_frame_gap: Duration,
) -> io::Result<UpperFrame>
where
    R: AsyncRead + Unpin,
{
    let Some(mode_byte) = read_optional_byte(reader, command_frame_gap).await? else {
        return Ok(UpperFrame::AirConditionerTargetQuery);
    };
    let temperature_celsius = reader.read_u8().await? as i8;
    let mode = match mode_byte {
        0x00 => AirConditionerMode::Cooling,
        0x01 => AirConditionerMode::Heating,
        _ => return Ok(UpperFrame::BoundaryError),
    };
    Ok(UpperFrame::AirConditionerTarget {
        mode,
        temperature_celsius,
    })
}

async fn read_air_conditioner_switch<R>(
    reader: &mut R,
    command_frame_gap: Duration,
) -> io::Result<UpperFrame>
where
    R: AsyncRead + Unpin,
{
    let Some(state_byte) = read_optional_byte(reader, command_frame_gap).await? else {
        return Ok(UpperFrame::AirConditionerSwitchQuery);
    };
    let state = match state_byte {
        0x00 => AirConditionerSwitchState::On,
        0xAA => AirConditionerSwitchState::SoftOff,
        0xFF => AirConditionerSwitchState::HardOff,
        _ => return Ok(UpperFrame::BoundaryError),
    };
    Ok(UpperFrame::AirConditionerSwitch(state))
}

async fn read_vent_speed<R>(reader: &mut R, command_frame_gap: Duration) -> io::Result<UpperFrame>
where
    R: AsyncRead + Unpin,
{
    let Some(speed_byte) = read_optional_byte(reader, command_frame_gap).await? else {
        return Ok(UpperFrame::VentSpeedQuery);
    };
    let speed = match speed_byte {
        0x00 => VentSpeed::Closed,
        0x01 => VentSpeed::Low,
        0x02 => VentSpeed::Medium,
        0x03 => VentSpeed::High,
        0x04 => VentSpeed::Full,
        _ => return Ok(UpperFrame::BoundaryError),
    };
    Ok(UpperFrame::VentSpeed(speed))
}

async fn read_debug_or_single_dispense<R>(reader: &mut R, layer_no: u8) -> io::Result<UpperFrame>
where
    R: AsyncRead + Unpin,
{
    let cell_no = reader.read_u8().await?;
    let crc = reader.read_u8().await?;
    if cell_no == 0xFF && crc == 0xFF {
        Ok(UpperFrame::DebugDispenseFault)
    } else {
        Ok(UpperFrame::SingleDispense {
            layer_no,
            cell_no,
            crc,
            raw: vec![FRAME_HEAD, layer_no, cell_no, crc],
        })
    }
}

async fn read_dispense_after_layer<R>(
    reader: &mut R,
    layer_no: u8,
    _command_frame_gap: Duration,
) -> io::Result<UpperFrame>
where
    R: AsyncRead + Unpin,
{
    let cell_no = reader.read_u8().await?;
    let crc = reader.read_u8().await?;
    Ok(UpperFrame::SingleDispense {
        layer_no,
        cell_no,
        crc,
        raw: vec![FRAME_HEAD, layer_no, cell_no, crc],
    })
}

async fn send_repeated_frame<W>(
    writer: &SharedWriter<W>,
    frame: LowerFrame,
    count: usize,
    interval: Duration,
) -> Result<(), SimulatorError>
where
    W: AsyncWrite + Unpin + Send,
{
    for index in 0..count {
        send_frame(writer, frame).await?;
        if index + 1 < count {
            sleep(interval).await;
        }
    }
    Ok(())
}

async fn send_observed_repeated_frame<W>(
    writer: &SharedWriter<W>,
    frame: LowerFrame,
    count: usize,
    interval: Duration,
    options: &SimulatorOptions,
) -> Result<(), SimulatorError>
where
    W: AsyncWrite + Unpin + Send,
{
    for index in 0..count {
        send_frame(writer, frame).await?;
        if index == 0 {
            journal_controller_frame(options, frame)?;
        }
        if index + 1 < count {
            sleep(interval).await;
        }
    }
    Ok(())
}

async fn send_frame<W>(writer: &SharedWriter<W>, frame: LowerFrame) -> Result<(), SimulatorError>
where
    W: AsyncWrite + Unpin + Send,
{
    let mut writer = writer.lock().await;
    writer.write_all(&frame.protocol_bytes()).await?;
    writer.flush().await?;
    Ok(())
}

async fn current_state(state: &SharedState) -> ControllerState {
    *state.lock().await
}

async fn set_state(state: &SharedState, next: ControllerState) {
    *state.lock().await = next;
}

async fn sleep_after_delta(previous: Duration, next: Duration) {
    sleep(next.saturating_sub(previous)).await;
}

fn trace(options: &SimulatorOptions, message: &str) {
    if options.trace {
        eprintln!("lower-controller-sim: {message}");
    }
}

fn frame_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02X}")).collect()
}

fn append_raw_frame(
    options: &SimulatorOptions,
    direction: &str,
    parsed_opcode: &str,
    bytes: &[u8],
) -> io::Result<()> {
    let Some(path) = &options.frame_journal_path else {
        return Ok(());
    };
    let opcode = bytes.get(1).copied().unwrap_or_default();
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(
        file,
        "{{\"direction\":\"{direction}\",\"parsedOpcode\":\"{parsed_opcode}\",\"opcode\":{opcode},\"rawFrameHex\":\"{}\"}}",
        frame_hex(bytes)
    )
}

fn journal_upper_frame(options: &SimulatorOptions, frame: &UpperFrame) -> io::Result<()> {
    match frame {
        UpperFrame::StatusQuery => append_raw_frame(
            options,
            "daemon-to-controller",
            "A0",
            &[FRAME_HEAD, 0xA0],
        ),
        UpperFrame::SingleDispense { raw, .. } => {
            append_raw_frame(options, "daemon-to-controller", "VEND", raw)
        }
        _ => Ok(()),
    }
}

fn journal_controller_frame(options: &SimulatorOptions, frame: LowerFrame) -> io::Result<()> {
    let parsed_opcode = match frame {
        LowerFrame::IdleHeartbeat => "00",
        LowerFrame::ArrivalAtOutlet => "F0",
        LowerFrame::PickupCompleted => "F1",
        LowerFrame::ResetCompletedFrame => "F2",
        _ => return Ok(()),
    };
    append_raw_frame(
        options,
        "controller-to-daemon",
        parsed_opcode,
        &frame.protocol_bytes(),
    )
}

fn journal_initial_health(options: &SimulatorOptions) -> io::Result<()> {
    if let Some(path) = &options.frame_journal_path {
        if path.exists()
            && std::fs::read_to_string(path)?.contains("\"parsedOpcode\":\"00\"")
        {
            return Ok(());
        }
    }
    journal_controller_frame(options, LowerFrame::IdleHeartbeat)
}

async fn wait_for_f2_release(path: Option<&Path>) {
    let Some(path) = path else {
        return;
    };
    while !path.exists() {
        sleep(Duration::from_millis(25)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{duplex, AsyncWriteExt},
        net::TcpListener,
        sync::watch,
        time::timeout,
    };
    use vending_core::{
        hardware::{DispenseCommandPayload, HardwareAdapter, SlotPayload},
        serial::{
            build_air_conditioner_switch_frame, build_dispense_frame,
            build_environment_sample_query_frame, build_status_query_frame, read_lower_frame,
            SerialHardwareAdapter, DEBUG_DISPENSE_FAULT_FRAME,
        },
    };

    fn fast_options(scenario: DispenseScenario) -> SimulatorOptions {
        SimulatorOptions {
            scenario,
            heartbeat_interval: Duration::from_millis(25),
            command_frame_gap: Duration::from_millis(5),
            dispense_to_outlet: Duration::from_millis(20),
            pickup_complete_after: Duration::from_millis(20),
            reset_duration: Duration::from_millis(20),
            pickup_warning_1_after: Duration::from_millis(20),
            pickup_warning_2_after: Duration::from_millis(40),
            pickup_final_timeout_after: Duration::from_millis(60),
            event_repeat_interval: Duration::from_millis(5),
            environment_sample: Some(EnvironmentSample {
                temperature_celsius: 22,
                relative_humidity_percent: 55,
            }),
            trace: false,
            frame_journal_path: None,
            f2_release_file: None,
        }
    }

    async fn start_test_simulator(
        scenario: DispenseScenario,
    ) -> (
        tokio::io::DuplexStream,
        mpsc::UnboundedSender<ControlCommand>,
        tokio::task::JoinHandle<Result<(), SimulatorError>>,
    ) {
        let (client, server) = duplex(1024);
        let (control_tx, control_rx) = mpsc::unbounded_channel();
        let handle = tokio::spawn(run_lower_controller_simulator(
            server,
            fast_options(scenario),
            control_rx,
            std::future::pending(),
        ));
        (client, control_tx, handle)
    }

    async fn read_until_code<R>(stream: &mut R, code: u8) -> LowerFrame
    where
        R: AsyncRead + Unpin,
    {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            let frame = timeout(remaining, read_lower_frame(stream, Duration::from_secs(1)))
                .await
                .expect("timed out waiting for lower frame")
                .expect("read lower frame");
            if frame.protocol_bytes().get(1).copied() == Some(code) {
                return frame;
            }
        }
    }

    async fn start_tcp_test_simulator(
        scenario: DispenseScenario,
    ) -> (
        String,
        SimulatorState,
        watch::Sender<bool>,
        tokio::task::JoinHandle<Result<(), io::Error>>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind tcp simulator");
        let port_path = format!("tcp://{}", listener.local_addr().expect("local addr"));
        let state = SimulatorState::default();
        let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
        let state_for_task = state.clone();
        let handle = tokio::spawn(async move {
            loop {
                tokio::select! {
                    changed = shutdown_rx.changed() => {
                        if changed.is_err() || *shutdown_rx.borrow() {
                            break;
                        }
                    }
                    accepted = listener.accept() => {
                        let (stream, _) = accepted?;
                        let options = fast_options(scenario);
                        let connection_state = state_for_task.clone();
                        let mut connection_shutdown = shutdown_rx.clone();
                        tokio::spawn(async move {
                            let _ = run_lower_controller_simulator_with_state(
                                stream,
                                options,
                                connection_state,
                                async move {
                                    loop {
                                        if *connection_shutdown.borrow() {
                                            break;
                                        }
                                        if connection_shutdown.changed().await.is_err() {
                                            break;
                                        }
                                    }
                                },
                            )
                            .await;
                        });
                    }
                }
            }
            Ok(())
        });
        (port_path, state, shutdown_tx, handle)
    }

    #[tokio::test]
    async fn simulator_responds_to_status_and_environment_queries() {
        let (mut stream, control_tx, handle) = start_test_simulator(DispenseScenario::Normal).await;

        stream
            .write_all(&build_status_query_frame())
            .await
            .expect("write status query");
        assert_eq!(
            read_until_code(&mut stream, 0xAA).await,
            LowerFrame::IdleHeartbeat
        );

        stream
            .write_all(&build_environment_sample_query_frame())
            .await
            .expect("write environment query");
        assert_eq!(
            read_until_code(&mut stream, 0xB0).await,
            LowerFrame::EnvironmentSample(EnvironmentSample {
                temperature_celsius: 22,
                relative_humidity_percent: 55,
            }),
        );

        stream
            .write_all(&build_air_conditioner_switch_frame(true))
            .await
            .expect("write ac switch");
        assert_eq!(
            read_until_code(&mut stream, 0xB2).await,
            LowerFrame::AirConditionerSwitchEcho {
                state: AirConditionerSwitchState::On,
            },
        );

        control_tx.send(ControlCommand::Quit).expect("quit");
        handle.await.expect("join").expect("sim exits cleanly");
    }

    #[tokio::test]
    async fn simulator_accepts_valid_dispense_and_completes() {
        let (mut stream, control_tx, handle) = start_test_simulator(DispenseScenario::Normal).await;

        stream
            .write_all(&build_dispense_frame(2, 5).expect("frame"))
            .await
            .expect("write dispense");

        assert_eq!(read_until_code(&mut stream, 0x00).await, LowerFrame::Ack);
        assert_eq!(
            read_until_code(&mut stream, 0xF0).await,
            LowerFrame::ArrivalAtOutlet
        );
        assert_eq!(
            read_until_code(&mut stream, 0xF1).await,
            LowerFrame::PickupCompleted
        );
        assert_eq!(
            read_until_code(&mut stream, 0xF2).await,
            LowerFrame::ResetCompletedFrame
        );

        control_tx.send(ControlCommand::Quit).expect("quit");
        handle.await.expect("join").expect("sim exits cleanly");
    }

    #[tokio::test]
    async fn simulator_emits_pickup_timeout_warnings_before_completion() {
        let (mut stream, control_tx, handle) =
            start_test_simulator(DispenseScenario::PickupTimeoutSuccess).await;

        stream
            .write_all(&build_dispense_frame(2, 5).expect("frame"))
            .await
            .expect("write dispense");

        assert_eq!(read_until_code(&mut stream, 0x00).await, LowerFrame::Ack);
        assert_eq!(
            read_until_code(&mut stream, 0xF0).await,
            LowerFrame::ArrivalAtOutlet
        );
        assert_eq!(
            read_until_code(&mut stream, 0xE5).await,
            LowerFrame::PickupTimeout
        );
        assert_eq!(
            read_until_code(&mut stream, 0xE5).await,
            LowerFrame::PickupTimeout
        );
        assert_eq!(
            read_until_code(&mut stream, 0xF1).await,
            LowerFrame::PickupCompleted
        );
        assert_eq!(
            read_until_code(&mut stream, 0xF2).await,
            LowerFrame::ResetCompletedFrame
        );

        control_tx.send(ControlCommand::Quit).expect("quit");
        handle.await.expect("join").expect("sim exits cleanly");
    }

    #[tokio::test]
    async fn simulator_enters_mechanical_fault_on_debug_fault_frame() {
        let (mut stream, control_tx, handle) = start_test_simulator(DispenseScenario::Normal).await;

        stream
            .write_all(&build_dispense_frame(2, 5).expect("frame"))
            .await
            .expect("write dispense");
        assert_eq!(read_until_code(&mut stream, 0x00).await, LowerFrame::Ack);

        stream
            .write_all(&DEBUG_DISPENSE_FAULT_FRAME)
            .await
            .expect("write debug fault");
        assert_eq!(
            read_until_code(&mut stream, 0xE3).await,
            LowerFrame::MechanicalError,
        );

        stream
            .write_all(&build_status_query_frame())
            .await
            .expect("write status query");
        assert_eq!(
            read_until_code(&mut stream, 0xE3).await,
            LowerFrame::MechanicalError,
        );

        control_tx.send(ControlCommand::Reset).expect("reset");
        assert_eq!(
            read_until_code(&mut stream, 0xAA).await,
            LowerFrame::IdleHeartbeat
        );
        control_tx.send(ControlCommand::Quit).expect("quit");
        handle.await.expect("join").expect("sim exits cleanly");
    }

    #[tokio::test]
    async fn simulator_rejects_bad_crc_before_accepting_retry() {
        let (mut stream, control_tx, handle) = start_test_simulator(DispenseScenario::Normal).await;
        let mut bad_frame = build_dispense_frame(2, 5).expect("frame");
        bad_frame[3] ^= 0x01;

        stream
            .write_all(&bad_frame)
            .await
            .expect("write bad dispense");
        assert_eq!(
            read_until_code(&mut stream, 0xE2).await,
            LowerFrame::CrcError
        );

        stream
            .write_all(&build_dispense_frame(2, 5).expect("frame"))
            .await
            .expect("write retry");
        assert_eq!(read_until_code(&mut stream, 0x00).await, LowerFrame::Ack);

        control_tx.send(ControlCommand::Quit).expect("quit");
        handle.await.expect("join").expect("sim exits cleanly");
    }

    #[tokio::test]
    async fn simulator_rejects_out_of_range_environment_control_arguments() {
        let (mut stream, control_tx, handle) = start_test_simulator(DispenseScenario::Normal).await;

        stream
            .write_all(&[FRAME_HEAD, 0xB0, 0x03])
            .await
            .expect("write invalid environment query");
        assert_eq!(
            read_until_code(&mut stream, 0xE1).await,
            LowerFrame::BoundaryError
        );

        stream
            .write_all(&[FRAME_HEAD, 0xB2, 0x01])
            .await
            .expect("write invalid ac switch");
        assert_eq!(
            read_until_code(&mut stream, 0xE1).await,
            LowerFrame::BoundaryError
        );

        stream
            .write_all(&[FRAME_HEAD, 0xB3, 0x05])
            .await
            .expect("write invalid vent speed");
        assert_eq!(
            read_until_code(&mut stream, 0xE1).await,
            LowerFrame::BoundaryError
        );

        control_tx.send(ControlCommand::Quit).expect("quit");
        handle.await.expect("join").expect("sim exits cleanly");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn serial_adapter_can_dispense_through_simulator_pty() {
        let TestPty {
            slave_path,
            master_reader,
            master_writer,
            slave_guard,
        } = open_test_pty();
        let (control_tx, control_rx) = mpsc::unbounded_channel();
        let evidence_root = std::env::temp_dir().join(format!(
            "vem-lower-controller-evidence-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&evidence_root).expect("create evidence root");
        let journal_path = evidence_root.join("raw-serial.jsonl");
        let release_f2_path = evidence_root.join("release-f2");
        let mut options = fast_options(DispenseScenario::Normal);
        options.frame_journal_path = Some(journal_path.clone());
        options.f2_release_file = Some(release_f2_path.clone());
        let handle = tokio::spawn(async move {
            let mut master_reader = master_reader;
            run_lower_controller_simulator_with_halves(
                &mut master_reader,
                master_writer,
                options,
                control_rx,
                std::future::pending(),
            )
            .await
        });
        sleep(Duration::from_millis(50)).await;

        let adapter = SerialHardwareAdapter::new(slave_path.to_string_lossy().to_string());
        let mut dispense = Box::pin(adapter.dispense(DispenseCommandPayload {
            command_no: "CMD-SIM-PTY".to_string(),
            order_no: "ORD-SIM-PTY".to_string(),
            slot: SlotPayload {
                layer_no: 2,
                cell_no: 5,
                slot_code: "R2C5".to_string(),
            },
            quantity: 1,
            timeout_seconds: 2,
        }));
        assert!(
            timeout(Duration::from_millis(250), &mut dispense).await.is_err(),
            "dispense must remain pending at the F1 boundary"
        );
        std::fs::write(&release_f2_path, b"release\n").expect("release F2");
        let result = timeout(
            Duration::from_secs(5),
            &mut dispense,
        )
        .await
        .expect("adapter timeout");

        assert!(result.success, "{result:?}");
        sleep(Duration::from_millis(50)).await;
        let journal = std::fs::read_to_string(&journal_path).expect("read raw serial journal");
        let vend = journal.find("\"direction\":\"daemon-to-controller\",\"parsedOpcode\":\"VEND\"").expect("outbound VEND record");
        let f0 = journal.find("\"direction\":\"controller-to-daemon\",\"parsedOpcode\":\"F0\"").expect("inbound F0 record");
        let f1 = journal.find("\"direction\":\"controller-to-daemon\",\"parsedOpcode\":\"F1\"").expect("inbound F1 record");
        let f2 = journal.find("\"direction\":\"controller-to-daemon\",\"parsedOpcode\":\"F2\"").expect("inbound F2 record");
        assert!(vend < f0 && f0 < f1 && f1 < f2, "raw protocol evidence must be ordered: {journal}");
        control_tx.send(ControlCommand::Quit).expect("quit");
        handle.await.expect("join").expect("sim exits cleanly");
        drop(slave_guard);
        std::fs::remove_dir_all(evidence_root).expect("remove evidence root");
    }

    #[tokio::test]
    async fn serial_adapter_can_dispense_through_tcp_simulator_with_persistent_state() {
        let (port_path, state, shutdown_tx, handle) =
            start_tcp_test_simulator(DispenseScenario::Normal).await;
        let adapter = SerialHardwareAdapter::new(port_path);

        let result = timeout(
            Duration::from_secs(5),
            adapter.dispense(DispenseCommandPayload {
                command_no: "CMD-SIM-TCP".to_string(),
                order_no: "ORD-SIM-TCP".to_string(),
                slot: SlotPayload {
                    layer_no: 2,
                    cell_no: 5,
                    slot_code: "R2C5".to_string(),
                },
                quantity: 1,
                timeout_seconds: 2,
            }),
        )
        .await
        .expect("adapter timeout");
        assert!(result.success, "{result:?}");

        state
            .apply_control_command(ControlCommand::MechanicalFault)
            .await;
        let status = timeout(Duration::from_secs(5), adapter.self_check())
            .await
            .expect("self-check timeout");
        assert!(!status.online, "{status:?}");
        assert!(status.message.contains("mechanical fault"), "{status:?}");

        state.apply_control_command(ControlCommand::Reset).await;
        let status = timeout(Duration::from_secs(5), adapter.self_check())
            .await
            .expect("self-check timeout");
        assert!(status.online, "{status:?}");

        shutdown_tx.send(true).expect("shutdown tcp simulator");
        handle.await.expect("join").expect("tcp listener exits");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn simulator_pty_responds_to_direct_slave_status_query() {
        let TestPty {
            slave_path,
            master_reader,
            master_writer,
            slave_guard,
        } = open_test_pty();
        let (control_tx, control_rx) = mpsc::unbounded_channel();
        let options = fast_options(DispenseScenario::Normal);
        let handle = tokio::spawn(async move {
            let mut master_reader = master_reader;
            run_lower_controller_simulator_with_halves(
                &mut master_reader,
                master_writer,
                options,
                control_rx,
                std::future::pending(),
            )
            .await
        });
        sleep(Duration::from_millis(50)).await;

        let mut slave = tokio::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&slave_path)
            .await
            .expect("open slave");
        slave
            .write_all(&build_status_query_frame())
            .await
            .expect("write status query");
        slave.flush().await.expect("flush status query");
        assert_eq!(
            read_until_code(&mut slave, 0xAA).await,
            LowerFrame::IdleHeartbeat
        );

        control_tx.send(ControlCommand::Quit).expect("quit");
        handle.await.expect("join").expect("sim exits cleanly");
        drop(slave_guard);
    }

    #[cfg(unix)]
    struct TestPty {
        slave_path: std::path::PathBuf,
        master_reader: tokio::fs::File,
        master_writer: tokio::fs::File,
        slave_guard: std::fs::File,
    }

    #[cfg(unix)]
    fn open_test_pty() -> TestPty {
        use std::os::fd::{FromRawFd, IntoRawFd};

        use nix::{
            fcntl::OFlag,
            pty::{grantpt, posix_openpt, ptsname_r, unlockpt},
            sys::termios::{cfmakeraw, tcgetattr, tcsetattr, SetArg},
        };

        let master = posix_openpt(OFlag::O_RDWR | OFlag::O_NOCTTY).expect("posix_openpt");
        grantpt(&master).expect("grantpt");
        unlockpt(&master).expect("unlockpt");
        let slave_path = std::path::PathBuf::from(ptsname_r(&master).expect("ptsname"));
        let slave_guard = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&slave_path)
            .expect("open pty slave");
        let mut termios = tcgetattr(&slave_guard).expect("tcgetattr pty slave");
        cfmakeraw(&mut termios);
        tcsetattr(&slave_guard, SetArg::TCSANOW, &termios).expect("set pty slave raw");
        let fd = master.into_raw_fd();
        // SAFETY: fd is freshly taken from `master` and handed to `File` exactly once.
        let master = unsafe { std::fs::File::from_raw_fd(fd) };
        let master_writer = master.try_clone().expect("clone pty master");
        TestPty {
            slave_path,
            master_reader: tokio::fs::File::from_std(master),
            master_writer: tokio::fs::File::from_std(master_writer),
            slave_guard,
        }
    }
}

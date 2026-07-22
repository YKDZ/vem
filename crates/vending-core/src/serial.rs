use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serialport::{SerialPortInfo, SerialPortType};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::TcpStream,
    sync::Mutex,
    time::{sleep, timeout, Duration as TokioDuration, Instant},
};
use tokio_serial::{DataBits, FlowControl, Parity, SerialPortBuilderExt, StopBits};

use crate::hardware::{
    DispenseCommandPayload, DispenseProgressEvent, DispenseProgressObserver, DispenseProgressStage,
    DispenseResultPayload, HardwareAdapter, HardwareStatus, LowerControllerFault,
};

pub const FRAME_HEAD: u8 = 0x55;
pub const DEBUG_DISPENSE_FAULT_FRAME: [u8; 4] = [FRAME_HEAD, 0xFF, 0xFF, 0xFF];
const HANDSHAKE: [u8; 2] = build_status_query_frame();
const SERIAL_BAUD_RATE: u32 = 115_200;
const COMMAND_ACK_TIMEOUT: TokioDuration = TokioDuration::from_millis(200);
const ENVIRONMENT_COMMAND_TIMEOUT: TokioDuration = TokioDuration::from_millis(200);
const STATUS_QUERY_TIMEOUT: TokioDuration = TokioDuration::from_millis(200);
/// 连续 2s 未收到下位机心跳后，再主动发送状态查询帧（来自通信文档第 6.5 节）。
const HEARTBEAT_LISTEN_TIMEOUT: TokioDuration = TokioDuration::from_secs(2);
const DISPENSE_COMPLETION_GRACE: TokioDuration = TokioDuration::from_secs(10);
/// 收到 Busy 回复后，下次重发出货指令前需等待的最小间隔
const BUSY_RETRY_DELAY: TokioDuration = TokioDuration::from_millis(100);
const COMMAND_ATTEMPTS: usize = 3;
const SERIAL_OPEN_ATTEMPTS: usize = 6;
const SERIAL_OPEN_RETRY_DELAY: TokioDuration = TokioDuration::from_millis(100);
const SERIAL_PROTOCOL_LOG_MAX_BYTES: u64 = 2 * 1024 * 1024;
static SERIAL_OPERATION_LOCK: Mutex<()> = Mutex::const_new(());

pub async fn acquire_serial_operation_guard() -> tokio::sync::MutexGuard<'static, ()> {
    SERIAL_OPERATION_LOCK.lock().await
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortUsbIdentity {
    pub vendor_id: String,
    pub product_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub serial_number: Option<String>,
}

impl SerialPortUsbIdentity {
    fn from_usb_port(info: &serialport::UsbPortInfo) -> Self {
        Self {
            vendor_id: format!("{:04X}", info.vid),
            product_id: format!("{:04X}", info.pid),
            serial_number: info.serial_number.clone().and_then(|value| {
                let value = value.trim().to_string();
                if value.is_empty() {
                    None
                } else {
                    Some(value)
                }
            }),
        }
    }

    fn matches_config(&self, config: &SerialPortUsbIdentity) -> bool {
        if !self.vendor_id.eq_ignore_ascii_case(&config.vendor_id)
            || !self.product_id.eq_ignore_ascii_case(&config.product_id)
        {
            return false;
        }
        match config.serial_number.as_deref() {
            Some(expected) => self.serial_number.as_deref() == Some(expected),
            None => true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LowerControllerDiscoveryCandidate {
    pub port_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usb_identity: Option<SerialPortUsbIdentity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handshake: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SerialResolutionSource {
    UsbIdentity,
    ManualPort,
    ManualPortFallback,
}

impl SerialResolutionSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::UsbIdentity => "usb_identity",
            Self::ManualPort => "manual_port",
            Self::ManualPortFallback => "manual_port_fallback",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedSerialPort {
    port_path: String,
    source: SerialResolutionSource,
    frame: LowerFrame,
    usb_identity: Option<SerialPortUsbIdentity>,
    candidates: Vec<LowerControllerDiscoveryCandidate>,
}

struct OpenResolvedSerialPort {
    resolved: ResolvedSerialPort,
    port: LowerControllerStream,
}

trait LowerControllerIo: AsyncRead + AsyncWrite + Unpin + Send {}

impl<T> LowerControllerIo for T where T: AsyncRead + AsyncWrite + Unpin + Send {}

type LowerControllerStream = Box<dyn LowerControllerIo>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
struct SerialProtocolLogEntry {
    ts: String,
    operation: String,
    direction: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    port_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    command_no: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    order_no: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    row_no: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cell_no: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    quantity: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    attempt: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    frame_hex: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    frame: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

impl SerialProtocolLogEntry {
    fn new(operation: impl Into<String>, direction: impl Into<String>) -> Self {
        Self {
            ts: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            operation: operation.into(),
            direction: direction.into(),
            ..Self::default()
        }
    }

    fn for_dispense(command: &DispenseCommandPayload, port_path: String) -> Self {
        Self {
            port_path: Some(port_path),
            command_no: Some(command.command_no.clone()),
            order_no: Some(command.order_no.clone()),
            row_no: Some(command.slot.row_no),
            cell_no: Some(command.slot.cell_no),
            quantity: Some(command.quantity),
            ..Self::new("dispense", "event")
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SerialResolutionError {
    message: String,
    candidates: Vec<LowerControllerDiscoveryCandidate>,
}

impl SerialResolutionError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            candidates: vec![],
        }
    }

    fn with_candidates(
        message: impl Into<String>,
        candidates: Vec<LowerControllerDiscoveryCandidate>,
    ) -> Self {
        Self {
            message: message.into(),
            candidates,
        }
    }
}

pub fn lower_controller_candidates_from_ports(
    identity: &SerialPortUsbIdentity,
    ports: &[SerialPortInfo],
) -> Vec<LowerControllerDiscoveryCandidate> {
    ports
        .iter()
        .filter_map(|port| {
            let usb_identity = match &port.port_type {
                SerialPortType::UsbPort(info) => SerialPortUsbIdentity::from_usb_port(info),
                _ => return None,
            };
            if !usb_identity.matches_config(identity) {
                return None;
            }
            Some(LowerControllerDiscoveryCandidate {
                port_path: port.port_name.clone(),
                usb_identity: Some(usb_identity),
                handshake: None,
            })
        })
        .collect()
}

fn available_lower_controller_candidates(
    identity: &SerialPortUsbIdentity,
) -> Result<Vec<LowerControllerDiscoveryCandidate>, SerialResolutionError> {
    let ports = serialport::available_ports().map_err(|error| {
        SerialResolutionError::new(format!("list serial ports failed: {error}"))
    })?;
    Ok(lower_controller_candidates_from_ports(identity, &ports))
}

/// Find the first available serial port path whose USB identity matches `identity`.
/// Returns `None` if no matching port is found or if listing ports fails.
pub fn find_port_path_by_usb_identity(identity: &SerialPortUsbIdentity) -> Option<String> {
    let ports = serialport::available_ports().ok()?;
    ports.into_iter().find_map(|port| {
        let usb_identity = match &port.port_type {
            SerialPortType::UsbPort(info) => SerialPortUsbIdentity::from_usb_port(info),
            _ => return None,
        };
        if usb_identity.matches_config(identity) {
            Some(port.port_name)
        } else {
            None
        }
    })
}

fn usb_identity_for_port_path(port_path: &str) -> Option<SerialPortUsbIdentity> {
    let ports = serialport::available_ports().ok()?;
    ports.into_iter().find_map(|port| {
        if port.port_name != port_path {
            return None;
        }
        match port.port_type {
            SerialPortType::UsbPort(info) => Some(SerialPortUsbIdentity::from_usb_port(&info)),
            _ => None,
        }
    })
}

async fn open_serial_port_path(port_path: &str) -> Result<LowerControllerStream, String> {
    if let Some(address) = tcp_debug_transport_address(port_path) {
        let stream = TcpStream::connect(address).await.map_err(|error| {
            format!("connect lower controller tcp transport {address} failed: {error}")
        })?;
        stream
            .set_nodelay(true)
            .map_err(|error| format!("configure lower controller tcp transport failed: {error}"))?;
        return Ok(Box::new(stream));
    }

    tokio_serial::new(port_path, SERIAL_BAUD_RATE)
        .data_bits(DataBits::Eight)
        .parity(Parity::None)
        .stop_bits(StopBits::One)
        .flow_control(FlowControl::None)
        .open_native_async()
        .map(|stream| Box::new(stream) as LowerControllerStream)
        .map_err(|error| format!("open serial port {port_path} failed: {error}"))
}

fn is_transient_serial_open_denied(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("access is denied")
        || normalized.contains("permission denied")
        || normalized.contains("os error 5")
        || error.contains("拒绝访问")
}

async fn open_serial_port_path_with_retry(
    port_path: &str,
) -> Result<LowerControllerStream, String> {
    for attempt in 1..=SERIAL_OPEN_ATTEMPTS {
        match open_serial_port_path(port_path).await {
            Ok(port) => return Ok(port),
            Err(error)
                if attempt < SERIAL_OPEN_ATTEMPTS && is_transient_serial_open_denied(&error) =>
            {
                sleep(SERIAL_OPEN_RETRY_DELAY).await;
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!("serial open retry loop always returns")
}

fn tcp_debug_transport_address(port_path: &str) -> Option<&str> {
    port_path
        .strip_prefix("tcp://")
        .filter(|address| !address.trim().is_empty())
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(" ")
}

fn rotated_protocol_log_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("serial-protocol.jsonl");
    path.with_file_name(format!("{file_name}.1"))
}

async fn rotate_protocol_log_if_needed(path: &Path) -> Result<(), String> {
    let metadata = match tokio::fs::metadata(path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("read serial protocol log metadata failed: {error}")),
    };
    if metadata.len() < SERIAL_PROTOCOL_LOG_MAX_BYTES {
        return Ok(());
    }
    let rotated = rotated_protocol_log_path(path);
    match tokio::fs::remove_file(&rotated).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "remove rotated serial protocol log failed: {error}"
            ))
        }
    }
    tokio::fs::rename(path, rotated)
        .await
        .map_err(|error| format!("rotate serial protocol log failed: {error}"))?;
    Ok(())
}

async fn append_protocol_log(path: &Path, entry: &SerialProtocolLogEntry) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("create serial protocol log directory failed: {error}"))?;
    }
    rotate_protocol_log_if_needed(path).await?;
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await
        .map_err(|error| format!("open serial protocol log failed: {error}"))?;
    let line = serde_json::to_string(entry)
        .map_err(|error| format!("serialize serial protocol log failed: {error}"))?;
    let mut payload = line.into_bytes();
    payload.push(b'\n');
    tokio::io::AsyncWriteExt::write_all(&mut file, &payload)
        .await
        .map_err(|error| format!("write serial protocol log failed: {error}"))?;
    Ok(())
}

pub struct SerialHardwareAdapter {
    port_path: Option<String>,
    usb_identity: Option<SerialPortUsbIdentity>,
    protocol_log_path: Option<PathBuf>,
    op_lock: Mutex<()>,
    debug_inject_next_dispense_fault: AtomicBool,
}

impl SerialHardwareAdapter {
    pub fn new(port_path: String) -> Self {
        Self::new_resolving(Some(port_path), None)
    }

    pub fn new_resolving(
        port_path: Option<String>,
        usb_identity: Option<SerialPortUsbIdentity>,
    ) -> Self {
        Self::new_resolving_with_protocol_log(port_path, usb_identity, None)
    }

    pub fn new_resolving_with_protocol_log(
        port_path: Option<String>,
        usb_identity: Option<SerialPortUsbIdentity>,
        protocol_log_path: Option<PathBuf>,
    ) -> Self {
        Self {
            port_path,
            usb_identity,
            protocol_log_path,
            op_lock: Mutex::new(()),
            debug_inject_next_dispense_fault: AtomicBool::new(false),
        }
    }

    async fn log_protocol(&self, entry: SerialProtocolLogEntry) {
        let Some(path) = &self.protocol_log_path else {
            return;
        };
        if let Err(error) = append_protocol_log(path, &entry).await {
            eprintln!("append serial protocol log failed: {error}");
        }
    }

    async fn log_frame(
        &self,
        mut entry: SerialProtocolLogEntry,
        direction: &str,
        bytes: &[u8],
        frame: Option<&str>,
    ) {
        entry.ts = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        entry.direction = direction.to_string();
        entry.frame_hex = Some(bytes_to_hex(bytes));
        entry.frame = frame.map(str::to_string);
        self.log_protocol(entry).await;
    }

    async fn log_message(
        &self,
        mut entry: SerialProtocolLogEntry,
        direction: &str,
        result: Option<&str>,
        message: Option<String>,
    ) {
        entry.ts = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        entry.direction = direction.to_string();
        entry.result = result.map(str::to_string);
        entry.message = message;
        self.log_protocol(entry).await;
    }

    async fn read_lower_frame_logged<R>(
        &self,
        reader: &mut R,
        read_timeout: Duration,
        entry: SerialProtocolLogEntry,
    ) -> Result<LowerFrame, String>
    where
        R: AsyncRead + Unpin,
    {
        match read_lower_frame(reader, read_timeout).await {
            Ok(frame) => {
                let bytes = frame.protocol_bytes();
                self.log_frame(entry, "rx", &bytes, Some(frame.describe()))
                    .await;
                Ok(frame)
            }
            Err(error) => {
                self.log_message(entry, "error", Some("read_failed"), Some(error.clone()))
                    .await;
                Err(error)
            }
        }
    }

    async fn resolve_serial_port_locked(
        &self,
    ) -> Result<ResolvedSerialPort, SerialResolutionError> {
        if let Some(identity) = &self.usb_identity {
            match discover_lower_controller_port(identity).await {
                Ok(resolved) => return Ok(resolved),
                Err(auto_error) => {
                    if let Some(port_path) = self.port_path.as_deref() {
                        let already_probed_manual_port = auto_error
                            .candidates
                            .iter()
                            .any(|candidate| candidate.port_path.eq_ignore_ascii_case(port_path));
                        if already_probed_manual_port {
                            return Err(auto_error);
                        }
                        return probe_manual_port(
                            port_path,
                            SerialResolutionSource::ManualPortFallback,
                            Some(auto_error.candidates),
                        )
                        .await;
                    }
                    return Err(auto_error);
                }
            }
        }

        if let Some(port_path) = self.port_path.as_deref() {
            return probe_manual_port(port_path, SerialResolutionSource::ManualPort, None).await;
        }

        Err(SerialResolutionError::new(
            "serial hardware requires lowerControllerUsbIdentity or serialPortPath",
        ))
    }

    async fn open_resolved_serial_port_locked(
        &self,
    ) -> Result<OpenResolvedSerialPort, SerialResolutionError> {
        if let Some(identity) = &self.usb_identity {
            match discover_lower_controller_port_open(identity).await {
                Ok(resolved) => return Ok(resolved),
                Err(auto_error) => {
                    if let Some(port_path) = self.port_path.as_deref() {
                        let already_probed_manual_port = auto_error
                            .candidates
                            .iter()
                            .any(|candidate| candidate.port_path.eq_ignore_ascii_case(port_path));
                        if already_probed_manual_port {
                            return Err(auto_error);
                        }
                        return probe_manual_port_open(
                            port_path,
                            SerialResolutionSource::ManualPortFallback,
                            Some(auto_error.candidates),
                        )
                        .await;
                    }
                    return Err(auto_error);
                }
            }
        }

        if let Some(port_path) = self.port_path.as_deref() {
            return probe_manual_port_open(port_path, SerialResolutionSource::ManualPort, None)
                .await;
        }

        Err(SerialResolutionError::new(
            "serial hardware requires lowerControllerUsbIdentity or serialPortPath",
        ))
    }

    async fn open_operational_port_locked(&self) -> Result<OpenResolvedSerialPort, String> {
        let OpenResolvedSerialPort { resolved, port } = self
            .open_resolved_serial_port_locked()
            .await
            .map_err(|error| error.message)?;
        if !resolved.frame.is_heartbeat() {
            return Err(format!(
                "lower controller is not available for commands: {}",
                resolved.frame.describe()
            ));
        }
        Ok(OpenResolvedSerialPort { resolved, port })
    }

    pub async fn query_environment_sample(&self) -> Result<Option<EnvironmentSample>, String> {
        let frame = build_environment_sample_query_frame();
        let _serial_guard = SERIAL_OPERATION_LOCK.lock().await;
        let _guard = self.op_lock.lock().await;
        let OpenResolvedSerialPort { resolved, mut port } =
            self.open_operational_port_locked().await?;
        let base_entry = SerialProtocolLogEntry {
            port_path: Some(resolved.port_path),
            ..SerialProtocolLogEntry::new("environment_query", "event")
        };
        port.write_all(&frame)
            .await
            .map_err(|error| format!("serial environment query write failed: {error}"))?;
        port.flush()
            .await
            .map_err(|error| format!("serial environment query flush failed: {error}"))?;
        self.log_frame(
            base_entry.clone(),
            "tx",
            &frame,
            Some("environment sample query"),
        )
        .await;

        match self
            .read_environment_command_response_logged(
                &mut port,
                ENVIRONMENT_COMMAND_TIMEOUT,
                base_entry,
                EnvironmentCommandResponseKind::Sample,
            )
            .await?
        {
            LowerFrame::EnvironmentSample(sample) => Ok(Some(sample)),
            frame if frame.is_fault() => Err(format!(
                "lower controller rejected environment query command: {}",
                frame.describe()
            )),
            frame => Err(format!(
                "unexpected frame while waiting for environment sample: {}",
                frame.describe()
            )),
        }
    }

    pub async fn set_target_temperature(&self, temperature_celsius: i8) -> Result<(), String> {
        let frame =
            build_air_conditioner_target_frame(AirConditionerMode::Cooling, temperature_celsius)?;
        let _serial_guard = SERIAL_OPERATION_LOCK.lock().await;
        let _guard = self.op_lock.lock().await;
        let OpenResolvedSerialPort { resolved, mut port } =
            self.open_operational_port_locked().await?;
        let base_entry = SerialProtocolLogEntry {
            port_path: Some(resolved.port_path),
            ..SerialProtocolLogEntry::new("set_target_temperature", "event")
        };
        port.write_all(&frame)
            .await
            .map_err(|error| format!("serial target temperature write failed: {error}"))?;
        port.flush()
            .await
            .map_err(|error| format!("serial target temperature flush failed: {error}"))?;
        self.log_frame(
            base_entry.clone(),
            "tx",
            &frame,
            Some("set target temperature"),
        )
        .await;

        match self
            .read_environment_command_response_logged(
                &mut port,
                ENVIRONMENT_COMMAND_TIMEOUT,
                base_entry,
                EnvironmentCommandResponseKind::AirConditionerTargetEcho,
            )
            .await?
        {
            LowerFrame::AirConditionerTargetEcho {
                mode: AirConditionerMode::Cooling,
                temperature_celsius: echoed,
            } if echoed == temperature_celsius => Ok(()),
            frame if frame.is_fault() => Err(format!(
                "lower controller rejected target temperature command: {}",
                frame.describe()
            )),
            frame => Err(format!(
                "unexpected frame while waiting for target temperature echo: {}",
                frame.describe()
            )),
        }
    }

    pub async fn set_air_conditioner_enabled(&self, enabled: bool) -> Result<(), String> {
        let frame = build_air_conditioner_switch_frame(enabled);
        let _serial_guard = SERIAL_OPERATION_LOCK.lock().await;
        let _guard = self.op_lock.lock().await;
        let OpenResolvedSerialPort { resolved, mut port } =
            self.open_operational_port_locked().await?;
        let base_entry = SerialProtocolLogEntry {
            port_path: Some(resolved.port_path),
            ..SerialProtocolLogEntry::new("set_air_conditioner", "event")
        };
        port.write_all(&frame)
            .await
            .map_err(|error| format!("serial air conditioner switch write failed: {error}"))?;
        port.flush()
            .await
            .map_err(|error| format!("serial air conditioner switch flush failed: {error}"))?;
        self.log_frame(
            base_entry.clone(),
            "tx",
            &frame,
            Some("set air conditioner switch"),
        )
        .await;

        match self
            .read_environment_command_response_logged(
                &mut port,
                ENVIRONMENT_COMMAND_TIMEOUT,
                base_entry,
                EnvironmentCommandResponseKind::AirConditionerSwitchEcho,
            )
            .await?
        {
            LowerFrame::AirConditionerSwitchEcho { state } if state.enabled() == enabled => Ok(()),
            frame if frame.is_fault() => Err(format!(
                "lower controller rejected air conditioner switch command: {}",
                frame.describe()
            )),
            frame => Err(format!(
                "unexpected frame while waiting for air conditioner switch echo: {}",
                frame.describe()
            )),
        }
    }

    pub async fn set_vent_speed(&self, speed: u8) -> Result<(), String> {
        let speed = VentSpeed::try_from(speed)?;
        let frame = build_vent_speed_frame(speed);
        let _serial_guard = SERIAL_OPERATION_LOCK.lock().await;
        let _guard = self.op_lock.lock().await;
        let OpenResolvedSerialPort { resolved, mut port } =
            self.open_operational_port_locked().await?;
        let base_entry = SerialProtocolLogEntry {
            port_path: Some(resolved.port_path),
            ..SerialProtocolLogEntry::new("set_vent_speed", "event")
        };
        port.write_all(&frame)
            .await
            .map_err(|error| format!("serial vent speed write failed: {error}"))?;
        port.flush()
            .await
            .map_err(|error| format!("serial vent speed flush failed: {error}"))?;
        self.log_frame(base_entry.clone(), "tx", &frame, Some("set vent speed"))
            .await;

        match self
            .read_environment_command_response_logged(
                &mut port,
                ENVIRONMENT_COMMAND_TIMEOUT,
                base_entry,
                EnvironmentCommandResponseKind::VentSpeedEcho,
            )
            .await?
        {
            LowerFrame::VentSpeedEcho { speed: echoed } if echoed == speed => Ok(()),
            frame if frame.is_fault() => Err(format!(
                "lower controller rejected vent speed command: {}",
                frame.describe()
            )),
            frame => Err(format!(
                "unexpected frame while waiting for vent speed echo: {}",
                frame.describe()
            )),
        }
    }

    async fn read_environment_command_response_logged<R>(
        &self,
        reader: &mut R,
        read_timeout: Duration,
        entry: SerialProtocolLogEntry,
        expected: EnvironmentCommandResponseKind,
    ) -> Result<LowerFrame, String>
    where
        R: AsyncRead + Unpin,
    {
        let deadline = Instant::now() + read_timeout;
        loop {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .ok_or_else(|| {
                    format!("serial read timeout waiting for {}", expected.describe())
                })?;
            let frame = self
                .read_lower_frame_logged(reader, remaining, entry.clone())
                .await?;
            if frame.is_heartbeat() {
                continue;
            }
            return Ok(frame);
        }
    }

    async fn handshake(&self) -> Result<ResolvedSerialPort, SerialResolutionError> {
        let _serial_guard = SERIAL_OPERATION_LOCK.lock().await;
        let _guard = self.op_lock.lock().await;
        self.resolve_serial_port_locked().await
    }

    async fn dispense_inner(
        &self,
        command: &DispenseCommandPayload,
        progress: Option<DispenseProgressObserver>,
    ) -> Result<(), DispenseFailure> {
        if command.quantity != 1 {
            return Err(DispenseFailure::unknown(
                "lower controller protocol v1 supports only single-item dispense commands",
            ));
        }
        let frame = build_dispense_frame(command.slot.row_no, command.slot.cell_no)
            .map(|frame| frame.to_vec())
            .map_err(DispenseFailure::unknown)?;
        let command_deadline = Instant::now()
            + TokioDuration::from_secs(command.timeout_seconds.max(1))
            + DISPENSE_COMPLETION_GRACE;

        let _serial_guard = SERIAL_OPERATION_LOCK.lock().await;
        let _guard = self.op_lock.lock().await;
        let OpenResolvedSerialPort { resolved, mut port } = self
            .open_operational_port_locked()
            .await
            .map_err(DispenseFailure::timeout)?;
        let base_entry = SerialProtocolLogEntry::for_dispense(command, resolved.port_path);
        let mut acknowledged = false;

        for attempt in 1..=COMMAND_ATTEMPTS {
            port.write_all(&frame).await.map_err(|error| {
                DispenseFailure::timeout(format!("serial command write failed: {error}"))
            })?;
            port.flush().await.map_err(|error| {
                DispenseFailure::timeout(format!("serial command flush failed: {error}"))
            })?;
            let mut tx_entry = base_entry.clone();
            tx_entry.attempt = Some(attempt);
            self.log_frame(tx_entry, "tx", &frame, Some("dispense command"))
                .await;

            match wait_for_ack(&mut port, self, &base_entry, attempt).await {
                Ok(()) => {
                    acknowledged = true;
                    break;
                }
                // ACK 可能丢失；先查状态，避免在下位机已开始出货时重发出货指令。
                Err(AckWaitError::Timeout) => {
                    match query_status_after_missing_ack(&mut port, self, &base_entry).await {
                        Ok(frame) if frame.indicates_command_in_progress() => {
                            self.log_message(
                                base_entry.clone(),
                                "event",
                                Some("ack_recovered_by_status"),
                                Some(format!(
                                    "missing ack recovered by lower controller status: {}",
                                    frame.describe()
                                )),
                            )
                            .await;
                            acknowledged = true;
                            break;
                        }
                        Ok(frame) => {
                            self.log_message(
                            base_entry.clone(),
                            "event",
                            Some("ack_timeout_status_retry"),
                            Some(format!(
                                "lower controller did not acknowledge command; status query returned {}",
                                frame.describe()
                            )),
                        )
                        .await;
                            continue;
                        }
                        Err(error) => {
                            self.log_message(
                            base_entry.clone(),
                            "event",
                            Some("ack_timeout_status_retry"),
                            Some(format!(
                                "lower controller did not acknowledge command; status query failed: {error}"
                            )),
                        )
                        .await;
                            continue;
                        }
                    }
                }
                // CRC 错误：通讯噪声导致，可立即重发
                Err(AckWaitError::CrcRetry) => continue,
                // 下位机繁忙：等待 100ms 后重发
                Err(AckWaitError::BusyRetry) => {
                    sleep(BUSY_RETRY_DELAY).await;
                    continue;
                }
                Err(AckWaitError::Failure(failure)) => return Err(failure),
            }
        }

        if !acknowledged {
            match query_status_after_missing_ack(&mut port, self, &base_entry).await {
                Ok(frame) if frame.indicates_command_in_progress() => {
                    self.log_message(
                        base_entry.clone(),
                        "event",
                        Some("ack_recovered_by_status"),
                        Some(format!(
                            "missing ack recovered by lower controller status: {}",
                            frame.describe()
                        )),
                    )
                    .await;
                }
                Ok(frame) => {
                    self.log_message(
                        base_entry.clone(),
                        "error",
                        Some("ack_timeout"),
                        Some(format!(
                            "lower controller did not acknowledge command after {COMMAND_ATTEMPTS} attempts; status query returned {}",
                            frame.describe()
                        )),
                    )
                    .await;
                    return Err(frame.to_failure().unwrap_or_else(|| {
                        DispenseFailure::timeout(format!(
                            "lower controller did not acknowledge command after {COMMAND_ATTEMPTS} attempts; status query returned {}",
                            frame.describe()
                        ))
                    }));
                }
                Err(error) => {
                    self.log_message(
                        base_entry.clone(),
                        "error",
                        Some("ack_timeout"),
                        Some(format!(
                            "lower controller did not acknowledge command after {COMMAND_ATTEMPTS} attempts; status query failed: {error}"
                        )),
                    )
                    .await;
                    return Err(DispenseFailure::timeout(format!(
                        "lower controller did not acknowledge command after {COMMAND_ATTEMPTS} attempts; status query failed: {error}"
                    )));
                }
            }
        }

        if self
            .debug_inject_next_dispense_fault
            .swap(false, Ordering::SeqCst)
        {
            port.write_all(&DEBUG_DISPENSE_FAULT_FRAME)
                .await
                .map_err(|error| {
                    DispenseFailure::timeout(format!(
                        "serial debug fault injection write failed: {error}"
                    ))
                })?;
            port.flush().await.map_err(|error| {
                DispenseFailure::timeout(format!(
                    "serial debug fault injection flush failed: {error}"
                ))
            })?;
            self.log_frame(
                base_entry.clone(),
                "tx",
                &DEBUG_DISPENSE_FAULT_FRAME,
                Some("debug dispense fault injection"),
            )
            .await;
        }

        wait_for_completion(
            &mut port,
            command,
            command_deadline,
            self,
            &base_entry,
            progress,
        )
        .await
    }
}

#[async_trait]
impl HardwareAdapter for SerialHardwareAdapter {
    fn adapter_name(&self) -> &str {
        "serial"
    }

    fn schedule_next_dispense_fault_injection(&self) -> Result<(), String> {
        self.debug_inject_next_dispense_fault
            .store(true, Ordering::SeqCst);
        Ok(())
    }

    async fn query_environment_sample(&self) -> Result<Option<EnvironmentSample>, String> {
        SerialHardwareAdapter::query_environment_sample(self).await
    }

    async fn set_target_temperature(&self, temperature_celsius: i8) -> Result<(), String> {
        SerialHardwareAdapter::set_target_temperature(self, temperature_celsius).await
    }

    async fn set_air_conditioner_enabled(&self, enabled: bool) -> Result<(), String> {
        SerialHardwareAdapter::set_air_conditioner_enabled(self, enabled).await
    }

    async fn set_vent_speed(&self, speed: u8) -> Result<(), String> {
        SerialHardwareAdapter::set_vent_speed(self, speed).await
    }

    async fn self_check(&self) -> HardwareStatus {
        match self.handshake().await {
            Ok(resolved) => {
                let online = resolved.frame.is_heartbeat();
                let bound_usb_identity =
                    if matches!(resolved.source, SerialResolutionSource::UsbIdentity)
                        && self
                            .usb_identity
                            .as_ref()
                            .is_some_and(|identity| identity.serial_number.is_none())
                        && resolved
                            .usb_identity
                            .as_ref()
                            .and_then(|identity| identity.serial_number.as_ref())
                            .is_some()
                    {
                        resolved.usb_identity.clone()
                    } else {
                        None
                    };
                HardwareStatus {
                    adapter: "serial".to_string(),
                    online,
                    message: format!(
                        "lower controller {} on {} ({})",
                        if online {
                            "ready"
                        } else {
                            "responded with fault"
                        },
                        resolved.port_path,
                        resolved.frame.describe()
                    ),
                    port_path: Some(resolved.port_path),
                    resolution_source: Some(resolved.source.as_str().to_string()),
                    bound_usb_identity,
                    candidates: resolved.candidates,
                    lower_controller_fault: match resolved.frame {
                        LowerFrame::MechanicalError => Some(LowerControllerFault::SharedMechanical),
                        LowerFrame::PickupPlatformBlocked => {
                            Some(LowerControllerFault::PickupPlatformBlocked)
                        }
                        _ => None,
                    },
                }
            }
            Err(error) => HardwareStatus {
                adapter: "serial".to_string(),
                online: false,
                message: error.message,
                port_path: None,
                resolution_source: Some("unresolved".to_string()),
                bound_usb_identity: None,
                candidates: error.candidates,
                lower_controller_fault: None,
            },
        }
    }

    async fn dispense(&self, command: DispenseCommandPayload) -> DispenseResultPayload {
        self.dispense_with_progress(command, None).await
    }

    async fn dispense_with_progress(
        &self,
        command: DispenseCommandPayload,
        progress: Option<DispenseProgressObserver>,
    ) -> DispenseResultPayload {
        let reported_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        match self.dispense_inner(&command, progress).await {
            Ok(()) => DispenseResultPayload {
                command_no: command.command_no,
                success: true,
                error_code: None,
                message: "serial: dispense completed".to_string(),
                reported_at,
                lower_controller_fault: None,
            },
            Err(failure) => DispenseResultPayload {
                command_no: command.command_no,
                success: false,
                error_code: Some(failure.error_code),
                message: failure.message,
                reported_at,
                lower_controller_fault: failure.lower_controller_fault,
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispenseFailure {
    pub error_code: String,
    pub message: String,
    pub lower_controller_fault: Option<LowerControllerFault>,
}

impl DispenseFailure {
    fn timeout(message: impl Into<String>) -> Self {
        Self {
            error_code: "MOTOR_TIMEOUT".to_string(),
            message: message.into(),
            lower_controller_fault: None,
        }
    }

    fn unknown(message: impl Into<String>) -> Self {
        Self {
            error_code: "UNKNOWN".to_string(),
            message: message.into(),
            lower_controller_fault: None,
        }
    }

    fn shared_mechanical(message: impl Into<String>) -> Self {
        Self {
            error_code: "JAMMED".to_string(),
            message: message.into(),
            lower_controller_fault: Some(LowerControllerFault::SharedMechanical),
        }
    }

    fn pickup_platform_blocked(message: impl Into<String>) -> Self {
        Self {
            error_code: "JAMMED".to_string(),
            message: message.into(),
            lower_controller_fault: Some(LowerControllerFault::PickupPlatformBlocked),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum AckWaitError {
    Timeout,
    /// CRC 校验失败——可立即重发出货指令
    CrcRetry,
    /// 下位机繁忙——需等待至少 100ms 后重发
    BusyRetry,
    Failure(DispenseFailure),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EnvironmentCommandResponseKind {
    Sample,
    AirConditionerTargetEcho,
    AirConditionerSwitchEcho,
    VentSpeedEcho,
}

impl EnvironmentCommandResponseKind {
    fn describe(self) -> &'static str {
        match self {
            Self::Sample => "environment sample",
            Self::AirConditionerTargetEcho => "air conditioner target echo",
            Self::AirConditionerSwitchEcho => "air conditioner switch echo",
            Self::VentSpeedEcho => "vent speed echo",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnvironmentSensorLocation {
    AirOutlet,
    External,
}

impl EnvironmentSensorLocation {
    pub const fn protocol_byte(self) -> u8 {
        match self {
            Self::AirOutlet => 0x01,
            Self::External => 0x02,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EnvironmentSample {
    pub temperature_celsius: i8,
    pub relative_humidity_percent: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AirConditionerMode {
    Cooling,
    Heating,
}

impl AirConditionerMode {
    pub const fn protocol_byte(self) -> u8 {
        match self {
            Self::Cooling => 0x00,
            Self::Heating => 0x01,
        }
    }

    fn from_protocol_byte(byte: u8) -> Result<Self, String> {
        match byte {
            0x00 => Ok(Self::Cooling),
            0x01 => Ok(Self::Heating),
            other => Err(format!(
                "air conditioner mode 0x{other:02X} out of protocol range 0x00/0x01"
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AirConditionerSwitchState {
    On,
    SoftOff,
    HardOff,
}

impl AirConditionerSwitchState {
    pub const fn protocol_byte(self) -> u8 {
        match self {
            Self::On => 0x00,
            Self::SoftOff => 0xAA,
            Self::HardOff => 0xFF,
        }
    }

    pub const fn enabled(self) -> bool {
        matches!(self, Self::On)
    }

    fn from_protocol_byte(byte: u8) -> Result<Self, String> {
        match byte {
            0x00 => Ok(Self::On),
            0xAA => Ok(Self::SoftOff),
            0xFF => Ok(Self::HardOff),
            other => Err(format!(
                "air conditioner switch state 0x{other:02X} out of protocol range 0x00/0xAA/0xFF"
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VentSpeed {
    Closed,
    Low,
    Medium,
    High,
    Full,
}

impl VentSpeed {
    pub const fn protocol_byte(self) -> u8 {
        match self {
            Self::Closed => 0x00,
            Self::Low => 0x01,
            Self::Medium => 0x02,
            Self::High => 0x03,
            Self::Full => 0x04,
        }
    }

    fn from_protocol_byte(byte: u8) -> Result<Self, String> {
        match byte {
            0x00 => Ok(Self::Closed),
            0x01 => Ok(Self::Low),
            0x02 => Ok(Self::Medium),
            0x03 => Ok(Self::High),
            0x04 => Ok(Self::Full),
            other => Err(format!(
                "vent speed 0x{other:02X} out of protocol range 0x00..0x04"
            )),
        }
    }
}

impl TryFrom<u8> for VentSpeed {
    type Error = String;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        Self::from_protocol_byte(value)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LowerFrame {
    Ack,
    BoundaryError,
    CrcError,
    MechanicalError,
    Busy,
    PickupTimeout,
    PickupPlatformBlocked,
    ArrivalAtOutlet,
    PickupCompleted,
    ResetCompletedFrame,
    IdleHeartbeat,
    DispensingHeartbeat,
    PickupHeartbeat,
    ResetHeartbeat,
    EnvironmentSample(EnvironmentSample),
    AirConditionerTargetEcho {
        mode: AirConditionerMode,
        temperature_celsius: i8,
    },
    AirConditionerSwitchEcho {
        state: AirConditionerSwitchState,
    },
    VentSpeedEcho {
        speed: VentSpeed,
    },
    Unknown(u8),
}

impl LowerFrame {
    pub fn from_code(code: u8) -> Self {
        match code {
            0x00 => Self::Ack,
            0xE1 => Self::BoundaryError,
            0xE2 => Self::CrcError,
            0xE3 => Self::MechanicalError,
            0xE4 => Self::Busy,
            0xE5 => Self::PickupTimeout,
            0xE6 => Self::PickupPlatformBlocked,
            0xF0 => Self::ArrivalAtOutlet,
            0xF1 => Self::PickupCompleted,
            0xF2 => Self::ResetCompletedFrame,
            0xAA => Self::IdleHeartbeat,
            0xAB => Self::DispensingHeartbeat,
            0xAC => Self::PickupHeartbeat,
            0xAF => Self::ResetHeartbeat,
            other => Self::Unknown(other),
        }
    }

    pub fn is_heartbeat(self) -> bool {
        matches!(
            self,
            Self::IdleHeartbeat
                | Self::DispensingHeartbeat
                | Self::PickupHeartbeat
                | Self::ResetHeartbeat
        )
    }

    pub fn is_fault(self) -> bool {
        matches!(
            self,
            Self::BoundaryError
                | Self::CrcError
                | Self::MechanicalError
                | Self::Busy
                | Self::PickupTimeout
                | Self::PickupPlatformBlocked
        )
    }

    pub fn is_lower_controller_status(self) -> bool {
        self.is_heartbeat() || matches!(self, Self::MechanicalError | Self::PickupPlatformBlocked)
    }

    pub fn indicates_command_in_progress(self) -> bool {
        matches!(
            self,
            Self::DispensingHeartbeat | Self::PickupHeartbeat | Self::ResetHeartbeat
        )
    }

    pub fn describe(self) -> &'static str {
        match self {
            Self::Ack => "acknowledged",
            Self::BoundaryError => "command boundary check failed",
            Self::CrcError => "crc check failed",
            Self::MechanicalError => "mechanical fault",
            Self::Busy => "controller busy",
            Self::PickupTimeout => "pickup timed out",
            Self::PickupPlatformBlocked => "pickup platform blocked",
            Self::ArrivalAtOutlet => "goods arrived at outlet",
            Self::PickupCompleted => "pickup completed and outlet closed",
            Self::ResetCompletedFrame => "dispense completed and reset to origin",
            Self::IdleHeartbeat => "idle heartbeat",
            Self::DispensingHeartbeat => "dispensing heartbeat",
            Self::PickupHeartbeat => "pickup heartbeat",
            Self::ResetHeartbeat => "resetting to origin",
            Self::EnvironmentSample(_) => "environment sample",
            Self::AirConditionerTargetEcho { .. } => "air conditioner target accepted",
            Self::AirConditionerSwitchEcho { .. } => "air conditioner switch accepted",
            Self::VentSpeedEcho { .. } => "vent speed accepted",
            Self::Unknown(_) => "unknown frame",
        }
    }

    pub fn protocol_bytes(self) -> Vec<u8> {
        match self {
            Self::Ack => vec![FRAME_HEAD, 0x00],
            Self::BoundaryError => vec![FRAME_HEAD, 0xE1],
            Self::CrcError => vec![FRAME_HEAD, 0xE2],
            Self::MechanicalError => vec![FRAME_HEAD, 0xE3],
            Self::Busy => vec![FRAME_HEAD, 0xE4],
            Self::PickupTimeout => vec![FRAME_HEAD, 0xE5],
            Self::PickupPlatformBlocked => vec![FRAME_HEAD, 0xE6],
            Self::ArrivalAtOutlet => vec![FRAME_HEAD, 0xF0],
            Self::PickupCompleted => vec![FRAME_HEAD, 0xF1],
            Self::ResetCompletedFrame => vec![FRAME_HEAD, 0xF2],
            Self::IdleHeartbeat => vec![FRAME_HEAD, 0xAA],
            Self::DispensingHeartbeat => vec![FRAME_HEAD, 0xAB],
            Self::PickupHeartbeat => vec![FRAME_HEAD, 0xAC],
            Self::ResetHeartbeat => vec![FRAME_HEAD, 0xAF],
            Self::EnvironmentSample(sample) => vec![
                FRAME_HEAD,
                0xB0,
                sample.temperature_celsius as u8,
                sample.relative_humidity_percent,
            ],
            Self::AirConditionerTargetEcho {
                mode,
                temperature_celsius,
            } => vec![
                FRAME_HEAD,
                0xB1,
                mode.protocol_byte(),
                temperature_celsius as u8,
            ],
            Self::AirConditionerSwitchEcho { state } => {
                vec![FRAME_HEAD, 0xB2, state.protocol_byte()]
            }
            Self::VentSpeedEcho { speed } => vec![FRAME_HEAD, 0xB3, speed.protocol_byte()],
            Self::Unknown(code) => vec![FRAME_HEAD, code],
        }
    }

    pub fn to_failure(self) -> Option<DispenseFailure> {
        match self {
            Self::BoundaryError => Some(DispenseFailure::unknown(
                "lower controller rejected command: boundary check failed",
            )),
            Self::CrcError => Some(DispenseFailure::unknown(
                "lower controller rejected command: crc check failed",
            )),
            Self::MechanicalError => Some(DispenseFailure::shared_mechanical(
                "lower controller reported mechanical fault during dispense",
            )),
            Self::Busy => Some(DispenseFailure::unknown(
                "lower controller rejected command: controller busy",
            )),
            Self::PickupTimeout => Some(DispenseFailure::timeout(
                "lower controller reported pickup timed out during dispense",
            )),
            Self::PickupPlatformBlocked => Some(DispenseFailure::pickup_platform_blocked(
                "lower controller reported pickup platform blocked",
            )),
            Self::Unknown(code) => Some(DispenseFailure::unknown(format!(
                "lower controller returned unknown frame code 0x{code:02X}"
            ))),
            _ => None,
        }
    }
}

pub fn crc8(data: &[u8]) -> u8 {
    let mut crc = 0x00u8;
    for byte in data {
        crc ^= *byte;
        for _ in 0..8 {
            if crc & 0x80 != 0 {
                crc = (crc << 1) ^ 0x07;
            } else {
                crc <<= 1;
            }
        }
    }
    crc
}

#[derive(Clone, Copy)]
struct SlotLayerBand {
    max_row_no: u32,
    max_cell_no: u32,
}

const SLOT_MIN_ROW_NO: u32 = 1;
const SLOT_LAYER_BANDS: [SlotLayerBand; 3] = [
    SlotLayerBand {
        max_row_no: 6,
        max_cell_no: 5,
    },
    SlotLayerBand {
        max_row_no: 8,
        max_cell_no: 4,
    },
    SlotLayerBand {
        max_row_no: 9,
        max_cell_no: 3,
    },
];
const SLOT_MAX_ROW_NO: u32 = SLOT_LAYER_BANDS[SLOT_LAYER_BANDS.len() - 1].max_row_no;

pub fn max_cell_no_for_layer(row_no: u32) -> Option<u32> {
    if row_no < SLOT_MIN_ROW_NO {
        return None;
    }
    SLOT_LAYER_BANDS
        .iter()
        .find(|band| row_no <= band.max_row_no)
        .map(|band| band.max_cell_no)
}

/// 校验货道号是否在硬件允许的范围内。
/// 行（row）1-9；格（cell）：行 1-6 为 1-5，行 7-8 为 1-4，行 9 为 1-3。
pub fn validate_slot_bounds(row_no: u32, cell_no: u32) -> Result<(), String> {
    let Some(max_cell) = max_cell_no_for_layer(row_no) else {
        return Err(format!(
            "rowNo {row_no} is out of hardware bounds ({SLOT_MIN_ROW_NO}-{SLOT_MAX_ROW_NO})"
        ));
    };
    if !(1..=max_cell).contains(&cell_no) {
        return Err(format!(
            "cellNo {cell_no} is out of hardware bounds for row {row_no} (1-{max_cell})"
        ));
    }
    Ok(())
}

pub const fn build_status_query_frame() -> [u8; 2] {
    [FRAME_HEAD, 0xA0]
}

pub const fn build_environment_sample_query_frame() -> [u8; 3] {
    build_environment_sample_query_frame_for(EnvironmentSensorLocation::External)
}

pub const fn build_environment_sample_query_frame_for(
    location: EnvironmentSensorLocation,
) -> [u8; 3] {
    [FRAME_HEAD, 0xB0, location.protocol_byte()]
}

pub const fn build_air_conditioner_target_query_frame() -> [u8; 2] {
    [FRAME_HEAD, 0xB1]
}

pub fn build_target_temperature_frame(temperature_celsius: i8) -> Result<[u8; 4], String> {
    build_air_conditioner_target_frame(AirConditionerMode::Cooling, temperature_celsius)
}

pub fn build_air_conditioner_target_frame(
    mode: AirConditionerMode,
    temperature_celsius: i8,
) -> Result<[u8; 4], String> {
    if !(18..=30).contains(&temperature_celsius) {
        return Err(format!(
            "target temperature {temperature_celsius} is out of protocol range 18..30 C"
        ));
    }
    Ok([
        FRAME_HEAD,
        0xB1,
        mode.protocol_byte(),
        temperature_celsius as u8,
    ])
}

pub const fn build_air_conditioner_switch_frame(enabled: bool) -> [u8; 3] {
    build_air_conditioner_switch_state_frame(if enabled {
        AirConditionerSwitchState::On
    } else {
        AirConditionerSwitchState::SoftOff
    })
}

pub const fn build_air_conditioner_switch_query_frame() -> [u8; 2] {
    [FRAME_HEAD, 0xB2]
}

pub const fn build_air_conditioner_switch_state_frame(state: AirConditionerSwitchState) -> [u8; 3] {
    [FRAME_HEAD, 0xB2, state.protocol_byte()]
}

pub const fn build_vent_speed_query_frame() -> [u8; 2] {
    [FRAME_HEAD, 0xB3]
}

pub const fn build_vent_speed_frame(speed: VentSpeed) -> [u8; 3] {
    [FRAME_HEAD, 0xB3, speed.protocol_byte()]
}

pub fn build_dispense_frame(row_no: u32, cell_no: u32) -> Result<[u8; 4], String> {
    let layer =
        u8::try_from(row_no).map_err(|_| format!("rowNo {row_no} exceeds uint8 protocol range"))?;
    let cell = u8::try_from(cell_no)
        .map_err(|_| format!("cellNo {cell_no} exceeds uint8 protocol range"))?;
    validate_slot_bounds(row_no, cell_no)?;
    let crc = crc8(&[layer, cell]);
    Ok([FRAME_HEAD, layer, cell, crc])
}

async fn probe_lower_controller_stream<S>(port: &mut S) -> Result<LowerFrame, String>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    match read_lower_controller_status(port, HEARTBEAT_LISTEN_TIMEOUT).await {
        Ok(frame) => Ok(frame),
        Err(listen_error) => {
            let mut last_error = listen_error;
            for _ in 0..COMMAND_ATTEMPTS {
                port.write_all(&HANDSHAKE)
                    .await
                    .map_err(|error| format!("serial status query write failed: {error}"))?;
                port.flush()
                    .await
                    .map_err(|error| format!("serial status query flush failed: {error}"))?;
                match read_lower_controller_status(port, STATUS_QUERY_TIMEOUT).await {
                    Ok(frame) => return Ok(frame),
                    Err(error) => last_error = error,
                }
            }
            Err(format!(
                "no heartbeat within 2s and status query failed after {COMMAND_ATTEMPTS} attempts: {last_error}"
            ))
        }
    }
}

async fn read_lower_controller_status<S>(
    port: &mut S,
    read_timeout: Duration,
) -> Result<LowerFrame, String>
where
    S: AsyncRead + Unpin,
{
    loop {
        let frame = read_lower_frame(port, read_timeout).await?;
        if frame.is_lower_controller_status() {
            return Ok(frame);
        }
    }
}

async fn probe_open_lower_controller_port(
    port_path: &str,
) -> Result<(LowerFrame, LowerControllerStream), String> {
    let mut port = open_serial_port_path_with_retry(port_path).await?;
    let frame = probe_lower_controller_stream(&mut port).await?;
    Ok((frame, port))
}

pub async fn probe_lower_controller_port(port_path: &str) -> Result<LowerFrame, String> {
    let (frame, _port) = probe_open_lower_controller_port(port_path).await?;
    Ok(frame)
}

async fn probe_manual_port(
    port_path: &str,
    source: SerialResolutionSource,
    previous_candidates: Option<Vec<LowerControllerDiscoveryCandidate>>,
) -> Result<ResolvedSerialPort, SerialResolutionError> {
    let usb_identity = usb_identity_for_port_path(port_path);
    match probe_lower_controller_port(port_path).await {
        Ok(frame) => Ok(ResolvedSerialPort {
            port_path: port_path.to_string(),
            source,
            frame,
            usb_identity,
            candidates: previous_candidates.unwrap_or_default(),
        }),
        Err(error) => Err(SerialResolutionError::with_candidates(
            format!("manual serial port {port_path} handshake failed: {error}"),
            previous_candidates.unwrap_or_default(),
        )),
    }
}

async fn probe_manual_port_open(
    port_path: &str,
    source: SerialResolutionSource,
    previous_candidates: Option<Vec<LowerControllerDiscoveryCandidate>>,
) -> Result<OpenResolvedSerialPort, SerialResolutionError> {
    let usb_identity = usb_identity_for_port_path(port_path);
    match probe_open_lower_controller_port(port_path).await {
        Ok((frame, port)) => Ok(OpenResolvedSerialPort {
            resolved: ResolvedSerialPort {
                port_path: port_path.to_string(),
                source,
                frame,
                usb_identity,
                candidates: previous_candidates.unwrap_or_default(),
            },
            port,
        }),
        Err(error) => Err(SerialResolutionError::with_candidates(
            format!("manual serial port {port_path} handshake failed: {error}"),
            previous_candidates.unwrap_or_default(),
        )),
    }
}

async fn discover_lower_controller_port(
    identity: &SerialPortUsbIdentity,
) -> Result<ResolvedSerialPort, SerialResolutionError> {
    let candidates = available_lower_controller_candidates(identity)?;
    if candidates.is_empty() {
        return Err(SerialResolutionError::new(format!(
            "no serial ports match lower controller USB identity {}:{}",
            identity.vendor_id, identity.product_id
        )));
    }

    let discovered_candidates = candidates.clone();
    let mut successes: Vec<(LowerControllerDiscoveryCandidate, LowerFrame)> = vec![];
    for candidate in candidates {
        if let Ok(frame) = probe_lower_controller_port(&candidate.port_path).await {
            let mut candidate = candidate;
            candidate.handshake = Some(frame.describe().to_string());
            successes.push((candidate, frame));
        }
    }

    match successes.len() {
        1 => {
            let (candidate, frame) = successes.remove(0);
            Ok(ResolvedSerialPort {
                port_path: candidate.port_path.clone(),
                source: SerialResolutionSource::UsbIdentity,
                frame,
                usb_identity: candidate.usb_identity.clone(),
                candidates: vec![candidate],
            })
        }
        0 => Err(SerialResolutionError::with_candidates(
            "no matching lower controller candidate responded to handshake",
            discovered_candidates,
        )),
        _ => {
            let candidates = successes
                .into_iter()
                .map(|(candidate, _)| candidate)
                .collect::<Vec<_>>();
            let ports = candidates
                .iter()
                .map(|candidate| candidate.port_path.clone())
                .collect::<Vec<_>>()
                .join(", ");
            Err(SerialResolutionError::with_candidates(
                format!("multiple lower controller candidates responded: {ports}"),
                candidates,
            ))
        }
    }
}

async fn discover_lower_controller_port_open(
    identity: &SerialPortUsbIdentity,
) -> Result<OpenResolvedSerialPort, SerialResolutionError> {
    let candidates = available_lower_controller_candidates(identity)?;
    if candidates.is_empty() {
        return Err(SerialResolutionError::new(format!(
            "no serial ports match lower controller USB identity {}:{}",
            identity.vendor_id, identity.product_id
        )));
    }

    let discovered_candidates = candidates.clone();
    let mut successes: Vec<LowerControllerDiscoveryCandidate> = vec![];
    let mut selected: Option<(
        LowerControllerDiscoveryCandidate,
        LowerFrame,
        LowerControllerStream,
    )> = None;
    for candidate in candidates {
        if let Ok((frame, port)) = probe_open_lower_controller_port(&candidate.port_path).await {
            let mut candidate = candidate;
            candidate.handshake = Some(frame.describe().to_string());
            successes.push(candidate.clone());
            if selected.is_none() {
                selected = Some((candidate, frame, port));
            }
        }
    }

    match successes.len() {
        1 => {
            let (candidate, frame, port) =
                selected.expect("single successful candidate should have open port");
            Ok(OpenResolvedSerialPort {
                resolved: ResolvedSerialPort {
                    port_path: candidate.port_path.clone(),
                    source: SerialResolutionSource::UsbIdentity,
                    frame,
                    usb_identity: candidate.usb_identity.clone(),
                    candidates: vec![candidate],
                },
                port,
            })
        }
        0 => Err(SerialResolutionError::with_candidates(
            "no matching lower controller candidate responded to handshake",
            discovered_candidates,
        )),
        _ => {
            let ports = successes
                .iter()
                .map(|candidate| candidate.port_path.clone())
                .collect::<Vec<_>>()
                .join(", ");
            Err(SerialResolutionError::with_candidates(
                format!("multiple lower controller candidates responded: {ports}"),
                successes,
            ))
        }
    }
}

async fn wait_for_ack<S>(
    port: &mut S,
    adapter: &SerialHardwareAdapter,
    base_entry: &SerialProtocolLogEntry,
    attempt: usize,
) -> Result<(), AckWaitError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let deadline = Instant::now() + COMMAND_ACK_TIMEOUT;
    loop {
        let now = Instant::now();
        if now >= deadline {
            let mut entry = base_entry.clone();
            entry.attempt = Some(attempt);
            adapter
                .log_message(
                    entry,
                    "error",
                    Some("ack_timeout"),
                    Some("serial read timeout while waiting for command ack".to_string()),
                )
                .await;
            return Err(AckWaitError::Timeout);
        }
        let remaining = deadline.saturating_duration_since(now);
        let mut entry = base_entry.clone();
        entry.attempt = Some(attempt);
        let frame = match adapter
            .read_lower_frame_logged(port, remaining, entry)
            .await
        {
            Ok(frame) => frame,
            Err(_) => return Err(AckWaitError::Timeout),
        };
        match frame {
            LowerFrame::Ack => return Ok(()),
            // CRC 错误：通讯噪声导致，可立即重发
            LowerFrame::CrcError => return Err(AckWaitError::CrcRetry),
            // 下位机繁忙：需退避 100ms 后重发
            LowerFrame::Busy => return Err(AckWaitError::BusyRetry),
            frame if frame.is_heartbeat() => continue,
            frame => {
                return Err(AckWaitError::Failure(frame.to_failure().unwrap_or_else(
                    || {
                        DispenseFailure::unknown(format!(
                            "unexpected frame while waiting for command ack: {}",
                            frame.describe()
                        ))
                    },
                )))
            }
        }
    }
}

async fn query_status_after_missing_ack<S>(
    port: &mut S,
    adapter: &SerialHardwareAdapter,
    base_entry: &SerialProtocolLogEntry,
) -> Result<LowerFrame, String>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut last_error = "status query not attempted".to_string();
    for attempt in 1..=COMMAND_ATTEMPTS {
        port.write_all(&HANDSHAKE)
            .await
            .map_err(|error| format!("serial status query write failed: {error}"))?;
        port.flush()
            .await
            .map_err(|error| format!("serial status query flush failed: {error}"))?;
        let mut tx_entry = base_entry.clone();
        tx_entry.operation = "dispense_ack_recovery".to_string();
        tx_entry.attempt = Some(attempt);
        adapter
            .log_frame(
                tx_entry,
                "tx",
                &HANDSHAKE,
                Some("status query after missing ack"),
            )
            .await;

        let mut rx_entry = base_entry.clone();
        rx_entry.operation = "dispense_ack_recovery".to_string();
        rx_entry.attempt = Some(attempt);
        match adapter
            .read_lower_frame_logged(port, STATUS_QUERY_TIMEOUT, rx_entry)
            .await
        {
            Ok(frame) if frame.is_lower_controller_status() => return Ok(frame),
            Ok(frame) => last_error = format!("unexpected frame {}", frame.describe()),
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}

/// 当心跳中断（2s 内无有效帧）时，主动向下位机发送状态查询。
/// 收到任意心跳/持续故障状态视为探测成功；200ms 无回应返回 Err。
async fn probe_handshake<S>(
    port: &mut S,
    adapter: &SerialHardwareAdapter,
    base_entry: &SerialProtocolLogEntry,
) -> Result<LowerFrame, ()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    port.write_all(&HANDSHAKE).await.map_err(|_| ())?;
    port.flush().await.map_err(|_| ())?;
    let mut tx_entry = base_entry.clone();
    tx_entry.operation = "dispense_probe".to_string();
    adapter
        .log_frame(tx_entry, "tx", &HANDSHAKE, Some("heartbeat probe"))
        .await;
    let mut rx_entry = base_entry.clone();
    rx_entry.operation = "dispense_probe".to_string();
    match adapter
        .read_lower_frame_logged(port, STATUS_QUERY_TIMEOUT, rx_entry)
        .await
    {
        Ok(frame) if frame.is_lower_controller_status() => Ok(frame),
        _ => Err(()),
    }
}

async fn wait_for_completion<S>(
    port: &mut S,
    command: &DispenseCommandPayload,
    command_deadline: Instant,
    adapter: &SerialHardwareAdapter,
    base_entry: &SerialProtocolLogEntry,
    progress: Option<DispenseProgressObserver>,
) -> Result<(), DispenseFailure>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut probe_failures: usize = 0;
    let mut outlet_opened_reported = false;
    let mut pickup_waiting_reported = false;
    let mut pickup_completed = false;
    let mut pickup_timeout_warnings: u8 = 0;
    loop {
        let now = Instant::now();
        if now >= command_deadline {
            adapter
                .log_message(
                    base_entry.clone(),
                    "error",
                    Some("completion_timeout"),
                    Some("dispense command timed out before completion frame".to_string()),
                )
                .await;
            return Err(DispenseFailure::timeout(
                "dispense command timed out before completion frame",
            ));
        }

        // 按文档监听心跳；连续 2s 无有效帧后才发送状态查询。
        let wait = HEARTBEAT_LISTEN_TIMEOUT.min(command_deadline.saturating_duration_since(now));
        let frame = match adapter
            .read_lower_frame_logged(port, wait, base_entry.clone())
            .await
        {
            Ok(frame) => {
                probe_failures = 0;
                frame
            }
            Err(_) => {
                if Instant::now() >= command_deadline {
                    adapter
                        .log_message(
                            base_entry.clone(),
                            "error",
                            Some("completion_timeout"),
                            Some("dispense command timed out before completion frame".to_string()),
                        )
                        .await;
                    return Err(DispenseFailure::timeout(
                        "dispense command timed out before completion frame",
                    ));
                }
                // 心跳中断——主动探测下位机
                match probe_handshake(port, adapter, base_entry).await {
                    Ok(_) => {
                        probe_failures = 0;
                        continue;
                    }
                    Err(()) => {
                        probe_failures += 1;
                        if probe_failures >= COMMAND_ATTEMPTS {
                            adapter
                                .log_message(
                                    base_entry.clone(),
                                    "error",
                                    Some("heartbeat_missing"),
                                    Some("lower controller heartbeat missing: no response after handshake probes".to_string()),
                                )
                                .await;
                            return Err(DispenseFailure::timeout(
                                "lower controller heartbeat missing: no response after handshake probes",
                            ));
                        }
                        continue;
                    }
                }
            }
        };

        match frame {
            LowerFrame::ResetCompletedFrame => {
                adapter
                    .log_message(
                        base_entry.clone(),
                        "event",
                        Some("completed"),
                        Some("dispense completed".to_string()),
                    )
                    .await;
                emit_dispense_progress(
                    &progress,
                    command,
                    DispenseProgressStage::ResetCompleted,
                    None,
                    "设备已复位完成",
                );
                return Ok(());
            }
            LowerFrame::PickupCompleted => {
                pickup_completed = true;
                adapter
                    .log_message(
                        base_entry.clone(),
                        "event",
                        Some("pickup_completed"),
                        Some("pickup completed and outlet closed".to_string()),
                    )
                    .await;
                emit_dispense_progress(
                    &progress,
                    command,
                    DispenseProgressStage::PickupCompleted,
                    None,
                    "用户已完成取货，设备正在复位",
                );
                continue;
            }
            LowerFrame::ArrivalAtOutlet => {
                if !outlet_opened_reported {
                    outlet_opened_reported = true;
                    emit_dispense_progress(
                        &progress,
                        command,
                        DispenseProgressStage::OutletOpened,
                        None,
                        "取货口已打开，请取走商品",
                    );
                }
                continue;
            }
            LowerFrame::PickupHeartbeat => {
                if !pickup_waiting_reported {
                    pickup_waiting_reported = true;
                    emit_dispense_progress(
                        &progress,
                        command,
                        DispenseProgressStage::PickupWaiting,
                        None,
                        "下位机正在等待用户取货",
                    );
                }
                continue;
            }
            LowerFrame::PickupTimeout => {
                if pickup_timeout_warnings >= 2 {
                    adapter
                        .log_message(
                            base_entry.clone(),
                            "event",
                            Some("pickup_timeout_warning_ignored"),
                            Some("duplicate pickup timeout warning ignored".to_string()),
                        )
                        .await;
                    continue;
                }
                pickup_timeout_warnings = pickup_timeout_warnings.saturating_add(1);
                let message = if pickup_timeout_warnings >= 2 {
                    "请立即取走商品，设备即将自动关闭取货口"
                } else {
                    "请尽快取走商品"
                };
                adapter
                    .log_message(
                        base_entry.clone(),
                        "event",
                        Some("pickup_timeout_warning"),
                        Some(message.to_string()),
                    )
                    .await;
                emit_dispense_progress(
                    &progress,
                    command,
                    DispenseProgressStage::PickupTimeoutWarning,
                    Some(pickup_timeout_warnings),
                    message,
                );
                continue;
            }
            LowerFrame::IdleHeartbeat if pickup_completed => {
                adapter
                    .log_message(
                        base_entry.clone(),
                        "event",
                        Some("completed_after_f2_loss"),
                        Some("controller returned idle after pickup completed".to_string()),
                    )
                    .await;
                emit_dispense_progress(
                    &progress,
                    command,
                    DispenseProgressStage::ResetCompleted,
                    None,
                    "设备已复位完成",
                );
                return Ok(());
            }
            LowerFrame::Ack
            | LowerFrame::IdleHeartbeat
            | LowerFrame::DispensingHeartbeat
            | LowerFrame::ResetHeartbeat => continue,
            frame => {
                return Err(frame.to_failure().unwrap_or_else(|| {
                    DispenseFailure::unknown(format!(
                        "unexpected frame while waiting for dispense completion: {}",
                        frame.describe()
                    ))
                }))
            }
        }
    }
}

fn emit_dispense_progress(
    progress: &Option<DispenseProgressObserver>,
    command: &DispenseCommandPayload,
    stage: DispenseProgressStage,
    warning_no: Option<u8>,
    message: &str,
) {
    let Some(progress) = progress else {
        return;
    };
    progress(DispenseProgressEvent {
        command_no: command.command_no.clone(),
        order_no: command.order_no.clone(),
        stage,
        warning_no,
        message: message.to_string(),
        reported_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    });
}

pub async fn read_lower_frame<R>(
    reader: &mut R,
    read_timeout: Duration,
) -> Result<LowerFrame, String>
where
    R: AsyncRead + Unpin,
{
    let deadline = Instant::now() + read_timeout;
    loop {
        let head = read_byte_before(reader, deadline).await?;
        if head != FRAME_HEAD {
            continue;
        }
        let code = read_byte_before(reader, deadline).await?;
        if code == 0xB0 {
            let temperature_byte = read_byte_before(reader, deadline).await?;
            let humidity = read_byte_before(reader, deadline).await?;
            let temperature_celsius = temperature_byte as i8;
            if !(-10..=100).contains(&temperature_celsius) {
                return Err(format!(
                    "environment sample temperature {temperature_celsius} out of protocol range -10..100 C"
                ));
            }
            if humidity > 100 {
                return Err(format!(
                    "environment sample humidity {humidity} out of protocol range 0..100 %RH"
                ));
            }
            return Ok(LowerFrame::EnvironmentSample(EnvironmentSample {
                temperature_celsius,
                relative_humidity_percent: humidity,
            }));
        }
        if code == 0xB1 {
            let mode =
                AirConditionerMode::from_protocol_byte(read_byte_before(reader, deadline).await?)?;
            let temperature_celsius = read_byte_before(reader, deadline).await? as i8;
            if !(18..=30).contains(&temperature_celsius) {
                return Err(format!(
                    "target temperature echo {temperature_celsius} out of protocol range 18..30 C"
                ));
            }
            return Ok(LowerFrame::AirConditionerTargetEcho {
                mode,
                temperature_celsius,
            });
        }
        if code == 0xB2 {
            let state = read_byte_before(reader, deadline).await?;
            return Ok(LowerFrame::AirConditionerSwitchEcho {
                state: AirConditionerSwitchState::from_protocol_byte(state)?,
            });
        }
        if code == 0xB3 {
            let speed = read_byte_before(reader, deadline).await?;
            return Ok(LowerFrame::VentSpeedEcho {
                speed: VentSpeed::from_protocol_byte(speed)?,
            });
        }
        return Ok(LowerFrame::from_code(code));
    }
}

async fn read_byte_before<R>(reader: &mut R, deadline: Instant) -> Result<u8, String>
where
    R: AsyncRead + Unpin,
{
    let now = Instant::now();
    if now >= deadline {
        return Err("serial read timeout".to_string());
    }
    let remaining = deadline.saturating_duration_since(now);
    let mut buf = [0u8; 1];
    match timeout(remaining, reader.read_exact(&mut buf)).await {
        Ok(Ok(_)) => Ok(buf[0]),
        Ok(Err(error)) => Err(format!("serial read failed: {error}")),
        Err(_) => Err("serial read timeout".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use tokio::io::duplex;

    use super::*;

    #[test]
    fn serial_open_retry_recognizes_windows_access_denied_errors() {
        assert!(is_transient_serial_open_denied(
            "open serial port COM4 failed: Access is denied. (os error 5)"
        ));
        assert!(is_transient_serial_open_denied(
            "open serial port COM4 failed: 拒绝访问。"
        ));
        assert!(!is_transient_serial_open_denied(
            "open serial port COM4 failed: The system cannot find the file specified."
        ));
    }

    #[test]
    fn crc8_matches_hardware_document_example() {
        assert_eq!(crc8(&[0x02, 0x05]), 0x31);
    }

    #[test]
    fn build_dispense_frame_uses_header_slot_and_crc() {
        assert_eq!(
            build_dispense_frame(2, 5).unwrap(),
            [0x55, 0x02, 0x05, 0x31]
        );
    }

    #[test]
    fn protocol_log_helpers_render_frames_as_hex() {
        assert_eq!(bytes_to_hex(&[0x55, 0x02, 0x05, 0x31]), "55 02 05 31");
        assert_eq!(LowerFrame::PickupCompleted.protocol_bytes(), [0x55, 0xF1]);
        assert_eq!(
            LowerFrame::ResetCompletedFrame.protocol_bytes(),
            [0x55, 0xF2]
        );
        assert_eq!(
            LowerFrame::EnvironmentSample(EnvironmentSample {
                temperature_celsius: -1,
                relative_humidity_percent: 55,
            })
            .protocol_bytes(),
            [0x55, 0xB0, 0xFF, 0x37]
        );
    }

    #[tokio::test]
    async fn probe_lower_controller_waits_for_heartbeat_before_status_query() {
        let (mut host, mut controller) = duplex(64);
        let probe = tokio::spawn(async move { probe_lower_controller_stream(&mut host).await });

        let mut unexpected = [0u8; 2];
        assert!(
            timeout(
                TokioDuration::from_millis(50),
                controller.read_exact(&mut unexpected)
            )
            .await
            .is_err(),
            "probe should not send 55 A0 while still waiting for heartbeat"
        );

        controller
            .write_all(&LowerFrame::IdleHeartbeat.protocol_bytes())
            .await
            .expect("write heartbeat");
        let frame = probe.await.expect("probe task").expect("probe frame");
        assert_eq!(frame, LowerFrame::IdleHeartbeat);
    }

    #[tokio::test]
    async fn missing_ack_status_query_can_recover_active_dispense_state() {
        let (mut host, mut controller) = duplex(64);
        let adapter = SerialHardwareAdapter::new("COM-TEST".to_string());
        let entry = SerialProtocolLogEntry::for_dispense(
            &DispenseCommandPayload {
                command_no: "CMD-1".to_string(),
                order_no: "ORD-1".to_string(),
                slot: crate::hardware::SlotPayload {
                    row_no: 1,
                    cell_no: 1,
                },
                quantity: 1,
                timeout_seconds: 30,
                recovery: None,
            },
            "COM-TEST".to_string(),
        );
        let query = tokio::spawn(async move {
            query_status_after_missing_ack(&mut host, &adapter, &entry).await
        });

        let mut sent = [0u8; 2];
        controller
            .read_exact(&mut sent)
            .await
            .expect("read status query");
        assert_eq!(sent, build_status_query_frame());
        controller
            .write_all(&LowerFrame::DispensingHeartbeat.protocol_bytes())
            .await
            .expect("write dispensing heartbeat");

        let frame = query.await.expect("query task").expect("status frame");
        assert_eq!(frame, LowerFrame::DispensingHeartbeat);
        assert!(frame.indicates_command_in_progress());
    }

    #[test]
    fn filters_lower_controller_candidates_by_usb_identity() {
        fn usb_port(name: &str, vid: u16, pid: u16, serial: Option<&str>) -> SerialPortInfo {
            SerialPortInfo {
                port_name: name.to_string(),
                port_type: SerialPortType::UsbPort(serialport::UsbPortInfo {
                    vid,
                    pid,
                    serial_number: serial.map(str::to_string),
                    manufacturer: None,
                    product: None,
                }),
            }
        }

        let ports = vec![
            usb_port("COM3", 0x1A86, 0x55D3, Some("5ABA102811")),
            usb_port("COM4", 0x1A86, 0x55D3, Some("OTHER")),
            usb_port("COM5", 0x1234, 0x55D3, Some("5ABA102811")),
        ];
        let identity = SerialPortUsbIdentity {
            vendor_id: "1a86".to_string(),
            product_id: "55d3".to_string(),
            serial_number: Some("5ABA102811".to_string()),
        };

        let candidates = lower_controller_candidates_from_ports(&identity, &ports);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].port_path, "COM3");
    }

    #[test]
    fn build_v1_environment_command_frames() {
        assert_eq!(build_status_query_frame(), [0x55, 0xA0]);
        assert_eq!(build_environment_sample_query_frame(), [0x55, 0xB0, 0x02]);
        assert_eq!(
            build_environment_sample_query_frame_for(EnvironmentSensorLocation::AirOutlet),
            [0x55, 0xB0, 0x01]
        );
        assert_eq!(
            build_target_temperature_frame(18).unwrap(),
            [0x55, 0xB1, 0x00, 18]
        );
        assert_eq!(
            build_air_conditioner_target_frame(AirConditionerMode::Heating, 30).unwrap(),
            [0x55, 0xB1, 0x01, 30]
        );
        assert!(build_target_temperature_frame(17).is_err());
        assert!(build_target_temperature_frame(31).is_err());
        assert_eq!(
            build_air_conditioner_switch_frame(false),
            [0x55, 0xB2, 0xAA]
        );
        assert_eq!(build_air_conditioner_switch_frame(true), [0x55, 0xB2, 0x00]);
        assert_eq!(
            build_air_conditioner_switch_state_frame(AirConditionerSwitchState::HardOff),
            [0x55, 0xB2, 0xFF]
        );
        assert_eq!(build_vent_speed_query_frame(), [0x55, 0xB3]);
        assert_eq!(
            build_vent_speed_frame(VentSpeed::Medium),
            [0x55, 0xB3, 0x02]
        );
    }

    #[test]
    fn build_dispense_frame_rejects_zero_or_out_of_range_values() {
        assert!(build_dispense_frame(0, 1).is_err());
        assert!(build_dispense_frame(1, 0).is_err());
        assert!(build_dispense_frame(256, 1).is_err());
        assert!(build_dispense_frame(1, 256).is_err());
    }

    #[test]
    fn lower_frame_maps_documented_v1_codes() {
        assert_eq!(LowerFrame::from_code(0x00), LowerFrame::Ack);
        assert_eq!(LowerFrame::from_code(0xF0), LowerFrame::ArrivalAtOutlet);
        assert_eq!(LowerFrame::from_code(0xF1), LowerFrame::PickupCompleted);
        assert_eq!(LowerFrame::from_code(0xF2), LowerFrame::ResetCompletedFrame);
        assert_eq!(LowerFrame::from_code(0xAA), LowerFrame::IdleHeartbeat);
        assert_eq!(LowerFrame::from_code(0xAB), LowerFrame::DispensingHeartbeat);
        assert_eq!(LowerFrame::from_code(0xAC), LowerFrame::PickupHeartbeat);
        assert_eq!(LowerFrame::from_code(0xAF), LowerFrame::ResetHeartbeat);
        assert_eq!(LowerFrame::from_code(0xE1), LowerFrame::BoundaryError);
        assert_eq!(LowerFrame::from_code(0xE2), LowerFrame::CrcError);
        assert_eq!(LowerFrame::from_code(0xE3), LowerFrame::MechanicalError);
        assert_eq!(LowerFrame::from_code(0xE4), LowerFrame::Busy);
        assert_eq!(LowerFrame::from_code(0xE5), LowerFrame::PickupTimeout);
        assert_eq!(
            LowerFrame::from_code(0xE6),
            LowerFrame::PickupPlatformBlocked
        );
    }

    #[test]
    fn explicit_protocol_faults_preserve_error_code_and_classification() {
        let mechanical = LowerFrame::MechanicalError
            .to_failure()
            .expect("mechanical failure");
        assert_eq!(mechanical.error_code, "JAMMED");
        assert_eq!(
            mechanical.lower_controller_fault,
            Some(LowerControllerFault::SharedMechanical)
        );

        let pickup = LowerFrame::PickupPlatformBlocked
            .to_failure()
            .expect("pickup platform failure");
        assert_eq!(pickup.error_code, "JAMMED");
        assert_eq!(
            pickup.lower_controller_fault,
            Some(LowerControllerFault::PickupPlatformBlocked)
        );
        assert_eq!(
            LowerFrame::PickupTimeout
                .to_failure()
                .expect("pickup timeout")
                .lower_controller_fault,
            None
        );
    }

    #[test]
    fn reset_heartbeat_is_a_heartbeat() {
        assert!(LowerFrame::IdleHeartbeat.is_heartbeat());
        assert!(LowerFrame::DispensingHeartbeat.is_heartbeat());
        assert!(LowerFrame::PickupHeartbeat.is_heartbeat());
        assert!(LowerFrame::ResetHeartbeat.is_heartbeat());
        assert!(!LowerFrame::MechanicalError.is_heartbeat());
    }

    #[test]
    fn validate_slot_bounds_rejects_out_of_range() {
        // 行超出 1-9
        assert!(validate_slot_bounds(0, 1).is_err());
        assert!(validate_slot_bounds(10, 1).is_err());
        // 行 1-6：格最大 5
        assert!(validate_slot_bounds(1, 5).is_ok());
        assert!(validate_slot_bounds(6, 5).is_ok());
        assert!(validate_slot_bounds(1, 6).is_err());
        // 行 7-8：格最大 4
        assert!(validate_slot_bounds(7, 4).is_ok());
        assert!(validate_slot_bounds(8, 4).is_ok());
        assert!(validate_slot_bounds(7, 5).is_err());
        // 行 9：格最大 3
        assert!(validate_slot_bounds(9, 3).is_ok());
        assert!(validate_slot_bounds(9, 4).is_err());
    }

    #[test]
    fn build_dispense_frame_respects_hardware_bounds() {
        // 有效货道
        assert!(build_dispense_frame(1, 5).is_ok());
        assert!(build_dispense_frame(6, 5).is_ok());
        assert!(build_dispense_frame(7, 4).is_ok());
        assert!(build_dispense_frame(8, 4).is_ok());
        assert!(build_dispense_frame(9, 3).is_ok());
        // 超出硬件范围
        assert!(build_dispense_frame(0, 1).is_err());
        assert!(build_dispense_frame(10, 1).is_err());
        assert!(build_dispense_frame(7, 5).is_err());
        assert!(build_dispense_frame(9, 4).is_err());
    }

    #[tokio::test]
    async fn read_lower_frame_skips_noise_before_frame_head() {
        let (mut tx, mut rx) = duplex(8);
        tokio::spawn(async move {
            tx.write_all(&[0x01, 0x02, FRAME_HEAD, 0x00])
                .await
                .expect("seed bytes");
        });
        let frame = read_lower_frame(&mut rx, Duration::from_millis(100))
            .await
            .expect("read frame");
        assert_eq!(frame, LowerFrame::Ack);
    }

    #[tokio::test]
    async fn read_lower_frame_parses_v1_environment_sample() {
        let (mut tx, mut rx) = duplex(8);
        tokio::spawn(async move {
            tx.write_all(&[FRAME_HEAD, 0xB0, 0xFE, 45])
                .await
                .expect("seed bytes");
        });
        let frame = read_lower_frame(&mut rx, Duration::from_millis(100))
            .await
            .expect("read frame");
        assert_eq!(
            frame,
            LowerFrame::EnvironmentSample(EnvironmentSample {
                temperature_celsius: -2,
                relative_humidity_percent: 45,
            })
        );
    }

    #[tokio::test]
    async fn read_lower_frame_rejects_out_of_range_environment_sample() {
        let (mut tx, mut rx) = duplex(16);
        tokio::spawn(async move {
            tx.write_all(&[FRAME_HEAD, 0xB0, 101, 53])
                .await
                .expect("seed high temperature");
            tx.write_all(&[FRAME_HEAD, 0xB0, 24, 101])
                .await
                .expect("seed high humidity");
        });

        let temperature_error = read_lower_frame(&mut rx, Duration::from_millis(100))
            .await
            .expect_err("high temperature should be rejected");
        assert!(
            temperature_error.contains("temperature"),
            "{temperature_error}"
        );

        let humidity_error = read_lower_frame(&mut rx, Duration::from_millis(100))
            .await
            .expect_err("high humidity should be rejected");
        assert!(humidity_error.contains("humidity"), "{humidity_error}");
    }

    #[tokio::test]
    async fn read_lower_frame_accepts_zero_environment_sample() {
        let (mut tx, mut rx) = duplex(8);
        tokio::spawn(async move {
            tx.write_all(&[FRAME_HEAD, 0xB0, 0x00, 0x00])
                .await
                .expect("seed bytes");
        });
        let frame = read_lower_frame(&mut rx, Duration::from_millis(100))
            .await
            .expect("read frame");
        assert_eq!(
            frame,
            LowerFrame::EnvironmentSample(EnvironmentSample {
                temperature_celsius: 0,
                relative_humidity_percent: 0,
            })
        );
    }

    #[tokio::test]
    async fn read_lower_frame_parses_v1_air_conditioner_target_echo() {
        let (mut tx, mut rx) = duplex(8);
        tokio::spawn(async move {
            tx.write_all(&[FRAME_HEAD, 0xB1, 0x01, 18])
                .await
                .expect("seed bytes");
        });
        let frame = read_lower_frame(&mut rx, Duration::from_millis(100))
            .await
            .expect("read frame");
        assert_eq!(
            frame,
            LowerFrame::AirConditionerTargetEcho {
                mode: AirConditionerMode::Heating,
                temperature_celsius: 18,
            }
        );
    }

    #[tokio::test]
    async fn read_lower_frame_parses_v1_air_conditioner_switch_echo() {
        let (mut tx, mut rx) = duplex(8);
        tokio::spawn(async move {
            tx.write_all(&[FRAME_HEAD, 0xB2, 0xFF])
                .await
                .expect("seed bytes");
        });
        let frame = read_lower_frame(&mut rx, Duration::from_millis(100))
            .await
            .expect("read frame");
        assert_eq!(
            frame,
            LowerFrame::AirConditionerSwitchEcho {
                state: AirConditionerSwitchState::HardOff,
            }
        );
    }

    #[tokio::test]
    async fn read_lower_frame_parses_v1_vent_speed_echo() {
        let (mut tx, mut rx) = duplex(8);
        tokio::spawn(async move {
            tx.write_all(&[FRAME_HEAD, 0xB3, 0x04])
                .await
                .expect("seed bytes");
        });
        let frame = read_lower_frame(&mut rx, Duration::from_millis(100))
            .await
            .expect("read frame");
        assert_eq!(
            frame,
            LowerFrame::VentSpeedEcho {
                speed: VentSpeed::Full,
            }
        );
    }
}

use async_trait::async_trait;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    sync::Mutex,
    time::{timeout, Duration, Instant},
};
use tokio_serial::{DataBits, FlowControl, Parity, SerialPortBuilderExt, SerialStream, StopBits};

use crate::hardware::{
    DispenseCommandPayload, DispenseResultPayload, HardwareAdapter, HardwareStatus,
};

const FRAME_HEAD: u8 = 0x55;
const HANDSHAKE: [u8; 2] = [FRAME_HEAD, 0x10];
const SERIAL_BAUD_RATE: u32 = 115_200;
const COMMAND_ACK_TIMEOUT: Duration = Duration::from_millis(100);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_millis(1_000);
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(3);
const COMMAND_ATTEMPTS: usize = 3;

pub struct SerialHardwareAdapter {
    port_path: String,
    op_lock: Mutex<()>,
}

impl SerialHardwareAdapter {
    pub fn new(port_path: String) -> Self {
        Self {
            port_path,
            op_lock: Mutex::new(()),
        }
    }

    fn open_port(&self) -> Result<SerialStream, String> {
        tokio_serial::new(&self.port_path, SERIAL_BAUD_RATE)
            .data_bits(DataBits::Eight)
            .parity(Parity::None)
            .stop_bits(StopBits::One)
            .flow_control(FlowControl::None)
            .open_native_async()
            .map_err(|error| format!("open serial port {} failed: {error}", self.port_path))
    }

    async fn handshake(&self) -> Result<LowerFrame, String> {
        let _guard = self.op_lock.lock().await;
        let mut port = self.open_port()?;
        port.write_all(&HANDSHAKE)
            .await
            .map_err(|error| format!("serial handshake write failed: {error}"))?;
        port.flush()
            .await
            .map_err(|error| format!("serial handshake flush failed: {error}"))?;

        loop {
            let frame = read_lower_frame(&mut port, HANDSHAKE_TIMEOUT).await?;
            if frame.is_heartbeat() {
                return Ok(frame);
            }
            if frame.is_fault() {
                return Err(frame.describe().to_string());
            }
        }
    }

    async fn dispense_inner(
        &self,
        command: &DispenseCommandPayload,
    ) -> Result<(), DispenseFailure> {
        if command.quantity != 1 {
            return Err(DispenseFailure::unknown(format!(
                "serial protocol supports one item per command, got quantity={}",
                command.quantity
            )));
        }

        let frame = build_dispense_frame(command.slot.layer_no, command.slot.cell_no)
            .map_err(DispenseFailure::unknown)?;
        let command_deadline = Instant::now() + Duration::from_secs(command.timeout_seconds.max(1));

        let _guard = self.op_lock.lock().await;
        let mut port = self.open_port().map_err(DispenseFailure::timeout)?;
        let mut acknowledged = false;

        for _attempt in 0..COMMAND_ATTEMPTS {
            port.write_all(&frame).await.map_err(|error| {
                DispenseFailure::timeout(format!("serial command write failed: {error}"))
            })?;
            port.flush().await.map_err(|error| {
                DispenseFailure::timeout(format!("serial command flush failed: {error}"))
            })?;

            match wait_for_ack(&mut port).await {
                Ok(()) => {
                    acknowledged = true;
                    break;
                }
                Err(AckWaitError::Timeout) => continue,
                Err(AckWaitError::Failure(failure)) => return Err(failure),
            }
        }

        if !acknowledged {
            let _ = port.write_all(&HANDSHAKE).await;
            let _ = port.flush().await;
            return Err(DispenseFailure::timeout(format!(
                "lower controller did not acknowledge command after {COMMAND_ATTEMPTS} attempts"
            )));
        }

        wait_for_completion(&mut port, command_deadline).await
    }
}

#[async_trait]
impl HardwareAdapter for SerialHardwareAdapter {
    fn adapter_name(&self) -> &str {
        "serial"
    }

    async fn self_check(&self) -> HardwareStatus {
        match self.handshake().await {
            Ok(frame) => HardwareStatus {
                adapter: "serial".to_string(),
                online: true,
                message: format!(
                    "serial adapter ready on {} ({})",
                    self.port_path,
                    frame.describe()
                ),
            },
            Err(error) => HardwareStatus {
                adapter: "serial".to_string(),
                online: false,
                message: format!("serial adapter unavailable on {}: {error}", self.port_path),
            },
        }
    }

    async fn dispense(&self, command: DispenseCommandPayload) -> DispenseResultPayload {
        let reported_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        match self.dispense_inner(&command).await {
            Ok(()) => DispenseResultPayload {
                command_no: command.command_no,
                success: true,
                error_code: None,
                message: "serial: dispense completed".to_string(),
                reported_at,
            },
            Err(failure) => DispenseResultPayload {
                command_no: command.command_no,
                success: false,
                error_code: Some(failure.error_code),
                message: failure.message,
                reported_at,
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DispenseFailure {
    error_code: String,
    message: String,
}

impl DispenseFailure {
    fn timeout(message: impl Into<String>) -> Self {
        Self {
            error_code: "MOTOR_TIMEOUT".to_string(),
            message: message.into(),
        }
    }

    fn jammed(message: impl Into<String>) -> Self {
        Self {
            error_code: "JAMMED".to_string(),
            message: message.into(),
        }
    }

    fn unknown(message: impl Into<String>) -> Self {
        Self {
            error_code: "UNKNOWN".to_string(),
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum AckWaitError {
    Timeout,
    Failure(DispenseFailure),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LowerFrame {
    Ack,
    BoundaryError,
    CrcError,
    MechanicalError,
    Busy,
    AboutToDrop,
    Completed,
    IdleHeartbeat,
    DispensingHeartbeat,
    Unknown(u8),
}

impl LowerFrame {
    fn from_code(code: u8) -> Self {
        match code {
            0x00 => Self::Ack,
            0x01 => Self::BoundaryError,
            0x02 => Self::CrcError,
            0x03 => Self::MechanicalError,
            0x04 => Self::Busy,
            0xF0 => Self::AboutToDrop,
            0xF1 => Self::Completed,
            0xAA => Self::IdleHeartbeat,
            0xAB => Self::DispensingHeartbeat,
            other => Self::Unknown(other),
        }
    }

    fn is_heartbeat(self) -> bool {
        matches!(self, Self::IdleHeartbeat | Self::DispensingHeartbeat)
    }

    fn is_fault(self) -> bool {
        matches!(
            self,
            Self::BoundaryError | Self::CrcError | Self::MechanicalError | Self::Busy
        )
    }

    fn describe(self) -> &'static str {
        match self {
            Self::Ack => "acknowledged",
            Self::BoundaryError => "slot boundary check failed",
            Self::CrcError => "crc check failed",
            Self::MechanicalError => "mechanical fault",
            Self::Busy => "controller busy",
            Self::AboutToDrop => "goods arrived at outlet",
            Self::Completed => "dispense completed and reset to origin",
            Self::IdleHeartbeat => "idle heartbeat",
            Self::DispensingHeartbeat => "dispensing heartbeat",
            Self::Unknown(_) => "unknown frame",
        }
    }

    fn to_failure(self) -> Option<DispenseFailure> {
        match self {
            Self::BoundaryError => Some(DispenseFailure::unknown(
                "lower controller rejected command: slot boundary check failed",
            )),
            Self::CrcError => Some(DispenseFailure::unknown(
                "lower controller rejected command: crc check failed",
            )),
            Self::MechanicalError => Some(DispenseFailure::jammed(
                "lower controller reported mechanical fault during dispense",
            )),
            Self::Busy => Some(DispenseFailure::unknown(
                "lower controller rejected command: controller busy",
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

pub fn build_dispense_frame(layer_no: u32, cell_no: u32) -> Result<[u8; 4], String> {
    let layer = u8::try_from(layer_no)
        .map_err(|_| format!("layerNo {layer_no} exceeds uint8 protocol range"))?;
    let cell = u8::try_from(cell_no)
        .map_err(|_| format!("cellNo {cell_no} exceeds uint8 protocol range"))?;
    if layer == 0 || cell == 0 {
        return Err("layerNo and cellNo must be 1-based positive values".to_string());
    }
    let crc = crc8(&[layer, cell]);
    Ok([FRAME_HEAD, layer, cell, crc])
}

async fn wait_for_ack(port: &mut SerialStream) -> Result<(), AckWaitError> {
    let deadline = Instant::now() + COMMAND_ACK_TIMEOUT;
    loop {
        let now = Instant::now();
        if now >= deadline {
            return Err(AckWaitError::Timeout);
        }
        let remaining = deadline.saturating_duration_since(now);
        let frame = match read_lower_frame(port, remaining).await {
            Ok(frame) => frame,
            Err(_) => return Err(AckWaitError::Timeout),
        };
        match frame {
            LowerFrame::Ack => return Ok(()),
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

async fn wait_for_completion(
    port: &mut SerialStream,
    command_deadline: Instant,
) -> Result<(), DispenseFailure> {
    loop {
        let now = Instant::now();
        if now >= command_deadline {
            return Err(DispenseFailure::timeout(
                "dispense command timed out before completion frame",
            ));
        }

        let wait = HEARTBEAT_TIMEOUT.min(command_deadline.saturating_duration_since(now));
        let frame = match read_lower_frame(port, wait).await {
            Ok(frame) => frame,
            Err(_) => {
                if Instant::now() >= command_deadline {
                    return Err(DispenseFailure::timeout(
                        "dispense command timed out before completion frame",
                    ));
                }
                return Err(DispenseFailure::timeout(
                    "lower controller heartbeat missing for 3 seconds",
                ));
            }
        };

        match frame {
            LowerFrame::Completed => return Ok(()),
            LowerFrame::Ack
            | LowerFrame::AboutToDrop
            | LowerFrame::IdleHeartbeat
            | LowerFrame::DispensingHeartbeat => continue,
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

async fn read_lower_frame<R>(reader: &mut R, read_timeout: Duration) -> Result<LowerFrame, String>
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
    use super::*;

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
    fn build_dispense_frame_rejects_zero_or_out_of_range_values() {
        assert!(build_dispense_frame(0, 1).is_err());
        assert!(build_dispense_frame(1, 0).is_err());
        assert!(build_dispense_frame(256, 1).is_err());
        assert!(build_dispense_frame(1, 256).is_err());
    }

    #[test]
    fn lower_frame_maps_documented_codes() {
        assert_eq!(LowerFrame::from_code(0x00), LowerFrame::Ack);
        assert_eq!(LowerFrame::from_code(0x01), LowerFrame::BoundaryError);
        assert_eq!(LowerFrame::from_code(0x02), LowerFrame::CrcError);
        assert_eq!(LowerFrame::from_code(0x03), LowerFrame::MechanicalError);
        assert_eq!(LowerFrame::from_code(0x04), LowerFrame::Busy);
        assert_eq!(LowerFrame::from_code(0xF0), LowerFrame::AboutToDrop);
        assert_eq!(LowerFrame::from_code(0xF1), LowerFrame::Completed);
        assert_eq!(LowerFrame::from_code(0xAA), LowerFrame::IdleHeartbeat);
        assert_eq!(LowerFrame::from_code(0xAB), LowerFrame::DispensingHeartbeat);
    }
}

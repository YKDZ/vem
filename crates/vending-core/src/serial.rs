use std::time::Duration;

use async_trait::async_trait;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    sync::Mutex,
    time::{sleep, timeout, Duration as TokioDuration, Instant},
};
use tokio_serial::{DataBits, FlowControl, Parity, SerialPortBuilderExt, SerialStream, StopBits};

use crate::hardware::{
    DispenseCommandPayload, DispenseResultPayload, HardwareAdapter, HardwareStatus,
};

pub const FRAME_HEAD: u8 = 0x55;
pub const FRAME_MULTI_TAIL: u8 = 0x56;
const HANDSHAKE: [u8; 2] = build_status_query_frame();
const SERIAL_BAUD_RATE: u32 = 115_200;
const COMMAND_ACK_TIMEOUT: TokioDuration = TokioDuration::from_millis(100);
const ENVIRONMENT_COMMAND_TIMEOUT: TokioDuration = TokioDuration::from_millis(200);
const HANDSHAKE_TIMEOUT: TokioDuration = TokioDuration::from_millis(1_000);
/// 连续多长时间未收到心跳后，主动发送握手探测帧（来自补充协议文档第5点）
const HEARTBEAT_PROBE_INTERVAL: TokioDuration = TokioDuration::from_secs(1);
/// 收到 Busy 回复后，下次重发出货指令前需等待的最小间隔
const BUSY_RETRY_DELAY: TokioDuration = TokioDuration::from_millis(100);
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

    pub async fn query_environment_sample(&self) -> Result<Option<EnvironmentSample>, String> {
        let frame = build_environment_sample_query_frame();
        let _guard = self.op_lock.lock().await;
        let mut port = self.open_port()?;
        port.write_all(&frame)
            .await
            .map_err(|error| format!("serial environment query write failed: {error}"))?;
        port.flush()
            .await
            .map_err(|error| format!("serial environment query flush failed: {error}"))?;

        match read_lower_frame(&mut port, ENVIRONMENT_COMMAND_TIMEOUT).await? {
            LowerFrame::EnvironmentSample(sample) => Ok(Some(sample)),
            LowerFrame::NoValidEnvironmentSample => Ok(None),
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
        let frame = build_target_temperature_frame(temperature_celsius)?;
        let _guard = self.op_lock.lock().await;
        let mut port = self.open_port()?;
        port.write_all(&frame)
            .await
            .map_err(|error| format!("serial target temperature write failed: {error}"))?;
        port.flush()
            .await
            .map_err(|error| format!("serial target temperature flush failed: {error}"))?;

        match read_lower_frame(&mut port, ENVIRONMENT_COMMAND_TIMEOUT).await? {
            LowerFrame::TargetTemperatureEcho {
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
        let _guard = self.op_lock.lock().await;
        let mut port = self.open_port()?;
        port.write_all(&frame)
            .await
            .map_err(|error| format!("serial air conditioner switch write failed: {error}"))?;
        port.flush()
            .await
            .map_err(|error| format!("serial air conditioner switch flush failed: {error}"))?;

        match read_lower_frame(&mut port, ENVIRONMENT_COMMAND_TIMEOUT).await? {
            LowerFrame::AirConditionerSwitchEcho { enabled: echoed } if echoed == enabled => Ok(()),
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
        // 单商品用 4 字节 CRC-8 帧；多件同货道用多商品帧（CRC-16）
        let frame: Vec<u8> = if command.quantity == 1 {
            build_dispense_frame(command.slot.layer_no, command.slot.cell_no)
                .map(|f| f.to_vec())
                .map_err(DispenseFailure::unknown)?
        } else {
            let slots: Vec<(u32, u32)> = std::iter::repeat_n(
                (command.slot.layer_no, command.slot.cell_no),
                command.quantity as usize,
            )
            .collect();
            build_multi_dispense_frame(&slots).map_err(DispenseFailure::unknown)?
        };
        let command_deadline =
            Instant::now() + TokioDuration::from_secs(command.timeout_seconds.max(1));

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
                // 超时或 CRC 错误：立即重发
                Err(AckWaitError::Timeout) | Err(AckWaitError::CrcRetry) => continue,
                // 下位机繁忙：等待 100ms 后重发
                Err(AckWaitError::BusyRetry) => {
                    sleep(BUSY_RETRY_DELAY).await;
                    continue;
                }
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

    async fn query_environment_sample(&self) -> Result<Option<EnvironmentSample>, String> {
        SerialHardwareAdapter::query_environment_sample(self).await
    }

    async fn set_target_temperature(&self, temperature_celsius: i8) -> Result<(), String> {
        SerialHardwareAdapter::set_target_temperature(self, temperature_celsius).await
    }

    async fn set_air_conditioner_enabled(&self, enabled: bool) -> Result<(), String> {
        SerialHardwareAdapter::set_air_conditioner_enabled(self, enabled).await
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
pub struct DispenseFailure {
    pub error_code: String,
    pub message: String,
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
    /// CRC 校验失败——可立即重发出货指令
    CrcRetry,
    /// 下位机繁忙——需等待至少 100ms 后重发
    BusyRetry,
    Failure(DispenseFailure),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EnvironmentSample {
    pub temperature_celsius: i8,
    pub relative_humidity_percent: u8,
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
    AboutToDrop,
    Completed,
    IdleHeartbeat,
    DispensingHeartbeat,
    PickupHeartbeat,
    ResetHeartbeat,
    EnvironmentSample(EnvironmentSample),
    NoValidEnvironmentSample,
    TargetTemperatureEcho { temperature_celsius: i8 },
    AirConditionerSwitchEcho { enabled: bool },
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
            0xF0 => Self::AboutToDrop,
            0xF1 => Self::Completed,
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

    pub fn describe(self) -> &'static str {
        match self {
            Self::Ack => "acknowledged",
            Self::BoundaryError => "command boundary check failed",
            Self::CrcError => "crc check failed",
            Self::MechanicalError => "mechanical fault",
            Self::Busy => "controller busy",
            Self::PickupTimeout => "pickup timed out",
            Self::PickupPlatformBlocked => "pickup platform blocked",
            Self::AboutToDrop => "goods arrived at outlet",
            Self::Completed => "dispense completed and reset to origin",
            Self::IdleHeartbeat => "idle heartbeat",
            Self::DispensingHeartbeat => "dispensing heartbeat",
            Self::PickupHeartbeat => "pickup heartbeat",
            Self::ResetHeartbeat => "resetting to origin",
            Self::EnvironmentSample(_) => "environment sample",
            Self::NoValidEnvironmentSample => "no valid environment sample",
            Self::TargetTemperatureEcho { .. } => "target temperature accepted",
            Self::AirConditionerSwitchEcho { .. } => "air conditioner switch accepted",
            Self::Unknown(_) => "unknown frame",
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
            Self::MechanicalError => Some(DispenseFailure::jammed(
                "lower controller reported mechanical fault during dispense",
            )),
            Self::Busy => Some(DispenseFailure::unknown(
                "lower controller rejected command: controller busy",
            )),
            Self::PickupTimeout => Some(DispenseFailure::timeout(
                "lower controller reported pickup timed out during dispense",
            )),
            Self::PickupPlatformBlocked => Some(DispenseFailure::jammed(
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

/// CRC-16/CCITT（poly=0x1021, init=0x0000, 无反射）
/// 用于多商品帧校验，具体算法待与硬件方联调时确认。
pub fn crc16(data: &[u8]) -> u16 {
    let mut crc = 0x0000u16;
    for byte in data {
        crc ^= (*byte as u16) << 8;
        for _ in 0..8 {
            if crc & 0x8000 != 0 {
                crc = (crc << 1) ^ 0x1021;
            } else {
                crc <<= 1;
            }
        }
    }
    crc
}

/// 校验货道号是否在硬件允许的范围内。
/// 行（row）1-10；格（cell）：行 1-6 为 1-5，行 7-10 为 1-4。
fn validate_slot_bounds(layer_no: u32, cell_no: u32) -> Result<(), String> {
    if !(1..=10).contains(&layer_no) {
        return Err(format!(
            "layerNo {layer_no} is out of hardware bounds (1-10)"
        ));
    }
    let max_cell = if layer_no <= 6 { 5u32 } else { 4u32 };
    if !(1..=max_cell).contains(&cell_no) {
        return Err(format!(
            "cellNo {cell_no} is out of hardware bounds for row {layer_no} (1-{max_cell})"
        ));
    }
    Ok(())
}

pub const fn build_status_query_frame() -> [u8; 2] {
    [FRAME_HEAD, 0xA0]
}

pub const fn build_environment_sample_query_frame() -> [u8; 2] {
    [FRAME_HEAD, 0xB0]
}

pub fn build_target_temperature_frame(temperature_celsius: i8) -> Result<[u8; 3], String> {
    if !(-10..=100).contains(&temperature_celsius) {
        return Err(format!(
            "target temperature {temperature_celsius} is out of protocol range -10..100 C"
        ));
    }
    Ok([FRAME_HEAD, 0xB1, temperature_celsius as u8])
}

pub const fn build_air_conditioner_switch_frame(enabled: bool) -> [u8; 3] {
    [FRAME_HEAD, 0xB2, if enabled { 0xFF } else { 0x00 }]
}

pub fn build_dispense_frame(layer_no: u32, cell_no: u32) -> Result<[u8; 4], String> {
    let layer = u8::try_from(layer_no)
        .map_err(|_| format!("layerNo {layer_no} exceeds uint8 protocol range"))?;
    let cell = u8::try_from(cell_no)
        .map_err(|_| format!("cellNo {cell_no} exceeds uint8 protocol range"))?;
    validate_slot_bounds(layer_no, cell_no)?;
    let crc = crc8(&[layer, cell]);
    Ok([FRAME_HEAD, layer, cell, crc])
}

/// 构造多商品出货帧：[0x55, row1, cell1, row2, cell2, ..., 0x56, crc_hi, crc_lo]
/// 同一货道多件时，重复传入相同的 (layer_no, cell_no)。
/// CRC-16 仅覆盖数据段（行列字节），不含帧头/帧尾。
pub fn build_multi_dispense_frame(slots: &[(u32, u32)]) -> Result<Vec<u8>, String> {
    if slots.is_empty() {
        return Err("at least one slot is required".to_string());
    }
    let mut data: Vec<u8> = Vec::with_capacity(slots.len() * 2);
    for &(layer_no, cell_no) in slots {
        let layer = u8::try_from(layer_no)
            .map_err(|_| format!("layerNo {layer_no} exceeds uint8 protocol range"))?;
        let cell = u8::try_from(cell_no)
            .map_err(|_| format!("cellNo {cell_no} exceeds uint8 protocol range"))?;
        validate_slot_bounds(layer_no, cell_no)?;
        data.push(layer);
        data.push(cell);
    }
    let crc = crc16(&data);
    let mut frame = Vec::with_capacity(1 + data.len() + 3);
    frame.push(FRAME_HEAD);
    frame.extend_from_slice(&data);
    frame.push(FRAME_MULTI_TAIL);
    frame.push((crc >> 8) as u8);
    frame.push(crc as u8);
    Ok(frame)
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

/// 当心跳中断（1s 内无有效帧）时，主动向下位机发送握手探测。
/// 收到任意心跳帧视为探测成功；100ms 无回应返回 Err。
async fn probe_handshake(port: &mut SerialStream) -> Result<LowerFrame, ()> {
    port.write_all(&HANDSHAKE).await.map_err(|_| ())?;
    port.flush().await.map_err(|_| ())?;
    match read_lower_frame(port, TokioDuration::from_millis(100)).await {
        Ok(frame) if frame.is_heartbeat() => Ok(frame),
        _ => Err(()),
    }
}

async fn wait_for_completion(
    port: &mut SerialStream,
    command_deadline: Instant,
) -> Result<(), DispenseFailure> {
    let mut probe_failures: usize = 0;
    loop {
        let now = Instant::now();
        if now >= command_deadline {
            return Err(DispenseFailure::timeout(
                "dispense command timed out before completion frame",
            ));
        }

        // 以 1s 为间隔读帧；超过 1s 无帧则发握手探测
        let wait = HEARTBEAT_PROBE_INTERVAL.min(command_deadline.saturating_duration_since(now));
        let frame = match read_lower_frame(port, wait).await {
            Ok(frame) => {
                probe_failures = 0;
                frame
            }
            Err(_) => {
                if Instant::now() >= command_deadline {
                    return Err(DispenseFailure::timeout(
                        "dispense command timed out before completion frame",
                    ));
                }
                // 心跳中断——主动探测下位机
                match probe_handshake(port).await {
                    Ok(_) => {
                        probe_failures = 0;
                        continue;
                    }
                    Err(()) => {
                        probe_failures += 1;
                        if probe_failures >= COMMAND_ATTEMPTS {
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
            LowerFrame::Completed => return Ok(()),
            LowerFrame::Ack
            | LowerFrame::AboutToDrop
            | LowerFrame::IdleHeartbeat
            | LowerFrame::DispensingHeartbeat
            | LowerFrame::PickupHeartbeat
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
            if temperature_byte == 0x00 && humidity == 0x00 {
                return Ok(LowerFrame::NoValidEnvironmentSample);
            }
            return Ok(LowerFrame::EnvironmentSample(EnvironmentSample {
                temperature_celsius: temperature_byte as i8,
                relative_humidity_percent: humidity,
            }));
        }
        if code == 0xB1 {
            let temperature_celsius = read_byte_before(reader, deadline).await? as i8;
            if !(-10..=100).contains(&temperature_celsius) {
                return Err(format!(
                    "target temperature echo {temperature_celsius} out of protocol range -10..100 C"
                ));
            }
            return Ok(LowerFrame::TargetTemperatureEcho {
                temperature_celsius,
            });
        }
        if code == 0xB2 {
            let state = read_byte_before(reader, deadline).await?;
            return match state {
                0x00 => Ok(LowerFrame::AirConditionerSwitchEcho { enabled: false }),
                0xFF => Ok(LowerFrame::AirConditionerSwitchEcho { enabled: true }),
                other => Err(format!(
                    "air conditioner switch echo state 0x{other:02X} out of protocol range 0x00/0xFF"
                )),
            };
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
    fn build_v1_environment_command_frames() {
        assert_eq!(build_status_query_frame(), [0x55, 0xA0]);
        assert_eq!(build_environment_sample_query_frame(), [0x55, 0xB0]);
        assert_eq!(
            build_target_temperature_frame(-10).unwrap(),
            [0x55, 0xB1, 0xF6]
        );
        assert_eq!(
            build_target_temperature_frame(100).unwrap(),
            [0x55, 0xB1, 100]
        );
        assert!(build_target_temperature_frame(-11).is_err());
        assert!(build_target_temperature_frame(101).is_err());
        assert_eq!(
            build_air_conditioner_switch_frame(false),
            [0x55, 0xB2, 0x00]
        );
        assert_eq!(build_air_conditioner_switch_frame(true), [0x55, 0xB2, 0xFF]);
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
        assert_eq!(LowerFrame::from_code(0xF0), LowerFrame::AboutToDrop);
        assert_eq!(LowerFrame::from_code(0xF1), LowerFrame::Completed);
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
    fn reset_heartbeat_is_a_heartbeat() {
        assert!(LowerFrame::IdleHeartbeat.is_heartbeat());
        assert!(LowerFrame::DispensingHeartbeat.is_heartbeat());
        assert!(LowerFrame::PickupHeartbeat.is_heartbeat());
        assert!(LowerFrame::ResetHeartbeat.is_heartbeat());
        assert!(!LowerFrame::MechanicalError.is_heartbeat());
    }

    #[test]
    fn validate_slot_bounds_rejects_out_of_range() {
        // 行超出 1-10
        assert!(validate_slot_bounds(0, 1).is_err());
        assert!(validate_slot_bounds(11, 1).is_err());
        // 行 1-6：格最大 5
        assert!(validate_slot_bounds(1, 5).is_ok());
        assert!(validate_slot_bounds(6, 5).is_ok());
        assert!(validate_slot_bounds(1, 6).is_err());
        // 行 7-10：格最大 4
        assert!(validate_slot_bounds(7, 4).is_ok());
        assert!(validate_slot_bounds(10, 4).is_ok());
        assert!(validate_slot_bounds(7, 5).is_err());
    }

    #[test]
    fn build_dispense_frame_respects_hardware_bounds() {
        // 有效货道
        assert!(build_dispense_frame(1, 5).is_ok());
        assert!(build_dispense_frame(6, 5).is_ok());
        assert!(build_dispense_frame(7, 4).is_ok());
        assert!(build_dispense_frame(10, 4).is_ok());
        // 超出硬件范围
        assert!(build_dispense_frame(0, 1).is_err());
        assert!(build_dispense_frame(11, 1).is_err());
        assert!(build_dispense_frame(7, 5).is_err());
    }

    #[test]
    fn build_multi_dispense_frame_has_correct_structure() {
        // 两件相同货道
        let frame = build_multi_dispense_frame(&[(2, 5), (2, 5)]).unwrap();
        // 帧头 + 4字节数据 + 帧尾 + 2字节CRC
        assert_eq!(frame.len(), 8);
        assert_eq!(frame[0], 0x55); // 帧头
        assert_eq!(frame[1], 0x02); // row1
        assert_eq!(frame[2], 0x05); // cell1
        assert_eq!(frame[3], 0x02); // row2
        assert_eq!(frame[4], 0x05); // cell2
        assert_eq!(frame[5], 0x56); // 多商品帧尾
                                    // CRC-16 覆盖数据段 [0x02, 0x05, 0x02, 0x05]
        let expected_crc = crc16(&[0x02, 0x05, 0x02, 0x05]);
        assert_eq!(frame[6], (expected_crc >> 8) as u8);
        assert_eq!(frame[7], expected_crc as u8);
    }

    #[test]
    fn build_multi_dispense_frame_rejects_empty() {
        assert!(build_multi_dispense_frame(&[]).is_err());
    }

    #[test]
    fn build_multi_dispense_frame_rejects_out_of_bounds_slot() {
        assert!(build_multi_dispense_frame(&[(7, 5)]).is_err());
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
    async fn read_lower_frame_represents_v1_environment_sentinel() {
        let (mut tx, mut rx) = duplex(8);
        tokio::spawn(async move {
            tx.write_all(&[FRAME_HEAD, 0xB0, 0x00, 0x00])
                .await
                .expect("seed bytes");
        });
        let frame = read_lower_frame(&mut rx, Duration::from_millis(100))
            .await
            .expect("read frame");
        assert_eq!(frame, LowerFrame::NoValidEnvironmentSample);
    }

    #[tokio::test]
    async fn read_lower_frame_parses_v1_target_temperature_echo() {
        let (mut tx, mut rx) = duplex(8);
        tokio::spawn(async move {
            tx.write_all(&[FRAME_HEAD, 0xB1, 0xF6])
                .await
                .expect("seed bytes");
        });
        let frame = read_lower_frame(&mut rx, Duration::from_millis(100))
            .await
            .expect("read frame");
        assert_eq!(
            frame,
            LowerFrame::TargetTemperatureEcho {
                temperature_celsius: -10
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
            LowerFrame::AirConditionerSwitchEcho { enabled: true }
        );
    }
}

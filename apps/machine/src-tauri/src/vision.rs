use std::time::Duration;

use chrono::{SecondsFormat, Utc};
use futures_util::{SinkExt, StreamExt};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use tokio::{net::TcpStream, time::timeout};
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};
use uuid::Uuid;

const VISION_PROTOCOL: &str = "vem.vision.v1";

pub const DEFAULT_VISION_WS_URL: &str = "ws://127.0.0.1:7892/ws";

pub type VisionSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientEnvelope<T>
where
    T: Serialize,
{
    protocol: &'static str,
    #[serde(rename = "type")]
    message_type: &'static str,
    message_id: String,
    timestamp: String,
    payload: T,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerEnvelope {
    protocol: String,
    #[serde(rename = "type")]
    message_type: String,
    _message_id: String,
    _timestamp: String,
    payload: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VisionHelloPayload {
    client_role: &'static str,
    machine_code: Option<String>,
    protocol_version: u8,
    capabilities: Vec<&'static str>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisionReadyPayload {
    pub server_name: String,
    pub server_version: String,
    pub camera_ready: bool,
    pub model_ready: bool,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VisionErrorPayload {
    event_id: Option<String>,
    code: String,
    message: String,
    retryable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisionSelfCheckResult {
    pub enabled: bool,
    pub online: bool,
    pub message: String,
    pub checked_at_ms: u128,
    pub ready: Option<VisionReadyPayload>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisionRuntimeStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub message: String,
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn message_id(prefix: &str) -> String {
    format!("{prefix}-{}", Uuid::new_v4())
}

fn client_envelope<T>(message_type: &'static str, payload: T) -> ClientEnvelope<T>
where
    T: Serialize,
{
    ClientEnvelope {
        protocol: VISION_PROTOCOL,
        message_type,
        message_id: message_id(message_type),
        timestamp: now_iso(),
        payload,
    }
}

async fn send_client_message<T>(
    socket: &mut VisionSocket,
    message_type: &'static str,
    payload: T,
) -> Result<(), String>
where
    T: Serialize,
{
    let content = serde_json::to_string(&client_envelope(message_type, payload))
        .map_err(|error| format!("serialize vision message failed: {error}"))?;
    socket
        .send(Message::Text(content))
        .await
        .map_err(|error| format!("send vision message failed: {error}"))
}

async fn read_server_envelope(socket: &mut VisionSocket) -> Result<ServerEnvelope, String> {
    while let Some(frame) = socket.next().await {
        let message = frame.map_err(|error| format!("read vision message failed: {error}"))?;
        match message {
            Message::Text(text) => {
                let envelope: ServerEnvelope = serde_json::from_str(&text)
                    .map_err(|error| format!("parse vision message failed: {error}"))?;
                if envelope.protocol != VISION_PROTOCOL {
                    return Err(format!(
                        "unsupported vision protocol: {}",
                        envelope.protocol
                    ));
                }
                return Ok(envelope);
            }
            Message::Binary(_) => return Err("vision server returned binary frame".to_string()),
            Message::Close(_) => return Err("vision websocket closed".to_string()),
            Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => continue,
        }
    }
    Err("vision websocket closed".to_string())
}

fn parse_payload<T>(envelope: ServerEnvelope) -> Result<T, String>
where
    T: DeserializeOwned,
{
    serde_json::from_value(envelope.payload)
        .map_err(|error| format!("parse vision payload failed: {error}"))
}

fn vision_error_message(error: VisionErrorPayload) -> String {
    let event_text = error
        .event_id
        .map(|event_id| format!(" event={event_id}"))
        .unwrap_or_default();
    format!(
        "vision {}{}: {} (retryable={})",
        error.code, event_text, error.message, error.retryable
    )
}

async fn connect_vision(ws_url: &str) -> Result<VisionSocket, String> {
    let (socket, _) = connect_async(ws_url)
        .await
        .map_err(|error| format!("connect vision websocket failed: {error}"))?;
    Ok(socket)
}

async fn send_hello(socket: &mut VisionSocket, machine_code: Option<String>) -> Result<(), String> {
    send_client_message(
        socket,
        "vision.hello",
        VisionHelloPayload {
            client_role: "machine",
            machine_code,
            protocol_version: 1,
            capabilities: vec!["profile_push"],
        },
    )
    .await
}

async fn wait_ready(socket: &mut VisionSocket) -> Result<VisionReadyPayload, String> {
    loop {
        let envelope = read_server_envelope(socket).await?;
        match envelope.message_type.as_str() {
            "vision.ready" => return parse_payload(envelope),
            "vision.error" => {
                let error: VisionErrorPayload = parse_payload(envelope)?;
                return Err(vision_error_message(error));
            }
            _ => continue,
        }
    }
}

pub async fn check_ready(
    ws_url: &str,
    machine_code: Option<String>,
    timeout_ms: u64,
) -> Result<VisionReadyPayload, String> {
    timeout(Duration::from_millis(timeout_ms), async {
        let mut socket = connect_vision(ws_url).await?;
        send_hello(&mut socket, machine_code).await?;
        wait_ready(&mut socket).await
    })
    .await
    .map_err(|_| "vision self-check timed out".to_string())?
}

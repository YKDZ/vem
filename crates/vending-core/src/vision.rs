use futures_util::{SinkExt, StreamExt};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use tokio::net::TcpStream;
use tokio::time::{timeout, Duration};
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

pub const VISION_PROTOCOL: &str = "vem.vision.v1";
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
    #[allow(dead_code)]
    event_id: Option<String>,
    code: String,
    message: String,
    retryable: bool,
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn message_id(prefix: &str) -> String {
    format!("{prefix}-{}", uuid::Uuid::new_v4())
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
    format!(
        "vision {}: {} (retryable={})",
        error.code, error.message, error.retryable
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

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::SinkExt;
    use tokio::net::TcpListener;
    use tokio_tungstenite::{accept_async, tungstenite::protocol::Message};

    #[tokio::test]
    async fn check_ready_returns_profile_on_ready_message() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listen");
        let addr = listener.local_addr().expect("local addr");
        let ws_url = format!("ws://{addr}/");

        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let mut ws_stream = accept_async(stream).await.expect("accept ws");
            let first = ws_stream.next().await.expect("next").expect("msg");
            assert!(first.is_text());
            ws_stream
                .send(Message::Text(
                    r#"{"protocol":"vem.vision.v1","type":"vision.ready","messageId":"1","timestamp":"x","payload":{"serverName":"s","serverVersion":"1","cameraReady":true,"modelReady":true,"capabilities":[]}}"#
                        .into(),
                ))
                .await
                .expect("send");
        });

        let ready = check_ready(&ws_url, Some("M-1".to_string()), 2000)
            .await
            .expect("ready");
        assert!(ready.camera_ready);
    }

    #[tokio::test]
    async fn check_ready_maps_error_payload() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listen");
        let addr = listener.local_addr().expect("local addr");
        let ws_url = format!("ws://{addr}/");

        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let mut ws_stream = accept_async(stream).await.expect("accept ws");
            let _ = ws_stream.next().await.expect("next");
            ws_stream
                .send(Message::Text(
                    r#"{"protocol":"vem.vision.v1","type":"vision.error","messageId":"1","timestamp":"x","payload":{"code":"camera_unavailable","message":"camera unavailable","retryable":false}}"#
                        .into(),
                ))
                .await
                .expect("send");
        });

        let err = check_ready(&ws_url, None, 2000).await;
        assert!(err.is_err());
        assert!(err.unwrap_err().contains("camera_unavailable"));
    }
}

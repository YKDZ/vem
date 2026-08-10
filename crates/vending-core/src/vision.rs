use futures_util::{SinkExt, StreamExt};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use tokio::net::TcpStream;
use tokio::time::{timeout, Duration};
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

pub const DEFAULT_VISION_WS_URL: &str = "ws://127.0.0.1:7892/ws";
const VISION_V2_MANIFEST: &str =
    include_str!("../../../packages/shared/generated/vision-v2/manifest.json");
#[cfg(test)]
const VISION_V2_VALID_FIXTURES: &str =
    include_str!("../../../packages/shared/generated/vision-v2/fixtures/valid.json");
#[cfg(test)]
const VISION_V2_INVALID_FIXTURES: &str =
    include_str!("../../../packages/shared/generated/vision-v2/fixtures/invalid.json");

pub type VisionSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientEnvelope<T>
where
    T: Serialize,
{
    protocol: String,
    #[serde(rename = "type")]
    message_type: &'static str,
    message_id: String,
    timestamp: String,
    payload: T,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServerEnvelope {
    protocol: String,
    #[serde(rename = "type")]
    message_type: String,
    message_id: String,
    timestamp: String,
    payload: Value,
}

#[derive(Debug, Clone)]
pub struct VisionServerEvent {
    pub message_type: String,
    pub payload: Value,
}

pub struct VisionSession {
    socket: VisionSocket,
}

impl VisionSession {
    pub async fn ping(&mut self) -> Result<(), String> {
        send_client_message(&mut self.socket, "vision.ping", serde_json::json!({})).await
    }

    pub async fn next_event(&mut self) -> Result<VisionServerEvent, String> {
        let envelope = read_server_envelope(&mut self.socket).await?;
        if envelope.message_type == "vision.error" {
            let error: VisionErrorPayload = serde_json::from_value(envelope.payload)
                .map_err(|error| format!("parse vision payload failed: {error}"))?;
            return Err(vision_error_message(error));
        }
        Ok(VisionServerEvent {
            message_type: envelope.message_type,
            payload: envelope.payload,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VisionHelloPayload {
    client_role: &'static str,
    machine_code: Option<String>,
    schema_version: String,
    bundle_version: String,
    contract_digest: String,
    capabilities: Vec<&'static str>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct VisionReadyPayload {
    pub server_name: String,
    pub server_version: String,
    pub schema_version: String,
    pub bundle_version: String,
    pub contract_digest: String,
    pub camera_ready: bool,
    pub fast_ready: bool,
    pub vision_business_ready: bool,
    pub business_readiness_diagnostic: VisionBusinessReadinessDiagnostic,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VisionBusinessReadinessDiagnostic {
    Ready,
    CameraUnavailable,
    ContractDigestMismatch,
    ContractVersionMismatch,
    ContractBundleUnavailable,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VisionV2BundleManifest {
    protocol: String,
    schema_version: String,
    bundle_version: String,
    bundle_digest: String,
    #[serde(rename = "files")]
    _files: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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

fn envelope_message_id(prefix: &str) -> String {
    format!("{prefix}-{}", uuid::Uuid::new_v4())
}

fn v2_contract_identity() -> Result<VisionV2BundleManifest, String> {
    let manifest: VisionV2BundleManifest = serde_json::from_str(VISION_V2_MANIFEST)
        .map_err(|error| format!("parse generated Vision V2 manifest failed: {error}"))?;
    if manifest.protocol.is_empty()
        || manifest.schema_version.is_empty()
        || manifest.bundle_version.is_empty()
        || manifest.bundle_digest.len() != 64
        || !manifest
            .bundle_digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("generated Vision V2 manifest identity is invalid".to_string());
    }
    Ok(manifest)
}

fn client_envelope<T>(message_type: &'static str, payload: T) -> Result<ClientEnvelope<T>, String>
where
    T: Serialize,
{
    let identity = v2_contract_identity()?;
    Ok(ClientEnvelope {
        protocol: identity.protocol,
        message_type,
        message_id: envelope_message_id(message_type),
        timestamp: now_iso(),
        payload,
    })
}

async fn send_client_message<T>(
    socket: &mut VisionSocket,
    message_type: &'static str,
    payload: T,
) -> Result<(), String>
where
    T: Serialize,
{
    let content = serde_json::to_string(&client_envelope(message_type, payload)?)
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
                if envelope.protocol != v2_contract_identity()?.protocol {
                    return Err(format!(
                        "unsupported vision protocol: {}",
                        envelope.protocol
                    ));
                }
                validate_server_envelope(&envelope)?;
                return Ok(envelope);
            }
            Message::Binary(_) => return Err("vision server returned binary frame".to_string()),
            Message::Close(_) => return Err("vision websocket closed".to_string()),
            Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => continue,
        }
    }
    Err("vision websocket closed".to_string())
}

fn validate_server_envelope(envelope: &ServerEnvelope) -> Result<(), String> {
    let message_id_chars = envelope.message_id.chars().count();
    if message_id_chars == 0 || message_id_chars > 128 {
        return Err("invalid vision messageId: expected 1..128 characters".to_string());
    }
    if !envelope.timestamp.ends_with('Z')
        || chrono::DateTime::parse_from_rfc3339(&envelope.timestamp).is_err()
    {
        return Err("invalid vision timestamp: expected UTC RFC3339 Z".to_string());
    }
    Ok(())
}

fn validate_ready_payload(ready: &VisionReadyPayload) -> Result<(), String> {
    if ready.server_name.is_empty()
        || ready.server_name.len() > 128
        || ready.server_version.is_empty()
        || ready.server_version.len() > 64
        || ready.schema_version.is_empty()
        || ready.schema_version.len() > 128
        || ready.bundle_version.is_empty()
        || ready.bundle_version.len() > 64
    {
        return Err("invalid vision.ready version metadata".to_string());
    }
    if ready.contract_digest.len() != 64
        || !ready
            .contract_digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("invalid vision.ready contractDigest".to_string());
    }
    if ready.capabilities.len() > 32
        || ready
            .capabilities
            .iter()
            .any(|capability| capability.is_empty() || capability.len() > 64)
    {
        return Err("invalid vision.ready capabilities".to_string());
    }
    Ok(())
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
    let identity = v2_contract_identity()?;
    send_client_message(
        socket,
        "vision.hello",
        VisionHelloPayload {
            client_role: "machine",
            machine_code,
            schema_version: identity.schema_version,
            bundle_version: identity.bundle_version,
            contract_digest: identity.bundle_digest,
            capabilities: vec![
                "profile_push",
                "presence_status",
                "person_departed",
                "ambient_light",
                "try_on_fast",
            ],
        },
    )
    .await
}

async fn wait_ready(socket: &mut VisionSocket) -> Result<VisionReadyPayload, String> {
    loop {
        let envelope = read_server_envelope(socket).await?;
        match envelope.message_type.as_str() {
            "vision.ready" => {
                let mut ready: VisionReadyPayload = parse_payload(envelope)?;
                validate_ready_payload(&ready)?;
                let identity = v2_contract_identity()?;
                if ready.business_readiness_diagnostic
                    == VisionBusinessReadinessDiagnostic::ContractBundleUnavailable
                {
                    // The remote generated bundle is unavailable.  This is a
                    // stable degraded-core diagnosis, not a local mismatch.
                } else if ready.schema_version != identity.schema_version
                    || ready.bundle_version != identity.bundle_version
                {
                    ready.fast_ready = false;
                    ready.vision_business_ready = false;
                    ready.business_readiness_diagnostic =
                        VisionBusinessReadinessDiagnostic::ContractVersionMismatch;
                } else if ready.contract_digest != identity.bundle_digest {
                    ready.fast_ready = false;
                    ready.vision_business_ready = false;
                    ready.business_readiness_diagnostic =
                        VisionBusinessReadinessDiagnostic::ContractDigestMismatch;
                }
                return Ok(ready);
            }
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

pub async fn connect_session(
    ws_url: &str,
    machine_code: Option<String>,
    timeout_ms: u64,
) -> Result<(VisionSession, VisionReadyPayload), String> {
    timeout(Duration::from_millis(timeout_ms), async {
        let mut socket = connect_vision(ws_url).await?;
        send_hello(&mut socket, machine_code).await?;
        let ready = wait_ready(&mut socket).await?;
        Ok((VisionSession { socket }, ready))
    })
    .await
    .map_err(|_| "vision connection timed out".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::SinkExt;
    use tokio::net::TcpListener;
    use tokio_tungstenite::{accept_async, tungstenite::protocol::Message};

    fn generated_ready_fixture() -> Value {
        serde_json::from_str::<Vec<Value>>(VISION_V2_VALID_FIXTURES)
            .expect("generated valid fixtures")
            .into_iter()
            .find(|message| message["type"] == "vision.ready")
            .expect("generated ready fixture")
    }

    fn generated_invalid_v1_hello_fixture() -> Value {
        serde_json::from_str::<Vec<Value>>(VISION_V2_INVALID_FIXTURES)
            .expect("generated invalid fixtures")
            .into_iter()
            .find(|fixture| fixture["name"] == "rejects-v1-protocol")
            .and_then(|fixture| fixture.get("message").cloned())
            .expect("generated invalid V1 fixture")
    }

    #[tokio::test]
    async fn check_ready_consumes_unmodified_shared_ready_fixture() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listen");
        let addr = listener.local_addr().expect("local addr");
        let ws_url = format!("ws://{addr}/");
        let fixture = generated_ready_fixture();

        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let mut ws_stream = accept_async(stream).await.expect("accept ws");
            let _ = ws_stream.next().await.expect("next");
            ws_stream
                .send(Message::Text(fixture.to_string()))
                .await
                .expect("send generated ready fixture");
        });

        let ready = check_ready(&ws_url, Some("M-1".to_string()), 2000)
            .await
            .expect("generated ready envelope accepted");
        // The corpus deliberately uses a placeholder digest.  It is still a
        // valid server envelope; runtime identity comparison must withhold
        // Fast without rewriting the source corpus.
        assert!(!ready.fast_ready);
        assert!(!ready.vision_business_ready);
        assert_eq!(
            ready.business_readiness_diagnostic,
            VisionBusinessReadinessDiagnostic::ContractDigestMismatch
        );
    }

    #[tokio::test]
    async fn check_ready_preserves_contract_bundle_unavailable_diagnostic() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listen");
        let addr = listener.local_addr().expect("local addr");
        let ws_url = format!("ws://{addr}/");
        let mut fixture = generated_ready_fixture();
        fixture["payload"]["schemaVersion"] = Value::String("unavailable".to_string());
        fixture["payload"]["bundleVersion"] = Value::String("unavailable".to_string());
        fixture["payload"]["contractDigest"] = Value::String("0".repeat(64));
        fixture["payload"]["fastReady"] = Value::Bool(false);
        fixture["payload"]["visionBusinessReady"] = Value::Bool(false);
        fixture["payload"]["businessReadinessDiagnostic"] =
            Value::String("contract_bundle_unavailable".to_string());

        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let mut ws_stream = accept_async(stream).await.expect("accept ws");
            let _ = ws_stream.next().await.expect("next");
            ws_stream
                .send(Message::Text(fixture.to_string()))
                .await
                .expect("send degraded ready");
        });

        let ready = check_ready(&ws_url, None, 2000)
            .await
            .expect("degraded ready remains a reachable Vision core");
        assert!(!ready.fast_ready);
        assert!(!ready.vision_business_ready);
        assert_eq!(
            ready.business_readiness_diagnostic,
            VisionBusinessReadinessDiagnostic::ContractBundleUnavailable
        );
    }

    #[tokio::test]
    async fn check_ready_rejects_unmodified_shared_v1_handshake_fixture() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listen");
        let addr = listener.local_addr().expect("local addr");
        let ws_url = format!("ws://{addr}/");
        let fixture = generated_invalid_v1_hello_fixture();

        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let mut ws_stream = accept_async(stream).await.expect("accept ws");
            let _ = ws_stream.next().await.expect("next");
            ws_stream
                .send(Message::Text(fixture.to_string()))
                .await
                .expect("send generated invalid fixture");
        });

        let error = check_ready(&ws_url, None, 2000)
            .await
            .expect_err("V1 fixture must not pass the V2 websocket boundary");
        assert!(error.contains("unsupported vision protocol"));
    }

    #[test]
    fn shared_envelope_accepts_non_uuid_character_message_ids_and_only_utc_z_timestamps() {
        let base = ServerEnvelope {
            protocol: v2_contract_identity().expect("identity").protocol,
            message_type: "vision.ready".to_string(),
            message_id: "消息-id".to_string(),
            timestamp: "2026-08-09T00:00:00.000Z".to_string(),
            payload: serde_json::json!({}),
        };
        assert!(validate_server_envelope(&base).is_ok());

        let too_long = ServerEnvelope {
            message_id: "界".repeat(129),
            ..base.clone()
        };
        assert!(validate_server_envelope(&too_long).is_err());
        let offset = ServerEnvelope {
            timestamp: "2026-08-09T00:00:00.000+00:00".to_string(),
            ..base
        };
        assert!(validate_server_envelope(&offset).is_err());
    }

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
            let hello: Value = serde_json::from_str(first.to_text().expect("text")).expect("json");
            assert_eq!(
                hello["payload"]["capabilities"],
                serde_json::json!([
                    "profile_push",
                    "presence_status",
                    "person_departed",
                    "ambient_light",
                    "try_on_fast"
                ])
            );
            ws_stream
                .send(Message::Text(
                    r#"{"protocol":"vem.vision.v2","type":"vision.ready","messageId":"550e8400-e29b-41d4-a716-446655440120","timestamp":"2026-08-09T00:00:00.000Z","payload":{"serverName":"s","serverVersion":"1","schemaVersion":"vem-vision-v2-contract-bundle/v1","bundleVersion":"1","contractDigest":"f5c86bc2def1a41328cccf7c2e864452fe2913265b99f36139d64c9c9028a386","cameraReady":true,"fastReady":true,"visionBusinessReady":true,"businessReadinessDiagnostic":"ready","capabilities":[]}}"#
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
                    r#"{"protocol":"vem.vision.v2","type":"vision.error","messageId":"550e8400-e29b-41d4-a716-446655440121","timestamp":"2026-08-09T00:00:00.000Z","payload":{"code":"camera_unavailable","message":"camera unavailable","retryable":false}}"#
                        .into(),
                ))
                .await
                .expect("send");
        });

        let err = check_ready(&ws_url, None, 2000).await;
        assert!(err.is_err());
        assert!(err.unwrap_err().contains("camera_unavailable"));
    }

    #[tokio::test]
    async fn check_ready_rejects_unknown_server_envelope_fields() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listen");
        let addr = listener.local_addr().expect("local addr");
        let ws_url = format!("ws://{addr}/");

        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let mut ws_stream = accept_async(stream).await.expect("accept ws");
            let _ = ws_stream.next().await.expect("next");
            ws_stream
                .send(Message::Text(
                    r#"{"protocol":"vem.vision.v2","type":"vision.ready","messageId":"550e8400-e29b-41d4-a716-446655440122","timestamp":"2026-08-09T00:00:00.000Z","payload":{"serverName":"s","serverVersion":"1","schemaVersion":"vem-vision-v2-contract-bundle/v1","bundleVersion":"1","contractDigest":"f5c86bc2def1a41328cccf7c2e864452fe2913265b99f36139d64c9c9028a386","cameraReady":true,"fastReady":true,"visionBusinessReady":true,"businessReadinessDiagnostic":"ready","capabilities":[]},"unexpected":true}"#
                        .into(),
                ))
                .await
                .expect("send");
        });

        let result = check_ready(&ws_url, None, 2000).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("unknown field"));
    }

    #[tokio::test]
    async fn check_ready_rejects_non_rfc3339_server_timestamp() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listen");
        let addr = listener.local_addr().expect("local addr");
        let ws_url = format!("ws://{addr}/");

        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let mut ws_stream = accept_async(stream).await.expect("accept ws");
            let _ = ws_stream.next().await.expect("next");
            ws_stream
                .send(Message::Text(
                    r#"{"protocol":"vem.vision.v2","type":"vision.ready","messageId":"550e8400-e29b-41d4-a716-446655440124","timestamp":"not-a-timestamp","payload":{"serverName":"s","serverVersion":"1","schemaVersion":"vem-vision-v2-contract-bundle/v1","bundleVersion":"1","contractDigest":"f5c86bc2def1a41328cccf7c2e864452fe2913265b99f36139d64c9c9028a386","cameraReady":true,"fastReady":true,"visionBusinessReady":true,"businessReadinessDiagnostic":"ready","capabilities":[]}}"#
                        .into(),
                ))
                .await
                .expect("send");
        });

        let result = check_ready(&ws_url, None, 2000).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("timestamp"));
    }

    #[tokio::test]
    async fn check_ready_rejects_unknown_readiness_diagnostic() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listen");
        let addr = listener.local_addr().expect("local addr");
        let ws_url = format!("ws://{addr}/");

        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let mut ws_stream = accept_async(stream).await.expect("accept ws");
            let _ = ws_stream.next().await.expect("next");
            ws_stream
                .send(Message::Text(
                    r#"{"protocol":"vem.vision.v2","type":"vision.ready","messageId":"550e8400-e29b-41d4-a716-446655440124","timestamp":"2026-08-09T00:00:00.000Z","payload":{"serverName":"s","serverVersion":"1","schemaVersion":"vem-vision-v2-contract-bundle/v1","bundleVersion":"1","contractDigest":"f5c86bc2def1a41328cccf7c2e864452fe2913265b99f36139d64c9c9028a386","cameraReady":true,"fastReady":true,"visionBusinessReady":true,"businessReadinessDiagnostic":"unrecognized","capabilities":[]}}"#
                        .into(),
                ))
                .await
                .expect("send");
        });

        let result = check_ready(&ws_url, None, 2000).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("unknown variant"));
    }

    #[tokio::test]
    async fn connected_session_receives_runtime_events_after_ready() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listen");
        let addr = listener.local_addr().expect("local addr");
        let ws_url = format!("ws://{addr}/");

        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let mut ws_stream = accept_async(stream).await.expect("accept ws");
            let _ = ws_stream.next().await.expect("next").expect("hello");
            ws_stream
                .send(Message::Text(
                    r#"{"protocol":"vem.vision.v2","type":"vision.ready","messageId":"550e8400-e29b-41d4-a716-446655440123","timestamp":"2026-08-09T00:00:00.000Z","payload":{"serverName":"s","serverVersion":"1","schemaVersion":"vem-vision-v2-contract-bundle/v1","bundleVersion":"1","contractDigest":"f5c86bc2def1a41328cccf7c2e864452fe2913265b99f36139d64c9c9028a386","cameraReady":true,"fastReady":true,"visionBusinessReady":true,"businessReadinessDiagnostic":"ready","capabilities":["person_departed"]}}"#.into(),
                ))
                .await
                .expect("send ready");
            ws_stream
                .send(Message::Text(
                    r#"{"protocol":"vem.vision.v2","type":"vision.person_departed","messageId":"550e8400-e29b-41d4-a716-446655440124","timestamp":"2026-08-09T00:00:00.000Z","payload":{"eventId":"departure-1","detectedAt":"2026-07-19T00:00:00.000Z","lastSeenAt":null}}"#.into(),
                ))
                .await
                .expect("send departure");
        });

        let (mut session, ready) = connect_session(&ws_url, Some("M-1".to_string()), 2000)
            .await
            .expect("session");
        assert!(ready.camera_ready);
        let event = session.next_event().await.expect("runtime event");
        assert_eq!(event.message_type, "vision.person_departed");
        assert_eq!(event.payload["eventId"], "departure-1");
    }
}

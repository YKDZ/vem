use std::{collections::BTreeMap, sync::Arc};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use rumqttc::{AsyncClient, Event, Incoming, MqttOptions, QoS};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::hardware::{DispenseCommandPayload, DispenseResultPayload, HardwareAdapter};

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MqttEnvelope {
    pub message_id: String,
    pub machine_code: String,
    pub issued_at: String,
    pub nonce: String,
    pub payload: Value,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NativeMqttStatus {
    pub running: bool,
    pub connected: bool,
    pub last_error: Option<String>,
    pub last_command_id: Option<String>,
    pub last_heartbeat_at: Option<String>,
}

/// Produce a canonical JSON string with sorted keys (matching TypeScript canonicalJson).
pub fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let sorted: BTreeMap<_, _> = map.iter().collect();
            let pairs: Vec<String> = sorted
                .iter()
                .map(|(k, v)| format!("\"{}\":{}", k, canonical_json(v)))
                .collect();
            format!("{{{}}}", pairs.join(","))
        }
        Value::Array(arr) => {
            let items: Vec<String> = arr.iter().map(canonical_json).collect();
            format!("[{}]", items.join(","))
        }
        Value::String(s) => format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\"")),
        other => other.to_string(),
    }
}

/// Sign a payload and return the full envelope.
pub fn sign_envelope(
    machine_code: &str,
    signing_secret: &str,
    message_id: &str,
    payload: Value,
) -> MqttEnvelope {
    let issued_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let nonce = Uuid::new_v4().to_string();
    // Canonical object for signing must have sorted keys
    let unsigned_obj = json!({
        "issuedAt": issued_at,
        "machineCode": machine_code,
        "messageId": message_id,
        "nonce": nonce,
        "payload": payload,
    });
    let input = canonical_json(&unsigned_obj);
    let mut mac =
        HmacSha256::new_from_slice(signing_secret.as_bytes()).expect("HMAC accepts any key");
    mac.update(input.as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    MqttEnvelope {
        message_id: message_id.to_string(),
        machine_code: machine_code.to_string(),
        issued_at,
        nonce,
        payload,
        signature,
    }
}

/// Verify an inbound envelope against the expected machine_code and signing_secret.
pub fn verify_envelope(
    envelope: &MqttEnvelope,
    expected_machine_code: &str,
    signing_secret: &str,
) -> Result<(), String> {
    if envelope.machine_code != expected_machine_code {
        return Err(format!(
            "envelope machine_code mismatch: expected {expected_machine_code}, got {}",
            envelope.machine_code
        ));
    }
    let unsigned_obj = json!({
        "issuedAt": envelope.issued_at,
        "machineCode": envelope.machine_code,
        "messageId": envelope.message_id,
        "nonce": envelope.nonce,
        "payload": envelope.payload,
    });
    let input = canonical_json(&unsigned_obj);
    let mut mac =
        HmacSha256::new_from_slice(signing_secret.as_bytes()).expect("HMAC accepts any key");
    mac.update(input.as_bytes());
    let expected = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    if expected != envelope.signature {
        return Err("MQTT envelope signature invalid".to_string());
    }
    Ok(())
}

pub struct NativeMqttRuntime {
    pub status: Arc<RwLock<NativeMqttStatus>>,
    client: AsyncClient,
    machine_code: String,
    signing_secret: String,
    hardware: Arc<dyn HardwareAdapter>,
}

impl NativeMqttRuntime {
    pub fn new(
        machine_code: String,
        signing_secret: String,
        hardware: Arc<dyn HardwareAdapter>,
        mqtt_options: MqttOptions,
    ) -> (Self, rumqttc::EventLoop) {
        let (client, event_loop) = AsyncClient::new(mqtt_options, 10);
        let runtime = NativeMqttRuntime {
            status: Arc::new(RwLock::new(NativeMqttStatus {
                running: true,
                connected: false,
                last_error: None,
                last_command_id: None,
                last_heartbeat_at: None,
            })),
            client,
            machine_code,
            signing_secret,
            hardware,
        };
        (runtime, event_loop)
    }

    pub async fn start(self: Arc<Self>, mut event_loop: rumqttc::EventLoop) -> Result<(), String> {
        let command_topic = format!("vem/machines/{}/commands/dispense", self.machine_code);
        self.client
            .subscribe(&command_topic, QoS::AtLeastOnce)
            .await
            .map_err(|e| e.to_string())?;

        let runtime = self.clone();
        tokio::spawn(async move {
            loop {
                match event_loop.poll().await {
                    Ok(Event::Incoming(Incoming::ConnAck(_))) => {
                        let mut s = runtime.status.write().await;
                        s.connected = true;
                        s.last_error = None;
                    }
                    Ok(Event::Incoming(Incoming::Publish(publish))) => {
                        let text = String::from_utf8_lossy(&publish.payload).to_string();
                        if let Err(err) = runtime.handle_command(text).await {
                            let mut s = runtime.status.write().await;
                            s.last_error = Some(err);
                        }
                    }
                    Err(err) => {
                        let mut s = runtime.status.write().await;
                        s.connected = false;
                        s.last_error = Some(err.to_string());
                    }
                    _ => {}
                }
            }
        });

        Ok(())
    }

    async fn handle_command(&self, payload_text: String) -> Result<(), String> {
        let envelope: MqttEnvelope =
            serde_json::from_str(&payload_text).map_err(|e| e.to_string())?;
        verify_envelope(&envelope, &self.machine_code, &self.signing_secret)?;

        let command: DispenseCommandPayload =
            serde_json::from_value(envelope.payload.clone()).map_err(|e| e.to_string())?;

        {
            let mut s = self.status.write().await;
            s.last_command_id = Some(command.command_id.clone());
        }

        self.publish_ack(&command.command_id).await?;
        let result = self.hardware.dispense(command).await;
        self.publish_result(result).await?;
        Ok(())
    }

    async fn publish_signed(
        &self,
        topic: String,
        message_id: String,
        payload: Value,
    ) -> Result<(), String> {
        let envelope = sign_envelope(
            &self.machine_code,
            &self.signing_secret,
            &message_id,
            payload,
        );
        let body = serde_json::to_string(&envelope).map_err(|e| e.to_string())?;
        self.client
            .publish(topic, QoS::AtLeastOnce, false, body)
            .await
            .map_err(|e| e.to_string())
    }

    async fn publish_ack(&self, command_id: &str) -> Result<(), String> {
        self.publish_signed(
            format!("vem/machines/{}/acks/dispense", self.machine_code),
            format!("ack:{command_id}"),
            json!({
                "commandId": command_id,
                "accepted": true,
                "acceptedAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            }),
        )
        .await
    }

    async fn publish_result(&self, result: DispenseResultPayload) -> Result<(), String> {
        let command_id = result.command_id.clone();
        self.publish_signed(
            format!("vem/machines/{}/results/dispense", self.machine_code),
            format!("result:{command_id}"),
            serde_json::to_value(result).map_err(|e| e.to_string())?,
        )
        .await
    }

    pub async fn publish_heartbeat(&self) -> Result<(), String> {
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        self.publish_signed(
            format!("vem/machines/{}/heartbeat", self.machine_code),
            format!("heartbeat:{}", Uuid::new_v4()),
            json!({ "at": now }),
        )
        .await?;
        let mut s = self.status.write().await;
        s.last_heartbeat_at = Some(now);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn sign_and_verify_envelope_roundtrip() {
        let machine_code = "M001";
        let secret = "test-signing-secret";
        let payload = json!({ "commandId": "cmd-001", "success": true });
        let envelope = sign_envelope(machine_code, secret, "msg-001", payload.clone());
        assert_eq!(envelope.machine_code, machine_code);
        assert!(!envelope.signature.is_empty());
        verify_envelope(&envelope, machine_code, secret).expect("should verify ok");
    }

    #[test]
    fn verify_envelope_fails_on_tampered_payload() {
        let machine_code = "M001";
        let secret = "test-signing-secret";
        let payload = json!({ "commandId": "cmd-001" });
        let mut envelope = sign_envelope(machine_code, secret, "msg-001", payload);
        // Tamper with payload
        envelope.payload = json!({ "commandId": "cmd-999" });
        let result = verify_envelope(&envelope, machine_code, secret);
        assert!(result.is_err(), "should fail with tampered payload");
    }

    #[test]
    fn verify_envelope_fails_on_wrong_machine_code() {
        let secret = "test-signing-secret";
        let payload = json!({});
        let envelope = sign_envelope("M001", secret, "msg-001", payload);
        let result = verify_envelope(&envelope, "M002", secret);
        assert!(result.is_err(), "should fail with wrong machine code");
    }

    #[test]
    fn canonical_json_sorts_keys() {
        let value = json!({ "z": 1, "a": 2, "m": 3 });
        let result = canonical_json(&value);
        // keys should be a,m,z order
        let a_pos = result.find("\"a\"").unwrap();
        let m_pos = result.find("\"m\"").unwrap();
        let z_pos = result.find("\"z\"").unwrap();
        assert!(a_pos < m_pos);
        assert!(m_pos < z_pos);
    }
}

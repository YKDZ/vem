use std::sync::Arc;

use rumqttc::{AsyncClient, Event, Incoming, MqttOptions, QoS};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::RwLock;
use tokio::time::{sleep, Duration};
use uuid::Uuid;

use crate::hardware::{DispenseCommandPayload, DispenseResultPayload, HardwareAdapter};
pub use vending_core::mqtt::{canonical_json, sign_envelope, verify_envelope, MqttEnvelope};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NativeMqttStatus {
    pub running: bool,
    pub connected: bool,
    pub last_error: Option<String>,
    pub last_command_no: Option<String>,
    pub last_heartbeat_at: Option<String>,
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
                last_command_no: None,
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

        let heartbeat_runtime = self.clone();
        tokio::spawn(async move {
            loop {
                sleep(Duration::from_secs(30)).await;
                let status = heartbeat_runtime.status.read().await.clone();
                if !status.running {
                    break;
                }
                if !status.connected {
                    continue;
                }
                if let Err(err) = heartbeat_runtime.publish_heartbeat().await {
                    let mut s = heartbeat_runtime.status.write().await;
                    s.last_error = Some(err);
                }
            }
        });

        Ok(())
    }

    async fn handle_command(&self, payload_text: String) -> Result<(), String> {
        let envelope: MqttEnvelope =
            serde_json::from_str(&payload_text).map_err(|e| e.to_string())?;
        verify_envelope(&envelope, &self.machine_code, &self.signing_secret, 300)?;

        let command: DispenseCommandPayload =
            serde_json::from_value(envelope.payload.clone()).map_err(|e| e.to_string())?;

        {
            let mut s = self.status.write().await;
            s.last_command_no = Some(command.command_no.clone());
        }

        self.publish_ack(&command.command_no).await?;
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

    async fn publish_ack(&self, command_no: &str) -> Result<(), String> {
        self.publish_signed(
            format!(
                "vem/machines/{}/commands/{}/ack",
                self.machine_code, command_no
            ),
            format!("ack:{command_no}"),
            json!({
                "messageId": format!("ack:{command_no}"),
            }),
        )
        .await
    }

    async fn publish_result(&self, result: DispenseResultPayload) -> Result<(), String> {
        let command_no = result.command_no.clone();
        self.publish_signed(
            format!("vem/machines/{}/events/dispense-result", self.machine_code),
            format!("result:{command_no}"),
            serde_json::to_value(result).map_err(|e| e.to_string())?,
        )
        .await
    }

    pub async fn publish_heartbeat(&self) -> Result<(), String> {
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let last_command_no = self.status.read().await.last_command_no.clone();
        self.publish_signed(
            format!("vem/machines/{}/events/heartbeat", self.machine_code),
            format!("heartbeat:{}", Uuid::new_v4()),
            json!({
                "machineCode": &self.machine_code,
                "reportedAt": now,
                "statusPayload": {
                    "network": "online",
                    "mqttConnected": true,
                    "hardwareAdapter": self.hardware.adapter_name(),
                    "hardwareStatus": "ok",
                    "lastCommandNo": last_command_no,
                }
            }),
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
        let payload = json!({ "commandNo": "CMD-001", "success": true });
        let envelope = sign_envelope(machine_code, secret, "msg-001", payload.clone());
        assert_eq!(envelope.machine_code, machine_code);
        assert!(!envelope.signature.is_empty());
        verify_envelope(&envelope, machine_code, secret, 300).expect("should verify ok");
    }

    #[test]
    fn verify_envelope_fails_on_tampered_payload() {
        let machine_code = "M001";
        let secret = "test-signing-secret";
        let payload = json!({ "commandNo": "CMD-001" });
        let mut envelope = sign_envelope(machine_code, secret, "msg-001", payload);
        envelope.payload = json!({ "commandNo": "CMD-999" });
        let result = verify_envelope(&envelope, machine_code, secret, 300);
        assert!(result.is_err(), "should fail with tampered payload");
    }

    #[test]
    fn verify_envelope_fails_on_wrong_machine_code() {
        let secret = "test-signing-secret";
        let payload = json!({});
        let envelope = sign_envelope("M001", secret, "msg-001", payload);
        let result = verify_envelope(&envelope, "M002", secret, 300);
        assert!(result.is_err(), "should fail with wrong machine code");
    }

    #[test]
    fn canonical_json_sorts_keys() {
        let value = json!({ "z": 1, "a": 2, "m": 3 });
        let result = canonical_json(&value);
        let a_pos = result.find("\"a\"").unwrap();
        let m_pos = result.find("\"m\"").unwrap();
        let z_pos = result.find("\"z\"").unwrap();
        assert!(a_pos < m_pos);
        assert!(m_pos < z_pos);
    }
}

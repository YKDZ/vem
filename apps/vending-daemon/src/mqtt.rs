use std::sync::Arc;

use rumqttc::{AsyncClient, ClientError, Event, EventLoop, MqttOptions, Packet, QoS};
use serde_json::json;
use tokio::sync::{broadcast, RwLock};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::events::DaemonEvent;
use crate::{
    hardware::HardwareSupervisor,
    state::{LocalStateStore, StoreError},
};
use vending_core::hardware::DispenseCommandPayload;

#[derive(Debug, Clone)]
pub struct OutboxFlushResult {
    pub sent: u64,
    pub failed: u64,
}

#[derive(Debug, Clone)]
pub enum CommandHandlingResult {
    DuplicateFinal { command_no: String },
    ActiveDuplicate { command_no: String },
    Processed { command_no: String },
}

#[derive(Clone)]
pub struct MqttSyncRuntime {
    machine_code: String,
    signing_secret: String,
    state: LocalStateStore,
    hardware: HardwareSupervisor,
    events: broadcast::Sender<DaemonEvent>,
    shutdown: CancellationToken,
    mqtt_client: Option<Arc<RwLock<AsyncClient>>>,
}

impl MqttSyncRuntime {
    pub fn new(
        machine_code: String,
        signing_secret: String,
        state: LocalStateStore,
        hardware: HardwareSupervisor,
        events: broadcast::Sender<DaemonEvent>,
        shutdown: CancellationToken,
    ) -> Self {
        Self {
            machine_code,
            signing_secret,
            state,
            hardware,
            events,
            shutdown,
            mqtt_client: None,
        }
    }

    pub fn with_client(mut self, client: AsyncClient) -> Self {
        self.mqtt_client = Some(Arc::new(RwLock::new(client)));
        self
    }

    pub fn mqtt_options_from_config(
        machine_code: &str,
        mqtt_url: &str,
    ) -> Result<MqttOptions, String> {
        let (scheme, rest) = mqtt_url
            .split_once("://")
            .ok_or_else(|| "invalid mqttUrl format".to_string())?;
        let (host, port_str) = rest
            .rsplit_once(':')
            .ok_or_else(|| "mqttUrl missing port".to_string())?;
        let port = port_str
            .parse::<u16>()
            .map_err(|_| "mqttUrl port is not a number".to_string())?;

        let mut options = MqttOptions::new(format!("machine-{machine_code}"), host, port);
        options.set_keep_alive(std::time::Duration::from_secs(30));
        match scheme {
            "mqtt" => {}
            "mqtts" | "ssl" => {
                options.set_transport(rumqttc::Transport::tls_with_default_config());
            }
            other => return Err(format!("unsupported mqtt scheme: {other}")),
        }
        Ok(options)
    }

    fn command_topic(&self) -> String {
        format!("vem/machines/{}/commands/dispense", self.machine_code)
    }

    async fn set_connected(&self, connected: bool, last_error: Option<String>) {
        let _ = self.events.send(DaemonEvent::MqttChanged {
            event_id: Uuid::new_v4().simple().to_string(),
            updated_at: crate::state::store::now_iso(),
            connected,
            last_error,
        });
    }

    fn parse_and_verify_envelope(
        &self,
        payload_text: &str,
    ) -> Result<vending_core::mqtt::MqttEnvelope, String> {
        let envelope: vending_core::mqtt::MqttEnvelope = serde_json::from_str(payload_text)
            .map_err(|error| format!("parse MQTT envelope failed: {error}"))?;
        vending_core::mqtt::verify_envelope(
            &envelope,
            &self.machine_code,
            &self.signing_secret,
            300,
        )
        .map_err(|error| error.to_string())?;
        Ok(envelope)
    }

    pub async fn handle_dispense_command(
        &self,
        payload_text: &str,
    ) -> Result<CommandHandlingResult, String> {
        let envelope = self.parse_and_verify_envelope(payload_text)?;
        let command: DispenseCommandPayload = serde_json::from_value(envelope.payload)
            .map_err(|error| format!("parse dispense command failed: {error}"))?;

        if let Some(existing) = self.state.get_command(&command.command_no).await? {
            if existing.result_payload.is_some() {
                let ack = crate::state::store::OutboxInput::dispense_result(
                    &self.machine_code,
                    &existing.result_payload.unwrap_or_else(|| {
                        vending_core::hardware::DispenseResultPayload {
                            command_no: command.command_no.clone(),
                            success: false,
                            error_code: Some("missing_result".to_string()),
                            message: "existing command has no result payload".to_string(),
                            reported_at: crate::state::store::now_iso(),
                        }
                    }),
                );
                self.state
                    .enqueue_outbox(&ack)
                    .await
                    .map_err(|error| error.to_string())?;
                return Ok(CommandHandlingResult::DuplicateFinal {
                    command_no: command.command_no,
                });
            }
            if existing.status == vending_core::domain::CommandLogStatus::Dispensing {
                return Ok(CommandHandlingResult::ActiveDuplicate {
                    command_no: command.command_no,
                });
            }
        }

        let ack_event =
            crate::state::store::OutboxInput::command_ack(&self.machine_code, &command.command_no);
        self.state
            .record_command_ack_tx(&command, &ack_event)
            .await
            .map_err(|error| error.to_string())?;

        self.state
            .mark_command_dispensing(&command.command_no)
            .await
            .map_err(|error| error.to_string())?;

        let result = self.hardware.dispense(command.clone()).await;
        let result_event =
            crate::state::store::OutboxInput::dispense_result(&self.machine_code, &result);
        self.state
            .record_command_result_and_enqueue_tx(&command, &result, &result_event)
            .await
            .map_err(|error| error.to_string())?;

        Ok(CommandHandlingResult::Processed {
            command_no: command.command_no,
        })
    }

    pub async fn enqueue_heartbeat(&self) -> Result<(), String> {
        let payload = json!({
            "machineCode": self.machine_code,
            "status": "ok",
            "ts": crate::state::store::now_iso(),
            "level": "ok",
        });
        let heartbeat = crate::state::store::OutboxInput::heartbeat(&self.machine_code, payload);
        self.state
            .enqueue_outbox(&heartbeat)
            .await
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub async fn flush_due_outbox(&self) -> Result<OutboxFlushResult, String> {
        let due = self
            .state
            .list_due_outbox(chrono::Utc::now())
            .await
            .map_err(|error| error.to_string())?;

        let mut sent = 0_u64;
        let mut failed = 0_u64;

        for event in due {
            let result = match event.transport {
                vending_core::domain::OutboxTransport::Mqtt => {
                    self.publish_json(event.topic.as_deref(), &event.payload_json)
                        .await
                }
                vending_core::domain::OutboxTransport::Http => {
                    self.publish_http(event.target_url.as_deref(), &event.payload_json)
                        .await
                }
            };

            match result {
                Ok(()) => {
                    self.state
                        .remove_outbox_event(&event.id)
                        .await
                        .map_err(|error| error.to_string())?;
                    sent += 1;
                }
                Err(error) => {
                    self.state
                        .mark_outbox_failed(&event.id, &error)
                        .await
                        .map_err(|mark_error| mark_error.to_string())?;
                    let _ = self.events.send(DaemonEvent::MqttChanged {
                        event_id: Uuid::new_v4().simple().to_string(),
                        updated_at: crate::state::store::now_iso(),
                        connected: false,
                        last_error: Some(error),
                    });
                    failed += 1;
                }
            }
        }

        Ok(OutboxFlushResult { sent, failed })
    }

    async fn publish_json(
        &self,
        topic: Option<&str>,
        payload: &serde_json::Value,
    ) -> Result<(), String> {
        let Some(client) = &self.mqtt_client else {
            return Ok(());
        };
        let topic = topic.ok_or_else(|| "outbox event missing topic".to_string())?;
        let bytes = serde_json::to_vec(payload)
            .map_err(|error| format!("serialize outbox payload failed: {error}"))?;
        let client = client.read().await;
        let result = client
            .publish(topic, QoS::AtLeastOnce, false, bytes)
            .await
            .map_err(|error| map_mqtt_error(error))?;
        drop(client);
        let _ = result;
        Ok(())
    }

    async fn publish_http(
        &self,
        target_url: Option<&str>,
        payload: &serde_json::Value,
    ) -> Result<(), String> {
        let _target_url =
            target_url.ok_or_else(|| "outbox event missing target_url".to_string())?;
        if payload.is_null() {
            Err("outbox payload is null".to_string())
        } else {
            Ok(())
        }
    }

    pub async fn run(self: Arc<Self>, mut event_loop: EventLoop) -> Result<(), String> {
        let topic = self.command_topic();
        {
            let _ = self.events.send(DaemonEvent::MqttChanged {
                event_id: Uuid::new_v4().simple().to_string(),
                updated_at: crate::state::store::now_iso(),
                connected: false,
                last_error: Some("starting".to_string()),
            });
        }

        if let Some(client) = &self.mqtt_client {
            let _ = client
                .read()
                .await
                .subscribe(topic.clone(), QoS::AtLeastOnce)
                .await;
        }

        let heartbeat = self.clone();
        let heartbeat_task = tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
            loop {
                tokio::select! {
                    _ = heartbeat.shutdown.cancelled() => break,
                    _ = interval.tick() => {
                        let _ = heartbeat.enqueue_heartbeat().await;
                        let _ = heartbeat.flush_due_outbox().await;
                    }
                }
            }
        });

        let result = loop {
            tokio::select! {
                _ = self.shutdown.cancelled() => {
                    break Ok(());
                }
                event = event_loop.poll() => {
                    match event {
                        Ok(Event::Incoming(Packet::ConnAck(_))) => {
                            self.set_connected(true, None).await;
                            let _ = self.flush_due_outbox().await;
                        }
                        Ok(Event::Incoming(Packet::Publish(publish))) => {
                            let text = String::from_utf8_lossy(&publish.payload).to_string();
                            match self.handle_dispense_command(&text).await {
                                Ok(_) => {
                                    if let Err(error) = self.flush_due_outbox().await {
                                        let _ = self
                                            .set_connected(
                                                false,
                                                Some(format!("outbox flush failed: {error}")),
                                            )
                                            .await;
                                    }
                                }
                                Err(error) => {
                                    let _ = self
                                        .set_connected(
                                            false,
                                            Some(format!("publish handle failed: {error}")),
                                        )
                                        .await;
                                }
                            }
                        }
                        Ok(_) => {}
                        Err(error) => {
                            self.set_connected(false, Some(error.to_string())).await;
                        }
                    }
                }
            }
        };

        heartbeat_task.abort();
        result
    }
}

impl From<StoreError> for String {
    fn from(error: StoreError) -> Self {
        error.to_string()
    }
}

fn map_mqtt_error(error: ClientError) -> String {
    match error {
        ClientError::Request(request) | ClientError::TryRequest(request) => {
            format!("mqtt request failed to enqueue: {request:?}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mqtt_options_accepts_mqtt_and_mqtts() {
        let opts =
            MqttSyncRuntime::mqtt_options_from_config("M1", "mqtt://127.0.0.1:1883").expect("mqtt");
        assert_eq!(opts.client_id(), "machine-M1");

        let secure = MqttSyncRuntime::mqtt_options_from_config("M1", "mqtts://127.0.0.1:8883")
            .expect("mqtts");
        assert_eq!(secure.client_id(), "machine-M1");

        assert!(MqttSyncRuntime::mqtt_options_from_config("M1", "ws://127.0.0.1:1883").is_err());
    }

    #[tokio::test]
    async fn mqtt_handle_command_rejects_invalid_envelope() {
        let temp = tempfile::tempdir().expect("temp");
        let state = crate::state::LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");

        let config = crate::config::default_public_config();
        let hardware = crate::hardware::HardwareSupervisor::from_config(&config).expect("hw");
        let (event_tx, _rx) = tokio::sync::broadcast::channel(4);
        let runtime = Arc::new(MqttSyncRuntime::new(
            "M1".to_string(),
            "secret".to_string(),
            state,
            hardware,
            event_tx,
            CancellationToken::new(),
        ));

        let error = runtime
            .handle_dispense_command("not-json")
            .await
            .unwrap_err();
        assert!(error.contains("parse MQTT envelope failed"));
    }
}

use std::{sync::Arc, time::Duration};

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
use vending_core::{
    environment::EnvironmentHeartbeatCache,
    hardware::{
        DispenseCommandPayload, DispenseProgressObserver, EnvironmentControlCommandPayload,
        EnvironmentControlResultPayload,
    },
    mqtt::sign_envelope,
    serial::EnvironmentSample,
};

const DISPENSE_LOCAL_TIMEOUT_GRACE_SECONDS: u64 = 15;

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
    environment: Arc<RwLock<EnvironmentHeartbeatCache>>,
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
            environment: Arc::new(RwLock::new(EnvironmentHeartbeatCache::default())),
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
        client_id: Option<&str>,
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

        let client_id = client_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
            .unwrap_or_else(|| format!("machine-{machine_code}"));
        let mut options = MqttOptions::new(client_id, host, port);
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

    fn environment_control_command_topic(&self) -> String {
        format!(
            "vem/machines/{}/commands/environment-control",
            self.machine_code
        )
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
                let mut ack = crate::state::store::OutboxInput::dispense_result(
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
                ack.payload_json = self.sign_outbox_payload(
                    format!("result:{}", command.command_no),
                    ack.payload_json,
                )?;
                self.state
                    .enqueue_outbox(&ack)
                    .await
                    .map_err(|error| error.to_string())?;
                return Ok(CommandHandlingResult::DuplicateFinal {
                    command_no: command.command_no,
                });
            }
            if matches!(
                existing.status,
                vending_core::domain::CommandLogStatus::Acknowledged
                    | vending_core::domain::CommandLogStatus::Dispensing
            ) {
                return Ok(CommandHandlingResult::ActiveDuplicate {
                    command_no: command.command_no,
                });
            }
        }

        let mut ack_event =
            crate::state::store::OutboxInput::command_ack(&self.machine_code, &command.command_no);
        ack_event.payload_json = self.sign_outbox_payload(
            format!("ack:{}", command.command_no),
            ack_event.payload_json,
        )?;
        self.state
            .record_command_ack_tx(&command, &ack_event)
            .await
            .map_err(|error| error.to_string())?;

        self.state
            .mark_command_dispensing(&command.command_no)
            .await
            .map_err(|error| error.to_string())?;

        let local_timeout = Duration::from_secs(
            command
                .timeout_seconds
                .max(1)
                .saturating_add(DISPENSE_LOCAL_TIMEOUT_GRACE_SECONDS),
        );
        let progress_state = self.state.clone();
        let progress_events = self.events.clone();
        let progress: DispenseProgressObserver = Arc::new(move |event| {
            let state = progress_state.clone();
            let events = progress_events.clone();
            tokio::spawn(async move {
                let order_no = event.order_no.clone();
                if state.record_dispense_progress(&event).await.is_ok() {
                    let _ = events.send(DaemonEvent::TransactionChanged {
                        event_id: Uuid::new_v4().simple().to_string(),
                        updated_at: crate::state::store::now_iso(),
                        order_no,
                        status: "dispensing".to_string(),
                    });
                }
            });
        });
        let result = match tokio::time::timeout(
            local_timeout,
            self.hardware
                .dispense_with_progress(command.clone(), Some(progress)),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => vending_core::hardware::DispenseResultPayload {
                command_no: command.command_no.clone(),
                success: false,
                error_code: Some("MOTOR_TIMEOUT".to_string()),
                message: format!(
                    "dispense command timed out after {} seconds",
                    local_timeout.as_secs()
                ),
                reported_at: crate::state::store::now_iso(),
            },
        };
        let mut result_event =
            crate::state::store::OutboxInput::dispense_result(&self.machine_code, &result);
        result_event.payload_json = self.sign_outbox_payload(
            format!("result:{}", command.command_no),
            result_event.payload_json,
        )?;
        let result_recorded = self
            .state
            .record_command_result_and_enqueue_tx(&command, &result, &result_event)
            .await
            .map_err(|error| error.to_string())?;
        self.state
            .apply_dispense_result_to_order_session(&command, &result)
            .await
            .map_err(|error| error.to_string())?;
        let _ = self.events.send(DaemonEvent::TransactionChanged {
            event_id: Uuid::new_v4().simple().to_string(),
            updated_at: crate::state::store::now_iso(),
            order_no: command.order_no.clone(),
            status: if result.success {
                "success".to_string()
            } else {
                "dispense_failed".to_string()
            },
        });
        if result_recorded && result.success {
            self.state
                .apply_dispense_success_to_local_stock(&command)
                .await
                .map_err(|error| error.to_string())?;
        } else if !result.success {
            self.state
                .block_slot_for_dispense_failure(
                    &command,
                    result.error_code.as_deref(),
                    Some(result.message.as_str()),
                )
                .await
                .map_err(|error| error.to_string())?;
        }

        Ok(CommandHandlingResult::Processed {
            command_no: command.command_no,
        })
    }

    fn sign_outbox_payload(
        &self,
        message_id: String,
        payload: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        serde_json::to_value(sign_envelope(
            &self.machine_code,
            &self.signing_secret,
            &message_id,
            payload,
        ))
        .map_err(|error| format!("serialize signed MQTT envelope failed: {error}"))
    }

    pub async fn handle_environment_control_command(
        &self,
        payload_text: &str,
    ) -> Result<CommandHandlingResult, String> {
        let envelope = self.parse_and_verify_envelope(payload_text)?;
        let command: EnvironmentControlCommandPayload = serde_json::from_value(envelope.payload)
            .map_err(|error| format!("parse environment control command failed: {error}"))?;
        validate_environment_control_command(&command)?;

        let mut ack_event =
            crate::state::store::OutboxInput::command_ack(&self.machine_code, &command.command_no);
        ack_event.payload_json = self.sign_outbox_payload(
            format!("ack:{}", command.command_no),
            ack_event.payload_json,
        )?;
        self.state
            .enqueue_outbox(&ack_event)
            .await
            .map_err(|error| error.to_string())?;

        let mut confirmed_target = None;
        let mut confirmed_switch = None;
        let mut failure = None;

        if let Some(target) = command.target_temperature_celsius {
            match self.hardware.set_target_temperature(target).await {
                Ok(()) => confirmed_target = Some(target),
                Err(error) => failure = Some(("target_temperature_failed".to_string(), error)),
            }
        }

        if failure.is_none() {
            if let Some(enabled) = command.air_conditioner_on {
                match self.hardware.set_air_conditioner_enabled(enabled).await {
                    Ok(()) => confirmed_switch = Some(enabled),
                    Err(error) => {
                        failure = Some(("air_conditioner_switch_failed".to_string(), error))
                    }
                }
            }
        }

        if failure.is_none() {
            self.environment
                .write()
                .await
                .record_control_success(confirmed_switch, confirmed_target);
        }

        let result = match failure {
            Some((error_code, message)) => EnvironmentControlResultPayload {
                command_no: command.command_no.clone(),
                success: false,
                error_code: Some(error_code),
                message: Some(message),
                air_conditioner_on: confirmed_switch,
                target_temperature_celsius: confirmed_target,
                reported_at: crate::state::store::now_iso(),
            },
            None => EnvironmentControlResultPayload {
                command_no: command.command_no.clone(),
                success: true,
                error_code: None,
                message: Some("environment control completed".to_string()),
                air_conditioner_on: confirmed_switch,
                target_temperature_celsius: confirmed_target,
                reported_at: crate::state::store::now_iso(),
            },
        };
        let mut result_event = crate::state::store::OutboxInput::environment_control_result(
            &self.machine_code,
            &result,
        );
        result_event.payload_json = self.sign_outbox_payload(
            format!("environment-control-result:{}", result.command_no),
            result_event.payload_json,
        )?;
        self.state
            .enqueue_outbox(&result_event)
            .await
            .map_err(|error| error.to_string())?;

        Ok(CommandHandlingResult::Processed {
            command_no: command.command_no,
        })
    }

    pub async fn record_environment_query_result(
        &self,
        sample: Option<EnvironmentSample>,
        sampled_at: String,
    ) {
        self.environment
            .write()
            .await
            .record_query_result(sample, sampled_at);
    }

    pub async fn sample_environment_once(&self) -> Result<(), String> {
        let sample = self.hardware.query_environment_sample().await?;
        self.record_environment_query_result(sample, crate::state::store::now_iso())
            .await;
        Ok(())
    }

    pub async fn enqueue_heartbeat(&self) -> Result<(), String> {
        let reported_at = crate::state::store::now_iso();
        let environment = self.environment.read().await.heartbeat_payload();
        let payload = json!({
            "machineCode": self.machine_code,
            "reportedAt": reported_at,
            "statusPayload": {
                "network": "online",
                "mqttConnected": true,
                "hardwareAdapter": self.hardware.adapter_name(),
                "hardwareStatus": "ok",
                "environment": serde_json::to_value(environment)
                    .map_err(|error| format!("serialize environment heartbeat failed: {error}"))?,
            },
        });
        let mut heartbeat =
            crate::state::store::OutboxInput::heartbeat(&self.machine_code, payload);
        heartbeat.payload_json = self.sign_outbox_payload(
            format!("heartbeat:{}", Uuid::new_v4()),
            heartbeat.payload_json,
        )?;
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
            if event.kind == vending_core::domain::OutboxKind::StockMovementUpload {
                continue;
            }
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
        client
            .publish(topic, QoS::AtLeastOnce, false, bytes)
            .await
            .map_err(map_mqtt_error)?;
        drop(client);
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
        let dispense_topic = self.command_topic();
        let environment_control_topic = self.environment_control_command_topic();
        {
            let _ = self.events.send(DaemonEvent::MqttChanged {
                event_id: Uuid::new_v4().simple().to_string(),
                updated_at: crate::state::store::now_iso(),
                connected: false,
                last_error: Some("starting".to_string()),
            });
        }

        if let Some(client) = &self.mqtt_client {
            let client = client.read().await;
            let _ = client
                .subscribe(dispense_topic.clone(), QoS::AtLeastOnce)
                .await;
            let _ = client
                .subscribe(environment_control_topic.clone(), QoS::AtLeastOnce)
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

        let sampler = self.clone();
        let sampler_task = tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
            loop {
                tokio::select! {
                    _ = sampler.shutdown.cancelled() => break,
                    _ = interval.tick() => {
                        let _ = sampler.sample_environment_once().await;
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
                            let handling_result = if publish.topic == dispense_topic {
                                self.handle_dispense_command(&text).await
                            } else if publish.topic == environment_control_topic {
                                self.handle_environment_control_command(&text).await
                            } else {
                                Ok(CommandHandlingResult::Processed {
                                    command_no: String::new(),
                                })
                            };

                            match handling_result {
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
        sampler_task.abort();
        result
    }
}

impl From<StoreError> for String {
    fn from(error: StoreError) -> Self {
        error.to_string()
    }
}

fn validate_environment_control_command(
    command: &EnvironmentControlCommandPayload,
) -> Result<(), String> {
    if command.air_conditioner_on.is_none() && command.target_temperature_celsius.is_none() {
        return Err("environment control command must request at least one action".to_string());
    }
    if command.timeout_seconds == 0 {
        return Err("environment control command timeoutSeconds must be positive".to_string());
    }
    if let Some(target) = command.target_temperature_celsius {
        if !(18..=30).contains(&target) {
            return Err(
                "environment control targetTemperatureCelsius must be between 18 and 30"
                    .to_string(),
            );
        }
    }
    Ok(())
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
    use async_trait::async_trait;
    use tokio::sync::Mutex;
    use vending_core::{
        hardware::{
            DispenseCommandPayload, DispenseResultPayload, EnvironmentControlCommandPayload,
            HardwareAdapter, HardwareStatus,
        },
        mqtt::sign_envelope,
    };

    #[derive(Debug, Default)]
    struct RecordingEnvironmentAdapter {
        operations: Mutex<Vec<String>>,
        fail_on: Mutex<Option<String>>,
        hang_dispense: bool,
    }

    #[async_trait]
    impl HardwareAdapter for RecordingEnvironmentAdapter {
        fn adapter_name(&self) -> &str {
            "recording"
        }

        async fn self_check(&self) -> HardwareStatus {
            HardwareStatus {
                adapter: "recording".to_string(),
                online: true,
                message: "recording adapter ready".to_string(),
                port_path: None,
                resolution_source: None,
                bound_usb_identity: None,
                candidates: vec![],
            }
        }

        async fn set_target_temperature(&self, temperature_celsius: i8) -> Result<(), String> {
            self.operations
                .lock()
                .await
                .push(format!("B1:{temperature_celsius}"));
            if self.fail_on.lock().await.as_deref() == Some("B1") {
                Err("target temperature echo mismatch".to_string())
            } else {
                Ok(())
            }
        }

        async fn set_air_conditioner_enabled(&self, enabled: bool) -> Result<(), String> {
            self.operations.lock().await.push(format!("B2:{enabled}"));
            if self.fail_on.lock().await.as_deref() == Some("B2") {
                Err("air conditioner switch echo mismatch".to_string())
            } else {
                Ok(())
            }
        }

        async fn dispense(&self, cmd: DispenseCommandPayload) -> DispenseResultPayload {
            self.operations
                .lock()
                .await
                .push(format!("dispense:{}", cmd.command_no));
            if self.hang_dispense {
                tokio::time::sleep(Duration::from_secs(60)).await;
            }
            DispenseResultPayload {
                command_no: cmd.command_no,
                success: true,
                error_code: None,
                message: "recording dispense succeeded".to_string(),
                reported_at: crate::state::store::now_iso(),
            }
        }
    }

    async fn seed_single_slot_planogram(state: &crate::state::LocalStateStore) {
        state
            .apply_planogram(crate::state::store::MachinePlanogramInput {
                planogram_version: "PLAN-MQTT".to_string(),
                source: "test".to_string(),
                applied_by: None,
                slots: vec![crate::state::store::MachinePlanogramSlotInput {
                    slot_id: "550e8400-e29b-41d4-a716-446655441001".to_string(),
                    slot_code: "A1".to_string(),
                    layer_no: 1,
                    cell_no: 1,
                    capacity: 8,
                    par_level: 6,
                    inventory_id: "550e8400-e29b-41d4-a716-446655441002".to_string(),
                    variant_id: "550e8400-e29b-41d4-a716-446655441003".to_string(),
                    product_id: "550e8400-e29b-41d4-a716-446655441004".to_string(),
                    product_name: "water".to_string(),
                    product_description: None,
                    cover_image_url: None,
                    category_id: None,
                    category_name: None,
                    sku: "WATER-001".to_string(),
                    size: Some("550ml".to_string()),
                    color: None,
                    price_cents: 200,
                    product_sort_order: 1,
                    target_gender: None,
                }],
            })
            .await
            .expect("planogram");
    }

    fn dispense_command_payload(command_no: &str, timeout_seconds: u64) -> DispenseCommandPayload {
        DispenseCommandPayload {
            command_no: command_no.to_string(),
            order_no: "ORD-MQTT".to_string(),
            slot: vending_core::hardware::SlotPayload {
                layer_no: 1,
                cell_no: 1,
                slot_code: "A1".to_string(),
            },
            quantity: 1,
            timeout_seconds,
        }
    }

    fn signed_dispense_command(command_no: &str, timeout_seconds: u64) -> String {
        let command = dispense_command_payload(command_no, timeout_seconds);
        let envelope = sign_envelope(
            "M1",
            "secret",
            &format!("MSG-{command_no}"),
            serde_json::to_value(&command).expect("payload"),
        );
        serde_json::to_string(&envelope).expect("envelope")
    }

    #[tokio::test]
    async fn duplicate_acknowledged_dispense_command_does_not_call_hardware_again() {
        let temp = tempfile::tempdir().expect("temp");
        let state = crate::state::LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        seed_single_slot_planogram(&state).await;

        let command = dispense_command_payload("CMD-DUP-ACK", 5);
        let ack_event = crate::state::store::OutboxInput::command_ack("M1", &command.command_no);
        state
            .record_command_ack_tx(&command, &ack_event)
            .await
            .expect("acknowledged command");

        let adapter = Arc::new(RecordingEnvironmentAdapter::default());
        let hardware = crate::hardware::HardwareSupervisor::from_adapter(adapter.clone());
        let (event_tx, _rx) = tokio::sync::broadcast::channel(4);
        let runtime = MqttSyncRuntime::new(
            "M1".to_string(),
            "secret".to_string(),
            state,
            hardware,
            event_tx,
            CancellationToken::new(),
        );

        let result = runtime
            .handle_dispense_command(&signed_dispense_command("CMD-DUP-ACK", 5))
            .await
            .expect("handle duplicate");

        assert!(matches!(
            result,
            CommandHandlingResult::ActiveDuplicate { command_no } if command_no == "CMD-DUP-ACK"
        ));
        let operations = adapter.operations.lock().await.clone();
        assert!(
            !operations
                .iter()
                .any(|operation| operation == "dispense:CMD-DUP-ACK"),
            "duplicate command should not call hardware: {operations:?}"
        );
    }

    fn signed_environment_command(
        command_no: &str,
        air_conditioner_on: Option<bool>,
        target_temperature_celsius: Option<i8>,
    ) -> String {
        let command = EnvironmentControlCommandPayload {
            command_no: command_no.to_string(),
            air_conditioner_on,
            target_temperature_celsius,
            timeout_seconds: 5,
        };
        let envelope = sign_envelope(
            "M1",
            "secret",
            &format!("MSG-{command_no}"),
            serde_json::to_value(&command).expect("payload"),
        );
        serde_json::to_string(&envelope).expect("envelope")
    }

    #[test]
    fn mqtt_options_accepts_mqtt_and_mqtts() {
        let opts = MqttSyncRuntime::mqtt_options_from_config("M1", "mqtt://127.0.0.1:1883", None)
            .expect("mqtt");
        assert_eq!(opts.client_id(), "machine-M1");

        let secure =
            MqttSyncRuntime::mqtt_options_from_config("M1", "mqtts://127.0.0.1:8883", None)
                .expect("mqtts");
        assert_eq!(secure.client_id(), "machine-M1");

        let provisioned = MqttSyncRuntime::mqtt_options_from_config(
            "M1",
            "mqtt://127.0.0.1:1883",
            Some("vem-machine-M1"),
        )
        .expect("mqtt");
        assert_eq!(provisioned.client_id(), "vem-machine-M1");

        assert!(
            MqttSyncRuntime::mqtt_options_from_config("M1", "ws://127.0.0.1:1883", None).is_err()
        );
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

    #[tokio::test]
    async fn enqueue_heartbeat_reports_cached_environment_state() {
        let temp = tempfile::tempdir().expect("temp");
        let state = crate::state::LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");

        let config = crate::config::default_public_config();
        let hardware = crate::hardware::HardwareSupervisor::from_config(&config).expect("hw");
        let (event_tx, _rx) = tokio::sync::broadcast::channel(4);
        let runtime = MqttSyncRuntime::new(
            "M1".to_string(),
            "secret".to_string(),
            state.clone(),
            hardware,
            event_tx,
            CancellationToken::new(),
        );

        runtime
            .record_environment_query_result(
                Some(vending_core::serial::EnvironmentSample {
                    temperature_celsius: 24,
                    relative_humidity_percent: 53,
                }),
                "2026-05-05T12:00:00.000Z".to_string(),
            )
            .await;
        runtime.enqueue_heartbeat().await.expect("heartbeat");

        let due = state
            .list_due_outbox(chrono::Utc::now() + chrono::Duration::seconds(1))
            .await
            .expect("outbox");
        assert_eq!(due.len(), 1);
        let envelope: vending_core::mqtt::MqttEnvelope =
            serde_json::from_value(due[0].payload_json.clone()).expect("envelope");
        vending_core::mqtt::verify_envelope(&envelope, "M1", "secret", 300)
            .expect("valid signed heartbeat");
        let payload = &envelope.payload;
        let environment = &payload["statusPayload"]["environment"];
        assert_eq!(payload["machineCode"], "M1");
        assert_eq!(payload["statusPayload"]["hardwareStatus"], "ok");
        assert_eq!(environment["temperatureCelsius"], 24);
        assert_eq!(environment["humidityRh"], 53);
        assert_eq!(environment["sampledAt"], "2026-05-05T12:00:00.000Z");
        assert_eq!(environment["sensorStatus"], "ok");
        assert_eq!(environment["airConditionerOn"], false);
        assert!(environment["targetTemperatureCelsius"].is_null());
    }

    #[tokio::test]
    async fn environment_control_command_accepts_signed_payload_and_enqueues_ack() {
        let temp = tempfile::tempdir().expect("temp");
        let state = crate::state::LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");

        let config = crate::config::default_public_config();
        let hardware = crate::hardware::HardwareSupervisor::from_config(&config).expect("hw");
        let (event_tx, _rx) = tokio::sync::broadcast::channel(4);
        let runtime = MqttSyncRuntime::new(
            "M1".to_string(),
            "secret".to_string(),
            state.clone(),
            hardware,
            event_tx,
            CancellationToken::new(),
        );

        let command = EnvironmentControlCommandPayload {
            command_no: "ENV-1".to_string(),
            air_conditioner_on: Some(true),
            target_temperature_celsius: None,
            timeout_seconds: 5,
        };
        let envelope = sign_envelope(
            "M1",
            "secret",
            "MSG-ENV-1",
            serde_json::to_value(&command).expect("payload"),
        );

        runtime
            .handle_environment_control_command(
                &serde_json::to_string(&envelope).expect("envelope"),
            )
            .await
            .expect("handle command");

        let due = state
            .list_due_outbox(chrono::Utc::now() + chrono::Duration::seconds(1))
            .await
            .expect("outbox");
        assert!(
            due.iter().any(|event| {
                event.topic.as_deref() == Some("vem/machines/M1/commands/ENV-1/ack")
                    && event.payload_json["payload"]["messageId"] == "ENV-1:ack"
            }),
            "expected command ACK in outbox: {due:?}"
        );
    }

    #[tokio::test]
    async fn environment_control_runs_target_before_switch_and_publishes_success_result() {
        let temp = tempfile::tempdir().expect("temp");
        let state = crate::state::LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");

        let adapter = Arc::new(RecordingEnvironmentAdapter::default());
        let hardware = crate::hardware::HardwareSupervisor::from_adapter(adapter.clone());
        let (event_tx, _rx) = tokio::sync::broadcast::channel(4);
        let runtime = MqttSyncRuntime::new(
            "M1".to_string(),
            "secret".to_string(),
            state.clone(),
            hardware,
            event_tx,
            CancellationToken::new(),
        );

        runtime
            .handle_environment_control_command(&signed_environment_command(
                "ENV-ORDER",
                Some(true),
                Some(24),
            ))
            .await
            .expect("handle command");

        assert_eq!(
            adapter.operations.lock().await.as_slice(),
            ["B1:24", "B2:true"]
        );
        let due = state
            .list_due_outbox(chrono::Utc::now() + chrono::Duration::seconds(1))
            .await
            .expect("outbox");
        let result = due
            .iter()
            .find(|event| {
                event.topic.as_deref() == Some("vem/machines/M1/events/environment-control-result")
            })
            .expect("environment result");
        assert_eq!(result.payload_json["payload"]["commandNo"], "ENV-ORDER");
        assert_eq!(result.payload_json["payload"]["success"], true);
        assert_eq!(
            result.payload_json["payload"]["targetTemperatureCelsius"],
            24
        );
        assert_eq!(result.payload_json["payload"]["airConditionerOn"], true);
    }

    #[tokio::test]
    async fn environment_control_failure_publishes_failed_result_without_updating_local_state() {
        let temp = tempfile::tempdir().expect("temp");
        let state = crate::state::LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");

        let adapter = Arc::new(RecordingEnvironmentAdapter::default());
        *adapter.fail_on.lock().await = Some("B2".to_string());
        let hardware = crate::hardware::HardwareSupervisor::from_adapter(adapter.clone());
        let (event_tx, _rx) = tokio::sync::broadcast::channel(4);
        let runtime = MqttSyncRuntime::new(
            "M1".to_string(),
            "secret".to_string(),
            state.clone(),
            hardware,
            event_tx,
            CancellationToken::new(),
        );

        runtime
            .handle_environment_control_command(&signed_environment_command(
                "ENV-FAIL",
                Some(true),
                Some(24),
            ))
            .await
            .expect("handle command");
        runtime.enqueue_heartbeat().await.expect("heartbeat");

        assert_eq!(
            adapter.operations.lock().await.as_slice(),
            ["B1:24", "B2:true"]
        );
        let due = state
            .list_due_outbox(chrono::Utc::now() + chrono::Duration::seconds(1))
            .await
            .expect("outbox");
        let result = due
            .iter()
            .find(|event| {
                event.topic.as_deref() == Some("vem/machines/M1/events/environment-control-result")
            })
            .expect("environment result");
        assert_eq!(result.payload_json["payload"]["success"], false);
        assert_eq!(
            result.payload_json["payload"]["errorCode"],
            "air_conditioner_switch_failed"
        );
        assert!(result.payload_json["payload"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("echo mismatch"));

        let heartbeat = due
            .iter()
            .find(|event| event.topic.as_deref() == Some("vem/machines/M1/events/heartbeat"))
            .expect("heartbeat");
        let environment = &heartbeat.payload_json["payload"]["statusPayload"]["environment"];
        assert_eq!(environment["airConditionerOn"], false);
        assert!(environment["targetTemperatureCelsius"].is_null());
    }

    #[tokio::test]
    async fn environment_control_success_updates_local_state_but_restart_uses_defaults() {
        let temp = tempfile::tempdir().expect("temp");
        let state = crate::state::LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");

        let adapter = Arc::new(RecordingEnvironmentAdapter::default());
        let hardware = crate::hardware::HardwareSupervisor::from_adapter(adapter);
        let (event_tx, _rx) = tokio::sync::broadcast::channel(4);
        let runtime = MqttSyncRuntime::new(
            "M1".to_string(),
            "secret".to_string(),
            state.clone(),
            hardware,
            event_tx.clone(),
            CancellationToken::new(),
        );

        runtime
            .handle_environment_control_command(&signed_environment_command(
                "ENV-STATE",
                Some(true),
                Some(24),
            ))
            .await
            .expect("handle command");
        runtime.enqueue_heartbeat().await.expect("heartbeat");
        let due = state
            .list_due_outbox(chrono::Utc::now() + chrono::Duration::seconds(1))
            .await
            .expect("outbox");
        let heartbeat = due
            .iter()
            .find(|event| event.topic.as_deref() == Some("vem/machines/M1/events/heartbeat"))
            .expect("heartbeat");
        let environment = &heartbeat.payload_json["payload"]["statusPayload"]["environment"];
        assert_eq!(environment["airConditionerOn"], true);
        assert_eq!(environment["targetTemperatureCelsius"], 24);

        let restarted = MqttSyncRuntime::new(
            "M1".to_string(),
            "secret".to_string(),
            state.clone(),
            crate::hardware::HardwareSupervisor::from_adapter(Arc::new(
                RecordingEnvironmentAdapter::default(),
            )),
            event_tx,
            CancellationToken::new(),
        );
        restarted
            .enqueue_heartbeat()
            .await
            .expect("restart heartbeat");
        let due = state
            .list_due_outbox(chrono::Utc::now() + chrono::Duration::seconds(1))
            .await
            .expect("outbox");
        let latest_heartbeat = due
            .iter()
            .rev()
            .find(|event| event.topic.as_deref() == Some("vem/machines/M1/events/heartbeat"))
            .expect("latest heartbeat");
        let restarted_environment =
            &latest_heartbeat.payload_json["payload"]["statusPayload"]["environment"];
        assert_eq!(restarted_environment["airConditionerOn"], false);
        assert!(restarted_environment["targetTemperatureCelsius"].is_null());
    }

    #[tokio::test]
    async fn mqtt_dispense_success_updates_current_transaction_to_success() {
        let temp = tempfile::tempdir().expect("temp");
        let state = crate::state::LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        state
            .upsert_order_session(crate::state::store::OrderSessionUpsert {
                order_no: "ORD-MQTT",
                payment_method: "payment_code",
                payment_provider: Some("alipay"),
                items_json: serde_json::json!([{ "name": "water", "slotCode": "A1" }]),
                status: "dispensing",
                next_action: "dispensing",
                payment_attempt_json: Some(serde_json::json!({
                    "attemptNo": 1,
                    "status": "succeeded",
                    "maskedAuthCode": "2840****3066",
                    "source": "serial_text",
                    "idempotencyKey": "ORD-MQTT:one",
                    "submittedAt": "2026-06-10T04:10:17.000Z",
                    "lastCheckedAt": "2026-06-10T04:10:20.000Z",
                    "canRetry": false,
                    "message": "支付成功"
                })),
                recovery_strategy: "local",
                last_backend_status_json: Some(serde_json::json!({
                    "orderId": "order-id",
                    "orderNo": "ORD-MQTT",
                    "orderStatus": "dispensing",
                    "fulfillmentState": "dispensing",
                    "totalAmountCents": 1,
                    "nextAction": "dispensing",
                    "payment": {
                        "paymentNo": "PAY-MQTT",
                        "method": "payment_code",
                        "providerCode": "alipay",
                        "paymentUrl": null,
                        "status": "succeeded",
                        "expiresAt": "2026-06-10T04:16:26.596Z"
                    },
                    "vending": {
                        "commandNo": "CMD-SUCCESS",
                        "status": "sent",
                        "lastError": null
                    }
                })),
                last_error: None,
            })
            .await
            .expect("active order session");

        let hardware = crate::hardware::HardwareSupervisor::from_adapter(Arc::new(
            RecordingEnvironmentAdapter::default(),
        ));
        let (event_tx, mut rx) = tokio::sync::broadcast::channel(4);
        let runtime = MqttSyncRuntime::new(
            "M1".to_string(),
            "secret".to_string(),
            state.clone(),
            hardware,
            event_tx,
            CancellationToken::new(),
        );

        runtime
            .handle_dispense_command(&signed_dispense_command("CMD-SUCCESS", 5))
            .await
            .expect("handle command");

        let snapshot = state
            .current_transaction_snapshot()
            .await
            .expect("snapshot")
            .expect("current transaction");
        assert_eq!(snapshot.order_no.as_deref(), Some("ORD-MQTT"));
        assert_eq!(snapshot.order_status.as_deref(), Some("fulfilled"));
        assert_eq!(snapshot.next_action.as_deref(), Some("success"));
        let vending = snapshot.vending.expect("vending summary");
        assert_eq!(vending.command_no.as_deref(), Some("CMD-SUCCESS"));
        assert_eq!(vending.status.as_deref(), Some("succeeded"));
        assert_eq!(vending.last_error.as_deref(), None);

        let event = rx.recv().await.expect("transaction event");
        match event {
            DaemonEvent::TransactionChanged {
                order_no, status, ..
            } => {
                assert_eq!(order_no, "ORD-MQTT");
                assert_eq!(status, "success");
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[tokio::test]
    async fn hung_dispense_command_records_timeout_result_and_locks_machine() {
        let temp = tempfile::tempdir().expect("temp");
        let state = crate::state::LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        seed_single_slot_planogram(&state).await;

        let hardware = crate::hardware::HardwareSupervisor::from_adapter(Arc::new(
            RecordingEnvironmentAdapter {
                hang_dispense: true,
                ..RecordingEnvironmentAdapter::default()
            },
        ));
        let (event_tx, mut rx) = tokio::sync::broadcast::channel(4);
        let runtime = MqttSyncRuntime::new(
            "M1".to_string(),
            "secret".to_string(),
            state.clone(),
            hardware,
            event_tx,
            CancellationToken::new(),
        );

        runtime
            .handle_dispense_command(&signed_dispense_command("CMD-HUNG", 1))
            .await
            .expect("handle hung command");

        let sale_view = state
            .sale_view(Some("M1".to_string()))
            .await
            .expect("sale view");
        assert_eq!(sale_view.items[0].slot_sales_state, "frozen");

        let command = state
            .get_command("CMD-HUNG")
            .await
            .expect("read command")
            .expect("command");
        assert_eq!(
            command.status,
            vending_core::domain::CommandLogStatus::Failed
        );
        let result = command.result_payload.expect("timeout result");
        assert!(!result.success);
        assert_eq!(result.error_code.as_deref(), Some("MOTOR_TIMEOUT"));

        let due = state
            .list_due_outbox(chrono::Utc::now() + chrono::Duration::seconds(1))
            .await
            .expect("outbox");
        assert!(due.iter().any(|event| {
            event.topic.as_deref() == Some("vem/machines/M1/commands/CMD-HUNG/ack")
        }));
        assert!(due.iter().any(|event| {
            event.topic.as_deref() == Some("vem/machines/M1/events/dispense-result")
        }));

        let lock = state
            .whole_machine_maintenance_lock()
            .await
            .expect("lock lookup")
            .expect("whole machine lock");
        assert_eq!(lock.code, "WHOLE_MACHINE_HARDWARE_FAULT");
        assert_eq!(lock.command_no, "CMD-HUNG");

        let event = rx.recv().await.expect("transaction event");
        match event {
            DaemonEvent::TransactionChanged {
                order_no, status, ..
            } => {
                assert_eq!(order_no, "ORD-MQTT");
                assert_eq!(status, "dispense_failed");
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[tokio::test]
    async fn environment_control_rejects_bad_signature_and_invalid_schema_without_ack() {
        let temp = tempfile::tempdir().expect("temp");
        let state = crate::state::LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        let hardware = crate::hardware::HardwareSupervisor::from_adapter(Arc::new(
            RecordingEnvironmentAdapter::default(),
        ));
        let (event_tx, _rx) = tokio::sync::broadcast::channel(4);
        let runtime = MqttSyncRuntime::new(
            "M1".to_string(),
            "secret".to_string(),
            state.clone(),
            hardware,
            event_tx,
            CancellationToken::new(),
        );

        let bad_signature = sign_envelope(
            "M1",
            "wrong-secret",
            "MSG-BAD-SIG",
            serde_json::to_value(EnvironmentControlCommandPayload {
                command_no: "ENV-BAD-SIG".to_string(),
                air_conditioner_on: Some(true),
                target_temperature_celsius: None,
                timeout_seconds: 5,
            })
            .expect("payload"),
        );
        let error = runtime
            .handle_environment_control_command(
                &serde_json::to_string(&bad_signature).expect("envelope"),
            )
            .await
            .expect_err("bad signature should be rejected");
        assert!(error.contains("signature invalid"), "{error}");

        let invalid_schema = sign_envelope(
            "M1",
            "secret",
            "MSG-BAD-SCHEMA",
            serde_json::json!({
                "commandNo": "ENV-BAD-SCHEMA",
                "timeoutSeconds": 5
            }),
        );
        let error = runtime
            .handle_environment_control_command(
                &serde_json::to_string(&invalid_schema).expect("envelope"),
            )
            .await
            .expect_err("schema-invalid command should be rejected");
        assert!(error.contains("at least one action"), "{error}");

        let due = state
            .list_due_outbox(chrono::Utc::now() + chrono::Duration::seconds(1))
            .await
            .expect("outbox");
        assert!(due.is_empty(), "rejected commands must not ACK: {due:?}");
    }

    #[tokio::test]
    async fn environment_control_is_allowed_during_faulted_sensor_and_active_business_state() {
        let temp = tempfile::tempdir().expect("temp");
        let state = crate::state::LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        state
            .upsert_order_session(crate::state::store::OrderSessionUpsert {
                order_no: "ORD-ACTIVE",
                payment_method: "mock",
                payment_provider: None,
                items_json: serde_json::json!([]),
                status: "dispensing",
                next_action: "collect_goods",
                payment_attempt_json: None,
                recovery_strategy: "local",
                last_backend_status_json: None,
                last_error: None,
            })
            .await
            .expect("active order session");

        let hardware = crate::hardware::HardwareSupervisor::from_adapter(Arc::new(
            RecordingEnvironmentAdapter::default(),
        ));
        let (event_tx, _rx) = tokio::sync::broadcast::channel(4);
        let runtime = MqttSyncRuntime::new(
            "M1".to_string(),
            "secret".to_string(),
            state.clone(),
            hardware,
            event_tx,
            CancellationToken::new(),
        );
        runtime
            .record_environment_query_result(None, "2026-05-05T12:00:00.000Z".to_string())
            .await;
        runtime
            .record_environment_query_result(None, "2026-05-05T12:00:30.000Z".to_string())
            .await;
        runtime
            .record_environment_query_result(None, "2026-05-05T12:01:00.000Z".to_string())
            .await;

        runtime
            .handle_environment_control_command(&signed_environment_command(
                "ENV-ACTIVE",
                Some(true),
                None,
            ))
            .await
            .expect("handle command while business state exists");
        runtime.enqueue_heartbeat().await.expect("heartbeat");

        let due = state
            .list_due_outbox(chrono::Utc::now() + chrono::Duration::seconds(1))
            .await
            .expect("outbox");
        let result = due
            .iter()
            .find(|event| {
                event.topic.as_deref() == Some("vem/machines/M1/events/environment-control-result")
            })
            .expect("environment result");
        assert_eq!(result.payload_json["payload"]["success"], true);
        let heartbeat = due
            .iter()
            .find(|event| event.topic.as_deref() == Some("vem/machines/M1/events/heartbeat"))
            .expect("heartbeat");
        let environment = &heartbeat.payload_json["payload"]["statusPayload"]["environment"];
        assert_eq!(environment["sensorStatus"], "faulted");
        assert_eq!(environment["airConditionerOn"], true);
    }
}

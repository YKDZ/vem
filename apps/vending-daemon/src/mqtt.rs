use std::{sync::Arc, time::Duration};

use chrono::{DateTime, Utc};
use rumqttc::{AsyncClient, ClientError, Event, EventLoop, MqttOptions, Outgoing, Packet, QoS};
use serde_json::json;
use tokio::sync::{broadcast, Mutex, RwLock};
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
const DISPENSE_RESTART_RECOVERY_GRACE_SECONDS: i64 = 30;
const DISPENSE_SIDE_EFFECT_RECOVERY_INTERVAL: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
pub struct OutboxFlushResult {
    pub sent: u64,
    pub failed: u64,
}

#[derive(Debug, Clone)]
struct PendingMqttOutboxEvent {
    id: String,
}

#[derive(Debug, Default)]
struct PendingMqttOutbox {
    // All application QoS1 publishes originate in the durable outbox. Keeping
    // one owner here makes a PubAck unambiguous even when rumqttc reuses a pkid.
    inflight: Option<PendingMqttOutboxEvent>,
    packet_id: Option<u16>,
    outgoing_observed: bool,
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
    readiness_context: Option<crate::ipc::IpcContext>,
    environment: Arc<RwLock<EnvironmentHeartbeatCache>>,
    events: broadcast::Sender<DaemonEvent>,
    shutdown: CancellationToken,
    mqtt_client: Option<Arc<RwLock<AsyncClient>>>,
    outbox_flush: Arc<Mutex<()>>,
    pending_mqtt_outbox: Arc<Mutex<PendingMqttOutbox>>,
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
            readiness_context: None,
            environment: Arc::new(RwLock::new(EnvironmentHeartbeatCache::default())),
            events,
            shutdown,
            mqtt_client: None,
            outbox_flush: Arc::new(Mutex::new(())),
            pending_mqtt_outbox: Arc::new(Mutex::new(PendingMqttOutbox::default())),
        }
    }

    pub fn with_client(mut self, client: AsyncClient) -> Self {
        self.mqtt_client = Some(Arc::new(RwLock::new(client)));
        self
    }

    pub fn with_readiness_context(mut self, context: crate::ipc::IpcContext) -> Self {
        self.environment = context.ui.status_cache.environment.clone();
        self.readiness_context = Some(context);
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
            if existing.command_payload != command {
                return Err(
                    "dispense command number was reused with a different payload".to_string(),
                );
            }
            if let Some(result) = existing.result_payload {
                let mut ack =
                    crate::state::store::OutboxInput::dispense_result(&self.machine_code, &result);
                ack.payload_json = self.sign_outbox_payload(
                    format!("result:{}", command.command_no),
                    ack.payload_json,
                )?;
                self.state
                    .commit_journaled_dispense_side_effects(&command, &result, &ack)
                    .await
                    .map_err(|error| error.to_string())?;
                if !result.success {
                    self.state
                        .block_slot_for_dispense_failure(
                            &command,
                            result.error_code.as_deref(),
                            Some(result.message.as_str()),
                        )
                        .await
                        .map_err(|error| error.to_string())?;
                }
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
                if matches!(state.record_dispense_progress(&event).await, Ok(true)) {
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
        self.state
            .record_command_result_journal(&command, &result)
            .await
            .map_err(|error| error.to_string())?;
        self.state
            .commit_journaled_dispense_side_effects(&command, &result, &result_event)
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
        if !result.success {
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

    pub async fn recover_stale_active_dispense_commands(&self) -> Result<usize, String> {
        self.recover_stale_active_dispense_commands_at(Utc::now())
            .await
    }

    pub async fn recover_journaled_dispense_side_effects(&self) -> Result<usize, String> {
        let commands = self
            .state
            .list_journaled_commands_pending_side_effects()
            .await
            .map_err(|error| error.to_string())?;
        let mut recovered = 0_usize;
        for record in commands {
            let Some(result) = record.result_payload else {
                continue;
            };
            let mut result_event =
                crate::state::store::OutboxInput::dispense_result(&self.machine_code, &result);
            result_event.payload_json = self.sign_outbox_payload(
                format!("result:{}", record.command_payload.command_no),
                result_event.payload_json,
            )?;
            match self
                .state
                .commit_journaled_dispense_side_effects(
                    &record.command_payload,
                    &result,
                    &result_event,
                )
                .await
            {
                Ok(changed) => {
                    recovered += usize::from(changed);
                }
                Err(error) => {
                    self.state
                        .append_health_event(&vending_core::health::ComponentHealth {
                            component: "dispense_recovery".to_string(),
                            level: vending_core::health::HealthLevel::Degraded,
                            code: "DISPENSE_RESULT_RECOVERY_DEFERRED".to_string(),
                            message: format!(
                                "terminal dispense {} is journaled but side effects remain recoverable: {error}",
                                record.command_no
                            ),
                            updated_at: crate::state::store::now_iso(),
                        })
                        .await
                        .map_err(|store_error| store_error.to_string())?;
                }
            }
        }
        Ok(recovered)
    }

    async fn run_journaled_dispense_recovery_worker(self: Arc<Self>, interval: Duration) {
        let mut ticker = tokio::time::interval(interval);
        // Startup performs the first scan synchronously. Consume tokio's
        // immediate tick so subsequent attempts remain bounded by the interval.
        ticker.tick().await;
        loop {
            tokio::select! {
                _ = self.shutdown.cancelled() => break,
                _ = ticker.tick() => {
                    let _ = self.recover_journaled_dispense_side_effects().await;
                }
            }
        }
    }

    async fn recover_stale_active_dispense_commands_at(
        &self,
        now: DateTime<Utc>,
    ) -> Result<usize, String> {
        let commands = self
            .state
            .list_active_unfinished_commands()
            .await
            .map_err(|error| error.to_string())?;
        let mut recovered = 0_usize;

        for record in commands {
            if !is_stale_for_restart_recovery(&record, now) {
                continue;
            }
            let result = vending_core::hardware::DispenseResultPayload {
                command_no: record.command_payload.command_no.clone(),
                success: false,
                error_code: Some("UNKNOWN".to_string()),
                message: "dispense result unknown after daemon restart".to_string(),
                reported_at: crate::state::store::now_iso(),
            };
            let mut result_event =
                crate::state::store::OutboxInput::dispense_result(&self.machine_code, &result);
            result_event.payload_json = self.sign_outbox_payload(
                format!("result:{}", record.command_payload.command_no),
                result_event.payload_json,
            )?;

            let result_recorded = self
                .state
                .record_command_result_journal(&record.command_payload, &result)
                .await
                .map_err(|error| error.to_string())?;
            if !result_recorded {
                continue;
            }

            self.state
                .commit_journaled_dispense_side_effects(
                    &record.command_payload,
                    &result,
                    &result_event,
                )
                .await
                .map_err(|error| error.to_string())?;
            self.state
                .block_slot_for_dispense_result_unknown(&record.command_payload)
                .await
                .map_err(|error| error.to_string())?;
            let _ = self.events.send(DaemonEvent::TransactionChanged {
                event_id: Uuid::new_v4().simple().to_string(),
                updated_at: crate::state::store::now_iso(),
                order_no: record.order_no,
                status: "dispense_failed".to_string(),
            });
            recovered += 1;
        }

        Ok(recovered)
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
        let mut confirmed_vent_speed = None;
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
            if let Some(speed) = command.vent_speed {
                match self.hardware.set_vent_speed(speed).await {
                    Ok(()) => confirmed_vent_speed = Some(speed),
                    Err(error) => failure = Some(("vent_speed_failed".to_string(), error)),
                }
            }
        }

        if failure.is_none() {
            self.environment.write().await.record_control_success(
                confirmed_switch,
                confirmed_target,
                confirmed_vent_speed,
            );
        }

        let result = match failure {
            Some((error_code, message)) => EnvironmentControlResultPayload {
                command_no: command.command_no.clone(),
                success: false,
                error_code: Some(error_code),
                message: Some(message),
                air_conditioner_on: confirmed_switch,
                target_temperature_celsius: confirmed_target,
                vent_speed: confirmed_vent_speed,
                reported_at: crate::state::store::now_iso(),
            },
            None => EnvironmentControlResultPayload {
                command_no: command.command_no.clone(),
                success: true,
                error_code: None,
                message: Some("environment control completed".to_string()),
                air_conditioner_on: confirmed_switch,
                target_temperature_celsius: confirmed_target,
                vent_speed: confirmed_vent_speed,
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

    async fn record_environment_query_error(&self, error: &str) {
        let mut environment = self.environment.write().await;
        if is_lower_controller_sensor_fault(error) {
            environment.record_sensor_fault();
        } else {
            environment.record_query_result(None, crate::state::store::now_iso());
        }
    }

    pub async fn sample_environment_once(&self) -> Result<(), String> {
        match self.hardware.query_environment_sample().await {
            Ok(sample) => {
                self.record_environment_query_result(sample, crate::state::store::now_iso())
                    .await;
                Ok(())
            }
            Err(error) => {
                self.record_environment_query_error(&error).await;
                Err(error)
            }
        }
    }

    pub async fn enqueue_heartbeat(&self) -> Result<(), String> {
        let reported_at = crate::state::store::now_iso();
        let environment = self.environment.read().await.heartbeat_payload();
        let hardware_status = self.hardware.self_check().await;
        let heartbeat_hardware_status = if hardware_status.online {
            "ok"
        } else {
            "faulted"
        };
        if let Some(context) = self.readiness_context.as_ref() {
            *context.ui.status_cache.hardware.write().await = hardware_status.clone();
        }
        let whole_machine_lock = self
            .state
            .whole_machine_maintenance_lock()
            .await
            .map_err(|error| format!("read whole-machine maintenance lock failed: {error}"))?;
        let sale_readiness = self
            .heartbeat_sale_readiness(whole_machine_lock.is_some(), hardware_status.online)
            .await?;
        let physical_stock_attestation = self
            .state
            .physical_stock_attestation_status()
            .await
            .map_err(|error| format!("read physical stock attestation failed: {error}"))?;
        let payload = json!({
            "machineCode": self.machine_code,
            "reportedAt": reported_at,
            "statusPayload": {
                "network": "online",
                "mqttConnected": true,
                "hardwareAdapter": self.hardware.adapter_name(),
                "hardwareStatus": heartbeat_hardware_status,
                "hardwareMessage": hardware_status.message,
                "wholeMachineMaintenanceLock": whole_machine_lock,
                "saleReadiness": sale_readiness,
                "physicalStockAttestation": physical_stock_attestation,
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

    async fn heartbeat_sale_readiness(
        &self,
        whole_machine_locked: bool,
        hardware_online: bool,
    ) -> Result<serde_json::Value, String> {
        if let Some(context) = self.readiness_context.as_ref() {
            let snapshot = crate::ipc::machine_sale_readiness_snapshot(context)
                .await
                .map_err(|error| format!("read sale readiness failed: {error}"))?;
            let blocking_codes = snapshot
                .get("blockingCodes")
                .and_then(|value| value.as_array())
                .cloned()
                .unwrap_or_default();
            let can_start_sale = snapshot
                .get("canStartNetworkAuthorizedSale")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            let state = if whole_machine_locked {
                "locked"
            } else if can_start_sale {
                "restored"
            } else {
                "blocked"
            };
            return Ok(json!({
                "state": state,
                "blockingCodes": blocking_codes,
            }));
        }

        let mut blocking_codes = Vec::new();
        if whole_machine_locked {
            blocking_codes.push("WHOLE_MACHINE_HARDWARE_FAULT");
        } else if !hardware_online {
            blocking_codes.push("LOWER_CONTROLLER_UNAVAILABLE");
        }
        let state = if whole_machine_locked {
            "locked"
        } else if hardware_online {
            "restored"
        } else {
            "blocked"
        };
        Ok(json!({
            "state": state,
            "blockingCodes": blocking_codes,
        }))
    }

    pub async fn flush_due_outbox(&self) -> Result<OutboxFlushResult, String> {
        let _flush = self.outbox_flush.lock().await;
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
                    if !self.claim_mqtt_outbox_event(&event.id).await {
                        // At most one durable QoS1 event may be owned until its
                        // matching Outgoing(Publish) and PubAck are observed.
                        break;
                    }
                    match self
                        .publish_json(event.topic.as_deref(), &event.payload_json)
                        .await
                    {
                        Ok(()) => Ok(()),
                        Err(error) => {
                            self.release_mqtt_outbox_event(&event.id).await;
                            Err(error)
                        }
                    }
                }
                vending_core::domain::OutboxTransport::Http => {
                    self.publish_http(event.target_url.as_deref(), &event.payload_json)
                        .await
                }
            };
            match result {
                Ok(()) => {
                    if event.transport == vending_core::domain::OutboxTransport::Http {
                        self.state
                            .remove_outbox_event(&event.id)
                            .await
                            .map_err(|error| error.to_string())?;
                    }
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

    async fn claim_mqtt_outbox_event(&self, event_id: &str) -> bool {
        let mut pending = self.pending_mqtt_outbox.lock().await;
        if pending.inflight.is_some() {
            return false;
        }
        pending.inflight = Some(PendingMqttOutboxEvent {
            id: event_id.to_string(),
        });
        pending.packet_id = None;
        pending.outgoing_observed = false;
        true
    }

    async fn release_mqtt_outbox_event(&self, event_id: &str) {
        let mut pending = self.pending_mqtt_outbox.lock().await;
        if pending
            .inflight
            .as_ref()
            .is_some_and(|event| event.id == event_id)
        {
            pending.inflight = None;
            pending.packet_id = None;
            pending.outgoing_observed = false;
        }
    }

    async fn record_mqtt_outbox_publish(&self, packet_id: u16) {
        let mut pending = self.pending_mqtt_outbox.lock().await;
        if pending.inflight.is_some() && !pending.outgoing_observed {
            pending.packet_id = Some(packet_id);
            pending.outgoing_observed = true;
        }
    }

    async fn acknowledge_mqtt_outbox_publish(&self, packet_id: u16) -> Result<bool, String> {
        let event = {
            let mut pending = self.pending_mqtt_outbox.lock().await;
            if pending.outgoing_observed && pending.packet_id == Some(packet_id) {
                let event = pending.inflight.take();
                pending.packet_id = None;
                pending.outgoing_observed = false;
                event
            } else {
                None
            }
        };
        let Some(event) = event else {
            return Ok(false);
        };
        self.state
            .remove_outbox_event(&event.id)
            .await
            .map_err(|error| error.to_string())?;
        Ok(true)
    }

    async fn begin_mqtt_generation(&self) {
        let mut pending = self.pending_mqtt_outbox.lock().await;
        // The same durable owner is retransmitted by rumqttc after reconnect.
        pending.packet_id = None;
        pending.outgoing_observed = false;
    }

    async fn retry_inflight_mqtt_outbox(&self) {
        let mut pending = self.pending_mqtt_outbox.lock().await;
        pending.packet_id = None;
        pending.outgoing_observed = false;
    }

    fn schedule_due_outbox(self: &Arc<Self>) {
        let runtime = self.clone();
        tokio::spawn(async move {
            let _ = runtime.flush_due_outbox().await;
        });
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
        let _ = self.recover_journaled_dispense_side_effects().await;
        let _ = self.recover_stale_active_dispense_commands().await;
        // The bounded AsyncClient queue is drained only by event_loop.poll().
        // Never await an initial backlog here, before this loop can poll it.
        self.schedule_due_outbox();

        let recovery_task = tokio::spawn(
            self.clone()
                .run_journaled_dispense_recovery_worker(DISPENSE_SIDE_EFFECT_RECOVERY_INTERVAL),
        );

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
                            self.begin_mqtt_generation().await;
                            self.set_connected(true, None).await;
                            self.schedule_due_outbox();
                        }
                        Ok(Event::Incoming(Packet::PubAck(ack))) => {
                            match self.acknowledge_mqtt_outbox_publish(ack.pkid).await {
                                Err(error) => {
                                    self.set_connected(
                                        false,
                                        Some(format!("outbox acknowledgement failed: {error}")),
                                    )
                                        .await;
                                }
                                Ok(true) => {
                                    // Polling is the only progress engine for the
                                    // bounded AsyncClient queue; start the next
                                    // durable event only after this acknowledgement.
                                    self.schedule_due_outbox();
                                }
                                Ok(false) => {}
                            }
                        }
                        Ok(Event::Outgoing(Outgoing::Publish(packet_id))) => {
                            self.record_mqtt_outbox_publish(packet_id).await;
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
                                    self.schedule_due_outbox();
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
                            self.retry_inflight_mqtt_outbox().await;
                            self.set_connected(false, Some(error.to_string())).await;
                        }
                    }
                }
            }
        };

        heartbeat_task.abort();
        sampler_task.abort();
        recovery_task.abort();
        result
    }
}

impl From<StoreError> for String {
    fn from(error: StoreError) -> Self {
        error.to_string()
    }
}

fn is_stale_for_restart_recovery(
    record: &crate::state::store::CommandLogRecord,
    now: DateTime<Utc>,
) -> bool {
    let Some(active_since) = command_active_since(record) else {
        return false;
    };
    let timeout_seconds = record.command_payload.timeout_seconds.max(1) as i64;
    let deadline = active_since
        + chrono::Duration::seconds(
            timeout_seconds
                + DISPENSE_LOCAL_TIMEOUT_GRACE_SECONDS as i64
                + DISPENSE_RESTART_RECOVERY_GRACE_SECONDS,
        );
    now >= deadline
}

fn command_active_since(record: &crate::state::store::CommandLogRecord) -> Option<DateTime<Utc>> {
    match record.status {
        vending_core::domain::CommandLogStatus::Dispensing => {
            parse_command_log_time(record.dispensing_started_at.as_deref())
                .or_else(|| parse_command_log_time(Some(record.updated_at.as_str())))
        }
        vending_core::domain::CommandLogStatus::Acknowledged => {
            parse_command_log_time(record.ack_at.as_deref())
                .or_else(|| parse_command_log_time(Some(record.updated_at.as_str())))
        }
        _ => None,
    }
}

fn parse_command_log_time(value: Option<&str>) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value?)
        .ok()
        .map(|at| at.with_timezone(&Utc))
}

fn validate_environment_control_command(
    command: &EnvironmentControlCommandPayload,
) -> Result<(), String> {
    if command.air_conditioner_on.is_none()
        && command.target_temperature_celsius.is_none()
        && command.vent_speed.is_none()
    {
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
    if let Some(speed) = command.vent_speed {
        if speed > 4 {
            return Err("environment control ventSpeed must be between 0 and 4".to_string());
        }
    }
    Ok(())
}

pub(crate) fn is_lower_controller_sensor_fault(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("mechanical fault") || normalized.contains("0xe3")
}

fn map_mqtt_error(error: ClientError) -> String {
    match error {
        ClientError::Request(request) | ClientError::TryRequest(request) => {
            format!("mqtt request failed to enqueue: {request:?}")
        }
    }
}

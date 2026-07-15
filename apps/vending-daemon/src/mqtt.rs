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

#[derive(Debug, Clone)]
pub struct OutboxFlushResult {
    pub sent: u64,
    pub failed: u64,
}

#[derive(Debug, Clone)]
struct PendingMqttOutboxEvent {
    id: String,
    awaiting_platform_ack: bool,
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

    fn secure_decommission_command_topic(&self) -> String {
        format!(
            "vem/machines/{}/commands/secure-decommission",
            self.machine_code
        )
    }

    fn secure_decommission_ack_topic(&self) -> String {
        format!(
            "vem/machines/{}/commands/secure-decommission-ack",
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

    pub async fn recover_stale_active_dispense_commands(&self) -> Result<usize, String> {
        self.recover_stale_active_dispense_commands_at(Utc::now())
            .await
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
                .record_command_result_and_enqueue_tx(
                    &record.command_payload,
                    &result,
                    &result_event,
                )
                .await
                .map_err(|error| error.to_string())?;
            if !result_recorded {
                continue;
            }

            self.state
                .apply_dispense_result_to_order_session(&record.command_payload, &result)
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

    pub async fn handle_secure_decommission_command(
        &self,
        payload_text: &str,
    ) -> Result<CommandHandlingResult, String> {
        let envelope = self.parse_and_verify_envelope(payload_text)?;
        let command_no = envelope
            .payload
            .get("commandNo")
            .and_then(|value| value.as_str())
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "secure decommission commandNo is missing".to_string())?
            .to_string();
        let operation = envelope
            .payload
            .get("operation")
            .and_then(|value| value.as_str())
            .ok_or_else(|| "secure decommission operation is missing".to_string())?;
        if operation != "secure-decommission" {
            return Err("unsupported secure decommission operation".to_string());
        }
        if envelope.message_id != format!("secure-decommission:{command_no}") {
            return Err("secure decommission message identity is invalid".to_string());
        }
        let existing = self
            .state
            .record_destructive_command_received(
                &envelope.message_id,
                "secure-decommission",
                &envelope.payload,
                &envelope.issued_at,
            )
            .await
            .map_err(|error| error.to_string())?;
        if existing.status == "succeeded" {
            let finalized = match &self.readiness_context {
                Some(context) => context
                    .config_store
                    .pending_secure_decommission_marker()
                    .await?
                    .is_none(),
                None => false,
            };
            if finalized {
                return Ok(CommandHandlingResult::DuplicateFinal { command_no });
            }
            let result_payload = serde_json::json!({
                "commandNo": command_no,
                "success": true,
                "reportedAt": crate::state::store::now_iso(),
                "error": null,
            });
            let mut result_event = crate::state::store::OutboxInput::secure_decommission_result(
                &self.machine_code,
                &command_no,
                result_payload,
            );
            result_event.payload_json = self.sign_outbox_payload(
                format!("secure-decommission-result:{command_no}"),
                result_event.payload_json,
            )?;
            self.state
                .replace_outbox_event(&result_event)
                .await
                .map_err(|error| error.to_string())?;
            return Ok(CommandHandlingResult::DuplicateFinal { command_no });
        }

        let marker = crate::state::store::SecureDecommissionFinalizeMarker {
            message_id: envelope.message_id.clone(),
            command_no: command_no.clone(),
            generation: envelope.message_id.clone(),
        };
        let cleanup = match &self.readiness_context {
            Some(context) => context.config_store.secure_decommission(&marker).await,
            None => Err("secure decommission runtime context is unavailable".to_string()),
        };
        let reported_at = crate::state::store::now_iso();
        let result_payload = serde_json::json!({
            "commandNo": command_no,
            "success": cleanup.is_ok(),
            "reportedAt": reported_at,
            "error": cleanup.as_ref().err(),
        });
        let mut result_event = crate::state::store::OutboxInput::secure_decommission_result(
            &self.machine_code,
            &command_no,
            result_payload,
        );
        result_event.payload_json = self.sign_outbox_payload(
            format!("secure-decommission-result:{command_no}"),
            result_event.payload_json,
        )?;
        self.state
            .record_destructive_command_result_tx(
                &envelope.message_id,
                cleanup.is_ok(),
                cleanup.as_ref().err().map(String::as_str),
                &result_event,
            )
            .await
            .map_err(|error| error.to_string())?;
        Ok(CommandHandlingResult::Processed { command_no })
    }

    pub async fn handle_secure_decommission_ack(
        &self,
        payload_text: &str,
    ) -> Result<CommandHandlingResult, String> {
        let envelope: vending_core::mqtt::MqttEnvelope = serde_json::from_str(payload_text)
            .map_err(|error| format!("parse MQTT envelope failed: {error}"))?;
        if envelope.machine_code != self.machine_code {
            return Err(
                "secure decommission acknowledgement machine identity is invalid".to_string(),
            );
        }
        vending_core::mqtt::verify_signature_bytes(&envelope, &self.signing_secret)?;
        let command_no = envelope
            .payload
            .get("commandNo")
            .and_then(|value| value.as_str())
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "secure decommission acknowledgement commandNo is missing".to_string())?
            .to_string();
        if envelope
            .payload
            .get("operation")
            .and_then(|value| value.as_str())
            != Some("secure-decommission-ack")
            || envelope
                .payload
                .get("acknowledgedAt")
                .and_then(|value| value.as_str())
                .is_none()
            || envelope.message_id != format!("secure-decommission-ack:{command_no}")
        {
            return Err("secure decommission acknowledgement is invalid".to_string());
        }
        let message_id = format!("secure-decommission:{command_no}");
        let command = self
            .state
            .destructive_command(&message_id)
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "secure decommission command is unknown".to_string())?;
        if command.command_type != "secure-decommission"
            || command.status != "succeeded"
            || command
                .payload_json
                .get("commandNo")
                .and_then(|value| value.as_str())
                != Some(command_no.as_str())
        {
            return Err("secure decommission command is not ready for acknowledgement".to_string());
        }
        let marker = crate::state::store::SecureDecommissionFinalizeMarker {
            message_id: message_id.clone(),
            command_no: command_no.clone(),
            generation: message_id.clone(),
        };
        let context = self
            .readiness_context
            .as_ref()
            .ok_or_else(|| "secure decommission finalization context is unavailable".to_string())?;
        match context
            .config_store
            .pending_secure_decommission_marker()
            .await?
        {
            Some(active) if active == marker => {}
            Some(_) => {
                return Err(
                    "secure decommission acknowledgement does not match the active command generation"
                        .to_string(),
                );
            }
            None => return Ok(CommandHandlingResult::DuplicateFinal { command_no }),
        }
        let newly_acknowledged = self
            .state
            .acknowledge_secure_decommission_result_tx(
                &message_id,
                &format!(
                    "{}:secure-decommission-result:{command_no}",
                    self.machine_code
                ),
                &marker,
            )
            .await
            .map_err(|error| error.to_string())?;
        // This deliberately happens after the SQLite transaction. A process
        // crash or external cleanup failure leaves the durable marker for
        // ConfigStore startup recovery rather than losing either side.
        context
            .config_store
            .finalize_secure_decommission(&marker)
            .await?;
        self.shutdown.cancel();
        Ok(if newly_acknowledged {
            CommandHandlingResult::Processed { command_no }
        } else {
            CommandHandlingResult::DuplicateFinal { command_no }
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
        let reported_runtime_configuration = if let Some(context) = self.readiness_context.as_ref()
        {
            match context
                .config_store
                .load_runtime_configuration_summary()
                .await
            {
                Ok(summary) => Some(crate::config::project_reported_runtime_configuration(
                    &summary.effective_public,
                )),
                Err(error) => {
                    eprintln!("load runtime configuration summary for heartbeat failed: {error}");
                    None
                }
            }
        } else {
            None
        };
        let mut payload = json!({
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
        if let Some(summary) = reported_runtime_configuration {
            payload["statusPayload"]["reportedRuntimeConfiguration"] =
                serde_json::to_value(summary).map_err(|error| {
                    format!("serialize reported runtime configuration failed: {error}")
                })?;
        }
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
        let decommission_result_topic = format!(
            "vem/machines/{}/events/secure-decommission-result",
            self.machine_code
        );

        for event in due {
            if event.kind == vending_core::domain::OutboxKind::StockMovementUpload {
                continue;
            }
            let is_decommission_result =
                event.topic.as_deref() == Some(decommission_result_topic.as_str());
            let result = match event.transport {
                vending_core::domain::OutboxTransport::Mqtt => {
                    if !self
                        .claim_mqtt_outbox_event(&event.id, is_decommission_result)
                        .await
                    {
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

    async fn claim_mqtt_outbox_event(&self, event_id: &str, awaiting_platform_ack: bool) -> bool {
        let mut pending = self.pending_mqtt_outbox.lock().await;
        if pending.inflight.is_some() {
            return false;
        }
        pending.inflight = Some(PendingMqttOutboxEvent {
            id: event_id.to_string(),
            awaiting_platform_ack,
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
        if event.awaiting_platform_ack {
            self.state
                .mark_outbox_failed(
                    &event.id,
                    "awaiting secure decommission platform acknowledgement",
                )
                .await
                .map_err(|error| error.to_string())?;
        } else {
            self.state
                .remove_outbox_event(&event.id)
                .await
                .map_err(|error| error.to_string())?;
        }
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
        let secure_decommission_topic = self.secure_decommission_command_topic();
        let secure_decommission_ack_topic = self.secure_decommission_ack_topic();
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
            let _ = client
                .subscribe(secure_decommission_topic.clone(), QoS::AtLeastOnce)
                .await;
            let _ = client
                .subscribe(secure_decommission_ack_topic.clone(), QoS::AtLeastOnce)
                .await;
        }
        let _ = self.recover_stale_active_dispense_commands().await;
        // The bounded AsyncClient queue is drained only by event_loop.poll().
        // Never await an initial backlog here, before this loop can poll it.
        self.schedule_due_outbox();

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
                            } else if publish.topic == secure_decommission_topic {
                                self.handle_secure_decommission_command(&text).await
                            } else if publish.topic == secure_decommission_ack_topic {
                                self.handle_secure_decommission_ack(&text).await
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

    #[derive(Debug)]
    struct RecordingEnvironmentAdapter {
        operations: Mutex<Vec<String>>,
        fail_on: Mutex<Option<String>>,
        environment_query_error: Option<String>,
        hang_dispense: bool,
        hardware_online: bool,
    }

    impl Default for RecordingEnvironmentAdapter {
        fn default() -> Self {
            Self {
                operations: Mutex::new(vec![]),
                fail_on: Mutex::new(None),
                environment_query_error: None,
                hang_dispense: false,
                hardware_online: true,
            }
        }
    }

    #[async_trait]
    impl HardwareAdapter for RecordingEnvironmentAdapter {
        fn adapter_name(&self) -> &str {
            "recording"
        }

        async fn self_check(&self) -> HardwareStatus {
            HardwareStatus {
                adapter: "recording".to_string(),
                online: self.hardware_online,
                message: if self.hardware_online {
                    "recording adapter ready".to_string()
                } else {
                    "lower controller unavailable".to_string()
                },
                port_path: None,
                resolution_source: None,
                bound_usb_identity: None,
                candidates: vec![],
            }
        }

        async fn query_environment_sample(
            &self,
        ) -> Result<Option<vending_core::serial::EnvironmentSample>, String> {
            if let Some(error) = &self.environment_query_error {
                Err(error.clone())
            } else {
                Ok(Some(vending_core::serial::EnvironmentSample {
                    temperature_celsius: 24,
                    relative_humidity_percent: 53,
                }))
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

        async fn set_vent_speed(&self, speed: u8) -> Result<(), String> {
            self.operations.lock().await.push(format!("B3:{speed}"));
            if self.fail_on.lock().await.as_deref() == Some("B3") {
                Err("vent speed echo mismatch".to_string())
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

    struct FixedDiskPressureProbe;

    impl crate::health::DiskPressureProbe for FixedDiskPressureProbe {
        fn snapshot(&self, _data_dir: &std::path::Path) -> crate::health::DiskPressureSnapshot {
            crate::health::DiskPressureSnapshot {
                pressured: false,
                available_bytes: Some(crate::health::DISK_PRESSURE_MIN_AVAILABLE_BYTES + 1),
                threshold_bytes: crate::health::DISK_PRESSURE_MIN_AVAILABLE_BYTES,
                message: "disk capacity available".to_string(),
            }
        }
    }

    async fn test_readiness_context(
        data_dir: &std::path::Path,
        state: crate::state::LocalStateStore,
        public: crate::config::MachinePublicConfig,
    ) -> crate::ipc::IpcContext {
        let data_dir =
            if data_dir.file_name().and_then(|name| name.to_str()) == Some("vending-daemon") {
                data_dir.to_path_buf()
            } else {
                data_dir.join("vending-daemon")
            };
        let secrets: Arc<dyn crate::secret::SecretStore> =
            Arc::new(crate::secret::InMemorySecretStore::default());
        secrets
            .write_secret(crate::secret::MACHINE_SECRET_ACCOUNT, "machine-secret")
            .await
            .expect("machine secret");
        secrets
            .write_secret(crate::secret::MQTT_SIGNING_SECRET_ACCOUNT, "secret")
            .await
            .expect("MQTT signing secret");
        let config_store = Arc::new(crate::config::ConfigStore::new(
            data_dir.clone(),
            state.clone(),
            secrets,
        ));
        config_store
            .save_public_config(public.clone())
            .await
            .expect("save public config");
        let (events_tx, _) = broadcast::channel(8);
        let (runtime_tx, _raw_rx) = tokio::sync::mpsc::channel(8);
        let backend = Arc::new(crate::backend::BackendClient::new("http://127.0.0.1:9/api"));
        backend
            .set_access_token_for_tests("test-backend-token")
            .await;
        let status_cache = crate::ipc::RuntimeStatusCache::new(&public, state.clone()).await;
        let transaction = crate::transaction::TransactionStateMachine::new(
            state.clone(),
            backend.clone(),
            public.machine_code.clone(),
            events_tx.clone(),
        );

        crate::ipc::IpcContext {
            data_dir,
            token: "test-token".to_string(),
            config_store,
            state,
            hardware: crate::hardware::HardwareSupervisor::from_config(&public).expect("hardware"),
            events: events_tx.clone(),
            runtime_tx: runtime_tx.clone(),
            scanner_runtime: crate::scanner::ScannerRuntimeController::new(runtime_tx, events_tx),
            serial_device_platform: Arc::new(crate::device_binding::WindowsSerialDevicePlatform),
            audio_output_platform: Arc::new(crate::audio_output::WindowsAudioOutputPlatform),
            audio_output_playback: Arc::new(
                crate::audio_output::WindowsAudioOutputPlayback::default(),
            ),
            audio_output_test_evidence: Arc::new(
                crate::ipc::AudioOutputTestEvidenceStore::default(),
            ),
            device_binding_test_evidence: Arc::new(
                crate::ipc::DeviceBindingTestEvidenceStore::default(),
            ),
            sale_binding_gate: Arc::new(crate::ipc::SaleBindingOperationGate::default()),
            disk_pressure_probe: Arc::new(FixedDiskPressureProbe),
            network_adapter: crate::network::adapter_from_env(),
            ui: crate::ipc::UiRuntimeServices {
                backend,
                transaction,
                status_cache,
            },
            background_shutdown: CancellationToken::new(),
            bring_up_execution_lock: Arc::new(tokio::sync::Mutex::new(())),
            maintenance_authorization: Arc::new(crate::ipc::UnavailableMaintenanceAuthorization),
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
                    try_on_silhouette_url: None,
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

    #[tokio::test]
    async fn restart_recovery_leaves_fresh_acknowledged_command_active() {
        let temp = tempfile::tempdir().expect("temp");
        let state = crate::state::LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        seed_single_slot_planogram(&state).await;

        let command = dispense_command_payload("CMD-FRESH-ACK", 5);
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
            state.clone(),
            hardware,
            event_tx,
            CancellationToken::new(),
        );

        let recovered = runtime
            .recover_stale_active_dispense_commands()
            .await
            .expect("recover fresh command");
        assert_eq!(recovered, 0);

        let command = state
            .get_command("CMD-FRESH-ACK")
            .await
            .expect("read command")
            .expect("command");
        assert_eq!(
            command.status,
            vending_core::domain::CommandLogStatus::Acknowledged
        );
        assert!(command.result_payload.is_none());
        let due = state
            .list_due_outbox(chrono::Utc::now() + chrono::Duration::seconds(1))
            .await
            .expect("outbox");
        assert!(!due.iter().any(|event| {
            event.topic.as_deref() == Some("vem/machines/M1/events/dispense-result")
        }));
        assert!(adapter.operations.lock().await.is_empty());
    }

    #[tokio::test]
    async fn restart_recovery_reports_stale_acknowledged_command_as_unknown_without_replay() {
        let temp = tempfile::tempdir().expect("temp");
        let state = crate::state::LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        seed_single_slot_planogram(&state).await;

        let command = dispense_command_payload("CMD-STALE-ACK", 5);
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
            state.clone(),
            hardware,
            event_tx,
            CancellationToken::new(),
        );

        let recovered = runtime
            .recover_stale_active_dispense_commands_at(
                chrono::Utc::now() + chrono::Duration::seconds(90),
            )
            .await
            .expect("recover stale command");
        assert_eq!(recovered, 1);

        let command = state
            .get_command("CMD-STALE-ACK")
            .await
            .expect("read command")
            .expect("command");
        assert_eq!(
            command.status,
            vending_core::domain::CommandLogStatus::Failed
        );
        let result = command.result_payload.expect("unknown result");
        assert!(!result.success);
        assert_eq!(result.error_code.as_deref(), Some("UNKNOWN"));

        let due = state
            .list_due_outbox(chrono::Utc::now() + chrono::Duration::seconds(1))
            .await
            .expect("outbox");
        let result_events = due
            .iter()
            .filter(|event| {
                event.topic.as_deref() == Some("vem/machines/M1/events/dispense-result")
            })
            .count();
        assert_eq!(result_events, 1);
        assert!(adapter.operations.lock().await.is_empty());
    }

    #[tokio::test]
    async fn restart_recovery_reports_stale_dispensing_command_as_unknown_without_replay() {
        let temp = tempfile::tempdir().expect("temp");
        let state = crate::state::LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        seed_single_slot_planogram(&state).await;

        let command = dispense_command_payload("CMD-STALE-UNKNOWN", 5);
        let ack_event = crate::state::store::OutboxInput::command_ack("M1", &command.command_no);
        state
            .record_command_ack_tx(&command, &ack_event)
            .await
            .expect("acknowledged command");
        state
            .mark_command_dispensing(&command.command_no)
            .await
            .expect("dispensing command");

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

        let recovered = runtime
            .recover_stale_active_dispense_commands_at(
                chrono::Utc::now() + chrono::Duration::seconds(90),
            )
            .await
            .expect("recover stale command");
        assert_eq!(recovered, 1);

        let recovered_again = runtime
            .recover_stale_active_dispense_commands_at(
                chrono::Utc::now() + chrono::Duration::seconds(120),
            )
            .await
            .expect("recover final command");
        assert_eq!(recovered_again, 0);

        let command = state
            .get_command("CMD-STALE-UNKNOWN")
            .await
            .expect("read command")
            .expect("command");
        assert_eq!(
            command.status,
            vending_core::domain::CommandLogStatus::Failed
        );
        let result = command.result_payload.expect("unknown result");
        assert!(!result.success);
        assert_eq!(result.error_code.as_deref(), Some("UNKNOWN"));
        assert!(result.message.contains("unknown after daemon restart"));

        let due = state
            .list_due_outbox(chrono::Utc::now() + chrono::Duration::seconds(1))
            .await
            .expect("outbox");
        let result_event = due
            .iter()
            .find(|event| event.topic.as_deref() == Some("vem/machines/M1/events/dispense-result"))
            .expect("dispense result outbox");
        assert_eq!(
            result_event.payload_json["payload"]["commandNo"],
            "CMD-STALE-UNKNOWN"
        );
        assert_eq!(result_event.payload_json["payload"]["success"], false);
        assert_eq!(result_event.payload_json["payload"]["errorCode"], "UNKNOWN");
        let result_event_count = due
            .iter()
            .filter(|event| {
                event.topic.as_deref() == Some("vem/machines/M1/events/dispense-result")
            })
            .count();
        assert_eq!(result_event_count, 1);
        assert!(
            result_event.payload_json["signature"]
                .as_str()
                .unwrap_or_default()
                .len()
                >= 32
        );

        let sale_view = state.sale_view(Some("M1".to_string())).await.expect("sale");
        assert_eq!(sale_view.items[0].slot_sales_state, "frozen");
        assert!(adapter.operations.lock().await.is_empty());
    }

    fn signed_environment_command(
        command_no: &str,
        air_conditioner_on: Option<bool>,
        target_temperature_celsius: Option<i8>,
        vent_speed: Option<u8>,
    ) -> String {
        let command = EnvironmentControlCommandPayload {
            command_no: command_no.to_string(),
            air_conditioner_on,
            target_temperature_celsius,
            vent_speed,
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
    async fn mqtt_outbox_allows_one_durable_qos1_owner_until_matching_puback() {
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

        let first = crate::state::store::OutboxInput::command_ack("M1", "CMD-PUBACK-1");
        let second = crate::state::store::OutboxInput::command_ack("M1", "CMD-PUBACK-2");
        state.enqueue_outbox(&first).await.expect("seed first");
        state.enqueue_outbox(&second).await.expect("seed second");
        assert!(runtime.claim_mqtt_outbox_event(&first.id, false).await);
        assert!(!runtime.claim_mqtt_outbox_event(&second.id, false).await);
        runtime.record_mqtt_outbox_publish(7).await;
        runtime
            .acknowledge_mqtt_outbox_publish(6)
            .await
            .expect("ignore unrelated ack");
        assert!(state
            .outbox_record(&first.id)
            .await
            .expect("first")
            .is_some());
        runtime
            .acknowledge_mqtt_outbox_publish(7)
            .await
            .expect("ack first");
        assert!(state
            .outbox_record(&first.id)
            .await
            .expect("first")
            .is_none());
        assert!(runtime.claim_mqtt_outbox_event(&second.id, false).await);
        runtime.record_mqtt_outbox_publish(7).await;
        runtime
            .acknowledge_mqtt_outbox_publish(7)
            .await
            .expect("ack reused pkid");
        assert_eq!(state.outbox_size().await.expect("outbox size"), 0);
    }

    #[tokio::test]
    async fn mqtt_outbox_ignores_duplicate_outgoing_events_and_retries_across_generations() {
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

        let first = crate::state::store::OutboxInput::command_ack("M1", "CMD-FIRST");
        let second = crate::state::store::OutboxInput::command_ack("M1", "CMD-SECOND");
        state.enqueue_outbox(&first).await.expect("seed first");
        state.enqueue_outbox(&second).await.expect("seed second");
        assert!(runtime.claim_mqtt_outbox_event(&first.id, false).await);
        assert!(!runtime.claim_mqtt_outbox_event(&second.id, false).await);

        runtime.record_mqtt_outbox_publish(7).await;
        // A non-outbox QoS1 publish cannot steal this owner by colliding with
        // its packet id. Its later PubAck must leave the durable event intact.
        runtime.record_mqtt_outbox_publish(9).await;
        assert!(!runtime
            .acknowledge_mqtt_outbox_publish(9)
            .await
            .expect("ignore non-outbox packet id"));
        assert!(state
            .outbox_record(&first.id)
            .await
            .expect("first")
            .is_some());
        runtime
            .acknowledge_mqtt_outbox_publish(7)
            .await
            .expect("ack first");
        assert!(state
            .outbox_record(&first.id)
            .await
            .expect("first")
            .is_none());
        assert!(state
            .outbox_record(&second.id)
            .await
            .expect("second")
            .is_some());

        assert!(runtime.claim_mqtt_outbox_event(&second.id, false).await);

        let retry = crate::state::store::OutboxInput::command_ack("M1", "CMD-RETRY");
        state.enqueue_outbox(&retry).await.expect("seed retry");
        assert!(!runtime.claim_mqtt_outbox_event(&retry.id, false).await);
        runtime.record_mqtt_outbox_publish(7).await;
        runtime
            .acknowledge_mqtt_outbox_publish(7)
            .await
            .expect("ack reused packet id");
        assert!(state
            .outbox_record(&second.id)
            .await
            .expect("second")
            .is_none());
        assert!(runtime.claim_mqtt_outbox_event(&retry.id, false).await);
        runtime.record_mqtt_outbox_publish(9).await;
        runtime.begin_mqtt_generation().await;
        runtime.record_mqtt_outbox_publish(9).await;
        runtime
            .acknowledge_mqtt_outbox_publish(9)
            .await
            .expect("ack retry after reconnect");
        assert!(state
            .outbox_record(&retry.id)
            .await
            .expect("retry")
            .is_none());
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
    async fn enqueue_heartbeat_omits_reported_runtime_configuration_when_config_summary_fails() {
        let temp = tempfile::tempdir().expect("temp");
        let data_dir = temp.path().join("daemon");
        let state = crate::state::LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");

        let mut config = crate::config::default_public_config();
        config.machine_code = Some("M1".to_string());
        let context = test_readiness_context(&data_dir, state.clone(), config.clone()).await;
        let manifest_path = context.config_store.factory_manifest_path();
        tokio::fs::create_dir_all(manifest_path.parent().expect("manifest parent"))
            .await
            .expect("factory dir");
        tokio::fs::write(&manifest_path, "{not valid json")
            .await
            .expect("write invalid manifest");

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
        )
        .with_readiness_context(context);

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
        assert_eq!(envelope.payload["machineCode"], "M1");
        assert!(envelope.payload["statusPayload"]
            .get("reportedRuntimeConfiguration")
            .is_none());
    }

    #[tokio::test]
    async fn environment_query_e3_marks_sensor_faulted_immediately() {
        let temp = tempfile::tempdir().expect("temp");
        let state = crate::state::LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");

        let hardware = crate::hardware::HardwareSupervisor::from_adapter(Arc::new(
            RecordingEnvironmentAdapter {
                environment_query_error: Some(
                    "lower controller rejected environment query command: mechanical fault"
                        .to_string(),
                ),
                ..Default::default()
            },
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

        let error = runtime
            .sample_environment_once()
            .await
            .expect_err("E3 environment query should still surface the command error");
        assert!(error.contains("mechanical fault"));
        runtime.enqueue_heartbeat().await.expect("heartbeat");

        let due = state
            .list_due_outbox(chrono::Utc::now() + chrono::Duration::seconds(1))
            .await
            .expect("outbox");
        let envelope: vending_core::mqtt::MqttEnvelope =
            serde_json::from_value(due[0].payload_json.clone()).expect("envelope");
        let environment = &envelope.payload["statusPayload"]["environment"];
        assert_eq!(environment["sensorStatus"], "faulted");
    }

    #[tokio::test]
    async fn enqueue_heartbeat_reports_faulted_when_hardware_self_check_is_offline() {
        let temp = tempfile::tempdir().expect("temp");
        let state = crate::state::LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");

        let hardware = crate::hardware::HardwareSupervisor::from_adapter(Arc::new(
            RecordingEnvironmentAdapter {
                hardware_online: false,
                ..Default::default()
            },
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

        runtime.enqueue_heartbeat().await.expect("heartbeat");

        let due = state
            .list_due_outbox(chrono::Utc::now() + chrono::Duration::seconds(1))
            .await
            .expect("outbox");
        let envelope: vending_core::mqtt::MqttEnvelope =
            serde_json::from_value(due[0].payload_json.clone()).expect("envelope");
        let payload = &envelope.payload;
        assert_eq!(payload["statusPayload"]["hardwareStatus"], "faulted");
        assert_eq!(
            payload["statusPayload"]["hardwareMessage"],
            "lower controller unavailable"
        );
        assert_eq!(
            payload["statusPayload"]["saleReadiness"]["state"],
            "blocked"
        );
        assert_eq!(
            payload["statusPayload"]["saleReadiness"]["blockingCodes"][0],
            "LOWER_CONTROLLER_UNAVAILABLE"
        );
    }

    #[tokio::test]
    async fn enqueue_heartbeat_reports_whole_machine_maintenance_lock() {
        let temp = tempfile::tempdir().expect("temp");
        let state = crate::state::LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        state
            .put_metadata(
                crate::state::store::WHOLE_MACHINE_MAINTENANCE_LOCK_KEY,
                &crate::state::store::WholeMachineMaintenanceLock {
                    code: "WHOLE_MACHINE_HARDWARE_FAULT".to_string(),
                    message: "pickup platform blocked".to_string(),
                    source: "dispense_failure".to_string(),
                    order_no: "ORD-LOCKED".to_string(),
                    command_no: "CMD-LOCKED".to_string(),
                    slot_code: "A1".to_string(),
                    error_code: Some("JAMMED".to_string()),
                    created_at: crate::state::store::now_iso(),
                },
            )
            .await
            .expect("lock");
        let hardware = crate::hardware::HardwareSupervisor::from_adapter(Arc::new(
            RecordingEnvironmentAdapter {
                hardware_online: true,
                ..Default::default()
            },
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

        runtime.enqueue_heartbeat().await.expect("heartbeat");

        let due = state
            .list_due_outbox(chrono::Utc::now() + chrono::Duration::seconds(1))
            .await
            .expect("outbox");
        let envelope: vending_core::mqtt::MqttEnvelope =
            serde_json::from_value(due[0].payload_json.clone()).expect("envelope");
        let status = &envelope.payload["statusPayload"];
        assert_eq!(status["hardwareStatus"], "ok");
        assert_eq!(status["saleReadiness"]["state"], "locked");
        assert_eq!(
            status["wholeMachineMaintenanceLock"]["code"],
            "WHOLE_MACHINE_HARDWARE_FAULT"
        );
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
            vent_speed: None,
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
                Some(2),
            ))
            .await
            .expect("handle command");

        assert_eq!(
            adapter.operations.lock().await.as_slice(),
            ["B1:24", "B2:true", "B3:2"]
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
        assert_eq!(result.payload_json["payload"]["ventSpeed"], 2);
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
                None,
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
                None,
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
        assert_eq!(
            snapshot.next_action,
            Some(vending_core::domain::InternalCheckoutFlowAction::Success)
        );
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
                vent_speed: None,
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
                next_action: "dispensing",
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

    #[tokio::test]
    async fn secure_decommission_rejects_mismatched_message_identity_before_cleanup() {
        let temp = tempfile::tempdir().expect("temp");
        let state = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        let mut public = crate::config::default_public_config();
        public.machine_code = Some("M1".to_string());
        let context = test_readiness_context(temp.path(), state.clone(), public.clone()).await;
        let hardware = crate::hardware::HardwareSupervisor::from_config(&public).expect("hardware");
        let (event_tx, _rx) = tokio::sync::broadcast::channel(4);
        let runtime = MqttSyncRuntime::new(
            "M1".to_string(),
            "secret".to_string(),
            state.clone(),
            hardware,
            event_tx,
            CancellationToken::new(),
        )
        .with_readiness_context(context);
        let envelope = sign_envelope(
            "M1",
            "secret",
            "captured-message-id",
            serde_json::json!({
                "commandNo": "DCOM-MISMATCH",
                "operation": "secure-decommission",
                "requestedAt": crate::state::store::now_iso(),
            }),
        );

        let error = runtime
            .handle_secure_decommission_command(
                &serde_json::to_string(&envelope).expect("envelope"),
            )
            .await
            .expect_err("mismatched message identity");

        assert!(error.contains("message identity"));
        assert!(state
            .destructive_command("captured-message-id")
            .await
            .expect("command log")
            .is_none());
    }

    #[tokio::test]
    async fn secure_decommission_retries_persisted_failed_local_cleanup() {
        let temp = tempfile::tempdir().expect("temp");
        let state = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        let mut public = crate::config::default_public_config();
        public.machine_code = Some("M1".to_string());
        let hardware = crate::hardware::HardwareSupervisor::from_config(&public).expect("hardware");
        let (event_tx, _rx) = tokio::sync::broadcast::channel(4);
        let unavailable = MqttSyncRuntime::new(
            "M1".to_string(),
            "secret".to_string(),
            state.clone(),
            hardware,
            event_tx,
            CancellationToken::new(),
        );
        let envelope = sign_envelope(
            "M1",
            "secret",
            "secure-decommission:DCOM-RETRY",
            serde_json::json!({
                "commandNo": "DCOM-RETRY",
                "operation": "secure-decommission",
                "requestedAt": crate::state::store::now_iso(),
            }),
        );
        let payload = serde_json::to_string(&envelope).expect("envelope");

        unavailable
            .handle_secure_decommission_command(&payload)
            .await
            .expect("record failed cleanup");
        assert_eq!(
            state
                .destructive_command("secure-decommission:DCOM-RETRY")
                .await
                .expect("command log")
                .expect("failed command")
                .status,
            "failed"
        );

        let context = test_readiness_context(temp.path(), state.clone(), public.clone()).await;
        let hardware = crate::hardware::HardwareSupervisor::from_config(&public).expect("hardware");
        let (event_tx, _rx) = tokio::sync::broadcast::channel(4);
        let recovered = MqttSyncRuntime::new(
            "M1".to_string(),
            "secret".to_string(),
            state.clone(),
            hardware,
            event_tx,
            CancellationToken::new(),
        )
        .with_readiness_context(context);

        let retry = recovered
            .handle_secure_decommission_command(&payload)
            .await
            .expect("retry cleanup");
        assert!(matches!(retry, CommandHandlingResult::Processed { .. }));
        assert_eq!(
            state
                .destructive_command("secure-decommission:DCOM-RETRY")
                .await
                .expect("command log")
                .expect("recovered command")
                .status,
            "succeeded"
        );
        assert_eq!(
            state
                .outbox_record("M1:secure-decommission-result:DCOM-RETRY")
                .await
                .expect("outbox")
                .expect("result")
                .payload_json["payload"]["success"],
            true,
        );
    }

    #[tokio::test]
    async fn secure_decommission_qos_duplicate_is_logged_once_and_replays_no_cleanup() {
        let temp = tempfile::tempdir().expect("temp");
        let state = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        let mut public = crate::config::default_public_config();
        public.machine_code = Some("M1".to_string());
        let context = test_readiness_context(temp.path(), state.clone(), public.clone()).await;
        let hardware = crate::hardware::HardwareSupervisor::from_config(&public).expect("hardware");
        let (event_tx, _rx) = tokio::sync::broadcast::channel(4);
        let runtime = MqttSyncRuntime::new(
            "M1".to_string(),
            "secret".to_string(),
            state.clone(),
            hardware,
            event_tx,
            CancellationToken::new(),
        )
        .with_readiness_context(context);
        let envelope = sign_envelope(
            "M1",
            "secret",
            "secure-decommission:DCOM-1",
            serde_json::json!({
                "commandNo": "DCOM-1",
                "operation": "secure-decommission",
                "requestedAt": crate::state::store::now_iso(),
            }),
        );
        let payload = serde_json::to_string(&envelope).expect("envelope");

        let first = runtime
            .handle_secure_decommission_command(&payload)
            .await
            .expect("first delivery");
        let duplicate = runtime
            .handle_secure_decommission_command(&payload)
            .await
            .expect("QoS duplicate");

        assert!(matches!(first, CommandHandlingResult::Processed { .. }));
        assert!(matches!(
            duplicate,
            CommandHandlingResult::DuplicateFinal { .. }
        ));
        let record = state
            .destructive_command("secure-decommission:DCOM-1")
            .await
            .expect("command log")
            .expect("logged command");
        assert_eq!(record.status, "succeeded");
        assert!(state
            .outbox_record("M1:secure-decommission-result:DCOM-1")
            .await
            .expect("outbox")
            .is_some());

        drop(runtime);
        let reopened = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("reopened state");
        let context = test_readiness_context(temp.path(), reopened.clone(), public.clone()).await;
        let hardware = crate::hardware::HardwareSupervisor::from_config(&public).expect("hardware");
        let (event_tx, _rx) = tokio::sync::broadcast::channel(4);
        let restarted = MqttSyncRuntime::new(
            "M1".to_string(),
            "secret".to_string(),
            reopened,
            hardware,
            event_tx,
            CancellationToken::new(),
        )
        .with_readiness_context(context);
        let replay_after_restart = restarted
            .handle_secure_decommission_command(&payload)
            .await
            .expect("captured replay after restart");
        assert!(matches!(
            replay_after_restart,
            CommandHandlingResult::DuplicateFinal { .. }
        ));
    }

    #[tokio::test]
    async fn secure_decommission_waits_for_persisted_platform_ack_before_finalizing() {
        let temp = tempfile::tempdir().expect("temp");
        let state = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        let mut public = crate::config::default_public_config();
        public.machine_code = Some("M1".to_string());
        let context = test_readiness_context(temp.path(), state.clone(), public).await;
        let hardware = crate::hardware::HardwareSupervisor::from_config(
            &context
                .config_store
                .load_public_config()
                .await
                .expect("public config"),
        )
        .expect("hardware");
        let shutdown = CancellationToken::new();
        let (event_tx, _rx) = tokio::sync::broadcast::channel(4);
        let runtime = MqttSyncRuntime::new(
            "M1".to_string(),
            "secret".to_string(),
            state.clone(),
            hardware,
            event_tx,
            shutdown.clone(),
        )
        .with_readiness_context(context.clone());
        let command_no = "DCOM-ACK";
        let command = sign_envelope(
            "M1",
            "secret",
            &format!("secure-decommission:{command_no}"),
            serde_json::json!({
                "commandNo": command_no,
                "operation": "secure-decommission",
                "requestedAt": crate::state::store::now_iso(),
            }),
        );

        runtime
            .handle_secure_decommission_command(&serde_json::to_string(&command).expect("command"))
            .await
            .expect("local cleanup");
        runtime.flush_due_outbox().await.expect("publish result");

        assert!(state
            .outbox_record("M1:secure-decommission-result:DCOM-ACK")
            .await
            .expect("outbox")
            .is_some());
        assert_eq!(
            context
                .config_store
                .load_public_config()
                .await
                .expect("public config")
                .machine_code
                .as_deref(),
            Some("M1"),
        );
        assert!(!shutdown.is_cancelled());

        let acknowledgement = sign_envelope(
            "M1",
            "secret",
            &format!("secure-decommission-ack:{command_no}"),
            serde_json::json!({
                "commandNo": command_no,
                "operation": "secure-decommission-ack",
                "acknowledgedAt": crate::state::store::now_iso(),
            }),
        );
        let first_ack = runtime
            .handle_secure_decommission_ack(
                &serde_json::to_string(&acknowledgement).expect("acknowledgement"),
            )
            .await
            .expect("platform acknowledgement");
        let duplicate_ack = runtime
            .handle_secure_decommission_ack(
                &serde_json::to_string(&acknowledgement).expect("acknowledgement"),
            )
            .await
            .expect("duplicate platform acknowledgement");

        assert!(matches!(first_ack, CommandHandlingResult::Processed { .. }));
        assert!(matches!(
            duplicate_ack,
            CommandHandlingResult::DuplicateFinal { .. }
        ));

        assert!(state
            .outbox_record("M1:secure-decommission-result:DCOM-ACK")
            .await
            .expect("outbox")
            .is_none());
        assert!(context
            .config_store
            .load_public_config()
            .await
            .expect("public config")
            .machine_code
            .is_none());
        assert!(context
            .config_store
            .runtime_secrets()
            .await
            .expect("runtime secrets")
            .mqtt_signing_secret
            .is_none());
        assert!(shutdown.is_cancelled());

        let duplicate_command = runtime
            .handle_secure_decommission_command(&serde_json::to_string(&command).expect("command"))
            .await
            .expect("duplicate command after final acknowledgement");
        assert!(matches!(
            duplicate_command,
            CommandHandlingResult::DuplicateFinal { .. }
        ));
        assert!(state
            .outbox_record("M1:secure-decommission-result:DCOM-ACK")
            .await
            .expect("outbox")
            .is_none());

        let mut reprovisioned = crate::config::default_public_config();
        reprovisioned.machine_code = Some("M1".to_string());
        context
            .config_store
            .save_public_config(reprovisioned.clone())
            .await
            .expect("reprovision");
        let hardware =
            crate::hardware::HardwareSupervisor::from_config(&reprovisioned).expect("hardware");
        let (event_tx, _rx) = tokio::sync::broadcast::channel(4);
        let restarted = MqttSyncRuntime::new(
            "M1".to_string(),
            "secret".to_string(),
            state.clone(),
            hardware,
            event_tx,
            CancellationToken::new(),
        )
        .with_readiness_context(context.clone());
        let replay_after_restart = restarted
            .handle_secure_decommission_command(&serde_json::to_string(&command).expect("command"))
            .await
            .expect("replay after reprovision and restart");
        assert!(matches!(
            replay_after_restart,
            CommandHandlingResult::DuplicateFinal { .. }
        ));
        assert!(state
            .outbox_record("M1:secure-decommission-result:DCOM-ACK")
            .await
            .expect("outbox")
            .is_none());
    }
}

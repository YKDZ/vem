use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

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

type EnvironmentCommandTask = tokio::task::JoinHandle<Result<CommandHandlingResult, String>>;

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
    environment_command_in_progress: Arc<AtomicBool>,
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
            environment_command_in_progress: Arc::new(AtomicBool::new(false)),
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

    fn invalidate_sale_start_capability(&self, reason: &str) {
        let _ = self
            .events
            .send(DaemonEvent::SaleStartCapabilityInvalidated {
                event_id: Uuid::new_v4().simple().to_string(),
                updated_at: crate::state::store::now_iso(),
                reason: reason.to_string(),
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
                            result.lower_controller_fault,
                        )
                        .await
                        .map_err(|error| error.to_string())?;
                    self.invalidate_sale_start_capability("dispense_failure");
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
        let (progress_sender, mut progress_receiver) =
            tokio::sync::mpsc::unbounded_channel::<vending_core::hardware::DispenseProgressEvent>();
        let progress_state = self.state.clone();
        let progress_events = self.events.clone();
        let progress_worker = tokio::spawn(async move {
            while let Some(event) = progress_receiver.recv().await {
                let order_no = event.order_no.clone();
                if matches!(
                    progress_state.record_dispense_progress(&event).await,
                    Ok(true)
                ) {
                    let _ = progress_events.send(DaemonEvent::TransactionChanged {
                        event_id: Uuid::new_v4().simple().to_string(),
                        updated_at: crate::state::store::now_iso(),
                        order_no,
                        status: "dispensing".to_string(),
                    });
                }
            }
        });
        let progress_sender_for_observer = progress_sender.clone();
        let progress: DispenseProgressObserver = Arc::new(move |event| {
            let _ = progress_sender_for_observer.send(event);
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
                lower_controller_fault: None,
            },
        };
        drop(progress_sender);
        progress_worker
            .await
            .map_err(|error| format!("dispense progress worker failed: {error}"))?;
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
                    result.lower_controller_fault,
                )
                .await
                .map_err(|error| error.to_string())?;
            self.invalidate_sale_start_capability("dispense_failure");
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
                lower_controller_fault: None,
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
            self.invalidate_sale_start_capability("dispense_result_unknown");
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

        if command.vent_speed.is_some() {
            if let Some(context) = self.readiness_context.as_ref() {
                context.automatic_vent.supersede_by_admin().await;
            }
        }

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

        let deadline = environment_command_deadline(&envelope.issued_at, command.timeout_seconds)?;
        if command_deadline_elapsed(&deadline) {
            self.enqueue_environment_control_result(
                &command,
                false,
                Some("COMMAND_EXPIRED".to_string()),
                Some("environment control command expired before execution".to_string()),
                None,
                None,
                None,
            )
            .await?;
            return Ok(CommandHandlingResult::Processed {
                command_no: command.command_no,
            });
        }

        if self.is_dispense_in_progress().await? {
            self.enqueue_environment_control_result(
                &command,
                false,
                Some("DISPENSE_IN_PROGRESS".to_string()),
                Some("a dispense operation is in progress".to_string()),
                None,
                None,
                None,
            )
            .await?;
            return Ok(CommandHandlingResult::Processed {
                command_no: command.command_no,
            });
        }

        let environment_guard = match self.acquire_environment_command_lock() {
            Ok(guard) => guard,
            Err(error) => {
                self.enqueue_environment_control_result(
                    &command,
                    false,
                    Some(error),
                    Some("another environment control command is in progress".to_string()),
                    None,
                    None,
                    None,
                )
                .await?;
                return Ok(CommandHandlingResult::Processed {
                    command_no: command.command_no,
                });
            }
        };

        let Some(remaining) = command_deadline_remaining(&deadline) else {
            self.enqueue_environment_control_result(
                &command,
                false,
                Some("COMMAND_EXPIRED".to_string()),
                Some("environment control command deadline elapsed".to_string()),
                None,
                None,
                None,
            )
            .await?;
            return Ok(CommandHandlingResult::Processed {
                command_no: command.command_no,
            });
        };
        let hardware = if command.vent_speed.is_none() {
            Some(
                match tokio::time::timeout(remaining, self.hardware.acquire_environment_hardware())
                    .await
                {
                    Ok(hardware) => hardware,
                    Err(_) => {
                        self.enqueue_environment_control_result(
                            &command,
                            false,
                            Some("COMMAND_EXPIRED".to_string()),
                            Some("environment control command deadline elapsed".to_string()),
                            None,
                            None,
                            None,
                        )
                        .await?;
                        return Ok(CommandHandlingResult::Processed {
                            command_no: command.command_no,
                        });
                    }
                },
            )
        } else {
            None
        };

        let mut confirmed_target = None;
        let mut confirmed_switch = None;
        let mut confirmed_vent_speed = None;
        let mut failure = None;

        if let Some(target) = command.target_temperature_celsius {
            if let Some(remaining) = command_deadline_remaining(&deadline) {
                match tokio::time::timeout(
                    remaining,
                    hardware
                        .as_ref()
                        .expect("non-B3 command has hardware ownership")
                        .set_target_temperature(target),
                )
                .await
                {
                    Err(_) => {
                        failure = Some((
                            "COMMAND_EXPIRED".to_string(),
                            "environment control command deadline elapsed".to_string(),
                        ))
                    }
                    Ok(Ok(())) => confirmed_target = Some(target),
                    Ok(Err(error)) => {
                        failure = Some(("target_temperature_failed".to_string(), error))
                    }
                }
            } else {
                failure = Some((
                    "COMMAND_EXPIRED".to_string(),
                    "environment control command deadline elapsed".to_string(),
                ));
            };
        }

        if failure.is_none() {
            if let Some(enabled) = command.air_conditioner_on {
                if let Some(remaining) = command_deadline_remaining(&deadline) {
                    match tokio::time::timeout(
                        remaining,
                        hardware
                            .as_ref()
                            .expect("non-B3 command has hardware ownership")
                            .set_air_conditioner_enabled(enabled),
                    )
                    .await
                    {
                        Err(_) => {
                            failure = Some((
                                "COMMAND_EXPIRED".to_string(),
                                "environment control command deadline elapsed".to_string(),
                            ))
                        }
                        Ok(Ok(())) => confirmed_switch = Some(enabled),
                        Ok(Err(error)) => {
                            failure = Some(("air_conditioner_switch_failed".to_string(), error))
                        }
                    }
                } else {
                    failure = Some((
                        "COMMAND_EXPIRED".to_string(),
                        "environment control command deadline elapsed".to_string(),
                    ));
                };
            }
        }

        if failure.is_none() {
            if let Some(speed) = command.vent_speed {
                if let Some(remaining) = command_deadline_remaining(&deadline) {
                    let set_vent_speed = async {
                        if let Some(context) = self.readiness_context.as_ref() {
                            context.automatic_vent.execute_admin_one_shot(speed).await
                        } else {
                            let hardware = self.hardware.acquire_environment_hardware().await;
                            hardware.set_vent_speed(speed).await
                        }
                    };
                    match tokio::time::timeout(remaining, set_vent_speed).await {
                        Err(_) => {
                            failure = Some((
                                "COMMAND_EXPIRED".to_string(),
                                "environment control command deadline elapsed".to_string(),
                            ))
                        }
                        Ok(Ok(())) => confirmed_vent_speed = Some(speed),
                        Ok(Err(error)) => failure = Some(("vent_speed_failed".to_string(), error)),
                    }
                } else {
                    failure = Some((
                        "COMMAND_EXPIRED".to_string(),
                        "environment control command deadline elapsed".to_string(),
                    ));
                };
            }
        }

        let (mut success, mut error_code, mut message) = match failure {
            Some((error_code, message)) => (false, Some(error_code), Some(message)),
            None => (
                true,
                None,
                Some("environment control completed".to_string()),
            ),
        };

        if success && command_deadline_elapsed(&deadline) {
            success = false;
            error_code = Some("COMMAND_EXPIRED".to_string());
            message = Some("environment control command deadline elapsed".to_string());
        }

        // A terminal result means the physical command no longer owns the
        // controller. Release both guards before making that result observable.
        drop(hardware);
        drop(environment_guard);

        if success {
            let remaining = command_deadline_remaining(&deadline)
                .ok_or_else(|| "environment control command deadline elapsed".to_string())?;
            tokio::time::timeout(
                remaining,
                self.enqueue_environment_control_result(
                    &command,
                    success,
                    error_code,
                    message,
                    confirmed_switch,
                    confirmed_target,
                    confirmed_vent_speed,
                ),
            )
            .await
            .map_err(|_| "environment control command deadline elapsed".to_string())??;
        } else {
            self.enqueue_environment_control_result(
                &command,
                success,
                error_code,
                message,
                confirmed_switch,
                confirmed_target,
                confirmed_vent_speed,
            )
            .await?;
        }

        Ok(CommandHandlingResult::Processed {
            command_no: command.command_no,
        })
    }

    async fn reject_environment_command_while_slot_occupied(
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
        self.enqueue_environment_control_result(
            &command,
            false,
            Some("ENVIRONMENT_COMMAND_IN_PROGRESS".to_string()),
            Some("another environment control command is in progress".to_string()),
            None,
            None,
            None,
        )
        .await?;
        Ok(CommandHandlingResult::Processed {
            command_no: command.command_no,
        })
    }

    async fn dispatch_environment_command(
        self: &Arc<Self>,
        payload_text: String,
        task_slot: &mut Option<EnvironmentCommandTask>,
    ) -> Result<CommandHandlingResult, String> {
        if task_slot.is_some() {
            return self
                .reject_environment_command_while_slot_occupied(&payload_text)
                .await;
        }

        let runtime = self.clone();
        *task_slot = Some(tokio::spawn(async move {
            runtime
                .handle_environment_control_command(&payload_text)
                .await
        }));
        Ok(CommandHandlingResult::Processed {
            command_no: String::new(),
        })
    }

    async fn enqueue_environment_control_result(
        &self,
        command: &EnvironmentControlCommandPayload,
        // Kept for now: keep caller-specific timeout checks in the single command
        // handler so no queueing policy leaks into this helper.
        success: bool,
        error_code: Option<String>,
        message: Option<String>,
        confirmed_switch: Option<bool>,
        confirmed_target: Option<i8>,
        confirmed_vent_speed: Option<u8>,
    ) -> Result<(), String> {
        let result = EnvironmentControlResultPayload {
            command_no: command.command_no.clone(),
            success,
            error_code,
            message,
            air_conditioner_on: confirmed_switch,
            target_temperature_celsius: confirmed_target,
            vent_speed: confirmed_vent_speed,
            reported_at: crate::state::store::now_iso(),
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

        Ok(())
    }

    async fn is_dispense_in_progress(&self) -> Result<bool, String> {
        let snapshot = self.state.current_transaction_snapshot().await?;
        Ok(snapshot.is_some_and(|snapshot| {
            snapshot.next_action.is_some_and(|status| {
                status == vending_core::domain::InternalCheckoutFlowAction::Dispensing
            }) || snapshot
                .order_status
                .as_deref()
                .is_some_and(|status| status == "dispensing")
        }))
    }

    fn acquire_environment_command_lock(
        &self,
    ) -> Result<EnvironmentCommandInProgressGuard, String> {
        self.environment_command_in_progress
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "ENVIRONMENT_COMMAND_IN_PROGRESS".to_string())?;

        Ok(EnvironmentCommandInProgressGuard {
            in_progress: self.environment_command_in_progress.clone(),
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
            let changed = {
                let mut cached = context.ui.status_cache.hardware.write().await;
                let changed = cached.online != hardware_status.online
                    || cached.port_path != hardware_status.port_path
                    || cached.adapter != hardware_status.adapter
                    || cached.message != hardware_status.message;
                *cached = hardware_status.clone();
                changed
            };
            if changed {
                self.invalidate_sale_start_capability("hardware_status_changed");
            }
        }
        let whole_machine_lock = self
            .state
            .whole_machine_maintenance_lock()
            .await
            .map_err(|error| format!("read whole-machine maintenance lock failed: {error}"))?;
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

        let mut acknowledged_subscriptions = 0_u8;
        let mut environment_task = None;
        let result = loop {
            tokio::select! {
                _ = self.shutdown.cancelled() => {
                    break Ok(());
                }
                completed = async {
                    environment_task.as_mut().expect("guarded environment task").await
                }, if environment_task.is_some() => {
                    environment_task = None;
                    match completed {
                        Ok(Ok(_)) => self.schedule_due_outbox(),
                        Ok(Err(error)) => {
                            self.set_connected(false, Some(format!("publish handle failed: {error}"))).await;
                        }
                        Err(error) => {
                            self.set_connected(false, Some(format!("environment task failed: {error}"))).await;
                        }
                    }
                }
                event = event_loop.poll() => {
                    match event {
                        Ok(Event::Incoming(Packet::ConnAck(_))) => {
                            self.begin_mqtt_generation().await;
                            acknowledged_subscriptions = 0;
                            self.set_connected(
                                false,
                                Some("waiting for command subscriptions".to_string()),
                            )
                            .await;
                            self.schedule_due_outbox();
                        }
                        Ok(Event::Incoming(Packet::SubAck(_))) => {
                            acknowledged_subscriptions =
                                acknowledged_subscriptions.saturating_add(1);
                            if acknowledged_subscriptions >= 2 {
                                self.set_connected(true, None).await;
                            }
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
                                if environment_task.as_ref().is_some_and(|task: &EnvironmentCommandTask| {
                                    task.is_finished()
                                        || !self.environment_command_in_progress.load(Ordering::Acquire)
                                }) {
                                    let completed = environment_task.take().expect("finished environment task").await;
                                    if let Ok(Err(error)) = completed {
                                        self.set_connected(false, Some(format!("publish handle failed: {error}"))).await;
                                    }
                                }
                                if environment_task.is_some() {
                                    self.reject_environment_command_while_slot_occupied(&text).await
                                } else {
                                    self.dispatch_environment_command(text, &mut environment_task).await
                                }
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
        if let Some(task) = environment_task {
            task.abort();
        }
        result
    }
}

impl From<StoreError> for String {
    fn from(error: StoreError) -> Self {
        error.to_string()
    }
}

struct EnvironmentCommandInProgressGuard {
    in_progress: Arc<AtomicBool>,
}

impl Drop for EnvironmentCommandInProgressGuard {
    fn drop(&mut self) {
        self.in_progress.store(false, Ordering::Release);
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
    let action_count = command.air_conditioner_on.is_some() as u8
        + command.target_temperature_celsius.is_some() as u8
        + command.vent_speed.is_some() as u8;
    if action_count != 1 {
        return Err("environment control command must request exactly one action".to_string());
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

fn environment_command_deadline(
    issued_at: &str,
    timeout_seconds: u64,
) -> Result<DateTime<Utc>, String> {
    let issued_at = DateTime::parse_from_rfc3339(issued_at)
        .map_err(|error| format!("parse issuedAt failed: {error}"))?
        .with_timezone(&Utc);
    let timeout_seconds = i64::try_from(timeout_seconds)
        .map_err(|_| "environment control command timeoutSeconds is out of range".to_string())?;
    issued_at
        .checked_add_signed(chrono::Duration::seconds(timeout_seconds))
        .ok_or_else(|| "environment control command deadline is out of range".to_string())
}

fn command_deadline_remaining(deadline: &DateTime<Utc>) -> Option<Duration> {
    deadline
        .signed_duration_since(Utc::now())
        .to_std()
        .ok()
        .filter(|duration| !duration.is_zero())
}

fn command_deadline_elapsed(deadline: &DateTime<Utc>) -> bool {
    command_deadline_remaining(deadline).is_none()
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
    use crate::{
        hardware::HardwareSupervisor,
        state::{
            store::{MachinePlanogramInput, MachinePlanogramSlotInput, StockMovementInput},
            OrderSessionUpsert,
        },
    };
    use async_trait::async_trait;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    use std::{
        sync::atomic::{AtomicUsize, Ordering},
        time::Duration as StdDuration,
    };
    use vending_core::{
        hardware::{
            DispenseCommandPayload, EnvironmentControlCommandPayload, HardwareAdapter,
            HardwareStatus, SlotPayload,
        },
        serial::EnvironmentSample,
    };

    #[derive(Debug, Default)]
    struct EnvironmentCommandCalls {
        target_temperature_calls: AtomicUsize,
        air_conditioner_calls: AtomicUsize,
        vent_speed_calls: AtomicUsize,
    }

    #[derive(Debug, Clone)]
    struct TrackingEnvironmentHardware {
        calls: Arc<EnvironmentCommandCalls>,
        command_delay_ms: u64,
    }

    type HmacSha256 = Hmac<Sha256>;

    impl TrackingEnvironmentHardware {
        fn new(command_delay_ms: u64) -> (Self, Arc<EnvironmentCommandCalls>) {
            let calls = Arc::new(EnvironmentCommandCalls::default());
            (
                Self {
                    calls: calls.clone(),
                    command_delay_ms,
                },
                calls,
            )
        }

        fn delay(&self) -> StdDuration {
            StdDuration::from_millis(self.command_delay_ms)
        }
    }

    #[async_trait]
    impl HardwareAdapter for TrackingEnvironmentHardware {
        fn adapter_name(&self) -> &str {
            "test"
        }

        async fn self_check(&self) -> HardwareStatus {
            HardwareStatus {
                adapter: "test".to_string(),
                online: true,
                message: "test controller".to_string(),
                port_path: None,
                resolution_source: Some("test".to_string()),
                bound_usb_identity: None,
                candidates: vec![],
                lower_controller_fault: None,
            }
        }

        async fn query_environment_sample(&self) -> Result<Option<EnvironmentSample>, String> {
            tokio::time::sleep(self.delay()).await;
            Ok(None)
        }

        async fn set_target_temperature(&self, _temperature_celsius: i8) -> Result<(), String> {
            tokio::time::sleep(self.delay()).await;
            self.calls
                .target_temperature_calls
                .fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        async fn set_air_conditioner_enabled(&self, _enabled: bool) -> Result<(), String> {
            tokio::time::sleep(self.delay()).await;
            self.calls
                .air_conditioner_calls
                .fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        async fn set_vent_speed(&self, _speed: u8) -> Result<(), String> {
            tokio::time::sleep(self.delay()).await;
            self.calls.vent_speed_calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        async fn dispense(
            &self,
            command: vending_core::hardware::DispenseCommandPayload,
        ) -> vending_core::hardware::DispenseResultPayload {
            vending_core::hardware::DispenseResultPayload {
                command_no: command.command_no,
                success: true,
                error_code: None,
                message: "ok".to_string(),
                reported_at: crate::state::store::now_iso(),
                lower_controller_fault: None,
            }
        }
    }

    fn environment_control_command(
        command_no: &str,
        air: Option<bool>,
        target: Option<i8>,
        vent: Option<u8>,
        timeout_seconds: u64,
    ) -> EnvironmentControlCommandPayload {
        EnvironmentControlCommandPayload {
            command_no: command_no.to_string(),
            air_conditioner_on: air,
            target_temperature_celsius: target,
            vent_speed: vent,
            timeout_seconds,
        }
    }

    fn canonical_json(value: &serde_json::Value) -> String {
        fn canonical_json_value(value: &serde_json::Value) -> String {
            match value {
                serde_json::Value::Object(map) => {
                    let mut keys: Vec<&String> = map.keys().collect();
                    keys.sort_unstable();
                    let pairs: Vec<String> = keys
                        .into_iter()
                        .map(|key| {
                            format!(
                                "{}:{}",
                                serde_json::to_string(key).unwrap_or_default(),
                                canonical_json_value(&map[key])
                            )
                        })
                        .collect();
                    format!("{{{}}}", pairs.join(","))
                }
                serde_json::Value::Array(items) => {
                    let inner: Vec<String> = items.iter().map(canonical_json_value).collect();
                    format!("[{}]", inner.join(","))
                }
                serde_json::Value::String(s) => serde_json::to_string(s).unwrap_or_default(),
                other => other.to_string(),
            }
        }

        match value {
            serde_json::Value::Object(map) => {
                let mut keys: Vec<&String> = map.keys().collect();
                keys.sort_unstable();
                let pairs: Vec<String> = keys
                    .into_iter()
                    .map(|key| {
                        format!(
                            "{}:{}",
                            serde_json::to_string(key).unwrap_or_default(),
                            canonical_json_value(&map[key])
                        )
                    })
                    .collect();
                format!("{{{}}}", pairs.join(","))
            }
            _ => canonical_json_value(value),
        }
    }

    fn sign_envelope_with_issued_at(
        machine_code: &str,
        secret: &str,
        message_id: &str,
        payload: &serde_json::Value,
        issued_at: &str,
    ) -> String {
        let nonce = Uuid::new_v4().to_string();
        let unsigned = serde_json::json!({
            "issuedAt": issued_at,
            "machineCode": machine_code,
            "messageId": message_id,
            "nonce": nonce,
            "payload": payload,
        });
        let input = canonical_json(&unsigned);
        let mut mac =
            HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key size");
        mac.update(input.as_bytes());
        let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());

        serde_json::to_string(&serde_json::json!({
            "messageId": message_id,
            "machineCode": machine_code,
            "issuedAt": issued_at,
            "nonce": nonce,
            "payload": payload,
            "signature": signature,
        }))
        .expect("envelope")
    }

    fn environment_control_envelope(
        machine_code: &str,
        secret: &str,
        message_id: &str,
        command: &EnvironmentControlCommandPayload,
        issued_at: Option<&str>,
    ) -> String {
        let payload = serde_json::to_value(command).expect("command payload");
        if let Some(issued_at) = issued_at {
            sign_envelope_with_issued_at(machine_code, secret, message_id, &payload, issued_at)
        } else {
            serde_json::to_string(&sign_envelope(machine_code, secret, message_id, payload))
                .expect("envelope")
        }
    }

    fn command_result_payload_by_no<'a>(
        events: &'a [crate::state::store::OutboxRecord],
        machine_code: &str,
        command_no: &str,
    ) -> Option<&'a serde_json::Value> {
        let topic = format!(
            "vem/machines/{}/events/environment-control-result",
            machine_code
        );
        events
            .iter()
            .find(|event| {
                event.topic.as_deref() == Some(topic.as_str())
                    && event.payload_json["payload"]["commandNo"].as_str() == Some(command_no)
            })
            .map(|event| &event.payload_json)
    }

    fn order_session_in_dispense(command_no: &str) -> OrderSessionUpsert<'static> {
        OrderSessionUpsert {
            order_no: "ORDER-ENV",
            payment_method: "payment_code",
            payment_provider: Some("alipay"),
            items_json: serde_json::json!([{ "slotId": "A1", "quantity": 1 }]),
            status: "dispensing",
            next_action: "dispensing",
            payment_attempt_json: None,
            recovery_strategy: "local",
            last_backend_status_json: Some(serde_json::json!({
                "orderNo": "ORDER-ENV",
                "orderStatus": "dispensing",
                "nextAction": "dispensing",
                "vending": {
                    "commandNo": command_no,
                    "status": "dispensing"
                }
            })),
            last_error: None,
        }
    }

    #[tokio::test]
    async fn successful_last_unit_dispense_emits_transaction_change_without_waiting_for_polling() {
        let temp = tempfile::tempdir().expect("temp");
        let state = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        state
            .apply_planogram(MachinePlanogramInput {
                planogram_version: "PLAN-LAST-UNIT".to_string(),
                source: "test".to_string(),
                applied_by: None,
                slots: vec![MachinePlanogramSlotInput {
                    slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                    row_no: 1,
                    cell_no: 1,
                    capacity: 1,
                    par_level: 1,
                    inventory_id: "550e8400-e29b-41d4-a716-446655440002".to_string(),
                    variant_id: "550e8400-e29b-41d4-a716-446655440003".to_string(),
                    product_id: "550e8400-e29b-41d4-a716-446655440004".to_string(),
                    product_name: "water".to_string(),
                    product_description: None,
                    cover_image_url: None,
                    try_on_silhouette_url: None,
                    category_id: None,
                    category_name: None,
                    sku: "WATER-001".to_string(),
                    size: None,
                    color: None,
                    price_cents: 200,
                    product_sort_order: 1,
                    target_gender: None,
                }],
            })
            .await
            .expect("planogram");
        state
            .record_stock_movement(StockMovementInput {
                movement_id: "COUNT-LAST-UNIT".to_string(),
                planogram_version: "PLAN-LAST-UNIT".to_string(),
                slot_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
                movement_type: "stock_count_correction".to_string(),
                quantity: 1,
                source: "test".to_string(),
                attributed_to: None,
            })
            .await
            .expect("stock");
        let command = DispenseCommandPayload {
            command_no: "CMD-LAST-UNIT".to_string(),
            order_no: "ORDER-LAST-UNIT".to_string(),
            slot: SlotPayload {
                row_no: 1,
                cell_no: 1,
                slot_id: "A1".to_string(),
            },
            quantity: 1,
            timeout_seconds: 2,
        };
        state
            .upsert_order_session(OrderSessionUpsert {
                order_no: &command.order_no,
                payment_method: "payment_code",
                payment_provider: Some("mock"),
                items_json: json!([{ "slotId": "A1", "quantity": 1 }]),
                status: "dispensing",
                next_action: "dispensing",
                payment_attempt_json: None,
                recovery_strategy: "local",
                last_backend_status_json: Some(json!({
                    "orderNo": command.order_no,
                    "orderStatus": "dispensing",
                    "nextAction": "dispensing",
                    "vending": {
                        "commandNo": command.command_no,
                        "status": "dispensing"
                    }
                })),
                last_error: None,
            })
            .await
            .expect("order");

        let (events, mut received) = broadcast::channel(8);
        let runtime = MqttSyncRuntime::new(
            "MACHINE-LAST-UNIT".to_string(),
            "mqtt-signing-secret-for-last-unit-test".to_string(),
            state.clone(),
            HardwareSupervisor::from_adapter(Arc::new(vending_core::hardware::MockHardwareAdapter)),
            events,
            CancellationToken::new(),
        );
        let envelope = sign_envelope(
            "MACHINE-LAST-UNIT",
            "mqtt-signing-secret-for-last-unit-test",
            "MESSAGE-LAST-UNIT",
            serde_json::to_value(command).expect("command payload"),
        );

        runtime
            .handle_dispense_command(&serde_json::to_string(&envelope).expect("envelope"))
            .await
            .expect("successful dispense");

        assert!(matches!(
            received.recv().await.expect("immediate transaction event"),
            DaemonEvent::TransactionChanged { order_no, status, .. }
                if order_no == "ORDER-LAST-UNIT" && status == "success"
        ));
        let sale_view = state.sale_view(None).await.expect("sale view");
        assert_eq!(sale_view.items[0].saleable_stock, 0);
        assert_eq!(sale_view.items[0].slot_sales_state, "sold_out");
    }

    #[tokio::test]
    async fn environment_control_requires_exactly_one_action() {
        let temp = tempfile::tempdir().expect("temp");
        let state = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        let (hardware, calls) = TrackingEnvironmentHardware::new(0);
        let runtime = Arc::new(MqttSyncRuntime::new(
            "MACHINE-ENV".to_string(),
            "mqtt-signing-secret-for-env".to_string(),
            state.clone(),
            HardwareSupervisor::from_adapter(Arc::new(hardware)),
            broadcast::channel(1).0,
            CancellationToken::new(),
        ));
        let command = environment_control_command("ENV-ONE", Some(true), Some(24), None, 5);

        let envelope = environment_control_envelope(
            "MACHINE-ENV",
            "mqtt-signing-secret-for-env",
            "ENV-ONE-MSG",
            &command,
            None,
        );
        let error = runtime
            .handle_environment_control_command(&envelope)
            .await
            .expect_err("invalid action combination must fail");
        assert_eq!(
            error,
            "environment control command must request exactly one action"
        );

        let events = state
            .list_due_outbox(chrono::Utc::now())
            .await
            .expect("environment outbox");
        assert!(events.is_empty());
        assert_eq!(calls.target_temperature_calls.load(Ordering::SeqCst), 0);
        assert_eq!(calls.air_conditioner_calls.load(Ordering::SeqCst), 0);
        assert_eq!(calls.vent_speed_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn environment_control_rejects_expired_command_before_hardware_call() {
        let temp = tempfile::tempdir().expect("temp");
        let state = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        let (hardware, calls) = TrackingEnvironmentHardware::new(0);
        let runtime = MqttSyncRuntime::new(
            "MACHINE-ENV".to_string(),
            "mqtt-signing-secret-for-env".to_string(),
            state.clone(),
            HardwareSupervisor::from_adapter(Arc::new(hardware)),
            broadcast::channel(1).0,
            CancellationToken::new(),
        );

        let command = environment_control_command("ENV-EXPIRED", Some(true), None, None, 2);
        let issued_at = (chrono::Utc::now() - chrono::Duration::seconds(10))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let envelope = environment_control_envelope(
            "MACHINE-ENV",
            "mqtt-signing-secret-for-env",
            "ENV-EXPIRED-MSG",
            &command,
            Some(&issued_at),
        );
        runtime
            .handle_environment_control_command(&envelope)
            .await
            .expect("environment command");

        let events = state
            .list_due_outbox(chrono::Utc::now())
            .await
            .expect("environment outbox");
        let result = command_result_payload_by_no(&events, "MACHINE-ENV", "ENV-EXPIRED")
            .expect("environment command result");
        assert_eq!(result["payload"]["success"], false);
        assert_eq!(
            result["payload"]["errorCode"],
            serde_json::Value::String("COMMAND_EXPIRED".to_string()),
        );
        assert_eq!(calls.air_conditioner_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn environment_control_cancels_before_hardware_write_after_deadline() {
        let temp = tempfile::tempdir().expect("temp");
        let state = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        let (hardware, calls) = TrackingEnvironmentHardware::new(500);
        let runtime = MqttSyncRuntime::new(
            "MACHINE-ENV".to_string(),
            "mqtt-signing-secret-for-env".to_string(),
            state.clone(),
            HardwareSupervisor::from_adapter(Arc::new(hardware)),
            broadcast::channel(1).0,
            CancellationToken::new(),
        );
        let command = environment_control_command("ENV-DEADLINE", Some(true), None, None, 1);
        let issued_at = (chrono::Utc::now() - chrono::Duration::milliseconds(800))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let envelope = environment_control_envelope(
            "MACHINE-ENV",
            "mqtt-signing-secret-for-env",
            "ENV-DEADLINE-MSG",
            &command,
            Some(&issued_at),
        );

        runtime
            .handle_environment_control_command(&envelope)
            .await
            .expect("environment command");

        let events = state
            .list_due_outbox(chrono::Utc::now())
            .await
            .expect("environment outbox");
        let result = command_result_payload_by_no(&events, "MACHINE-ENV", "ENV-DEADLINE")
            .expect("environment command result");
        assert_eq!(result["payload"]["errorCode"], "COMMAND_EXPIRED");
        assert_eq!(calls.air_conditioner_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn environment_control_rejects_during_dispense_command() {
        let temp = tempfile::tempdir().expect("temp");
        let state = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        state
            .upsert_order_session(order_session_in_dispense("ENV-DISP-1"))
            .await
            .expect("seed dispensing order");

        let (hardware, calls) = TrackingEnvironmentHardware::new(0);
        let runtime = MqttSyncRuntime::new(
            "MACHINE-ENV".to_string(),
            "mqtt-signing-secret-for-env".to_string(),
            state.clone(),
            HardwareSupervisor::from_adapter(Arc::new(hardware)),
            broadcast::channel(1).0,
            CancellationToken::new(),
        );

        let command = environment_control_command("ENV-DISP", Some(true), None, None, 5);
        let envelope = environment_control_envelope(
            "MACHINE-ENV",
            "mqtt-signing-secret-for-env",
            "ENV-DISP-MSG",
            &command,
            None,
        );
        runtime
            .handle_environment_control_command(&envelope)
            .await
            .expect("environment command");

        let events = state
            .list_due_outbox(chrono::Utc::now())
            .await
            .expect("environment outbox");
        let result = command_result_payload_by_no(&events, "MACHINE-ENV", "ENV-DISP")
            .expect("environment command result");
        assert_eq!(result["payload"]["success"], false);
        assert_eq!(
            result["payload"]["errorCode"],
            serde_json::Value::String("DISPENSE_IN_PROGRESS".to_string()),
        );
        assert_eq!(calls.air_conditioner_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn environment_control_waits_for_background_sample_ownership() {
        let temp = tempfile::tempdir().expect("temp");
        let state = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        let (hardware, calls) = TrackingEnvironmentHardware::new(500);
        let supervisor = HardwareSupervisor::from_adapter(Arc::new(hardware));
        let runtime = MqttSyncRuntime::new(
            "MACHINE-ENV".to_string(),
            "mqtt-signing-secret-for-env".to_string(),
            state.clone(),
            supervisor.clone(),
            broadcast::channel(1).0,
            CancellationToken::new(),
        );
        let occupied = tokio::spawn(async move { supervisor.query_environment_sample().await });
        tokio::time::sleep(StdDuration::from_millis(20)).await;

        let command = environment_control_command("ENV-BUSY", Some(true), None, None, 5);
        let envelope = environment_control_envelope(
            "MACHINE-ENV",
            "mqtt-signing-secret-for-env",
            "ENV-BUSY-MSG",
            &command,
            None,
        );
        tokio::time::timeout(
            StdDuration::from_secs(2),
            runtime.handle_environment_control_command(&envelope),
        )
        .await
        .expect("environment command must complete within its deadline")
        .expect("environment command");

        let events = state
            .list_due_outbox(chrono::Utc::now())
            .await
            .expect("environment outbox");
        let result = command_result_payload_by_no(&events, "MACHINE-ENV", "ENV-BUSY")
            .expect("environment command result");
        assert_eq!(result["payload"]["success"], true);
        assert_eq!(calls.air_conditioner_calls.load(Ordering::SeqCst), 1);
        occupied
            .await
            .expect("background sample task")
            .expect("sample");
    }

    #[tokio::test]
    async fn environment_control_command_lock_prevents_overlap() {
        let temp = tempfile::tempdir().expect("temp");
        let state = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        let (hardware, calls) = TrackingEnvironmentHardware::new(120);
        let runtime = MqttSyncRuntime::new(
            "MACHINE-ENV".to_string(),
            "mqtt-signing-secret-for-env".to_string(),
            state.clone(),
            HardwareSupervisor::from_adapter(Arc::new(hardware)),
            broadcast::channel(1).0,
            CancellationToken::new(),
        );

        let first_command = environment_control_command("ENV-RACE-1", None, None, Some(2), 5);
        let second_command = environment_control_command("ENV-RACE-2", None, None, Some(3), 5);
        let first_envelope = environment_control_envelope(
            "MACHINE-ENV",
            "mqtt-signing-secret-for-env",
            "ENV-RACE-1-MSG",
            &first_command,
            None,
        );
        let second_envelope = environment_control_envelope(
            "MACHINE-ENV",
            "mqtt-signing-secret-for-env",
            "ENV-RACE-2-MSG",
            &second_command,
            None,
        );

        let first = tokio::spawn({
            let runtime = runtime.clone();
            let envelope = first_envelope;
            async move { runtime.handle_environment_control_command(&envelope).await }
        });
        tokio::time::sleep(StdDuration::from_millis(20)).await;
        let second = tokio::spawn({
            let runtime = runtime.clone();
            let envelope = second_envelope;
            async move { runtime.handle_environment_control_command(&envelope).await }
        });

        first
            .await
            .expect("first command panicked")
            .expect("first command");
        second
            .await
            .expect("second command panicked")
            .expect("second command");

        let events = state
            .list_due_outbox(chrono::Utc::now())
            .await
            .expect("environment outbox");
        let first_result = command_result_payload_by_no(&events, "MACHINE-ENV", "ENV-RACE-1")
            .expect("first environment result");
        let second_result = command_result_payload_by_no(&events, "MACHINE-ENV", "ENV-RACE-2")
            .expect("second environment result");
        assert_eq!(first_result["payload"]["success"], true);
        assert_eq!(second_result["payload"]["success"], false);
        assert_eq!(
            second_result["payload"]["errorCode"],
            serde_json::Value::String("ENVIRONMENT_COMMAND_IN_PROGRESS".to_string()),
        );
        assert_eq!(calls.vent_speed_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn mqtt_environment_dispatch_does_not_wait_for_hardware_task() {
        let temp = tempfile::tempdir().expect("temp");
        let state = LocalStateStore::open(&temp.path().join("state.db"))
            .await
            .expect("state");
        let (hardware, calls) = TrackingEnvironmentHardware::new(500);
        let runtime = Arc::new(MqttSyncRuntime::new(
            "MACHINE-ENV".to_string(),
            "mqtt-signing-secret-for-env".to_string(),
            state,
            HardwareSupervisor::from_adapter(Arc::new(hardware)),
            broadcast::channel(1).0,
            CancellationToken::new(),
        ));
        let command = environment_control_command("ENV-POLL", None, None, Some(2), 5);
        let envelope = environment_control_envelope(
            "MACHINE-ENV",
            "mqtt-signing-secret-for-env",
            "ENV-POLL-MSG",
            &command,
            None,
        );
        let mut task_slot = None;

        tokio::time::timeout(
            StdDuration::from_millis(100),
            runtime.dispatch_environment_command(envelope, &mut task_slot),
        )
        .await
        .expect("MQTT dispatch must return before environment hardware completes")
        .expect("dispatch environment command");

        let task = task_slot.as_ref().expect("fixed environment task slot");
        assert!(!task.is_finished());
        task_slot
            .take()
            .expect("environment task")
            .await
            .expect("environment task panicked")
            .expect("environment command");
        assert_eq!(calls.vent_speed_calls.load(Ordering::SeqCst), 1);
    }
}

mod support;

use rumqttc::QoS;
use support::{
    mqtt::{
        collect_publishes, spawn_event_loop, MqttBrokerHarness, ObservedQos1Publish,
        PubAckDropProxy,
    },
    process::DaemonHarness,
    sensitive, sqlite,
};
use vending_core::{
    hardware::{DispenseCommandPayload, EnvironmentControlCommandPayload},
    mqtt::sign_envelope,
};
use vending_daemon::state::{
    store::{MachinePlanogramInput, MachinePlanogramSlotInput, StockMovementInput},
    LocalStateStore, OrderSessionUpsert,
};

fn mqtt_config(mqtt_url: String) -> serde_json::Value {
    serde_json::json!({
        "machineCode": "MACHINE-MQTT",
        "apiBaseUrl": "http://127.0.0.1:9/api",
        "mqttUrl": mqtt_url,
        "hardwareModel": "vem-test-24",
        "hardwareSlotTopology": { "identity": "vem-test-24", "version": "2026-07-test" }
    })
}

fn environment_control_command(command_no: &str) -> EnvironmentControlCommandPayload {
    EnvironmentControlCommandPayload {
        command_no: command_no.to_string(),
        air_conditioner_on: Some(true),
        target_temperature_celsius: Some(24),
        vent_speed: None,
        timeout_seconds: 5,
    }
}

fn dispense_command(command_no: &str) -> DispenseCommandPayload {
    DispenseCommandPayload {
        command_no: command_no.to_string(),
        order_no: "ORD-MQTT".to_string(),
        slot: vending_core::hardware::SlotPayload {
            layer_no: 1,
            cell_no: 1,
            slot_code: "A1".to_string(),
        },
        quantity: 1,
        timeout_seconds: 2,
    }
}

async fn prepare_dispense_state(daemon: &DaemonHarness, command: &DispenseCommandPayload) {
    let state = LocalStateStore::open(&daemon.state_db_path())
        .await
        .expect("open daemon state");
    state
        .apply_planogram(MachinePlanogramInput {
            planogram_version: "PLAN-MQTT-FAULT".to_string(),
            source: "integration_test".to_string(),
            applied_by: None,
            slots: vec![MachinePlanogramSlotInput {
                slot_id: "550e8400-e29b-41d4-a716-446655442001".to_string(),
                slot_code: "A1".to_string(),
                layer_no: 1,
                cell_no: 1,
                capacity: 8,
                par_level: 6,
                inventory_id: "550e8400-e29b-41d4-a716-446655442002".to_string(),
                variant_id: "550e8400-e29b-41d4-a716-446655442003".to_string(),
                product_id: "550e8400-e29b-41d4-a716-446655442004".to_string(),
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
        .expect("seed planogram");
    state
        .record_stock_movement(StockMovementInput {
            movement_id: format!("COUNT-BEFORE-{}", command.command_no),
            planogram_version: "PLAN-MQTT-FAULT".to_string(),
            slot_id: "550e8400-e29b-41d4-a716-446655442001".to_string(),
            movement_type: "stock_count_correction".to_string(),
            quantity: 4,
            source: "integration_test".to_string(),
            attributed_to: Some("integration-test".to_string()),
        })
        .await
        .expect("seed counted stock");
    state
        .upsert_order_session(OrderSessionUpsert {
            order_no: &command.order_no,
            payment_method: "payment_code",
            payment_provider: Some("alipay"),
            items_json: serde_json::json!([{ "slotCode": "A1", "quantity": 1 }]),
            status: "dispensing",
            next_action: "dispensing",
            payment_attempt_json: None,
            recovery_strategy: "local",
            last_backend_status_json: Some(serde_json::json!({
                "orderNo": command.order_no,
                "orderStatus": "dispensing",
                "nextAction": "dispensing",
                "vending": { "commandNo": command.command_no, "status": "dispensing" }
            })),
            last_error: None,
        })
        .await
        .expect("seed dispensing order");
}

#[tokio::test]
async fn mqtt_environment_control_command_flow_publishes_ack_and_explicit_unbound_hardware_result()
{
    let broker = MqttBrokerHarness::start().await;
    let mut daemon = DaemonHarness::start(
        mqtt_config(broker.url()),
        &[(
            "VEM_MQTT_SIGNING_SECRET",
            sensitive::TEST_MQTT_SIGNING_SECRET,
        )],
        &[],
    )
    .await
    .expect("start daemon");
    wait_for_mqtt_connected(&daemon).await;
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    let (collector, mut collector_loop) = broker.client("env-collector");
    let ack_topic = "vem/machines/MACHINE-MQTT/commands/ENV-MQTT-1/ack";
    let result_topic = "vem/machines/MACHINE-MQTT/events/environment-control-result";
    collector
        .subscribe(ack_topic, QoS::AtLeastOnce)
        .await
        .unwrap();
    collector
        .subscribe(result_topic, QoS::AtLeastOnce)
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    let (publisher, publisher_loop) = broker.client("env-publisher");
    let _publisher_task = spawn_event_loop(publisher_loop);
    let payload = serde_json::to_value(environment_control_command("ENV-MQTT-1")).unwrap();
    let envelope = sign_envelope(
        "MACHINE-MQTT",
        sensitive::TEST_MQTT_SIGNING_SECRET,
        "MSG-ENV-MQTT-1",
        payload,
    );
    let bytes = serde_json::to_vec(&envelope).unwrap();
    publisher
        .publish(
            "vem/machines/MACHINE-MQTT/commands/environment-control",
            QoS::AtLeastOnce,
            false,
            bytes,
        )
        .await
        .unwrap();

    let publishes = collect_publishes(&mut collector_loop, 2).await;
    assert!(
        publishes.iter().any(|(topic, _)| topic == ack_topic),
        "missing ACK publish: {publishes:?}"
    );
    let ack = publishes
        .iter()
        .find(|(topic, _)| topic == ack_topic)
        .map(|(_, payload)| serde_json::from_slice::<serde_json::Value>(payload).unwrap())
        .expect("environment control ACK publish");
    assert_eq!(ack["payload"]["messageId"], "ENV-MQTT-1:ack");
    assert!(ack["signature"].as_str().unwrap_or_default().len() >= 32);

    let result = publishes
        .iter()
        .find(|(topic, _)| topic == result_topic)
        .map(|(_, payload)| serde_json::from_slice::<serde_json::Value>(payload).unwrap())
        .expect("environment control result publish");
    assert_eq!(result["payload"]["commandNo"], "ENV-MQTT-1");
    assert_eq!(result["payload"]["success"], false);
    assert!(result["payload"]["message"]
        .as_str()
        .unwrap_or_default()
        .contains("lowerControllerUsbIdentity"));
    assert!(result["signature"].as_str().unwrap_or_default().len() >= 32);

    daemon.terminate().await;
}

#[tokio::test]
async fn mqtt_command_flow_survives_without_ui_and_dedupes_replay_when_hardware_is_unbound() {
    let broker = MqttBrokerHarness::start().await;
    let mut daemon = DaemonHarness::start(
        mqtt_config(broker.url()),
        &[(
            "VEM_MQTT_SIGNING_SECRET",
            sensitive::TEST_MQTT_SIGNING_SECRET,
        )],
        &[],
    )
    .await
    .expect("start daemon");
    wait_for_mqtt_connected(&daemon).await;
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    let (collector, mut collector_loop) = broker.client("collector");
    let topic_filter = "vem/machines/MACHINE-MQTT/#";
    collector
        .subscribe(topic_filter, QoS::AtLeastOnce)
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    let (publisher, publisher_loop) = broker.client("publisher");
    let _publisher_task = spawn_event_loop(publisher_loop);
    let command = dispense_command("CMD-MQTT-1");
    prepare_dispense_state(&daemon, &command).await;
    let payload = serde_json::to_value(command).unwrap();
    let envelope = sign_envelope(
        "MACHINE-MQTT",
        sensitive::TEST_MQTT_SIGNING_SECRET,
        "MSG-CMD-MQTT-1",
        payload,
    );
    let bytes = serde_json::to_vec(&envelope).unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    publisher
        .publish(
            "vem/machines/MACHINE-MQTT/commands/dispense",
            QoS::AtLeastOnce,
            false,
            bytes.clone(),
        )
        .await
        .unwrap();
    let first_publishes = collect_publishes(&mut collector_loop, 2).await;
    let ack_topic = "vem/machines/MACHINE-MQTT/commands/CMD-MQTT-1/ack";
    let result_topic = "vem/machines/MACHINE-MQTT/events/dispense-result";
    assert_eq!(
        first_publishes
            .iter()
            .filter(|(topic, _)| topic == ack_topic)
            .count(),
        1
    );
    assert_eq!(
        first_publishes
            .iter()
            .filter(|(topic, _)| topic == result_topic)
            .count(),
        1
    );
    let first_ack = first_publishes
        .iter()
        .find(|(topic, _)| topic == ack_topic)
        .map(|(_, payload)| serde_json::from_slice::<serde_json::Value>(payload).unwrap())
        .expect("first ack publish");
    assert_eq!(first_ack["payload"]["messageId"], "CMD-MQTT-1:ack");
    assert!(first_ack["signature"].as_str().unwrap_or_default().len() >= 32);
    let first_result = first_publishes
        .iter()
        .find(|(topic, _)| topic == result_topic)
        .map(|(_, payload)| serde_json::from_slice::<serde_json::Value>(payload).unwrap())
        .expect("first result publish");
    assert_eq!(
        first_result["payload"]["success"], false,
        "unexpected result: {first_result}"
    );
    assert_eq!(first_result["payload"]["commandNo"], "CMD-MQTT-1");
    assert!(first_result["signature"].as_str().unwrap_or_default().len() >= 32);

    publisher
        .publish(
            "vem/machines/MACHINE-MQTT/commands/dispense",
            QoS::AtLeastOnce,
            false,
            bytes,
        )
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    daemon.terminate().await;
    let pool = sqlite::open_readonly(&daemon.state_db_path()).await;
    assert_eq!(
        sqlite::scalar_i64(
            &pool,
            "SELECT COUNT(1) FROM command_log WHERE command_no='CMD-MQTT-1' AND status='failed'",
        )
        .await,
        1
    );
}

#[tokio::test]
async fn daemon_restart_flushes_persisted_outbox_result() {
    let broker = MqttBrokerHarness::start().await;
    let temp = tempfile::tempdir().expect("shared daemon data dir");
    let data_dir = temp.path().join("vending-daemon");
    let mut daemon = DaemonHarness::start_at(
        data_dir.clone(),
        mqtt_config(broker.url()),
        &[(
            "VEM_MQTT_SIGNING_SECRET",
            sensitive::TEST_MQTT_SIGNING_SECRET,
        )],
        &[],
    )
    .await
    .expect("start once");

    daemon.terminate().await;

    let state = vending_daemon::state::LocalStateStore::open(&data_dir.join("state.db"))
        .await
        .expect("open existing state");
    let command = dispense_command("CMD-RECOVER-1");
    let result = vending_core::hardware::DispenseResultPayload {
        command_no: command.command_no.clone(),
        success: true,
        error_code: None,
        message: "seeded before restart".to_string(),
        reported_at: vending_daemon::state::store::now_iso(),
    };
    let mut event =
        vending_daemon::state::store::OutboxInput::dispense_result("MACHINE-MQTT", &result);
    event.payload_json = serde_json::to_value(sign_envelope(
        "MACHINE-MQTT",
        sensitive::TEST_MQTT_SIGNING_SECRET,
        "result:CMD-RECOVER-1",
        event.payload_json,
    ))
    .expect("signed seeded result");
    state
        .record_command_result_and_enqueue_tx(&command, &result, &event)
        .await
        .expect("seed outbox");
    drop(state);

    let (collector, mut collector_loop) = broker.client("recover-collector");
    let result_topic = "vem/machines/MACHINE-MQTT/events/dispense-result";
    collector
        .subscribe(result_topic, QoS::AtLeastOnce)
        .await
        .unwrap();
    let collect_results =
        tokio::spawn(async move { collect_publishes(&mut collector_loop, 1).await });
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    let mut daemon2 = DaemonHarness::start_at(
        data_dir.clone(),
        mqtt_config(broker.url()),
        &[(
            "VEM_MQTT_SIGNING_SECRET",
            sensitive::TEST_MQTT_SIGNING_SECRET,
        )],
        &[],
    )
    .await
    .expect("restart daemon");
    let publishes = collect_results.await.expect("collector task");
    let body: serde_json::Value = serde_json::from_slice(&publishes[0].1).unwrap();
    assert_eq!(body["payload"]["commandNo"], "CMD-RECOVER-1");
    assert!(body["signature"].as_str().unwrap_or_default().len() >= 32);

    wait_for_outbox_event_removal(&data_dir, &event.id).await;
    daemon2.terminate().await;
    let pool = sqlite::open_readonly(&data_dir.join("state.db")).await;
    assert_eq!(
        sqlite::scalar_i64(
            &pool,
            "SELECT COUNT(1) FROM outbox_events WHERE id = 'MACHINE-MQTT:dispense-result:CMD-RECOVER-1'",
        )
        .await,
        0
    );
}

#[tokio::test]
async fn initial_mqtt_backlog_drains_past_async_client_capacity_without_losing_due_events() {
    let broker = MqttBrokerHarness::start().await;
    let temp = tempfile::tempdir().expect("shared daemon data dir");
    let data_dir = temp.path().join("vending-daemon");
    let state = vending_daemon::state::LocalStateStore::open(&data_dir.join("state.db"))
        .await
        .expect("state");
    let mut event_ids = Vec::new();
    for index in 0..32 {
        let event = vending_daemon::state::store::OutboxInput::command_ack(
            "MACHINE-MQTT",
            &format!("CMD-BACKLOG-{index}"),
        );
        state.enqueue_outbox(&event).await.expect("seed due event");
        event_ids.push(event.id);
    }
    drop(state);

    let (collector, mut collector_loop) = broker.client("backlog-collector");
    collector
        .subscribe("vem/machines/MACHINE-MQTT/commands/+/ack", QoS::AtLeastOnce)
        .await
        .expect("subscribe collector");
    let received = tokio::spawn(async move { collect_publishes(&mut collector_loop, 32).await });

    let mut daemon = DaemonHarness::start_at(
        data_dir.clone(),
        mqtt_config(broker.url()),
        &[(
            "VEM_MQTT_SIGNING_SECRET",
            sensitive::TEST_MQTT_SIGNING_SECRET,
        )],
        &[],
    )
    .await
    .expect("start daemon with 32 due events");
    let publishes = tokio::time::timeout(std::time::Duration::from_secs(15), received)
        .await
        .expect("initial backlog timed out")
        .expect("collector task");
    assert_eq!(publishes.len(), 32);
    for event_id in &event_ids {
        wait_for_outbox_event_removal(&data_dir, event_id).await;
    }
    daemon.terminate().await;
}

#[tokio::test]
async fn broker_unavailable_keeps_due_outbox_with_retry_error() {
    let unused_port = portpicker::pick_unused_port().expect("port");
    let temp = tempfile::tempdir().expect("temp");
    let data_dir = temp.path().join("vending-daemon");

    let state = vending_daemon::state::LocalStateStore::open(&data_dir.join("state.db"))
        .await
        .expect("state");
    let heartbeat = vending_daemon::state::store::OutboxInput::heartbeat(
        "MACHINE-MQTT",
        serde_json::json!({"status":"ok"}),
    );
    state.enqueue_outbox(&heartbeat).await.expect("seed outbox");
    drop(state);

    let mut daemon = DaemonHarness::start_at(
        data_dir.clone(),
        mqtt_config(format!("mqtt://127.0.0.1:{unused_port}")),
        &[(
            "VEM_MQTT_SIGNING_SECRET",
            sensitive::TEST_MQTT_SIGNING_SECRET,
        )],
        &[],
    )
    .await
    .expect("start daemon with dead broker");

    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    daemon.terminate().await;

    let pool = sqlite::open_readonly(&data_dir.join("state.db")).await;
    let retained = sqlite::scalar_i64(&pool, "SELECT COUNT(1) FROM outbox_events").await;
    assert!(
        retained >= 1,
        "the outbox must retain events while MQTT is offline"
    );
    let seeded = sqlx::query_scalar::<_, i64>("SELECT COUNT(1) FROM outbox_events WHERE id = ?1")
        .bind(&heartbeat.id)
        .fetch_one(&pool)
        .await
        .expect("query seeded outbox event");
    assert_eq!(
        seeded, 1,
        "the original due event must remain durable while MQTT is offline"
    );
    assert_eq!(
        sqlite::scalar_i64(
            &pool,
            "SELECT COUNT(1) FROM sqlite_master WHERE type='table' AND name='outbox_events'",
        )
        .await,
        1
    );
}

#[tokio::test]
async fn puback_drop_proxy_retransmits_durable_qos1_without_stranding_other_outbox_traffic() {
    let broker = MqttBrokerHarness::start().await;
    for round in 0..3 {
        let proxy = PubAckDropProxy::start(broker.port()).await;
        let temp = tempfile::tempdir().expect("temp");
        let data_dir = temp.path().join("vending-daemon");
        let state = vending_daemon::state::LocalStateStore::open(&data_dir.join("state.db"))
            .await
            .expect("state");
        let first = vending_daemon::state::store::OutboxInput::command_ack(
            "MACHINE-MQTT",
            &format!("CMD-PUBACK-DROP-{round}"),
        );
        let second = vending_daemon::state::store::OutboxInput::heartbeat(
            "MACHINE-MQTT",
            serde_json::json!({"round": round, "kind": "other-qos1-traffic"}),
        );
        state.enqueue_outbox(&first).await.expect("seed first");
        state.enqueue_outbox(&second).await.expect("seed second");
        drop(state);

        let mut daemon = DaemonHarness::start_at(
            data_dir.clone(),
            mqtt_config(proxy.url()),
            &[(
                "VEM_MQTT_SIGNING_SECRET",
                sensitive::TEST_MQTT_SIGNING_SECRET,
            )],
            &[],
        )
        .await
        .expect("start daemon through PubAck-drop proxy");
        wait_for_outbox_event_removal(&data_dir, &first.id).await;
        wait_for_outbox_event_removal(&data_dir, &second.id).await;
        let publishes = wait_for_proxy_publishes(&proxy, 3).await;
        assert!(
            proxy.dropped_before_puback(),
            "proxy did not cut the first PubAck"
        );
        assert_eq!(
            publishes[0].packet_id, publishes[1].packet_id,
            "retransmit must retain the QoS1 packet id"
        );
        assert_eq!(
            publishes[0].topic, publishes[1].topic,
            "retransmit changed the durable publish owner"
        );
        assert!(
            publishes.iter().skip(2).any(|publish| {
                publish.topic != publishes[0].topic && publish.packet_id != publishes[0].packet_id
            }),
            "other QoS1 traffic was not independently acknowledged: {publishes:?}",
        );
        daemon.terminate().await;
        let pool = sqlite::open_readonly(&data_dir.join("state.db")).await;
        let stranded =
            sqlx::query_scalar::<_, i64>("SELECT COUNT(1) FROM outbox_events WHERE id IN (?1, ?2)")
                .bind(&first.id)
                .bind(&second.id)
                .fetch_one(&pool)
                .await
                .expect("query seeded outbox events");
        assert_eq!(
            stranded, 0,
            "PubAck recovery stranded a seeded durable event"
        );
    }
}

async fn wait_for_outbox_event_removal(data_dir: &std::path::Path, event_id: &str) {
    for _ in 0..30 {
        let pool = sqlite::open_readonly(&data_dir.join("state.db")).await;
        let count =
            sqlx::query_scalar::<_, i64>("SELECT COUNT(1) FROM outbox_events WHERE id = ?1")
                .bind(event_id)
                .fetch_one(&pool)
                .await
                .expect("query persisted outbox event");
        if count == 0 {
            return;
        }
        drop(pool);
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    panic!("persisted outbox event {event_id} was not removed after MQTT PubAck");
}

async fn wait_for_proxy_publishes(
    proxy: &PubAckDropProxy,
    expected: usize,
) -> Vec<ObservedQos1Publish> {
    for _ in 0..100 {
        let publishes = proxy.qos1_publishes().await;
        if publishes.len() >= expected {
            return publishes;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("proxy did not observe {expected} QoS1 PUBLISH packets");
}

async fn wait_for_mqtt_connected(daemon: &DaemonHarness) {
    for _ in 0..40 {
        let status = daemon.get_json("/v1/sync/status").await;
        if status["mqttConnected"] == true {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let status = daemon.get_json("/v1/sync/status").await;
    assert_eq!(
        status["mqttConnected"], true,
        "mqtt did not connect: {status}"
    );
}

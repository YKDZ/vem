#![cfg(unix)]

mod support;

use std::{sync::Arc, time::Duration};

use serde_json::json;
use support::pty::PtyHarness;
use tokio::{
    sync::{mpsc, oneshot},
    time::{sleep, timeout},
};
use vending_core::{
    domain::InternalCheckoutFlowAction,
    hardware::{
        DispenseCommandPayload, DispenseProgressObserver, DispenseProgressStage, HardwareAdapter,
        SlotPayload,
    },
    serial::{build_dispense_frame, build_status_query_frame, SerialHardwareAdapter, FRAME_HEAD},
};
use vending_daemon::state::{
    store::{MachinePlanogramInput, MachinePlanogramSlotInput, OutboxInput, StockMovementInput},
    LocalStateStore, OrderSessionUpsert,
};

const PLANOGRAM_VERSION: &str = "PLAN-SERIAL-FULFILLMENT";
const SLOT_ID: &str = "550e8400-e29b-41d4-a716-446655440901";

fn command() -> DispenseCommandPayload {
    DispenseCommandPayload {
        command_no: "CMD-SERIAL-FULFILLMENT".to_string(),
        order_no: "ORDER-SERIAL-FULFILLMENT".to_string(),
        slot: SlotPayload {
            row_no: 1,
            cell_no: 1,
            slot_id: "A1".to_string(),
        },
        quantity: 1,
        timeout_seconds: 2,
    }
}

async fn seed_dispensing_order(store: &LocalStateStore, command: &DispenseCommandPayload) {
    store
        .apply_planogram(MachinePlanogramInput {
            planogram_version: PLANOGRAM_VERSION.to_string(),
            source: "integration_test".to_string(),
            applied_by: None,
            slots: vec![MachinePlanogramSlotInput {
                slot_id: SLOT_ID.to_string(),
                row_no: i64::from(command.slot.row_no),
                cell_no: i64::from(command.slot.cell_no),
                capacity: 8,
                par_level: 6,
                inventory_id: "550e8400-e29b-41d4-a716-446655440902".to_string(),
                variant_id: "550e8400-e29b-41d4-a716-446655440903".to_string(),
                product_id: "550e8400-e29b-41d4-a716-446655440904".to_string(),
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
    store
        .record_stock_movement(StockMovementInput {
            movement_id: "COUNT-BEFORE-SERIAL-FULFILLMENT".to_string(),
            planogram_version: PLANOGRAM_VERSION.to_string(),
            slot_id: SLOT_ID.to_string(),
            movement_type: "stock_count_correction".to_string(),
            quantity: 4,
            source: "integration_test".to_string(),
            attributed_to: Some("integration-test".to_string()),
        })
        .await
        .expect("seed stock");
    store
        .upsert_order_session(OrderSessionUpsert {
            order_no: &command.order_no,
            payment_method: "payment_code",
            payment_provider: Some("alipay"),
            items_json: json!([{ "slotId": command.slot.slot_id, "quantity": 1 }]),
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
        .expect("seed dispensing order");
}

async fn wait_for_progress(
    receiver: &mut mpsc::UnboundedReceiver<DispenseProgressStage>,
    expected: &[DispenseProgressStage],
) {
    let mut observed = Vec::with_capacity(expected.len());
    while observed.len() < expected.len() {
        observed.push(
            timeout(Duration::from_secs(2), receiver.recv())
                .await
                .expect("progress persistence timed out")
                .expect("progress channel closed"),
        );
    }
    assert_eq!(observed, expected);
}

#[tokio::test]
async fn serial_progress_survives_nullable_backend_refresh_until_f2_stock_commit() {
    let temp = tempfile::tempdir().expect("tempdir");
    let store = LocalStateStore::open(&temp.path().join("state.db"))
        .await
        .expect("open store");
    let command = command();
    seed_dispensing_order(&store, &command).await;

    let mut controller = PtyHarness::open();
    let serial_path = controller.slave_path.to_string_lossy().to_string();
    let (f1_sent, mut f1_observed) = oneshot::channel();
    let (allow_f2, wait_for_f2) = oneshot::channel();
    tokio::spawn(async move {
        let mut handshake = [0_u8; 2];
        controller.read_exact(&mut handshake).await;
        assert_eq!(handshake, [FRAME_HEAD, build_status_query_frame()[1]]);
        controller.write(&[FRAME_HEAD, 0xAA]).await;

        let mut dispense = [0_u8; 4];
        controller.read_exact(&mut dispense).await;
        assert_eq!(
            dispense,
            build_dispense_frame(1, 1).expect("dispense frame")
        );
        controller.write(&[FRAME_HEAD, 0x00]).await;

        // F0 and F1 are each repeated three times by the lower-controller protocol.
        for _ in 0..3 {
            controller.write(&[FRAME_HEAD, 0xF0]).await;
            sleep(Duration::from_millis(5)).await;
        }
        controller.write(&[FRAME_HEAD, 0xAC]).await;
        sleep(Duration::from_millis(10)).await;
        controller.write(&[FRAME_HEAD, 0xE5]).await;
        sleep(Duration::from_millis(10)).await;
        controller.write(&[FRAME_HEAD, 0xE5]).await;
        sleep(Duration::from_millis(10)).await;
        for _ in 0..3 {
            controller.write(&[FRAME_HEAD, 0xF1]).await;
            sleep(Duration::from_millis(5)).await;
        }
        // A delayed duplicate warning/open event must not regress E5-2/F1.
        controller.write(&[FRAME_HEAD, 0xE5]).await;
        sleep(Duration::from_millis(5)).await;
        controller.write(&[FRAME_HEAD, 0xF0]).await;
        sleep(Duration::from_millis(5)).await;
        f1_sent.send(()).expect("notify F1");
        wait_for_f2.await.expect("allow F2");
        controller.write(&[FRAME_HEAD, 0xAF]).await;
        for _ in 0..3 {
            controller.write(&[FRAME_HEAD, 0xF2]).await;
            sleep(Duration::from_millis(5)).await;
        }
    });

    let (progress_sender, mut progress_receiver) = mpsc::unbounded_channel();
    let (progress_queue_sender, mut progress_queue_receiver) = mpsc::unbounded_channel();
    let progress_store = store.clone();
    let progress_worker = tokio::spawn(async move {
        while let Some(event) = progress_queue_receiver.recv().await {
            if progress_store
                .record_dispense_progress(&event)
                .await
                .expect("persist serial progress")
            {
                progress_sender
                    .send(event.stage)
                    .expect("report persisted progress");
            }
        }
    });
    let progress_queue_sender_for_observer = progress_queue_sender.clone();
    let progress: DispenseProgressObserver = Arc::new(move |event| {
        progress_queue_sender_for_observer
            .send(event)
            .expect("queue serial progress");
    });
    let adapter = SerialHardwareAdapter::new(serial_path);
    let dispense = adapter.dispense_with_progress(command.clone(), Some(progress));
    tokio::pin!(dispense);

    tokio::select! {
        observed = &mut f1_observed => observed.expect("F1 notification failed"),
        result = &mut dispense => panic!("dispense completed before F1/F2 boundary: {result:?}"),
    }
    wait_for_progress(
        &mut progress_receiver,
        &[
            DispenseProgressStage::OutletOpened,
            DispenseProgressStage::PickupWaiting,
            DispenseProgressStage::PickupTimeoutWarning,
            DispenseProgressStage::PickupTimeoutWarning,
            DispenseProgressStage::PickupCompleted,
        ],
    )
    .await;

    let before_refresh = store
        .current_transaction_snapshot()
        .await
        .expect("transaction snapshot")
        .expect("active transaction");
    assert_eq!(
        before_refresh.next_action,
        Some(InternalCheckoutFlowAction::Dispensing)
    );
    assert_eq!(
        before_refresh
            .vending
            .as_ref()
            .and_then(|vending| vending.command_no.as_deref()),
        Some(command.command_no.as_str())
    );
    assert_eq!(
        before_refresh
            .vending
            .as_ref()
            .and_then(|vending| vending.pickup_reminder.as_ref())
            .and_then(|reminder| reminder.stage.as_deref()),
        Some("pickup_completed")
    );

    store
        .apply_backend_order_status(
            &command.order_no,
            json!({
                "orderNo": command.order_no,
                "orderStatus": "dispensing",
                "nextAction": "dispensing",
                "vending": null
            }),
        )
        .await
        .expect("apply nullable backend refresh");

    let after_refresh = store
        .current_transaction_snapshot()
        .await
        .expect("transaction snapshot after refresh")
        .expect("active transaction after refresh");
    assert_eq!(
        after_refresh
            .vending
            .as_ref()
            .and_then(|vending| vending.command_no.as_deref()),
        Some(command.command_no.as_str())
    );
    assert_eq!(
        after_refresh
            .vending
            .as_ref()
            .and_then(|vending| vending.pickup_reminder.as_ref())
            .and_then(|reminder| reminder.stage.as_deref()),
        Some("pickup_completed")
    );
    let refreshed_backend_status: serde_json::Value = serde_json::from_str(
        &store
            .current_order_session_record()
            .await
            .expect("refreshed order session")
            .expect("active refreshed order session")
            .last_backend_status_json
            .expect("persisted refreshed backend status"),
    )
    .expect("parse refreshed backend status");
    assert_eq!(
        refreshed_backend_status
            .pointer("/vending/fulfillmentProgressStage")
            .and_then(serde_json::Value::as_str),
        Some("pickup_completed")
    );

    assert!(
        timeout(Duration::from_millis(50), &mut dispense)
            .await
            .is_err(),
        "F1 must remain nonterminal until F2"
    );
    allow_f2.send(()).expect("allow terminal F2");
    let result = timeout(Duration::from_secs(2), &mut dispense)
        .await
        .expect("F2 completion timed out");
    assert!(result.success, "F2 must complete dispense: {result:?}");
    drop(progress_queue_sender);
    progress_worker.abort();
    let _ = progress_worker.await;

    let result_event = OutboxInput::dispense_result("MACHINE-SERIAL", &result);
    assert!(store
        .record_command_result_journal(&command, &result)
        .await
        .expect("journal F2 result"));
    assert!(store
        .commit_journaled_dispense_side_effects(&command, &result, &result_event)
        .await
        .expect("commit F2 side effects"));

    let completed = store
        .current_transaction_snapshot()
        .await
        .expect("completed transaction snapshot")
        .expect("completed transaction");
    assert_eq!(
        completed.next_action,
        Some(InternalCheckoutFlowAction::Success)
    );
    assert_eq!(completed.order_status.as_deref(), Some("fulfilled"));

    let sale_view = store.sale_view(None).await.expect("sale view after F2");
    assert_eq!(sale_view.items[0].physical_stock, 3);
    assert!(!store
        .commit_journaled_dispense_side_effects(&command, &result, &result_event)
        .await
        .expect("dedupe F2 side effects"));
    assert_eq!(
        store
            .sale_view(None)
            .await
            .expect("sale view after duplicate F2")
            .items[0]
            .physical_stock,
        3
    );
}

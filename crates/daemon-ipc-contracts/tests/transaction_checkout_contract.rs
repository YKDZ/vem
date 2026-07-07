use daemon_ipc_contracts::{
    validate_current_transaction_snapshot_boundary, CheckoutFlowAction, CurrentTransactionSnapshot,
    DispenseProgressObservationStage,
};
use serde_json::Value;
use std::str::FromStr;

#[derive(Debug)]
struct NamedInvalidFixture {
    name: String,
    snapshot: Value,
}

fn valid_fixtures() -> Vec<Value> {
    serde_json::from_str(include_str!(
        "fixtures/transaction_checkout_valid.snapshots.json"
    ))
    .expect("valid transaction checkout fixture JSON")
}

fn invalid_fixtures() -> Vec<NamedInvalidFixture> {
    let named: Vec<Value> = serde_json::from_str(include_str!(
        "fixtures/transaction_checkout_invalid.snapshots.json"
    ))
    .expect("invalid transaction checkout fixture JSON");

    named
        .into_iter()
        .map(|entry| NamedInvalidFixture {
            name: entry["name"]
                .as_str()
                .expect("invalid fixture has a name")
                .to_owned(),
            snapshot: entry["snapshot"].clone(),
        })
        .collect()
}

fn canonical_transaction_wire_shape(mut value: Value) -> Value {
    if let Some(vending) = value.get_mut("vending").and_then(Value::as_object_mut) {
        if vending.get("pickupReminder") == Some(&Value::Null) {
            vending.remove("pickupReminder");
        }

        if let Some(pickup_reminder) = vending
            .get_mut("pickupReminder")
            .and_then(Value::as_object_mut)
        {
            if pickup_reminder.get("remainingSeconds") == Some(&Value::Null) {
                pickup_reminder.remove("remainingSeconds");
            }
        }
    }

    value
}

#[test]
fn transaction_checkout_public_names_are_stable_and_structural_deserialization_is_strict() {
    assert_eq!(
        CheckoutFlowAction::from_str("wait_payment").expect("current action parses"),
        CheckoutFlowAction::WaitPayment,
    );
    assert!(CheckoutFlowAction::from_str("submit_payment").is_err());
    assert!(CheckoutFlowAction::from_str("collect_goods").is_err());
    assert_eq!(
        DispenseProgressObservationStage::from_str("reset_completed")
            .expect("dispense progress observation stage parses"),
        DispenseProgressObservationStage::ResetCompleted,
    );

    let mut fixture = valid_fixtures()
        .into_iter()
        .next()
        .expect("at least one valid fixture");
    fixture["extraDaemonField"] = Value::Bool(true);

    serde_json::from_value::<CurrentTransactionSnapshot>(fixture)
        .expect_err("transaction snapshot rejects unknown fields");
}

#[test]
fn transaction_checkout_snapshots_serialize_back_to_fixture_wire_shape() {
    for fixture in valid_fixtures() {
        let snapshot: CurrentTransactionSnapshot =
            serde_json::from_value(fixture.clone()).expect("fixture deserializes");
        let serialized = serde_json::to_value(&snapshot).expect("fixture serializes");

        assert_eq!(
            serialized,
            canonical_transaction_wire_shape(fixture.clone())
        );

        let reparsed: CurrentTransactionSnapshot =
            serde_json::from_value(serialized).expect("serialized fixture deserializes");
        let expected: CurrentTransactionSnapshot =
            serde_json::from_value(fixture).expect("fixture deserializes again");

        assert_eq!(reparsed, expected);
    }
}

#[test]
fn transaction_checkout_boundary_validation_matches_shared_fixture_semantics() {
    for fixture in valid_fixtures() {
        let snapshot: CurrentTransactionSnapshot =
            serde_json::from_value(fixture).expect("valid fixture deserializes");

        validate_current_transaction_snapshot_boundary(&snapshot)
            .expect("valid fixture passes boundary validation");
    }

    let mut semantic_rejections = Vec::new();
    let mut structural_rejections = Vec::new();
    for fixture in invalid_fixtures() {
        match serde_json::from_value::<CurrentTransactionSnapshot>(fixture.snapshot) {
            Ok(snapshot) => {
                semantic_rejections.push(fixture.name);
                validate_current_transaction_snapshot_boundary(&snapshot)
                    .expect_err("invalid semantic fixture is rejected");
            }
            Err(_) => {
                structural_rejections.push(fixture.name);
            }
        }
    }

    assert_eq!(
        semantic_rejections,
        [
            "missingNextActionWithOrderNo",
            "awaitingPaymentWithoutPaymentMethod",
            "awaitingPaymentWithoutTotalAmount",
            "negativeTotalAmount",
            "negativePickupReminderRemainingSeconds",
        ]
    );
    assert_eq!(
        structural_rejections,
        ["legacySubmitPaymentAction", "legacyCollectGoodsAction"]
    );
}

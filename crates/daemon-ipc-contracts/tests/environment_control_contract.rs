use daemon_ipc_contracts::{
    validate_environment_control_action_boundary, EnvironmentControlAction,
    EnvironmentControlAdmission, EnvironmentControlSnapshot,
};

fn snapshot() -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": "vem-environment-control/v1",
        "revision": 7,
        "settings": {
            "airConditionerEnabled": true,
            "targetTemperatureCelsius": 24,
            "baseVentSpeed": 3
        },
        "desired": {
            "airConditionerEnabled": true,
            "targetTemperatureCelsius": 24,
            "ventSpeed": 0
        },
        "confirmed": {
            "airConditionerEnabled": true,
            "targetTemperatureCelsius": 24,
            "ventSpeed": 0
        },
        "convergence": "applied",
        "reasonCode": "controller_confirmed",
        "message": null,
        "lastAction": {
            "actionId": "presence-7:stop",
            "source": "stable_presence",
            "action": "temporarily_stop_vent",
            "acceptedAt": "2026-08-25T00:00:00Z"
        },
        "updatedAt": "2026-08-25T00:00:01Z",
        "lastAttemptAt": "2026-08-25T00:00:00Z",
        "confirmedAt": "2026-08-25T00:00:01Z"
    })
}

#[test]
fn generated_environment_control_boundaries_accept_the_shared_wire_shape() {
    let action = serde_json::json!({
        "actionId": "presence-7:stop",
        "source": "stable_presence",
        "action": { "type": "temporarily_stop_vent" }
    });
    serde_json::from_value::<EnvironmentControlAction>(action).expect("generated action contract");
    serde_json::from_value::<EnvironmentControlSnapshot>(snapshot())
        .expect("generated snapshot contract");
    serde_json::from_value::<EnvironmentControlAdmission>(serde_json::json!({
        "outcome": "accepted",
        "acceptedRevision": 7,
        "snapshot": snapshot()
    }))
    .expect("generated admission contract");
}

#[test]
fn generated_environment_control_action_rejects_unknown_or_out_of_range_facts() {
    let out_of_range = serde_json::from_value::<EnvironmentControlAction>(serde_json::json!({
        "actionId": "operator-1",
        "source": "local_operator",
        "action": { "type": "set_base_vent_speed", "ventSpeed": 5 }
    }))
    .expect("generated shape still requires boundary range validation");
    assert!(validate_environment_control_action_boundary(&out_of_range).is_err());
    assert!(
        serde_json::from_value::<EnvironmentControlAction>(serde_json::json!({
            "actionId": "operator-1",
            "source": "local_operator",
            "action": { "type": "retry_current_desired" },
            "customerPresent": true
        }))
        .is_err()
    );
}

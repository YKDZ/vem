use vending_daemon::environment_control::{
    EnvironmentControlAction, EnvironmentControlActionKind, EnvironmentControlAdmissionOutcome,
    EnvironmentControlConfirmation, EnvironmentControlConvergence, EnvironmentControlSnapshot,
    EnvironmentControlSource,
};
use vending_daemon::state::LocalStateStore;

const T0: &str = "2026-08-24T00:00:00.000Z";
const T1: &str = "2026-08-24T00:00:01.000Z";

fn action(
    id: &str,
    source: EnvironmentControlSource,
    kind: EnvironmentControlActionKind,
) -> EnvironmentControlAction {
    EnvironmentControlAction {
        action_id: id.to_string(),
        source,
        kind,
    }
}

#[test]
fn first_initialization_has_only_the_confirmed_product_defaults() {
    let snapshot = EnvironmentControlSnapshot::initial(T0);

    assert!(!snapshot.settings.air_conditioner_enabled);
    assert_eq!(snapshot.settings.target_temperature_celsius, 26);
    assert_eq!(snapshot.settings.base_vent_speed, 3);
    assert!(!snapshot.desired.air_conditioner_enabled);
    assert_eq!(snapshot.desired.target_temperature_celsius, 26);
    assert_eq!(snapshot.desired.vent_speed, 0);
    assert_eq!(snapshot.confirmed.air_conditioner_enabled, None);
    assert_eq!(snapshot.confirmed.target_temperature_celsius, None);
    assert_eq!(snapshot.confirmed.vent_speed, None);
    assert_eq!(snapshot.revision, 0);
    assert_eq!(snapshot.convergence, EnvironmentControlConvergence::Pending);
}

#[test]
fn durable_zero_is_not_reopened_by_a_later_presence_arrival() {
    let initial = EnvironmentControlSnapshot::initial(T0);
    let closed = initial
        .transition(
            &action(
                "operator-close",
                EnvironmentControlSource::LocalOperator,
                EnvironmentControlActionKind::SetBaseVentSpeed { vent_speed: 0 },
            ),
            T1,
        )
        .expect("set durable zero");
    let restored = closed
        .transition(
            &action(
                "arrival",
                EnvironmentControlSource::StablePresence,
                EnvironmentControlActionKind::RestoreBaseVentSpeed,
            ),
            T1,
        )
        .expect("restore base speed");

    assert_eq!(restored.settings.base_vent_speed, 0);
    assert_eq!(restored.desired.vent_speed, 0);
    assert_eq!(restored.revision, 2);
}

#[test]
fn temporary_stop_preserves_the_base_and_operator_change_applies_even_while_absent() {
    let initial = EnvironmentControlSnapshot::initial(T0);
    let stopped = initial
        .transition(
            &action(
                "departure",
                EnvironmentControlSource::StablePresence,
                EnvironmentControlActionKind::TemporarilyStopVent,
            ),
            T1,
        )
        .expect("temporary stop");
    assert_eq!(stopped.settings.base_vent_speed, 3);
    assert_eq!(stopped.desired.vent_speed, 0);

    let changed_while_absent = stopped
        .transition(
            &action(
                "operator-speed-2",
                EnvironmentControlSource::LocalOperator,
                EnvironmentControlActionKind::SetBaseVentSpeed { vent_speed: 2 },
            ),
            T1,
        )
        .expect("set speed while no customer is present");
    assert_eq!(changed_while_absent.settings.base_vent_speed, 2);
    assert_eq!(changed_while_absent.desired.vent_speed, 2);
}

#[test]
fn air_conditioner_temperature_and_vent_are_independent_axes() {
    let initial = EnvironmentControlSnapshot::initial(T0);
    let temperature = initial
        .transition(
            &action(
                "temperature",
                EnvironmentControlSource::RemoteOperator,
                EnvironmentControlActionKind::SetTargetTemperature {
                    temperature_celsius: 23,
                },
            ),
            T1,
        )
        .expect("set temperature");
    let air = temperature
        .transition(
            &action(
                "air",
                EnvironmentControlSource::RemoteOperator,
                EnvironmentControlActionKind::SetAirConditioner { enabled: true },
            ),
            T1,
        )
        .expect("set air conditioner");

    assert!(air.settings.air_conditioner_enabled);
    assert_eq!(air.settings.target_temperature_celsius, 23);
    assert_eq!(air.settings.base_vent_speed, 3);
    assert!(air.desired.air_conditioner_enabled);
    assert_eq!(air.desired.target_temperature_celsius, 23);
    assert_eq!(air.desired.vent_speed, 0);
}

#[test]
fn operator_and_automatic_policy_use_the_same_transition() {
    let initial = EnvironmentControlSnapshot::initial(T0);
    let operator = initial
        .transition(
            &action(
                "operator",
                EnvironmentControlSource::LocalOperator,
                EnvironmentControlActionKind::SetBaseVentSpeed { vent_speed: 4 },
            ),
            T1,
        )
        .expect("operator action");
    let automatic = initial
        .transition(
            &action(
                "automatic",
                EnvironmentControlSource::AutomaticPolicy,
                EnvironmentControlActionKind::SetBaseVentSpeed { vent_speed: 4 },
            ),
            T1,
        )
        .expect("automatic action");

    assert_eq!(operator.settings, automatic.settings);
    assert_eq!(operator.desired, automatic.desired);
    assert_eq!(operator.revision, automatic.revision);
}

#[test]
fn explicit_retry_replays_the_current_desired_state_without_new_revision() {
    let initial = EnvironmentControlSnapshot::initial(T0);
    let changed = initial
        .transition(
            &action(
                "speed",
                EnvironmentControlSource::LocalOperator,
                EnvironmentControlActionKind::SetBaseVentSpeed { vent_speed: 2 },
            ),
            T1,
        )
        .expect("set speed");
    let retried = changed
        .transition(
            &action(
                "retry",
                EnvironmentControlSource::LocalOperator,
                EnvironmentControlActionKind::RetryCurrentDesired,
            ),
            T1,
        )
        .expect("retry");

    assert_eq!(retried.revision, changed.revision);
    assert_eq!(retried.settings, changed.settings);
    assert_eq!(retried.desired, changed.desired);
    assert_eq!(retried.convergence, EnvironmentControlConvergence::Pending);
    assert_eq!(retried.reason_code, "explicit_retry_requested");
}

#[test]
fn a_late_confirmation_cannot_overwrite_a_newer_revision() {
    let initial = EnvironmentControlSnapshot::initial(T0);
    let revision_one = initial
        .transition(
            &action(
                "speed-1",
                EnvironmentControlSource::LocalOperator,
                EnvironmentControlActionKind::SetBaseVentSpeed { vent_speed: 1 },
            ),
            T1,
        )
        .expect("revision one");
    let mut revision_two = revision_one
        .transition(
            &action(
                "speed-4",
                EnvironmentControlSource::LocalOperator,
                EnvironmentControlActionKind::SetBaseVentSpeed { vent_speed: 4 },
            ),
            T1,
        )
        .expect("revision two");

    let applied = revision_two.record_applied(
        revision_one.revision,
        EnvironmentControlConfirmation {
            air_conditioner_enabled: false,
            target_temperature_celsius: 26,
            vent_speed: 1,
        },
        T1,
    );

    assert!(!applied);
    assert_eq!(revision_two.confirmed.vent_speed, None);
    assert_eq!(revision_two.desired.vent_speed, 4);
    assert_eq!(
        revision_two.convergence,
        EnvironmentControlConvergence::Pending
    );
}

#[tokio::test]
async fn accepted_settings_and_desired_state_survive_a_store_restart() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database = directory.path().join("state.db");
    let store = LocalStateStore::open(&database).await.expect("open store");
    let accepted = store
        .admit_environment_control_action(
            &action(
                "persist-speed",
                EnvironmentControlSource::LocalOperator,
                EnvironmentControlActionKind::SetBaseVentSpeed { vent_speed: 2 },
            ),
            T1,
        )
        .await
        .expect("accept action");
    assert_eq!(
        accepted.outcome,
        EnvironmentControlAdmissionOutcome::Accepted
    );
    drop(store);

    let reopened = LocalStateStore::open(&database)
        .await
        .expect("reopen store");
    let restored = reopened
        .environment_control_snapshot()
        .await
        .expect("read snapshot");

    assert_eq!(restored.settings.base_vent_speed, 2);
    assert_eq!(restored.desired.vent_speed, 2);
    assert_eq!(restored.revision, 1);
}

#[tokio::test]
async fn an_action_id_remains_deduplicated_after_newer_actions() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let store = LocalStateStore::open(&directory.path().join("state.db"))
        .await
        .expect("open store");
    let first_action = action(
        "stable-edge-1",
        EnvironmentControlSource::StablePresence,
        EnvironmentControlActionKind::RestoreBaseVentSpeed,
    );
    let first = store
        .admit_environment_control_action(&first_action, T0)
        .await
        .expect("first action");
    store
        .admit_environment_control_action(
            &action(
                "operator-newer",
                EnvironmentControlSource::LocalOperator,
                EnvironmentControlActionKind::SetBaseVentSpeed { vent_speed: 4 },
            ),
            T1,
        )
        .await
        .expect("newer action");

    let duplicate = store
        .admit_environment_control_action(&first_action, T1)
        .await
        .expect("deduplicate old action");

    assert_eq!(first.accepted_revision, 1);
    assert_eq!(
        duplicate.outcome,
        EnvironmentControlAdmissionOutcome::Deduplicated
    );
    assert_eq!(duplicate.accepted_revision, first.accepted_revision);
    assert_eq!(duplicate.snapshot.revision, 2);
    assert_eq!(duplicate.snapshot.desired.vent_speed, 4);
}

#[tokio::test]
async fn reusing_an_action_id_for_different_content_is_rejected() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let store = LocalStateStore::open(&directory.path().join("state.db"))
        .await
        .expect("open store");
    store
        .admit_environment_control_action(
            &action(
                "same-id",
                EnvironmentControlSource::LocalOperator,
                EnvironmentControlActionKind::SetBaseVentSpeed { vent_speed: 1 },
            ),
            T0,
        )
        .await
        .expect("first action");

    let error = store
        .admit_environment_control_action(
            &action(
                "same-id",
                EnvironmentControlSource::LocalOperator,
                EnvironmentControlActionKind::SetBaseVentSpeed { vent_speed: 4 },
            ),
            T1,
        )
        .await
        .expect_err("different content must conflict");

    assert!(error.to_string().contains("idempotency"), "{error}");
    assert_eq!(
        store
            .environment_control_snapshot()
            .await
            .expect("snapshot")
            .desired
            .vent_speed,
        1
    );
}

#[tokio::test]
async fn persisted_feedback_is_revision_guarded_and_failure_keeps_intent() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let store = LocalStateStore::open(&directory.path().join("state.db"))
        .await
        .expect("open store");
    let first = store
        .admit_environment_control_action(
            &action(
                "speed-1",
                EnvironmentControlSource::LocalOperator,
                EnvironmentControlActionKind::SetBaseVentSpeed { vent_speed: 1 },
            ),
            T0,
        )
        .await
        .expect("first action");
    let second = store
        .admit_environment_control_action(
            &action(
                "speed-4",
                EnvironmentControlSource::LocalOperator,
                EnvironmentControlActionKind::SetBaseVentSpeed { vent_speed: 4 },
            ),
            T1,
        )
        .await
        .expect("second action");

    assert!(!store
        .record_environment_control_applied(
            first.accepted_revision,
            &EnvironmentControlConfirmation {
                air_conditioner_enabled: false,
                target_temperature_celsius: 26,
                vent_speed: 1,
            },
            T1,
        )
        .await
        .expect("ignore late confirmation"));
    assert!(store
        .record_environment_control_unapplied(
            second.accepted_revision,
            EnvironmentControlConvergence::Failed,
            "lower_controller_rejected",
            Some("controller rejected B3".to_string()),
            T1,
        )
        .await
        .expect("record current failure"));

    let snapshot = store
        .environment_control_snapshot()
        .await
        .expect("snapshot");
    assert_eq!(snapshot.settings.base_vent_speed, 4);
    assert_eq!(snapshot.desired.vent_speed, 4);
    assert_eq!(snapshot.confirmed.vent_speed, None);
    assert_eq!(snapshot.convergence, EnvironmentControlConvergence::Failed);
}

#[tokio::test]
async fn runtime_start_forgets_hardware_confirmation_but_not_persisted_desire() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let store = LocalStateStore::open(&directory.path().join("state.db"))
        .await
        .expect("open store");
    let accepted = store
        .admit_environment_control_action(
            &action(
                "speed-2",
                EnvironmentControlSource::LocalOperator,
                EnvironmentControlActionKind::SetBaseVentSpeed { vent_speed: 2 },
            ),
            T0,
        )
        .await
        .expect("action");
    assert!(store
        .record_environment_control_applied(
            accepted.accepted_revision,
            &EnvironmentControlConfirmation {
                air_conditioner_enabled: false,
                target_temperature_celsius: 26,
                vent_speed: 2,
            },
            T0,
        )
        .await
        .expect("record confirmation"));

    let restarted = store
        .reset_environment_control_confirmation_for_runtime_start(T1)
        .await
        .expect("reset confirmation");

    assert_eq!(restarted.revision, accepted.accepted_revision);
    assert_eq!(restarted.settings.base_vent_speed, 2);
    assert_eq!(restarted.desired.vent_speed, 2);
    assert_eq!(restarted.confirmed.vent_speed, None);
    assert_eq!(
        restarted.convergence,
        EnvironmentControlConvergence::Pending
    );
    assert_eq!(restarted.reason_code, "runtime_started");
}

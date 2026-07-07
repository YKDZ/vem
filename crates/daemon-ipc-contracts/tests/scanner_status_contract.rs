use daemon_ipc_contracts::ScannerRuntimeStatus;
use serde_json::Value;

#[derive(Debug)]
struct NamedInvalidFixture {
    name: String,
    snapshot: Value,
}

fn valid_fixtures() -> Vec<Value> {
    serde_json::from_str(include_str!("fixtures/scanner_status_valid.snapshots.json"))
        .expect("valid scanner status fixture JSON")
}

fn invalid_fixtures() -> Vec<NamedInvalidFixture> {
    let named: Vec<Value> = serde_json::from_str(include_str!(
        "fixtures/scanner_status_invalid.snapshots.json"
    ))
    .expect("invalid scanner status fixture JSON");

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

#[test]
fn scanner_runtime_status_shared_fixtures_match_structural_deserialization() {
    for fixture in valid_fixtures() {
        serde_json::from_value::<ScannerRuntimeStatus>(fixture)
            .expect("valid scanner status fixture deserializes");
    }

    let structural_rejections = invalid_fixtures()
        .into_iter()
        .map(|fixture| {
            serde_json::from_value::<ScannerRuntimeStatus>(fixture.snapshot)
                .expect_err("invalid scanner status fixture is rejected");
            fixture.name
        })
        .collect::<Vec<_>>();

    assert_eq!(structural_rejections, ["unknownField", "missingCode"]);
}

#[test]
fn scanner_runtime_status_snapshots_serialize_back_to_fixture_wire_shape() {
    for fixture in valid_fixtures() {
        let snapshot: ScannerRuntimeStatus =
            serde_json::from_value(fixture.clone()).expect("fixture deserializes");
        let serialized = serde_json::to_value(&snapshot).expect("fixture serializes");

        assert_eq!(serialized, fixture);
    }
}

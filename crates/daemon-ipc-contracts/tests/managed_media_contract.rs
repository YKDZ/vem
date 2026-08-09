use daemon_ipc_contracts::{
    validate_managed_media_reconcile_receipt_boundary, ManagedMediaDescriptor,
    ManagedMediaProjection, ManagedMediaReconcileReceipt, ManagedMediaSnapshot,
};
use serde_json::json;

fn descriptor() -> serde_json::Value {
    json!({
        "id": "550e8400-e29b-41d4-a716-446655440124",
        "reference": "/api/media-assets/550e8400-e29b-41d4-a716-446655440124/content",
        "digest": format!("sha256:{}", "a".repeat(64)),
        "contentType": "image/png",
        "byteSize": 42,
        "purpose": "product_display_image",
        "revision": { "catalogRevision": "catalog-7" }
    })
}

fn projection() -> serde_json::Value {
    json!({
        "descriptor": descriptor(),
        "readiness": "ready",
        "readyUrl": format!("http://127.0.0.1:4312/media/sha256:{}?grant={}", "a".repeat(64), "g".repeat(32)),
        "diagnostic": null
    })
}

#[test]
fn generated_managed_media_boundary_round_trips_complete_snapshot() {
    let value = json!({
        "generation": format!("sha256:{}", "b".repeat(64)),
        "assets": [projection()]
    });
    let snapshot: ManagedMediaSnapshot =
        serde_json::from_value(value.clone()).expect("valid media snapshot");
    assert_eq!(
        serde_json::to_value(snapshot).expect("serialize snapshot"),
        value
    );
}

#[test]
fn generated_managed_media_boundary_rejects_unknown_and_invalid_values() {
    let mut unknown = projection();
    unknown["legacyReadyUrl"] = json!("http://127.0.0.1/old");
    assert!(serde_json::from_value::<ManagedMediaProjection>(unknown).is_err());

    let mut invalid_enum = projection();
    invalid_enum["readiness"] = json!("broken");
    assert!(serde_json::from_value::<ManagedMediaProjection>(invalid_enum).is_err());

    let mut invalid_url = projection();
    invalid_url["readyUrl"] = json!("https://platform.invalid/media/image.png");
    assert!(serde_json::from_value::<ManagedMediaProjection>(invalid_url).is_err());

    let mut invalid_digest = descriptor();
    invalid_digest["digest"] = json!("sha256:BAD");
    assert!(serde_json::from_value::<ManagedMediaDescriptor>(invalid_digest).is_err());
}

#[test]
fn reconcile_receipt_boundary_is_complete_and_generation_consistent() {
    let generation = format!("sha256:{}", "b".repeat(64));
    let receipt_value = json!({
        "generation": generation,
        "accepted": true,
        "interestCount": 1,
        "snapshot": { "generation": format!("sha256:{}", "b".repeat(64)), "assets": [projection()] }
    });
    let receipt: ManagedMediaReconcileReceipt =
        serde_json::from_value(receipt_value).expect("valid reconcile receipt");
    validate_managed_media_reconcile_receipt_boundary(&receipt)
        .expect("complete receipt validates");

    let mut rejected = serde_json::to_value(receipt).expect("serialize receipt");
    rejected["accepted"] = json!(false);
    let rejected: ManagedMediaReconcileReceipt =
        serde_json::from_value(rejected).expect("structural receipt");
    assert!(validate_managed_media_reconcile_receipt_boundary(&rejected).is_err());
}

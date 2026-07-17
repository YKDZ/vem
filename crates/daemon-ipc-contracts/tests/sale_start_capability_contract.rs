use daemon_ipc_contracts::SaleStartCapabilitySnapshot;

#[test]
fn generated_sale_start_capability_rejects_unknown_fields() {
    let value = serde_json::json!({
        "generation": "daemon-generation-1",
        "revision": 1,
        "observedAt": "2026-07-17T00:00:00Z",
        "canStartSale": true,
        "blockers": [],
        "degradations": [],
        "paymentOptions": {
            "ready": true,
            "defaultOptionKey": "qr_code:alipay",
            "defaultProviderCode": "alipay",
            "options": [{
                "optionKey": "qr_code:alipay",
                "providerCode": "alipay",
                "method": "qr_code",
                "displayName": "Alipay",
                "description": "Scan to pay",
                "icon": "alipay",
                "recommended": true,
                "ready": true,
                "disabledReason": null
            }]
        }
    });
    serde_json::from_value::<SaleStartCapabilitySnapshot>(value.clone())
        .expect("generated snapshot");

    let mut contaminated = value;
    contaminated["legacyReady"] = serde_json::json!(true);
    assert!(serde_json::from_value::<SaleStartCapabilitySnapshot>(contaminated).is_err());
}

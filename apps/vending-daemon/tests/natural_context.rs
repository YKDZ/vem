mod support;

use serde_json::json;
use support::{process::DaemonHarness, sensitive};
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn configured_daemon(api_base_url: String) -> serde_json::Value {
    json!({
        "machineCode": "MACHINE-NATURAL",
        "apiBaseUrl": api_base_url,
        "mqttUrl": "mqtt://127.0.0.1:1883",
        "mqttUsername": null,
        "hardwareAdapter": "mock",
        "serialPortPath": null,
        "scannerAdapter": "disabled",
        "scannerSerialPortPath": null,
        "scannerBaudRate": 9600,
        "scannerFrameSuffix": "crlf",
        "visionEnabled": false,
        "visionWsUrl": "ws://127.0.0.1:7892/ws",
        "visionRequestTimeoutMs": 8000,
        "kioskMode": true
    })
}

#[tokio::test]
async fn daemon_fetches_external_environment_and_exposes_operator_visible_natural_context() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/machine-auth/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "accessToken": "natural-token"
        })))
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(path(
            "/machines/by-code/MACHINE-NATURAL/external-natural-environment",
        ))
        .and(header("authorization", "Bearer natural-token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "status": "ready",
            "machineId": "550e8400-e29b-41d4-a716-446655440000",
            "machineCode": "MACHINE-NATURAL",
            "checkedAt": "2026-06-30T14:00:00.000Z",
            "localTime": {
                "status": "ready",
                "timezone": "Asia/Shanghai",
                "localDate": "2026-06-30",
                "localClock": "22:00:00"
            },
            "weather": {
                "status": "ready",
                "temperatureCelsius": 28,
                "conditionText": "Sunny",
                "conditionCode": "305",
                "observedAt": "2026-06-30T13:50:00.000Z",
                "windScale": 8,
                "windSpeedKph": 65,
                "weatherConditionClasses": ["strong_wind", "light_rain"],
                "primaryWeatherConditionClass": "strong_wind"
            },
            "sun": {
                "status": "ready",
                "sunriseAt": "2026-06-29T21:53:00.000Z",
                "sunsetAt": "2026-06-30T10:02:00.000Z"
            },
            "calendar": {
                "status": "ready",
                "localDate": "2026-06-30",
                "festivals": [],
                "primaryFestival": null,
                "solarTerm": null
            }
        })))
        .expect(1)
        .mount(&server)
        .await;

    let mut daemon = DaemonHarness::start(
        configured_daemon(server.uri()),
        &[("VEM_MACHINE_SECRET", sensitive::TEST_MACHINE_SECRET)],
    )
    .await
    .expect("start daemon");

    let snapshot = daemon.get_json("/v1/natural-context").await;
    assert_eq!(snapshot["status"], "ready");
    assert_eq!(snapshot["machineCode"], "MACHINE-NATURAL");
    assert_eq!(snapshot["externalEnvironment"]["status"], "ready");
    assert_eq!(
        snapshot["externalEnvironment"]["weather"]["temperatureCelsius"],
        28
    );
    assert_eq!(
        snapshot["externalEnvironment"]["weather"]["primaryWeatherConditionClass"],
        "strong_wind"
    );
    assert_eq!(
        snapshot["externalEnvironment"]["calendar"]["status"],
        "ready"
    );
    assert_eq!(snapshot["localSiteSignals"]["status"], "ok");
    assert_eq!(snapshot["localSiteSignals"]["temperatureCelsius"], 24);
    assert_eq!(snapshot["localSiteSignals"]["humidityRh"], 50);
    assert_eq!(snapshot["degraded"], false);
    assert_eq!(snapshot["customerFacingBlocked"], false);

    let ready = daemon.get_json("/readyz").await;
    assert!(!ready["blockingCodes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|code| code.as_str().unwrap_or_default().contains("NATURAL")));

    daemon.terminate().await;
}

#[tokio::test]
async fn unconfigured_external_environment_is_operator_visible_without_blocking_sales() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/machine-auth/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "accessToken": "natural-token"
        })))
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(path(
            "/machines/by-code/MACHINE-NATURAL/external-natural-environment",
        ))
        .and(header("authorization", "Bearer natural-token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "status": "unconfigured",
            "machineId": "550e8400-e29b-41d4-a716-446655440000",
            "machineCode": "MACHINE-NATURAL",
            "checkedAt": "2026-06-30T14:00:00.000Z",
            "diagnostic": {
                "reason": "machine_geo_location_missing",
                "message": "Machine Geo Location is not configured"
            }
        })))
        .mount(&server)
        .await;

    let mut daemon = DaemonHarness::start(
        configured_daemon(server.uri()),
        &[("VEM_MACHINE_SECRET", sensitive::TEST_MACHINE_SECRET)],
    )
    .await
    .expect("start daemon");

    let snapshot = daemon.get_json("/v1/natural-context").await;
    assert_eq!(snapshot["status"], "unconfigured");
    assert_eq!(snapshot["degraded"], true);
    assert_eq!(snapshot["customerFacingBlocked"], false);
    assert_eq!(
        snapshot["externalEnvironment"]["diagnostic"]["reason"],
        "machine_geo_location_missing"
    );

    let ready = daemon.get_json("/readyz").await;
    assert!(!ready["blockingCodes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|code| code.as_str().unwrap_or_default().contains("NATURAL")));

    daemon.terminate().await;
}

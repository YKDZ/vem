use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, SecondsFormat, Utc};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MqttEnvelope {
    pub message_id: String,
    pub machine_code: String,
    pub issued_at: String,
    pub nonce: String,
    pub payload: Value,
    pub signature: String,
}

fn canonical_json_value(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let pairs: Vec<String> = keys
                .into_iter()
                .map(|k| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(k).unwrap_or_default(),
                        canonical_json_value(&map[k])
                    )
                })
                .collect();
            format!("{{{}}}", pairs.join(","))
        }
        Value::Array(items) => {
            let inner: Vec<String> = items.iter().map(canonical_json_value).collect();
            format!("[{}]", inner.join(","))
        }
        Value::String(s) => serde_json::to_string(s).unwrap_or_default(),
        other => other.to_string(),
    }
}

pub fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
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

pub fn sign_envelope(
    machine_code: &str,
    signing_secret: &str,
    message_id: &str,
    payload: Value,
) -> MqttEnvelope {
    let issued_at = chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let nonce = Uuid::new_v4().to_string();
    let unsigned = json!({
        "issuedAt": issued_at,
        "machineCode": machine_code,
        "messageId": message_id,
        "nonce": nonce,
        "payload": payload,
    });
    let input = canonical_json(&unsigned);
    let mut mac =
        HmacSha256::new_from_slice(signing_secret.as_bytes()).expect("HMAC accepts any key size");
    mac.update(input.as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    MqttEnvelope {
        message_id: message_id.to_string(),
        machine_code: machine_code.to_string(),
        issued_at,
        nonce,
        payload: unsigned["payload"].clone(),
        signature,
    }
}

pub fn verify_signature_bytes(envelope: &MqttEnvelope, signing_secret: &str) -> Result<(), String> {
    let unsigned = json!({
        "issuedAt": envelope.issued_at,
        "machineCode": envelope.machine_code,
        "messageId": envelope.message_id,
        "nonce": envelope.nonce,
        "payload": envelope.payload,
    });
    let input = canonical_json(&unsigned);
    let mut mac = HmacSha256::new_from_slice(signing_secret.as_bytes())
        .map_err(|error| format!("invalid signing key: {error}"))?;
    mac.update(input.as_bytes());
    let signature = URL_SAFE_NO_PAD
        .decode(envelope.signature.as_bytes())
        .map_err(|_| "MQTT envelope signature invalid".to_string())?;
    mac.verify_slice(&signature)
        .map_err(|_| "MQTT envelope signature invalid".to_string())
}

pub fn verify_envelope(
    envelope: &MqttEnvelope,
    expected_machine_code: &str,
    signing_secret: &str,
    tolerance_seconds: i64,
) -> Result<(), String> {
    if envelope.machine_code != expected_machine_code {
        return Err(format!(
            "envelope machine_code mismatch: expected {expected_machine_code}, got {}",
            envelope.machine_code
        ));
    }
    let issued = DateTime::parse_from_rfc3339(&envelope.issued_at)
        .map_err(|error| format!("parse issuedAt failed: {error}"))?
        .with_timezone(&Utc);
    let skew = (chrono::Utc::now() - issued).num_seconds().abs();
    if skew > tolerance_seconds {
        return Err("MQTT envelope outside time window".to_string());
    }
    verify_signature_bytes(envelope, signing_secret)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn canonical_json_sorting_matches_expected() {
        let value = json!({ "b": 1, "a": 2 });
        assert_eq!(canonical_json(&value), r#"{"a":2,"b":1}"#);
    }

    #[test]
    fn canonical_json_sorts_nested_objects() {
        let value = json!({
            "payload": {
                "reportedAt": "2026-06-09T10:18:33.166Z",
                "commandNo": "MCMD1",
                "success": false,
                "message": "line\nbreak",
            },
            "machineCode": "M001",
        });
        assert_eq!(
            canonical_json(&value),
            r#"{"machineCode":"M001","payload":{"commandNo":"MCMD1","message":"line\nbreak","reportedAt":"2026-06-09T10:18:33.166Z","success":false}}"#
        );
    }

    #[test]
    fn signature_roundtrip_and_tamper_detection() {
        let secret = "secret";
        let envelope = sign_envelope("machine-001", secret, "msg-01", json!({"payload":"v"}));
        assert!(verify_envelope(&envelope, "machine-001", secret, 300).is_ok());

        let mut tampered = envelope.clone();
        tampered.payload = json!({"payload":"x"});
        assert!(verify_envelope(&tampered, "machine-001", secret, 300).is_err());
        assert!(verify_envelope(&envelope, "machine-other", secret, 300).is_err());
    }

    #[test]
    fn issued_at_drift_check() {
        let secret = "secret";
        let mut envelope = sign_envelope("machine-001", secret, "msg-02", json!({"payload":"v"}));
        envelope.issued_at = (Utc::now() - chrono::Duration::seconds(400))
            .to_rfc3339_opts(SecondsFormat::Millis, true);
        assert!(verify_envelope(&envelope, "machine-001", secret, 300).is_err());
    }
}

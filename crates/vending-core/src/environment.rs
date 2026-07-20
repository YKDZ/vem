use serde::{Deserialize, Serialize};

use crate::serial::EnvironmentSample;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EnvironmentSensorStatus {
    Ok,
    Faulted,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentHeartbeatPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature_celsius: Option<i8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub humidity_rh: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sampled_at: Option<String>,
    pub sensor_status: EnvironmentSensorStatus,
}

impl Default for EnvironmentHeartbeatPayload {
    fn default() -> Self {
        Self {
            temperature_celsius: None,
            humidity_rh: None,
            sampled_at: None,
            sensor_status: EnvironmentSensorStatus::Unknown,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct EnvironmentHeartbeatCache {
    payload: EnvironmentHeartbeatPayload,
    consecutive_empty_samples: u8,
}

impl EnvironmentHeartbeatCache {
    pub fn record_query_result(&mut self, sample: Option<EnvironmentSample>, sampled_at: String) {
        match sample {
            Some(sample) => {
                self.consecutive_empty_samples = 0;
                self.payload.temperature_celsius = Some(sample.temperature_celsius);
                self.payload.humidity_rh = Some(sample.relative_humidity_percent);
                self.payload.sampled_at = Some(sampled_at);
                self.payload.sensor_status = EnvironmentSensorStatus::Ok;
            }
            None => {
                self.consecutive_empty_samples = self.consecutive_empty_samples.saturating_add(1);
                if self.consecutive_empty_samples >= 3 {
                    self.payload.sensor_status = EnvironmentSensorStatus::Faulted;
                }
            }
        }
    }

    pub fn record_sensor_fault(&mut self) {
        self.payload.sensor_status = EnvironmentSensorStatus::Faulted;
    }

    pub fn heartbeat_payload(&self) -> EnvironmentHeartbeatPayload {
        self.payload.clone()
    }
}

#[cfg(test)]
mod tests {
    use crate::{
        environment::{EnvironmentHeartbeatCache, EnvironmentSensorStatus},
        serial::EnvironmentSample,
    };

    #[test]
    fn heartbeat_serializes_only_b0_observations() {
        let payload =
            serde_json::to_value(EnvironmentHeartbeatCache::default().heartbeat_payload())
                .expect("serialize environment heartbeat");

        assert_eq!(payload, serde_json::json!({ "sensorStatus": "unknown" }));
    }

    #[test]
    fn preserves_last_valid_reading_after_one_empty_sample() {
        let mut cache = EnvironmentHeartbeatCache::default();

        cache.record_query_result(
            Some(EnvironmentSample {
                temperature_celsius: 24,
                relative_humidity_percent: 53,
            }),
            "2026-05-05T12:00:00.000Z".to_string(),
        );
        cache.record_query_result(None, "2026-05-05T12:00:30.000Z".to_string());

        let payload = cache.heartbeat_payload();
        assert_eq!(payload.sensor_status, EnvironmentSensorStatus::Ok);
        assert_eq!(payload.temperature_celsius, Some(24));
        assert_eq!(payload.humidity_rh, Some(53));
        assert_eq!(
            payload.sampled_at.as_deref(),
            Some("2026-05-05T12:00:00.000Z")
        );
    }

    #[test]
    fn three_empty_samples_mark_sensor_faulted_without_clearing_last_reading() {
        let mut cache = EnvironmentHeartbeatCache::default();

        cache.record_query_result(
            Some(EnvironmentSample {
                temperature_celsius: 24,
                relative_humidity_percent: 53,
            }),
            "2026-05-05T12:00:00.000Z".to_string(),
        );
        cache.record_query_result(None, "2026-05-05T12:00:30.000Z".to_string());
        cache.record_query_result(None, "2026-05-05T12:01:00.000Z".to_string());
        cache.record_query_result(None, "2026-05-05T12:01:30.000Z".to_string());

        let payload = cache.heartbeat_payload();
        assert_eq!(payload.sensor_status, EnvironmentSensorStatus::Faulted);
        assert_eq!(payload.temperature_celsius, Some(24));
        assert_eq!(payload.humidity_rh, Some(53));
        assert_eq!(
            payload.sampled_at.as_deref(),
            Some("2026-05-05T12:00:00.000Z")
        );
    }

    #[test]
    fn explicit_sensor_fault_marks_faulted_immediately_without_clearing_last_reading() {
        let mut cache = EnvironmentHeartbeatCache::default();

        cache.record_query_result(
            Some(EnvironmentSample {
                temperature_celsius: 24,
                relative_humidity_percent: 53,
            }),
            "2026-05-05T12:00:00.000Z".to_string(),
        );
        cache.record_sensor_fault();

        let payload = cache.heartbeat_payload();
        assert_eq!(payload.sensor_status, EnvironmentSensorStatus::Faulted);
        assert_eq!(payload.temperature_celsius, Some(24));
        assert_eq!(payload.humidity_rh, Some(53));
    }
}

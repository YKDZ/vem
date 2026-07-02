use vending_core::environment::{EnvironmentHeartbeatPayload, EnvironmentSensorStatus};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineNaturalContextSnapshot {
    pub status: NaturalContextStatus,
    pub machine_code: Option<String>,
    pub external_environment: serde_json::Value,
    pub local_site_signals: LocalSiteSignalsProjection,
    pub degraded: bool,
    pub customer_facing_blocked: bool,
    pub checked_at: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NaturalContextStatus {
    Ready,
    Stale,
    Unavailable,
    Unconfigured,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSiteSignalsProjection {
    pub status: LocalSiteSignalsStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature_celsius: Option<i8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub humidity_rh: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sampled_at: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LocalSiteSignalsStatus {
    Ok,
    Faulted,
    Unknown,
    Unavailable,
}

impl LocalSiteSignalsProjection {
    pub fn unavailable() -> Self {
        Self {
            status: LocalSiteSignalsStatus::Unavailable,
            temperature_celsius: None,
            humidity_rh: None,
            sampled_at: None,
        }
    }

    pub fn from_environment(payload: EnvironmentHeartbeatPayload) -> Self {
        Self {
            status: match payload.sensor_status {
                EnvironmentSensorStatus::Ok => LocalSiteSignalsStatus::Ok,
                EnvironmentSensorStatus::Faulted => LocalSiteSignalsStatus::Faulted,
                EnvironmentSensorStatus::Unknown => LocalSiteSignalsStatus::Unknown,
            },
            temperature_celsius: payload.temperature_celsius,
            humidity_rh: payload.humidity_rh,
            sampled_at: payload.sampled_at,
        }
    }
}

impl MachineNaturalContextSnapshot {
    pub fn unconfigured(machine_code: Option<String>, message: impl Into<String>) -> Self {
        let checked_at = crate::state::store::now_iso();
        let external_environment = serde_json::json!({
            "status": "unconfigured",
            "machineCode": machine_code,
            "checkedAt": checked_at,
            "diagnostic": {
                "reason": "machine_geo_location_missing",
                "message": message.into(),
            },
        });
        Self::from_external_environment(machine_code, external_environment, None)
    }

    pub fn unavailable(machine_code: Option<String>, message: impl Into<String>) -> Self {
        let checked_at = crate::state::store::now_iso();
        let external_environment = serde_json::json!({
            "status": "unavailable",
            "machineCode": machine_code,
            "checkedAt": checked_at,
            "diagnostic": {
                "reason": "provider_unavailable",
                "message": message.into(),
            },
        });
        Self::from_external_environment(machine_code, external_environment, None)
    }

    pub fn from_external_environment(
        machine_code: Option<String>,
        external_environment: serde_json::Value,
        local_environment: Option<EnvironmentHeartbeatPayload>,
    ) -> Self {
        let status = match external_environment
            .get("status")
            .and_then(|value| value.as_str())
        {
            Some("ready") => NaturalContextStatus::Ready,
            Some("stale") => NaturalContextStatus::Stale,
            Some("unconfigured") => NaturalContextStatus::Unconfigured,
            _ => NaturalContextStatus::Unavailable,
        };
        let checked_at = external_environment
            .get("checkedAt")
            .and_then(|value| value.as_str())
            .map(ToString::to_string)
            .unwrap_or_else(crate::state::store::now_iso);
        Self {
            degraded: status != NaturalContextStatus::Ready,
            status,
            machine_code,
            external_environment,
            local_site_signals: local_environment
                .map(LocalSiteSignalsProjection::from_environment)
                .unwrap_or_else(LocalSiteSignalsProjection::unavailable),
            customer_facing_blocked: false,
            checked_at,
        }
    }
}

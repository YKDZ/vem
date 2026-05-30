use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HealthLevel {
    Ok,
    Degraded,
    Offline,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DaemonUiStatus {
    Healthy,
    Degraded,
    Offline,
    Maintenance,
    Starting,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadyReason {
    pub code: String,
    pub component: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SuggestedRoute {
    Maintenance,
    Offline,
    Catalog,
    Payment,
    Dispensing,
    Result,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentHealth {
    pub component: String,
    pub level: HealthLevel,
    pub code: String,
    pub message: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthSnapshot {
    pub status: DaemonUiStatus,
    pub process: ComponentHealth,
    pub components: Vec<ComponentHealth>,
    pub config_configured: bool,
    pub database_online: bool,
    pub backend_online: bool,
    pub mqtt_connected: bool,
    pub outbox_size: usize,
    pub outbox_max: usize,
    pub hardware_online: bool,
    pub scanner_online: bool,
    pub vision_online: bool,
    pub remote_ops_active: bool,
    pub current_transaction: Option<crate::domain::CurrentTransactionSummary>,
    pub operator_reason: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadySnapshot {
    pub ready: bool,
    pub can_sell: bool,
    pub mode: String,
    pub blocking_codes: Vec<String>,
    pub blocking_reasons: Vec<ReadyReason>,
    pub degraded_reasons: Vec<ReadyReason>,
    pub suggested_route: SuggestedRoute,
    pub updated_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_snapshot_is_camel_case() {
        let snapshot = HealthSnapshot {
            status: DaemonUiStatus::Healthy,
            process: ComponentHealth {
                component: "daemon".to_string(),
                level: HealthLevel::Ok,
                code: "OK".to_string(),
                message: "ok".to_string(),
                updated_at: "2025-01-01T00:00:00.000Z".to_string(),
            },
            components: vec![],
            config_configured: true,
            database_online: true,
            backend_online: true,
            mqtt_connected: true,
            outbox_size: 0,
            outbox_max: 256,
            hardware_online: true,
            scanner_online: true,
            vision_online: true,
            remote_ops_active: false,
            current_transaction: None,
            operator_reason: String::new(),
            updated_at: "2025-01-01T00:00:00.000Z".to_string(),
        };
        let value = serde_json::to_string(&snapshot).expect("serialize snapshot");
        assert!(value.contains("\"outboxSize\""));
        assert!(value.contains("\"updatedAt\""));
        assert!(value.contains("\"configConfigured\""));
        assert!(value.contains("\"currentTransaction\""));
        assert!(!value.contains("authCode"));
        let ready = super::ReadySnapshot {
            ready: true,
            can_sell: true,
            mode: "sale".to_string(),
            blocking_codes: vec![],
            blocking_reasons: vec![],
            degraded_reasons: vec![],
            suggested_route: super::SuggestedRoute::Catalog,
            updated_at: "2025-01-01T00:00:00.000Z".to_string(),
        };
        let ready_json = serde_json::to_string(&ready).expect("ready");
        assert!(ready_json.contains("\"canSell\""));
        assert!(ready_json.contains("\"suggestedRoute\""));
    }
}

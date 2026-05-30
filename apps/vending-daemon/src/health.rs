use std::collections::BTreeMap;

use tokio::sync::RwLock;

use crate::state::LocalStateStore;

pub struct HealthAggregator {
    state: LocalStateStore,
    components: RwLock<BTreeMap<String, vending_core::health::ComponentHealth>>,
}

impl HealthAggregator {
    pub fn new(state: LocalStateStore) -> Self {
        Self {
            state,
            components: RwLock::new(BTreeMap::new()),
        }
    }

    pub async fn set_component(
        &self,
        component: &str,
        level: vending_core::health::HealthLevel,
        code: &str,
        message: &str,
    ) {
        let item = vending_core::health::ComponentHealth {
            component: component.to_string(),
            level,
            code: code.to_string(),
            message: message.to_string(),
            updated_at: crate::state::store::now_iso(),
        };
        let mut guard = self.components.write().await;
        guard.insert(component.to_string(), item.clone());
        let _ = self.state.append_health_event(&item).await;
    }

    pub async fn health_snapshot(&self) -> vending_core::health::HealthSnapshot {
        let components = self
            .components
            .read()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let outbox_size = self.state.outbox_size().await.ok();
        let blocking = components
            .iter()
            .filter(|item| {
                matches!(
                    item.level,
                    vending_core::health::HealthLevel::Offline
                        | vending_core::health::HealthLevel::Error
                )
            })
            .collect::<Vec<_>>();
        let scanner_online = !components.iter().any(|item| {
            item.component == "scanner"
                && matches!(item.level, vending_core::health::HealthLevel::Offline)
        });
        let vision_online = !components.iter().any(|item| {
            item.component == "vision"
                && matches!(item.level, vending_core::health::HealthLevel::Offline)
        });
        vending_core::health::HealthSnapshot {
            status: if blocking.is_empty() {
                vending_core::health::DaemonUiStatus::Healthy
            } else {
                vending_core::health::DaemonUiStatus::Degraded
            },
            process: vending_core::health::ComponentHealth {
                component: "daemon".to_string(),
                level: vending_core::health::HealthLevel::Ok,
                code: "DAEMON_ALIVE".to_string(),
                message: "daemon process and IPC are alive".to_string(),
                updated_at: crate::state::store::now_iso(),
            },
            components: components.clone(),
            config_configured: true,
            database_online: true,
            backend_online: true,
            mqtt_connected: true,
            outbox_size: outbox_size.unwrap_or(0) as usize,
            outbox_max: 1000,
            hardware_online: true,
            scanner_online,
            vision_online,
            remote_ops_active: true,
            current_transaction: self
                .state
                .current_order_session_snapshot()
                .await
                .ok()
                .flatten()
                .and_then(|snapshot| {
                    let order_no = snapshot.order_no?;
                    let status = snapshot.status?;
                    Some(vending_core::domain::CurrentTransactionSummary {
                        order_no,
                        status,
                        next_action: snapshot
                            .next_action
                            .unwrap_or_else(|| "submit_payment".to_string()),
                        updated_at: snapshot.updated_at,
                    })
                }),
            operator_reason: if blocking.is_empty() {
                String::new()
            } else {
                blocking
                    .iter()
                    .map(|item| item.code.clone())
                    .collect::<Vec<_>>()
                    .join(",")
            },
            updated_at: crate::state::store::now_iso(),
        }
    }

    pub async fn ready_snapshot(&self) -> vending_core::health::ReadySnapshot {
        let components = self.components.read().await;
        let blocking_codes = components
            .values()
            .filter(|item| {
                matches!(
                    item.level,
                    vending_core::health::HealthLevel::Offline
                        | vending_core::health::HealthLevel::Error
                )
            })
            .map(|item| item.code.clone())
            .collect::<Vec<_>>();
        vending_core::health::ReadySnapshot {
            ready: blocking_codes.is_empty(),
            can_sell: blocking_codes.is_empty(),
            mode: if blocking_codes.is_empty() {
                "sale".to_string()
            } else {
                "maintenance".to_string()
            },
            blocking_codes: blocking_codes.clone(),
            blocking_reasons: vec![],
            degraded_reasons: vec![],
            suggested_route: if blocking_codes.is_empty() {
                vending_core::health::SuggestedRoute::Catalog
            } else {
                vending_core::health::SuggestedRoute::Maintenance
            },
            updated_at: crate::state::store::now_iso(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn health_ready_false_when_blocking_error_component() {
        let state =
            crate::state::LocalStateStore::open(&std::path::Path::new("/tmp/vem_health_test.db"))
                .await
                .expect("state");
        let health = HealthAggregator::new(state);

        health
            .set_component(
                "config",
                vending_core::health::HealthLevel::Error,
                "CONFIG_INCOMPLETE",
                "machine code missing",
            )
            .await;

        let ready = health.ready_snapshot().await;
        assert!(!ready.ready);
        assert_eq!(ready.blocking_codes, vec!["CONFIG_INCOMPLETE"]);
        assert_eq!(ready.mode, "maintenance");
    }
}

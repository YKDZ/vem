use serde::{Deserialize, Serialize};

use crate::config::{MachinePublicRuntimeConfig, RuntimeHardwareMode};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BringUpState {
    NetworkRequired,
    PlatformReachable,
    ClaimRequired,
    // Claiming is intentionally absent until claim attempts have a durable async tracker.
    ProfileApplied,
    TopologyMismatch,
    HardwareAcceptanceRequired,
    StockAttestationRequired,
    RuntimeReady,
    SimulatedHardwareReady,
    SellReady,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BringUpReadinessLevel {
    NotReady,
    RuntimeReady,
    SimulatedHardwareReady,
    SellReady,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BringUpHardwareMode {
    Production,
    Simulated,
}

impl Default for BringUpHardwareMode {
    fn default() -> Self {
        Self::Simulated
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BringUpReason {
    pub code: String,
    pub component: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BringUpAllowedActions {
    pub configure_network: bool,
    pub claim_machine: bool,
    pub retry_claim: bool,
    pub sync_profile: bool,
    pub resolve_topology: bool,
    pub run_runtime_acceptance: bool,
    pub run_hardware_acceptance: bool,
    pub attest_stock: bool,
    pub start_sales: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BringUpSnapshot {
    pub state: BringUpState,
    pub blocking_reasons: Vec<BringUpReason>,
    pub diagnostics: Vec<BringUpReason>,
    pub readiness_level: BringUpReadinessLevel,
    pub hardware_mode: BringUpHardwareMode,
    pub allowed_actions: BringUpAllowedActions,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default)]
pub struct BringUpEvaluationInput {
    pub config: Option<MachinePublicRuntimeConfig>,
    pub config_error: Option<String>,
    pub hardware_mode: BringUpHardwareMode,
    pub platform_reachable: bool,
    pub topology_ready: Option<bool>,
    pub topology_code: Option<String>,
    pub topology_message: Option<String>,
    pub active_planogram_ready: bool,
    pub production_dispense_path_ready: bool,
    pub production_dispense_path_code: Option<String>,
    pub production_dispense_path_message: Option<String>,
    pub hardware_online: bool,
    pub stock_attestation_required: bool,
    pub stock_attestation_ready: bool,
    pub sale_ready: bool,
    pub updated_at: String,
}

pub fn evaluate_bring_up(input: BringUpEvaluationInput) -> BringUpSnapshot {
    let hardware_mode = input.hardware_mode.clone();
    let public = input.config.as_ref().map(|config| &config.public);
    let network_configured = public
        .map(|public| !public.api_base_url.trim().is_empty())
        .unwrap_or(false);
    let provisioned = input
        .config
        .as_ref()
        .map(|config| config.provisioned)
        .unwrap_or(false);

    let mut blocking_reasons = Vec::new();
    let mut diagnostics = Vec::new();

    if let Some(error) = input.config_error.as_ref() {
        diagnostics.push(reason(
            "CONFIG_SUMMARY_UNAVAILABLE",
            "config",
            safe_diagnostic(error),
        ));
    } else if !provisioned {
        diagnostics.push(reason(
            "PUBLIC_CONFIG_UNCLAIMED",
            "config",
            "local runtime has no applied provisioning profile",
        ));
    } else {
        diagnostics.push(reason(
            "PUBLIC_CONFIG_PROFILE_APPLIED",
            "config",
            "local runtime has an applied provisioning profile",
        ));
    }

    let state = if !input.platform_reachable || (input.config.is_some() && !network_configured) {
        blocking_reasons.push(reason(
            "NETWORK_REQUIRED",
            "platform",
            if network_configured {
                "platform endpoint is not reachable"
            } else {
                "platform endpoint is not configured"
            },
        ));
        BringUpState::NetworkRequired
    } else if input.config.is_none() {
        BringUpState::PlatformReachable
    } else if !provisioned {
        blocking_reasons.push(reason(
            "CLAIM_REQUIRED",
            "provisioning",
            "machine must be claimed before runtime profile can be applied",
        ));
        BringUpState::ClaimRequired
    } else if input.topology_ready == Some(false) {
        blocking_reasons.push(reason(
            input
                .topology_code
                .as_deref()
                .unwrap_or("TOPOLOGY_MISMATCH"),
            "topology",
            input
                .topology_message
                .as_deref()
                .unwrap_or("hardware slot topology blocks sales"),
        ));
        BringUpState::TopologyMismatch
    } else if !input.active_planogram_ready {
        blocking_reasons.push(reason(
            "ACTIVE_PLANOGRAM_MISSING",
            "stock",
            "active planogram must be applied before runtime readiness",
        ));
        BringUpState::ProfileApplied
    } else if hardware_mode == BringUpHardwareMode::Production
        && (!input.production_dispense_path_ready || !input.hardware_online)
    {
        blocking_reasons.push(reason(
            input
                .production_dispense_path_code
                .as_deref()
                .unwrap_or("HARDWARE_ACCEPTANCE_REQUIRED"),
            "hardware",
            input
                .production_dispense_path_message
                .as_deref()
                .unwrap_or("production hardware acceptance is required"),
        ));
        BringUpState::HardwareAcceptanceRequired
    } else if input.stock_attestation_required && !input.stock_attestation_ready {
        blocking_reasons.push(reason(
            "STOCK_ATTESTATION_REQUIRED",
            "stock",
            "physical stock attestation is required before sales",
        ));
        BringUpState::StockAttestationRequired
    } else if input.sale_ready && hardware_mode == BringUpHardwareMode::Production {
        BringUpState::SellReady
    } else if hardware_mode == BringUpHardwareMode::Simulated {
        BringUpState::SimulatedHardwareReady
    } else {
        BringUpState::RuntimeReady
    };

    if input.platform_reachable {
        diagnostics.push(reason(
            "PLATFORM_REACHABLE",
            "platform",
            "platform endpoint is reachable",
        ));
    }

    let readiness_level = match state {
        BringUpState::SellReady => BringUpReadinessLevel::SellReady,
        BringUpState::SimulatedHardwareReady => BringUpReadinessLevel::SimulatedHardwareReady,
        BringUpState::RuntimeReady => BringUpReadinessLevel::RuntimeReady,
        _ => BringUpReadinessLevel::NotReady,
    };

    let allowed_actions = BringUpAllowedActions {
        configure_network: state == BringUpState::NetworkRequired,
        claim_machine: state == BringUpState::ClaimRequired,
        retry_claim: state == BringUpState::ClaimRequired,
        sync_profile: matches!(
            state,
            BringUpState::PlatformReachable | BringUpState::ProfileApplied
        ),
        resolve_topology: state == BringUpState::TopologyMismatch,
        run_runtime_acceptance: matches!(
            state,
            BringUpState::ProfileApplied
                | BringUpState::HardwareAcceptanceRequired
                | BringUpState::StockAttestationRequired
                | BringUpState::RuntimeReady
                | BringUpState::SimulatedHardwareReady
        ),
        run_hardware_acceptance: state == BringUpState::HardwareAcceptanceRequired,
        attest_stock: state == BringUpState::StockAttestationRequired,
        start_sales: state == BringUpState::SellReady,
    };

    BringUpSnapshot {
        state,
        blocking_reasons,
        diagnostics,
        readiness_level,
        hardware_mode,
        allowed_actions,
        updated_at: input.updated_at,
    }
}

impl From<RuntimeHardwareMode> for BringUpHardwareMode {
    fn from(value: RuntimeHardwareMode) -> Self {
        match value {
            RuntimeHardwareMode::Production => BringUpHardwareMode::Production,
            RuntimeHardwareMode::Simulated => BringUpHardwareMode::Simulated,
        }
    }
}

fn reason(
    code: impl Into<String>,
    component: impl Into<String>,
    message: impl Into<String>,
) -> BringUpReason {
    BringUpReason {
        code: code.into(),
        component: component.into(),
        message: message.into(),
    }
}

fn safe_diagnostic(message: &str) -> String {
    let lower = message.to_ascii_lowercase();
    if lower.contains("secret") || lower.contains("password") || lower.contains("token") {
        return "configuration summary unavailable".to_string();
    }
    message.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        default_public_config, MachinePublicRuntimeConfig, ProductionControllerProfile,
        ProductionMachineHardwareProfile, ProductionPaymentScannerProfile, ProductionVisionProfile,
        ProvisioningRuntimeEndpoints,
    };

    fn public_config() -> MachinePublicRuntimeConfig {
        MachinePublicRuntimeConfig {
            public: default_public_config(),
            machine_secret_configured: false,
            mqtt_signing_secret_configured: false,
            mqtt_password_configured: false,
            provisioned: false,
            provisioning_issues: vec!["machine_code_missing".to_string()],
        }
    }

    fn provisioned_config() -> MachinePublicRuntimeConfig {
        let mut config = public_config();
        config.public.machine_code = Some("MACHINE-1".to_string());
        config.public.machine_id = Some("550e8400-e29b-41d4-a716-446655440000".to_string());
        config.public.api_base_url = "http://127.0.0.1:3000/api".to_string();
        config.public.mqtt_client_id = Some("vem-machine-MACHINE-1".to_string());
        config.public.runtime_endpoints = Some(ProvisioningRuntimeEndpoints {
            api_base_path: "/api".to_string(),
            machine_auth_token_path: "/machine/auth/token".to_string(),
            machine_api_base_path: "/machine".to_string(),
            mqtt_topic_prefix: "machines/MACHINE-1".to_string(),
        });
        config.machine_secret_configured = true;
        config.mqtt_signing_secret_configured = true;
        config.provisioned = true;
        config.provisioning_issues = vec![];
        config
    }

    fn production_config() -> MachinePublicRuntimeConfig {
        let mut config = provisioned_config();
        config.public.hardware_profile = Some(ProductionMachineHardwareProfile {
            profile: "production".to_string(),
            controller: ProductionControllerProfile {
                required: true,
                protocol: "vem-lower-controller-v1".to_string(),
            },
            payment_scanner: ProductionPaymentScannerProfile {
                required: true,
                supports_payment_code: true,
            },
            vision: ProductionVisionProfile {
                required: false,
                supports_recommendations: true,
            },
        });
        config
    }

    fn input() -> BringUpEvaluationInput {
        BringUpEvaluationInput {
            config: Some(public_config()),
            updated_at: "2026-07-04T00:00:00Z".to_string(),
            ..BringUpEvaluationInput::default()
        }
    }

    #[test]
    fn network_required_allows_only_network_configuration() {
        let snapshot = evaluate_bring_up(input());

        assert_eq!(snapshot.state, BringUpState::NetworkRequired);
        assert_eq!(snapshot.readiness_level, BringUpReadinessLevel::NotReady);
        assert!(snapshot.allowed_actions.configure_network);
        assert!(!snapshot.allowed_actions.claim_machine);
        assert!(!snapshot.allowed_actions.start_sales);
    }

    #[test]
    fn platform_reachable_is_distinct_from_claim_required_when_config_summary_is_missing() {
        let snapshot = evaluate_bring_up(BringUpEvaluationInput {
            config: None,
            config_error: Some("machine config not yet written".to_string()),
            platform_reachable: true,
            updated_at: "2026-07-04T00:00:00Z".to_string(),
            ..BringUpEvaluationInput::default()
        });

        assert_eq!(snapshot.state, BringUpState::PlatformReachable);
        assert!(!snapshot.allowed_actions.configure_network);
        assert!(!snapshot.allowed_actions.claim_machine);
        assert!(snapshot.allowed_actions.sync_profile);
    }

    #[test]
    fn claim_required_allows_machine_claim_only_after_network_is_ready() {
        let mut config = public_config();
        config.public.api_base_url = "http://127.0.0.1:3000/api".to_string();
        let snapshot = evaluate_bring_up(BringUpEvaluationInput {
            config: Some(config),
            platform_reachable: true,
            updated_at: "2026-07-04T00:00:00Z".to_string(),
            ..BringUpEvaluationInput::default()
        });

        assert_eq!(snapshot.state, BringUpState::ClaimRequired);
        assert!(snapshot.allowed_actions.claim_machine);
        assert!(snapshot.allowed_actions.retry_claim);
        assert!(!snapshot.allowed_actions.start_sales);
    }

    #[test]
    fn topology_mismatch_blocks_runtime_acceptance_and_exposes_resolution_action() {
        let snapshot = evaluate_bring_up(BringUpEvaluationInput {
            config: Some(provisioned_config()),
            platform_reachable: true,
            topology_ready: Some(false),
            topology_code: Some("TOPOLOGY_MISMATCH".to_string()),
            topology_message: Some("factory topology differs from platform".to_string()),
            updated_at: "2026-07-04T00:00:00Z".to_string(),
            ..BringUpEvaluationInput::default()
        });

        assert_eq!(snapshot.state, BringUpState::TopologyMismatch);
        assert_eq!(snapshot.blocking_reasons[0].code, "TOPOLOGY_MISMATCH");
        assert!(snapshot.allowed_actions.resolve_topology);
        assert!(!snapshot.allowed_actions.run_runtime_acceptance);
    }

    #[test]
    fn profile_applied_waits_for_planogram_before_runtime_acceptance() {
        let snapshot = evaluate_bring_up(BringUpEvaluationInput {
            config: Some(provisioned_config()),
            platform_reachable: true,
            topology_ready: Some(true),
            updated_at: "2026-07-04T00:00:00Z".to_string(),
            ..BringUpEvaluationInput::default()
        });

        assert_eq!(snapshot.state, BringUpState::ProfileApplied);
        assert!(snapshot.allowed_actions.run_runtime_acceptance);
        assert!(!snapshot.allowed_actions.start_sales);
    }

    #[test]
    fn simulated_hardware_mode_reaches_simulated_hardware_ready_without_sell_evidence() {
        let snapshot = evaluate_bring_up(BringUpEvaluationInput {
            config: Some(provisioned_config()),
            platform_reachable: true,
            topology_ready: Some(true),
            active_planogram_ready: true,
            updated_at: "2026-07-04T00:00:00Z".to_string(),
            ..BringUpEvaluationInput::default()
        });

        assert_eq!(snapshot.hardware_mode, BringUpHardwareMode::Simulated);
        assert_eq!(snapshot.state, BringUpState::SimulatedHardwareReady);
        assert_eq!(
            snapshot.readiness_level,
            BringUpReadinessLevel::SimulatedHardwareReady
        );
        assert!(snapshot.allowed_actions.run_runtime_acceptance);
        assert!(!snapshot.allowed_actions.start_sales);
    }

    #[test]
    fn production_hardware_mode_requires_hardware_acceptance_before_stock_or_sales() {
        let snapshot = evaluate_bring_up(BringUpEvaluationInput {
            config: Some(production_config()),
            hardware_mode: BringUpHardwareMode::Production,
            platform_reachable: true,
            topology_ready: Some(true),
            active_planogram_ready: true,
            production_dispense_path_ready: false,
            production_dispense_path_code: Some("PRODUCTION_DISPENSE_PATH_MOCK".to_string()),
            production_dispense_path_message: Some(
                "production path cannot use mock hardware".to_string(),
            ),
            updated_at: "2026-07-04T00:00:00Z".to_string(),
            ..BringUpEvaluationInput::default()
        });

        assert_eq!(snapshot.hardware_mode, BringUpHardwareMode::Production);
        assert_eq!(snapshot.state, BringUpState::HardwareAcceptanceRequired);
        assert!(snapshot.allowed_actions.run_hardware_acceptance);
        assert!(!snapshot.allowed_actions.attest_stock);
    }

    #[test]
    fn production_mode_requires_stock_attestation_after_hardware_acceptance() {
        let snapshot = evaluate_bring_up(BringUpEvaluationInput {
            config: Some(production_config()),
            hardware_mode: BringUpHardwareMode::Production,
            platform_reachable: true,
            topology_ready: Some(true),
            active_planogram_ready: true,
            hardware_online: true,
            production_dispense_path_ready: true,
            stock_attestation_required: true,
            stock_attestation_ready: false,
            updated_at: "2026-07-04T00:00:00Z".to_string(),
            ..BringUpEvaluationInput::default()
        });

        assert_eq!(snapshot.state, BringUpState::StockAttestationRequired);
        assert!(snapshot.allowed_actions.attest_stock);
        assert!(!snapshot.allowed_actions.start_sales);
    }

    #[test]
    fn production_sell_ready_allows_starting_sales() {
        let snapshot = evaluate_bring_up(BringUpEvaluationInput {
            config: Some(production_config()),
            hardware_mode: BringUpHardwareMode::Production,
            platform_reachable: true,
            topology_ready: Some(true),
            active_planogram_ready: true,
            hardware_online: true,
            production_dispense_path_ready: true,
            stock_attestation_required: true,
            stock_attestation_ready: true,
            sale_ready: true,
            updated_at: "2026-07-04T00:00:00Z".to_string(),
            ..BringUpEvaluationInput::default()
        });

        assert_eq!(snapshot.state, BringUpState::SellReady);
        assert_eq!(snapshot.readiness_level, BringUpReadinessLevel::SellReady);
        assert!(snapshot.allowed_actions.start_sales);
    }
}

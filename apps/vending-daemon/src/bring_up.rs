use serde::{Deserialize, Serialize};

use crate::config::{MachinePublicRuntimeConfig, RuntimeHardwareMode};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BringUpState {
    NetworkRequired,
    PlatformReachable,
    ClaimRequired,
    ReclaimRequired,
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

/// The single action that the Machine Runtime Console may render for the
/// current Bring-Up state.  Keeping this separate from diagnostic progress
/// prevents the UI from reconstructing a second state machine from booleans.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BringUpTaskKind {
    ConfigureNetwork,
    ClaimMachine,
    ReclaimMachine,
    SyncProfile,
    ResolveTopology,
    RunHardwareAcceptance,
    AttestStock,
    StartSales,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BringUpTaskIntent {
    ConfigureNetwork,
    RefreshNetwork,
    ClaimMachine,
    ReclaimMachine,
    RefreshProfile,
    OpenMaintenance,
    RecordStock,
    StartSales,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BringUpTask {
    pub contract_version: u8,
    /// Stable daemon-owned cursor identity.  The UI must echo this exact
    /// value when it submits the task rather than reconstructing a cursor
    /// from route state.
    pub task_id: String,
    /// Bump when the payload contract for this cursor changes.
    pub task_version: u64,
    pub kind: BringUpTaskKind,
    pub intent: BringUpTaskIntent,
    pub rotate_maintenance_identity: bool,
    pub projection: BringUpTaskProjection,
}

/// The task-specific payload keeps complex work out of the generic
/// Maintenance route. The UI can render one bounded form/action without
/// inferring the daemon cursor from route state.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BringUpTaskProjection {
    NetworkSettings {
        supports_hidden_network: bool,
        supports_existing_network_probe: bool,
    },
    ClaimCode {
        rotate_maintenance_identity: bool,
    },
    ProfileSync,
    TopologyResolution {
        component: String,
    },
    HardwareAcceptance {
        component: String,
    },
    StockAttestation {
        entry_mode: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BringUpStepKind {
    Network,
    Provisioning,
    Topology,
    Hardware,
    Stock,
    SaleReadiness,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BringUpStepStatus {
    Completed,
    Current,
    Upcoming,
    Revalidate,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BringUpEvidenceKind {
    Durable,
    Volatile,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BringUpProgressStep {
    pub kind: BringUpStepKind,
    pub status: BringUpStepStatus,
    pub evidence: BringUpEvidenceKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum BringUpHardwareMode {
    Production,
    #[default]
    Simulated,
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
    pub current_task: Option<BringUpTask>,
    pub progress: Vec<BringUpProgressStep>,
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
    /// A replacement/reinstalled machine must claim through the protected
    /// reclaim path so it rotates, rather than overwrites, daemon-owned
    /// maintenance identity.
    pub reclaim_required: bool,
    /// A protected maintenance action persisted by the daemon.  It is
    /// intentionally separate from profile-cache presence: a cache is normal
    /// after a successful claim and must not manufacture a reclaim cursor.
    pub reclaim_requested: bool,
    pub updated_at: String,
}

pub fn evaluate_bring_up(input: BringUpEvaluationInput) -> BringUpSnapshot {
    let hardware_mode = input.hardware_mode.clone();
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

    let state = if !input.platform_reachable {
        blocking_reasons.push(reason(
            "NETWORK_REQUIRED",
            "platform",
            "local network and pre-claim platform endpoint have not been verified",
        ));
        BringUpState::NetworkRequired
    } else if input.config.is_none() {
        BringUpState::PlatformReachable
    } else if input.reclaim_requested {
        blocking_reasons.push(reason(
            "RECLAIM_AUTHORIZED",
            "provisioning",
            "protected maintenance authorized this machine reclaim",
        ));
        BringUpState::ReclaimRequired
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
        claim_machine: matches!(
            state,
            BringUpState::ClaimRequired | BringUpState::ReclaimRequired
        ),
        retry_claim: matches!(
            state,
            BringUpState::ClaimRequired | BringUpState::ReclaimRequired
        ),
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
        ),
        run_hardware_acceptance: state == BringUpState::HardwareAcceptanceRequired,
        attest_stock: state == BringUpState::StockAttestationRequired,
        start_sales: state == BringUpState::SellReady,
    };

    let current_task = task_for_state(&state, input.reclaim_required || input.reclaim_requested);
    let progress = progress_for_state(&state, &input, provisioned);

    BringUpSnapshot {
        state,
        blocking_reasons,
        diagnostics,
        readiness_level,
        hardware_mode,
        allowed_actions,
        current_task,
        progress,
        updated_at: input.updated_at,
    }
}

fn task_for_state(state: &BringUpState, reclaim_required: bool) -> Option<BringUpTask> {
    let (kind, intent) = match state {
        BringUpState::NetworkRequired => (
            BringUpTaskKind::ConfigureNetwork,
            BringUpTaskIntent::RefreshNetwork,
        ),
        BringUpState::PlatformReachable | BringUpState::ProfileApplied => (
            BringUpTaskKind::SyncProfile,
            BringUpTaskIntent::RefreshProfile,
        ),
        BringUpState::ReclaimRequired => (
            BringUpTaskKind::ReclaimMachine,
            BringUpTaskIntent::ReclaimMachine,
        ),
        BringUpState::ClaimRequired if reclaim_required => (
            BringUpTaskKind::ReclaimMachine,
            BringUpTaskIntent::ReclaimMachine,
        ),
        BringUpState::ClaimRequired => (
            BringUpTaskKind::ClaimMachine,
            BringUpTaskIntent::ClaimMachine,
        ),
        BringUpState::TopologyMismatch => (
            BringUpTaskKind::ResolveTopology,
            BringUpTaskIntent::OpenMaintenance,
        ),
        BringUpState::HardwareAcceptanceRequired => (
            BringUpTaskKind::RunHardwareAcceptance,
            BringUpTaskIntent::OpenMaintenance,
        ),
        BringUpState::StockAttestationRequired => {
            (BringUpTaskKind::AttestStock, BringUpTaskIntent::RecordStock)
        }
        BringUpState::RuntimeReady
        | BringUpState::SimulatedHardwareReady
        | BringUpState::SellReady => {
            return None;
        }
    };
    let projection = task_projection(&kind, reclaim_required);
    Some(BringUpTask {
        contract_version: 1,
        task_id: task_id(&kind).to_string(),
        task_version: task_version(&kind),
        kind,
        intent,
        rotate_maintenance_identity: reclaim_required
            && matches!(
                state,
                BringUpState::ClaimRequired | BringUpState::ReclaimRequired
            ),
        projection,
    })
}

fn task_version(kind: &BringUpTaskKind) -> u64 {
    match kind {
        // v2 adds the password-free existing-network probe. Clients must
        // obtain this cursor rather than infer readiness from apiBaseUrl.
        BringUpTaskKind::ConfigureNetwork => 2,
        _ => 1,
    }
}

fn task_id(kind: &BringUpTaskKind) -> &'static str {
    match kind {
        BringUpTaskKind::ConfigureNetwork => "bring_up.configure_network",
        BringUpTaskKind::ClaimMachine => "bring_up.claim_machine",
        BringUpTaskKind::ReclaimMachine => "bring_up.reclaim_machine",
        BringUpTaskKind::SyncProfile => "bring_up.sync_profile",
        BringUpTaskKind::ResolveTopology => "bring_up.resolve_topology",
        BringUpTaskKind::RunHardwareAcceptance => "bring_up.hardware_acceptance",
        BringUpTaskKind::AttestStock => "bring_up.attest_stock",
        BringUpTaskKind::StartSales => "bring_up.start_sales",
    }
}

fn task_projection(kind: &BringUpTaskKind, reclaim_required: bool) -> BringUpTaskProjection {
    match kind {
        BringUpTaskKind::ConfigureNetwork => BringUpTaskProjection::NetworkSettings {
            supports_hidden_network: true,
            supports_existing_network_probe: true,
        },
        BringUpTaskKind::ClaimMachine | BringUpTaskKind::ReclaimMachine => {
            BringUpTaskProjection::ClaimCode {
                rotate_maintenance_identity: reclaim_required,
            }
        }
        BringUpTaskKind::SyncProfile => BringUpTaskProjection::ProfileSync,
        BringUpTaskKind::ResolveTopology => BringUpTaskProjection::TopologyResolution {
            component: "topology".to_string(),
        },
        BringUpTaskKind::RunHardwareAcceptance => BringUpTaskProjection::HardwareAcceptance {
            component: "hardware".to_string(),
        },
        BringUpTaskKind::AttestStock => BringUpTaskProjection::StockAttestation {
            entry_mode: "final_actual_quantities".to_string(),
        },
        BringUpTaskKind::StartSales => BringUpTaskProjection::ProfileSync,
    }
}

fn progress_for_state(
    state: &BringUpState,
    input: &BringUpEvaluationInput,
    provisioned: bool,
) -> Vec<BringUpProgressStep> {
    let current = match state {
        BringUpState::NetworkRequired => Some(0),
        BringUpState::PlatformReachable
        | BringUpState::ClaimRequired
        | BringUpState::ReclaimRequired => Some(1),
        BringUpState::ProfileApplied | BringUpState::TopologyMismatch => Some(2),
        BringUpState::HardwareAcceptanceRequired => Some(3),
        BringUpState::StockAttestationRequired => Some(4),
        BringUpState::RuntimeReady
        | BringUpState::SimulatedHardwareReady
        | BringUpState::SellReady => None,
    };
    let kinds = [
        (BringUpStepKind::Network, BringUpEvidenceKind::Volatile),
        (BringUpStepKind::Provisioning, BringUpEvidenceKind::Durable),
        (BringUpStepKind::Topology, BringUpEvidenceKind::Durable),
        (BringUpStepKind::Hardware, BringUpEvidenceKind::Volatile),
        (BringUpStepKind::Stock, BringUpEvidenceKind::Durable),
        (
            BringUpStepKind::SaleReadiness,
            BringUpEvidenceKind::Volatile,
        ),
    ];
    kinds
        .into_iter()
        .enumerate()
        .map(|(index, (kind, evidence))| {
            let status = progress_status(index, current, &kind, &evidence, input, provisioned);
            BringUpProgressStep {
                kind,
                evidence,
                status,
            }
        })
        .collect()
}

fn progress_status(
    index: usize,
    current: Option<usize>,
    kind: &BringUpStepKind,
    evidence: &BringUpEvidenceKind,
    input: &BringUpEvaluationInput,
    provisioned: bool,
) -> BringUpStepStatus {
    if Some(index) == current {
        return BringUpStepStatus::Current;
    }
    match kind {
        BringUpStepKind::Network => BringUpStepStatus::Revalidate,
        BringUpStepKind::Provisioning if provisioned => BringUpStepStatus::Completed,
        BringUpStepKind::Topology if provisioned && input.topology_ready == Some(true) => {
            BringUpStepStatus::Completed
        }
        BringUpStepKind::Hardware
            if input.hardware_mode == BringUpHardwareMode::Production && input.hardware_online =>
        {
            BringUpStepStatus::Revalidate
        }
        // A durable completion is evidence, never the absence of a
        // requirement. When this machine does not yet require stock, leave
        // the later step pending; a later production profile must not see a
        // fictitious completed attestation and then regress it.
        BringUpStepKind::Stock if input.stock_attestation_ready => BringUpStepStatus::Completed,
        BringUpStepKind::SaleReadiness if input.sale_ready => BringUpStepStatus::Revalidate,
        _ if matches!(evidence, BringUpEvidenceKind::Volatile)
            && current.is_some_and(|current| index < current) =>
        {
            BringUpStepStatus::Revalidate
        }
        _ => BringUpStepStatus::Upcoming,
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
    fn network_blocker_projects_one_current_task_and_compact_remaining_progress() {
        let snapshot = evaluate_bring_up(input());

        assert_eq!(
            snapshot.current_task,
            Some(BringUpTask {
                contract_version: 1,
                task_id: "bring_up.configure_network".to_string(),
                task_version: 2,
                kind: BringUpTaskKind::ConfigureNetwork,
                intent: BringUpTaskIntent::RefreshNetwork,
                rotate_maintenance_identity: false,
                projection: BringUpTaskProjection::NetworkSettings {
                    supports_hidden_network: true,
                    supports_existing_network_probe: true,
                },
            })
        );
        assert!(snapshot
            .progress
            .iter()
            .any(|step| step.kind == BringUpStepKind::Network
                && step.status == BringUpStepStatus::Current));
        assert!(snapshot
            .progress
            .iter()
            .any(|step| step.kind == BringUpStepKind::Provisioning
                && step.status == BringUpStepStatus::Upcoming));
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
    fn protected_reclaim_projects_a_rotating_daemon_identity_task() {
        let mut config = public_config();
        config.public.api_base_url = "http://127.0.0.1:3000/api".to_string();
        let snapshot = evaluate_bring_up(BringUpEvaluationInput {
            config: Some(config),
            platform_reachable: true,
            reclaim_required: true,
            updated_at: "2026-07-14T00:00:00Z".to_string(),
            ..BringUpEvaluationInput::default()
        });

        assert_eq!(
            snapshot.current_task,
            Some(BringUpTask {
                contract_version: 1,
                task_id: "bring_up.reclaim_machine".to_string(),
                task_version: 1,
                kind: BringUpTaskKind::ReclaimMachine,
                intent: BringUpTaskIntent::ReclaimMachine,
                rotate_maintenance_identity: true,
                projection: BringUpTaskProjection::ClaimCode {
                    rotate_maintenance_identity: true,
                },
            })
        );
    }

    #[test]
    fn restart_revalidates_volatile_network_evidence_without_losing_durable_provisioning() {
        let snapshot = evaluate_bring_up(BringUpEvaluationInput {
            config: Some(provisioned_config()),
            platform_reachable: false,
            updated_at: "2026-07-04T00:00:00Z".to_string(),
            ..BringUpEvaluationInput::default()
        });

        assert_eq!(snapshot.state, BringUpState::NetworkRequired);
        assert!(snapshot.progress.iter().any(|step| {
            step.kind == BringUpStepKind::Network
                && step.status == BringUpStepStatus::Current
                && step.evidence == BringUpEvidenceKind::Volatile
        }));
        assert!(snapshot.progress.iter().any(|step| {
            step.kind == BringUpStepKind::Provisioning
                && step.status == BringUpStepStatus::Completed
                && step.evidence == BringUpEvidenceKind::Durable
        }));
    }

    #[test]
    fn stock_stays_pending_until_persistent_attestation_evidence_exists() {
        let snapshot = evaluate_bring_up(BringUpEvaluationInput {
            config: Some(provisioned_config()),
            platform_reachable: true,
            active_planogram_ready: true,
            stock_attestation_required: false,
            stock_attestation_ready: false,
            updated_at: "2026-07-14T00:00:00Z".to_string(),
            ..BringUpEvaluationInput::default()
        });

        assert!(snapshot.progress.iter().any(|step| {
            step.kind == BringUpStepKind::Stock
                && step.status == BringUpStepStatus::Upcoming
                && step.evidence == BringUpEvidenceKind::Durable
        }));
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
        assert!(!snapshot.allowed_actions.run_runtime_acceptance);
        assert_eq!(snapshot.current_task, None);
        assert_eq!(
            snapshot
                .progress
                .iter()
                .filter(|step| step.status == BringUpStepStatus::Current)
                .count(),
            0
        );
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

    #[test]
    fn nonterminal_projection_has_one_current_step_and_only_durable_evidence_can_complete() {
        let snapshot = evaluate_bring_up(BringUpEvaluationInput {
            config: Some(provisioned_config()),
            platform_reachable: true,
            topology_ready: Some(false),
            updated_at: "2026-07-14T00:00:00Z".to_string(),
            ..BringUpEvaluationInput::default()
        });

        assert_eq!(snapshot.state, BringUpState::TopologyMismatch);
        assert_eq!(
            snapshot
                .progress
                .iter()
                .filter(|step| step.status == BringUpStepStatus::Current)
                .count(),
            1
        );
        assert!(snapshot.progress.iter().all(|step| {
            step.status != BringUpStepStatus::Completed
                || step.evidence == BringUpEvidenceKind::Durable
        }));
    }

    #[test]
    fn runtime_ready_is_completed_without_a_fake_hardware_task() {
        let snapshot = evaluate_bring_up(BringUpEvaluationInput {
            config: Some(production_config()),
            hardware_mode: BringUpHardwareMode::Production,
            platform_reachable: true,
            topology_ready: Some(true),
            active_planogram_ready: true,
            hardware_online: true,
            production_dispense_path_ready: true,
            updated_at: "2026-07-14T00:00:00Z".to_string(),
            ..BringUpEvaluationInput::default()
        });

        assert_eq!(snapshot.state, BringUpState::RuntimeReady);
        assert_eq!(snapshot.current_task, None);
        assert_eq!(
            snapshot
                .progress
                .iter()
                .filter(|step| step.status == BringUpStepStatus::Current)
                .count(),
            0
        );
    }
}

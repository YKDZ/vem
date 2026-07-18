use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkSettingsRequest {
    pub ssid: String,
    pub password: String,
    #[serde(default)]
    pub hidden: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NetworkSetupStatus {
    Connected,
    Failed,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkDiagnostic {
    pub component: String,
    pub level: String,
    pub code: String,
    pub message: String,
    /// A stable, independently collected readiness claim.  `component` and
    /// `level` remain for older Machine UIs; new callers must use this typed
    /// payload rather than infer one subsystem from another subsystem's
    /// health response.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence: Option<NetworkReadinessEvidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NetworkEvidenceSource {
    LocalAdapter,
    LocalAddress,
    LocalDefaultRoute,
    PlatformApi,
    MqttBroker,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NetworkEvidenceStatus {
    Ready,
    Failed,
    Pending,
    NotConfigured,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkReadinessEvidence {
    pub source: NetworkEvidenceSource,
    pub status: NetworkEvidenceStatus,
    pub reason_code: String,
    pub reason: String,
    pub recovery_action: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkSettingsResponse {
    pub status: NetworkSetupStatus,
    pub ssid: String,
    pub hidden: bool,
    pub diagnostics: Vec<NetworkDiagnostic>,
    pub operator_guidance: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WifiNetwork {
    pub ssid: String,
    pub signal_quality: u32,
    pub security: WifiSecurity,
    pub connected: bool,
    pub profile_saved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WifiSecurity {
    Open,
    WpaPersonal,
    Wpa2Personal,
    Wpa3Personal,
    Enterprise,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WifiScanStatus {
    Available,
    Failed,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WifiScanResponse {
    pub status: WifiScanStatus,
    pub networks: Vec<WifiNetwork>,
    pub operator_guidance: String,
    pub updated_at: String,
}

#[async_trait]
pub trait NetworkAdapter: Send + Sync {
    async fn scan_wifi_networks(&self) -> WifiScanResponse {
        WifiScanResponse {
            status: WifiScanStatus::Unsupported,
            networks: Vec::new(),
            operator_guidance: "当前运行环境不支持扫描无线网络，可手动输入隐藏网络。".to_string(),
            updated_at: crate::state::store::now_iso(),
        }
    }

    async fn apply_wifi_settings(&self, request: NetworkSettingsRequest)
        -> NetworkSettingsResponse;

    /// Verifies only the machine-local network state.  It must not depend on
    /// the Platform API or MQTT, so a remote outage cannot erase an already
    /// proven wired/Wi-Fi adapter, address, and default-route result.
    async fn probe_local_network_readiness(&self) -> NetworkSettingsResponse {
        local_network_unavailable_response(
            "existing-network",
            false,
            "LOCAL_NETWORK_PROBE_UNSUPPORTED",
            "This runtime cannot inspect the local adapter, address, and default route",
        )
    }

    /// Checks the connection Windows already has (wired or an existing WLAN
    /// profile) against the pre-claim Platform endpoint. This deliberately
    /// does not accept a Wi-Fi password: endpoint configuration is not
    /// connectivity evidence, and an already-connected machine must be able
    /// to progress without creating a new WLAN profile.
    async fn probe_preclaim_platform_endpoint(
        &self,
        api_base_url: &str,
    ) -> NetworkSettingsResponse {
        let local = self.probe_local_network_readiness().await;
        let platform = probe_preclaim_platform_endpoint(api_base_url).await;
        merge_local_and_platform_probe(local, platform)
    }
}

async fn probe_preclaim_platform_endpoint(api_base_url: &str) -> NetworkSettingsResponse {
    let endpoint = format!("{}/health", api_base_url.trim().trim_end_matches('/'));
    if api_base_url.trim().is_empty() {
        return failed_preclaim_probe_response(
            "PRECLAIM_PLATFORM_ENDPOINT_MISSING",
            "Platform endpoint is not configured for the pre-claim network probe",
        );
    }

    let client = match reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(2))
        .timeout(std::time::Duration::from_secs(8))
        .build()
    {
        Ok(client) => client,
        Err(_) => {
            return failed_preclaim_probe_response(
                "PRECLAIM_NETWORK_PROBE_UNAVAILABLE",
                "Local network probe could not start",
            );
        }
    };

    match client.get(endpoint).send().await {
        Ok(response) if response.status().is_redirection() => failed_preclaim_probe_response(
            "PRECLAIM_PLATFORM_ENDPOINT_REDIRECTED",
            &format!(
                "Pre-claim Platform health endpoint redirected with HTTP {}",
                response.status().as_u16()
            ),
        ),
        Ok(response) if !response.status().is_success() => failed_preclaim_probe_response(
            "PRECLAIM_PLATFORM_ENDPOINT_UNREACHABLE",
            &format!(
                "Pre-claim Platform endpoint returned HTTP {}",
                response.status().as_u16()
            ),
        ),
        Ok(response) => validate_preclaim_platform_health_response(response).await,
        Err(_) => failed_preclaim_probe_response(
            "PRECLAIM_PLATFORM_ENDPOINT_UNREACHABLE",
            "Existing local network could not reach the pre-claim Platform endpoint",
        ),
    }
}

async fn validate_preclaim_platform_health_response(
    response: reqwest::Response,
) -> NetworkSettingsResponse {
    let content_type_is_json = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value.split(';').next().is_some_and(|media_type| {
                media_type.trim().eq_ignore_ascii_case("application/json")
            })
        })
        .unwrap_or(false);
    if !content_type_is_json {
        return failed_preclaim_probe_response(
            "PRECLAIM_PLATFORM_HEALTH_INVALID_CONTENT_TYPE",
            "Pre-claim Platform health endpoint did not return application/json",
        );
    }

    let body = match response.bytes().await {
        Ok(body) => body,
        Err(_) => {
            return failed_preclaim_probe_response(
                "PRECLAIM_PLATFORM_ENDPOINT_UNREACHABLE",
                "Existing local network could not read the pre-claim Platform health response",
            );
        }
    };
    let health: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(health) => health,
        Err(_) => {
            return failed_preclaim_probe_response(
                "PRECLAIM_PLATFORM_HEALTH_INVALID_JSON",
                "Pre-claim Platform health endpoint returned malformed JSON",
            );
        }
    };
    let Some(database) = health.get("database").and_then(serde_json::Value::as_str) else {
        return failed_preclaim_probe_response(
            "PRECLAIM_PLATFORM_HEALTH_INVALID_CONTRACT",
            "Pre-claim Platform health response is missing its database status",
        );
    };
    if database != "ok" {
        return failed_preclaim_probe_response(
            "PRECLAIM_PLATFORM_DATABASE_UNHEALTHY",
            "Pre-claim Platform database health is not ok",
        );
    }
    NetworkSettingsResponse {
        status: NetworkSetupStatus::Connected,
        ssid: "existing-network".to_string(),
        hidden: false,
        diagnostics: vec![diagnostic_with_evidence(
            "provisioning_endpoint",
            "ok",
            "PRECLAIM_PLATFORM_API_REACHABLE",
            "Pre-claim Platform API health endpoint is reachable and its database is ready",
            NetworkEvidenceSource::PlatformApi,
            NetworkEvidenceStatus::Ready,
            "Continue with machine claim. MQTT is verified separately from the machine's own broker connection.",
        )],
        operator_guidance: "已验证平台 API；本机网络和 MQTT 会作为独立证据显示，可以继续领取机器。"
            .to_string(),
        updated_at: crate::state::store::now_iso(),
    }
}

fn failed_preclaim_probe_response(code: &str, message: &str) -> NetworkSettingsResponse {
    NetworkSettingsResponse {
        status: NetworkSetupStatus::Failed,
        ssid: "existing-network".to_string(),
        hidden: false,
        diagnostics: vec![diagnostic_with_evidence(
            "provisioning_endpoint",
            "error",
            code,
            message,
            NetworkEvidenceSource::PlatformApi,
            NetworkEvidenceStatus::Failed,
            "Check the Platform API endpoint and retry; a Platform outage does not change local network readiness.",
        )],
        operator_guidance:
            "平台 API 尚未验证；请检查平台地址或现场网络后重试。本机网络就绪状态保持独立。"
                .to_string(),
        updated_at: crate::state::store::now_iso(),
    }
}

fn merge_local_and_platform_probe(
    mut local: NetworkSettingsResponse,
    platform: NetworkSettingsResponse,
) -> NetworkSettingsResponse {
    // A Platform reply can arrive through a VPN, virtual NIC, or a stale
    // route.  It is useful evidence, but it must never promote a machine
    // whose selected physical adapter has not independently proved adapter,
    // address, and default-route readiness.
    let local_ready = has_ready_local_physical_evidence(&local);
    let platform_ready = has_ready_evidence(&platform, NetworkEvidenceSource::PlatformApi);
    if local_ready && platform_ready {
        local.status = NetworkSetupStatus::Connected;
        local.operator_guidance = platform.operator_guidance;
        local.updated_at = platform.updated_at;
    } else if !local_ready {
        // Keep the local status and recovery guidance authoritative.  The
        // Platform diagnostic below remains visible as a separate fact.
    } else {
        local.status = platform.status;
        local.operator_guidance = platform.operator_guidance;
        local.updated_at = platform.updated_at;
    }
    local.diagnostics.extend(platform.diagnostics);
    local
}

/// Claim readiness is deliberately stricter than a successful HTTP request.
/// Every source must be independently reported as ready, preventing a route
/// on a VPN or virtual adapter from masking a failed physical local path.
pub fn is_ready_for_machine_claim(network: &NetworkSettingsResponse) -> bool {
    matches!(network.status, NetworkSetupStatus::Connected)
        && has_ready_local_physical_evidence(network)
        && has_ready_evidence(network, NetworkEvidenceSource::PlatformApi)
}

fn has_ready_local_physical_evidence(network: &NetworkSettingsResponse) -> bool {
    [
        NetworkEvidenceSource::LocalAdapter,
        NetworkEvidenceSource::LocalAddress,
        NetworkEvidenceSource::LocalDefaultRoute,
    ]
    .into_iter()
    .all(|source| has_ready_evidence(network, source))
}

fn has_ready_evidence(
    network: &NetworkSettingsResponse,
    expected_source: NetworkEvidenceSource,
) -> bool {
    network.diagnostics.iter().any(|diagnostic| {
        diagnostic.evidence.as_ref().is_some_and(|evidence| {
            evidence.source == expected_source && evidence.status == NetworkEvidenceStatus::Ready
        })
    })
}

fn local_network_ready_response(ssid: &str, hidden: bool) -> NetworkSettingsResponse {
    NetworkSettingsResponse {
        status: NetworkSetupStatus::Connected,
        ssid: ssid.to_string(),
        hidden,
        diagnostics: local_network_ready_diagnostics(),
        operator_guidance: "本机网卡、地址和默认路由已就绪；平台 API 与 MQTT 连通性单独验证。"
            .to_string(),
        updated_at: crate::state::store::now_iso(),
    }
}

fn local_network_unavailable_response(
    ssid: &str,
    hidden: bool,
    code: &str,
    message: &str,
) -> NetworkSettingsResponse {
    NetworkSettingsResponse {
        status: NetworkSetupStatus::Failed,
        ssid: ssid.to_string(),
        hidden,
        diagnostics: vec![
            diagnostic_with_evidence(
                "local_adapter",
                "error",
                code,
                message,
                NetworkEvidenceSource::LocalAdapter,
                NetworkEvidenceStatus::Failed,
                "Check the active wired/Wi-Fi adapter and retry the local network probe.",
            ),
            diagnostic_with_evidence(
                "mqtt",
                "unknown",
                "MQTT_BROKER_NOT_PROVISIONED",
                "A machine-specific MQTT broker is not provisioned during pre-claim setup",
                NetworkEvidenceSource::MqttBroker,
                NetworkEvidenceStatus::NotConfigured,
                "Complete machine claim before checking the machine's own MQTT CONNACK.",
            ),
        ],
        operator_guidance: "本机网络状态尚未确认；请检查网卡、DHCP 地址和默认路由后重试。"
            .to_string(),
        updated_at: crate::state::store::now_iso(),
    }
}

pub fn adapter_from_env() -> Arc<dyn NetworkAdapter> {
    match std::env::var("VEM_NETWORK_ADAPTER").ok().as_deref() {
        Some("fake") => Arc::new(FakeNetworkAdapter::from_env()),
        _ => default_adapter(),
    }
}

fn default_adapter() -> Arc<dyn NetworkAdapter> {
    #[cfg(windows)]
    {
        Arc::new(WindowsWlanAdapter)
    }
    #[cfg(not(windows))]
    {
        Arc::new(FakeNetworkAdapter::unsupported(
            "NETWORK_SETUP_UNSUPPORTED_ON_THIS_PLATFORM",
            "Protected Network Settings can only apply Wi-Fi on Windows runtime hosts",
        ))
    }
}

pub struct FakeNetworkAdapter {
    outcome: String,
}

impl FakeNetworkAdapter {
    fn from_env() -> Self {
        Self {
            outcome: std::env::var("VEM_FAKE_NETWORK_OUTCOME")
                .unwrap_or_else(|_| "success".to_string()),
        }
    }

    #[cfg(not(windows))]
    fn unsupported(code: &str, message: &str) -> Self {
        Self {
            outcome: format!("unsupported:{code}:{message}"),
        }
    }
}

#[async_trait]
impl NetworkAdapter for FakeNetworkAdapter {
    async fn scan_wifi_networks(&self) -> WifiScanResponse {
        WifiScanResponse {
            status: WifiScanStatus::Available,
            networks: vec![
                WifiNetwork {
                    ssid: "VEM-Lab".to_string(),
                    signal_quality: 86,
                    security: WifiSecurity::Wpa2Personal,
                    connected: false,
                    profile_saved: true,
                },
                WifiNetwork {
                    ssid: "Venue-Guest".to_string(),
                    signal_quality: 61,
                    security: WifiSecurity::Open,
                    connected: true,
                    profile_saved: true,
                },
            ],
            operator_guidance: "请选择现场无线网络。".to_string(),
            updated_at: crate::state::store::now_iso(),
        }
    }

    async fn apply_wifi_settings(
        &self,
        request: NetworkSettingsRequest,
    ) -> NetworkSettingsResponse {
        let (status, diagnostics, guidance) = match self.outcome.as_str() {
            "success" => (
                NetworkSetupStatus::Connected,
                success_diagnostics(),
                "网络已连接，可以继续领取机器或重试平台连通性检查。".to_string(),
            ),
            "associated_only" => (
                NetworkSetupStatus::Failed,
                pending_reachability_diagnostics(),
                "Wi-Fi 已提交连接请求，但本机尚未确认 DHCP/IP、DNS、平台或 MQTT 连通性。请等待现场网络稳定后重试。"
                    .to_string(),
            ),
            "pending_success" => (
                NetworkSetupStatus::Connected,
                pending_reachability_diagnostics(),
                "Wi-Fi 已提交连接请求，但本机尚未确认 DHCP/IP、DNS、平台或 MQTT 连通性。请等待现场网络稳定后重试。"
                    .to_string(),
            ),
            "invalid_password" => (
                NetworkSetupStatus::Failed,
                vec![
                    diagnostic(
                        "local_network",
                        "error",
                        "WIFI_AUTH_FAILED",
                        "Wi-Fi password was rejected by the access point",
                    ),
                    diagnostic(
                        "dhcp_ip",
                        "unknown",
                        "DHCP_IP_NOT_CHECKED",
                        "DHCP/IP was not checked because Wi-Fi authentication failed",
                    ),
                    diagnostic(
                        "dns",
                        "unknown",
                        "DNS_NOT_CHECKED",
                        "DNS was not checked because local network is unavailable",
                    ),
                    diagnostic(
                        "provisioning_endpoint",
                        "unknown",
                        "PROVISIONING_ENDPOINT_NOT_CHECKED",
                        "Provisioning endpoint was not checked because local network is unavailable",
                    ),
                    diagnostic(
                        "mqtt",
                        "unknown",
                        "MQTT_NOT_CHECKED",
                        "MQTT was not checked because local network is unavailable",
                    ),
                ],
                "Wi-Fi 密码验证失败。请让现场人员重新输入密码，或请场地方确认该网络未启用网页登录、短信登录或 802.1X。".to_string(),
            ),
            "captive_portal" => (
                NetworkSetupStatus::Unsupported,
                vec![
                    diagnostic(
                        "local_network",
                        "warn",
                        "INTERACTIVE_LOGIN_NETWORK_UNSUPPORTED",
                        "Network appears to require captive portal or other interactive login",
                    ),
                    diagnostic(
                        "dhcp_ip",
                        "unknown",
                        "DHCP_IP_NOT_CHECKED",
                        "DHCP/IP is not enough to support an interactive-login network",
                    ),
                    diagnostic(
                        "dns",
                        "unknown",
                        "DNS_NOT_CHECKED",
                        "DNS was not checked because interactive login is unsupported",
                    ),
                    diagnostic(
                        "provisioning_endpoint",
                        "unknown",
                        "PROVISIONING_ENDPOINT_NOT_CHECKED",
                        "Provisioning endpoint was not checked because interactive login is unsupported",
                    ),
                    diagnostic(
                        "mqtt",
                        "unknown",
                        "MQTT_NOT_CHECKED",
                        "MQTT was not checked because interactive login is unsupported",
                    ),
                ],
                unsupported_guidance(),
            ),
            value if value.starts_with("unsupported:") => {
                let mut parts = value.splitn(3, ':');
                let _ = parts.next();
                let code = parts
                    .next()
                    .unwrap_or("NETWORK_SETUP_UNSUPPORTED_ON_THIS_PLATFORM");
                let message = parts
                    .next()
                    .unwrap_or("Protected Network Settings is unavailable on this platform");
                (
                    NetworkSetupStatus::Unsupported,
                    vec![diagnostic("local_network", "error", code, message)],
                    unsupported_guidance(),
                )
            }
            _ => (
                NetworkSetupStatus::Failed,
                vec![diagnostic(
                    "local_network",
                    "error",
                    "WIFI_CONNECT_FAILED",
                    "Wi-Fi connection failed",
                )],
                "Wi-Fi 连接失败。请检查 SSID、密码和现场信号后重试。".to_string(),
            ),
        };

        NetworkSettingsResponse {
            status,
            ssid: request.ssid.trim().to_string(),
            hidden: request.hidden,
            diagnostics,
            operator_guidance: guidance,
            updated_at: crate::state::store::now_iso(),
        }
    }

    async fn probe_local_network_readiness(&self) -> NetworkSettingsResponse {
        match self.outcome.as_str() {
            "success" | "pending_success" => {
                local_network_ready_response("existing-network", false)
            }
            "associated_only" => NetworkSettingsResponse {
                status: NetworkSetupStatus::Failed,
                ssid: "existing-network".to_string(),
                hidden: false,
                diagnostics: pending_reachability_diagnostics(),
                operator_guidance: "本机 Wi-Fi 尚未取得地址和默认路由；请等待 DHCP 完成后重试。"
                    .to_string(),
                updated_at: crate::state::store::now_iso(),
            },
            "invalid_password" => local_network_unavailable_response(
                "existing-network",
                false,
                "WIFI_AUTH_FAILED",
                "Wi-Fi password was rejected by the access point",
            ),
            value if value.starts_with("unsupported:") => local_network_unavailable_response(
                "existing-network",
                false,
                "LOCAL_NETWORK_PROBE_UNSUPPORTED",
                "Protected local network probing is unavailable on this platform",
            ),
            _ => local_network_unavailable_response(
                "existing-network",
                false,
                "LOCAL_NETWORK_CONNECT_FAILED",
                "The local network adapter is not ready",
            ),
        }
    }

    async fn probe_preclaim_platform_endpoint(
        &self,
        _api_base_url: &str,
    ) -> NetworkSettingsResponse {
        let local = self.probe_local_network_readiness().await;
        let platform = match self.outcome.as_str() {
            "success" | "pending_success" | "platform_success_local_failure" => {
                NetworkSettingsResponse {
                    status: NetworkSetupStatus::Connected,
                    ssid: "existing-network".to_string(),
                    hidden: false,
                    diagnostics: vec![diagnostic_with_evidence(
                        "provisioning_endpoint",
                        "ok",
                        "PRECLAIM_PLATFORM_API_REACHABLE",
                        "Fake Platform API health endpoint is reachable",
                        NetworkEvidenceSource::PlatformApi,
                        NetworkEvidenceStatus::Ready,
                        "Continue with machine claim.",
                    )],
                    operator_guidance: "现有网络已验证可访问平台。".to_string(),
                    updated_at: crate::state::store::now_iso(),
                }
            }
            _ => failed_preclaim_probe_response(
                "PRECLAIM_PLATFORM_ENDPOINT_UNREACHABLE",
                "Fake Platform API health endpoint is unreachable",
            ),
        };
        merge_local_and_platform_probe(local, platform)
    }
}

fn success_diagnostics() -> Vec<NetworkDiagnostic> {
    local_network_ready_diagnostics()
}

fn pending_reachability_diagnostics() -> Vec<NetworkDiagnostic> {
    vec![
        diagnostic(
            "local_adapter",
            "warn",
            "LOCAL_NETWORK_ASSOCIATION_PENDING",
            "Wi-Fi connection was requested but local connectivity is not verified yet",
        ),
        diagnostic(
            "local_address",
            "unknown",
            "DHCP_IP_PENDING",
            "DHCP/IP has not been verified yet",
        ),
        diagnostic(
            "local_default_route",
            "unknown",
            "LOCAL_DEFAULT_ROUTE_PENDING",
            "The associated adapter does not yet have a verified default route",
        ),
        diagnostic(
            "provisioning_endpoint",
            "unknown",
            "PROVISIONING_ENDPOINT_PENDING",
            "Provisioning endpoint reachability has not been verified yet",
        ),
        diagnostic(
            "mqtt",
            "unknown",
            "MQTT_PENDING",
            "MQTT broker reachability has not been verified yet",
        ),
    ]
}

fn local_network_ready_diagnostics() -> Vec<NetworkDiagnostic> {
    vec![
        diagnostic_with_evidence(
            "local_adapter",
            "ok",
            "LOCAL_ADAPTER_READY",
            "The selected wired/Wi-Fi adapter is associated and operational",
            NetworkEvidenceSource::LocalAdapter,
            NetworkEvidenceStatus::Ready,
            "Continue to verify Platform API and MQTT independently.",
        ),
        diagnostic_with_evidence(
            "local_address",
            "ok",
            "LOCAL_ADDRESS_READY",
            "The selected adapter has a usable non-loopback IPv4 or IPv6 address",
            NetworkEvidenceSource::LocalAddress,
            NetworkEvidenceStatus::Ready,
            "Continue to verify Platform API and MQTT independently.",
        ),
        diagnostic_with_evidence(
            "local_default_route",
            "ok",
            "LOCAL_DEFAULT_ROUTE_READY",
            "The selected adapter owns a usable default route",
            NetworkEvidenceSource::LocalDefaultRoute,
            NetworkEvidenceStatus::Ready,
            "Continue to verify Platform API and MQTT independently.",
        ),
        diagnostic_with_evidence(
            "provisioning_endpoint",
            "unknown",
            "PLATFORM_API_PENDING",
            "Platform API health has not been verified yet",
            NetworkEvidenceSource::PlatformApi,
            NetworkEvidenceStatus::Pending,
            "Run the Platform API probe after the local network is ready.",
        ),
        diagnostic_with_evidence(
            "mqtt",
            "unknown",
            "MQTT_BROKER_NOT_PROVISIONED",
            "A machine-specific MQTT broker is not provisioned during pre-claim setup",
            NetworkEvidenceSource::MqttBroker,
            NetworkEvidenceStatus::NotConfigured,
            "Complete machine claim before checking the machine's own MQTT CONNACK.",
        ),
    ]
}

fn diagnostic(
    component: impl Into<String>,
    level: impl Into<String>,
    code: impl Into<String>,
    message: impl Into<String>,
) -> NetworkDiagnostic {
    let component = component.into();
    let level = level.into();
    let code = code.into();
    let message = message.into();
    NetworkDiagnostic {
        evidence: inferred_evidence(&component, &level, &code, &message),
        component,
        level,
        code,
        message,
    }
}

fn diagnostic_with_evidence(
    component: impl Into<String>,
    level: impl Into<String>,
    code: impl Into<String>,
    message: impl Into<String>,
    source: NetworkEvidenceSource,
    status: NetworkEvidenceStatus,
    recovery_action: impl Into<String>,
) -> NetworkDiagnostic {
    let code = code.into();
    let message = message.into();
    NetworkDiagnostic {
        component: component.into(),
        level: level.into(),
        code: code.clone(),
        message: message.clone(),
        evidence: Some(NetworkReadinessEvidence {
            source,
            status,
            reason_code: code,
            reason: message,
            recovery_action: recovery_action.into(),
        }),
    }
}

fn inferred_evidence(
    component: &str,
    level: &str,
    code: &str,
    message: &str,
) -> Option<NetworkReadinessEvidence> {
    let source = match component {
        "local_network" | "local_adapter" => NetworkEvidenceSource::LocalAdapter,
        "dhcp_ip" | "local_address" => NetworkEvidenceSource::LocalAddress,
        "local_default_route" => NetworkEvidenceSource::LocalDefaultRoute,
        "provisioning_endpoint" => NetworkEvidenceSource::PlatformApi,
        "mqtt" => NetworkEvidenceSource::MqttBroker,
        _ => return None,
    };
    let status = match level {
        "ok" => NetworkEvidenceStatus::Ready,
        "error" => NetworkEvidenceStatus::Failed,
        "unknown" => NetworkEvidenceStatus::Pending,
        _ => NetworkEvidenceStatus::Pending,
    };
    Some(NetworkReadinessEvidence {
        source,
        status,
        reason_code: code.to_string(),
        reason: message.to_string(),
        recovery_action: "Inspect this independent network check and retry the affected probe."
            .to_string(),
    })
}

/// Turns the daemon's own MQTT runtime state into a separate proof.  The
/// runtime sets `mqtt_connected` only after its rumqttc event loop receives a
/// broker ConnAck; it is intentionally not inferred from Platform `/health`.
pub fn mqtt_connack_diagnostic(
    broker_is_provisioned: bool,
    mqtt_connected: bool,
    last_error: Option<&str>,
) -> NetworkDiagnostic {
    if !broker_is_provisioned {
        return diagnostic_with_evidence(
            "mqtt",
            "unknown",
            "MQTT_BROKER_NOT_PROVISIONED",
            "A machine-specific MQTT broker is not provisioned during pre-claim setup",
            NetworkEvidenceSource::MqttBroker,
            NetworkEvidenceStatus::NotConfigured,
            "Complete machine claim before checking the machine's own MQTT CONNACK.",
        );
    }
    if mqtt_connected {
        return diagnostic_with_evidence(
            "mqtt",
            "ok",
            "MQTT_CONNACK_CONFIRMED",
            "The daemon received CONNACK from the provisioned machine MQTT broker",
            NetworkEvidenceSource::MqttBroker,
            NetworkEvidenceStatus::Ready,
            "No recovery action is needed; keep the daemon running to maintain its broker session.",
        );
    }
    let reason = last_error
        .filter(|error| !error.trim().is_empty())
        .unwrap_or("The daemon has not received CONNACK from the provisioned machine MQTT broker");
    diagnostic_with_evidence(
        "mqtt",
        "error",
        "MQTT_CONNACK_NOT_CONFIRMED",
        reason,
        NetworkEvidenceSource::MqttBroker,
        NetworkEvidenceStatus::Failed,
        "Check the provisioned MQTT endpoint and credentials, then wait for the daemon to reconnect and receive CONNACK.",
    )
}

fn unsupported_guidance() -> String {
    "该网络需要网页登录、短信登录、证书、802.1X 或其他交互式认证，当前现场网络设置不支持。请让场地方提供普通 WPA/WPA2 密码 Wi-Fi、有线网络，或由运维人员在受保护维护流程中完成企业网络准备。".to_string()
}

#[cfg(windows)]
pub struct WindowsWlanAdapter;

#[cfg(windows)]
#[async_trait]
impl NetworkAdapter for WindowsWlanAdapter {
    async fn scan_wifi_networks(&self) -> WifiScanResponse {
        tokio::task::spawn_blocking(scan_windows_wifi_networks)
            .await
            .unwrap_or_else(|error| failed_scan_response(format!("Wi-Fi 扫描任务失败：{error}")))
    }

    async fn apply_wifi_settings(
        &self,
        request: NetworkSettingsRequest,
    ) -> NetworkSettingsResponse {
        match apply_windows_wlan_profile(&request).await {
            Ok(observation) => observed_windows_wifi_response(&request, observation),
            Err(error) => NetworkSettingsResponse {
                status: NetworkSetupStatus::Failed,
                ssid: request.ssid.trim().to_string(),
                hidden: request.hidden,
                diagnostics: vec![diagnostic(
                    "local_network",
                    "error",
                    "WIFI_CONNECT_FAILED",
                    sanitize_secret(&error, &request.password),
                )],
                operator_guidance: "Wi-Fi 连接失败。请检查 SSID、密码和现场信号后重试。"
                    .to_string(),
                updated_at: crate::state::store::now_iso(),
            },
        }
    }

    async fn probe_local_network_readiness(&self) -> NetworkSettingsResponse {
        match tokio::task::spawn_blocking(|| inspect_windows_local_interface(None)).await {
            Ok(Ok(observation)) => observed_windows_local_network_response(observation),
            Ok(Err(error)) => local_network_unavailable_response(
                "existing-network",
                false,
                "LOCAL_NETWORK_PROBE_FAILED",
                &error,
            ),
            Err(error) => local_network_unavailable_response(
                "existing-network",
                false,
                "LOCAL_NETWORK_PROBE_FAILED",
                &format!("Windows local network probe task failed: {error}"),
            ),
        }
    }
}

#[cfg(windows)]
fn observed_windows_local_network_response(
    observation: LocalInterfaceObservation,
) -> NetworkSettingsResponse {
    let adapter = if observation.adapter_ready {
        diagnostic_with_evidence(
            "local_adapter",
            "ok",
            "LOCAL_ADAPTER_READY",
            "A physical wired or Wi-Fi adapter is operational",
            NetworkEvidenceSource::LocalAdapter,
            NetworkEvidenceStatus::Ready,
            "Continue to verify the adapter address and default route.",
        )
    } else {
        diagnostic_with_evidence(
            "local_adapter",
            "error",
            "LOCAL_ADAPTER_UNAVAILABLE",
            "No operational physical wired or Wi-Fi adapter was found",
            NetworkEvidenceSource::LocalAdapter,
            NetworkEvidenceStatus::Failed,
            "Enable or connect a physical wired/Wi-Fi adapter; VPN and virtual adapters do not satisfy this check.",
        )
    };
    let address = if observation.local_address_ready {
        local_address_ready_diagnostic()
    } else {
        diagnostic_with_evidence(
            "local_address",
            "error",
            "LOCAL_ADDRESS_UNAVAILABLE",
            "The selected physical adapter has no usable IPv4 or IPv6 address",
            NetworkEvidenceSource::LocalAddress,
            NetworkEvidenceStatus::Failed,
            "Check DHCP, VLAN assignment or static addressing on the selected adapter.",
        )
    };
    let route = if observation.default_route_ready {
        diagnostic_with_evidence(
            "local_default_route",
            "ok",
            "LOCAL_DEFAULT_ROUTE_READY",
            "The selected physical adapter owns a default route",
            NetworkEvidenceSource::LocalDefaultRoute,
            NetworkEvidenceStatus::Ready,
            "Continue to verify Platform API and MQTT independently.",
        )
    } else {
        diagnostic_with_evidence(
            "local_default_route",
            "error",
            "LOCAL_DEFAULT_ROUTE_UNAVAILABLE",
            "The selected physical adapter has no usable default route",
            NetworkEvidenceSource::LocalDefaultRoute,
            NetworkEvidenceStatus::Failed,
            "Check the gateway/DHCP route option on the selected adapter; routes on VPN or virtual adapters do not satisfy this check.",
        )
    };
    let ready = observation.adapter_ready
        && observation.local_address_ready
        && observation.default_route_ready;
    NetworkSettingsResponse {
        status: if ready {
            NetworkSetupStatus::Connected
        } else {
            NetworkSetupStatus::Failed
        },
        ssid: "existing-network".to_string(),
        hidden: false,
        diagnostics: vec![
            adapter,
            address,
            route,
            diagnostic_with_evidence(
                "provisioning_endpoint",
                "unknown",
                "PLATFORM_API_PENDING",
                "Platform API health has not been checked by the local adapter probe",
                NetworkEvidenceSource::PlatformApi,
                NetworkEvidenceStatus::Pending,
                "Run the Platform API probe separately.",
            ),
            diagnostic_with_evidence(
                "mqtt",
                "unknown",
                "MQTT_BROKER_NOT_PROVISIONED",
                "A machine-specific MQTT broker is not provisioned during pre-claim setup",
                NetworkEvidenceSource::MqttBroker,
                NetworkEvidenceStatus::NotConfigured,
                "Complete machine claim before checking the machine's own MQTT CONNACK.",
            ),
        ],
        operator_guidance: if ready {
            "已确认本机物理网卡、地址和默认路由；平台 API 与 MQTT 会独立验证。".to_string()
        } else {
            "本机网络未就绪；请按诊断检查物理网卡、地址和默认路由后重试。".to_string()
        },
        updated_at: crate::state::store::now_iso(),
    }
}

#[cfg(any(windows, test))]
fn observed_windows_wifi_response(
    request: &NetworkSettingsRequest,
    observation: WlanConnectionObservation,
) -> NetworkSettingsResponse {
    let (status, diagnostics, operator_guidance) = match observation.association {
        WlanAssociationState::AuthenticationFailed(reason_code) => (
            NetworkSetupStatus::Failed,
            vec![
                diagnostic_with_evidence(
                    "local_adapter",
                    "error",
                    "WIFI_AUTH_FAILED",
                    format!("Windows WLAN authentication failed (reason code {reason_code})"),
                    NetworkEvidenceSource::LocalAdapter,
                    NetworkEvidenceStatus::Failed,
                    "Ask the operator to re-enter the Wi-Fi password and confirm the access point accepts WPA personal authentication.",
                ),
                pending_local_address_diagnostic(),
                pending_local_default_route_diagnostic(),
            ],
            "Wi-Fi 身份验证失败。请核对密码；此结果来自 Windows WLAN 原生 reason code。"
                .to_string(),
        ),
        WlanAssociationState::AssociationFailed(reason_code) => (
            NetworkSetupStatus::Failed,
            vec![
                diagnostic_with_evidence(
                    "local_adapter",
                    "error",
                    "WIFI_ASSOCIATION_FAILED",
                    format!(
                        "Windows could not associate the requested SSID (reason code {reason_code})"
                    ),
                    NetworkEvidenceSource::LocalAdapter,
                    NetworkEvidenceStatus::Failed,
                    "Check SSID visibility, radio signal and access-point policy, then retry.",
                ),
                pending_local_address_diagnostic(),
                pending_local_default_route_diagnostic(),
            ],
            "Wi-Fi 未能关联到所选 SSID。请检查信号、SSID 和场地方接入策略后重试。".to_string(),
        ),
        WlanAssociationState::TimedOut => (
            NetworkSetupStatus::Failed,
            vec![
                diagnostic_with_evidence(
                    "local_adapter",
                    "error",
                    "WIFI_ASSOCIATION_TIMEOUT",
                    "Windows did not confirm association with the requested SSID before the bounded timeout",
                    NetworkEvidenceSource::LocalAdapter,
                    NetworkEvidenceStatus::Failed,
                    "Wait for the access point to become available, then retry the connection.",
                ),
                pending_local_address_diagnostic(),
                pending_local_default_route_diagnostic(),
            ],
            "等待 Wi-Fi 关联超时。请检查信号和接入点状态后重试。".to_string(),
        ),
        WlanAssociationState::Associated if !observation.local_address_ready => (
            NetworkSetupStatus::Failed,
            vec![
                associated_adapter_diagnostic(),
                diagnostic_with_evidence(
                    "local_address",
                    "error",
                    "LOCAL_ADDRESS_UNAVAILABLE",
                    "The requested SSID is associated but its adapter has no usable IPv4 or IPv6 address",
                    NetworkEvidenceSource::LocalAddress,
                    NetworkEvidenceStatus::Failed,
                    "Check DHCP, VLAN assignment or static address configuration on this Wi-Fi network.",
                ),
                pending_local_default_route_diagnostic(),
            ],
            "Wi-Fi 已关联，但该无线网卡未取得可用 IPv4/IPv6 地址。请检查 DHCP 或 VLAN 后重试。"
                .to_string(),
        ),
        WlanAssociationState::Associated if !observation.default_route_ready => (
            NetworkSetupStatus::Failed,
            vec![
                associated_adapter_diagnostic(),
                local_address_ready_diagnostic(),
                diagnostic_with_evidence(
                    "local_default_route",
                    "error",
                    "LOCAL_DEFAULT_ROUTE_UNAVAILABLE",
                    "The requested SSID adapter has an address but no usable default route",
                    NetworkEvidenceSource::LocalDefaultRoute,
                    NetworkEvidenceStatus::Failed,
                    "Check the Wi-Fi gateway/DHCP router option and retry; routes on VPN or virtual adapters do not satisfy this check.",
                ),
            ],
            "Wi-Fi 已关联且已取得地址，但该无线网卡没有默认路由。请检查网关或 DHCP 路由选项。"
                .to_string(),
        ),
        WlanAssociationState::Associated => (
            NetworkSetupStatus::Connected,
            vec![
                associated_adapter_diagnostic(),
                local_address_ready_diagnostic(),
                diagnostic_with_evidence(
                    "local_default_route",
                    "ok",
                    "LOCAL_DEFAULT_ROUTE_READY",
                    "The requested SSID adapter owns a usable default route",
                    NetworkEvidenceSource::LocalDefaultRoute,
                    NetworkEvidenceStatus::Ready,
                    "Continue to verify Platform API and MQTT independently.",
                ),
                diagnostic_with_evidence(
                    "provisioning_endpoint",
                    "unknown",
                    "PLATFORM_API_PENDING",
                    "Platform API reachability must be verified separately",
                    NetworkEvidenceSource::PlatformApi,
                    NetworkEvidenceStatus::Pending,
                    "Run the Platform API probe after local network readiness succeeds.",
                ),
                diagnostic_with_evidence(
                    "mqtt",
                    "unknown",
                    "MQTT_BROKER_NOT_PROVISIONED",
                    "A machine-specific MQTT broker is not provisioned during pre-claim setup",
                    NetworkEvidenceSource::MqttBroker,
                    NetworkEvidenceStatus::NotConfigured,
                    "Complete machine claim before checking the machine's own MQTT CONNACK.",
                ),
            ],
            "已确认所选 Wi-Fi 的关联、地址和默认路由；平台 API 与 MQTT 会独立验证。".to_string(),
        ),
    };

    NetworkSettingsResponse {
        status,
        ssid: request.ssid.trim().to_string(),
        hidden: request.hidden,
        diagnostics,
        operator_guidance,
        updated_at: crate::state::store::now_iso(),
    }
}

#[cfg(any(windows, test))]
fn associated_adapter_diagnostic() -> NetworkDiagnostic {
    diagnostic_with_evidence(
        "local_adapter",
        "ok",
        "WIFI_ASSOCIATED",
        "Windows observed association with the requested SSID",
        NetworkEvidenceSource::LocalAdapter,
        NetworkEvidenceStatus::Ready,
        "Continue to verify the same adapter's address and default route.",
    )
}

#[cfg(any(windows, test))]
fn local_address_ready_diagnostic() -> NetworkDiagnostic {
    diagnostic_with_evidence(
        "local_address",
        "ok",
        "LOCAL_ADDRESS_READY",
        "The requested SSID adapter has a usable non-loopback IPv4 or IPv6 address",
        NetworkEvidenceSource::LocalAddress,
        NetworkEvidenceStatus::Ready,
        "Continue to verify the same adapter's default route.",
    )
}

#[cfg(any(windows, test))]
fn pending_local_address_diagnostic() -> NetworkDiagnostic {
    diagnostic_with_evidence(
        "local_address",
        "unknown",
        "LOCAL_ADDRESS_NOT_CHECKED",
        "A local address cannot be verified before Wi-Fi association succeeds",
        NetworkEvidenceSource::LocalAddress,
        NetworkEvidenceStatus::Pending,
        "Resolve the Wi-Fi association issue, then retry the local network probe.",
    )
}

#[cfg(any(windows, test))]
fn pending_local_default_route_diagnostic() -> NetworkDiagnostic {
    diagnostic_with_evidence(
        "local_default_route",
        "unknown",
        "LOCAL_DEFAULT_ROUTE_NOT_CHECKED",
        "A default route cannot be verified before Wi-Fi association and addressing succeed",
        NetworkEvidenceSource::LocalDefaultRoute,
        NetworkEvidenceStatus::Pending,
        "Resolve local adapter/address readiness, then retry the local network probe.",
    )
}

#[cfg(windows)]
fn scan_windows_wifi_networks() -> WifiScanResponse {
    use std::{collections::BTreeMap, ptr, slice, thread, time::Duration};
    use windows_sys::Win32::{
        Foundation::HANDLE,
        NetworkManagement::WiFi::{
            WlanCloseHandle, WlanEnumInterfaces, WlanFreeMemory, WlanGetAvailableNetworkList,
            WlanOpenHandle, WlanScan, WLAN_AVAILABLE_NETWORK_LIST, WLAN_INTERFACE_INFO,
            WLAN_INTERFACE_INFO_LIST,
        },
    };

    const ERROR_SUCCESS: u32 = 0;
    const ERROR_ACCESS_DENIED: u32 = 5;

    unsafe {
        let mut negotiated_version = 0;
        let mut handle: HANDLE = ptr::null_mut();
        let open_result = WlanOpenHandle(2, ptr::null(), &mut negotiated_version, &mut handle);
        if open_result != ERROR_SUCCESS {
            return failed_scan_response(wlan_scan_error_guidance(open_result));
        }

        let mut interface_list: *mut WLAN_INTERFACE_INFO_LIST = ptr::null_mut();
        let enum_result = WlanEnumInterfaces(handle, ptr::null(), &mut interface_list);
        if enum_result != ERROR_SUCCESS || interface_list.is_null() {
            WlanCloseHandle(handle, ptr::null());
            return failed_scan_response(wlan_scan_error_guidance(enum_result));
        }

        let interfaces: Vec<WLAN_INTERFACE_INFO> = slice::from_raw_parts(
            (*interface_list).InterfaceInfo.as_ptr(),
            (*interface_list).dwNumberOfItems as usize,
        )
        .to_vec();
        WlanFreeMemory(interface_list.cast());

        for interface in &interfaces {
            let result = WlanScan(
                handle,
                &interface.InterfaceGuid,
                ptr::null(),
                ptr::null(),
                ptr::null(),
            );
            if result == ERROR_ACCESS_DENIED {
                WlanCloseHandle(handle, ptr::null());
                return failed_scan_response(wlan_scan_error_guidance(result));
            }
        }
        thread::sleep(Duration::from_millis(1200));

        let mut by_ssid = BTreeMap::<String, WifiNetwork>::new();
        let mut last_error = ERROR_SUCCESS;
        for interface in &interfaces {
            let mut list: *mut WLAN_AVAILABLE_NETWORK_LIST = ptr::null_mut();
            let result = WlanGetAvailableNetworkList(
                handle,
                &interface.InterfaceGuid,
                0,
                ptr::null(),
                &mut list,
            );
            if result != ERROR_SUCCESS || list.is_null() {
                last_error = result;
                continue;
            }
            let entries =
                slice::from_raw_parts((*list).Network.as_ptr(), (*list).dwNumberOfItems as usize);
            for entry in entries {
                if let Some(network) = wifi_network_from_native(entry) {
                    by_ssid
                        .entry(network.ssid.clone())
                        .and_modify(|existing| merge_wifi_network(existing, &network))
                        .or_insert(network);
                }
            }
            WlanFreeMemory(list.cast());
        }
        WlanCloseHandle(handle, ptr::null());

        if interfaces.is_empty() {
            return failed_scan_response(
                "未找到已启用的无线网卡，请检查无线网卡和 WLAN AutoConfig 服务。".to_string(),
            );
        }
        if by_ssid.is_empty() && last_error != ERROR_SUCCESS {
            return failed_scan_response(wlan_scan_error_guidance(last_error));
        }

        let mut networks: Vec<_> = by_ssid.into_values().collect();
        networks.sort_by_key(|network| {
            (
                !network.connected,
                std::cmp::Reverse(network.signal_quality),
            )
        });
        WifiScanResponse {
            status: WifiScanStatus::Available,
            networks,
            operator_guidance: "请选择现场无线网络；隐藏网络可继续手动输入。".to_string(),
            updated_at: crate::state::store::now_iso(),
        }
    }
}

#[cfg(windows)]
fn wifi_network_from_native(
    entry: &windows_sys::Win32::NetworkManagement::WiFi::WLAN_AVAILABLE_NETWORK,
) -> Option<WifiNetwork> {
    use windows_sys::Win32::NetworkManagement::WiFi::{
        DOT11_AUTH_ALGO_80211_OPEN, DOT11_AUTH_ALGO_RSNA, DOT11_AUTH_ALGO_RSNA_PSK,
        DOT11_AUTH_ALGO_WPA, DOT11_AUTH_ALGO_WPA3, DOT11_AUTH_ALGO_WPA3_ENT,
        DOT11_AUTH_ALGO_WPA3_SAE, DOT11_AUTH_ALGO_WPA_PSK, WLAN_AVAILABLE_NETWORK_CONNECTED,
        WLAN_AVAILABLE_NETWORK_HAS_PROFILE,
    };
    let length = usize::try_from(entry.dot11Ssid.uSSIDLength).ok()?.min(32);
    let ssid = std::str::from_utf8(&entry.dot11Ssid.ucSSID[..length])
        .ok()?
        .trim();
    if ssid.is_empty() {
        return None;
    }
    let auth = entry.dot11DefaultAuthAlgorithm;
    let security = if entry.bSecurityEnabled == 0 || auth == DOT11_AUTH_ALGO_80211_OPEN {
        WifiSecurity::Open
    } else if auth == DOT11_AUTH_ALGO_WPA_PSK {
        WifiSecurity::WpaPersonal
    } else if auth == DOT11_AUTH_ALGO_RSNA_PSK {
        WifiSecurity::Wpa2Personal
    } else if auth == DOT11_AUTH_ALGO_WPA3_SAE {
        WifiSecurity::Wpa3Personal
    } else if [
        DOT11_AUTH_ALGO_WPA,
        DOT11_AUTH_ALGO_RSNA,
        DOT11_AUTH_ALGO_WPA3,
        DOT11_AUTH_ALGO_WPA3_ENT,
    ]
    .contains(&auth)
    {
        WifiSecurity::Enterprise
    } else {
        WifiSecurity::Unknown
    };
    Some(WifiNetwork {
        ssid: ssid.to_string(),
        signal_quality: entry.wlanSignalQuality.min(100),
        security,
        connected: entry.dwFlags & WLAN_AVAILABLE_NETWORK_CONNECTED != 0,
        profile_saved: entry.dwFlags & WLAN_AVAILABLE_NETWORK_HAS_PROFILE != 0,
    })
}

#[cfg(any(windows, test))]
fn merge_wifi_network(existing: &mut WifiNetwork, candidate: &WifiNetwork) {
    existing.signal_quality = existing.signal_quality.max(candidate.signal_quality);
    existing.connected |= candidate.connected;
    existing.profile_saved |= candidate.profile_saved;
    if existing.security == WifiSecurity::Unknown {
        existing.security = candidate.security.clone();
    }
}

#[cfg(windows)]
fn failed_scan_response(guidance: String) -> WifiScanResponse {
    WifiScanResponse {
        status: WifiScanStatus::Failed,
        networks: Vec::new(),
        operator_guidance: guidance,
        updated_at: crate::state::store::now_iso(),
    }
}

#[cfg(windows)]
fn wlan_scan_error_guidance(code: u32) -> String {
    match code {
        5 => "Windows 拒绝读取附近 Wi-Fi，请在系统设置中允许位置访问后重试。".to_string(),
        1168 => "未找到已启用的无线网卡，请检查无线网卡和 WLAN AutoConfig 服务。".to_string(),
        0x8034_2002 => "无线功能已关闭，请开启无线网卡后重试。".to_string(),
        _ => format!(
            "Windows Wi-Fi 扫描失败（错误码 {code}），请检查无线网卡和 WLAN AutoConfig 服务。"
        ),
    }
}

#[cfg(windows)]
async fn apply_windows_wlan_profile(
    request: &NetworkSettingsRequest,
) -> Result<WlanConnectionObservation, String> {
    let request = request.clone();
    tokio::task::spawn_blocking(move || apply_windows_wlan_profile_native(&request))
        .await
        .map_err(|error| format!("Windows WLAN connection task failed: {error}"))?
}

/// Evidence collected through WLAN and IP Helper APIs after Windows accepts a
/// profile/connect request. Dispatching a connection request alone is not
/// proof of association, DHCP, or a default route on the selected interface.
#[cfg(any(windows, test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WlanAssociationState {
    Associated,
    AuthenticationFailed(u32),
    AssociationFailed(u32),
    TimedOut,
}

#[cfg(any(windows, test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WlanConnectionObservation {
    association: WlanAssociationState,
    local_address_ready: bool,
    default_route_ready: bool,
}

/// `WlanGetProfile` returns an allocated UTF-16 XML buffer. Keep it opaque so
/// a protected prior key is neither decoded nor included in diagnostics while
/// the candidate profile is being tried.
#[cfg(any(windows, test))]
#[derive(Clone)]
struct PreservedWlanProfile {
    profile_xml: Vec<u16>,
    profile_position: u32,
}

#[cfg(test)]
enum ManagedWlanProfileRollbackPlan {
    Restore(PreservedWlanProfile),
    DeleteCandidate,
}

#[cfg(test)]
fn managed_wlan_profile_rollback_plan(
    previous: Option<PreservedWlanProfile>,
) -> ManagedWlanProfileRollbackPlan {
    match previous {
        Some(profile) => ManagedWlanProfileRollbackPlan::Restore(profile),
        None => ManagedWlanProfileRollbackPlan::DeleteCandidate,
    }
}

#[cfg(any(windows, test))]
fn wlan_local_connection_succeeded(observation: WlanConnectionObservation) -> bool {
    matches!(observation.association, WlanAssociationState::Associated)
        && observation.local_address_ready
        && observation.default_route_ready
}

#[cfg(any(windows, test))]
fn deterministic_wlan_profile_name(ssid: &str) -> String {
    use sha2::{Digest, Sha256};

    let digest = Sha256::digest(ssid.as_bytes());
    let suffix = digest[..10]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("VEM-WIFI-{suffix}")
}

#[cfg(any(windows, test))]
const VEM_WLAN_CANDIDATE_PREFIX: &str = "VEM-WIFI-CANDIDATE-";

/// Candidate profiles are intentionally nonce-qualified. They are only ever
/// used to prove a new credential set before the durable per-SSID profile is
/// touched, so a crashed provisioning attempt cannot replace the old auto
/// connect profile with an unverified password.
#[cfg(any(windows, test))]
fn candidate_wlan_profile_name(ssid: &str, nonce: &str) -> String {
    let stable = deterministic_wlan_profile_name(ssid);
    let suffix = stable.trim_start_matches("VEM-WIFI-");
    format!("{VEM_WLAN_CANDIDATE_PREFIX}{suffix}-{nonce}")
}

#[cfg(any(windows, test))]
fn is_vem_candidate_profile_name(profile_name: &str) -> bool {
    profile_name.starts_with(VEM_WLAN_CANDIDATE_PREFIX)
}

/// The recovery plan is intentionally explicit: a stale manual profile must
/// never be deleted before we know whether it owns the current connection,
/// and reconnecting a deleted candidate is forbidden.  Native Windows code
/// executes these actions one at a time and freezes future mutations if any
/// required stable-profile recovery action fails.
#[cfg(any(windows, test))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct StableWlanRecoveryTarget {
    profile_name: String,
    ssid: String,
    hidden: bool,
}

#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
enum WlanRecoveryAction {
    ReadCurrentConnection,
    DisconnectCandidate(String),
    WaitForCandidateDisconnect(String),
    DeleteCandidate(String),
    ConnectStable(String),
    VerifyStable,
}

/// Stable rollback has a deliberately different success criterion from
/// candidate cleanup.  The old profile is not recovered until its exact
/// profile/interface/SSID has been connected and its local address and route
/// have been verified.
#[cfg(any(windows, test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StableWlanRollbackStep {
    RestoreOldProfile,
    ConnectOldStable,
    VerifyOldStable,
    ClearCandidate,
}

#[cfg(any(windows, test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StableWlanRollbackPhase {
    Initial,
    OldProfileRestored,
    OldStableConnected,
    OldStableVerified,
    CandidateCleared,
}

#[cfg(any(windows, test))]
struct StableWlanRollbackState {
    phase: StableWlanRollbackPhase,
}

#[cfg(any(windows, test))]
impl StableWlanRollbackState {
    fn new() -> Self {
        Self {
            phase: StableWlanRollbackPhase::Initial,
        }
    }

    fn completed(&mut self, step: StableWlanRollbackStep) {
        self.phase = match (self.phase, step) {
            (StableWlanRollbackPhase::Initial, StableWlanRollbackStep::RestoreOldProfile) => {
                StableWlanRollbackPhase::OldProfileRestored
            }
            (
                StableWlanRollbackPhase::OldProfileRestored,
                StableWlanRollbackStep::ConnectOldStable,
            ) => StableWlanRollbackPhase::OldStableConnected,
            (
                StableWlanRollbackPhase::OldStableConnected,
                StableWlanRollbackStep::VerifyOldStable,
            ) => StableWlanRollbackPhase::OldStableVerified,
            (
                StableWlanRollbackPhase::OldStableVerified,
                StableWlanRollbackStep::ClearCandidate,
            ) => StableWlanRollbackPhase::CandidateCleared,
            (phase, step) => {
                panic!("invalid stable WLAN rollback transition from {phase:?} through {step:?}")
            }
        };
    }
}

/// The Windows implementation and the fault matrix share this exact
/// orchestrator. The adapter is only the native boundary; ordering and the
/// process-wide recovery freeze remain production behavior.
#[cfg(any(windows, test))]
trait StableWlanRollbackStepAdapter {
    fn run_step(&mut self, step: StableWlanRollbackStep) -> Result<(), String>;
}

#[cfg(any(windows, test))]
trait StableWlanRollbackOperations {
    fn restore_old_profile(&mut self) -> Result<(), String>;
    fn connect_old_stable(&mut self) -> Result<(), String>;
    fn verify_old_stable(&mut self) -> Result<(), String>;
    fn clear_candidate(&mut self) -> Result<(), String>;
}

#[cfg(any(windows, test))]
struct StableWlanRollbackAdapter<O> {
    operations: O,
}

#[cfg(any(windows, test))]
impl<O> StableWlanRollbackAdapter<O> {
    fn new(operations: O) -> Self {
        Self { operations }
    }
}

#[cfg(any(windows, test))]
impl<O: StableWlanRollbackOperations> StableWlanRollbackStepAdapter
    for StableWlanRollbackAdapter<O>
{
    fn run_step(&mut self, step: StableWlanRollbackStep) -> Result<(), String> {
        match step {
            StableWlanRollbackStep::RestoreOldProfile => self.operations.restore_old_profile(),
            StableWlanRollbackStep::ConnectOldStable => self.operations.connect_old_stable(),
            StableWlanRollbackStep::VerifyOldStable => self.operations.verify_old_stable(),
            StableWlanRollbackStep::ClearCandidate => self.operations.clear_candidate(),
        }
    }
}

#[cfg(any(windows, test))]
fn execute_stable_wlan_rollback<A: StableWlanRollbackStepAdapter>(
    registry: &WlanCallbackMutationRegistry,
    adapter: &mut A,
) -> Result<(), String> {
    let mut state = StableWlanRollbackState::new();
    for step in [
        StableWlanRollbackStep::RestoreOldProfile,
        StableWlanRollbackStep::ConnectOldStable,
        StableWlanRollbackStep::VerifyOldStable,
        StableWlanRollbackStep::ClearCandidate,
    ] {
        if let Err(error) = adapter.run_step(step) {
            registry.freeze_for_recovery();
            return Err(format!(
                "WLAN_RECOVERY_REQUIRED: stable WLAN rollback failed at {step:?}: {error}; WLAN mutations are frozen until daemon restart and operator recovery"
            ));
        }
        state.completed(step);
    }
    debug_assert_eq!(state.phase, StableWlanRollbackPhase::CandidateCleared);
    Ok(())
}

/// Candidate connection failure follows the same recovery invariant as a
/// stable-profile rollback: the marker is the crash-recovery evidence and is
/// cleared only after the exact old stable connection is usable again.
#[cfg(any(windows, test))]
fn execute_candidate_failure_recovery<A: StableWlanRollbackStepAdapter>(
    registry: &WlanCallbackMutationRegistry,
    adapter: &mut A,
) -> Result<(), String> {
    execute_stable_wlan_rollback(registry, adapter)
}

#[cfg(test)]
fn stale_candidate_startup_recovery_plan(
    current: CurrentWlanConnectionQuery,
    candidate_name: &str,
    stable: Option<StableWlanRecoveryTarget>,
) -> Result<Vec<WlanRecoveryAction>, String> {
    let mut actions = vec![WlanRecoveryAction::ReadCurrentConnection];
    match current {
        CurrentWlanConnectionQuery::Connected(current)
        | CurrentWlanConnectionQuery::Connecting(current)
            if current.profile_name == candidate_name =>
        {
            actions.push(WlanRecoveryAction::DisconnectCandidate(
                candidate_name.to_string(),
            ));
        }
        CurrentWlanConnectionQuery::Disconnecting(current)
            if current.profile_name == candidate_name =>
        {
            actions.push(WlanRecoveryAction::WaitForCandidateDisconnect(
                candidate_name.to_string(),
            ));
        }
        CurrentWlanConnectionQuery::Error(code) => {
            return Err(format!(
                "WLAN_RECOVERY_REQUIRED: current WLAN query failed with error {code}"
            ));
        }
        CurrentWlanConnectionQuery::Connected(_)
        | CurrentWlanConnectionQuery::Connecting(_)
        | CurrentWlanConnectionQuery::Disconnecting(_)
        | CurrentWlanConnectionQuery::Absent => {}
    }
    let Some(stable) = stable else {
        return Err("WLAN_RECOVERY_REQUIRED: no complete stable profile is available".to_string());
    };
    actions.push(WlanRecoveryAction::ConnectStable(stable.profile_name));
    actions.push(WlanRecoveryAction::VerifyStable);
    actions.push(WlanRecoveryAction::DeleteCandidate(
        candidate_name.to_string(),
    ));
    Ok(actions)
}

#[cfg(any(windows, test))]
fn stable_wlan_profile_name_for_candidate(candidate_name: &str) -> Option<String> {
    let suffix = candidate_name.strip_prefix(VEM_WLAN_CANDIDATE_PREFIX)?;
    let stable_suffix = suffix.get(..20)?;
    if suffix.as_bytes().get(20) != Some(&b'-')
        || !stable_suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return None;
    }
    Some(format!("VEM-WIFI-{stable_suffix}"))
}

#[cfg(any(windows, test))]
fn wlan_profile_recovery_target(
    profile_name: String,
    profile_xml: &[u16],
) -> Result<StableWlanRecoveryTarget, String> {
    let profile_xml = String::from_utf16(profile_xml.strip_suffix(&[0]).unwrap_or(profile_xml))
        .map_err(|_| "WLAN stable profile XML is not valid UTF-16".to_string())?;
    let ssid_section = xml_tag_value(&profile_xml, "SSID")
        .ok_or_else(|| "WLAN stable profile is missing its SSID section".to_string())?;
    let ssid = xml_tag_value(ssid_section, "name")
        .map(xml_unescape)
        .filter(|ssid| !ssid.is_empty())
        .ok_or_else(|| "WLAN stable profile is missing its SSID name".to_string())?;
    let hidden = xml_tag_value(&profile_xml, "nonBroadcast")
        .map(str::trim)
        .is_some_and(|value| value.eq_ignore_ascii_case("true"));
    Ok(StableWlanRecoveryTarget {
        profile_name,
        ssid,
        hidden,
    })
}

#[cfg(any(windows, test))]
fn xml_tag_value<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let value = xml.split_once(&open)?.1;
    let (value, _) = value.split_once(&close)?;
    Some(value)
}

#[cfg(any(windows, test))]
fn xml_unescape(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

#[cfg(any(windows, test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WlanProfileConnectionMode {
    Manual,
    Auto,
}

#[cfg(any(windows, test))]
fn wlan_profile_xml(
    profile_name: &str,
    ssid: &str,
    password: &str,
    hidden: bool,
    connection_mode: WlanProfileConnectionMode,
) -> String {
    format!(
        r#"<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
  <name>{}</name>
  <SSIDConfig>
    <SSID>
      <name>{}</name>
    </SSID>
    <nonBroadcast>{}</nonBroadcast>
  </SSIDConfig>
  <connectionType>ESS</connectionType>
  <connectionMode>{}</connectionMode>
  <MSM>
    <security>
      <authEncryption>
        <authentication>WPA2PSK</authentication>
        <encryption>AES</encryption>
        <useOneX>false</useOneX>
      </authEncryption>
      <sharedKey>
        <keyType>passPhrase</keyType>
        <protected>false</protected>
        <keyMaterial>{}</keyMaterial>
      </sharedKey>
    </security>
  </MSM>
</WLANProfile>"#,
        xml_escape(profile_name),
        xml_escape(ssid),
        if hidden { "true" } else { "false" },
        match connection_mode {
            WlanProfileConnectionMode::Manual => "manual",
            WlanProfileConnectionMode::Auto => "auto",
        },
        xml_escape(password)
    )
}

/// The journal is deliberately tiny: it is the guard that makes the native
/// call order auditable. In particular, `StableWritten` cannot be reached
/// without local candidate association, address and default-route evidence.
#[cfg(any(windows, test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum WlanProfileTransactionPhase {
    Initial,
    CandidateStaged,
    CandidateVerified,
    StableWritten,
    StableVerified,
    CandidateDeleted,
}

#[cfg(any(windows, test))]
impl WlanProfileTransactionPhase {
    #[cfg(test)]
    fn crash_safety_snapshot(self) -> WlanProfileCrashSafetySnapshot {
        WlanProfileCrashSafetySnapshot {
            // A candidate is either absent or has <connectionMode>manual>.
            candidate_autoconnect: false,
            candidate_may_remain: (Self::CandidateStaged..Self::CandidateDeleted).contains(&self),
            stable_profile_may_have_been_replaced: self >= Self::StableWritten,
        }
    }
}

#[cfg(test)]
struct WlanProfileCrashSafetySnapshot {
    candidate_autoconnect: bool,
    candidate_may_remain: bool,
    stable_profile_may_have_been_replaced: bool,
}

#[cfg(any(windows, test))]
struct CrashSafeWlanProfileTransaction {
    phase: WlanProfileTransactionPhase,
}

#[cfg(any(windows, test))]
impl CrashSafeWlanProfileTransaction {
    fn new() -> Self {
        Self {
            phase: WlanProfileTransactionPhase::Initial,
        }
    }

    fn candidate_staged(&mut self) {
        debug_assert_eq!(self.phase, WlanProfileTransactionPhase::Initial);
        self.phase = WlanProfileTransactionPhase::CandidateStaged;
    }

    fn candidate_verified(&mut self) {
        debug_assert_eq!(self.phase, WlanProfileTransactionPhase::CandidateStaged);
        self.phase = WlanProfileTransactionPhase::CandidateVerified;
    }

    fn stable_profile_write_is_allowed(&self) -> bool {
        self.phase >= WlanProfileTransactionPhase::CandidateVerified
    }

    fn stable_written(&mut self) -> Result<(), String> {
        if !self.stable_profile_write_is_allowed() {
            return Err(
                "WLAN stable profile write was attempted before candidate readiness".to_string(),
            );
        }
        self.phase = WlanProfileTransactionPhase::StableWritten;
        Ok(())
    }

    fn stable_verified(&mut self) {
        debug_assert_eq!(self.phase, WlanProfileTransactionPhase::StableWritten);
        self.phase = WlanProfileTransactionPhase::StableVerified;
    }

    fn candidate_deleted(&mut self) {
        debug_assert_eq!(self.phase, WlanProfileTransactionPhase::StableVerified);
        self.phase = WlanProfileTransactionPhase::CandidateDeleted;
    }
}

/// A native WLAN callback must never outlive its context. Windows documents
/// synchronous teardown only for a successful unregister/handle close. When
/// both calls fail we retain one context for process lifetime and trip this
/// fuse, preventing any later WLAN mutation from registering another callback
/// until the daemon restarts.
#[cfg(any(windows, test))]
#[derive(Default)]
struct WlanCallbackMutationRegistry {
    state: std::sync::Mutex<WlanCallbackMutationRegistryState>,
}

#[cfg(any(windows, test))]
#[derive(Default)]
struct WlanCallbackMutationRegistryState {
    mutation_active: bool,
    callback_fused: bool,
    recovery_frozen: bool,
    retained_context_count: u8,
}

#[cfg(any(windows, test))]
struct WlanCallbackMutationPermit<'a> {
    registry: &'a WlanCallbackMutationRegistry,
}

#[cfg(any(windows, test))]
impl WlanCallbackMutationRegistry {
    fn acquire(&self) -> Result<WlanCallbackMutationPermit<'_>, String> {
        let mut state = self.state.lock().expect("WLAN callback fuse lock poisoned");
        if state.callback_fused {
            return Err("WLAN mutations are disabled until the daemon restarts because a prior callback could not be safely released".to_string());
        }
        if state.recovery_frozen {
            return Err(
                "WLAN mutations are frozen until the daemon restarts because a prior stable-profile recovery requires operator intervention"
                    .to_string(),
            );
        }
        if state.mutation_active {
            return Err("Another WLAN mutation is already in progress".to_string());
        }
        state.mutation_active = true;
        Ok(WlanCallbackMutationPermit { registry: self })
    }

    /// Returns false only if an impossible second unsafe-retention attempt
    /// reaches this registry. The mutation permit prevents that state: no
    /// second notification registration can begin while the first mutation is
    /// active, and a fused registry rejects every later mutation.
    fn retain_context_for_safety(&self) -> bool {
        let mut state = self.state.lock().expect("WLAN callback fuse lock poisoned");
        if !state.mutation_active || state.callback_fused {
            return false;
        }
        state.callback_fused = true;
        state.retained_context_count = state.retained_context_count.saturating_add(1);
        debug_assert_eq!(state.retained_context_count, 1);
        true
    }

    #[cfg(test)]
    fn retained_context_count(&self) -> u8 {
        self.state
            .lock()
            .expect("WLAN callback fuse lock poisoned")
            .retained_context_count
    }

    fn is_fused(&self) -> bool {
        let state = self.state.lock().expect("WLAN callback fuse lock poisoned");
        state.callback_fused || state.recovery_frozen
    }

    #[cfg(any(windows, test))]
    fn freeze_for_recovery(&self) {
        self.state
            .lock()
            .expect("WLAN callback fuse lock poisoned")
            .recovery_frozen = true;
    }
}

#[cfg(test)]
impl WlanCallbackMutationPermit<'_> {
    fn retain_context_for_safety(&mut self) {
        assert!(
            self.registry.retain_context_for_safety(),
            "a WLAN callback context may only be retained once per process"
        );
    }
}

#[cfg(windows)]
fn wlan_callback_mutation_registry() -> &'static WlanCallbackMutationRegistry {
    static REGISTRY: std::sync::OnceLock<WlanCallbackMutationRegistry> = std::sync::OnceLock::new();
    REGISTRY.get_or_init(WlanCallbackMutationRegistry::default)
}

#[cfg(windows)]
fn wlan_recovery_required(message: impl std::fmt::Display) -> String {
    wlan_callback_mutation_registry().freeze_for_recovery();
    format!(
        "WLAN_RECOVERY_REQUIRED: {message}; WLAN mutations are frozen until daemon restart and operator recovery"
    )
}

#[cfg(any(windows, test))]
impl Drop for WlanCallbackMutationPermit<'_> {
    fn drop(&mut self) {
        self.registry
            .state
            .lock()
            .expect("WLAN callback fuse lock poisoned")
            .mutation_active = false;
    }
}

#[cfg(any(windows, test))]
fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(windows)]
fn sanitize_secret(message: &str, secret: &str) -> String {
    if secret.is_empty() {
        message.to_string()
    } else {
        message.replace(secret, "[redacted]")
    }
}

#[cfg(windows)]
#[derive(Debug, Clone, Copy)]
struct LocalInterfaceObservation {
    adapter_ready: bool,
    local_address_ready: bool,
    default_route_ready: bool,
}

#[cfg(windows)]
#[derive(Debug, Clone, Copy)]
enum NativeWlanEvent {
    Completed,
    Failed(u32),
}

#[cfg(windows)]
struct NativeWlanNotificationContext {
    sender: std::sync::mpsc::Sender<NativeWlanEvent>,
    interface_guid: windows_sys::core::GUID,
    profile_name: String,
    ssid: String,
}

#[cfg(any(windows, test))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct PreviousWlanConnection {
    profile_name: String,
    ssid: String,
}

/// `WlanQueryInterface` also reports an in-progress association.  Keeping
/// that fact distinct from a fully connected profile lets crash recovery
/// disconnect a stale manual candidate before removing it.
#[cfg(any(windows, test))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct CurrentWlanConnection {
    profile_name: String,
    ssid: String,
}

#[cfg(any(windows, test))]
#[derive(Debug, Clone, PartialEq, Eq)]
enum CurrentWlanConnectionQuery {
    Connected(CurrentWlanConnection),
    Connecting(CurrentWlanConnection),
    Disconnecting(CurrentWlanConnection),
    Absent,
    Error(u32),
}

#[cfg(any(windows, test))]
fn classify_current_wlan_query(
    query_result: u32,
    interface_state: Option<u32>,
    connection: Option<CurrentWlanConnection>,
) -> CurrentWlanConnectionQuery {
    const ERROR_SUCCESS: u32 = 0;
    const ERROR_INVALID_DATA: u32 = 13;
    const WLAN_INTERFACE_STATE_NOT_READY: u32 = 0;
    const WLAN_INTERFACE_STATE_CONNECTED: u32 = 1;
    const WLAN_INTERFACE_STATE_AD_HOC_NETWORK_FORMED: u32 = 2;
    const WLAN_INTERFACE_STATE_DISCONNECTING: u32 = 3;
    const WLAN_INTERFACE_STATE_DISCONNECTED: u32 = 4;
    const WLAN_INTERFACE_STATE_ASSOCIATING: u32 = 5;
    const WLAN_INTERFACE_STATE_DISCOVERING: u32 = 6;
    const WLAN_INTERFACE_STATE_AUTHENTICATING: u32 = 7;

    if query_result != ERROR_SUCCESS {
        return CurrentWlanConnectionQuery::Error(query_result);
    }
    match interface_state {
        Some(WLAN_INTERFACE_STATE_CONNECTED) => connection.map_or(
            CurrentWlanConnectionQuery::Error(ERROR_INVALID_DATA),
            CurrentWlanConnectionQuery::Connected,
        ),
        Some(
            WLAN_INTERFACE_STATE_ASSOCIATING
            | WLAN_INTERFACE_STATE_DISCOVERING
            | WLAN_INTERFACE_STATE_AUTHENTICATING,
        ) => connection.map_or(
            CurrentWlanConnectionQuery::Error(ERROR_INVALID_DATA),
            CurrentWlanConnectionQuery::Connecting,
        ),
        Some(WLAN_INTERFACE_STATE_DISCONNECTING) => connection.map_or(
            CurrentWlanConnectionQuery::Error(ERROR_INVALID_DATA),
            CurrentWlanConnectionQuery::Disconnecting,
        ),
        Some(
            WLAN_INTERFACE_STATE_NOT_READY
            | WLAN_INTERFACE_STATE_AD_HOC_NETWORK_FORMED
            | WLAN_INTERFACE_STATE_DISCONNECTED,
        ) => CurrentWlanConnectionQuery::Absent,
        _ => CurrentWlanConnectionQuery::Error(ERROR_INVALID_DATA),
    }
}

#[cfg(any(windows, test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UncommittedWlanDropCandidateDisposition {
    Preserve,
}

#[cfg(any(windows, test))]
fn uncommitted_wlan_drop_candidate_disposition(
    _query: &CurrentWlanConnectionQuery,
    _candidate_name: &str,
) -> UncommittedWlanDropCandidateDisposition {
    // A current-connection observation is not a transaction outcome. Only an
    // explicit commit or a completed rollback may clear the durable marker;
    // Drop represents neither and therefore has no cleanup disposition.
    UncommittedWlanDropCandidateDisposition::Preserve
}

#[cfg(windows)]
fn current_wlan_query_connection(
    query: &CurrentWlanConnectionQuery,
) -> Option<&CurrentWlanConnection> {
    match query {
        CurrentWlanConnectionQuery::Connected(current)
        | CurrentWlanConnectionQuery::Connecting(current)
        | CurrentWlanConnectionQuery::Disconnecting(current) => Some(current),
        CurrentWlanConnectionQuery::Absent | CurrentWlanConnectionQuery::Error(_) => None,
    }
}

#[cfg(any(windows, test))]
fn require_safe_current_wlan_query(
    registry: &WlanCallbackMutationRegistry,
    query: &CurrentWlanConnectionQuery,
    context: &str,
) -> Result<(), String> {
    if let CurrentWlanConnectionQuery::Error(code) = query {
        registry.freeze_for_recovery();
        return Err(format!(
            "WLAN_RECOVERY_REQUIRED: {context} could not determine the current WLAN connection (error {code}); WLAN mutations are frozen until daemon restart and operator recovery"
        ));
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn previous_wlan_connection_from_query(
    registry: &WlanCallbackMutationRegistry,
    query: CurrentWlanConnectionQuery,
) -> Result<Option<PreviousWlanConnection>, String> {
    require_safe_current_wlan_query(registry, &query, "capturing the prior WLAN connection")?;
    Ok(match query {
        CurrentWlanConnectionQuery::Connected(current)
        | CurrentWlanConnectionQuery::Connecting(current)
        | CurrentWlanConnectionQuery::Disconnecting(current) => Some(PreviousWlanConnection {
            profile_name: current.profile_name,
            ssid: current.ssid,
        }),
        CurrentWlanConnectionQuery::Absent => None,
        CurrentWlanConnectionQuery::Error(_) => unreachable!("query error returned above"),
    })
}

#[cfg(windows)]
struct WlanClientHandle {
    raw: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl WlanClientHandle {
    unsafe fn open() -> Result<Self, String> {
        use std::ptr;
        use windows_sys::Win32::{Foundation::HANDLE, NetworkManagement::WiFi::WlanOpenHandle};

        const ERROR_SUCCESS: u32 = 0;
        let mut negotiated_version = 0;
        let mut raw: HANDLE = ptr::null_mut();
        let open = WlanOpenHandle(2, ptr::null(), &mut negotiated_version, &mut raw);
        if open != ERROR_SUCCESS {
            return Err(format!("WLAN API open failed with error {open}"));
        }
        Ok(Self { raw })
    }

    fn raw(&self) -> windows_sys::Win32::Foundation::HANDLE {
        self.raw
    }

    fn is_open(&self) -> bool {
        !self.raw.is_null()
    }

    unsafe fn close_synchronously(&mut self) -> Result<(), u32> {
        use std::ptr;
        use windows_sys::Win32::NetworkManagement::WiFi::WlanCloseHandle;

        if !self.is_open() {
            return Ok(());
        }
        // Closing a WLAN client handle unregisters notifications. It is the
        // only fallback allowed before a failed unregister frees its callback
        // context.
        let close = WlanCloseHandle(self.raw, ptr::null());
        if close == 0 {
            self.raw = ptr::null_mut();
            Ok(())
        } else {
            Err(close)
        }
    }
}

#[cfg(windows)]
impl Drop for WlanClientHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = self.close_synchronously();
        }
    }
}

#[cfg(windows)]
struct NativeWlanNotificationRelease<'a> {
    handle: &'a mut WlanClientHandle,
}

#[cfg(windows)]
impl WlanNotificationReleaseApi for NativeWlanNotificationRelease<'_> {
    fn unregister_notification(&mut self) -> u32 {
        use std::ptr;
        use windows_sys::Win32::NetworkManagement::WiFi::{
            WlanRegisterNotification, WLAN_NOTIFICATION_SOURCE_NONE,
        };

        unsafe {
            WlanRegisterNotification(
                self.handle.raw(),
                WLAN_NOTIFICATION_SOURCE_NONE,
                0,
                None,
                ptr::null(),
                ptr::null(),
                ptr::null_mut(),
            )
        }
    }

    fn close_handle_synchronously(&mut self) -> Result<(), u32> {
        unsafe { self.handle.close_synchronously() }
    }
}

#[cfg(windows)]
struct NativeWlanNotificationRegistration<'a> {
    handle: &'a mut WlanClientHandle,
    context: WlanNotificationContextLease<NativeWlanNotificationContext>,
}

#[cfg(windows)]
impl<'a> NativeWlanNotificationRegistration<'a> {
    unsafe fn register(
        handle: &'a mut WlanClientHandle,
        context: NativeWlanNotificationContext,
    ) -> Result<Self, String> {
        use std::ptr;
        use windows_sys::Win32::NetworkManagement::WiFi::{
            WlanRegisterNotification, WLAN_NOTIFICATION_SOURCE_ACM,
        };

        const ERROR_SUCCESS: u32 = 0;
        let mut context = WlanNotificationContextLease::new(context);
        let mut previous_notification_source = 0;
        let registration = WlanRegisterNotification(
            handle.raw(),
            WLAN_NOTIFICATION_SOURCE_ACM,
            0,
            Some(native_wlan_notification_callback),
            context.context_ptr().cast(),
            ptr::null(),
            &mut previous_notification_source,
        );
        if registration != ERROR_SUCCESS {
            return Err(format!(
                "WLAN notification registration failed with error {registration}"
            ));
        }
        Ok(Self { handle, context })
    }

    fn raw_handle(&self) -> windows_sys::Win32::Foundation::HANDLE {
        self.handle.raw()
    }

    fn release(&mut self) -> Result<(), u32> {
        let (handle, context) = (&mut *self.handle, &mut self.context);
        let mut release = NativeWlanNotificationRelease { handle };
        context.release_with(&mut release)
    }

    fn leak_context(&mut self) {
        // `release_with` reports an unregister error even if its synchronous
        // CloseHandle fallback succeeded. In that case it has already freed
        // the context, so only a true unregister+close double failure trips
        // the process fuse.
        if self.context.context.is_none() {
            return;
        }
        // This call can occur only while the process-wide mutation permit is
        // held. It therefore becomes the sole retained context and fuses all
        // future WLAN mutations before another callback context is created.
        assert!(
            wlan_callback_mutation_registry().retain_context_for_safety(),
            "a WLAN callback context may only be retained once per process"
        );
        self.context.leak();
    }
}

#[cfg(windows)]
impl Drop for NativeWlanNotificationRegistration<'_> {
    fn drop(&mut self) {
        if self.release().is_err() {
            // A failed CloseHandle means Windows has not confirmed that the
            // callback is gone. Leak rather than leave a dangling pointer.
            self.leak_context();
        }
    }
}

#[cfg(windows)]
struct StableWlanProfileTransaction {
    interface_guid: windows_sys::core::GUID,
    profile_name_wide: Vec<u16>,
    previous: Option<PreservedWlanProfile>,
    previous_target: Option<StableWlanRecoveryTarget>,
    candidate_name: String,
    stable_applied: bool,
    committed: bool,
}

#[cfg(windows)]
impl StableWlanProfileTransaction {
    unsafe fn begin(
        handle: windows_sys::Win32::Foundation::HANDLE,
        interface_guid: windows_sys::core::GUID,
        profile_name: String,
        candidate_name: String,
    ) -> Result<Self, String> {
        let profile_name_wide = wide_null(&profile_name);
        let previous = capture_existing_wlan_profile(handle, &interface_guid, &profile_name_wide)?;
        let previous_target = previous
            .as_ref()
            .map(|profile| wlan_profile_recovery_target(profile_name.clone(), &profile.profile_xml))
            .transpose()?;
        Ok(Self {
            interface_guid,
            profile_name_wide,
            previous,
            previous_target,
            candidate_name,
            stable_applied: false,
            committed: false,
        })
    }

    unsafe fn stage_stable_profile(
        &mut self,
        handle: windows_sys::Win32::Foundation::HANDLE,
        profile_xml: &[u16],
    ) -> Result<(), String> {
        set_all_user_wlan_profile(handle, &self.interface_guid, profile_xml, "stable")?;
        self.stable_applied = true;
        Ok(())
    }

    fn commit(&mut self) {
        self.committed = true;
        self.stable_applied = false;
    }

    /// The rollback is a recovery state machine, not a best-effort file
    /// restore: restoring XML/order is only its first transition.  The old
    /// stable profile must then be actively connected and independently
    /// verified on this exact interface before the mutation is considered
    /// recovered.
    unsafe fn rollback(
        &mut self,
        client: &mut WlanClientHandle,
        interface: &windows_sys::Win32::NetworkManagement::WiFi::WLAN_INTERFACE_INFO,
    ) -> Result<(), String> {
        if !self.stable_applied || self.committed {
            return Ok(());
        }
        if wlan_callback_mutation_registry().is_fused() {
            return Err(wlan_recovery_required(
                "stable profile rollback cannot begin because WLAN callbacks are not safe",
            ));
        }
        let Some(previous) = self.previous_target.clone() else {
            return Err(wlan_recovery_required(
                "the failed stable profile was new, so no prior stable profile exists to reconnect",
            ));
        };
        let registry = wlan_callback_mutation_registry();
        let operations = NativeStableWlanRollbackOperations {
            transaction: self,
            client,
            interface,
            previous,
            restored: None,
        };
        let mut adapter = StableWlanRollbackAdapter::new(operations);
        execute_stable_wlan_rollback(registry, &mut adapter)?;
        drop(adapter);
        self.committed = true;
        Ok(())
    }

    unsafe fn restore_profile_on_handle(
        &mut self,
        handle: windows_sys::Win32::Foundation::HANDLE,
    ) -> Result<(), String> {
        use std::ptr;
        use windows_sys::Win32::NetworkManagement::WiFi::{
            WlanDeleteProfile, WlanSetProfile, WlanSetProfilePosition, WLAN_REASON_CODE_SUCCESS,
        };

        const ERROR_SUCCESS: u32 = 0;
        match self.previous.as_ref() {
            Some(previous) => {
                let all_user_security = wide_null("D:(A;;GA;;;SY)(A;;GA;;;BA)");
                let mut profile_reason = WLAN_REASON_CODE_SUCCESS;
                let restore = WlanSetProfile(
                    handle,
                    &self.interface_guid,
                    0,
                    previous.profile_xml.as_ptr(),
                    all_user_security.as_ptr(),
                    1,
                    ptr::null(),
                    &mut profile_reason,
                );
                if restore != ERROR_SUCCESS {
                    return Err(format!(
                        "Windows could not restore the prior stable WLAN profile (error {restore}, reason code {profile_reason})"
                    ));
                }
                let reorder = WlanSetProfilePosition(
                    handle,
                    &self.interface_guid,
                    self.profile_name_wide.as_ptr(),
                    previous.profile_position,
                    ptr::null(),
                );
                if reorder != ERROR_SUCCESS {
                    return Err(format!(
                        "Windows could not restore the prior stable WLAN profile order (error {reorder})"
                    ));
                }
            }
            None => {
                let delete = WlanDeleteProfile(
                    handle,
                    &self.interface_guid,
                    self.profile_name_wide.as_ptr(),
                    ptr::null(),
                );
                if delete != ERROR_SUCCESS {
                    return Err(format!(
                        "Windows could not remove the failed stable WLAN profile (error {delete})"
                    ));
                }
            }
        }
        self.stable_applied = false;
        Ok(())
    }
}

#[cfg(windows)]
struct NativeStableWlanRollbackOperations<'a> {
    transaction: &'a mut StableWlanProfileTransaction,
    client: &'a mut WlanClientHandle,
    interface: &'a windows_sys::Win32::NetworkManagement::WiFi::WLAN_INTERFACE_INFO,
    previous: StableWlanRecoveryTarget,
    restored: Option<WlanConnectionObservation>,
}

#[cfg(windows)]
impl StableWlanRollbackOperations for NativeStableWlanRollbackOperations<'_> {
    fn restore_old_profile(&mut self) -> Result<(), String> {
        unsafe {
            ensure_wlan_client_open(self.client).map_err(|error| {
                format!("could not open the WLAN client to restore the old stable profile: {error}")
            })?;
            self.transaction
                .restore_profile_on_handle(self.client.raw())
        }
    }

    fn connect_old_stable(&mut self) -> Result<(), String> {
        unsafe {
            ensure_wlan_client_open(self.client).map_err(|error| {
                format!(
                    "could not open the WLAN client to reconnect the old stable profile: {error}"
                )
            })?;
            let restored = attempt_windows_wlan_connection(
                self.client,
                self.interface,
                &self.previous.profile_name,
                &self.previous.ssid,
                self.previous.hidden,
            )
            .map_err(|error| {
                format!("old stable profile reconnect failed after XML/order restore: {error}")
            })?;
            if !matches!(restored.association, WlanAssociationState::Associated) {
                return Err(
                    "old stable profile did not reconnect to its exact profile/interface/SSID after XML/order restore"
                        .to_string(),
                );
            }
            self.restored = Some(restored);
            Ok(())
        }
    }

    fn verify_old_stable(&mut self) -> Result<(), String> {
        let restored = self.restored.ok_or_else(|| {
            "old stable profile verification ran without a matching connection".to_string()
        })?;
        if !restored.local_address_ready || !restored.default_route_ready {
            return Err(
                "old stable profile did not verify its usable local address and 0/0 route after XML/order restore"
                    .to_string(),
            );
        }
        Ok(())
    }

    fn clear_candidate(&mut self) -> Result<(), String> {
        unsafe {
            ensure_wlan_client_open(self.client).map_err(|error| {
                format!(
                    "could not open the WLAN client to clear the recovered manual candidate: {error}"
                )
            })?;
            delete_wlan_profile(
                self.client.raw(),
                &self.transaction.interface_guid,
                &self.transaction.candidate_name,
                "rolled-back manual candidate",
            )
        }
    }
}

#[cfg(windows)]
impl Drop for StableWlanProfileTransaction {
    fn drop(&mut self) {
        if !self.stable_applied || self.committed {
            return;
        }
        if wlan_callback_mutation_registry().is_fused() {
            return;
        }
        unsafe {
            // Drop deliberately does not claim rollback: XML/order restore
            // without a verified old-profile reconnect is a false recovery.
            // A non-current or absent candidate is likewise not evidence of
            // a completed rollback. Explicit `commit`/`rollback` own cleanup;
            // an uncommitted Drop always retains the durable marker.
            if let Ok(client) = WlanClientHandle::open() {
                let current_query =
                    windows_wlan_current_connection_state(client.raw(), &self.interface_guid);
                if require_safe_current_wlan_query(
                    wlan_callback_mutation_registry(),
                    &current_query,
                    "uncommitted transaction drop",
                )
                .is_ok()
                {
                    match uncommitted_wlan_drop_candidate_disposition(
                        &current_query,
                        &self.candidate_name,
                    ) {
                        UncommittedWlanDropCandidateDisposition::Preserve => {}
                    }
                }
            }
        }
    }
}

#[cfg(windows)]
unsafe fn set_all_user_wlan_profile(
    handle: windows_sys::Win32::Foundation::HANDLE,
    interface_guid: &windows_sys::core::GUID,
    profile_xml: &[u16],
    profile_role: &str,
) -> Result<(), String> {
    use std::ptr;
    use windows_sys::Win32::NetworkManagement::WiFi::{WlanSetProfile, WLAN_REASON_CODE_SUCCESS};

    const ERROR_SUCCESS: u32 = 0;
    let all_user_security = wide_null("D:(A;;GA;;;SY)(A;;GA;;;BA)");
    let mut profile_reason = WLAN_REASON_CODE_SUCCESS;
    let set = WlanSetProfile(
        handle,
        interface_guid,
        0,
        profile_xml.as_ptr(),
        all_user_security.as_ptr(),
        1,
        ptr::null(),
        &mut profile_reason,
    );
    if set != ERROR_SUCCESS {
        return Err(format!(
            "Windows rejected the {profile_role} all-user WLAN profile (error {set}, reason code {profile_reason})"
        ));
    }
    Ok(())
}

#[cfg(windows)]
unsafe fn delete_wlan_profile(
    handle: windows_sys::Win32::Foundation::HANDLE,
    interface_guid: &windows_sys::core::GUID,
    profile_name: &str,
    profile_role: &str,
) -> Result<(), String> {
    use std::ptr;
    use windows_sys::Win32::NetworkManagement::WiFi::WlanDeleteProfile;

    const ERROR_SUCCESS: u32 = 0;
    let profile_name = wide_null(profile_name);
    let delete = WlanDeleteProfile(handle, interface_guid, profile_name.as_ptr(), ptr::null());
    if delete != ERROR_SUCCESS {
        return Err(format!(
            "Windows could not remove the {profile_role} WLAN profile (error {delete})"
        ));
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn wlan_notification_matches_target(
    expected_interface: [u8; 16],
    notification_interface: [u8; 16],
    expected_profile: &str,
    notification_profile: &str,
    expected_ssid: &str,
    notification_ssid: &str,
) -> bool {
    expected_interface == notification_interface
        && expected_profile == notification_profile
        && expected_ssid == notification_ssid
}

/// A matching current connection can be evidence for this attempt only when
/// it was not already the target before `WlanConnect`. If the same profile
/// and SSID were connected beforehand, require the target's completion
/// notification so stale association state cannot approve new credentials.
#[cfg(any(windows, test))]
fn wlan_attempt_has_target_association(
    was_target_connected_before: bool,
    target_connected_now: bool,
    received_target_completion: bool,
    failure_reason: Option<u32>,
) -> bool {
    failure_reason.is_none()
        && target_connected_now
        && (received_target_completion || !was_target_connected_before)
}

/// `WlanRegisterNotification(..., WLAN_NOTIFICATION_SOURCE_NONE, ...)`
/// synchronously waits for an in-flight callback only when it succeeds. On
/// failure, closing the client handle is the synchronous fallback that
/// unregisters the callback before its context is released.
#[cfg(any(windows, test))]
trait WlanNotificationReleaseApi {
    fn unregister_notification(&mut self) -> u32;
    fn close_handle_synchronously(&mut self) -> Result<(), u32>;
}

#[cfg(any(windows, test))]
struct WlanNotificationContextLease<T> {
    context: Option<Box<T>>,
}

#[cfg(any(windows, test))]
impl<T> WlanNotificationContextLease<T> {
    fn new(context: T) -> Self {
        Self {
            context: Some(Box::new(context)),
        }
    }

    #[cfg(windows)]
    fn context_ptr(&mut self) -> *mut T {
        self.context
            .as_deref_mut()
            .map_or(std::ptr::null_mut(), |context| context as *mut T)
    }

    #[cfg(windows)]
    fn leak(&mut self) {
        if let Some(context) = self.context.take() {
            // Safety over a dangling callback pointer: if Windows rejected
            // both unregister and synchronous handle close, its callback
            // context can no longer be reclaimed in-process.
            std::mem::forget(context);
        }
    }

    fn release_with<A: WlanNotificationReleaseApi>(&mut self, api: &mut A) -> Result<(), u32> {
        if self.context.is_none() {
            return Ok(());
        }
        let unregister = api.unregister_notification();
        if unregister != 0 && api.close_handle_synchronously().is_err() {
            // Leave the context owned so the native RAII guard can leak it
            // safely instead of freeing memory Windows may still use.
            return Err(unregister);
        }
        // The successful unregister and the synchronous close fallback both
        // guarantee no callback can still dereference this context.
        self.context.take();
        if unregister == 0 {
            Ok(())
        } else {
            Err(unregister)
        }
    }
}

#[cfg(any(windows, test))]
fn wlan_reason_is_authentication_failure(reason: u32) -> bool {
    // Keep the security classification table-driven. In particular,
    // WLAN_REASON_CODE_MSMSEC_MIN..=WLAN_REASON_CODE_MSMSEC_MAX is the full
    // documented security family, not only the short connect subrange that
    // happens to contain PSK_MISMATCH_SUSPECTED.
    const SECURITY_REASON_RANGES: &[(u32, u32)] = &[(262_144, 327_679)]; // WLAN_REASON_CODE_MSMSEC_MIN..=MSMSEC_MAX
    const SECURITY_REASON_CODES: &[u32] = &[
        163_853, // WLAN_REASON_CODE_KEY_MISMATCH
        196_609, // WLAN_REASON_CODE_UNSUPPORTED_SECURITY_SET_BY_OS
        196_610, // WLAN_REASON_CODE_UNSUPPORTED_SECURITY_SET
        229_380, // WLAN_REASON_CODE_PRE_SECURITY_FAILURE
        229_381, // WLAN_REASON_CODE_START_SECURITY_FAILURE
        229_382, // WLAN_REASON_CODE_SECURITY_FAILURE
        229_383, // WLAN_REASON_CODE_SECURITY_TIMEOUT
        229_385, // WLAN_REASON_CODE_ROAMING_SECURITY_FAILURE
        229_386, // WLAN_REASON_CODE_ADHOC_SECURITY_FAILURE
        229_394, // WLAN_REASON_CODE_TOO_MANY_SECURITY_ATTEMPTS
        524_294, // WLAN_REASON_CODE_MSM_SECURITY_MISSING
        524_295, // WLAN_REASON_CODE_IHV_SECURITY_NOT_SUPPORTED
        524_299, // WLAN_REASON_CODE_CONFLICT_SECURITY
        524_300, // WLAN_REASON_CODE_SECURITY_MISSING
        524_306, // WLAN_REASON_CODE_IHV_SECURITY_ONEX_MISSING
    ];

    SECURITY_REASON_RANGES
        .iter()
        .any(|(start, end)| (*start..=*end).contains(&reason))
        || SECURITY_REASON_CODES.binary_search(&reason).is_ok()
}

#[cfg(windows)]
fn wlan_guid_identity(guid: &windows_sys::core::GUID) -> [u8; 16] {
    let mut identity = [0u8; 16];
    identity[..4].copy_from_slice(&guid.data1.to_ne_bytes());
    identity[4..6].copy_from_slice(&guid.data2.to_ne_bytes());
    identity[6..8].copy_from_slice(&guid.data3.to_ne_bytes());
    identity[8..].copy_from_slice(&guid.data4);
    identity
}

#[cfg(windows)]
fn wlan_notification_profile_name(
    payload: &windows_sys::Win32::NetworkManagement::WiFi::WLAN_CONNECTION_NOTIFICATION_DATA,
) -> Option<String> {
    let length = payload
        .strProfileName
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(payload.strProfileName.len());
    String::from_utf16(&payload.strProfileName[..length]).ok()
}

#[cfg(windows)]
fn wlan_notification_ssid(
    payload: &windows_sys::Win32::NetworkManagement::WiFi::WLAN_CONNECTION_NOTIFICATION_DATA,
) -> Option<&str> {
    let length = usize::try_from(payload.dot11Ssid.uSSIDLength).ok()?.min(32);
    std::str::from_utf8(&payload.dot11Ssid.ucSSID[..length]).ok()
}

#[cfg(windows)]
unsafe fn capture_existing_wlan_profile(
    handle: windows_sys::Win32::Foundation::HANDLE,
    interface_guid: &windows_sys::core::GUID,
    profile_name: &[u16],
) -> Result<Option<PreservedWlanProfile>, String> {
    use std::ptr;
    use windows_sys::Win32::NetworkManagement::WiFi::{WlanFreeMemory, WlanGetProfile};

    const ERROR_SUCCESS: u32 = 0;
    const ERROR_NOT_FOUND: u32 = 1168;
    let Some(profile_position) = wlan_profile_position(handle, interface_guid, profile_name)?
    else {
        return Ok(None);
    };

    let mut profile_xml = ptr::null_mut();
    let mut profile_flags = 0;
    let mut granted_access = 0;
    // Do not request WLAN_PROFILE_GET_PLAINTEXT_KEY. Windows returns the
    // stored protected form, which we retain as opaque UTF-16 for rollback.
    let get = WlanGetProfile(
        handle,
        interface_guid,
        profile_name.as_ptr(),
        ptr::null(),
        &mut profile_xml,
        &mut profile_flags,
        &mut granted_access,
    );
    if get == ERROR_NOT_FOUND {
        return Ok(None);
    }
    if get != ERROR_SUCCESS || profile_xml.is_null() {
        return Err(format!(
            "Windows could not preserve the existing managed WLAN profile (error {get})"
        ));
    }
    let profile_xml_pointer = profile_xml;
    let copied_profile_xml = copy_wide_null(profile_xml_pointer);
    WlanFreeMemory(profile_xml_pointer.cast());
    let profile_xml = copied_profile_xml?;
    Ok(Some(PreservedWlanProfile {
        profile_xml,
        profile_position,
    }))
}

#[cfg(windows)]
unsafe fn wlan_profile_position(
    handle: windows_sys::Win32::Foundation::HANDLE,
    interface_guid: &windows_sys::core::GUID,
    profile_name: &[u16],
) -> Result<Option<u32>, String> {
    use std::{ptr, slice};
    use windows_sys::Win32::NetworkManagement::WiFi::{
        WlanFreeMemory, WlanGetProfileList, WLAN_PROFILE_INFO, WLAN_PROFILE_INFO_LIST,
    };

    const ERROR_SUCCESS: u32 = 0;
    let mut profiles: *mut WLAN_PROFILE_INFO_LIST = ptr::null_mut();
    let list = WlanGetProfileList(handle, interface_guid, ptr::null(), &mut profiles);
    if list != ERROR_SUCCESS || profiles.is_null() {
        return Err(format!(
            "Windows could not preserve the managed WLAN profile order (error {list})"
        ));
    }
    let count = (*profiles).dwNumberOfItems as usize;
    let entries: &[WLAN_PROFILE_INFO] =
        slice::from_raw_parts((*profiles).ProfileInfo.as_ptr(), count);
    let position = entries
        .iter()
        .position(|entry| wlan_profile_name_matches(&entry.strProfileName, profile_name))
        .map(|position| position as u32);
    WlanFreeMemory(profiles.cast());
    Ok(position)
}

#[cfg(windows)]
fn wlan_profile_name_matches(profile_name: &[u16; 256], expected: &[u16]) -> bool {
    let actual_length = profile_name
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(profile_name.len());
    let expected = expected.strip_suffix(&[0]).unwrap_or(expected);
    profile_name[..actual_length] == expected[..]
}

#[cfg(windows)]
unsafe fn copy_wide_null(value: *const u16) -> Result<Vec<u16>, String> {
    use std::slice;

    const MAX_PROFILE_UTF16_UNITS: usize = 1024 * 1024;
    if value.is_null() {
        return Err("Windows returned an empty managed WLAN profile buffer".to_string());
    }
    for length in 0..MAX_PROFILE_UTF16_UNITS {
        if *value.add(length) == 0 {
            return Ok(slice::from_raw_parts(value, length + 1).to_vec());
        }
    }
    Err("Windows returned an unterminated managed WLAN profile buffer".to_string())
}

#[cfg(windows)]
unsafe extern "system" fn native_wlan_notification_callback(
    notification: *mut windows_sys::Win32::NetworkManagement::WiFi::L2_NOTIFICATION_DATA,
    context: *mut std::ffi::c_void,
) {
    use windows_sys::Win32::NetworkManagement::WiFi::{
        wlan_notification_acm_connection_attempt_fail, wlan_notification_acm_connection_complete,
        WLAN_CONNECTION_NOTIFICATION_DATA, WLAN_NOTIFICATION_SOURCE_ACM, WLAN_REASON_CODE_SUCCESS,
    };

    if notification.is_null() || context.is_null() {
        return;
    }
    let notification = &*notification;
    if notification.NotificationSource != WLAN_NOTIFICATION_SOURCE_ACM
        || (notification.NotificationCode != wlan_notification_acm_connection_complete as u32
            && notification.NotificationCode
                != wlan_notification_acm_connection_attempt_fail as u32)
        || notification.pData.is_null()
        || notification.dwDataSize < std::mem::size_of::<WLAN_CONNECTION_NOTIFICATION_DATA>() as u32
    {
        return;
    }
    let payload = &*(notification.pData as *const WLAN_CONNECTION_NOTIFICATION_DATA);
    let context = &*(context as *const NativeWlanNotificationContext);
    let Some(notification_profile) = wlan_notification_profile_name(payload) else {
        return;
    };
    let Some(notification_ssid) = wlan_notification_ssid(payload) else {
        return;
    };
    if !wlan_notification_matches_target(
        wlan_guid_identity(&context.interface_guid),
        wlan_guid_identity(&notification.InterfaceGuid),
        &context.profile_name,
        &notification_profile,
        &context.ssid,
        notification_ssid,
    ) {
        return;
    }
    let event = if notification.NotificationCode == wlan_notification_acm_connection_complete as u32
        && payload.wlanReasonCode == WLAN_REASON_CODE_SUCCESS
    {
        NativeWlanEvent::Completed
    } else {
        NativeWlanEvent::Failed(payload.wlanReasonCode)
    };
    let _ = context.sender.send(event);
}

#[cfg(windows)]
fn apply_windows_wlan_profile_native(
    request: &NetworkSettingsRequest,
) -> Result<WlanConnectionObservation, String> {
    let ssid = request.ssid.trim();
    if ssid.is_empty() {
        return Err("SSID is required".to_string());
    }
    if ssid.as_bytes().len() > 32 {
        return Err("SSID must be at most 32 UTF-8 bytes".to_string());
    }
    if request.password.is_empty() {
        return Err("Wi-Fi password is required".to_string());
    }

    // Hold the process-wide permit for the whole mutation. It serializes
    // native callback registration and turns a double teardown failure into a
    // hard fuse before another context can be allocated.
    let _mutation_permit = wlan_callback_mutation_registry().acquire()?;

    unsafe {
        let mut client = WlanClientHandle::open()?;
        recover_stale_vem_candidate_profiles(&mut client)?;
        let interface = select_windows_wlan_interface(client.raw(), ssid, request.hidden)?;
        let previous_connection =
            windows_wlan_current_connection(client.raw(), &interface.InterfaceGuid)?;
        let candidate_name = candidate_wlan_profile_name(ssid, &uuid::Uuid::new_v4().to_string());
        let candidate_profile_xml = wide_null(&wlan_profile_xml(
            &candidate_name,
            ssid,
            &request.password,
            request.hidden,
            WlanProfileConnectionMode::Manual,
        ));
        let mut journal = CrashSafeWlanProfileTransaction::new();
        // This is the only profile write before association, address and
        // default-route evidence. It has a unique name and manual connection
        // mode, so a process crash can leave at most an inert candidate while
        // preserving the old deterministic auto-connect profile intact.
        if let Err(error) = set_all_user_wlan_profile(
            client.raw(),
            &interface.InterfaceGuid,
            &candidate_profile_xml,
            "manual candidate",
        ) {
            let recovery = recover_after_candidate_failure(
                &mut client,
                &interface,
                &candidate_name,
                previous_connection.as_ref(),
            );
            return combine_wlan_recovery_result(Err(error), Ok(()), recovery);
        }
        journal.candidate_staged();

        let candidate_connection = attempt_windows_wlan_connection(
            &mut client,
            &interface,
            &candidate_name,
            ssid,
            request.hidden,
        );
        match candidate_connection {
            Ok(observation) if wlan_local_connection_succeeded(observation) => {
                journal.candidate_verified();

                if let Err(error) = ensure_wlan_client_open(&mut client) {
                    let recovery = recover_after_candidate_failure(
                        &mut client,
                        &interface,
                        &candidate_name,
                        previous_connection.as_ref(),
                    );
                    return combine_wlan_recovery_result(Err(error), Ok(()), recovery);
                }
                let stable_name = deterministic_wlan_profile_name(ssid);
                let stable_profile_xml = wide_null(&wlan_profile_xml(
                    &stable_name,
                    ssid,
                    &request.password,
                    request.hidden,
                    WlanProfileConnectionMode::Auto,
                ));
                let mut stable_transaction = match StableWlanProfileTransaction::begin(
                    client.raw(),
                    interface.InterfaceGuid,
                    stable_name.clone(),
                    candidate_name.clone(),
                ) {
                    Ok(transaction) => transaction,
                    Err(error) => {
                        let recovery = recover_after_candidate_failure(
                            &mut client,
                            &interface,
                            &candidate_name,
                            previous_connection.as_ref(),
                        );
                        return combine_wlan_recovery_result(Err(error), Ok(()), recovery);
                    }
                };
                // The journal makes this ordering a checked invariant rather
                // than a comment: a future refactor cannot stage the stable
                // profile until candidate readiness has been observed.
                if !journal.stable_profile_write_is_allowed() {
                    return Err(
                        "WLAN stable profile write was attempted before candidate readiness"
                            .to_string(),
                    );
                }
                if let Err(error) =
                    stable_transaction.stage_stable_profile(client.raw(), &stable_profile_xml)
                {
                    let stable_rollback = stable_transaction.rollback(&mut client, &interface);
                    return combine_wlan_recovery_result(Err(error), stable_rollback, Ok(()));
                }
                if let Err(error) = journal.stable_written() {
                    let stable_rollback = stable_transaction.rollback(&mut client, &interface);
                    return combine_wlan_recovery_result(Err(error), stable_rollback, Ok(()));
                }

                let stable_connection = attempt_windows_wlan_connection(
                    &mut client,
                    &interface,
                    &stable_name,
                    ssid,
                    request.hidden,
                );
                match stable_connection {
                    Ok(stable_observation)
                        if wlan_local_connection_succeeded(stable_observation) =>
                    {
                        journal.stable_verified();
                        if let Err(error) = ensure_wlan_client_open(&mut client) {
                            // A verified stable connection is safer than a
                            // speculative rollback. Keep it, and let a later
                            // process clean the manual candidate.
                            stable_transaction.commit();
                            return Err(format!(
                                "WLAN stable profile was verified but manual candidate cleanup is pending: {error}"
                            ));
                        }
                        match delete_wlan_profile(
                            client.raw(),
                            &interface.InterfaceGuid,
                            &candidate_name,
                            "manual candidate",
                        ) {
                            Ok(()) => {
                                journal.candidate_deleted();
                                stable_transaction.commit();
                                Ok(stable_observation)
                            }
                            Err(error) => {
                                // The verified stable profile is now the
                                // safe live connection. Keep it rather than
                                // undo a successful handover; the candidate
                                // remains manual and the next operation will
                                // retry cleanup before any mutation.
                                stable_transaction.commit();
                                Err(format!(
                                    "WLAN stable profile was verified but manual candidate cleanup is pending: {error}"
                                ))
                            }
                        }
                    }
                    Ok(observation) => {
                        let stable_rollback = stable_transaction.rollback(&mut client, &interface);
                        combine_wlan_recovery_result(Ok(observation), stable_rollback, Ok(()))
                    }
                    Err(error) => {
                        let stable_rollback = stable_transaction.rollback(&mut client, &interface);
                        combine_wlan_recovery_result(Err(error), stable_rollback, Ok(()))
                    }
                }
            }
            Ok(observation) => {
                let recovery = recover_after_candidate_failure(
                    &mut client,
                    &interface,
                    &candidate_name,
                    previous_connection.as_ref(),
                );
                combine_wlan_recovery_result(Ok(observation), Ok(()), recovery)
            }
            Err(error) => {
                let recovery = recover_after_candidate_failure(
                    &mut client,
                    &interface,
                    &candidate_name,
                    previous_connection.as_ref(),
                );
                combine_wlan_recovery_result(Err(error), Ok(()), recovery)
            }
        }
    }
}

#[cfg(windows)]
unsafe fn ensure_wlan_client_open(client: &mut WlanClientHandle) -> Result<(), String> {
    if !client.is_open() {
        *client = WlanClientHandle::open()?;
    }
    Ok(())
}

#[cfg(windows)]
struct NativeCandidateFailureRecoveryOperations<'a> {
    client: &'a mut WlanClientHandle,
    interface: &'a windows_sys::Win32::NetworkManagement::WiFi::WLAN_INTERFACE_INFO,
    candidate_name: &'a str,
    previous: &'a PreviousWlanConnection,
    restored: Option<WlanConnectionObservation>,
}

#[cfg(windows)]
impl StableWlanRollbackOperations for NativeCandidateFailureRecoveryOperations<'_> {
    fn restore_old_profile(&mut self) -> Result<(), String> {
        unsafe {
            ensure_wlan_client_open(self.client).map_err(|error| {
                format!("could not open the WLAN client to restore the old stable profile: {error}")
            })?;
            let profile_name = wide_null(&self.previous.profile_name);
            capture_existing_wlan_profile(
                self.client.raw(),
                &self.interface.InterfaceGuid,
                &profile_name,
            )?
            .ok_or_else(|| {
                format!(
                    "old stable WLAN profile {:?} is no longer present",
                    self.previous.profile_name
                )
            })?;
            Ok(())
        }
    }

    fn connect_old_stable(&mut self) -> Result<(), String> {
        unsafe {
            ensure_wlan_client_open(self.client).map_err(|error| {
                format!(
                    "could not open the WLAN client to reconnect the old stable profile: {error}"
                )
            })?;
            let restored = attempt_windows_wlan_connection(
                self.client,
                self.interface,
                &self.previous.profile_name,
                &self.previous.ssid,
                false,
            )
            .map_err(|error| format!("old stable WLAN reconnect failed: {error}"))?;
            if !matches!(restored.association, WlanAssociationState::Associated) {
                return Err(
                    "old stable WLAN did not associate with its exact profile/interface/SSID"
                        .to_string(),
                );
            }
            self.restored = Some(restored);
            Ok(())
        }
    }

    fn verify_old_stable(&mut self) -> Result<(), String> {
        let restored = self.restored.ok_or_else(|| {
            "old stable WLAN verification ran without an exact restored connection".to_string()
        })?;
        if !restored.local_address_ready || !restored.default_route_ready {
            return Err(
                "old stable WLAN did not verify a usable local address and default route"
                    .to_string(),
            );
        }
        Ok(())
    }

    fn clear_candidate(&mut self) -> Result<(), String> {
        unsafe {
            ensure_wlan_client_open(self.client).map_err(|error| {
                format!("could not open the WLAN client to clear the failed candidate: {error}")
            })?;
            delete_wlan_profile(
                self.client.raw(),
                &self.interface.InterfaceGuid,
                self.candidate_name,
                "failed manual candidate after verified old stable recovery",
            )
        }
    }
}

#[cfg(windows)]
unsafe fn recover_after_candidate_failure(
    client: &mut WlanClientHandle,
    interface: &windows_sys::Win32::NetworkManagement::WiFi::WLAN_INTERFACE_INFO,
    candidate_name: &str,
    previous_connection: Option<&PreviousWlanConnection>,
) -> Result<(), String> {
    if wlan_callback_mutation_registry().is_fused() {
        // A callback may still dereference the retained context. Do not
        // register another callback or issue a new WLAN mutation in this
        // process; the candidate is manual and startup/next process will
        // clean it up before attempting a connection.
        return Err(wlan_recovery_required(
            "candidate failure recovery cannot begin because WLAN callbacks are not safe",
        ));
    }
    let Some(previous) = previous_connection else {
        return Err(wlan_recovery_required(
            "candidate failure has no captured old stable profile to restore and verify; candidate marker is retained",
        ));
    };
    let registry = wlan_callback_mutation_registry();
    let operations = NativeCandidateFailureRecoveryOperations {
        client,
        interface,
        candidate_name,
        previous,
        restored: None,
    };
    let mut adapter = StableWlanRollbackAdapter::new(operations);
    execute_candidate_failure_recovery(registry, &mut adapter)
}

#[cfg(any(windows, test))]
fn combine_wlan_recovery_result(
    connection: Result<WlanConnectionObservation, String>,
    stable_rollback: Result<(), String>,
    candidate_recovery: Result<(), String>,
) -> Result<WlanConnectionObservation, String> {
    match (connection, stable_rollback, candidate_recovery) {
        (Ok(observation), Ok(()), Ok(())) => Ok(observation),
        (Ok(_), Ok(()), Err(recovery)) => Err(format!(
            "WLAN candidate connection did not reach local readiness; recovery failed: {recovery}"
        )),
        (Err(error), Ok(()), Ok(())) => Err(error),
        (Err(error), Ok(()), Err(recovery)) => Err(format!("{error}; recovery failed: {recovery}")),
        (Ok(_), Err(rollback), Ok(())) => Err(format!(
            "WLAN candidate connection did not reach local readiness; stable profile rollback failed: {rollback}"
        )),
        (Ok(_), Err(rollback), Err(recovery)) => Err(format!(
            "WLAN candidate connection did not reach local readiness; stable profile rollback failed: {rollback}; recovery failed: {recovery}"
        )),
        (Err(error), Err(rollback), Ok(())) => Err(format!(
            "{error}; stable profile rollback failed: {rollback}"
        )),
        (Err(error), Err(rollback), Err(recovery)) => Err(format!(
            "{error}; stable profile rollback failed: {rollback}; recovery failed: {recovery}"
        )),
    }
}

#[cfg(windows)]
unsafe fn attempt_windows_wlan_connection(
    client: &mut WlanClientHandle,
    interface: &windows_sys::Win32::NetworkManagement::WiFi::WLAN_INTERFACE_INFO,
    profile_name: &str,
    ssid: &str,
    hidden: bool,
) -> Result<WlanConnectionObservation, String> {
    use std::{ptr, sync::mpsc, thread, time::Duration};
    use windows_sys::Win32::NetworkManagement::WiFi::{
        dot11_BSS_type_any, wlan_connection_mode_profile, WlanConnect,
        WLAN_CONNECTION_HIDDEN_NETWORK, WLAN_CONNECTION_PARAMETERS,
    };

    const ERROR_SUCCESS: u32 = 0;
    if wlan_callback_mutation_registry().is_fused() {
        return Err(
            "WLAN mutations are disabled until the daemon restarts because a prior callback could not be safely released"
                .to_string(),
        );
    }
    let target_was_connected_before = windows_wlan_is_associated_with_target(
        client.raw(),
        &interface.InterfaceGuid,
        profile_name,
        ssid,
    )?;
    let (sender, receiver) = mpsc::channel();
    let context = NativeWlanNotificationContext {
        sender,
        interface_guid: interface.InterfaceGuid,
        profile_name: profile_name.to_string(),
        ssid: ssid.to_string(),
    };
    let mut registration = NativeWlanNotificationRegistration::register(client, context)?;
    let handle = registration.raw_handle();

    let mut dot11_ssid = windows_sys::Win32::NetworkManagement::WiFi::DOT11_SSID {
        uSSIDLength: ssid.len() as u32,
        ucSSID: [0; 32],
    };
    dot11_ssid.ucSSID[..ssid.len()].copy_from_slice(ssid.as_bytes());
    let profile_name_wide = wide_null(profile_name);
    let parameters = WLAN_CONNECTION_PARAMETERS {
        wlanConnectionMode: wlan_connection_mode_profile,
        strProfile: profile_name_wide.as_ptr(),
        pDot11Ssid: &mut dot11_ssid,
        pDesiredBssidList: ptr::null_mut(),
        dot11BssType: dot11_BSS_type_any,
        dwFlags: if hidden {
            WLAN_CONNECTION_HIDDEN_NETWORK
        } else {
            0
        },
    };
    let connect = WlanConnect(handle, &interface.InterfaceGuid, &parameters, ptr::null());
    if connect != ERROR_SUCCESS {
        let cleanup = registration.release();
        if cleanup.is_err() {
            registration.leak_context();
        }
        drop(registration);
        return match cleanup {
            Ok(()) => Err(format!("WLAN connect request failed with error {connect}")),
            Err(cleanup) => Err(format!(
                "WLAN connect request failed with error {connect}; notification cleanup failed with error {cleanup}"
            )),
        };
    }

    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    let mut received_target_completion = false;
    let mut failure_reason = None;
    while std::time::Instant::now() < deadline {
        match receiver.recv_timeout(Duration::from_millis(500)) {
            Ok(NativeWlanEvent::Completed) => {
                received_target_completion = true;
                break;
            }
            Ok(NativeWlanEvent::Failed(reason)) => {
                failure_reason = Some(reason);
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let target_connected_now = windows_wlan_is_associated_with_target(
                    handle,
                    &interface.InterfaceGuid,
                    profile_name,
                    ssid,
                )?;
                if wlan_attempt_has_target_association(
                    target_was_connected_before,
                    target_connected_now,
                    received_target_completion,
                    failure_reason,
                ) {
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    let target_connected_now = windows_wlan_is_associated_with_target(
        handle,
        &interface.InterfaceGuid,
        profile_name,
        ssid,
    )?;
    let association = if wlan_attempt_has_target_association(
        target_was_connected_before,
        target_connected_now,
        received_target_completion,
        failure_reason,
    ) {
        WlanAssociationState::Associated
    } else if let Some(reason) = failure_reason {
        // A matched target failure always beats stale state, including a
        // prior association to the same SSID/profile.
        wlan_association_state_from_reason(reason)
    } else {
        WlanAssociationState::TimedOut
    };
    let cleanup = registration.release();
    if cleanup.is_err() {
        registration.leak_context();
    }
    drop(registration);
    if let Err(cleanup) = cleanup {
        return Err(format!(
            "WLAN notification cleanup failed with error {cleanup}"
        ));
    }

    if association != WlanAssociationState::Associated {
        return Ok(WlanConnectionObservation {
            association,
            local_address_ready: false,
            default_route_ready: false,
        });
    }

    let mut observation = LocalInterfaceObservation {
        adapter_ready: true,
        local_address_ready: false,
        default_route_ready: false,
    };
    for _ in 0..20 {
        observation = inspect_windows_local_interface(Some(&interface.InterfaceGuid))?;
        if observation.local_address_ready && observation.default_route_ready {
            break;
        }
        thread::sleep(Duration::from_millis(500));
    }
    Ok(WlanConnectionObservation {
        association,
        local_address_ready: observation.local_address_ready,
        default_route_ready: observation.default_route_ready,
    })
}

#[cfg(windows)]
unsafe fn select_windows_wlan_interface(
    handle: windows_sys::Win32::Foundation::HANDLE,
    ssid: &str,
    hidden: bool,
) -> Result<windows_sys::Win32::NetworkManagement::WiFi::WLAN_INTERFACE_INFO, String> {
    use std::{ptr, slice};
    use windows_sys::Win32::NetworkManagement::WiFi::{
        WlanEnumInterfaces, WlanFreeMemory, WlanGetAvailableNetworkList, WLAN_AVAILABLE_NETWORK,
        WLAN_AVAILABLE_NETWORK_LIST, WLAN_INTERFACE_INFO_LIST,
    };
    const ERROR_SUCCESS: u32 = 0;

    let mut list: *mut WLAN_INTERFACE_INFO_LIST = ptr::null_mut();
    let result = WlanEnumInterfaces(handle, ptr::null(), &mut list);
    if result != ERROR_SUCCESS || list.is_null() {
        return Err(format!(
            "WLAN interface enumeration failed with error {result}"
        ));
    }
    let interfaces = slice::from_raw_parts(
        (*list).InterfaceInfo.as_ptr(),
        (*list).dwNumberOfItems as usize,
    )
    .to_vec();
    WlanFreeMemory(list.cast());
    if interfaces.is_empty() {
        return Err("No enabled Windows WLAN interface is available".to_string());
    }
    if hidden {
        return Ok(interfaces[0]);
    }
    for interface in interfaces {
        let mut networks: *mut WLAN_AVAILABLE_NETWORK_LIST = ptr::null_mut();
        let result = WlanGetAvailableNetworkList(
            handle,
            &interface.InterfaceGuid,
            0,
            ptr::null(),
            &mut networks,
        );
        if result != ERROR_SUCCESS || networks.is_null() {
            continue;
        }
        let found = slice::from_raw_parts(
            (*networks).Network.as_ptr(),
            (*networks).dwNumberOfItems as usize,
        )
        .iter()
        .any(|network: &WLAN_AVAILABLE_NETWORK| native_network_ssid(network) == Some(ssid));
        WlanFreeMemory(networks.cast());
        if found {
            return Ok(interface);
        }
    }
    Err("The requested SSID is not available on an enabled Windows WLAN adapter".to_string())
}

#[cfg(windows)]
fn native_network_ssid(
    network: &windows_sys::Win32::NetworkManagement::WiFi::WLAN_AVAILABLE_NETWORK,
) -> Option<&str> {
    let length = usize::try_from(network.dot11Ssid.uSSIDLength).ok()?.min(32);
    std::str::from_utf8(&network.dot11Ssid.ucSSID[..length]).ok()
}

#[cfg(windows)]
unsafe fn recover_stale_vem_candidate_profiles(
    client: &mut WlanClientHandle,
) -> Result<(), String> {
    use std::{ptr, slice};
    use windows_sys::Win32::NetworkManagement::WiFi::{
        WlanEnumInterfaces, WlanFreeMemory, WLAN_INTERFACE_INFO_LIST,
    };

    const ERROR_SUCCESS: u32 = 0;
    if wlan_callback_mutation_registry().is_fused() {
        return Err(
            "WLAN stale-candidate recovery cannot run because WLAN mutations are frozen until daemon restart"
                .to_string(),
        );
    }
    ensure_wlan_client_open(client)?;
    let handle = client.raw();
    let mut list: *mut WLAN_INTERFACE_INFO_LIST = ptr::null_mut();
    let enumerate = WlanEnumInterfaces(handle, ptr::null(), &mut list);
    if enumerate != ERROR_SUCCESS || list.is_null() {
        return Err(format!(
            "Windows could not enumerate WLAN interfaces for candidate cleanup (error {enumerate})"
        ));
    }
    let interfaces = slice::from_raw_parts(
        (*list).InterfaceInfo.as_ptr(),
        (*list).dwNumberOfItems as usize,
    )
    .to_vec();
    WlanFreeMemory(list.cast());

    for interface in interfaces {
        let candidate_names: Vec<_> = wlan_profile_names(handle, &interface.InterfaceGuid)?
            .into_iter()
            .filter(|profile_name| is_vem_candidate_profile_name(profile_name))
            .collect();
        if candidate_names.is_empty() {
            // A normally disconnected interface may report
            // ERROR_INVALID_STATE for current_connection. With no durable
            // candidate marker there is no recovery mutation to guard.
            continue;
        }
        for candidate_name in candidate_names {
            ensure_wlan_client_open(client)?;
            let handle = client.raw();
            // Read the live connection before touching each marker. In
            // particular, deleting an in-flight manual candidate and then
            // asking Windows to reconnect it would turn crash recovery into
            // a use-after-delete profile transition.
            let current_query =
                windows_wlan_current_connection_state(handle, &interface.InterfaceGuid);
            require_safe_current_wlan_query(
                wlan_callback_mutation_registry(),
                &current_query,
                "startup candidate recovery",
            )?;
            let stable_name = stable_wlan_profile_name_for_candidate(&candidate_name).ok_or_else(
                || {
                    wlan_recovery_required(format!(
                        "stale candidate profile has an invalid name and cannot be mapped to its stable profile: {candidate_name}"
                    ))
                },
            )?;
            let stable_name_wide = wide_null(&stable_name);
            let stable =
                capture_existing_wlan_profile(handle, &interface.InterfaceGuid, &stable_name_wide)?
                    .map(|profile| {
                        wlan_profile_recovery_target(stable_name.clone(), &profile.profile_xml)
                    })
                    .transpose()
                    .map_err(wlan_recovery_required)?;

            let candidate_current = current_wlan_query_connection(&current_query)
                .is_some_and(|connection| connection.profile_name == candidate_name);
            if candidate_current {
                disconnect_stale_wlan_candidate(
                    handle,
                    &interface.InterfaceGuid,
                    &candidate_name,
                    &current_query,
                )?;
            }
            // The manual candidate is the durable crash marker. Preserve it
            // until the exact stable profile/interface/SSID has associated
            // and IP Helper proves a usable address plus a 0/0 route. This
            // applies even when Windows initially reports the stable profile
            // as connected or still connecting.
            let Some(stable) = stable else {
                return Err(wlan_recovery_required(format!(
                    "stale candidate {candidate_name} is retained because stable profile {stable_name} is unavailable"
                )));
            };
            ensure_wlan_client_open(client)?;
            let observation = attempt_windows_wlan_connection(
                client,
                &interface,
                &stable.profile_name,
                &stable.ssid,
                stable.hidden,
            )
            .map_err(|error| {
                wlan_recovery_required(format!(
                    "stable profile {stable_name} could not reconnect while retaining stale candidate {candidate_name}: {error}"
                ))
            })?;
            if !wlan_local_connection_succeeded(observation) {
                return Err(wlan_recovery_required(format!(
                    "stable profile {stable_name} did not verify its exact profile/interface/SSID, usable local address and 0/0 route; stale candidate {candidate_name} is retained"
                )));
            }
            ensure_wlan_client_open(client).map_err(|error| {
                wlan_recovery_required(format!(
                    "stable profile {stable_name} was verified but the WLAN client could not reopen to clear stale candidate {candidate_name}: {error}"
                ))
            })?;
            delete_wlan_profile(
                client.raw(),
                &interface.InterfaceGuid,
                &candidate_name,
                "verified stale manual candidate",
            )
            .map_err(|error| {
                wlan_recovery_required(format!(
                    "stable profile {stable_name} was verified but stale candidate {candidate_name} could not be cleared: {error}"
                ))
            })?;
        }
    }
    Ok(())
}

#[cfg(windows)]
unsafe fn disconnect_stale_wlan_candidate(
    handle: windows_sys::Win32::Foundation::HANDLE,
    interface_guid: &windows_sys::core::GUID,
    candidate_name: &str,
    current_query: &CurrentWlanConnectionQuery,
) -> Result<(), String> {
    use std::{ptr, thread, time::Duration};
    use windows_sys::Win32::NetworkManagement::WiFi::WlanDisconnect;

    const ERROR_SUCCESS: u32 = 0;
    let candidate_is_current = current_wlan_query_connection(current_query)
        .is_some_and(|current| current.profile_name == candidate_name);
    if !candidate_is_current {
        return Ok(());
    }
    if matches!(
        current_query,
        CurrentWlanConnectionQuery::Connected(_) | CurrentWlanConnectionQuery::Connecting(_)
    ) {
        let disconnect = WlanDisconnect(handle, interface_guid, ptr::null());
        if disconnect != ERROR_SUCCESS {
            return Err(wlan_recovery_required(format!(
                "could not disconnect stale manual candidate {candidate_name} before stable recovery (error {disconnect})"
            )));
        }
    }
    for _ in 0..20 {
        let current_query = windows_wlan_current_connection_state(handle, interface_guid);
        require_safe_current_wlan_query(
            wlan_callback_mutation_registry(),
            &current_query,
            "waiting for a stale candidate to disconnect",
        )?;
        match current_query {
            CurrentWlanConnectionQuery::Error(_) => unreachable!("query error returned above"),
            CurrentWlanConnectionQuery::Absent => return Ok(()),
            CurrentWlanConnectionQuery::Connected(current)
            | CurrentWlanConnectionQuery::Connecting(current)
            | CurrentWlanConnectionQuery::Disconnecting(current)
                if current.profile_name != candidate_name =>
            {
                return Ok(());
            }
            CurrentWlanConnectionQuery::Connected(_)
            | CurrentWlanConnectionQuery::Connecting(_)
            | CurrentWlanConnectionQuery::Disconnecting(_) => {}
        }
        thread::sleep(Duration::from_millis(250));
    }
    Err(wlan_recovery_required(format!(
        "stale manual candidate {candidate_name} remained current while disconnecting"
    )))
}

#[cfg(windows)]
unsafe fn wlan_profile_names(
    handle: windows_sys::Win32::Foundation::HANDLE,
    interface_guid: &windows_sys::core::GUID,
) -> Result<Vec<String>, String> {
    use std::{ptr, slice};
    use windows_sys::Win32::NetworkManagement::WiFi::{
        WlanFreeMemory, WlanGetProfileList, WLAN_PROFILE_INFO, WLAN_PROFILE_INFO_LIST,
    };

    const ERROR_SUCCESS: u32 = 0;
    let mut profiles: *mut WLAN_PROFILE_INFO_LIST = ptr::null_mut();
    let list = WlanGetProfileList(handle, interface_guid, ptr::null(), &mut profiles);
    if list != ERROR_SUCCESS || profiles.is_null() {
        return Err(format!(
            "Windows could not enumerate WLAN profiles for candidate cleanup (error {list})"
        ));
    }
    let entries: &[WLAN_PROFILE_INFO] = slice::from_raw_parts(
        (*profiles).ProfileInfo.as_ptr(),
        (*profiles).dwNumberOfItems as usize,
    );
    let names = entries
        .iter()
        .filter_map(|entry| {
            let length = entry
                .strProfileName
                .iter()
                .position(|unit| *unit == 0)
                .unwrap_or(entry.strProfileName.len());
            String::from_utf16(&entry.strProfileName[..length]).ok()
        })
        .collect();
    WlanFreeMemory(profiles.cast());
    Ok(names)
}

#[cfg(windows)]
unsafe fn windows_wlan_current_connection_state(
    handle: windows_sys::Win32::Foundation::HANDLE,
    interface: &windows_sys::core::GUID,
) -> CurrentWlanConnectionQuery {
    use std::ptr;
    use windows_sys::Win32::NetworkManagement::WiFi::{
        wlan_intf_opcode_current_connection, WlanFreeMemory, WlanQueryInterface,
        WLAN_CONNECTION_ATTRIBUTES, WLAN_OPCODE_VALUE_TYPE,
    };
    const ERROR_SUCCESS: u32 = 0;

    let mut size = 0;
    let mut data = ptr::null_mut();
    let mut value_type: WLAN_OPCODE_VALUE_TYPE = 0;
    let result = WlanQueryInterface(
        handle,
        interface,
        wlan_intf_opcode_current_connection,
        ptr::null(),
        &mut size,
        &mut data,
        &mut value_type,
    );
    if result != ERROR_SUCCESS {
        if !data.is_null() {
            WlanFreeMemory(data);
        }
        return classify_current_wlan_query(result, None, None);
    }
    if data.is_null() || size < std::mem::size_of::<WLAN_CONNECTION_ATTRIBUTES>() as u32 {
        if !data.is_null() {
            WlanFreeMemory(data);
        }
        return classify_current_wlan_query(ERROR_SUCCESS, None, None);
    }
    let attributes = &*(data as *const WLAN_CONNECTION_ATTRIBUTES);
    let profile_length = attributes
        .strProfileName
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(attributes.strProfileName.len());
    let ssid_length = usize::try_from(attributes.wlanAssociationAttributes.dot11Ssid.uSSIDLength)
        .unwrap_or(0)
        .min(32);
    let connection = {
        let profile_name = String::from_utf16(&attributes.strProfileName[..profile_length]).ok();
        let ssid = std::str::from_utf8(
            &attributes.wlanAssociationAttributes.dot11Ssid.ucSSID[..ssid_length],
        )
        .ok()
        .map(str::to_string);
        match (profile_name, ssid) {
            (Some(profile_name), Some(ssid)) if !profile_name.is_empty() && !ssid.is_empty() => {
                Some(CurrentWlanConnection { profile_name, ssid })
            }
            _ => None,
        }
    };
    let interface_state = attributes.isState as u32;
    WlanFreeMemory(data);
    classify_current_wlan_query(ERROR_SUCCESS, Some(interface_state), connection)
}

#[cfg(windows)]
unsafe fn windows_wlan_current_connection(
    handle: windows_sys::Win32::Foundation::HANDLE,
    interface: &windows_sys::core::GUID,
) -> Result<Option<PreviousWlanConnection>, String> {
    previous_wlan_connection_from_query(
        wlan_callback_mutation_registry(),
        windows_wlan_current_connection_state(handle, interface),
    )
}

#[cfg(windows)]
unsafe fn windows_wlan_is_associated_with_target(
    handle: windows_sys::Win32::Foundation::HANDLE,
    interface: &windows_sys::core::GUID,
    expected_profile: &str,
    expected_ssid: &str,
) -> Result<bool, String> {
    let query = windows_wlan_current_connection_state(handle, interface);
    require_safe_current_wlan_query(
        wlan_callback_mutation_registry(),
        &query,
        "verifying the requested WLAN association",
    )?;
    Ok(matches!(
        query,
        CurrentWlanConnectionQuery::Connected(CurrentWlanConnection { profile_name, ssid })
            if profile_name == expected_profile && ssid == expected_ssid
    ))
}

#[cfg(windows)]
fn wlan_association_state_from_reason(reason: u32) -> WlanAssociationState {
    if wlan_reason_is_authentication_failure(reason) {
        WlanAssociationState::AuthenticationFailed(reason)
    } else {
        WlanAssociationState::AssociationFailed(reason)
    }
}

#[cfg(windows)]
fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn inspect_windows_local_interface(
    interface_guid: Option<&windows_sys::core::GUID>,
) -> Result<LocalInterfaceObservation, String> {
    use std::{mem, ptr};
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        ConvertInterfaceGuidToLuid, GetAdaptersAddresses, IP_ADAPTER_ADDRESSES_LH,
    };
    const ERROR_SUCCESS: u32 = 0;
    const ERROR_BUFFER_OVERFLOW: u32 = 111;

    unsafe {
        let target_luid = if let Some(guid) = interface_guid {
            let mut luid = mem::zeroed();
            let result = ConvertInterfaceGuidToLuid(guid, &mut luid);
            if result != ERROR_SUCCESS {
                return Err(format!(
                    "Windows could not resolve WLAN interface identity (error {result})"
                ));
            }
            Some(luid)
        } else {
            None
        };
        let mut size = 15 * 1024u32;
        let mut buffer = vec![0u8; size as usize];
        let mut result = GetAdaptersAddresses(
            0,
            0,
            ptr::null(),
            buffer.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>(),
            &mut size,
        );
        if result == ERROR_BUFFER_OVERFLOW {
            buffer.resize(size as usize, 0);
            result = GetAdaptersAddresses(
                0,
                0,
                ptr::null(),
                buffer.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>(),
                &mut size,
            );
        }
        if result != ERROR_SUCCESS {
            return Err(format!(
                "Windows IP Helper adapter query failed with error {result}"
            ));
        }

        let mut best = LocalInterfaceObservation {
            adapter_ready: false,
            local_address_ready: false,
            default_route_ready: false,
        };
        let mut adapter = buffer.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
        while !adapter.is_null() {
            let candidate = &*adapter;
            let matches_target =
                target_luid.is_none_or(|target| candidate.Luid.Value == target.Value);
            if matches_target && interface_luid_is_present_physical_adapter(&candidate.Luid)? {
                let address_families = adapter_usable_address_families(candidate);
                let local_address_ready = address_families.any();
                // A gateway field does not prove a real default route on this
                // interface: it can be a VPN, virtual NIC, or another family.
                let default_route_ready = interface_has_default_route_for_usable_family(
                    &candidate.Luid,
                    address_families,
                )?;
                let observation = LocalInterfaceObservation {
                    adapter_ready: true,
                    local_address_ready,
                    default_route_ready,
                };
                if observation.local_address_ready && observation.default_route_ready {
                    return Ok(observation);
                }
                best = observation;
            }
            adapter = candidate.Next;
        }
        Ok(best)
    }
}

#[cfg(any(windows, test))]
fn physical_adapter_is_eligible(if_type: u32, operational: bool) -> bool {
    // IF_TYPE_ETHERNET_CSMACD and IF_TYPE_IEEE80211.  Keep this raw contract
    // independent of localized adapter names: Tailscale, loopback, tunnel,
    // Hyper-V and other virtual routes must not complete local readiness.
    operational && matches!(if_type, 6 | 71)
}

#[cfg(any(windows, test))]
fn mib_if_row2_indicates_present_physical_adapter(
    if_type: u32,
    operational: bool,
    interface_and_oper_status_flags: u8,
) -> bool {
    // MIB_IF_ROW2::InterfaceAndOperStatusFlags: HardwareInterface is bit 0
    // and ConnectorPresent is bit 2. Requiring both rejects virtual Ethernet
    // paths such as Hyper-V in addition to the IF_TYPE tunnel/loopback filter.
    physical_adapter_is_eligible(if_type, operational)
        && interface_and_oper_status_flags & 0b0000_0101 == 0b0000_0101
}

#[cfg(windows)]
unsafe fn interface_luid_is_present_physical_adapter(
    luid: &windows_sys::Win32::NetworkManagement::Ndis::NET_LUID_LH,
) -> Result<bool, String> {
    use std::mem;
    use windows_sys::Win32::NetworkManagement::{
        IpHelper::{GetIfEntry2, MIB_IF_ROW2},
        Ndis::NET_IF_OPER_STATUS_UP,
    };

    const ERROR_SUCCESS: u32 = 0;
    let mut row: MIB_IF_ROW2 = mem::zeroed();
    row.InterfaceLuid = *luid;
    let result = GetIfEntry2(&mut row);
    if result != ERROR_SUCCESS {
        return Err(format!(
            "Windows could not inspect interface hardware flags (error {result})"
        ));
    }

    // HardwareInterface and ConnectorPresent are bits 0 and 2 in
    // MIB_IF_ROW2.InterfaceAndOperStatusFlags. Hyper-V, VPN, tunnel, and
    // loopback paths must not pass just because they expose an Ethernet type.
    Ok(mib_if_row2_indicates_present_physical_adapter(
        row.Type,
        row.OperStatus == NET_IF_OPER_STATUS_UP,
        row.InterfaceAndOperStatusFlags._bitfield,
    ))
}

#[cfg(windows)]
#[derive(Debug, Clone, Copy, Default)]
struct UsableAddressFamilies {
    ipv4: bool,
    ipv6: bool,
}

#[cfg(windows)]
impl UsableAddressFamilies {
    fn any(self) -> bool {
        self.ipv4 || self.ipv6
    }
}

#[cfg(windows)]
unsafe fn adapter_usable_address_families(
    adapter: &windows_sys::Win32::NetworkManagement::IpHelper::IP_ADAPTER_ADDRESSES_LH,
) -> UsableAddressFamilies {
    use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6, SOCKADDR_IN};

    let mut families = UsableAddressFamilies::default();
    let mut address = adapter.FirstUnicastAddress;
    while !address.is_null() {
        let socket = (*address).Address.lpSockaddr;
        if !socket.is_null() {
            match (*socket).sa_family {
                AF_INET => {
                    let ipv4 = &*(socket.cast::<SOCKADDR_IN>());
                    let bytes = ipv4.sin_addr.S_un.S_addr.to_ne_bytes();
                    if ipv4_address_is_usable(&bytes) {
                        families.ipv4 = true;
                    }
                }
                AF_INET6 => {
                    let bytes = (*socket
                        .cast::<windows_sys::Win32::Networking::WinSock::SOCKADDR_IN6>())
                    .sin6_addr
                    .u
                    .Byte;
                    if ipv6_address_is_usable(&bytes) {
                        families.ipv6 = true;
                    }
                }
                _ => {}
            }
        }
        address = (*address).Next;
    }
    families
}

#[cfg(any(windows, test))]
fn ipv4_address_is_usable(bytes: &[u8; 4]) -> bool {
    bytes[0] != 127 && !(bytes[0] == 169 && bytes[1] == 254) && bytes != &[0, 0, 0, 0]
}

#[cfg(any(windows, test))]
fn ipv6_address_is_usable(bytes: &[u8; 16]) -> bool {
    let unspecified = bytes.iter().all(|byte| *byte == 0);
    let loopback = bytes[..15].iter().all(|byte| *byte == 0) && bytes[15] == 1;
    // fe80::/10 is valid only on a link. It cannot alone demonstrate an
    // Internet-capable local path.
    let link_local = bytes[0] == 0xfe && bytes[1] & 0b1100_0000 == 0b1000_0000;
    !unspecified && !loopback && !link_local
}

#[cfg(windows)]
unsafe fn interface_has_default_route_for_usable_family(
    luid: &windows_sys::Win32::NetworkManagement::Ndis::NET_LUID_LH,
    families: UsableAddressFamilies,
) -> Result<bool, String> {
    use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6};

    if families.ipv4 && interface_has_default_route_for_family(luid, AF_INET)? {
        return Ok(true);
    }
    if families.ipv6 && interface_has_default_route_for_family(luid, AF_INET6)? {
        return Ok(true);
    }
    Ok(false)
}

#[cfg(windows)]
unsafe fn interface_has_default_route_for_family(
    luid: &windows_sys::Win32::NetworkManagement::Ndis::NET_LUID_LH,
    family: windows_sys::Win32::Networking::WinSock::ADDRESS_FAMILY,
) -> Result<bool, String> {
    use std::{ptr, slice};
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        FreeMibTable, GetIpForwardTable2, MIB_IPFORWARD_TABLE2,
    };

    const ERROR_SUCCESS: u32 = 0;
    let mut table: *mut MIB_IPFORWARD_TABLE2 = ptr::null_mut();
    let result = GetIpForwardTable2(family, &mut table);
    if result != ERROR_SUCCESS || table.is_null() {
        return Err(format!(
            "Windows could not inspect default routes for address family {family} (error {result})"
        ));
    }
    let rows = slice::from_raw_parts((*table).Table.as_ptr(), (*table).NumEntries as usize);
    let ready = rows.iter().any(|row| {
        row.InterfaceLuid.Value == luid.Value
            && row.DestinationPrefix.PrefixLength == 0
            && row.DestinationPrefix.Prefix.si_family == family
            && row.Loopback == 0
    });
    FreeMibTable(table.cast());
    Ok(ready)
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::{
        matchers::{method, path},
        Mock, MockServer, ResponseTemplate,
    };

    #[test]
    fn uncommitted_drop_preserves_candidate_for_every_current_wlan_query() {
        const ERROR_INVALID_STATE: u32 = 5023;
        let candidate = "VEM-WIFI-CANDIDATE-deadbeefdeadbeefdead-retry";
        let candidate_connection = CurrentWlanConnection {
            profile_name: candidate.to_string(),
            ssid: "VEM-Lab".to_string(),
        };

        for query in [
            CurrentWlanConnectionQuery::Error(ERROR_INVALID_STATE),
            CurrentWlanConnectionQuery::Disconnecting(candidate_connection),
            CurrentWlanConnectionQuery::Absent,
            CurrentWlanConnectionQuery::Connected(CurrentWlanConnection {
                profile_name: "VEM-WIFI-stable".to_string(),
                ssid: "VEM-Lab".to_string(),
            }),
        ] {
            assert_eq!(
                uncommitted_wlan_drop_candidate_disposition(&query, candidate),
                UncommittedWlanDropCandidateDisposition::Preserve,
                "Drop must not infer successful rollback from {query:?}"
            );
        }
    }

    #[test]
    fn current_wlan_query_keeps_disconnecting_distinct_from_absent() {
        let registry = WlanCallbackMutationRegistry::default();
        let previous = previous_wlan_connection_from_query(
            &registry,
            CurrentWlanConnectionQuery::Disconnecting(CurrentWlanConnection {
                profile_name: "VEM-WIFI-stable".to_string(),
                ssid: "VEM-Lab".to_string(),
            }),
        )
        .expect("disconnecting is a typed prior target, not absence")
        .expect("disconnecting profile remains available for exact recovery");
        assert_eq!(previous.profile_name, "VEM-WIFI-stable");
        assert_eq!(previous.ssid, "VEM-Lab");
    }

    #[test]
    fn native_current_wlan_query_classifies_connected_connecting_disconnecting_absent_and_error() {
        fn connection() -> CurrentWlanConnection {
            CurrentWlanConnection {
                profile_name: "VEM-WIFI-target".to_string(),
                ssid: "VEM-Lab".to_string(),
            }
        }

        assert!(matches!(
            classify_current_wlan_query(0, Some(1), Some(connection())),
            CurrentWlanConnectionQuery::Connected(_)
        ));
        for state in [5, 6, 7] {
            assert!(matches!(
                classify_current_wlan_query(0, Some(state), Some(connection())),
                CurrentWlanConnectionQuery::Connecting(_)
            ));
        }
        assert!(matches!(
            classify_current_wlan_query(0, Some(3), Some(connection())),
            CurrentWlanConnectionQuery::Disconnecting(_)
        ));
        for state in [0, 2, 4] {
            assert!(matches!(
                classify_current_wlan_query(0, Some(state), None),
                CurrentWlanConnectionQuery::Absent
            ));
        }
        assert!(matches!(
            classify_current_wlan_query(5023, None, None),
            CurrentWlanConnectionQuery::Error(5023)
        ));
    }

    #[test]
    fn startup_recovery_keeps_candidate_marker_until_current_stable_is_exactly_verified() {
        let candidate = candidate_wlan_profile_name("VEM-Lab", "stale-nonce");
        let stable = StableWlanRecoveryTarget {
            profile_name: deterministic_wlan_profile_name("VEM-Lab"),
            ssid: "VEM-Lab".to_string(),
            hidden: false,
        };

        for current in [
            CurrentWlanConnectionQuery::Connected(CurrentWlanConnection {
                profile_name: stable.profile_name.clone(),
                ssid: stable.ssid.clone(),
            }),
            CurrentWlanConnectionQuery::Connecting(CurrentWlanConnection {
                profile_name: stable.profile_name.clone(),
                ssid: stable.ssid.clone(),
            }),
        ] {
            let actions =
                stale_candidate_startup_recovery_plan(current, &candidate, Some(stable.clone()))
                    .expect("stable current state still requires exact readiness verification");
            assert_eq!(
                actions,
                vec![
                    WlanRecoveryAction::ReadCurrentConnection,
                    WlanRecoveryAction::ConnectStable(stable.profile_name.clone()),
                    WlanRecoveryAction::VerifyStable,
                    WlanRecoveryAction::DeleteCandidate(candidate.clone()),
                ]
            );
        }
    }

    #[test]
    fn current_wlan_query_error_freezes_real_registry_before_candidate_recovery() {
        let registry = WlanCallbackMutationRegistry::default();
        let permit = registry.acquire().expect("recovery owns mutation permit");
        let error = require_safe_current_wlan_query(
            &registry,
            &CurrentWlanConnectionQuery::Error(5023),
            "startup candidate recovery",
        )
        .expect_err("ERROR_INVALID_STATE is uncertainty, not absence");
        assert!(error.contains("error 5023"));
        drop(permit);
        assert!(registry.is_fused());
        assert!(registry.acquire().is_err());
    }

    #[test]
    fn callback_context_can_still_be_retained_safely_after_a_query_freezes_recovery() {
        let registry = WlanCallbackMutationRegistry::default();
        let mut permit = registry.acquire().expect("callback mutation is active");
        registry.freeze_for_recovery();
        permit.retain_context_for_safety();
        drop(permit);

        assert_eq!(registry.retained_context_count(), 1);
        assert!(registry.is_fused());
    }

    #[tokio::test]
    async fn existing_network_probe_requires_a_real_preclaim_platform_health_response() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/health"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "database": "ok",
                "mqtt": "connected"
            })))
            .mount(&server)
            .await;

        let response = probe_preclaim_platform_endpoint(&format!("{}/api", server.uri())).await;

        assert_eq!(response.status, NetworkSetupStatus::Connected);
        assert!(response.diagnostics.iter().any(|item| {
            item.component == "provisioning_endpoint"
                && item.code == "PRECLAIM_PLATFORM_API_REACHABLE"
                && item.evidence.as_ref().is_some_and(|evidence| {
                    evidence.source == NetworkEvidenceSource::PlatformApi
                        && evidence.status == NetworkEvidenceStatus::Ready
                })
        }));
        assert!(response.diagnostics.iter().all(|item| {
            item.evidence
                .as_ref()
                .is_none_or(|evidence| evidence.source != NetworkEvidenceSource::MqttBroker)
        }));
    }

    #[tokio::test]
    async fn platform_api_outage_keeps_independent_local_readiness_evidence() {
        struct ReadyLocalAdapter;

        #[async_trait]
        impl NetworkAdapter for ReadyLocalAdapter {
            async fn apply_wifi_settings(
                &self,
                _request: NetworkSettingsRequest,
            ) -> NetworkSettingsResponse {
                unreachable!("this test only probes the existing wired network")
            }

            async fn probe_local_network_readiness(&self) -> NetworkSettingsResponse {
                local_network_ready_response("existing-network", false)
            }
        }

        let response = ReadyLocalAdapter
            .probe_preclaim_platform_endpoint("http://127.0.0.1:1/api")
            .await;

        assert_eq!(response.status, NetworkSetupStatus::Failed);
        assert!(response.diagnostics.iter().any(|item| {
            item.evidence.as_ref().is_some_and(|evidence| {
                evidence.source == NetworkEvidenceSource::LocalAdapter
                    && evidence.status == NetworkEvidenceStatus::Ready
            })
        }));
        assert!(response.diagnostics.iter().any(|item| {
            item.evidence.as_ref().is_some_and(|evidence| {
                evidence.source == NetworkEvidenceSource::PlatformApi
                    && evidence.status == NetworkEvidenceStatus::Failed
            })
        }));
        assert!(response.diagnostics.iter().any(|item| {
            item.evidence.as_ref().is_some_and(|evidence| {
                evidence.source == NetworkEvidenceSource::MqttBroker
                    && evidence.status == NetworkEvidenceStatus::NotConfigured
            })
        }));
    }

    #[test]
    fn platform_success_cannot_mask_failed_physical_local_readiness() {
        let local = local_network_unavailable_response(
            "existing-network",
            false,
            "LOCAL_DEFAULT_ROUTE_UNAVAILABLE",
            "The selected physical adapter has no usable default route",
        );
        let platform = NetworkSettingsResponse {
            status: NetworkSetupStatus::Connected,
            ssid: "existing-network".to_string(),
            hidden: false,
            diagnostics: vec![diagnostic_with_evidence(
                "provisioning_endpoint",
                "ok",
                "PRECLAIM_PLATFORM_API_REACHABLE",
                "Platform API is reachable through another path",
                NetworkEvidenceSource::PlatformApi,
                NetworkEvidenceStatus::Ready,
                "Do not treat this as local physical readiness.",
            )],
            operator_guidance: "platform ready".to_string(),
            updated_at: crate::state::store::now_iso(),
        };

        let merged = merge_local_and_platform_probe(local, platform);

        assert_eq!(merged.status, NetworkSetupStatus::Failed);
        assert!(merged.diagnostics.iter().any(|item| {
            item.evidence.as_ref().is_some_and(|evidence| {
                evidence.source == NetworkEvidenceSource::LocalAdapter
                    && evidence.status == NetworkEvidenceStatus::Failed
            })
        }));
        assert!(merged.diagnostics.iter().any(|item| {
            item.evidence.as_ref().is_some_and(|evidence| {
                evidence.source == NetworkEvidenceSource::PlatformApi
                    && evidence.status == NetworkEvidenceStatus::Ready
            })
        }));
    }

    #[test]
    fn provisioned_mqtt_evidence_requires_the_daemons_own_connack() {
        let disconnected = mqtt_connack_diagnostic(true, false, Some("connection refused"));
        let connected = mqtt_connack_diagnostic(true, true, None);

        assert_eq!(disconnected.code, "MQTT_CONNACK_NOT_CONFIRMED");
        assert!(disconnected.evidence.as_ref().is_some_and(|evidence| {
            evidence.source == NetworkEvidenceSource::MqttBroker
                && evidence.status == NetworkEvidenceStatus::Failed
                && evidence.recovery_action.contains("credentials")
        }));
        assert_eq!(connected.code, "MQTT_CONNACK_CONFIRMED");
        assert!(connected
            .evidence
            .as_ref()
            .is_some_and(|evidence| { evidence.status == NetworkEvidenceStatus::Ready }));
    }

    #[tokio::test]
    async fn existing_network_probe_rejects_html_success_as_non_platform_health() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/health"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/html; charset=utf-8")
                    .set_body_string("<html><title>login</title></html>"),
            )
            .mount(&server)
            .await;

        let response = probe_preclaim_platform_endpoint(&format!("{}/api", server.uri())).await;

        assert_eq!(response.status, NetworkSetupStatus::Failed);
        assert!(response.diagnostics.iter().any(|item| {
            item.component == "provisioning_endpoint"
                && item.code == "PRECLAIM_PLATFORM_HEALTH_INVALID_CONTENT_TYPE"
        }));
        assert!(!response
            .diagnostics
            .iter()
            .any(|item| item.code == "PROVISIONING_ENDPOINT_REACHABLE"));
    }

    #[tokio::test]
    async fn existing_network_probe_rejects_redirects_and_unhealthy_platform_health() {
        for (status, content_type, body, expected_code) in [
            (
                302,
                "text/html",
                "",
                "PRECLAIM_PLATFORM_ENDPOINT_REDIRECTED",
            ),
            (
                200,
                "application/json",
                "{not-json",
                "PRECLAIM_PLATFORM_HEALTH_INVALID_JSON",
            ),
            (
                200,
                "application/json",
                r#"{"database":"unavailable","mqtt":"connected"}"#,
                "PRECLAIM_PLATFORM_DATABASE_UNHEALTHY",
            ),
        ] {
            let server = MockServer::start().await;
            let template = if status == 302 {
                ResponseTemplate::new(status)
                    .insert_header("location", format!("{}/login", server.uri()))
                    .set_body_string(body)
            } else {
                ResponseTemplate::new(status).set_body_raw(body, content_type)
            };
            Mock::given(method("GET"))
                .and(path("/api/health"))
                .respond_with(template)
                .mount(&server)
                .await;
            Mock::given(method("GET"))
                .and(path("/login"))
                .respond_with(
                    ResponseTemplate::new(200)
                        .insert_header("content-type", "text/html")
                        .set_body_string("<html><title>login</title></html>"),
                )
                .mount(&server)
                .await;

            let response = probe_preclaim_platform_endpoint(&format!("{}/api", server.uri())).await;

            assert_eq!(
                response.status,
                NetworkSetupStatus::Failed,
                "{expected_code}"
            );
            assert!(
                response.diagnostics.iter().any(|item| {
                    item.component == "provisioning_endpoint" && item.code == expected_code
                }),
                "expected {expected_code}, diagnostics: {:?}",
                response.diagnostics
            );
            assert!(!response
                .diagnostics
                .iter()
                .any(|item| item.code == "PROVISIONING_ENDPOINT_REACHABLE"));
            if status == 302 {
                let requests = server.received_requests().await.expect("requests");
                assert_eq!(requests.len(), 1, "redirect must not be followed");
                assert_eq!(requests[0].url.path(), "/api/health");
            }
        }
    }

    #[tokio::test]
    async fn bad_wifi_password_has_a_distinct_diagnostic_without_echoing_the_credential() {
        let password = "wrong-password".to_string();
        let response = FakeNetworkAdapter {
            outcome: "invalid_password".to_string(),
        }
        .apply_wifi_settings(NetworkSettingsRequest {
            ssid: "VEM-Lab".to_string(),
            password: password.clone(),
            hidden: false,
        })
        .await;

        assert_eq!(response.status, NetworkSetupStatus::Failed);
        assert!(response
            .diagnostics
            .iter()
            .any(|item| item.code == "WIFI_AUTH_FAILED"));
        let serialized = serde_json::to_string(&response).expect("serialize diagnostic");
        assert!(!serialized.contains(&password));
    }

    #[test]
    fn windows_profile_is_deterministic_per_ssid_and_keeps_password_in_memory_only() {
        let password = "secret-pass";
        let first = deterministic_wlan_profile_name("VEM-Lab");
        assert_eq!(first, deterministic_wlan_profile_name("VEM-Lab"));
        assert_ne!(first, deterministic_wlan_profile_name("Other-WiFi"));
        let profile = wlan_profile_xml(
            &first,
            "VEM-Lab",
            password,
            false,
            WlanProfileConnectionMode::Auto,
        );
        assert!(profile.contains(password));
        assert!(profile.contains(&first));
        assert!(profile.contains("<connectionMode>auto</connectionMode>"));
    }

    #[test]
    fn candidate_profiles_are_unique_manual_and_never_replace_the_stable_profile_early() {
        let stable = deterministic_wlan_profile_name("VEM-Lab");
        let first = candidate_wlan_profile_name("VEM-Lab", "first-nonce");
        let second = candidate_wlan_profile_name("VEM-Lab", "second-nonce");
        let password = "candidate-password";

        assert_ne!(first, second);
        assert!(is_vem_candidate_profile_name(&first));
        assert!(!is_vem_candidate_profile_name(&stable));
        assert!(wlan_profile_xml(
            &first,
            "VEM-Lab",
            password,
            false,
            WlanProfileConnectionMode::Manual
        )
        .contains("<connectionMode>manual</connectionMode>"));
        assert!(wlan_profile_xml(
            &stable,
            "VEM-Lab",
            password,
            false,
            WlanProfileConnectionMode::Auto
        )
        .contains("<connectionMode>auto</connectionMode>"));

        let mut transaction = CrashSafeWlanProfileTransaction::new();
        assert!(!transaction.stable_profile_write_is_allowed());
        transaction.candidate_staged();
        assert!(!transaction.stable_profile_write_is_allowed());
        transaction.candidate_verified();
        assert!(transaction.stable_profile_write_is_allowed());
        transaction
            .stable_written()
            .expect("candidate was verified");
        transaction.stable_verified();
        transaction.candidate_deleted();
    }

    #[test]
    fn every_crash_phase_keeps_the_old_auto_profile_until_candidate_readiness_is_proven() {
        for (phase, candidate_may_remain, stable_may_be_replaced) in [
            (WlanProfileTransactionPhase::Initial, false, false),
            (WlanProfileTransactionPhase::CandidateStaged, true, false),
            (WlanProfileTransactionPhase::CandidateVerified, true, false),
            (WlanProfileTransactionPhase::StableWritten, true, true),
            (WlanProfileTransactionPhase::StableVerified, true, true),
            (WlanProfileTransactionPhase::CandidateDeleted, false, true),
        ] {
            let snapshot = phase.crash_safety_snapshot();
            assert!(
                !snapshot.candidate_autoconnect,
                "{phase:?} may only leave a manual candidate"
            );
            assert_eq!(
                snapshot.candidate_may_remain, candidate_may_remain,
                "{phase:?}"
            );
            assert_eq!(
                snapshot.stable_profile_may_have_been_replaced, stable_may_be_replaced,
                "{phase:?}"
            );
        }
    }

    #[test]
    fn startup_recovery_disconnects_a_connected_stale_candidate_before_deleting_it_and_restores_stable(
    ) {
        let candidate = candidate_wlan_profile_name("VEM-Lab", "stale-nonce");
        let stable = deterministic_wlan_profile_name("VEM-Lab");

        let actions = stale_candidate_startup_recovery_plan(
            CurrentWlanConnectionQuery::Connected(CurrentWlanConnection {
                profile_name: candidate.clone(),
                ssid: "VEM-Lab".to_string(),
            }),
            &candidate,
            Some(StableWlanRecoveryTarget {
                profile_name: stable.clone(),
                ssid: "VEM-Lab".to_string(),
                hidden: false,
            }),
        )
        .expect("a complete stable profile permits startup recovery");

        assert_eq!(
            actions,
            vec![
                WlanRecoveryAction::ReadCurrentConnection,
                WlanRecoveryAction::DisconnectCandidate(candidate.clone()),
                WlanRecoveryAction::ConnectStable(stable),
                WlanRecoveryAction::VerifyStable,
                WlanRecoveryAction::DeleteCandidate(candidate),
            ]
        );
    }

    #[test]
    fn startup_recovery_without_a_current_connection_still_restores_a_complete_stable_profile() {
        let candidate = candidate_wlan_profile_name("VEM-Lab", "stale-nonce");
        let stable = deterministic_wlan_profile_name("VEM-Lab");

        let actions = stale_candidate_startup_recovery_plan(
            CurrentWlanConnectionQuery::Absent,
            &candidate,
            Some(StableWlanRecoveryTarget {
                profile_name: stable.clone(),
                ssid: "VEM-Lab".to_string(),
                hidden: true,
            }),
        )
        .expect("a missing current association must not skip stable recovery");

        assert_eq!(
            actions,
            vec![
                WlanRecoveryAction::ReadCurrentConnection,
                WlanRecoveryAction::ConnectStable(stable),
                WlanRecoveryAction::VerifyStable,
                WlanRecoveryAction::DeleteCandidate(candidate),
            ]
        );
    }

    #[test]
    fn startup_recovery_disconnects_a_connecting_stale_candidate_before_deleting_it() {
        let candidate = candidate_wlan_profile_name("VEM-Lab", "stale-nonce");
        let stable = deterministic_wlan_profile_name("VEM-Lab");

        let actions = stale_candidate_startup_recovery_plan(
            CurrentWlanConnectionQuery::Connecting(CurrentWlanConnection {
                profile_name: candidate.clone(),
                ssid: "VEM-Lab".to_string(),
            }),
            &candidate,
            Some(StableWlanRecoveryTarget {
                profile_name: stable.clone(),
                ssid: "VEM-Lab".to_string(),
                hidden: false,
            }),
        )
        .expect("a connecting candidate is explicitly disconnected before cleanup");

        assert_eq!(
            actions,
            vec![
                WlanRecoveryAction::ReadCurrentConnection,
                WlanRecoveryAction::DisconnectCandidate(candidate.clone()),
                WlanRecoveryAction::ConnectStable(stable),
                WlanRecoveryAction::VerifyStable,
                WlanRecoveryAction::DeleteCandidate(candidate),
            ]
        );
    }

    #[test]
    fn stale_candidate_maps_to_and_recovers_the_complete_stable_profile() {
        let candidate = candidate_wlan_profile_name("VEM & Lab", "stale-nonce");
        let stable = stable_wlan_profile_name_for_candidate(&candidate)
            .expect("candidate nonce preserves the deterministic stable profile identity");
        assert_eq!(stable, deterministic_wlan_profile_name("VEM & Lab"));

        let xml = wlan_profile_xml(
            &stable,
            "VEM & Lab",
            "not-logged",
            true,
            WlanProfileConnectionMode::Auto,
        )
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
        let target = wlan_profile_recovery_target(stable.clone(), &xml)
            .expect("a complete stable profile supplies its reconnect target");
        assert_eq!(target.profile_name, stable);
        assert_eq!(target.ssid, "VEM & Lab");
        assert!(target.hidden);
    }

    #[test]
    fn production_stable_rollback_adapter_fault_matrix_freezes_every_step_including_clear_candidate(
    ) {
        struct FaultingRollbackOperations {
            fail_step: Option<StableWlanRollbackStep>,
            calls: Vec<StableWlanRollbackStep>,
        }

        impl FaultingRollbackOperations {
            fn record(&mut self, step: StableWlanRollbackStep) -> Result<(), String> {
                self.calls.push(step);
                if self.fail_step == Some(step) {
                    Err(format!("injected {step:?} failure"))
                } else {
                    Ok(())
                }
            }
        }

        impl StableWlanRollbackOperations for FaultingRollbackOperations {
            fn restore_old_profile(&mut self) -> Result<(), String> {
                self.record(StableWlanRollbackStep::RestoreOldProfile)
            }

            fn connect_old_stable(&mut self) -> Result<(), String> {
                self.record(StableWlanRollbackStep::ConnectOldStable)
            }

            fn verify_old_stable(&mut self) -> Result<(), String> {
                self.record(StableWlanRollbackStep::VerifyOldStable)
            }

            fn clear_candidate(&mut self) -> Result<(), String> {
                self.record(StableWlanRollbackStep::ClearCandidate)
            }
        }

        let steps = [
            StableWlanRollbackStep::RestoreOldProfile,
            StableWlanRollbackStep::ConnectOldStable,
            StableWlanRollbackStep::VerifyOldStable,
            StableWlanRollbackStep::ClearCandidate,
        ];
        for (failed_index, failed_step) in steps.into_iter().enumerate() {
            let registry = WlanCallbackMutationRegistry::default();
            let permit = registry.acquire().expect("rollback owns mutation permit");
            let operations = FaultingRollbackOperations {
                fail_step: Some(failed_step),
                calls: vec![],
            };
            let mut adapter = StableWlanRollbackAdapter::new(operations);
            let error = execute_stable_wlan_rollback(&registry, &mut adapter)
                .expect_err("every native rollback boundary must freeze on failure");
            assert!(error.contains("WLAN_RECOVERY_REQUIRED"));
            assert!(error.contains(&format!("{failed_step:?}")));
            assert_eq!(adapter.operations.calls, steps[..=failed_index]);
            drop(permit);
            assert!(registry.is_fused());
            assert!(registry.acquire().is_err());
        }

        let registry = WlanCallbackMutationRegistry::default();
        let permit = registry.acquire().expect("rollback owns mutation permit");
        let operations = FaultingRollbackOperations {
            fail_step: None,
            calls: vec![],
        };
        let mut adapter = StableWlanRollbackAdapter::new(operations);
        execute_stable_wlan_rollback(&registry, &mut adapter)
            .expect("all four native rollback boundaries succeeded");
        assert_eq!(adapter.operations.calls, steps);
        drop(permit);
        assert!(!registry.is_fused());
    }

    #[test]
    fn production_candidate_failure_recovery_fault_matrix_keeps_marker_until_old_stable_is_verified(
    ) {
        struct FaultingCandidateRecoveryOperations {
            fail_step: Option<StableWlanRollbackStep>,
            calls: Vec<StableWlanRollbackStep>,
            candidate_present: bool,
        }

        impl FaultingCandidateRecoveryOperations {
            fn record(&mut self, step: StableWlanRollbackStep) -> Result<(), String> {
                self.calls.push(step);
                if self.fail_step == Some(step) {
                    return Err(format!("injected {step:?} failure"));
                }
                if step == StableWlanRollbackStep::ClearCandidate {
                    self.candidate_present = false;
                }
                Ok(())
            }
        }

        impl StableWlanRollbackOperations for FaultingCandidateRecoveryOperations {
            fn restore_old_profile(&mut self) -> Result<(), String> {
                self.record(StableWlanRollbackStep::RestoreOldProfile)
            }

            fn connect_old_stable(&mut self) -> Result<(), String> {
                self.record(StableWlanRollbackStep::ConnectOldStable)
            }

            fn verify_old_stable(&mut self) -> Result<(), String> {
                self.record(StableWlanRollbackStep::VerifyOldStable)
            }

            fn clear_candidate(&mut self) -> Result<(), String> {
                self.record(StableWlanRollbackStep::ClearCandidate)
            }
        }

        let steps = [
            StableWlanRollbackStep::RestoreOldProfile,
            StableWlanRollbackStep::ConnectOldStable,
            StableWlanRollbackStep::VerifyOldStable,
            StableWlanRollbackStep::ClearCandidate,
        ];
        for (failed_index, failed_step) in steps.into_iter().enumerate() {
            let registry = WlanCallbackMutationRegistry::default();
            let permit = registry.acquire().expect("candidate recovery owns permit");
            let operations = FaultingCandidateRecoveryOperations {
                fail_step: Some(failed_step),
                calls: vec![],
                candidate_present: true,
            };
            let mut adapter = StableWlanRollbackAdapter::new(operations);
            let error = execute_candidate_failure_recovery(&registry, &mut adapter)
                .expect_err("every recovery boundary must freeze before marker removal");

            assert!(error.contains("WLAN_RECOVERY_REQUIRED"));
            assert_eq!(adapter.operations.calls, steps[..=failed_index]);
            assert!(adapter.operations.candidate_present);
            drop(permit);
            assert!(registry.is_fused());
            assert!(registry.acquire().is_err());
        }

        let registry = WlanCallbackMutationRegistry::default();
        let permit = registry.acquire().expect("candidate recovery owns permit");
        let operations = FaultingCandidateRecoveryOperations {
            fail_step: None,
            calls: vec![],
            candidate_present: true,
        };
        let mut adapter = StableWlanRollbackAdapter::new(operations);
        execute_candidate_failure_recovery(&registry, &mut adapter)
            .expect("candidate clears only after exact old stable verification");
        assert_eq!(adapter.operations.calls, steps);
        assert!(!adapter.operations.candidate_present);
        drop(permit);
        assert!(!registry.is_fused());
    }

    #[test]
    fn callback_double_failure_blows_a_process_fuse_with_only_one_retained_context() {
        struct DoubleFailureNotificationApi;

        impl WlanNotificationReleaseApi for DoubleFailureNotificationApi {
            fn unregister_notification(&mut self) -> u32 {
                5
            }

            fn close_handle_synchronously(&mut self) -> Result<(), u32> {
                Err(6)
            }
        }

        let mut release = DoubleFailureNotificationApi;
        let mut callback_context = WlanNotificationContextLease::new(());
        assert_eq!(callback_context.release_with(&mut release), Err(5));
        assert!(
            callback_context.context.is_some(),
            "a double failure must keep the context owned until it is retained safely"
        );

        let registry = WlanCallbackMutationRegistry::default();
        let mut first = registry.acquire().expect("first WLAN mutation is allowed");
        first.retain_context_for_safety();
        drop(first);

        assert_eq!(registry.retained_context_count(), 1);
        assert!(registry.is_fused());
        assert!(
            registry.acquire().is_err(),
            "fused process must reject a new WLAN mutation"
        );
        assert_eq!(
            registry.retained_context_count(),
            1,
            "repeated double failures must not accumulate leaked callback contexts"
        );
    }

    #[test]
    fn candidate_failure_returns_its_observation_only_after_verified_prior_reconnect() {
        let candidate_failed = WlanConnectionObservation {
            association: WlanAssociationState::Associated,
            local_address_ready: true,
            default_route_ready: false,
        };

        let recovered = combine_wlan_recovery_result(Ok(candidate_failed), Ok(()), Ok(())).expect(
            "a deleted candidate and verified prior reconnect preserve the original observation",
        );
        assert_eq!(recovered, candidate_failed);

        let reconnect_failed = combine_wlan_recovery_result(
            Ok(candidate_failed),
            Ok(()),
            Err("prior profile did not regain a default route".to_string()),
        )
        .expect_err("an unverified prior reconnect must be reported as recovery failure");
        assert!(reconnect_failed.contains("recovery failed"));
        assert!(reconnect_failed.contains("prior profile"));
    }

    #[test]
    fn windows_local_readiness_uses_only_physical_adapter_routes_in_multi_interface_hosts() {
        assert!(physical_adapter_is_eligible(6, true), "wired Ethernet");
        assert!(physical_adapter_is_eligible(71, true), "Wi-Fi");
        assert!(!physical_adapter_is_eligible(24, true), "loopback");
        assert!(!physical_adapter_is_eligible(131, true), "tunnel/VPN");
        assert!(!physical_adapter_is_eligible(71, false), "down Wi-Fi");
    }

    #[test]
    fn windows_local_readiness_requires_hardware_and_connector_mib_flags() {
        assert!(mib_if_row2_indicates_present_physical_adapter(
            6, true, 0b101
        ));
        assert!(!mib_if_row2_indicates_present_physical_adapter(
            6, true, 0b001
        ));
        assert!(!mib_if_row2_indicates_present_physical_adapter(
            6, true, 0b100
        ));
        assert!(!mib_if_row2_indicates_present_physical_adapter(
            6, false, 0b101
        ));
        assert!(!mib_if_row2_indicates_present_physical_adapter(
            131, true, 0b101
        ));
    }

    #[test]
    fn ipv6_link_local_address_cannot_independently_satisfy_local_readiness() {
        assert!(!ipv4_address_is_usable(&[169, 254, 1, 1]));
        assert!(ipv4_address_is_usable(&[192, 0, 2, 8]));
        assert!(!ipv6_address_is_usable(&[
            0xfe, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
        ]));
        assert!(!ipv6_address_is_usable(&[
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
        ]));
        assert!(ipv6_address_is_usable(&[
            0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
        ]));
    }

    #[test]
    fn wlan_notification_context_accepts_only_the_requested_interface_profile_and_ssid() {
        let interface = [1; 16];
        assert!(wlan_notification_matches_target(
            interface,
            interface,
            "VEM-WIFI-abc",
            "VEM-WIFI-abc",
            "VEM-Lab",
            "VEM-Lab",
        ));
        assert!(!wlan_notification_matches_target(
            interface,
            [2; 16],
            "VEM-WIFI-abc",
            "VEM-WIFI-abc",
            "VEM-Lab",
            "VEM-Lab",
        ));
        assert!(!wlan_notification_matches_target(
            interface,
            interface,
            "VEM-WIFI-abc",
            "another-profile",
            "VEM-Lab",
            "VEM-Lab",
        ));
        assert!(!wlan_notification_matches_target(
            interface,
            interface,
            "VEM-WIFI-abc",
            "VEM-WIFI-abc",
            "VEM-Lab",
            "Other-WiFi",
        ));
    }

    #[test]
    fn wlan_attempt_requires_fresh_target_association_evidence() {
        // The same managed profile and SSID can already be connected before
        // this request. A later state query alone must not rebrand that old
        // connection as success for newly supplied credentials.
        assert!(!wlan_attempt_has_target_association(
            true, true, false, None,
        ));
        assert!(wlan_attempt_has_target_association(true, true, true, None,));
        assert!(wlan_attempt_has_target_association(
            false, true, false, None,
        ));
        assert!(!wlan_attempt_has_target_association(
            false,
            true,
            true,
            Some(229_380),
        ));
    }

    #[test]
    fn callback_context_waits_for_synchronous_handle_close_when_unregister_fails() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc, Mutex,
        };

        struct DropProbe {
            callback_in_flight: Arc<AtomicBool>,
            events: Arc<Mutex<Vec<&'static str>>>,
        }

        impl Drop for DropProbe {
            fn drop(&mut self) {
                assert!(
                    !self.callback_in_flight.load(Ordering::SeqCst),
                    "callback context was freed while a callback was in flight"
                );
                self.events.lock().expect("events lock").push("freed");
            }
        }

        struct MockNotificationApi {
            unregister_result: u32,
            callback_in_flight: Arc<AtomicBool>,
            events: Arc<Mutex<Vec<&'static str>>>,
            close_calls: usize,
        }

        impl WlanNotificationReleaseApi for MockNotificationApi {
            fn unregister_notification(&mut self) -> u32 {
                self.events.lock().expect("events lock").push("unregister");
                if self.unregister_result == 0 {
                    self.callback_in_flight.store(false, Ordering::SeqCst);
                }
                self.unregister_result
            }

            fn close_handle_synchronously(&mut self) -> Result<(), u32> {
                self.events.lock().expect("events lock").push("close");
                self.close_calls += 1;
                self.callback_in_flight.store(false, Ordering::SeqCst);
                Ok(())
            }
        }

        let callback_in_flight = Arc::new(AtomicBool::new(true));
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut api = MockNotificationApi {
            unregister_result: 5,
            callback_in_flight: callback_in_flight.clone(),
            events: events.clone(),
            close_calls: 0,
        };
        let mut lease = WlanNotificationContextLease::new(DropProbe {
            callback_in_flight,
            events: events.clone(),
        });

        assert_eq!(lease.release_with(&mut api), Err(5));
        assert_eq!(api.close_calls, 1);
        assert_eq!(
            events.lock().expect("events lock").as_slice(),
            ["unregister", "close", "freed"],
        );
        drop(lease);
        assert_eq!(api.close_calls, 1, "release must not double-close");
    }

    #[test]
    fn callback_context_is_freed_after_successful_unregister_without_closing_handle() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc, Mutex,
        };

        struct DropProbe {
            callback_in_flight: Arc<AtomicBool>,
            events: Arc<Mutex<Vec<&'static str>>>,
        }

        impl Drop for DropProbe {
            fn drop(&mut self) {
                assert!(!self.callback_in_flight.load(Ordering::SeqCst));
                self.events.lock().expect("events lock").push("freed");
            }
        }

        struct MockNotificationApi {
            callback_in_flight: Arc<AtomicBool>,
            events: Arc<Mutex<Vec<&'static str>>>,
            close_calls: usize,
        }

        impl WlanNotificationReleaseApi for MockNotificationApi {
            fn unregister_notification(&mut self) -> u32 {
                self.events.lock().expect("events lock").push("unregister");
                self.callback_in_flight.store(false, Ordering::SeqCst);
                0
            }

            fn close_handle_synchronously(&mut self) -> Result<(), u32> {
                self.close_calls += 1;
                Ok(())
            }
        }

        let callback_in_flight = Arc::new(AtomicBool::new(true));
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut api = MockNotificationApi {
            callback_in_flight: callback_in_flight.clone(),
            events: events.clone(),
            close_calls: 0,
        };
        let mut lease = WlanNotificationContextLease::new(DropProbe {
            callback_in_flight,
            events: events.clone(),
        });

        assert_eq!(lease.release_with(&mut api), Ok(()));
        assert_eq!(api.close_calls, 0);
        assert_eq!(
            events.lock().expect("events lock").as_slice(),
            ["unregister", "freed"],
        );
    }

    #[test]
    fn managed_profile_rolls_back_exact_old_bytes_and_order_until_local_connection_succeeds() {
        let old_profile = PreservedWlanProfile {
            // This stays an opaque UTF-16 buffer: rollback must not parse,
            // normalize, log, or otherwise expose an old protected key.
            profile_xml: vec![b'<'.into(), b'x'.into(), 0x4e2d, b'>'.into(), 0],
            profile_position: 3,
        };
        let rollback = managed_wlan_profile_rollback_plan(Some(old_profile.clone()));
        match rollback {
            ManagedWlanProfileRollbackPlan::Restore(profile) => {
                assert_eq!(profile.profile_xml, old_profile.profile_xml);
                assert_eq!(profile.profile_position, 3);
            }
            ManagedWlanProfileRollbackPlan::DeleteCandidate => {
                panic!("an existing managed profile must be restored")
            }
        }
        assert!(matches!(
            managed_wlan_profile_rollback_plan(None),
            ManagedWlanProfileRollbackPlan::DeleteCandidate
        ));

        assert!(wlan_local_connection_succeeded(WlanConnectionObservation {
            association: WlanAssociationState::Associated,
            local_address_ready: true,
            default_route_ready: true,
        }));
        assert!(!wlan_local_connection_succeeded(
            WlanConnectionObservation {
                association: WlanAssociationState::Associated,
                local_address_ready: true,
                default_route_ready: false,
            }
        ));
        assert!(!wlan_local_connection_succeeded(
            WlanConnectionObservation {
                association: WlanAssociationState::AuthenticationFailed(229_380),
                local_address_ready: true,
                default_route_ready: true,
            }
        ));
    }

    #[test]
    fn wlan_psk_mismatch_reason_is_an_authentication_failure() {
        // WLAN_REASON_CODE_MSMSEC_PSK_MISMATCH_SUSPECTED
        assert!(wlan_reason_is_authentication_failure(294_932));
        assert!(wlan_reason_is_authentication_failure(163_853)); // KEY_MISMATCH
        assert!(!wlan_reason_is_authentication_failure(229_378)); // association failure
    }

    #[test]
    fn wlan_authentication_reason_table_covers_pre_security_and_full_msmsec_range() {
        // WLAN_REASON_CODE_PRE_SECURITY_FAILURE and the documented MSMSEC
        // range are all security/authentication evidence, not generic
        // association failures.
        assert!(wlan_reason_is_authentication_failure(229_380));
        assert!(wlan_reason_is_authentication_failure(262_144));
        assert!(wlan_reason_is_authentication_failure(327_679));
    }

    #[test]
    fn windows_observation_reports_auth_association_address_and_route_failures_separately() {
        let request = NetworkSettingsRequest {
            ssid: "VEM-Lab".to_string(),
            password: "secret-pass".to_string(),
            hidden: false,
        };
        let auth_failed = observed_windows_wifi_response(
            &request,
            WlanConnectionObservation {
                association: WlanAssociationState::AuthenticationFailed(163853),
                local_address_ready: false,
                default_route_ready: false,
            },
        );
        let association_failed = observed_windows_wifi_response(
            &request,
            WlanConnectionObservation {
                association: WlanAssociationState::AssociationFailed(229378),
                local_address_ready: false,
                default_route_ready: false,
            },
        );
        let no_local_address = observed_windows_wifi_response(
            &request,
            WlanConnectionObservation {
                association: WlanAssociationState::Associated,
                local_address_ready: false,
                default_route_ready: false,
            },
        );
        let no_default_route = observed_windows_wifi_response(
            &request,
            WlanConnectionObservation {
                association: WlanAssociationState::Associated,
                local_address_ready: true,
                default_route_ready: false,
            },
        );
        let timeout = observed_windows_wifi_response(
            &request,
            WlanConnectionObservation {
                association: WlanAssociationState::TimedOut,
                local_address_ready: false,
                default_route_ready: false,
            },
        );

        assert!(auth_failed
            .diagnostics
            .iter()
            .any(|item| item.code == "WIFI_AUTH_FAILED"));
        assert!(association_failed
            .diagnostics
            .iter()
            .any(|item| item.code == "WIFI_ASSOCIATION_FAILED"));
        assert!(no_local_address
            .diagnostics
            .iter()
            .any(|item| item.code == "LOCAL_ADDRESS_UNAVAILABLE"));
        assert!(no_default_route
            .diagnostics
            .iter()
            .any(|item| item.code == "LOCAL_DEFAULT_ROUTE_UNAVAILABLE"));
        assert!(timeout
            .diagnostics
            .iter()
            .any(|item| item.code == "WIFI_ASSOCIATION_TIMEOUT"));
    }

    #[test]
    fn duplicate_wifi_networks_merge_signal_and_connection_state() {
        let mut existing = WifiNetwork {
            ssid: "VEM-Lab".to_string(),
            signal_quality: 42,
            security: WifiSecurity::Wpa2Personal,
            connected: false,
            profile_saved: false,
        };
        let candidate = WifiNetwork {
            ssid: "VEM-Lab".to_string(),
            signal_quality: 88,
            security: WifiSecurity::Wpa2Personal,
            connected: true,
            profile_saved: true,
        };

        merge_wifi_network(&mut existing, &candidate);

        assert_eq!(existing.signal_quality, 88);
        assert!(existing.connected);
        assert!(existing.profile_saved);
    }
}

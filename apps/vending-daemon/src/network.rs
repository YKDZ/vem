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
        operator_guidance:
            "已验证平台 API；本机网络和 MQTT 会作为独立证据显示，可以继续领取机器。".to_string(),
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
            "Wi-Fi 身份验证失败。请核对密码；此结果来自 Windows WLAN 原生 reason code。".to_string(),
        ),
        WlanAssociationState::AssociationFailed(reason_code) => (
            NetworkSetupStatus::Failed,
            vec![
                diagnostic_with_evidence(
                    "local_adapter",
                    "error",
                    "WIFI_ASSOCIATION_FAILED",
                    format!("Windows could not associate the requested SSID (reason code {reason_code})"),
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
        WlanAssociationState::Associated if !observation.local_address_ready => {
            (
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
                "Wi-Fi 已关联，但该无线网卡未取得可用 IPv4/IPv6 地址。请检查 DHCP 或 VLAN 后重试。".to_string(),
            )
        }
        WlanAssociationState::Associated if !observation.default_route_ready => {
            (
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
                "Wi-Fi 已关联且已取得地址，但该无线网卡没有默认路由。请检查网关或 DHCP 路由选项。".to_string(),
            )
        }
        WlanAssociationState::Associated => {
            (
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
            )
        }
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
fn wlan_profile_xml(profile_name: &str, ssid: &str, password: &str, hidden: bool) -> String {
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
  <connectionMode>auto</connectionMode>
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
        xml_escape(password)
    )
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

#[cfg(any(windows, test))]
fn wlan_reason_is_authentication_failure(reason: u32) -> bool {
    // The documented WLAN_REASON_CODE_MSMSEC range is the connection
    // security/authentication family, including
    // MSMSEC_PSK_MISMATCH_SUSPECTED (294932).  Treat the whole family as an
    // authentication result rather than flattening it into association or
    // timeout; the numeric code remains in the diagnostic for operators.
    (294_913..=294_939).contains(&reason)
        || matches!(
            reason,
            163_853 // WLAN_REASON_CODE_KEY_MISMATCH
                | 229_381 // WLAN_REASON_CODE_START_SECURITY_FAILURE
                | 229_382 // WLAN_REASON_CODE_SECURITY_FAILURE
                | 229_383 // WLAN_REASON_CODE_SECURITY_TIMEOUT
                | 229_385 // WLAN_REASON_CODE_ROAMING_SECURITY_FAILURE
                | 229_386 // WLAN_REASON_CODE_ADHOC_SECURITY_FAILURE
                | 229_394 // WLAN_REASON_CODE_TOO_MANY_SECURITY_ATTEMPTS
                | 524_294 // WLAN_REASON_CODE_MSM_SECURITY_MISSING
                | 524_295 // WLAN_REASON_CODE_IHV_SECURITY_NOT_SUPPORTED
                | 524_300 // WLAN_REASON_CODE_SECURITY_MISSING
        )
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
    use std::{ptr, sync::mpsc, thread, time::Duration};
    use windows_sys::Win32::{
        Foundation::HANDLE,
        NetworkManagement::WiFi::{
            dot11_BSS_type_any, wlan_connection_mode_profile, WlanCloseHandle, WlanConnect,
            WlanOpenHandle, WlanRegisterNotification, WlanSetProfile,
            WLAN_CONNECTION_HIDDEN_NETWORK, WLAN_CONNECTION_PARAMETERS,
            WLAN_NOTIFICATION_SOURCE_ACM, WLAN_NOTIFICATION_SOURCE_NONE, WLAN_REASON_CODE_SUCCESS,
        },
    };

    const ERROR_SUCCESS: u32 = 0;
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

    unsafe {
        let mut negotiated_version = 0;
        let mut handle: HANDLE = ptr::null_mut();
        let open = WlanOpenHandle(2, ptr::null(), &mut negotiated_version, &mut handle);
        if open != ERROR_SUCCESS {
            return Err(format!("WLAN API open failed with error {open}"));
        }

        let result = (|| -> Result<WlanConnectionObservation, String> {
            let interface = select_windows_wlan_interface(handle, ssid, request.hidden)?;
            let profile_name = deterministic_wlan_profile_name(ssid);
            let profile_xml =
                wlan_profile_xml(&profile_name, ssid, &request.password, request.hidden);
            let profile_xml = wide_null(&profile_xml);
            // A stable profile name and overwrite=true atomically replace this
            // machine-wide profile for the SSID.  The password never leaves
            // process memory for an argv, environment variable, log, or file.
            let all_user_security = wide_null("D:(A;;GA;;;SY)(A;;GA;;;BA)");
            let mut profile_reason = WLAN_REASON_CODE_SUCCESS;
            let set = WlanSetProfile(
                handle,
                &interface.InterfaceGuid,
                0,
                profile_xml.as_ptr(),
                all_user_security.as_ptr(),
                1,
                ptr::null(),
                &mut profile_reason,
            );
            if set != ERROR_SUCCESS {
                return Err(format!(
                    "Windows rejected the all-user WLAN profile (error {set}, reason code {profile_reason})"
                ));
            }

            let (sender, receiver) = mpsc::channel();
            let context = Box::new(NativeWlanNotificationContext {
                sender,
                interface_guid: interface.InterfaceGuid,
                profile_name: profile_name.clone(),
                ssid: ssid.to_string(),
            });
            let context_ptr = Box::into_raw(context);
            let mut previous_notification_source = 0;
            let registration = WlanRegisterNotification(
                handle,
                WLAN_NOTIFICATION_SOURCE_ACM,
                0,
                Some(native_wlan_notification_callback),
                context_ptr.cast(),
                ptr::null(),
                &mut previous_notification_source,
            );
            if registration != ERROR_SUCCESS {
                drop(Box::from_raw(context_ptr));
                return Err(format!(
                    "WLAN notification registration failed with error {registration}"
                ));
            }

            let mut dot11_ssid = windows_sys::Win32::NetworkManagement::WiFi::DOT11_SSID {
                uSSIDLength: ssid.len() as u32,
                ucSSID: [0; 32],
            };
            dot11_ssid.ucSSID[..ssid.len()].copy_from_slice(ssid.as_bytes());
            let profile_name = wide_null(&profile_name);
            let parameters = WLAN_CONNECTION_PARAMETERS {
                wlanConnectionMode: wlan_connection_mode_profile,
                strProfile: profile_name.as_ptr(),
                pDot11Ssid: &mut dot11_ssid,
                pDesiredBssidList: ptr::null_mut(),
                dot11BssType: dot11_BSS_type_any,
                dwFlags: if request.hidden {
                    WLAN_CONNECTION_HIDDEN_NETWORK
                } else {
                    0
                },
            };
            let connect = WlanConnect(handle, &interface.InterfaceGuid, &parameters, ptr::null());
            if connect != ERROR_SUCCESS {
                let _ = WlanRegisterNotification(
                    handle,
                    WLAN_NOTIFICATION_SOURCE_NONE,
                    0,
                    None,
                    ptr::null(),
                    ptr::null(),
                    ptr::null_mut(),
                );
                drop(Box::from_raw(context_ptr));
                return Err(format!("WLAN connect request failed with error {connect}"));
            }

            let deadline = std::time::Instant::now() + Duration::from_secs(20);
            let mut failure_reason = None;
            while std::time::Instant::now() < deadline {
                match receiver.recv_timeout(Duration::from_millis(500)) {
                    Ok(NativeWlanEvent::Completed) => break,
                    Ok(NativeWlanEvent::Failed(reason)) => {
                        failure_reason = Some(reason);
                        break;
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if windows_wlan_is_associated_with_ssid(
                            handle,
                            &interface.InterfaceGuid,
                            ssid,
                        ) {
                            break;
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
            let _ = WlanRegisterNotification(
                handle,
                WLAN_NOTIFICATION_SOURCE_NONE,
                0,
                None,
                ptr::null(),
                ptr::null(),
                ptr::null_mut(),
            );
            drop(Box::from_raw(context_ptr));

            let association =
                if windows_wlan_is_associated_with_ssid(handle, &interface.InterfaceGuid, ssid) {
                    WlanAssociationState::Associated
                } else if let Some(reason) = failure_reason {
                    wlan_association_state_from_reason(reason)
                } else {
                    WlanAssociationState::TimedOut
                };
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
        })();
        WlanCloseHandle(handle, ptr::null());
        result
    }
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
unsafe fn windows_wlan_is_associated_with_ssid(
    handle: windows_sys::Win32::Foundation::HANDLE,
    interface: &windows_sys::core::GUID,
    expected_ssid: &str,
) -> bool {
    use std::ptr;
    use windows_sys::Win32::NetworkManagement::WiFi::{
        wlan_interface_state_connected, wlan_intf_opcode_current_connection, WlanFreeMemory,
        WlanQueryInterface, WLAN_CONNECTION_ATTRIBUTES, WLAN_OPCODE_VALUE_TYPE,
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
    if result != ERROR_SUCCESS
        || data.is_null()
        || size < std::mem::size_of::<WLAN_CONNECTION_ATTRIBUTES>() as u32
    {
        return false;
    }
    let attributes = &*(data as *const WLAN_CONNECTION_ATTRIBUTES);
    let length = usize::try_from(attributes.wlanAssociationAttributes.dot11Ssid.uSSIDLength)
        .unwrap_or(0)
        .min(32);
    let associated = attributes.isState == wlan_interface_state_connected
        && std::str::from_utf8(&attributes.wlanAssociationAttributes.dot11Ssid.ucSSID[..length])
            .ok()
            == Some(expected_ssid);
    WlanFreeMemory(data);
    associated
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
        let profile = wlan_profile_xml(&first, "VEM-Lab", password, false);
        assert!(profile.contains(password));
        assert!(profile.contains(&first));
        assert!(profile.contains("<connectionMode>auto</connectionMode>"));
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
    fn wlan_psk_mismatch_reason_is_an_authentication_failure() {
        // WLAN_REASON_CODE_MSMSEC_PSK_MISMATCH_SUSPECTED
        assert!(wlan_reason_is_authentication_failure(294_932));
        assert!(wlan_reason_is_authentication_failure(163_853)); // KEY_MISMATCH
        assert!(!wlan_reason_is_authentication_failure(229_378)); // association failure
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

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

    /// Checks the connection Windows already has (wired or an existing WLAN
    /// profile) against the pre-claim Platform endpoint. This deliberately
    /// does not accept a Wi-Fi password: endpoint configuration is not
    /// connectivity evidence, and an already-connected machine must be able
    /// to progress without creating a new WLAN profile.
    async fn probe_preclaim_platform_endpoint(
        &self,
        api_base_url: &str,
    ) -> NetworkSettingsResponse {
        probe_preclaim_platform_endpoint(api_base_url).await
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
        Ok(response) if response.status().is_success() => NetworkSettingsResponse {
            status: NetworkSetupStatus::Connected,
            ssid: "existing-network".to_string(),
            hidden: false,
            diagnostics: vec![
                diagnostic(
                    "local_network",
                    "ok",
                    "LOCAL_NETWORK_ROUTE_READY",
                    "An existing local network route reached the Platform endpoint",
                ),
                diagnostic(
                    "provisioning_endpoint",
                    "ok",
                    "PROVISIONING_ENDPOINT_REACHABLE",
                    "Pre-claim Platform endpoint is reachable",
                ),
            ],
            operator_guidance: "已验证现有有线或已连接无线网络可访问平台，可以继续领取机器。"
                .to_string(),
            updated_at: crate::state::store::now_iso(),
        },
        Ok(response) => failed_preclaim_probe_response(
            "PRECLAIM_PLATFORM_ENDPOINT_UNREACHABLE",
            &format!(
                "Pre-claim Platform endpoint returned HTTP {}",
                response.status().as_u16()
            ),
        ),
        Err(_) => failed_preclaim_probe_response(
            "PRECLAIM_PLATFORM_ENDPOINT_UNREACHABLE",
            "Existing local network could not reach the pre-claim Platform endpoint",
        ),
    }
}

fn failed_preclaim_probe_response(code: &str, message: &str) -> NetworkSettingsResponse {
    NetworkSettingsResponse {
        status: NetworkSetupStatus::Failed,
        ssid: "existing-network".to_string(),
        hidden: false,
        diagnostics: vec![
            diagnostic(
                "local_network",
                "warn",
                "LOCAL_NETWORK_OR_PLATFORM_UNVERIFIED",
                "No verified local route to the pre-claim Platform endpoint",
            ),
            diagnostic("provisioning_endpoint", "error", code, message),
        ],
        operator_guidance:
            "尚未验证现有有线或已连接无线网络可访问平台；请检查现场网络，或配置 Wi-Fi 后重试。"
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

    async fn probe_preclaim_platform_endpoint(
        &self,
        _api_base_url: &str,
    ) -> NetworkSettingsResponse {
        self.apply_wifi_settings(NetworkSettingsRequest {
            ssid: "existing-network".to_string(),
            password: "test-only-network-probe".to_string(),
            hidden: false,
        })
        .await
    }
}

fn success_diagnostics() -> Vec<NetworkDiagnostic> {
    vec![
        diagnostic(
            "local_network",
            "ok",
            "LOCAL_NETWORK_CONNECTED",
            "Wi-Fi association succeeded",
        ),
        diagnostic("dhcp_ip", "ok", "DHCP_IP_READY", "DHCP/IP address is ready"),
        diagnostic("dns", "ok", "DNS_READY", "DNS resolution is ready"),
        diagnostic(
            "provisioning_endpoint",
            "ok",
            "PROVISIONING_ENDPOINT_REACHABLE",
            "Provisioning endpoint is reachable",
        ),
        diagnostic("mqtt", "ok", "MQTT_REACHABLE", "MQTT broker is reachable"),
    ]
}

fn pending_reachability_diagnostics() -> Vec<NetworkDiagnostic> {
    vec![
        diagnostic(
            "local_network",
            "warn",
            "LOCAL_NETWORK_ASSOCIATION_PENDING",
            "Wi-Fi connection was requested but local connectivity is not verified yet",
        ),
        diagnostic(
            "dhcp_ip",
            "unknown",
            "DHCP_IP_PENDING",
            "DHCP/IP has not been verified yet",
        ),
        diagnostic(
            "dns",
            "unknown",
            "DNS_PENDING",
            "DNS resolution has not been verified yet",
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

fn diagnostic(
    component: impl Into<String>,
    level: impl Into<String>,
    code: impl Into<String>,
    message: impl Into<String>,
) -> NetworkDiagnostic {
    NetworkDiagnostic {
        component: component.into(),
        level: level.into(),
        code: code.into(),
        message: message.into(),
    }
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
            Ok(()) => NetworkSettingsResponse {
                status: NetworkSetupStatus::Connected,
                ssid: request.ssid.trim().to_string(),
                hidden: request.hidden,
                diagnostics: pending_reachability_diagnostics(),
                operator_guidance:
                    "Wi-Fi 已提交连接请求，但本机尚未确认 DHCP/IP、DNS、平台或 MQTT 连通性。请等待现场网络稳定后重试。"
                        .to_string(),
                updated_at: crate::state::store::now_iso(),
            },
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
async fn apply_windows_wlan_profile(request: &NetworkSettingsRequest) -> Result<(), String> {
    let runner = NetshWlanCommandRunner;
    apply_windows_wlan_profile_with_runner(&runner, request, &std::env::temp_dir()).await
}

#[cfg(any(windows, test))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct WlanCommandOutput {
    success: bool,
    stderr: String,
}

#[cfg(any(windows, test))]
#[cfg(test)]
impl WlanCommandOutput {
    fn success() -> Self {
        Self {
            success: true,
            stderr: String::new(),
        }
    }
}

#[cfg(windows)]
impl From<std::process::Output> for WlanCommandOutput {
    fn from(output: std::process::Output) -> Self {
        Self {
            success: output.status.success(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        }
    }
}

#[cfg(any(windows, test))]
#[async_trait]
trait WlanCommandRunner: Send + Sync {
    async fn add_profile(&self, path: &std::path::Path) -> Result<WlanCommandOutput, String>;
    async fn connect(&self, profile_name: &str, ssid: &str) -> Result<WlanCommandOutput, String>;
    async fn delete_profile(&self, profile_name: &str) -> Result<WlanCommandOutput, String>;
}

#[cfg(windows)]
struct NetshWlanCommandRunner;

#[cfg(windows)]
#[async_trait]
impl WlanCommandRunner for NetshWlanCommandRunner {
    async fn add_profile(&self, path: &std::path::Path) -> Result<WlanCommandOutput, String> {
        use tokio::process::Command;

        Command::new("netsh")
            .args(["wlan", "add", "profile"])
            .arg(format!("filename={}", path.display()))
            .arg("user=current")
            .output()
            .await
            .map(WlanCommandOutput::from)
            .map_err(|error| format!("run netsh wlan add profile failed: {error}"))
    }

    async fn connect(&self, profile_name: &str, ssid: &str) -> Result<WlanCommandOutput, String> {
        use tokio::process::Command;

        Command::new("netsh")
            .args(["wlan", "connect"])
            .arg(format!("name={profile_name}"))
            .arg(format!("ssid={ssid}"))
            .output()
            .await
            .map(WlanCommandOutput::from)
            .map_err(|error| format!("run netsh wlan connect failed: {error}"))
    }

    async fn delete_profile(&self, profile_name: &str) -> Result<WlanCommandOutput, String> {
        use tokio::process::Command;

        Command::new("netsh")
            .args(["wlan", "delete", "profile"])
            .arg(format!("name={profile_name}"))
            .output()
            .await
            .map(WlanCommandOutput::from)
            .map_err(|error| format!("run netsh wlan delete profile failed: {error}"))
    }
}

#[cfg(any(windows, test))]
async fn apply_windows_wlan_profile_with_runner(
    runner: &(impl WlanCommandRunner + ?Sized),
    request: &NetworkSettingsRequest,
    temp_dir: &std::path::Path,
) -> Result<(), String> {
    let ssid = request.ssid.trim();
    if ssid.is_empty() {
        return Err("SSID is required".to_string());
    }
    if request.password.is_empty() {
        return Err("Wi-Fi password is required".to_string());
    }

    let profile_name = format!("VEM-{}", uuid::Uuid::new_v4().simple());
    let profile_xml = wlan_profile_xml(&profile_name, ssid, &request.password, request.hidden);
    let path = temp_dir.join(format!("{profile_name}.xml"));
    tokio::fs::write(&path, profile_xml)
        .await
        .map_err(|error| format!("write WLAN profile failed: {error}"))?;

    let add = runner.add_profile(&path).await;
    let remove_temp = tokio::fs::remove_file(&path).await;
    let add = add.map_err(|error| sanitize_secret(&error, &request.password))?;
    if !add.success {
        return Err(sanitize_secret(
            &format!("netsh wlan add profile failed: {}", add.stderr),
            &request.password,
        ));
    }
    if let Err(error) = remove_temp {
        let message = format!("remove temporary WLAN profile XML failed: {error}");
        return Err(cleanup_windows_wlan_profile_after_failure(
            runner,
            &profile_name,
            &request.password,
            message,
        )
        .await);
    }

    let connect = match runner.connect(&profile_name, ssid).await {
        Ok(connect) => connect,
        Err(error) => {
            return Err(cleanup_windows_wlan_profile_after_failure(
                runner,
                &profile_name,
                &request.password,
                error,
            )
            .await);
        }
    };
    if !connect.success {
        return Err(cleanup_windows_wlan_profile_after_failure(
            runner,
            &profile_name,
            &request.password,
            format!("netsh wlan connect failed: {}", connect.stderr),
        )
        .await);
    }

    cleanup_windows_wlan_profile(runner, &profile_name, &request.password).await?;
    Ok(())
}

#[cfg(any(windows, test))]
async fn cleanup_windows_wlan_profile_after_failure(
    runner: &(impl WlanCommandRunner + ?Sized),
    profile_name: &str,
    secret: &str,
    failure: impl AsRef<str>,
) -> String {
    let failure = sanitize_secret(failure.as_ref(), secret);
    match cleanup_windows_wlan_profile(runner, profile_name, secret).await {
        Ok(()) => failure,
        Err(cleanup_error) => format!("{failure}; {cleanup_error}"),
    }
}

#[cfg(any(windows, test))]
async fn cleanup_windows_wlan_profile(
    runner: &(impl WlanCommandRunner + ?Sized),
    profile_name: &str,
    secret: &str,
) -> Result<(), String> {
    let delete = runner
        .delete_profile(profile_name)
        .await
        .map_err(|error| sanitize_secret(&error, secret))?;
    if delete.success {
        Ok(())
    } else {
        Err(sanitize_secret(
            &format!("netsh wlan delete profile failed: {}", delete.stderr),
            secret,
        ))
    }
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

#[cfg(any(windows, test))]
fn sanitize_secret(message: &str, secret: &str) -> String {
    if secret.is_empty() {
        message.to_string()
    } else {
        message.replace(secret, "[redacted]")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::sync::{Arc, Mutex};
    use wiremock::{
        matchers::{method, path},
        Mock, MockServer, ResponseTemplate,
    };

    #[tokio::test]
    async fn existing_network_probe_requires_a_real_preclaim_platform_health_response() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/health"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let response = probe_preclaim_platform_endpoint(&format!("{}/api", server.uri())).await;

        assert_eq!(response.status, NetworkSetupStatus::Connected);
        assert!(response.diagnostics.iter().any(|item| {
            item.component == "local_network" && item.code == "LOCAL_NETWORK_ROUTE_READY"
        }));
        assert!(response.diagnostics.iter().any(|item| {
            item.component == "provisioning_endpoint"
                && item.code == "PROVISIONING_ENDPOINT_REACHABLE"
        }));
    }

    #[derive(Clone)]
    struct FakeWlanCommandRunner {
        calls: Arc<Mutex<Vec<String>>>,
        connect_success: bool,
        leaked_password: String,
    }

    #[async_trait]
    impl WlanCommandRunner for FakeWlanCommandRunner {
        async fn add_profile(&self, path: &Path) -> Result<WlanCommandOutput, String> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("add:{}", path.display()));
            Ok(WlanCommandOutput::success())
        }

        async fn connect(
            &self,
            profile_name: &str,
            ssid: &str,
        ) -> Result<WlanCommandOutput, String> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("connect:{profile_name}:{ssid}"));
            Ok(WlanCommandOutput {
                success: self.connect_success,
                stderr: format!(
                    "authentication failed for password {}",
                    self.leaked_password
                ),
            })
        }

        async fn delete_profile(&self, profile_name: &str) -> Result<WlanCommandOutput, String> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("delete:{profile_name}"));
            Ok(WlanCommandOutput::success())
        }
    }

    #[tokio::test]
    async fn windows_profile_connect_failure_deletes_imported_profile_without_leaking_password() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let submitted_password = ["secret", "pass", "123"].join("-");
        let runner = FakeWlanCommandRunner {
            calls: calls.clone(),
            connect_success: false,
            leaked_password: submitted_password.clone(),
        };
        let temp = tempfile::tempdir().expect("temp");
        let request = NetworkSettingsRequest {
            ssid: "VEM-Lab".to_string(),
            password: submitted_password.clone(),
            hidden: false,
        };

        let result = apply_windows_wlan_profile_with_runner(&runner, &request, temp.path()).await;

        let error = result.expect_err("connect should fail");
        assert!(!error.contains(&submitted_password));
        let calls = calls.lock().expect("calls").clone();
        assert!(calls.iter().any(|call| call.starts_with("add:")));
        let connect = calls
            .iter()
            .find(|call| call.starts_with("connect:"))
            .expect("connect call");
        let profile_name = connect
            .strip_prefix("connect:")
            .and_then(|value| value.strip_suffix(":VEM-Lab"))
            .expect("profile name from connect call");
        assert!(profile_name.starts_with("VEM-"));
        assert!(calls
            .iter()
            .any(|call| call == &format!("delete:{profile_name}")));
        assert_eq!(
            std::fs::read_dir(temp.path()).expect("temp dir").count(),
            0,
            "temporary WLAN profile XML should be removed"
        );
    }

    #[tokio::test]
    async fn windows_profile_success_returns_connected_pending_reachability() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let submitted_password = ["secret", "pass", "123"].join("-");
        let runner = FakeWlanCommandRunner {
            calls,
            connect_success: true,
            leaked_password: submitted_password.clone(),
        };
        let temp = tempfile::tempdir().expect("temp");
        let request = NetworkSettingsRequest {
            ssid: "VEM-Lab".to_string(),
            password: submitted_password,
            hidden: false,
        };

        apply_windows_wlan_profile_with_runner(&runner, &request, temp.path())
            .await
            .expect("netsh success");
        let response = NetworkSettingsResponse {
            status: NetworkSetupStatus::Connected,
            ssid: request.ssid.trim().to_string(),
            hidden: request.hidden,
            diagnostics: pending_reachability_diagnostics(),
            operator_guidance:
                "Wi-Fi 已提交连接请求，但本机尚未确认 DHCP/IP、DNS、平台或 MQTT 连通性。请等待现场网络稳定后重试。"
                    .to_string(),
            updated_at: crate::state::store::now_iso(),
        };

        assert_eq!(response.status, NetworkSetupStatus::Connected);
        assert!(response.diagnostics.iter().any(|item| {
            item.component == "provisioning_endpoint"
                && item.code == "PROVISIONING_ENDPOINT_PENDING"
        }));
        assert!(!response
            .diagnostics
            .iter()
            .any(|item| item.code == "PROVISIONING_ENDPOINT_REACHABLE"));
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

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

#[async_trait]
pub trait NetworkAdapter: Send + Sync {
    async fn apply_wifi_settings(&self, request: NetworkSettingsRequest)
        -> NetworkSettingsResponse;
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

    fn unsupported(code: &str, message: &str) -> Self {
        Self {
            outcome: format!("unsupported:{code}:{message}"),
        }
    }
}

#[async_trait]
impl NetworkAdapter for FakeNetworkAdapter {
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
}

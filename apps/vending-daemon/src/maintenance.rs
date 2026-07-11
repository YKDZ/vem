use std::{path::PathBuf, sync::Arc};

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use x25519_dalek::{PublicKey, StaticSecret};

use crate::{
    config::ProvisioningMaintenanceIdentity,
    secret::{
        SecretStore, MACHINE_MAINTENANCE_LIFECYCLE_ACCOUNT,
        MACHINE_WIREGUARD_PENDING_PRIVATE_KEY_ACCOUNT, MACHINE_WIREGUARD_PRIVATE_KEY_ACCOUNT,
    },
};

const WINDOWS_TUNNEL_NAME: &str = "VEM-Maintenance";
const WINDOWS_WIREGUARD_EXECUTABLE: &str = "wireguard.exe";
const WINDOWS_WG_EXECUTABLE: &str = "wg.exe";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MaintenanceTunnelIdentity {
    Active,
    Pending,
}

impl MaintenanceTunnelIdentity {
    fn tunnel_name(self) -> &'static str {
        match self {
            Self::Active => WINDOWS_TUNNEL_NAME,
            Self::Pending => "VEM-Maintenance-Pending",
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct WindowsTunnelConfig {
    pub private_key: String,
    pub address: String,
    pub endpoint: String,
    pub relay_public_key: String,
    pub relay_address: String,
    pub role_routes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandshakeObservation {
    pub verified: bool,
    pub last_handshake_at: Option<String>,
    pub message: String,
}

#[async_trait]
pub trait WindowsTunnelBackend: Send + Sync {
    async fn apply(
        &self,
        identity: MaintenanceTunnelIdentity,
        config: WindowsTunnelConfig,
    ) -> Result<(), String>;
    async fn observe_handshake(
        &self,
        identity: MaintenanceTunnelIdentity,
        public_key: &str,
    ) -> Result<HandshakeObservation, String>;

    async fn remove(&self, _identity: MaintenanceTunnelIdentity) -> Result<(), String> {
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CommandOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

impl Default for CommandOutput {
    fn default() -> Self {
        Self::success()
    }
}

impl CommandOutput {
    fn success() -> Self {
        Self {
            success: true,
            stdout: String::new(),
            stderr: String::new(),
        }
    }

    #[cfg(test)]
    fn failure() -> Self {
        Self {
            success: false,
            stdout: String::new(),
            stderr: String::new(),
        }
    }

    #[cfg(test)]
    fn with_stdout(stdout: &str) -> Self {
        Self {
            success: true,
            stdout: stdout.to_string(),
            stderr: String::new(),
        }
    }
}

#[async_trait]
trait TunnelCommandRunner: Send + Sync {
    async fn run(&self, program: &str, args: &[String]) -> Result<CommandOutput, String>;
}

struct ProcessTunnelCommandRunner;

#[async_trait]
impl TunnelCommandRunner for ProcessTunnelCommandRunner {
    async fn run(&self, program: &str, args: &[String]) -> Result<CommandOutput, String> {
        let output = tokio::process::Command::new(program)
            .args(args)
            .output()
            .await
            .map_err(|error| format!("run WireGuard command failed: {error}"))?;
        Ok(CommandOutput {
            success: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}

#[async_trait]
trait WireGuardEncryptedConfigStore: Send + Sync {
    async fn persist(&self, tunnel_name: &str, plaintext_config: &[u8]) -> Result<PathBuf, String>;

    async fn remove(&self, _tunnel_name: &str) -> Result<(), String> {
        Ok(())
    }
}

struct WindowsDpapiWireGuardConfigStore;

#[async_trait]
impl WireGuardEncryptedConfigStore for WindowsDpapiWireGuardConfigStore {
    async fn persist(&self, tunnel_name: &str, plaintext_config: &[u8]) -> Result<PathBuf, String> {
        #[cfg(not(windows))]
        {
            let _ = (tunnel_name, plaintext_config);
            Err("WireGuard DPAPI configuration is supported only on Windows".to_string())
        }

        #[cfg(windows)]
        {
            let tunnel_name = tunnel_name.to_string();
            let plaintext_config = plaintext_config.to_vec();
            let encrypted = tokio::task::spawn_blocking(move || {
                protect_wireguard_config(&plaintext_config, &tunnel_name)
            })
            .await
            .map_err(|error| format!("join WireGuard DPAPI protection failed: {error}"))??;
            let program_files = std::env::var_os("ProgramFiles")
                .map(PathBuf::from)
                .ok_or_else(|| "ProgramFiles is unavailable".to_string())?;
            let config_dir = program_files
                .join("WireGuard")
                .join("Data")
                .join("Configurations");
            tokio::fs::create_dir_all(&config_dir)
                .await
                .map_err(|error| {
                    format!("create WireGuard configuration directory failed: {error}")
                })?;
            let path = config_dir.join(format!("{tunnel_name}.conf.dpapi"));
            let staging_path = config_dir.join(format!("{tunnel_name}.conf.dpapi.tmp"));
            if let Err(error) = persist_encrypted_config(&staging_path, &path, &encrypted).await {
                let _ = tokio::fs::remove_file(&staging_path).await;
                return Err(error);
            }
            Ok(path)
        }
    }

    async fn remove(&self, tunnel_name: &str) -> Result<(), String> {
        #[cfg(not(windows))]
        {
            let _ = tunnel_name;
            Ok(())
        }

        #[cfg(windows)]
        {
            let program_files = std::env::var_os("ProgramFiles")
                .map(PathBuf::from)
                .ok_or_else(|| "ProgramFiles is unavailable".to_string())?;
            let path = program_files
                .join("WireGuard")
                .join("Data")
                .join("Configurations")
                .join(format!("{tunnel_name}.conf.dpapi"));
            match tokio::fs::remove_file(path).await {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(format!("remove WireGuard configuration failed: {error}")),
            }
        }
    }
}

#[cfg(windows)]
async fn persist_encrypted_config(
    staging_path: &std::path::Path,
    path: &std::path::Path,
    encrypted: &[u8],
) -> Result<(), String> {
    tokio::fs::write(staging_path, encrypted)
        .await
        .map_err(|error| format!("write encrypted WireGuard configuration failed: {error}"))?;
    let acl_status = tokio::process::Command::new("icacls.exe")
        .arg(staging_path)
        .args(["/inheritance:r", "/grant:r", "SYSTEM:F", "Administrators:D"])
        .status()
        .await
        .map_err(|error| format!("harden encrypted WireGuard configuration failed: {error}"))?;
    if !acl_status.success() {
        return Err("harden encrypted WireGuard configuration failed".to_string());
    }
    match tokio::fs::remove_file(path).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "replace encrypted WireGuard configuration failed: {error}"
            ));
        }
    }
    tokio::fs::rename(staging_path, path)
        .await
        .map_err(|error| format!("replace encrypted WireGuard configuration failed: {error}"))
}

#[cfg(windows)]
fn protect_wireguard_config(value: &[u8], tunnel_name: &str) -> Result<Vec<u8>, String> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::{
        Foundation::{GetLastError, LocalFree},
        Security::Cryptography::{CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB},
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: value.len() as u32,
        pbData: value.as_ptr() as *mut u8,
    };
    let description = tunnel_name
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };
    let ok = unsafe {
        CryptProtectData(
            &input,
            description.as_ptr(),
            null(),
            null(),
            null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(format!(
            "protect WireGuard configuration failed: {}",
            unsafe { GetLastError() }
        ));
    }
    let result =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    unsafe {
        LocalFree(output.pbData as *mut std::ffi::c_void);
    }
    Ok(result)
}

#[derive(Clone)]
pub struct WindowsWireGuardTunnel {
    enabled: bool,
    config_store: Arc<dyn WireGuardEncryptedConfigStore>,
    commands: Arc<dyn TunnelCommandRunner>,
    apply_lock: Arc<Mutex<()>>,
}

impl Default for WindowsWireGuardTunnel {
    fn default() -> Self {
        Self {
            enabled: cfg!(windows),
            config_store: Arc::new(WindowsDpapiWireGuardConfigStore),
            commands: Arc::new(ProcessTunnelCommandRunner),
            apply_lock: Arc::new(Mutex::new(())),
        }
    }
}

impl WindowsWireGuardTunnel {
    #[cfg(test)]
    fn with_dependencies(
        config_store: Arc<dyn WireGuardEncryptedConfigStore>,
        commands: Arc<dyn TunnelCommandRunner>,
    ) -> Self {
        Self {
            enabled: true,
            config_store,
            commands,
            apply_lock: Arc::new(Mutex::new(())),
        }
    }

    async fn uninstall_service(&self, tunnel_name: &str) -> Result<CommandOutput, String> {
        self.commands
            .run(
                WINDOWS_WIREGUARD_EXECUTABLE,
                &[
                    "/uninstalltunnelservice".to_string(),
                    tunnel_name.to_string(),
                ],
            )
            .await
    }
}

#[async_trait]
impl WindowsTunnelBackend for WindowsWireGuardTunnel {
    async fn apply(
        &self,
        identity: MaintenanceTunnelIdentity,
        config: WindowsTunnelConfig,
    ) -> Result<(), String> {
        if !self.enabled {
            return Ok(());
        }
        let _apply_guard = self.apply_lock.lock().await;
        let tunnel_name = identity.tunnel_name();
        let allowed_ips = config.role_routes.join(",");
        let contents = format!(
            "[Interface]\nPrivateKey = {}\nAddress = {}\n\n[Peer]\nPublicKey = {}\nAllowedIPs = {}\nEndpoint = {}\nPersistentKeepalive = 25\n",
            config.private_key,
            config.address,
            config.relay_public_key,
            allowed_ips,
            config.endpoint,
        );
        let path = self
            .config_store
            .persist(tunnel_name, contents.as_bytes())
            .await
            .map_err(|error| format!("persist WireGuard tunnel configuration failed: {error}"))?;
        let normalized_path = path.to_string_lossy().replace('\\', "/");
        if !normalized_path.ends_with(&format!("/{tunnel_name}.conf.dpapi")) {
            return Err("WireGuard tunnel configuration identity is unstable".to_string());
        }
        let _ = self.uninstall_service(tunnel_name).await;
        let install = self
            .commands
            .run(
                WINDOWS_WIREGUARD_EXECUTABLE,
                &[
                    "/installtunnelservice".to_string(),
                    path.to_string_lossy().to_string(),
                ],
            )
            .await;
        let install = match install {
            Ok(output) => output,
            Err(error) => {
                let _ = self.uninstall_service(tunnel_name).await;
                return Err(error);
            }
        };
        if !install.success {
            let _ = self.uninstall_service(tunnel_name).await;
            return Err("WireGuard tunnel service rejected configuration".to_string());
        }
        Ok(())
    }

    async fn remove(&self, identity: MaintenanceTunnelIdentity) -> Result<(), String> {
        if !self.enabled {
            return Ok(());
        }
        let _guard = self.apply_lock.lock().await;
        let tunnel_name = identity.tunnel_name();
        let uninstall = self.uninstall_service(tunnel_name).await?;
        if !uninstall.success {
            return Err("WireGuard tunnel service removal failed".to_string());
        }
        self.config_store.remove(tunnel_name).await
    }

    async fn observe_handshake(
        &self,
        identity: MaintenanceTunnelIdentity,
        relay_public_key: &str,
    ) -> Result<HandshakeObservation, String> {
        if !self.enabled {
            return Ok(HandshakeObservation {
                verified: false,
                last_handshake_at: None,
                message: "first WireGuard handshake has not been observed".to_string(),
            });
        }
        let output = self
            .commands
            .run(
                WINDOWS_WG_EXECUTABLE,
                &[
                    "show".to_string(),
                    identity.tunnel_name().to_string(),
                    "latest-handshakes".to_string(),
                ],
            )
            .await
            .map_err(|error| format!("read WireGuard handshake state failed: {error}"))?;
        if !output.success {
            return Err("WireGuard handshake state is unavailable".to_string());
        }
        let latest = output
            .stdout
            .lines()
            .filter_map(|line| {
                let mut fields = line.split_whitespace();
                let public_key = fields.next()?;
                let timestamp = fields.next()?;
                (public_key == relay_public_key).then_some(timestamp)
            })
            .filter_map(|timestamp| timestamp.parse::<i64>().ok())
            .next()
            .filter(|value| *value > 0);
        Ok(HandshakeObservation {
            verified: latest.is_some(),
            last_handshake_at: latest.and_then(|value| {
                chrono::DateTime::from_timestamp(value, 0).map(|date| date.to_rfc3339())
            }),
            message: if latest.is_some() {
                "first WireGuard handshake observed".to_string()
            } else {
                "first WireGuard handshake has not been observed".to_string()
            },
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceEnrollmentStatus {
    pub state: String,
    pub public_key: Option<String>,
    pub tunnel_address: Option<String>,
    pub endpoint: Option<String>,
    pub handshake_verified: bool,
    pub last_handshake_at: Option<String>,
    pub last_error: Option<String>,
    pub active_public_key: Option<String>,
    pub pending_public_key: Option<String>,
    pub reclaim_expires_at: Option<String>,
    pub active_identity_retained: bool,
    pub updated_at: String,
}

impl Default for MaintenanceEnrollmentStatus {
    fn default() -> Self {
        Self {
            state: "not_enrolled".to_string(),
            public_key: None,
            tunnel_address: None,
            endpoint: None,
            handshake_verified: false,
            last_handshake_at: None,
            last_error: None,
            active_public_key: None,
            pending_public_key: None,
            reclaim_expires_at: None,
            active_identity_retained: false,
            updated_at: Utc::now().to_rfc3339(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedMaintenanceLifecycle {
    active: Option<ProvisioningMaintenanceIdentity>,
    pending: Option<PersistedPendingMaintenanceIdentity>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedPendingMaintenanceIdentity {
    claim_code_digest: String,
    identity: Option<ProvisioningMaintenanceIdentity>,
    reclaim_expires_at: Option<String>,
    handshake_verified: bool,
}

#[derive(Clone)]
pub struct MaintenanceEnrollment {
    secrets: Arc<dyn SecretStore>,
    tunnel: Arc<dyn WindowsTunnelBackend>,
    key_generation: Arc<Mutex<()>>,
    status: Arc<Mutex<MaintenanceEnrollmentStatus>>,
    relay_public_key: Arc<Mutex<Option<String>>>,
}

impl MaintenanceEnrollment {
    pub fn new(secrets: Arc<dyn SecretStore>, tunnel: Arc<dyn WindowsTunnelBackend>) -> Self {
        Self {
            secrets,
            tunnel,
            key_generation: Arc::new(Mutex::new(())),
            status: Arc::new(Mutex::new(MaintenanceEnrollmentStatus::default())),
            relay_public_key: Arc::new(Mutex::new(None)),
        }
    }

    pub async fn ensure_public_key(&self) -> Result<String, String> {
        let _generation_guard = self.key_generation.lock().await;
        let private_key = match self
            .secrets
            .read_secret(MACHINE_WIREGUARD_PRIVATE_KEY_ACCOUNT)
            .await?
        {
            Some(value) => value,
            None => {
                let mut bytes = [0_u8; 32];
                getrandom::getrandom(&mut bytes)
                    .map_err(|error| format!("generate machine WireGuard key failed: {error}"))?;
                let private_key = STANDARD.encode(bytes);
                self.secrets
                    .write_secret(MACHINE_WIREGUARD_PRIVATE_KEY_ACCOUNT, &private_key)
                    .await
                    .map_err(|error| format!("store machine WireGuard key failed: {error}"))?;
                private_key
            }
        };
        let public_key = public_key_from_private_key(&private_key)?;
        let mut status = self.status.lock().await;
        status.public_key = Some(public_key.clone());
        status.updated_at = Utc::now().to_rfc3339();
        Ok(public_key)
    }

    pub async fn ensure_reclaim_public_key(
        &self,
        claim_code: &str,
        active_identity: Option<&ProvisioningMaintenanceIdentity>,
    ) -> Result<String, String> {
        let _generation_guard = self.key_generation.lock().await;
        let claim_code_digest = format!("{:x}", Sha256::digest(claim_code.as_bytes()));
        let mut lifecycle = self.load_lifecycle().await?;
        if lifecycle.active.is_none() {
            lifecycle.active = active_identity.cloned();
        }
        if lifecycle.active.is_none() {
            return Err("active machine maintenance identity is unavailable".to_string());
        }
        if lifecycle
            .pending
            .as_ref()
            .is_some_and(|pending| pending.claim_code_digest == claim_code_digest)
        {
            if let Some(private_key) = self
                .secrets
                .read_secret(MACHINE_WIREGUARD_PENDING_PRIVATE_KEY_ACCOUNT)
                .await?
            {
                return public_key_from_private_key(&private_key);
            }
        }

        if lifecycle.pending.is_some() {
            self.tunnel
                .remove(MaintenanceTunnelIdentity::Pending)
                .await?;
            self.secrets
                .write_secret(MACHINE_WIREGUARD_PENDING_PRIVATE_KEY_ACCOUNT, "")
                .await?;
        }
        let mut bytes = [0_u8; 32];
        getrandom::getrandom(&mut bytes)
            .map_err(|error| format!("generate machine WireGuard key failed: {error}"))?;
        let private_key = STANDARD.encode(bytes);
        self.secrets
            .write_secret(MACHINE_WIREGUARD_PENDING_PRIVATE_KEY_ACCOUNT, &private_key)
            .await
            .map_err(|error| format!("store pending machine WireGuard key failed: {error}"))?;
        let public_key = public_key_from_private_key(&private_key)?;
        lifecycle.pending = Some(PersistedPendingMaintenanceIdentity {
            claim_code_digest,
            identity: None,
            reclaim_expires_at: None,
            handshake_verified: false,
        });
        self.save_lifecycle(&lifecycle).await?;
        let mut status = self.status.lock().await;
        status.active_public_key = lifecycle
            .active
            .as_ref()
            .map(|identity| identity.public_key.clone());
        status.public_key = status.active_public_key.clone();
        status.pending_public_key = Some(public_key.clone());
        status.handshake_verified = false;
        status.last_handshake_at = None;
        status.state = "reclaim_request_pending".to_string();
        status.last_error = None;
        status.active_identity_retained = true;
        status.updated_at = Utc::now().to_rfc3339();
        Ok(public_key)
    }

    pub async fn apply_profile(
        &self,
        identity: &ProvisioningMaintenanceIdentity,
    ) -> Result<MaintenanceEnrollmentStatus, String> {
        let public_key = self.ensure_public_key().await?;
        if public_key != identity.public_key {
            return self
                .fail("maintenance public key differs from claimed identity")
                .await;
        }
        let private_key = self
            .secrets
            .read_secret(MACHINE_WIREGUARD_PRIVATE_KEY_ACCOUNT)
            .await?
            .ok_or_else(|| "machine WireGuard private key is missing".to_string())?;
        let observation = self
            .tunnel
            .apply(
                MaintenanceTunnelIdentity::Active,
                tunnel_config(private_key, identity),
            )
            .await;
        if let Err(error) = observation {
            return self.fail(&error).await;
        }
        *self.relay_public_key.lock().await = Some(identity.relay.public_key.clone());
        let observation = self
            .tunnel
            .observe_handshake(
                MaintenanceTunnelIdentity::Active,
                &identity.relay.public_key,
            )
            .await;
        let mut lifecycle = self.load_lifecycle().await?;
        lifecycle.active = Some(identity.clone());
        self.save_lifecycle(&lifecycle).await?;
        let mut status = self.status.lock().await;
        status.state = "tunnel_applied".to_string();
        status.public_key = Some(public_key.clone());
        status.tunnel_address = Some(identity.address.clone());
        status.endpoint = Some(identity.endpoint.clone());
        status.last_error = None;
        status.active_public_key = Some(public_key.clone());
        status.pending_public_key = None;
        status.reclaim_expires_at = None;
        status.active_identity_retained = true;
        match observation {
            Ok(observation) => {
                status.handshake_verified = observation.verified;
                status.last_handshake_at = observation.last_handshake_at;
                status.state = if observation.verified {
                    "handshake_verified".to_string()
                } else {
                    "handshake_pending".to_string()
                };
                if !observation.verified {
                    status.last_error = Some(observation.message);
                }
            }
            Err(error) => {
                status.state = "handshake_pending".to_string();
                status.last_error = Some(error);
            }
        }
        status.updated_at = Utc::now().to_rfc3339();
        Ok(status.clone())
    }

    pub async fn apply_reclaim_profile(
        &self,
        identity: &ProvisioningMaintenanceIdentity,
    ) -> Result<MaintenanceEnrollmentStatus, String> {
        let private_key = self
            .secrets
            .read_secret(MACHINE_WIREGUARD_PENDING_PRIVATE_KEY_ACCOUNT)
            .await?
            .ok_or_else(|| "pending machine WireGuard private key is missing".to_string())?;
        let pending_public_key = public_key_from_private_key(&private_key)?;
        if pending_public_key != identity.public_key {
            return self
                .fail("pending maintenance public key differs from claimed identity")
                .await;
        }
        let reclaim_expires_at = identity
            .reclaim_expires_at
            .as_ref()
            .ok_or_else(|| "pending reclaim expiry is missing".to_string())?;
        DateTime::parse_from_rfc3339(reclaim_expires_at)
            .map_err(|_| "pending reclaim expiry is invalid".to_string())?;

        let mut lifecycle = self.load_lifecycle().await?;
        if lifecycle.active.is_none() {
            return Err("active machine maintenance identity is unavailable".to_string());
        }
        let pending = lifecycle
            .pending
            .as_mut()
            .ok_or_else(|| "pending machine maintenance identity is unavailable".to_string())?;
        pending.identity = Some(identity.clone());
        pending.reclaim_expires_at = Some(reclaim_expires_at.clone());
        pending.handshake_verified = false;
        self.save_lifecycle(&lifecycle).await?;

        self.tunnel
            .apply(
                MaintenanceTunnelIdentity::Pending,
                tunnel_config(private_key, identity),
            )
            .await
            .map_err(|error| format!("apply pending maintenance tunnel failed: {error}"))?;
        let observation = self
            .tunnel
            .observe_handshake(
                MaintenanceTunnelIdentity::Pending,
                &identity.relay.public_key,
            )
            .await;
        let mut status = self.status.lock().await;
        status.state = "reclaim_handshake_pending".to_string();
        status.public_key = lifecycle
            .active
            .as_ref()
            .map(|identity| identity.public_key.clone());
        status.active_public_key = status.public_key.clone();
        status.pending_public_key = Some(pending_public_key);
        status.reclaim_expires_at = Some(reclaim_expires_at.clone());
        status.active_identity_retained = true;
        status.handshake_verified = false;
        status.last_handshake_at = None;
        status.last_error = None;
        match observation {
            Ok(observation) if observation.verified => {
                status.state = "reclaim_handshake_verified".to_string();
                status.handshake_verified = true;
                status.last_handshake_at = observation.last_handshake_at;
                let mut lifecycle = lifecycle;
                if let Some(pending) = lifecycle.pending.as_mut() {
                    pending.handshake_verified = true;
                }
                self.save_lifecycle(&lifecycle).await?;
            }
            Ok(observation) => status.last_error = Some(observation.message),
            Err(error) => status.last_error = Some(error),
        }
        status.updated_at = Utc::now().to_rfc3339();
        Ok(status.clone())
    }

    pub async fn recover(
        &self,
        cached_identity: Option<&ProvisioningMaintenanceIdentity>,
    ) -> Result<Option<MaintenanceEnrollmentStatus>, String> {
        let lifecycle = self.load_lifecycle().await?;
        if let Some(active) = lifecycle.active.as_ref() {
            self.apply_profile(active).await?;
            if let Some(pending) = lifecycle
                .pending
                .as_ref()
                .and_then(|pending| pending.identity.as_ref())
            {
                self.apply_reclaim_profile(pending).await?;
            }
            return Ok(Some(self.status().await));
        }
        let Some(cached_identity) = cached_identity else {
            return Ok(None);
        };
        self.apply_profile(cached_identity).await.map(Some)
    }

    pub async fn promote_reclaim(
        &self,
        public_key: &str,
    ) -> Result<MaintenanceEnrollmentStatus, String> {
        let mut lifecycle = self.load_lifecycle().await?;
        let pending = lifecycle
            .pending
            .clone()
            .ok_or_else(|| "pending machine maintenance identity is unavailable".to_string())?;
        let mut identity = pending
            .identity
            .ok_or_else(|| "pending machine maintenance profile is unavailable".to_string())?;
        if identity.public_key != public_key {
            return Err("platform promoted an unexpected maintenance identity".to_string());
        }
        if !pending.handshake_verified {
            return Err("pending maintenance handshake is not verified locally".to_string());
        }
        let private_key = self
            .secrets
            .read_secret(MACHINE_WIREGUARD_PENDING_PRIVATE_KEY_ACCOUNT)
            .await?
            .ok_or_else(|| "pending machine WireGuard private key is missing".to_string())?;
        self.tunnel
            .apply(
                MaintenanceTunnelIdentity::Active,
                tunnel_config(private_key.clone(), &identity),
            )
            .await?;
        self.secrets
            .write_secret(MACHINE_WIREGUARD_PRIVATE_KEY_ACCOUNT, &private_key)
            .await?;
        self.secrets
            .write_secret(MACHINE_WIREGUARD_PENDING_PRIVATE_KEY_ACCOUNT, "")
            .await?;
        identity.reclaim_expires_at = None;
        lifecycle.active = Some(identity.clone());
        lifecycle.pending = None;
        self.save_lifecycle(&lifecycle).await?;
        self.tunnel
            .remove(MaintenanceTunnelIdentity::Pending)
            .await?;

        let mut status = self.status.lock().await;
        status.state = "handshake_verified".to_string();
        status.public_key = Some(identity.public_key.clone());
        status.active_public_key = status.public_key.clone();
        status.pending_public_key = None;
        status.reclaim_expires_at = None;
        status.active_identity_retained = true;
        status.handshake_verified = true;
        status.last_error = None;
        status.updated_at = Utc::now().to_rfc3339();
        Ok(status.clone())
    }

    pub async fn reject_reclaim(
        &self,
        public_key: &str,
        reason: &str,
    ) -> Result<MaintenanceEnrollmentStatus, String> {
        let mut lifecycle = self.load_lifecycle().await?;
        let pending_public_key = lifecycle
            .pending
            .as_ref()
            .and_then(|pending| pending.identity.as_ref())
            .map(|identity| identity.public_key.as_str())
            .ok_or_else(|| "pending machine maintenance identity is unavailable".to_string())?;
        if pending_public_key != public_key {
            return Err("platform rejected an unexpected maintenance identity".to_string());
        }
        self.recover_active_after_reclaim_timeout(&mut lifecycle)
            .await?;
        let mut status = self.status.lock().await;
        status.state = "reclaim_timed_out_recovered".to_string();
        status.public_key = lifecycle
            .active
            .as_ref()
            .map(|active| active.public_key.clone());
        status.active_public_key = status.public_key.clone();
        status.pending_public_key = None;
        status.reclaim_expires_at = None;
        status.active_identity_retained = true;
        status.handshake_verified = false;
        status.last_handshake_at = None;
        status.last_error = Some(reason.to_string());
        status.updated_at = Utc::now().to_rfc3339();
        Ok(status.clone())
    }

    async fn fail(&self, error: &str) -> Result<MaintenanceEnrollmentStatus, String> {
        let mut status = self.status.lock().await;
        status.state = "failed".to_string();
        status.last_error = Some(error.to_string());
        status.updated_at = Utc::now().to_rfc3339();
        Err(error.to_string())
    }

    pub async fn status(&self) -> MaintenanceEnrollmentStatus {
        if let Ok(mut lifecycle) = self.load_lifecycle().await {
            if let Some(pending) = lifecycle.pending.clone() {
                if let (Some(identity), Some(expires_at)) = (
                    pending.identity.as_ref(),
                    pending.reclaim_expires_at.as_ref(),
                ) {
                    let expired = DateTime::parse_from_rfc3339(expires_at)
                        .map(|value| value.with_timezone(&Utc) <= Utc::now())
                        .unwrap_or(true);
                    if expired && !pending.handshake_verified {
                        if self
                            .recover_active_after_reclaim_timeout(&mut lifecycle)
                            .await
                            .is_ok()
                        {
                            let mut status = self.status.lock().await;
                            status.state = "reclaim_timed_out_recovered".to_string();
                            status.public_key = lifecycle
                                .active
                                .as_ref()
                                .map(|active| active.public_key.clone());
                            status.active_public_key = status.public_key.clone();
                            status.pending_public_key = None;
                            status.reclaim_expires_at = None;
                            status.active_identity_retained = true;
                            status.handshake_verified = false;
                            status.last_handshake_at = None;
                            status.last_error = Some(
                                "pending reclaim handshake timed out; active identity retained"
                                    .to_string(),
                            );
                            status.updated_at = Utc::now().to_rfc3339();
                            return status.clone();
                        }
                    } else if !pending.handshake_verified {
                        match self
                            .tunnel
                            .observe_handshake(
                                MaintenanceTunnelIdentity::Pending,
                                &identity.relay.public_key,
                            )
                            .await
                        {
                            Ok(observation) if observation.verified => {
                                if let Some(value) = lifecycle.pending.as_mut() {
                                    value.handshake_verified = true;
                                }
                                let _ = self.save_lifecycle(&lifecycle).await;
                                let mut status = self.status.lock().await;
                                status.state = "reclaim_handshake_verified".to_string();
                                status.handshake_verified = true;
                                status.last_handshake_at = observation.last_handshake_at;
                                status.last_error = None;
                                status.updated_at = Utc::now().to_rfc3339();
                                return status.clone();
                            }
                            Ok(observation) => {
                                let mut status = self.status.lock().await;
                                status.last_error = Some(observation.message);
                                status.updated_at = Utc::now().to_rfc3339();
                                return status.clone();
                            }
                            Err(error) => {
                                let mut status = self.status.lock().await;
                                status.last_error = Some(error);
                                status.updated_at = Utc::now().to_rfc3339();
                                return status.clone();
                            }
                        }
                    }
                }
            }
        }
        let relay_public_key = {
            let status = self.status.lock().await;
            if status.state != "handshake_pending" {
                return status.clone();
            }
            self.relay_public_key.lock().await.clone()
        };
        let Some(relay_public_key) = relay_public_key else {
            return self.status.lock().await.clone();
        };
        let observation = self
            .tunnel
            .observe_handshake(MaintenanceTunnelIdentity::Active, &relay_public_key)
            .await;
        let mut status = self.status.lock().await;
        match observation {
            Ok(observation) if observation.verified => {
                status.state = "handshake_verified".to_string();
                status.handshake_verified = true;
                status.last_handshake_at = observation.last_handshake_at;
                status.last_error = None;
                status.updated_at = Utc::now().to_rfc3339();
            }
            Ok(observation) => {
                status.last_error = Some(observation.message);
                status.updated_at = Utc::now().to_rfc3339();
            }
            Err(error) => {
                status.last_error = Some(error);
                status.updated_at = Utc::now().to_rfc3339();
            }
        }
        status.clone()
    }

    pub async fn decommission(&self) -> Result<(), String> {
        let lifecycle = self.load_lifecycle().await.unwrap_or_default();
        if lifecycle.pending.is_some() {
            self.tunnel
                .remove(MaintenanceTunnelIdentity::Pending)
                .await?;
        }
        if lifecycle.active.is_some()
            || self
                .secrets
                .read_secret(MACHINE_WIREGUARD_PRIVATE_KEY_ACCOUNT)
                .await?
                .is_some()
        {
            self.tunnel
                .remove(MaintenanceTunnelIdentity::Active)
                .await?;
        }
        for account in [
            MACHINE_WIREGUARD_PRIVATE_KEY_ACCOUNT,
            MACHINE_WIREGUARD_PENDING_PRIVATE_KEY_ACCOUNT,
            MACHINE_MAINTENANCE_LIFECYCLE_ACCOUNT,
        ] {
            self.secrets
                .write_secret(account, "")
                .await
                .map_err(|error| {
                    format!("clear decommissioned maintenance identity failed: {error}")
                })?;
        }
        let mut status = self.status.lock().await;
        status.state = "decommissioned".to_string();
        status.public_key = None;
        status.tunnel_address = None;
        status.endpoint = None;
        status.handshake_verified = false;
        status.last_handshake_at = None;
        status.last_error = None;
        status.active_public_key = None;
        status.pending_public_key = None;
        status.reclaim_expires_at = None;
        status.active_identity_retained = false;
        status.updated_at = Utc::now().to_rfc3339();
        *self.relay_public_key.lock().await = None;
        Ok(())
    }

    async fn load_lifecycle(&self) -> Result<PersistedMaintenanceLifecycle, String> {
        let Some(value) = self
            .secrets
            .read_secret(MACHINE_MAINTENANCE_LIFECYCLE_ACCOUNT)
            .await?
        else {
            return Ok(PersistedMaintenanceLifecycle::default());
        };
        serde_json::from_str(&value)
            .map_err(|error| format!("read machine maintenance lifecycle failed: {error}"))
    }

    async fn save_lifecycle(
        &self,
        lifecycle: &PersistedMaintenanceLifecycle,
    ) -> Result<(), String> {
        let value = serde_json::to_string(lifecycle)
            .map_err(|error| format!("serialize machine maintenance lifecycle failed: {error}"))?;
        self.secrets
            .write_secret(MACHINE_MAINTENANCE_LIFECYCLE_ACCOUNT, &value)
            .await
            .map_err(|error| format!("store machine maintenance lifecycle failed: {error}"))
    }

    async fn recover_active_after_reclaim_timeout(
        &self,
        lifecycle: &mut PersistedMaintenanceLifecycle,
    ) -> Result<(), String> {
        self.tunnel
            .remove(MaintenanceTunnelIdentity::Pending)
            .await?;
        self.secrets
            .write_secret(MACHINE_WIREGUARD_PENDING_PRIVATE_KEY_ACCOUNT, "")
            .await?;
        if let Some(active) = lifecycle.active.as_ref() {
            let private_key = self
                .secrets
                .read_secret(MACHINE_WIREGUARD_PRIVATE_KEY_ACCOUNT)
                .await?
                .ok_or_else(|| "active machine WireGuard private key is missing".to_string())?;
            self.tunnel
                .apply(
                    MaintenanceTunnelIdentity::Active,
                    tunnel_config(private_key, active),
                )
                .await?;
        }
        lifecycle.pending = None;
        self.save_lifecycle(lifecycle).await
    }
}

fn tunnel_config(
    private_key: String,
    identity: &ProvisioningMaintenanceIdentity,
) -> WindowsTunnelConfig {
    WindowsTunnelConfig {
        private_key,
        address: identity.address.clone(),
        endpoint: identity.endpoint.clone(),
        relay_public_key: identity.relay.public_key.clone(),
        relay_address: identity.relay.address.clone(),
        role_routes: vec![
            identity.role_routes.relay.clone(),
            identity.role_routes.runner.clone(),
            identity.role_routes.maintainer.clone(),
        ],
    }
}

pub fn public_key_from_private_key(value: &str) -> Result<String, String> {
    let bytes = decode_key(value, "machine WireGuard private key")?;
    Ok(STANDARD.encode(PublicKey::from(&StaticSecret::from(bytes)).as_bytes()))
}

fn decode_key(value: &str, label: &str) -> Result<[u8; 32], String> {
    let bytes = STANDARD
        .decode(value)
        .map_err(|_| format!("{label} is not canonical base64"))?;
    bytes
        .try_into()
        .map_err(|_| format!("{label} must contain exactly 32 bytes"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        config::{
            MaintenanceRoleRoutes, ProvisioningMaintenanceIdentity, ProvisioningMaintenancePeer,
        },
        secret::InMemorySecretStore,
    };
    use std::{
        collections::VecDeque,
        sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    };

    #[derive(Default)]
    struct FakeTunnel {
        applies: AtomicUsize,
        observed: AtomicUsize,
        removals: AtomicUsize,
        pending_verified: AtomicBool,
    }

    #[derive(Default)]
    struct DelayedHandshakeTunnel {
        observations: AtomicUsize,
    }

    struct FakeEncryptedConfigStore {
        path: PathBuf,
        writes: Mutex<Vec<(String, Vec<u8>)>>,
    }

    #[async_trait]
    impl WireGuardEncryptedConfigStore for FakeEncryptedConfigStore {
        async fn persist(
            &self,
            tunnel_name: &str,
            plaintext_config: &[u8],
        ) -> Result<PathBuf, String> {
            self.writes
                .lock()
                .await
                .push((tunnel_name.to_string(), plaintext_config.to_vec()));
            Ok(self.path.clone())
        }
    }

    #[derive(Default)]
    struct FakeCommandRunner {
        calls: Mutex<Vec<(String, Vec<String>)>>,
        results: Mutex<VecDeque<CommandOutput>>,
    }

    #[async_trait]
    impl TunnelCommandRunner for FakeCommandRunner {
        async fn run(&self, program: &str, args: &[String]) -> Result<CommandOutput, String> {
            self.calls
                .lock()
                .await
                .push((program.to_string(), args.to_vec()));
            Ok(self.results.lock().await.pop_front().unwrap_or_default())
        }
    }

    #[async_trait]
    impl WindowsTunnelBackend for DelayedHandshakeTunnel {
        async fn apply(
            &self,
            _identity: MaintenanceTunnelIdentity,
            _config: WindowsTunnelConfig,
        ) -> Result<(), String> {
            Ok(())
        }

        async fn observe_handshake(
            &self,
            _identity: MaintenanceTunnelIdentity,
            _public_key: &str,
        ) -> Result<HandshakeObservation, String> {
            let observation = self.observations.fetch_add(1, Ordering::SeqCst);
            Ok(HandshakeObservation {
                verified: observation > 0,
                last_handshake_at: (observation > 0).then(|| "2026-07-10T00:00:00Z".to_string()),
                message: "first WireGuard handshake has not been observed".to_string(),
            })
        }
    }

    #[async_trait]
    impl WindowsTunnelBackend for FakeTunnel {
        async fn apply(
            &self,
            _identity: MaintenanceTunnelIdentity,
            config: WindowsTunnelConfig,
        ) -> Result<(), String> {
            assert!(!config.private_key.is_empty());
            assert!(!config.private_key.contains("secret"));
            self.applies.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        async fn observe_handshake(
            &self,
            identity: MaintenanceTunnelIdentity,
            _public_key: &str,
        ) -> Result<HandshakeObservation, String> {
            self.observed.fetch_add(1, Ordering::SeqCst);
            let verified = identity == MaintenanceTunnelIdentity::Active
                || self.pending_verified.load(Ordering::SeqCst);
            Ok(HandshakeObservation {
                verified,
                last_handshake_at: verified.then(|| "2026-07-10T00:00:00Z".to_string()),
                message: if verified {
                    "handshake observed".to_string()
                } else {
                    "first WireGuard handshake has not been observed".to_string()
                },
            })
        }

        async fn remove(&self, _identity: MaintenanceTunnelIdentity) -> Result<(), String> {
            self.removals.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    fn identity(public_key: String) -> ProvisioningMaintenanceIdentity {
        ProvisioningMaintenanceIdentity {
            public_key,
            tunnel_address: "10.91.16.10".to_string(),
            address: "10.91.16.10/32".to_string(),
            endpoint: "relay.example:51820".to_string(),
            relay: ProvisioningMaintenancePeer {
                public_key: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=".to_string(),
                tunnel_address: "10.91.0.1".to_string(),
                address: "10.91.0.1/32".to_string(),
            },
            role_routes: MaintenanceRoleRoutes {
                relay: "10.91.0.1/32".to_string(),
                runner: "10.91.1.0/24".to_string(),
                maintainer: "10.91.3.0/24".to_string(),
            },
            reclaim_expires_at: None,
        }
    }

    fn tunnel_config() -> WindowsTunnelConfig {
        WindowsTunnelConfig {
            private_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_string(),
            address: "10.91.16.10/32".to_string(),
            endpoint: "relay.example:51820".to_string(),
            relay_public_key: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=".to_string(),
            relay_address: "10.91.0.1/32".to_string(),
            role_routes: vec![
                "10.91.0.1/32".to_string(),
                "10.91.1.0/24".to_string(),
                "10.91.3.0/24".to_string(),
            ],
        }
    }

    #[tokio::test]
    async fn installs_one_stable_dpapi_tunnel_identity_without_plaintext_temp_files() {
        let encrypted_path = PathBuf::from(
            r"C:\Program Files\WireGuard\Data\Configurations\VEM-Maintenance.conf.dpapi",
        );
        let config_store = Arc::new(FakeEncryptedConfigStore {
            path: encrypted_path.clone(),
            writes: Mutex::new(Vec::new()),
        });
        let commands = Arc::new(FakeCommandRunner::default());
        let tunnel =
            WindowsWireGuardTunnel::with_dependencies(config_store.clone(), commands.clone());

        tunnel
            .apply(MaintenanceTunnelIdentity::Active, tunnel_config())
            .await
            .expect("apply tunnel");

        let writes = config_store.writes.lock().await;
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].0, "VEM-Maintenance");
        assert!(String::from_utf8_lossy(&writes[0].1).contains("PrivateKey = "));
        drop(writes);
        assert_eq!(
            commands.calls.lock().await.as_slice(),
            [
                (
                    "wireguard.exe".to_string(),
                    vec![
                        "/uninstalltunnelservice".to_string(),
                        "VEM-Maintenance".to_string(),
                    ],
                ),
                (
                    "wireguard.exe".to_string(),
                    vec![
                        "/installtunnelservice".to_string(),
                        encrypted_path.to_string_lossy().to_string(),
                    ],
                ),
            ]
        );
        let serialized_calls = format!("{:?}", commands.calls.lock().await.as_slice());
        assert!(!serialized_calls.contains("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="));
        assert!(!serialized_calls.to_ascii_lowercase().contains("temp"));
    }

    #[tokio::test]
    async fn failed_install_is_cleaned_up_and_retries_the_same_tunnel_identity() {
        let encrypted_path = PathBuf::from(
            r"C:\Program Files\WireGuard\Data\Configurations\VEM-Maintenance.conf.dpapi",
        );
        let config_store = Arc::new(FakeEncryptedConfigStore {
            path: encrypted_path,
            writes: Mutex::new(Vec::new()),
        });
        let commands = Arc::new(FakeCommandRunner {
            calls: Mutex::new(Vec::new()),
            results: Mutex::new(VecDeque::from([
                CommandOutput::failure(),
                CommandOutput::failure(),
                CommandOutput::success(),
                CommandOutput::failure(),
                CommandOutput::success(),
            ])),
        });
        let tunnel = WindowsWireGuardTunnel::with_dependencies(config_store, commands.clone());

        assert!(tunnel
            .apply(MaintenanceTunnelIdentity::Active, tunnel_config())
            .await
            .is_err());
        tunnel
            .apply(MaintenanceTunnelIdentity::Active, tunnel_config())
            .await
            .expect("retry tunnel");

        let calls = commands.calls.lock().await;
        assert_eq!(
            calls
                .iter()
                .filter(
                    |(_, args)| args.first().map(String::as_str) == Some("/installtunnelservice")
                )
                .count(),
            2
        );
        assert!(calls.iter().all(|(_, args)| {
            args.get(1).is_some_and(|identity| {
                identity == "VEM-Maintenance" || identity.ends_with("VEM-Maintenance.conf.dpapi")
            })
        }));
    }

    #[tokio::test]
    async fn handshake_diagnostics_use_the_stable_interface_and_selected_relay_peer() {
        let config_store = Arc::new(FakeEncryptedConfigStore {
            path: PathBuf::from("VEM-Maintenance.conf.dpapi"),
            writes: Mutex::new(Vec::new()),
        });
        let commands = Arc::new(FakeCommandRunner {
            calls: Mutex::new(Vec::new()),
            results: Mutex::new(VecDeque::from([CommandOutput::with_stdout(
                "unrelated-peer\t1780000000\nAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=\t1780000001\n",
            )])),
        });
        let tunnel = WindowsWireGuardTunnel::with_dependencies(config_store, commands.clone());

        let observation = tunnel
            .observe_handshake(
                MaintenanceTunnelIdentity::Active,
                "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
            )
            .await
            .expect("observe handshake");

        assert!(observation.verified);
        assert_eq!(
            commands.calls.lock().await.as_slice(),
            [(
                "wg.exe".to_string(),
                vec![
                    "show".to_string(),
                    "VEM-Maintenance".to_string(),
                    "latest-handshakes".to_string(),
                ]
            )]
        );
    }

    #[tokio::test]
    async fn tunnel_removal_rejects_nonzero_uninstall_with_stderr_only() {
        let config_store = Arc::new(FakeEncryptedConfigStore {
            path: PathBuf::from("VEM-Maintenance.conf.dpapi"),
            writes: Mutex::new(Vec::new()),
        });
        let commands = Arc::new(FakeCommandRunner {
            calls: Mutex::new(Vec::new()),
            results: Mutex::new(VecDeque::from([CommandOutput {
                success: false,
                stdout: String::new(),
                stderr: "service removal failed".to_string(),
            }])),
        });
        let tunnel = WindowsWireGuardTunnel::with_dependencies(config_store, commands);

        let error = tunnel
            .remove(MaintenanceTunnelIdentity::Active)
            .await
            .expect_err("nonzero uninstall must fail");

        assert_eq!(error, "WireGuard tunnel service removal failed");
    }

    #[tokio::test]
    async fn generates_once_stores_locally_and_applies_without_exposing_private_key() {
        let secrets: Arc<dyn SecretStore> = Arc::new(InMemorySecretStore::default());
        let tunnel = Arc::new(FakeTunnel::default());
        let enrollment = MaintenanceEnrollment::new(secrets.clone(), tunnel.clone());

        let public_key = enrollment.ensure_public_key().await.expect("public key");
        let status = enrollment
            .apply_profile(&identity(public_key.clone()))
            .await
            .expect("apply");

        assert_eq!(status.state, "handshake_verified");
        assert_eq!(status.public_key.as_deref(), Some(public_key.as_str()));
        assert_eq!(tunnel.applies.load(Ordering::SeqCst), 1);
        assert_eq!(tunnel.observed.load(Ordering::SeqCst), 1);
        let private_key = secrets
            .read_secret(MACHINE_WIREGUARD_PRIVATE_KEY_ACCOUNT)
            .await
            .expect("secret read")
            .expect("private key");
        assert_ne!(private_key, public_key);
        let serialized = serde_json::to_string(&status).expect("status json");
        assert!(!serialized.contains(&private_key));
    }

    #[tokio::test]
    async fn concurrent_claim_retries_reuse_one_local_machine_identity() {
        let secrets: Arc<dyn SecretStore> = Arc::new(InMemorySecretStore::default());
        let enrollment =
            MaintenanceEnrollment::new(secrets, Arc::new(DelayedHandshakeTunnel::default()));

        let (first, second) = tokio::join!(
            enrollment.ensure_public_key(),
            enrollment.ensure_public_key(),
        );

        assert_eq!(first.expect("first key"), second.expect("second key"));
    }

    #[tokio::test]
    async fn status_refreshes_a_handshake_that_arrives_after_tunnel_apply() {
        let secrets = Arc::new(InMemorySecretStore::default());
        let tunnel = Arc::new(DelayedHandshakeTunnel::default());
        let enrollment = MaintenanceEnrollment::new(secrets, tunnel);
        let public_key = enrollment.ensure_public_key().await.expect("public key");
        let profile = identity(public_key);

        let pending = enrollment.apply_profile(&profile).await.expect("apply");
        assert_eq!(pending.state, "handshake_pending");
        assert!(!pending.handshake_verified);

        let verified = enrollment.status().await;
        assert_eq!(verified.state, "handshake_verified");
        assert!(verified.handshake_verified);
        assert_eq!(
            verified.last_handshake_at.as_deref(),
            Some("2026-07-10T00:00:00Z")
        );
    }

    #[tokio::test]
    async fn secure_decommission_removes_tunnel_and_all_protected_identity_material() {
        let secrets = Arc::new(InMemorySecretStore::default());
        secrets
            .write_secret(MACHINE_WIREGUARD_PRIVATE_KEY_ACCOUNT, "private")
            .await
            .expect("seed key");
        secrets
            .write_secret(crate::secret::MACHINE_SECRET_ACCOUNT, "business")
            .await
            .expect("seed business secret");
        let tunnel = Arc::new(FakeTunnel::default());
        let enrollment = MaintenanceEnrollment::new(secrets.clone(), tunnel.clone());

        enrollment.decommission().await.expect("decommission");

        assert_eq!(tunnel.removals.load(Ordering::SeqCst), 1);
        assert!(secrets
            .read_secret(MACHINE_WIREGUARD_PRIVATE_KEY_ACCOUNT)
            .await
            .expect("read key")
            .is_none());
        assert_eq!(enrollment.status().await.state, "decommissioned");
    }

    #[tokio::test]
    async fn reclaim_retries_reuse_pending_identity_and_timeout_recovers_active_tunnel() {
        let secrets = Arc::new(InMemorySecretStore::default());
        let tunnel = Arc::new(FakeTunnel::default());
        let enrollment = MaintenanceEnrollment::new(secrets.clone(), tunnel.clone());
        let active_public_key = enrollment.ensure_public_key().await.expect("active key");
        let active_identity = identity(active_public_key.clone());
        enrollment
            .apply_profile(&active_identity)
            .await
            .expect("active profile");
        let active_private_key = secrets
            .read_secret(MACHINE_WIREGUARD_PRIVATE_KEY_ACCOUNT)
            .await
            .expect("active key read")
            .expect("active key exists");

        let first_pending = enrollment
            .ensure_reclaim_public_key("ABCD-2345", Some(&active_identity))
            .await
            .expect("pending key");
        let retried_pending = enrollment
            .ensure_reclaim_public_key("ABCD-2345", Some(&active_identity))
            .await
            .expect("same pending key");

        assert_eq!(first_pending, retried_pending);
        assert_ne!(first_pending, active_public_key);
        assert_eq!(
            secrets
                .read_secret(MACHINE_WIREGUARD_PRIVATE_KEY_ACCOUNT)
                .await
                .expect("active key read")
                .as_deref(),
            Some(active_private_key.as_str()),
        );

        let mut pending_identity = identity(first_pending);
        pending_identity.tunnel_address = "10.91.16.11".to_string();
        pending_identity.address = "10.91.16.11/32".to_string();
        pending_identity.reclaim_expires_at = Some("2020-01-01T00:00:00Z".to_string());
        enrollment
            .apply_reclaim_profile(&pending_identity)
            .await
            .expect("pending profile");

        let recovered = enrollment.status().await;
        assert_eq!(recovered.state, "reclaim_timed_out_recovered");
        assert_eq!(
            recovered.public_key.as_deref(),
            Some(active_public_key.as_str())
        );
        assert_eq!(tunnel.removals.load(Ordering::SeqCst), 1);
        assert_eq!(tunnel.applies.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn restart_recovers_both_active_and_pending_reclaim_tunnels() {
        let secrets = Arc::new(InMemorySecretStore::default());
        let initial = MaintenanceEnrollment::new(secrets.clone(), Arc::new(FakeTunnel::default()));
        let active_public_key = initial.ensure_public_key().await.expect("active key");
        let active_identity = identity(active_public_key);
        initial
            .apply_profile(&active_identity)
            .await
            .expect("active profile");
        let pending_public_key = initial
            .ensure_reclaim_public_key("ABCD-2345", Some(&active_identity))
            .await
            .expect("pending key");
        let mut pending_identity = identity(pending_public_key.clone());
        pending_identity.tunnel_address = "10.91.16.12".to_string();
        pending_identity.address = "10.91.16.12/32".to_string();
        pending_identity.reclaim_expires_at = Some("2099-01-01T00:00:00Z".to_string());
        initial
            .apply_reclaim_profile(&pending_identity)
            .await
            .expect("pending profile");

        let recovered_tunnel = Arc::new(FakeTunnel::default());
        let restarted = MaintenanceEnrollment::new(secrets, recovered_tunnel.clone());
        let recovered = restarted
            .recover(Some(&pending_identity))
            .await
            .expect("recovery")
            .expect("recovered status");

        assert_eq!(recovered.state, "reclaim_handshake_pending");
        assert_eq!(
            recovered.pending_public_key.as_deref(),
            Some(pending_public_key.as_str())
        );
        assert!(recovered.active_identity_retained);
        assert_eq!(recovered_tunnel.applies.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn platform_confirmation_promotes_pending_identity_and_retires_old_local_key() {
        let secrets = Arc::new(InMemorySecretStore::default());
        let tunnel = Arc::new(FakeTunnel::default());
        let enrollment = MaintenanceEnrollment::new(secrets.clone(), tunnel.clone());
        let active_public_key = enrollment.ensure_public_key().await.expect("active key");
        let active_identity = identity(active_public_key);
        enrollment
            .apply_profile(&active_identity)
            .await
            .expect("active profile");
        let pending_public_key = enrollment
            .ensure_reclaim_public_key("ABCD-2345", Some(&active_identity))
            .await
            .expect("pending key");
        let mut pending_identity = identity(pending_public_key.clone());
        pending_identity.tunnel_address = "10.91.16.13".to_string();
        pending_identity.address = "10.91.16.13/32".to_string();
        pending_identity.reclaim_expires_at = Some("2099-01-01T00:00:00Z".to_string());
        tunnel.pending_verified.store(true, Ordering::SeqCst);
        enrollment
            .apply_reclaim_profile(&pending_identity)
            .await
            .expect("pending profile");

        let promoted = enrollment
            .promote_reclaim(&pending_public_key)
            .await
            .expect("promote pending identity");

        assert_eq!(promoted.state, "handshake_verified");
        assert_eq!(
            promoted.public_key.as_deref(),
            Some(pending_public_key.as_str())
        );
        assert!(promoted.pending_public_key.is_none());
        assert_eq!(tunnel.removals.load(Ordering::SeqCst), 1);
        let active_private = secrets
            .read_secret(MACHINE_WIREGUARD_PRIVATE_KEY_ACCOUNT)
            .await
            .expect("active key")
            .expect("active key exists");
        assert_eq!(
            public_key_from_private_key(&active_private).expect("public"),
            pending_public_key
        );
        assert!(secrets
            .read_secret(MACHINE_WIREGUARD_PENDING_PRIVATE_KEY_ACCOUNT)
            .await
            .expect("pending key")
            .is_none());
    }
}

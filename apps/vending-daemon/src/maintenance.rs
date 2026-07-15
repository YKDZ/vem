use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

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

#[cfg(windows)]
use crate::secret::harden_machine_protected_file_permissions;

const WINDOWS_TUNNEL_NAME: &str = "VEM-Maintenance";
const WINDOWS_WIREGUARD_EXECUTABLE: &str = "wireguard.exe";
const WINDOWS_WG_EXECUTABLE: &str = "wg.exe";
const WINDOWS_WIREGUARD_DIRECTORY: &str = "WireGuard";
const WINDOWS_TUNNEL_INSTALL_ATTEMPTS: usize = 20;
const WINDOWS_TUNNEL_INSTALL_RETRY_DELAY: Duration = Duration::from_millis(250);

#[derive(Clone)]
struct WireGuardExecutables {
    wireguard: PathBuf,
    wg: PathBuf,
}

fn pinned_wireguard_executable_candidates(
    executable: &str,
    program_files: Option<PathBuf>,
    program_files_x86: Option<PathBuf>,
) -> Vec<PathBuf> {
    [program_files, program_files_x86]
        .into_iter()
        .flatten()
        .map(|root| root.join(WINDOWS_WIREGUARD_DIRECTORY).join(executable))
        .collect()
}

fn resolve_pinned_wireguard_executable_from_roots<F>(
    executable: &str,
    program_files: Option<PathBuf>,
    program_files_x86: Option<PathBuf>,
    exists: F,
) -> Result<PathBuf, String>
where
    F: Fn(&Path) -> bool,
{
    let candidates =
        pinned_wireguard_executable_candidates(executable, program_files, program_files_x86);
    if let Some(path) = candidates.iter().find(|path| exists(path)) {
        return Ok(path.clone());
    }
    if candidates.is_empty() {
        return Err(format!(
            "pinned WireGuard executable {executable} cannot be resolved: ProgramFiles and ProgramFiles(x86) are unavailable"
        ));
    }
    Err(format!(
        "pinned WireGuard executable {executable} was not found; checked {}",
        candidates
            .iter()
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>()
            .join(", "),
    ))
}

fn resolve_pinned_wireguard_executable(executable: &str) -> Result<PathBuf, String> {
    resolve_pinned_wireguard_executable_from_roots(
        executable,
        std::env::var_os("ProgramFiles").map(PathBuf::from),
        std::env::var_os("ProgramFiles(x86)").map(PathBuf::from),
        Path::is_file,
    )
}
const WIREGUARD_HANDSHAKE_FRESH_SECONDS: i64 = 180;

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
            if let Ok(existing) = tokio::fs::read(&path).await {
                let existing_plaintext = tokio::task::spawn_blocking(move || {
                    crate::secret::unprotect_machine_local_bytes_blocking(&existing)
                })
                .await
                .map_err(|error| format!("join WireGuard DPAPI unprotect failed: {error}"))?;
                if existing_plaintext.is_ok_and(|value| value == plaintext_config) {
                    harden_machine_protected_file_permissions(&path)
                        .await
                        .map_err(|error| {
                            format!("harden reused WireGuard configuration failed: {error}")
                        })?;
                    return Ok(path);
                }
            }
            let plaintext_config = plaintext_config.to_vec();
            let encrypted = tokio::task::spawn_blocking(move || {
                // WireGuard config has the same machine-scope lifecycle as every
                // daemon secret: LocalMachine DPAPI, UI forbidden, SYSTEM/Admin ACL.
                crate::secret::protect_machine_local_bytes_blocking(&plaintext_config)
            })
            .await
            .map_err(|error| format!("join WireGuard DPAPI protection failed: {error}"))??;
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
    harden_machine_protected_file_permissions(staging_path)
        .await
        .map_err(|error| format!("harden encrypted WireGuard configuration failed: {error}"))?;
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
        .map_err(|error| format!("replace encrypted WireGuard configuration failed: {error}"))?;
    harden_machine_protected_file_permissions(path)
        .await
        .map_err(|error| format!("harden replaced WireGuard configuration failed: {error}"))
}

#[derive(Clone)]
pub struct WindowsWireGuardTunnel {
    enabled: bool,
    config_store: Arc<dyn WireGuardEncryptedConfigStore>,
    commands: Arc<dyn TunnelCommandRunner>,
    executables: Option<WireGuardExecutables>,
    install_retry_delay: Duration,
    apply_lock: Arc<Mutex<()>>,
}

impl Default for WindowsWireGuardTunnel {
    fn default() -> Self {
        Self {
            enabled: cfg!(windows),
            config_store: Arc::new(WindowsDpapiWireGuardConfigStore),
            commands: Arc::new(ProcessTunnelCommandRunner),
            executables: None,
            install_retry_delay: WINDOWS_TUNNEL_INSTALL_RETRY_DELAY,
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
            executables: Some(WireGuardExecutables {
                wireguard: PathBuf::from(r"C:\Program Files\WireGuard\wireguard.exe"),
                wg: PathBuf::from(r"C:\Program Files\WireGuard\wg.exe"),
            }),
            install_retry_delay: Duration::from_millis(0),
            apply_lock: Arc::new(Mutex::new(())),
        }
    }

    fn executable(&self, name: &str) -> Result<String, String> {
        let path = match self.executables.as_ref() {
            Some(executables) => match name {
                WINDOWS_WIREGUARD_EXECUTABLE => executables.wireguard.clone(),
                WINDOWS_WG_EXECUTABLE => executables.wg.clone(),
                _ => return Err(format!("unsupported pinned WireGuard executable: {name}")),
            },
            None => resolve_pinned_wireguard_executable(name)?,
        };
        Ok(path.to_string_lossy().into_owned())
    }

    async fn uninstall_service(
        &self,
        wireguard_executable: &str,
        tunnel_name: &str,
    ) -> Result<CommandOutput, String> {
        self.commands
            .run(
                wireguard_executable,
                &[
                    "/uninstalltunnelservice".to_string(),
                    tunnel_name.to_string(),
                ],
            )
            .await
    }

    async fn install_service_after_removal(
        &self,
        wireguard_executable: &str,
        config_path: &Path,
    ) -> Result<(), String> {
        let args = vec![
            "/installtunnelservice".to_string(),
            config_path.to_string_lossy().to_string(),
        ];
        for attempt in 0..WINDOWS_TUNNEL_INSTALL_ATTEMPTS {
            let install = self
                .commands
                .run(wireguard_executable, &args)
                .await
                .map_err(|_| "WireGuard tunnel service installation failed".to_string())?;
            if install.success {
                return Ok(());
            }
            if attempt + 1 < WINDOWS_TUNNEL_INSTALL_ATTEMPTS {
                tokio::time::sleep(self.install_retry_delay).await;
            }
        }
        Err("WireGuard tunnel service rejected configuration".to_string())
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
        let wireguard_executable = self.executable(WINDOWS_WIREGUARD_EXECUTABLE)?;
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
        let _ = self
            .uninstall_service(&wireguard_executable, tunnel_name)
            .await;
        if let Err(error) = self
            .install_service_after_removal(&wireguard_executable, &path)
            .await
        {
            let _ = self
                .uninstall_service(&wireguard_executable, tunnel_name)
                .await;
            return Err(error);
        }
        Ok(())
    }

    async fn remove(&self, identity: MaintenanceTunnelIdentity) -> Result<(), String> {
        if !self.enabled {
            return Ok(());
        }
        let _guard = self.apply_lock.lock().await;
        let tunnel_name = identity.tunnel_name();
        let wireguard_executable = self.executable(WINDOWS_WIREGUARD_EXECUTABLE)?;
        let uninstall = self
            .uninstall_service(&wireguard_executable, tunnel_name)
            .await?;
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
        let wg_executable = self.executable(WINDOWS_WG_EXECUTABLE)?;
        let output = self
            .commands
            .run(
                &wg_executable,
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
        let now = Utc::now().timestamp();
        let connected = latest.is_some_and(|value| {
            value <= now + 30 && value >= now - WIREGUARD_HANDSHAKE_FRESH_SECONDS
        });
        Ok(HandshakeObservation {
            verified: connected,
            last_handshake_at: latest.and_then(|value| {
                chrono::DateTime::from_timestamp(value, 0).map(|date| date.to_rfc3339())
            }),
            message: if connected {
                "first WireGuard handshake observed".to_string()
            } else if latest.is_some() {
                "WireGuard handshake is stale".to_string()
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
    pub tunnel_connected: bool,
    pub first_handshake_verified_at: Option<String>,
    pub last_handshake_at: Option<String>,
    pub last_error: Option<String>,
    pub alert_code: Option<String>,
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
            tunnel_connected: false,
            first_handshake_verified_at: None,
            last_handshake_at: None,
            last_error: None,
            alert_code: None,
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
    #[serde(default)]
    active_first_handshake_at: Option<String>,
    pending: Option<PersistedPendingMaintenanceIdentity>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedPendingMaintenanceIdentity {
    claim_code_digest: String,
    identity: Option<ProvisioningMaintenanceIdentity>,
    reclaim_expires_at: Option<String>,
    handshake_verified: bool,
    #[serde(default)]
    first_handshake_at: Option<String>,
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
            first_handshake_at: None,
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
        status.tunnel_connected = false;
        status.first_handshake_verified_at = lifecycle.active_first_handshake_at.clone();
        status.last_handshake_at = None;
        status.state = "reclaim_request_pending".to_string();
        status.last_error = None;
        status.alert_code = None;
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
            return Err("maintenance public key differs from claimed identity".to_string());
        }
        let private_key = self
            .secrets
            .read_secret(MACHINE_WIREGUARD_PRIVATE_KEY_ACCOUNT)
            .await?
            .ok_or_else(|| "machine WireGuard private key is missing".to_string())?;
        // Machine Claim owns the durable identity boundary. Persist the
        // claim-bound tunnel intent before touching Windows service state so
        // a temporary apply failure can be retried after this process exits.
        let mut lifecycle = self.load_lifecycle().await?;
        if lifecycle
            .active
            .as_ref()
            .is_some_and(|active| active.public_key != identity.public_key)
        {
            lifecycle.active_first_handshake_at = None;
        }
        lifecycle.active = Some(identity.clone());
        self.save_lifecycle(&lifecycle).await?;
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
        status.alert_code = None;
        match observation {
            Ok(observation) => {
                if observation.verified && lifecycle.active_first_handshake_at.is_none() {
                    lifecycle.active_first_handshake_at = observation.last_handshake_at.clone();
                    self.save_lifecycle(&lifecycle).await?;
                }
                status.handshake_verified = lifecycle.active_first_handshake_at.is_some();
                status.tunnel_connected = observation.verified;
                status.first_handshake_verified_at = lifecycle.active_first_handshake_at.clone();
                status.last_handshake_at = observation
                    .last_handshake_at
                    .or_else(|| lifecycle.active_first_handshake_at.clone());
                status.state = match (status.handshake_verified, status.tunnel_connected) {
                    (true, true) => "handshake_verified".to_string(),
                    (true, false) => "tunnel_degraded".to_string(),
                    (false, _) => "handshake_pending".to_string(),
                };
                if !status.tunnel_connected {
                    status.last_error = Some(observation.message);
                    if status.handshake_verified {
                        status.alert_code = Some("MAINTENANCE_TUNNEL_DEGRADED".to_string());
                    }
                }
            }
            Err(error) => {
                status.handshake_verified = lifecycle.active_first_handshake_at.is_some();
                status.tunnel_connected = false;
                status.first_handshake_verified_at = lifecycle.active_first_handshake_at.clone();
                status.last_handshake_at = lifecycle.active_first_handshake_at.clone();
                status.state = if status.handshake_verified {
                    "tunnel_degraded".to_string()
                } else {
                    "handshake_pending".to_string()
                };
                status.last_error = Some(error);
                if status.handshake_verified {
                    status.alert_code = Some("MAINTENANCE_TUNNEL_DEGRADED".to_string());
                }
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
            return Err("pending maintenance public key differs from claimed identity".to_string());
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
        pending.first_handshake_at = None;
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
        status.first_handshake_verified_at = lifecycle.active_first_handshake_at.clone();
        status.last_handshake_at = None;
        status.last_error = None;
        status.alert_code = None;
        match observation {
            Ok(observation) if observation.verified => {
                status.state = "reclaim_handshake_verified".to_string();
                status.handshake_verified = true;
                status.last_handshake_at = observation.last_handshake_at.clone();
                let mut lifecycle = lifecycle;
                if let Some(pending) = lifecycle.pending.as_mut() {
                    pending.handshake_verified = true;
                    pending.first_handshake_at = observation.last_handshake_at;
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
            if let Err(error) = self.apply_profile(active).await {
                let status = self.status.lock().await.clone();
                if status.active_identity_retained
                    && matches!(
                        status.state.as_str(),
                        "tunnel_apply_pending" | "tunnel_degraded"
                    )
                {
                    return Ok(Some(status));
                }
                return Err(error);
            }
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

    pub async fn retry_active_convergence(&self) -> Result<MaintenanceEnrollmentStatus, String> {
        let identity = self
            .load_lifecycle()
            .await?
            .active
            .ok_or_else(|| "claim-bound maintenance identity is unavailable".to_string())?;
        self.apply_profile(&identity).await
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
        lifecycle.active_first_handshake_at = pending.first_handshake_at.clone();
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
        status.tunnel_connected = true;
        status.first_handshake_verified_at = lifecycle.active_first_handshake_at.clone();
        status.last_handshake_at = lifecycle.active_first_handshake_at.clone();
        status.last_error = None;
        status.alert_code = None;
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
        status.handshake_verified = lifecycle.active_first_handshake_at.is_some();
        status.tunnel_connected = false;
        status.first_handshake_verified_at = lifecycle.active_first_handshake_at.clone();
        status.last_handshake_at = lifecycle.active_first_handshake_at.clone();
        status.last_error = Some(reason.to_string());
        status.alert_code = Some("MAINTENANCE_TUNNEL_DEGRADED".to_string());
        status.updated_at = Utc::now().to_rfc3339();
        Ok(status.clone())
    }

    async fn fail(&self, error: &str) -> Result<MaintenanceEnrollmentStatus, String> {
        let lifecycle = self.load_lifecycle().await.unwrap_or_default();
        let mut status = self.status.lock().await;
        if let Some(identity) = lifecycle.active.as_ref() {
            status.public_key = Some(identity.public_key.clone());
            status.active_public_key = Some(identity.public_key.clone());
            status.tunnel_address = Some(identity.address.clone());
            status.endpoint = Some(identity.endpoint.clone());
            status.active_identity_retained = true;
        }
        status.handshake_verified = lifecycle.active_first_handshake_at.is_some();
        status.tunnel_connected = false;
        status.first_handshake_verified_at = lifecycle.active_first_handshake_at.clone();
        status.last_handshake_at = lifecycle.active_first_handshake_at;
        status.state = if status.handshake_verified {
            "tunnel_degraded".to_string()
        } else if lifecycle.active.is_some() {
            "tunnel_apply_pending".to_string()
        } else {
            "failed".to_string()
        };
        status.last_error = Some(error.to_string());
        status.alert_code = Some(if status.handshake_verified {
            "MAINTENANCE_TUNNEL_DEGRADED".to_string()
        } else {
            "MAINTENANCE_TUNNEL_CONVERGENCE_REQUIRED".to_string()
        });
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
                            status.handshake_verified =
                                lifecycle.active_first_handshake_at.is_some();
                            status.tunnel_connected = false;
                            status.first_handshake_verified_at =
                                lifecycle.active_first_handshake_at.clone();
                            status.last_handshake_at = lifecycle.active_first_handshake_at.clone();
                            status.last_error = Some(
                                "pending reclaim handshake timed out; active identity retained"
                                    .to_string(),
                            );
                            status.alert_code = Some("MAINTENANCE_TUNNEL_DEGRADED".to_string());
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
                                    value.first_handshake_at =
                                        observation.last_handshake_at.clone();
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
        let Ok(mut lifecycle) = self.load_lifecycle().await else {
            return self.status.lock().await.clone();
        };
        let Some(identity) = lifecycle.active.clone() else {
            return self.status.lock().await.clone();
        };
        let observation = self
            .tunnel
            .observe_handshake(
                MaintenanceTunnelIdentity::Active,
                &identity.relay.public_key,
            )
            .await;
        if let Ok(observation) = observation.as_ref() {
            if observation.verified && lifecycle.active_first_handshake_at.is_none() {
                lifecycle.active_first_handshake_at = observation.last_handshake_at.clone();
                let _ = self.save_lifecycle(&lifecycle).await;
            }
        }
        let mut status = self.status.lock().await;
        status.public_key = Some(identity.public_key.clone());
        status.active_public_key = Some(identity.public_key);
        status.tunnel_address = Some(identity.address);
        status.endpoint = Some(identity.endpoint);
        status.active_identity_retained = true;
        status.handshake_verified = lifecycle.active_first_handshake_at.is_some();
        status.first_handshake_verified_at = lifecycle.active_first_handshake_at.clone();
        status.alert_code = None;
        match observation {
            Ok(observation) if observation.verified => {
                status.state = "handshake_verified".to_string();
                status.tunnel_connected = true;
                status.last_handshake_at = observation.last_handshake_at;
                status.last_error = None;
                status.updated_at = Utc::now().to_rfc3339();
            }
            Ok(observation) => {
                status.tunnel_connected = false;
                status.state = if status.handshake_verified {
                    "tunnel_degraded".to_string()
                } else {
                    "handshake_pending".to_string()
                };
                status.last_handshake_at = observation
                    .last_handshake_at
                    .or_else(|| lifecycle.active_first_handshake_at.clone());
                status.last_error = Some(observation.message);
                status.alert_code = Some(if status.handshake_verified {
                    "MAINTENANCE_TUNNEL_DEGRADED".to_string()
                } else {
                    "MAINTENANCE_TUNNEL_FIRST_HANDSHAKE_REQUIRED".to_string()
                });
                status.updated_at = Utc::now().to_rfc3339();
            }
            Err(error) => {
                status.tunnel_connected = false;
                status.state = if status.handshake_verified {
                    "tunnel_degraded".to_string()
                } else {
                    "handshake_pending".to_string()
                };
                status.last_handshake_at = lifecycle.active_first_handshake_at;
                status.last_error = Some(error);
                status.alert_code = Some(if status.handshake_verified {
                    "MAINTENANCE_TUNNEL_DEGRADED".to_string()
                } else {
                    "MAINTENANCE_TUNNEL_FIRST_HANDSHAKE_REQUIRED".to_string()
                });
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
        status.tunnel_connected = false;
        status.first_handshake_verified_at = None;
        status.last_handshake_at = None;
        status.last_error = None;
        status.alert_code = None;
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

    #[derive(Default)]
    struct RecoverableApplyTunnel {
        fail_apply: AtomicBool,
        applies: AtomicUsize,
    }

    struct FixedConnectivityTunnel {
        connected: AtomicBool,
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
    impl WindowsTunnelBackend for RecoverableApplyTunnel {
        async fn apply(
            &self,
            _identity: MaintenanceTunnelIdentity,
            _config: WindowsTunnelConfig,
        ) -> Result<(), String> {
            self.applies.fetch_add(1, Ordering::SeqCst);
            if self.fail_apply.load(Ordering::SeqCst) {
                Err("injected tunnel apply failure".to_string())
            } else {
                Ok(())
            }
        }

        async fn observe_handshake(
            &self,
            _identity: MaintenanceTunnelIdentity,
            _public_key: &str,
        ) -> Result<HandshakeObservation, String> {
            Ok(HandshakeObservation {
                verified: true,
                last_handshake_at: Some("2026-07-15T00:00:00Z".to_string()),
                message: "handshake observed".to_string(),
            })
        }
    }

    #[async_trait]
    impl WindowsTunnelBackend for FixedConnectivityTunnel {
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
            let connected = self.connected.load(Ordering::SeqCst);
            Ok(HandshakeObservation {
                verified: connected,
                last_handshake_at: connected.then(|| "2026-07-15T01:00:00Z".to_string()),
                message: if connected {
                    "handshake observed".to_string()
                } else {
                    "WireGuard handshake is stale".to_string()
                },
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

    #[test]
    fn resolves_pinned_wireguard_executables_from_program_files_before_x86_fallback() {
        let program_files = PathBuf::from("/pinned/Program Files");
        let program_files_x86 = PathBuf::from("/pinned/Program Files (x86)");
        let primary = program_files
            .join(WINDOWS_WIREGUARD_DIRECTORY)
            .join(WINDOWS_WIREGUARD_EXECUTABLE);
        let x86_fallback = program_files_x86
            .join(WINDOWS_WIREGUARD_DIRECTORY)
            .join(WINDOWS_WIREGUARD_EXECUTABLE);

        let selected = resolve_pinned_wireguard_executable_from_roots(
            WINDOWS_WIREGUARD_EXECUTABLE,
            Some(program_files.clone()),
            Some(program_files_x86.clone()),
            |path| path == primary || path == x86_fallback,
        )
        .expect("select primary pinned executable");
        assert_eq!(selected, primary);

        let selected = resolve_pinned_wireguard_executable_from_roots(
            WINDOWS_WIREGUARD_EXECUTABLE,
            Some(program_files),
            Some(program_files_x86),
            |path| path == x86_fallback,
        )
        .expect("select x86 fallback executable");
        assert_eq!(selected, x86_fallback);
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
                    r"C:\Program Files\WireGuard\wireguard.exe".to_string(),
                    vec![
                        "/uninstalltunnelservice".to_string(),
                        "VEM-Maintenance".to_string(),
                    ],
                ),
                (
                    r"C:\Program Files\WireGuard\wireguard.exe".to_string(),
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
    async fn install_retries_after_service_removal_until_the_stable_identity_is_accepted() {
        let encrypted_path = PathBuf::from(
            r"C:\Program Files\WireGuard\Data\Configurations\VEM-Maintenance.conf.dpapi",
        );
        let config_store = Arc::new(FakeEncryptedConfigStore {
            path: encrypted_path.clone(),
            writes: Mutex::new(Vec::new()),
        });
        let commands = Arc::new(FakeCommandRunner {
            calls: Mutex::new(Vec::new()),
            results: Mutex::new(VecDeque::from([
                CommandOutput::success(),
                CommandOutput {
                    success: false,
                    stdout: "ignored".to_string(),
                    stderr: "ignored".to_string(),
                },
                CommandOutput::success(),
            ])),
        });
        let tunnel = WindowsWireGuardTunnel::with_dependencies(config_store, commands.clone());

        tunnel
            .apply(MaintenanceTunnelIdentity::Active, tunnel_config())
            .await
            .expect("retry after service deletion");

        assert_eq!(
            commands.calls.lock().await.as_slice(),
            [
                (
                    r"C:\Program Files\WireGuard\wireguard.exe".to_string(),
                    vec![
                        "/uninstalltunnelservice".to_string(),
                        "VEM-Maintenance".to_string(),
                    ],
                ),
                (
                    r"C:\Program Files\WireGuard\wireguard.exe".to_string(),
                    vec![
                        "/installtunnelservice".to_string(),
                        encrypted_path.to_string_lossy().to_string(),
                    ],
                ),
                (
                    r"C:\Program Files\WireGuard\wireguard.exe".to_string(),
                    vec![
                        "/installtunnelservice".to_string(),
                        encrypted_path.to_string_lossy().to_string(),
                    ],
                ),
            ]
        );
    }

    #[tokio::test]
    async fn rejected_install_is_cleaned_up_and_returns_a_generic_error() {
        let encrypted_path = PathBuf::from(
            r"C:\Program Files\WireGuard\Data\Configurations\VEM-Maintenance.conf.dpapi",
        );
        let config_store = Arc::new(FakeEncryptedConfigStore {
            path: encrypted_path.clone(),
            writes: Mutex::new(Vec::new()),
        });
        let mut results = VecDeque::from([
            CommandOutput::success(),
            CommandOutput {
                success: false,
                stdout: "PrivateKey = AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_string(),
                stderr: "WireGuard diagnostic output".to_string(),
            },
        ]);
        results.extend(
            std::iter::repeat_with(CommandOutput::failure)
                .take(WINDOWS_TUNNEL_INSTALL_ATTEMPTS - 1),
        );
        results.extend([
            CommandOutput::success(),
            CommandOutput::success(),
            CommandOutput::success(),
        ]);
        let commands = Arc::new(FakeCommandRunner {
            calls: Mutex::new(Vec::new()),
            results: Mutex::new(results),
        });
        let tunnel = WindowsWireGuardTunnel::with_dependencies(config_store, commands.clone());

        let error = tunnel
            .apply(MaintenanceTunnelIdentity::Active, tunnel_config())
            .await
            .expect_err("reject configuration after bounded retries");
        assert_eq!(error, "WireGuard tunnel service rejected configuration");
        assert!(!error.contains("PrivateKey"));
        assert!(!error.contains("diagnostic"));
        tunnel
            .apply(MaintenanceTunnelIdentity::Active, tunnel_config())
            .await
            .expect("retry tunnel");

        let calls = commands.calls.lock().await;
        let uninstall_call = (
            r"C:\Program Files\WireGuard\wireguard.exe".to_string(),
            vec![
                "/uninstalltunnelservice".to_string(),
                "VEM-Maintenance".to_string(),
            ],
        );
        let install_call = (
            r"C:\Program Files\WireGuard\wireguard.exe".to_string(),
            vec![
                "/installtunnelservice".to_string(),
                encrypted_path.to_string_lossy().to_string(),
            ],
        );
        let mut expected_calls = Vec::with_capacity(WINDOWS_TUNNEL_INSTALL_ATTEMPTS + 4);
        expected_calls.push(uninstall_call.clone());
        expected_calls.extend((0..WINDOWS_TUNNEL_INSTALL_ATTEMPTS).map(|_| install_call.clone()));
        expected_calls.push(uninstall_call.clone());
        expected_calls.push(uninstall_call);
        expected_calls.push(install_call);

        assert_eq!(calls.as_slice(), expected_calls.as_slice());
        assert_eq!(
            calls
                .iter()
                .filter(|(_, args)| {
                    args.first().map(String::as_str) == Some("/uninstalltunnelservice")
                })
                .count(),
            3
        );
    }

    #[tokio::test]
    async fn handshake_diagnostics_use_the_stable_interface_and_selected_relay_peer() {
        let config_store = Arc::new(FakeEncryptedConfigStore {
            path: PathBuf::from("VEM-Maintenance.conf.dpapi"),
            writes: Mutex::new(Vec::new()),
        });
        let fresh_handshake = Utc::now().timestamp();
        let commands = Arc::new(FakeCommandRunner {
            calls: Mutex::new(Vec::new()),
            results: Mutex::new(VecDeque::from([CommandOutput::with_stdout(&format!(
                "unrelated-peer\t{fresh_handshake}\nAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=\t{fresh_handshake}\n",
            ))])),
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
                r"C:\Program Files\WireGuard\wg.exe".to_string(),
                vec![
                    "show".to_string(),
                    "VEM-Maintenance".to_string(),
                    "latest-handshakes".to_string(),
                ]
            )]
        );
    }

    #[tokio::test]
    async fn stale_handshake_is_retained_as_evidence_but_reports_disconnected() {
        let config_store = Arc::new(FakeEncryptedConfigStore {
            path: PathBuf::from("VEM-Maintenance.conf.dpapi"),
            writes: Mutex::new(Vec::new()),
        });
        let stale_handshake = Utc::now().timestamp() - 600;
        let commands = Arc::new(FakeCommandRunner {
            calls: Mutex::new(Vec::new()),
            results: Mutex::new(VecDeque::from([CommandOutput::with_stdout(&format!(
                "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=\t{stale_handshake}\n",
            ))])),
        });
        let tunnel = WindowsWireGuardTunnel::with_dependencies(config_store, commands);

        let observation = tunnel
            .observe_handshake(
                MaintenanceTunnelIdentity::Active,
                "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
            )
            .await
            .expect("observe stale handshake");

        assert!(!observation.verified);
        assert!(observation.last_handshake_at.is_some());
        assert_eq!(observation.message, "WireGuard handshake is stale");
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
    async fn claimed_identity_survives_tunnel_apply_failure_and_restart_retry() {
        let secrets = Arc::new(InMemorySecretStore::default());
        let tunnel = Arc::new(RecoverableApplyTunnel::default());
        tunnel.fail_apply.store(true, Ordering::SeqCst);
        let claimed = MaintenanceEnrollment::new(secrets.clone(), tunnel.clone());
        let public_key = claimed.ensure_public_key().await.expect("public key");

        let error = claimed
            .apply_profile(&identity(public_key.clone()))
            .await
            .expect_err("first tunnel application fails");
        assert_eq!(error, "injected tunnel apply failure");

        let restarted = MaintenanceEnrollment::new(secrets, tunnel.clone());
        let pending = restarted
            .recover(None)
            .await
            .expect("tunnel outage must not refuse daemon restart")
            .expect("claim-bound identity retained before tunnel apply");
        assert_eq!(pending.state, "tunnel_apply_pending");
        assert_eq!(pending.public_key.as_deref(), Some(public_key.as_str()));

        tunnel.fail_apply.store(false, Ordering::SeqCst);
        let recovered = restarted
            .retry_active_convergence()
            .await
            .expect("restart convergence retry");
        assert_eq!(recovered.state, "handshake_verified");
        assert_eq!(recovered.public_key.as_deref(), Some(public_key.as_str()));
        assert_eq!(tunnel.applies.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn first_handshake_evidence_survives_restart_and_later_outage_is_degraded() {
        let secrets = Arc::new(InMemorySecretStore::default());
        let tunnel = Arc::new(FixedConnectivityTunnel {
            connected: AtomicBool::new(true),
        });
        let commissioned = MaintenanceEnrollment::new(secrets.clone(), tunnel.clone());
        let public_key = commissioned.ensure_public_key().await.expect("public key");
        let verified = commissioned
            .apply_profile(&identity(public_key))
            .await
            .expect("first handshake");
        assert_eq!(verified.state, "handshake_verified");
        assert!(verified.handshake_verified);

        tunnel.connected.store(false, Ordering::SeqCst);
        let restarted = MaintenanceEnrollment::new(secrets, tunnel);
        let degraded = restarted
            .recover(None)
            .await
            .expect("restart recovery")
            .expect("persisted identity");

        assert_eq!(degraded.state, "tunnel_degraded");
        assert!(degraded.handshake_verified);
        assert_eq!(
            degraded.last_handshake_at.as_deref(),
            Some("2026-07-15T01:00:00Z")
        );
        assert_eq!(
            degraded.last_error.as_deref(),
            Some("WireGuard handshake is stale")
        );
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

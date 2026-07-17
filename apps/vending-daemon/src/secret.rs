use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio::sync::RwLock;

pub const KEYRING_SERVICE: &str = "com.vem.machine";
pub const MACHINE_SECRET_ACCOUNT: &str = "machine_secret";
pub const MQTT_SIGNING_SECRET_ACCOUNT: &str = "mqtt_signing_secret";
pub const MQTT_PASSWORD_ACCOUNT: &str = "mqtt_password";
// Claim replacement keeps these protected copies only while its durable
// transaction journal is present. They let restart recovery restore the last
// accepted credential set without ever serialising secrets into a JSON file.
pub const MACHINE_SECRET_ROLLBACK_ACCOUNT: &str = "machine_secret.rollback";
pub const MQTT_SIGNING_SECRET_ROLLBACK_ACCOUNT: &str = "mqtt_signing_secret.rollback";
pub const MQTT_PASSWORD_ROLLBACK_ACCOUNT: &str = "mqtt_password.rollback";
pub const CREDENTIAL_ROLLBACK_READY_ACCOUNT: &str = "credentials.rollback.ready";

const SECRET_ACCOUNTS: [&str; 7] = [
    MACHINE_SECRET_ACCOUNT,
    MQTT_SIGNING_SECRET_ACCOUNT,
    MQTT_PASSWORD_ACCOUNT,
    MACHINE_SECRET_ROLLBACK_ACCOUNT,
    MQTT_SIGNING_SECRET_ROLLBACK_ACCOUNT,
    MQTT_PASSWORD_ROLLBACK_ACCOUNT,
    CREDENTIAL_ROLLBACK_READY_ACCOUNT,
];

#[cfg(any(windows, test))]
pub(crate) const WINDOWS_MACHINE_PROTECTED_FILE_ACL_ARGS: [&str; 4] = [
    "/inheritance:r",
    "/grant:r",
    "*S-1-5-18:F",
    "*S-1-5-32-544:F",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SecretStoreStatus {
    pub kind: String,
    pub location: String,
    pub protection: String,
    pub machine_scope: bool,
    pub machine_secret_configured: bool,
    pub mqtt_signing_secret_configured: bool,
    pub mqtt_password_configured: bool,
    pub last_error: Option<String>,
}

#[async_trait]
pub trait SecretStore: Send + Sync {
    async fn read_secret(&self, account: &str) -> Result<Option<String>, String>;
    async fn write_secret(&self, account: &str, value: &str) -> Result<(), String>;
    async fn clear_all(&self) -> Result<(), String>;
    async fn status(&self) -> Result<SecretStoreStatus, String>;
}

#[derive(Debug, Default, Clone)]
pub struct KeyringSecretStore;

#[derive(Debug, Default)]
pub struct InMemorySecretStore {
    values: Arc<RwLock<HashMap<String, String>>>,
}

#[derive(Debug, Default, Clone)]
pub struct EnvSecretStore;

#[derive(Debug, Clone)]
pub struct FileSecretStore {
    dir: PathBuf,
}

#[derive(Debug, Clone)]
pub struct ProtectedLocalSecretStore {
    dir: PathBuf,
}

impl FileSecretStore {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            dir: data_dir.join("secrets"),
        }
    }

    fn account_path(&self, account: &str) -> Result<PathBuf, String> {
        let file_name = match account {
            MACHINE_SECRET_ACCOUNT => "machine_secret",
            MQTT_SIGNING_SECRET_ACCOUNT => "mqtt_signing_secret",
            MQTT_PASSWORD_ACCOUNT => "mqtt_password",
            MACHINE_SECRET_ROLLBACK_ACCOUNT => "machine_secret.rollback",
            MQTT_SIGNING_SECRET_ROLLBACK_ACCOUNT => "mqtt_signing_secret.rollback",
            MQTT_PASSWORD_ROLLBACK_ACCOUNT => "mqtt_password.rollback",
            CREDENTIAL_ROLLBACK_READY_ACCOUNT => "credentials.rollback.ready",
            _ => return Err("unknown secret account".to_string()),
        };
        Ok(self.dir.join(file_name))
    }
}

async fn write_secret_file_durable(
    dir: &Path,
    path: &Path,
    bytes: &[u8],
    label: &str,
) -> Result<(), String> {
    let temp_path = path.with_extension("tmp");
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temp_path)
        .await
        .map_err(|error| format!("write {label} failed: {error}"))?;
    file.write_all(bytes)
        .await
        .map_err(|error| format!("write {label} failed: {error}"))?;
    file.sync_all()
        .await
        .map_err(|error| format!("sync {label} failed: {error}"))?;
    drop(file);
    harden_machine_protected_file_permissions(&temp_path).await?;
    tokio::fs::rename(&temp_path, path)
        .await
        .map_err(|error| format!("replace {label} failed: {error}"))?;
    harden_machine_protected_file_permissions(path).await?;
    sync_secret_directory(dir, label).await
}

async fn sync_secret_directory(dir: &Path, label: &str) -> Result<(), String> {
    let dir = dir.to_path_buf();
    tokio::task::spawn_blocking(move || std::fs::File::open(dir)?.sync_all())
        .await
        .map_err(|error| format!("join {label} directory sync failed: {error}"))?
        .map_err(|error| format!("sync {label} directory failed: {error}"))
}

impl ProtectedLocalSecretStore {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            dir: runtime_root_dir(&data_dir).join("secrets"),
        }
    }

    fn account_path(&self, account: &str) -> Result<PathBuf, String> {
        let file_name = match account {
            MACHINE_SECRET_ACCOUNT => "machine_secret.dpapi",
            MQTT_SIGNING_SECRET_ACCOUNT => "mqtt_signing_secret.dpapi",
            MQTT_PASSWORD_ACCOUNT => "mqtt_password.dpapi",
            MACHINE_SECRET_ROLLBACK_ACCOUNT => "machine_secret.rollback.dpapi",
            MQTT_SIGNING_SECRET_ROLLBACK_ACCOUNT => "mqtt_signing_secret.rollback.dpapi",
            MQTT_PASSWORD_ROLLBACK_ACCOUNT => "mqtt_password.rollback.dpapi",
            CREDENTIAL_ROLLBACK_READY_ACCOUNT => "credentials.rollback.ready.dpapi",
            _ => return Err("unknown secret account".to_string()),
        };
        Ok(self.dir.join(file_name))
    }

    async fn configured_for_status(&self, account: &str) -> (bool, Option<String>) {
        match self.read_secret(account).await {
            Ok(value) => (value.is_some(), None),
            Err(error) => (false, Some(error)),
        }
    }
}

fn runtime_root_dir(data_dir: &Path) -> PathBuf {
    if data_dir.file_name().and_then(|name| name.to_str()) == Some("vending-daemon") {
        data_dir
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| data_dir.to_path_buf())
    } else {
        data_dir.to_path_buf()
    }
}

#[async_trait]
impl SecretStore for InMemorySecretStore {
    async fn read_secret(&self, account: &str) -> Result<Option<String>, String> {
        let values = self.values.read().await;
        Ok(values.get(account).cloned())
    }

    async fn write_secret(&self, account: &str, value: &str) -> Result<(), String> {
        let value = value.trim().to_string();
        let mut values = self.values.write().await;
        if value.is_empty() {
            values.remove(account);
            return Ok(());
        }
        values.insert(account.to_string(), value);
        Ok(())
    }

    async fn clear_all(&self) -> Result<(), String> {
        self.values.write().await.clear();
        Ok(())
    }

    async fn status(&self) -> Result<SecretStoreStatus, String> {
        let values = self.values.read().await;
        Ok(SecretStoreStatus {
            kind: "in_memory".to_string(),
            location: "memory://vending-daemon".to_string(),
            protection: "test_only".to_string(),
            machine_scope: false,
            machine_secret_configured: values.contains_key(MACHINE_SECRET_ACCOUNT),
            mqtt_signing_secret_configured: values.contains_key(MQTT_SIGNING_SECRET_ACCOUNT),
            mqtt_password_configured: values.contains_key(MQTT_PASSWORD_ACCOUNT),
            last_error: None,
        })
    }
}

fn env_account_name(account: &str) -> Option<&'static str> {
    match account {
        MACHINE_SECRET_ACCOUNT => Some("VEM_MACHINE_SECRET"),
        MQTT_SIGNING_SECRET_ACCOUNT => Some("VEM_MQTT_SIGNING_SECRET"),
        MQTT_PASSWORD_ACCOUNT => Some("VEM_MQTT_PASSWORD"),
        MACHINE_SECRET_ROLLBACK_ACCOUNT
        | MQTT_SIGNING_SECRET_ROLLBACK_ACCOUNT
        | MQTT_PASSWORD_ROLLBACK_ACCOUNT
        | CREDENTIAL_ROLLBACK_READY_ACCOUNT => None,
        _ => None,
    }
}

#[async_trait]
impl SecretStore for EnvSecretStore {
    async fn read_secret(&self, account: &str) -> Result<Option<String>, String> {
        let Some(name) = env_account_name(account) else {
            return Ok(None);
        };

        Ok(std::env::var(name)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()))
    }

    async fn write_secret(&self, _account: &str, _value: &str) -> Result<(), String> {
        Err("env secret store is read-only".to_string())
    }

    async fn clear_all(&self) -> Result<(), String> {
        Err("env secret store is read-only".to_string())
    }

    async fn status(&self) -> Result<SecretStoreStatus, String> {
        Ok(SecretStoreStatus {
            kind: "env".to_string(),
            location: "env://process".to_string(),
            protection: "process_environment".to_string(),
            machine_scope: false,
            machine_secret_configured: self.read_secret(MACHINE_SECRET_ACCOUNT).await?.is_some(),
            mqtt_signing_secret_configured: self
                .read_secret(MQTT_SIGNING_SECRET_ACCOUNT)
                .await?
                .is_some(),
            mqtt_password_configured: self.read_secret(MQTT_PASSWORD_ACCOUNT).await?.is_some(),
            last_error: None,
        })
    }
}

#[async_trait]
impl SecretStore for FileSecretStore {
    async fn read_secret(&self, account: &str) -> Result<Option<String>, String> {
        let path = self.account_path(account)?;
        match tokio::fs::read_to_string(path).await {
            Ok(value) => Ok(Some(value.trim().to_string()).filter(|value| !value.is_empty())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(format!("read file secret failed: {error}")),
        }
    }

    async fn write_secret(&self, account: &str, value: &str) -> Result<(), String> {
        let path = self.account_path(account)?;
        let value = value.trim();
        tokio::fs::create_dir_all(&self.dir)
            .await
            .map_err(|error| format!("create file secret dir failed: {error}"))?;
        if value.is_empty() {
            match tokio::fs::remove_file(path).await {
                Ok(()) => return sync_secret_directory(&self.dir, "file secret").await,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(error) => return Err(format!("remove file secret failed: {error}")),
            }
        }
        write_secret_file_durable(&self.dir, &path, value.as_bytes(), "file secret").await
    }

    async fn clear_all(&self) -> Result<(), String> {
        match tokio::fs::remove_dir_all(&self.dir).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("clear file secrets failed: {error}")),
        }
    }

    async fn status(&self) -> Result<SecretStoreStatus, String> {
        Ok(SecretStoreStatus {
            kind: "file".to_string(),
            location: self.dir.to_string_lossy().replace('\\', "/"),
            protection: "plaintext_file".to_string(),
            machine_scope: false,
            machine_secret_configured: self.read_secret(MACHINE_SECRET_ACCOUNT).await?.is_some(),
            mqtt_signing_secret_configured: self
                .read_secret(MQTT_SIGNING_SECRET_ACCOUNT)
                .await?
                .is_some(),
            mqtt_password_configured: self.read_secret(MQTT_PASSWORD_ACCOUNT).await?.is_some(),
            last_error: None,
        })
    }
}

#[async_trait]
impl SecretStore for ProtectedLocalSecretStore {
    async fn read_secret(&self, account: &str) -> Result<Option<String>, String> {
        let path = self.account_path(account)?;
        let blob = match tokio::fs::read(&path).await {
            Ok(blob) => blob,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("read protected local secret failed: {error}")),
        };
        let value = unprotect_secret_blob(blob)
            .await
            .map_err(|error| format!("unprotect protected local secret failed: {error}"))?;
        Ok(Some(value.trim().to_string()).filter(|value| !value.is_empty()))
    }

    async fn write_secret(&self, account: &str, value: &str) -> Result<(), String> {
        let path = self.account_path(account)?;
        let value = value.trim();
        tokio::fs::create_dir_all(&self.dir)
            .await
            .map_err(|error| format!("create protected local secret dir failed: {error}"))?;
        if value.is_empty() {
            match tokio::fs::remove_file(path).await {
                Ok(()) => return sync_secret_directory(&self.dir, "protected local secret").await,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(error) => return Err(format!("remove protected local secret failed: {error}")),
            }
        }
        let blob = protect_secret_blob(value)
            .await
            .map_err(|error| format!("protect local secret failed: {error}"))?;
        write_secret_file_durable(&self.dir, &path, &blob, "protected local secret").await
    }

    async fn clear_all(&self) -> Result<(), String> {
        match tokio::fs::remove_dir_all(&self.dir).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("clear protected local secrets failed: {error}")),
        }
    }

    async fn status(&self) -> Result<SecretStoreStatus, String> {
        let (machine_secret_configured, machine_secret_error) =
            self.configured_for_status(MACHINE_SECRET_ACCOUNT).await;
        let (mqtt_signing_secret_configured, mqtt_signing_secret_error) = self
            .configured_for_status(MQTT_SIGNING_SECRET_ACCOUNT)
            .await;
        let (mqtt_password_configured, mqtt_password_error) =
            self.configured_for_status(MQTT_PASSWORD_ACCOUNT).await;
        let last_error = [
            machine_secret_error,
            mqtt_signing_secret_error,
            mqtt_password_error,
        ]
        .into_iter()
        .flatten()
        .next();
        Ok(SecretStoreStatus {
            kind: "protected_local_file".to_string(),
            location: self.dir.to_string_lossy().replace('\\', "/"),
            protection: protected_secret_protection_name().to_string(),
            machine_scope: cfg!(windows),
            machine_secret_configured,
            mqtt_signing_secret_configured,
            mqtt_password_configured,
            last_error,
        })
    }
}

pub(crate) async fn harden_machine_protected_file_permissions(
    path: &std::path::Path,
) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let permissions = std::fs::Permissions::from_mode(0o600);
        tokio::fs::set_permissions(path, permissions)
            .await
            .map_err(|error| format!("harden file secret permissions failed: {error}"))?;
    }

    #[cfg(windows)]
    {
        // Do not use account names here: localized Windows images can resolve
        // them differently.  Rebuild the explicit DACL so a pre-existing temp
        // file cannot retain an unrelated allow or deny ACE after replacement.
        let status = windows_secret_acl_process(path)
            .status()
            .await
            .map_err(|error| format!("set file secret ACL failed: {error}"))?;
        if !status.success() {
            return Err(format!("set file secret ACL failed with status {status}"));
        }
    }

    Ok(())
}

#[cfg(any(windows, test))]
fn windows_secret_acl_script() -> &'static str {
    r#"if ($args.Count -ne 0) { throw 'secret ACL command must not receive positional arguments' }
$path = [Environment]::GetEnvironmentVariable('VEM_DAEMON_SECRET_ACL_PATH', 'Process')
if ([string]::IsNullOrWhiteSpace($path)) { throw 'secret ACL path environment variable is missing' }
$path = [IO.Path]::GetFullPath($path)
$acl = Get-Acl -LiteralPath $path -ErrorAction Stop
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
$system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$administrators = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$acl.SetOwner($system)
foreach ($sid in @($system, $administrators)) {
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
    $sid, 'FullControl', 'None', 'None', 'Allow'
  ))
}
Set-Acl -LiteralPath $path -AclObject $acl"#
}

#[cfg(any(windows, test))]
fn windows_secret_acl_command() -> Vec<String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let script = windows_secret_acl_script();
    let utf16le = script
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    vec![
        "-NoProfile".to_string(),
        "-NonInteractive".to_string(),
        "-EncodedCommand".to_string(),
        STANDARD.encode(utf16le),
    ]
}

#[cfg(any(windows, test))]
fn windows_secret_acl_process(path: &std::path::Path) -> tokio::process::Command {
    let mut command = tokio::process::Command::new("powershell.exe");
    command
        .args(windows_secret_acl_command())
        .env("VEM_DAEMON_SECRET_ACL_PATH", path)
        // A daemon started by pwsh can inherit PowerShell 7's module search
        // path. Windows PowerShell then finds but cannot load its own Security
        // module. Let powershell.exe reconstruct its native module boundary.
        .env_remove("PSModulePath");
    command
}

fn protected_secret_protection_name() -> &'static str {
    if cfg!(windows) {
        "windows_dpapi_local_machine"
    } else {
        "deterministic_test_blob"
    }
}

#[cfg(not(windows))]
async fn protect_secret_blob(value: &str) -> Result<Vec<u8>, String> {
    use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};

    let encoded: Vec<u8> = value.as_bytes().iter().map(|byte| byte ^ 0xA5).collect();
    Ok(format!(
        "VEM-TEST-PROTECTED-SECRET-v1:{}",
        STANDARD_NO_PAD.encode(encoded)
    )
    .into_bytes())
}

#[cfg(not(windows))]
async fn unprotect_secret_blob(blob: Vec<u8>) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};

    let text =
        String::from_utf8(blob).map_err(|error| format!("decode test blob failed: {error}"))?;
    let encoded = text
        .strip_prefix("VEM-TEST-PROTECTED-SECRET-v1:")
        .ok_or_else(|| "unsupported protected local secret blob".to_string())?;
    let protected = STANDARD_NO_PAD
        .decode(encoded.as_bytes())
        .map_err(|error| format!("decode test protected local secret failed: {error}"))?;
    let plain: Vec<u8> = protected.into_iter().map(|byte| byte ^ 0xA5).collect();
    String::from_utf8(plain).map_err(|error| format!("decode test secret failed: {error}"))
}

#[cfg(windows)]
pub(crate) async fn protect_machine_local_bytes(value: &[u8]) -> Result<Vec<u8>, String> {
    let value = value.to_vec();
    tokio::task::spawn_blocking(move || protect_machine_local_bytes_blocking(&value))
        .await
        .map_err(|error| format!("join DPAPI protect failed: {error}"))?
}

#[cfg(windows)]
async fn protect_secret_blob(value: &str) -> Result<Vec<u8>, String> {
    protect_machine_local_bytes(value.as_bytes()).await
}

#[cfg(windows)]
async fn unprotect_secret_blob(blob: Vec<u8>) -> Result<String, String> {
    let plain = tokio::task::spawn_blocking(move || unprotect_machine_local_bytes_blocking(&blob))
        .await
        .map_err(|error| format!("join DPAPI unprotect failed: {error}"))??;
    String::from_utf8(plain).map_err(|error| format!("decode DPAPI secret failed: {error}"))
}

#[cfg(windows)]
pub(crate) fn protect_machine_local_bytes_blocking(value: &[u8]) -> Result<Vec<u8>, String> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::{
        Foundation::{GetLastError, LocalFree},
        Security::Cryptography::{
            CryptProtectData, CRYPTPROTECT_LOCAL_MACHINE, CRYPTPROTECT_UI_FORBIDDEN,
            CRYPT_INTEGER_BLOB,
        },
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: value.len() as u32,
        pbData: value.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };
    let ok = unsafe {
        CryptProtectData(
            &input,
            null(),
            null(),
            null(),
            null(),
            CRYPTPROTECT_LOCAL_MACHINE | CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(format!("CryptProtectData failed: {}", unsafe {
            GetLastError()
        }));
    }
    let bytes = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) };
    let result = bytes.to_vec();
    unsafe {
        LocalFree(output.pbData as *mut std::ffi::c_void);
    }
    Ok(result)
}

#[cfg(windows)]
pub(crate) fn unprotect_machine_local_bytes_blocking(blob: &[u8]) -> Result<Vec<u8>, String> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::{
        Foundation::{GetLastError, LocalFree},
        Security::Cryptography::{
            CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: blob.len() as u32,
        pbData: blob.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            null_mut(),
            null(),
            null(),
            null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(format!("CryptUnprotectData failed: {}", unsafe {
            GetLastError()
        }));
    }
    let bytes = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) };
    let result = bytes.to_vec();
    unsafe {
        LocalFree(output.pbData as *mut std::ffi::c_void);
    }
    Ok(result)
}

#[async_trait]
impl SecretStore for KeyringSecretStore {
    async fn read_secret(&self, account: &str) -> Result<Option<String>, String> {
        let account = account.to_string();
        tokio::task::spawn_blocking(move || {
            let entry = keyring::Entry::new(KEYRING_SERVICE, &account)
                .map_err(|error| format!("create keyring entry failed: {error}"))?;
            match entry.get_password() {
                Ok(secret) => Ok(Some(secret)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(error) => Err(format!("read keyring secret failed: {error}")),
            }
        })
        .await
        .map_err(|error| format!("join keyring read failed: {error}"))?
    }

    async fn write_secret(&self, account: &str, value: &str) -> Result<(), String> {
        let account = account.to_string();
        let value = value.trim().to_string();
        tokio::task::spawn_blocking(move || {
            if value.is_empty() {
                let entry = keyring::Entry::new(KEYRING_SERVICE, &account)
                    .map_err(|error| format!("create keyring entry failed: {error}"))?;
                return match entry.delete_credential() {
                    Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                    Err(error) => Err(format!("delete keyring secret failed: {error}")),
                };
            }
            let entry = keyring::Entry::new(KEYRING_SERVICE, &account)
                .map_err(|error| format!("create keyring entry failed: {error}"))?;
            entry
                .set_password(&value)
                .map_err(|error| format!("write keyring secret failed: {error}"))
        })
        .await
        .map_err(|error| format!("join keyring write failed: {error}"))?
    }

    async fn clear_all(&self) -> Result<(), String> {
        for account in SECRET_ACCOUNTS {
            self.write_secret(account, "").await?;
        }
        Ok(())
    }

    async fn status(&self) -> Result<SecretStoreStatus, String> {
        Ok(SecretStoreStatus {
            kind: "keyring".to_string(),
            location: format!("keyring://{KEYRING_SERVICE}"),
            protection: "os_keyring".to_string(),
            machine_scope: false,
            machine_secret_configured: self.read_secret(MACHINE_SECRET_ACCOUNT).await?.is_some(),
            mqtt_signing_secret_configured: self
                .read_secret(MQTT_SIGNING_SECRET_ACCOUNT)
                .await?
                .is_some(),
            mqtt_password_configured: self.read_secret(MQTT_PASSWORD_ACCOUNT).await?.is_some(),
            last_error: None,
        })
    }
}

pub fn default_secret_store(data_dir: PathBuf) -> Arc<dyn SecretStore> {
    // Production startup has one machine-scope secret lifecycle.
    Arc::new(ProtectedLocalSecretStore::new(data_dir))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    #[test]
    fn protected_file_acl_uses_language_independent_builtin_sids() {
        assert_eq!(
            WINDOWS_MACHINE_PROTECTED_FILE_ACL_ARGS,
            [
                "/inheritance:r",
                "/grant:r",
                "*S-1-5-18:F",
                "*S-1-5-32-544:F",
            ]
        );
    }

    #[tokio::test]
    async fn production_secret_store_ignores_legacy_inherited_selector() {
        let temp = tempfile::tempdir().unwrap();
        // SAFETY: this focused test restores the inherited compatibility selector.
        unsafe { std::env::set_var("VEM_DAEMON_SECRET_STORE", "env") };

        let status = default_secret_store(temp.path().to_path_buf())
            .status()
            .await
            .unwrap();

        // SAFETY: restore the process environment after this test.
        unsafe { std::env::remove_var("VEM_DAEMON_SECRET_STORE") };
        assert_eq!(status.kind, "protected_local_file");
        assert_eq!(status.protection, protected_secret_protection_name());
    }

    #[tokio::test]
    async fn in_memory_secret_store_round_trips_and_ignores_empty_set() {
        let store = InMemorySecretStore::default();
        store.write_secret("account", "").await.unwrap();
        assert!(store.read_secret("account").await.unwrap().is_none());

        store.write_secret("account", "value").await.unwrap();
        assert_eq!(
            store.read_secret("account").await.unwrap().as_deref(),
            Some("value")
        );

        store.write_secret("account", "").await.unwrap();
        assert!(store.read_secret("account").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn env_secret_store_reads_only_mapped_test_env_vars() {
        // SAFETY: tests mutate process env in a scoped way.
        unsafe {
            std::env::set_var("VEM_MQTT_SIGNING_SECRET", " test-signing ");
        }
        let store = EnvSecretStore;
        assert_eq!(
            store
                .read_secret(MQTT_SIGNING_SECRET_ACCOUNT)
                .await
                .unwrap()
                .as_deref(),
            Some("test-signing")
        );
        assert!(store
            .write_secret(MQTT_SIGNING_SECRET_ACCOUNT, "x")
            .await
            .is_err());
        // SAFETY: tests mutate process env in a scoped way.
        unsafe {
            std::env::remove_var("VEM_MQTT_SIGNING_SECRET");
        }
    }

    #[tokio::test]
    async fn file_secret_store_round_trips_known_accounts() {
        let temp = tempfile::tempdir().unwrap();
        let store = FileSecretStore::new(temp.path().to_path_buf());
        store
            .write_secret(MACHINE_SECRET_ACCOUNT, " machine-secret ")
            .await
            .unwrap();
        assert_eq!(
            store
                .read_secret(MACHINE_SECRET_ACCOUNT)
                .await
                .unwrap()
                .as_deref(),
            Some("machine-secret")
        );
        store
            .write_secret(MACHINE_SECRET_ACCOUNT, "")
            .await
            .unwrap();
        assert!(store
            .read_secret(MACHINE_SECRET_ACCOUNT)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn protected_local_secret_store_round_trips_status_and_clear_without_exposing_values() {
        let temp = tempfile::tempdir().unwrap();
        let store = ProtectedLocalSecretStore::new(temp.path().to_path_buf());
        let machine_secret = "vms_machine_secret_12345678901234567890";
        let signing_secret = "vms_mqtt_signing_secret_123456789012345";
        let mqtt_password = "mqtt-password-secret";

        store
            .write_secret(MACHINE_SECRET_ACCOUNT, machine_secret)
            .await
            .unwrap();
        store
            .write_secret(MQTT_SIGNING_SECRET_ACCOUNT, signing_secret)
            .await
            .unwrap();
        store
            .write_secret(MQTT_PASSWORD_ACCOUNT, mqtt_password)
            .await
            .unwrap();

        assert_eq!(
            store
                .read_secret(MACHINE_SECRET_ACCOUNT)
                .await
                .unwrap()
                .as_deref(),
            Some(machine_secret)
        );
        assert_eq!(
            store
                .read_secret(MQTT_SIGNING_SECRET_ACCOUNT)
                .await
                .unwrap()
                .as_deref(),
            Some(signing_secret)
        );
        assert_eq!(
            store
                .read_secret(MQTT_PASSWORD_ACCOUNT)
                .await
                .unwrap()
                .as_deref(),
            Some(mqtt_password)
        );

        let status = store.status().await.unwrap();
        assert_eq!(status.kind, "protected_local_file");
        assert_eq!(status.protection, protected_secret_protection_name());
        assert!(status.machine_secret_configured);
        assert!(status.mqtt_signing_secret_configured);
        assert!(status.mqtt_password_configured);
        let serialized = serde_json::to_string(&status).unwrap();
        assert!(!serialized.contains(machine_secret));
        assert!(!serialized.contains(signing_secret));
        assert!(!serialized.contains(mqtt_password));

        store.clear_all().await.unwrap();
        let status = store.status().await.unwrap();
        assert!(!status.machine_secret_configured);
        assert!(!status.mqtt_signing_secret_configured);
        assert!(!status.mqtt_password_configured);
        assert!(store
            .read_secret(MACHINE_SECRET_ACCOUNT)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn protected_machine_store_recovers_provisioned_secret_after_restart() {
        let temp = tempfile::tempdir().unwrap();
        let data_dir = temp.path().to_path_buf();
        let provisioned = ProtectedLocalSecretStore::new(data_dir.clone());
        provisioned
            .write_secret(MACHINE_SECRET_ACCOUNT, "machine-secret-after-restart")
            .await
            .unwrap();

        let restarted = ProtectedLocalSecretStore::new(data_dir);
        assert_eq!(
            restarted
                .read_secret(MACHINE_SECRET_ACCOUNT)
                .await
                .unwrap()
                .as_deref(),
            Some("machine-secret-after-restart"),
        );
    }

    #[test]
    fn windows_secret_acl_replaces_existing_explicit_rules_with_stable_sids() {
        let script = windows_secret_acl_script();
        assert!(script.contains("SetAccessRuleProtection($true, $false)"));
        assert!(script.contains("RemoveAccessRuleSpecific"));
        assert!(script.contains("S-1-5-18"));
        assert!(script.contains("S-1-5-32-544"));
        assert!(script.contains("$acl.SetOwner($system)"));
        assert!(!script.contains("Administrators:F"));
        assert!(!script.contains("SYSTEM:F"));
    }

    #[test]
    fn windows_secret_acl_command_keeps_the_path_out_of_the_script_argument_boundary() {
        let args = windows_secret_acl_command();
        assert!(args.windows(2).any(|pair| pair[0] == "-EncodedCommand"));
        assert!(!args.iter().any(|argument| argument == "-Command"));

        let encoded = args
            .windows(2)
            .find_map(|pair| (pair[0] == "-EncodedCommand").then_some(pair[1].as_str()))
            .expect("encoded command");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("encoded PowerShell script");
        let words = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        let script = String::from_utf16(&words).expect("PowerShell UTF-16 script");
        assert!(script.contains("VEM_DAEMON_SECRET_ACL_PATH"));
        assert!(script.contains("$args.Count -ne 0"));
        assert!(!script.contains("$args[0]"));
    }

    #[test]
    fn windows_secret_acl_process_does_not_inherit_powershell_module_path() {
        let command = windows_secret_acl_process(Path::new("secret with spaces.bin"));
        let (name, value) = command
            .as_std()
            .get_envs()
            .find(|(name, _)| name.eq_ignore_ascii_case("PSModulePath"))
            .expect("PowerShell module path must have an explicit child-process policy");

        assert_eq!(name, std::ffi::OsStr::new("PSModulePath"));
        assert!(value.is_none(), "the child must not inherit pwsh modules");
        assert!(command.as_std().get_envs().any(|(name, value)| {
            name == std::ffi::OsStr::new("VEM_DAEMON_SECRET_ACL_PATH") && value.is_some()
        }));
    }

    #[cfg(windows)]
    fn run_windows_acl_probe(path: &Path, script: &str) -> std::process::Output {
        use std::process::Command;

        let utf16le = script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();
        let encoded = base64::engine::general_purpose::STANDARD.encode(utf16le);
        Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded])
            .env("VEM_DAEMON_SECRET_ACL_PATH", path)
            .output()
            .expect("run PowerShell ACL probe")
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_secret_acl_hardens_spaced_secret_paths() {
        let temp = tempfile::tempdir().unwrap();
        let secret_root = temp.path().join("secret paths with spaces");
        std::fs::create_dir_all(&secret_root).unwrap();

        for name in ["machine secret", "mqtt signing secret"] {
            let path = secret_root.join(name);
            std::fs::write(&path, "secret").unwrap();
            let setup = run_windows_acl_probe(
                &path,
                r#"$path = [Environment]::GetEnvironmentVariable('VEM_DAEMON_SECRET_ACL_PATH', 'Process')
$acl = Get-Acl -LiteralPath $path -ErrorAction Stop
$everyone = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($everyone, 'ReadAndExecute', 'None', 'None', 'Allow'))
Set-Acl -LiteralPath $path -AclObject $acl"#,
            );
            assert!(
                setup.status.success(),
                "failed to create preexisting ACE: {}",
                String::from_utf8_lossy(&setup.stderr)
            );

            // Every extracted claim secret uses this production process
            // invocation; the probe also exercises a path containing spaces.
            harden_machine_protected_file_permissions(&path)
                .await
                .unwrap();

            let probe = run_windows_acl_probe(
                &path,
                r#"$path = [Environment]::GetEnvironmentVariable('VEM_DAEMON_SECRET_ACL_PATH', 'Process')
$acl = Get-Acl -LiteralPath $path -ErrorAction Stop
$owner = $acl.Owner.Translate([Security.Principal.SecurityIdentifier]).Value
$rules = @($acl.Access | Where-Object { -not $_.IsInherited } | ForEach-Object {
  [ordered]@{
    sid = $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    rights = [int]$_.FileSystemRights
    type = [string]$_.AccessControlType
    inheritance = [string]$_.InheritanceFlags
    propagation = [string]$_.PropagationFlags
  }
})
[ordered]@{ protected = [bool]$acl.AreAccessRulesProtected; owner = $owner; rules = $rules } | ConvertTo-Json -Depth 8 -Compress"#,
            );
            assert!(
                probe.status.success(),
                "failed to read hardened ACL: {}",
                String::from_utf8_lossy(&probe.stderr)
            );
            let value: serde_json::Value = serde_json::from_slice(&probe.stdout).unwrap();
            assert_eq!(value["protected"], true);
            assert_eq!(value["owner"], "S-1-5-18");
            let rules = value["rules"].as_array().unwrap();
            assert_eq!(rules.len(), 2, "stale ACE survived for {name}");
            for sid in ["S-1-5-18", "S-1-5-32-544"] {
                assert!(rules.iter().any(|rule| {
                    rule["sid"] == sid
                        && rule["type"] == "Allow"
                        && rule["inheritance"] == "None"
                        && rule["propagation"] == "None"
                }));
            }
            assert!(rules.iter().all(|rule| rule["sid"] != "S-1-1-0"));
        }
    }
}

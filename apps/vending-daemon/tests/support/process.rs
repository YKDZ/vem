use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::{io::AsyncReadExt, process::Child, time::sleep};
use vending_daemon::secret::{
    ProtectedLocalSecretStore, SecretStore, MACHINE_MAINTENANCE_PIN_ACCOUNT,
    MACHINE_SECRET_ACCOUNT, MQTT_PASSWORD_ACCOUNT, MQTT_SIGNING_SECRET_ACCOUNT,
};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadyFile {
    pub healthz_url: String,
    pub readyz_url: String,
    pub ipc_token: String,
    #[serde(default)]
    pub runtime_flags: RuntimeFlags,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeFlags {
    pub advanced_maintenance_config: bool,
}

pub struct DaemonHarness {
    pub data_dir: PathBuf,
    pub ready: ReadyFile,
    _temp_dir: Option<TempDir>,
    child: Child,
    client: Client,
}

impl DaemonHarness {
    pub async fn start(
        public_config: serde_json::Value,
        protected_secrets: &[(&str, &str)],
        child_env: &[(&str, &str)],
    ) -> Result<Self, String> {
        let temp_dir = TempDir::new().map_err(|error| error.to_string())?;
        let data_dir = temp_dir.path().join("vending-daemon");
        let mut harness =
            Self::start_at(data_dir, public_config, protected_secrets, child_env).await?;
        harness._temp_dir = Some(temp_dir);
        Ok(harness)
    }

    pub async fn start_at(
        data_dir: PathBuf,
        public_config: serde_json::Value,
        protected_secrets: &[(&str, &str)],
        child_env: &[(&str, &str)],
    ) -> Result<Self, String> {
        tokio::fs::create_dir_all(&data_dir)
            .await
            .map_err(|error| error.to_string())?;

        let ready_file = data_dir.join("daemon-ready.json");
        tokio::fs::write(
            data_dir.join("machine-config.json"),
            serde_json::to_vec_pretty(&public_config).map_err(|error| error.to_string())?,
        )
        .await
        .map_err(|error| error.to_string())?;
        write_layered_runtime_test_config(&data_dir, &public_config).await?;
        seed_protected_test_secrets(&data_dir, protected_secrets).await?;
        let _ = tokio::fs::remove_file(&ready_file).await;

        let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_vending-daemon"));
        command
            .arg("--console")
            .arg("--data-dir")
            .arg(&data_dir)
            .arg("--bind")
            .arg("127.0.0.1:0")
            .arg("--print-ready-file")
            .arg(&ready_file)
            .env("VEM_DISK_PRESSURE_MIN_AVAILABLE_BYTES", "0")
            .envs(child_env.iter().copied())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().map_err(|error| error.to_string())?;
        let client = Client::new();

        let ready = match wait_ready_file(&ready_file).await {
            Ok(ready) => ready,
            Err(error) => {
                let _ = child.start_kill();
                let mut stderr = String::new();
                let mut stdout = String::new();
                if let Some(mut pipe) = child.stderr.take() {
                    let _ = pipe.read_to_string(&mut stderr).await;
                }
                if let Some(mut pipe) = child.stdout.take() {
                    let _ = pipe.read_to_string(&mut stdout).await;
                }
                let _ = child.wait().await;
                return Err(format!(
                    "{error}; daemon stdout: {stdout}; daemon stderr: {stderr}"
                ));
            }
        };
        wait_http_ok(&client, &ready.healthz_url).await?;

        Ok(Self {
            data_dir,
            ready,
            _temp_dir: None,
            child,
            client,
        })
    }

    pub fn bearer(&self) -> String {
        format!("Bearer {}", self.ready.ipc_token)
    }

    pub async fn create_maintenance_session(&self, pin: &str) -> String {
        let base = self.ready.healthz_url.trim_end_matches("/healthz");
        let response = self
            .client
            .post(format!("{base}/v1/maintenance/sessions"))
            .header("Authorization", self.bearer())
            .json(&json!({
                "pin": pin,
                "operatorId": "integration-test"
            }))
            .send()
            .await
            .expect("create maintenance session request");
        let status = response.status();
        let body: Value = response
            .json()
            .await
            .expect("create maintenance session response");
        assert_eq!(
            status,
            reqwest::StatusCode::CREATED,
            "session response: {body}"
        );
        body["sessionId"]
            .as_str()
            .filter(|session_id| !session_id.is_empty())
            .expect("maintenance session id")
            .to_string()
    }

    pub fn state_db_path(&self) -> PathBuf {
        self.data_dir.join("state.db")
    }

    pub async fn get_json(&self, path: &str) -> serde_json::Value {
        let base = self.ready.healthz_url.trim_end_matches("/healthz");
        self.client
            .get(format!("{base}{path}"))
            .header("Authorization", self.bearer())
            .send()
            .await
            .expect("request")
            .json()
            .await
            .expect("json")
    }

    pub async fn terminate(&mut self) {
        let _ = self.child.start_kill();
        let _ = tokio::time::timeout(Duration::from_secs(3), self.child.wait()).await;
    }
}

/// Explicitly seed the same protected local store used by daemon startup.  The
/// process environment is deliberately not a secret-store compatibility seam.
async fn seed_protected_test_secrets(
    data_dir: &Path,
    protected_secrets: &[(&str, &str)],
) -> Result<(), String> {
    let store = ProtectedLocalSecretStore::new(data_dir.to_path_buf());
    for (name, value) in protected_secrets {
        let account = match *name {
            "VEM_MQTT_SIGNING_SECRET" | "mqtt_signing_secret" => MQTT_SIGNING_SECRET_ACCOUNT,
            "VEM_MQTT_PASSWORD" | "mqtt_password" => MQTT_PASSWORD_ACCOUNT,
            "VEM_MACHINE_SECRET" | "machine_secret" => MACHINE_SECRET_ACCOUNT,
            "machine_maintenance_pin" => MACHINE_MAINTENANCE_PIN_ACCOUNT,
            other => return Err(format!("unsupported explicit test secret: {other}")),
        };
        store.write_secret(account, value).await?;
    }
    Ok(())
}

async fn write_layered_runtime_test_config(
    data_dir: &Path,
    public_config: &Value,
) -> Result<(), String> {
    let root = data_dir.parent().unwrap_or(data_dir);
    let bringup_dir = root.join("bringup");
    tokio::fs::create_dir_all(&bringup_dir)
        .await
        .map_err(|error| error.to_string())?;
    if let Some(topology) = public_config
        .get("hardwareSlotTopology")
        .filter(|value| !value.is_null())
    {
        let factory_dir = root.join("factory");
        tokio::fs::create_dir_all(&factory_dir)
            .await
            .map_err(|error| error.to_string())?;
        let api_base_url = public_config
            .get("apiBaseUrl")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("http://127.0.0.1:0/api");
        let manifest = json!({
            "layoutVersion": 1,
            "environment": "testbed",
            "provisioningEndpoint": api_base_url,
            "hardwareMode": "production",
            "hardwareModel": "test-fixture",
            "hardwareSlotTopology": topology
        });
        tokio::fs::write(
            factory_dir.join("factory-manifest.json"),
            serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
        )
        .await
        .map_err(|error| error.to_string())?;
    }

    let mut local = serde_json::Map::new();
    copy_string(
        public_config,
        &mut local,
        "apiBaseUrl",
        "provisioningEndpointOverride",
    );
    copy_value(public_config, &mut local, "hardwareAdapter");
    copy_value(public_config, &mut local, "serialPortPath");
    copy_value(public_config, &mut local, "lowerControllerUsbIdentity");
    copy_value(public_config, &mut local, "scannerAdapter");
    copy_value(public_config, &mut local, "scannerSerialPortPath");
    copy_value(public_config, &mut local, "scannerUsbIdentity");
    copy_value(public_config, &mut local, "scannerBaudRate");
    copy_value(public_config, &mut local, "scannerFrameSuffix");
    copy_value(public_config, &mut local, "visionEnabled");
    copy_value(public_config, &mut local, "visionWsUrl");
    copy_value(public_config, &mut local, "visionRequestTimeoutMs");
    copy_value(public_config, &mut local, "machineAudioVolume");
    copy_value(public_config, &mut local, "tryOnCameraDeviceId");
    copy_value(public_config, &mut local, "audioCueSettings");
    copy_value(public_config, &mut local, "kioskMode");
    copy_value(public_config, &mut local, "stockMovementRetentionDays");
    tokio::fs::write(
        bringup_dir.join("local-settings.json"),
        serde_json::to_vec_pretty(&Value::Object(local)).map_err(|error| error.to_string())?,
    )
    .await
    .map_err(|error| error.to_string())?;

    let machine_code = public_config
        .get("machineCode")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    if let Some(machine_code) = machine_code {
        let provisioning_dir = root.join("provisioning");
        tokio::fs::create_dir_all(&provisioning_dir)
            .await
            .map_err(|error| error.to_string())?;
        let api_base_url = public_config
            .get("apiBaseUrl")
            .and_then(Value::as_str)
            .unwrap_or("http://127.0.0.1:0/api");
        let mqtt_url = public_config
            .get("mqttUrl")
            .and_then(Value::as_str)
            .unwrap_or("mqtt://127.0.0.1:1883");
        let mqtt_client_id = public_config
            .get("mqttClientId")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(|| format!("vem-machine-{machine_code}"));
        let mqtt_username = public_config
            .get("mqttUsername")
            .cloned()
            .unwrap_or(Value::Null);
        let profile = json!({
            "profileVersion": 1,
            "machineId": "550e8400-e29b-41d4-a716-446655440000",
            "machineCode": machine_code,
            "machineName": public_config.get("machineName").and_then(Value::as_str).unwrap_or("Test Machine"),
            "machineStatus": public_config.get("machineStatus").and_then(Value::as_str).unwrap_or("online"),
            "machineLocationLabel": public_config.get("machineLocationLabel").cloned().unwrap_or(Value::Null),
            "claimedAt": "2026-07-08T00:00:00.000Z",
            "apiBaseUrl": api_base_url,
            "mqttUrl": mqtt_url,
            "mqttClientId": mqtt_client_id,
            "mqttUsername": mqtt_username,
            "runtimeEndpoints": {
                "apiBasePath": "/api",
                "machineAuthTokenPath": "/api/machine-auth/token",
                "machineApiBasePath": format!("/api/machines/{machine_code}"),
                "mqttTopicPrefix": format!("vem/machines/{machine_code}")
            },
            "hardwareProfile": public_config.get("hardwareProfile").cloned().unwrap_or_else(|| json!({
                "profile": "production",
                "controller": { "required": true, "protocol": "vem-vending-controller" },
                "paymentScanner": { "required": true, "supportsPaymentCode": true },
                "vision": { "required": false, "supportsRecommendations": true }
            })),
            "hardwareSlotTopology": public_config.get("hardwareSlotTopology").cloned().unwrap_or_else(|| json!({
                "identity": "vem-test-24",
                "version": "2026-07-test"
            })),
            "paymentCapability": public_config.get("paymentCapability").cloned().unwrap_or_else(|| json!({
                "profile": "production",
                "qrCodeEnabled": true,
                "paymentCodeEnabled": true,
                "serverTime": "2026-07-08T00:00:00.000Z"
            })),
            "provisioningMetadata": {
                "profileVersion": 1,
                "claimCodeId": "550e8400-e29b-41d4-a716-446655440111",
                "claimedAt": "2026-07-08T00:00:00.000Z",
                "serverTime": "2026-07-08T00:00:00.000Z"
            }
        });
        tokio::fs::write(
            provisioning_dir.join("profile-cache-summary.json"),
            serde_json::to_vec_pretty(&profile).map_err(|error| error.to_string())?,
        )
        .await
        .map_err(|error| error.to_string())?;
    }

    Ok(())
}

fn copy_value(source: &Value, target: &mut serde_json::Map<String, Value>, key: &str) {
    if let Some(value) = source.get(key).filter(|value| !value.is_null()) {
        target.insert(key.to_string(), value.clone());
    }
}

fn copy_string(
    source: &Value,
    target: &mut serde_json::Map<String, Value>,
    source_key: &str,
    target_key: &str,
) {
    if let Some(value) = source
        .get(source_key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        target.insert(target_key.to_string(), Value::String(value.to_string()));
    }
}

impl Drop for DaemonHarness {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

async fn wait_ready_file(path: &Path) -> Result<ReadyFile, String> {
    for _ in 0..100 {
        if let Ok(bytes) = tokio::fs::read(path).await {
            return serde_json::from_slice(&bytes).map_err(|error| error.to_string());
        }
        sleep(Duration::from_millis(50)).await;
    }
    Err(format!("ready file was not written at {}", path.display()))
}

async fn wait_http_ok(client: &Client, url: &str) -> Result<(), String> {
    for _ in 0..100 {
        if let Ok(response) = client.get(url).send().await {
            if response.status().is_success() {
                return Ok(());
            }
        }
        sleep(Duration::from_millis(50)).await;
    }
    Err(format!("health endpoint did not become ready: {url}"))
}

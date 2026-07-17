use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};

use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::{io::AsyncReadExt, process::Child, time::sleep};
use vending_daemon::{
    provisioning::{
        HardwareSlotTopologyIdentity, MachineProvisioningProfile, ProductionControllerProfile,
        ProductionMachineHardwareProfile, ProductionMachinePaymentCapability,
        ProductionPaymentScannerProfile, ProductionVisionProfile, ProvisioningCredentials,
        ProvisioningMachine, ProvisioningMetadata, ProvisioningMqttConnection,
        ProvisioningRuntimeEndpoints,
    },
    runtime_configuration::CleanRuntimeConfigurationStore,
    secret::ProtectedLocalSecretStore,
};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadyFile {
    pub healthz_url: String,
    pub readyz_url: String,
    pub ipc_token: String,
}

pub struct DaemonHarness {
    pub data_dir: PathBuf,
    pub ready: ReadyFile,
    _temp_dir: Option<TempDir>,
    child: Child,
    client: Client,
}

impl DaemonHarness {
    /// `fixture` describes only deployment bootstrap values and a previously
    /// accepted platform claim. It is never written as a daemon configuration
    /// document.
    pub async fn start(
        fixture: serde_json::Value,
        extracted_secrets: &[(&str, &str)],
        child_env: &[(&str, &str)],
    ) -> Result<Self, String> {
        let temp_dir = TempDir::new().map_err(|error| error.to_string())?;
        let data_dir = temp_dir.path().join("vending-daemon");
        let mut harness = Self::start_at(data_dir, fixture, extracted_secrets, child_env).await?;
        harness._temp_dir = Some(temp_dir);
        Ok(harness)
    }

    pub async fn start_at(
        data_dir: PathBuf,
        fixture: serde_json::Value,
        extracted_secrets: &[(&str, &str)],
        child_env: &[(&str, &str)],
    ) -> Result<Self, String> {
        tokio::fs::create_dir_all(&data_dir)
            .await
            .map_err(|error| error.to_string())?;
        prepare_runtime_sources(&data_dir, &fixture, extracted_secrets).await?;

        let ready_file = data_dir.join("daemon-ready.json");
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

async fn prepare_runtime_sources(
    data_dir: &Path,
    fixture: &Value,
    extracted_secrets: &[(&str, &str)],
) -> Result<(), String> {
    let root = data_dir.parent().unwrap_or(data_dir);
    let hardware_model = fixture_string(fixture, "hardwareModel", "vem-test-24");
    let topology = fixture
        .get("hardwareSlotTopology")
        .cloned()
        .unwrap_or_else(|| json!({ "identity": hardware_model, "version": "2026-07-test" }));
    let topology_identity = topology
        .get("identity")
        .and_then(Value::as_str)
        .unwrap_or(&hardware_model);
    let topology_version = topology
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("2026-07-test");
    let provisioning_api_base_url = fixture_string(fixture, "apiBaseUrl", "http://127.0.0.1:9/api");
    tokio::fs::write(
        root.join("runtime-bootstrap.json"),
        serde_json::to_vec_pretty(&json!({
            "schemaVersion": 1,
            "provisioningApiBaseUrl": provisioning_api_base_url,
            "hardwareModel": hardware_model,
            "topology": { "identity": topology_identity, "version": topology_version },
        }))
        .map_err(|error| error.to_string())?,
    )
    .await
    .map_err(|error| error.to_string())?;

    let Some(machine_code) = fixture
        .get("machineCode")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    else {
        return Ok(());
    };

    let secret_store = Arc::new(ProtectedLocalSecretStore::new(data_dir.to_path_buf()));
    let store = CleanRuntimeConfigurationStore::new(data_dir.to_path_buf(), secret_store);
    if tokio::fs::try_exists(store.profile_cache_path())
        .await
        .map_err(|error| error.to_string())?
    {
        return Ok(());
    }
    store
        .accept_profile(&profile_from_fixture(
            fixture,
            machine_code,
            &hardware_model,
            topology_identity,
            topology_version,
            extracted_secrets,
        ))
        .await
        .map(|_| ())
}

fn profile_from_fixture(
    fixture: &Value,
    machine_code: &str,
    hardware_model: &str,
    topology_identity: &str,
    topology_version: &str,
    extracted_secrets: &[(&str, &str)],
) -> MachineProvisioningProfile {
    let machine_secret = extracted_secret(
        extracted_secrets,
        &["VEM_MACHINE_SECRET", "machine_secret"],
        "machine-secret-for-integration-tests-0001",
    );
    let mqtt_signing_secret = extracted_secret(
        extracted_secrets,
        &["VEM_MQTT_SIGNING_SECRET", "mqtt_signing_secret"],
        "mqtt-signing-secret-for-integration-tests-0001",
    );
    let mqtt_password = extracted_secrets
        .iter()
        .find(|(name, _)| matches!(*name, "VEM_MQTT_PASSWORD" | "mqtt_password"))
        .map(|(_, value)| (*value).to_string());
    MachineProvisioningProfile {
        machine: ProvisioningMachine {
            id: "550e8400-e29b-41d4-a716-446655440000".to_string(),
            code: machine_code.to_string(),
            name: fixture_string(fixture, "machineName", "Integration Test Machine"),
            status: fixture_string(fixture, "machineStatus", "online"),
            location_label: fixture
                .get("machineLocationLabel")
                .and_then(Value::as_str)
                .map(ToString::to_string),
        },
        credentials: ProvisioningCredentials {
            machine_secret,
            mqtt_signing_secret,
            mqtt_connection: ProvisioningMqttConnection {
                url: fixture_string(fixture, "mqttUrl", "mqtt://127.0.0.1:1883"),
                client_id: fixture_string(
                    fixture,
                    "mqttClientId",
                    &format!("vem-machine-{machine_code}"),
                ),
                username: fixture
                    .get("mqttUsername")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                password: mqtt_password,
            },
        },
        api_base_url: fixture_string(fixture, "apiBaseUrl", "http://127.0.0.1:9/api"),
        runtime_endpoints: ProvisioningRuntimeEndpoints {
            api_base_path: "/api".to_string(),
            machine_auth_token_path: "/api/machine-auth/token".to_string(),
            machine_api_base_path: format!("/api/machines/{machine_code}"),
            mqtt_topic_prefix: format!("vem/machines/{machine_code}"),
        },
        hardware_profile: serde_json::from_value(
            fixture.get("hardwareProfile").cloned().unwrap_or_else(|| {
                json!({
                    "profile": "production",
                    "controller": { "required": true, "protocol": "vem-vending-controller" },
                    "paymentScanner": { "required": true, "supportsPaymentCode": true },
                    "vision": { "required": false, "supportsRecommendations": true },
                })
            }),
        )
        .unwrap_or(ProductionMachineHardwareProfile {
            profile: "production".to_string(),
            controller: ProductionControllerProfile {
                required: true,
                protocol: "vem-vending-controller".to_string(),
            },
            payment_scanner: ProductionPaymentScannerProfile {
                required: true,
                supports_payment_code: true,
            },
            vision: ProductionVisionProfile {
                required: false,
                supports_recommendations: true,
            },
        }),
        hardware_model: hardware_model.to_string(),
        hardware_slot_topology: HardwareSlotTopologyIdentity {
            identity: topology_identity.to_string(),
            version: topology_version.to_string(),
        },
        payment_capability: serde_json::from_value(
            fixture
                .get("paymentCapability")
                .cloned()
                .unwrap_or_else(|| {
                    json!({
                        "profile": "production",
                        "qrCodeEnabled": true,
                        "paymentCodeEnabled": true,
                        "serverTime": "2026-07-17T00:00:00Z",
                    })
                }),
        )
        .unwrap_or(ProductionMachinePaymentCapability {
            profile: "production".to_string(),
            qr_code_enabled: true,
            payment_code_enabled: true,
            server_time: "2026-07-17T00:00:00Z".to_string(),
            options: vec![],
            default_option_key: None,
            default_provider_code: None,
        }),
        metadata: ProvisioningMetadata {
            profile_version: 1,
            profile_revision: 1,
            claim_code_id: "550e8400-e29b-41d4-a716-446655440111".to_string(),
            claimed_at: "2026-07-17T00:00:00Z".to_string(),
            server_time: "2026-07-17T00:00:00Z".to_string(),
        },
    }
}

fn fixture_string(fixture: &Value, key: &str, default: &str) -> String {
    fixture
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(default)
        .to_string()
}

fn extracted_secret(extracted_secrets: &[(&str, &str)], names: &[&str], default: &str) -> String {
    extracted_secrets
        .iter()
        .find(|(name, _)| names.contains(name))
        .map(|(_, value)| (*value).to_string())
        .unwrap_or_else(|| default.to_string())
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

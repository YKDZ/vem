use std::{
    env,
    path::{Path, PathBuf},
};

pub use daemon_ipc_contracts::MachineProvisioningProfile;

pub fn validate_machine_provisioning_profile(
    profile: &MachineProvisioningProfile,
) -> Result<(), String> {
    validate_url(&profile.api_base_url, "apiBaseUrl invalid")?;
    validate_url(
        &profile.credentials.mqtt_connection.url,
        "mqtt connection url missing from provisioning profile",
    )?;
    let machine_code = profile.machine.code.as_str();
    if profile.runtime_endpoints.api_base_path != "/api"
        || profile.runtime_endpoints.machine_auth_token_path != "/api/machine-auth/token"
        || profile.runtime_endpoints.machine_api_base_path.as_str()
            != format!("/api/machines/{machine_code}")
        || profile.runtime_endpoints.mqtt_topic_prefix.as_str()
            != format!("vem/machines/{machine_code}")
    {
        return Err("runtime endpoints do not match machine identity".to_string());
    }
    if profile.metadata.profile_version != 1.0 {
        return Err("provisioning metadata invalid".to_string());
    }
    if profile.hardware_profile.profile != "production"
        || !profile.hardware_profile.controller.required
        || profile.hardware_profile.controller.protocol != "vem-vending-controller"
        || !profile.hardware_profile.payment_scanner.required
        || profile.payment_capability.profile != "production"
    {
        return Err("hardware or payment profile invalid".to_string());
    }
    Ok(())
}

fn validate_url(value: &str, message: &str) -> Result<(), String> {
    reqwest::Url::parse(value.trim())
        .map(|_| ())
        .map_err(|_| message.to_string())
}

pub fn resolve_data_dir(cli_value: Option<PathBuf>) -> Result<PathBuf, String> {
    if let Some(value) = cli_value {
        return Ok(value);
    }
    if let Ok(value) = env::var("VEM_DAEMON_DATA_DIR") {
        if !value.trim().is_empty() {
            return Ok(PathBuf::from(value));
        }
    }
    default_data_dir()
}

fn default_data_dir() -> Result<PathBuf, String> {
    #[cfg(unix)]
    {
        if let Ok(value) = env::var("XDG_DATA_HOME") {
            return Ok(PathBuf::from(value).join("vem").join("vending-daemon"));
        }
        let home = env::var("HOME").map_err(|error| format!("resolve HOME failed: {error}"))?;
        Ok(Path::new(&home)
            .join(".local")
            .join("share")
            .join("vem")
            .join("vending-daemon"))
    }
    #[cfg(windows)]
    {
        let program_data = env::var("ProgramData")
            .map_err(|error| format!("resolve ProgramData failed: {error}"))?;
        Ok(Path::new(&program_data).join("VEM").join("vending-daemon"))
    }
}

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[cfg(windows)]
use rodio::cpal::traits::{DeviceTrait, HostTrait};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AudioOutputObservation {
    pub endpoint_id: String,
    pub friendly_name: String,
    pub is_default: bool,
}

pub trait AudioOutputPlatform: Send + Sync {
    fn enumerate(&self) -> Result<Vec<AudioOutputObservation>, String>;
}

pub type SharedAudioOutputPlatform = Arc<dyn AudioOutputPlatform>;

#[derive(Debug, Default)]
pub struct WindowsAudioOutputPlatform;

impl AudioOutputPlatform for WindowsAudioOutputPlatform {
    fn enumerate(&self) -> Result<Vec<AudioOutputObservation>, String> {
        #[cfg(not(windows))]
        {
            Err("native audio output enumeration is only supported on Windows".to_string())
        }

        #[cfg(windows)]
        {
            enumerate_windows_audio_outputs()
        }
    }
}

pub fn normalized_audio_output_observations(
    observations: impl IntoIterator<Item = AudioOutputObservation>,
) -> Vec<AudioOutputObservation> {
    let mut observations = observations.into_iter().collect::<Vec<_>>();
    observations.sort_by(|left, right| left.endpoint_id.cmp(&right.endpoint_id));
    observations
}

pub fn audio_output_observation_revision(
    observations: &[AudioOutputObservation],
) -> Result<String, String> {
    let normalized = normalized_audio_output_observations(observations.iter().cloned());
    let payload = serde_json::to_vec(&normalized)
        .map_err(|error| format!("serialize audio output observation failed: {error}"))?;
    Ok(format!("sha256:{:x}", Sha256::digest(payload)))
}

#[cfg(windows)]
fn enumerate_windows_audio_outputs() -> Result<Vec<AudioOutputObservation>, String> {
    let host = rodio::cpal::default_host();
    let default_output_id = host
        .default_output_device()
        .and_then(|device| device.id().ok().map(|id| id.1));
    let observations = host
        .output_devices()
        .map_err(|error| format!("enumerate audio outputs failed: {error}"))?
        .map(|device| {
            let endpoint_id = device
                .id()
                .map_err(|error| format!("read audio output identity failed: {error}"))?
                .1;
            let friendly_name = device
                .description()
                .map(|description| description.name().to_string())
                .map_err(|error| format!("read audio output name failed: {error}"))?;
            Ok(AudioOutputObservation {
                is_default: default_output_id
                    .as_deref()
                    .is_some_and(|default_id| default_id == endpoint_id),
                endpoint_id,
                friendly_name,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(normalized_audio_output_observations(observations))
}

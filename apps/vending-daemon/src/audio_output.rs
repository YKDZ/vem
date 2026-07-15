use std::sync::Arc;
#[cfg(windows)]
use std::{num::NonZeroU16, num::NonZeroU32};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[cfg(windows)]
use rodio::{
    buffer::SamplesBuffer,
    cpal::traits::{DeviceTrait, HostTrait},
    DeviceSinkBuilder, Player,
};

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeAudioPlaybackEvidence {
    pub endpoint_id: String,
    pub source_non_silent: bool,
}

#[async_trait::async_trait]
pub trait AudioOutputPlayback: Send + Sync {
    async fn play_calibration(
        &self,
        endpoint_id: &str,
        volume: f32,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> Result<NativeAudioPlaybackEvidence, String>;
}

pub type SharedAudioOutputPlayback = Arc<dyn AudioOutputPlayback>;

#[cfg(any(windows, test))]
const CALIBRATION_SAMPLE_RATE: u32 = 48_000;
#[cfg(any(windows, test))]
const CALIBRATION_DURATION_SAMPLES: usize = 48_000;
#[cfg(any(windows, test))]
const CALIBRATION_FREQUENCY_HZ: f32 = 880.0;
#[cfg(any(windows, test))]
const CALIBRATION_AMPLITUDE: f32 = 0.25;

#[cfg(any(windows, test))]
fn fixed_audio_calibration_samples() -> Vec<f32> {
    (0..CALIBRATION_DURATION_SAMPLES)
        .map(|index| {
            let phase = 2.0 * std::f32::consts::PI * CALIBRATION_FREQUENCY_HZ * index as f32
                / CALIBRATION_SAMPLE_RATE as f32;
            CALIBRATION_AMPLITUDE * phase.sin()
        })
        .collect()
}

#[derive(Default)]
pub struct WindowsAudioOutputPlayback;

impl std::fmt::Debug for WindowsAudioOutputPlayback {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WindowsAudioOutputPlayback")
            .finish_non_exhaustive()
    }
}

#[async_trait::async_trait]
impl AudioOutputPlayback for WindowsAudioOutputPlayback {
    async fn play_calibration(
        &self,
        endpoint_id: &str,
        volume: f32,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> Result<NativeAudioPlaybackEvidence, String> {
        #[cfg(not(windows))]
        {
            let _ = (endpoint_id, volume, cancellation);
            Err("native audio output playback is only supported on Windows".to_string())
        }

        #[cfg(windows)]
        {
            self.play_windows_calibration(endpoint_id, volume, cancellation)
                .await
        }
    }
}

#[cfg(windows)]
impl WindowsAudioOutputPlayback {
    async fn play_windows_calibration(
        &self,
        endpoint_id: &str,
        volume: f32,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> Result<NativeAudioPlaybackEvidence, String> {
        let endpoint_id = endpoint_id.trim();
        if endpoint_id.is_empty() {
            return Err("audio output calibration requires a stable endpoint id".to_string());
        }
        let host = rodio::cpal::default_host();
        let device = host
            .output_devices()
            .map_err(|error| format!("enumerate audio outputs failed: {error}"))?
            .find_map(|device| {
                device
                    .id()
                    .ok()
                    .filter(|id| id.1 == endpoint_id)
                    .map(|_| device)
            })
            .ok_or_else(|| "selected native audio output is not currently observed".to_string())?;
        let samples = fixed_audio_calibration_samples();
        let source_non_silent = samples.iter().any(|sample| sample.abs() > 0.000_1);
        if !source_non_silent {
            return Err("audio output calibration source is silent".to_string());
        }
        let sink = DeviceSinkBuilder::from_device(device)
            .and_then(|builder| builder.open_stream())
            .map_err(|error| format!("open selected audio output failed: {error}"))?;
        let player = Player::connect_new(&sink.mixer());
        player.set_volume(volume.clamp(0.0, 1.0));
        player.append(SamplesBuffer::new(
            NonZeroU16::new(1).expect("one calibration channel"),
            NonZeroU32::new(CALIBRATION_SAMPLE_RATE).expect("calibration sample rate"),
            samples,
        ));
        let completion_deadline = tokio::time::sleep(std::time::Duration::from_secs(5));
        tokio::pin!(completion_deadline);
        loop {
            if player.empty() {
                break;
            }
            tokio::select! {
                _ = cancellation.cancelled() => {
                    player.stop();
                    return Err("audio output calibration was cancelled before playback completed".to_string());
                }
                _ = &mut completion_deadline => {
                    player.stop();
                    return Err("audio output calibration did not complete before its deadline".to_string());
                }
                _ = tokio::time::sleep(std::time::Duration::from_millis(10)) => {}
            }
        }
        drop(player);
        drop(sink);
        Ok(NativeAudioPlaybackEvidence {
            endpoint_id: endpoint_id.to_string(),
            source_non_silent,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calibration_pcm_is_fixed_and_non_silent() {
        let first = fixed_audio_calibration_samples();
        let second = fixed_audio_calibration_samples();

        assert_eq!(first, second);
        assert_eq!(first.len(), CALIBRATION_DURATION_SAMPLES);
        assert!(first.iter().any(|sample| sample.abs() > 0.000_1));
        assert!(first
            .iter()
            .all(|sample| sample.abs() <= CALIBRATION_AMPLITUDE));
    }
}

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

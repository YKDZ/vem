#[cfg(windows)]
use std::{num::NonZeroU16, num::NonZeroU32};

#[cfg(windows)]
use rodio::{
    buffer::SamplesBuffer,
    DeviceSinkBuilder, Player,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeAudioPlaybackEvidence {
    pub output_model: String,
    pub source_non_silent: bool,
}

#[async_trait::async_trait]
pub trait AudioOutputPlayback: Send + Sync {
    async fn play_calibration(
        &self,
        volume: f32,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> Result<NativeAudioPlaybackEvidence, String>;
}

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
        volume: f32,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> Result<NativeAudioPlaybackEvidence, String> {
        #[cfg(not(windows))]
        {
            let _ = (volume, cancellation);
            Err("native audio output playback is only supported on Windows".to_string())
        }

        #[cfg(windows)]
        {
            let host = rodio::cpal::default_host();
            let device = host
                .default_output_device()
                .ok_or_else(|| "Windows default audio output is not currently observed".to_string())?;
            let samples = fixed_audio_calibration_samples();
            let source_non_silent = samples.iter().any(|sample| sample.abs() > 0.000_1);
            if !source_non_silent {
                return Err("audio output calibration source is silent".to_string());
            }
            let sink = DeviceSinkBuilder::from_device(device)
                .and_then(|builder| builder.open_stream())
                .map_err(|error| format!("open Windows default audio output failed: {error}"))?;
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
                output_model: "windows_default".to_string(),
                source_non_silent,
            })
        }
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

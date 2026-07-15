use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::prelude::*;
use serde::Serialize;

#[cfg(windows)]
use {
    rodio::{
        cpal::traits::{DeviceTrait, HostTrait},
        Decoder, DeviceSinkBuilder, MixerDeviceSink, Player,
    },
    std::fs::File,
    std::io::{BufReader, Cursor},
};

pub struct MachineAudioState {
    active: Mutex<Option<ActiveMachineAudio>>,
}

struct ActiveMachineAudio {
    #[cfg(windows)]
    _sink: MixerDeviceSink,
    #[cfg(windows)]
    player: Player,
}

#[derive(Debug)]
#[cfg_attr(not(windows), allow(dead_code))]
enum MachineAudioSource {
    Bytes(Vec<u8>),
    File(PathBuf),
}

#[derive(Debug, PartialEq, Eq)]
enum MachineAudioSourcePath {
    Asset(String),
    DevAssetFile(PathBuf),
    File(PathBuf),
}

#[derive(Debug)]
pub struct PlayMachineAudioRequest {
    pub source_url: String,
    pub volume: f32,
    #[cfg_attr(not(windows), allow(dead_code))]
    pub output_device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MachineAudioOutputCandidate {
    pub endpoint_id: String,
    pub friendly_name: String,
    pub is_default: bool,
}

impl Default for MachineAudioState {
    fn default() -> Self {
        Self {
            active: Mutex::new(None),
        }
    }
}

impl MachineAudioSource {
    fn from_source_url(
        source_url: &str,
        resolve_asset: impl FnOnce(&str) -> Result<Option<Vec<u8>>, String>,
    ) -> Result<Self, String> {
        if source_url.starts_with("http://") || source_url.starts_with("https://") {
            if let Some(local_path) = localhost_dev_asset_path(source_url) {
                return Ok(Self::File(local_path));
            }
            return Err("remote audio URLs are not supported by native playback".to_string());
        }
        if source_url.starts_with("data:") {
            return Self::from_data_url(source_url);
        }

        match source_path_from_url(source_url)? {
            MachineAudioSourcePath::Asset(asset_path) => {
                let bytes = resolve_asset(&asset_path)?
                    .ok_or_else(|| format!("packaged audio asset not found: {asset_path}"))?;
                Ok(Self::Bytes(bytes))
            }
            MachineAudioSourcePath::DevAssetFile(path) | MachineAudioSourcePath::File(path) => {
                Ok(Self::File(path))
            }
        }
    }

    fn from_data_url(source_url: &str) -> Result<Self, String> {
        let (metadata, payload) = source_url
            .split_once(',')
            .ok_or_else(|| "invalid audio data URL".to_string())?;
        if !metadata.starts_with("data:audio/") {
            return Err("data URL must contain audio media".to_string());
        }
        if !metadata.ends_with(";base64") {
            return Err("audio data URL must be base64 encoded".to_string());
        }
        let bytes = BASE64_STANDARD
            .decode(payload)
            .map_err(|error| format!("decode audio data URL failed: {error}"))?;
        Ok(Self::Bytes(bytes))
    }
}

impl MachineAudioState {
    fn play(
        &self,
        input: PlayMachineAudioRequest,
        resolve_asset: impl FnOnce(&str) -> Result<Option<Vec<u8>>, String>,
    ) -> Result<(), String> {
        #[cfg(not(windows))]
        {
            let _ = MachineAudioSource::from_source_url(&input.source_url, resolve_asset)?;
            let _ = normalize_volume(input.volume);
            return Err("native audio playback is only supported on Windows".to_string());
        }

        #[cfg(windows)]
        {
            self.stop();
            let source = MachineAudioSource::from_source_url(&input.source_url, resolve_asset)?;
            let sink = open_requested_output_sink(input.output_device_id.as_deref())?;
            let player = Player::connect_new(&sink.mixer());
            player.set_volume(normalize_volume(input.volume));
            match source {
                MachineAudioSource::Bytes(bytes) => {
                    let decoder = Decoder::try_from(Cursor::new(bytes))
                        .map_err(|error| format!("decode audio source failed: {error}"))?;
                    player.append(decoder);
                }
                MachineAudioSource::File(path) => {
                    let file = File::open(&path)
                        .map_err(|error| format!("open audio source failed: {error}"))?;
                    let decoder = Decoder::try_from(BufReader::new(file))
                        .map_err(|error| format!("decode audio source failed: {error}"))?;
                    player.append(decoder);
                }
            }
            let mut active = self.active.lock().map_err(|_| "audio state poisoned")?;
            *active = Some(ActiveMachineAudio {
                _sink: sink,
                player,
            });
            Ok(())
        }
    }

    fn stop(&self) {
        if let Ok(mut active) = self.active.lock() {
            #[cfg(windows)]
            if let Some(current) = active.take() {
                current.player.stop();
            }
            #[cfg(not(windows))]
            {
                let _ = active.take();
            }
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn play_machine_audio(
    app: tauri::AppHandle,
    state: tauri::State<'_, MachineAudioState>,
    source_url: String,
    volume: Option<f32>,
    output_device_id: Option<String>,
) -> Result<(), String> {
    let resolver = app.asset_resolver();
    state.play(
        PlayMachineAudioRequest {
            source_url,
            volume: volume.unwrap_or_else(default_volume),
            output_device_id,
        },
        |asset_path| {
            Ok(resolver.get(asset_path.to_string()).and_then(|asset| {
                if asset.mime_type().starts_with("audio/") {
                    Some(asset.bytes)
                } else {
                    None
                }
            }))
        },
    )
}

#[tauri::command]
pub fn stop_machine_audio(state: tauri::State<'_, MachineAudioState>) -> Result<(), String> {
    state.stop();
    Ok(())
}

#[tauri::command]
pub fn list_machine_audio_outputs() -> Result<Vec<MachineAudioOutputCandidate>, String> {
    #[cfg(not(windows))]
    {
        Ok(Vec::new())
    }

    #[cfg(windows)]
    {
        list_windows_audio_outputs()
    }
}

fn default_volume() -> f32 {
    1.0
}

fn normalize_volume(volume: f32) -> f32 {
    if volume.is_finite() {
        volume.clamp(0.0, 1.0)
    } else {
        1.0
    }
}

#[cfg(windows)]
fn open_os_default_sink() -> Result<MixerDeviceSink, String> {
    let default_device = rodio::cpal::default_host().default_output_device();
    open_required_default_sink(default_device, |device| {
        DeviceSinkBuilder::from_device(device)
            .and_then(|builder| builder.open_stream())
            .map_err(|error| error.to_string())
    })
}

#[cfg(windows)]
fn open_requested_output_sink(output_device_id: Option<&str>) -> Result<MixerDeviceSink, String> {
    match output_device_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(device_id) => {
            let device = find_output_device_by_id(device_id)?
                .ok_or_else(|| "configured audio output binding not found".to_string())?;
            DeviceSinkBuilder::from_device(device)
                .and_then(|builder| builder.open_stream())
                .map_err(|error| format!("open configured audio output failed: {error}"))
        }
        None => open_os_default_sink(),
    }
}

#[cfg(windows)]
fn list_windows_audio_outputs() -> Result<Vec<MachineAudioOutputCandidate>, String> {
    let host = rodio::cpal::default_host();
    let default_output_id = host
        .default_output_device()
        .and_then(|device| device.id().ok().map(|id| id.1));
    let mut outputs = host
        .output_devices()
        .map_err(|error| format!("enumerate audio outputs failed: {error}"))?
        .map(|device| {
            let endpoint_id = device
                .id()
                .map_err(|error| format!("read audio output identity failed: {error}"))?
                .1;
            let friendly_name = device
                .name()
                .or_else(|_| {
                    device
                        .description()
                        .map(|description| description.name().to_string())
                })
                .map_err(|error| format!("read audio output name failed: {error}"))?;
            Ok(MachineAudioOutputCandidate {
                is_default: default_output_id
                    .as_deref()
                    .is_some_and(|default_id| default_id == endpoint_id),
                endpoint_id,
                friendly_name,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    outputs.sort_by(|left, right| {
        right
            .is_default
            .cmp(&left.is_default)
            .then_with(|| left.friendly_name.cmp(&right.friendly_name))
            .then_with(|| left.endpoint_id.cmp(&right.endpoint_id))
    });
    Ok(outputs)
}

#[cfg(windows)]
fn find_output_device_by_id(output_device_id: &str) -> Result<Option<rodio::cpal::Device>, String> {
    let host = rodio::cpal::default_host();
    for device in host
        .output_devices()
        .map_err(|error| format!("enumerate audio outputs failed: {error}"))?
    {
        let device_id = device
            .id()
            .map_err(|error| format!("read audio output identity failed: {error}"))?
            .1;
        if device_id == output_device_id {
            return Ok(Some(device));
        }
    }
    Ok(None)
}

#[cfg_attr(not(windows), allow(dead_code))]
fn open_required_default_sink<Device, Sink>(
    default_device: Option<Device>,
    open_default_device: impl FnOnce(Device) -> Result<Sink, String>,
) -> Result<Sink, String> {
    let default_device = default_device
        .ok_or_else(|| "open default audio output failed: no default output device".to_string())?;
    open_default_device(default_device)
        .map_err(|error| format!("open default audio output failed: {error}"))
}

fn source_path_from_url(source_url: &str) -> Result<MachineAudioSourcePath, String> {
    let path = strip_query_and_fragment(source_url);
    if path.trim().is_empty() {
        return Err("audio source URL is empty".to_string());
    }
    if let Some(asset_path) = packaged_asset_path(path) {
        return Ok(MachineAudioSourcePath::Asset(asset_path));
    }
    if let Some(dev_asset_path) = dev_asset_path(path) {
        return Ok(MachineAudioSourcePath::DevAssetFile(dev_asset_path));
    }
    Ok(MachineAudioSourcePath::File(PathBuf::from(path)))
}

fn strip_query_and_fragment(source_url: &str) -> &str {
    let without_query = source_url
        .split_once('?')
        .map(|(path, _)| path)
        .unwrap_or(source_url);
    without_query
        .split_once('#')
        .map(|(path, _)| path)
        .unwrap_or(without_query)
}

fn packaged_asset_path(path: &str) -> Option<String> {
    path.strip_prefix("/assets/")
        .map(|asset_path| format!("assets/{asset_path}"))
        .or_else(|| {
            path.strip_prefix("assets/")
                .map(|asset_path| format!("assets/{asset_path}"))
        })
        .or_else(|| {
            path.strip_prefix("/audio/")
                .map(|asset_path| format!("audio/{asset_path}"))
        })
        .or_else(|| {
            path.strip_prefix("audio/")
                .map(|asset_path| format!("audio/{asset_path}"))
        })
}

fn dev_asset_path(path: &str) -> Option<PathBuf> {
    path.strip_prefix("/src/assets/")
        .or_else(|| path.strip_prefix("src/assets/"))
        .map(|asset_path| {
            machine_src_dir()
                .join("assets")
                .join(safe_relative_path(asset_path))
        })
}

fn localhost_dev_asset_path(source_url: &str) -> Option<PathBuf> {
    let path = source_url
        .strip_prefix("http://localhost:")
        .or_else(|| source_url.strip_prefix("http://127.0.0.1:"))
        .and_then(|without_host| without_host.split_once('/').map(|(_, path)| path))?;
    dev_asset_path(&format!("/{path}"))
}

fn machine_src_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("src")
}

fn safe_relative_path(path: &str) -> PathBuf {
    Path::new(path)
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(part) => Some(part),
            _ => None,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_base64_audio_data_url_as_in_memory_audio() {
        let source = MachineAudioSource::from_source_url(
            "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=",
            |_| Ok(None),
        )
        .expect("audio data URL should be accepted");

        match source {
            MachineAudioSource::Bytes(bytes) => assert!(!bytes.is_empty()),
            MachineAudioSource::File(_) => panic!("expected in-memory audio bytes"),
        }
    }

    #[test]
    fn accepts_local_file_path_sources() {
        let source =
            MachineAudioSource::from_source_url("C:\\VEM\\audio\\payment.wav", |_| Ok(None))
                .expect("local file path should be accepted");

        match source {
            MachineAudioSource::File(path) => {
                assert!(path.to_string_lossy().ends_with("payment.wav"))
            }
            MachineAudioSource::Bytes(_) => panic!("expected local file source"),
        }
    }

    #[test]
    fn rejects_remote_audio_urls() {
        let error =
            MachineAudioSource::from_source_url("https://example.com/payment.wav", |_| Ok(None))
                .expect_err("remote audio URLs must not be accepted by native playback");

        assert!(error.contains("remote audio URLs are not supported"));
    }

    #[test]
    fn resolves_vite_production_asset_urls_from_tauri_packaged_assets() {
        let source = MachineAudioSource::from_source_url(
            "/assets/payment-succeeded.abc123.wav?import#cue",
            |asset_path| {
                assert_eq!(asset_path, "assets/payment-succeeded.abc123.wav");
                Ok(Some(vec![1, 2, 3]))
            },
        )
        .expect("packaged Vite asset URL should resolve through Tauri assets");

        match source {
            MachineAudioSource::Bytes(bytes) => assert_eq!(bytes, vec![1, 2, 3]),
            MachineAudioSource::File(_) => panic!("expected packaged asset bytes"),
        }
    }

    #[test]
    fn resolves_public_audio_urls_from_tauri_packaged_assets() {
        let source = MachineAudioSource::from_source_url(
            "/audio/voice/departure/normal_weather/sunny.mp3",
            |asset_path| {
                assert_eq!(asset_path, "audio/voice/departure/normal_weather/sunny.mp3");
                Ok(Some(vec![1, 2, 3]))
            },
        )
        .expect("public audio URL should resolve through Tauri assets");

        match source {
            MachineAudioSource::Bytes(bytes) => assert_eq!(bytes, vec![1, 2, 3]),
            MachineAudioSource::File(_) => panic!("expected packaged asset bytes"),
        }
    }

    #[test]
    fn resolves_vite_dev_asset_urls_without_requiring_callers_to_pass_file_paths() {
        let source = source_path_from_url("/src/assets/audio/payment-succeeded.wav?import")
            .expect("Vite dev asset URL should resolve");

        match source {
            MachineAudioSourcePath::DevAssetFile(path) => {
                assert!(path.ends_with(
                    Path::new("src")
                        .join("assets")
                        .join("audio")
                        .join("payment-succeeded.wav")
                ));
            }
            _ => panic!("expected dev asset file path"),
        }
    }

    #[test]
    fn fails_when_the_os_default_output_device_cannot_open() {
        let result = open_required_default_sink::<&str, ()>(Some("os-default"), |device| {
            assert_eq!(device, "os-default");
            Err("default stream busy".to_string())
        });

        assert_eq!(
            result.expect_err("default output failure should be returned"),
            "open default audio output failed: default stream busy"
        );
    }

    #[test]
    fn fails_when_there_is_no_os_default_output_device() {
        let result = open_required_default_sink::<&str, ()>(None, |_| {
            panic!("must not open a non-default output device")
        });

        assert_eq!(
            result.expect_err("missing default output should be returned"),
            "open default audio output failed: no default output device"
        );
    }

    #[test]
    fn normalizes_invalid_volume_to_full_volume() {
        assert_eq!(normalize_volume(f32::NAN), 1.0);
        assert_eq!(normalize_volume(-1.0), 0.0);
        assert_eq!(normalize_volume(2.0), 1.0);
        assert_eq!(normalize_volume(0.35), 0.35);
    }
}

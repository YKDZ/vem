use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    mpsc::{Receiver, Sender},
    Arc, Mutex,
};
use std::thread::{self, JoinHandle};

#[cfg(any(windows, test))]
use std::sync::mpsc;

use base64::prelude::*;
use serde::Serialize;

#[cfg(windows)]
use {
    rodio::{Decoder, DeviceSinkBuilder, MixerDeviceSink, Player},
    std::fs::File,
    std::io::{BufReader, Cursor},
    tauri::Emitter,
};

pub struct MachineAudioState {
    lifecycle: PlaybackLifecycle<ActiveMachineAudio>,
    #[cfg(windows)]
    completion_tx: Sender<CompletionSignal>,
}

struct ActiveMachineAudio {
    #[cfg(windows)]
    app: tauri::AppHandle,
    #[cfg(windows)]
    player: Arc<Player>,
    #[cfg(windows)]
    sink: MixerDeviceSink,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code))]
struct CompletionSignal {
    generation: u64,
}

#[cfg_attr(not(windows), allow(dead_code))]
struct ActivePlayback<T> {
    generation: u64,
    request_id: String,
    payload: T,
}

#[cfg_attr(not(windows), allow(dead_code))]
struct PlaybackLifecycle<T> {
    state: Arc<Mutex<PlaybackLifecycleState<T>>>,
    next_generation: AtomicU64,
}

#[cfg_attr(not(windows), allow(dead_code))]
struct PlaybackLifecycleState<T> {
    active: Option<ActivePlayback<T>>,
    completion_generation: Option<u64>,
    claimed_completions: Vec<CompletionClaim>,
    stop_before_start_request_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CompletionClaim {
    generation: u64,
    request_id: String,
    terminal: CompletionTerminal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CompletionTerminal {
    Completed,
    Stopped,
}

impl<T> Default for PlaybackLifecycle<T> {
    fn default() -> Self {
        Self {
            state: Arc::new(Mutex::new(PlaybackLifecycleState {
                active: None,
                completion_generation: None,
                claimed_completions: Vec::new(),
                stop_before_start_request_ids: Vec::new(),
            })),
            next_generation: AtomicU64::new(1),
        }
    }
}

impl<T> PlaybackLifecycle<T> {
    #[cfg_attr(not(windows), allow(dead_code))]
    fn state_handle(&self) -> Arc<Mutex<PlaybackLifecycleState<T>>> {
        Arc::clone(&self.state)
    }

    #[cfg_attr(not(windows), allow(dead_code))]
    fn replace(
        &self,
        request_id: String,
        payload: T,
        stop_replaced: impl FnOnce(ActivePlayback<T>),
    ) -> Result<PlaybackStart, String> {
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
        let replaced = {
            let mut state = self.state.lock().map_err(|_| "audio state poisoned")?;
            if let Some(index) = state
                .stop_before_start_request_ids
                .iter()
                .position(|pending| pending == &request_id)
            {
                state.stop_before_start_request_ids.remove(index);
                return Ok(PlaybackStart::StoppedBeforeStart);
            }
            for claimed in &mut state.claimed_completions {
                claimed.terminal = CompletionTerminal::Stopped;
            }
            let replaced = state.active.replace(ActivePlayback {
                generation,
                request_id,
                payload,
            });
            state.completion_generation = Some(generation);
            replaced
        };
        if let Some(replaced) = replaced {
            stop_replaced(replaced);
        }
        Ok(PlaybackStart::Started(generation))
    }

    fn stop(&self, request_id: String, stop_active: impl FnOnce(ActivePlayback<T>)) {
        let stopped = self.state.lock().ok().and_then(|mut state| {
            if state
                .active
                .as_ref()
                .is_some_and(|active| active.request_id == request_id)
            {
                state.completion_generation = None;
                return state.active.take();
            }
            if let Some(claimed) = state
                .claimed_completions
                .iter_mut()
                .find(|claimed| claimed.request_id == request_id)
            {
                claimed.terminal = CompletionTerminal::Stopped;
                return None;
            }
            remember_stop_before_start(&mut state.stop_before_start_request_ids, request_id);
            None
        });
        if let Some(stopped) = stopped {
            stop_active(stopped);
        }
    }

    fn stop_active(&self, stop_active: impl FnOnce(ActivePlayback<T>)) {
        let stopped = self.state.lock().ok().and_then(|mut state| {
            state.completion_generation = None;
            state.active.take()
        });
        if let Some(stopped) = stopped {
            stop_active(stopped);
        }
    }
}

enum PlaybackStart {
    Started(u64),
    StoppedBeforeStart,
}

#[cfg(test)]
impl PlaybackStart {
    fn expect_started(self) -> u64 {
        match self {
            Self::Started(generation) => generation,
            Self::StoppedBeforeStart => panic!("playback was stopped before start"),
        }
    }
}

fn remember_stop_before_start(memory: &mut Vec<String>, request_id: String) {
    if memory.iter().any(|pending| pending == &request_id) {
        return;
    }
    memory.push(request_id);
    if memory.len() > 32 {
        memory.remove(0);
    }
}

#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn spawn_terminal_waiter(wait_for_terminal: impl FnOnce() + Send + 'static) {
    thread::Builder::new()
        .name("machine-audio-terminal-wait".to_string())
        .spawn(wait_for_terminal)
        .expect("spawn machine audio terminal waiter");
}

#[cfg_attr(not(windows), allow(dead_code))]
struct OnceCompletionSignal {
    completion_tx: Sender<CompletionSignal>,
    generation: u64,
    sent: AtomicBool,
}

impl OnceCompletionSignal {
    #[cfg_attr(not(windows), allow(dead_code))]
    fn new(completion_tx: Sender<CompletionSignal>, generation: u64) -> Self {
        Self {
            completion_tx,
            generation,
            sent: AtomicBool::new(false),
        }
    }

    #[cfg_attr(not(windows), allow(dead_code))]
    fn send(&self) {
        if self
            .sent
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            let _ = self.completion_tx.send(CompletionSignal {
                generation: self.generation,
            });
        }
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
fn take_completed<T>(
    state: &Arc<Mutex<PlaybackLifecycleState<T>>>,
    signal: CompletionSignal,
) -> Option<ActivePlayback<T>> {
    let mut state = state.lock().ok()?;
    if state
        .active
        .as_ref()
        .is_some_and(|current| current.generation == signal.generation)
    {
        let completed = state.active.take()?;
        state.claimed_completions.push(CompletionClaim {
            generation: signal.generation,
            request_id: completed.request_id.clone(),
            terminal: CompletionTerminal::Completed,
        });
        Some(completed)
    } else {
        None
    }
}

fn commit_completion<T>(
    state: &Arc<Mutex<PlaybackLifecycleState<T>>>,
    signal: CompletionSignal,
) -> Option<CompletionTerminal> {
    let committed = {
        let Ok(mut state) = state.lock() else {
            return None;
        };
        let claim_index = state
            .claimed_completions
            .iter()
            .position(|claim| claim.generation == signal.generation)?;
        let claim = state.claimed_completions.remove(claim_index);
        if claim.terminal == CompletionTerminal::Stopped
            || state.completion_generation == Some(signal.generation)
        {
            if state.completion_generation == Some(signal.generation) {
                state.completion_generation = None;
            }
            Some(claim.terminal)
        } else {
            None
        }
    };
    committed
}

#[cfg_attr(not(windows), allow(dead_code))]
fn spawn_completion_worker<T, E, F, G>(
    state: Arc<Mutex<PlaybackLifecycleState<T>>>,
    completion_rx: Receiver<CompletionSignal>,
    mut teardown: F,
    mut on_completed: G,
) -> JoinHandle<()>
where
    T: Send + 'static,
    E: Send + 'static,
    F: FnMut(T) -> E + Send + 'static,
    G: FnMut(String, CompletionTerminal, E) + Send + 'static,
{
    // Stream teardown may join the audio thread, so completion ownership must
    // always cross this worker boundary before the payload is dropped.
    thread::Builder::new()
        .name("machine-audio-completion".to_string())
        .spawn(move || {
            while let Ok(signal) = completion_rx.recv() {
                let Some(completed) = take_completed(&state, signal) else {
                    continue;
                };
                let request_id = completed.request_id;
                let event_context = teardown(completed.payload);
                if let Some(terminal) = commit_completion(&state, signal) {
                    on_completed(request_id, terminal, event_context);
                }
            }
        })
        .expect("spawn machine audio completion worker")
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
    #[cfg_attr(not(windows), allow(dead_code))]
    pub request_id: String,
    pub source_url: String,
    pub volume: f32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code))]
#[serde(rename_all = "camelCase")]
pub struct MachineAudioCompletedEvent {
    pub request_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code))]
#[serde(rename_all = "camelCase")]
pub struct MachineAudioTerminalEvent {
    pub request_id: String,
    pub message: Option<String>,
}

impl Default for MachineAudioState {
    fn default() -> Self {
        let lifecycle = PlaybackLifecycle::default();
        #[cfg(windows)]
        let completion_tx = {
            let (completion_tx, completion_rx) = mpsc::channel();
            let _worker = spawn_completion_worker(
                lifecycle.state_handle(),
                completion_rx,
                |completed: ActiveMachineAudio| {
                    let ActiveMachineAudio { app, player, sink } = completed;
                    drop(player);
                    drop(sink);
                    app
                },
                |request_id, terminal, app| match terminal {
                    CompletionTerminal::Completed => {
                        let _ = app.emit(
                            "machine-audio-completed",
                            MachineAudioCompletedEvent { request_id },
                        );
                    }
                    CompletionTerminal::Stopped => {
                        let _ = app.emit(
                            "machine-audio-stopped",
                            MachineAudioTerminalEvent {
                                request_id,
                                message: Some(
                                    "playback stopped during completion teardown".to_string(),
                                ),
                            },
                        );
                    }
                },
            );
            completion_tx
        };
        Self {
            lifecycle,
            #[cfg(windows)]
            completion_tx,
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
        app: tauri::AppHandle,
        input: PlayMachineAudioRequest,
        resolve_asset: impl FnOnce(&str) -> Result<Option<Vec<u8>>, String>,
    ) -> Result<(), String> {
        #[cfg(not(windows))]
        {
            let _ = app;
            let _ = MachineAudioSource::from_source_url(&input.source_url, resolve_asset)?;
            let _ = normalize_volume(input.volume);
            return Err("native audio playback is only supported on Windows".to_string());
        }

        #[cfg(windows)]
        {
            let source = MachineAudioSource::from_source_url(&input.source_url, resolve_asset)?;
            let mut sink = DeviceSinkBuilder::open_default_sink()
                .map_err(|error| format!("open Windows default audio output failed: {error}"))?;
            sink.log_on_drop(false);
            let player = Arc::new(Player::connect_new(&sink.mixer()));
            player.set_volume(normalize_volume(input.volume));
            player.pause();
            match source {
                MachineAudioSource::Bytes(bytes) => {
                    let decoder = Decoder::try_from(Cursor::new(bytes))
                        .map_err(|error| format!("decode audio source failed: {error}"))?;
                    self.start_player(app, sink, player, input.request_id, decoder)?;
                }
                MachineAudioSource::File(path) => {
                    let file = File::open(&path)
                        .map_err(|error| format!("open audio source failed: {error}"))?;
                    let decoder = Decoder::try_from(BufReader::new(file))
                        .map_err(|error| format!("decode audio source failed: {error}"))?;
                    self.start_player(app, sink, player, input.request_id, decoder)?;
                }
            }
            Ok(())
        }
    }

    #[cfg(windows)]
    fn start_player<S>(
        &self,
        app: tauri::AppHandle,
        sink: MixerDeviceSink,
        player: Arc<Player>,
        request_id: String,
        source: S,
    ) -> Result<(), String>
    where
        S: rodio::Source<Item = f32> + Send + 'static,
    {
        let stopped_request_id = request_id.clone();
        let terminal_app = app.clone();
        let start = self.lifecycle.replace(
            request_id,
            ActiveMachineAudio {
                app,
                player: Arc::clone(&player),
                sink,
            },
            |replaced| {
                replaced.payload.player.stop();
                let _ = replaced.payload.app.emit(
                    "machine-audio-stopped",
                    MachineAudioTerminalEvent {
                        request_id: replaced.request_id,
                        message: Some("replaced by a newer playback request".to_string()),
                    },
                );
            },
        )?;
        let PlaybackStart::Started(generation) = start else {
            let _ = terminal_app.emit(
                "machine-audio-stopped",
                MachineAudioTerminalEvent {
                    request_id: stopped_request_id,
                    message: Some("stop requested before native playback started".to_string()),
                },
            );
            return Ok(());
        };
        let completion = OnceCompletionSignal::new(self.completion_tx.clone(), generation);
        player.append(source);
        spawn_terminal_waiter(move || {
            player.sleep_until_end();
            completion.send();
        });
        player.play();
        Ok(())
    }

    fn stop(&self, request_id: String) {
        #[cfg(windows)]
        self.lifecycle.stop(request_id, |current| {
            current.payload.player.stop();
            let _ = current.payload.app.emit(
                "machine-audio-stopped",
                MachineAudioTerminalEvent {
                    request_id: current.request_id,
                    message: None,
                },
            );
        });
        #[cfg(not(windows))]
        self.lifecycle.stop(request_id, |_| {});
    }

    fn stop_all(&self) {
        #[cfg(windows)]
        self.lifecycle.stop_active(|current| {
            current.payload.player.stop();
        });
        #[cfg(not(windows))]
        self.lifecycle.stop_active(|_| {});
    }
}

impl Drop for MachineAudioState {
    fn drop(&mut self) {
        self.stop_all();
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn play_machine_audio(
    app: tauri::AppHandle,
    state: tauri::State<'_, MachineAudioState>,
    source_url: String,
    request_id: String,
    volume: Option<f32>,
) -> Result<(), String> {
    let resolver = app.asset_resolver();
    let request_id = normalize_request_id(request_id)?;
    state.play(
        app,
        PlayMachineAudioRequest {
            request_id,
            source_url,
            volume: volume.unwrap_or_else(default_volume),
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

#[tauri::command(rename_all = "camelCase")]
pub fn stop_machine_audio(
    state: tauri::State<'_, MachineAudioState>,
    request_id: String,
) -> Result<(), String> {
    state.stop(normalize_request_id(request_id)?);
    Ok(())
}

fn default_volume() -> f32 {
    1.0
}

fn normalize_request_id(request_id: String) -> Result<String, String> {
    let request_id = request_id.trim().to_string();
    if request_id.is_empty() || request_id.len() > 128 {
        return Err("audio playback request id is invalid".to_string());
    }
    Ok(request_id)
}

fn normalize_volume(volume: f32) -> f32 {
    if volume.is_finite() {
        volume.clamp(0.0, 1.0)
    } else {
        1.0
    }
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

    #[derive(Debug)]
    struct LifecycleObservation {
        action: &'static str,
        thread_id: thread::ThreadId,
        lock_available: bool,
    }

    struct DropProbe {
        active: Arc<Mutex<PlaybackLifecycleState<DropProbe>>>,
        observations: Arc<Mutex<Vec<LifecycleObservation>>>,
    }

    impl Drop for DropProbe {
        fn drop(&mut self) {
            let lock_available = self.active.try_lock().is_ok();
            self.observations
                .lock()
                .expect("observations")
                .push(LifecycleObservation {
                    action: "drop",
                    thread_id: thread::current().id(),
                    lock_available,
                });
        }
    }

    #[test]
    fn completion_worker_drops_payload_then_emits_off_the_signaling_thread() {
        let lifecycle = PlaybackLifecycle::default();
        let active = lifecycle.state_handle();
        let observations = Arc::new(Mutex::new(Vec::new()));
        let probe = DropProbe {
            active: Arc::clone(&active),
            observations: Arc::clone(&observations),
        };
        let generation = lifecycle
            .replace("request-1".to_string(), probe, |_| {})
            .expect("install playback")
            .expect_started();
        let (completion_tx, completion_rx) = mpsc::channel();
        let worker_active = Arc::clone(&active);
        let worker_observations = Arc::clone(&observations);
        let worker = spawn_completion_worker(
            Arc::clone(&active),
            completion_rx,
            move |payload| {
                drop(payload);
            },
            move |request_id, _terminal, ()| {
                assert_eq!(request_id, "request-1");
                let lock_available = worker_active.try_lock().is_ok();
                worker_observations
                    .lock()
                    .expect("observations")
                    .push(LifecycleObservation {
                        action: "emit",
                        thread_id: thread::current().id(),
                        lock_available,
                    });
            },
        );
        let signaling_thread = thread::current().id();

        OnceCompletionSignal::new(completion_tx, generation).send();
        worker.join().expect("completion worker");

        let observations = observations.lock().expect("observations");
        assert_eq!(
            observations
                .iter()
                .map(|observation| observation.action)
                .collect::<Vec<_>>(),
            vec!["drop", "emit"]
        );
        assert!(observations
            .iter()
            .all(|observation| observation.lock_available));
        assert!(observations
            .iter()
            .all(|observation| observation.thread_id != signaling_thread));
        assert_eq!(observations[0].thread_id, observations[1].thread_id);
    }

    #[test]
    fn stop_and_replace_release_the_active_lock_before_stopping_or_dropping_payload() {
        let lifecycle = PlaybackLifecycle::default();
        let active = lifecycle.state_handle();
        let observations = Arc::new(Mutex::new(Vec::new()));
        lifecycle
            .replace(
                "request-1".to_string(),
                DropProbe {
                    active: Arc::clone(&active),
                    observations: Arc::clone(&observations),
                },
                |_| {},
            )
            .expect("install playback");

        lifecycle.stop("request-1".to_string(), |_| {
            observations
                .lock()
                .expect("observations")
                .push(LifecycleObservation {
                    action: "stop",
                    thread_id: thread::current().id(),
                    lock_available: active.try_lock().is_ok(),
                });
        });

        lifecycle
            .replace(
                "request-2".to_string(),
                DropProbe {
                    active: Arc::clone(&active),
                    observations: Arc::clone(&observations),
                },
                |_| {},
            )
            .expect("install replacement source");
        lifecycle
            .replace(
                "request-3".to_string(),
                DropProbe {
                    active: Arc::clone(&active),
                    observations: Arc::clone(&observations),
                },
                |_| {
                    observations
                        .lock()
                        .expect("observations")
                        .push(LifecycleObservation {
                            action: "replace",
                            thread_id: thread::current().id(),
                            lock_available: active.try_lock().is_ok(),
                        });
                },
            )
            .expect("replace playback");
        lifecycle.stop("request-3".to_string(), |_| {});

        let observations = observations.lock().expect("observations");
        assert_eq!(
            observations
                .iter()
                .map(|observation| observation.action)
                .collect::<Vec<_>>(),
            vec!["stop", "drop", "replace", "drop", "drop"]
        );
        assert!(observations
            .iter()
            .all(|observation| observation.lock_available));
    }

    #[test]
    fn stale_completion_generation_cannot_take_replacement_playback() {
        let lifecycle = PlaybackLifecycle::default();
        let first_generation = lifecycle
            .replace("request-1".to_string(), "first", |_| {})
            .expect("install first playback")
            .expect_started();
        let second_generation = lifecycle
            .replace("request-1".to_string(), "second", |_| {})
            .expect("replace playback")
            .expect_started();

        assert!(take_completed(
            &lifecycle.state_handle(),
            CompletionSignal {
                generation: first_generation,
            },
        )
        .is_none());
        let completed = take_completed(
            &lifecycle.state_handle(),
            CompletionSignal {
                generation: second_generation,
            },
        )
        .expect("current playback completes");
        assert_eq!(completed.request_id, "request-1");
        assert_eq!(completed.payload, "second");
    }

    #[test]
    fn stopped_playback_completion_signal_does_not_emit() {
        let lifecycle = PlaybackLifecycle::default();
        let generation = lifecycle
            .replace("request-1".to_string(), (), |_| {})
            .expect("install playback")
            .expect_started();
        lifecycle.stop("request-1".to_string(), |_| {});
        let (completion_tx, completion_rx) = mpsc::channel();
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let worker_emitted = Arc::clone(&emitted);
        let worker = spawn_completion_worker(
            lifecycle.state_handle(),
            completion_rx,
            |()| (),
            move |request_id, _terminal, ()| {
                worker_emitted
                    .lock()
                    .expect("emitted requests")
                    .push(request_id);
            },
        );

        OnceCompletionSignal::new(completion_tx, generation).send();
        worker.join().expect("completion worker");

        assert!(emitted.lock().expect("emitted requests").is_empty());
    }

    #[test]
    fn completion_claimed_before_stop_emits_one_stopped_terminal_after_teardown() {
        let lifecycle = PlaybackLifecycle::default();
        let generation = lifecycle
            .replace("request-1".to_string(), (), |_| {})
            .expect("install playback")
            .expect_started();
        let (completion_tx, completion_rx) = mpsc::channel();
        let (claimed_tx, claimed_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel();
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let worker_emitted = Arc::clone(&emitted);
        let worker = spawn_completion_worker(
            lifecycle.state_handle(),
            completion_rx,
            move |()| {
                claimed_tx.send(()).expect("completion claimed");
                resume_rx.recv().expect("resume completion teardown");
            },
            move |request_id, terminal, ()| {
                worker_emitted
                    .lock()
                    .expect("emitted requests")
                    .push((request_id, terminal));
            },
        );

        OnceCompletionSignal::new(completion_tx, generation).send();
        claimed_rx
            .recv()
            .expect("completion worker claims playback");
        lifecycle.stop("request-1".to_string(), |_| {});
        assert!(emitted.lock().expect("emitted requests").is_empty());
        resume_tx.send(()).expect("resume completion worker");
        worker.join().expect("completion worker");

        assert_eq!(
            *emitted.lock().expect("emitted requests"),
            vec![("request-1".to_string(), CompletionTerminal::Stopped)]
        );
    }

    #[test]
    fn completion_claimed_before_replacement_emits_one_stopped_terminal() {
        let lifecycle = PlaybackLifecycle::default();
        let generation = lifecycle
            .replace("request-1".to_string(), (), |_| {})
            .expect("install playback")
            .expect_started();
        let (completion_tx, completion_rx) = mpsc::channel();
        let (claimed_tx, claimed_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel();
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let worker_emitted = Arc::clone(&emitted);
        let worker = spawn_completion_worker(
            lifecycle.state_handle(),
            completion_rx,
            move |()| {
                claimed_tx.send(()).expect("completion claimed");
                resume_rx.recv().expect("resume completion teardown");
            },
            move |request_id, terminal, ()| {
                worker_emitted
                    .lock()
                    .expect("emitted requests")
                    .push((request_id, terminal));
            },
        );

        OnceCompletionSignal::new(completion_tx, generation).send();
        claimed_rx
            .recv()
            .expect("completion worker claims playback");
        lifecycle
            .replace("request-2".to_string(), (), |_| {})
            .expect("replace playback");
        resume_tx.send(()).expect("resume completion worker");
        worker.join().expect("completion worker");

        assert_eq!(
            *emitted.lock().expect("emitted requests"),
            vec![("request-1".to_string(), CompletionTerminal::Stopped)]
        );
    }

    #[test]
    fn stop_request_before_playback_start_is_claimed_by_that_request() {
        let lifecycle = PlaybackLifecycle::default();
        lifecycle.stop("request-race".to_string(), |_| {
            panic!("a request that has not started cannot be stopped directly")
        });

        assert!(matches!(
            lifecycle
                .replace("request-race".to_string(), (), |_| {})
                .expect("claim stop-before-start request"),
            PlaybackStart::StoppedBeforeStart
        ));
        assert!(lifecycle
            .state_handle()
            .lock()
            .expect("lifecycle state")
            .active
            .is_none());
    }

    #[test]
    fn audio_completion_signal_is_sent_only_once() {
        let (completion_tx, completion_rx) = mpsc::channel();
        let completion = OnceCompletionSignal::new(completion_tx, 42);

        completion.send();
        completion.send();

        assert_eq!(
            completion_rx.recv().expect("completion signal"),
            CompletionSignal { generation: 42 }
        );
        assert!(completion_rx.try_recv().is_err());
    }

    #[test]
    fn terminal_waiter_signals_completion_after_wait_finishes() {
        let (resume_tx, resume_rx) = mpsc::channel();
        let (completion_tx, completion_rx) = mpsc::channel();
        let completion = OnceCompletionSignal::new(completion_tx, 7);

        spawn_terminal_waiter(move || {
            resume_rx.recv().expect("resume terminal wait");
            completion.send();
        });

        assert!(completion_rx.try_recv().is_err());
        resume_tx.send(()).expect("resume terminal waiter");
        assert_eq!(
            completion_rx.recv().expect("completion signal"),
            CompletionSignal { generation: 7 }
        );
    }

    #[test]
    fn rejects_empty_or_overlong_playback_request_ids() {
        assert!(normalize_request_id("  ".to_string()).is_err());
        assert!(normalize_request_id("a".repeat(129)).is_err());
        assert_eq!(
            normalize_request_id(" native-request-1 ".to_string()).expect("request id"),
            "native-request-1"
        );
    }

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
    fn normalizes_invalid_volume_to_full_volume() {
        assert_eq!(normalize_volume(f32::NAN), 1.0);
        assert_eq!(normalize_volume(-1.0), 0.0);
        assert_eq!(normalize_volume(2.0), 1.0);
        assert_eq!(normalize_volume(0.35), 0.35);
    }
}

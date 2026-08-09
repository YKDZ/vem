//! Deep module for the machine-owned managed media cache.
//!
//! The cache deliberately exposes only catalog reconciliation, a readiness
//! projection, and a grant-bound read lease.  Downloading, pinning and cleanup
//! are implementation details of the module rather than IPC commands.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
    time::SystemTime,
};

use async_trait::async_trait;
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, Notify};

const MAX_MEDIA_OBJECT_BYTES: u64 = 5_000_000;
const MAX_MEDIA_OBJECTS: usize = 256;
const MAX_MEDIA_CACHE_BYTES: u64 = 100_000_000;
const MEDIA_CACHE_RESERVED_BYTES: u64 = 5_000_000;
// The cache may briefly contain the previous generation while a new
// generation warms.  Cleanup therefore starts at the high watermark and
// trims inactive objects down to the lower watermark rather than trusting the
// descriptor declarations as a substitute for real disk accounting.
const MEDIA_CACHE_HIGH_WATER_BYTES: u64 = MAX_MEDIA_CACHE_BYTES;
const MEDIA_CACHE_LOW_WATER_BYTES: u64 = 80_000_000;
const CLEANUP_BATCH_SIZE: usize = 32;
const DOWNLOAD_WORKERS: usize = 4;
const VERIFY_BUFFER_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MediaDescriptor {
    pub id: String,
    pub reference: String,
    pub digest: String,
    pub content_type: String,
    pub byte_size: u64,
    pub purpose: String,
    pub revision: MediaRevision,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MediaRevision {
    pub catalog_revision: String,
    #[serde(default)]
    pub asset_revision: Option<String>,
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MediaReadiness {
    Ready,
    Warming,
    Unavailable,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MediaProjection {
    pub descriptor: MediaDescriptor,
    pub readiness: MediaReadiness,
    pub ready_url: Option<String>,
    pub diagnostic: Option<String>,
    pub diagnostic_reason: Option<String>,
}

/// Parse an externally supplied descriptor through the generated strict IPC
/// DTO before converting it into the cache's private domain representation.
pub fn parse_media_descriptor_boundary(
    value: serde_json::Value,
) -> Result<MediaDescriptor, String> {
    let boundary: daemon_ipc_contracts::ManagedMediaDescriptor = serde_json::from_value(value)
        .map_err(|error| format!("managed media descriptor boundary: {error}"))?;
    let descriptor: MediaDescriptor = serde_json::from_value(
        serde_json::to_value(boundary)
            .map_err(|error| format!("managed media descriptor conversion: {error}"))?,
    )
    .map_err(|error| format!("managed media descriptor conversion: {error}"))?;
    if let Some(error) = validate_descriptor(&descriptor) {
        return Err(error);
    }
    Ok(descriptor)
}

/// Canonical object collection used by catalog generation derivation.  This is
/// intentionally the same normalization that reconciliation, receipts and
/// snapshots use, so duplicate source references cannot mint a different
/// generation for unchanged immutable cache objects.
pub fn canonical_media_objects(
    descriptors: Vec<MediaDescriptor>,
) -> Result<Vec<MediaDescriptor>, String> {
    Ok(normalize_interest_set(descriptors)?
        .objects
        .into_iter()
        .map(|object| object.descriptor)
        .collect())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaFetchResult {
    pub content_type: String,
}

#[async_trait]
pub trait MediaFetcher: Send + Sync {
    /// Streams a response directly into `staging`, which is guaranteed to be
    /// on the cache volume.  Fetchers must not retain an object-sized buffer.
    async fn fetch_to(
        &self,
        descriptor: &MediaDescriptor,
        staging: &Path,
    ) -> Result<MediaFetchResult, String>;
}

pub struct BackendMediaFetcher {
    pub backend: Arc<crate::backend::BackendClient>,
}

#[async_trait]
impl MediaFetcher for BackendMediaFetcher {
    async fn fetch_to(
        &self,
        descriptor: &MediaDescriptor,
        staging: &Path,
    ) -> Result<MediaFetchResult, String> {
        self.backend
            .fetch_managed_media_to(&descriptor.reference, descriptor.byte_size, staging)
            .await
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaReadMethod {
    Get,
    Head,
}

#[derive(Debug)]
pub enum MediaReadError {
    Forbidden,
    NotReady,
    NotFound,
    Io(String),
}

impl std::fmt::Display for MediaReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Forbidden => "media read grant or method is not permitted",
            Self::NotReady => "media is not ready",
            Self::NotFound => "media digest is not published",
            Self::Io(error) => error,
        })
    }
}

impl std::error::Error for MediaReadError {}

#[derive(Debug, Clone)]
struct Entry {
    descriptor: MediaDescriptor,
    /// Every currently accepted catalog source for these immutable bytes.
    /// `descriptor` is the canonical projection descriptor; candidates are
    /// retained so a failed current source can fall through to another source
    /// that declares the same verified object.
    candidates: Vec<MediaDescriptor>,
    readiness: MediaReadiness,
    diagnostic: Option<String>,
    pinned: bool,
    active: bool,
    leases: usize,
    last_used: SystemTime,
    warming_generation: Option<String>,
}

#[derive(Debug, Default)]
struct CacheState {
    generation: String,
    entries: HashMap<String, Entry>,
    epoch: u64,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActiveMediaManifest {
    generation: String,
    assets: Vec<MediaDescriptor>,
}

#[derive(Clone)]
pub struct ManagedMediaCache {
    root: Arc<PathBuf>,
    read_url_base: Arc<std::sync::RwLock<String>>,
    grant: Arc<String>,
    fetcher: Arc<dyn MediaFetcher>,
    state: Arc<Mutex<CacheState>>,
    /// Serializes the complete durable adoption transaction.  It deliberately
    /// does not guard reads or warming: only next-state construction, manifest
    /// persistence, state swap and the reconcile receipt belong together.
    reconcile_gate: Arc<Mutex<()>>,
    queue: Arc<Mutex<VecDeque<WarmJob>>>,
    inflight: Arc<Mutex<HashSet<WarmIdentity>>>,
    staging: Arc<Mutex<HashSet<PathBuf>>>,
    queue_notify: Arc<Notify>,
}

#[derive(Debug, Clone)]
struct WarmJob {
    generation: String,
    descriptor: MediaDescriptor,
    candidates: Vec<MediaDescriptor>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct MediaIdentity {
    digest: String,
    content_type: String,
    byte_size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct WarmIdentity {
    generation: String,
    media: MediaIdentity,
}

#[derive(Debug, Clone)]
struct InterestSet {
    candidates: Vec<MediaDescriptor>,
    objects: Vec<MediaObject>,
}

#[derive(Debug, Clone)]
struct MediaObject {
    descriptor: MediaDescriptor,
    candidates: Vec<MediaDescriptor>,
}

impl ManagedMediaCache {
    pub fn new(
        root: impl Into<PathBuf>,
        read_url_base: impl Into<String>,
        fetcher: Arc<dyn MediaFetcher>,
    ) -> Result<Self, String> {
        let root = root.into();
        fs::create_dir_all(&root).map_err(|error| format!("create media cache: {error}"))?;
        let persisted = fs::read(root.join("active-media.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<ActiveMediaManifest>(&bytes).ok())
            .filter(|manifest| {
                !manifest.generation.trim().is_empty()
                    && manifest.assets.len() <= MAX_MEDIA_OBJECTS
                    && manifest
                        .assets
                        .iter()
                        .all(|asset| validate_descriptor(asset).is_none())
            });
        // Inventory cache data during recovery.  A cache object without a
        // current valid manifest is never a recoverable source of truth.
        let allowed = persisted
            .as_ref()
            .map(|manifest| {
                manifest
                    .assets
                    .iter()
                    .map(|asset| object_key(&asset.digest))
                    .collect::<HashSet<_>>()
            })
            .unwrap_or_default();
        if let Ok(entries) = fs::read_dir(&root) {
            for entry in entries.flatten() {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();
                let object = name
                    .strip_suffix(".bin")
                    .or_else(|| name.strip_suffix(".json"));
                if name != "active-media.json" && !object.is_some_and(|key| allowed.contains(key)) {
                    let _ = fs::remove_file(path);
                }
            }
        }
        let initial_state = persisted
            .map(|manifest| {
                let entries = normalize_interest_set(manifest.assets)
                    .ok()
                    .map(|interest| interest.objects)
                    .unwrap_or_default()
                    .into_iter()
                    .map(|object| {
                        let descriptor = object.descriptor;
                        let valid = validate_descriptor(&descriptor).is_none();
                        let ready = valid
                            && verify_staged_file(
                                &root.join(format!("{}.bin", object_key(&descriptor.digest))),
                                &descriptor,
                                &descriptor.content_type,
                            )
                            .is_ok();
                        (
                            descriptor.digest.clone(),
                            Entry {
                                descriptor,
                                candidates: object.candidates,
                                readiness: if ready {
                                    MediaReadiness::Ready
                                } else {
                                    MediaReadiness::Warming
                                },
                                diagnostic: None,
                                pinned: true,
                                active: true,
                                leases: 0,
                                last_used: SystemTime::now(),
                                warming_generation: None,
                            },
                        )
                    })
                    .collect();
                CacheState {
                    generation: manifest.generation,
                    entries,
                    epoch: 1,
                }
            })
            .unwrap_or_default();
        let cache = Self {
            root: Arc::new(root),
            read_url_base: Arc::new(std::sync::RwLock::new(
                read_url_base.into().trim_end_matches('/').to_string(),
            )),
            grant: Arc::new(uuid::Uuid::new_v4().to_string()),
            fetcher,
            state: Arc::new(Mutex::new(initial_state)),
            reconcile_gate: Arc::new(Mutex::new(())),
            queue: Arc::new(Mutex::new(VecDeque::new())),
            inflight: Arc::new(Mutex::new(HashSet::new())),
            staging: Arc::new(Mutex::new(HashSet::new())),
            queue_notify: Arc::new(Notify::new()),
        };
        for _ in 0..DOWNLOAD_WORKERS {
            let worker = cache.clone();
            tokio::spawn(async move { worker.worker_loop().await });
        }
        Ok(cache)
    }

    /// Atomically adopts the complete active interest set and warms it out of band.
    pub async fn reconcile_active_catalog(
        &self,
        generation: impl Into<String>,
        descriptors: Vec<MediaDescriptor>,
    ) -> Result<(), String> {
        let generation = generation.into();
        if generation.trim().is_empty() {
            return Err("managed media generation is required".to_string());
        }
        let interest = normalize_interest_set(descriptors)?;
        self.adopt_interest_set(generation, interest)
            .await
            .map(|_| ())
    }

    async fn adopt_interest_set(
        &self,
        generation: String,
        interest: InterestSet,
    ) -> Result<(usize, daemon_ipc_contracts::ManagedMediaSnapshot), String> {
        let gate = self.reconcile_gate.lock().await;

        // Recovery and regular reconciliation share the same inventory rule:
        // no loose object, metadata, or staging file is allowed to consume the
        // cache budget.  This is deliberately based on actual directory bytes,
        // not on a prior generation's declared descriptor sizes.
        self.remove_untracked_files().await;
        if directory_usage_bytes(self.root.as_ref()) > MEDIA_CACHE_HIGH_WATER_BYTES {
            return Err("managed media cache disk high-water mark exceeded".to_string());
        }

        // The potentially slow disk checks and fsync occur outside the state
        // mutex.  An epoch retry keeps the final in-memory replacement one
        // coherent swap even when refreshes race.
        let (warm, accepted_snapshot) = loop {
            let (epoch, previous) = {
                let state = self.state.lock().await;
                (state.epoch, state.entries.clone())
            };
            let mut entries = previous
                .into_iter()
                .map(|(digest, mut entry)| {
                    entry.active = false;
                    entry.pinned = false;
                    (digest, entry)
                })
                .collect::<HashMap<_, _>>();
            for object in &interest.objects {
                let descriptor = &object.descriptor;
                let digest = descriptor.digest.clone();
                let published = self.published_and_valid(descriptor);
                let entry = entries.entry(digest).or_insert_with(|| Entry {
                    descriptor: descriptor.clone(),
                    candidates: object.candidates.clone(),
                    readiness: MediaReadiness::Warming,
                    diagnostic: None,
                    pinned: false,
                    active: false,
                    leases: 0,
                    last_used: SystemTime::now(),
                    warming_generation: None,
                });
                entry.descriptor = descriptor.clone();
                entry.candidates = object.candidates.clone();
                entry.active = true;
                entry.pinned = true;
                entry.diagnostic = None;
                entry.readiness = if published {
                    MediaReadiness::Ready
                } else {
                    MediaReadiness::Warming
                };
                entry.warming_generation = (!published).then(|| generation.clone());
            }
            let manifest = ActiveMediaManifest {
                generation: generation.clone(),
                assets: interest.candidates.clone(),
            };
            self.persist_manifest(&manifest)?;
            let mut state = self.state.lock().await;
            if state.epoch != epoch {
                continue;
            }
            state.generation = generation.clone();
            state.entries = entries;
            state.epoch = state.epoch.wrapping_add(1);
            let warm = state
                .entries
                .values()
                .filter(|entry| entry.active && entry.readiness == MediaReadiness::Warming)
                .map(|entry| WarmJob {
                    generation: generation.clone(),
                    descriptor: entry.descriptor.clone(),
                    candidates: entry.candidates.clone(),
                })
                .collect::<Vec<_>>();
            let snapshot = snapshot_boundary_from(
                state.generation.clone(),
                state
                    .entries
                    .values()
                    .filter(|entry| entry.active)
                    .map(|entry| self.projection(entry))
                    .collect(),
            )?;
            break (warm, snapshot);
        };
        drop(gate);
        for job in warm {
            self.enqueue_warm(job).await;
        }
        let _ = self.cleanup_bounded(CLEANUP_BATCH_SIZE).await;
        Ok((interest.objects.len(), accepted_snapshot))
    }

    /// Public reconciliation boundary: generated request in, generated
    /// receipt out.  Conversion to the cache domain is explicit and every
    /// descriptor is validated before the active generation is adopted.
    pub async fn reconcile_boundary(
        &self,
        request: daemon_ipc_contracts::ManagedMediaReconcileRequest,
    ) -> Result<daemon_ipc_contracts::ManagedMediaReconcileReceipt, String> {
        let generation = request.generation.to_string();
        let descriptors = request
            .interests
            .into_iter()
            .map(|interest| {
                serde_json::to_value(interest)
                    .map_err(|error| format!("managed media interest conversion: {error}"))
                    .and_then(parse_media_descriptor_boundary)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let interest = normalize_interest_set(descriptors)?;
        let (interest_count, snapshot) = self
            .adopt_interest_set(generation.clone(), interest)
            .await?;
        let receipt = serde_json::from_value(serde_json::json!({
            "generation": generation,
            "accepted": true,
            "interestCount": interest_count,
            "snapshot": snapshot,
        }))
        .map_err(|error| format!("managed media reconcile receipt boundary: {error}"))?;
        daemon_ipc_contracts::validate_managed_media_reconcile_receipt_boundary(&receipt)
            .map_err(|error| error.to_string())?;
        Ok(receipt)
    }

    pub async fn snapshot(&self) -> (String, Vec<MediaProjection>) {
        let state = self.state.lock().await;
        let projections = state
            .entries
            .values()
            .filter(|entry| entry.active)
            .map(|entry| self.projection(entry))
            .collect();
        (state.generation.clone(), projections)
    }

    /// Serialize the public snapshot through the generated strict DTO.  The
    /// private cache projection remains independent from the wire contract.
    pub async fn snapshot_boundary(
        &self,
    ) -> Result<daemon_ipc_contracts::ManagedMediaSnapshot, String> {
        let (generation, assets) = self.snapshot().await;
        snapshot_boundary_from(generation, assets)
    }

    pub fn read_grant(&self) -> String {
        self.grant.as_ref().clone()
    }

    pub fn set_read_url_base(&self, base: impl Into<String>) {
        if let Ok(mut value) = self.read_url_base.write() {
            *value = base.into().trim_end_matches('/').to_string();
        }
    }

    pub async fn read_ready(
        &self,
        grant: &str,
        method: MediaReadMethod,
        digest: &str,
    ) -> Result<MediaReadLease, MediaReadError> {
        if grant != self.grant.as_str()
            || !matches!(method, MediaReadMethod::Get | MediaReadMethod::Head)
        {
            return Err(MediaReadError::Forbidden);
        }
        let mut state = self.state.lock().await;
        let entry = state
            .entries
            .get_mut(digest)
            .ok_or(MediaReadError::NotFound)?;
        if !entry.active || entry.readiness != MediaReadiness::Ready {
            return Err(MediaReadError::NotReady);
        }
        entry.leases += 1;
        entry.last_used = SystemTime::now();
        let path = self.content_path(digest);
        drop(state);
        let entry = self.state.lock().await;
        let descriptor = entry
            .entries
            .get(digest)
            .map(|entry| entry.descriptor.clone());
        drop(entry);
        let descriptor = descriptor.ok_or(MediaReadError::NotFound)?;
        if verify_staged_file(&path, &descriptor, &descriptor.content_type).is_err() {
            let mut state = self.state.lock().await;
            if let Some(entry) = state.entries.get_mut(digest) {
                entry.leases = entry.leases.saturating_sub(1);
                entry.readiness = MediaReadiness::Unavailable;
                entry.diagnostic =
                    Some("published media failed defensive read verification".to_string());
            }
            return Err(MediaReadError::NotReady);
        }
        Ok(MediaReadLease {
            content_type: descriptor.content_type,
            byte_size: descriptor.byte_size,
            digest: digest.to_string(),
            path: matches!(method, MediaReadMethod::Get).then_some(path),
            state: self.state.clone(),
        })
    }

    pub async fn cleanup_bounded(&self, max_remove: usize) -> usize {
        self.remove_untracked_files().await;
        let mut candidates = {
            let state = self.state.lock().await;
            state
                .entries
                .iter()
                .filter(|(_, entry)| !entry.pinned && entry.leases == 0)
                .map(|(digest, entry)| (digest.clone(), entry.last_used))
                .collect::<Vec<_>>()
        };
        candidates.sort_by_key(|(_, used)| *used);
        let mut removed = 0;
        let mut disk_bytes = directory_usage_bytes(self.root.as_ref());
        for (digest, _) in candidates.into_iter().take(max_remove) {
            if disk_bytes <= MEDIA_CACHE_LOW_WATER_BYTES && removed > 0 {
                break;
            }
            // Disk mutation deliberately happens with no Tokio state lock.
            let object_bytes = fs::metadata(self.content_path(&digest))
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            let _ = fs::remove_file(self.content_path(&digest));
            let _ = fs::remove_file(self.meta_path(&digest));
            let mut state = self.state.lock().await;
            if state
                .entries
                .get(&digest)
                .is_some_and(|entry| !entry.pinned && entry.leases == 0)
                && state.entries.remove(&digest).is_some()
            {
                removed += 1;
                disk_bytes = disk_bytes.saturating_sub(object_bytes);
            }
        }
        removed
    }

    /// Remove only files that are not represented by live cache state.  A
    /// lease always wins over reclamation, including when its generation is no
    /// longer active.  The filesystem work intentionally happens outside the
    /// Tokio cache-state mutex.
    async fn remove_untracked_files(&self) {
        let protected = {
            let state = self.state.lock().await;
            state
                .entries
                .iter()
                .filter(|(_, entry)| entry.active || entry.leases > 0)
                .map(|(digest, _)| object_key(digest))
                .collect::<HashSet<_>>()
        };
        let staging = self.staging.lock().await.clone();
        let Ok(entries) = fs::read_dir(self.root.as_ref()) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name == "active-media.json" {
                continue;
            }
            if staging.contains(&path) {
                continue;
            }
            let keep = name
                .strip_suffix(".bin")
                .is_some_and(|key| protected.contains(key));
            if !keep {
                let _ = fs::remove_file(path);
            }
        }
    }

    fn projection(&self, entry: &Entry) -> MediaProjection {
        let base = self
            .read_url_base
            .read()
            .map(|value| value.clone())
            .unwrap_or_default();
        MediaProjection {
            descriptor: entry.descriptor.clone(),
            readiness: entry.readiness,
            ready_url: (entry.readiness == MediaReadiness::Ready).then(|| {
                format!(
                    "{}/media/{}?grant={}",
                    base, entry.descriptor.digest, self.grant
                )
            }),
            diagnostic: entry.diagnostic.clone(),
            diagnostic_reason: entry
                .diagnostic
                .as_deref()
                .and_then(managed_media_diagnostic_reason)
                .map(str::to_string),
        }
    }

    fn content_path(&self, digest: &str) -> PathBuf {
        self.root.join(format!("{}.bin", object_key(digest)))
    }

    fn persist_manifest(&self, manifest: &ActiveMediaManifest) -> Result<(), String> {
        let temp = self.root.join(format!(
            ".active-media.{}.tmp",
            uuid::Uuid::new_v4().simple()
        ));
        write_durable(
            &temp,
            &serde_json::to_vec(manifest).map_err(|error| error.to_string())?,
        )
        .map_err(|error| format!("manifest persistence: {error}"))?;
        let target = self.root.join("active-media.json");
        atomic_replace(&temp, &target).map_err(|error| format!("manifest persistence: {error}"))?;
        sync_parent_dir(&self.root);
        Ok(())
    }

    fn meta_path(&self, digest: &str) -> PathBuf {
        self.root.join(format!("{}.json", object_key(digest)))
    }

    fn published_and_valid(&self, descriptor: &MediaDescriptor) -> bool {
        verify_staged_file(
            &self.content_path(&descriptor.digest),
            descriptor,
            &descriptor.content_type,
        )
        .is_ok()
    }

    async fn enqueue_warm(&self, job: WarmJob) {
        let identity = WarmIdentity {
            generation: job.generation.clone(),
            media: media_identity(&job.descriptor),
        };
        let mut inflight = self.inflight.lock().await;
        if !inflight.insert(identity) {
            return;
        }
        drop(inflight);
        self.queue.lock().await.push_back(job);
        self.queue_notify.notify_one();
    }

    async fn worker_loop(self) {
        loop {
            let job = loop {
                if let Some(job) = self.queue.lock().await.pop_front() {
                    break job;
                }
                self.queue_notify.notified().await;
            };
            self.warm(job.clone()).await;
            self.inflight.lock().await.remove(&WarmIdentity {
                generation: job.generation.clone(),
                media: media_identity(&job.descriptor),
            });
        }
    }

    async fn warm(&self, job: WarmJob) {
        let stage = self.staging_path(&job.descriptor.digest, &job.generation);
        self.staging.lock().await.insert(stage.clone());
        let mut failures = Vec::new();
        let mut result = Err("managed media has no candidate source".to_string());
        for candidate in &job.candidates {
            result = self
                .fetcher
                .fetch_to(candidate, &stage)
                .await
                .and_then(|response| {
                    if response.content_type != candidate.content_type {
                        return Err("media content type does not match descriptor".to_string());
                    }
                    verify_staged_file(&stage, candidate, &response.content_type)
                });
            match &result {
                Ok(()) => break,
                Err(error) => failures.push(format!("{}: {error}", candidate.reference)),
            }
        }
        if result.is_err() && !failures.is_empty() {
            result = Err(format!(
                "all managed media sources failed: {}",
                failures.join("; ")
            ));
        }
        match result {
            Ok(()) => {
                // First take a cheap fence snapshot.  The slow filesystem
                // replacement itself must never run under the Tokio mutex:
                // snapshots and sale-view stay responsive while large objects
                // are being published.
                let current = {
                    let state = self.state.lock().await;
                    state
                        .entries
                        .get(&job.descriptor.digest)
                        .filter(|entry| {
                            entry.active
                                && media_identity(&entry.descriptor)
                                    == media_identity(&job.descriptor)
                                && entry.warming_generation.as_deref()
                                    == Some(job.generation.as_str())
                        })
                        .map(|entry| entry.descriptor.clone())
                };
                let Some(current) = current else {
                    let _ = fs::remove_file(&stage);
                    self.staging.lock().await.remove(&stage);
                    return;
                };
                if directory_usage_bytes(self.root.as_ref()) > MEDIA_CACHE_HIGH_WATER_BYTES {
                    let _ = fs::remove_file(&stage);
                    let mut state = self.state.lock().await;
                    if let Some(entry) = state.entries.get_mut(&current.digest) {
                        if entry.warming_generation.as_deref() == Some(job.generation.as_str()) {
                            entry.readiness = MediaReadiness::Unavailable;
                            entry.diagnostic = Some(
                                "managed media cache disk high-water mark exceeded".to_string(),
                            );
                        }
                    }
                    return;
                }
                let publish = self.publish_staged(&current, &stage);
                let mut state = self.state.lock().await;
                let current = state
                    .entries
                    .get(&job.descriptor.digest)
                    .filter(|entry| {
                        entry.active
                            && media_identity(&entry.descriptor) == media_identity(&job.descriptor)
                            && entry.warming_generation.as_deref() == Some(job.generation.as_str())
                    })
                    .map(|entry| entry.descriptor.clone());
                if let Some(current) = current {
                    if let Some(entry) = state.entries.get_mut(&current.digest) {
                        entry.warming_generation = None;
                        match publish {
                            Ok(()) => {
                                entry.readiness = MediaReadiness::Ready;
                                entry.diagnostic = None;
                            }
                            Err(error) => {
                                entry.readiness = MediaReadiness::Unavailable;
                                entry.diagnostic = Some(error);
                            }
                        }
                    }
                } else {
                    // A late completion may have published after its
                    // generation was replaced.  Remove its unreferenced
                    // target immediately so it cannot become an orphan.
                    if publish.is_ok() {
                        let _ = fs::remove_file(self.content_path(&job.descriptor.digest));
                    } else {
                        let _ = fs::remove_file(&stage);
                    }
                }
            }
            Err(error) => {
                let _ = fs::remove_file(&stage);
                let mut state = self.state.lock().await;
                if let Some(entry) = state
                    .entries
                    .get_mut(&job.descriptor.digest)
                    .filter(|entry| {
                        entry.active
                            && media_identity(&entry.descriptor) == media_identity(&job.descriptor)
                            && entry.warming_generation.as_deref() == Some(job.generation.as_str())
                    })
                {
                    entry.warming_generation = None;
                    entry.readiness = MediaReadiness::Unavailable;
                    entry.diagnostic = Some(error);
                }
            }
        }
        self.staging.lock().await.remove(&stage);
    }

    fn staging_path(&self, digest: &str, generation: &str) -> PathBuf {
        let generation = format!("{:x}", Sha256::digest(generation.as_bytes()));
        self.root.join(format!(
            ".{}.{}.{}.tmp",
            object_key(digest),
            &generation[..16],
            uuid::Uuid::new_v4().simple()
        ))
    }

    fn publish_staged(&self, descriptor: &MediaDescriptor, stage: &Path) -> Result<(), String> {
        atomic_replace(stage, &self.content_path(&descriptor.digest))?;
        // `active-media.json` is the durable descriptor authority.  No second
        // per-object descriptor is written on the hot publication path.
        Ok(())
    }
}

fn snapshot_boundary_from(
    generation: String,
    assets: Vec<MediaProjection>,
) -> Result<daemon_ipc_contracts::ManagedMediaSnapshot, String> {
    let mut value = serde_json::json!({ "generation": generation, "assets": assets });
    if let Some(items) = value
        .get_mut("assets")
        .and_then(serde_json::Value::as_array_mut)
    {
        for item in items {
            let reason = item
                .get("diagnostic")
                .and_then(serde_json::Value::as_str)
                .and_then(managed_media_diagnostic_reason);
            item["diagnosticReason"] = reason.map_or(serde_json::Value::Null, |value| {
                serde_json::Value::String(value.to_string())
            });
        }
    }
    serde_json::from_value(value)
        .map_err(|error| format!("managed media snapshot boundary: {error}"))
}

fn object_key(digest: &str) -> String {
    digest
        .strip_prefix("sha256:")
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .unwrap_or("invalid")
        .to_ascii_lowercase()
}

fn directory_usage_bytes(root: &Path) -> u64 {
    fs::read_dir(root)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| entry.metadata().ok())
        .filter(|metadata| metadata.is_file())
        .map(|metadata| metadata.len())
        .sum()
}

fn write_durable(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = fs::File::create(path).map_err(|error| format!("stage media file: {error}"))?;
    file.write_all(bytes)
        .map_err(|error| format!("write staged media file: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("sync staged media file: {error}"))
}

#[cfg(not(windows))]
fn atomic_replace(from: &Path, to: &Path) -> Result<(), String> {
    fs::rename(from, to).map_err(|error| format!("atomically publish media file: {error}"))
}

#[cfg(windows)]
fn atomic_replace(from: &Path, to: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let wide = |value: &Path| {
        value
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>()
    };
    let from = wide(from);
    let to = wide(to);
    // MoveFileExW performs an in-volume replacement without the delete window
    // that `remove_file` followed by `rename` created.
    if unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(format!(
            "atomically publish media file: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn sync_parent_dir(path: &Path) {
    let _ = fs::File::open(path).and_then(|dir| dir.sync_all());
}

#[cfg(not(unix))]
fn sync_parent_dir(_: &Path) {}

pub struct MediaReadLease {
    pub content_type: String,
    pub byte_size: u64,
    pub digest: String,
    path: Option<PathBuf>,
    state: Arc<Mutex<CacheState>>,
}

impl MediaReadLease {
    pub async fn into_file(mut self) -> Result<(tokio::fs::File, Self), MediaReadError> {
        let path = self
            .path
            .take()
            .ok_or_else(|| MediaReadError::Io("HEAD has no body".to_string()))?;
        let file = tokio::fs::File::open(path)
            .await
            .map_err(|error| MediaReadError::Io(error.to_string()))?;
        Ok((file, self))
    }
}

impl Drop for MediaReadLease {
    fn drop(&mut self) {
        let state = self.state.clone();
        let digest = self.digest.clone();
        tokio::spawn(async move {
            if let Some(entry) = state.lock().await.entries.get_mut(&digest) {
                entry.leases = entry.leases.saturating_sub(1);
            }
        });
    }
}

#[cfg(test)]
fn digest_of(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn media_identity(descriptor: &MediaDescriptor) -> MediaIdentity {
    MediaIdentity {
        digest: descriptor.digest.clone(),
        content_type: descriptor.content_type.clone(),
        byte_size: descriptor.byte_size,
    }
}

/// Canonicalize one generation exactly once.  A cache object is deduplicated
/// by immutable byte identity (digest/type/size), while every distinct current
/// source descriptor remains a candidate in the durable manifest.  Receipt
/// `interestCount` and snapshot assets therefore mean *cache objects*, not
/// source references.
fn normalize_interest_set(mut candidates: Vec<MediaDescriptor>) -> Result<InterestSet, String> {
    if candidates.len() > MAX_MEDIA_OBJECTS {
        return Err("managed media interest object limit exceeded".to_string());
    }
    for descriptor in &candidates {
        if let Some(error) = validate_descriptor(descriptor) {
            return Err(error);
        }
    }
    candidates.sort_by(|left, right| {
        (
            &left.digest,
            &left.content_type,
            left.byte_size,
            &left.id,
            &left.reference,
            &left.purpose,
            &left.revision.catalog_revision,
            &left.revision.asset_revision,
        )
            .cmp(&(
                &right.digest,
                &right.content_type,
                right.byte_size,
                &right.id,
                &right.reference,
                &right.purpose,
                &right.revision.catalog_revision,
                &right.revision.asset_revision,
            ))
    });
    candidates.dedup();

    let mut objects = Vec::new();
    let mut cursor = 0;
    let mut aggregate_bytes = 0u64;
    while cursor < candidates.len() {
        let end = candidates[cursor..]
            .iter()
            .position(|candidate| candidate.digest != candidates[cursor].digest)
            .map(|offset| cursor + offset)
            .unwrap_or(candidates.len());
        let sources = candidates[cursor..end].to_vec();
        let descriptor = sources[0].clone();
        if sources
            .iter()
            .any(|candidate| media_identity(candidate) != media_identity(&descriptor))
        {
            return Err("managed media digest has inconsistent immutable facts".to_string());
        }
        aggregate_bytes = aggregate_bytes.saturating_add(descriptor.byte_size);
        if aggregate_bytes > MAX_MEDIA_CACHE_BYTES.saturating_sub(MEDIA_CACHE_RESERVED_BYTES) {
            return Err("managed media cache byte budget exceeded".to_string());
        }
        objects.push(MediaObject {
            descriptor,
            candidates: sources,
        });
        cursor = end;
    }
    Ok(InterestSet {
        candidates,
        objects,
    })
}

fn validate_descriptor(descriptor: &MediaDescriptor) -> Option<String> {
    let valid_id = uuid::Uuid::parse_str(&descriptor.id).is_ok();
    let valid_reference = descriptor.reference.starts_with("/api/media-assets/")
        && descriptor.reference.ends_with("/content")
        && !descriptor.reference.contains("..")
        && !descriptor.reference.contains("://")
        && descriptor
            .reference
            .strip_prefix("/api/media-assets/")
            .and_then(|value| value.strip_suffix("/content"))
            .is_some_and(|value| value.eq_ignore_ascii_case(&descriptor.id));
    let valid_digest = descriptor.digest.starts_with("sha256:")
        && descriptor.digest.len() == 71
        && descriptor.digest[7..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit());
    let valid_purpose = matches!(
        descriptor.purpose.as_str(),
        "product_display_image" | "try_on_garment"
    );
    if valid_id
        && valid_reference
        && valid_digest
        && descriptor.byte_size > 0
        && descriptor.byte_size <= MAX_MEDIA_OBJECT_BYTES
        && matches!(
            descriptor.content_type.as_str(),
            "image/png" | "image/jpeg" | "image/webp"
        )
        && valid_purpose
        && !descriptor.revision.catalog_revision.trim().is_empty()
    {
        None
    } else {
        Some("managed media descriptor failed boundary validation".to_string())
    }
}

fn managed_media_diagnostic_reason(message: &str) -> Option<&'static str> {
    if message.contains("descriptor") {
        Some("descriptor_invalid")
    } else if message.contains("budget") || message.contains("object limit") {
        Some("cache_budget_exceeded")
    } else if message.contains("manifest persistence") {
        Some("manifest_persistence_failed")
    } else if message.contains("byte size") {
        Some("byte_size_mismatch")
    } else if message.contains("content type") {
        Some("content_type_mismatch")
    } else if message.contains("header") {
        Some("media_facts_invalid")
    } else if message.contains("digest") {
        Some("digest_mismatch")
    } else if message.contains("defensive read") {
        Some("defensive_read_failed")
    } else if message.contains("published") || message.contains("existing") {
        Some("published_media_corrupt")
    } else {
        Some("download_failed")
    }
}

fn verify_staged_file(
    path: &Path,
    descriptor: &MediaDescriptor,
    content_type: &str,
) -> Result<(), String> {
    let mut file =
        fs::File::open(path).map_err(|error| format!("open staged media file: {error}"))?;
    let mut digest = Sha256::new();
    let mut header = Vec::with_capacity(12);
    let mut bytes = 0u64;
    let mut buffer = [0u8; VERIFY_BUFFER_BYTES];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("read staged media file: {error}"))?;
        if count == 0 {
            break;
        }
        bytes = bytes.saturating_add(count as u64);
        if bytes > descriptor.byte_size || bytes > MAX_MEDIA_OBJECT_BYTES {
            return Err("media byte size does not match descriptor".to_string());
        }
        let needed = 12usize.saturating_sub(header.len()).min(count);
        header.extend_from_slice(&buffer[..needed]);
        digest.update(&buffer[..count]);
    }
    if bytes != descriptor.byte_size {
        return Err("media byte size does not match descriptor".to_string());
    }
    let valid_magic = match content_type {
        "image/png" => header.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => header.starts_with(b"\xff\xd8\xff"),
        "image/webp" => header.len() >= 12 && &header[..4] == b"RIFF" && &header[8..12] == b"WEBP",
        _ => false,
    };
    if valid_magic {
        let actual = format!("sha256:{:x}", digest.finalize());
        if actual == descriptor.digest {
            Ok(())
        } else {
            Err("media digest does not match descriptor".to_string())
        }
    } else {
        Err("media header does not match declared image type".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    struct FixtureFetcher {
        bytes: Vec<u8>,
        content_type: String,
    }

    #[async_trait]
    impl MediaFetcher for FixtureFetcher {
        async fn fetch_to(
            &self,
            _: &MediaDescriptor,
            staging: &Path,
        ) -> Result<MediaFetchResult, String> {
            write_durable(staging, &self.bytes)?;
            Ok(MediaFetchResult {
                content_type: self.content_type.clone(),
            })
        }
    }

    fn descriptor(bytes: &[u8], content_type: &str) -> MediaDescriptor {
        MediaDescriptor {
            id: "550e8400-e29b-41d4-a716-446655440124".to_string(),
            reference: "/api/media-assets/550e8400-e29b-41d4-a716-446655440124/content".to_string(),
            digest: digest_of(bytes),
            content_type: content_type.to_string(),
            byte_size: bytes.len() as u64,
            purpose: "product_display_image".to_string(),
            revision: MediaRevision {
                catalog_revision: "catalog-1".to_string(),
                asset_revision: None,
            },
        }
    }

    async fn lease_bytes(lease: MediaReadLease) -> Vec<u8> {
        let (mut file, _lease) = lease.into_file().await.expect("stream file");
        let mut bytes = Vec::new();
        tokio::io::AsyncReadExt::read_to_end(&mut file, &mut bytes)
            .await
            .expect("read stream");
        bytes
    }

    #[tokio::test]
    async fn reconciliation_warms_verified_bytes_and_exposes_only_ready_digest() {
        let bytes = b"\x89PNG\r\n\x1a\nimage".to_vec();
        let descriptor = descriptor(&bytes, "image/png");
        let cache = ManagedMediaCache::new(
            tempdir().expect("tempdir").keep(),
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                bytes,
                content_type: "image/png".to_string(),
            }),
        )
        .expect("cache");
        cache
            .reconcile_active_catalog("generation-1", vec![descriptor.clone()])
            .await
            .expect("adopt");
        for _ in 0..20 {
            if cache.snapshot().await.1[0].readiness == MediaReadiness::Ready {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        let (_, snapshot) = cache.snapshot().await;
        assert_eq!(snapshot[0].readiness, MediaReadiness::Ready);
        let grant = cache.read_grant();
        let lease = cache
            .read_ready(&grant, MediaReadMethod::Get, &descriptor.digest)
            .await
            .expect("read");
        assert_eq!(lease_bytes(lease).await, b"\x89PNG\r\n\x1a\nimage");
        assert!(snapshot[0]
            .ready_url
            .as_deref()
            .is_some_and(|url| url.contains("grant=")));
    }

    #[tokio::test]
    async fn corrupt_download_is_unavailable_and_never_published() {
        let expected = descriptor(b"\x89PNG\r\n\x1a\ngood", "image/png");
        let cache = ManagedMediaCache::new(
            tempdir().expect("tempdir").keep(),
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                bytes: b"bad".to_vec(),
                content_type: "image/png".to_string(),
            }),
        )
        .expect("cache");
        cache
            .reconcile_active_catalog("generation-1", vec![expected.clone()])
            .await
            .expect("adopt");
        for _ in 0..20 {
            if cache.snapshot().await.1[0].readiness == MediaReadiness::Unavailable {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert_eq!(
            cache.snapshot().await.1[0].readiness,
            MediaReadiness::Unavailable
        );
        assert!(matches!(
            cache
                .read_ready(&cache.read_grant(), MediaReadMethod::Get, &expected.digest)
                .await,
            Err(MediaReadError::NotReady)
        ));
    }

    #[tokio::test]
    async fn cleanup_never_removes_active_same_digest_staging_and_publish_is_atomic() {
        struct StagedFetcher {
            bytes: Vec<u8>,
            staged: Arc<Notify>,
            release: Arc<Notify>,
        }

        #[async_trait]
        impl MediaFetcher for StagedFetcher {
            async fn fetch_to(
                &self,
                _: &MediaDescriptor,
                staging: &Path,
            ) -> Result<MediaFetchResult, String> {
                write_durable(staging, &self.bytes)?;
                self.staged.notify_one();
                self.release.notified().await;
                Ok(MediaFetchResult {
                    content_type: "image/png".to_string(),
                })
            }
        }

        let root = tempdir().expect("tempdir").keep();
        let bytes = b"\x89PNG\r\n\x1a\nstaged".to_vec();
        let expected = descriptor(&bytes, "image/png");
        let staged = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let cache = ManagedMediaCache::new(
            root.clone(),
            "http://127.0.0.1:1234",
            Arc::new(StagedFetcher {
                bytes,
                staged: staged.clone(),
                release: release.clone(),
            }),
        )
        .expect("cache");

        cache
            .reconcile_active_catalog("generation-1", vec![expected.clone()])
            .await
            .expect("adopt");
        tokio::time::timeout(std::time::Duration::from_secs(1), staged.notified())
            .await
            .expect("staging started");
        assert_eq!(cache.cleanup_bounded(10).await, 0);
        release.notify_waiters();
        for _ in 0..40 {
            if cache.snapshot().await.1[0].readiness == MediaReadiness::Ready {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert_eq!(cache.snapshot().await.1[0].readiness, MediaReadiness::Ready);
        assert!(fs::read_dir(root)
            .expect("cache files")
            .flatten()
            .all(|entry| !entry.file_name().to_string_lossy().ends_with(".tmp")));
    }

    #[tokio::test]
    async fn a_post_publish_corruption_is_not_served() {
        let root = tempdir().expect("tempdir").keep();
        let bytes = b"\x89PNG\r\n\x1a\nverified".to_vec();
        let expected = descriptor(&bytes, "image/png");
        let cache = ManagedMediaCache::new(
            root,
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                bytes,
                content_type: "image/png".to_string(),
            }),
        )
        .expect("cache");
        cache
            .reconcile_active_catalog("generation-1", vec![expected.clone()])
            .await
            .expect("adopt");
        for _ in 0..20 {
            if cache.snapshot().await.1[0].readiness == MediaReadiness::Ready {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        fs::write(cache.content_path(&expected.digest), b"corrupt")
            .expect("corrupt published file");
        assert!(matches!(
            cache
                .read_ready(&cache.read_grant(), MediaReadMethod::Get, &expected.digest)
                .await,
            Err(MediaReadError::NotReady)
        ));
    }

    #[tokio::test]
    async fn replacement_unpins_old_digest_and_cleanup_respects_read_lease() {
        let old_bytes = b"\x89PNG\r\n\x1a\nold".to_vec();
        let old = descriptor(&old_bytes, "image/png");
        let new_bytes = b"\x89PNG\r\n\x1a\nnew".to_vec();
        let new = descriptor(&new_bytes, "image/png");
        let cache = ManagedMediaCache::new(
            tempdir().expect("tempdir").keep(),
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                bytes: old_bytes,
                content_type: "image/png".to_string(),
            }),
        )
        .expect("cache");
        cache
            .reconcile_active_catalog("generation-1", vec![old.clone()])
            .await
            .expect("adopt");
        for _ in 0..20 {
            if cache.snapshot().await.1[0].readiness == MediaReadiness::Ready {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        let lease = cache
            .read_ready(&cache.read_grant(), MediaReadMethod::Get, &old.digest)
            .await
            .expect("old lease");
        cache
            .reconcile_active_catalog("generation-2", vec![new])
            .await
            .expect("adopt");
        assert_eq!(cache.cleanup_bounded(10).await, 0);
        drop(lease);
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        assert_eq!(cache.cleanup_bounded(10).await, 1);
    }

    #[tokio::test]
    async fn a_verified_digest_is_readable_offline_after_cache_reconstruction() {
        let root = tempdir().expect("tempdir").keep();
        let bytes = b"\x89PNG\r\n\x1a\noffline-ready".to_vec();
        let expected = descriptor(&bytes, "image/png");
        let online = ManagedMediaCache::new(
            root.clone(),
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                bytes,
                content_type: "image/png".to_string(),
            }),
        )
        .expect("cache");
        online
            .reconcile_active_catalog("generation-1", vec![expected.clone()])
            .await
            .expect("adopt");
        for _ in 0..20 {
            if online.snapshot().await.1[0].readiness == MediaReadiness::Ready {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        struct OfflineFetcher;
        #[async_trait]
        impl MediaFetcher for OfflineFetcher {
            async fn fetch_to(
                &self,
                _: &MediaDescriptor,
                _: &Path,
            ) -> Result<MediaFetchResult, String> {
                Err("offline".to_string())
            }
        }
        let offline =
            ManagedMediaCache::new(root, "http://127.0.0.1:1234", Arc::new(OfflineFetcher))
                .expect("cache");
        assert_eq!(
            offline.snapshot().await.1[0].readiness,
            MediaReadiness::Ready
        );
        let lease = offline
            .read_ready(
                &offline.read_grant(),
                MediaReadMethod::Get,
                &expected.digest,
            )
            .await
            .expect("offline read");
        assert_eq!(lease_bytes(lease).await, b"\x89PNG\r\n\x1a\noffline-ready");
    }

    #[tokio::test]
    async fn corrupt_manifest_never_revives_an_old_cached_digest() {
        let root = tempdir().expect("tempdir").keep();
        let bytes = b"\x89PNG\r\n\x1a\nold".to_vec();
        let old = descriptor(&bytes, "image/png");
        fs::write(
            root.join(format!("{}.bin", object_key(&old.digest))),
            &bytes,
        )
        .expect("old object");
        fs::write(root.join("active-media.json"), b"{not valid JSON").expect("corrupt manifest");
        let cache = ManagedMediaCache::new(
            root,
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                bytes,
                content_type: "image/png".to_string(),
            }),
        )
        .expect("cache");

        assert!(cache.snapshot().await.1.is_empty());
        assert!(matches!(
            cache
                .read_ready(&cache.read_grant(), MediaReadMethod::Get, &old.digest)
                .await,
            Err(MediaReadError::NotFound)
        ));
    }

    #[tokio::test]
    async fn reconciliation_returns_while_proactive_fetch_is_still_pending() {
        struct SlowFetcher;
        #[async_trait]
        impl MediaFetcher for SlowFetcher {
            async fn fetch_to(
                &self,
                _: &MediaDescriptor,
                _: &Path,
            ) -> Result<MediaFetchResult, String> {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                Err("slow source".to_string())
            }
        }
        let cache = ManagedMediaCache::new(
            tempdir().expect("tempdir").keep(),
            "http://127.0.0.1:1234",
            Arc::new(SlowFetcher),
        )
        .expect("cache");
        let descriptor = descriptor(b"pending", "image/png");
        tokio::time::timeout(
            std::time::Duration::from_millis(25),
            cache.reconcile_active_catalog("generation-1", vec![descriptor]),
        )
        .await
        .expect("reconciliation must not await source fetch")
        .expect("adopt");
    }

    #[tokio::test]
    async fn same_digest_candidates_are_all_accepted_and_share_verified_bytes() {
        let bytes = b"\x89PNG\r\n\x1a\nsame-digest".to_vec();
        let first = descriptor(&bytes, "image/png");
        let mut second = first.clone();
        second.id = "550e8400-e29b-41d4-a716-446655440125".to_string();
        second.reference =
            "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content".to_string();
        let cache = ManagedMediaCache::new(
            tempdir().expect("tempdir").keep(),
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                bytes,
                content_type: "image/png".to_string(),
            }),
        )
        .expect("cache");

        let request = serde_json::from_value(serde_json::json!({
            "generation": "generation-1",
            "interests": [first, second],
        }))
        .expect("generated request");
        let receipt = cache
            .reconcile_boundary(request)
            .await
            .expect("accepted receipt");

        assert_eq!(receipt.interest_count, 1, "count means cache objects");
        assert_eq!(receipt.snapshot.assets.len(), 1);
        let manifest: ActiveMediaManifest = serde_json::from_slice(
            &fs::read(cache.root.join("active-media.json")).expect("manifest"),
        )
        .expect("manifest shape");
        assert_eq!(manifest.assets.len(), 2, "both source candidates persist");
    }

    #[tokio::test]
    async fn failed_source_falls_through_to_another_current_same_digest_candidate() {
        struct FirstSourceFails {
            bytes: Vec<u8>,
        }
        #[async_trait]
        impl MediaFetcher for FirstSourceFails {
            async fn fetch_to(
                &self,
                descriptor: &MediaDescriptor,
                staging: &Path,
            ) -> Result<MediaFetchResult, String> {
                if descriptor.id.ends_with("124") {
                    return Err("first source unavailable".to_string());
                }
                write_durable(staging, &self.bytes)?;
                Ok(MediaFetchResult {
                    content_type: descriptor.content_type.clone(),
                })
            }
        }

        let bytes = b"\x89PNG\r\n\x1a\nfallback".to_vec();
        let first = descriptor(&bytes, "image/png");
        let mut second = first.clone();
        second.id = "550e8400-e29b-41d4-a716-446655440125".to_string();
        second.reference =
            "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content".to_string();
        let cache = ManagedMediaCache::new(
            tempdir().expect("tempdir").keep(),
            "http://127.0.0.1:1234",
            Arc::new(FirstSourceFails { bytes }),
        )
        .expect("cache");

        cache
            .reconcile_active_catalog("generation-1", vec![first.clone(), second])
            .await
            .expect("adopt");
        for _ in 0..20 {
            if cache.snapshot().await.1[0].readiness == MediaReadiness::Ready {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        let (_, snapshot) = cache.snapshot().await;
        assert_eq!(snapshot[0].readiness, MediaReadiness::Ready);
        assert_eq!(
            lease_bytes(
                cache
                    .read_ready(&cache.read_grant(), MediaReadMethod::Get, &first.digest)
                    .await
                    .expect("fallback bytes are readable"),
            )
            .await,
            b"\x89PNG\r\n\x1a\nfallback"
        );
    }

    #[tokio::test]
    async fn manifest_persistence_failure_keeps_previous_generation_and_cannot_revive_rejected_one()
    {
        let root = tempdir().expect("tempdir").keep();
        let old_bytes = b"\x89PNG\r\n\x1a\nold-generation".to_vec();
        let old = descriptor(&old_bytes, "image/png");
        let cache = ManagedMediaCache::new(
            root.clone(),
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                bytes: old_bytes,
                content_type: "image/png".to_string(),
            }),
        )
        .expect("cache");
        cache
            .reconcile_active_catalog("generation-old", vec![old.clone()])
            .await
            .expect("old generation accepted");

        let parked_root = root.with_extension("parked");
        fs::rename(&root, &parked_root).expect("park cache directory");
        fs::write(&root, b"not a directory").expect("block manifest path");
        let new = descriptor(b"\x89PNG\r\n\x1a\nrejected-generation", "image/png");
        let rejected: daemon_ipc_contracts::ManagedMediaReconcileRequest =
            serde_json::from_value(serde_json::json!({
                "generation": "generation-rejected",
                "interests": [new],
            }))
            .expect("generated request");
        assert!(cache.reconcile_boundary(rejected).await.is_err());
        assert_eq!(cache.snapshot().await.0, "generation-old");

        fs::remove_file(&root).expect("unblock manifest path");
        fs::rename(&parked_root, &root).expect("restore cache directory");
        let restarted = ManagedMediaCache::new(
            root,
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                bytes: Vec::new(),
                content_type: "image/png".to_string(),
            }),
        )
        .expect("restart");
        let (generation, snapshot) = restarted.snapshot().await;
        assert_eq!(generation, "generation-old");
        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0].descriptor.digest, old.digest);
    }

    #[tokio::test]
    async fn concurrent_reconciles_leave_manifest_memory_and_accepted_receipt_on_one_generation() {
        let root = tempdir().expect("tempdir").keep();
        let cache = ManagedMediaCache::new(
            root.clone(),
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                bytes: Vec::new(),
                content_type: "image/png".to_string(),
            }),
        )
        .expect("cache");
        let a = descriptor(b"\x89PNG\r\n\x1a\ngeneration-a", "image/png");
        let b = descriptor(b"\x89PNG\r\n\x1a\ngeneration-b", "image/png");
        let request = |generation: &str, descriptor: MediaDescriptor| {
            serde_json::from_value(serde_json::json!({
                "generation": generation,
                "interests": [descriptor],
            }))
            .expect("generated request")
        };
        let first = cache.clone();
        let second = cache.clone();
        let (a_receipt, b_receipt) = tokio::join!(
            first.reconcile_boundary(request("generation-a", a)),
            second.reconcile_boundary(request("generation-b", b)),
        );
        let a_receipt = a_receipt.expect("A receipt");
        let b_receipt = b_receipt.expect("B receipt");
        let (generation, snapshot) = cache.snapshot().await;
        let manifest: ActiveMediaManifest =
            serde_json::from_slice(&fs::read(root.join("active-media.json")).expect("manifest"))
                .expect("manifest shape");
        let receipt = [a_receipt, b_receipt]
            .into_iter()
            .find(|receipt| receipt.generation.as_str() == generation)
            .expect("final accepted receipt");

        assert_eq!(manifest.generation, generation);
        assert_eq!(receipt.snapshot.generation.as_str(), generation);
        assert_eq!(receipt.snapshot.assets.len(), snapshot.len());
        assert_eq!(manifest.assets.len(), snapshot.len());
        assert_eq!(
            manifest.assets[0].digest, snapshot[0].descriptor.digest,
            "disk and memory describe the same adopted generation"
        );
    }

    #[tokio::test]
    async fn stale_generation_failure_does_not_mark_new_same_digest_source_unavailable() {
        struct GenerationFencedFetcher {
            bytes: Vec<u8>,
            old_started: Arc<Notify>,
            release_old: Arc<Notify>,
        }
        #[async_trait]
        impl MediaFetcher for GenerationFencedFetcher {
            async fn fetch_to(
                &self,
                descriptor: &MediaDescriptor,
                staging: &Path,
            ) -> Result<MediaFetchResult, String> {
                if descriptor.id.ends_with("124") {
                    self.old_started.notify_one();
                    self.release_old.notified().await;
                    return Err("stale source failed".to_string());
                }
                write_durable(staging, &self.bytes)?;
                Ok(MediaFetchResult {
                    content_type: "image/png".to_string(),
                })
            }
        }

        let bytes = b"\x89PNG\r\n\x1a\nfenced-source".to_vec();
        let old = descriptor(&bytes, "image/png");
        let mut current = old.clone();
        current.id = "550e8400-e29b-41d4-a716-446655440125".to_string();
        current.reference =
            "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content".to_string();
        let old_started = Arc::new(Notify::new());
        let release_old = Arc::new(Notify::new());
        let cache = ManagedMediaCache::new(
            tempdir().expect("tempdir").keep(),
            "http://127.0.0.1:1234",
            Arc::new(GenerationFencedFetcher {
                bytes,
                old_started: old_started.clone(),
                release_old: release_old.clone(),
            }),
        )
        .expect("cache");
        cache
            .reconcile_active_catalog("generation-old", vec![old])
            .await
            .expect("old adoption");
        tokio::time::timeout(std::time::Duration::from_secs(1), old_started.notified())
            .await
            .expect("old source started");
        cache
            .reconcile_active_catalog("generation-current", vec![current])
            .await
            .expect("current adoption");
        release_old.notify_waiters();
        for _ in 0..40 {
            let (generation, snapshot) = cache.snapshot().await;
            if generation == "generation-current" && snapshot[0].readiness == MediaReadiness::Ready
            {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        let (generation, snapshot) = cache.snapshot().await;
        assert_eq!(generation, "generation-current");
        assert_eq!(snapshot[0].readiness, MediaReadiness::Ready);
    }

    #[tokio::test]
    async fn runtime_reconcile_rejects_interest_object_and_aggregate_byte_limits() {
        let cache = ManagedMediaCache::new(
            tempdir().expect("tempdir").keep(),
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                bytes: Vec::new(),
                content_type: "image/png".to_string(),
            }),
        )
        .expect("cache");
        let bytes = b"\x89PNG\r\n\x1a\nlimit".to_vec();
        let base = descriptor(&bytes, "image/png");
        assert!(cache
            .reconcile_active_catalog("too-many", vec![base.clone(); MAX_MEDIA_OBJECTS + 1])
            .await
            .expect_err("runtime object limit")
            .contains("object limit"));

        let oversized = (0..20)
            .map(|index| MediaDescriptor {
                digest: format!("sha256:{index:064x}"),
                byte_size: MAX_MEDIA_OBJECT_BYTES,
                ..base.clone()
            })
            .collect();
        assert!(cache
            .reconcile_active_catalog("too-large", oversized)
            .await
            .expect_err("aggregate byte budget")
            .contains("byte budget"));
    }

    #[tokio::test]
    async fn reconciliation_reclaims_untracked_disk_bytes_before_adopting_interest() {
        let root = tempdir().expect("tempdir").keep();
        let cache = ManagedMediaCache::new(
            root.clone(),
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                bytes: b"pending".to_vec(),
                content_type: "image/png".to_string(),
            }),
        )
        .expect("cache");
        // Declared interest alone is not a capacity proof: an interrupted
        // generation can leave a large, unreferenced object behind.
        fs::write(
            root.join(format!("{}.bin", "f".repeat(64))),
            vec![0; 96_000_000],
        )
        .expect("orphan object");

        cache
            .reconcile_active_catalog("generation-1", vec![descriptor(b"pending", "image/png")])
            .await
            .expect("reclaim orphan and adopt");

        assert!(!root.join(format!("{}.bin", "f".repeat(64))).exists());
    }
}

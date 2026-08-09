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
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::SystemTime,
};

use async_trait::async_trait;
use sha2::{Digest, Sha256};
use tokio::{
    sync::{Mutex, Notify},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

const MAX_MEDIA_OBJECT_BYTES: u64 = MAX_MEDIA_CACHE_BYTES - MEDIA_CACHE_RESERVED_BYTES;
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

/// Canonical source collection used by catalog generation derivation.  The
/// generation fences source-set adoption, not only bytes: adding a second
/// current source for an existing digest must schedule a fresh warm attempt.
/// The complete sorted candidates retain all identity, reference and facts.
pub fn canonical_media_objects(
    descriptors: Vec<MediaDescriptor>,
) -> Result<Vec<MediaDescriptor>, String> {
    Ok(normalize_interest_set(descriptors)?.candidates)
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

pub(crate) trait MediaVerifier: Send + Sync {
    fn verify(
        &self,
        path: &Path,
        descriptor: &MediaDescriptor,
        content_type: &str,
    ) -> Result<(), String>;
}

struct PlatformMediaVerifier;

impl MediaVerifier for PlatformMediaVerifier {
    fn verify(
        &self,
        path: &Path,
        descriptor: &MediaDescriptor,
        content_type: &str,
    ) -> Result<(), String> {
        verify_staged_file(path, descriptor, content_type)
    }
}

/// The manifest replacement is durable only after the parent directory has
/// been flushed.  Keeping this small boundary injectable lets the cache prove
/// that a post-rename flush failure is never acknowledged as an adoption.
#[async_trait]
pub(crate) trait ManifestDirectorySync: Send + Sync {
    async fn sync(&self, directory: &Path) -> Result<(), String>;

    /// Startup treats only a missing transaction marker as absent.  Keeping
    /// metadata behind the same small filesystem boundary makes permission
    /// and I/O failures testable and prevents them from being mistaken for a
    /// clean cache directory.
    fn transaction_marker_present(&self, marker: &Path) -> Result<bool, String> {
        match fs::metadata(marker) {
            Ok(_) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(format!("inspect manifest transaction marker: {error}")),
        }
    }
}

struct PlatformManifestDirectorySync;

#[async_trait]
impl ManifestDirectorySync for PlatformManifestDirectorySync {
    async fn sync(&self, directory: &Path) -> Result<(), String> {
        crate::platform_fs::sync_directory(directory)
            .await
            .map_err(|error| format!("sync manifest parent directory: {error}"))
    }
}

/// Post-commit maintenance is intentionally observable at one narrow seam:
/// it runs outside catalog acceptance, so a slow directory cleanup can never
/// extend the catalog registration/receipt linearization window.
#[async_trait]
pub(crate) trait MediaMaintenanceObserver: Send + Sync {
    async fn before_cleanup(&self);
}

struct NoopMediaMaintenanceObserver;

#[async_trait]
impl MediaMaintenanceObserver for NoopMediaMaintenanceObserver {
    async fn before_cleanup(&self) {}
}

/// Testable seam for the short, memory-only catalog publication critical
/// section.  Production uses the no-op implementation; the observer exists
/// to prove that a router cannot expose a presentation revision on one side
/// of the adoption token and another revision on the other side.
#[async_trait]
pub(crate) trait CatalogPresentationObserver: Send + Sync {
    async fn after_presentation_write(&self);
}

struct NoopCatalogPresentationObserver;

#[async_trait]
impl CatalogPresentationObserver for NoopCatalogPresentationObserver {
    async fn after_presentation_write(&self) {}
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
    /// Lease reservations are keyed by the publication that granted them.
    /// A same-digest republication must never cause an old response body's
    /// drop to release (or quarantine) the new publication.
    lease_reservations: HashMap<u64, usize>,
    last_used: SystemTime,
    warming_generation: Option<String>,
    /// Changes whenever an adoption republishes this digest.  A slow
    /// defensive read may release its lease afterwards, but it must never
    /// downgrade a newer Ready publication.
    read_version: u64,
    /// A defensive reread found corruption, but a response body from this
    /// publication is still alive.  The last matching lease performs the
    /// version-fenced quarantine under the publication gate.
    pending_quarantine: Option<u64>,
}

#[derive(Debug, Default)]
struct CacheState {
    generation: String,
    entries: HashMap<String, Entry>,
    epoch: u64,
    /// A manifest transaction which cannot be durably rolled back is never a
    /// recoverable cache state.  Keep the cache fail-closed until its owner
    /// has stopped; the on-disk transaction marker carries the same rule over
    /// a restart.
    fatal_error: Option<String>,
}

#[derive(Debug)]
struct ManifestPersistenceError {
    message: String,
    fatal: bool,
}

impl ManifestPersistenceError {
    fn ordinary(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            fatal: false,
        }
    }

    fn fatal(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            fatal: true,
        }
    }
}

#[derive(Default)]
struct OwnedTasks {
    closing: bool,
    handles: Vec<JoinHandle<()>>,
}

impl OwnedTasks {
    fn spawn<F>(&mut self, task: F) -> Result<(), String>
    where
        F: std::future::Future<Output = ()> + Send + 'static,
    {
        self.handles.retain(|handle| !handle.is_finished());
        if self.closing {
            return Err("managed media cache is closing".to_string());
        }
        self.handles.push(tokio::spawn(task));
        Ok(())
    }

    fn close_and_take(&mut self) -> Vec<JoinHandle<()>> {
        self.closing = true;
        std::mem::take(&mut self.handles)
    }
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
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
    verifier: Arc<dyn MediaVerifier>,
    manifest_directory_sync: Arc<dyn ManifestDirectorySync>,
    maintenance_observer: Arc<dyn MediaMaintenanceObserver>,
    catalog_presentation_observer: Arc<dyn CatalogPresentationObserver>,
    state: Arc<Mutex<CacheState>>,
    /// Serializes the complete durable adoption transaction.  It deliberately
    /// does not guard reads or warming: only next-state construction, manifest
    /// persistence, state swap and the reconcile receipt belong together.
    reconcile_gate: Arc<Mutex<()>>,
    /// Registration and final commit share this gate.  A request supersedes a
    /// prior request only after it obtains this gate and advances the token;
    /// once a committer holds it, marker completion, state swap and its
    /// receipt form one linearized acceptance.
    adoption_linearization_gate: Arc<Mutex<()>>,
    queue: Arc<Mutex<VecDeque<WarmJob>>>,
    inflight: Arc<Mutex<HashSet<WarmIdentity>>>,
    staging: Arc<Mutex<HashSet<PathBuf>>>,
    queue_notify: Arc<Notify>,
    /// The current catalog request reserves its sequence before its detached
    /// reconciliation task is spawned.  A task that starts late therefore
    /// cannot redefine "latest" merely by reaching this module later.
    latest_adoption: Arc<AtomicU64>,
    shutdown: CancellationToken,
    tasks: Arc<std::sync::Mutex<OwnedTasks>>,
}

#[derive(Debug, Clone)]
struct WarmJob {
    generation: String,
    descriptor: MediaDescriptor,
    candidates: Vec<MediaDescriptor>,
}

/// Work which may be slow but is never part of a durable catalog acceptance.
/// In particular, the receipt must release `adoption_linearization_gate`
/// before download queueing or reclaiming cache bytes begins.
#[derive(Debug)]
struct PostCommitMaintenance {
    warm: Vec<WarmJob>,
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
        Self::new_with_manifest_directory_sync_and_shutdown(
            root,
            read_url_base,
            fetcher,
            Arc::new(PlatformManifestDirectorySync),
            Arc::new(PlatformMediaVerifier),
            CancellationToken::new(),
        )
    }

    /// Production caches observe their owning daemon cycle.  Tests which
    /// construct an isolated cache may use `new` and explicitly call
    /// `shutdown` when they need to prove task joining.
    pub fn new_with_shutdown(
        root: impl Into<PathBuf>,
        read_url_base: impl Into<String>,
        fetcher: Arc<dyn MediaFetcher>,
        cycle_shutdown: CancellationToken,
    ) -> Result<Self, String> {
        Self::new_with_manifest_directory_sync_and_shutdown(
            root,
            read_url_base,
            fetcher,
            Arc::new(PlatformManifestDirectorySync),
            Arc::new(PlatformMediaVerifier),
            cycle_shutdown,
        )
    }

    #[cfg(test)]
    pub(crate) fn new_with_manifest_directory_sync(
        root: impl Into<PathBuf>,
        read_url_base: impl Into<String>,
        fetcher: Arc<dyn MediaFetcher>,
        manifest_directory_sync: Arc<dyn ManifestDirectorySync>,
    ) -> Result<Self, String> {
        Self::new_with_manifest_directory_sync_and_shutdown(
            root,
            read_url_base,
            fetcher,
            manifest_directory_sync,
            Arc::new(PlatformMediaVerifier),
            CancellationToken::new(),
        )
    }

    #[cfg(test)]
    pub(crate) fn new_with_manifest_directory_sync_and_verifier(
        root: impl Into<PathBuf>,
        read_url_base: impl Into<String>,
        fetcher: Arc<dyn MediaFetcher>,
        manifest_directory_sync: Arc<dyn ManifestDirectorySync>,
        verifier: Arc<dyn MediaVerifier>,
    ) -> Result<Self, String> {
        Self::new_with_manifest_directory_sync_and_shutdown(
            root,
            read_url_base,
            fetcher,
            manifest_directory_sync,
            verifier,
            CancellationToken::new(),
        )
    }

    #[cfg(test)]
    pub(crate) fn new_with_verifier(
        root: impl Into<PathBuf>,
        read_url_base: impl Into<String>,
        fetcher: Arc<dyn MediaFetcher>,
        verifier: Arc<dyn MediaVerifier>,
    ) -> Result<Self, String> {
        Self::new_with_manifest_directory_sync_and_shutdown(
            root,
            read_url_base,
            fetcher,
            Arc::new(PlatformManifestDirectorySync),
            verifier,
            CancellationToken::new(),
        )
    }

    #[cfg(test)]
    pub(crate) fn new_with_maintenance_observer(
        root: impl Into<PathBuf>,
        read_url_base: impl Into<String>,
        fetcher: Arc<dyn MediaFetcher>,
        maintenance_observer: Arc<dyn MediaMaintenanceObserver>,
    ) -> Result<Self, String> {
        Self::new_with_components(
            root,
            read_url_base,
            fetcher,
            Arc::new(PlatformManifestDirectorySync),
            Arc::new(PlatformMediaVerifier),
            maintenance_observer,
            Arc::new(NoopCatalogPresentationObserver),
            CancellationToken::new(),
        )
    }

    #[cfg(test)]
    pub(crate) fn new_with_manifest_directory_sync_and_catalog_presentation_observer(
        root: impl Into<PathBuf>,
        read_url_base: impl Into<String>,
        fetcher: Arc<dyn MediaFetcher>,
        manifest_directory_sync: Arc<dyn ManifestDirectorySync>,
        catalog_presentation_observer: Arc<dyn CatalogPresentationObserver>,
    ) -> Result<Self, String> {
        Self::new_with_components(
            root,
            read_url_base,
            fetcher,
            manifest_directory_sync,
            Arc::new(PlatformMediaVerifier),
            Arc::new(NoopMediaMaintenanceObserver),
            catalog_presentation_observer,
            CancellationToken::new(),
        )
    }

    pub(crate) fn new_with_manifest_directory_sync_and_shutdown(
        root: impl Into<PathBuf>,
        read_url_base: impl Into<String>,
        fetcher: Arc<dyn MediaFetcher>,
        manifest_directory_sync: Arc<dyn ManifestDirectorySync>,
        verifier: Arc<dyn MediaVerifier>,
        cycle_shutdown: CancellationToken,
    ) -> Result<Self, String> {
        Self::new_with_components(
            root,
            read_url_base,
            fetcher,
            manifest_directory_sync,
            verifier,
            Arc::new(NoopMediaMaintenanceObserver),
            Arc::new(NoopCatalogPresentationObserver),
            cycle_shutdown,
        )
    }

    fn new_with_components(
        root: impl Into<PathBuf>,
        read_url_base: impl Into<String>,
        fetcher: Arc<dyn MediaFetcher>,
        manifest_directory_sync: Arc<dyn ManifestDirectorySync>,
        verifier: Arc<dyn MediaVerifier>,
        maintenance_observer: Arc<dyn MediaMaintenanceObserver>,
        catalog_presentation_observer: Arc<dyn CatalogPresentationObserver>,
        cycle_shutdown: CancellationToken,
    ) -> Result<Self, String> {
        let root = root.into();
        fs::create_dir_all(&root).map_err(|error| format!("create media cache: {error}"))?;
        let transaction = root.join(".active-media.transaction");
        let (marker_present, marker_metadata_error) =
            match manifest_directory_sync.transaction_marker_present(&transaction) {
                Ok(present) => (present, None),
                Err(error) => (false, Some(error)),
            };
        let (transaction_left_behind, completed_transaction_error) = if marker_present {
            match fs::read(&transaction) {
                Ok(phase) if phase == b"completed replacement\n" => (false, None),
                Ok(_) => (true, None),
                Err(error) => (
                    true,
                    Some(format!("read manifest transaction marker: {error}")),
                ),
            }
        } else {
            (false, None)
        };
        let persisted = (!transaction_left_behind
            && marker_metadata_error.is_none()
            && completed_transaction_error.is_none())
        .then(|| fs::read(root.join("active-media.json")).ok())
        .flatten()
        .and_then(|bytes| serde_json::from_slice::<ActiveMediaManifest>(&bytes).ok())
        .and_then(|manifest| {
            (!manifest.generation.trim().is_empty())
                .then_some(manifest)
                .and_then(|manifest| {
                    normalize_interest_set(manifest.assets)
                        .ok()
                        .map(|interest| ActiveMediaManifest {
                            generation: manifest.generation,
                            assets: interest.candidates,
                        })
                })
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
        if marker_metadata_error.is_none() {
            if let Ok(entries) = fs::read_dir(&root) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    let name = entry.file_name().to_string_lossy().to_string();
                    let object = name
                        .strip_suffix(".bin")
                        .or_else(|| name.strip_suffix(".json"));
                    if name != "active-media.json"
                        && name != ".active-media.transaction"
                        && !object.is_some_and(|key| allowed.contains(key))
                    {
                        let _ = fs::remove_file(path);
                    }
                }
            }
        }
        let mut initial_state = persisted
            .map(|manifest| {
                let entries = normalize_interest_set(manifest.assets)
                    .ok()
                    .map(|interest| interest.objects)
                    .unwrap_or_default()
                    .into_iter()
                    .map(|object| {
                        let descriptor = object.descriptor;
                        let valid = validate_descriptor(&descriptor).is_none();
                        let content = root.join(format!("{}.bin", object_key(&descriptor.digest)));
                        let ready = valid
                            && fs::metadata(&content)
                                .map(|metadata| metadata.len() == descriptor.byte_size)
                                .unwrap_or(false)
                            && verifier
                                .verify(&content, &descriptor, &descriptor.content_type)
                                .is_ok();
                        if !ready {
                            // A manifest describes immutable bytes.  A corrupt
                            // or expanded active object is neither a pin nor a
                            // recoverable cache asset; discard it so recovery
                            // can warm a bounded replacement.
                            let _ = fs::remove_file(&content);
                        }
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
                                lease_reservations: HashMap::new(),
                                last_used: SystemTime::now(),
                                warming_generation: None,
                                read_version: 1,
                                pending_quarantine: None,
                            },
                        )
                    })
                    .collect();
                CacheState {
                    generation: manifest.generation,
                    entries,
                    epoch: 1,
                    fatal_error: None,
                }
            })
            .unwrap_or_default();
        if let Some(error) = marker_metadata_error.or(completed_transaction_error) {
            initial_state.fatal_error = Some(format!(
                "managed media cache cannot inspect manifest transaction marker; cache is unavailable: {error}"
            ));
        } else if transaction_left_behind {
            initial_state.fatal_error = Some(
                "managed media cache has an incomplete manifest transaction; cache is unavailable"
                    .to_string(),
            );
        }
        let cache = Self {
            root: Arc::new(root),
            read_url_base: Arc::new(std::sync::RwLock::new(
                read_url_base.into().trim_end_matches('/').to_string(),
            )),
            grant: Arc::new(uuid::Uuid::new_v4().to_string()),
            fetcher,
            verifier,
            manifest_directory_sync,
            maintenance_observer,
            catalog_presentation_observer,
            state: Arc::new(Mutex::new(initial_state)),
            reconcile_gate: Arc::new(Mutex::new(())),
            adoption_linearization_gate: Arc::new(Mutex::new(())),
            queue: Arc::new(Mutex::new(VecDeque::new())),
            inflight: Arc::new(Mutex::new(HashSet::new())),
            staging: Arc::new(Mutex::new(HashSet::new())),
            queue_notify: Arc::new(Notify::new()),
            latest_adoption: Arc::new(AtomicU64::new(0)),
            shutdown: cycle_shutdown.child_token(),
            tasks: Arc::new(std::sync::Mutex::new(OwnedTasks::default())),
        };
        for _ in 0..DOWNLOAD_WORKERS {
            let worker = cache.clone();
            cache
                .tasks
                .lock()
                .expect("media task owner")
                .spawn(async move { worker.worker_loop().await })?;
        }
        Ok(cache)
    }

    /// Reserve the ordering point before a caller launches its background
    /// reconcile task.  This is intentionally public because the IPC catalog
    /// handler owns the task and its presentation diagnostic.
    pub async fn register_catalog_adoption(&self) -> u64 {
        let _linearization = self.adoption_linearization_gate.lock().await;
        self.latest_adoption.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Publish a catalog's in-memory presentation and reserve its adoption
    /// token under the same short gate.  The closure is intentionally limited
    /// to presentation-memory work: filesystem reconciliation is detached by
    /// the caller after this method returns.
    pub async fn register_catalog_adoption_with_presentation<T, F, Fut>(
        &self,
        publish: F,
    ) -> (u64, T)
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = T>,
    {
        let _linearization = self.adoption_linearization_gate.lock().await;
        let token = self.latest_adoption.fetch_add(1, Ordering::SeqCst) + 1;
        let presentation = publish().await;
        self.catalog_presentation_observer
            .after_presentation_write()
            .await;
        (token, presentation)
    }

    fn is_latest_adoption(&self, token: u64) -> bool {
        !self.shutdown.is_cancelled() && self.latest_adoption.load(Ordering::SeqCst) == token
    }

    /// Spawn, register and close-fence a cache-owned task under one lock.
    /// This is the only production entry point for detached catalog work.
    pub fn spawn_owned_task<F>(&self, task: F) -> Result<(), String>
    where
        F: std::future::Future<Output = ()> + Send + 'static,
    {
        self.tasks.lock().expect("media task owner").spawn(task)
    }

    pub async fn shutdown(&self) {
        // Close production task registration before signalling cancellation.
        // A late refresh cannot escape this ownership set.
        let tasks = self
            .tasks
            .lock()
            .expect("media task owner")
            .close_and_take();
        self.shutdown.cancel();
        // Do not abort: a persistence operation may already be touching the
        // directory.  The cycle owner must wait for it before a new cache can
        // use this path.
        for task in tasks {
            let _ = task.await;
        }
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
        let token = self.register_catalog_adoption().await;
        let (_, _, commit, maintenance) =
            self.adopt_interest_set(generation, interest, token).await?;
        drop(commit);
        self.schedule_post_commit_maintenance(maintenance)?;
        Ok(())
    }

    async fn adopt_interest_set(
        &self,
        generation: String,
        interest: InterestSet,
        adoption_token: u64,
    ) -> Result<
        (
            usize,
            daemon_ipc_contracts::ManagedMediaSnapshot,
            tokio::sync::MutexGuard<'_, ()>,
            PostCommitMaintenance,
        ),
        String,
    > {
        if !self.is_latest_adoption(adoption_token) {
            return Err("managed media catalog adoption superseded".to_string());
        }
        let gate = self.reconcile_gate.lock().await;
        if !self.is_latest_adoption(adoption_token) {
            return Err("managed media catalog adoption superseded".to_string());
        }
        if let Some(error) = self.state.lock().await.fatal_error.clone() {
            return Err(format!("managed media cache unavailable: {error}"));
        }
        // A digest already known to this cache is immutable across catalog
        // generations.  Reject before any disk/manifest mutation; accepting a
        // changed type, size or canonical managed-media identity would make a
        // held response lease ambiguous.
        {
            let state = self.state.lock().await;
            for object in &interest.objects {
                if let Some(existing) = state
                    .entries
                    .get(&object.descriptor.digest)
                    .filter(|entry| entry.active || entry.leases > 0)
                {
                    if media_identity(&existing.descriptor) != media_identity(&object.descriptor) {
                        return Err(
                            "managed media digest conflicts with known immutable facts".to_string()
                        );
                    }
                }
            }
        }

        // Recovery and regular reconciliation share the same inventory rule:
        // no loose object, metadata, or staging file is allowed to consume the
        // cache budget.  This is deliberately based on actual directory bytes,
        // not on a prior generation's declared descriptor sizes.
        self.remove_untracked_files().await;

        // Full object verification and hashing may take seconds for a large
        // cache.  Build this immutable plan before touching cache state and
        // before the durable transaction, so a committed manifest can be
        // swapped into memory immediately at its linearization point.
        let mut published = HashMap::with_capacity(interest.objects.len());
        for object in &interest.objects {
            published.insert(
                object.descriptor.digest.clone(),
                self.published_and_valid(&object.descriptor).await,
            );
        }

        let manifest = ActiveMediaManifest {
            generation: generation.clone(),
            assets: interest.candidates.clone(),
        };
        if !self.is_latest_adoption(adoption_token) {
            return Err("managed media catalog adoption superseded".to_string());
        }
        let commit = match self.persist_manifest(&manifest, adoption_token).await {
            Ok(commit) => commit,
            Err(error) => {
                if error.fatal {
                    self.enter_fatal(error.message.clone()).await;
                }
                return Err(error.message);
            }
        };
        // `persist_manifest` completed the transaction marker removal only
        // while this request was current.  A later registration is ordered
        // after that durable acceptance and will take this same reconcile
        // gate before replacing the in-memory projection.
        let (warm, accepted_snapshot) = {
            let mut state = self.state.lock().await;
            for entry in state.entries.values_mut() {
                entry.active = false;
                entry.pinned = false;
            }
            for object in &interest.objects {
                let descriptor = &object.descriptor;
                let published = published.get(&descriptor.digest).copied().unwrap_or(false);
                let entry = state
                    .entries
                    .entry(descriptor.digest.clone())
                    .or_insert_with(|| Entry {
                        descriptor: descriptor.clone(),
                        candidates: object.candidates.clone(),
                        readiness: MediaReadiness::Warming,
                        diagnostic: None,
                        pinned: false,
                        active: false,
                        leases: 0,
                        lease_reservations: HashMap::new(),
                        last_used: SystemTime::now(),
                        warming_generation: None,
                        read_version: 0,
                        pending_quarantine: None,
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
                entry.read_version = entry.read_version.wrapping_add(1);
                entry.pending_quarantine = None;
            }
            state.generation = generation.clone();
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
            (warm, snapshot)
        };
        drop(gate);
        Ok((
            interest.objects.len(),
            accepted_snapshot,
            commit,
            PostCommitMaintenance { warm },
        ))
    }

    /// Public reconciliation boundary: generated request in, generated
    /// receipt out.  Conversion to the cache domain is explicit and every
    /// descriptor is validated before the active generation is adopted.
    pub async fn reconcile_boundary(
        &self,
        request: daemon_ipc_contracts::ManagedMediaReconcileRequest,
    ) -> Result<daemon_ipc_contracts::ManagedMediaReconcileReceipt, String> {
        let token = self.register_catalog_adoption().await;
        self.reconcile_boundary_registered(request, token).await
    }

    pub async fn reconcile_boundary_registered(
        &self,
        request: daemon_ipc_contracts::ManagedMediaReconcileRequest,
        adoption_token: u64,
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
        let (interest_count, snapshot, commit, maintenance) = self
            .adopt_interest_set(generation.clone(), interest, adoption_token)
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
        // `commit` is deliberately released directly after final receipt
        // construction.  Queueing a warm job or trimming old bytes is
        // maintenance, not a condition of a visible catalog acceptance.
        drop(commit);
        self.schedule_post_commit_maintenance(maintenance)?;
        Ok(receipt)
    }

    fn schedule_post_commit_maintenance(
        &self,
        maintenance: PostCommitMaintenance,
    ) -> Result<(), String> {
        let cache = self.clone();
        self.spawn_owned_task(async move {
            for job in maintenance.warm {
                cache.enqueue_warm(job).await;
            }
            cache.cleanup_to_low_water().await;
        })
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
        let path = self.content_path(digest);
        let (descriptor, read_version) = {
            let mut state = self.state.lock().await;
            let entry = state
                .entries
                .get_mut(digest)
                .ok_or(MediaReadError::NotFound)?;
            if !entry.active || entry.readiness != MediaReadiness::Ready {
                return Err(MediaReadError::NotReady);
            }
            entry.leases += 1;
            *entry
                .lease_reservations
                .entry(entry.read_version)
                .or_default() += 1;
            entry.last_used = SystemTime::now();
            let descriptor = entry.descriptor.clone();
            let read_version = entry.read_version;
            state.epoch = state.epoch.wrapping_add(1);
            (descriptor, read_version)
        };
        if verify_staged_file_async(
            self.verifier.clone(),
            path.clone(),
            descriptor.clone(),
            descriptor.content_type.clone(),
        )
        .await
        .is_err()
        {
            self.reject_defensive_read(digest, descriptor.clone(), read_version, path)
                .await;
            return Err(MediaReadError::NotReady);
        }
        let identity = media_identity(&descriptor);
        Ok(MediaReadLease {
            content_type: descriptor.content_type,
            byte_size: descriptor.byte_size,
            digest: digest.to_string(),
            path: matches!(method, MediaReadMethod::Get).then_some(path),
            quarantine_path: self.content_path(digest),
            state: self.state.clone(),
            identity,
            read_version,
            reconcile_gate: self.reconcile_gate.clone(),
        })
    }

    /// Treat a failed re-read as corruption only if it still describes the
    /// exact publication which granted this read.  Holding publication/cleanup
    /// coordination while removing the bad inode prevents a concurrent warm
    /// from being deleted, without ever holding the Tokio state mutex over
    /// filesystem work.
    async fn reject_defensive_read(
        &self,
        digest: &str,
        descriptor: MediaDescriptor,
        read_version: u64,
        path: PathBuf,
    ) {
        let _publication_gate = self.reconcile_gate.lock().await;
        let identity = media_identity(&descriptor);
        let quarantine = {
            let mut state = self.state.lock().await;
            let (current_publication, no_matching_leases) = {
                let Some(entry) = state.entries.get_mut(digest) else {
                    return;
                };
                // This read incremented exactly one lease.  Its completion must
                // release that reservation even if the same immutable object was
                // adopted again while the verifier was slow.
                if media_identity(&entry.descriptor) != identity {
                    return;
                }
                entry.leases = entry.leases.saturating_sub(1);
                let reservations = entry.lease_reservations.entry(read_version).or_default();
                *reservations = reservations.saturating_sub(1);
                let no_matching_leases = *reservations == 0;
                if no_matching_leases {
                    entry.lease_reservations.remove(&read_version);
                }
                let current_publication = entry.read_version == read_version;
                if current_publication {
                    entry.readiness = MediaReadiness::Unavailable;
                    entry.diagnostic =
                        Some("published media failed defensive read verification".to_string());
                    entry.pending_quarantine = Some(read_version);
                }
                (current_publication, no_matching_leases)
            };
            state.epoch = state.epoch.wrapping_add(1);
            current_publication && no_matching_leases
        };
        if quarantine {
            let _ = tokio::task::spawn_blocking(move || remove_optional_file(&path)).await;
        }
    }

    pub async fn cleanup_bounded(&self, max_remove: usize) -> usize {
        let _publication_gate = self.reconcile_gate.lock().await;
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
        let mut disk_bytes = directory_usage_bytes_async(self.root.as_ref().clone()).await;
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
                state.epoch = state.epoch.wrapping_add(1);
            }
        }
        removed
    }

    async fn cleanup_to_low_water(&self) {
        let mut observed = false;
        while directory_usage_bytes_async(self.root.as_ref().clone()).await
            > MEDIA_CACHE_LOW_WATER_BYTES
        {
            if !observed {
                self.maintenance_observer.before_cleanup().await;
                observed = true;
            }
            if self.cleanup_bounded(CLEANUP_BATCH_SIZE).await == 0 {
                break;
            }
        }
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
                .map(|(digest, _)| object_key(digest))
                .collect::<HashSet<_>>()
        };
        // Keep stage registration closed until the blocking directory walk has
        // captured it.  Otherwise a newly-created stage could appear between
        // the async snapshot and the worker's `read_dir` call.
        let staging_guard = self.staging.lock().await;
        let staging = staging_guard.clone();
        let root = self.root.as_ref().clone();
        let _ = tokio::task::spawn_blocking(move || {
            let Ok(entries) = fs::read_dir(&root) else {
                return;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();
                if name == "active-media.json" || staging.contains(&path) {
                    continue;
                }
                let keep = name
                    .strip_suffix(".bin")
                    .is_some_and(|key| protected.contains(key));
                if !keep {
                    let _ = fs::remove_file(path);
                }
            }
        })
        .await;
        drop(staging_guard);
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

    async fn persist_manifest(
        &self,
        manifest: &ActiveMediaManifest,
        adoption_token: u64,
    ) -> Result<tokio::sync::MutexGuard<'_, ()>, ManifestPersistenceError> {
        let temp = self.root.join(format!(
            ".active-media.{}.tmp",
            uuid::Uuid::new_v4().simple()
        ));
        write_durable(
            &temp,
            &serde_json::to_vec(manifest).map_err(|error| {
                ManifestPersistenceError::ordinary(format!(
                    "manifest persistence: serialize manifest: {error}"
                ))
            })?,
        )
        .map_err(|error| {
            ManifestPersistenceError::ordinary(format!("manifest persistence: {error}"))
        })?;
        let target = self.root.join("active-media.json");
        // A readable old manifest is a precondition for replacing it.  An I/O
        // error is not equivalent to absence: overwriting it would destroy
        // the only durable accepted generation.
        let previous = match fs::read(&target) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                return Err(ManifestPersistenceError::ordinary(format!(
                    "manifest persistence: read previous accepted manifest: {error}"
                )))
            }
        };
        let transaction = self.root.join(".active-media.transaction");
        write_durable(&transaction, b"pending replacement\n").map_err(|error| {
            ManifestPersistenceError::ordinary(format!(
                "manifest persistence: write transaction marker: {error}"
            ))
        })?;
        self.manifest_directory_sync
            .sync(self.root.as_ref())
            .await
            .map_err(|error| {
                ManifestPersistenceError::ordinary(format!(
                    "manifest persistence: sync transaction marker: {error}"
                ))
            })?;

        if let Err(error) = atomic_replace(&temp, &target) {
            return self
                .rollback_manifest(
                    previous,
                    &target,
                    &transaction,
                    format!("replace manifest: {error}"),
                )
                .await;
        }
        if let Err(error) = self.manifest_directory_sync.sync(self.root.as_ref()).await {
            return self
                .rollback_manifest(
                    previous,
                    &target,
                    &transaction,
                    format!("sync replaced manifest: {error}"),
                )
                .await;
        }
        // A newer catalog may register while this older durable replacement
        // is blocked.  It must win without waiting for this reconciliation's
        // whole persistence path.
        if !self.is_latest_adoption(adoption_token) {
            return self
                .rollback_manifest(
                    previous,
                    &target,
                    &transaction,
                    "catalog adoption superseded after durable manifest replacement".to_string(),
                )
                .await;
        }
        // Registration and the final durable commit share only this short
        // gate.  Re-check after acquiring it so no later catalog can observe
        // a receipt/state projection for a stale manifest.
        let commit = self.adoption_linearization_gate.lock().await;
        if !self.is_latest_adoption(adoption_token) {
            drop(commit);
            return self
                .rollback_manifest(
                    previous,
                    &target,
                    &transaction,
                    "catalog adoption superseded before manifest completion".to_string(),
                )
                .await;
        }
        // Preserve a directory-durable *pending* phase before removing the
        // pending marker.  A failed completion flush can therefore never
        // erase the only evidence needed to fail closed after a failed
        // rollback; successful restart recognizes this completed phase.
        if let Err(error) = write_durable(&transaction, b"completion pending\n") {
            drop(commit);
            return self
                .rollback_manifest(
                    previous,
                    &target,
                    &transaction,
                    format!("write completion-pending transaction marker: {error}"),
                )
                .await;
        }
        if let Err(error) = self.manifest_directory_sync.sync(self.root.as_ref()).await {
            drop(commit);
            return self
                .rollback_manifest(
                    previous,
                    &target,
                    &transaction,
                    format!("sync completion transaction marker: {error}"),
                )
                .await;
        }
        if let Err(error) = write_durable(&transaction, b"completed replacement\n") {
            // The pending phase is already directory durable.  Do not remove
            // it or roll back an accepted replacement if merely recording the
            // completed label fails; startup will fail closed on pending.
            return Err(ManifestPersistenceError::fatal(format!(
                "managed media cache fatal: write completed transaction marker: {error}"
            )));
        }
        // This is post-commit garbage collection.  The completed marker is
        // already durable, so a removal or directory-sync failure cannot turn
        // an accepted manifest into a rejected one.  Startup treats a
        // remaining completed marker as evidence of that accepted state.
        if remove_optional_file(&transaction).is_ok() {
            let _ = self.manifest_directory_sync.sync(self.root.as_ref()).await;
        }
        Ok(commit)
    }

    async fn rollback_manifest<T>(
        &self,
        previous: Option<Vec<u8>>,
        target: &Path,
        transaction: &Path,
        cause: String,
    ) -> Result<T, ManifestPersistenceError> {
        let restore = match previous {
            Some(bytes) => {
                let path = self.root.join(format!(
                    ".active-media.rollback.{}.tmp",
                    uuid::Uuid::new_v4().simple()
                ));
                write_durable(&path, &bytes)
                    .and_then(|_| atomic_replace(&path, target))
                    .map_err(|error| format!("restore previous manifest: {error}"))
            }
            None => fs::remove_file(target)
                .or_else(|error| {
                    (error.kind() == std::io::ErrorKind::NotFound)
                        .then_some(())
                        .ok_or(error)
                })
                .map_err(|error| format!("delete unaccepted manifest: {error}")),
        };
        if let Err(error) = restore {
            return Err(ManifestPersistenceError::fatal(format!(
                "managed media cache fatal: {cause}; rollback failed: {error}"
            )));
        }
        if let Err(error) = self.manifest_directory_sync.sync(self.root.as_ref()).await {
            return Err(ManifestPersistenceError::fatal(format!(
                "managed media cache fatal: {cause}; sync rollback manifest: {error}"
            )));
        }
        if let Err(error) = remove_optional_file(transaction) {
            return Err(ManifestPersistenceError::fatal(format!(
                "managed media cache fatal: {cause}; remove rollback transaction marker: {error}"
            )));
        }
        if let Err(error) = self.manifest_directory_sync.sync(self.root.as_ref()).await {
            return Err(ManifestPersistenceError::fatal(format!(
                "managed media cache fatal: {cause}; sync rollback completion: {error}"
            )));
        }
        Err(ManifestPersistenceError::ordinary(format!(
            "manifest persistence: {cause}"
        )))
    }

    async fn enter_fatal(&self, error: String) {
        let mut state = self.state.lock().await;
        state.fatal_error = Some(error);
        for entry in state.entries.values_mut() {
            entry.active = false;
            entry.pinned = false;
            entry.readiness = MediaReadiness::Unavailable;
        }
        state.epoch = state.epoch.wrapping_add(1);
    }

    fn meta_path(&self, digest: &str) -> PathBuf {
        self.root.join(format!("{}.json", object_key(digest)))
    }

    async fn published_and_valid(&self, descriptor: &MediaDescriptor) -> bool {
        verify_staged_file_async(
            self.verifier.clone(),
            self.content_path(&descriptor.digest),
            descriptor.clone(),
            descriptor.content_type.clone(),
        )
        .await
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
                if self.shutdown.is_cancelled() {
                    return;
                }
                if let Some(job) = self.queue.lock().await.pop_front() {
                    break job;
                }
                tokio::select! {
                    _ = self.shutdown.cancelled() => return,
                    _ = self.queue_notify.notified() => {}
                }
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
        let mut candidates = job.candidates.clone();
        let mut candidate_index = 0;
        while let Some(candidate) = candidates.get(candidate_index) {
            if self.shutdown.is_cancelled() {
                let _ = fs::remove_file(&stage);
                self.staging.lock().await.remove(&stage);
                return;
            }
            candidate_index += 1;
            let fetched = tokio::select! {
                _ = self.shutdown.cancelled() => {
                    let _ = fs::remove_file(&stage);
                    self.staging.lock().await.remove(&stage);
                    return;
                }
                result = self.fetcher.fetch_to(candidate, &stage) => result,
            };
            result = match fetched {
                Ok(response) if response.content_type != candidate.content_type => {
                    Err("media content type does not match descriptor".to_string())
                }
                Ok(response) => {
                    verify_staged_file_async(
                        self.verifier.clone(),
                        stage.clone(),
                        candidate.clone(),
                        response.content_type,
                    )
                    .await
                }
                Err(error) => Err(error),
            };
            match &result {
                Ok(()) => break,
                Err(error) => {
                    failures.push(format!("{}: {error}", candidate.reference));
                    // Refreshes may add a source for the same immutable
                    // object while this fetch is in flight.  Continue from
                    // the latest current candidate set rather than allowing
                    // an obsolete job snapshot to suppress the fallback.
                    if let Some(latest) = self
                        .state
                        .lock()
                        .await
                        .entries
                        .get(&job.descriptor.digest)
                        .filter(|entry| {
                            entry.active
                                && media_identity(&entry.descriptor)
                                    == media_identity(&job.descriptor)
                                && entry.warming_generation.as_deref()
                                    == Some(job.generation.as_str())
                        })
                        .map(|entry| entry.candidates.clone())
                    {
                        for source in latest {
                            if !candidates.contains(&source) {
                                candidates.push(source);
                            }
                        }
                    }
                }
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
                // Reconciliation, publication and cleanup share this short
                // gate.  Once a job has passed its current fence, no newer
                // adoption can publish or reclaim the digest until the same
                // job has atomically replaced the file and marked it ready.
                let _publication_gate = self.reconcile_gate.lock().await;
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
                if directory_usage_bytes_async(self.root.as_ref().clone()).await
                    > MEDIA_CACHE_HIGH_WATER_BYTES
                {
                    let _ = fs::remove_file(&stage);
                    let mut state = self.state.lock().await;
                    if let Some(entry) = state.entries.get_mut(&current.digest) {
                        if entry.warming_generation.as_deref() == Some(job.generation.as_str()) {
                            entry.readiness = MediaReadiness::Unavailable;
                            entry.diagnostic = Some(
                                "managed media cache disk high-water mark exceeded".to_string(),
                            );
                            state.epoch = state.epoch.wrapping_add(1);
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
                        state.epoch = state.epoch.wrapping_add(1);
                    }
                } else {
                    // A stale job owns only its staging path.  In particular
                    // it must never bare-delete a digest-addressed target:
                    // that target may already be the newer publisher's file.
                    let _ = fs::remove_file(&stage);
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
                    state.epoch = state.epoch.wrapping_add(1);
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

async fn directory_usage_bytes_async(root: PathBuf) -> u64 {
    tokio::task::spawn_blocking(move || directory_usage_bytes(&root))
        .await
        .unwrap_or(0)
}

async fn verify_staged_file_async(
    verifier: Arc<dyn MediaVerifier>,
    path: PathBuf,
    descriptor: MediaDescriptor,
    content_type: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || verifier.verify(&path, &descriptor, &content_type))
        .await
        .map_err(|error| format!("managed media verifier task failed: {error}"))?
}

/// A marker is evidence only while present.  Once its deletion has been
/// requested, observing it already absent is the same completed state and
/// must not turn an otherwise durable transaction into a fatal cache.
fn remove_optional_file(path: &Path) -> Result<(), std::io::Error> {
    fs::remove_file(path).or_else(|error| {
        (error.kind() == std::io::ErrorKind::NotFound)
            .then_some(())
            .ok_or(error)
    })
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

pub struct MediaReadLease {
    pub content_type: String,
    pub byte_size: u64,
    pub digest: String,
    path: Option<PathBuf>,
    quarantine_path: PathBuf,
    state: Arc<Mutex<CacheState>>,
    identity: MediaIdentity,
    read_version: u64,
    reconcile_gate: Arc<Mutex<()>>,
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
        let identity = self.identity.clone();
        let read_version = self.read_version;
        let path = self.quarantine_path.clone();
        let reconcile_gate = self.reconcile_gate.clone();
        tokio::spawn(async move {
            let _publication_gate = reconcile_gate.lock().await;
            let mut state = state.lock().await;
            let quarantine = if let Some(entry) = state
                .entries
                .get_mut(&digest)
                .filter(|entry| media_identity(&entry.descriptor) == identity)
            {
                entry.leases = entry.leases.saturating_sub(1);
                let reservations = entry.lease_reservations.entry(read_version).or_default();
                *reservations = reservations.saturating_sub(1);
                let no_matching_leases = *reservations == 0;
                if no_matching_leases {
                    entry.lease_reservations.remove(&read_version);
                }
                let quarantine = entry.read_version == read_version
                    && entry.pending_quarantine == Some(read_version)
                    && no_matching_leases;
                if quarantine {
                    entry.pending_quarantine = None;
                }
                state.epoch = state.epoch.wrapping_add(1);
                quarantine
            } else {
                false
            };
            drop(state);
            if quarantine {
                let _ = tokio::task::spawn_blocking(move || remove_optional_file(&path)).await;
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

pub(crate) fn verify_staged_file(
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
    use std::{
        sync::atomic::{AtomicUsize, Ordering},
        time::Duration,
    };
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
        for _ in 0..400 {
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
        for _ in 0..100 {
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
        assert_eq!(
            cache.snapshot().await.1[0].readiness,
            MediaReadiness::Unavailable,
            "defensive-read corruption must not leave a ready projection"
        );
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
        for _ in 0..400 {
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
    async fn defensive_read_quarantines_an_expanded_active_file_so_same_digest_can_rewarm() {
        let root = tempdir().expect("tempdir").keep();
        let bytes = b"\x89PNG\r\n\x1a\nrepairable".to_vec();
        let expected = descriptor(&bytes, "image/png");
        let cache = ManagedMediaCache::new(
            root,
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                bytes: bytes.clone(),
                content_type: "image/png".to_string(),
            }),
        )
        .expect("cache");
        cache
            .reconcile_active_catalog("first", vec![expected.clone()])
            .await
            .expect("first adoption");
        for _ in 0..400 {
            if cache.snapshot().await.1[0].readiness == MediaReadiness::Ready {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        std::fs::OpenOptions::new()
            .write(true)
            .open(cache.content_path(&expected.digest))
            .expect("published object")
            .set_len(MEDIA_CACHE_HIGH_WATER_BYTES + 1)
            .expect("expand corrupt object");
        assert!(matches!(
            cache
                .read_ready(&cache.read_grant(), MediaReadMethod::Get, &expected.digest)
                .await,
            Err(MediaReadError::NotReady)
        ));
        assert_eq!(
            cache.snapshot().await.1[0].readiness,
            MediaReadiness::Unavailable
        );

        cache
            .reconcile_active_catalog("repair", vec![expected.clone()])
            .await
            .expect("same digest is eligible for repair");
        for _ in 0..400 {
            if cache.snapshot().await.1[0].readiness == MediaReadiness::Ready {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(
            cache.snapshot().await.1[0].readiness,
            MediaReadiness::Ready,
            "the corrupt high-water object must not prevent a same-digest warm"
        );
        assert_eq!(
            fs::metadata(cache.content_path(&expected.digest))
                .expect("rewarmed object")
                .len(),
            bytes.len() as u64
        );
    }

    #[tokio::test]
    async fn stale_defensive_read_failure_cannot_downgrade_a_republished_same_digest() {
        struct OneBlockedFailureVerifier {
            block_next: std::sync::atomic::AtomicBool,
            entered: Arc<Notify>,
            release: Arc<(std::sync::Mutex<bool>, std::sync::Condvar)>,
        }

        impl MediaVerifier for OneBlockedFailureVerifier {
            fn verify(
                &self,
                path: &Path,
                descriptor: &MediaDescriptor,
                content_type: &str,
            ) -> Result<(), String> {
                if self.block_next.swap(false, Ordering::SeqCst) {
                    self.entered.notify_one();
                    let (ready, wake) = self.release.as_ref();
                    let mut released = ready.lock().expect("release mutex");
                    while !*released {
                        released = wake.wait(released).expect("release wait");
                    }
                    return Err("injected stale defensive read failure".to_string());
                }
                verify_staged_file(path, descriptor, content_type)
            }
        }

        let root = tempdir().expect("tempdir").keep();
        let bytes = b"\x89PNG\r\n\x1a\nversion-fence".to_vec();
        let expected = descriptor(&bytes, "image/png");
        let entered = Arc::new(Notify::new());
        let release = Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
        let verifier = Arc::new(OneBlockedFailureVerifier {
            block_next: std::sync::atomic::AtomicBool::new(false),
            entered: entered.clone(),
            release: release.clone(),
        });
        let cache = ManagedMediaCache::new_with_verifier(
            root,
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                bytes,
                content_type: "image/png".to_string(),
            }),
            verifier.clone(),
        )
        .expect("cache");
        cache
            .reconcile_active_catalog("first", vec![expected.clone()])
            .await
            .expect("first adoption");
        for _ in 0..400 {
            if cache.snapshot().await.1[0].readiness == MediaReadiness::Ready {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        verifier.block_next.store(true, Ordering::SeqCst);
        let old_read = tokio::spawn({
            let cache = cache.clone();
            let digest = expected.digest.clone();
            async move {
                cache
                    .read_ready(&cache.read_grant(), MediaReadMethod::Get, &digest)
                    .await
            }
        });
        tokio::time::timeout(Duration::from_secs(1), entered.notified())
            .await
            .expect("old defensive read entered verifier");
        cache
            .reconcile_active_catalog("republished", vec![expected.clone()])
            .await
            .expect("same digest republished while old read is slow");
        assert_eq!(cache.snapshot().await.1[0].readiness, MediaReadiness::Ready);
        let (ready, wake) = release.as_ref();
        *ready.lock().expect("release mutex") = true;
        wake.notify_all();
        assert!(matches!(
            old_read.await.expect("old reader joined"),
            Err(MediaReadError::NotReady)
        ));
        assert_eq!(
            cache.snapshot().await.1[0].readiness,
            MediaReadiness::Ready,
            "an old verifier result must be fenced from the replacement publication"
        );
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
        for _ in 0..400 {
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
    async fn startup_discards_an_expanded_active_object_before_reconcile_checks_high_water() {
        let root = tempdir().expect("tempdir").keep();
        let bytes = b"\x89PNG\r\n\x1a\nsmall-active".to_vec();
        let active = descriptor(&bytes, "image/png");
        fs::write(
            root.join("active-media.json"),
            serde_json::to_vec(&ActiveMediaManifest {
                generation: "active".to_string(),
                assets: vec![active.clone()],
            })
            .expect("manifest"),
        )
        .expect("manifest seed");
        fs::File::create(root.join(format!("{}.bin", object_key(&active.digest))))
            .expect("expanded active object")
            .set_len(MEDIA_CACHE_HIGH_WATER_BYTES + 1)
            .expect("expand active object");

        let replacement_bytes = b"\x89PNG\r\n\x1a\nreplacement".to_vec();
        let replacement = descriptor(&replacement_bytes, "image/png");
        let cache = ManagedMediaCache::new(
            root.clone(),
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                bytes: replacement_bytes,
                content_type: "image/png".to_string(),
            }),
        )
        .expect("recovery cache");
        assert!(
            !root
                .join(format!("{}.bin", object_key(&active.digest)))
                .exists(),
            "an expanded active object is not retained as an immutable pin"
        );
        cache
            .reconcile_active_catalog("replacement", vec![replacement])
            .await
            .expect("reconcile does not inherit a permanent high-water failure");
    }

    #[tokio::test]
    async fn startup_rejects_an_over_aggregate_manifest_before_pinning_its_files() {
        let root = tempdir().expect("tempdir").keep();
        let bytes = b"\x89PNG\r\n\x1a\nmanifest".to_vec();
        let base = descriptor(&bytes, "image/png");
        let mut assets = Vec::new();
        for index in 0..=MAX_MEDIA_OBJECTS {
            let mut asset = base.clone();
            asset.id = format!("550e8400-e29b-41d4-a716-{index:012x}");
            asset.reference = format!("/api/media-assets/{}/content", asset.id);
            assets.push(asset);
        }
        fs::write(
            root.join("active-media.json"),
            serde_json::to_vec(&ActiveMediaManifest {
                generation: "oversized".to_string(),
                assets,
            })
            .expect("manifest"),
        )
        .expect("seed manifest");
        fs::write(
            root.join(format!("{}.bin", object_key(&base.digest))),
            bytes,
        )
        .expect("seed loose object");
        let cache = ManagedMediaCache::new(
            root.clone(),
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                bytes: Vec::new(),
                content_type: "image/png".to_string(),
            }),
        )
        .expect("cache");
        assert!(cache.snapshot().await.0.is_empty());
        assert!(
            !root
                .join(format!("{}.bin", object_key(&base.digest)))
                .exists(),
            "an invalid aggregate manifest cannot pin a disk object"
        );
    }

    #[tokio::test]
    async fn replacement_cleanup_repeats_from_high_water_to_low_water_without_removing_leases() {
        struct NeverFetcher;
        #[async_trait]
        impl MediaFetcher for NeverFetcher {
            async fn fetch_to(
                &self,
                _: &MediaDescriptor,
                _: &Path,
            ) -> Result<MediaFetchResult, String> {
                std::future::pending().await
            }
        }
        let root = tempdir().expect("tempdir").keep();
        let cache = ManagedMediaCache::new(
            root.clone(),
            "http://127.0.0.1:1234",
            Arc::new(NeverFetcher),
        )
        .expect("cache");
        let mut descriptors = Vec::new();
        for index in 0..19u8 {
            let mut bytes = vec![0; 5_000_000];
            bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
            bytes[8] = index;
            let mut descriptor = descriptor(&bytes, "image/png");
            descriptor.id = format!("550e8400-e29b-41d4-a716-{index:012x}");
            descriptor.reference = format!("/api/media-assets/{}/content", descriptor.id);
            descriptors.push(descriptor);
        }
        cache
            .reconcile_active_catalog("old", descriptors.clone())
            .await
            .expect("old generation");
        for (index, descriptor) in descriptors.iter().enumerate() {
            let mut bytes = vec![0; 5_000_000];
            bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
            bytes[8] = index as u8;
            fs::write(
                root.join(format!("{}.bin", object_key(&descriptor.digest))),
                bytes,
            )
            .expect("seed active object");
            if index > 0 {
                fs::OpenOptions::new()
                    .write(true)
                    .open(root.join(format!("{}.bin", object_key(&descriptor.digest))))
                    .expect("expanded inactive object")
                    .set_len(5_300_000)
                    .expect("expand inactive object");
            }
            cache
                .state
                .lock()
                .await
                .entries
                .get_mut(&descriptor.digest)
                .expect("active entry")
                .readiness = MediaReadiness::Ready;
        }
        let lease = cache
            .read_ready(
                &cache.read_grant(),
                MediaReadMethod::Head,
                &descriptors[0].digest,
            )
            .await
            .expect("active lease");
        cache
            .reconcile_active_catalog("empty", vec![])
            .await
            .expect("replacement permits cleanup from high water");
        for _ in 0..400 {
            if directory_usage_bytes(&root) <= MEDIA_CACHE_LOW_WATER_BYTES {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(
            directory_usage_bytes(&root) <= MEDIA_CACHE_LOW_WATER_BYTES,
            "post-commit scheduled cleanup repeats until low water"
        );
        assert!(
            cache.content_path(&descriptors[0].digest).exists(),
            "a stream lease is never removed during bounded cleanup"
        );
        drop(lease);
        for _ in 0..100 {
            if cache.cleanup_bounded(CLEANUP_BATCH_SIZE).await > 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("released lease was not eligible for later cleanup");
    }

    #[tokio::test]
    async fn verified_ninety_five_mb_warm_does_not_block_cache_snapshot() {
        struct BlockingVerifier {
            entered: Arc<Notify>,
            released: Arc<(std::sync::Mutex<bool>, std::sync::Condvar)>,
        }
        impl MediaVerifier for BlockingVerifier {
            fn verify(
                &self,
                path: &Path,
                descriptor: &MediaDescriptor,
                content_type: &str,
            ) -> Result<(), String> {
                if !path.exists() {
                    return verify_staged_file(path, descriptor, content_type);
                }
                self.entered.notify_one();
                let (ready, wake) = self.released.as_ref();
                let mut released = ready.lock().expect("release mutex");
                while !*released {
                    released = wake.wait(released).expect("release wait");
                }
                verify_staged_file(path, descriptor, content_type)
            }
        }
        let mut bytes = vec![
            0;
            (MAX_MEDIA_CACHE_BYTES - MEDIA_CACHE_RESERVED_BYTES)
                .try_into()
                .expect("95 MB fits usize")
        ];
        bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        let descriptor = descriptor(&bytes, "image/png");
        let entered = Arc::new(Notify::new());
        let released = Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
        let cache = ManagedMediaCache::new_with_manifest_directory_sync_and_verifier(
            tempdir().expect("tempdir").keep(),
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                bytes,
                content_type: "image/png".to_string(),
            }),
            Arc::new(PlatformManifestDirectorySync),
            Arc::new(BlockingVerifier {
                entered: entered.clone(),
                released: released.clone(),
            }),
        )
        .expect("cache");
        cache
            .reconcile_active_catalog("large", vec![descriptor])
            .await
            .expect("large warm is tracked");
        tokio::time::timeout(Duration::from_secs(5), entered.notified())
            .await
            .expect("verifier entered on its blocking worker");
        tokio::time::timeout(Duration::from_millis(100), cache.snapshot())
            .await
            .expect("cache snapshot stays responsive while verifier is blocked");
        {
            let (ready, wake) = released.as_ref();
            *ready.lock().expect("release mutex") = true;
            wake.notify_all();
        }
    }

    #[tokio::test]
    async fn reconciliation_returns_while_proactive_fetch_is_still_pending() {
        struct PendingFetcher {
            started: Arc<Notify>,
        }
        #[async_trait]
        impl MediaFetcher for PendingFetcher {
            async fn fetch_to(
                &self,
                _: &MediaDescriptor,
                _: &Path,
            ) -> Result<MediaFetchResult, String> {
                self.started.notify_one();
                std::future::pending::<Result<MediaFetchResult, String>>().await
            }
        }
        let started = Arc::new(Notify::new());
        let cache = ManagedMediaCache::new(
            tempdir().expect("tempdir").keep(),
            "http://127.0.0.1:1234",
            Arc::new(PendingFetcher {
                started: started.clone(),
            }),
        )
        .expect("cache");
        let descriptor = descriptor(b"pending", "image/png");
        // The fetch stays pending forever; the wide timeout is only a test
        // deadlock guard, while Notify proves the actual worker boundary.
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            cache.reconcile_active_catalog("generation-1", vec![descriptor]),
        )
        .await
        .expect("reconciliation must not await source fetch")
        .expect("adopt");
        tokio::time::timeout(std::time::Duration::from_secs(1), started.notified())
            .await
            .expect("proactive fetch started after reconcile returned");
        cache.shutdown().await;
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
        for _ in 0..400 {
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
    async fn post_rename_manifest_directory_sync_failure_is_not_adopted_or_receipted() {
        struct FailingAfterRename;
        #[async_trait]
        impl ManifestDirectorySync for FailingAfterRename {
            async fn sync(&self, _: &Path) -> Result<(), String> {
                Err("injected post-rename directory sync failure".to_string())
            }
        }
        let root = tempdir().expect("tempdir").keep();
        let cache = ManagedMediaCache::new_with_manifest_directory_sync(
            root.clone(),
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                bytes: b"\x89PNG\r\n\x1a\nmanifest".to_vec(),
                content_type: "image/png".to_string(),
            }),
            Arc::new(FailingAfterRename),
        )
        .expect("cache");
        let request = serde_json::from_value(serde_json::json!({
            "generation": "generation-not-durable",
            "interests": [descriptor(b"\x89PNG\r\n\x1a\nmanifest", "image/png")],
        }))
        .expect("request");

        assert!(cache.reconcile_boundary(request).await.is_err());
        assert!(cache.snapshot().await.0.is_empty(), "memory did not swap");
        assert!(cache.snapshot().await.1.is_empty());
        assert!(
            !root.join("active-media.json").exists(),
            "unreceipted first manifest was rolled back after rename"
        );
    }

    #[tokio::test]
    async fn adoption_retries_its_swap_when_a_read_lease_arrives_during_manifest_persistence() {
        struct SecondSyncBarrier {
            calls: AtomicUsize,
            persisted: Arc<Notify>,
            release: Arc<Notify>,
        }
        #[async_trait]
        impl ManifestDirectorySync for SecondSyncBarrier {
            async fn sync(&self, _: &Path) -> Result<(), String> {
                // The first transaction has marker/replace/complete syncs.
                // Hold the second transaction after its replacement.
                if self.calls.fetch_add(1, Ordering::SeqCst) == 4 {
                    self.persisted.notify_one();
                    self.release.notified().await;
                }
                Ok(())
            }
        }
        let bytes = b"\x89PNG\r\n\x1a\nlease-merge".to_vec();
        let descriptor = descriptor(&bytes, "image/png");
        let persisted = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let cache = ManagedMediaCache::new_with_manifest_directory_sync(
            tempdir().expect("tempdir").keep(),
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                bytes,
                content_type: "image/png".to_string(),
            }),
            Arc::new(SecondSyncBarrier {
                calls: AtomicUsize::new(0),
                persisted: persisted.clone(),
                release: release.clone(),
            }),
        )
        .expect("cache");
        cache
            .reconcile_active_catalog("generation-1", vec![descriptor.clone()])
            .await
            .expect("first adoption");
        for _ in 0..40 {
            if cache.snapshot().await.1[0].readiness == MediaReadiness::Ready {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let adoption = {
            let cache = cache.clone();
            let descriptor = descriptor.clone();
            tokio::spawn(async move {
                cache
                    .reconcile_active_catalog("generation-2", vec![descriptor])
                    .await
            })
        };
        tokio::time::timeout(Duration::from_secs(1), persisted.notified())
            .await
            .expect("second manifest persistence reached barrier");
        let lease = cache
            .read_ready(
                &cache.read_grant(),
                MediaReadMethod::Get,
                &descriptor.digest,
            )
            .await
            .expect("lease while manifest is persisting");
        release.notify_waiters();
        adoption.await.expect("join").expect("second adoption");
        assert_eq!(
            cache
                .state
                .lock()
                .await
                .entries
                .get(&descriptor.digest)
                .expect("entry")
                .leases,
            1,
            "the old clone did not erase the concurrent lease"
        );
        drop(lease);
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
        let receipts = [a_receipt, b_receipt]
            .into_iter()
            .filter_map(Result::ok)
            .collect::<Vec<_>>();
        let (generation, snapshot) = cache.snapshot().await;
        let manifest: ActiveMediaManifest =
            serde_json::from_slice(&fs::read(root.join("active-media.json")).expect("manifest"))
                .expect("manifest shape");
        let receipt = receipts
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
    async fn latest_registered_catalog_wins_when_an_older_background_task_runs_after_it() {
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
        let a = descriptor(b"\x89PNG\r\n\x1a\nregistered-a", "image/png");
        let b = descriptor(b"\x89PNG\r\n\x1a\nregistered-b", "image/png");
        let request = |generation: &str, descriptor: MediaDescriptor| {
            serde_json::from_value(serde_json::json!({
                "generation": generation,
                "interests": [descriptor],
            }))
            .expect("generated request")
        };

        // A is registered first but deliberately not allowed to execute until
        // B has fully adopted.  This models a delayed HTTP background task.
        let a_token = cache.register_catalog_adoption().await;
        let b_token = cache.register_catalog_adoption().await;
        cache
            .reconcile_boundary_registered(request("generation-b", b.clone()), b_token)
            .await
            .expect("B adoption");
        assert!(cache
            .reconcile_boundary_registered(request("generation-a", a), a_token)
            .await
            .expect_err("late A must be superseded")
            .contains("superseded"));

        let (generation, projection) = cache.snapshot().await;
        let manifest: ActiveMediaManifest =
            serde_json::from_slice(&fs::read(root.join("active-media.json")).expect("manifest"))
                .expect("manifest shape");
        assert_eq!(generation, "generation-b");
        assert_eq!(manifest.generation, "generation-b");
        assert_eq!(projection.len(), 1);
        assert_eq!(projection[0].descriptor.digest, b.digest);
    }

    #[tokio::test]
    async fn post_rename_manifest_failure_restores_previous_accepted_generation_for_restart() {
        struct FailSecondDirectorySync(AtomicUsize);
        #[async_trait]
        impl ManifestDirectorySync for FailSecondDirectorySync {
            async fn sync(&self, _: &Path) -> Result<(), String> {
                // A successful transaction synchronizes pending, replacement,
                // completed phase and marker GC.  Fail the second transaction
                // only after its replacement.
                if self.0.fetch_add(1, Ordering::SeqCst) == 5 {
                    Err("injected post-rename directory sync failure".to_string())
                } else {
                    Ok(())
                }
            }
        }
        let root = tempdir().expect("tempdir").keep();
        let old = descriptor(b"\x89PNG\r\n\x1a\naccepted-old", "image/png");
        let new = descriptor(b"\x89PNG\r\n\x1a\nrejected-new", "image/png");
        let cache = ManagedMediaCache::new_with_manifest_directory_sync(
            root.clone(),
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                bytes: Vec::new(),
                content_type: "image/png".to_string(),
            }),
            Arc::new(FailSecondDirectorySync(AtomicUsize::new(0))),
        )
        .expect("cache");
        cache
            .reconcile_active_catalog("accepted", vec![old.clone()])
            .await
            .expect("first manifest is accepted");
        assert!(cache
            .reconcile_active_catalog("unreceipted", vec![new])
            .await
            .expect_err("post-rename failure")
            .contains("manifest persistence"));

        let restarted = ManagedMediaCache::new(
            root,
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                bytes: Vec::new(),
                content_type: "image/png".to_string(),
            }),
        )
        .expect("reconstruct cache");
        let (generation, projection) = restarted.snapshot().await;
        assert_eq!(generation, "accepted");
        assert_eq!(projection.len(), 1);
        assert_eq!(projection[0].descriptor.digest, old.digest);
    }

    #[tokio::test]
    async fn newer_registration_supersedes_a_persisting_catalog_without_waiting_for_it() {
        struct PersistBarrier {
            calls: AtomicUsize,
            persisted: Arc<Notify>,
            release: Arc<Notify>,
        }
        #[async_trait]
        impl ManifestDirectorySync for PersistBarrier {
            async fn sync(&self, _: &Path) -> Result<(), String> {
                // The initial transaction has marker/replace/complete syncs;
                // hold A at its durable replacement boundary.
                if self.calls.fetch_add(1, Ordering::SeqCst) == 4 {
                    self.persisted.notify_one();
                    self.release.notified().await;
                }
                Ok(())
            }
        }

        let root = tempdir().expect("tempdir").keep();
        let accepted = descriptor(b"\x89PNG\r\n\x1a\naccepted-c", "image/png");
        let stale = descriptor(b"\x89PNG\r\n\x1a\nstale-a", "image/png");
        let mut rejected_b = stale.clone();
        rejected_b.byte_size = MAX_MEDIA_OBJECT_BYTES + 1;
        let persisted = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let cache = ManagedMediaCache::new_with_manifest_directory_sync(
            root.clone(),
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                bytes: Vec::new(),
                content_type: "image/png".to_string(),
            }),
            Arc::new(PersistBarrier {
                calls: AtomicUsize::new(0),
                persisted: persisted.clone(),
                release: release.clone(),
            }),
        )
        .expect("cache");
        cache
            .reconcile_active_catalog("accepted-c", vec![accepted.clone()])
            .await
            .expect("C accepted");

        let a_token = cache.register_catalog_adoption().await;
        let a_cache = cache.clone();
        let a_task = tokio::spawn(async move {
            a_cache
                .reconcile_boundary_registered(
                    serde_json::from_value(serde_json::json!({
                        "generation": "stale-a",
                        "interests": [stale],
                    }))
                    .expect("A request"),
                    a_token,
                )
                .await
        });
        tokio::time::timeout(Duration::from_secs(1), persisted.notified())
            .await
            .expect("A persisted");
        let mut b_registration = tokio::spawn({
            let cache = cache.clone();
            async move { cache.register_catalog_adoption().await }
        });
        let b_token = tokio::time::timeout(Duration::from_secs(1), &mut b_registration)
            .await
            .expect("B registration must not wait for A persistence")
            .expect("B registration");
        release.notify_waiters();
        assert!(
            a_task.await.expect("A task").is_err(),
            "A becomes stale after B registers"
        );
        assert!(
            cache
                .reconcile_boundary_registered(
                    serde_json::from_value(serde_json::json!({
                        "generation": "rejected-b",
                        "interests": [rejected_b],
                    }))
                    .expect("B request"),
                    b_token,
                )
                .await
                .is_err(),
            "B rejection cannot replace C"
        );

        let manifest: ActiveMediaManifest = serde_json::from_slice(
            &fs::read(root.join("active-media.json")).expect("durable manifest"),
        )
        .expect("manifest");
        assert_eq!(manifest.generation, "accepted-c");
        assert_eq!(cache.snapshot().await.0, "accepted-c");

        let restarted = ManagedMediaCache::new(
            root,
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                bytes: Vec::new(),
                content_type: "image/png".to_string(),
            }),
        )
        .expect("restart");
        assert_eq!(restarted.snapshot().await.0, "accepted-c");
    }

    #[tokio::test]
    async fn newer_registered_catalog_commits_after_a_stale_persist_rolls_back() {
        struct PersistBarrier {
            calls: AtomicUsize,
            entered: Arc<Notify>,
            release: Arc<Notify>,
        }
        #[async_trait]
        impl ManifestDirectorySync for PersistBarrier {
            async fn sync(&self, _: &Path) -> Result<(), String> {
                if self.calls.fetch_add(1, Ordering::SeqCst) == 1 {
                    self.entered.notify_one();
                    self.release.notified().await;
                }
                Ok(())
            }
        }
        let root = tempdir().expect("tempdir").keep();
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let cache = ManagedMediaCache::new_with_manifest_directory_sync(
            root.clone(),
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                bytes: Vec::new(),
                content_type: "image/png".to_string(),
            }),
            Arc::new(PersistBarrier {
                calls: AtomicUsize::new(0),
                entered: entered.clone(),
                release: release.clone(),
            }),
        )
        .expect("cache");
        let a = descriptor(b"\x89PNG\r\n\x1a\nstale-a", "image/png");
        let b = descriptor(b"\x89PNG\r\n\x1a\ncurrent-b", "image/png");
        let request = |generation: &str, descriptor: MediaDescriptor| {
            serde_json::from_value(serde_json::json!({
                "generation": generation,
                "interests": [descriptor],
            }))
            .expect("request")
        };
        let a_token = cache.register_catalog_adoption().await;
        let a_task = tokio::spawn({
            let cache = cache.clone();
            let request = request("a", a);
            async move { cache.reconcile_boundary_registered(request, a_token).await }
        });
        tokio::time::timeout(Duration::from_secs(1), entered.notified())
            .await
            .expect("A replacement persistence blocked");
        let b_token =
            tokio::time::timeout(Duration::from_secs(1), cache.register_catalog_adoption())
                .await
                .expect("B registration is not held by A persistence");
        release.notify_waiters();
        assert!(a_task.await.expect("A join").is_err());
        let receipt = cache
            .reconcile_boundary_registered(request("b", b.clone()), b_token)
            .await
            .expect("B receipt");
        let manifest: ActiveMediaManifest =
            serde_json::from_slice(&fs::read(root.join("active-media.json")).expect("manifest"))
                .expect("manifest shape");
        assert_eq!(manifest.generation, "b");
        assert_eq!(cache.snapshot().await.0, "b");
        assert_eq!(receipt.generation.as_str(), "b");
        assert_eq!(
            receipt.snapshot.assets[0].descriptor.digest.as_str(),
            b.digest
        );
        let restarted = ManagedMediaCache::new(
            root,
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                bytes: Vec::new(),
                content_type: "image/png".to_string(),
            }),
        )
        .expect("restart");
        assert_eq!(restarted.snapshot().await.0, "b");
    }

    #[tokio::test]
    async fn rollback_sync_failure_fails_closed_and_a_restart_does_not_claim_recovery() {
        struct FailReplaceAndRollbackSync(AtomicUsize);
        #[async_trait]
        impl ManifestDirectorySync for FailReplaceAndRollbackSync {
            async fn sync(&self, _: &Path) -> Result<(), String> {
                // C completes pending/replace/completed/GC with 0..3.  Fail
                // A's replacement flush and its mandatory rollback flush.
                match self.0.fetch_add(1, Ordering::SeqCst) {
                    5 | 6 => Err("injected directory sync failure".to_string()),
                    _ => Ok(()),
                }
            }
        }

        let root = tempdir().expect("tempdir").keep();
        let accepted = descriptor(b"\x89PNG\r\n\x1a\naccepted-c", "image/png");
        let rejected = descriptor(b"\x89PNG\r\n\x1a\nrejected-a", "image/png");
        let cache = ManagedMediaCache::new_with_manifest_directory_sync(
            root.clone(),
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                bytes: Vec::new(),
                content_type: "image/png".to_string(),
            }),
            Arc::new(FailReplaceAndRollbackSync(AtomicUsize::new(0))),
        )
        .expect("cache");
        cache
            .reconcile_active_catalog("accepted-c", vec![accepted])
            .await
            .expect("C accepted");
        assert!(cache
            .reconcile_active_catalog("rejected-a", vec![rejected.clone()])
            .await
            .expect_err("failed rollback is fatal")
            .contains("fatal"));
        assert!(
            cache.snapshot().await.1.is_empty(),
            "fatal cache is unavailable"
        );
        assert!(cache
            .reconcile_active_catalog("later", vec![rejected])
            .await
            .expect_err("fatal cache rejects new writes")
            .contains("unavailable"));
        assert!(root.join(".active-media.transaction").exists());

        let restarted = ManagedMediaCache::new(
            root,
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                bytes: Vec::new(),
                content_type: "image/png".to_string(),
            }),
        )
        .expect("restart constructor stays conservative");
        assert!(restarted.snapshot().await.0.is_empty());
        assert!(restarted.snapshot().await.1.is_empty());
    }

    #[tokio::test]
    async fn completion_and_rollback_sync_failures_retain_a_fatal_pending_marker() {
        struct FailCompletionAndRollback(AtomicUsize);
        #[async_trait]
        impl ManifestDirectorySync for FailCompletionAndRollback {
            async fn sync(&self, _: &Path) -> Result<(), String> {
                // The first accepted generation consumes pending, replacement,
                // completed and GC syncs 0..3.  The next generation fails its
                // completion-pending sync (6) and rollback sync (7).
                match self.0.fetch_add(1, Ordering::SeqCst) {
                    6 | 7 => Err("injected completion/rollback sync failure".to_string()),
                    _ => Ok(()),
                }
            }
        }
        let root = tempdir().expect("tempdir").keep();
        let accepted = descriptor(b"\x89PNG\r\n\x1a\naccepted", "image/png");
        let rejected = descriptor(b"\x89PNG\r\n\x1a\nrejected", "image/png");
        let cache = ManagedMediaCache::new_with_manifest_directory_sync(
            root.clone(),
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                bytes: Vec::new(),
                content_type: "image/png".to_string(),
            }),
            Arc::new(FailCompletionAndRollback(AtomicUsize::new(0))),
        )
        .expect("cache");
        cache
            .reconcile_active_catalog("accepted", vec![accepted])
            .await
            .expect("accepted generation");
        assert!(cache
            .reconcile_active_catalog("rejected", vec![rejected])
            .await
            .expect_err("double sync failure is fatal")
            .contains("fatal"));
        assert!(root.join(".active-media.transaction").exists());
        assert_ne!(
            fs::read_to_string(root.join(".active-media.transaction")).expect("marker"),
            "completed replacement\n"
        );

        let restarted = ManagedMediaCache::new(
            root,
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                bytes: Vec::new(),
                content_type: "image/png".to_string(),
            }),
        )
        .expect("restart cache");
        assert!(restarted.snapshot().await.0.is_empty());
        assert!(restarted.snapshot().await.1.is_empty());
    }

    #[tokio::test]
    async fn unreadable_previous_manifest_is_never_overwritten_as_if_absent() {
        let root = tempdir().expect("tempdir").keep();
        fs::create_dir(root.join("active-media.json")).expect("unreadable manifest stand-in");
        let cache = ManagedMediaCache::new(
            root.clone(),
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                bytes: Vec::new(),
                content_type: "image/png".to_string(),
            }),
        )
        .expect("cache");
        assert!(cache
            .reconcile_active_catalog(
                "cannot-overwrite",
                vec![descriptor(b"\x89PNG\r\n\x1a\nnew", "image/png")],
            )
            .await
            .expect_err("manifest read error rejects replacement")
            .contains("read previous accepted manifest"));
        assert!(root.join("active-media.json").is_dir());
        assert!(!root.join(".active-media.transaction").exists());
    }

    #[tokio::test]
    async fn completion_marker_already_removed_is_an_idempotent_accepted_commit() {
        struct RemoveMarkerBeforeCompletionSync(AtomicUsize);
        #[async_trait]
        impl ManifestDirectorySync for RemoveMarkerBeforeCompletionSync {
            async fn sync(&self, directory: &Path) -> Result<(), String> {
                // The second flush follows the manifest replacement, before
                // the completion marker is removed.  Model a concurrent
                // recovery/cleanup which has already made that deletion.
                if self.0.fetch_add(1, Ordering::SeqCst) == 1 {
                    fs::remove_file(directory.join(".active-media.transaction"))
                        .map_err(|error| error.to_string())?;
                }
                Ok(())
            }
        }

        let root = tempdir().expect("tempdir").keep();
        let expected = descriptor(b"\x89PNG\r\n\x1a\ncompletion-idempotent", "image/png");
        let cache = ManagedMediaCache::new_with_manifest_directory_sync(
            root.clone(),
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                bytes: Vec::new(),
                content_type: "image/png".to_string(),
            }),
            Arc::new(RemoveMarkerBeforeCompletionSync(AtomicUsize::new(0))),
        )
        .expect("cache");

        cache
            .reconcile_active_catalog("accepted", vec![expected.clone()])
            .await
            .expect("an already absent completion marker is successful");
        assert_eq!(cache.snapshot().await.0, "accepted");
        assert!(!root.join(".active-media.transaction").exists());
    }

    #[tokio::test]
    async fn completion_sync_failure_rolls_back_without_marking_the_cache_fatal() {
        struct FailCompletionSync(AtomicUsize);
        #[async_trait]
        impl ManifestDirectorySync for FailCompletionSync {
            async fn sync(&self, _: &Path) -> Result<(), String> {
                // marker, replacement, completion, then rollback and its
                // completion.  Only the unaccepted completion flush fails.
                if self.0.fetch_add(1, Ordering::SeqCst) == 2 {
                    Err("injected completion sync failure".to_string())
                } else {
                    Ok(())
                }
            }
        }
        let root = tempdir().expect("tempdir").keep();
        let cache = ManagedMediaCache::new_with_manifest_directory_sync(
            root.clone(),
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                bytes: Vec::new(),
                content_type: "image/png".to_string(),
            }),
            Arc::new(FailCompletionSync(AtomicUsize::new(0))),
        )
        .expect("cache");
        assert!(cache
            .reconcile_active_catalog(
                "unaccepted",
                vec![descriptor(b"\x89PNG\r\n\x1a\nunaccepted", "image/png")],
            )
            .await
            .expect_err("completion sync cannot be receipted")
            .contains("completion"));
        assert!(cache.snapshot().await.0.is_empty());
        assert!(!root.join("active-media.json").exists());
        assert!(!root.join(".active-media.transaction").exists());
        cache
            .reconcile_active_catalog(
                "later",
                vec![descriptor(b"\x89PNG\r\n\x1a\nlater", "image/png")],
            )
            .await
            .expect("safe rollback leaves cache usable");
    }

    #[tokio::test]
    async fn startup_marker_metadata_error_fails_closed_without_recovering_manifest() {
        struct MarkerMetadataError;
        #[async_trait]
        impl ManifestDirectorySync for MarkerMetadataError {
            async fn sync(&self, _: &Path) -> Result<(), String> {
                Ok(())
            }

            fn transaction_marker_present(&self, _: &Path) -> Result<bool, String> {
                Err("injected marker metadata denial".to_string())
            }
        }

        let root = tempdir().expect("tempdir").keep();
        let accepted = descriptor(b"\x89PNG\r\n\x1a\naccepted", "image/png");
        fs::write(
            root.join("active-media.json"),
            serde_json::to_vec(&ActiveMediaManifest {
                generation: "accepted".to_string(),
                assets: vec![accepted],
            })
            .expect("manifest"),
        )
        .expect("seed manifest");

        let cache = ManagedMediaCache::new_with_manifest_directory_sync(
            root.clone(),
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                bytes: Vec::new(),
                content_type: "image/png".to_string(),
            }),
            Arc::new(MarkerMetadataError),
        )
        .expect("fail-closed cache still starts for diagnostics");
        assert!(cache.snapshot().await.0.is_empty());
        assert!(cache
            .reconcile_active_catalog(
                "must-not-recover",
                vec![descriptor(b"\x89PNG\r\n\x1a\nnew", "image/png")],
            )
            .await
            .expect_err("metadata failure freezes cache")
            .contains("unavailable"));
        assert!(root.join("active-media.json").exists());
    }

    #[tokio::test]
    async fn shutdown_closes_owned_task_registration_before_cancellation_and_reaps_finished_tasks()
    {
        let cache = ManagedMediaCache::new(
            tempdir().expect("tempdir").keep(),
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                bytes: Vec::new(),
                content_type: "image/png".to_string(),
            }),
        )
        .expect("cache");
        let (finished_tx, finished_rx) = tokio::sync::oneshot::channel();
        let task_cache = cache.clone();
        let task_shutdown = cache.shutdown.clone();
        cache
            .spawn_owned_task(async move {
                task_shutdown.cancelled().await;
                let rejected = task_cache.spawn_owned_task(async {}).is_err();
                let _ = finished_tx.send(rejected);
            })
            .expect("initial task registered");
        let shutdown = tokio::spawn({
            let cache = cache.clone();
            async move { cache.shutdown().await }
        });
        assert!(finished_rx.await.expect("late task checked"));
        shutdown.await.expect("shutdown joined");

        // A long-running daemon must not retain every completed refresh.
        let reopened = ManagedMediaCache::new(
            tempdir().expect("tempdir").keep(),
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                bytes: Vec::new(),
                content_type: "image/png".to_string(),
            }),
        )
        .expect("cache");
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        reopened
            .spawn_owned_task(async move {
                let _ = done_tx.send(());
            })
            .expect("finished task registered");
        done_rx.await.expect("finished task");
        reopened
            .spawn_owned_task(async {})
            .expect("next registration reaps finished handle");
        assert_eq!(
            reopened.tasks.lock().expect("owner").handles.len(),
            DOWNLOAD_WORKERS + 1,
            "only workers and the most recent detached task remain tracked"
        );
        reopened.shutdown().await;
    }

    #[tokio::test]
    async fn shutdown_joins_a_tracked_reconcile_blocked_in_manifest_sync_before_reusing_directory()
    {
        struct ManifestSyncBarrier {
            entered: Arc<Notify>,
            release: Arc<Notify>,
            calls: AtomicUsize,
        }
        #[async_trait]
        impl ManifestDirectorySync for ManifestSyncBarrier {
            async fn sync(&self, _: &Path) -> Result<(), String> {
                if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
                    self.entered.notify_one();
                    self.release.notified().await;
                }
                Ok(())
            }
        }

        let root = tempdir().expect("tempdir").keep();
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let cache = ManagedMediaCache::new_with_manifest_directory_sync(
            root.clone(),
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                bytes: Vec::new(),
                content_type: "image/png".to_string(),
            }),
            Arc::new(ManifestSyncBarrier {
                entered: entered.clone(),
                release: release.clone(),
                calls: AtomicUsize::new(0),
            }),
        )
        .expect("cache");
        let token = cache.register_catalog_adoption().await;
        let worker = cache.clone();
        worker
            .clone()
            .spawn_owned_task(async move {
                let _ = worker
                    .reconcile_boundary_registered(
                        serde_json::from_value(serde_json::json!({
                            "generation": "blocked",
                            "interests": [descriptor(b"\x89PNG\r\n\x1a\nblocked", "image/png")],
                        }))
                        .expect("request"),
                        token,
                    )
                    .await;
            })
            .expect("tracked reconcile");
        tokio::time::timeout(Duration::from_secs(1), entered.notified())
            .await
            .expect("manifest sync is blocked");

        let mut shutdown = tokio::spawn({
            let cache = cache.clone();
            async move { cache.shutdown().await }
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(30), &mut shutdown)
                .await
                .is_err(),
            "shutdown must retain the tracked persistence task until its sync returns"
        );
        release.notify_waiters();
        shutdown
            .await
            .expect("shutdown joins after manifest sync release");

        let next = ManagedMediaCache::new(
            root.clone(),
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                bytes: Vec::new(),
                content_type: "image/png".to_string(),
            }),
        )
        .expect("new cycle cache");
        let token = next.register_catalog_adoption().await;
        next.reconcile_boundary_registered(
            serde_json::from_value(serde_json::json!({
                "generation": "new-cycle",
                "interests": [descriptor(b"\x89PNG\r\n\x1a\nnew-cycle", "image/png")],
            }))
            .expect("request"),
            token,
        )
        .await
        .expect("new cycle reconcile");
        assert_eq!(next.snapshot().await.0, "new-cycle");
    }

    #[tokio::test]
    async fn lease_drop_is_not_lost_by_a_following_catalog_swap() {
        let bytes = b"\x89PNG\r\n\x1a\nlease-drop".to_vec();
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
            .reconcile_active_catalog("one", vec![descriptor.clone()])
            .await
            .expect("one");
        for _ in 0..40 {
            if cache.snapshot().await.1[0].readiness == MediaReadiness::Ready {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let lease = cache
            .read_ready(
                &cache.read_grant(),
                MediaReadMethod::Head,
                &descriptor.digest,
            )
            .await
            .expect("lease");
        drop(lease);
        for _ in 0..40 {
            if cache.state.lock().await.entries[&descriptor.digest].leases == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        cache
            .reconcile_active_catalog("two", vec![descriptor.clone()])
            .await
            .expect("two");
        assert_eq!(
            cache.state.lock().await.entries[&descriptor.digest].leases,
            0
        );
    }

    #[tokio::test]
    async fn cycle_shutdown_joins_workers_even_when_a_fetch_is_hung() {
        struct HungFetcher {
            started: Arc<Notify>,
        }
        #[async_trait]
        impl MediaFetcher for HungFetcher {
            async fn fetch_to(
                &self,
                _: &MediaDescriptor,
                _: &Path,
            ) -> Result<MediaFetchResult, String> {
                self.started.notify_one();
                std::future::pending::<Result<MediaFetchResult, String>>().await
            }
        }
        let started = Arc::new(Notify::new());
        let cycle = CancellationToken::new();
        let cache = ManagedMediaCache::new_with_shutdown(
            tempdir().expect("tempdir").keep(),
            "http://127.0.0.1:1234",
            Arc::new(HungFetcher {
                started: started.clone(),
            }),
            cycle.clone(),
        )
        .expect("cache");
        cache
            .reconcile_active_catalog(
                "hung",
                vec![descriptor(b"\x89PNG\r\n\x1a\nhung", "image/png")],
            )
            .await
            .expect("adopt");
        tokio::time::timeout(Duration::from_secs(1), started.notified())
            .await
            .expect("fetch started");
        cycle.cancel();
        tokio::time::timeout(Duration::from_secs(1), cache.shutdown())
            .await
            .expect("workers joined");
    }

    #[tokio::test]
    async fn reconfigured_cycle_joins_old_media_work_before_new_cache_uses_the_directory() {
        struct StagedAndHungFetcher {
            bytes: Vec<u8>,
            staged: Arc<Notify>,
        }
        #[async_trait]
        impl MediaFetcher for StagedAndHungFetcher {
            async fn fetch_to(
                &self,
                _: &MediaDescriptor,
                staging: &Path,
            ) -> Result<MediaFetchResult, String> {
                write_durable(staging, &self.bytes)?;
                self.staged.notify_one();
                std::future::pending::<Result<MediaFetchResult, String>>().await
            }
        }

        let root = tempdir().expect("tempdir").keep();
        let old_bytes = b"\x89PNG\r\n\x1a\nold-cycle".to_vec();
        let old = descriptor(&old_bytes, "image/png");
        let staged = Arc::new(Notify::new());
        let old_cycle = CancellationToken::new();
        let old_cache = ManagedMediaCache::new_with_shutdown(
            root.clone(),
            "http://127.0.0.1:1234",
            Arc::new(StagedAndHungFetcher {
                bytes: old_bytes,
                staged: staged.clone(),
            }),
            old_cycle.clone(),
        )
        .expect("old cache");
        old_cache
            .reconcile_active_catalog("old-cycle", vec![old.clone()])
            .await
            .expect("old adoption");
        tokio::time::timeout(Duration::from_secs(1), staged.notified())
            .await
            .expect("old fetch staged");
        old_cycle.cancel();
        old_cache.shutdown().await;

        let new_bytes = b"\x89PNG\r\n\x1a\nnew-cycle".to_vec();
        let new = descriptor(&new_bytes, "image/png");
        let new_cache = ManagedMediaCache::new_with_shutdown(
            root.clone(),
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                bytes: new_bytes,
                content_type: "image/png".to_string(),
            }),
            CancellationToken::new(),
        )
        .expect("new cache");
        new_cache
            .reconcile_active_catalog("new-cycle", vec![new.clone()])
            .await
            .expect("new adoption");
        for _ in 0..40 {
            let (generation, projection) = new_cache.snapshot().await;
            if generation == "new-cycle" && projection[0].readiness == MediaReadiness::Ready {
                let manifest: ActiveMediaManifest = serde_json::from_slice(
                    &fs::read(root.join("active-media.json")).expect("manifest"),
                )
                .expect("manifest shape");
                assert_eq!(manifest.generation, "new-cycle");
                assert_eq!(projection[0].descriptor.digest, new.digest);
                assert!(!new_cache.content_path(&old.digest).exists());
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("old cycle work crossed into the new cache");
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
    async fn adding_a_same_digest_source_mints_a_new_adoption_and_warms_it() {
        struct AThenBFetcher {
            bytes: Vec<u8>,
            a_started: Arc<Notify>,
            release_a: Arc<Notify>,
            a_attempts: Arc<AtomicUsize>,
            b_attempts: Arc<AtomicUsize>,
        }
        #[async_trait]
        impl MediaFetcher for AThenBFetcher {
            async fn fetch_to(
                &self,
                descriptor: &MediaDescriptor,
                staging: &Path,
            ) -> Result<MediaFetchResult, String> {
                if descriptor.id.ends_with("124") {
                    if self.a_attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                        self.a_started.notify_one();
                        self.release_a.notified().await;
                    }
                    return Err("A is unavailable".to_string());
                }
                self.b_attempts.fetch_add(1, Ordering::SeqCst);
                write_durable(staging, &self.bytes)?;
                Ok(MediaFetchResult {
                    content_type: "image/png".to_string(),
                })
            }
        }

        let bytes = b"\x89PNG\r\n\x1a\nsource-set".to_vec();
        let a = descriptor(&bytes, "image/png");
        let mut b = a.clone();
        b.id = "550e8400-e29b-41d4-a716-446655440125".to_string();
        b.reference = "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content".to_string();
        let a_generation = format!(
            "sha256:{:x}",
            Sha256::digest(
                serde_json::to_vec(&canonical_media_objects(vec![a.clone()]).unwrap()).unwrap()
            )
        );
        let ab_generation = format!(
            "sha256:{:x}",
            Sha256::digest(
                serde_json::to_vec(&canonical_media_objects(vec![a.clone(), b.clone()]).unwrap())
                    .unwrap()
            )
        );
        assert_ne!(a_generation, ab_generation, "candidate set fences adoption");

        let a_started = Arc::new(Notify::new());
        let release_a = Arc::new(Notify::new());
        let a_attempts = Arc::new(AtomicUsize::new(0));
        let b_attempts = Arc::new(AtomicUsize::new(0));
        let cache = ManagedMediaCache::new(
            tempdir().expect("tempdir").keep(),
            "http://127.0.0.1:1234",
            Arc::new(AThenBFetcher {
                bytes,
                a_started: a_started.clone(),
                release_a: release_a.clone(),
                a_attempts,
                b_attempts: b_attempts.clone(),
            }),
        )
        .expect("cache");
        cache
            .reconcile_active_catalog(a_generation, vec![a.clone()])
            .await
            .expect("A adoption");
        tokio::time::timeout(Duration::from_secs(1), a_started.notified())
            .await
            .expect("A fetch started");
        cache
            .reconcile_active_catalog(ab_generation.clone(), vec![a, b.clone()])
            .await
            .expect("B adoption");
        release_a.notify_waiters();
        for _ in 0..40 {
            let (generation, snapshot) = cache.snapshot().await;
            if generation == ab_generation && snapshot[0].readiness == MediaReadiness::Ready {
                assert!(b_attempts.load(Ordering::SeqCst) > 0, "B was attempted");
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("new candidate did not become ready");
    }

    #[tokio::test]
    async fn stale_publisher_cannot_remove_a_new_same_digest_publication() {
        struct RacingFetcher {
            bytes: Vec<u8>,
            a_staged: Arc<Notify>,
            release_a: Arc<Notify>,
            b_attempted: Arc<Notify>,
        }
        #[async_trait]
        impl MediaFetcher for RacingFetcher {
            async fn fetch_to(
                &self,
                descriptor: &MediaDescriptor,
                staging: &Path,
            ) -> Result<MediaFetchResult, String> {
                write_durable(staging, &self.bytes)?;
                if descriptor.id.ends_with("124") {
                    self.a_staged.notify_one();
                    self.release_a.notified().await;
                } else {
                    self.b_attempted.notify_one();
                }
                Ok(MediaFetchResult {
                    content_type: "image/png".to_string(),
                })
            }
        }
        let root = tempdir().expect("tempdir").keep();
        let bytes = b"\x89PNG\r\n\x1a\npublish-race".to_vec();
        let a = descriptor(&bytes, "image/png");
        let mut b = a.clone();
        b.id = "550e8400-e29b-41d4-a716-446655440125".to_string();
        b.reference = "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content".to_string();
        let a_staged = Arc::new(Notify::new());
        let release_a = Arc::new(Notify::new());
        let b_attempted = Arc::new(Notify::new());
        let cache = ManagedMediaCache::new(
            root.clone(),
            "http://127.0.0.1:1234",
            Arc::new(RacingFetcher {
                bytes: bytes.clone(),
                a_staged: a_staged.clone(),
                release_a: release_a.clone(),
                b_attempted: b_attempted.clone(),
            }),
        )
        .expect("cache");
        cache
            .reconcile_active_catalog("generation-a", vec![a])
            .await
            .expect("A adoption");
        tokio::time::timeout(Duration::from_secs(1), a_staged.notified())
            .await
            .expect("A staged");
        cache
            .reconcile_active_catalog("generation-b", vec![b.clone()])
            .await
            .expect("B adoption");
        tokio::time::timeout(Duration::from_secs(1), b_attempted.notified())
            .await
            .expect("B attempted");
        release_a.notify_waiters();
        for _ in 0..40 {
            let (generation, snapshot) = cache.snapshot().await;
            if generation == "generation-b" && snapshot[0].readiness == MediaReadiness::Ready {
                assert_eq!(
                    fs::read(cache.content_path(&b.digest)).expect("B file"),
                    bytes
                );
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("B publication was removed by stale A");
    }

    #[tokio::test]
    async fn removed_generation_stale_job_leaves_no_published_or_staging_orphan() {
        struct BlockedFetcher {
            bytes: Vec<u8>,
            staged: Arc<Notify>,
            release: Arc<Notify>,
        }
        #[async_trait]
        impl MediaFetcher for BlockedFetcher {
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
        let bytes = b"\x89PNG\r\n\x1a\nremoved-generation".to_vec();
        let descriptor = descriptor(&bytes, "image/png");
        let staged = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let cache = ManagedMediaCache::new(
            root.clone(),
            "http://127.0.0.1:1234",
            Arc::new(BlockedFetcher {
                bytes,
                staged: staged.clone(),
                release: release.clone(),
            }),
        )
        .expect("cache");
        cache
            .reconcile_active_catalog("generation-old", vec![descriptor.clone()])
            .await
            .expect("old adoption");
        tokio::time::timeout(Duration::from_secs(1), staged.notified())
            .await
            .expect("old staging");
        cache
            .reconcile_active_catalog("generation-empty", vec![])
            .await
            .expect("remove old generation");
        release.notify_waiters();
        for _ in 0..40 {
            if !root
                .join(format!("{}.bin", object_key(&descriptor.digest)))
                .exists()
                && fs::read_dir(&root)
                    .expect("cache root")
                    .flatten()
                    .all(|entry| !entry.file_name().to_string_lossy().ends_with(".tmp"))
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("stale job left an orphan");
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

    #[tokio::test]
    async fn pending_quarantine_waits_for_the_last_body_lease_then_allows_same_digest_repair() {
        let root = tempdir().expect("tempdir").keep();
        let bytes = b"\x89PNG\r\n\x1a\npending-quarantine".to_vec();
        let descriptor = descriptor(&bytes, "image/png");
        let cache = ManagedMediaCache::new(
            root.clone(),
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                bytes: bytes.clone(),
                content_type: "image/png".to_string(),
            }),
        )
        .expect("cache");
        cache
            .reconcile_active_catalog("one", vec![descriptor.clone()])
            .await
            .expect("one");
        for _ in 0..80 {
            if cache.snapshot().await.1[0].readiness == MediaReadiness::Ready {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let body_lease = cache
            .read_ready(
                &cache.read_grant(),
                MediaReadMethod::Head,
                &descriptor.digest,
            )
            .await
            .expect("body lease");
        std::fs::OpenOptions::new()
            .write(true)
            .open(cache.content_path(&descriptor.digest))
            .expect("object")
            .set_len(MEDIA_CACHE_HIGH_WATER_BYTES + 1)
            .expect("expand");
        assert!(matches!(
            cache
                .read_ready(
                    &cache.read_grant(),
                    MediaReadMethod::Head,
                    &descriptor.digest
                )
                .await,
            Err(MediaReadError::NotReady)
        ));
        assert!(
            cache.content_path(&descriptor.digest).exists(),
            "body lease keeps corrupt publication until drop"
        );
        drop(body_lease);
        for _ in 0..80 {
            if !cache.content_path(&descriptor.digest).exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(
            !cache.content_path(&descriptor.digest).exists(),
            "last matching lease quarantines pending corrupt publication"
        );
        cache
            .reconcile_active_catalog("repair", vec![descriptor.clone()])
            .await
            .expect("repair");
        for _ in 0..80 {
            if cache.snapshot().await.1[0].readiness == MediaReadiness::Ready {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("same digest did not rewarm after pending quarantine");
    }

    #[tokio::test]
    async fn known_digest_rejects_changed_facts_without_consuming_its_lease_but_allows_same_facts()
    {
        let bytes = b"\x89PNG\r\n\x1a\nimmutable-facts".to_vec();
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
            .reconcile_active_catalog("one", vec![descriptor.clone()])
            .await
            .expect("one");
        for _ in 0..80 {
            if cache.snapshot().await.1[0].readiness == MediaReadiness::Ready {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let lease = cache
            .read_ready(
                &cache.read_grant(),
                MediaReadMethod::Head,
                &descriptor.digest,
            )
            .await
            .expect("lease");
        let mut conflict = descriptor.clone();
        conflict.byte_size += 1;
        assert!(
            cache
                .reconcile_active_catalog("conflict", vec![conflict])
                .await
                .is_err(),
            "known digest facts must be rejected before adoption"
        );
        assert_eq!(
            cache.state.lock().await.entries[&descriptor.digest].leases,
            1
        );
        cache
            .reconcile_active_catalog("same-facts", vec![descriptor.clone()])
            .await
            .expect("same immutable facts may cross generations");
        drop(lease);
        for _ in 0..80 {
            if cache.state.lock().await.entries[&descriptor.digest].leases == 0 {
                cache
                    .reconcile_active_catalog("empty", vec![])
                    .await
                    .expect("remove active interest");
                for _ in 0..80 {
                    if cache.cleanup_bounded(1).await == 1 {
                        return;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                panic!("released old publication was not cleanup eligible");
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("old publication lease did not release its own reservation");
    }
}

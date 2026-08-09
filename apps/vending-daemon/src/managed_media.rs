//! Deep module for the machine-owned managed media cache.
//!
//! The cache deliberately exposes only catalog reconciliation, a readiness
//! projection, and a grant-bound read lease.  Downloading, pinning and cleanup
//! are implementation details of the module rather than IPC commands.

use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
    time::SystemTime,
};

use async_trait::async_trait;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

const MAX_MEDIA_OBJECT_BYTES: u64 = 5_000_000;
const MAX_MEDIA_OBJECTS: usize = 256;
const CLEANUP_BATCH_SIZE: usize = 32;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedMediaDescriptor {
    pub id: String,
    pub reference: String,
    pub digest: String,
    pub content_type: String,
    pub byte_size: u64,
    pub purpose: String,
    pub revision: ManagedMediaRevision,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedMediaRevision {
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
pub struct ManagedMediaProjection {
    pub descriptor: ManagedMediaDescriptor,
    pub readiness: MediaReadiness,
    pub ready_url: Option<String>,
    pub diagnostic: Option<String>,
}

#[derive(Debug, Clone)]
pub struct MediaBytes {
    pub bytes: Vec<u8>,
    pub content_type: String,
}

#[async_trait]
pub trait MediaFetcher: Send + Sync {
    async fn fetch(&self, descriptor: &ManagedMediaDescriptor) -> Result<MediaBytes, String>;
}

pub struct BackendMediaFetcher {
    pub backend: Arc<crate::backend::BackendClient>,
}

#[async_trait]
impl MediaFetcher for BackendMediaFetcher {
    async fn fetch(&self, descriptor: &ManagedMediaDescriptor) -> Result<MediaBytes, String> {
        self.backend
            .fetch_managed_media(&descriptor.reference, descriptor.byte_size)
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

#[derive(Debug)]
struct Entry {
    descriptor: ManagedMediaDescriptor,
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
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActiveMediaManifest {
    generation: String,
    assets: Vec<ManagedMediaDescriptor>,
}

#[derive(Clone)]
pub struct ManagedMediaCache {
    root: Arc<PathBuf>,
    read_url_base: Arc<std::sync::RwLock<String>>,
    grant: Arc<String>,
    fetcher: Arc<dyn MediaFetcher>,
    state: Arc<Mutex<CacheState>>,
}

impl ManagedMediaCache {
    pub fn new(
        root: impl Into<PathBuf>,
        read_url_base: impl Into<String>,
        fetcher: Arc<dyn MediaFetcher>,
    ) -> Result<Self, String> {
        let root = root.into();
        fs::create_dir_all(&root).map_err(|error| format!("create media cache: {error}"))?;
        // Staging names are deliberately distinct from object names and are
        // never part of a manifest.  An interrupted download is therefore
        // safely reclaimable during recovery.
        if let Ok(entries) = fs::read_dir(&root) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                if name.to_string_lossy().starts_with('.') {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
        let initial_state = fs::read(root.join("active-media.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<ActiveMediaManifest>(&bytes).ok())
            .map(|manifest| {
                let entries = manifest
                    .assets
                    .into_iter()
                    .map(|descriptor| {
                        let valid = validate_descriptor(&descriptor).is_none();
                        let ready = valid
                            && match fs::read(
                                root.join(format!("{}.bin", object_key(&descriptor.digest))),
                            ) {
                                Ok(bytes) => {
                                    bytes.len() as u64 == descriptor.byte_size
                                        && digest_of(&bytes) == descriptor.digest
                                }
                                Err(_) => false,
                            };
                        (
                            descriptor.digest.clone(),
                            Entry {
                                descriptor,
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
                }
            })
            .unwrap_or_default();
        Ok(Self {
            root: Arc::new(root),
            read_url_base: Arc::new(std::sync::RwLock::new(
                read_url_base.into().trim_end_matches('/').to_string(),
            )),
            grant: Arc::new(uuid::Uuid::new_v4().to_string()),
            fetcher,
            state: Arc::new(Mutex::new(initial_state)),
        })
    }

    /// Atomically adopts the complete active interest set and warms it out of band.
    pub async fn reconcile_active_catalog(
        &self,
        generation: impl Into<String>,
        descriptors: Vec<ManagedMediaDescriptor>,
    ) {
        let generation = generation.into();
        let mut state = self.state.lock().await;
        let mut entries = state
            .entries
            .drain()
            .map(|(digest, mut entry)| {
                entry.active = false;
                entry.pinned = false;
                (digest, entry)
            })
            .collect::<HashMap<_, _>>();
        for descriptor in descriptors.into_iter().take(MAX_MEDIA_OBJECTS) {
            let digest = descriptor.digest.clone();
            let validation = validate_descriptor(&descriptor);
            let published = validation.is_none() && self.published_and_valid(&descriptor);
            if let Some(mut entry) = entries.remove(&digest) {
                // Reconciliation of an unchanged digest must not discard a
                // live HTTP read lease.  The descriptor fence still updates so
                // late output cannot turn a replacement ready.
                entry.descriptor = descriptor;
                entry.pinned = true;
                entry.active = true;
                entry.diagnostic = validation;
                entry.readiness = if entry.diagnostic.is_some() {
                    MediaReadiness::Unavailable
                } else if published {
                    MediaReadiness::Ready
                } else {
                    MediaReadiness::Warming
                };
                entries.insert(digest, entry);
            } else {
                entries.insert(
                    digest,
                    Entry {
                        descriptor,
                        readiness: if validation.is_some() {
                            MediaReadiness::Unavailable
                        } else if published {
                            MediaReadiness::Ready
                        } else {
                            MediaReadiness::Warming
                        },
                        diagnostic: validation,
                        pinned: true,
                        active: true,
                        leases: 0,
                        last_used: SystemTime::now(),
                        warming_generation: None,
                    },
                );
            }
        }
        state.generation = generation.clone();
        state.entries = entries;
        let manifest = ActiveMediaManifest {
            generation: generation.clone(),
            assets: state
                .entries
                .values()
                .filter(|entry| entry.active)
                .map(|entry| entry.descriptor.clone())
                .collect(),
        };
        if let Err(error) = self.persist_manifest(&manifest) {
            // Do not warm or expose an in-memory generation which cannot
            // survive restart.  Serving the previous on-disk manifest here
            // would substitute stale bytes for the newly adopted descriptor.
            for entry in state.entries.values_mut().filter(|entry| entry.active) {
                entry.readiness = MediaReadiness::Unavailable;
                entry.diagnostic =
                    Some(format!("media cache manifest persistence failed: {error}"));
            }
            return;
        }
        let warm = state
            .entries
            .values_mut()
            .filter(|entry| entry.readiness == MediaReadiness::Warming)
            .filter_map(|entry| {
                if entry.warming_generation.as_deref() == Some(&generation) {
                    None
                } else {
                    entry.warming_generation = Some(generation.clone());
                    Some(entry.descriptor.clone())
                }
            })
            .collect::<Vec<_>>();
        drop(state);
        for descriptor in warm {
            let cache = self.clone();
            let expected_generation = generation.clone();
            tokio::spawn(async move {
                cache.warm(expected_generation, descriptor).await;
            });
        }
        let _ = self.cleanup_bounded(CLEANUP_BATCH_SIZE).await;
    }

    pub async fn snapshot(&self) -> (String, Vec<ManagedMediaProjection>) {
        let state = self.state.lock().await;
        let projections = state
            .entries
            .values()
            .filter(|entry| entry.active)
            .map(|entry| self.projection(entry))
            .collect();
        (state.generation.clone(), projections)
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
        let bytes = fs::read(&path).map_err(|error| {
            // Lease cleanup is best effort; the caller still receives a read failure.
            let state = self.state.clone();
            let digest = digest.to_string();
            tokio::spawn(async move {
                if let Some(entry) = state.lock().await.entries.get_mut(&digest) {
                    entry.leases = entry.leases.saturating_sub(1);
                }
            });
            MediaReadError::Io(error.to_string())
        })?;
        let entry = self.state.lock().await;
        let descriptor = entry
            .entries
            .get(digest)
            .map(|entry| entry.descriptor.clone());
        drop(entry);
        let descriptor = descriptor.ok_or(MediaReadError::NotFound)?;
        if bytes.len() as u64 != descriptor.byte_size || digest_of(&bytes) != descriptor.digest {
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
            bytes: if matches!(method, MediaReadMethod::Head) {
                Vec::new()
            } else {
                bytes
            },
            content_type: descriptor.content_type,
            byte_size: descriptor.byte_size,
            digest: digest.to_string(),
            state: self.state.clone(),
        })
    }

    pub async fn cleanup_bounded(&self, max_remove: usize) -> usize {
        let mut state = self.state.lock().await;
        let mut candidates = state
            .entries
            .iter()
            .filter(|(_, entry)| !entry.pinned && entry.leases == 0)
            .map(|(digest, entry)| (digest.clone(), entry.last_used))
            .collect::<Vec<_>>();
        candidates.sort_by_key(|(_, used)| *used);
        let mut removed = 0;
        for (digest, _) in candidates.into_iter().take(max_remove) {
            let _ = fs::remove_file(self.content_path(&digest));
            let _ = fs::remove_file(self.meta_path(&digest));
            if state.entries.remove(&digest).is_some() {
                removed += 1;
            }
        }
        removed
    }

    fn projection(&self, entry: &Entry) -> ManagedMediaProjection {
        let base = self
            .read_url_base
            .read()
            .map(|value| value.clone())
            .unwrap_or_default();
        ManagedMediaProjection {
            descriptor: entry.descriptor.clone(),
            readiness: entry.readiness,
            ready_url: (entry.readiness == MediaReadiness::Ready).then(|| {
                format!(
                    "{}/media/{}?grant={}",
                    base, entry.descriptor.digest, self.grant
                )
            }),
            diagnostic: entry.diagnostic.clone(),
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
        )?;
        let target = self.root.join("active-media.json");
        atomic_replace(&temp, &target)?;
        sync_parent_dir(&self.root);
        Ok(())
    }

    fn meta_path(&self, digest: &str) -> PathBuf {
        self.root.join(format!("{}.json", object_key(digest)))
    }

    fn published_and_valid(&self, descriptor: &ManagedMediaDescriptor) -> bool {
        let path = self.content_path(&descriptor.digest);
        let Ok(bytes) = fs::read(path) else {
            return false;
        };
        bytes.len() as u64 == descriptor.byte_size && digest_of(&bytes) == descriptor.digest
    }

    async fn warm(&self, generation: String, descriptor: ManagedMediaDescriptor) {
        let result = self.fetcher.fetch(&descriptor).await.and_then(|media| {
            if media.bytes.len() as u64 != descriptor.byte_size {
                return Err("media byte size does not match descriptor".to_string());
            }
            if media.content_type != descriptor.content_type {
                return Err("media content type does not match descriptor".to_string());
            }
            verify_media_facts(&descriptor.content_type, &media.bytes)?;
            if digest_of(&media.bytes) != descriptor.digest {
                return Err("media digest does not match descriptor".to_string());
            }
            self.publish(&descriptor, &media.bytes)
        });
        let mut state = self.state.lock().await;
        if state.generation != generation {
            return;
        }
        let Some(entry) = state.entries.get_mut(&descriptor.digest) else {
            return;
        };
        if entry.descriptor != descriptor {
            return;
        }
        entry.warming_generation = None;
        match result {
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

    fn publish(&self, descriptor: &ManagedMediaDescriptor, bytes: &[u8]) -> Result<(), String> {
        let key = object_key(&descriptor.digest);
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        let temp = self.root.join(format!(".{key}.{nonce}.tmp"));
        let meta_temp = self.root.join(format!(".{key}.{nonce}.meta.tmp"));
        write_durable(
            &meta_temp,
            &serde_json::to_vec(descriptor).map_err(|error| error.to_string())?,
        )?;
        write_durable(&temp, bytes)?;
        let metadata_path = self.meta_path(&descriptor.digest);
        let content_path = self.content_path(&descriptor.digest);
        // A digest-addressed object is immutable.  Never remove an existing
        // target to make rename work on Windows: a verified existing object is
        // already the desired publication, while an invalid target is a
        // recoverable cache fault rather than permission to create a visibility
        // gap.
        if content_path.exists() {
            let existing = fs::read(&content_path)
                .map_err(|error| format!("read existing media object: {error}"))?;
            if existing.len() as u64 != descriptor.byte_size
                || digest_of(&existing) != descriptor.digest
            {
                return Err("existing digest-addressed media object is corrupt".to_string());
            }
            let _ = fs::remove_file(&temp);
        } else {
            atomic_replace(&temp, &content_path)?;
        }
        atomic_replace(&meta_temp, &metadata_path)?;
        sync_parent_dir(&self.root);
        Ok(())
    }
}

fn object_key(digest: &str) -> String {
    digest
        .strip_prefix("sha256:")
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .unwrap_or("invalid")
        .to_ascii_lowercase()
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
    pub bytes: Vec<u8>,
    pub content_type: String,
    pub byte_size: u64,
    pub digest: String,
    state: Arc<Mutex<CacheState>>,
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

fn digest_of(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn validate_descriptor(descriptor: &ManagedMediaDescriptor) -> Option<String> {
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

fn verify_media_facts(content_type: &str, bytes: &[u8]) -> Result<(), String> {
    let valid_magic = match content_type {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
        "image/webp" => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        _ => false,
    };
    if valid_magic {
        Ok(())
    } else {
        Err("media header does not match declared image type".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    struct FixtureFetcher {
        media: MediaBytes,
    }

    #[async_trait]
    impl MediaFetcher for FixtureFetcher {
        async fn fetch(&self, _: &ManagedMediaDescriptor) -> Result<MediaBytes, String> {
            Ok(self.media.clone())
        }
    }

    fn descriptor(bytes: &[u8], content_type: &str) -> ManagedMediaDescriptor {
        ManagedMediaDescriptor {
            id: "550e8400-e29b-41d4-a716-446655440124".to_string(),
            reference: "/api/media-assets/550e8400-e29b-41d4-a716-446655440124/content".to_string(),
            digest: digest_of(bytes),
            content_type: content_type.to_string(),
            byte_size: bytes.len() as u64,
            purpose: "product_display_image".to_string(),
            revision: ManagedMediaRevision {
                catalog_revision: "catalog-1".to_string(),
                asset_revision: None,
            },
        }
    }

    #[tokio::test]
    async fn reconciliation_warms_verified_bytes_and_exposes_only_ready_digest() {
        let bytes = b"\x89PNG\r\n\x1a\nimage".to_vec();
        let descriptor = descriptor(&bytes, "image/png");
        let cache = ManagedMediaCache::new(
            tempdir().expect("tempdir").keep(),
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                media: MediaBytes {
                    bytes,
                    content_type: "image/png".to_string(),
                },
            }),
        )
        .expect("cache");
        cache
            .reconcile_active_catalog("generation-1", vec![descriptor.clone()])
            .await;
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
        assert_eq!(lease.bytes, b"\x89PNG\r\n\x1a\nimage");
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
                media: MediaBytes {
                    bytes: b"bad".to_vec(),
                    content_type: "image/png".to_string(),
                },
            }),
        )
        .expect("cache");
        cache
            .reconcile_active_catalog("generation-1", vec![expected.clone()])
            .await;
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
    async fn a_post_publish_corruption_is_not_served() {
        let root = tempdir().expect("tempdir").keep();
        let bytes = b"\x89PNG\r\n\x1a\nverified".to_vec();
        let expected = descriptor(&bytes, "image/png");
        let cache = ManagedMediaCache::new(
            root,
            "http://127.0.0.1:1234",
            Arc::new(FixtureFetcher {
                media: MediaBytes {
                    bytes,
                    content_type: "image/png".to_string(),
                },
            }),
        )
        .expect("cache");
        cache
            .reconcile_active_catalog("generation-1", vec![expected.clone()])
            .await;
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
                media: MediaBytes {
                    bytes: old_bytes,
                    content_type: "image/png".to_string(),
                },
            }),
        )
        .expect("cache");
        cache
            .reconcile_active_catalog("generation-1", vec![old.clone()])
            .await;
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
            .await;
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
                media: MediaBytes {
                    bytes,
                    content_type: "image/png".to_string(),
                },
            }),
        )
        .expect("cache");
        online
            .reconcile_active_catalog("generation-1", vec![expected.clone()])
            .await;
        for _ in 0..20 {
            if online.snapshot().await.1[0].readiness == MediaReadiness::Ready {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        struct OfflineFetcher;
        #[async_trait]
        impl MediaFetcher for OfflineFetcher {
            async fn fetch(&self, _: &ManagedMediaDescriptor) -> Result<MediaBytes, String> {
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
        assert_eq!(lease.bytes, b"\x89PNG\r\n\x1a\noffline-ready");
    }

    #[tokio::test]
    async fn reconciliation_returns_while_proactive_fetch_is_still_pending() {
        struct SlowFetcher;
        #[async_trait]
        impl MediaFetcher for SlowFetcher {
            async fn fetch(&self, _: &ManagedMediaDescriptor) -> Result<MediaBytes, String> {
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
        .expect("reconciliation must not await source fetch");
    }
}

use std::path::Path;

/// A directory handle opened before a metadata mutation and flushed after it.
/// Keeping the handle open ensures an open-permission failure occurs before a
/// caller replaces or removes an entry from that directory.
pub struct DirectorySyncHandle {
    file: std::fs::File,
}

impl DirectorySyncHandle {
    pub async fn sync(self) -> std::io::Result<()> {
        tokio::task::spawn_blocking(move || self.file.sync_all())
            .await
            .map_err(std::io::Error::other)?
    }
}

/// Flushes directory metadata after a durable replacement or deletion.
/// Windows requires FILE_FLAG_BACKUP_SEMANTICS to open directory handles.
pub async fn sync_directory(path: &Path) -> std::io::Result<()> {
    prepare_directory_sync(path).await?.sync().await
}

/// Opens a directory handle suitable for a later metadata flush. Windows
/// FlushFileBuffers requires GENERIC_WRITE, so read-only directory handles
/// are deliberately not used here.
pub async fn prepare_directory_sync(path: &Path) -> std::io::Result<DirectorySyncHandle> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || open_directory_for_sync_blocking(&path))
        .await
        .map_err(std::io::Error::other)?
}

fn open_directory_for_sync_blocking(path: &Path) -> std::io::Result<DirectorySyncHandle> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt as _;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS;

        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)?;
        Ok(DirectorySyncHandle { file })
    }

    #[cfg(not(windows))]
    {
        Ok(DirectorySyncHandle {
            file: std::fs::File::open(path)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::sync_directory;

    #[cfg(windows)]
    use super::prepare_directory_sync;

    #[tokio::test]
    async fn syncs_a_real_directory_after_a_mutation() {
        let temp = tempfile::tempdir().expect("temporary directory");
        tokio::fs::write(temp.path().join("current.json"), b"{}")
            .await
            .expect("write mutation");

        sync_directory(temp.path())
            .await
            .expect("sync directory metadata");
    }

    #[tokio::test]
    async fn reports_an_unopenable_directory_before_callers_claim_durability() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let missing = temp.path().join("missing-directory");

        assert!(sync_directory(&missing).await.is_err());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_write_access_directory_handle_flushes_renames_and_deletions() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let staged = temp.path().join("staged.json");
        let current = temp.path().join("current.json");
        let sync = prepare_directory_sync(temp.path())
            .await
            .expect("open writable directory handle");

        tokio::fs::write(&staged, b"{}")
            .await
            .expect("stage replacement");
        tokio::fs::rename(&staged, &current)
            .await
            .expect("replace current configuration");
        tokio::fs::remove_file(&current)
            .await
            .expect("delete current configuration");

        sync.sync()
            .await
            .expect("FlushFileBuffers accepts the directory handle");
    }
}

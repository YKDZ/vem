use std::path::Path;

/// Flushes directory metadata after a durable replacement or deletion.
/// Windows requires FILE_FLAG_BACKUP_SEMANTICS to open directory handles.
pub async fn sync_directory(path: &Path) -> std::io::Result<()> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || sync_directory_blocking(&path))
        .await
        .map_err(std::io::Error::other)?
}

fn sync_directory_blocking(path: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt as _;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS;

        std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)?
            .sync_all()
    }

    #[cfg(not(windows))]
    {
        std::fs::File::open(path)?.sync_all()
    }
}

#[cfg(test)]
mod tests {
    use super::sync_directory;

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
}

use std::io::Write;
use std::path::Path;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalLogEntry {
    pub ts: String,
    pub level: String,
    pub category: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

pub async fn append_local_log(path: &Path, entry: &LocalLogEntry) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("create log directory failed: {error}"))?;
    }

    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await
        .map_err(|error| format!("open log file failed: {error}"))?;

    let line = serde_json::to_string(entry)
        .map_err(|error| format!("serialize log entry failed: {error}"))?;
    let mut payload = line.into_bytes();
    payload.push(b'\n');
    tokio::io::AsyncWriteExt::write_all(&mut file, &payload)
        .await
        .map_err(|error| format!("write log entry failed: {error}"))?;

    Ok(())
}

pub async fn export_local_logs_zip(data_dir: &Path) -> Result<Vec<u8>, String> {
    let log_path = data_dir.join("logs").join("machine-events.jsonl");
    let content = tokio::fs::read(&log_path).await.unwrap_or_default();

    let mut output: Vec<u8> = Vec::new();
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut output));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    zip.start_file("machine-events.jsonl", options)
        .map_err(|error| format!("create zip entry failed: {error}"))?;
    zip.write_all(&content)
        .map_err(|error| format!("zip write failed: {error}"))?;
    zip.finish()
        .map_err(|error| format!("zip finish failed: {error}"))?;

    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use zip::ZipArchive;

    #[tokio::test]
    async fn export_zip_contains_machine_events_jsonl() {
        let temp = tempfile::tempdir().expect("tmp");
        let log_path = temp.path().join("logs").join("machine-events.jsonl");
        append_local_log(
            &log_path,
            &LocalLogEntry {
                ts: "2026-01-01T00:00:00.000Z".to_string(),
                level: "info".to_string(),
                category: "runtime".to_string(),
                message: "first".to_string(),
                data: None,
            },
        )
        .await
        .expect("append");
        append_local_log(
            &log_path,
            &LocalLogEntry {
                ts: "2026-01-01T00:00:01.000Z".to_string(),
                level: "warn".to_string(),
                category: "runtime".to_string(),
                message: "second".to_string(),
                data: None,
            },
        )
        .await
        .expect("append");

        let bytes = export_local_logs_zip(temp.path()).await.expect("export");
        let mut archive = ZipArchive::new(std::io::Cursor::new(bytes)).expect("zip");
        let mut entry = archive.by_name("machine-events.jsonl").expect("entry");
        let mut content = String::new();
        entry.read_to_string(&mut content).expect("read");
        assert!(content.contains("first"));
        assert!(content.contains("second"));
    }
}

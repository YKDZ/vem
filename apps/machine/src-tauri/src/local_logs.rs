use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::PathBuf,
};

use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalLogEntry {
    pub ts: String,
    pub level: String,
    pub category: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalLogStats {
    pub log_path: String,
    pub total_lines: u64,
    pub size_bytes: u64,
}

/// Append one log entry to the JSONL file.
pub fn append_local_log(log_path: &PathBuf, entry: &LocalLogEntry) -> Result<(), String> {
    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create log dir failed: {e}"))?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .map_err(|e| format!("open log file failed: {e}"))?;
    let line =
        serde_json::to_string(entry).map_err(|e| format!("serialize log entry failed: {e}"))?;
    writeln!(file, "{line}").map_err(|e| format!("write log entry failed: {e}"))?;
    Ok(())
}

/// Read basic stats about the log file.
pub fn read_local_log_stats(log_path: &PathBuf) -> Result<LocalLogStats, String> {
    if !log_path.exists() {
        return Ok(LocalLogStats {
            log_path: log_path.to_string_lossy().to_string(),
            total_lines: 0,
            size_bytes: 0,
        });
    }
    let metadata = fs::metadata(log_path).map_err(|e| format!("stat log file failed: {e}"))?;
    let file = File::open(log_path).map_err(|e| format!("open log file failed: {e}"))?;
    let total_lines = BufReader::new(file).lines().count() as u64;
    Ok(LocalLogStats {
        log_path: log_path.to_string_lossy().to_string(),
        total_lines,
        size_bytes: metadata.len(),
    })
}

/// Export the JSONL log file into a ZIP archive in memory and return the bytes.
pub fn export_local_logs(log_path: &PathBuf, file_name: &str) -> Result<Vec<u8>, String> {
    let content = if log_path.exists() {
        fs::read(log_path).map_err(|e| format!("read log file failed: {e}"))?
    } else {
        Vec::new()
    };

    let buf = std::io::Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(buf);
    zip.start_file(file_name, SimpleFileOptions::default())
        .map_err(|e| format!("zip start file failed: {e}"))?;
    zip.write_all(&content)
        .map_err(|e| format!("zip write failed: {e}"))?;
    let result = zip
        .finish()
        .map_err(|e| format!("zip finish failed: {e}"))?;
    Ok(result.into_inner())
}

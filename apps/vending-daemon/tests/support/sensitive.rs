use std::path::Path;

pub const TEST_AUTH_CODE: &str = "621234567890123456";
pub const TEST_MACHINE_SECRET: &str = "MACHINE-SECRET-PLAINTEXT";
pub const TEST_MQTT_SIGNING_SECRET: &str = "MQTT-SIGNING-SECRET-PLAINTEXT";
pub const TEST_MQTT_PASSWORD: &str = "MQTT-PASSWORD-PLAINTEXT";

pub fn assert_absent(label: &str, haystack: &str, needles: &[&str]) {
    for needle in needles {
        assert!(
            !haystack.contains(needle),
            "{label} leaked sensitive value {needle}"
        );
    }
}

pub async fn read_text_files_under(root: &Path) -> String {
    let mut out = String::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(path) = stack.pop() {
        let entries = match std::fs::read_dir(&path) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if matches!(
                path.extension().and_then(|value| value.to_str()),
                Some("json") | Some("jsonl") | Some("log") | Some("txt")
            ) {
                if let Ok(content) = tokio::fs::read_to_string(&path).await {
                    out.push_str(&content);
                    out.push('\n');
                }
            }
        }
    }
    out
}

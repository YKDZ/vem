use serde::{Deserialize, Serialize};

pub const PAYMENT_CODE_SOURCE_SERIAL_TEXT: &str = "serial_text";
pub const SCANNER_MAX_FRAME_BYTES: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScannerFrameSuffix {
    Crlf,
    Lf,
    Cr,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawPaymentCode {
    pub auth_code: String,
    pub masked_code: String,
    pub scanned_at_ms: u128,
}

/// Internal scanner runtime health model converted to generated IPC contracts at the boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannerHealthSnapshot {
    pub online: bool,
    pub adapter: String,
    pub port: Option<String>,
    pub level: crate::health::HealthLevel,
    pub code: String,
    pub message: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicScannerEvent {
    pub masked_code: String,
    pub source: String,
    pub scanned_at_ms: u128,
}

#[derive(Debug)]
pub struct ScannerFramer {
    suffix: ScannerFrameSuffix,
    frame: Vec<u8>,
    overflowed: bool,
    last_code: String,
    last_at_ms: u128,
}

impl Default for ScannerFramer {
    fn default() -> Self {
        Self::new(ScannerFrameSuffix::Crlf)
    }
}

impl ScannerFramer {
    pub fn new(suffix: ScannerFrameSuffix) -> Self {
        Self {
            suffix,
            frame: Vec::new(),
            overflowed: false,
            last_code: String::new(),
            last_at_ms: 0,
        }
    }

    pub fn push_bytes(&mut self, bytes: &[u8], now_ms: u128) -> Vec<RawPaymentCode> {
        let mut out = Vec::new();
        for byte in bytes {
            match self.suffix {
                ScannerFrameSuffix::Crlf | ScannerFrameSuffix::Lf if *byte == b'\n' => {
                    self.flush(now_ms, &mut out);
                }
                ScannerFrameSuffix::Cr if *byte == b'\r' => {
                    self.flush(now_ms, &mut out);
                }
                ScannerFrameSuffix::Crlf if *byte == b'\r' => {}
                ScannerFrameSuffix::None if byte.is_ascii_control() => {}
                _ if !byte.is_ascii_control()
                    && !self.overflowed
                    && self.frame.len() < SCANNER_MAX_FRAME_BYTES =>
                {
                    self.frame.push(*byte)
                }
                _ if !byte.is_ascii_control() => self.overflowed = true,
                _ => {}
            }
        }
        if matches!(self.suffix, ScannerFrameSuffix::None) && !self.frame.is_empty() {
            self.flush(now_ms, &mut out);
        }
        out
    }

    fn flush(&mut self, now_ms: u128, out: &mut Vec<RawPaymentCode>) {
        if self.overflowed {
            self.frame.clear();
            self.overflowed = false;
            return;
        }
        let code = String::from_utf8_lossy(&self.frame).trim().to_string();
        self.frame.clear();
        if code.is_empty() {
            return;
        }
        if code == self.last_code && now_ms.saturating_sub(self.last_at_ms) < 1500 {
            return;
        }
        self.last_code = code.clone();
        self.last_at_ms = now_ms;
        out.push(RawPaymentCode {
            masked_code: mask_code(&code),
            auth_code: code,
            scanned_at_ms: now_ms,
        });
    }
}

pub fn mask_code(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return "****".to_string();
    }
    if trimmed.len() <= 8 {
        return format!("{}****", &trimmed[..trimmed.len().min(2)]);
    }
    format!("{}****{}", &trimmed[..4], &trimmed[trimmed.len() - 4..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mask_code_shortens_mid_string() {
        assert_eq!(mask_code("621234567890123456"), "6212****3456");
    }

    #[test]
    fn mask_code_empty() {
        assert_eq!(mask_code(""), "****");
    }

    #[test]
    fn scanner_framer_debounce_duplicates() {
        let mut framer = ScannerFramer::default();
        let first = framer.push_bytes(b"621234567890123456\r\n", 1_000);
        assert_eq!(first.len(), 1);
        let second = framer.push_bytes(b"621234567890123456\r\n", 2_000);
        assert!(second.is_empty());
    }

    #[test]
    fn public_event_does_not_serialize_auth_code() {
        let event = PublicScannerEvent {
            masked_code: "6212****3456".to_string(),
            source: PAYMENT_CODE_SOURCE_SERIAL_TEXT.to_string(),
            scanned_at_ms: 12345,
        };
        let value = serde_json::to_value(&event).expect("serialize");
        assert!(!value.as_object().unwrap().contains_key("authCode"));
    }

    #[test]
    fn scanner_health_snapshot_serializes_without_auth_code() {
        let health = ScannerHealthSnapshot {
            online: true,
            adapter: PAYMENT_CODE_SOURCE_SERIAL_TEXT.to_string(),
            port: Some("/dev/ttyUSB1".to_string()),
            level: crate::health::HealthLevel::Ok,
            code: "SCANNER_READY".to_string(),
            message: "scanner ready".to_string(),
            updated_at: "2026-05-30T00:00:00.000Z".to_string(),
        };
        let value = serde_json::to_value(&health).expect("serialize health");
        assert_eq!(value["adapter"], "serial_text");
        assert!(!value.to_string().contains("authCode"));
    }
}

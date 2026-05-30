use serde::{Deserialize, Serialize};

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
                _ if !byte.is_ascii_control() => self.frame.push(*byte),
                _ => {}
            }
        }
        if matches!(self.suffix, ScannerFrameSuffix::None) && !self.frame.is_empty() {
            self.flush(now_ms, &mut out);
        }
        out
    }

    fn flush(&mut self, now_ms: u128, out: &mut Vec<RawPaymentCode>) {
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
            source: "serial".to_string(),
            scanned_at_ms: 12345,
        };
        let value = serde_json::to_value(&event).expect("serialize");
        assert!(!value.as_object().unwrap().contains_key("authCode"));
    }
}

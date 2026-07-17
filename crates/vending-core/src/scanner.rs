use serde::{Deserialize, Serialize};

pub const PAYMENT_CODE_SOURCE_SERIAL_TEXT: &str = "serial_text";
pub const SCANNER_MAX_FRAME_BYTES: usize = 256;
pub const SCANNER_FRAME_IDLE_TIMEOUT_MS: u128 = 1_000;

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
    invalid_frame: bool,
    pending_cr: bool,
    last_input_at_ms: Option<u128>,
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
            invalid_frame: false,
            pending_cr: false,
            last_input_at_ms: None,
            last_code: String::new(),
            last_at_ms: 0,
        }
    }

    pub fn push_bytes(&mut self, bytes: &[u8], now_ms: u128) -> Vec<RawPaymentCode> {
        if (!self.frame.is_empty() || self.invalid_frame)
            && self
                .last_input_at_ms
                .is_some_and(|last| now_ms.saturating_sub(last) >= SCANNER_FRAME_IDLE_TIMEOUT_MS)
        {
            self.reset_frame_state();
        }
        if !bytes.is_empty() {
            self.last_input_at_ms = Some(now_ms);
        }
        let mut out = Vec::new();
        for byte in bytes {
            match self.suffix {
                ScannerFrameSuffix::Crlf => self.push_crlf_byte(*byte, now_ms, &mut out),
                ScannerFrameSuffix::Lf if *byte == b'\n' => self.flush(now_ms, &mut out),
                ScannerFrameSuffix::Cr if *byte == b'\r' => {
                    self.flush(now_ms, &mut out);
                }
                _ if is_allowed_payload_byte(*byte)
                    && !self.invalid_frame
                    && self.frame.len() < SCANNER_MAX_FRAME_BYTES =>
                {
                    self.frame.push(*byte)
                }
                _ => self.invalid_frame = true,
            }
        }
        if matches!(self.suffix, ScannerFrameSuffix::None) {
            self.flush(now_ms, &mut out);
        }
        out
    }

    /// Reset every per-frame and cross-frame acceptance state. Scanner arm
    /// changes call this before accepting bytes for the next transaction, so
    /// a partial frame or a duplicate from an earlier order cannot affect it.
    pub fn reset(&mut self) {
        self.reset_frame_state();
        self.last_input_at_ms = None;
        self.last_code.clear();
        self.last_at_ms = 0;
    }

    fn push_crlf_byte(&mut self, byte: u8, now_ms: u128, out: &mut Vec<RawPaymentCode>) {
        if self.pending_cr {
            self.pending_cr = false;
            if byte == b'\n' {
                self.flush(now_ms, out);
                return;
            }

            // CR belongs only to the configured terminal delimiter. A lone
            // CR or CR followed by payload is malformed, never whitespace.
            self.invalid_frame = true;
            return;
        }

        match byte {
            b'\r' => self.pending_cr = true,
            // A lone LF is an invalid CRLF terminal, but it still terminates
            // that malformed frame. Do not let it poison the next frame.
            b'\n' => self.reset_frame_state(),
            _ if is_allowed_payload_byte(byte)
                && !self.invalid_frame
                && self.frame.len() < SCANNER_MAX_FRAME_BYTES =>
            {
                self.frame.push(byte);
            }
            _ => self.invalid_frame = true,
        }
    }

    fn reset_frame_state(&mut self) {
        self.frame.clear();
        self.invalid_frame = false;
        self.pending_cr = false;
    }

    fn flush(&mut self, now_ms: u128, out: &mut Vec<RawPaymentCode>) {
        if self.invalid_frame {
            self.reset_frame_state();
            return;
        }
        let Ok(code) = String::from_utf8(std::mem::take(&mut self.frame)) else {
            return;
        };
        let code = code.trim().to_string();
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

/// Scanner payloads are plain serial text: printable ASCII plus ordinary spaces.
/// Delimiters are handled separately; controls and bytes at or above `0x80`
/// poison the entire frame instead of being silently removed or lossily decoded.
fn is_allowed_payload_byte(byte: u8) -> bool {
    byte.is_ascii_graphic() || byte == b' '
}

pub fn mask_code(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return "****".to_string();
    }
    let chars = trimmed.chars().collect::<Vec<_>>();
    if chars.len() <= 8 {
        return format!("{}****", chars.iter().take(2).collect::<String>());
    }
    format!(
        "{}****{}",
        chars.iter().take(4).collect::<String>(),
        chars[chars.len() - 4..].iter().collect::<String>()
    )
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
    fn scanner_framer_discards_a_partial_frame_after_idle_timeout() {
        let mut framer = ScannerFramer::default();
        assert!(framer.push_bytes(b"stale-partial", 1_000).is_empty());

        let scanned = framer.push_bytes(b"621234567890123456\r\n", 2_000);

        assert_eq!(scanned.len(), 1);
        assert_eq!(scanned[0].auth_code, "621234567890123456");
    }

    #[test]
    fn scanner_framer_discards_an_overlong_frame_before_the_next_attempt() {
        let mut framer = ScannerFramer::default();
        let oversized = vec![b'1'; SCANNER_MAX_FRAME_BYTES + 1];
        assert!(framer.push_bytes(&oversized, 1_000).is_empty());

        let scanned = framer.push_bytes(b"621234567890123456\r\n", 2_000);

        assert_eq!(scanned.len(), 1);
        assert_eq!(scanned[0].auth_code, "621234567890123456");
    }

    #[test]
    fn scanner_framer_discards_a_malformed_frame_before_the_next_attempt() {
        let mut framer = ScannerFramer::default();
        assert!(framer.push_bytes(b"6212\xffbad\r\n", 1_000).is_empty());

        let scanned = framer.push_bytes(b"621234567890123456\r\n", 1_001);

        assert_eq!(scanned.len(), 1);
        assert_eq!(scanned[0].auth_code, "621234567890123456");
    }

    #[test]
    fn scanner_framer_crlf_requires_one_exact_terminal_pair() {
        let mut framer = ScannerFramer::new(ScannerFrameSuffix::Crlf);

        assert!(framer.push_bytes(b"6212\n", 1_000).is_empty());
        assert!(framer.push_bytes(b"6212\rX\r\n", 1_001).is_empty());
        assert!(framer.push_bytes(b"6212\r", 1_002).is_empty());
        assert!(framer.push_bytes(b"X\r\n", 1_003).is_empty());

        let scanned = framer.push_bytes(b"621234567890123456\r\n", 1_004);
        assert_eq!(scanned.len(), 1);
        assert_eq!(scanned[0].auth_code, "621234567890123456");
    }

    #[test]
    fn scanner_framer_discards_a_lone_lf_without_poisoning_the_next_crlf_frame() {
        let mut framer = ScannerFramer::new(ScannerFrameSuffix::Crlf);
        assert!(framer.push_bytes(b"6212\n", 1_000).is_empty());

        let scanned = framer.push_bytes(b"621234567890123456\r\n", 1_001);
        assert_eq!(scanned.len(), 1);
        assert_eq!(scanned[0].auth_code, "621234567890123456");
    }

    #[test]
    fn scanner_framer_suffixes_have_exact_delimiter_semantics() {
        let mut lf = ScannerFramer::new(ScannerFrameSuffix::Lf);
        assert!(lf.push_bytes(b"6212\r\n", 1_000).is_empty());
        assert_eq!(
            lf.push_bytes(b"621234567890123456\n", 1_001)[0].auth_code,
            "621234567890123456"
        );

        let mut cr = ScannerFramer::new(ScannerFrameSuffix::Cr);
        assert!(cr.push_bytes(b"6212\n\r", 1_000).is_empty());
        assert_eq!(
            cr.push_bytes(b"621234567890123456\r", 1_001)[0].auth_code,
            "621234567890123456"
        );

        let mut none = ScannerFramer::new(ScannerFrameSuffix::None);
        assert!(none.push_bytes(b"6212\r", 1_000).is_empty());
        assert_eq!(
            none.push_bytes(b"621234567890123456", 1_001)[0].auth_code,
            "621234567890123456"
        );
    }

    #[test]
    fn scanner_framer_reset_clears_duplicate_debounce() {
        let mut framer = ScannerFramer::default();
        assert_eq!(framer.push_bytes(b"621234567890123456\r\n", 1_000).len(), 1);
        framer.reset();
        assert_eq!(framer.push_bytes(b"621234567890123456\r\n", 1_001).len(), 1);
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

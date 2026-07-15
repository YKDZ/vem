use vending_core::scanner::{mask_code, ScannerFrameSuffix, ScannerFramer};

#[test]
fn scanner_framer_rejects_invalid_utf8_without_panicking() {
    let mut framer = ScannerFramer::new(ScannerFrameSuffix::Lf);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        framer.push_bytes(b"\xff12\n", 1_000)
    }));

    assert!(result.is_ok(), "invalid serial bytes must not panic");
    assert!(result.unwrap().is_empty());
    assert_eq!(
        framer.push_bytes(b"621234567890123456\n", 2_000)[0].auth_code,
        "621234567890123456"
    );
}

#[test]
fn scanner_framer_without_suffix_recovers_at_the_next_read_boundary() {
    let mut framer = ScannerFramer::new(ScannerFrameSuffix::None);

    assert!(framer.push_bytes(b"\xff12", 1_000).is_empty());
    let frames = framer.push_bytes(b"621234567890123456", 2_000);

    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].auth_code, "621234567890123456");
}

#[test]
fn scanner_framer_remains_invalid_until_a_delimiter() {
    let mut framer = ScannerFramer::new(ScannerFrameSuffix::Lf);

    assert!(framer.push_bytes(b"\xff12", 1_000).is_empty());
    assert!(framer.push_bytes(b"345\n", 1_100).is_empty());
    assert_eq!(
        framer.push_bytes(b"621234567890123456\n", 2_000)[0].auth_code,
        "621234567890123456"
    );
}

#[test]
fn mask_code_is_safe_for_arbitrary_utf8() {
    let result = std::panic::catch_unwind(|| mask_code("中文🙂测试条码"));

    assert!(result.is_ok(), "masking valid UTF-8 must not panic");
    assert_eq!(result.unwrap(), "中文****");
}

#[test]
fn scanner_framer_accepts_ascii_graphic_characters_and_spaces() {
    let mut framer = ScannerFramer::new(ScannerFrameSuffix::Lf);

    let frames = framer.push_bytes(b"ORDER 12-34_56\n", 1_000);

    assert_eq!(frames[0].auth_code, "ORDER 12-34_56");
}

#[test]
fn scanner_framer_supports_documented_suffixes() {
    let cases = [
        (
            ScannerFrameSuffix::Crlf,
            b"621234567890123456\r\n".as_slice(),
        ),
        (ScannerFrameSuffix::Lf, b"621234567890123456\n".as_slice()),
        (ScannerFrameSuffix::Cr, b"621234567890123456\r".as_slice()),
        (ScannerFrameSuffix::None, b"621234567890123456".as_slice()),
    ];

    for (suffix, bytes) in cases {
        let mut framer = ScannerFramer::new(suffix);
        let frames = framer.push_bytes(bytes, 1_000);
        assert_eq!(frames.len(), 1, "suffix {suffix:?}");
        assert_eq!(frames[0].masked_code, "6212****3456");
        assert_eq!(frames[0].scanned_at_ms, 1_000);
    }
}

#[test]
fn scanner_framer_rejects_control_noise_then_recovers_at_the_next_frame() {
    let mut framer = ScannerFramer::new(ScannerFrameSuffix::Lf);

    let frames = framer.push_bytes(b"\x02111111111111111111\x03\n621234567890123456\n", 1_000);

    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].auth_code, "621234567890123456");
}

#[test]
fn scanner_framer_rejects_oversized_frame_without_emitting_a_truncated_code() {
    let mut framer = ScannerFramer::new(ScannerFrameSuffix::Lf);
    let mut oversized = vec![b'1'; 257];
    oversized.push(b'\n');

    assert!(framer.push_bytes(&oversized, 1_000).is_empty());
    assert_eq!(
        framer.push_bytes(b"621234567890123456\n", 2_000)[0].auth_code,
        "621234567890123456"
    );
}

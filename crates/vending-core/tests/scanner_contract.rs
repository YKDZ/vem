use vending_core::scanner::{ScannerFrameSuffix, ScannerFramer};

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
    }
}

#[test]
fn scanner_framer_drops_control_chars_and_debounces_duplicates() {
    let mut framer = ScannerFramer::new(ScannerFrameSuffix::Lf);
    assert_eq!(
        framer.push_bytes(b"\x02621234567890123456\x03\n", 1_000)[0].auth_code,
        "621234567890123456"
    );
    assert!(framer.push_bytes(b"621234567890123456\n", 2_000).is_empty());
    assert_eq!(framer.push_bytes(b"621234567890123456\n", 3_000).len(), 1);
}

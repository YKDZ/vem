mod support;

use std::{
    os::fd::AsRawFd,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

use nix::{
    errno::Errno,
    fcntl::{fcntl, FcntlArg, OFlag},
};
use tokio::{
    io::AsyncWriteExt,
    time::{sleep, timeout},
};
use vending_core::{
    hardware::{DispenseCommandPayload, HardwareAdapter, SlotPayload},
    serial::{
        build_dispense_frame, EnvironmentSample, SerialHardwareAdapter, DEBUG_DISPENSE_FAULT_FRAME,
        FRAME_HEAD,
    },
};

static PTY_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn command(command_no: &str) -> DispenseCommandPayload {
    DispenseCommandPayload {
        command_no: command_no.to_string(),
        order_no: "ORD-PTY".to_string(),
        slot: SlotPayload {
            layer_no: 2,
            cell_no: 5,
            slot_code: "A25".to_string(),
        },
        quantity: 1,
        timeout_seconds: 2,
    }
}

#[tokio::test]
async fn serial_adapter_dispenses_once_on_ack_and_completed() {
    let _pty_guard = PTY_TEST_LOCK.lock().await;
    let mut pty = support::open_pty();
    let slave_path = pty.slave_path.clone();
    let writes = Arc::new(AtomicUsize::new(0));
    let writes_for_task = writes.clone();
    tokio::spawn(async move {
        support::respond_to_handshake(&mut pty.master).await;
        let frame = support::read_single_dispense_frame(&mut pty.master).await;
        writes_for_task.fetch_add(1, Ordering::SeqCst);
        assert_eq!(frame, build_dispense_frame(2, 5).unwrap());
        support::send_lower_code(&mut pty.master, 0x00).await;
        sleep(Duration::from_millis(10)).await;
        support::send_lower_code(&mut pty.master, 0xF1).await;
        sleep(Duration::from_millis(50)).await;
    });

    let adapter = SerialHardwareAdapter::new(slave_path.to_string_lossy().to_string());
    let result = timeout(
        Duration::from_secs(10),
        adapter.dispense(command("CMD-PTY-1")),
    )
    .await
    .expect("test timeout");
    assert!(result.success, "{result:?}");
    assert_eq!(writes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn serial_adapter_retries_busy_and_crc_before_success() {
    let _pty_guard = PTY_TEST_LOCK.lock().await;
    let mut pty = support::open_pty();
    let slave_path = pty.slave_path.clone();
    let writes = Arc::new(AtomicUsize::new(0));
    let writes_for_task = writes.clone();
    tokio::spawn(async move {
        support::respond_to_handshake(&mut pty.master).await;
        for code in [0xE4, 0xE2, 0x00] {
            let frame = support::read_single_dispense_frame(&mut pty.master).await;
            assert_eq!(frame[0], FRAME_HEAD);
            writes_for_task.fetch_add(1, Ordering::SeqCst);
            support::send_lower_code(&mut pty.master, code).await;
        }
        sleep(Duration::from_millis(10)).await;
        support::send_lower_code(&mut pty.master, 0xF1).await;
        sleep(Duration::from_millis(50)).await;
    });

    let adapter = SerialHardwareAdapter::new(slave_path.to_string_lossy().to_string());
    let result = timeout(
        Duration::from_secs(10),
        adapter.dispense(command("CMD-PTY-2")),
    )
    .await
    .expect("test timeout");
    assert!(result.success, "{result:?}");
    assert_eq!(writes.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn serial_adapter_reports_mechanical_fault_after_ack() {
    let _pty_guard = PTY_TEST_LOCK.lock().await;
    let mut pty = support::open_pty();
    let slave_path = pty.slave_path.clone();
    tokio::spawn(async move {
        support::respond_to_handshake(&mut pty.master).await;
        let _frame = support::read_single_dispense_frame(&mut pty.master).await;
        support::send_lower_code(&mut pty.master, 0x00).await;
        sleep(Duration::from_millis(10)).await;
        support::send_lower_code(&mut pty.master, 0xE3).await;
        sleep(Duration::from_millis(50)).await;
    });

    let adapter = SerialHardwareAdapter::new(slave_path.to_string_lossy().to_string());
    let result = timeout(
        Duration::from_secs(10),
        adapter.dispense(command("CMD-PTY-3")),
    )
    .await
    .expect("test timeout");
    assert!(!result.success);
    assert_eq!(result.error_code.as_deref(), Some("JAMMED"));
}

#[tokio::test]
async fn serial_adapter_can_inject_documented_debug_dispense_fault_after_ack() {
    let _pty_guard = PTY_TEST_LOCK.lock().await;
    let mut pty = support::open_pty();
    let slave_path = pty.slave_path.clone();
    tokio::spawn(async move {
        support::respond_to_handshake(&mut pty.master).await;
        let frame = support::read_single_dispense_frame(&mut pty.master).await;
        assert_eq!(frame, build_dispense_frame(2, 5).unwrap());
        support::send_lower_code(&mut pty.master, 0x00).await;

        let mut injected = [0_u8; 4];
        tokio::io::AsyncReadExt::read_exact(&mut pty.master, &mut injected)
            .await
            .expect("read debug fault injection frame");
        assert_eq!(injected, DEBUG_DISPENSE_FAULT_FRAME);

        support::send_lower_code(&mut pty.master, 0xE3).await;
        sleep(Duration::from_millis(50)).await;
    });

    let adapter = SerialHardwareAdapter::new(slave_path.to_string_lossy().to_string());
    adapter
        .schedule_next_dispense_fault_injection()
        .expect("schedule injection");
    let result = timeout(
        Duration::from_secs(10),
        adapter.dispense(command("CMD-PTY-INJECT-FAULT")),
    )
    .await
    .expect("test timeout");
    assert!(!result.success);
    assert_eq!(result.error_code.as_deref(), Some("JAMMED"));
    assert!(result.message.contains("mechanical fault"));
}

#[tokio::test]
async fn serial_adapter_reports_pickup_platform_blocked_after_ack() {
    let _pty_guard = PTY_TEST_LOCK.lock().await;
    let mut pty = support::open_pty();
    let slave_path = pty.slave_path.clone();
    tokio::spawn(async move {
        support::respond_to_handshake(&mut pty.master).await;
        let _frame = support::read_single_dispense_frame(&mut pty.master).await;
        support::send_lower_code(&mut pty.master, 0x00).await;
        sleep(Duration::from_millis(10)).await;
        support::send_lower_code(&mut pty.master, 0xE6).await;
        sleep(Duration::from_millis(50)).await;
    });

    let adapter = SerialHardwareAdapter::new(slave_path.to_string_lossy().to_string());
    let result = timeout(
        Duration::from_secs(10),
        adapter.dispense(command("CMD-PTY-BLOCKED")),
    )
    .await
    .expect("test timeout");
    assert!(!result.success);
    assert_eq!(result.error_code.as_deref(), Some("JAMMED"));
    assert!(result.message.contains("pickup platform blocked"));
}

#[tokio::test]
async fn serial_adapter_serializes_cross_instance_control_behind_active_dispense() {
    let _pty_guard = PTY_TEST_LOCK.lock().await;
    let mut pty = support::open_pty();
    let slave_path = pty.slave_path.clone();
    tokio::spawn(async move {
        support::respond_to_handshake(&mut pty.master).await;
        let frame = support::read_single_dispense_frame(&mut pty.master).await;
        assert_eq!(frame, build_dispense_frame(2, 5).unwrap());
        support::send_lower_code(&mut pty.master, 0x00).await;

        sleep(Duration::from_millis(150)).await;
        let fd = pty.master.as_raw_fd();
        let original_flags =
            OFlag::from_bits_truncate(fcntl(fd, FcntlArg::F_GETFL).expect("read pty flags"));
        fcntl(fd, FcntlArg::F_SETFL(original_flags | OFlag::O_NONBLOCK))
            .expect("set pty nonblocking");
        let mut unexpected = [0_u8; 3];
        match nix::unistd::read(fd, &mut unexpected) {
            Err(error) if error == Errno::EAGAIN || error == Errno::EWOULDBLOCK => {}
            Ok(count) => panic!(
                "environment control wrote to serial before dispense completed: {:?}",
                &unexpected[..count]
            ),
            Err(error) => panic!("unexpected nonblocking pty read error: {error}"),
        }
        fcntl(fd, FcntlArg::F_SETFL(original_flags)).expect("restore pty flags");

        support::send_lower_code(&mut pty.master, 0xF1).await;
        support::respond_to_handshake(&mut pty.master).await;
        let mut switch_frame = [0_u8; 3];
        tokio::io::AsyncReadExt::read_exact(&mut pty.master, &mut switch_frame)
            .await
            .expect("read air conditioner switch frame");
        assert_eq!(switch_frame, [FRAME_HEAD, 0xB2, 0xFF]);
        pty.master
            .write_all(&[FRAME_HEAD, 0xB2, 0xFF])
            .await
            .expect("write air conditioner switch echo");
        pty.master.flush().await.expect("flush");
        sleep(Duration::from_millis(50)).await;
    });

    let dispense_adapter = Arc::new(SerialHardwareAdapter::new(
        slave_path.to_string_lossy().to_string(),
    ));
    let dispense =
        tokio::spawn(async move { dispense_adapter.dispense(command("CMD-SERIALIZE")).await });
    sleep(Duration::from_millis(25)).await;
    let control_adapter = Arc::new(SerialHardwareAdapter::new(
        slave_path.to_string_lossy().to_string(),
    ));
    let control =
        tokio::spawn(async move { control_adapter.set_air_conditioner_enabled(true).await });

    let dispense_result = timeout(Duration::from_secs(10), dispense)
        .await
        .expect("dispense timeout")
        .expect("dispense join");
    assert!(dispense_result.success, "{dispense_result:?}");
    timeout(Duration::from_secs(10), control)
        .await
        .expect("control timeout")
        .expect("control join")
        .expect("air conditioner accepted");
}

#[tokio::test]
async fn serial_adapter_sets_target_temperature_on_v1_echo() {
    let _pty_guard = PTY_TEST_LOCK.lock().await;
    let mut pty = support::open_pty();
    let slave_path = pty.slave_path.clone();
    tokio::spawn(async move {
        support::respond_to_handshake(&mut pty.master).await;
        let mut frame = [0_u8; 3];
        tokio::io::AsyncReadExt::read_exact(&mut pty.master, &mut frame)
            .await
            .expect("read target temperature frame");
        assert_eq!(frame, [FRAME_HEAD, 0xB1, 24]);
        pty.master
            .write_all(&[FRAME_HEAD, 0xB1, 24])
            .await
            .expect("write target temperature echo");
        pty.master.flush().await.expect("flush");
        sleep(Duration::from_millis(50)).await;
    });

    let adapter = SerialHardwareAdapter::new(slave_path.to_string_lossy().to_string());
    timeout(Duration::from_secs(10), adapter.set_target_temperature(24))
        .await
        .expect("test timeout")
        .expect("target temperature accepted");
}

#[tokio::test]
async fn serial_adapter_switches_air_conditioner_on_v1_echo() {
    let _pty_guard = PTY_TEST_LOCK.lock().await;
    let mut pty = support::open_pty();
    let slave_path = pty.slave_path.clone();
    tokio::spawn(async move {
        support::respond_to_handshake(&mut pty.master).await;
        let mut frame = [0_u8; 3];
        tokio::io::AsyncReadExt::read_exact(&mut pty.master, &mut frame)
            .await
            .expect("read air conditioner switch frame");
        assert_eq!(frame, [FRAME_HEAD, 0xB2, 0xFF]);
        pty.master
            .write_all(&[FRAME_HEAD, 0xB2, 0xFF])
            .await
            .expect("write air conditioner switch echo");
        pty.master.flush().await.expect("flush");
        sleep(Duration::from_millis(50)).await;
    });

    let adapter = SerialHardwareAdapter::new(slave_path.to_string_lossy().to_string());
    timeout(
        Duration::from_secs(10),
        adapter.set_air_conditioner_enabled(true),
    )
    .await
    .expect("test timeout")
    .expect("air conditioner switch accepted");
}

#[tokio::test]
async fn serial_adapter_reports_target_temperature_e1_rejection() {
    let _pty_guard = PTY_TEST_LOCK.lock().await;
    let mut pty = support::open_pty();
    let slave_path = pty.slave_path.clone();
    tokio::spawn(async move {
        support::respond_to_handshake(&mut pty.master).await;
        let mut frame = [0_u8; 3];
        tokio::io::AsyncReadExt::read_exact(&mut pty.master, &mut frame)
            .await
            .expect("read target temperature frame");
        assert_eq!(frame, [FRAME_HEAD, 0xB1, 30]);
        support::send_lower_code(&mut pty.master, 0xE1).await;
        sleep(Duration::from_millis(50)).await;
    });

    let adapter = SerialHardwareAdapter::new(slave_path.to_string_lossy().to_string());
    let error = timeout(Duration::from_secs(10), adapter.set_target_temperature(30))
        .await
        .expect("test timeout")
        .expect_err("E1 rejection should fail command");
    assert!(error.contains("target temperature"), "{error}");
    assert!(error.contains("boundary"), "{error}");
}

#[tokio::test]
async fn serial_adapter_reports_air_conditioner_e1_rejection() {
    let _pty_guard = PTY_TEST_LOCK.lock().await;
    let mut pty = support::open_pty();
    let slave_path = pty.slave_path.clone();
    tokio::spawn(async move {
        support::respond_to_handshake(&mut pty.master).await;
        let mut frame = [0_u8; 3];
        tokio::io::AsyncReadExt::read_exact(&mut pty.master, &mut frame)
            .await
            .expect("read air conditioner switch frame");
        assert_eq!(frame, [FRAME_HEAD, 0xB2, 0x00]);
        support::send_lower_code(&mut pty.master, 0xE1).await;
        sleep(Duration::from_millis(50)).await;
    });

    let adapter = SerialHardwareAdapter::new(slave_path.to_string_lossy().to_string());
    let error = timeout(
        Duration::from_secs(10),
        adapter.set_air_conditioner_enabled(false),
    )
    .await
    .expect("test timeout")
    .expect_err("E1 rejection should fail command");
    assert!(error.contains("air conditioner"), "{error}");
    assert!(error.contains("boundary"), "{error}");
}

#[tokio::test]
async fn serial_adapter_queries_v1_environment_sample() {
    let _pty_guard = PTY_TEST_LOCK.lock().await;
    let mut pty = support::open_pty();
    let slave_path = pty.slave_path.clone();
    tokio::spawn(async move {
        support::respond_to_handshake(&mut pty.master).await;
        let mut frame = [0_u8; 2];
        tokio::io::AsyncReadExt::read_exact(&mut pty.master, &mut frame)
            .await
            .expect("read environment query frame");
        assert_eq!(frame, [FRAME_HEAD, 0xB0]);
        pty.master
            .write_all(&[FRAME_HEAD, 0xB0, 0xFB, 88])
            .await
            .expect("write environment sample");
        pty.master.flush().await.expect("flush");
        sleep(Duration::from_millis(50)).await;
    });

    let adapter = SerialHardwareAdapter::new(slave_path.to_string_lossy().to_string());
    let sample = timeout(Duration::from_secs(10), adapter.query_environment_sample())
        .await
        .expect("test timeout")
        .expect("environment query accepted");
    assert_eq!(
        sample,
        Some(EnvironmentSample {
            temperature_celsius: -5,
            relative_humidity_percent: 88,
        })
    );
}

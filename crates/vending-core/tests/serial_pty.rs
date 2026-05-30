mod support;

use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

use tokio::time::timeout;
use vending_core::{
    hardware::{DispenseCommandPayload, HardwareAdapter, SlotPayload},
    serial::{build_dispense_frame, SerialHardwareAdapter, FRAME_HEAD},
};

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
    let mut pty = support::open_pty();
    let slave_path = pty.slave_path.clone();
    let writes = Arc::new(AtomicUsize::new(0));
    let writes_for_task = writes.clone();
    tokio::spawn(async move {
        let frame = support::read_single_dispense_frame(&mut pty.master).await;
        writes_for_task.fetch_add(1, Ordering::SeqCst);
        assert_eq!(frame, build_dispense_frame(2, 5).unwrap());
        support::send_lower_code(&mut pty.master, 0x00).await;
        support::send_lower_code(&mut pty.master, 0xF1).await;
    });

    let adapter = SerialHardwareAdapter::new(slave_path.to_string_lossy().to_string());
    let result = timeout(
        Duration::from_secs(3),
        adapter.dispense(command("CMD-PTY-1")),
    )
    .await
    .expect("test timeout");
    assert!(result.success, "{result:?}");
    assert_eq!(writes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn serial_adapter_retries_busy_and_crc_before_success() {
    let mut pty = support::open_pty();
    let slave_path = pty.slave_path.clone();
    let writes = Arc::new(AtomicUsize::new(0));
    let writes_for_task = writes.clone();
    tokio::spawn(async move {
        for code in [0x04, 0x02, 0x00] {
            let frame = support::read_single_dispense_frame(&mut pty.master).await;
            assert_eq!(frame[0], FRAME_HEAD);
            writes_for_task.fetch_add(1, Ordering::SeqCst);
            support::send_lower_code(&mut pty.master, code).await;
        }
        support::send_lower_code(&mut pty.master, 0xF1).await;
    });

    let adapter = SerialHardwareAdapter::new(slave_path.to_string_lossy().to_string());
    let result = timeout(
        Duration::from_secs(3),
        adapter.dispense(command("CMD-PTY-2")),
    )
    .await
    .expect("test timeout");
    assert!(result.success, "{result:?}");
    assert_eq!(writes.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn serial_adapter_reports_mechanical_fault_after_ack() {
    let mut pty = support::open_pty();
    let slave_path = pty.slave_path.clone();
    tokio::spawn(async move {
        let _frame = support::read_single_dispense_frame(&mut pty.master).await;
        support::send_lower_code(&mut pty.master, 0x00).await;
        support::send_lower_code(&mut pty.master, 0x03).await;
    });

    let adapter = SerialHardwareAdapter::new(slave_path.to_string_lossy().to_string());
    let result = timeout(
        Duration::from_secs(3),
        adapter.dispense(command("CMD-PTY-3")),
    )
    .await
    .expect("test timeout");
    assert!(!result.success);
    assert_eq!(result.error_code.as_deref(), Some("JAMMED"));
}

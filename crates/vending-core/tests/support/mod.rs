use std::{
    os::fd::{FromRawFd, IntoRawFd},
    path::{Path, PathBuf},
};

use nix::{
    fcntl::OFlag,
    pty::{grantpt, posix_openpt, ptsname_r, unlockpt},
    sys::termios::{cfmakeraw, tcgetattr, tcsetattr, SetArg},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub struct PtyPair {
    pub slave_path: PathBuf,
    pub master: tokio::fs::File,
    _slave: std::fs::File,
}

pub fn open_pty() -> PtyPair {
    let master = posix_openpt(OFlag::O_RDWR | OFlag::O_NOCTTY).expect("posix_openpt");
    grantpt(&master).expect("grantpt");
    unlockpt(&master).expect("unlockpt");
    let slave_path = PathBuf::from(ptsname_r(&master).expect("ptsname"));
    let slave = configure_slave_raw(&slave_path);
    let fd = master.into_raw_fd();
    // SAFETY: fd is freshly taken from `master` and handed to `File` exactly once.
    let file = unsafe { std::fs::File::from_raw_fd(fd) };
    PtyPair {
        slave_path,
        master: tokio::fs::File::from_std(file),
        _slave: slave,
    }
}

fn configure_slave_raw(slave_path: &Path) -> std::fs::File {
    let slave = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(slave_path)
        .expect("open pty slave");
    let mut termios = tcgetattr(&slave).expect("tcgetattr pty slave");
    cfmakeraw(&mut termios);
    tcsetattr(&slave, SetArg::TCSANOW, &termios).expect("tcsetattr pty slave raw");
    slave
}

pub async fn read_single_dispense_frame(master: &mut tokio::fs::File) -> [u8; 4] {
    let mut frame = [0_u8; 4];
    master.read_exact(&mut frame).await.expect("read frame");
    frame
}

pub async fn send_lower_code(master: &mut tokio::fs::File, code: u8) {
    master
        .write_all(&[vending_core::serial::FRAME_HEAD, code])
        .await
        .expect("write lower code");
    master.flush().await.expect("flush");
}

pub async fn respond_to_handshake(master: &mut tokio::fs::File) {
    let mut frame = [0_u8; 2];
    master
        .read_exact(&mut frame)
        .await
        .expect("read handshake frame");
    assert_eq!(
        frame,
        [
            vending_core::serial::FRAME_HEAD,
            vending_core::serial::build_status_query_frame()[1],
        ]
    );
    send_lower_code(master, 0xAA).await;
}

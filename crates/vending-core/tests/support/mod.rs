use std::{
    os::fd::{FromRawFd, IntoRawFd},
    path::PathBuf,
};

use nix::{
    fcntl::OFlag,
    pty::{grantpt, posix_openpt, ptsname_r, unlockpt},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub struct PtyPair {
    pub slave_path: PathBuf,
    pub master: tokio::fs::File,
}

pub fn open_pty() -> PtyPair {
    let master = posix_openpt(OFlag::O_RDWR | OFlag::O_NOCTTY).expect("posix_openpt");
    grantpt(&master).expect("grantpt");
    unlockpt(&master).expect("unlockpt");
    let slave_path = PathBuf::from(ptsname_r(&master).expect("ptsname"));
    let fd = master.into_raw_fd();
    // SAFETY: fd is freshly taken from `master` and handed to `File` exactly once.
    let file = unsafe { std::fs::File::from_raw_fd(fd) };
    PtyPair {
        slave_path,
        master: tokio::fs::File::from_std(file),
    }
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
